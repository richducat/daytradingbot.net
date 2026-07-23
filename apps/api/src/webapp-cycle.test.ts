import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RobinhoodOrder, RobinhoodQuote, ReviewedRobinhoodBuy } from "./robinhood-web.js";
import { MySqlWebAppRepository, WebAppError, WebAppService, marketIsOpen } from "./webapp.js";

const LICENSE_ID = "00000000-0000-4000-8000-000000000001";
const INTENT_ID = "00000000-0000-4000-8000-000000000002";
const ORDER_ID = "00000000-0000-4000-8000-000000000003";
const ACCESS_TOKEN = "a".repeat(32);
const NOW = new Date("2026-07-22T14:30:00.000Z");

type CycleMode = "practice" | "real";

function quote(symbol: string, changePercent: number): RobinhoodQuote {
  const previousClose = 100;
  return {
    symbol,
    previousClose,
    lastTradePrice: previousClose * (1 + changePercent / 100),
    changePercent,
    venueLastTradeTime: new Date(NOW.getTime() - 10_000),
  };
}

function cycleHarness(input: {
  mode?: CycleMode;
  realTradingEnabled?: boolean;
  reviewedChangePercent?: number;
  submissionAuthorized?: boolean;
  orderState?: RobinhoodOrder["state"];
  incompleteQuotes?: boolean;
} = {}) {
  const mode = input.mode ?? "real";
  const activities: Array<{ kind: string; message: string }> = [];
  const markedIntents: Array<{ state: string; orderId: string | null }> = [];
  let claimed = false;
  let paused = false;
  let reserved = 0;
  let submissions = 0;
  let placements = 0;

  const repository = {
    recordWorkerStarted: vi.fn(async () => undefined),
    recordWorkerFinished: vi.fn(async () => undefined),
    reconciliationLicenses: vi.fn(async () => [] as string[]),
    claimDueCycles: vi.fn(async () => {
      if (claimed) return [];
      claimed = true;
      return [{
        licenseId: LICENSE_ID,
        mode,
        dailyBudgetCents: 1_000,
        maxPerTradeCents: 500,
        realAuthorizedUntil: mode === "real" ? new Date(NOW.getTime() + 60_000) : null,
      }];
    }),
    cycleStillActive: vi.fn(async () => !paused),
    recordActivity: vi.fn(async (_licenseId: string, _mode: CycleMode, kind: string, message: string) => {
      activities.push({ kind, message });
    }),
    finishCycle: vi.fn(async () => undefined),
    failCycle: vi.fn(async (_licenseId: string, _message: string, shouldPause: boolean) => {
      if (shouldPause) paused = true;
    }),
    pauseTrading: vi.fn(async () => { paused = true; }),
    getConnection: vi.fn(async () => ({
      credentials: { accessToken: ACCESS_TOKEN, clientId: "client", expiresAtUnix: Math.floor(NOW.getTime() / 1_000) + 3_600 },
      state: "connected" as const,
      hasBuyingPower: true,
      lastCheckedAt: NOW,
    })),
    unresolvedIntents: vi.fn(async () => []),
    reserveRealIntent: vi.fn(async () => {
      reserved += 1;
      return { status: "reserved" as const, intentId: INTENT_ID };
    }),
    beginSubmission: vi.fn(async () => {
      submissions += 1;
      return true;
    }),
    submissionStillAuthorized: vi.fn(async () => input.submissionAuthorized ?? true),
    markIntent: vi.fn(async (_intentId: string, state: string, orderId: string | null = null) => {
      markedIntents.push({ state, orderId });
    }),
    recordFill: vi.fn(async () => ({ recorded: true, notionalCents: 500 })),
  };

  const initialQuotes = [
    quote("AAPL", -2),
    ...["NVDA", "TSLA", "SPY", "QQQ", "AMD", "MSFT", "GOOGL"].map((symbol) => quote(symbol, 0)),
  ];
  if (input.incompleteQuotes) initialQuotes.pop();
  const reviewed: ReviewedRobinhoodBuy = Object.freeze({
    accountNumber: "agentic",
    symbol: "AAPL",
    amountCents: 500,
    quote: Object.freeze(quote("AAPL", input.reviewedChangePercent ?? -2)),
  });
  const placedOrder: RobinhoodOrder = {
    orderId: ORDER_ID,
    refId: INTENT_ID,
    symbol: "AAPL",
    state: input.orderState ?? "pending",
    executions: [],
  };
  const session = {
    buyingPowerCents: vi.fn(async () => 5_000),
    positions: vi.fn(async () => []),
    orders: vi.fn(async (request: { orderId?: string } = {}) => request.orderId ? [placedOrder] : []),
    quotes: vi.fn(async () => initialQuotes),
    reviewMarketBuy: vi.fn(async () => reviewed),
    placeReviewedMarketBuy: vi.fn(async () => {
      placements += 1;
      return { orderId: ORDER_ID, state: input.orderState ?? "pending" };
    }),
  };
  const client = {
    snapshot: vi.fn(async () => ({ authenticated: true as const, agenticAccountAvailable: true, agenticAccountCount: 1, hasBuyingPower: true })),
    tradingSession: vi.fn(async () => session),
  };
  const service = new WebAppService(
    repository as unknown as MySqlWebAppRepository,
    "https://api.daytradingbot.net",
    "https://daytradingbot.net",
    input.realTradingEnabled ?? true,
    () => client,
  );

  return {
    service,
    repository,
    session,
    activities,
    markedIntents,
    state: () => ({ paused, reserved, submissions, placements }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Bluechip browser worker", () => {
  it("records a matching Practice trade without reserving or placing an order", async () => {
    const harness = cycleHarness({ mode: "practice" });
    const result = await harness.service.runDueCycles();

    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(harness.state()).toMatchObject({ reserved: 0, submissions: 0, placements: 0 });
    expect(harness.activities.some((activity) => activity.message.includes("Practice only"))).toBe(true);
  });

  it("places exactly one bounded Real order after every execution gate passes", async () => {
    const harness = cycleHarness();
    const result = await harness.service.runDueCycles();

    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(harness.state()).toMatchObject({ reserved: 1, submissions: 1, placements: 1 });
    expect(harness.session.placeReviewedMarketBuy).toHaveBeenCalledOnce();
    expect(harness.session.placeReviewedMarketBuy).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "AAPL", amountCents: 500 }),
      INTENT_ID,
    );
  });

  it("does not reserve or place when the fresh review price no longer matches", async () => {
    const harness = cycleHarness({ reviewedChangePercent: -1 });
    await harness.service.runDueCycles();

    expect(harness.state()).toMatchObject({ reserved: 0, placements: 0 });
    expect(harness.activities.some((activity) => activity.message.includes("no longer matched"))).toBe(true);
  });

  it("does not place after reservation when the final authorization check fails", async () => {
    const harness = cycleHarness({ submissionAuthorized: false });
    await harness.service.runDueCycles();

    expect(harness.state()).toMatchObject({ reserved: 1, submissions: 1, placements: 0 });
    expect(harness.markedIntents).toContainEqual({ state: "rejected", orderId: null });
  });

  it("pauses an already-running Real cycle when the production switch is off", async () => {
    const harness = cycleHarness({ realTradingEnabled: false });
    await harness.service.runDueCycles();

    expect(harness.state()).toMatchObject({ paused: true, reserved: 0, placements: 0 });
  });

  it("pauses after an unknown broker order state and sends no second order", async () => {
    const harness = cycleHarness({ orderState: "unknown" });
    const result = await harness.service.runDueCycles();

    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1 });
    expect(harness.state()).toMatchObject({ paused: true, placements: 1 });
    expect(harness.session.placeReviewedMarketBuy).toHaveBeenCalledOnce();
  });

  it("fails closed when Robinhood omits any watchlist quote", async () => {
    const harness = cycleHarness({ incompleteQuotes: true });
    const result = await harness.service.runDueCycles();

    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1 });
    expect(harness.state().placements).toBe(0);
  });
});

