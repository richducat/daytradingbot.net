import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

const REGISTRATION_ENDPOINT = "https://agent.robinhood.com/oauth/trading/register";
const AUTHORIZATION_ENDPOINT = "https://robinhood.com/oauth";
const TOKEN_ENDPOINT = "https://api.robinhood.com/oauth2/token/";
const MCP_ENDPOINT = "https://agent.robinhood.com/mcp/trading";
const MCP_RESOURCE = MCP_ENDPOINT;
const OAUTH_SCOPE = "internal";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const MAX_RESPONSE_BYTES = 512 * 1024;

type FetchLike = typeof fetch;
const MCP_RPC = Symbol("daytradingbot.mcp-rpc");

export type RobinhoodTokenBundle = {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  expiresAtUnix: number;
};

export type RobinhoodRegistration = {
  clientId: string;
  verifier: string;
  authorizationUrl: string;
};

export type RobinhoodSnapshot = {
  authenticated: true;
  agenticAccountAvailable: boolean;
  agenticAccountCount: number;
  hasBuyingPower: boolean;
};

export type RobinhoodQuote = {
  symbol: string;
  lastTradePrice: number;
  previousClose: number;
  venueLastTradeTime: Date;
  changePercent: number;
};

export type RobinhoodPosition = { symbol: string; quantity: number };
export type RobinhoodOrderState = "pending" | "partially_filled" | "filled" | "canceled" | "rejected" | "unknown";
export type RobinhoodExecution = {
  id: string;
  quantity: string;
  price: string;
  fee: string;
  executedAt: Date;
};
export type RobinhoodOrder = {
  readonly orderId: string;
  readonly refId: string | null;
  readonly symbol: string;
  readonly state: RobinhoodOrderState;
  readonly executions: readonly RobinhoodExecution[];
};
export type ReviewedRobinhoodBuy = {
  readonly accountNumber: string;
  readonly symbol: string;
  readonly amountCents: number;
  readonly quote: Readonly<RobinhoodQuote>;
};
export type RobinhoodPlacement = { orderId: string; state: RobinhoodOrderState };

export type RobinhoodErrorCode =
  | "invalid_input"
  | "authentication_failed"
  | "permission_denied"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_response"
  | "tool_error"
  | "agentic_account_required"
  | "placement_rejected"
  | "placement_unknown";

export class RobinhoodError extends Error {
  constructor(readonly code: RobinhoodErrorCode) {
    super(code);
    this.name = "RobinhoodError";
  }
}

const registrationSchema = z.object({ client_id: z.string().min(1).max(1024) });
const tokenSchema = z.object({
  access_token: z.string().min(24).max(16_384),
  refresh_token: z.string().min(24).max(16_384).optional(),
  expires_in: z.number().int().positive().max(86_400).optional(),
});

function cleanToken(value: string): string {
  if (value.length < 24 || value.length > 16_384 || /\s/.test(value)) {
    throw new RobinhoodError("invalid_response");
  }
  return value;
}

function cleanClientId(value: string): string {
  if (!value || value.length > 1024 || /\s/.test(value)) {
    throw new RobinhoodError("invalid_response");
  }
  return value;
}

function cleanSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z.-]{1,10}$/.test(symbol)) throw new RobinhoodError("invalid_response");
  return symbol;
}

function cleanUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new RobinhoodError("invalid_response");
  }
  return value;
}

function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw new RobinhoodError("invalid_response");
  return number;
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new RobinhoodError("invalid_response");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new RobinhoodError("invalid_response");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new RobinhoodError("invalid_response");
  }
}

function providerStatus(response: Response): void {
  if (response.status === 401) throw new RobinhoodError("authentication_failed");
  if (response.status === 403) throw new RobinhoodError("permission_denied");
  if (response.status === 429) throw new RobinhoodError("rate_limited");
  if (!response.ok) throw new RobinhoodError("provider_unavailable");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge };
}

