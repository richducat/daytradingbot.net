import { useCallback, useEffect, useMemo, useState } from "react";
import { siteConfig } from "./siteConfig";
import "./webapp.css";

type TradingMode = "practice" | "real";
type View = "home" | "account" | "activity";
type Activity = {
  id: string;
  agentId: "bluechip";
  mode: TradingMode;
  kind: string;
  symbol: string | null;
  amountUsd: number | null;
  message: string;
  occurredAt: string;
};
type Dashboard = {
  app: "daytradingbot-web";
  realTradingEnabled: boolean;
  connection: {
    provider: "robinhood";
    connected: boolean;
    state: "not_connected" | "connected" | "needs_agentic_account" | "authentication_expired" | "error";
    hasBuyingPower: boolean;
    lastCheckedAt: string | null;
  };
  settings: {
    agentId: "bluechip";
    mode: TradingMode;
    dailyBudgetUsd: number;
    maxPerTradeUsd: number;
    running: boolean;
    lastCheckedAt: string | null;
    nextCheckAt: string | null;
    statusMessage: string;
  };
  activity: Activity[];
  agent: {
    id: "bluechip";
    name: "Bluechip";
    account: "Robinhood";
    market: "Stocks and ETFs";
    summary: string;
    cadenceMinutes: 15;
    riskLevel: "steady";
  };
};
type SessionPayload = {
  authenticated: true;
  csrfToken: string;
  expiresAt: string;
  dashboard: Dashboard;
};
type SessionResponse = SessionPayload | { authenticated: false };

