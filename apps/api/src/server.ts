import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import type { ApiConfig } from "./config.js";
import { launchPolicy } from "./policy.js";

type ServerDependencies = {
  readinessCheck?: () => Promise<void>;
};

export function buildServer(config: ApiConfig, dependencies: ServerDependencies = {}): FastifyInstance {
  const logger = config.NODE_ENV === "test" ? false : {
    level: config.NODE_ENV === "production" ? "info" : "debug",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.stripe-signature",
        "res.headers.set-cookie",
        "*.apiKey",
        "*.privateKey",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
  };

  const app = Fastify({
    bodyLimit: 64 * 1024,
    trustProxy: ["127.0.0.1", "::1"],
    logger,
  });

  const pool = dependencies.readinessCheck ? undefined : new Pool({ connectionString: config.DATABASE_URL });
  const readinessCheck = dependencies.readinessCheck ?? (async () => {
    await pool?.query("SELECT 1");
  });

  app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await readinessCheck();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.get("/v1/policy", async () => ({ version: 1, policy: launchPolicy }));

  app.post(
    "/v1/checkout/session",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["acceptedRiskDisclosure"],
          properties: {
            acceptedRiskDisclosure: { type: "boolean", const: true },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.code(503).send({
        error: "checkout_not_open",
        message: "Founder checkout remains closed until every commercial launch gate passes.",
      });
    },
  );

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ error: "not_found" });
  });

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const candidate = typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    const status = typeof candidate === "number" && candidate >= 400 && candidate < 500
      ? candidate
      : 500;
    return reply.code(status).send({
      error: status === 500 ? "internal_error" : "invalid_request",
    });
  });

  app.addHook("onClose", async () => {
    await pool?.end();
  });

  return app;
}