export async function registerRobinhoodWebClient(
  redirectUri: string,
  state: string,
  fetcher: FetchLike = fetch,
): Promise<RobinhoodRegistration> {
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "https:" || redirect.username || redirect.password || redirect.hash) {
    throw new RobinhoodError("invalid_input");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new RobinhoodError("invalid_input");
  const response = await fetcher(REGISTRATION_ENDPOINT, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", "user-agent": "DayTradingBot/0.1 web-oauth" },
    body: JSON.stringify({
      client_name: "DayTradingBot Web",
      application_type: "web",
      redirect_uris: [redirect.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: OAUTH_SCOPE,
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new RobinhoodError("provider_unavailable"); });
  providerStatus(response);
  const registration = registrationSchema.parse(await boundedJson(response));
  const clientId = cleanClientId(registration.client_id);
  const { verifier, challenge } = generatePkce();
  const authorization = new URL(AUTHORIZATION_ENDPOINT);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", clientId);
  authorization.searchParams.set("redirect_uri", redirect.toString());
  authorization.searchParams.set("scope", OAUTH_SCOPE);
  authorization.searchParams.set("resource", MCP_RESOURCE);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("state", state);
  return { clientId, verifier, authorizationUrl: authorization.toString() };
}

async function tokenRequest(body: URLSearchParams, fetcher: FetchLike): Promise<RobinhoodTokenBundle> {
  const response = await fetcher(TOKEN_ENDPOINT, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "DayTradingBot/0.1 web-oauth",
    },
    body,
    signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new RobinhoodError("provider_unavailable"); });
  providerStatus(response);
  const token = tokenSchema.parse(await boundedJson(response));
  return {
    accessToken: cleanToken(token.access_token),
    ...(token.refresh_token ? { refreshToken: cleanToken(token.refresh_token) } : {}),
    clientId: cleanClientId(body.get("client_id") ?? ""),
    expiresAtUnix: Math.floor(Date.now() / 1_000) + (token.expires_in ?? 3_600),
  };
}

export async function exchangeRobinhoodCode(
  input: { code: string; clientId: string; redirectUri: string; verifier: string },
  fetcher: FetchLike = fetch,
): Promise<RobinhoodTokenBundle> {
  if (!input.code || input.code.length > 4_096 || /\s/.test(input.code)) {
    throw new RobinhoodError("invalid_input");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: cleanClientId(input.clientId),
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
    resource: MCP_RESOURCE,
  });
  return tokenRequest(body, fetcher);
}

export async function refreshRobinhoodToken(
  bundle: RobinhoodTokenBundle,
  fetcher: FetchLike = fetch,
): Promise<RobinhoodTokenBundle> {
  if (!bundle.refreshToken) throw new RobinhoodError("authentication_failed");
  const refreshed = await tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cleanToken(bundle.refreshToken),
    client_id: cleanClientId(bundle.clientId),
    resource: MCP_RESOURCE,
  }), fetcher);
  return {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? bundle.refreshToken,
  };
}

function parseRpcBody(text: string, expectedId: number): unknown {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const candidate = JSON.parse(data) as { id?: unknown };
      if (candidate.id === expectedId) return candidate;
    } catch {
      // Continue to the next bounded SSE event.
    }
  }
  try {
    const candidate = JSON.parse(text) as { id?: unknown };
    if (candidate.id === expectedId) return candidate;
  } catch {
    // Converted to a stable provider error below.
  }
  throw new RobinhoodError("invalid_response");
}

const rpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().int().nonnegative(),
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  }).optional(),
  error: z.unknown().optional(),
});

const initializeRpcSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.literal(1),
  result: z.object({ protocolVersion: z.literal(MCP_PROTOCOL_VERSION) }),
  error: z.never().optional(),
});

function toolValue(response: unknown): unknown {
  const rpc = rpcSchema.parse(response);
  if (!rpc.result || rpc.error !== undefined || rpc.result.isError) {
    throw new RobinhoodError("tool_error");
  }
  if (rpc.result.structuredContent !== undefined) return rpc.result.structuredContent;
  const text = rpc.result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new RobinhoodError("invalid_response");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RobinhoodError("invalid_response");
  }
}

async function boundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new RobinhoodError("invalid_response");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new RobinhoodError("invalid_response");
  return new TextDecoder().decode(bytes);
}

