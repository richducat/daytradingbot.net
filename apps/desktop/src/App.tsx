import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";

type View = "home" | "agents" | "accounts" | "activity";
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
  symbol: string | null;
  amount_usd: string | null;
  message: string;
  occurred_at: string;
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

const emptyLicense: LicenseStatus = {
  activated: false,
  real_trading_ready: false,
  renewal_needed: false,
  expires_at: null,
  message: "Activate the app before using real money.",
};

const connectionCheckTimeoutMs = 16_000;

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
  ADD_FUNDS_TO_ROBINHOOD: "Add at least the per-trade amount to your Robinhood Agentic account.",
  ORDER_RECONCILIATION_REQUIRED: "One earlier Robinhood order needs to be checked before real trading can continue.",
  SIMMER_ACCOUNT_NOT_CONNECTED: "Connect your Polymarket or Kalshi trading wallet before starting this agent.",
  AGENT_INSTALLATION_INCOMPLETE: "One selected trading agent is not installed yet.",
  TRADING_AGENT_INSTALLATION_INCOMPLETE: "One selected trading agent is not installed in this build yet.",
  REAL_TRADING_CONFIRMATION_REQUIRED: "Please confirm the real-trading summary before starting.",
  ENGINE_ACTION_FAILED: "The trading engine could not start that agent. Nothing was turned on.",
  AGENT_NOT_AVAILABLE_IN_THIS_BUILD: "That agent is coming next and is not available in this app yet.",
  OWNER_ENGINE_NOT_INSTALLED: "The trading engine is not installed on this computer yet.",
  PURCHASE_CODE_NOT_RECOGNIZED: "That purchase code was not recognized. Check the code and try again.",
  PURCHASE_CODE_ACTIVE_ELSEWHERE: "That purchase is already active on another computer.",
  LICENSE_ACTIVATION_UNAVAILABLE: "App activation is temporarily unavailable. Practice still works.",
  LICENSE_ACTIVATION_INVALID: "The activation response could not be verified. Real trading stayed off.",
  LICENSE_STORAGE_UNAVAILABLE: "This computer’s secure storage is unavailable. Real trading stayed off.",
  ACCOUNT_VAULT_UNAVAILABLE: "Mac Keychain did not allow access to that saved account. Nothing was changed.",
  ROBINHOOD_OWNER_VAULT_UNAVAILABLE: "Mac Keychain did not allow access to the saved Robinhood connection. Nothing was changed.",
  COINBASE_OWNER_VAULT_UNAVAILABLE: "Mac Keychain did not allow access to the saved Coinbase connection. Nothing was changed.",
  OWNER_DEMO_VAULT_UNAVAILABLE: "Mac Keychain did not allow access to the saved Kalshi connection. Nothing was changed.",
  POLYMARKET_US_OWNER_VAULT_UNAVAILABLE: "Mac Keychain did not allow access to the saved Polymarket connection. Nothing was changed.",
  KALSHI_AUTHENTICATION_FAILED: "Kalshi did not accept that key. Create a new trading API key and try again.",
  KALSHI_PERMISSION_DENIED: "That Kalshi key cannot view this account.",
  KALSHI_RATE_LIMITED: "Kalshi is receiving too many requests. Wait a moment and check again.",
  KALSHI_CONNECTION_FAILED: "Kalshi could not verify that connection. Nothing was saved.",
};

