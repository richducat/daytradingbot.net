import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import type { Pool, PoolClient } from "pg";
import Stripe from "stripe";
import { hashLicenseSecret } from "./licensing.js";

const PRODUCT_KEY = "desktop-v1";
const PRODUCT_PRICE_CENTS = 9_800;
const ENCRYPTION_VERSION = 1;

export type DownloadLinks = {
  macos?: string;
  webApp?: string;
};

export type CheckoutStatus = {
  status: "paid";
  email: string;
  activationCode: string;
  emailDelivered: boolean;
  downloads: DownloadLinks;
};

export interface CommerceOperations {
  createCheckoutSession(): Promise<{ checkoutUrl: string }>;
  checkoutStatus(sessionId: string): Promise<CheckoutStatus>;
  handleWebhook(rawBody: Buffer, signature: string): Promise<void>;
}

export type PaidCheckoutSession = {
  sessionId: string;
  paymentIntentId?: string;
  customerEmail: string;
  amountCents: number;
  currency: string;
};

export type ProvisionedPurchase = {
  purchaseId: string;
  customerEmail: string;
  activationCode: string;
};

export interface CommerceRepository {
  recordStripeEvent(eventId: string, eventType: string, payloadHash: Buffer): Promise<boolean>;
  markStripeEventProcessed(eventId: string): Promise<void>;
  markStripeEventFailed(eventId: string, message: string): Promise<void>;
  provisionPaidPurchase(session: PaidCheckoutSession): Promise<ProvisionedPurchase>;
  claimLicenseDelivery(purchaseId: string): Promise<"send" | "sent" | "busy">;
  markLicenseDelivered(purchaseId: string): Promise<void>;
  markLicenseDeliveryFailed(purchaseId: string, message: string): Promise<void>;
  markPurchaseCanceled(sessionId: string): Promise<void>;
  markPurchaseByPaymentIntent(
    paymentIntentId: string,
    status: "refunded" | "disputed",
  ): Promise<void>;
}

export interface LicenseMailer {
  sendLicense(input: {
    to: string;
    activationCode: string;
    downloads: DownloadLinks;
  }): Promise<void>;
}

type CommerceConfig = {
  publicSiteUrl: string;
  stripePriceId: string;
  stripeWebhookSecret: string;
  downloads: DownloadLinks;
};

export class CommerceServiceError extends Error {
  constructor(
    readonly code:
      | "checkout_unavailable"
      | "invalid_webhook"
      | "payment_not_complete"
      | "invalid_checkout"
      | "fulfillment_unavailable",
  ) {
    super(code);
    this.name = "CommerceServiceError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return "unknown_error";
}

function paymentIntentId(value: string | Stripe.PaymentIntent | null): string | undefined {
  if (typeof value === "string") return value;
  return value?.id;
}

function chargePaymentIntentId(value: string | Stripe.PaymentIntent | null): string | undefined {
  if (typeof value === "string") return value;
  return value?.id;
}

export class CommerceService implements CommerceOperations {
  constructor(
    private readonly stripe: Stripe,
    private readonly repository: CommerceRepository,
    private readonly config: CommerceConfig,
    private readonly mailer?: LicenseMailer,
  ) {}

  async createCheckoutSession(): Promise<{ checkoutUrl: string }> {
    try {
      const session = await this.stripe.checkout.sessions.create({
        mode: "payment",
        customer_creation: "always",
        line_items: [{ price: this.config.stripePriceId, quantity: 1 }],
        success_url: `${this.config.publicSiteUrl}/welcome/?session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${this.config.publicSiteUrl}/get-started/?checkout=cancelled`,
        metadata: { daytradingbot_product: PRODUCT_KEY },
        payment_intent_data: { metadata: { daytradingbot_product: PRODUCT_KEY } },
      });
      if (!session.url) throw new CommerceServiceError("checkout_unavailable");
      return { checkoutUrl: session.url };
    } catch (error) {
      if (error instanceof CommerceServiceError) throw error;
      throw new CommerceServiceError("checkout_unavailable");
    }
  }