describe("order recovery", () => {
  it("reconciles a paused crash-after-send intent by its Robinhood reference", async () => {
    const markIntent = vi.fn(async () => undefined);
    const pauseTrading = vi.fn(async () => undefined);
    const order: RobinhoodOrder = {
      orderId: ORDER_ID,
      refId: INTENT_ID,
      symbol: "AAPL",
      state: "pending",
      executions: [],
    };
    const repository = {
      recordWorkerStarted: vi.fn(async () => undefined),
      recordWorkerFinished: vi.fn(async () => undefined),
      reconciliationLicenses: vi.fn(async () => [LICENSE_ID]),
      claimDueCycles: vi.fn(async () => []),
      getConnection: vi.fn(async () => ({
        credentials: { accessToken: ACCESS_TOKEN, clientId: "client", expiresAtUnix: Math.floor(NOW.getTime() / 1_000) + 3_600 },
        state: "connected" as const,
        hasBuyingPower: true,
        lastCheckedAt: NOW,
      })),
      unresolvedIntents: vi.fn(async () => [{
        intent_id: INTENT_ID,
        state: "submitting" as const,
        venue_order_id: null,
        symbol: "AAPL",
        amount_cents: 500,
      }]),
      markIntent,
      recordFill: vi.fn(async () => ({ recorded: false, notionalCents: 0 })),
      recordActivity: vi.fn(async () => undefined),
      pauseTrading,
    };
    const session = {
      buyingPowerCents: vi.fn(async () => 0),
      positions: vi.fn(async () => []),
      orders: vi.fn(async () => [order]),
      quotes: vi.fn(async () => []),
      reviewMarketBuy: vi.fn(async () => { throw new Error("not used"); }),
      placeReviewedMarketBuy: vi.fn(async () => { throw new Error("not used"); }),
    };
    const service = new WebAppService(
      repository as unknown as MySqlWebAppRepository,
      "https://api.daytradingbot.net",
      "https://daytradingbot.net",
      true,
      () => ({
        snapshot: async () => ({ authenticated: true, agenticAccountAvailable: true, agenticAccountCount: 1, hasBuyingPower: true }),
        tradingSession: async () => session,
      }),
    );

    expect(await service.runDueCycles()).toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(markIntent).toHaveBeenCalledWith(INTENT_ID, "submitted", ORDER_ID);
    expect(pauseTrading).not.toHaveBeenCalled();
    expect(session.placeReviewedMarketBuy).not.toHaveBeenCalled();
  });
});