const accountPayloadSchema = z.object({ data: z.object({ accounts: z.array(z.object({
  account_number: z.string().min(1).max(256),
  agentic_allowed: z.boolean().optional().default(false),
})) }) });
const portfolioPayloadSchema = z.object({ data: z.object({ buying_power: z.object({
  buying_power: z.unknown().optional(),
  unleveraged_buying_power: z.unknown().optional(),
}).optional() }) });
const quoteWireSchema = z.object({
  symbol: z.string(),
  last_trade_price: z.unknown().optional(),
  price: z.unknown().optional(),
  previous_close: z.unknown().optional(),
  adjusted_previous_close: z.unknown().optional(),
  venue_last_trade_time: z.string(),
});
const quotePayloadSchema = z.object({ data: z.object({ results: z.array(z.object({ quote: quoteWireSchema.optional() })) }) });
const positionPayloadSchema = z.object({ data: z.object({ positions: z.array(z.object({
  symbol: z.string(), quantity: z.unknown(),
})) }) });
const executionSchema = z.object({
  id: z.string().min(1).max(255), quantity: z.unknown(), price: z.unknown(), fees: z.unknown().optional(), timestamp: z.string(),
});
const orderPayloadSchema = z.object({ data: z.object({ orders: z.array(z.object({
  id: z.string(),
  ref_id: z.string().nullish(),
  symbol: z.string(),
  state: z.string(),
  executions: z.array(executionSchema).optional().default([]),
})) }) });
const reviewPayloadSchema = z.object({ data: z.object({
  symbol: z.string(), side: z.string(), type: z.string(), dollar_amount: z.unknown(), quote_data: quoteWireSchema,
}) });

function quoteFromWire(wire: z.infer<typeof quoteWireSchema>): RobinhoodQuote {
  const symbol = cleanSymbol(wire.symbol);
  const lastTradePrice = numberValue(wire.last_trade_price ?? wire.price);
  const previousClose = numberValue(wire.previous_close ?? wire.adjusted_previous_close);
  const venueLastTradeTime = new Date(wire.venue_last_trade_time);
  if (lastTradePrice <= 0 || previousClose <= 0 || Number.isNaN(venueLastTradeTime.getTime())) {
    throw new RobinhoodError("invalid_response");
  }
  return {
    symbol,
    lastTradePrice,
    previousClose,
    venueLastTradeTime,
    changePercent: ((lastTradePrice - previousClose) / previousClose) * 100,
  };
}

function orderState(value: string): RobinhoodOrderState {
  if (value === "partially_filled") return "partially_filled";
  if (value === "filled") return "filled";
  if (["cancelled", "canceled", "voided"].includes(value)) return "canceled";
  if (["rejected", "failed"].includes(value)) return "rejected";
  if (["new", "queued", "confirmed", "unconfirmed"].includes(value)) return "pending";
  return "unknown";
}

function hasPreTradeWarning(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasPreTradeWarning);
  for (const [key, nested] of Object.entries(value)) {
    if (/warning|alert/i.test(key)) {
      if (Array.isArray(nested) && nested.length > 0) return true;
      if (typeof nested === "string" && nested.trim()) return true;
      if (typeof nested === "boolean" && nested) return true;
      if (nested && typeof nested === "object" && Object.keys(nested).length > 0) return true;
    }
    if (hasPreTradeWarning(nested)) return true;
  }
  return false;
}

export class RobinhoodTradingSession {
  private requestId = 3;

  constructor(
    private readonly client: RobinhoodMcpClient,
    private readonly sessionId: string,
    private readonly accountNumber: string,
  ) {}

