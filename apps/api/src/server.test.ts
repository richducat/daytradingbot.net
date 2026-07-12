import { afterEach, describe, expect, it } from "vitest";
import type { ApiConfig } from "./config.js";
import { buildServer } from "./server.js";

const config: ApiConfig = {
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: 3000,
  DATABASE_URL: "postgresql://unused",
  PUBLIC_SITE_URL: "https://daytradingbot.net",
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

  it("keeps checkout closed until launch gates pass", async () => {
    const app = buildServer(config, { readinessCheck: async () => undefined });
    servers.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/checkout/session",
      payload: { acceptedRiskDisclosure: true },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "checkout_not_open" });
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
});

