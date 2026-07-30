export type TradingRoomMode = "practice" | "real";

export type TradingRoomActivityKind =
  | "started"
  | "paused"
  | "market_check"
  | "signal"
  | "skipped"
  | "reviewed"
  | "order_submitted"
  | "filled"
  | "error";

export type TradingRoomOrderState =
  | "practice_review"
  | "submitted"
  | "pending"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "rejected"
  | "unknown"
  | null;

export type TradingRoomActivity = {
  id: string;
  agent_id: string;
  mode: TradingRoomMode;
  kind: TradingRoomActivityKind;
  recorded_order_state: TradingRoomOrderState;
  symbol: string | null;
  amount_usd: string | null;
  message: string;
  occurred_at: string;
};

export type TradingRoomStageId = "market" | "decision" | "limits" | "account";
export type TradingRoomTone = "working" | "complete" | "waiting" | "attention";

export type TradingRoomMessage = TradingRoomActivity & {
  stage: TradingRoomStageId;
  title: string;
  tone: TradingRoomTone;
  speaker: string;
  speakerRole: string;
};

export const tradingRoomStages = [
  {
    id: "market",
    name: "Market Scout",
    role: "Watches the market",
    job: "Checks eight supported stocks and funds for a possible setup.",
  },
  {
    id: "decision",
    name: "Bluechip",
    role: "Makes the decision",
    job: "Compares the available setups and explains what it chose.",
  },
  {
    id: "limits",
    name: "Limit Guide",
    role: "Applies your limits",
    job: "Checks the account and the exact dollar limits you selected.",
  },
  {
    id: "account",
    name: "Robinhood",
    role: "Reports order status",
    job: "Shows only what the connected account actually reports.",
  },
] as const;

export const tradingRoomWatchlist = [
  "AAPL",
  "NVDA",
  "TSLA",
  "SPY",
  "QQQ",
  "AMD",
  "MSFT",
  "GOOGL",
] as const;

function stageDetails(stage: TradingRoomStageId) {
  return tradingRoomStages.find((item) => item.id === stage) ?? tradingRoomStages[1];
}

export function tradingRoomStageForActivity(
  activity: Pick<TradingRoomActivity, "kind">,
): TradingRoomStageId {
  if (activity.kind === "market_check") return "market";
  if (activity.kind === "reviewed") return "limits";
  if (activity.kind === "order_submitted" || activity.kind === "filled") return "account";
  return "decision";
}

function orderStateTitle(state: TradingRoomOrderState) {
  if (state === "submitted") return "The connected account received the order";
  if (state === "pending") return "The order is waiting for an update";
  if (state === "partially_filled") return "Part of the order filled";
  if (state === "filled") return "The order filled";
  if (state === "canceled") return "The order was canceled";
  if (state === "rejected") return "The order was rejected";
  if (state === "unknown") return "The order needs a status check";
  return "The order step was recorded";
}

export function tradingRoomTitleForActivity(
  activity: Pick<TradingRoomActivity, "kind" | "recorded_order_state" | "symbol">,
) {
  const symbol = activity.symbol ?? "The market";
  if (activity.recorded_order_state === "practice_review") {
    return "Practice completed without sending an order";
  }
  if (activity.recorded_order_state) {
    return orderStateTitle(activity.recorded_order_state);
  }
  if (activity.kind === "started") return "The trading session started";
  if (activity.kind === "paused") return "New trading checks were paused";
  if (activity.kind === "market_check") return `${symbol} is being reviewed`;
  if (activity.kind === "signal") return `${symbol} matched Bluechip’s rules`;
  if (activity.kind === "skipped") return `${symbol} was passed over`;
  if (activity.kind === "reviewed") return "The limit check is complete";
  if (activity.kind === "order_submitted" || activity.kind === "filled") return "The account update was recorded";
  return "This step needs attention";
}

export function tradingRoomToneForActivity(
  activity: Pick<TradingRoomActivity, "kind" | "recorded_order_state">,
): TradingRoomTone {
  if (
    activity.kind === "error"
    || activity.recorded_order_state === "unknown"
    || activity.recorded_order_state === "rejected"
  ) return "attention";
  if (activity.recorded_order_state === "canceled") return "waiting";
  if (
    activity.kind === "market_check"
    || activity.kind === "signal"
    || activity.recorded_order_state === "submitted"
    || activity.recorded_order_state === "pending"
    || activity.recorded_order_state === "partially_filled"
  ) return "working";
  if (activity.kind === "paused" || activity.kind === "skipped") return "waiting";
  return "complete";
}

export function buildTradingRoomMessages(
  activity: TradingRoomActivity[],
  channel: "all" | string = "all",
  order: "newest" | "oldest" = "newest",
): TradingRoomMessage[] {
  return activity
    .filter((item) => {
      if (channel === "all") return true;
      if (channel.startsWith("stage:")) {
        return tradingRoomStageForActivity(item) === channel.slice("stage:".length);
      }
      if (channel.startsWith("symbol:")) {
        return item.symbol === channel.slice("symbol:".length);
      }
      return item.symbol === channel;
    })
    .slice()
    .sort((a, b) => {
      const difference = new Date(a.occurred_at).valueOf() - new Date(b.occurred_at).valueOf();
      return order === "oldest" ? difference : -difference;
    })
    .map((item) => {
      const stage = tradingRoomStageForActivity(item);
      const details = stageDetails(stage);
      return {
        ...item,
        stage,
        title: tradingRoomTitleForActivity(item),
        tone: tradingRoomToneForActivity(item),
        speaker: details.name,
        speakerRole: details.role,
      };
    });
}

