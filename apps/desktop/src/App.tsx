import { invoke } from "@tauri-apps/api/core";
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowsSort,
  IconCalendar,
  IconChartCandle,
  IconCheck,
  IconChevronRight,
  IconCircleCheck,
  IconCircleDot,
  IconClock,
  IconCoin,
  IconEye,
  IconHistory,
  IconInfoCircle,
  IconLoader2,
  IconLock,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconRobot,
  IconSearch,
  IconSettings,
  IconShieldCheck,
  IconSparkles,
  IconTag,
  IconWallet,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import dtbBrandMark from "./assets/dtb-brand-mark-512.png";

type View = "watch" | "agents" | "accounts" | "activity";
type TradingMode = "practice" | "real";
type ActivityFilter = "all" | TradingMode;
type ConnectionReadback = "checking" | "available" | "unavailable";
export type DataLifecycle = "loading" | "ready" | "unavailable";
export type LicenseReadback = "checking" | "available" | "unavailable";
type AccountName = "Robinhood" | "Coinbase" | "Kalshi" | "Polymarket";
type CredentialAccount = Exclude<AccountName, "Robinhood">;

type Agent = {
  id: string;
  name: string;
  account: "Robinhood" | "Coinbase" | "Kalshi" | "Polymarket" | string;
  market: string;
  summary: string;
  cadence_minutes: number;
  risk_level: "steady" | "balanced" | "active";
  practice_available: boolean;
  real_trading_available: boolean;
  customer_ready: boolean;
  auto_pick_rank: number;
  engine: { kind: string; legacy_label: string; entrypoint: string };
};

type AgentCatalog = { version: number; agents: Agent[] };

type OwnerEngineStatus = {
  available: boolean;
  mode: "not_installed" | "unavailable" | "paused" | TradingMode;
  selected_agent_ids: string[];
  loaded_agent_ids: string[];
  message: string;
};

type RobinhoodStatus = {
  owner_import_available: boolean;
  configured: boolean;
  authenticated: boolean;
  agentic_account_available: boolean;
  has_buying_power: boolean;
  connection_state: string;
};

type SimmerStatus = {
  owner_import_available: boolean;
  configured: boolean;
  authenticated: boolean;
  wallet_configured: boolean;
  direct_api_configured: boolean;
  has_spendable_balance: boolean;
  connection_state: string;
};

type CoinbaseStatus = {
  configured: boolean;
  authenticated: boolean;
  least_privilege_live_scope: boolean;
  has_btc_or_eth_account: boolean;
  connection_state: string;
};

type PolymarketStatus = {
  configured: boolean;
  authenticated: boolean;
  approved_account_verified: boolean;
  has_buying_power: boolean;
  market_data_available: boolean;
  connection_state: string;
};

type SessionResult = {
  mode: "paused" | TradingMode;
  selected_agent_ids: string[];
  message: string;
};

export type ActivityItem = {
  id: string;
  agent_id: string;
  mode: TradingMode;
  kind: "started" | "paused" | "market_check" | "signal" | "skipped" | "reviewed" | "order_submitted" | "filled" | "error";
  recorded_order_state: "practice_review" | "submitted" | "pending" | "partially_filled" | "filled" | "canceled" | "rejected" | "unknown" | null;
  symbol: string | null;
  amount_usd: string | null;
  message: string;
  occurred_at: string;
};

type BluechipWatchState = {
  status_available: boolean;
  running: boolean | null;
  mode: "unavailable" | "paused" | TradingMode;
  message: string;
  last_checked_at: string | null;
  next_check_at: string | null;
  budget_state: "paused" | "practice" | "available" | "unavailable";
  daily_limit_usd: string | null;
  per_trade_limit_usd: string | null;
  used_or_held_usd: string | null;
  pending_usd: string | null;
  committed_usd: string | null;
  remaining_usd: string | null;
  has_unresolved_real_order: boolean | null;
};

type NativeBluechipWatchState = Omit<
  BluechipWatchState,
  "status_available" | "running" | "mode" | "has_unresolved_real_order"
> & {
  running: boolean;
  mode: "paused" | TradingMode;
  has_unresolved_real_order: boolean;
};

type LicenseStatus = {
  activated: boolean;
  real_trading_ready: boolean;
  renewal_needed: boolean;
  expires_at: string | null;
  message: string;
};

const emptyRobinhood: RobinhoodStatus = {
  owner_import_available: false,
  configured: false,
  authenticated: false,
  agentic_account_available: false,
  has_buying_power: false,
  connection_state: "not_configured",
};

const emptySimmer: SimmerStatus = {
  owner_import_available: false,
  configured: false,
  authenticated: false,
  wallet_configured: false,
  direct_api_configured: false,
  has_spendable_balance: false,
  connection_state: "not_configured",
};

const emptyCoinbase: CoinbaseStatus = {
  configured: false,
  authenticated: false,
  least_privilege_live_scope: false,
  has_btc_or_eth_account: false,
  connection_state: "not_configured",
};

const emptyPolymarket: PolymarketStatus = {
  configured: false,
  authenticated: false,
  approved_account_verified: false,
  has_buying_power: false,
  market_data_available: false,
  connection_state: "public_data_ready",
};

const emptyEngine: OwnerEngineStatus = {
  available: false,
  mode: "not_installed",
  selected_agent_ids: [],
  loaded_agent_ids: [],
  message: "Checking the trading engine…",
};

export function unavailableWatchState(previous?: BluechipWatchState): BluechipWatchState {
  return {
    status_available: false,
    running: null,
    mode: "unavailable",
    message: "The app couldn’t confirm Bluechip’s status. Do not assume trading is paused.",
    last_checked_at: previous?.last_checked_at ?? null,
    next_check_at: null,
    budget_state: "unavailable",
    daily_limit_usd: null,
    per_trade_limit_usd: null,
    used_or_held_usd: null,
    pending_usd: null,
    committed_usd: null,
    remaining_usd: null,
    has_unresolved_real_order: null,
  };
}

export function watchDisplayMode(
  watch: Pick<BluechipWatchState, "status_available" | "running" | "mode">,
) {
  if (!watch.status_available) return "unavailable" as const;
  return watch.running ? watch.mode : "paused" as const;
}

function availableWatchState(snapshot: NativeBluechipWatchState): BluechipWatchState {
  return { ...snapshot, status_available: true };
}

const emptyWatch = unavailableWatchState();

const emptyLicense: LicenseStatus = {
  activated: false,
  real_trading_ready: false,
  renewal_needed: false,
  expires_at: null,
  message: "Activate the app before using real money.",
};

const connectionCheckTimeoutMs = 16_000;
const dailyLimitMinimum = 1;
const dailyLimitMaximum = 1_000_000;
const perTradeMinimum = 1;
const perTradeMaximum = 1_000_000;
export const watchSymbols = ["AAPL", "NVDA", "TSLA", "SPY", "QQQ", "AMD", "MSFT", "GOOGL"] as const;
export type WatchSymbol = (typeof watchSymbols)[number];
const tradingViewSymbols: Record<WatchSymbol, string> = {
  AAPL: "NASDAQ:AAPL",
  NVDA: "NASDAQ:NVDA",
  TSLA: "NASDAQ:TSLA",
  SPY: "AMEX:SPY",
  QQQ: "NASDAQ:QQQ",
  AMD: "NASDAQ:AMD",
  MSFT: "NASDAQ:MSFT",
  GOOGL: "NASDAQ:GOOGL",
};
const tradingViewWidgetOrigin = "https://www.tradingview-widget.com";

function isWatchSymbol(value: string | null): value is WatchSymbol {
  return value !== null && (watchSymbols as readonly string[]).includes(value);
}

export function tradingViewChartUrl(symbol: string): string | null {
  if (!isWatchSymbol(symbol)) return null;
  const url = new URL("/embed-widget/advanced-chart/", tradingViewWidgetOrigin);
  url.searchParams.set("locale", "en");
  url.hash = encodeURIComponent(JSON.stringify({
    autosize: true,
    symbol: tradingViewSymbols[symbol],
    interval: "5",
    timezone: "exchange",
    theme: "dark",
    style: "1",
    locale: "en",
    backgroundColor: "rgba(13, 15, 13, 1)",
    gridColor: "rgba(43, 48, 40, 0.45)",
    hide_side_toolbar: true,
    hide_top_toolbar: true,
    hide_legend: false,
    hide_volume: false,
    allow_symbol_change: false,
    save_image: false,
    calendar: false,
    withdateranges: true,
    support_host: "https://www.tradingview.com",
  }));
  return url.toString();
}

export function tradingViewSymbolUrl(symbol: string): string | null {
  if (!isWatchSymbol(symbol)) return null;
  return `https://www.tradingview.com/symbols/${tradingViewSymbols[symbol].replace(":", "-")}/`;
}

export type TradingLimits = {
  dailyBudget: number;
  perTrade: number;
};

