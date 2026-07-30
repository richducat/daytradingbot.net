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
};

export const tradingRoomStages = [
  {
    id: "market",
    name: "Market check",
    job: "Bluechip checks its supported stocks for a possible setup.",
  },
  {
    id: "decision",
    name: "Strategy decision",
    job: "Bluechip records whether the setup matches its rule.",
  },
  {
    id: "limits",
    name: "Limit Check",
    job: "The app checks the account and the dollar limits you chose.",
  },
  {
    id: "account",
    name: "Account update",
    job: "The app records exactly what the connected account reports.",
  },
] as const;

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
): TradingRoomMessage[] {
  return activity
    .filter((item) => channel === "all" || item.symbol === channel)
    .slice()
    .sort((a, b) => new Date(b.occurred_at).valueOf() - new Date(a.occurred_at).valueOf())
    .map((item) => ({
      ...item,
      stage: tradingRoomStageForActivity(item),
      title: tradingRoomTitleForActivity(item),
      tone: tradingRoomToneForActivity(item),
    }));
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
