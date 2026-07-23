import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import {
  commerceEncryptionKey,
  openCommerceValue,
  sealCommerceValue,
} from "./commerce.js";
import { hashLicenseSecret } from "./licensing.js";
import {
  exchangeRobinhoodCode,
  newIntentId,
  newOauthState,
  refreshRobinhoodToken,
  registerRobinhoodWebClient,
  RobinhoodError,
  RobinhoodMcpClient,
  type RobinhoodOrder,
  type RobinhoodSnapshot,
  type RobinhoodTokenBundle,
} from "./robinhood-web.js";

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const REAL_AUTHORIZATION_SECONDS = 24 * 60 * 60;
const REAL_DISCLOSURE_VERSION = "2026-07-22-v1";
const OAUTH_STATE_SECONDS = 10 * 60;
const AGENT_CADENCE_MINUTES = 15;
const WORKER_STALE_MINUTES = 12;
const CYCLE_LOCK_MINUTES = 8;
const WATCHLIST = ["AAPL", "NVDA", "TSLA", "SPY", "QQQ", "AMD", "MSFT", "GOOGL"];
const DIP_THRESHOLD_PERCENT = -1.5;
const MAX_TRADES_PER_CYCLE = 2;
const STRATEGY_ID = "bluechip-pullback-v1";

export type TradingMode = "practice" | "real";
export type ActivityKind =
  | "started"
  | "paused"
  | "market_check"
  | "signal"
  | "skipped"
  | "reviewed"
  | "order_submitted"
  | "filled"
  | "error";

export type WebSettings = {
  agentId: "bluechip";
  mode: TradingMode;
  dailyBudgetUsd: number;
  maxPerTradeUsd: number;
  running: boolean;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  statusMessage: string;
};

export type WebConnectionSummary = {
  provider: "robinhood";
  connected: boolean;
  state: "not_connected" | "connected" | "needs_agentic_account" | "authentication_expired" | "error";
  hasBuyingPower: boolean;
  lastCheckedAt: string | null;
};

export type WebActivity = {
  id: string;
  agentId: "bluechip";
  mode: TradingMode;
  kind: ActivityKind;
  symbol: string | null;
  amountUsd: number | null;
  message: string;
  occurredAt: string;
};

export type WebDashboard = {
  app: "daytradingbot-web";
  realTradingEnabled: boolean;
  runtime: {
    ready: boolean;
    lastSuccessfulCheckAt: string | null;
  };
  connection: WebConnectionSummary;
  settings: WebSettings;
  activity: WebActivity[];
  agent: {
    id: "bluechip";
    name: "Bluechip";
    account: "Robinhood";
    market: "Stocks and ETFs";
    summary: string;
    cadenceMinutes: 15;
    riskLevel: "steady";
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
  | "webapp_unavailable"
  | "connection_required"
  | "connection_unavailable"
  | "agentic_account_required"
  | "invalid_limits"
  | "pause_before_changing"
  | "real_trading_unavailable"
  | "real_risk_acknowledgement_required"
  | "trading_unavailable";

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

interface ConnectionRow extends RowDataPacket {
  encrypted_credentials: Buffer;
  connection_state: "connected" | "needs_agentic_account" | "authentication_expired" | "error";
  has_buying_power: number;
  last_checked_at: Date | null;
}

interface SettingsRow extends RowDataPacket {
  license_id: string;
  agent_id: "bluechip";
  mode: TradingMode;
  daily_budget_cents: number;
  max_per_trade_cents: number;
  running: number;
  real_authorized_until: Date | null;
  last_checked_at: Date | null;
  next_check_at: Date | null;
  status_message: string;
}

interface ActivityRow extends RowDataPacket {
  activity_id: string;
  agent_id: "bluechip";
  mode: TradingMode;
  kind: ActivityKind;
  symbol: string | null;
  amount_cents: number | null;
  message: string;
  occurred_at: Date;
}

interface OAuthStateRow extends RowDataPacket {
  license_id: string;
  encrypted_payload: Buffer;
  expires_at: Date;
}

interface IntentRow extends RowDataPacket {
  intent_id: string;
  state: "reserved" | "submitting" | "submitted" | "unknown" | "rejected" | "filled" | "canceled";
  venue_order_id: string | null;
  symbol: string;
  amount_cents: number;
}

interface WorkerStatusRow extends RowDataPacket {
  last_success_at: Date | null;
  ready: number;
}

type ClaimedCycle = {
  licenseId: string;
  mode: TradingMode;
  dailyBudgetCents: number;
  maxPerTradeCents: number;
  realAuthorizedUntil: Date | null;
};

type StoredConnection = {
  credentials: RobinhoodTokenBundle;
  state: ConnectionRow["connection_state"];
  hasBuyingPower: boolean;
  lastCheckedAt: Date | null;
};

type StoredOAuthState = {
  licenseId: string;
  clientId: string;
  verifier: string;
  redirectUri: string;
};

function dateIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function normalizeCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^DTB-[A-Z0-9-]{12,80}$/.test(normalized)) throw new WebAppError("invalid_code");
  return normalized;
}

function centsFromUsd(value: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new WebAppError("invalid_limits");
  const cents = Math.round(value * 100);
  if (cents < 100 || cents > maximum || Math.abs(value * 100 - cents) > 0.0001) {
    throw new WebAppError("invalid_limits");
  }
  return cents;
}

function fillNotionalCents(quantityValue: string, priceValue: string): number {
  const quantity = Number(quantityValue);
  const price = Number(priceValue);
  const notionalCents = Math.round(quantity * price * 100);
  if (
    !Number.isFinite(quantity)
    || !Number.isFinite(price)
    || quantity <= 0
    || price <= 0
    || !Number.isSafeInteger(notionalCents)
    || notionalCents <= 0
  ) {
    throw new RobinhoodError("placement_unknown");
  }
  return notionalCents;
}

