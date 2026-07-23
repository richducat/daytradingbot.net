import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

type View = "watch" | "agents" | "accounts" | "activity";
type TradingMode = "practice" | "real";
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

type ActivityItem = {
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
    message: "Bot status is unavailable. Do not assume trading is paused.",
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
const dailyLimitMaximum = 25;
const perTradeMinimum = 1;
const perTradeMaximum = 5;
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
    hide_top_toolbar: false,
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
  DAILY_BUDGET_MUST_BE_BETWEEN_1_AND_25: "Choose a daily limit from $1 to $25 in Setup.",
  TRADE_LIMIT_MUST_BE_BETWEEN_1_AND_5: "Choose $1 to $5 per trade, without going over your daily limit.",
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

function accountInitial(name: string) {
  return name === "Robinhood" ? "R" : name === "Coinbase" ? "C" : name === "Kalshi" ? "K" : "P";
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
      {loadState === "loading" ? <div className="chart-loading" role="status"><span /><strong>Loading the market chart…</strong></div> : null}
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
  const [busy, setBusy] = useState(false);
  const [pendingTradingAction, setPendingTradingAction] = useState<"start" | "pause" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [watch, setWatch] = useState<BluechipWatchState>(emptyWatch);
  const [selectedSymbol, setSelectedSymbol] = useState<WatchSymbol>("AAPL");
  const [followLatest, setFollowLatest] = useState(true);
  const [license, setLicense] = useState<LicenseStatus>(emptyLicense);
  const [activationOpen, setActivationOpen] = useState(false);
  const [purchaseCode, setPurchaseCode] = useState("");
  const renewalAttempted = useRef(false);
  const setupBackdrop = useRef<HTMLDivElement>(null);
  const setupDialog = useRef<HTMLElement>(null);
  const setupClose = useRef<HTMLButtonElement>(null);
  const realReviewBackdrop = useRef<HTMLDivElement>(null);
  const realReviewDialog = useRef<HTMLElement>(null);
  const realReviewCancel = useRef<HTMLButtonElement>(null);

  const receiveEngineStatus = (result: OwnerEngineStatus) => {
    setEngine(result);
    setEngineReadbackAvailable(true);
    if (result.selected_agent_ids.length) setSelectedIds(result.selected_agent_ids);
    if (result.mode === "practice" || result.mode === "real") setMode(result.mode);
  };

  const refresh = async () => {
    const catalogRequest = invoke<AgentCatalog>("trading_agent_catalog").then((result) => {
      setCatalog(result.agents);
      const ready = new Set(result.agents.filter((agent) => agent.customer_ready).map((agent) => agent.id));
      setSelectedIds((current) => current.filter((id) => ready.has(id)));
    });
    const engineRequest = invoke<OwnerEngineStatus>("owner_engine_status")
      .then(receiveEngineStatus)
      .catch((error: unknown) => {
        setEngineReadbackAvailable(false);
        throw error;
      });
    void invoke<ActivityItem[]>("recent_trading_activity").then(setActivity).catch(() => undefined);
    const watchRequest = invoke<NativeBluechipWatchState>("bluechip_watch_state")
      .then((snapshot) => setWatch(availableWatchState(snapshot)))
      .catch((error: unknown) => {
        setWatch((current) => unavailableWatchState(current));
        throw error;
      });
    const licenseRequest = invoke<LicenseStatus>("entry_license_status").then(setLicense);

    await Promise.allSettled([catalogRequest, engineRequest, watchRequest, licenseRequest]);
  };

  const refreshAccount = async (account: AccountName) => {
    if (account === "Robinhood") {
      setRobinhood(await invoke<RobinhoodStatus>("robinhood_owner_demo_status"));
    } else if (account === "Coinbase") {
      setCoinbase(await invoke<CoinbaseStatus>("coinbase_owner_demo_status"));
    } else if (account === "Kalshi") {
      setSimmer(await invoke<SimmerStatus>("kalshi_owner_demo_status"));
    } else {
      setPolymarket(await invoke<PolymarketStatus>("polymarket_us_owner_demo_status"));
    }
  };

  const checkAllConnections = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const results = await Promise.allSettled(
        (["Robinhood", "Coinbase", "Kalshi", "Polymarket"] satisfies AccountName[])
          .map((account) => withTimeout(refreshAccount(account), connectionCheckTimeoutMs)),
      );
      const unavailable = results.filter((result) => result.status === "rejected").length;
      setNotice(unavailable
        ? `Connections checked. ${unavailable} ${unavailable === 1 ? "account" : "accounts"} could not be reached; nothing was changed.`
        : "Saved account connections checked.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void invoke<OwnerEngineStatus>("owner_engine_status")
        .then(receiveEngineStatus)
        .catch(() => setEngineReadbackAvailable(false));
      void invoke<ActivityItem[]>("recent_trading_activity").then(setActivity).catch(() => undefined);
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
    void invoke<LicenseStatus>("renew_license")
      .then(setLicense)
      .catch(() => undefined);
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
    const focusFrame = window.requestAnimationFrame(() => setupClose.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
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
  }, [activationOpen, credentialAccount, realReviewOpen, setupOpen]);

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
    window.requestAnimationFrame(() => realReviewCancel.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setRealReviewOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) return;
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
      document.removeEventListener("keydown", handleKeyDown);
      siblings.forEach(({ element, wasInert }) => { element.inert = wasInert; });
      previouslyFocused?.focus();
    };
  }, [realReviewOpen]);

  const accounts = useMemo<Array<{ name: AccountName; detail: string; connected: boolean; funded: boolean; action: string }>>(
    () => [
      {
        name: "Robinhood",
        detail: "Stocks and ETFs",
        connected: robinhood.authenticated && robinhood.agentic_account_available,
        funded: robinhood.has_buying_power,
        action: "Connect",
      },
      {
        name: "Coinbase",
        detail: "Bitcoin and Ethereum",
        connected: coinbase.authenticated && coinbase.least_privilege_live_scope,
        funded: coinbase.has_btc_or_eth_account,
        action: "Add account",
      },
      {
        name: "Kalshi",
        detail: "Event contracts",
        connected: simmer.authenticated && simmer.direct_api_configured,
        funded: simmer.has_spendable_balance,
        action: simmer.owner_import_available && !simmer.configured ? "Use connected account" : "Connect",
      },
      {
        name: "Polymarket",
        detail: "Prediction markets",
        connected: polymarket.authenticated || (simmer.authenticated && simmer.wallet_configured),
        funded: polymarket.has_buying_power || simmer.has_spendable_balance,
        action: "Connect wallet",
      },
    ],
    [coinbase, polymarket, robinhood, simmer],
  );

  const connectedNames = useMemo(() => new Set<string>(accounts.filter((account) => account.connected).map((account) => account.name)), [accounts]);
  const selectedAgents = catalog.filter((agent) => selectedIds.includes(agent.id));
  const running = engineReadbackAvailable
    && (engine.mode === "practice" || engine.mode === "real");

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
    if (!credentialAccount || !credentialFields.first.trim() || !credentialFields.second.trim()) {
      setNotice("Complete both fields to connect this account.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      if (credentialAccount === "Coinbase") {
        await invoke("connect_coinbase_account", {
          request: { key_name: credentialFields.first.trim(), private_key_pem: credentialFields.second.trim() },
        });
      } else if (credentialAccount === "Kalshi") {
        await invoke("connect_kalshi_account", {
          request: { api_key_id: credentialFields.first.trim(), private_key_pem: credentialFields.second.trim() },
        });
      } else {
        await invoke("connect_polymarket_us_account", {
          request: { key_id: credentialFields.first.trim(), secret_key: credentialFields.second.trim() },
        });
      }
      const connected = credentialAccount;
      setCredentialFields({ first: "", second: "" });
      setCredentialAccount(null);
      setNotice(`${connected} is connected.`);
      await Promise.all([refresh(), refreshAccount(connected)]);
    } catch (error) {
      setNotice(messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  const start = async (confirmed = false) => {
    if (!engineReadbackAvailable) {
      setNotice("Trading engine status is unavailable. Check status before starting.");
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
    if (mode === "real" && !license.real_trading_ready) {
      setRealReviewOpen(false);
      setActivationOpen(true);
      return;
    }
    if (mode === "real" && !confirmed) {
      setRealReviewOpen(true);
      return;
    }
    setBusy(true);
    setPendingTradingAction("start");
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
      setPendingTradingAction(null);
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!purchaseCode.trim()) {
      setNotice("Enter your DayTradingBot access code.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await invoke<LicenseStatus>("activate_license", {
        request: { license_code: purchaseCode.trim() },
      });
      setLicense(result);
      setPurchaseCode("");
      setActivationOpen(false);
      setNotice("DayTradingBot is activated. You can now review and start real trading.");
    } catch (error) {
      setNotice(messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  const pause = async () => {
    setBusy(true);
    setPendingTradingAction("pause");
    setNotice(null);
    try {
      const result = await invoke<SessionResult>("pause_owner_engine_session");
      setNotice(result.message);
      await refresh();
    } catch (error) {
      setNotice(messageFromError(error));
    } finally {
      setPendingTradingAction(null);
      setBusy(false);
    }
  };

  const finishSetupStep = () => {
    if (setupStep === 2 && !selectedIds.length) {
      setNotice("Choose a trading agent or use Pick for me.");
      return;
    }
    if (setupStep < 4) setSetupStep((step) => step + 1);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" type="button" onClick={() => setView("watch")} aria-label="Watch DayTradingBot">
          <span>DTB</span>
          <strong>DayTradingBot</strong>
        </button>
        <nav aria-label="Main navigation">
          {(["watch", "agents", "accounts", "activity"] as View[]).map((item) => (
            <button className={view === item ? "nav-item active" : "nav-item"} type="button" key={item} onClick={() => setView(item)}>
              {item === "watch" ? "Watch bot" : item === "agents" ? "Trading agents" : item === "accounts" ? "Accounts" : "Activity"}
            </button>
          ))}
        </nav>
        <button className="setup-link" type="button" onClick={() => setSetupOpen(true)}>Setup</button>
        <button className={license.real_trading_ready ? "activation-link ready" : "activation-link"} type="button" onClick={() => setActivationOpen(true)}>{license.real_trading_ready ? "App activated" : "Activate app"}</button>
        <div className="engine-note">
          <span className={engineReadbackAvailable && engine.available ? "online" : ""} />
          {!engineReadbackAvailable ? "Engine status unavailable" : engine.available ? "Trading engine ready" : "Installer needed"}
        </div>
      </aside>

      <main className={view === "watch" ? "main-area watch-main" : "main-area"}>
        <header className="topbar">
          <div>
            <p>{view === "watch" ? "Bluechip · eight-symbol watch" : view === "agents" ? "Choose who trades" : view === "accounts" ? "Your money stays in your accounts" : "Every move, in one place"}</p>
            <h1>{view === "watch" ? "Watch bot" : view === "agents" ? "Trading agents" : view === "accounts" ? "Accounts" : "Activity"}</h1>
          </div>
          {view !== "watch" && !engineReadbackAvailable ? (
            <button className="pause-button" type="button" disabled>Check status first</button>
          ) : view !== "watch" && running ? (
            <button className="pause-button" type="button" onClick={pause} disabled={busy}>{pendingTradingAction === "pause" ? "Pausing…" : "Pause trading"}</button>
          ) : view !== "watch" ? (
            <button className="start-button compact" type="button" onClick={() => void start()} disabled={busy}>{pendingTradingAction === "pause" ? "Pausing…" : pendingTradingAction === "start" ? "Starting…" : "Start trading"}</button>
          ) : null}
        </header>

        {notice ? <div className="notice" role="status"><span />{notice}<button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div> : null}

        {view === "watch" ? (() => {
          const currentDecision = activity.find((item) => (
            item.symbol === selectedSymbol
            && ["signal", "skipped", "reviewed", "order_submitted", "filled", "error"].includes(item.kind)
          ));
          const selectedEvents = activity
            .filter((item) => item.symbol === selectedSymbol)
            .slice(0, 5);
          const activeMode = watchDisplayMode(watch);
          const dailyLimit = watch.daily_limit_usd ? money(Number(watch.daily_limit_usd)) : "Unavailable";
          const perTradeLimit = watch.per_trade_limit_usd ? money(Number(watch.per_trade_limit_usd)) : "Unavailable";
          return (
            <div className="watch-view">
              <section className={`watch-state ${activeMode}`} aria-labelledby="watch-state-title">
                <div className="watch-state-copy">
                  <div className="mode-line">
                    <span className={`mode-badge ${activeMode}`}>
                      {activeMode === "practice"
                        ? "Practice · No real order or money"
                        : activeMode === "real"
                          ? "Real money"
                          : activeMode === "unavailable"
                            ? "Status unavailable · Do not assume paused"
                            : "Paused · No new trades"}
                    </span>
                    <span>Bluechip · checks every 15 minutes</span>
                  </div>
                  <h2 id="watch-state-title">{watch.message}</h2>
                  <div className="check-times">
                    <span><small>Last known check</small><strong>{watchTime(watch.last_checked_at, watch.status_available ? watch.running ? "Starting now" : "Not running" : "Unavailable")}</strong></span>
                    <span><small>Next check</small><strong>{watchTime(watch.next_check_at, watch.status_available ? watch.running ? "After this check" : "Starts when you do" : "Unavailable")}</strong></span>
                  </div>
                </div>
                <div className="watch-action">
                  {!engineReadbackAvailable ? (
                    <button className="pause-button wide" type="button" disabled>Check status first</button>
                  ) : running ? (
                    <button className="pause-button wide" type="button" onClick={pause} disabled={busy}>{pendingTradingAction === "pause" ? "Pausing…" : "Pause new trades"}</button>
                  ) : (
                    <button className="start-button wide" type="button" onClick={() => void start()} disabled={busy}>{pendingTradingAction === "start" ? "Starting…" : mode === "practice" ? "Start Practice" : "Review Real"}</button>
                  )}
                  <button className="watch-settings" type="button" onClick={() => setSetupOpen(true)}>Review setup</button>
                </div>
              </section>

              {!watch.status_available ? (
                <div className="order-warning" role="alert">Bot status and daily money readback are unavailable. Do not assume trading is paused or treat a missing amount as zero. An existing order may still fill.</div>
              ) : watch.has_unresolved_real_order ? (
                <div className="order-warning" role="status">An earlier real order still needs an authoritative status check. Pausing blocks new trades; an existing order may still fill.</div>
              ) : null}

              <section className={`budget-strip ${watch.budget_state}`} aria-label={watch.budget_state === "practice" ? "Practice decision limits" : "Daily new-buy budget"}>
                {watch.budget_state === "practice" ? (
                  <>
                    <div><span>Practice daily limit setting</span><strong>{dailyLimit}</strong><small>No cumulative money is tracked</small></div>
                    <div><span>Most in one practice decision</span><strong>{perTradeLimit}</strong><small>No order is sent</small></div>
                    <p>Practice does not create cumulative money used, pending, or remaining.</p>
                  </>
                ) : watch.budget_state === "paused" ? (
                  <>
                    <div><span>Next-run daily limit</span><strong>{money(dailyBudget)}</strong><small>Setup value · not active</small></div>
                    <div><span>Next-run per trade</span><strong>{money(perTrade)}</strong><small>Setup value · not active</small></div>
                    <p>Start Practice or Real to see the active backend limits here.</p>
                  </>
                ) : (
                  <>
                    <div><span>Daily new-buy limit</span><strong>{dailyLimit}</strong><small>Opening-notional cap</small></div>
                    <div><span>Used or held</span><strong>{watch.used_or_held_usd ? money(Number(watch.used_or_held_usd)) : "Unavailable"}</strong><small>Committed + pending</small></div>
                    <div><span>Pending</span><strong>{watch.pending_usd ? money(Number(watch.pending_usd)) : "Unavailable"}</strong><small>Included in Used</small></div>
                    <div><span>Committed</span><strong>{watch.committed_usd ? money(Number(watch.committed_usd)) : "Unavailable"}</strong><small>Durable today</small></div>
                    <div><span>Remaining</span><strong>{watch.remaining_usd ? money(Number(watch.remaining_usd)) : "Unavailable"}</strong><small>For new buys</small></div>
                    <div><span>Per trade</span><strong>{perTradeLimit}</strong><small>Maximum</small></div>
                  </>
                )}
              </section>

              <section className="watch-workspace">
                <div className="chart-column">
                  <header className="chart-heading">
                    <div><p className="eyebrow">Market context</p><h3>{selectedSymbol} · 5-minute candles</h3></div>
                    <button className={followLatest ? "follow-button active" : "follow-button"} type="button" onClick={() => setFollowLatest(true)}>{followLatest ? "Following bot" : "Follow bot"}</button>
                  </header>
                  <div className="symbol-watchlist" aria-label="Bluechip watchlist">
                    {watchSymbols.map((symbol) => (
                      <button
                        type="button"
                        key={symbol}
                        className={selectedSymbol === symbol ? "active" : ""}
                        aria-pressed={selectedSymbol === symbol}
                        onClick={() => { setSelectedSymbol(symbol); setFollowLatest(false); }}
                      >{symbol}</button>
                    ))}
                  </div>
                  <TradingViewChart symbol={selectedSymbol} />
                  <p className="chart-separation">Chart is for you to follow the market. Bluechip makes decisions from your connected account, not from this chart.</p>
                </div>

                <aside className="decision-column" aria-label={`${selectedSymbol} bot decisions`}>
                  <div className={`decision-card ${currentDecision?.kind ?? "waiting"}`}>
                    <p className="eyebrow">Current decision · {selectedSymbol}</p>
                    <h3>{currentDecision ? eventLabel(currentDecision) : !watch.status_available ? "Bot status unavailable" : watch.running ? "Waiting for this symbol" : "Bot is paused"}</h3>
                    <p>{currentDecision?.message ?? (!watch.status_available ? "Recorded activity remains visible, but the app cannot confirm whether Bluechip is running or paused." : watch.running ? `No recorded ${selectedSymbol} decision in the current activity window. Bluechip will keep checking its fixed watchlist.` : "Start Practice to watch Bluechip decide without sending a real order.")}</p>
                    <dl>
                      <div><dt>Recorded mode</dt><dd>{currentDecision ? currentDecision.mode === "practice" ? "Practice · no order" : "Real" : "—"}</dd></div>
                      <div><dt>Recorded at</dt><dd>{currentDecision ? activityTime(currentDecision.occurred_at) : "—"}</dd></div>
                      <div><dt>{currentDecision?.mode === "practice" ? "Practice decision amount" : "Recorded amount"}</dt><dd>{currentDecision?.amount_usd ? money(Number(currentDecision.amount_usd)) : "Not recorded"}</dd></div>
                    </dl>
                  </div>
                  <div className="event-rail">
                    <div className="rail-heading"><strong>Recorded events</strong><button type="button" onClick={() => setView("activity")}>All activity</button></div>
                    {selectedEvents.length ? selectedEvents.map((item) => (
                      <div className={`rail-event ${item.kind}`} key={item.id}>
                        <span aria-hidden="true" />
                        <div><strong>{eventLabel(item)}</strong><small>{activityTime(item.occurred_at)} · {item.mode === "practice" ? "Practice" : "Real"}</small></div>
                      </div>
                    )) : <p className="empty-events">No {selectedSymbol} events recorded yet.</p>}
                  </div>
                </aside>
              </section>

              <details className="watch-text-alternative">
                <summary>Text and table view of chart context and activity</summary>
                <p>{selectedSymbol} market candles are shown in the TradingView frame above. Bluechip’s separate recorded events are listed below; they are not markers on the TradingView chart.</p>
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
          );
        })() : null}

        {view === "agents" ? (
          <section className="agents-view">
            <div className="view-intro"><div><h2>Choose up to three.</h2><p>Each agent follows a different trading approach. You can change them whenever trading is paused.</p></div><button className="pick-button" type="button" onClick={pickForMe}>Pick for me</button></div>
            <div className="agent-list">
              {catalog.map((agent) => {
                const selected = selectedIds.includes(agent.id);
                const connected = connectedNames.has(agent.account);
                return (
                  <button className={selected ? "agent-row selected" : "agent-row"} type="button" key={agent.id} onClick={() => toggleAgent(agent.id)} disabled={!engineReadbackAvailable || running || !agent.customer_ready}>
                    <span className="agent-avatar">{agent.name.slice(0, 1)}</span>
                    <div className="agent-main"><span><strong>{agent.name}</strong><small>{agent.account} · every {agent.cadence_minutes} minutes</small></span><p>{agent.summary}</p></div>
                    <span className={`risk-tag ${agent.risk_level}`}>{agent.risk_level === "steady" ? "Steady" : agent.risk_level === "balanced" ? "Balanced" : "Active"}</span>
                    <span className={connected ? "account-ready" : "account-needed"}>{!agent.customer_ready ? "Coming next" : connected ? "Account ready" : `Connect ${agent.account}`}</span>
                    <span className="selection-mark">{!agent.customer_ready ? "Not yet" : selected ? "Selected" : "Select"}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {view === "accounts" ? (
          <section className="accounts-view">
            <div className="view-intro"><div><h2>Connect the accounts you want to trade with.</h2><p>Money stays with the broker, exchange, or wallet you already use.</p></div><button className="pick-button" type="button" disabled={busy} onClick={() => void checkAllConnections()}>{busy ? "Checking…" : "Check connections"}</button></div>
            <div className="account-list">
              {accounts.map((account) => (
                <div className="account-row" key={account.name}>
                  <span className="account-logo large">{accountInitial(account.name)}</span>
                  <div><strong>{account.name}</strong><small>{account.detail}</small></div>
                  <div className="account-state"><span className={account.connected ? "state-indicator connected" : "state-indicator"} />{account.connected ? (account.funded ? "Connected and ready" : "Connected · add funds to trade") : "Not connected"}</div>
                  {account.connected ? <button className="secondary-button" type="button">View</button> : (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void connectAccount(account.name)}
                    >{account.action}</button>
                  )}
                </div>
              ))}
            </div>
            <p className="account-footnote">DayTradingBot never needs permission to withdraw or transfer money.</p>
          </section>
        ) : null}

        {view === "activity" ? (
          <section className="activity-view">
            <div className="view-intro"><div><h2>Clear records, without the noise.</h2><p>Market checks, decisions, orders, and results will appear here in time order.</p></div></div>
            <div className="timeline">
              <div className="timeline-row"><span className={running ? "pulse-dot active" : "pulse-dot"} /><time>Now</time><div><strong>{engine.message}</strong><p>{selectedAgents.length ? `${selectedAgents.map((agent) => agent.name).join(", ")} · ${mode === "practice" ? "Practice" : "Real trading"}` : "Choose an agent to begin."}</p></div></div>
              {activity.map((item) => (
                <div className={item.kind === "error" ? "timeline-row warning" : "timeline-row"} key={item.id}>
                  <span className={item.kind === "order_submitted" || item.kind === "filled" ? "pulse-dot active" : "pulse-dot"} />
                  <time>{activityTime(item.occurred_at)}</time>
                  <div><strong>{item.message}</strong><p>{item.agent_id === "bluechip" ? "Bluechip" : item.agent_id} · {item.mode === "practice" ? "Practice" : "Real trading"}{item.amount_usd ? ` · $${Number(item.amount_usd).toFixed(2)}` : ""}</p></div>
                </div>
              ))}
              {!activity.length && engineReadbackAvailable && !running ? <div className="timeline-row muted"><span className="pulse-dot" /><time>Next</time><div><strong>Your first market check</strong><p>Start Practice to watch the agents work without using real money.</p></div></div> : null}
            </div>
          </section>
        ) : null}
      </main>

      {setupOpen ? (
        <div className="modal-backdrop" role="presentation" ref={setupBackdrop}>
          <section className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" ref={setupDialog} tabIndex={-1}>
            <header>
              <div><p>Step {setupStep} of 4</p><h2 id="setup-title">{setupStep === 1 ? "Connect your accounts" : setupStep === 2 ? "Choose your trading agent" : setupStep === 3 ? "Set your limits" : "Choose how to start"}</h2></div>
              <button type="button" onClick={() => setSetupOpen(false)} aria-label="Close setup" ref={setupClose}>×</button>
            </header>
            <div className="setup-progress" aria-hidden="true">{[1, 2, 3, 4].map((step) => <span className={step <= setupStep ? "complete" : ""} key={step} />)}</div>

            {setupStep === 1 ? (
              <div className="setup-body">
                <p className="setup-lead">Start with one account. You can add more later.</p>
                <div className="setup-account-list">
                  {accounts.map((account) => (
                    <div className="setup-account" key={account.name}>
                      <span className="account-logo">{accountInitial(account.name)}</span>
                      <div><strong>{account.name}</strong><small>{account.connected ? (account.funded ? "Connected and ready" : "Connected · add funds to trade") : account.detail}</small></div>
                      {account.connected ? <span className="check active">✓</span> : (
                        <button
                          className="setup-connect"
                          type="button"
                          disabled={busy}
                          onClick={() => void connectAccount(account.name)}
                        >{account.action}</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {setupStep === 2 ? (
              <div className="setup-body">
                <div className="setup-agent-head"><p className="setup-lead">Choose one yourself, or let DayTradingBot match an agent to your connected accounts.</p><button className="pick-button" type="button" onClick={pickForMe}>Pick for me</button></div>
                <div className="setup-agent-list">
                  {catalog.filter((agent) => agent.customer_ready).slice(0, 6).map((agent) => <button className={selectedIds.includes(agent.id) ? "setup-agent selected" : "setup-agent"} type="button" key={agent.id} onClick={() => toggleAgent(agent.id)}><span className="agent-avatar">{agent.name.slice(0, 1)}</span><div><strong>{agent.name}</strong><small>{agent.account} · {agent.summary}</small></div><span>{selectedIds.includes(agent.id) ? "✓" : "+"}</span></button>)}
                </div>
              </div>
            ) : null}

            {setupStep === 3 ? (
              <div className="setup-body limits-body">
                <div className="limit-control">
                  <div><label htmlFor="daily-trading-limit">Daily trading limit</label><strong>{money(dailyBudget)}</strong></div>
                  <input
                    id="daily-trading-limit"
                    type="range"
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
                  <small id="daily-limit-help">{limitPlanCopy(dailyBudget, perTrade)}</small>
                </div>
                <div className="limit-control">
                  <div><label htmlFor="per-trade-limit">Most in one trade</label><strong>{money(perTrade)}</strong></div>
                  <input
                    id="per-trade-limit"
                    type="range"
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
                <button className={mode === "practice" ? "mode-choice selected" : "mode-choice"} type="button" onClick={() => setMode("practice")}><span>Practice</span><strong>See the agents work without using real money.</strong><small>Recommended for your first run</small></button>
                <button className={mode === "real" ? "mode-choice selected" : "mode-choice"} type="button" onClick={() => setMode("real")}><span>Real trading</span><strong>Use money in your connected accounts.</strong><small>{license.real_trading_ready ? "App activated · every trade can lose money" : "Enter your access code once before starting"}</small></button>
                <div className="start-summary"><span>{selectedAgents.map((agent) => agent.name).join(" + ") || "Choose an agent"}</span><strong>{money(dailyBudget)} today · {money(perTrade)} per trade</strong></div>
              </div>
            ) : null}

            <footer>
              <button className="back-button" type="button" onClick={() => setupStep === 1 ? setSetupOpen(false) : setSetupStep((step) => step - 1)}>{setupStep === 1 ? "Close" : "Back"}</button>
              {setupStep < 4 ? <button className="continue-button" type="button" onClick={finishSetupStep}>Continue</button> : <button className="continue-button" type="button" onClick={() => void start()} disabled={busy || !engineReadbackAvailable}>{pendingTradingAction === "start" ? "Starting…" : mode === "practice" ? "Start Practice" : "Review real trading"}</button>}
            </footer>
          </section>
        </div>
      ) : null}

      {realReviewOpen ? (
        <div className="modal-backdrop highest" role="presentation" ref={realReviewBackdrop}>
          <section className="real-review" role="alertdialog" aria-modal="true" aria-labelledby="real-review-title" aria-describedby="real-review-description" ref={realReviewDialog}>
            <p className="eyebrow">Real money</p>
            <h2 id="real-review-title">Allow Bluechip to trade on Robinhood?</h2>
            <p id="real-review-description">For up to 24 hours, Bluechip may place recurring market buys in your dedicated Robinhood Agentic account. It cannot transfer or withdraw money. Every trade can lose its full value.</p>
            <dl>
              <div><dt>Trading agent</dt><dd>{selectedAgents.map((agent) => agent.name).join(", ")}</dd></div>
              <div><dt>Stocks Bluechip may choose</dt><dd>AAPL, NVDA, TSLA, SPY, QQQ, AMD, MSFT, or GOOGL</dd></div>
              <div><dt>Order</dt><dd>Buy at the current market price, in U.S. dollars</dd></div>
              <div><dt>Maximum total</dt><dd>{money(dailyBudget)} per day</dd></div>
              <div><dt>Maximum per trade</dt><dd>{money(perTrade)}</dd></div>
              <div><dt>Permission</dt><dd>Recurring for up to 24 hours, or until you pause it</dd></div>
            </dl>
            <div className="review-actions"><button className="back-button" type="button" onClick={() => setRealReviewOpen(false)} ref={realReviewCancel}>Go back</button><button className="danger-start" type="button" onClick={() => void start(true)} disabled={busy || !engineReadbackAvailable}>{pendingTradingAction === "start" ? "Starting…" : "Allow these trades for 24 hours"}</button></div>
          </section>
        </div>
      ) : null}

      {credentialAccount ? (
        <div className="modal-backdrop highest" role="presentation">
          <section className="credential-modal" role="dialog" aria-modal="true" aria-labelledby="credential-title">
            <header>
              <div><p className="eyebrow">Connect account</p><h2 id="credential-title">{credentialAccount}</h2></div>
              <button type="button" onClick={() => { setCredentialFields({ first: "", second: "" }); setCredentialAccount(null); }} aria-label="Close">×</button>
            </header>
            <p>{credentialAccount === "Coinbase" ? "Use an Advanced Trade key with View and Trade only. Leave transfer and withdrawal permissions off." : credentialAccount === "Kalshi" ? "Create a trading API key in Kalshi, then paste the key ID and private key below." : "Use a Polymarket US developer key from your approved retail account."}</p>
            <label>
              <span>{credentialAccount === "Coinbase" ? "API key name" : "Key ID"}</span>
              <input type="text" autoComplete="off" spellCheck={false} value={credentialFields.first} onChange={(event) => setCredentialFields((fields) => ({ ...fields, first: event.target.value }))} />
            </label>
            <label>
              <span>{credentialAccount === "Polymarket" ? "Secret key" : "Private key"}</span>
              <textarea autoComplete="off" spellCheck={false} rows={6} value={credentialFields.second} onChange={(event) => setCredentialFields((fields) => ({ ...fields, second: event.target.value }))} />
            </label>
            <small>Your key is checked directly with {credentialAccount} and saved only in this computer’s secure storage.</small>
            <footer><button className="back-button" type="button" onClick={() => { setCredentialFields({ first: "", second: "" }); setCredentialAccount(null); }}>Cancel</button><button className="continue-button" type="button" disabled={busy} onClick={() => void submitCredentials()}>{busy ? "Connecting…" : `Connect ${credentialAccount}`}</button></footer>
          </section>
        </div>
      ) : null}

      {activationOpen ? (
        <div className="modal-backdrop highest" role="presentation">
          <section className="credential-modal activation-modal" role="dialog" aria-modal="true" aria-labelledby="activation-title">
            <header>
              <div><p className="eyebrow">One-time setup</p><h2 id="activation-title">Activate DayTradingBot</h2></div>
              <button type="button" onClick={() => setActivationOpen(false)} aria-label="Close">×</button>
            </header>
            {license.real_trading_ready ? (
              <p>This app is activated for real trading on this computer. Practice and real trading are both available.</p>
            ) : (
              <>
                <p>Enter your access code. One code can be active on one computer at a time.</p>
                <label>
                  <span>Access code</span>
                  <input type="text" autoComplete="off" spellCheck={false} placeholder="DTB-…" value={purchaseCode} onChange={(event) => setPurchaseCode(event.target.value.toUpperCase())} />
                </label>
                <small>The code only activates the app. Your brokerage and wallet connections remain on this computer.</small>
              </>
            )}
            <footer>
              <button className="back-button" type="button" onClick={() => setActivationOpen(false)}>Close</button>
              {!license.real_trading_ready ? <button className="continue-button" type="button" disabled={busy} onClick={() => void activate()}>{busy ? "Activating…" : "Activate app"}</button> : null}
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