  private async call(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    const id = this.requestId++;
    const response = await this.client[MCP_RPC]({
      jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ },
    }, id, this.sessionId);
    return toolValue(response);
  }

  async buyingPowerCents(): Promise<number> {
    const payload = portfolioPayloadSchema.parse(await this.call("get_portfolio", { account_number: this.accountNumber }));
    const value = payload.data.buying_power?.unleveraged_buying_power ?? payload.data.buying_power?.buying_power;
    const amount = numberValue(value);
    if (amount < 0) throw new RobinhoodError("invalid_response");
    return Math.floor((amount + Number.EPSILON) * 100);
  }

  async positions(): Promise<RobinhoodPosition[]> {
    const payload = positionPayloadSchema.parse(await this.call("get_equity_positions", { account_number: this.accountNumber }));
    return payload.data.positions.map((position) => ({
      symbol: cleanSymbol(position.symbol),
      quantity: numberValue(position.quantity),
    }));
  }

  async quotes(symbols: string[]): Promise<RobinhoodQuote[]> {
    if (!symbols.length || symbols.length > 20 || new Set(symbols).size !== symbols.length) {
      throw new RobinhoodError("invalid_input");
    }
    const clean = symbols.map(cleanSymbol);
    const payload = quotePayloadSchema.parse(await this.call("get_equity_quotes", { symbols: clean }));
    return payload.data.results.flatMap((result) => result.quote ? [quoteFromWire(result.quote)] : []);
  }

  async orders(input: { since?: Date; orderId?: string } = {}): Promise<RobinhoodOrder[]> {
    const arguments_: Record<string, unknown> = { account_number: this.accountNumber };
    if (input.since) {
      arguments_.created_at_gte = input.since.toISOString();
      arguments_.placed_agent = "agentic";
    }
    if (input.orderId) arguments_.order_id = cleanUuid(input.orderId);
    const payload = orderPayloadSchema.parse(await this.call("get_equity_orders", arguments_));
    return payload.data.orders.map((wire) => ({
      orderId: cleanUuid(wire.id),
      refId: wire.ref_id ? cleanUuid(wire.ref_id) : null,
      symbol: cleanSymbol(wire.symbol),
      state: orderState(wire.state),
      executions: wire.executions.map((execution) => {
        const quantity = numberValue(execution.quantity);
        const price = numberValue(execution.price);
        const fee = execution.fees === undefined ? 0 : numberValue(execution.fees);
        const executedAt = new Date(execution.timestamp);
        if (quantity <= 0 || price <= 0 || fee < 0 || Number.isNaN(executedAt.getTime())) {
          throw new RobinhoodError("invalid_response");
        }
        return { id: execution.id, quantity: String(quantity), price: String(price), fee: String(fee), executedAt };
      }),
    }));
  }

  async reviewMarketBuy(symbolValue: string, amountCents: number): Promise<ReviewedRobinhoodBuy> {
    const symbol = cleanSymbol(symbolValue);
    if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > 5_000_000) {
      throw new RobinhoodError("invalid_input");
    }
    const amount = (amountCents / 100).toFixed(2);
    const rawPayload = await this.call("review_equity_order", {
      account_number: this.accountNumber,
      symbol,
      side: "buy",
      type: "market",
      dollar_amount: amount,
      time_in_force: "gfd",
      market_hours: "regular_hours",
    });
    if (hasPreTradeWarning(rawPayload)) throw new RobinhoodError("placement_rejected");
    const payload = reviewPayloadSchema.parse(rawPayload);
    if (
      cleanSymbol(payload.data.symbol) !== symbol
      || payload.data.side !== "buy"
      || payload.data.type !== "market"
      || Math.round(numberValue(payload.data.dollar_amount) * 100) !== amountCents
    ) {
      throw new RobinhoodError("invalid_response");
    }
    const quote = quoteFromWire(payload.data.quote_data);
    if (quote.symbol !== symbol) throw new RobinhoodError("invalid_response");
    return Object.freeze({
      accountNumber: this.accountNumber,
      symbol,
      amountCents,
      quote: Object.freeze(quote),
    });
  }

  async placeReviewedMarketBuy(reviewed: ReviewedRobinhoodBuy, refIdValue: string): Promise<RobinhoodPlacement> {
    if (reviewed.accountNumber !== this.accountNumber) throw new RobinhoodError("placement_rejected");
    const refId = cleanUuid(refIdValue);
    const id = this.requestId++;
    let response: unknown;
    try {
      response = await this.client[MCP_RPC]({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "place_equity_order",
          arguments: {
            account_number: this.accountNumber,
            symbol: reviewed.symbol,
            side: "buy",
            type: "market",
            dollar_amount: (reviewed.amountCents / 100).toFixed(2),
            time_in_force: "gfd",
            market_hours: "regular_hours",
            ref_id: refId,
          },
        },
      }, id, this.sessionId);
    } catch (error) {
      if (error instanceof RobinhoodError && ["authentication_failed", "permission_denied", "rate_limited", "tool_error", "invalid_input"].includes(error.code)) {
        throw new RobinhoodError("placement_rejected");
      }
      throw new RobinhoodError("placement_unknown");
    }
    try {
      const value = toolValue(response) as { data?: { id?: unknown; order_id?: unknown; state?: unknown; order?: { id?: unknown; state?: unknown } } };
      const rawId = value.data?.id ?? value.data?.order?.id ?? value.data?.order_id;
      if (typeof rawId !== "string") throw new RobinhoodError("invalid_response");
      const rawState = value.data?.state ?? value.data?.order?.state;
      return { orderId: cleanUuid(rawId), state: typeof rawState === "string" ? orderState(rawState) : "pending" };
    } catch {
      throw new RobinhoodError("placement_unknown");
    }
  }
}

