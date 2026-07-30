import { describe, expect, it } from "vitest";
import {
  buildTradingRoomMessages,
  type TradingRoomActivity,
  tradingRoomStageForActivity,
  tradingRoomSymbols,
  tradingRoomTitleForActivity,
  tradingRoomToneForActivity,
} from "./tradingRoomModel";

function activity(overrides: Partial<TradingRoomActivity> = {}): TradingRoomActivity {
  return {
    id: "event-1",
    agent_id: "bluechip",
    mode: "practice",
    kind: "market_check",
    recorded_order_state: null,
    symbol: "AAPL",
    amount_usd: null,
    message: "Bluechip checked AAPL.",
    occurred_at: "2026-07-29T10:00:00-04:00",
    ...overrides,
  };
}

describe("Trading Room recorded stages", () => {
  it.each([
    ["market_check", "market"],
    ["signal", "decision"],
    ["skipped", "decision"],
    ["reviewed", "limits"],
    ["order_submitted", "account"],
    ["filled", "account"],
    ["error", "decision"],
  ] as const)("labels %s from its recorded kind without parsing message text", (kind, stage) => {
    expect(tradingRoomStageForActivity(activity({ kind }))).toBe(stage);
  });

  it("does not invent a limit-check owner from customer-facing message text", () => {
    const item = activity({
      kind: "skipped",
      message: "The daily limit did not leave enough room for this trade.",
    });
    const [message] = buildTradingRoomMessages([item]);
    expect(message.stage).toBe("decision");
    expect(message.message).toBe(item.message);
  });

  it("marks recorded errors for attention without inventing an order manager", () => {
    const item = activity({
      kind: "error",
      message: "The order status could not be reconciled.",
    });
    expect(tradingRoomStageForActivity(item)).toBe("decision");
    expect(tradingRoomToneForActivity(item)).toBe("attention");
  });
});

describe("Trading Room customer language", () => {
  it.each([
    ["practice_review", "Practice completed without sending an order"],
    ["submitted", "The connected account received the order"],
    ["pending", "The order is waiting for an update"],
    ["partially_filled", "Part of the order filled"],
    ["filled", "The order filled"],
    ["canceled", "The order was canceled"],
    ["rejected", "The order was rejected"],
    ["unknown", "The order needs a status check"],
  ] as const)("explains authoritative %s state without overclaiming", (state, title) => {
    expect(tradingRoomTitleForActivity(activity({
      kind: "order_submitted",
      recorded_order_state: state,
    }))).toBe(title);
  });

  it.each([
    ["canceled", "The order was canceled", "waiting"],
    ["rejected", "The order was rejected", "attention"],
  ] as const)("uses authoritative %s state before a skipped event kind", (state, title, tone) => {
    const item = activity({
      kind: "skipped",
      recorded_order_state: state,
    });
    expect(tradingRoomTitleForActivity(item)).toBe(title);
    expect(tradingRoomToneForActivity(item)).toBe(tone);
  });

  it("uses the recorded symbol in market and signal handoffs", () => {
    expect(tradingRoomTitleForActivity(activity({ symbol: "QQQ" }))).toBe("QQQ is being reviewed");
    expect(tradingRoomTitleForActivity(activity({ kind: "signal", symbol: "QQQ" })))
      .toBe("QQQ matched Bluechip’s rules");
  });
});

describe("Trading Room ordering and channels", () => {
  const items = [
    activity({ id: "old-aapl", symbol: "AAPL", occurred_at: "2026-07-29T09:00:00-04:00" }),
    activity({ id: "new-qqq", symbol: "QQQ", occurred_at: "2026-07-29T11:00:00-04:00" }),
    activity({ id: "new-aapl", symbol: "AAPL", occurred_at: "2026-07-29T10:30:00-04:00" }),
  ];

  it("shows the newest recorded handoff first without mutating the ledger response", () => {
    const originalOrder = items.map((item) => item.id);
    expect(buildTradingRoomMessages(items).map((item) => item.id))
      .toEqual(["new-qqq", "new-aapl", "old-aapl"]);
    expect(items.map((item) => item.id)).toEqual(originalOrder);
  });

  it("filters a symbol channel exactly", () => {
    expect(buildTradingRoomMessages(items, "AAPL").map((item) => item.id))
      .toEqual(["new-aapl", "old-aapl"]);
  });

  it("orders room channels by their most recent recorded activity", () => {
    expect(tradingRoomSymbols(items)).toEqual(["QQQ", "AAPL"]);
  });
});