export function tradingRoomSymbols(activity: TradingRoomActivity[]) {
  const latestBySymbol = new Map<string, number>();
  for (const item of activity) {
    if (!item.symbol) continue;
    const timestamp = new Date(item.occurred_at).valueOf();
    latestBySymbol.set(item.symbol, Math.max(timestamp, latestBySymbol.get(item.symbol) ?? 0));
  }
  return [...latestBySymbol.entries()]
    .sort(([, left], [, right]) => right - left)
    .map(([symbol]) => symbol);
}

type TradingRoomAnswerInput = {
  question: string;
  activity: TradingRoomActivity[];
  status: "unavailable" | "paused" | "practice" | "real";
  nextCheckLabel: string;
  dailyLimitLabel: string;
  perTradeLimitLabel: string;
  remainingLimitLabel?: string | null;
};

function latestActivity(
  activity: TradingRoomActivity[],
  symbol?: string,
) {
  return activity
    .filter((item) => !symbol || item.symbol === symbol)
    .slice()
    .sort((a, b) => new Date(b.occurred_at).valueOf() - new Date(a.occurred_at).valueOf())[0];
}

function latestDecisionActivity(
  activity: TradingRoomActivity[],
  symbol?: string,
  preferredKind?: TradingRoomActivityKind,
) {
  const decisionActivity = activity
    .filter((item) => (
      (!symbol || item.symbol === symbol)
      && (
        item.kind === "signal"
        || item.kind === "skipped"
        || item.kind === "reviewed"
        || item.kind === "error"
      )
    ))
    .slice()
    .sort((a, b) => new Date(b.occurred_at).valueOf() - new Date(a.occurred_at).valueOf());
  return (
    (preferredKind
      ? decisionActivity.find((item) => item.kind === preferredKind)
      : undefined)
    ?? decisionActivity[0]
  );
}

export function answerTradingRoomQuestion({
  question,
  activity,
  status,
  nextCheckLabel,
  dailyLimitLabel,
  perTradeLimitLabel,
  remainingLimitLabel,
}: TradingRoomAnswerInput) {
  const normalized = question.trim().toLowerCase();
  const symbol = tradingRoomWatchlist.find((item) => normalized.includes(item.toLowerCase()));

  if (normalized.includes("watch") || normalized.includes("scan") || normalized.includes("looking")) {
    return {
      speaker: "Market Scout",
      stage: "market" as const,
      message: `I watch ${tradingRoomWatchlist.join(", ")}. Bluechip compares any supported setups before choosing one.`,
    };
  }

  if (
    normalized.includes("limit")
    || normalized.includes("risk")
    || normalized.includes("spend")
    || normalized.includes("how much")
  ) {
    const remaining = remainingLimitLabel
      ? ` The app currently reports ${remainingLimitLabel} remaining for new trades today.`
      : "";
    return {
      speaker: "Limit Guide",
      stage: "limits" as const,
      message: `Your current ceiling is ${perTradeLimitLabel} for one trade and ${dailyLimitLabel} in new trades for the day.${remaining}`,
    };
  }

  if (normalized.includes("next") || normalized.includes("when")) {
    return {
      speaker: "Bluechip",
      stage: "decision" as const,
      message: status === "unavailable"
        ? "I cannot confirm the schedule because the current trading status is unavailable. Try loading the room again before relying on a next-check time."
        : status === "paused"
          ? "I am ready, but no new market checks start until you choose Practice or review Real Trading."
          : `I am following the current schedule. ${nextCheckLabel}.`,
    };
  }

  if (normalized.includes("order") || normalized.includes("trade") || normalized.includes("real")) {
    const latestOrder = activity
      .filter((item) => item.recorded_order_state !== null)
      .slice()
      .sort((a, b) => new Date(b.occurred_at).valueOf() - new Date(a.occurred_at).valueOf())[0];
    if (latestOrder) {
      return {
        speaker: latestOrder.mode === "practice" ? "Bluechip" : "Robinhood",
        stage: latestOrder.mode === "practice" ? "decision" as const : "account" as const,
        message: latestOrder.message,
      };
    }
    return {
      speaker: "Bluechip",
      stage: "decision" as const,
      message: status === "practice"
        ? "Practice is running, so decisions are recorded without sending a real order."
        : status === "real"
          ? "Real Trading is running, but there is no recorded order update in the room yet."
          : "There is no recorded order update yet. Asking a question here can never start a trade.",
    };
  }

  if (normalized.includes("why") || normalized.includes("skip")) {
    const preferredKind = normalized.includes("skip")
      ? "skipped" as const
      : normalized.includes("review")
        ? "reviewed" as const
        : undefined;
    const item = latestDecisionActivity(activity, symbol, preferredKind);
    if (item) {
      return {
        speaker: stageDetails(tradingRoomStageForActivity(item)).name,
        stage: tradingRoomStageForActivity(item),
        message: item.message,
      };
    }
    return {
      speaker: "Bluechip",
      stage: "decision" as const,
      message: symbol
        ? `There is no recorded ${symbol} decision in this room yet. I will show the reason after a decision is recorded.`
        : "Choose a stock from the room and I will explain its latest recorded decision.",
    };
  }

  if (symbol) {
    const item = latestActivity(activity, symbol);
    return {
      speaker: item ? stageDetails(tradingRoomStageForActivity(item)).name : "Bluechip",
      stage: item ? tradingRoomStageForActivity(item) : "decision" as const,
      message: item
        ? item.message
        : `There is no recorded ${symbol} update in this room yet.`,
    };
  }

  const latest = latestActivity(activity);
  return {
    speaker: "Bluechip",
    stage: "decision" as const,
    message: latest
      ? `The latest recorded update says: ${latest.message}`
      : "I can explain recorded market checks, limits, timing, and order updates. Try asking what I am watching or how much can be traded.",
  };
}
