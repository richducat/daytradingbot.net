import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  Pool,
  PoolConnection,
  RowDataPacket,
} from "mysql2/promise";
import { hashLicenseSecret } from "./licensing.js";

const SESSION_SECONDS = 7 * 24 * 60 * 60;

export type WebDashboard = {
  app: "daytradingbot-web";
  entitlement: {
    status: "active";
  };
};

export type WebSession = {
  licenseId: string;
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
};

export type LoginResult = WebSession & { sessionToken: string };

export type WebAppErrorCode =
  | "invalid_code"
  | "not_authenticated"
  | "session_expired"
  | "invalid_csrf"
  | "webapp_unavailable";

export class WebAppError extends Error {
  constructor(readonly code: WebAppErrorCode) {
    super(code);
    this.name = "WebAppError";
  }
}

interface SessionRow extends RowDataPacket {
  session_id: string;
  license_id: string;
  expires_at: Date;
}

function normalizeCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^DTB-[A-Z0-9-]{12,80}$/.test(normalized)) throw new WebAppError("invalid_code");
  return normalized;
}

function secureHash(secret: string, purpose: string, value: string): Buffer {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`, "utf8").digest();
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function rollbackQuietly(connection: PoolConnection): Promise<void> {
  try {
    await connection.rollback();
  } catch {
    // Preserve the database error that caused the rollback.
  }
}

/**
 * Shared-host persistence is deliberately limited to licensed browser sessions.
 * Brokerage credentials and customer trading data belong on the customer device.
 */
export class MySqlWebAppRepository {
  constructor(
    private readonly pool: Pool,
    private readonly sessionSecret: string,
    private readonly licensePepper: string,
  ) {
    if (sessionSecret.length < 32 || licensePepper.length < 32) {
      throw new WebAppError("webapp_unavailable");
    }
  }

  sessionHash(token: string): Buffer {
    return secureHash(this.sessionSecret, "web-session", token);
  }

  csrfToken(token: string): string {
    return secureHash(this.sessionSecret, "web-csrf", token).toString("base64url");
  }

  async createSession(licenseCode: string): Promise<LoginResult> {
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1_000);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [licenses] = await connection.execute<(RowDataPacket & { license_id: string })[]>(
        `SELECT license_id
           FROM licenses
          WHERE license_secret_hash = ? AND status = 'active'
          FOR UPDATE`,
        [hashLicenseSecret(this.licensePepper, licenseCode)],
      );
      const licenseId = licenses[0]?.license_id;
      if (!licenseId) {
        await connection.rollback();
        throw new WebAppError("invalid_code");
      }
      await connection.execute(
        `UPDATE web_sessions
            SET revoked_at = UTC_TIMESTAMP(6)
          WHERE license_id = ? AND revoked_at IS NULL`,
        [licenseId],
      );
      await connection.execute(
        `INSERT INTO web_sessions
           (session_id, license_id, session_token_hash, expires_at)
         VALUES (?, ?, ?, ?)`,
        [sessionId, licenseId, this.sessionHash(token), expiresAt],
      );
      await connection.commit();
      return {
        licenseId,
        sessionId,
        sessionToken: token,
        csrfToken: this.csrfToken(token),
        expiresAt,
      };
    } catch (error) {
      await rollbackQuietly(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async authenticate(sessionToken: string): Promise<WebSession> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw new WebAppError("not_authenticated");
    const [rows] = await this.pool.execute<SessionRow[]>(
      `SELECT s.session_id, s.license_id, s.expires_at
         FROM web_sessions s
         JOIN licenses l ON l.license_id = s.license_id
        WHERE s.session_token_hash = ?
          AND s.revoked_at IS NULL
          AND s.expires_at > UTC_TIMESTAMP(6)
          AND l.status = 'active'
        LIMIT 1`,
      [this.sessionHash(sessionToken)],
    );
    const row = rows[0];
    if (!row) throw new WebAppError("session_expired");
    await this.pool.execute(
      "UPDATE web_sessions SET last_seen_at = UTC_TIMESTAMP(6) WHERE session_id = ?",
      [row.session_id],
    );
    return {
      licenseId: row.license_id,
      sessionId: row.session_id,
      csrfToken: this.csrfToken(sessionToken),
      expiresAt: row.expires_at,
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.pool.execute(
      "UPDATE web_sessions SET revoked_at = UTC_TIMESTAMP(6) WHERE session_id = ?",
      [sessionId],
    );
  }
}

export interface WebAppOperations {
  login(licenseCode: string): Promise<LoginResult>;
  authenticate(sessionToken: string): Promise<WebSession>;
  requireCsrf(session: WebSession, csrfToken: string | undefined): void;
  logout(session: WebSession): Promise<void>;
  dashboard(licenseId: string): Promise<WebDashboard>;
}

export class WebAppService implements WebAppOperations {
  constructor(private readonly repository: MySqlWebAppRepository) {}

  login(licenseCode: string): Promise<LoginResult> {
    return this.repository.createSession(normalizeCode(licenseCode));
  }

  authenticate(sessionToken: string): Promise<WebSession> {
    return this.repository.authenticate(sessionToken);
  }

  requireCsrf(session: WebSession, csrfToken: string | undefined): void {
    if (!csrfToken || !safeEqual(session.csrfToken, csrfToken)) throw new WebAppError("invalid_csrf");
  }

  logout(session: WebSession): Promise<void> {
    return this.repository.revokeSession(session.sessionId);
  }

  async dashboard(_licenseId: string): Promise<WebDashboard> {
    return {
      app: "daytradingbot-web",
      entitlement: { status: "active" },
    };
  }
}

export const webSessionCookieName = "__Host-dtb_session";

export function parseSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const cookies = header.split(";");
  for (const cookie of cookies) {
    const [name, ...parts] = cookie.trim().split("=");
    if (name !== webSessionCookieName) continue;
    const value = parts.join("=");
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }
  return undefined;
}

export function sessionCookie(token: string, maxAge = SESSION_SECONDS): string {
  return `${webSessionCookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie(): string {
  return `${webSessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
