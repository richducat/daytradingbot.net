import { describe, expect, it } from "vitest";

import {
  limitPlanCopy,
  normalizeTradingLimits,
  setupRiskCopy,
  tradingViewChartUrl,
  tradingViewSymbolUrl,
  unavailableWatchState,
  watchDisplayMode,
  watchSymbols,
} from "./App";

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
        support_host: string;
      };
      expect(config.symbol).toMatch(/^(NASDAQ|AMEX):[A-Z]+$/);
      expect(config.interval).toBe("5");
      expect(config.allow_symbol_change).toBe(false);
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