function boundedWholeDollars(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

export function normalizeTradingLimits(dailyInput: unknown, perTradeInput: unknown): TradingLimits {
  const dailyBudget = boundedWholeDollars(
    dailyInput,
    dailyLimitMinimum,
    dailyLimitMaximum,
    15,
  );
  const perTrade = boundedWholeDollars(
    perTradeInput,
    perTradeMinimum,
    Math.min(perTradeMaximum, dailyBudget),
    Math.min(3, dailyBudget),
  );
  return { dailyBudget, perTrade };
}

function storedTradingLimits(): TradingLimits {
  try {
    return normalizeTradingLimits(
      localStorage.getItem("dtb.dailyBudget") ?? 15,
      localStorage.getItem("dtb.perTrade") ?? 3,
    );
  } catch {
    return normalizeTradingLimits(15, 3);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("CONNECTION_CHECK_TIMED_OUT")), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const errorCopy: Record<string, string> = {
  REAL_TRADING_LICENSE_REQUIRED: "Finish activating this copy of DayTradingBot before starting real trading.",
  REAL_TRADING_ONE_AGENT_AT_A_TIME: "Start real trading with one agent at a time for now.",
  BLUECHIP_RUNS_BY_ITSELF_FOR_NOW: "Bluechip runs by itself for now. Pause, select only Bluechip, and start again.",
  ROBINHOOD_ACCOUNT_NOT_CONNECTED: "Connect Robinhood before starting Bluechip.",
  ROBINHOOD_AGENTIC_ACCOUNT_REQUIRED: "Robinhood needs one dedicated Agentic account for Bluechip.",
  ROBINHOOD_AUTHENTICATION_EXPIRED: "Reconnect Robinhood so Bluechip can continue.",
  ROBINHOOD_CONNECTION_TIMED_OUT: "Robinhood took too long to respond. Nothing was turned on. Check the connection and try again.",
  ADD_FUNDS_TO_ROBINHOOD: "Robinhood needs at least $1 of available buying power. Add money or free up buying power, then try again.",
  DAILY_BUDGET_MUST_BE_POSITIVE: "Choose a positive whole-dollar daily limit in Setup.",
  TRADE_LIMIT_MUST_BE_POSITIVE_AND_NOT_EXCEED_DAILY: "Choose a positive whole-dollar amount per trade that does not exceed your daily limit.",
  TRADING_LIMITS_INVALID: "Your saved limits were adjusted to the supported range. Review them in Setup, then try again.",
  TRADING_LIMITS_UNAVAILABLE: "Bluechip could not read your saved limits. Open Setup, choose them again, then restart.",
  ORDER_RECONCILIATION_REQUIRED: "One earlier Robinhood order needs to be checked before real trading can continue.",
  SIMMER_ACCOUNT_NOT_CONNECTED: "Connect your Polymarket or Kalshi trading wallet before starting this agent.",
  AGENT_INSTALLATION_INCOMPLETE: "One selected trading agent is not installed yet.",
  TRADING_AGENT_INSTALLATION_INCOMPLETE: "One selected trading agent is not installed in this build yet.",
  REAL_TRADING_CONFIRMATION_REQUIRED: "Please confirm the real-trading summary before starting.",
  ENGINE_ACTION_FAILED: "The trading engine could not start that agent. Nothing was turned on.",
  AGENT_NOT_AVAILABLE_IN_THIS_BUILD: "That agent is coming next and is not available in this app yet.",
  OWNER_ENGINE_NOT_INSTALLED: "The trading engine is not installed on this computer yet.",
  PURCHASE_CODE_NOT_RECOGNIZED: "That access code was not recognized. Check the code and try again.",
  PURCHASE_CODE_ACTIVE_ELSEWHERE: "That purchase is already active on another computer.",
  LICENSE_ACTIVATION_UNAVAILABLE: "App activation is temporarily unavailable. Practice still works.",
  LICENSE_ACTIVATION_INVALID: "The activation response could not be verified. Real trading stayed off.",
  LICENSE_STORAGE_UNAVAILABLE: "This computer’s secure storage is unavailable. Real trading stayed off.",
  ACCOUNT_VAULT_UNAVAILABLE: "Mac Keychain did not allow access to that saved account. Nothing was changed.",
  ROBINHOOD_OWNER_VAULT_UNAVAILABLE: "Mac Keychain did not allow access to the saved Robinhood connection. Nothing was changed.",
  ROBINHOOD_OWNER_AUTHENTICATION_EXPIRED: "Your saved Robinhood sign-in has expired. Connect Robinhood again.",
  ROBINHOOD_OWNER_IMPORT_INSECURE: "The saved Robinhood connection could not be imported safely. Connect Robinhood again.",
  COINBASE_OWNER_VAULT_UNAVAILABLE: "Mac Keychain did not allow access to the saved Coinbase connection. Nothing was changed.",
  OWNER_DEMO_VAULT_UNAVAILABLE: "Mac Keychain did not allow access to the saved Kalshi connection. Nothing was changed.",
  POLYMARKET_US_OWNER_VAULT_UNAVAILABLE: "Mac Keychain did not allow access to the saved Polymarket connection. Nothing was changed.",
  KALSHI_AUTHENTICATION_FAILED: "Kalshi did not accept that key. Create a new trading API key and try again.",
  KALSHI_PERMISSION_DENIED: "That Kalshi key cannot view this account.",
  KALSHI_RATE_LIMITED: "Kalshi is receiving too many requests. Wait a moment and check again.",
  KALSHI_CONNECTION_FAILED: "Kalshi could not verify that connection. Nothing was saved.",
};

function messageFromError(error: unknown) {
  const key = errorKey(error);
  return errorCopy[key] ?? "That did not work. Nothing was turned on. Try again or check Accounts.";
}

function errorKey(error: unknown) {
  return String(error).replace(/^Error:\s*/, "");
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

export function limitPlanCopy(dailyInput: unknown, perTradeInput: unknown) {
  const { dailyBudget, perTrade } = normalizeTradingLimits(dailyInput, perTradeInput);
  const remainder = dailyBudget % perTrade;
  if (remainder > 0) {
    return `Bluechip uses up to ${money(perTrade)} per trade. If ${money(remainder)} remains near your daily limit, it can make one smaller trade instead of stopping.`;
  }
  return `Bluechip uses up to ${money(perTrade)} per trade and automatically stops before it goes over your ${money(dailyBudget)} daily limit.`;
}

export const setupRiskCopy = "Your daily limit is a maximum, not a promise to spend it all. Before every trade, Bluechip checks its signal, the market, your Robinhood account, and your remaining limit. If a check stops a trade, the app explains why. Every trade can lose its full value.";

export function realTradingAuthorizationSummary(dailyInput: unknown, perTradeInput: unknown) {
  const { dailyBudget, perTrade } = normalizeTradingLimits(dailyInput, perTradeInput);
  return {
    dailyCap: `${money(dailyBudget)} per calendar day`,
    maximumPossibleTotal: `${money(dailyBudget * 2)} across the 24-hour window if it spans two calendar days`,
    perTradeCap: money(perTrade),
  };
}

export function dataLifecycleCopy(
  resource: "activity" | "catalog",
  state: DataLifecycle,
  hasLoadedData: boolean,
) {
  if (state === "loading") {
    return resource === "activity"
      ? { title: "Loading recorded activity", detail: "Practice and Real records will appear when the local history is ready." }
      : { title: "Checking available agents", detail: "Your agent list will appear when the local catalog is ready." };
  }
  if (state === "unavailable") {
    return resource === "activity"
      ? {
        title: "Recorded activity is unavailable",
        detail: hasLoadedData
          ? "The latest refresh failed. Earlier loaded records remain visible below."
          : "The app could not load recorded activity. Do not treat this as an empty history.",
      }
      : {
        title: "Agent catalog is unavailable",
        detail: hasLoadedData
          ? "The latest refresh failed. Earlier loaded agents remain visible below."
          : "The app could not load the local agent catalog. Do not treat this as an empty catalog.",
      };
  }
  return resource === "activity"
    ? { title: "No recorded activity yet", detail: "Practice and Real records will appear after the first recorded event." }
    : { title: "No available agents", detail: "The loaded catalog does not contain a customer-ready agent." };
}

function activityTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Recent";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

function watchTime(value: string | null, fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return fallback;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function eventLabel(item: ActivityItem) {
  if (item.kind === "signal") return "Signal recorded";
  if (item.recorded_order_state === "practice_review") return "Practice review";
  if (item.recorded_order_state === "partially_filled") return "Partially filled · recorded";
  if (item.recorded_order_state === "filled") return "Fill · recorded";
  if (item.recorded_order_state === "canceled") return "Canceled · recorded";
  if (item.recorded_order_state === "rejected") return "Rejected · recorded";
  if (item.recorded_order_state === "unknown") return "Status unknown · recorded";
  if (item.recorded_order_state === "pending") return "Pending · recorded";
  if (item.recorded_order_state === "submitted") return "Submitted · recorded";
  if (item.kind === "skipped") return "No trade";
  if (item.kind === "error") return "Needs attention";
  if (item.kind === "market_check") return "Market check";
  if (item.kind === "started") return "Started";
  if (item.kind === "paused") return "Paused";
  return "Decision";
}

export type ActivityDayGroup = {
  key: string;
  label: string;
  items: ActivityItem[];
  practiceCount: number;
  realCount: number;
  realOrderCount: number;
};

function localDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayLabel(value: Date, now: Date) {
  const today = localDateKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const key = localDateKey(value);
  if (key === today) return "Today";
  if (key === localDateKey(yesterdayDate)) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: value.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(value);
}

export function groupActivityByDay(
  items: ActivityItem[],
  filter: ActivityFilter,
  now = new Date(),
): ActivityDayGroup[] {
  const groups = new Map<string, { date: Date; items: ActivityItem[] }>();
  items
    .filter((item) => filter === "all" || item.mode === filter)
    .slice()
    .sort((a, b) => new Date(b.occurred_at).valueOf() - new Date(a.occurred_at).valueOf())
    .forEach((item) => {
      const date = new Date(item.occurred_at);
      if (Number.isNaN(date.valueOf())) return;
      const key = localDateKey(date);
      const group = groups.get(key) ?? { date, items: [] };
      group.items.push(item);
      groups.set(key, group);
    });

  return Array.from(groups.entries()).map(([key, group]) => ({
    key,
    label: dayLabel(group.date, now),
    items: group.items,
    practiceCount: group.items.filter((item) => item.mode === "practice").length,
    realCount: group.items.filter((item) => item.mode === "real").length,
    realOrderCount: group.items.filter((item) => (
      item.mode === "real"
      && (item.kind === "order_submitted" || item.recorded_order_state === "submitted")
    )).length,
  }));
}

export type LiveBotState = "checking" | "waiting" | "paused" | "unavailable";

export function connectionStatusLabel(readback: ConnectionReadback, connected: boolean) {
  if (readback === "checking") return "Checking saved connection…";
  if (readback === "unavailable") return "Connection status unavailable";
  return connected ? "Connection verified" : "Not connected";
}

export function polymarketUsAccountReadiness(
  status: Pick<PolymarketStatus, "authenticated" | "has_buying_power">,
) {
  return {
    connected: status.authenticated,
    funded: status.has_buying_power,
  };
}

export function tradingControlGate(
  engineReadbackAvailable: boolean,
  engineMode: OwnerEngineStatus["mode"],
  watchStatusAvailable: boolean,
  engineAvailable = true,
  watchRunning: boolean | null = false,
) {
  const engineRunning = engineReadbackAvailable
    && (engineMode === "practice" || engineMode === "real");
  const watchIsRunning = watchStatusAvailable && watchRunning === true;
  const running = engineRunning || watchIsRunning;
  return {
    running,
    canPause: running,
    canStartOrReview: engineReadbackAvailable
      && engineAvailable
      && watchStatusAvailable
      && !engineRunning
      && watchRunning === false,
  };
}

export function realTradingAccountReadiness(
  readback: ConnectionReadback,
  connected: boolean,
  funded: boolean,
) {
  if (readback === "checking") {
    return { ready: false, message: "Checking Robinhood before Real Trading can be reviewed." };
  }
  if (readback === "unavailable") {
    return { ready: false, message: "Robinhood status is unavailable. Real Trading stays off." };
  }
  if (!connected) {
    return { ready: false, message: "Connect Robinhood before reviewing Real Trading." };
  }
  if (!funded) {
    return { ready: false, message: "Robinhood needs available buying power before reviewing Real Trading." };
  }
  return { ready: true, message: "Robinhood connection and available buying power are verified." };
}

export function tradingModeAccountReady(mode: TradingMode, realAccountReady: boolean) {
  return mode === "practice" || realAccountReady;
}

export function licenseStatusPresentation(
  readback: LicenseReadback,
  status: Pick<LicenseStatus, "real_trading_ready">,
) {
  if (readback === "checking") {
    return {
      state: "checking" as const,
      label: "Checking activation…",
      realTradingReady: false,
    };
  }
  if (readback === "unavailable") {
    return {
      state: "unavailable" as const,
      label: "Activation status unavailable",
      realTradingReady: false,
    };
  }
  if (status.real_trading_ready) {
    return {
      state: "ready" as const,
      label: "App activated",
      realTradingReady: true,
    };
  }
  return {
    state: "not-activated" as const,
    label: "Activate app",
    realTradingReady: false,
  };
}

export function tradingActionLabel(
  readbackAvailable: boolean,
  isRunning: boolean,
  selectedMode: TradingMode,
  pending: "start" | "pause" | null = null,
) {
  if (!readbackAvailable) return "Check again";
  if (pending === "pause") return "Pausing…";
  if (pending === "start") return "Starting…";
  if (isRunning) return selectedMode === "practice" ? "Pause Practice" : "Pause new real trades";
  return selectedMode === "practice" ? "Start Practice" : "Review Real Trading";
}

export function liveBotState(
  snapshot: Pick<BluechipWatchState, "status_available" | "running" | "next_check_at">,
  latest?: Pick<ActivityItem, "kind">,
): LiveBotState {
  if (!snapshot.status_available || snapshot.running === null) return "unavailable";
  if (!snapshot.running) return "paused";
  if (latest?.kind === "market_check" && !snapshot.next_check_at) return "checking";
  return "waiting";
}

function accountIcon(name: AccountName) {
  if (name === "Coinbase") return <IconCoin aria-hidden="true" />;
  if (name === "Robinhood") return <IconChartCandle aria-hidden="true" />;
  return <IconWallet aria-hidden="true" />;
}

export type DecisionOutcome = {
  title: string;
  result: string;
  final: boolean;
};

export function decisionOutcome(item: ActivityItem | undefined): DecisionOutcome | null {
  if (!item) return null;
  if (item.recorded_order_state === "practice_review") {
    return {
      title: `Practice result${item.amount_usd ? `: would use ${money(Number(item.amount_usd))}` : ""}`,
      result: "No real order was placed.",
      final: true,
    };
  }
  if (item.recorded_order_state === "submitted") {
    return {
      title: "Real order submitted · recorded",
      result: "The order may still fill. Confirm its latest status with your connected account.",
      final: false,
    };
  }
  if (item.recorded_order_state === "pending") {
    return {
      title: "Real order pending · recorded",
      result: "The order may still fill. Confirm its latest status with your connected account.",
      final: false,
    };
  }
  if (item.recorded_order_state === "partially_filled") {
    return {
      title: "Partial fill recorded",
      result: "Part of the order filled and the rest may still change. Confirm the latest status with your connected account.",
      final: false,
    };
  }
  if (item.recorded_order_state === "filled") {
    return {
      title: "Fill recorded",
      result: "This is the most recent authoritative order result stored by DayTradingBot.",
      final: true,
    };
  }
  if (item.recorded_order_state === "canceled") {
    return {
      title: "Order canceled · recorded",
      result: "The order is recorded as canceled. Confirm any earlier fills with your connected account.",
      final: true,
    };
  }
  if (item.recorded_order_state === "rejected") {
    return {
      title: "Order rejected · recorded",
      result: "The connected account rejected the order. DayTradingBot is not claiming a fill.",
      final: true,
    };
  }
  if (item.recorded_order_state === "unknown") {
    return {
      title: "Order status unknown · needs attention",
      result: "Do not assume the order is filled, canceled, or rejected. Check your connected account.",
      final: false,
    };
  }
  if (item.kind === "skipped") {
    return {
      title: "No trade this time",
      result: "Bluechip recorded a reason and moved on without sending an order.",
      final: true,
    };
  }
  if (item.kind === "error") {
    return {
      title: "This decision needs attention",
      result: "The recorded issue is shown below. Do not assume an order state from this message.",
      final: false,
    };
  }
  if (item.kind === "order_submitted") {
    return {
      title: "Order submission event recorded",
      result: "No authoritative order status was recorded. Check your connected account.",
      final: false,
    };
  }
  if (item.kind === "filled") {
    return {
      title: "Fill event recorded",
      result: "No authoritative order status accompanied this event. Check your connected account.",
      final: false,
    };
  }
  return null;
}

export function decisionHasFinalOutcome(item: ActivityItem | undefined) {
  return decisionOutcome(item)?.final === true;
}

function TradingViewChart({ symbol }: { symbol: WatchSymbol }) {
  const [loadState, setLoadState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [attempt, setAttempt] = useState(0);
  const source = tradingViewChartUrl(symbol);
  const attribution = tradingViewSymbolUrl(symbol);

  useEffect(() => {
    setLoadState("loading");
    const timer = window.setTimeout(() => {
      setLoadState((current) => current === "loading" ? "unavailable" : current);
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [attempt, symbol]);

  if (!source || !attribution) {
    return <div className="chart-unavailable" role="status"><strong>Market chart unavailable</strong><p>This symbol is outside Bluechip’s fixed watchlist.</p></div>;
  }

  return (
    <div className="market-chart-frame" data-state={loadState}>
      {loadState === "loading" ? <div className="chart-loading" role="status"><IconLoader2 className="spin" aria-hidden="true" /><strong>Loading the market chart…</strong></div> : null}
      {loadState === "unavailable" ? (
        <div className="chart-unavailable" role="status">
          <strong>Market chart unavailable</strong>
          <p>TradingView could not load. Bluechip’s recorded decisions and timing remain available beside the chart.</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>Try chart again</button>
        </div>
      ) : null}
      <iframe
        key={`${symbol}-${attempt}`}
        className="tradingview-chart"
        src={source}
        title={`${symbol} market chart by TradingView`}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => setLoadState("ready")}
        onError={() => setLoadState("unavailable")}
      />
      <div className="chart-attribution">
        <a href={attribution} rel="noopener nofollow" target="_blank">{symbol} chart by TradingView</a>
        <span>Market chart by TradingView · exchange data may be delayed.</span>
      </div>
    </div>
  );
}

export function App() {
  const [view, setView] = useState<View>("watch");
  const [catalog, setCatalog] = useState<Agent[]>([]);
  const [catalogState, setCatalogState] = useState<DataLifecycle>("loading");
  const [engine, setEngine] = useState<OwnerEngineStatus>(emptyEngine);
  const [engineReadbackAvailable, setEngineReadbackAvailable] = useState(false);
  const [robinhood, setRobinhood] = useState<RobinhoodStatus>(emptyRobinhood);
  const [simmer, setSimmer] = useState<SimmerStatus>(emptySimmer);
  const [coinbase, setCoinbase] = useState<CoinbaseStatus>(emptyCoinbase);
  const [polymarket, setPolymarket] = useState<PolymarketStatus>(emptyPolymarket);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("dtb.selectedAgents") ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [dailyBudget, setDailyBudget] = useState(() => storedTradingLimits().dailyBudget);
  const [perTrade, setPerTrade] = useState(() => storedTradingLimits().perTrade);
  const [mode, setMode] = useState<TradingMode>(() => (localStorage.getItem("dtb.mode") === "real" ? "real" : "practice"));
  const [setupOpen, setSetupOpen] = useState(() => localStorage.getItem("dtb.setupComplete") !== "yes");
  const [setupStep, setSetupStep] = useState(1);
  const [realReviewOpen, setRealReviewOpen] = useState(false);
  const [credentialAccount, setCredentialAccount] = useState<CredentialAccount | null>(null);
  const [credentialFields, setCredentialFields] = useState({ first: "", second: "" });
  const [credentialSavePending, setCredentialSavePending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checkingConnections, setCheckingConnections] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [connectionReadback, setConnectionReadback] = useState<Record<AccountName, ConnectionReadback>>({
    Robinhood: "checking",
    Coinbase: "checking",
    Kalshi: "checking",
    Polymarket: "checking",
  });
  const [startPending, setStartPending] = useState(false);
  const [pausePending, setPausePending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityState, setActivityState] = useState<DataLifecycle>("loading");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [watch, setWatch] = useState<BluechipWatchState>(emptyWatch);
  const [selectedSymbol, setSelectedSymbol] = useState<WatchSymbol>("AAPL");
  const [followLatest, setFollowLatest] = useState(true);
  const [license, setLicense] = useState<LicenseStatus>(emptyLicense);
  const [licenseReadback, setLicenseReadback] = useState<LicenseReadback>("checking");
  const [activationOpen, setActivationOpen] = useState(false);
  const [activationPending, setActivationPending] = useState(false);
  const [purchaseCode, setPurchaseCode] = useState("");
  const startPendingRef = useRef(false);
  const pausePendingRef = useRef(false);
  const credentialSavePendingRef = useRef(false);
  const activationPendingRef = useRef(false);
  const renewalAttempted = useRef(false);
  const initialConnectionCheckStarted = useRef(false);
  const setupBackdrop = useRef<HTMLDivElement>(null);
  const setupDialog = useRef<HTMLElement>(null);
  const setupClose = useRef<HTMLButtonElement>(null);
  const realReviewBackdrop = useRef<HTMLDivElement>(null);
  const realReviewDialog = useRef<HTMLElement>(null);
  const realReviewCancel = useRef<HTMLButtonElement>(null);
  const credentialBackdrop = useRef<HTMLDivElement>(null);
  const credentialDialog = useRef<HTMLElement>(null);
  const credentialClose = useRef<HTMLButtonElement>(null);
  const activationBackdrop = useRef<HTMLDivElement>(null);
  const activationDialog = useRef<HTMLElement>(null);
  const activationClose = useRef<HTMLButtonElement>(null);

  const receiveEngineStatus = (result: OwnerEngineStatus) => {
    setEngine(result);
    setEngineReadbackAvailable(true);
    if (result.selected_agent_ids.length) setSelectedIds(result.selected_agent_ids);
    if (result.mode === "practice" || result.mode === "real") setMode(result.mode);
  };

  const loadCatalog = async (showLoading = false) => {
    if (showLoading) setCatalogState("loading");
    try {
      const result = await invoke<AgentCatalog>("trading_agent_catalog");
      setCatalog(result.agents);
      const ready = new Set(result.agents.filter((agent) => agent.customer_ready).map((agent) => agent.id));
      setSelectedIds((current) => current.filter((id) => ready.has(id)));
      setCatalogState("ready");
    } catch (error) {
      setCatalogState("unavailable");
      throw error;
    }
  };

  const loadActivity = async (showLoading = false) => {
    if (showLoading) setActivityState("loading");
    try {
      setActivity(await invoke<ActivityItem[]>("recent_trading_activity"));
      setActivityState("ready");
    } catch (error) {
      setActivityState("unavailable");
      throw error;
    }
  };

  const loadLicense = async (showChecking = false) => {
    if (showChecking) setLicenseReadback("checking");
    try {
      setLicense(await invoke<LicenseStatus>("entry_license_status"));
      setLicenseReadback("available");
    } catch (error) {
      setLicenseReadback("unavailable");
      throw error;
    }
  };

  const refresh = async () => {
    const catalogRequest = loadCatalog();
    const engineRequest = invoke<OwnerEngineStatus>("owner_engine_status")
      .then(receiveEngineStatus)
      .catch((error: unknown) => {
        setEngineReadbackAvailable(false);
        throw error;
      });
    const activityRequest = loadActivity();
    const watchRequest = invoke<NativeBluechipWatchState>("bluechip_watch_state")
      .then((snapshot) => setWatch(availableWatchState(snapshot)))
      .catch((error: unknown) => {
        setWatch((current) => unavailableWatchState(current));
        throw error;
      });
    const licenseRequest = loadLicense();

    const results = await Promise.allSettled([
      catalogRequest,
      engineRequest,
      activityRequest,
      watchRequest,
      licenseRequest,
    ]);
    return {
      engineAvailable: results[1].status === "fulfilled",
      watchAvailable: results[3].status === "fulfilled",
    };
  };

  const checkStatus = async () => {
    setCheckingStatus(true);
    setNotice(null);
    try {
      const result = await refresh();
      setNotice(result.engineAvailable && result.watchAvailable
        ? "Bluechip’s status is up to date. Nothing was changed."
        : "The app still couldn’t confirm Bluechip’s status. Nothing was changed.");
    } finally {
      setCheckingStatus(false);
    }
  };

  const checkLicense = async () => {
    setNotice(null);
    try {
      await loadLicense(true);
      setNotice("Activation status is up to date. Nothing was changed.");
    } catch {
      setNotice("The app still couldn’t confirm activation status. Real Trading stays off.");
    }
  };

  const refreshAccount = async (account: AccountName) => {
    setConnectionReadback((current) => ({ ...current, [account]: "checking" }));
    try {
      if (account === "Robinhood") {
        setRobinhood(await invoke<RobinhoodStatus>("robinhood_owner_demo_status"));
      } else if (account === "Coinbase") {
        setCoinbase(await invoke<CoinbaseStatus>("coinbase_owner_demo_status"));
      } else if (account === "Kalshi") {
        setSimmer(await invoke<SimmerStatus>("kalshi_owner_demo_status"));
      } else {
        setPolymarket(await invoke<PolymarketStatus>("polymarket_us_owner_demo_status"));
      }
      setConnectionReadback((current) => ({ ...current, [account]: "available" }));
    } catch (error) {
      setConnectionReadback((current) => ({ ...current, [account]: "unavailable" }));
      throw error;
    }
  };

  const checkAllConnections = async (announce = true) => {
    setCheckingConnections(true);
    if (announce) setNotice(null);
    try {
      const results = await Promise.allSettled(
        (["Robinhood", "Coinbase", "Kalshi", "Polymarket"] satisfies AccountName[])
          .map(async (account) => {
            try {
              await withTimeout(refreshAccount(account), connectionCheckTimeoutMs);
            } catch (error) {
              setConnectionReadback((current) => ({ ...current, [account]: "unavailable" }));
              throw error;
            }
          }),
      );
      const unavailable = results.filter((result) => result.status === "rejected").length;
      if (announce) {
        setNotice(unavailable
          ? `Connections checked. ${unavailable} ${unavailable === 1 ? "account is" : "accounts are"} unavailable; nothing was changed.`
          : "Saved account connections checked.");
      }
    } finally {
      setCheckingConnections(false);
    }
  };

  useEffect(() => {
    void refresh();
    if (!initialConnectionCheckStarted.current) {
      initialConnectionCheckStarted.current = true;
      void checkAllConnections(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void invoke<OwnerEngineStatus>("owner_engine_status")
        .then(receiveEngineStatus)
        .catch(() => setEngineReadbackAvailable(false));
      void loadActivity().catch(() => undefined);
      void invoke<NativeBluechipWatchState>("bluechip_watch_state")
        .then((snapshot) => setWatch(availableWatchState(snapshot)))
        .catch(() => setWatch((current) => unavailableWatchState(current)));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!followLatest) return;
    const latestSymbol = activity.find((item) => isWatchSymbol(item.symbol))?.symbol ?? null;
    if (isWatchSymbol(latestSymbol)) setSelectedSymbol(latestSymbol);
  }, [activity, followLatest]);

  useEffect(() => {
    localStorage.setItem("dtb.selectedAgents", JSON.stringify(selectedIds));
    localStorage.setItem("dtb.dailyBudget", String(dailyBudget));
    localStorage.setItem("dtb.perTrade", String(perTrade));
    localStorage.setItem("dtb.mode", mode);
  }, [selectedIds, dailyBudget, perTrade, mode]);

  useEffect(() => {
    if (!license.renewal_needed || renewalAttempted.current) return;
    renewalAttempted.current = true;
    setLicenseReadback("checking");
    void invoke<LicenseStatus>("renew_license")
      .then((result) => {
        setLicense(result);
        setLicenseReadback("available");
      })
      .catch(() => setLicenseReadback("unavailable"));
  }, [license.renewal_needed]);

  useEffect(() => {
    const setupIsTopmost = setupOpen
      && !realReviewOpen
      && credentialAccount === null
      && !activationOpen;
    if (!setupIsTopmost) return;

    const backdrop = setupBackdrop.current;
    const dialog = setupDialog.current;
    if (!backdrop || !dialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(backdrop.parentElement?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({ element, wasInert: element.inert }));
    siblings.forEach(({ element }) => { element.inert = true; });
    const focusFrame = window.requestAnimationFrame(() => {
      if (startPending) dialog.focus();
      else setupClose.current?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (startPending) return;
        setSetupOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      siblings.forEach(({ element, wasInert }) => { element.inert = wasInert; });
      previouslyFocused?.focus();
    };
  }, [activationOpen, credentialAccount, realReviewOpen, setupOpen, startPending]);

  useEffect(() => {
    if (!realReviewOpen) return;
    const backdrop = realReviewBackdrop.current;
    const dialog = realReviewDialog.current;
    if (!backdrop || !dialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(backdrop.parentElement?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({ element, wasInert: element.inert }));
    siblings.forEach(({ element }) => { element.inert = true; });
    const focusFrame = window.requestAnimationFrame(() => {
      if (startPending) dialog.focus();
      else realReviewCancel.current?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (startPending) return;
        setRealReviewOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      siblings.forEach(({ element, wasInert }) => { element.inert = wasInert; });
      previouslyFocused?.focus();
    };
  }, [realReviewOpen, startPending]);

  useEffect(() => {
    if (credentialAccount === null) return;
    const backdrop = credentialBackdrop.current;
    const dialog = credentialDialog.current;
    if (!backdrop || !dialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(backdrop.parentElement?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({ element, wasInert: element.inert }));
    siblings.forEach(({ element }) => { element.inert = true; });
    const focusFrame = window.requestAnimationFrame(() => {
      if (credentialSavePending) dialog.focus();
      else credentialClose.current?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (credentialSavePending) return;
        setCredentialFields({ first: "", second: "" });
        setCredentialAccount(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      siblings.forEach(({ element, wasInert }) => { element.inert = wasInert; });
      previouslyFocused?.focus();
    };
  }, [credentialAccount, credentialSavePending]);

  useEffect(() => {
    if (!activationOpen) return;
    const backdrop = activationBackdrop.current;
    const dialog = activationDialog.current;
    if (!backdrop || !dialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(backdrop.parentElement?.children ?? [])
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
      .map((element) => ({ element, wasInert: element.inert }));
    siblings.forEach(({ element }) => { element.inert = true; });
    const focusFrame = window.requestAnimationFrame(() => {
      if (activationPending) dialog.focus();
      else activationClose.current?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (activationPending) return;
        setPurchaseCode("");
        setActivationOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      siblings.forEach(({ element, wasInert }) => { element.inert = wasInert; });
      previouslyFocused?.focus();
    };
  }, [activationOpen, activationPending]);

  const accounts = useMemo<Array<{ name: AccountName; detail: string; connected: boolean; funded: boolean; action: string; readback: ConnectionReadback }>>(
    () => {
      const polymarketReadiness = polymarketUsAccountReadiness(polymarket);
      return [
      {
        name: "Robinhood",
        detail: "Stocks and ETFs",
        connected: robinhood.authenticated && robinhood.agentic_account_available,
        funded: robinhood.has_buying_power,
        action: "Connect",
        readback: connectionReadback.Robinhood,
      },
      {
        name: "Coinbase",
        detail: "Bitcoin and Ethereum",
        connected: coinbase.authenticated && coinbase.least_privilege_live_scope,
        funded: coinbase.has_btc_or_eth_account,
        action: "Add account",
        readback: connectionReadback.Coinbase,
      },
      {
        name: "Kalshi",
        detail: "Event contracts",
        connected: simmer.authenticated && simmer.direct_api_configured,
        funded: simmer.has_spendable_balance,
        action: simmer.owner_import_available && !simmer.configured ? "Use connected account" : "Connect",
        readback: connectionReadback.Kalshi,
      },
      {
        name: "Polymarket",
        detail: "Prediction markets",
        connected: polymarketReadiness.connected,
        funded: polymarketReadiness.funded,
        action: "Add API key",
        readback: connectionReadback.Polymarket,
      },
      ];
    },
    [coinbase, connectionReadback, polymarket, robinhood, simmer],
  );

  const connectedNames = useMemo(() => new Set<string>(accounts.filter((account) => account.readback === "available" && account.connected).map((account) => account.name)), [accounts]);
  const selectedAgents = catalog.filter((agent) => selectedIds.includes(agent.id));
  const controlGate = tradingControlGate(
    engineReadbackAvailable,
    engine.mode,
    watch.status_available,
    engine.available,
    watch.running,
  );
  const running = controlGate.running;
  const engineReportsRunning = engineReadbackAvailable
    && (engine.mode === "practice" || engine.mode === "real");
  const watchReportsRunning = watch.status_available && watch.running === true;
  const controlReadbacksDisagree = engineReadbackAvailable
    && watch.status_available
    && (
      engineReportsRunning !== watchReportsRunning
      || (
        engineReportsRunning
        && watchReportsRunning
        && engine.mode !== watch.mode
      )
    );
  const robinhoodAccount = accounts.find((account) => account.name === "Robinhood");
  const realAccountReadiness = realTradingAccountReadiness(
    robinhoodAccount?.readback ?? "checking",
    Boolean(robinhoodAccount?.connected),
    Boolean(robinhoodAccount?.funded),
  );
  const licensePresentation = licenseStatusPresentation(licenseReadback, license);

  const toggleAgent = (id: string) => {
    setNotice(null);
    const agent = catalog.find((item) => item.id === id);
    if (!agent?.customer_ready) {
      setNotice("That agent is coming next. Bluechip is available in this customer build.");
      return;
    }
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 3) {
        setNotice("Choose up to three trading agents.");
        return current;
      }
      return [...current, id];
    });
  };

  const pickForMe = () => {
    const eligible = catalog
      .filter((agent) => agent.customer_ready && connectedNames.has(agent.account))
      .sort((a, b) => a.auto_pick_rank - b.auto_pick_rank);
    const pick = eligible[0];
    if (!pick) {
      setNotice("Connect an account—or check your saved connections—before using Pick for me.");
      setView("accounts");
      return;
    }
    setSelectedIds([pick.id]);
    setNotice(`${pick.name} is the best match for your connected ${pick.account} account and current settings.`);
  };

  const connectAccount = async (account: AccountName) => {
    if (account === "Coinbase" || account === "Polymarket" || (account === "Kalshi" && !simmer.owner_import_available)) {
      setCredentialAccount(account);
      setCredentialFields({ first: "", second: "" });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      if (account === "Robinhood") {
        try {
          await invoke("import_robinhood_owner_connection");
        } catch (ownerImportError) {
          const key = errorKey(ownerImportError);
          if (key === "ROBINHOOD_OWNER_VAULT_UNAVAILABLE") throw ownerImportError;
          await invoke("connect_robinhood");
        }
      }
      if (account === "Kalshi") await invoke("import_owner_demo_credentials");
      await Promise.all([refresh(), refreshAccount(account)]);
      setNotice(`${account} is connected.`);
    } catch (error) {
      setNotice(messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  const submitCredentials = async () => {
    if (credentialSavePendingRef.current) return;
    if (!credentialAccount || !credentialFields.first.trim() || !credentialFields.second.trim()) {
      setNotice("Complete both fields to connect this account.");
      return;
    }
    const account = credentialAccount;
    const identifier = credentialFields.first.trim();
    const secret = credentialFields.second.trim();
    credentialSavePendingRef.current = true;
    setCredentialSavePending(true);
    setBusy(true);
    setNotice(null);
    try {
      if (account === "Coinbase") {
        await invoke("connect_coinbase_account", {
          request: { key_name: identifier, private_key_pem: secret },
        });
      } else if (account === "Kalshi") {
        await invoke("connect_kalshi_account", {
          request: { api_key_id: identifier, private_key_pem: secret },
        });
      } else {
        await invoke("connect_polymarket_us_account", {
          request: { key_id: identifier, secret_key: secret },
        });
      }
      setCredentialFields({ first: "", second: "" });
      setCredentialAccount(null);
      setNotice(`${account} is connected.`);
      await Promise.all([refresh(), refreshAccount(account)]);
    } catch (error) {
      setNotice(messageFromError(error));
    } finally {
      credentialSavePendingRef.current = false;
      setCredentialFields((fields) => ({ ...fields, second: "" }));
      setCredentialSavePending(false);
      setBusy(false);
    }
  };

  const start = async (confirmed = false) => {
    if (startPendingRef.current) return;
    if (!engineReadbackAvailable) {
      setNotice("Trading engine status is unavailable. Check status before starting.");
      return;
    }
    if (!watch.status_available) {
      setNotice("Bluechip status is unavailable. Check again before starting or reviewing trading.");
      return;
    }
    if (!engine.available) {
      setNotice("The local trading engine is unavailable. Nothing was started.");
      return;
    }
    if (!controlGate.canStartOrReview) {
      setNotice("A trading session is already running. Pause it before starting another session.");
      return;
    }
    const normalizedLimits = normalizeTradingLimits(dailyBudget, perTrade);
    if (
      normalizedLimits.dailyBudget !== dailyBudget
      || normalizedLimits.perTrade !== perTrade
    ) {
      setDailyBudget(normalizedLimits.dailyBudget);
      setPerTrade(normalizedLimits.perTrade);
    }
    if (!selectedIds.length) {
      setNotice("Choose a trading agent first, or use Pick for me.");
      setView("agents");
      return;
    }
    if (!tradingModeAccountReady(mode, realAccountReadiness.ready)) {
      setRealReviewOpen(false);
      setNotice(realAccountReadiness.message);
      setView("accounts");
      return;
    }
    if (mode === "real" && licenseReadback !== "available") {
      setRealReviewOpen(false);
      setActivationOpen(true);
      setNotice("Activation status is unavailable. Check it again before reviewing Real Trading.");
      return;
    }
    if (mode === "real" && !licensePresentation.realTradingReady) {
      setRealReviewOpen(false);
      setActivationOpen(true);
      return;
    }
    if (mode === "real" && !confirmed) {
      setRealReviewOpen(true);
      return;
    }
    startPendingRef.current = true;
    setBusy(true);
    setStartPending(true);
    setNotice(null);
    try {
      const result = await invoke<SessionResult>("start_owner_engine_session", {
        request: {
          agent_ids: selectedIds,
          mode,
          daily_budget_usd: normalizedLimits.dailyBudget,
          max_per_trade_usd: normalizedLimits.perTrade,
          real_confirmation: mode === "real" ? "START REAL TRADING" : null,
        },
      });
      setRealReviewOpen(false);
      setSetupOpen(false);
      localStorage.setItem("dtb.setupComplete", "yes");
      setNotice(result.message);
      await refresh();
      setView("watch");
    } catch (error) {
      setRealReviewOpen(false);
      setNotice(messageFromError(error));
    } finally {
      startPendingRef.current = false;
      setStartPending(false);
      setBusy(false);
    }
  };

  const activate = async () => {
    if (activationPendingRef.current) return;
    if (!purchaseCode.trim()) {
      setNotice("Enter your DayTradingBot access code.");
      return;
    }
    activationPendingRef.current = true;
    setActivationPending(true);
    setBusy(true);
    setLicenseReadback("checking");
    setNotice(null);
    try {
      const result = await invoke<LicenseStatus>("activate_license", {
        request: { license_code: purchaseCode.trim() },
      });
      setLicense(result);
      setLicenseReadback("available");
      setPurchaseCode("");
      setActivationOpen(false);
      setNotice("DayTradingBot is activated. You can now review and start real trading.");
    } catch (error) {
      setLicenseReadback("unavailable");
      setNotice(messageFromError(error));
    } finally {
      activationPendingRef.current = false;
      setPurchaseCode("");
      setActivationPending(false);
      setBusy(false);
    }
  };

  const pause = async () => {
    if (!controlGate.canPause || pausePendingRef.current) return;
    pausePendingRef.current = true;
    setPausePending(true);
    setNotice(null);
    try {
      const result = await invoke<SessionResult>("pause_owner_engine_session");
      setNotice(result.message);
      await refresh();
    } catch (error) {
      setNotice(messageFromError(error));
    } finally {
      pausePendingRef.current = false;
      setPausePending(false);
    }
  };

  const finishSetupStep = () => {
    if (setupStep === 2 && !selectedIds.length) {
      setNotice("Choose a trading agent or use Pick for me.");
      return;
    }
    if (setupStep < 4) setSetupStep((step) => step + 1);
  };

  const latestActivity = useMemo(
    () => activity
      .slice()
      .sort((a, b) => new Date(b.occurred_at).valueOf() - new Date(a.occurred_at).valueOf())[0],
    [activity],
  );
  const activeMode = watchDisplayMode(watch);
  const currentLiveState = liveBotState(watch, latestActivity);
  const currentDecision = activity.find((item) => (
    item.symbol === selectedSymbol
    && ["signal", "skipped", "reviewed", "order_submitted", "filled", "error"].includes(item.kind)
  ));
  const currentOutcome = decisionOutcome(currentDecision);
  const hasFinalDecisionOutcome = decisionHasFinalOutcome(currentDecision);
  const activityLifecycleCopy = dataLifecycleCopy("activity", activityState, activity.length > 0);
  const catalogLifecycleCopy = dataLifecycleCopy("catalog", catalogState, catalog.length > 0);
  const authorizationSummary = realTradingAuthorizationSummary(dailyBudget, perTrade);
  const historyGroups = useMemo(
    () => groupActivityByDay(activity, activityFilter),
    [activity, activityFilter],
  );
  const recentOutcomeGroups = useMemo(
    () => groupActivityByDay(activity, "all").slice(0, 2),
    [activity],
  );
  const bluechipSelected = selectedIds.includes("bluechip");
  const controlMode = engineReadbackAvailable && (engine.mode === "practice" || engine.mode === "real")
    ? engine.mode
    : watch.status_available && watch.running && (watch.mode === "practice" || watch.mode === "real")
      ? watch.mode
      : mode;
  const pauseActionLabel = pausePending
    ? "Pausing…"
    : controlReadbacksDisagree
      ? "Pause trading"
      : tradingActionLabel(true, true, controlMode);
  const persistentModeCopy = controlReadbacksDisagree
    ? "Status mismatch · Pause remains available"
    : activeMode === "practice"
    ? "Practice running · no real money"
    : activeMode === "real"
      ? "Real trading running"
      : activeMode === "unavailable"
        ? "Couldn’t confirm Bluechip’s status"
        : controlMode === "practice"
          ? "Practice · no real money"
          : "Real trading selected · paused";
  const watchTitle = controlReadbacksDisagree
    ? "Bluechip status reports disagree"
    : activeMode === "practice"
    ? "Watch Bluechip practice"
    : activeMode === "real"
      ? "Bluechip is trading with real money"
      : activeMode === "unavailable"
        ? "Bluechip’s status needs a check"
        : !engineReadbackAvailable
          ? "Trading engine status is unavailable"
          : !engine.available
            ? "Bluechip needs the trading engine"
            : !bluechipSelected
              ? "Choose Bluechip to continue"
              : robinhoodAccount?.readback === "checking"
                ? "Checking your Robinhood connection"
                : robinhoodAccount?.readback === "unavailable"
                  ? "Robinhood connection status is unavailable"
                  : !robinhoodAccount?.connected
                    ? "Connect Robinhood to continue"
                    : controlMode === "real" && !robinhoodAccount.funded
                      ? "Robinhood needs available buying power"
                    : "Bluechip is ready when you are";
  const watchSupportCopy = controlReadbacksDisagree
    ? "The engine and Bluechip watch readbacks disagree. Starting stays blocked; Pause remains available to block new trades."
    : activeMode === "practice"
    ? "Watch each recorded decision. Practice never sends a real order."
    : activeMode === "real"
      ? "Bluechip is using your connected account within the limits shown below."
      : activeMode === "unavailable"
        ? "The app cannot confirm whether Bluechip is running or paused. Recorded history is still available."
        : !engineReadbackAvailable
          ? "Nothing can be started until the app can read the trading engine status."
          : !engine.available
            ? "Install the local trading engine before starting Bluechip."
            : !bluechipSelected
              ? "Open Agents and select Bluechip before starting."
              : robinhoodAccount?.readback === "checking"
          ? "Checking saved connection…"
          : robinhoodAccount?.readback === "unavailable"
            ? "Connection status unavailable. Nothing was changed."
            : robinhoodAccount?.connected
              ? controlMode === "practice"
                ? "Connection verified. Bluechip will not start a new check until you start Practice."
                : robinhoodAccount.funded
                  ? "Connection and available buying power verified. Bluechip will not start until you review Real Trading."
                  : "Connection verified, but Real Trading needs available Robinhood buying power."
              : "Connect Robinhood before starting Bluechip.";
  const liveStateCopy: Record<LiveBotState, { title: string; detail: string }> = {
    checking: { title: "Checking the market", detail: "A market check is recorded" },
    waiting: { title: "Waiting for the next check", detail: watchTime(watch.next_check_at, "Scheduled by Bluechip") },
    paused: { title: "Next check", detail: "Starts when you do" },
    unavailable: { title: "Bot status", detail: "Unavailable" },
  };
  const screenTitle = view === "watch"
    ? watchTitle
    : view === "agents"
      ? "Choose the approach that fits you"
      : view === "accounts"
        ? "Your accounts, clearly connected"
        : "Your complete trading history";
  const screenSupport = view === "watch"
    ? watchSupportCopy
    : view === "agents"
      ? "Pick an agent yourself, or let DayTradingBot recommend one from the accounts you connect."
      : view === "accounts"
        ? "Your money stays with your broker, exchange, or wallet. DayTradingBot never needs withdrawal access."
        : "Filter Practice and Real records, then open any day to see what Bluechip recorded.";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" type="button" onClick={() => setView("watch")} aria-label="Watch DayTradingBot">
          <img src={dtbBrandMark} alt="" />
          <strong>DayTradingBot</strong>
        </button>
        <nav aria-label="Main navigation">
          <button className={view === "watch" ? "nav-item active" : "nav-item"} type="button" onClick={() => setView("watch")} aria-label="Watch" aria-current={view === "watch" ? "page" : undefined}>
            <IconEye aria-hidden="true" />
            <span>Watch</span>
          </button>
          <button className={view === "agents" ? "nav-item active" : "nav-item"} type="button" onClick={() => setView("agents")} aria-label="Agents" aria-current={view === "agents" ? "page" : undefined}>
            <IconRobot aria-hidden="true" />
            <span>Agents</span>
          </button>
          <button className={view === "accounts" ? "nav-item active" : "nav-item"} type="button" onClick={() => setView("accounts")} aria-label="Accounts" aria-current={view === "accounts" ? "page" : undefined}>
            <IconWallet aria-hidden="true" />
            <span>Accounts</span>
          </button>
          <button className={view === "activity" ? "nav-item active" : "nav-item"} type="button" onClick={() => setView("activity")} aria-label="History" aria-current={view === "activity" ? "page" : undefined}>
            <IconHistory aria-hidden="true" />
            <span>History</span>
          </button>
        </nav>
        <button className="setup-link" type="button" onClick={() => setSetupOpen(true)} aria-label="Setup">
          <IconSettings aria-hidden="true" />
          <span>Setup</span>
        </button>
        <button
          className={licensePresentation.realTradingReady ? "activation-link ready" : "activation-link"}
          type="button"
          onClick={() => setActivationOpen(true)}
          aria-label={licensePresentation.label}
          disabled={licensePresentation.state === "checking"}
        >
          {licensePresentation.state === "checking"
            ? <IconLoader2 className="spin" aria-hidden="true" />
            : licensePresentation.state === "unavailable"
              ? <IconAlertTriangle aria-hidden="true" />
              : licensePresentation.realTradingReady
                ? <IconCircleCheck aria-hidden="true" />
                : <IconLock aria-hidden="true" />}
          <span className="full-label">{licensePresentation.label}</span>
          <span className="compact-label" aria-hidden="true">Activation</span>
        </button>
        <div className={`account-note ${robinhoodAccount?.readback ?? "checking"}`} role="status">
          {robinhoodAccount?.readback === "checking" ? (
            <IconLoader2 className="spin" aria-hidden="true" />
          ) : robinhoodAccount?.readback === "unavailable" ? (
            <IconAlertTriangle aria-hidden="true" />
          ) : robinhoodAccount?.connected && robinhoodAccount.funded ? (
            <IconCircleCheck aria-hidden="true" />
          ) : robinhoodAccount?.connected ? (
            <IconAlertTriangle aria-hidden="true" />
          ) : (
            <IconWallet aria-hidden="true" />
          )}
          <div>
            <strong>
              {connectionStatusLabel(
                robinhoodAccount?.readback ?? "checking",
                Boolean(robinhoodAccount?.connected),
              )}
            </strong>
            <small>
              {robinhoodAccount?.readback === "unavailable"
                ? "Nothing was changed."
                : robinhoodAccount?.connected && robinhoodAccount.funded
                  ? "Robinhood connection and buying power are verified."
                  : robinhoodAccount?.connected
                    ? "Robinhood is connected · funding needed before Real Trading."
                  : "Connect it before Bluechip trades."}
            </small>
          </div>
        </div>
      </aside>

      <main className={`main-area ${view === "watch" ? "watch-main" : ""}`}>
        <header className={`topbar ${view}`}>
          <div className="topbar-copy">
            <h1>{screenTitle}</h1>
            <div className="screen-mode">
              <span className={`mode-badge ${activeMode === "paused" ? controlMode : activeMode}`}>
                {activeMode === "unavailable" ? <IconAlertTriangle aria-hidden="true" /> : activeMode === "paused" ? <IconPlayerPause aria-hidden="true" /> : <IconActivity aria-hidden="true" />}
                {persistentModeCopy}
              </span>
              <p>{screenSupport}</p>
            </div>
          </div>
          <div className="topbar-actions">
            {running ? (
              <button className="pause-button" type="button" onClick={pause} disabled={pausePending}>
                <IconPlayerPause aria-hidden="true" />
                {pauseActionLabel}
              </button>
            ) : !engineReadbackAvailable || !watch.status_available ? (
              <button
                className="pause-button"
                type="button"
                onClick={() => void checkStatus()}
                disabled={checkingStatus}
              >
                <IconRefresh className={checkingStatus ? "spin" : ""} aria-hidden="true" />
                {checkingStatus ? "Checking…" : tradingActionLabel(false, false, controlMode)}
              </button>
            ) : (
              <button
                className="start-button"
                type="button"
                onClick={() => void start()}
                disabled={busy || !controlGate.canStartOrReview || !tradingModeAccountReady(controlMode, realAccountReadiness.ready)}
              >
                <IconPlayerPlay aria-hidden="true" />
                {tradingActionLabel(true, false, controlMode, startPending ? "start" : null)}
              </button>
            )}
            {view === "watch" ? (
              <button className="text-button" type="button" onClick={() => setSetupOpen(true)}>
                <IconSettings aria-hidden="true" />
                Review setup
              </button>
            ) : null}
          </div>
        </header>

        {notice ? (
          <div className="notice" role="status">
            <IconInfoCircle aria-hidden="true" />
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message"><IconX aria-hidden="true" /></button>
          </div>
        ) : null}

        {view === "watch" ? (
          <div className="watch-view">
            {controlReadbacksDisagree ? (
              <div className="order-warning" role="alert">
                <IconAlertTriangle aria-hidden="true" />
                <span>The trading engine and Bluechip watch status disagree. Starting stays blocked. Use Pause to block new trades, then check status again.</span>
              </div>
            ) : !watch.status_available ? (
              <div className="order-warning" role="alert">
                <IconAlertTriangle aria-hidden="true" />
                <span>The app couldn’t confirm Bluechip or your remaining daily amount. Do not assume it is paused or treat a missing amount as $0. An earlier order may still fill.</span>
              </div>
            ) : watch.has_unresolved_real_order ? (
              <div className="order-warning" role="status">
                <IconAlertTriangle aria-hidden="true" />
                <span>An earlier real order still needs an authoritative status check. Pausing blocks new trades; an existing order may still fill.</span>
              </div>
            ) : null}

            <section className="watch-overview" aria-label="Bluechip status and limits">
              <article>
                {currentLiveState === "unavailable" ? <IconAlertTriangle aria-hidden="true" /> : currentLiveState === "checking" ? <IconSearch aria-hidden="true" /> : <IconCalendar aria-hidden="true" />}
                <div><span>{liveStateCopy[currentLiveState].title}</span><strong>{liveStateCopy[currentLiveState].detail}</strong></div>
              </article>
              <article>
                <IconShieldCheck aria-hidden="true" />
                <div><span>Daily limit</span><strong>{activeMode === "unavailable" ? "Unavailable" : watch.daily_limit_usd ? money(Number(watch.daily_limit_usd)) : money(dailyBudget)}</strong></div>
              </article>
              <article>
                <IconTag aria-hidden="true" />
                <div><span>Per decision</span><strong>{activeMode === "unavailable" ? "Unavailable" : watch.per_trade_limit_usd ? money(Number(watch.per_trade_limit_usd)) : money(perTrade)}</strong></div>
              </article>
            </section>

            {watch.budget_state === "available" ? (
              <section className="real-budget" aria-label="Real trading money status">
                <div><span>Used or held</span><strong>{watch.used_or_held_usd ? money(Number(watch.used_or_held_usd)) : "Unavailable"}</strong><small>Committed plus pending</small></div>
                <div><span>Pending</span><strong>{watch.pending_usd ? money(Number(watch.pending_usd)) : "Unavailable"}</strong><small>Included in used</small></div>
                <div><span>Committed</span><strong>{watch.committed_usd ? money(Number(watch.committed_usd)) : "Unavailable"}</strong><small>Recorded today</small></div>
                <div><span>Remaining</span><strong>{watch.remaining_usd ? money(Number(watch.remaining_usd)) : "Unavailable"}</strong><small>Available for new buys</small></div>
              </section>
            ) : null}

            <section className="watch-workspace">
              <div className="chart-card">
                <header className="chart-heading">
                  <div>
                    <p className="eyebrow">Market context only</p>
                    <h2>{selectedSymbol} · 5-minute chart</h2>
                    <p>Bluechip uses your connected account for decisions, not this chart.</p>
                  </div>
                  <div className="chart-controls">
                    <label>
                      <span>Chart symbol</span>
                      <select
                        value={selectedSymbol}
                        onChange={(event) => {
                          const symbol = event.target.value;
                          if (isWatchSymbol(symbol)) {
                            setSelectedSymbol(symbol);
                            setFollowLatest(false);
                          }
                        }}
                      >
                        {watchSymbols.map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
                      </select>
                    </label>
                    <button className={followLatest ? "follow-button active" : "follow-button"} type="button" onClick={() => setFollowLatest(true)} aria-pressed={followLatest}>
                      <IconSparkles aria-hidden="true" />
                      {followLatest ? "Following Bluechip" : "Follow Bluechip"}
                    </button>
                  </div>
                </header>
                <TradingViewChart symbol={selectedSymbol} />
              </div>

              <aside className={`decision-card ${currentDecision?.kind ?? "waiting"}`} aria-labelledby="decision-title">
                <p className="eyebrow">What Bluechip recorded</p>
                <h2 id="decision-title">
                  {currentDecision?.message
                    ?? (activeMode === "unavailable"
                      ? "Recorded decisions are available, but live status is not."
                      : activeMode === "paused"
                        ? "Start Practice to watch a decision without placing an order."
                        : `Waiting for a recorded ${selectedSymbol} decision.`)}
                </h2>
                <div className="decision-steps" role="list" aria-label="Explanation of the recorded decision">
                  <div className={currentDecision ? "complete" : ""} role="listitem">
                    <span>{currentDecision ? <IconCheck aria-hidden="true" /> : "1"}</span>
                    <div><strong>Reviewed the market</strong><small>{currentDecision ? `${selectedSymbol} · ${activityTime(currentDecision.occurred_at)}` : "No decision recorded for this symbol yet"}</small></div>
                  </div>
                  <div className={hasFinalDecisionOutcome ? "complete" : ""} role="listitem">
                    <span>{hasFinalDecisionOutcome ? <IconCheck aria-hidden="true" /> : "2"}</span>
                    <div><strong>Applied your limits</strong><small>{hasFinalDecisionOutcome ? `Recorded with a ${currentDecision?.mode === "practice" ? "Practice" : "Real"} result` : "Shown only after a final outcome is recorded"}</small></div>
                  </div>
                  <div className={currentOutcome?.final ? "complete" : ""} role="listitem">
                    <span>{currentOutcome?.final ? <IconCheck aria-hidden="true" /> : "3"}</span>
                    <div><strong>{currentOutcome?.title ?? "Recorded the outcome"}</strong><small>{currentOutcome?.result ?? "The result will appear here"}</small></div>
                  </div>
                </div>
                {currentDecision ? (
                  <footer>
                    <strong>{currentDecision.mode === "practice" ? "Practice · no real order" : "Real trading record"}</strong>
                    <span>{currentDecision.amount_usd ? money(Number(currentDecision.amount_usd)) : "No amount recorded"}</span>
                  </footer>
                ) : null}
              </aside>
            </section>

            <section className="decision-guide" aria-labelledby="decision-guide-title">
              <div className="guide-heading">
                <p className="eyebrow">What Bluechip does</p>
                <h2 id="decision-guide-title">How every Bluechip check works</h2>
              </div>
              <div className="guide-step"><IconSearch aria-hidden="true" /><div><strong>Scans 8 stocks</strong><small>Looks for supported setups</small></div></div>
              <IconChevronRight className="guide-arrow" aria-hidden="true" />
              <div className="guide-step"><IconArrowsSort aria-hidden="true" /><div><strong>Compares opportunities</strong><small>Ranks the available setups</small></div></div>
              <IconChevronRight className="guide-arrow" aria-hidden="true" />
              <div className="guide-step"><IconShieldCheck aria-hidden="true" /><div><strong>Applies your limits</strong><small>Uses the settings you chose</small></div></div>
              <IconChevronRight className="guide-arrow" aria-hidden="true" />
              <div className="guide-step"><IconClock aria-hidden="true" /><div><strong>Records the outcome</strong><small>Then waits for the next check</small></div></div>
            </section>

            <section className="recent-outcomes" aria-labelledby="recent-outcomes-title">
              <div className="section-heading">
                <div><p className="eyebrow">Recorded results</p><h2 id="recent-outcomes-title">Recent outcomes</h2></div>
                <button className="text-button" type="button" onClick={() => setView("activity")}>Open History <IconChevronRight aria-hidden="true" /></button>
              </div>
              {activityState !== "ready" ? (
                <div className="empty-panel" role={activityState === "unavailable" ? "alert" : "status"}>
                  {activityState === "loading" ? <IconLoader2 className="spin" aria-hidden="true" /> : <IconAlertTriangle aria-hidden="true" />}
                  <strong>{activityLifecycleCopy.title}</strong>
                  <p>{activityLifecycleCopy.detail}</p>
                  {activityState === "unavailable" ? <button className="secondary-button" type="button" onClick={() => void loadActivity(true).catch(() => undefined)}>Try activity again</button> : null}
                </div>
              ) : null}
              {recentOutcomeGroups.length ? recentOutcomeGroups.map((group) => (
                <article key={group.key}>
                  <IconCalendar aria-hidden="true" />
                  <div><strong>{group.label}</strong><small>{group.items.length} loaded {group.items.length === 1 ? "event" : "events"}</small></div>
                  <div><strong>{group.realOrderCount} loaded Real submission {group.realOrderCount === 1 ? "event" : "events"}</strong><small>{group.realCount ? `${group.realCount} loaded Real-mode events` : "No Real-mode events are loaded for this day"}</small></div>
                  <div><strong>{group.realCount ? "Practice and Real are separated" : "Loaded events are Practice only"}</strong><small>{group.realCount ? "Open History for the exact loaded events" : "Practice never sends a real order"}</small></div>
                  <span className={group.realCount ? "outcome-mode real" : "outcome-mode practice"}>{group.realCount ? "Contains Real records" : "Practice · no real money"}</span>
                </article>
              )) : activityState === "ready" ? (
                <div className="empty-panel"><IconHistory aria-hidden="true" /><strong>No recorded outcomes yet</strong><p>Start Practice to see Bluechip’s first decision without using real money.</p></div>
              ) : null}
            </section>

            <details className="watch-text-alternative">
              <summary>Accessible text and table view</summary>
              <p>{selectedSymbol} market candles are displayed by TradingView. Bluechip’s separate recorded events are listed below and are not chart markers.</p>
              <div className="activity-table-wrap">
                <table>
                  <thead><tr><th>Time</th><th>Symbol</th><th>Recorded event</th><th>Mode</th><th>Details</th></tr></thead>
                  <tbody>
                    {activity.slice(0, 12).map((item) => (
                      <tr key={item.id}>
                        <td>{activityTime(item.occurred_at)}</td>
                        <td>{item.symbol ?? "All"}</td>
                        <td>{eventLabel(item)}</td>
                        <td>{item.mode === "practice" ? "Practice · no real order" : "Real"}</td>
                        <td>{item.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        ) : null}

        {view === "agents" ? (
          <section className="agents-view">
            <div className="view-intro">
              <div><p className="eyebrow">Your strategy</p><h2>Choose up to three agents</h2><p>Each agent follows a different approach. You can change your selection whenever trading is paused.</p></div>
              <button className="pick-button" type="button" onClick={pickForMe} disabled={catalogState !== "ready"}><IconSparkles aria-hidden="true" />Pick for me</button>
            </div>
            {catalogState !== "ready" ? (
              <div className="empty-panel" role={catalogState === "unavailable" ? "alert" : "status"}>
                {catalogState === "loading" ? <IconLoader2 className="spin" aria-hidden="true" /> : <IconAlertTriangle aria-hidden="true" />}
                <strong>{catalogLifecycleCopy.title}</strong>
                <p>{catalogLifecycleCopy.detail}</p>
                {catalogState === "unavailable" ? <button className="secondary-button" type="button" onClick={() => void loadCatalog(true).catch(() => undefined)}>Try agent catalog again</button> : null}
              </div>
            ) : null}
            <div className="agent-list">
              {catalog.map((agent) => {
                const selected = selectedIds.includes(agent.id);
                const account = accounts.find((item) => item.name === agent.account);
                const connected = account?.readback === "available" && account.connected;
                const funded = connected && Boolean(account?.funded);
                const accountCopy = account?.readback === "checking"
                  ? "Checking saved connection…"
                  : account?.readback === "unavailable"
                    ? "Connection status unavailable"
                    : !agent.customer_ready
                      ? "Coming next"
                      : connected
                        ? funded
                          ? "Ready for Real Trading"
                          : "Connected · funding needed for Real Trading"
                        : `Connect ${agent.account}`;
                return (
                  <button className={selected ? "agent-row selected" : "agent-row"} type="button" key={agent.id} onClick={() => toggleAgent(agent.id)} disabled={!engineReadbackAvailable || running || !agent.customer_ready}>
                    <span className="agent-avatar"><IconRobot aria-hidden="true" /></span>
                    <div className="agent-main"><span><strong>{agent.name}</strong><small>{agent.account} · every {agent.cadence_minutes} minutes</small></span><p>{agent.summary}</p></div>
                    <span className={`risk-tag ${agent.risk_level}`}>{agent.risk_level === "steady" ? "Steady" : agent.risk_level === "balanced" ? "Balanced" : "Active"}</span>
                    <span className={funded ? "account-ready" : "account-needed"}>{accountCopy}</span>
                    <span className="selection-mark">{selected ? <><IconCircleCheck aria-hidden="true" />Selected</> : <><IconCircleDot aria-hidden="true" />Select</>}</span>
                  </button>
                );
              })}
            </div>
            {catalogState === "ready" && !catalog.length ? <div className="empty-panel"><IconRobot aria-hidden="true" /><strong>{catalogLifecycleCopy.title}</strong><p>{catalogLifecycleCopy.detail}</p></div> : null}
          </section>
        ) : null}

        {view === "accounts" ? (
          <section className="accounts-view">
            <div className="view-intro">
              <div><p className="eyebrow">Connection status</p><h2>Use the accounts you already have</h2><p>Saved accounts are checked automatically when the app opens. If a check fails, the app says so instead of telling you the account was disconnected.</p></div>
              <button className="pick-button" type="button" disabled={checkingConnections} onClick={() => void checkAllConnections()}>
                <IconRefresh className={checkingConnections ? "spin" : ""} aria-hidden="true" />
                {checkingConnections ? "Checking accounts…" : "Check again"}
              </button>
            </div>
            <div className="account-list">
              {accounts.map((account) => {
                const stateCopy = connectionStatusLabel(account.readback, account.connected);
                return (
                <article className={`account-row ${account.readback}`} key={account.name}>
                  <span className="account-logo large">{accountIcon(account.name)}</span>
                  <div><strong>{account.name}</strong><small>{account.connected && account.readback === "available" && !account.funded ? `${account.detail} · funding needed before Real Trading` : account.detail}</small></div>
                  <div className={`account-state ${account.readback} ${account.connected && account.funded ? "connected" : account.connected ? "funding-needed" : ""}`}>
                    {account.readback === "checking" ? <IconLoader2 className="spin" aria-hidden="true" /> : account.readback === "unavailable" ? <IconAlertTriangle aria-hidden="true" /> : account.connected && account.funded ? <IconCircleCheck aria-hidden="true" /> : account.connected ? <IconAlertTriangle aria-hidden="true" /> : <IconCircleDot aria-hidden="true" />}
                    <span>{stateCopy}</span>
                  </div>
                  {account.readback === "checking" ? (
                    <button className="secondary-button" type="button" disabled>Checking…</button>
                  ) : account.readback === "unavailable" ? (
                    <button className="secondary-button" type="button" disabled={checkingConnections} onClick={() => void refreshAccount(account.name)}>Try again</button>
                  ) : account.connected && account.funded ? (
                    <span className="ready-label"><IconCircleCheck aria-hidden="true" />Ready</span>
                  ) : account.connected ? (
                    <span className="account-needed"><IconAlertTriangle aria-hidden="true" />Connected · funding needed</span>
                  ) : (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void connectAccount(account.name)}
                    >{account.action}</button>
                  )}
                </article>
              )})}
            </div>
            <div className="account-footnote"><IconLock aria-hidden="true" /><p><strong>Your money stays where it is.</strong> DayTradingBot never needs permission to withdraw or transfer money.</p></div>
          </section>
        ) : null}

        {view === "activity" ? (
          <section className="activity-view">
            <div className="history-toolbar">
              <div><p className="eyebrow">Recorded activity</p><h2>Practice and Real stay separate</h2></div>
              <div className="history-filters" aria-label="Filter trading history">
                {(["all", "practice", "real"] as ActivityFilter[]).map((filter) => (
                  <button type="button" key={filter} className={activityFilter === filter ? "active" : ""} aria-pressed={activityFilter === filter} onClick={() => setActivityFilter(filter)}>
                    {filter === "all" ? "All records" : filter === "practice" ? "Practice" : "Real money"}
                  </button>
                ))}
              </div>
            </div>
            <div className="history-status">
              {currentLiveState === "unavailable" ? <IconAlertTriangle aria-hidden="true" /> : currentLiveState === "checking" ? <IconSearch aria-hidden="true" /> : currentLiveState === "waiting" ? <IconClock aria-hidden="true" /> : <IconPlayerPause aria-hidden="true" />}
              <div><strong>{liveStateCopy[currentLiveState].title}</strong><span>{currentLiveState === "unavailable" ? "Recorded history remains available." : engine.message}</span></div>
            </div>
            {activityState !== "ready" ? (
              <div className="empty-panel" role={activityState === "unavailable" ? "alert" : "status"}>
                {activityState === "loading" ? <IconLoader2 className="spin" aria-hidden="true" /> : <IconAlertTriangle aria-hidden="true" />}
                <strong>{activityLifecycleCopy.title}</strong>
                <p>{activityLifecycleCopy.detail}</p>
                {activityState === "unavailable" ? <button className="secondary-button" type="button" onClick={() => void loadActivity(true).catch(() => undefined)}>Try activity again</button> : null}
              </div>
            ) : null}
            <div className="history-groups">
              {historyGroups.map((group) => (
                <section className="history-day" key={group.key} aria-labelledby={`history-${group.key}`}>
                  <header>
                    <div><IconCalendar aria-hidden="true" /><h3 id={`history-${group.key}`}>{group.label}</h3></div>
                    <span>{group.practiceCount} Practice events · {group.realCount} Real events loaded</span>
                  </header>
                  <div className="timeline">
                    {group.items.map((item) => (
                      <article className={item.kind === "error" ? "timeline-row warning" : "timeline-row"} key={item.id}>
                        <span className={`event-icon ${item.kind}`}>{item.kind === "error" ? <IconAlertTriangle aria-hidden="true" /> : item.kind === "market_check" ? <IconSearch aria-hidden="true" /> : item.kind === "paused" ? <IconPlayerPause aria-hidden="true" /> : <IconCircleCheck aria-hidden="true" />}</span>
                        <time>{activityTime(item.occurred_at)}</time>
                        <div><strong>{item.message}</strong><p>{item.agent_id === "bluechip" ? "Bluechip" : item.agent_id} · {item.mode === "practice" ? "Practice · no real order" : "Real trading record"}{item.amount_usd ? ` · ${money(Number(item.amount_usd))}` : ""}</p></div>
                        <span className={`history-mode ${item.mode}`}>{item.mode === "practice" ? "Practice" : "Real"}</span>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
              {activityState === "ready" && !historyGroups.length ? (
                <div className="empty-panel"><IconHistory aria-hidden="true" /><strong>No {activityFilter === "all" ? "" : activityFilter === "practice" ? "Practice " : "Real "}records yet</strong><p>{activityFilter === "real" ? "Real trading records will appear only after you explicitly review and start Real Trading." : "Start Practice to see Bluechip work without using real money."}</p></div>
              ) : null}
            </div>
          </section>
        ) : null}
      </main>

      {setupOpen ? (
        <div className="modal-backdrop" role="presentation" ref={setupBackdrop}>
          <section className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" aria-describedby={startPending ? "setup-start-pending-status" : undefined} aria-busy={startPending} ref={setupDialog} tabIndex={-1}>
            <header>
              <div><p>Step {setupStep} of 4</p><h2 id="setup-title">{setupStep === 1 ? "Connect your accounts" : setupStep === 2 ? "Choose your trading agent" : setupStep === 3 ? "Set your limits" : "Choose how to start"}</h2></div>
              <button type="button" onClick={() => { if (!startPending) setSetupOpen(false); }} aria-label="Close setup" ref={setupClose} disabled={startPending}><IconX aria-hidden="true" /></button>
            </header>
            <div className="setup-progress" aria-hidden="true">{[1, 2, 3, 4].map((step) => <span className={step <= setupStep ? "complete" : ""} key={step} />)}</div>
            {startPending ? <p id="setup-start-pending-status" role="status">Starting {mode === "practice" ? "Practice" : "Real Trading"}… DayTradingBot is waiting for an authoritative result. This window will close after the attempt finishes.</p> : null}

            {setupStep === 1 ? (
              <div className="setup-body">
                <p className="setup-lead">Start with one account. You can add more later.</p>
                <div className="setup-account-list">
                  {accounts.map((account) => (
                    <div className="setup-account" key={account.name}>
                      <span className="account-logo">{accountIcon(account.name)}</span>
                      <div>
                        <strong>{account.name}</strong>
                        <small>
                          {account.readback === "checking"
                            ? "Checking saved connection…"
                            : account.readback === "unavailable"
                              ? "Connection status unavailable"
                              : account.connected && account.funded
                                ? "Connection and funds verified"
                                : account.connected
                                  ? "Connected · funding needed before Real Trading"
                                : account.detail}
                        </small>
                      </div>
                      {account.readback === "checking" ? (
                        <span className="check checking" aria-label="Checking saved connection"><IconLoader2 className="spin" aria-hidden="true" /></span>
                      ) : account.readback === "available" && account.connected && account.funded ? <span className="check active" aria-label="Connection and funds verified"><IconCheck aria-hidden="true" /></span> : account.readback === "available" && account.connected ? <span className="check" aria-label="Connected; funding needed before Real Trading"><IconAlertTriangle aria-hidden="true" /></span> : (
                        <button
                          className="setup-connect"
                          type="button"
                          disabled={busy || checkingConnections}
                          onClick={() => void (account.readback === "unavailable" ? refreshAccount(account.name) : connectAccount(account.name))}
                        >{account.readback === "unavailable" ? "Try again" : account.action}</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {setupStep === 2 ? (
              <div className="setup-body">
                <div className="setup-agent-head"><p className="setup-lead">Choose one yourself, or let DayTradingBot match an agent to your connected accounts.</p><button className="pick-button" type="button" onClick={pickForMe} disabled={catalogState !== "ready"}>Pick for me</button></div>
                {catalogState !== "ready" ? (
                  <div className="empty-panel" role={catalogState === "unavailable" ? "alert" : "status"}>
                    {catalogState === "loading" ? <IconLoader2 className="spin" aria-hidden="true" /> : <IconAlertTriangle aria-hidden="true" />}
                    <strong>{catalogLifecycleCopy.title}</strong>
                    <p>{catalogLifecycleCopy.detail}</p>
                    {catalogState === "unavailable" ? <button className="secondary-button" type="button" onClick={() => void loadCatalog(true).catch(() => undefined)}>Try agent catalog again</button> : null}
                  </div>
                ) : null}
                <div className="setup-agent-list">
                  {catalog.filter((agent) => agent.customer_ready).slice(0, 6).map((agent) => <button className={selectedIds.includes(agent.id) ? "setup-agent selected" : "setup-agent"} type="button" key={agent.id} onClick={() => toggleAgent(agent.id)}><span className="agent-avatar"><IconRobot aria-hidden="true" /></span><div><strong>{agent.name}</strong><small>{agent.account} · {agent.summary}</small></div><span>{selectedIds.includes(agent.id) ? <IconCircleCheck aria-label="Selected" /> : <IconCircleDot aria-label="Not selected" />}</span></button>)}
                </div>
              </div>
            ) : null}

            {setupStep === 3 ? (
              <div className="setup-body limits-body">
                <div className="limit-control">
                  <div><label htmlFor="daily-trading-limit">Daily trading limit</label><strong>{money(dailyBudget)}</strong></div>
                  <input
                    id="daily-trading-limit"
                    className="money-limit-input"
                    type="number"
                    inputMode="numeric"
                    min={dailyLimitMinimum}
                    max={dailyLimitMaximum}
                    step="1"
                    value={dailyBudget}
                    aria-valuetext={`${money(dailyBudget)} daily maximum`}
                    aria-describedby="daily-limit-help"
                    onChange={(event) => {
                      const limits = normalizeTradingLimits(Number(event.target.value), perTrade);
                      setDailyBudget(limits.dailyBudget);
                      setPerTrade(limits.perTrade);
                    }}
                  />
                  <small id="daily-limit-help">{limitPlanCopy(dailyBudget, perTrade)} You choose this amount; Bluechip can use less when Robinhood buying power is lower.</small>
                </div>
                <div className="limit-control">
                  <div><label htmlFor="per-trade-limit">Most in one trade</label><strong>{money(perTrade)}</strong></div>
                  <input
                    id="per-trade-limit"
                    className="money-limit-input"
                    type="number"
                    inputMode="numeric"
                    min={perTradeMinimum}
                    max={Math.min(perTradeMaximum, dailyBudget)}
                    step="1"
                    value={perTrade}
                    aria-valuetext={`${money(perTrade)} maximum per trade`}
                    aria-describedby="per-trade-help"
                    onChange={(event) => {
                      const limits = normalizeTradingLimits(dailyBudget, Number(event.target.value));
                      setDailyBudget(limits.dailyBudget);
                      setPerTrade(limits.perTrade);
                    }}
                  />
                  <small id="per-trade-help">This is a maximum, not a required amount. Bluechip automatically uses less when your remaining daily limit or Robinhood buying power is lower.</small>
                </div>
                <p className="risk-line">{setupRiskCopy}</p>
              </div>
            ) : null}

            {setupStep === 4 ? (
              <div className="setup-body mode-body">
                <button className={mode === "practice" ? "mode-choice selected" : "mode-choice"} type="button" onClick={() => setMode("practice")} aria-pressed={mode === "practice"} disabled={startPending}><span>Practice</span><strong>See the agents work without using real money.</strong><small>Recommended for your first run</small></button>
                <button className={mode === "real" ? "mode-choice selected" : "mode-choice"} type="button" onClick={() => setMode("real")} aria-pressed={mode === "real"} disabled={startPending}><span>Real trading</span><strong>Use money in your connected accounts.</strong><small>{licensePresentation.state === "checking" ? "Checking app activation…" : licensePresentation.state === "unavailable" ? "Activation status unavailable · Real Trading stays off" : !licensePresentation.realTradingReady ? "Enter your access code once before starting" : realAccountReadiness.ready ? "App activated · Robinhood buying power verified · every trade can lose money" : realAccountReadiness.message}</small></button>
                <div className="start-summary"><span>{selectedAgents.map((agent) => agent.name).join(" + ") || "Choose an agent"}</span><strong>{money(dailyBudget)} today · {money(perTrade)} per trade</strong></div>
              </div>
            ) : null}

            <footer>
              <button className="back-button" type="button" onClick={() => { if (startPending) return; setupStep === 1 ? setSetupOpen(false) : setSetupStep((step) => step - 1); }} disabled={startPending}>{setupStep === 1 ? "Close" : "Back"}</button>
              {running ? <button className="pause-button" type="button" onClick={pause} disabled={pausePending}><IconPlayerPause aria-hidden="true" />{pauseActionLabel}</button> : null}
              {setupStep < 4 ? <button className="continue-button" type="button" onClick={finishSetupStep} disabled={startPending}>Continue</button> : <button className="continue-button" type="button" onClick={() => void start()} disabled={busy || !controlGate.canStartOrReview || !tradingModeAccountReady(mode, realAccountReadiness.ready)}>{startPending ? "Starting…" : mode === "practice" ? "Start Practice" : "Review real trading"}</button>}
            </footer>
          </section>
        </div>
      ) : null}

      {realReviewOpen ? (
        <div className="modal-backdrop highest" role="presentation" ref={realReviewBackdrop}>
          <section className="real-review" role="alertdialog" aria-modal="true" aria-labelledby="real-review-title" aria-describedby={startPending ? "real-review-description real-start-pending-status" : "real-review-description"} aria-busy={startPending} ref={realReviewDialog} tabIndex={-1}>
            <p className="eyebrow">Real money</p>
            <h2 id="real-review-title">Allow Bluechip to trade on Robinhood?</h2>
            <p id="real-review-description">For up to 24 hours, Bluechip may place recurring market buys in your dedicated Robinhood Agentic account. It cannot transfer or withdraw money. Every trade can lose its full value.</p>
            <dl>
              <div><dt>Trading agent</dt><dd>{selectedAgents.map((agent) => agent.name).join(", ")}</dd></div>
              <div><dt>Stocks Bluechip may choose</dt><dd>AAPL, NVDA, TSLA, SPY, QQQ, AMD, MSFT, or GOOGL</dd></div>
              <div><dt>Order</dt><dd>Buy at the current market price, in U.S. dollars</dd></div>
              <div><dt>Daily cap</dt><dd>{authorizationSummary.dailyCap}</dd></div>
              <div><dt>Maximum possible total</dt><dd>{authorizationSummary.maximumPossibleTotal}</dd></div>
              <div><dt>Maximum per trade</dt><dd>{authorizationSummary.perTradeCap}</dd></div>
              <div><dt>Permission</dt><dd>Recurring for up to 24 hours, or until you pause it</dd></div>
            </dl>
            {startPending ? <p id="real-start-pending-status" role="status">Starting Real Trading… DayTradingBot is waiting for an authoritative result. This review will close after the attempt finishes.</p> : null}
            <div className="review-actions"><button className="back-button" type="button" onClick={() => { if (!startPending) setRealReviewOpen(false); }} ref={realReviewCancel} disabled={startPending}>Go back</button>{running ? <button className="pause-button" type="button" onClick={pause} disabled={pausePending}><IconPlayerPause aria-hidden="true" />{pauseActionLabel}</button> : null}<button className="danger-start" type="button" onClick={() => void start(true)} disabled={busy || !controlGate.canStartOrReview || !realAccountReadiness.ready || !licensePresentation.realTradingReady}>{startPending ? "Starting…" : "Allow these trades for 24 hours"}</button></div>
          </section>
        </div>
      ) : null}

      {credentialAccount ? (
        <div className="modal-backdrop highest" role="presentation" ref={credentialBackdrop}>
          <section className="credential-modal" role="dialog" aria-modal="true" aria-labelledby="credential-title" aria-describedby={credentialSavePending ? "credential-save-pending-status" : undefined} aria-busy={credentialSavePending} ref={credentialDialog} tabIndex={-1}>
            <header>
              <div><p className="eyebrow">Connect account</p><h2 id="credential-title">{credentialAccount}</h2></div>
              <button type="button" onClick={() => { if (credentialSavePending) return; setCredentialFields({ first: "", second: "" }); setCredentialAccount(null); }} aria-label="Close account connection" ref={credentialClose} disabled={credentialSavePending}><IconX aria-hidden="true" /></button>
            </header>
            <p>{credentialAccount === "Coinbase" ? "Use an Advanced Trade key with View and Trade only. Leave transfer and withdrawal permissions off." : credentialAccount === "Kalshi" ? "Create a trading API key in Kalshi, then paste the key ID and private key below." : "Use a Polymarket US developer key from your approved retail account."}</p>
            <label>
              <span>{credentialAccount === "Coinbase" ? "API key name" : "Key ID"}</span>
              <input type="text" autoComplete="off" spellCheck={false} value={credentialFields.first} onChange={(event) => setCredentialFields((fields) => ({ ...fields, first: event.target.value }))} disabled={credentialSavePending} />
            </label>
            <label>
              <span>{credentialAccount === "Polymarket" ? "Secret key" : "Private key"}</span>
              <textarea className="secret-field" autoComplete="off" spellCheck={false} rows={6} value={credentialFields.second} onChange={(event) => setCredentialFields((fields) => ({ ...fields, second: event.target.value }))} disabled={credentialSavePending} />
            </label>
            <small>Your key is checked directly with {credentialAccount} and saved only in this computer’s secure storage.</small>
            {credentialSavePending ? <p id="credential-save-pending-status" role="status">Checking and securely saving the {credentialAccount} connection… This window will close after DayTradingBot confirms the result.</p> : null}
            <footer>
              <button className="back-button" type="button" onClick={() => { if (credentialSavePending) return; setCredentialFields({ first: "", second: "" }); setCredentialAccount(null); }} disabled={credentialSavePending}>Cancel</button>
              {running ? <button className="pause-button" type="button" onClick={pause} disabled={pausePending}><IconPlayerPause aria-hidden="true" />{pauseActionLabel}</button> : null}
              <button className="continue-button" type="button" disabled={busy || credentialSavePending} onClick={() => void submitCredentials()}>{credentialSavePending ? "Saving connection…" : `Connect ${credentialAccount}`}</button>
            </footer>
          </section>
        </div>
      ) : null}

      {activationOpen ? (
        <div className="modal-backdrop highest" role="presentation" ref={activationBackdrop}>
          <section className="credential-modal activation-modal" role="dialog" aria-modal="true" aria-labelledby="activation-title" aria-describedby={activationPending ? "activation-pending-status" : undefined} aria-busy={activationPending} ref={activationDialog} tabIndex={-1}>
            <header>
              <div><p className="eyebrow">One-time setup</p><h2 id="activation-title">Activate DayTradingBot</h2></div>
              <button type="button" onClick={() => { if (activationPending) return; setPurchaseCode(""); setActivationOpen(false); }} aria-label="Close activation" ref={activationClose} disabled={activationPending}><IconX aria-hidden="true" /></button>
            </header>
            {activationPending ? (
              <p id="activation-pending-status" role="status">Activating DayTradingBot… This window will close after the app confirms whether activation completed.</p>
            ) : licensePresentation.state === "checking" ? (
              <p role="status"><IconLoader2 className="spin" aria-hidden="true" /> Checking activation status…</p>
            ) : licensePresentation.state === "unavailable" ? (
              <p role="alert">The app could not confirm whether this copy is activated. Real Trading stays off until activation status is available.</p>
            ) : licensePresentation.realTradingReady ? (
              <p>This app is activated for real trading on this computer. Practice and real trading are both available.</p>
            ) : (
              <>
                <p>Enter your access code. One code can be active on one computer at a time.</p>
                <label>
                  <span>Access code</span>
                  <input className="secret-field" type="password" autoComplete="off" spellCheck={false} placeholder="DTB-…" value={purchaseCode} onChange={(event) => setPurchaseCode(event.target.value.toUpperCase())} disabled={activationPending} />
                </label>
                <small>The code only activates the app. Your brokerage and wallet connections remain on this computer.</small>
              </>
            )}
            <footer>
              <button className="back-button" type="button" onClick={() => { if (activationPending) return; setPurchaseCode(""); setActivationOpen(false); }} disabled={activationPending}>Close</button>
              {running ? <button className="pause-button" type="button" onClick={pause} disabled={pausePending}><IconPlayerPause aria-hidden="true" />{pauseActionLabel}</button> : null}
              {!activationPending && licensePresentation.state === "unavailable" ? <button className="continue-button" type="button" onClick={() => void checkLicense()}>Check activation again</button> : null}
              {activationPending ? <button className="continue-button" type="button" disabled>Activating…</button> : licensePresentation.state === "not-activated" ? <button className="continue-button" type="button" disabled={busy} onClick={() => void activate()}>Activate app</button> : null}
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