describe("Real trading start gates", () => {
  function startService(workerReady: boolean) {
    const repository = {
      workerStatus: vi.fn(async () => ({ ready: workerReady, lastSuccessfulCheckAt: workerReady ? NOW : null })),
      startTrading: vi.fn(async () => undefined),
    };
    return new WebAppService(
      repository as unknown as MySqlWebAppRepository,
      "https://api.daytradingbot.net",
      "https://daytradingbot.net",
      true,
      () => { throw new Error("not used"); },
    );
  }

  it("blocks Start when the production worker is stale", async () => {
    const service = startService(false);
    await expect(service.start(LICENSE_ID, { mode: "real", acceptedRealRisk: true }))
      .rejects.toMatchObject({ code: "trading_unavailable" } satisfies Partial<WebAppError>);
  });

  it("requires the customer to approve Real trading", async () => {
    const service = startService(true);
    await expect(service.start(LICENSE_ID, { mode: "real", acceptedRealRisk: false }))
      .rejects.toMatchObject({ code: "real_risk_acknowledgement_required" } satisfies Partial<WebAppError>);
  });
});

describe("conservative market window", () => {
  it("allows the normal mid-morning window", () => {
    expect(marketIsOpen(new Date("2026-07-22T14:30:00.000Z"))).toBe(true);
  });

  it("blocks exchange holidays and the period near a standard early close", () => {
    expect(marketIsOpen(new Date("2026-07-03T14:30:00.000Z"))).toBe(false);
    expect(marketIsOpen(new Date("2026-11-27T18:00:00.000Z"))).toBe(false);
  });
});
