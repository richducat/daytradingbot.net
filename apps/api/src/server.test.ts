import { afterEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { buildServer } from "./server.js";

const config: ApiConfig = {
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  DATABASE_PROVIDER: "postgres",
  DATABASE_URL: "postgresql://unused",
  PUBLIC_SITE_URL: "https://daytradingbot.net",
  CHECKOUT_ENABLED: true,
  LICENSE_EMAIL_FROM: "licenses@daytradingbot.net",
  SUPPORT_EMAIL: "support@daytradingbot.net",
};

const servers: ReturnType<typeof buildServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("control-plane API", () => {
  it("returns health without leaking framework metadata", async () => {
    const app = buildServer(config, { readinessCheck: async () => undefined });
    servers.push(app);
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("fails readiness closed when the database is unavailable", async () => {
    const app = buildServer(config, { readinessCheck: async () => { throw new Error("offline"); } });
    servers.push(app);
    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
  });

  it("returns a live Stripe checkout URL when commerce is configured", async () => {
    const commerceService = {
      createCheckoutSession: async () => ({ checkoutUrl: "https://checkout.stripe.com/c/pay/test" }),
      checkoutStatus: async () => ({
        status: "paid" as const,
        email: "buyer@example.com",
        activationCode: "DTB-TEST-CODE-123456",
        emailDelivered: true,
        downloads: { macos: "https://releases.daytradingbot.net/app.dmg" },
      }),
      handleWebhook: async () => undefined,
    };
    const app = buildServer(config, { readinessCheck: async () => undefined });
    const configured = buildServer(config, {
      readinessCheck: async () => undefined,
      commerceService,
    });
    servers.push(app);
    servers.push(configured);
    const response = await configured.inject({
      method: "POST",
      url: "/v1/checkout/session",
      payload: { acceptedRiskDisclosure: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ checkoutUrl: "https://checkout.stripe.com/c/pay/test" });
  });

  it("preserves the exact webhook body for Stripe signature verification", async () => {
    let receivedBody = "";
    let receivedSignature = "";
    const app = buildServer(config, {
      readinessCheck: async () => undefined,
      commerceService: {
        createCheckoutSession: async () => ({ checkoutUrl: "https://checkout.stripe.com/test" }),
        checkoutStatus: async () => {
          throw new Error("not used");
        },
        handleWebhook: async (body, signature) => {
          receivedBody = body.toString("utf8");
          receivedSignature = signature;
        },
      },
    });
    servers.push(app);
    const payload = '{"id":"evt_test","type":"checkout.session.completed"}';
    const response = await app.inject({
      method: "POST",
      url: "/v1/stripe/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=signature",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(receivedBody).toBe(payload);
    expect(receivedSignature).toBe("t=123,v1=signature");
  });

  it("keeps activation closed when the signing service is not configured", async () => {
    const app = buildServer(config, { readinessCheck: async () => undefined });
    servers.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/licenses/activate",
      payload: {
        licenseCode: "DTB-FOUNDER-TEST-0001",
        devicePublicKey: Buffer.alloc(32, 4).toString("base64url"),
        platform: "macos-universal",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "activation_unavailable" });
  });

  it("rejects Windows activation because the commercial app is Mac-only", async () => {
    const app = buildServer(config, { readinessCheck: async () => undefined });
    servers.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/licenses/activate",
      payload: {
        licenseCode: "DTB-FOUNDER-TEST-0001",
        devicePublicKey: Buffer.alloc(32, 4).toString("base64url"),
        platform: "windows-x64",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects checkout requests without affirmative risk acceptance", async () => {
    const app = buildServer(config, { readinessCheck: async () => undefined });
    servers.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/checkout/session",
      payload: { acceptedRiskDisclosure: false },
    });

    expect(response.statusCode).toBe(400);
  });

  it("keeps checkout closed until the commercial Mac download is ready", async () => {
    const app = buildServer({ ...config, CHECKOUT_ENABLED: false }, {
      readinessCheck: async () => undefined,
      commerceService: {
        createCheckoutSession: async () => ({ checkoutUrl: "https://checkout.stripe.com/never" }),
        checkoutStatus: async () => { throw new Error("not used"); },
        handleWebhook: async () => undefined,
      },
    });
    servers.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/checkout/session",
      payload: { acceptedRiskDisclosure: true },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "checkout_unavailable" });
  });

  it("allows the public site to call checkout without opening CORS to other sites", async () => {
    const app = buildServer(config, { readinessCheck: async () => undefined });
    servers.push(app);
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/v1/checkout/session",
      headers: {
        origin: "https://daytradingbot.net",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    const denied = await app.inject({
      method: "OPTIONS",
      url: "/v1/checkout/session",
      headers: {
        origin: "https://not-daytradingbot.example",
        "access-control-request-method": "POST",
      },
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://daytradingbot.net");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
