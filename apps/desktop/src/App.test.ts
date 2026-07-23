import { describe, expect, it } from "vitest";

import { limitPlanCopy, normalizeTradingLimits, setupRiskCopy } from "./App";

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
