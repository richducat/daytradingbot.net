import { describe, expect, it } from "vitest";
import {
  answerTradingRoomQuestion,
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

  it("supports explicit stage and symbol channels", () => {
    expect(buildTradingRoomMessages(items, "stage:market").map((item) => item.id))
      .toEqual(["new-qqq", "new-aapl", "old-aapl"]);
    expect(buildTradingRoomMessages(items, "symbol:AAPL").map((item) => item.id))
      .toEqual(["new-aapl", "old-aapl"]);
  });

  it("can render the recorded conversation from oldest to newest", () => {
    expect(buildTradingRoomMessages(items, "all", "oldest").map((item) => item.id))
      .toEqual(["old-aapl", "new-aapl", "new-qqq"]);
  });

  it("assigns each recorded stage to its visible speaker", () => {
    const speakers = buildTradingRoomMessages([
      activity({ id: "market", kind: "market_check" }),
      activity({ id: "decision", kind: "signal" }),
      activity({ id: "limits", kind: "reviewed" }),
      activity({ id: "account", kind: "order_submitted", recorded_order_state: "submitted" }),
    ], "all", "oldest").map((item) => item.speaker);
    expect(speakers).toEqual(["Market Scout", "Bluechip", "Limit Guide", "Robinhood"]);
  });

  it("orders room channels by their most recent recorded activity", () => {
    expect(tradingRoomSymbols(items)).toEqual(["QQQ", "AAPL"]);
  });
});

describe("Trading Room questions", () => {
  const input = {
    activity: [
      activity({
        id: "review-qqq",
        kind: "reviewed" as const,
        recorded_order_state: "practice_review" as const,
        symbol: "QQQ",
        amount_usd: "20.00",
        message: "Practice reviewed QQQ and sent no real order.",
      }),
    ],
    status: "practice" as const,
    nextCheckLabel: "Next check at 10:15 AM",
    dailyLimitLabel: "$100",
    perTradeLimitLabel: "$20",
    remainingLimitLabel: "$80",
  };

  it("explains the selected customer limits", () => {
    expect(answerTradingRoomQuestion({
      ...input,
      question: "How much can be traded?",
    })).toEqual({
      speaker: "Limit Guide",
      stage: "limits",
      message: "Your current ceiling is $20 for one trade and $100 in new trades for the day. The app currently reports $80 remaining for new trades today.",
    });
  });

  it("answers from the latest recorded order without inventing a live order", () => {
    expect(answerTradingRoomQuestion({
      ...input,
      question: "Did you place a real trade?",
    })).toEqual({
      speaker: "Bluechip",
      stage: "decision",
      message: "Practice reviewed QQQ and sent no real order.",
    });
  });

  it("explains a stock from its latest recorded message", () => {
    expect(answerTradingRoomQuestion({
      ...input,
      question: "Why did you review QQQ?",
    })).toEqual({
      speaker: "Limit Guide",
      stage: "limits",
      message: "Practice reviewed QQQ and sent no real order.",
    });
  });

  it("does not claim a schedule when live status is unavailable", () => {
    expect(answerTradingRoomQuestion({
      ...input,
      status: "unavailable",
      question: "When is the next check?",
    })).toEqual({
      speaker: "Bluechip",
      stage: "decision",
      message: "I cannot confirm the schedule because the current trading status is unavailable. Try loading the room again before relying on a next-check time.",
    });
  });

  it("answers why from the latest recorded decision instead of a later market update", () => {
    expect(answerTradingRoomQuestion({
      ...input,
      activity: [
        activity({
          id: "decision-qqq",
          kind: "skipped",
          symbol: "QQQ",
          message: "QQQ was skipped because the setup no longer matched.",
          occurred_at: "2026-07-29T10:00:00-04:00",
        }),
        activity({
          id: "later-scan-qqq",
          kind: "market_check",
          symbol: "QQQ",
          message: "QQQ was checked again.",
          occurred_at: "2026-07-29T10:05:00-04:00",
        }),
      ],
      question: "Why did you skip QQQ?",
    })).toEqual({
      speaker: "Bluechip",
      stage: "decision",
      message: "QQQ was skipped because the setup no longer matched.",
    });
  });

  it("answers a skip question from the skip event even after a later decision", () => {
    expect(answerTradingRoomQuestion({
      ...input,
      activity: [
        activity({
          id: "skip-qqq",
          kind: "skipped",
          symbol: "QQQ",
          message: "QQQ was skipped because the price moved outside the setup.",
          occurred_at: "2026-07-29T10:00:00-04:00",
        }),
        activity({
          id: "later-review-qqq",
          kind: "reviewed",
          symbol: "QQQ",
          message: "QQQ passed a later limit review.",
          occurred_at: "2026-07-29T10:10:00-04:00",
        }),
      ],
      question: "Why did you skip QQQ?",
    })).toEqual({
      speaker: "Bluechip",
      stage: "decision",
      message: "QQQ was skipped because the price moved outside the setup.",
    });
  });
});