  async checkoutStatus(sessionId: string): Promise<CheckoutStatus> {
    const session = await this.retrieveAndValidatePaidSession(sessionId);
    const purchase = await this.repository.provisionPaidPurchase(session);
    const emailDelivered = await this.deliverLicense(purchase, false);
    return {
      status: "paid",
      email: purchase.customerEmail,
      activationCode: purchase.activationCode,
      emailDelivered,
      downloads: this.config.downloads,
    };
  }

  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.config.stripeWebhookSecret,
      );
    } catch {
      throw new CommerceServiceError("invalid_webhook");
    }

    const shouldProcess = await this.repository.recordStripeEvent(
      event.id,
      event.type,
      createHash("sha256").update(rawBody).digest(),
    );
    if (!shouldProcess) return;

    try {
      if (
        event.type === "checkout.session.completed"
        || event.type === "checkout.session.async_payment_succeeded"
      ) {
        const session = await this.retrieveAndValidatePaidSession(event.data.object.id);
        const purchase = await this.repository.provisionPaidPurchase(session);
        await this.deliverLicense(purchase, true);
      } else if (event.type === "checkout.session.async_payment_failed") {
        await this.repository.markPurchaseCanceled(event.data.object.id);
      } else if (event.type === "charge.refunded") {
        const intentId = chargePaymentIntentId(event.data.object.payment_intent);
        if (intentId && event.data.object.refunded) {
          await this.repository.markPurchaseByPaymentIntent(intentId, "refunded");
        }
      } else if (event.type === "charge.dispute.created") {
        const charge = await this.stripe.charges.retrieve(event.data.object.charge as string);
        const intentId = chargePaymentIntentId(charge.payment_intent);
        if (intentId) {
          await this.repository.markPurchaseByPaymentIntent(intentId, "disputed");
        }
      }
      await this.repository.markStripeEventProcessed(event.id);
    } catch (error) {
      await this.repository.markStripeEventFailed(event.id, errorMessage(error));
      throw error;
    }
  }

  private async retrieveAndValidatePaidSession(sessionId: string): Promise<PaidCheckoutSession> {
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9]{8,}$/.test(sessionId)) {
      throw new CommerceServiceError("invalid_checkout");
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["line_items.data.price"],
      });
    } catch {
      throw new CommerceServiceError("invalid_checkout");
    }

    if (session.payment_status !== "paid") {
      throw new CommerceServiceError("payment_not_complete");
    }
    const email = session.customer_details?.email ?? session.customer_email;
    const lineItem = session.line_items?.data[0];
    const priceId = typeof lineItem?.price === "string" ? lineItem.price : lineItem?.price?.id;
    if (
      session.metadata?.daytradingbot_product !== PRODUCT_KEY
      || session.amount_total !== PRODUCT_PRICE_CENTS
      || session.currency?.toLowerCase() !== "usd"
      || priceId !== this.config.stripePriceId
      || !email
    ) {
      throw new CommerceServiceError("invalid_checkout");
    }
    const intentId = paymentIntentId(session.payment_intent);
    return {
      sessionId: session.id,
      ...(intentId ? { paymentIntentId: intentId } : {}),
      customerEmail: email.toLowerCase(),
      amountCents: session.amount_total,
      currency: session.currency.toLowerCase(),
    };
  }

  private async deliverLicense(
    purchase: ProvisionedPurchase,
    strict: boolean,
  ): Promise<boolean> {
    if (!this.mailer) {
      if (strict) throw new CommerceServiceError("fulfillment_unavailable");
      return false;
    }
    const claim = await this.repository.claimLicenseDelivery(purchase.purchaseId);
    if (claim === "sent") return true;
    if (claim === "busy") return false;
    try {
      await this.mailer.sendLicense({
        to: purchase.customerEmail,
        activationCode: purchase.activationCode,
        downloads: this.config.downloads,
      });
      await this.repository.markLicenseDelivered(purchase.purchaseId);
      return true;
    } catch (error) {
      await this.repository.markLicenseDeliveryFailed(purchase.purchaseId, errorMessage(error));
      if (strict) throw error;
      return false;
    }
  }
}

export function commerceEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new CommerceServiceError("fulfillment_unavailable");
  return key;
}

export function sealCommerceValue(key: Buffer, label: string, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(label, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([ENCRYPTION_VERSION]), iv, tag, ciphertext]);
}

