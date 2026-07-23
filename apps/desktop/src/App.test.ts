import { describe, expect, it } from "vitest";

import {
  type ActivityItem,
  connectionStatusLabel,
  dataLifecycleCopy,
  decisionHasFinalOutcome,
  decisionOutcome,
  groupActivityByDay,
  limitPlanCopy,
  licenseStatusPresentation,
  liveBotState,
  normalizeTradingLimits,
  polymarketUsAccountReadiness,
  realTradingAccountReadiness,
  realTradingAuthorizationSummary,
  setupRiskCopy,
  tradingActionLabel,
  tradingControlGate,
  tradingModeAccountReady,
  tradingViewChartUrl,
  tradingViewSymbolUrl,
  unavailableWatchState,
  watchDisplayMode,
  watchSymbols,
} from "./App";

function activityItem(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "event-1",
    agent_id: "bluechip",
    mode: "practice",
    kind: "market_check",
    recorded_order_state: null,
    symbol: "AAPL",
    amount_usd: null,
    message: "Bluechip checked AAPL.",
    occurred_at: "2026-07-23T15:00:00-04:00",
    ...overrides,
  };
}

describe("customer trading limits", () => {
  it("keeps every supported daily and per-trade combination unchanged", () => {
    let tested = 0;
    for (let dailyBudget = 1; dailyBudget <= 25; dailyBudget += 1) {
      for (let perTrade = 1; perTrade <= Math.min(5, dailyBudget); perTrade += 1) {
        expect(normalizeTradingLimits(dailyBudget, perTrade)).toEqual({
          dailyBudget,
          perTrade,
        });
        tested += 1;
      }
    }
    expect(tested).toBe(115);
  });

  it("repairs stale or malformed saved values without exceeding the supported limits", () => {
    expect(normalizeTradingLimits(99, 9)).toEqual({ dailyBudget: 25, perTrade: 5 });
    expect(normalizeTradingLimits(2, 5)).toEqual({ dailyBudget: 2, perTrade: 2 });
    expect(normalizeTradingLimits(20.9, 3.9)).toEqual({ dailyBudget: 20, perTrade: 3 });
    expect(normalizeTradingLimits("not-a-number", "not-a-number")).toEqual({
      dailyBudget: 15,
      perTrade: 3,
    });
  });

  it("explains the automatic smaller final trade in plain English", () => {
    const copy = limitPlanCopy(20, 3);
    expect(copy).toContain("up to $3 per trade");
    expect(copy).toContain("$2 remains");
    expect(copy).toContain("one smaller trade instead of stopping");
  });

  it("describes the checks customers actually receive without claiming loss protection", () => {
    expect(setupRiskCopy).toContain("checks its signal");
    expect(setupRiskCopy).toContain("the market");
    expect(setupRiskCopy).toContain("your Robinhood account");
    expect(setupRiskCopy).toContain("remaining limit");
    expect(setupRiskCopy).toContain("Every trade can lose its full value");
    expect(setupRiskCopy.toLowerCase()).not.toContain("loss protection");
  });
});

describe("TradingView chart boundary", () => {
  it("creates only exact hosted-widget URLs for the fixed watchlist", () => {
    for (const symbol of watchSymbols) {
      const chartUrl = tradingViewChartUrl(symbol);
      expect(chartUrl).not.toBeNull();
      const parsed = new URL(chartUrl!);
      expect(parsed.origin).toBe("https://www.tradingview-widget.com");
      expect(parsed.pathname).toBe("/embed-widget/advanced-chart/");
      expect(parsed.searchParams.get("locale")).toBe("en");

      const config = JSON.parse(decodeURIComponent(parsed.hash.slice(1))) as {
        symbol: string;
        interval: string;
        allow_symbol_change: boolean;
        hide_top_toolbar: boolean;
        support_host: string;
      };
      expect(config.symbol).toMatch(/^(NASDAQ|AMEX):[A-Z]+$/);
      expect(config.interval).toBe("5");
      expect(config.allow_symbol_change).toBe(false);
      expect(config.hide_top_toolbar).toBe(true);
      expect(config.support_host).toBe("https://www.tradingview.com");

      const attributionUrl = new URL(tradingViewSymbolUrl(symbol)!);
      expect(attributionUrl.origin).toBe("https://www.tradingview.com");
      expect(attributionUrl.pathname).toMatch(/^\/symbols\/(NASDAQ|AMEX)-[A-Z]+\/$/);
    }
  });

  it("rejects injected, traversing, and unsupported symbols", () => {
    for (const symbol of ["AAPL&symbol=TSLA", "../AAPL", "META", "", "AAPL%0A"]) {
      expect(tradingViewChartUrl(symbol)).toBeNull();
      expect(tradingViewSymbolUrl(symbol)).toBeNull();
    }
  });
});