function messageFromError(error: unknown) {
  const key = String(error).replace(/^Error:\s*/, "");
  return errorCopy[key] ?? "That did not work. Nothing was turned on. Try again or check Accounts.";
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function accountInitial(name: string) {
  return name === "Robinhood" ? "R" : name === "Coinbase" ? "C" : name === "Kalshi" ? "K" : "P";
}

function activityTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Recent";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

export function App() {
  const [view, setView] = useState<View>("home");
  const [catalog, setCatalog] = useState<Agent[]>([]);
  const [engine, setEngine] = useState<OwnerEngineStatus>(emptyEngine);
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
  const [dailyBudget, setDailyBudget] = useState(() => Number(localStorage.getItem("dtb.dailyBudget") ?? 15));
  const [perTrade, setPerTrade] = useState(() => Number(localStorage.getItem("dtb.perTrade") ?? 3));
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
  const [license, setLicense] = useState<LicenseStatus>(emptyLicense);
  const [activationOpen, setActivationOpen] = useState(false);
  const [purchaseCode, setPurchaseCode] = useState("");
  const renewalAttempted = useRef(false);

  const refresh = async () => {
    const catalogRequest = invoke<AgentCatalog>("trading_agent_catalog").then((result) => {
      setCatalog(result.agents);
      const ready = new Set(result.agents.filter((agent) => agent.customer_ready).map((agent) => agent.id));
      setSelectedIds((current) => current.filter((id) => ready.has(id)));
    });
    const engineRequest = invoke<OwnerEngineStatus>("owner_engine_status").then((result) => {
      setEngine(result);
      if (result.selected_agent_ids.length) setSelectedIds(result.selected_agent_ids);
      if (result.mode === "practice" || result.mode === "real") setMode(result.mode);
    });
    void invoke<ActivityItem[]>("recent_trading_activity").then(setActivity).catch(() => undefined);
    const licenseRequest = invoke<LicenseStatus>("entry_license_status").then(setLicense);

    await Promise.allSettled([catalogRequest, engineRequest, licenseRequest]);
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
      void invoke<OwnerEngineStatus>("owner_engine_status").then(setEngine).catch(() => undefined);
      void invoke<ActivityItem[]>("recent_trading_activity").then(setActivity).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

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
  const running = engine.mode === "practice" || engine.mode === "real";

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
      if (account === "Robinhood") await invoke("connect_robinhood");
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
          daily_budget_usd: dailyBudget,
          max_per_trade_usd: perTrade,
          real_confirmation: mode === "real" ? "START REAL TRADING" : null,
        },
      });
      setRealReviewOpen(false);
      setSetupOpen(false);
      localStorage.setItem("dtb.setupComplete", "yes");
      setNotice(result.message);
      await refresh();
      setView("home");
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
      setNotice("Enter the purchase code from your DayTradingBot receipt.");
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
        <button className="brand" type="button" onClick={() => setView("home")} aria-label="DayTradingBot home">
          <span>DTB</span>
          <strong>DayTradingBot</strong>
        </button>
        <nav aria-label="Main navigation">
          {(["home", "agents", "accounts", "activity"] as View[]).map((item) => (
            <button className={view === item ? "nav-item active" : "nav-item"} type="button" key={item} onClick={() => setView(item)}>
              {item === "home" ? "Home" : item === "agents" ? "Trading agents" : item === "accounts" ? "Accounts" : "Activity"}
            </button>
          ))}
        </nav>
        <button className="setup-link" type="button" onClick={() => setSetupOpen(true)}>Setup</button>
        <button className={license.real_trading_ready ? "activation-link ready" : "activation-link"} type="button" onClick={() => setActivationOpen(true)}>{license.real_trading_ready ? "App activated" : "Activate app"}</button>
        <div className="engine-note"><span className={engine.available ? "online" : ""} />{engine.available ? "Trading engine ready" : "Installer needed"}</div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div>
            <p>{view === "home" ? "Your trading team" : view === "agents" ? "Choose who trades" : view === "accounts" ? "Your money stays in your accounts" : "Every move, in one place"}</p>
            <h1>{view === "home" ? "Home" : view === "agents" ? "Trading agents" : view === "accounts" ? "Accounts" : "Activity"}</h1>
          </div>
          {running ? (
            <button className="pause-button" type="button" onClick={pause} disabled={busy}>{pendingTradingAction === "pause" ? "Pausing…" : "Pause trading"}</button>
          ) : (
            <button className="start-button compact" type="button" onClick={() => void start()} disabled={busy}>{pendingTradingAction === "pause" ? "Pausing…" : pendingTradingAction === "start" ? "Starting…" : "Start trading"}</button>
          )}
        </header>

        {notice ? <div className="notice" role="status"><span />{notice}<button type="button" onClick={() => setNotice(null)} aria-label="Dismiss">×</button></div> : null}

        {view === "home" ? (
          <div className="home-view">
            <section className="session-hero">
              <div>
                <p className="eyebrow">{running ? `${engine.mode === "real" ? "Real trading" : "Practice"} is running` : "Ready when you are"}</p>
                <h2>{running ? "Your agents are watching the markets." : "Set your limits. Then put your agents to work."}</h2>
              </div>
              <div className="session-action">
                <span>{selectedAgents.length ? selectedAgents.map((agent) => agent.name).join(" + ") : "No agent selected"}</span>
                <strong>{money(dailyBudget)} <small>at risk today</small></strong>
                {running ? (
                  <button className="pause-button wide" type="button" onClick={pause} disabled={busy}>{pendingTradingAction === "pause" ? "Pausing…" : "Pause trading"}</button>
                ) : (
                  <button className="start-button wide" type="button" onClick={() => void start()} disabled={busy}>{pendingTradingAction === "pause" ? "Pausing…" : pendingTradingAction === "start" ? "Starting…" : "Start trading"}</button>
                )}
              </div>
            </section>

            <section className="quick-settings" aria-label="Trading settings">
              <button type="button" onClick={() => setSetupOpen(true)}><span>Trading with</span><strong>{selectedAgents.length ? selectedAgents.map((agent) => agent.name).join(", ") : "Choose an agent"}</strong></button>
              <button type="button" onClick={() => setSetupOpen(true)}><span>Mode</span><strong>{mode === "practice" ? "Practice" : "Real trading"}</strong></button>
              <button type="button" onClick={() => setSetupOpen(true)}><span>Daily limit</span><strong>{money(dailyBudget)}</strong></button>
              <button type="button" onClick={() => setSetupOpen(true)}><span>Each trade</span><strong>Up to {money(perTrade)}</strong></button>
            </section>

            <section className="home-grid">
              <div className="plain-section account-summary">
                <div className="section-heading"><div><p className="eyebrow">Connected money</p><h3>Your accounts</h3></div><button type="button" onClick={() => setView("accounts")}>Manage</button></div>
                <div className="account-lines">
                  {accounts.filter((account) => account.connected).length ? accounts.filter((account) => account.connected).map((account) => (
                    <div className="account-line" key={account.name}>
                      <span className="account-logo">{accountInitial(account.name)}</span>
                      <div><strong>{account.name}</strong><small>{account.detail}</small></div>
                      <span className="connected-copy">Connected</span>
                    </div>
                  )) : <button className="empty-action" type="button" onClick={() => setSetupOpen(true)}>Connect your first account</button>}
                </div>
              </div>

              <div className="plain-section recent-summary">
                <div className="section-heading"><div><p className="eyebrow">Latest update</p><h3>What your agents are doing</h3></div><button type="button" onClick={() => setView("activity")}>See all</button></div>
                <div className="activity-line">
                  <span className={running ? "pulse-dot active" : "pulse-dot"} />
                  <div><strong>{activity[0]?.message ?? engine.message}</strong><small>{activity[0] ? `${activity[0].mode === "practice" ? "Practice" : "Real trading"} · ${activityTime(activity[0].occurred_at)}` : running ? "The next market check runs on each agent’s schedule." : "Start Practice to see what the agents would do before using real money."}</small></div>
                </div>
              </div>
            </section>
          </div>
        ) : null}

        {view === "agents" ? (
          <section className="agents-view">
            <div className="view-intro"><div><h2>Choose up to three.</h2><p>Each agent follows a different trading approach. You can change them whenever trading is paused.</p></div><button className="pick-button" type="button" onClick={pickForMe}>Pick for me</button></div>
            <div className="agent-list">
              {catalog.map((agent) => {
                const selected = selectedIds.includes(agent.id);
                const connected = connectedNames.has(agent.account);
                return (
                  <button className={selected ? "agent-row selected" : "agent-row"} type="button" key={agent.id} onClick={() => toggleAgent(agent.id)} disabled={running || !agent.customer_ready}>
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
              {!activity.length && !running ? <div className="timeline-row muted"><span className="pulse-dot" /><time>Next</time><div><strong>Your first market check</strong><p>Start Practice to watch the agents work without using real money.</p></div></div> : null}
            </div>
          </section>
        ) : null}
      </main>

      {setupOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title">
            <header>
              <div><p>Step {setupStep} of 4</p><h2 id="setup-title">{setupStep === 1 ? "Connect your accounts" : setupStep === 2 ? "Choose your trading agent" : setupStep === 3 ? "Set your limits" : "Choose how to start"}</h2></div>
              <button type="button" onClick={() => setSetupOpen(false)} aria-label="Close setup">×</button>
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
                <div className="limit-control"><div><span>Amount at risk today</span><strong>{money(dailyBudget)}</strong></div><input type="range" min="1" max="25" step="1" value={dailyBudget} onChange={(event) => { const value = Number(event.target.value); setDailyBudget(value); if (perTrade > value) setPerTrade(value); }} /><small>When the agents reach this amount, they cannot open another trade that day.</small></div>
                <div className="limit-control"><div><span>Most in one trade</span><strong>{money(perTrade)}</strong></div><input type="range" min="1" max={Math.min(5, dailyBudget)} step="1" value={perTrade} onChange={(event) => setPerTrade(Number(event.target.value))} /><small>No agent can put more than this amount into one new trade.</small></div>
                <p className="risk-line">The full amount you put at risk can be lost. Start smaller until you are comfortable with how the agents trade.</p>
              </div>
            ) : null}

            {setupStep === 4 ? (
              <div className="setup-body mode-body">
                <button className={mode === "practice" ? "mode-choice selected" : "mode-choice"} type="button" onClick={() => setMode("practice")}><span>Practice</span><strong>See the agents work without using real money.</strong><small>Recommended for your first run</small></button>
                <button className={mode === "real" ? "mode-choice selected" : "mode-choice"} type="button" onClick={() => setMode("real")}><span>Real trading</span><strong>Use money in your connected accounts.</strong><small>{license.real_trading_ready ? "App activated · every trade can lose money" : "Enter your purchase code once before starting"}</small></button>
                <div className="start-summary"><span>{selectedAgents.map((agent) => agent.name).join(" + ") || "Choose an agent"}</span><strong>{money(dailyBudget)} today · {money(perTrade)} per trade</strong></div>
              </div>
            ) : null}

            <footer>
              <button className="back-button" type="button" onClick={() => setupStep === 1 ? setSetupOpen(false) : setSetupStep((step) => step - 1)}>{setupStep === 1 ? "Close" : "Back"}</button>
              {setupStep < 4 ? <button className="continue-button" type="button" onClick={finishSetupStep}>Continue</button> : <button className="continue-button" type="button" onClick={() => void start()} disabled={busy}>{pendingTradingAction === "start" ? "Starting…" : mode === "practice" ? "Start Practice" : "Review real trading"}</button>}
            </footer>
          </section>
        </div>
      ) : null}

      {realReviewOpen ? (
        <div className="modal-backdrop highest" role="presentation">
          <section className="real-review" role="alertdialog" aria-modal="true" aria-labelledby="real-review-title">
            <p className="eyebrow">Real money</p>
            <h2 id="real-review-title">Ready to start real trading?</h2>
            <p>The selected agents can place trades in your connected accounts. The full amount at risk today can be lost.</p>
            <dl><div><dt>Trading agents</dt><dd>{selectedAgents.map((agent) => agent.name).join(", ")}</dd></div><div><dt>Amount at risk today</dt><dd>{money(dailyBudget)}</dd></div><div><dt>Most in one trade</dt><dd>{money(perTrade)}</dd></div></dl>
            <div className="review-actions"><button className="back-button" type="button" onClick={() => setRealReviewOpen(false)}>Go back</button><button className="danger-start" type="button" onClick={() => void start(true)} disabled={busy}>{pendingTradingAction === "start" ? "Starting…" : "Start real trading"}</button></div>
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
                <p>Enter the purchase code from your receipt. One purchase can be active on one computer at a time.</p>
                <label>
                  <span>Purchase code</span>
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