export function openCommerceValue(key: Buffer, label: string, payload: Buffer): string {
  if (payload.length < 30 || payload[0] !== ENCRYPTION_VERSION) {
    throw new CommerceServiceError("fulfillment_unavailable");
  }
  const iv = payload.subarray(1, 13);
  const tag = payload.subarray(13, 29);
  const ciphertext = payload.subarray(29);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(label, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CommerceServiceError("fulfillment_unavailable");
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}

export class PostgresCommerceRepository implements CommerceRepository {
  private readonly key: Buffer;

  constructor(
    private readonly pool: Pool,
    encryptionKeyValue: string,
    private readonly licensePepper: string,
  ) {
    this.key = commerceEncryptionKey(encryptionKeyValue);
  }

  async recordStripeEvent(
    eventId: string,
    eventType: string,
    payloadHash: Buffer,
  ): Promise<boolean> {
    const result = await this.pool.query<{ processed_at: Date | null }>(
      `INSERT INTO stripe_events (stripe_event_id, event_type, payload_sha256)
       VALUES ($1, $2, $3)
       ON CONFLICT (stripe_event_id) DO UPDATE
         SET event_type = EXCLUDED.event_type
       RETURNING processed_at`,
      [eventId, eventType, payloadHash],
    );
    return !result.rows[0]?.processed_at;
  }

  async markStripeEventProcessed(eventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE stripe_events
          SET processed_at = now(), processing_error = NULL
        WHERE stripe_event_id = $1`,
      [eventId],
    );
  }

  async markStripeEventFailed(eventId: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE stripe_events
          SET processing_error = $2
        WHERE stripe_event_id = $1`,
      [eventId, message],
    );
  }

  async provisionPaidPurchase(session: PaidCheckoutSession): Promise<ProvisionedPurchase> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const emailCiphertext = sealCommerceValue(this.key, "customer-email", session.customerEmail);
      const purchaseResult = await client.query<{ purchase_id: string; status: string }>(
        `INSERT INTO purchases
           (stripe_checkout_session_id, stripe_payment_intent_id, customer_email_ciphertext,
            amount_cents, currency, status, paid_at)
         VALUES ($1, $2, $3, $4, $5, 'paid', now())
         ON CONFLICT (stripe_checkout_session_id) DO UPDATE
           SET stripe_payment_intent_id = COALESCE(purchases.stripe_payment_intent_id, EXCLUDED.stripe_payment_intent_id),
               status = CASE
                 WHEN purchases.status IN ('refunded', 'disputed') THEN purchases.status
                 ELSE 'paid'
               END,
               paid_at = COALESCE(purchases.paid_at, now()),
               updated_at = now()
         RETURNING purchase_id, status`,
        [
          session.sessionId,
          session.paymentIntentId ?? null,
          emailCiphertext,
          session.amountCents,
          session.currency,
        ],
      );
      const purchase = purchaseResult.rows[0];
      const purchaseId = purchase?.purchase_id;
      if (!purchaseId) throw new CommerceServiceError("fulfillment_unavailable");
      if (purchase.status !== "paid") throw new CommerceServiceError("invalid_checkout");

      const existingResult = await client.query<{ license_code_ciphertext: Buffer; status: string }>(
        `SELECT license_code_ciphertext, status
           FROM licenses
          WHERE purchase_id = $1
          FOR UPDATE`,
        [purchaseId],
      );
      if (existingResult.rows[0] && existingResult.rows[0].status !== "active") {
        throw new CommerceServiceError("invalid_checkout");
      }
      let codeCiphertext = existingResult.rows[0]?.license_code_ciphertext;
      if (!codeCiphertext) {
        const activationCode = `DTB-${randomBytes(20).toString("hex").toUpperCase()}`;
        const candidateCiphertext = sealCommerceValue(this.key, "license-code", activationCode);
        await client.query(
          `INSERT INTO licenses
             (purchase_id, source, license_secret_hash, license_code_ciphertext, status)
           VALUES ($1, 'purchase', $2, $3, 'active')
           ON CONFLICT (purchase_id) DO NOTHING`,
          [
            purchaseId,
            hashLicenseSecret(this.licensePepper, activationCode),
            candidateCiphertext,
          ],
        );
        const insertedResult = await client.query<{ license_code_ciphertext: Buffer; status: string }>(
          `SELECT license_code_ciphertext, status
             FROM licenses
            WHERE purchase_id = $1
            FOR UPDATE`,
          [purchaseId],
        );
        if (insertedResult.rows[0]?.status !== "active") {
          throw new CommerceServiceError("invalid_checkout");
        }
        codeCiphertext = insertedResult.rows[0]?.license_code_ciphertext;
      }
      if (!codeCiphertext) throw new CommerceServiceError("fulfillment_unavailable");
      await client.query("COMMIT");
      return {
        purchaseId,
        customerEmail: session.customerEmail,
        activationCode: openCommerceValue(this.key, "license-code", codeCiphertext),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimLicenseDelivery(purchaseId: string): Promise<"send" | "sent" | "busy"> {
    const claimed = await this.pool.query(
      `INSERT INTO license_deliveries
         (purchase_id, attempts, sending_at, last_error, updated_at)
       VALUES ($1, 1, now(), NULL, now())
       ON CONFLICT (purchase_id) DO UPDATE
         SET attempts = license_deliveries.attempts + 1,
             sending_at = now(),
             last_error = NULL,
             updated_at = now()
       WHERE license_deliveries.delivered_at IS NULL
         AND (
           license_deliveries.sending_at IS NULL
           OR license_deliveries.sending_at < now() - interval '5 minutes'
         )
       RETURNING purchase_id`,
      [purchaseId],
    );
    if (claimed.rowCount) return "send";
    const current = await this.pool.query<{ delivered_at: Date | null }>(
      "SELECT delivered_at FROM license_deliveries WHERE purchase_id = $1",
      [purchaseId],
    );
    return current.rows[0]?.delivered_at ? "sent" : "busy";
  }

  async markLicenseDelivered(purchaseId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO license_deliveries (purchase_id, attempts, delivered_at, last_error, updated_at)
       VALUES ($1, 1, now(), NULL, now())
       ON CONFLICT (purchase_id) DO UPDATE
         SET delivered_at = now(),
             sending_at = NULL,
             last_error = NULL,
             updated_at = now()`,
      [purchaseId],
    );
  }

  async markLicenseDeliveryFailed(purchaseId: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE license_deliveries
          SET sending_at = NULL,
              last_error = $2,
              updated_at = now()
        WHERE purchase_id = $1`,
      [purchaseId, message],
    );
  }

  async markPurchaseCanceled(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE purchases
          SET status = 'canceled', updated_at = now()
        WHERE stripe_checkout_session_id = $1 AND status = 'pending'`,
      [sessionId],
    );
  }

  async markPurchaseByPaymentIntent(
    paymentIntentId: string,
    status: "refunded" | "disputed",
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const purchaseResult = await client.query<{ purchase_id: string }>(
        `UPDATE purchases
            SET status = $2,
                refunded_at = CASE WHEN $2 = 'refunded' THEN now() ELSE refunded_at END,
                updated_at = now()
          WHERE stripe_payment_intent_id = $1
          RETURNING purchase_id`,
        [paymentIntentId, status],
      );
      const purchaseId = purchaseResult.rows[0]?.purchase_id;
      if (purchaseId) {
        await client.query(
          `UPDATE licenses
              SET status = CASE WHEN $2 = 'refunded' THEN 'refunded' ELSE 'revoked' END,
                  revoked_at = now()
            WHERE purchase_id = $1`,
          [purchaseId, status],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

export class SmtpLicenseMailer implements LicenseMailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
    private readonly supportEmail: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async sendLicense(input: {
    to: string;
    activationCode: string;
    downloads: DownloadLinks;
  }): Promise<void> {
    const downloads = [
      input.downloads.webApp ? `Use in your browser: ${input.downloads.webApp}` : undefined,
      input.downloads.macos ? `Mac: ${input.downloads.macos}` : undefined,
    ].filter((value): value is string => Boolean(value));
    await this.transport.sendMail({
      from: this.from,
      to: input.to,
      subject: "Your DayTradingBot access code",
      text: [
        "Your DayTradingBot purchase is ready.",
        "",
        `Activation code: ${input.activationCode}`,
        "",
        ...downloads,
        "",
        "Open the browser app or install the Mac app, enter the activation code, connect an account you own, and begin in Practice.",
        `Need help? Email ${this.supportEmail}.`,
        "",
        "Real trading can lose money. DayTradingBot does not promise a profit or hold your trading funds.",
      ].join("\n"),
    });
  }
}