describe("Watch readback failures", () => {
  it("never turns an unavailable snapshot into a paused or no-order claim", () => {
    const state = unavailableWatchState();
    expect(state.status_available).toBe(false);
    expect(state.running).toBeNull();
    expect(state.mode).toBe("unavailable");
    expect(state.has_unresolved_real_order).toBeNull();
    expect(state.message).toContain("Do not assume trading is paused");
    expect(watchDisplayMode(state)).toBe("unavailable");
  });

  it("retains only the last known check time when a later poll fails", () => {
    const state = unavailableWatchState({
      ...unavailableWatchState(),
      status_available: true,
      running: true,
      mode: "real",
      last_checked_at: "2026-07-23T16:00:00Z",
      next_check_at: "2026-07-23T16:15:00Z",
      has_unresolved_real_order: false,
    });
    expect(state.last_checked_at).toBe("2026-07-23T16:00:00Z");
    expect(state.next_check_at).toBeNull();
    expect(state.budget_state).toBe("unavailable");
    expect(state.remaining_usd).toBeNull();
  });
});

describe("consumer status language", () => {
  it("never turns a failed account readback into a disconnected claim", () => {
    expect(connectionStatusLabel("checking", false)).toBe("Checking saved connection…");
    expect(connectionStatusLabel("unavailable", false)).toBe("Connection status unavailable");
    expect(connectionStatusLabel("available", false)).toBe("Not connected");
    expect(connectionStatusLabel("available", true)).toBe("Connection verified");
  });

  it("names the exact mode in every trading action", () => {
    expect(tradingActionLabel(false, false, "practice")).toBe("Check again");
    expect(tradingActionLabel(true, false, "practice")).toBe("Start Practice");
    expect(tradingActionLabel(true, true, "practice")).toBe("Pause Practice");
    expect(tradingActionLabel(true, false, "real")).toBe("Review Real Trading");
    expect(tradingActionLabel(true, true, "real")).toBe("Pause new real trades");
  });

  it("uses only backend-supported live workflow states", () => {
    expect(liveBotState(unavailableWatchState())).toBe("unavailable");
    expect(liveBotState({
      status_available: true,
      running: false,
      next_check_at: null,
    })).toBe("paused");
    expect(liveBotState({
      status_available: true,
      running: true,
      next_check_at: null,
    }, activityItem({ kind: "market_check" }))).toBe("checking");
    expect(liveBotState({
      status_available: true,
      running: true,
      next_check_at: "2026-07-23T15:15:00-04:00",
    }, activityItem({ kind: "signal" }))).toBe("waiting");
  });
});

describe("fail-closed trading controls", () => {
  it("requires both engine and watch readbacks before Start or Review", () => {
    expect(tradingControlGate(false, "paused", true)).toEqual({
      running: false,
      canPause: false,
      canStartOrReview: false,
    });
    expect(tradingControlGate(true, "paused", false).canStartOrReview).toBe(false);
    expect(tradingControlGate(true, "paused", true).canStartOrReview).toBe(true);
    expect(tradingControlGate(true, "paused", true, false).canStartOrReview).toBe(false);
  });

  it("keeps Pause available from authoritative engine state even when watch readback fails", () => {
    expect(tradingControlGate(true, "real", false)).toEqual({
      running: true,
      canPause: true,
      canStartOrReview: false,
    });
  });

  it("keeps Pause available when only the authoritative watch says running", () => {
    expect(tradingControlGate(true, "paused", true, true, true)).toEqual({
      running: true,
      canPause: true,
      canStartOrReview: false,
    });
    expect(tradingControlGate(false, "unavailable", true, false, true)).toEqual({
      running: true,
      canPause: true,
      canStartOrReview: false,
    });
  });

  it("requires both authoritative readbacks to report not running before Start", () => {
    expect(tradingControlGate(true, "paused", true, true, false).canStartOrReview).toBe(true);
    expect(tradingControlGate(true, "paused", true, true, null).canStartOrReview).toBe(false);
    expect(tradingControlGate(true, "practice", true, true, false).canStartOrReview).toBe(false);
  });

  it("requires connected funded Robinhood for Real but not Practice", () => {
    expect(realTradingAccountReadiness("available", true, false)).toMatchObject({
      ready: false,
      message: expect.stringContaining("buying power"),
    });
    expect(realTradingAccountReadiness("available", true, true).ready).toBe(true);
    expect(realTradingAccountReadiness("unavailable", true, true).ready).toBe(false);
    expect(tradingModeAccountReady("real", false)).toBe(false);
    expect(tradingModeAccountReady("practice", false)).toBe(true);
  });
});

