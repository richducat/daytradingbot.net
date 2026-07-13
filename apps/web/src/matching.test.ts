import { describe, expect, it } from "vitest";
import { recommendAgent, type MatchAnswers } from "./matching";

const base: MatchAnswers = {
  goal: "learn",
  market: "stocks",
  approach: "pullbacks",
  account: "robinhood_agentic",
  experience: "new",
  reviewFrequency: "daily",
  dailyBudget: "25",
  startPreference: "practice",
};

describe("recommendAgent", () => {
  it("still makes a recommendation when someone wants short-term opportunities", () => {
    const result = recommendAgent({ ...base, goal: "fast_returns" });
    expect(result.status).toBe("available");
    expect(result.agent).toBe("Bluechip");
    expect(result.realTradingCaution).toContain("faster losses");
  });

  it("matches a new stock trader to Bluechip with a smaller starting plan", () => {
    const result = recommendAgent(base);
    expect(result.status).toBe("available");
    expect(result.agent).toBe("Bluechip");
    expect(result.recommendedMode).toBe("Practice");
    expect(result.dailyLimit).toBe(5);
    expect(result.perTradeLimit).toBe(1);
    expect(result.needsAccountSetup).toBe(false);
  });

  it("explains when the matched customer still needs the correct account", () => {
    const result = recommendAgent({ ...base, account: "robinhood" });
    expect(result.agent).toBe("Bluechip");
    expect(result.needsAccountSetup).toBe(true);
    expect(result.accountNeeded).toBe("Robinhood Agentic");
  });

  it("does not sell a crypto agent that is not packaged", () => {
    const result = recommendAgent({
      ...base,
      market: "crypto",
      approach: "momentum",
      account: "coinbase",
      experience: "active",
    });
    expect(result.status).toBe("coming_soon");
    expect(result.agent).toBe("Sprinter");
  });

  it("routes a Kalshi public-data trader to Barometer", () => {
    const result = recommendAgent({
      ...base,
      market: "events",
      approach: "public_data",
      account: "kalshi",
    });
    expect(result.status).toBe("coming_soon");
    expect(result.agent).toBe("Barometer");
  });

  it("suggests Practice to infrequent reviewers without blocking their choice", () => {
    const result = recommendAgent({ ...base, experience: "active", reviewFrequency: "rarely", startPreference: "real_now" });
    expect(result.recommendedMode).toBe("Practice");
    expect(result.realTradingCaution).toContain("suggest staying in Practice");
    expect(result.realTradingCaution).toContain("final choice is yours");
  });
});
