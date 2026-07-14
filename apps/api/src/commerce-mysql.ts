import { randomBytes, randomUUID } from "node:crypto";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import {
  CommerceServiceError,
  commerceEncryptionKey,
  openCommerceValue,
  sealCommerceValue,
  type CommerceRepository,
  type PaidCheckoutSession,
  type ProvisionedPurchase,
} from "./commerce.js";
import { hashLicenseSecret } from "./licensing.js";

interface StripeEventRow extends RowDataPacket {
  processed_at: Date | null;
}

interface PurchaseRow extends RowDataPacket {
  purchase_id: string;
  status: string;
}

interface LicenseCodeRow extends RowDataPacket {
  license_code_ciphertext: Buffer;
  status: string;
}

interface DeliveryRow extends RowDataPacket {
  delivered_at: Date | null;
}

async function rollbackQuietly(connection: PoolConnection): Promise<void> {
  try {
    await connection.rollback();
  } catch {
    // Preserve the original transaction failure.
  }
}

export class MySqlCommerceRepository implements CommerceRepository {
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
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO stripe_events (stripe_event_id, event_type, payload_sha256)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE event_type = VALUES(event_type)`,
      [eventId, eventType, payloadHash],
    );
    const [rows] = await this.pool.execute<StripeEventRow[]>(
      `SELECT processed_at
         FROM stripe_events
        WHERE stripe_event_id = ?`,
      [eventId],
    );
    return !rows[0]?.processed_at;
  }

  async markStripeEventProcessed(eventId: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE stripe_events
          SET processed_at = UTC_TIMESTAMP(6), processing_error = NULL
        WHERE stripe_event_id = ?`,
      [eventId],
    );
  }

  async markStripeEventFailed(eventId: string, message: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE stripe_events
          SET processing_error = ?
        WHERE stripe_event_id = ?`,
      [message, eventId],
    );
  }

  async provisionPaidPurchase(session: PaidCheckoutSession): Promise<ProvisionedPurchase> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const candidatePurchaseId = randomUUID();
      const emailCiphertext = sealCommerceValue(this.key, "customer-email", session.customerEmail);
      await connection.execute<ResultSetHeader>(
        `INSERT INTO purchases
           (purchase_id, stripe_checkout_session_id, stripe_payment_intent_id,
            customer_email_ciphertext, amount_cents, currency, status, paid_at)
         VALUES (?, ?, ?, ?, ?, ?, 'paid', UTC_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE
           stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, VALUES(stripe_payment_intent_id)),
           status = IF(status IN ('refunded', 'disputed'), status, 'paid'),
           paid_at = COALESCE(paid_at, UTC_TIMESTAMP(6)),
           updated_at = UTC_TIMESTAMP(6)`,
        [
          candidatePurchaseId,
          session.sessionId,
          session.paymentIntentId ?? null,
          emailCiphertext,
          session.amountCents,
          session.currency,
        ],
      );
      const [purchaseRows] = await connection.execute<PurchaseRow[]>(
        `SELECT purchase_id, status
           FROM purchases
          WHERE stripe_checkout_session_id = ?
          FOR UPDATE`,
        [session.sessionId],
      );
      const purchaseId = purchaseRows[0]?.purchase_id;
      if (!purchaseId) throw new CommerceServiceError("fulfillment_unavailable");
      if (purchaseRows[0]?.status !== "paid") {
        throw new CommerceServiceError("invalid_checkout");
      }

      let [licenseRows] = await connection.execute<LicenseCodeRow[]>(
        `SELECT license_code_ciphertext, status
           FROM licenses
          WHERE purchase_id = ?
          FOR UPDATE`,
        [purchaseId],
      );
      if (licenseRows[0] && licenseRows[0].status !== "active") {
        throw new CommerceServiceError("invalid_checkout");
      }
      if (!licenseRows[0]) {
        const activationCode = `DTB-${randomBytes(20).toString("hex").toUpperCase()}`;
        await connection.execute<ResultSetHeader>(
          `INSERT INTO licenses
             (license_id, purchase_id, source, license_secret_hash,
              license_code_ciphertext, status)
           VALUES (?, ?, 'purchase', ?, ?, 'active')`,
          [
            randomUUID(),
            purchaseId,
            hashLicenseSecret(this.licensePepper, activationCode),
            sealCommerceValue(this.key, "license-code", activationCode),
          ],
        );
        [licenseRows] = await connection.execute<LicenseCodeRow[]>(
          `SELECT license_code_ciphertext, status
             FROM licenses
            WHERE purchase_id = ?
            FOR UPDATE`,
          [purchaseId],
        );
      }
      const codeCiphertext = licenseRows[0]?.license_code_ciphertext;
      if (!codeCiphertext || licenseRows[0]?.status !== "active") {
        throw new CommerceServiceError("fulfillment_unavailable");
      }
      await connection.commit();
      return {
        purchaseId,
        customerEmail: session.customerEmail,
        activationCode: openCommerceValue(this.key, "license-code", codeCiphertext),
      };
    } catch (error) {
      await rollbackQuietly(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async claimLicenseDelivery(purchaseId: string): Promise<"send" | "sent" | "busy"> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO license_deliveries (purchase_id, attempts, updated_at)
       VALUES (?, 0, UTC_TIMESTAMP(6))`,
      [purchaseId],
    );
    const [claim] = await this.pool.execute<ResultSetHeader>(
      `UPDATE license_deliveries
          SET attempts = attempts + 1,
              sending_at = UTC_TIMESTAMP(6),
              last_error = NULL,
              updated_at = UTC_TIMESTAMP(6)
        WHERE purchase_id = ?
          AND delivered_at IS NULL
          AND (sending_at IS NULL OR sending_at < UTC_TIMESTAMP(6) - INTERVAL 5 MINUTE)`,
      [purchaseId],
    );
    if (claim.affectedRows === 1) return "send";
    const [rows] = await this.pool.execute<DeliveryRow[]>(
      `SELECT delivered_at
         FROM license_deliveries
        WHERE purchase_id = ?`,
      [purchaseId],
    );
    return rows[0]?.delivered_at ? "sent" : "busy";
  }

  async markLicenseDelivered(purchaseId: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO license_deliveries
         (purchase_id, attempts, delivered_at, last_error, updated_at)
       VALUES (?, 1, UTC_TIMESTAMP(6), NULL, UTC_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE
         delivered_at = UTC_TIMESTAMP(6),
         sending_at = NULL,
         last_error = NULL,
         updated_at = UTC_TIMESTAMP(6)`,
      [purchaseId],
    );
  }

  async markLicenseDeliveryFailed(purchaseId: string, message: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE license_deliveries
          SET sending_at = NULL,
              last_error = ?,
              updated_at = UTC_TIMESTAMP(6)
        WHERE purchase_id = ?`,
      [message, purchaseId],
    );
  }

  async markPurchaseCanceled(sessionId: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE purchases
          SET status = 'canceled', updated_at = UTC_TIMESTAMP(6)
        WHERE stripe_checkout_session_id = ? AND status = 'pending'`,
      [sessionId],
    );
  }

  async markPurchaseByPaymentIntent(
    paymentIntentId: string,
    status: "refunded" | "disputed",
  ): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [purchaseRows] = await connection.execute<PurchaseRow[]>(
        `SELECT purchase_id
           FROM purchases
          WHERE stripe_payment_intent_id = ?
          FOR UPDATE`,
        [paymentIntentId],
      );
      const purchaseId = purchaseRows[0]?.purchase_id;
      if (purchaseId) {
        await connection.execute<ResultSetHeader>(
          `UPDATE purchases
              SET status = ?,
                  refunded_at = IF(? = 'refunded', UTC_TIMESTAMP(6), refunded_at),
                  updated_at = UTC_TIMESTAMP(6)
            WHERE purchase_id = ?`,
          [status, status, purchaseId],
        );
        await connection.execute<ResultSetHeader>(
          `UPDATE licenses
              SET status = IF(? = 'refunded', 'refunded', 'revoked'),
                  revoked_at = UTC_TIMESTAMP(6)
            WHERE purchase_id = ?`,
          [status, purchaseId],
        );
      }
      await connection.commit();
    } catch (error) {
      await rollbackQuietly(connection);
      throw error;
    } finally {
      connection.release();
    }
  }
}