describe("provider and lifecycle truth", () => {
  it("derives Polymarket readiness only from Polymarket US fields", () => {
    expect(polymarketUsAccountReadiness({
      authenticated: false,
      has_buying_power: false,
    })).toEqual({ connected: false, funded: false });
    expect(polymarketUsAccountReadiness({
      authenticated: true,
      has_buying_power: true,
    })).toEqual({ connected: true, funded: true });
  });

  it("never presents an unavailable license readback as definitively unactivated", () => {
    expect(licenseStatusPresentation("checking", { real_trading_ready: false })).toMatchObject({
      state: "checking",
      realTradingReady: false,
    });
    expect(licenseStatusPresentation("unavailable", { real_trading_ready: false })).toEqual({
      state: "unavailable",
      label: "Activation status unavailable",
      realTradingReady: false,
    });
    expect(licenseStatusPresentation("available", { real_trading_ready: false }).state).toBe("not-activated");
    expect(licenseStatusPresentation("available", { real_trading_ready: true }).realTradingReady).toBe(true);
  });

  it("distinguishes unavailable data from a ready empty result", () => {
    expect(dataLifecycleCopy("activity", "unavailable", false)).toMatchObject({
      title: "Recorded activity is unavailable",
      detail: expect.stringContaining("Do not treat this as an empty history"),
    });
    expect(dataLifecycleCopy("catalog", "unavailable", false)).toMatchObject({
      title: "Agent catalog is unavailable",
      detail: expect.stringContaining("Do not treat this as an empty catalog"),
    });
    expect(dataLifecycleCopy("activity", "ready", false).title).toBe("No recorded activity yet");
  });
});

describe("recorded decision truth", () => {
  it.each([
    ["practice_review", "Practice result", true],
    ["submitted", "Real order submitted", false],
    ["pending", "Real order pending", false],
    ["partially_filled", "Partial fill recorded", false],
    ["filled", "Fill recorded", true],
    ["canceled", "Order canceled", true],
    ["rejected", "Order rejected", true],
    ["unknown", "Order status unknown", false],
  ] as const)("maps authoritative %s state before the event kind", (recordedState, title, final) => {
    const item = activityItem({
      kind: "order_submitted",
      recorded_order_state: recordedState,
    });
    expect(decisionOutcome(item)?.title).toContain(title);
    expect(decisionHasFinalOutcome(item)).toBe(final);
  });

  it("does not mark a bare signal or unauthoritative submission event complete", () => {
    const signal = activityItem({ kind: "signal", recorded_order_state: null });
    expect(decisionOutcome(signal)).toBeNull();
    expect(decisionHasFinalOutcome(signal)).toBe(false);

    const submission = activityItem({ kind: "order_submitted", recorded_order_state: null });
    expect(decisionOutcome(submission)).toMatchObject({
      title: "Order submission event recorded",
      final: false,
    });
  });
});

describe("real-trading authorization copy", () => {
  it("states both the calendar-day cap and maximum possible 24-hour total", () => {
    expect(realTradingAuthorizationSummary(15, 3)).toEqual({
      dailyCap: "$15 per calendar day",
      maximumPossibleTotal: "$30 across the 24-hour window if it spans two calendar days",
      perTradeCap: "$3",
    });
  });
});

describe("grouped Practice and Real history", () => {
  const items = [
    activityItem({ id: "practice-today", mode: "practice" }),
    activityItem({
      id: "real-today",
      mode: "real",
      kind: "order_submitted",
      recorded_order_state: "submitted",
      occurred_at: "2026-07-23T14:00:00-04:00",
    }),
    activityItem({
      id: "practice-yesterday",
      mode: "practice",
      occurred_at: "2026-07-22T12:00:00-04:00",
    }),
  ];
  const now = new Date("2026-07-23T16:00:00-04:00");

  it("groups loaded events by day without merging Practice and Real counts", () => {
    const groups = groupActivityByDay(items, "all", now);
    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0]).toMatchObject({
      practiceCount: 1,
      realCount: 1,
      realOrderCount: 1,
    });
  });

  it("filters history without changing the original records", () => {
    const groups = groupActivityByDay(items, "practice", now);
    expect(groups.flatMap((group) => group.items).map((item) => item.id)).toEqual([
      "practice-today",
      "practice-yesterday",
    ]);
    expect(items).toHaveLength(3);
  });
});
