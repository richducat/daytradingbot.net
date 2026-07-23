import { describe, expect, it, vi } from "vitest";
import {
  generatePkce,
  registerRobinhoodWebClient,
  RobinhoodMcpClient,
} from "./robinhood-web.js";

function rpc(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Robinhood browser connection", () => {
  it("creates a SHA-256 PKCE pair without padding", () => {
    const pair = generatePkce();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("registers only the fixed HTTPS callback and returns a Robinhood URL", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { redirect_uris?: unknown };
      expect(body.redirect_uris).toEqual(["https://api.daytradingbot.net/v1/web/connections/robinhood/callback"]);
      return new Response(JSON.stringify({ client_id: "client-id-123" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await registerRobinhoodWebClient(
      "https://api.daytradingbot.net/v1/web/connections/robinhood/callback",
      "s".repeat(43),
      fetcher,
    );
    const authorization = new URL(result.authorizationUrl);
    expect(authorization.origin).toBe("https://robinhood.com");
    expect(authorization.searchParams.get("state")).toBe("s".repeat(43));
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("returns only redacted account readiness from the MCP", async () => {
    const accountNumber = "must-not-leave-the-server";
    const responses = [
      new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-03-26" },
      }), { status: 200, headers: { "mcp-session-id": "session-123" } }),
      new Response("", { status: 202 }),
      rpc(2, {
        structuredContent: { data: { accounts: [{ account_number: accountNumber, agentic_allowed: true }] } },
        isError: false,
      }),
      rpc(3, {
        structuredContent: { data: { buying_power: { unleveraged_buying_power: "12.34" } } },
        isError: false,
      }),
    ];
    const fetcher = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }) as unknown as typeof fetch;
    const snapshot = await new RobinhoodMcpClient("a".repeat(32), fetcher).snapshot();
    expect(snapshot).toEqual({
      authenticated: true,
      agenticAccountAvailable: true,
      agenticAccountCount: 1,
      hasBuyingPower: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain(accountNumber);
    expect(JSON.stringify(snapshot)).not.toContain("12.34");
  });

  it("rejects a malformed MCP initialization handshake", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "unexpected-version" },
    }), { status: 200, headers: { "mcp-session-id": "session-123" } })) as unknown as typeof fetch;

    await expect(new RobinhoodMcpClient("a".repeat(32), fetcher).snapshot())
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("places only the exact market buy that was reviewed", async () => {
    const accountNumber = "private-agentic-account";
    const intentId = "b3aa5c84-206c-4ce7-873a-97a61b99f70c";
    const orderId = "ed602d6c-8d86-4e18-9bd5-cda8850473f3";
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-03-26" },
      }), { status: 200, headers: { "mcp-session-id": "session-123" } }),
      new Response("", { status: 202 }),
      rpc(2, {
        structuredContent: { data: { accounts: [{ account_number: accountNumber, agentic_allowed: true }] } },
        isError: false,
      }),
      rpc(3, {
        structuredContent: {
          data: {
            symbol: "AAPL",
            side: "buy",
            type: "market",
            dollar_amount: "2.00",
            quote_data: {
              symbol: "AAPL",
              last_trade_price: "100.00",
              previous_close: "103.00",
              venue_last_trade_time: "2026-07-14T17:00:00.000Z",
            },
          },
        },
        isError: false,
      }),
      rpc(4, {
        structuredContent: { data: { id: orderId, state: "queued" } },
        isError: false,
      }),
    ];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }) as unknown as typeof fetch;

    const session = await new RobinhoodMcpClient("a".repeat(32), fetcher).tradingSession();
    const reviewed = await session.reviewMarketBuy("AAPL", 200);
    const placement = await session.placeReviewedMarketBuy(reviewed, intentId);

    expect(Object.isFrozen(reviewed)).toBe(true);
    expect(Object.isFrozen(reviewed.quote)).toBe(true);
    expect(placement).toEqual({ orderId, state: "pending" });
    expect(requests.at(-1)).toMatchObject({
      method: "tools/call",
      params: {
        name: "place_equity_order",
        arguments: {
          account_number: accountNumber,
          symbol: "AAPL",
          side: "buy",
          type: "market",
          dollar_amount: "2.00",
          time_in_force: "gfd",
          market_hours: "regular_hours",
          ref_id: intentId,
        },
      },
    });
  });

  it("fails closed when Robinhood returns a pre-trade warning", async () => {
    const responses = [
      new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-03-26" },
      }), { status: 200, headers: { "mcp-session-id": "session-123" } }),
      new Response("", { status: 202 }),
      rpc(2, {
        structuredContent: { data: { accounts: [{ account_number: "agentic", agentic_allowed: true }] } },
        isError: false,
      }),
      rpc(3, {
        structuredContent: {
          data: {
            symbol: "AAPL",
            side: "buy",
            type: "market",
            dollar_amount: "2.00",
            warnings: [{ message: "review required" }],
            quote_data: {
              symbol: "AAPL",
              last_trade_price: "100.00",
              previous_close: "103.00",
              venue_last_trade_time: "2026-07-14T17:00:00.000Z",
            },
          },
        },
        isError: false,
      }),
    ];
    const fetcher = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }) as unknown as typeof fetch;

    const session = await new RobinhoodMcpClient("a".repeat(32), fetcher).tradingSession();
    await expect(session.reviewMarketBuy("AAPL", 200))
      .rejects.toMatchObject({ code: "placement_rejected" });
  });

  it("keeps the intent reference when reading orders for crash recovery", async () => {
    const intentId = "b3aa5c84-206c-4ce7-873a-97a61b99f70c";
    const orderId = "ed602d6c-8d86-4e18-9bd5-cda8850473f3";
    const responses = [
      new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-03-26" },
      }), { status: 200, headers: { "mcp-session-id": "session-123" } }),
      new Response("", { status: 202 }),
      rpc(2, {
        structuredContent: { data: { accounts: [{ account_number: "agentic", agentic_allowed: true }] } },
        isError: false,
      }),
      rpc(3, {
        structuredContent: {
          data: { orders: [{ id: orderId, ref_id: intentId, symbol: "AAPL", state: "queued", executions: [] }] },
        },
        isError: false,
      }),
    ];
    const fetcher = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    }) as unknown as typeof fetch;

    const session = await new RobinhoodMcpClient("a".repeat(32), fetcher).tradingSession();
    expect(await session.orders({ since: new Date("2026-07-14T00:00:00.000Z") })).toEqual([{
      orderId,
      refId: intentId,
      symbol: "AAPL",
      state: "pending",
      executions: [],
    }]);
  });
});