function secureHash(secret: string, purpose: string, value: string): Buffer {
  return createHmac("sha256", secret).update(`${purpose}\0${value}`, "utf8").digest();
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isDuplicate(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ER_DUP_ENTRY";
}

async function rollbackQuietly(connection: PoolConnection): Promise<void> {
  try {
    await connection.rollback();
  } catch {
    // Keep the original database error.
  }
}

export class MySqlWebAppRepository {
  private readonly credentialKey: Buffer;

  constructor(
    private readonly pool: Pool,
    private readonly sessionSecret: string,
    credentialEncryptionKey: string,
    private readonly licensePepper: string,
  ) {
    this.credentialKey = commerceEncryptionKey(credentialEncryptionKey);
    if (sessionSecret.length < 32 || licensePepper.length < 32) throw new WebAppError("webapp_unavailable");
  }

  sessionHash(token: string): Buffer {
    return secureHash(this.sessionSecret, "web-session", token);
  }

  csrfToken(token: string): string {
    return secureHash(this.sessionSecret, "web-csrf", token).toString("base64url");
  }

  stateHash(state: string): Buffer {
    return secureHash(this.sessionSecret, "oauth-state", state);
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
      // A personal code has one active browser sign-in. Signing in again safely
      // ends an older browser session without touching a running server-side bot.
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

  async ensureSettings(licenseId: string): Promise<void> {
    await this.pool.execute(
      `INSERT IGNORE INTO web_trading_settings (license_id) VALUES (?)`,
      [licenseId],
    );
  }

  async getSettings(licenseId: string): Promise<SettingsRow> {
    await this.ensureSettings(licenseId);
    const [rows] = await this.pool.execute<SettingsRow[]>(
      `SELECT license_id, agent_id, mode, daily_budget_cents, max_per_trade_cents,
              running, real_authorized_until, last_checked_at, next_check_at, status_message
         FROM web_trading_settings WHERE license_id = ?`,
      [licenseId],
    );
    const row = rows[0];
    if (!row) throw new WebAppError("webapp_unavailable");
    return row;
  }

  async getConnection(licenseId: string): Promise<StoredConnection | null> {
    const [rows] = await this.pool.execute<ConnectionRow[]>(
      `SELECT encrypted_credentials, connection_state, has_buying_power, last_checked_at
         FROM web_trading_connections
        WHERE license_id = ? AND provider = 'robinhood'`,
      [licenseId],
    );
    const row = rows[0];
    if (!row) return null;
    try {
      const credentials = JSON.parse(openCommerceValue(
        this.credentialKey,
        `robinhood-connection:${licenseId}`,
        row.encrypted_credentials,
      )) as RobinhoodTokenBundle;
      return {
        credentials,
        state: row.connection_state,
        hasBuyingPower: Boolean(row.has_buying_power),
        lastCheckedAt: row.last_checked_at,
      };
    } catch {
      throw new WebAppError("connection_unavailable");
    }
  }

  async saveConnection(
    licenseId: string,
    credentials: RobinhoodTokenBundle,
    state: ConnectionRow["connection_state"],
    hasBuyingPower: boolean,
  ): Promise<void> {
    const encrypted = sealCommerceValue(
      this.credentialKey,
      `robinhood-connection:${licenseId}`,
      JSON.stringify(credentials),
    );
    await this.pool.execute(
      `INSERT INTO web_trading_connections
         (connection_id, license_id, provider, encrypted_credentials, connection_state,
          has_buying_power, last_checked_at)
       VALUES (?, ?, 'robinhood', ?, ?, ?, UTC_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE
         encrypted_credentials = VALUES(encrypted_credentials),
         connection_state = VALUES(connection_state),
         has_buying_power = VALUES(has_buying_power),
         last_checked_at = UTC_TIMESTAMP(6),
         updated_at = UTC_TIMESTAMP(6)`,
      [randomUUID(), licenseId, encrypted, state, hasBuyingPower],
    );
  }

  async updateConnectionState(
    licenseId: string,
    state: ConnectionRow["connection_state"],
    hasBuyingPower = false,
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE web_trading_connections
          SET connection_state = ?, has_buying_power = ?, last_checked_at = UTC_TIMESTAMP(6),
              updated_at = UTC_TIMESTAMP(6)
        WHERE license_id = ? AND provider = 'robinhood'`,
      [state, hasBuyingPower, licenseId],
    );
  }

  async deleteConnection(licenseId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        "DELETE FROM web_trading_connections WHERE license_id = ? AND provider = 'robinhood'",
        [licenseId],
      );
      await connection.execute(
        `UPDATE web_trading_settings
            SET running = FALSE, real_authorized_until = NULL, next_check_at = NULL,
                cycle_locked_until = NULL, status_message = 'Robinhood is disconnected.',
                updated_at = UTC_TIMESTAMP(6)
          WHERE license_id = ?`,
        [licenseId],
      );
      await connection.commit();
    } catch (error) {
      await rollbackQuietly(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async saveOauthState(input: StoredOAuthState & { state: string }): Promise<void> {
    const encrypted = sealCommerceValue(
      this.credentialKey,
      `robinhood-oauth-state:${input.licenseId}`,
      JSON.stringify({ clientId: input.clientId, verifier: input.verifier, redirectUri: input.redirectUri }),
    );
    await this.pool.execute(
      `INSERT INTO web_oauth_states
         (state_hash, license_id, provider, encrypted_payload, expires_at)
       VALUES (?, ?, 'robinhood', ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? SECOND))`,
      [this.stateHash(input.state), input.licenseId, encrypted, OAUTH_STATE_SECONDS],
    );
  }

  async consumeOauthState(state: string): Promise<StoredOAuthState> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<OAuthStateRow[]>(
        `SELECT license_id, encrypted_payload, expires_at
           FROM web_oauth_states
          WHERE state_hash = ? AND provider = 'robinhood'
          FOR UPDATE`,
        [this.stateHash(state)],
      );
      const row = rows[0];
      await connection.execute("DELETE FROM web_oauth_states WHERE state_hash = ?", [this.stateHash(state)]);
      await connection.commit();
      if (!row || row.expires_at.getTime() <= Date.now()) throw new WebAppError("connection_unavailable");
      const parsed = JSON.parse(openCommerceValue(
        this.credentialKey,
        `robinhood-oauth-state:${row.license_id}`,
        row.encrypted_payload,
      )) as { clientId?: unknown; verifier?: unknown; redirectUri?: unknown };
      if (typeof parsed.clientId !== "string" || typeof parsed.verifier !== "string" || typeof parsed.redirectUri !== "string") {
        throw new WebAppError("connection_unavailable");
      }
      return { licenseId: row.license_id, clientId: parsed.clientId, verifier: parsed.verifier, redirectUri: parsed.redirectUri };
    } catch (error) {
      await rollbackQuietly(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async listActivity(licenseId: string): Promise<WebActivity[]> {
    const [rows] = await this.pool.execute<ActivityRow[]>(
      `SELECT activity_id, agent_id, mode, kind, symbol, amount_cents, message, occurred_at
         FROM web_trading_activity
        WHERE license_id = ?
        ORDER BY occurred_at DESC
        LIMIT 100`,
      [licenseId],
    );
    return rows.map((row) => ({
      id: row.activity_id,
      agentId: row.agent_id,
      mode: row.mode,
      kind: row.kind,
      symbol: row.symbol,
      amountUsd: row.amount_cents === null ? null : row.amount_cents / 100,
      message: row.message,
      occurredAt: row.occurred_at.toISOString(),
    }));
  }

  async recordActivity(
    licenseId: string,
    mode: TradingMode,
    kind: ActivityKind,
    message: string,
    symbol: string | null = null,
    amountCents: number | null = null,
  ): Promise<void> {
    await this.pool.execute(
      `INSERT INTO web_trading_activity
         (activity_id, license_id, agent_id, mode, kind, symbol, amount_cents, message)
       VALUES (?, ?, 'bluechip', ?, ?, ?, ?, ?)`,
      [randomUUID(), licenseId, mode, kind, symbol, amountCents, message.slice(0, 500)],
    );
  }

  async workerStatus(): Promise<{ ready: boolean; lastSuccessfulCheckAt: Date | null }> {
    const [rows] = await this.pool.execute<WorkerStatusRow[]>(
      `SELECT last_success_at,
              CASE WHEN last_success_at IS NOT NULL
                         AND last_success_at >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL ? MINUTE)
                    THEN 1 ELSE 0 END AS ready
         FROM web_worker_status
        WHERE worker_name = 'primary'
        LIMIT 1`,
      [WORKER_STALE_MINUTES],
    );
    const row = rows[0];
    return {
      ready: Boolean(row?.ready),
      lastSuccessfulCheckAt: row?.last_success_at ?? null,
    };
  }

  async recordWorkerStarted(): Promise<void> {
    await this.pool.execute(
      `INSERT INTO web_worker_status
         (worker_name, last_started_at, last_result)
       VALUES ('primary', UTC_TIMESTAMP(6), 'running')
       ON DUPLICATE KEY UPDATE
         last_started_at = UTC_TIMESTAMP(6), last_result = 'running',
         updated_at = UTC_TIMESTAMP(6)`,
    );
  }

  async recordWorkerFinished(
    success: boolean,
    counts: { claimed: number; completed: number; failed: number },
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE web_worker_status
          SET last_finished_at = UTC_TIMESTAMP(6),
              last_success_at = CASE WHEN ? THEN UTC_TIMESTAMP(6) ELSE last_success_at END,
              last_result = CASE WHEN ? THEN 'success' ELSE 'error' END,
              claimed_cycles = ?, completed_cycles = ?, failed_cycles = ?,
              updated_at = UTC_TIMESTAMP(6)
        WHERE worker_name = 'primary'`,
      [success, success, counts.claimed, counts.completed, counts.failed],
    );
  }

  async saveSettings(licenseId: string, mode: TradingMode, daily: number, perTrade: number): Promise<void> {
    await this.ensureSettings(licenseId);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE web_trading_settings
          SET mode = ?, daily_budget_cents = ?, max_per_trade_cents = ?,
              status_message = 'Ready when you are.', updated_at = UTC_TIMESTAMP(6)
        WHERE license_id = ? AND running = FALSE`,
      [mode, daily, perTrade, licenseId],
    );
    if (result.affectedRows !== 1) throw new WebAppError("pause_before_changing");
  }

  async startTrading(licenseId: string, mode: TradingMode): Promise<void> {
    await this.ensureSettings(licenseId);
    const authorizedUntil = mode === "real"
      ? new Date(Date.now() + REAL_AUTHORIZATION_SECONDS * 1_000)
      : null;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute<ResultSetHeader>(
        `UPDATE web_trading_settings s
         JOIN licenses l ON l.license_id = s.license_id
         JOIN web_trading_connections c
           ON c.license_id = s.license_id AND c.provider = 'robinhood'
            SET s.mode = ?, s.running = TRUE, s.real_authorized_until = ?,
                s.next_check_at = UTC_TIMESTAMP(6), s.cycle_locked_until = NULL,
                s.status_message = 'Bluechip is ready for its first market check.',
                s.updated_at = UTC_TIMESTAMP(6)
          WHERE s.license_id = ? AND l.status = 'active'
            AND c.connection_state = 'connected' AND s.running = FALSE`,
        [mode, authorizedUntil, licenseId],
      );
      if (result.affectedRows !== 1) {
        const [settings] = await connection.execute<(RowDataPacket & { running: number })[]>(
          "SELECT running FROM web_trading_settings WHERE license_id = ?",
          [licenseId],
        );
        await connection.rollback();
        if (settings[0]?.running) throw new WebAppError("pause_before_changing");
        throw new WebAppError("connection_required");
      }
      if (mode === "real" && authorizedUntil) {
        await connection.execute(
          `INSERT INTO web_real_authorizations
             (authorization_id, license_id, disclosure_version, daily_budget_cents,
              max_per_trade_cents, authorized_at, expires_at)
           SELECT ?, license_id, ?, daily_budget_cents, max_per_trade_cents,
                  UTC_TIMESTAMP(6), ?
             FROM web_trading_settings WHERE license_id = ?`,
          [randomUUID(), REAL_DISCLOSURE_VERSION, authorizedUntil, licenseId],
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

  async pauseTrading(licenseId: string, message = "Trading is paused. No new trades will start."): Promise<void> {
    await this.pool.execute(
      `UPDATE web_trading_settings
          SET running = FALSE, real_authorized_until = NULL, next_check_at = NULL,
              cycle_locked_until = NULL, status_message = ?, updated_at = UTC_TIMESTAMP(6)
        WHERE license_id = ?`,
      [message, licenseId],
    );
  }

  async claimDueCycles(limit = 1): Promise<ClaimedCycle[]> {
    const safeLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE web_trade_intents
            SET state = 'rejected', failure_code = 'stale_reservation', updated_at = UTC_TIMESTAMP(6)
          WHERE state = 'reserved' AND created_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 10 MINUTE)`,
      );
      const [rows] = await connection.query<SettingsRow[]>(
        `SELECT s.license_id, s.agent_id, s.mode, s.daily_budget_cents,
                s.max_per_trade_cents, s.running, s.real_authorized_until,
                s.last_checked_at, s.next_check_at, s.status_message
           FROM web_trading_settings s
           JOIN licenses l ON l.license_id = s.license_id AND l.status = 'active'
          WHERE s.running = TRUE
            AND (s.next_check_at IS NULL OR s.next_check_at <= UTC_TIMESTAMP(6))
            AND (s.cycle_locked_until IS NULL OR s.cycle_locked_until < UTC_TIMESTAMP(6))
          ORDER BY s.next_check_at ASC
          LIMIT ${safeLimit}
          FOR UPDATE`,
      );
      for (const row of rows) {
        await connection.execute(
          `UPDATE web_trading_settings
              SET cycle_locked_until = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? MINUTE)
            WHERE license_id = ?`,
          [CYCLE_LOCK_MINUTES, row.license_id],
        );
      }
      await connection.commit();
      return rows.map((row) => ({
        licenseId: row.license_id,
        mode: row.mode,
        dailyBudgetCents: row.daily_budget_cents,
        maxPerTradeCents: row.max_per_trade_cents,
        realAuthorizedUntil: row.real_authorized_until,
      }));
    } catch (error) {
      await rollbackQuietly(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async reconciliationLicenses(limit = 25): Promise<string[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const [rows] = await this.pool.query<(RowDataPacket & { license_id: string })[]>(
      `SELECT i.license_id
         FROM web_trade_intents i
         JOIN licenses l ON l.license_id = i.license_id AND l.status = 'active'
         JOIN web_trading_connections c
           ON c.license_id = i.license_id AND c.provider = 'robinhood'
          AND c.connection_state = 'connected'
        WHERE i.state IN ('submitting','submitted','unknown')
        GROUP BY i.license_id
        ORDER BY MIN(i.created_at) ASC
        LIMIT ${safeLimit}`,
    );
    return rows.map((row) => row.license_id);
  }

  async finishCycle(licenseId: string, message: string): Promise<void> {
    await this.pool.execute(
      `UPDATE web_trading_settings
          SET last_checked_at = UTC_TIMESTAMP(6),
              next_check_at = CASE WHEN running THEN DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? MINUTE) ELSE NULL END,
              cycle_locked_until = NULL, status_message = ?, updated_at = UTC_TIMESTAMP(6)
        WHERE license_id = ? AND running = TRUE`,
      [AGENT_CADENCE_MINUTES, message.slice(0, 500), licenseId],
    );
  }

  async failCycle(licenseId: string, message: string, pause: boolean): Promise<void> {
    await this.pool.execute(
      `UPDATE web_trading_settings
          SET running = CASE WHEN ? THEN FALSE ELSE running END,
              real_authorized_until = CASE WHEN ? THEN NULL ELSE real_authorized_until END,
              last_checked_at = UTC_TIMESTAMP(6),
              next_check_at = CASE WHEN ? THEN NULL ELSE DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? MINUTE) END,
              cycle_locked_until = NULL, status_message = ?, updated_at = UTC_TIMESTAMP(6)
        WHERE license_id = ? AND running = TRUE`,
      [pause, pause, pause, AGENT_CADENCE_MINUTES, message.slice(0, 500), licenseId],
    );
  }

  async cycleStillActive(licenseId: string, mode: TradingMode): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1
         FROM web_trading_settings s
         JOIN licenses l ON l.license_id = s.license_id
        WHERE s.license_id = ? AND s.running = TRUE AND s.mode = ?
          AND l.status = 'active'
          AND (? <> 'real' OR s.real_authorized_until > UTC_TIMESTAMP(6))
        LIMIT 1`,
      [licenseId, mode, mode],
    );
    return rows.length === 1;
  }

  async reserveRealIntent(input: {
    licenseId: string;
    symbol: string;
    amountCents: number;
    sourceEventHash: Buffer;
    dayStart: Date;
  }): Promise<{ status: "reserved"; intentId: string } | { status: "duplicate" | "rejected" }> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [settingsRows] = await connection.execute<SettingsRow[]>(
        `SELECT s.license_id, s.agent_id, s.mode, s.daily_budget_cents,
                s.max_per_trade_cents, s.running, s.real_authorized_until,
                s.last_checked_at, s.next_check_at, s.status_message
           FROM web_trading_settings s
           JOIN licenses l ON l.license_id = s.license_id
          WHERE s.license_id = ? AND l.status = 'active'
          FOR UPDATE`,
        [input.licenseId],
      );
      const settings = settingsRows[0];
      if (
        !settings
        || !settings.running
        || settings.mode !== "real"
        || !settings.real_authorized_until
        || settings.real_authorized_until.getTime() <= Date.now()
        || input.amountCents > settings.max_per_trade_cents
      ) {
        await connection.rollback();
        return { status: "rejected" };
      }
      const [riskRows] = await connection.execute<(RowDataPacket & { used_cents: string | number; resting: number })[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN created_at >= ? AND state IN
             ('reserved','submitting','submitted','unknown','filled','canceled') THEN amount_cents ELSE 0 END), 0) AS used_cents,
           COALESCE(SUM(CASE WHEN state IN ('submitting','submitted','unknown') THEN 1 ELSE 0 END), 0) AS resting
         FROM web_trade_intents
        WHERE license_id = ?`,
        [input.dayStart, input.licenseId],
      );
      const used = Number(riskRows[0]?.used_cents ?? 0);
      const resting = Number(riskRows[0]?.resting ?? 0);
      if (used + input.amountCents > settings.daily_budget_cents || resting >= 2) {
        await connection.rollback();
        return { status: "rejected" };
      }
      const intentId = newIntentId();
      try {
        await connection.execute(
          `INSERT INTO web_trade_intents
             (intent_id, license_id, source_event_hash, strategy_id, symbol, amount_cents, state)
           VALUES (?, ?, ?, ?, ?, ?, 'reserved')`,
          [intentId, input.licenseId, input.sourceEventHash, STRATEGY_ID, input.symbol, input.amountCents],
        );
      } catch (error) {
        if (isDuplicate(error)) {
          await connection.rollback();
          return { status: "duplicate" };
        }
        throw error;
      }
      await connection.commit();
      return { status: "reserved", intentId };
    } catch (error) {
      await rollbackQuietly(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  async beginSubmission(intentId: string, fingerprint: Buffer): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE web_trade_intents i
       JOIN web_trading_settings s ON s.license_id = i.license_id
       JOIN licenses l ON l.license_id = i.license_id
          SET i.state = 'submitting', i.request_fingerprint = ?, i.updated_at = UTC_TIMESTAMP(6)
        WHERE i.intent_id = ? AND i.state = 'reserved'
          AND s.running = TRUE AND s.mode = 'real'
          AND s.real_authorized_until > UTC_TIMESTAMP(6)
          AND l.status = 'active'`,
      [fingerprint, intentId],
    );
    return result.affectedRows === 1;
  }

  async submissionStillAuthorized(intentId: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1
         FROM web_trade_intents i
         JOIN web_trading_settings s ON s.license_id = i.license_id
         JOIN licenses l ON l.license_id = i.license_id
         JOIN web_trading_connections c
           ON c.license_id = i.license_id AND c.provider = 'robinhood'
        WHERE i.intent_id = ? AND i.state = 'submitting'
          AND s.running = TRUE AND s.mode = 'real'
          AND s.real_authorized_until > UTC_TIMESTAMP(6)
          AND i.amount_cents <= s.max_per_trade_cents
          AND l.status = 'active'
          AND c.connection_state = 'connected'
        LIMIT 1`,
      [intentId],
    );
    return rows.length === 1;
  }

  async markIntent(
    intentId: string,
    state: IntentRow["state"],
    orderId: string | null = null,
    failureCode: string | null = null,
  ): Promise<void> {
    await this.pool.execute(
      `UPDATE web_trade_intents
          SET state = ?, venue_order_id = COALESCE(?, venue_order_id), failure_code = ?,
              updated_at = UTC_TIMESTAMP(6)
        WHERE intent_id = ?`,
      [state, orderId, failureCode, intentId],
    );
  }

  async unresolvedIntents(licenseId: string): Promise<IntentRow[]> {
    const [rows] = await this.pool.execute<IntentRow[]>(
      `SELECT intent_id, state, venue_order_id, symbol, amount_cents
         FROM web_trade_intents
        WHERE license_id = ? AND state IN ('submitting','submitted','unknown')
        ORDER BY created_at ASC`,
      [licenseId],
    );
    return rows;
  }

  async recordFill(
    intentId: string,
    execution: RobinhoodOrder["executions"][number],
  ): Promise<{ recorded: boolean; notionalCents: number }> {
    const notionalCents = fillNotionalCents(execution.quantity, execution.price);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [intentRows] = await connection.execute<(RowDataPacket & { amount_cents: number })[]>(
        "SELECT amount_cents FROM web_trade_intents WHERE intent_id = ? FOR UPDATE",
        [intentId],
      );
      const intent = intentRows[0];
      if (!intent) throw new RobinhoodError("placement_unknown");
      const [fillRows] = await connection.execute<(RowDataPacket & {
        venue_fill_id: string;
        quantity: string;
        price: string;
      })[]>(
        "SELECT venue_fill_id, quantity, price FROM web_trade_fills WHERE intent_id = ?",
        [intentId],
      );
      if (fillRows.some((row) => row.venue_fill_id === execution.id)) {
        await connection.rollback();
        return { recorded: false, notionalCents };
      }
      const recordedCents = fillRows.reduce(
        (total, row) => total + fillNotionalCents(row.quantity, row.price),
        0,
      );
      // A one-cent allowance covers venue rounding for fractional shares. Any
      // larger overfill is quarantined instead of being accepted into history.
      if (recordedCents + notionalCents > intent.amount_cents + 1) {
        throw new RobinhoodError("placement_unknown");
      }
      await connection.execute(
        `INSERT INTO web_trade_fills
           (fill_id, intent_id, venue_fill_id, quantity, price, fee, filled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), intentId, execution.id, execution.quantity, execution.price, execution.fee, execution.executedAt],
      );
      await connection.commit();
      return { recorded: true, notionalCents };
    } catch (error) {
      await rollbackQuietly(connection);
      throw error;
    } finally {
      connection.release();
    }
  }
}

function settingsWire(row: SettingsRow): WebSettings {
  return {
    agentId: row.agent_id,
    mode: row.mode,
    dailyBudgetUsd: row.daily_budget_cents / 100,
    maxPerTradeUsd: row.max_per_trade_cents / 100,
    running: Boolean(row.running),
    lastCheckedAt: dateIso(row.last_checked_at),
    nextCheckAt: dateIso(row.next_check_at),
    statusMessage: row.status_message,
  };
}

function connectionWire(connection: StoredConnection | null): WebConnectionSummary {
  if (!connection) {
    return { provider: "robinhood", connected: false, state: "not_connected", hasBuyingPower: false, lastCheckedAt: null };
  }
  return {
    provider: "robinhood",
    connected: connection.state === "connected" || connection.state === "needs_agentic_account",
    state: connection.state,
    hasBuyingPower: connection.hasBuyingPower,
    lastCheckedAt: dateIso(connection.lastCheckedAt),
  };
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function observedFixedHoliday(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = 1 + ((weekday - first.getUTCDay() + 7) % 7) + (nth - 1) * 7;
  return dateKey(year, month, day);
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  const day = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
  return dateKey(year, month, day);
}

function goodFriday(year: number): string {
  // Gregorian Easter (Meeus/Jones/Butcher), then two days back.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const date = new Date(Date.UTC(year, month - 1, day - 2));
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function regularMarketHolidays(year: number): Set<string> {
  const holidays = new Set<string>();
  for (const fixedYear of [year - 1, year, year + 1]) {
    holidays.add(observedFixedHoliday(fixedYear, 1, 1));
    holidays.add(observedFixedHoliday(fixedYear, 7, 4));
    holidays.add(observedFixedHoliday(fixedYear, 12, 25));
    if (fixedYear >= 2022) holidays.add(observedFixedHoliday(fixedYear, 6, 19));
  }
  holidays.add(nthWeekday(year, 1, 1, 3));
  holidays.add(nthWeekday(year, 2, 1, 3));
  holidays.add(goodFriday(year));
  holidays.add(lastWeekday(year, 5, 1));
  holidays.add(nthWeekday(year, 9, 1, 1));
  holidays.add(nthWeekday(year, 11, 4, 4));
  return holidays;
}

export function marketIsOpen(now = new Date()): boolean {
  const pieces = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => pieces.find((piece) => piece.type === type)?.value;
  const weekday = part("weekday");
  const year = Number(part("year"));
  const month = Number(part("month"));
  const day = Number(part("day"));
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  if (
    weekday === "Sat"
    || weekday === "Sun"
    || ![year, month, day, hour, minute].every(Number.isInteger)
    || regularMarketHolidays(year).has(dateKey(year, month, day))
  ) return false;
  const current = hour * 60 + minute;
  // Bluechip intentionally uses a narrower window than the exchange session.
  // It avoids the open and is already stopped before any standard 1 p.m. early close.
  return current >= 10 * 60 && current < 12 * 60 + 45;
}

function easternDayStart(now = new Date()): Date {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const date = formatter.format(now);
  // Noon UTC is used only to ask Intl for the New York offset on that date.
  const noon = new Date(`${date}T12:00:00.000Z`);
  const localAtNoon = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23",
  }).format(noon);
  const offsetHours = 12 - Number(localAtNoon);
  return new Date(`${date}T${String(offsetHours).padStart(2, "0")}:00:00.000Z`);
}

function plainTradingError(error: unknown): { message: string; pause: boolean } {
  if (error instanceof WebAppError && ["connection_required", "connection_unavailable"].includes(error.code)) {
    return { message: "Robinhood needs to be reconnected before Bluechip can continue.", pause: true };
  }
  if (error instanceof RobinhoodError) {
    if (error.code === "authentication_failed") {
      return { message: "Robinhood needs to be reconnected before Bluechip can continue.", pause: true };
    }
    if (error.code === "agentic_account_required") {
      return { message: "Connect one dedicated Robinhood Agentic account before starting Bluechip.", pause: true };
    }
    if (error.code === "placement_unknown") {
      return { message: "Robinhood's order response was unclear. Trading is paused so the order can be checked before anything else happens.", pause: true };
    }
    if (error.code === "invalid_response") {
      return { message: "Robinhood did not return complete market data. No new order was sent.", pause: false };
    }
  }
  return { message: "Bluechip could not finish this market check. No new order was sent.", pause: false };
}

export interface WebAppOperations {
  login(code: string): Promise<LoginResult>;
  authenticate(sessionToken: string): Promise<WebSession>;
  requireCsrf(session: WebSession, csrfToken: string | undefined): void;
  logout(session: WebSession): Promise<void>;
  dashboard(licenseId: string): Promise<WebDashboard>;
  beginRobinhoodConnection(licenseId: string): Promise<{ authorizationUrl: string }>;
  completeRobinhoodConnection(query: { state?: string; code?: string; error?: string }): Promise<string>;
  checkRobinhoodConnection(licenseId: string): Promise<WebConnectionSummary>;
  disconnectRobinhood(licenseId: string): Promise<void>;
  saveSettings(licenseId: string, input: { mode: TradingMode; dailyBudgetUsd: number; maxPerTradeUsd: number }): Promise<WebDashboard>;
  start(licenseId: string, input: { mode: TradingMode; acceptedRealRisk: boolean }): Promise<WebDashboard>;
  pause(licenseId: string): Promise<WebDashboard>;
  runDueCycles(): Promise<{ claimed: number; completed: number; failed: number }>;
  workerReady(): Promise<boolean>;
}

type RobinhoodSession = Pick<
  Awaited<ReturnType<RobinhoodMcpClient["tradingSession"]>>,
  "buyingPowerCents" | "positions" | "orders" | "quotes" | "reviewMarketBuy" | "placeReviewedMarketBuy"
>;
type RobinhoodClient = {
  snapshot(): Promise<RobinhoodSnapshot>;
  tradingSession(): Promise<RobinhoodSession>;
};
type RobinhoodClientFactory = (accessToken: string) => RobinhoodClient;

export class WebAppService implements WebAppOperations {
  private readonly callbackUrl: string;
  private readonly webAppUrl: string;

  constructor(
    private readonly repository: MySqlWebAppRepository,
    publicApiUrl: string,
    publicSiteUrl: string,
    private readonly realTradingEnabled: boolean,
    private readonly robinhoodClientFactory: RobinhoodClientFactory = (accessToken) => new RobinhoodMcpClient(accessToken),
  ) {
    this.callbackUrl = new URL("/v1/web/connections/robinhood/callback", publicApiUrl).toString();
    this.webAppUrl = new URL("/app/", publicSiteUrl).toString();
  }

  login(code: string): Promise<LoginResult> {
    return this.repository.createSession(normalizeCode(code));
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

  async dashboard(licenseId: string): Promise<WebDashboard> {
    const [settings, connection, activity, runtime] = await Promise.all([
      this.repository.getSettings(licenseId),
      this.repository.getConnection(licenseId),
      this.repository.listActivity(licenseId),
      this.repository.workerStatus(),
    ]);
    return {
      app: "daytradingbot-web",
      realTradingEnabled: this.realTradingEnabled,
      runtime: {
        ready: runtime.ready,
        lastSuccessfulCheckAt: dateIso(runtime.lastSuccessfulCheckAt),
      },
      connection: connectionWire(connection),
      settings: settingsWire(settings),
      activity,
      agent: {
        id: "bluechip",
        name: "Bluechip",
        account: "Robinhood",
        market: "Stocks and ETFs",
        summary: "Looks for pullbacks in a short list of widely held stocks and funds.",
        cadenceMinutes: 15,
        riskLevel: "steady",
      },
    };
  }

  async beginRobinhoodConnection(licenseId: string): Promise<{ authorizationUrl: string }> {
    const state = newOauthState();
    try {
      const registration = await registerRobinhoodWebClient(this.callbackUrl, state);
      await this.repository.saveOauthState({
        licenseId,
        state,
        clientId: registration.clientId,
        verifier: registration.verifier,
        redirectUri: this.callbackUrl,
      });
      return { authorizationUrl: registration.authorizationUrl };
    } catch {
      throw new WebAppError("connection_unavailable");
    }
  }

  async completeRobinhoodConnection(query: { state?: string; code?: string; error?: string }): Promise<string> {
    const failed = new URL(this.webAppUrl);
    failed.searchParams.set("connection", "robinhood");
    failed.searchParams.set("status", "error");
    if (!query.state || !/^[A-Za-z0-9_-]{43}$/.test(query.state)) return failed.toString();
    let stored: StoredOAuthState;
    try {
      stored = await this.repository.consumeOauthState(query.state);
    } catch {
      return failed.toString();
    }
    if (query.error || !query.code) return failed.toString();
    try {
      const bundle = await exchangeRobinhoodCode({
        code: query.code,
        clientId: stored.clientId,
        redirectUri: stored.redirectUri,
        verifier: stored.verifier,
      });
      const snapshot = await new RobinhoodMcpClient(bundle.accessToken).snapshot();
      await this.repository.saveConnection(
        stored.licenseId,
        bundle,
        snapshot.agenticAccountCount === 1 ? "connected" : "needs_agentic_account",
        snapshot.hasBuyingPower,
      );
      const success = new URL(this.webAppUrl);
      success.searchParams.set("connection", "robinhood");
      success.searchParams.set("status", snapshot.agenticAccountCount === 1 ? "connected" : "needs-account");
      return success.toString();
    } catch {
      return failed.toString();
    }
  }

  private async currentRobinhood(licenseId: string): Promise<{ bundle: RobinhoodTokenBundle; client: RobinhoodClient }> {
    const connection = await this.repository.getConnection(licenseId);
    if (!connection) throw new WebAppError("connection_required");
    let bundle = connection.credentials;
    if (bundle.expiresAtUnix <= Math.floor(Date.now() / 1_000) + 120) {
      try {
        bundle = await refreshRobinhoodToken(bundle);
        await this.repository.saveConnection(licenseId, bundle, connection.state, connection.hasBuyingPower);
      } catch {
        await this.repository.updateConnectionState(licenseId, "authentication_expired");
        throw new WebAppError("connection_required");
      }
    }
    return { bundle, client: this.robinhoodClientFactory(bundle.accessToken) };
  }

  async checkRobinhoodConnection(licenseId: string): Promise<WebConnectionSummary> {
    try {
      const { bundle, client } = await this.currentRobinhood(licenseId);
      const snapshot = await client.snapshot();
      const state = snapshot.agenticAccountCount === 1 ? "connected" : "needs_agentic_account";
      await this.repository.saveConnection(licenseId, bundle, state, snapshot.hasBuyingPower);
      return connectionWire({ credentials: bundle, state, hasBuyingPower: snapshot.hasBuyingPower, lastCheckedAt: new Date() });
    } catch (error) {
      if (error instanceof WebAppError && error.code === "connection_required") {
        return connectionWire(await this.repository.getConnection(licenseId));
      }
      await this.repository.updateConnectionState(licenseId, "error");
      throw new WebAppError("connection_unavailable");
    }
  }

  async disconnectRobinhood(licenseId: string): Promise<void> {
    await this.repository.deleteConnection(licenseId);
  }

  async saveSettings(
    licenseId: string,
    input: { mode: TradingMode; dailyBudgetUsd: number; maxPerTradeUsd: number },
  ): Promise<WebDashboard> {
    if (input.mode !== "practice" && input.mode !== "real") throw new WebAppError("invalid_limits");
    if (input.mode === "real" && !this.realTradingEnabled) throw new WebAppError("real_trading_unavailable");
    const daily = centsFromUsd(input.dailyBudgetUsd, 2_500);
    const perTrade = centsFromUsd(input.maxPerTradeUsd, 500);
    if (perTrade > daily) throw new WebAppError("invalid_limits");
    await this.repository.saveSettings(licenseId, input.mode, daily, perTrade);
    return this.dashboard(licenseId);
  }

  async start(
    licenseId: string,
    input: { mode: TradingMode; acceptedRealRisk: boolean },
  ): Promise<WebDashboard> {
    if (!(await this.workerReady())) throw new WebAppError("trading_unavailable");
    if (input.mode === "real") {
      if (!this.realTradingEnabled) throw new WebAppError("real_trading_unavailable");
      if (!input.acceptedRealRisk) throw new WebAppError("real_risk_acknowledgement_required");
    }
    await this.repository.startTrading(licenseId, input.mode);
    await this.repository.recordActivity(
      licenseId,
      input.mode,
      "started",
      input.mode === "practice"
        ? "Practice started. Bluechip will use current market information without placing an order."
        : "Real trading started with your daily and per-trade limits.",
    );
    return this.dashboard(licenseId);
  }

  async pause(licenseId: string): Promise<WebDashboard> {
    const settings = await this.repository.getSettings(licenseId);
    await this.repository.pauseTrading(licenseId);
    await this.repository.recordActivity(licenseId, settings.mode, "paused", "Trading is paused. No new trades will start.");
    return this.dashboard(licenseId);
  }

  async runDueCycles(): Promise<{ claimed: number; completed: number; failed: number }> {
    await this.repository.recordWorkerStarted();
    const counts = { claimed: 0, completed: 0, failed: 0 };
    try {
      const reconciliationLicenses = await this.repository.reconciliationLicenses();
      for (const licenseId of reconciliationLicenses) {
        try {
          const { client } = await this.currentRobinhood(licenseId);
          await this.reconcile(licenseId, await client.tradingSession());
        } catch (error) {
          counts.failed += 1;
          const plain = plainTradingError(error);
          await this.repository.recordActivity(licenseId, "real", "error", plain.message);
          if (plain.pause) await this.repository.pauseTrading(licenseId, plain.message);
        }
      }
      const cycles = await this.repository.claimDueCycles();
      counts.claimed = cycles.length;
      for (const cycle of cycles) {
        try {
          await this.runBluechipCycle(cycle);
          counts.completed += 1;
        } catch (error) {
          counts.failed += 1;
          const plain = plainTradingError(error);
          await this.repository.recordActivity(cycle.licenseId, cycle.mode, "error", plain.message);
          await this.repository.failCycle(cycle.licenseId, plain.message, plain.pause);
        }
      }
      await this.repository.recordWorkerFinished(true, counts);
      return counts;
    } catch (error) {
      await this.repository.recordWorkerFinished(false, counts).catch(() => undefined);
      throw error;
    }
  }

  async workerReady(): Promise<boolean> {
    return (await this.repository.workerStatus()).ready;
  }

  private async reconcile(licenseId: string, session: RobinhoodSession): Promise<void> {
    const unresolved = await this.repository.unresolvedIntents(licenseId);
    const recentOrders = unresolved.some((intent) => !intent.venue_order_id)
      ? await session.orders({ since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000) })
      : [];
    for (const intent of unresolved) {
      const order = intent.venue_order_id
        ? (await session.orders({ orderId: intent.venue_order_id }))[0]
        : recentOrders.find((candidate) => candidate.refId === intent.intent_id);
      if (!order) throw new RobinhoodError("placement_unknown");
      if (!intent.venue_order_id) await this.repository.markIntent(intent.intent_id, "submitted", order.orderId);
      await this.settleOrder(licenseId, "real", intent.intent_id, intent.symbol, order);
    }
  }

  private async settleOrder(
    licenseId: string,
    mode: TradingMode,
    intentId: string,
    expectedSymbol: string,
    order: RobinhoodOrder,
  ): Promise<void> {
    if (order.symbol !== expectedSymbol || (order.state === "filled" && !order.executions.length)) {
      throw new RobinhoodError("placement_unknown");
    }
    for (const execution of order.executions) {
      const fill = await this.repository.recordFill(intentId, execution);
      if (fill.recorded) {
        await this.repository.recordActivity(
          licenseId,
          mode,
          "filled",
          `Robinhood filled $${(fill.notionalCents / 100).toFixed(2)} of the ${order.symbol} trade.`,
          order.symbol,
          fill.notionalCents,
        );
      }
    }
    if (order.state === "filled") await this.repository.markIntent(intentId, "filled", order.orderId);
    else if (order.state === "canceled") {
      await this.repository.markIntent(intentId, "canceled", order.orderId);
      await this.repository.recordActivity(licenseId, mode, "skipped", `${order.symbol} order was canceled.`, order.symbol);
    } else if (order.state === "rejected") {
      await this.repository.markIntent(intentId, "rejected", order.orderId, "robinhood_rejected");
      await this.repository.recordActivity(licenseId, mode, "skipped", `${order.symbol} order was rejected by Robinhood.`, order.symbol);
    }
    else if (order.state === "unknown") {
      await this.repository.markIntent(intentId, "unknown", order.orderId, "unknown_order_state");
      throw new RobinhoodError("placement_unknown");
    }
  }

  private async runBluechipCycle(cycle: ClaimedCycle): Promise<void> {
    if (cycle.mode === "real" && !this.realTradingEnabled) {
      const message = "Real trading is unavailable, so Bluechip stopped before sending another order.";
      await this.repository.pauseTrading(cycle.licenseId, message);
      await this.repository.recordActivity(cycle.licenseId, cycle.mode, "paused", message);
      return;
    }
    if (
      cycle.mode === "real"
      && (!cycle.realAuthorizedUntil || cycle.realAuthorizedUntil.getTime() <= Date.now())
    ) {
      const message = "Real trading stopped after 24 hours. Review your limits and press Start to continue.";
      await this.repository.pauseTrading(cycle.licenseId, message);
      await this.repository.recordActivity(cycle.licenseId, cycle.mode, "paused", message);
      return;
    }
    if (!await this.repository.cycleStillActive(cycle.licenseId, cycle.mode)) return;
    await this.repository.recordActivity(
      cycle.licenseId,
      cycle.mode,
      "market_check",
      "Bluechip is checking eight widely held stocks and funds.",
    );
    const { client } = await this.currentRobinhood(cycle.licenseId);
    const session = await client.tradingSession();
    if (cycle.mode === "real") await this.reconcile(cycle.licenseId, session);
    // Robinhood's MCP session is stateful. Keep its typed calls in order so a
    // slow provider response cannot reorder request ids inside one bot cycle.
    let availableBuyingPowerCents = await session.buyingPowerCents();
    const positions = await session.positions();
    const orders = await session.orders({ since: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000) });
    const quotes = await session.quotes(WATCHLIST);
    const receivedSymbols = new Set(quotes.map((quote) => quote.symbol));
    if (quotes.length !== WATCHLIST.length || WATCHLIST.some((symbol) => !receivedSymbols.has(symbol))) {
      throw new RobinhoodError("invalid_response");
    }
    const held = new Set(positions.filter((position) => position.quantity > 0).map((position) => position.symbol));
    const pending = new Set(orders.filter((order) => ["pending", "partially_filled", "unknown"].includes(order.state)).map((order) => order.symbol));
    const candidates = quotes
      .filter((quote) => quote.changePercent <= DIP_THRESHOLD_PERCENT && !held.has(quote.symbol) && !pending.has(quote.symbol))
      .sort((left, right) => left.changePercent - right.changePercent);
    if (!candidates.length) {
      const message = "Market check finished. No new trade matched Bluechip's rules.";
      await this.repository.recordActivity(cycle.licenseId, cycle.mode, "skipped", message);
      await this.repository.finishCycle(cycle.licenseId, message);
      return;
    }

    let actions = 0;
    for (const candidate of candidates) {
      if (actions >= MAX_TRADES_PER_CYCLE) break;
      if (
        cycle.mode === "real"
        && cycle.realAuthorizedUntil
        && cycle.realAuthorizedUntil.getTime() <= Date.now()
      ) {
        const message = "Real trading stopped after 24 hours. Review your limits and press Start to continue.";
        await this.repository.pauseTrading(cycle.licenseId, message);
        await this.repository.recordActivity(cycle.licenseId, cycle.mode, "paused", message);
        return;
      }
      if (!await this.repository.cycleStillActive(cycle.licenseId, cycle.mode)) return;
      const amountCents = Math.min(cycle.maxPerTradeCents, availableBuyingPowerCents);
      if (amountCents < 100) {
        await this.repository.recordActivity(
          cycle.licenseId,
          cycle.mode,
          "skipped",
          "A trade matched, but the connected Robinhood account needs more buying power.",
          candidate.symbol,
        );
        break;
      }
      const reviewed = await session.reviewMarketBuy(candidate.symbol, amountCents);
      const quoteAge = Date.now() - reviewed.quote.venueLastTradeTime.getTime();
      if (quoteAge < -30_000 || quoteAge > 5 * 60_000) {
        await this.repository.recordActivity(
          cycle.licenseId, cycle.mode, "skipped",
          "A trade matched, but the latest price was too old to use safely.", candidate.symbol,
        );
        continue;
      }
      if (reviewed.quote.changePercent > DIP_THRESHOLD_PERCENT) {
        await this.repository.recordActivity(
          cycle.licenseId, cycle.mode, "skipped",
          `${candidate.symbol} moved before the order review and no longer matched Bluechip's rule.`, candidate.symbol,
        );
        continue;
      }
      await this.repository.recordActivity(
        cycle.licenseId,
        cycle.mode,
        "signal",
        `${candidate.symbol} is ${Math.abs(reviewed.quote.changePercent).toFixed(2)}% below its previous close and matched Bluechip's rule.`,
        candidate.symbol,
        amountCents,
      );
      if (cycle.mode === "practice") {
        await this.repository.recordActivity(
          cycle.licenseId,
          cycle.mode,
          "reviewed",
          `Practice only: Bluechip would buy $${(amountCents / 100).toFixed(2)} of ${candidate.symbol}. No order was placed.`,
          candidate.symbol,
          amountCents,
        );
        actions += 1;
        availableBuyingPowerCents -= amountCents;
        continue;
      }
      if (!marketIsOpen()) {
        await this.repository.recordActivity(
          cycle.licenseId, cycle.mode, "skipped",
          "A trade matched, but the regular stock market is closed.", candidate.symbol,
        );
        continue;
      }
      const sourceEventHash = createHash("sha256")
        .update(`${STRATEGY_ID}\0${candidate.symbol}\0${reviewed.quote.venueLastTradeTime.toISOString()}`, "utf8")
        .digest();
      const reservation = await this.repository.reserveRealIntent({
        licenseId: cycle.licenseId,
        symbol: candidate.symbol,
        amountCents,
        sourceEventHash,
        dayStart: easternDayStart(),
      });
      if (reservation.status !== "reserved") continue;
      const fingerprint = createHash("sha256")
        .update(`${reservation.intentId}|${candidate.symbol}|buy|market|${(amountCents / 100).toFixed(2)}|gfd|regular`, "utf8")
        .digest();
      if (!await this.repository.beginSubmission(reservation.intentId, fingerprint)) {
        await this.repository.markIntent(reservation.intentId, "rejected", null, "paused_before_submission");
        break;
      }
      if (!await this.repository.submissionStillAuthorized(reservation.intentId)) {
        await this.repository.markIntent(reservation.intentId, "rejected", null, "paused_before_submission");
        break;
      }
      try {
        const placement = await session.placeReviewedMarketBuy(reviewed, reservation.intentId);
        await this.repository.markIntent(reservation.intentId, "submitted", placement.orderId);
        await this.repository.recordActivity(
          cycle.licenseId,
          cycle.mode,
          "order_submitted",
          `Bluechip sent a $${(amountCents / 100).toFixed(2)} ${candidate.symbol} buy to Robinhood.`,
          candidate.symbol,
          amountCents,
        );
        const order = (await session.orders({ orderId: placement.orderId }))[0];
        if (order) {
          await this.settleOrder(
            cycle.licenseId,
            cycle.mode,
            reservation.intentId,
            candidate.symbol,
            order,
          );
        }
        actions += 1;
        availableBuyingPowerCents -= amountCents;
      } catch (error) {
        if (error instanceof RobinhoodError && error.code === "placement_rejected") {
          await this.repository.markIntent(reservation.intentId, "rejected", null, "robinhood_rejected");
          await this.repository.recordActivity(
            cycle.licenseId, cycle.mode, "skipped",
            "Robinhood did not accept this trade. No order was opened.", candidate.symbol, amountCents,
          );
          continue;
        }
        await this.repository.markIntent(reservation.intentId, "unknown", null, "robinhood_response_unknown");
        throw new RobinhoodError("placement_unknown");
      }
    }
    const message = cycle.mode === "practice"
      ? `Practice check finished. ${actions} possible trade(s) recorded.`
      : `Market check finished. ${actions} order(s) sent to Robinhood.`;
    await this.repository.finishCycle(cycle.licenseId, message);
  }
}

export function workerSecretMatches(expected: string, provided: string | undefined): boolean {
  return Boolean(provided && expected.length >= 32 && safeEqual(expected, provided));
}

export const webSessionCookieName = "__Host-dtb_session";

export function parseSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== webSessionCookieName) continue;
    try {
      const value = decodeURIComponent(pair.slice(separator + 1).trim());
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function sessionCookie(token: string, maxAge = SESSION_SECONDS): string {
  return `${webSessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${webSessionCookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