class BrowserAppError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function api<T>(path: string, init: RequestInit = {}, csrfToken?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (csrfToken) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(`${siteConfig.apiBaseUrl}${path}`, {
    ...init,
    headers,
    credentials: "include",
    redirect: "error",
  });
  const payload = await response.json().catch(() => ({})) as { message?: unknown };
  if (!response.ok) {
    throw new BrowserAppError(
      response.status,
      typeof payload.message === "string" ? payload.message : "DayTradingBot could not finish that request.",
    );
  }
  return payload as T;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function activityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

function connectionCopy(state: Dashboard["connection"]["state"]): string {
  if (state === "connected") return "Connected and ready";
  if (state === "needs_agentic_account") return "Connected. Finish setting up the Agentic account in Robinhood";
  if (state === "authentication_expired") return "Reconnect Robinhood";
  if (state === "error") return "Connection needs attention";
  return "Not connected";
}

function Login({ onSignedIn }: { onSignedIn: (payload: SessionPayload) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await api<SessionPayload>("/v1/web/session", {
        method: "POST",
        body: JSON.stringify({ licenseCode: code.trim().toUpperCase() }),
      });
      setCode("");
      onSignedIn(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in did not finish.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="browser-login">
      <header><a href="/" className="browser-wordmark">DAYTRADINGBOT</a><a href="/get-started/">Buy Bluechip</a></header>
      <section>
        <div className="login-copy">
          <p className="browser-eyebrow"><span /> Your bot runs here</p>
          <h1>Bluechip watches the market so you don't have to.</h1>
          <p>Use the code from your receipt to open your dashboard. Then connect Robinhood, choose how much Bluechip may use, and start in Practice without placing a real order.</p>
          <ul>
            <li>Checks eight stocks and ETFs about every 15 minutes.</li>
            <li>Shows every check, skipped trade, and order in Activity.</li>
            <li>Keeps your trading money in Robinhood.</li>
          </ul>
        </div>
        <form className="login-card" onSubmit={signIn}>
          <p>Open your dashboard</p>
          <h2>Enter your access code</h2>
          <label htmlFor="purchase-code">Access code from your receipt</label>
          <input
            id="purchase-code"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="DTB-…"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            minLength={16}
            maxLength={84}
            required
          />
          <button type="submit" disabled={busy || code.trim().length < 16}>{busy ? "Opening…" : "Open my dashboard"}</button>
          {error && <div className="browser-error" role="alert">{error}</div>}
          <small>Can't find the code? Check the email address used at checkout.</small>
        </form>
      </section>
    </main>
  );
}

export function WebApp() {
  const [phase, setPhase] = useState<"loading" | "signed-out" | "ready">("loading");
  const [csrf, setCsrf] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [view, setView] = useState<View>("home");
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupStep, setSetupStep] = useState(1);
  const [dailyBudget, setDailyBudget] = useState(10);
  const [perTrade, setPerTrade] = useState(2);
  const [mode, setMode] = useState<TradingMode>("practice");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [realReviewOpen, setRealReviewOpen] = useState(false);
  const [disconnectReview, setDisconnectReview] = useState(false);

  const acceptSession = useCallback((payload: SessionPayload) => {
    setCsrf(payload.csrfToken);
    setDashboard(payload.dashboard);
    setDailyBudget(payload.dashboard.settings.dailyBudgetUsd);
    setPerTrade(payload.dashboard.settings.maxPerTradeUsd);
    setMode(payload.dashboard.settings.mode);
    setPhase("ready");
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    try {
      const payload = await api<SessionResponse>("/v1/web/session");
      if (!payload.authenticated) {
        setCsrf("");
        setDashboard(null);
        setPhase("signed-out");
        return;
      }
      acceptSession(payload);
    } catch (caught) {
      if (caught instanceof BrowserAppError && caught.status === 401) {
        setCsrf("");
        setDashboard(null);
        setPhase("signed-out");
        return;
      }
      if (!quiet) setError(caught instanceof Error ? caught.message : "The app could not load.");
      setPhase((current) => current === "loading" ? "signed-out" : current);
    }
  }, [acceptSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (phase !== "ready") return;
    const interval = window.setInterval(() => void refresh(true), 15_000);
    return () => window.clearInterval(interval);
  }, [phase, refresh]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    if (params.get("connection") === "robinhood" && status) {
      setNotice(status === "connected"
        ? "Robinhood is connected. Choose your dollar limits and start Practice."
        : status === "needs-account"
          ? "Robinhood is connected, but Bluechip still needs a dedicated Agentic account. Finish that step in Robinhood."
          : "Robinhood did not finish connecting. Try again when you're ready.");
      if (status === "connected") {
        setSetupOpen(true);
        setSetupStep(2);
      }
      window.history.replaceState({}, "", "/app/");
    }
  }, []);

  const act = async <T,>(operation: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    setError("");
    try {
      const value = await operation();
      if (success) setNotice(success);
      return value;
    } catch (caught) {
      if (caught instanceof BrowserAppError && caught.status === 401) setPhase("signed-out");
      else setError(caught instanceof Error ? caught.message : "That action did not finish.");
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const startConnection = async () => {
    const result = await act(() => api<{ authorizationUrl: string }>(
      "/v1/web/connections/robinhood/start",
      { method: "POST" },
      csrf,
    ));
    if (!result) return;
    const url = new URL(result.authorizationUrl);
    if (url.protocol !== "https:" || url.hostname !== "robinhood.com") {
      setError("Robinhood returned an invalid connection page.");
      return;
    }
    window.location.assign(url.toString());
  };

  const saveSettings = async (): Promise<Dashboard | undefined> => {
    const result = await act(() => api<Dashboard>(
      "/v1/web/settings",
      { method: "POST", body: JSON.stringify({ mode, dailyBudgetUsd: dailyBudget, maxPerTradeUsd: perTrade }) },
      csrf,
    ));
    if (result) setDashboard(result);
    return result;
  };

  const start = async (acceptedRealRisk = false) => {
    if (!dashboard?.connection.connected) {
      setSetupStep(1);
      setSetupOpen(true);
      return;
    }
    if (mode === "real" && !acceptedRealRisk) {
      setRealReviewOpen(true);
      return;
    }
    const saved = await saveSettings();
    if (!saved) return;
    const result = await act(() => api<Dashboard>(
      "/v1/web/trading/start",
      { method: "POST", body: JSON.stringify({ mode, acceptedRealRisk }) },
      csrf,
    ), mode === "practice" ? "Practice is running. Bluechip will make its first market check within five minutes." : "Real trading is running with the dollar limits you chose.");
    if (result) {
      setDashboard(result);
      setSetupOpen(false);
      setRealReviewOpen(false);
    }
  };

  const pause = async () => {
    const result = await act(() => api<Dashboard>("/v1/web/trading/pause", { method: "POST" }, csrf), "Bluechip is paused. It will not open another trade.");
    if (result) setDashboard(result);
  };

  const checkConnection = async () => {
    const result = await act(() => api<Dashboard["connection"]>(
      "/v1/web/connections/robinhood/check",
      { method: "POST" },
      csrf,
    ), "Robinhood is connected and current.");
    if (result && dashboard) setDashboard({ ...dashboard, connection: result });
  };

  const disconnect = async () => {
    const result = await act(() => api<{ disconnected: true }>(
      "/v1/web/connections/robinhood/disconnect",
      { method: "POST" },
      csrf,
    ), "Robinhood is disconnected. Bluechip is paused.");
    if (result) {
      setDisconnectReview(false);
      await refresh();
    }
  };

  const logout = async () => {
    await act(() => api("/v1/web/session/logout", { method: "POST" }, csrf));
    setCsrf("");
    setDashboard(null);
    setPhase("signed-out");
  };

  const selectedSummary = useMemo(
    () => `${money(dailyBudget)} for new trades today · up to ${money(perTrade)} each`,
    [dailyBudget, perTrade],
  );

  if (phase === "loading") {
    return <main className="browser-loading"><span /><p>Opening your Bluechip dashboard…</p></main>;
  }
  if (phase === "signed-out" || !dashboard) return <Login onSignedIn={acceptSession} />;

  return (
    <div className="browser-shell">
      <aside className="browser-sidebar">
        <a className="browser-wordmark" href="/">DAYTRADINGBOT</a>
        <nav aria-label="Browser app navigation">
          <button className={view === "home" ? "active" : ""} type="button" onClick={() => setView("home")}><span>01</span>Home</button>
          <button className={view === "account" ? "active" : ""} type="button" onClick={() => setView("account")}><span>02</span>Account</button>
          <button className={view === "activity" ? "active" : ""} type="button" onClick={() => setView("activity")}><span>03</span>Activity</button>
        </nav>
        <div className="sidebar-bottom">
          <p><span className={dashboard.settings.running ? "live-dot on" : "live-dot"} />{dashboard.settings.running ? `${dashboard.settings.mode === "real" ? "Real trading" : "Practice"} is running` : "Bluechip is off"}</p>
          <button type="button" onClick={() => void logout()}>Sign out</button>
        </div>
      </aside>

      <main className="browser-main">
        <header className="browser-topbar">
          <div><p className="browser-eyebrow">Your Bluechip bot</p><h1>{view === "home" ? "Home" : view === "account" ? "Connected account" : "Activity"}</h1></div>
          {dashboard.settings.running
            ? <button className="pause-trading" type="button" onClick={() => void pause()} disabled={busy}>Pause</button>
            : <button className="start-trading" type="button" onClick={() => void start()} disabled={busy}>Start</button>}
        </header>

        {notice && <div className="browser-notice" role="status"><span />{notice}<button type="button" aria-label="Dismiss" onClick={() => setNotice("")}>×</button></div>}
        {error && <div className="browser-error wide" role="alert">{error}<button type="button" aria-label="Dismiss" onClick={() => setError("")}>×</button></div>}

        {view === "home" && (
          <>
            <section className="browser-hero">
              <div>
                <p className="browser-eyebrow">{dashboard.settings.running ? "Watching the market now" : "Your bot is off"}</p>
                <h2>{dashboard.settings.running ? dashboard.settings.statusMessage : "Start with a no-money Practice run."}</h2>
                <p>Bluechip checks eight stocks and ETFs about every 15 minutes. It waits unless a price move, its trading rule, and your dollar limits all line up.</p>
              </div>
              <div className="hero-control">
                <span>{dashboard.agent.name} · {dashboard.settings.mode === "practice" ? "Practice" : "Real trading"}</span>
                <strong>{money(dashboard.settings.dailyBudgetUsd)}<small>maximum for new trades today</small></strong>
                {dashboard.settings.running
                  ? <button className="pause-trading wide" type="button" onClick={() => void pause()} disabled={busy}>Pause trading</button>
                  : <button className="start-trading wide" type="button" onClick={() => { setSetupStep(dashboard.connection.connected ? 2 : 1); setSetupOpen(true); }}>Choose settings and start</button>}
              </div>
            </section>

            <section className="browser-facts" aria-label="Current settings">
              <button type="button" onClick={() => { setSetupStep(2); setSetupOpen(true); }}><span>Bot</span><strong>Bluechip</strong><small>Stocks and ETFs</small></button>
              <button type="button" onClick={() => { setSetupStep(4); setSetupOpen(true); }}><span>Mode</span><strong>{dashboard.settings.mode === "practice" ? "Practice" : "Real trading"}</strong><small>{dashboard.settings.mode === "practice" ? "No orders are sent" : "Orders may be sent"}</small></button>
              <button type="button" onClick={() => { setSetupStep(3); setSetupOpen(true); }}><span>New trades today</span><strong>{money(dashboard.settings.dailyBudgetUsd)}</strong><small>Maximum</small></button>
              <button type="button" onClick={() => { setSetupStep(3); setSetupOpen(true); }}><span>One trade</span><strong>{money(dashboard.settings.maxPerTradeUsd)}</strong><small>Maximum</small></button>
            </section>

            <section className="browser-grid">
              <article className="browser-panel">
                <div className="panel-heading"><div><p className="browser-eyebrow">Connected account</p><h3>Robinhood</h3></div><button type="button" onClick={() => setView("account")}>Manage</button></div>
                <div className="account-summary-row">
                  <span className="rh-mark">R</span>
                  <div><strong>{connectionCopy(dashboard.connection.state)}</strong><small>Only the money in the dedicated Agentic account is available to Bluechip.</small></div>
                  <span className={dashboard.connection.state === "connected" ? "connection-light on" : "connection-light"} />
                </div>
              </article>
              <article className="browser-panel">
                <div className="panel-heading"><div><p className="browser-eyebrow">Latest update</p><h3>Activity</h3></div><button type="button" onClick={() => setView("activity")}>See all</button></div>
                <div className="latest-row">
                  <span className={dashboard.settings.running ? "pulse active" : "pulse"} />
                  <div><strong>{dashboard.activity[0]?.message ?? dashboard.settings.statusMessage}</strong><small>{dashboard.activity[0] ? activityTime(dashboard.activity[0].occurredAt) : "Start Practice to see Bluechip make current decisions without placing an order."}</small></div>
                </div>
              </article>
            </section>
          </>
        )}

        {view === "account" && (
          <section className="account-page">
            <div className="page-intro"><div><p className="browser-eyebrow">The account Bluechip will use</p><h2>Connect a dedicated Robinhood Agentic account.</h2><p>Robinhood keeps this separate from your regular account. Bluechip can view it and place the trades you allow, but it cannot transfer or withdraw your money.</p></div></div>
            <article className="account-card">
              <span className="rh-mark large">R</span>
              <div className="account-card-copy"><h3>Robinhood</h3><p>{connectionCopy(dashboard.connection.state)}</p><small>{dashboard.connection.hasBuyingPower ? "This account has money available for trades." : "If you want to use Real trading, add money to the Agentic account in Robinhood."}</small></div>
              <div className="account-card-actions">
                {dashboard.connection.connected
                  ? <><button type="button" onClick={() => void checkConnection()} disabled={busy}>Check connection</button><button className="quiet-danger" type="button" onClick={() => setDisconnectReview(true)}>Disconnect</button></>
                  : <button className="start-trading" type="button" onClick={() => void startConnection()} disabled={busy}>Connect Robinhood</button>}
              </div>
            </article>
            <div className="account-explainer">
              <div><span>01</span><h3>Robinhood handles sign-in.</h3><p>You approve the connection on Robinhood's website. DayTradingBot never sees your password.</p></div>
              <div><span>02</span><h3>Choose the Agentic account.</h3><p>Only money placed in that separate account can be used by Bluechip.</p></div>
              <div><span>03</span><h3>Come back and start Practice.</h3><p>See current decisions before you decide whether to allow real orders.</p></div>
            </div>
          </section>
        )}

        {view === "activity" && (
          <section className="activity-page">
            <div className="page-intro"><div><p className="browser-eyebrow">Everything in one place</p><h2>See what Bluechip checked and why it acted.</h2><p>If Bluechip waits, you will see why. If Real trading sends an order, you will see that too.</p></div></div>
            <div className="activity-list">
              <div className="activity-row current"><span className={dashboard.settings.running ? "pulse active" : "pulse"} /><time>Now</time><div><strong>{dashboard.settings.statusMessage}</strong><p>{dashboard.settings.mode === "practice" ? "Practice" : "Real trading"} · {selectedSummary}</p></div></div>
              {dashboard.activity.map((item) => (
                <div className={`activity-row ${item.kind === "error" ? "warning" : ""}`} key={item.id}>
                  <span className={["filled", "order_submitted"].includes(item.kind) ? "pulse active" : "pulse"} />
                  <time>{activityTime(item.occurredAt)}</time>
                  <div><strong>{item.message}</strong><p>Bluechip · {item.mode === "practice" ? "Practice" : "Real trading"}{item.symbol ? ` · ${item.symbol}` : ""}{item.amountUsd !== null ? ` · ${money(item.amountUsd)}` : ""}</p></div>
                </div>
              ))}
              {!dashboard.activity.length && <div className="activity-row empty"><span className="pulse" /><time>Next</time><div><strong>Your first market check</strong><p>Start Practice to see a current Bluechip decision without placing an order.</p></div></div>}
            </div>
          </section>
        )}
      </main>

      {setupOpen && (
        <div className="browser-modal-backdrop" role="presentation">
          <section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-heading">
            <header><div><p>Step {setupStep} of 4</p><h2 id="setup-heading">{setupStep === 1 ? "Connect the account Bluechip will use" : setupStep === 2 ? "Meet Bluechip" : setupStep === 3 ? "Choose how much it may use" : "Watch it or let it trade"}</h2></div><button type="button" aria-label="Close" onClick={() => setSetupOpen(false)}>×</button></header>
            <div className="setup-progress" aria-hidden="true">{[1, 2, 3, 4].map((step) => <span className={step <= setupStep ? "done" : ""} key={step} />)}</div>
            <div className="setup-content">
              {setupStep === 1 && (
                <div className="connect-step">
                  <p>Robinhood handles sign-in and asks you to approve DayTradingBot. Your password stays with Robinhood.</p>
                  <article><span className="rh-mark">R</span><div><strong>Robinhood Agentic</strong><small>{connectionCopy(dashboard.connection.state)}</small></div>{dashboard.connection.state === "connected" ? <span className="setup-check">✓</span> : <button type="button" onClick={() => void startConnection()} disabled={busy}>Connect</button>}</article>
                  <small>The Agentic account keeps Bluechip separate from your regular Robinhood account.</small>
                </div>
              )}
              {setupStep === 2 && (
                <div className="agent-step">
                  <div className="pick-row"><p>Bluechip is the available bot for Robinhood stocks and ETFs.</p><span className="auto-pick">Picked for you ✓</span></div>
                  <article><span className="agent-letter">B</span><div><strong>Bluechip</strong><small>{dashboard.agent.summary}</small></div><span className="steady-tag">Steady</span><span className="setup-check">✓</span></article>
                  <dl><div><dt>Checks</dt><dd>Every 15 minutes</dd></div><div><dt>Looks for</dt><dd>Pullbacks of 1.5% or more</dd></div><div><dt>Watches</dt><dd>8 widely held stocks and funds</dd></div></dl>
                </div>
              )}
              {setupStep === 3 && (
                <div className="limits-step">
                  <label><span>Most it may add to new trades today <strong>{money(dailyBudget)}</strong></span><input type="range" min="1" max="25" step="1" value={dailyBudget} onChange={(event) => { const value = Number(event.target.value); setDailyBudget(value); if (perTrade > value) setPerTrade(value); }} /><small>After Bluechip reaches this amount, it cannot open another trade that day.</small></label>
                  <label><span>Most it may use in one trade <strong>{money(perTrade)}</strong></span><input type="range" min="1" max={Math.min(5, dailyBudget)} step="1" value={perTrade} onChange={(event) => setPerTrade(Number(event.target.value))} /><small>No single Bluechip trade can be larger than this.</small></label>
                  <p>You can lose the full amount used in a trade. Start small while you learn how Bluechip behaves.</p>
                </div>
              )}
              {setupStep === 4 && (
                <div className="mode-step">
                  <button className={mode === "practice" ? "selected" : ""} type="button" onClick={() => setMode("practice")}><span>Practice</span><strong>See current Bluechip decisions without sending an order.</strong><small>Best choice for your first run</small></button>
                  <button className={mode === "real" ? "selected" : ""} type="button" disabled={!dashboard.realTradingEnabled} onClick={() => setMode("real")}><span>Real trading</span><strong>Let Bluechip send allowed trades to your Agentic account.</strong><small>{dashboard.realTradingEnabled ? "A real trade can lose money" : "Temporarily unavailable"}</small></button>
                  <div className="setup-summary"><span>Bluechip · {mode === "practice" ? "Practice" : "Real trading"}</span><strong>{selectedSummary}</strong></div>
                </div>
              )}
            </div>
            <footer><button type="button" onClick={() => setupStep === 1 ? setSetupOpen(false) : setSetupStep((step) => step - 1)}>{setupStep === 1 ? "Close" : "Back"}</button>{setupStep < 4 ? <button className="continue" type="button" disabled={setupStep === 1 && dashboard.connection.state !== "connected"} onClick={() => setSetupStep((step) => step + 1)}>Continue</button> : <button className="continue" type="button" disabled={busy} onClick={() => void start()}>{mode === "practice" ? "Start Practice" : "Review real trading"}</button>}</footer>
          </section>
        </div>
      )}

      {realReviewOpen && (
        <div className="browser-modal-backdrop top" role="presentation">
          <section className="real-dialog" role="alertdialog" aria-modal="true" aria-labelledby="real-heading">
            <p className="browser-eyebrow">Review before using real money</p><h2 id="real-heading">Bluechip will be allowed to place trades.</h2>
            <p>It will use the Robinhood Agentic account you connected and stay inside the dollar limits below. A trade can lose money, including the full amount used in that trade.</p>
            <p className="real-window">This permission ends after 24 hours. You must review and start Real trading again if you want it to continue.</p>
            <dl><div><dt>Bot</dt><dd>Bluechip</dd></div><div><dt>Most today</dt><dd>{money(dailyBudget)}</dd></div><div><dt>Most in one trade</dt><dd>{money(perTrade)}</dd></div></dl>
            <div><button type="button" onClick={() => setRealReviewOpen(false)}>Go back</button><button className="real-start" type="button" disabled={busy} onClick={() => void start(true)}>{busy ? "Starting…" : "Start real trading"}</button></div>
          </section>
        </div>
      )}

      {disconnectReview && (
        <div className="browser-modal-backdrop top" role="presentation">
          <section className="disconnect-dialog" role="alertdialog" aria-modal="true" aria-labelledby="disconnect-heading">
            <h2 id="disconnect-heading">Disconnect Robinhood?</h2><p>Bluechip will pause immediately. DayTradingBot will delete the saved Robinhood connection.</p><div><button type="button" onClick={() => setDisconnectReview(false)}>Keep connected</button><button className="real-start" type="button" disabled={busy} onClick={() => void disconnect()}>Disconnect</button></div>
          </section>
        </div>
      )}
    </div>
  );
}
