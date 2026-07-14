import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import {
  CommerceService,
  type CommerceRepository,
  type LicenseMailer,
  type PaidCheckoutSession,
  type ProvisionedPurchase,
} from "./commerce.js";

function paidSession(overrides: Record<string, unknown> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_test_1234567890",
    payment_status: "paid",
    amount_total: 9_800,
    currency: "usd",
    customer_details: { email: "BUYER@EXAMPLE.COM" },
    customer_email: null,
    metadata: { daytradingbot_product: "desktop-v1" },
    payment_intent: "pi_test_123",
    line_items: {
      object: "list",
      data: [{ price: { id: "price_test_98" } }],
      has_more: false,
      url: "/v1/line_items",
    },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function repository(): CommerceRepository & {
  provisionPaidPurchase: ReturnType<typeof vi.fn>;
  markStripeEventProcessed: ReturnType<typeof vi.fn>;
  markLicenseDelivered: ReturnType<typeof vi.fn>;
} {
  const seen = new Set<string>();
  return {
    recordStripeEvent: vi.fn(async (eventId: string) => {
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      return true;
    }),
    markStripeEventProcessed: vi.fn(async () => undefined),
    markStripeEventFailed: vi.fn(async () => undefined),
    provisionPaidPurchase: vi.fn(async (_session: PaidCheckoutSession): Promise<ProvisionedPurchase> => ({
      purchaseId: "74c966db-e7f2-4e77-853e-ff612dd4ce9f",
      customerEmail: "buyer@example.com",
      activationCode: "DTB-TEST-1234567890ABCDEF",
    })),
    claimLicenseDelivery: vi.fn(async () => "send" as const),
    markLicenseDelivered: vi.fn(async () => undefined),
    markLicenseDeliveryFailed: vi.fn(async () => undefined),
    markPurchaseCanceled: vi.fn(async () => undefined),
    markPurchaseByPaymentIntent: vi.fn(async () => undefined),
  };
}

function service(input: {
  session?: Stripe.Checkout.Session;
  event?: Stripe.Event;
  repository?: CommerceRepository;
  mailer?: LicenseMailer;
}) {
  const session = input.session ?? paidSession();
  const event = input.event ?? ({
    id: "evt_test_123",
    type: "checkout.session.completed",
    data: { object: { id: session.id } },
  } as Stripe.Event);
  const stripe = {
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://checkout.stripe.com/c/pay/test" })),
        retrieve: vi.fn(async () => session),
      },
    },
    webhooks: { constructEvent: vi.fn(() => event) },
    charges: { retrieve: vi.fn() },
  } as unknown as Stripe;
  return new CommerceService(
    stripe,
    input.repository ?? repository(),
    {
      publicSiteUrl: "https://daytradingbot.net",
      stripePriceId: "price_test_98",
      stripeWebhookSecret: "whsec_test",
      downloads: {
        macos: "https://releases.daytradingbot.net/DayTradingBot.dmg",
        windows: "https://releases.daytradingbot.net/DayTradingBot.exe",
      },
    },
    input.mailer,
  );
}

describe("commerce service", () => {
  it("creates a Stripe-hosted checkout that returns to automatic delivery", async () => {
    const commerce = service({});
    await expect(commerce.createCheckoutSession()).resolves.toEqual({
      checkoutUrl: "https://checkout.stripe.com/c/pay/test",
    });
  });

  it("provisions and emails a paid session once across duplicate webhooks", async () => {
    const repo = repository();
    const mailer: LicenseMailer = { sendLicense: vi.fn(async () => undefined) };
    const commerce = service({ repository: repo, mailer });

    await commerce.handleWebhook(Buffer.from('{"id":"evt_test_123"}'), "valid");
    await commerce.handleWebhook(Buffer.from('{"id":"evt_test_123"}'), "valid");

    expect(repo.provisionPaidPurchase).toHaveBeenCalledTimes(1);
    expect(mailer.sendLicense).toHaveBeenCalledTimes(1);
    expect(repo.markLicenseDelivered).toHaveBeenCalledTimes(1);
    expect(repo.markStripeEventProcessed).toHaveBeenCalledTimes(1);
  });

  it("refuses to fulfill a session that is not the paid DayTradingBot product", async () => {
    const commerce = service({
      session: paidSession({ metadata: { daytradingbot_product: "another-product" } }),
    });

    await expect(commerce.checkoutStatus("cs_test_1234567890"))
      .rejects.toMatchObject({ code: "invalid_checkout" });
  });
});
