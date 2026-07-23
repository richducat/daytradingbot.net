import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import { createPool as createMySqlPool } from "mysql2/promise";
import { Pool as PostgresPool } from "pg";
import Stripe from "stripe";
import { MySqlCommerceRepository } from "./commerce-mysql.js";
import {
  CommerceService,
  CommerceServiceError,
  PostgresCommerceRepository,
  SmtpLicenseMailer,
  type CommerceOperations,
  type DownloadLinks,
} from "./commerce.js";
import type { ApiConfig } from "./config.js";
import { MySqlLicenseRepository } from "./licensing-mysql.js";
import {
  LicenseService,
  LicenseServiceError,
  PostgresLicenseRepository,
  type DesktopPlatform,
} from "./licensing.js";
import { launchPolicy } from "./policy.js";
import {
  clearSessionCookie,
  MySqlWebAppRepository,
  parseSessionCookie,
  sessionCookie,
  WebAppError,
  WebAppService,
  type WebAppOperations,
  type WebSession,
  workerSecretMatches,
} from "./webapp.js";

type ServerDependencies = {
  readinessCheck?: () => Promise<void>;
  licenseService?: LicenseService;
  commerceService?: CommerceOperations;
  webAppService?: WebAppOperations;
};

function mysqlPoolConfig(databaseUrl: string) {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "mysql:" && parsed.protocol !== "mariadb:") {
    throw new Error("DATABASE_URL must use mysql:// or mariadb:// when DATABASE_PROVIDER=mysql");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !parsed.username || !database) {
    throw new Error("DATABASE_URL is missing the database host, user, or name");
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    charset: "utf8mb4",
    timezone: "Z",
    connectionLimit: 10,
    enableKeepAlive: true,
  };
}

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
        "*.activationToken",
        "*.licenseCode",
        "*.privateKey",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
  };

  const app = Fastify({
    bodyLimit: 64 * 1024,
    trustProxy: ["127.0.0.1", "::1"],
    // OAuth callbacks contain a short-lived authorization code in the query
    // string. Disable framework request logs so that code never reaches disk.
    logController: new LogController({ disableRequestLogging: true }),
    logger,
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      if (request.url.startsWith("/v1/stripe/webhook")) {
        done(null, body);
        return;
      }
      try {
        done(null, JSON.parse(body.toString("utf8")) as unknown);
      } catch {
        const error = new Error("Invalid JSON") as Error & { statusCode: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  const postgresPool = dependencies.readinessCheck || config.DATABASE_PROVIDER !== "postgres"
    ? undefined
    : new PostgresPool({ connectionString: config.DATABASE_URL });
  const mysqlPool = dependencies.readinessCheck || config.DATABASE_PROVIDER !== "mysql"
    ? undefined
    : createMySqlPool(mysqlPoolConfig(config.DATABASE_URL));
  const databaseConfigured = Boolean(postgresPool || mysqlPool);
  const licenseRepository = postgresPool
    ? new PostgresLicenseRepository(postgresPool)
    : mysqlPool
      ? new MySqlLicenseRepository(mysqlPool)
      : undefined;
  const licenseService = dependencies.licenseService ?? (
    licenseRepository && config.LICENSE_SIGNING_PRIVATE_KEY_PEM && config.LICENSE_SECRET_PEPPER
      ? new LicenseService(
        licenseRepository,
        config.LICENSE_SIGNING_PRIVATE_KEY_PEM,
        config.LICENSE_SECRET_PEPPER,
      )
      : undefined
  );
  const downloads: DownloadLinks = {
    webApp: `${config.PUBLIC_SITE_URL.replace(/\/$/, "")}/app/`,
    ...(config.MACOS_DOWNLOAD_URL ? { macos: config.MACOS_DOWNLOAD_URL } : {}),
  };
  const commerceConfigured = Boolean(
    databaseConfigured
    && config.STRIPE_SECRET_KEY
    && config.STRIPE_WEBHOOK_SECRET
    && config.STRIPE_PRICE_ID
    && config.COMMERCE_ENCRYPTION_KEY
    && config.LICENSE_SECRET_PEPPER
    && config.SMTP_URL
  );
  const commerceRepository = postgresPool && config.COMMERCE_ENCRYPTION_KEY && config.LICENSE_SECRET_PEPPER
    ? new PostgresCommerceRepository(
      postgresPool,
      config.COMMERCE_ENCRYPTION_KEY,
      config.LICENSE_SECRET_PEPPER,
    )
    : mysqlPool && config.COMMERCE_ENCRYPTION_KEY && config.LICENSE_SECRET_PEPPER
      ? new MySqlCommerceRepository(
        mysqlPool,
        config.COMMERCE_ENCRYPTION_KEY,
        config.LICENSE_SECRET_PEPPER,
      )
      : undefined;
  const commerceService = dependencies.commerceService ?? (
    commerceConfigured && commerceRepository
      ? new CommerceService(
        new Stripe(config.STRIPE_SECRET_KEY as string),
        commerceRepository,
        {
          publicSiteUrl: config.PUBLIC_SITE_URL,
          stripePriceId: config.STRIPE_PRICE_ID as string,
          stripeWebhookSecret: config.STRIPE_WEBHOOK_SECRET as string,
          downloads,
        },
        new SmtpLicenseMailer(
          config.SMTP_URL as string,
          config.LICENSE_EMAIL_FROM,
          config.SUPPORT_EMAIL,
        ),
      )
      : undefined
  );
  const webAppService = dependencies.webAppService ?? (
    config.WEBAPP_ENABLED
    && mysqlPool
    && config.WEB_SESSION_SECRET
    && config.TRADING_CREDENTIAL_ENCRYPTION_KEY
    && config.LICENSE_SECRET_PEPPER
      ? new WebAppService(
        new MySqlWebAppRepository(
          mysqlPool,
          config.WEB_SESSION_SECRET,
          config.TRADING_CREDENTIAL_ENCRYPTION_KEY,
          config.LICENSE_SECRET_PEPPER,
        ),
        config.PUBLIC_API_URL,
        config.PUBLIC_SITE_URL,
        config.REAL_TRADING_ENABLED,
      )
      : undefined
  );
  const readinessCheck = dependencies.readinessCheck ?? (async () => {
    if (postgresPool) await postgresPool.query("SELECT 1");
    if (mysqlPool) await mysqlPool.execute("SELECT 1");
    if (config.NODE_ENV === "production" && (!licenseService || !commerceService)) {
      throw new Error("commercial services are not configured");
    }
    if (config.NODE_ENV === "production" && config.WEBAPP_ENABLED && !webAppService) {
      throw new Error("browser app services are not configured");
    }
    if (config.NODE_ENV === "production" && config.WEBAPP_ENABLED) {
      if (!config.WORKER_SECRET) throw new Error("browser trading worker is not configured");
      if (!await webAppService?.workerReady()) throw new Error("browser trading worker is stale");
    }
  });

  app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  app.register(cors, {
    origin: (origin, callback) => {
      callback(null, !origin || origin === config.PUBLIC_SITE_URL);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "x-csrf-token"],
    credentials: true,
    maxAge: 600,
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

  const requireBrowserApp = (): WebAppOperations => {
    if (!webAppService) throw new WebAppError("webapp_unavailable");
    return webAppService;
  };
  const requireSiteOrigin = (origin: string | undefined): void => {
    if (origin !== config.PUBLIC_SITE_URL) throw new WebAppError("invalid_csrf");
  };
  const authenticateBrowser = async (request: FastifyRequest): Promise<WebSession> => {
    const token = parseSessionCookie(request.headers.cookie);
    if (!token) throw new WebAppError("not_authenticated");
    return requireBrowserApp().authenticate(token);
  };
  const authenticateMutation = async (request: FastifyRequest): Promise<WebSession> => {
    requireSiteOrigin(request.headers.origin);
    const session = await authenticateBrowser(request);
    const csrf = request.headers["x-csrf-token"];
    requireBrowserApp().requireCsrf(session, typeof csrf === "string" ? csrf : undefined);
    return session;
  };

  app.post(
    "/v1/web/session",
    {
      config: { rateLimit: { max: 6, timeWindow: "10 minutes" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["licenseCode"],
          properties: { licenseCode: { type: "string", minLength: 16, maxLength: 84 } },
        },
      },
    },
    async (request, reply) => {
      requireSiteOrigin(request.headers.origin);
      const body = request.body as { licenseCode: string };
      const session = await requireBrowserApp().login(body.licenseCode);
      reply.header("cache-control", "no-store");
      reply.header("set-cookie", sessionCookie(session.sessionToken));
      return {
        authenticated: true,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt.toISOString(),
        dashboard: await requireBrowserApp().dashboard(session.licenseId),
      };
    },
  );

  app.get(
    "/v1/web/session",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      try {
        const session = await authenticateBrowser(request);
        return {
          authenticated: true,
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt.toISOString(),
          dashboard: await requireBrowserApp().dashboard(session.licenseId),
        };
      } catch (error) {
        if (
          error instanceof WebAppError
          && (error.code === "not_authenticated" || error.code === "session_expired")
        ) {
          reply.header("set-cookie", clearSessionCookie());
          return { authenticated: false };
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/web/session/logout",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const session = await authenticateMutation(request);
      await requireBrowserApp().logout(session);
      reply.header("cache-control", "no-store");
      reply.header("set-cookie", clearSessionCookie());
      return { authenticated: false };
    },
  );

  app.get(
    "/v1/web/dashboard",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const session = await authenticateBrowser(request);
      return requireBrowserApp().dashboard(session.licenseId);
    },
  );

  app.post(
    "/v1/web/connections/robinhood/start",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const session = await authenticateMutation(request);
      reply.header("cache-control", "no-store");
      return requireBrowserApp().beginRobinhoodConnection(session.licenseId);
    },
  );

  app.get(
    "/v1/web/connections/robinhood/callback",
    {
      config: { rateLimit: { max: 20, timeWindow: "10 minutes" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: true,
          properties: {
            state: { type: "string", maxLength: 128 },
            code: { type: "string", maxLength: 4096 },
            error: { type: "string", maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { state?: string; code?: string; error?: string };
      const redirect = await requireBrowserApp().completeRobinhoodConnection(query);
      reply.header("cache-control", "no-store");
      reply.header("referrer-policy", "no-referrer");
      return reply.redirect(redirect, 303);
    },
  );

  app.post(
    "/v1/web/connections/robinhood/check",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const session = await authenticateMutation(request);
      reply.header("cache-control", "no-store");
      return requireBrowserApp().checkRobinhoodConnection(session.licenseId);
    },
  );

  app.post(
    "/v1/web/connections/robinhood/disconnect",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (request) => {
      const session = await authenticateMutation(request);
      await requireBrowserApp().disconnectRobinhood(session.licenseId);
      return { disconnected: true };
    },
  );

  app.post(
    "/v1/web/settings",
    {
      config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "dailyBudgetUsd", "maxPerTradeUsd"],
          properties: {
            mode: { type: "string", enum: ["practice", "real"] },
            dailyBudgetUsd: { type: "number", minimum: 1, maximum: 25, multipleOf: 0.01 },
            maxPerTradeUsd: { type: "number", minimum: 1, maximum: 5, multipleOf: 0.01 },
          },
        },
      },
    },
    async (request, reply) => {
      const session = await authenticateMutation(request);
      const body = request.body as { mode: "practice" | "real"; dailyBudgetUsd: number; maxPerTradeUsd: number };
      reply.header("cache-control", "no-store");
      return requireBrowserApp().saveSettings(session.licenseId, body);
    },
  );

  app.post(
    "/v1/web/trading/start",
    {
      config: { rateLimit: { max: 10, timeWindow: "10 minutes" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "acceptedRealRisk"],
          properties: {
            mode: { type: "string", enum: ["practice", "real"] },
            acceptedRealRisk: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const session = await authenticateMutation(request);
      const body = request.body as { mode: "practice" | "real"; acceptedRealRisk: boolean };
      reply.header("cache-control", "no-store");
      return requireBrowserApp().start(session.licenseId, body);
    },
  );

  app.post(
    "/v1/web/trading/pause",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const session = await authenticateMutation(request);
      reply.header("cache-control", "no-store");
      return requireBrowserApp().pause(session.licenseId);
    },
  );

  app.post(
    "/v1/internal/run-due-trading-cycles",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const authorization = request.headers.authorization;
      const provided = typeof authorization === "string" && authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : undefined;
      if (!config.WORKER_SECRET || !workerSecretMatches(config.WORKER_SECRET, provided)) {
        return reply.code(401).send({ error: "not_authenticated" });
      }
      return requireBrowserApp().runDueCycles();
    },
  );

  app.post(
    "/v1/licenses/activate",
    {
      config: { rateLimit: { max: 8, timeWindow: "10 minutes" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["licenseCode", "devicePublicKey", "platform"],
          properties: {
            licenseCode: { type: "string", minLength: 16, maxLength: 84 },
            devicePublicKey: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
            platform: { type: "string", enum: ["macos-universal"] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!licenseService) {
        return reply.code(503).send({
          error: "activation_unavailable",
          message: "App activation is temporarily unavailable.",
        });
      }
      const body = request.body as {
        licenseCode: string;
        devicePublicKey: string;
        platform: DesktopPlatform;
      };
      try {
        return await licenseService.activate(body);
      } catch (error) {
        if (error instanceof LicenseServiceError) {
          if (error.code === "device_already_active") {
            return reply.code(409).send({
              error: error.code,
              message: "This purchase is already active on another computer.",
            });
          }
          if (error.code === "invalid_license") {
            return reply.code(401).send({
              error: error.code,
              message: "That purchase code was not recognized.",
            });
          }
          return reply.code(503).send({
            error: "activation_unavailable",
            message: "App activation is temporarily unavailable.",
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/licenses/renew",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["activationToken", "devicePublicKey"],
          properties: {
            activationToken: { type: "string", pattern: "^dtb_act_[A-Za-z0-9_-]{43}$" },
            devicePublicKey: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
          },
        },
      },
    },
    async (request, reply) => {
      if (!licenseService) {
        return reply.code(503).send({ error: "activation_unavailable" });
      }
      const body = request.body as { activationToken: string; devicePublicKey: string };
      try {
        return await licenseService.renew(body);
      } catch (error) {
        if (error instanceof LicenseServiceError) {
          if (error.code === "invalid_activation") {
            return reply.code(401).send({ error: error.code });
          }
          return reply.code(503).send({ error: "activation_unavailable" });
        }
        throw error;
      }
    },
  );

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
      if (!commerceService || !config.CHECKOUT_ENABLED) {
        return reply.code(503).send({
          error: "checkout_unavailable",
          message: config.CHECKOUT_ENABLED
            ? "Checkout is temporarily unavailable. Please try again shortly."
            : "Checkout is not open yet. No card has been charged.",
        });
      }
      try {
        return await commerceService.createCheckoutSession();
      } catch (error) {
        if (error instanceof CommerceServiceError) {
          return reply.code(503).send({
            error: error.code,
            message: "Checkout is temporarily unavailable. Please try again shortly.",
          });
        }
        throw error;
      }
    },
  );

  app.get(
    "/v1/checkout/status",
    {
      config: { rateLimit: { max: 20, timeWindow: "10 minutes" } },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["session"],
          properties: {
            session: {
              type: "string",
              pattern: "^cs_(?:test_|live_)?[A-Za-z0-9]{8,}$",
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!commerceService) {
        return reply.code(503).send({ error: "fulfillment_unavailable" });
      }
      const { session: sessionId } = request.query as { session: string };
      try {
        return await commerceService.checkoutStatus(sessionId);
      } catch (error) {
        if (error instanceof CommerceServiceError) {
          if (error.code === "payment_not_complete") {
            return reply.code(409).send({ error: error.code });
          }
          if (error.code === "invalid_checkout") {
            return reply.code(400).send({ error: error.code });
          }
          return reply.code(503).send({ error: "fulfillment_unavailable" });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/stripe/webhook",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!commerceService) {
        return reply.code(503).send({ error: "fulfillment_unavailable" });
      }
      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string" || !Buffer.isBuffer(request.body)) {
        return reply.code(400).send({ error: "invalid_webhook" });
      }
      try {
        await commerceService.handleWebhook(request.body, signature);
        return { received: true };
      } catch (error) {
        if (error instanceof CommerceServiceError && error.code === "invalid_webhook") {
          return reply.code(400).send({ error: error.code });
        }
        throw error;
      }
    },
  );

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ error: "not_found" });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof WebAppError) {
      const status = error.code === "invalid_code" || error.code === "not_authenticated" || error.code === "session_expired"
        ? 401
        : error.code === "invalid_csrf"
          ? 403
          : error.code === "pause_before_changing"
            ? 409
            : error.code === "invalid_limits" || error.code === "real_risk_acknowledgement_required"
              ? 400
              : 503;
      const messages: Partial<Record<WebAppError["code"], string>> = {
        invalid_code: "That purchase code was not recognized.",
        not_authenticated: "Sign in to use the browser app.",
        session_expired: "Your browser session ended. Sign in again.",
        invalid_csrf: "Refresh the page and try again.",
        connection_required: "Connect one dedicated Robinhood Agentic account first.",
        connection_unavailable: "Robinhood could not be connected right now.",
        invalid_limits: "Choose $1–$25 for the day and $1–$5 for each trade.",
        pause_before_changing: "Pause trading before changing these settings.",
        real_trading_unavailable: "Real trading is temporarily unavailable. Practice still works.",
        real_risk_acknowledgement_required: "Review the real-trading warning before starting.",
        trading_unavailable: "Bluechip's market checker has not checked in. No trading can start until it is back online.",
      };
      return reply.code(status).send({
        error: error.code,
        message: messages[error.code] ?? "The browser app is temporarily unavailable.",
      });
    }
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
    await postgresPool?.end();
    await mysqlPool?.end();
  });

  return app;
}