export class RobinhoodMcpClient {
  constructor(private readonly accessToken: string, private readonly fetcher: FetchLike = fetch) {
    cleanToken(accessToken);
  }

  async [MCP_RPC](payload: Record<string, unknown>, expectedId: number, sessionId?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.accessToken}`,
      "content-type": "application/json",
      "user-agent": "DayTradingBot/0.1 web-agent",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const response = await this.fetcher(MCP_ENDPOINT, {
      method: "POST", redirect: "error", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    }).catch(() => { throw new RobinhoodError("provider_unavailable"); });
    providerStatus(response);
    const parsed = parseRpcBody(await boundedText(response), expectedId);
    const rpc = rpcSchema.parse(parsed);
    if (rpc.id !== expectedId || (rpc.result === undefined) === (rpc.error === undefined)) {
      throw new RobinhoodError("invalid_response");
    }
    return parsed;
  }

  private async initialize(): Promise<{ sessionId: string; accounts: z.infer<typeof accountPayloadSchema>["data"]["accounts"] }> {
    // Initialization is handled directly because its response header carries
    // the MCP session identifier used by every later typed tool call.
    const initResponse = await this.fetcher(MCP_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
        "user-agent": "DayTradingBot/0.1 web-agent",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "daytradingbot-web-agent", version: "0.1" },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => { throw new RobinhoodError("provider_unavailable"); });
    providerStatus(initResponse);
    const sessionId = initResponse.headers.get("mcp-session-id");
    const initPayload = initializeRpcSchema.safeParse(parseRpcBody(await boundedText(initResponse), 1));
    if (!sessionId || sessionId.length > 1024 || !initPayload.success) {
      throw new RobinhoodError("invalid_response");
    }
    const notification = await this.fetcher(MCP_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        "user-agent": "DayTradingBot/0.1 web-agent",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => { throw new RobinhoodError("provider_unavailable"); });
    providerStatus(notification);
    const accountResponse = await this[MCP_RPC]({
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_accounts", arguments: {} },
    }, 2, sessionId);
    const accounts = accountPayloadSchema.parse(toolValue(accountResponse)).data.accounts;
    return { sessionId, accounts };
  }

  async snapshot(): Promise<RobinhoodSnapshot> {
    const initialized = await this.initialize();
    const allowed = initialized.accounts.filter((account) => account.agentic_allowed);
    let hasBuyingPower = false;
    let id = 3;
    for (const account of allowed) {
      const response = await this[MCP_RPC]({
        jsonrpc: "2.0", id, method: "tools/call", params: {
          name: "get_portfolio", arguments: { account_number: account.account_number },
        },
      }, id, initialized.sessionId);
      id += 1;
      const payload = portfolioPayloadSchema.parse(toolValue(response));
      const value = payload.data.buying_power?.unleveraged_buying_power ?? payload.data.buying_power?.buying_power;
      hasBuyingPower ||= numberValue(value) > 0;
    }
    return {
      authenticated: true,
      agenticAccountAvailable: allowed.length > 0,
      agenticAccountCount: allowed.length,
      hasBuyingPower: allowed.length > 0 && hasBuyingPower,
    };
  }

  async tradingSession(): Promise<RobinhoodTradingSession> {
    const initialized = await this.initialize();
    const allowed = initialized.accounts.filter((account) => account.agentic_allowed);
    if (allowed.length !== 1 || !allowed[0]) throw new RobinhoodError("agentic_account_required");
    return new RobinhoodTradingSession(this, initialized.sessionId, allowed[0].account_number);
  }
}

export function newOauthState(): string {
  return randomBytes(32).toString("base64url");
}

export function newIntentId(): string {
  return randomUUID();
}
