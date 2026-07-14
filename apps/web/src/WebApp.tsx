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
  if (state === "needs_agentic_account") return "Connected — finish the Agentic account setup in Robinhood";
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
      <header><a href="/" className="browser-wordmark">DAYTRADINGBOT</a><a href="/get-started/">Get a code</a></header>
      <section>
        <div className="login-copy">
          <p className="browser-eyebrow"><span /> No download required</p>
          <h1>Use DayTradingBot in your browser.</h1>
          <p>Enter the purchase code from your receipt. Then connect Robinhood, choose Practice or Real, set your dollar limits, and press Start.</p>
          <ul>
            <li>Your trading money stays in Robinhood.</li>
            <li>Your connection is encrypted on our server.</li>
            <li>You can press Pause from any browser.</li>
          </ul>
        </div>
        <form className="login-card" onSubmit={signIn}>
          <p>Browser app</p>
          <h2>Enter your purchase code</h2>
          <label htmlFor="purchase-code">Code from your receipt</label>
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
          <button type="submit" disabled={busy || code.trim().length < 16}>{busy ? "Signing in…" : "Open my app"}</button>
          {error && <div className="browser-error" role="alert">{error}</div>}
          <small>DayTradingBot never asks for your Robinhood password on this screen.</small>
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
        ? "Robinhood is connected. Finish your limits and choose how to start."
        : status === "needs-account"
          ? "Robinhood is connected, but it needs one dedicated Agentic account before Bluechip can run."
          : "Robinhood did not finish connecting. Try again when you are ready.");
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
    ), mode === "practice" ? "Practice is on. The first market check will run within five minutes." : "Real trading is on with the limits you chose.");
    if (result) {
      setDashboard(result);
      setSetupOpen(false);
      setRealReviewOpen(false);
    }
  };

  const pause = async () => {
    const result = await act(() => api<Dashboard>("/v1/web/trading/pause", { method: "POST" }, csrf), "Trading is paused.");
    if (result) setDashboard(result);
  };

  const checkConnection = async () => {
    const result = await act(() => api<Dashboard["connection"]>(
      "/v1/web/connections/robinhood/check",
      { method: "POST" },
      csrf,
    ), "Robinhood was checked.");
    if (result && dashboard) setDashboard({ ...dashboard, connection: result });
  };

  const disconnect = async () => {
    const result = await act(() => api<{ disconnected: true }>(
      "/v1/web/connections/robinhood/disconnect",
      { method: "POST" },
      csrf,
    ), "Robinhood is disconnected.");
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
    () => `${money(dailyBudget)} today · ${money(perTrade)} for each trade`,
    [dailyBudget, perTrade],
  );

  if (phase === "loading") {
    return <main className="browser-loading"><span /><p>Opening your DayTradingBot app…</p></main>;
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
          <p><span className={dashboard.settings.running ? "live-dot on" : "live-dot"} />{dashboard.settings.running ? `${dashboard.settings.mode === "real" ? "Real" : "Practice"} is on` : "Trading is paused"}</p>
          <button type="button" onClick={() => void logout()}>Sign out</button>
        </div>
      </aside>

      <main className="browser-main">
        <header className="browser-topbar">
          <div><p className="browser-eyebrow">Browser app</p><h1>{view === "home" ? "Your bot" : view === "account" ? "Your account" : "What your bot is doing"}</h1></div>
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
                <p className="browser-eyebrow">{dashboard.settings.running ? "Bluechip is watching" : "Ready when you are"}</p>
                <h2>{dashboard.settings.running ? dashboard.settings.statusMessage : "Connect. Set your limits. Press Start."}</h2>
                <p>Bluechip checks eight widely held stocks and funds about every 15 minutes. It only acts when its rule and your limits both allow it.</p>
              </div>
              <div className="hero-control">
                <span>{dashboard.agent.name} · {dashboard.settings.mode === "practice" ? "Practice" : "Real trading"}</span>
                <strong>{money(dashboard.settings.dailyBudgetUsd)}<small>most in new trades today</small></strong>
                {dashboard.settings.running
                  ? <button className="pause-trading wide" type="button" onClick={() => void pause()} disabled={busy}>Pause trading</button>
                  : <button className="start-trading wide" type="button" onClick={() => { setSetupStep(dashboard.connection.connected ? 2 : 1); setSetupOpen(true); }}>Set up and start</button>}
              </div>
            </section>

            <section className="browser-facts" aria-label="Current settings">
              <button type="button" onClick={() => { setSetupStep(2); setSetupOpen(true); }}><span>Bot</span><strong>Bluechip</strong><small>Stocks and ETFs</small></button>
              <button type="button" onClick={() => { setSetupStep(4); setSetupOpen(true); }}><span>How it runs</span><strong>{dashboard.settings.mode === "practice" ? "Practice" : "Real trading"}</strong><small>{dashboard.settings.mode === "practice" ? "No orders" : "Can send orders"}</small></button>
              <button type="button" onClick={() => { setSetupStep(3); setSetupOpen(true); }}><span>Daily limit</span><strong>{money(dashboard.settings.dailyBudgetUsd)}</strong><small>New trades today</small></button>
              <button type="button" onClick={() => { setSetupStep(3); setSetupOpen(true); }}><span>Each trade</span><strong>{money(dashboard.settings.maxPerTradeUsd)}</strong><small>Maximum</small></button>
            </section>

            <section className="browser-grid">
              <article className="browser-panel">
                <div className="panel-heading"><div><p className="browser-eyebrow">Money connection</p><h3>Robinhood</h3></div><button type="button" onClick={() => setView("account")}>Manage</button></div>
                <div className="account-summary-row">
                  <span className="rh-mark">R</span>
                  <div><strong>{connectionCopy(dashboard.connection.state)}</strong><small>Your money stays in your dedicated Robinhood Agentic account.</small></div>
                  <span className={dashboard.connection.state === "connected" ? "connection-light on" : "connection-light"} />
                </div>
              </article>
              <article className="browser-panel">
                <div className="panel-heading"><div><p className="browser-eyebrow">Latest update</p><h3>Activity</h3></div><button type="button" onClick={() => setView("activity")}>See all</button></div>
                <div className="latest-row">
                  <span className={dashboard.settings.running ? "pulse active" : "pulse"} />
                  <div><strong>{dashboard.activity[0]?.message ?? dashboard.settings.statusMessage}</strong><small>{dashboard.activity[0] ? activityTime(dashboard.activity[0].occurredAt) : "Start Practice to watch Bluechip work without using real money."}</small></div>
                </div>
              </article>
            </section>
          </>
        )}

        {view === "account" && (
          <section className="account-page">
            <div className="page-intro"><div><p className="browser-eyebrow">Your money stays there</p><h2>Connect one dedicated Robinhood Agentic account.</h2><p>DayTradingBot can see the account and place allowed trades. It cannot transfer or withdraw your money.</p></div></div>
            <article className="account-card">
              <span className="rh-mark large">R</span>
              <div className="account-card-copy"><h3>Robinhood</h3><p>{connectionCopy(dashboard.connection.state)}</p><small>{dashboard.connection.hasBuyingPower ? "The account has buying power." : "Add money in Robinhood if the Agentic account needs it."}</small></div>
              <div className="account-card-actions">
                {dashboard.connection.connected
                  ? <><button type="button" onClick={() => void checkConnection()} disabled={busy}>Check connection</button><button className="quiet-danger" type="button" onClick={() => setDisconnectReview(true)}>Disconnect</button></>
                  : <button className="start-trading" type="button" onClick={() => void startConnection()} disabled={busy}>Connect Robinhood</button>}
              </div>
            </article>
            <div className="account-explainer">
              <div><span>01</span><h3>Robinhood asks you to approve the connection.</h3><p>You sign in on Robinhood's own website. DayTradingBot never sees your Robinhood password.</p></div>
              <div><span>02</span><h3>Use a dedicated Agentic account.</h3><p>Only the money you put in that account is available to the bot.</p></div>
              <div><span>03</span><h3>Start with Practice.</h3><p>See current decisions first. Move to Real only when you understand what Bluechip does.</p></div>
            </div>
          </section>
        )}

        {view === "activity" && (
          <section className="activity-page">
            <div className="page-intro"><div><p className="browser-eyebrow">Plain-English record</p><h2>Checks, decisions, and orders—together.</h2><p>If Bluechip skips a trade, you will see why. If Real trading sends an order, you will see that too.</p></div></div>
            <div className="activity-list">
              <div className="activity-row current"><span className={dashboard.settings.running ? "pulse active" : "pulse"} /><time>Now</time><div><strong>{dashboard.settings.statusMessage}</strong><p>{dashboard.settings.mode === "practice" ? "Practice" : "Real trading"} · {selectedSummary}</p></div></div>
              {dashboard.activity.map((item) => (
                <div className={`activity-row ${item.kind === "error" ? "warning" : ""}`} key={item.id}>
                  <span className={["filled", "order_submitted"].includes(item.kind) ? "pulse active" : "pulse"} />
                  <time>{activityTime(item.occurredAt)}</time>
                  <div><strong>{item.message}</strong><p>Bluechip · {item.mode === "practice" ? "Practice" : "Real trading"}{item.symbol ? ` · ${item.symbol}` : ""}{item.amountUsd !== null ? ` · ${money(item.amountUsd)}` : ""}</p></div>
                </div>
              ))}
              {!dashboard.activity.length && <div className="activity-row empty"><span className="pulse" /><time>Next</time><div><strong>Your first market check</strong><p>Start Practice to see what Bluechip would do without placing an order.</p></div></div>}
            </div>
          </section>
        )}
      </main>

      {setupOpen && (
        <div className="browser-modal-backdrop" role="presentation">
          <section className="setup-dialog" role="dialog" aria-modal="true" aria-labelledby="setup-heading">
            <header><div><p>Step {setupStep} of 4</p><h2 id="setup-heading">{setupStep === 1 ? "Connect Robinhood" : setupStep === 2 ? "Meet your bot" : setupStep === 3 ? "Set your dollar limits" : "Choose how to start"}</h2></div><button type="button" aria-label="Close" onClick={() => setSetupOpen(false)}>×</button></header>
            <div className="setup-progress" aria-hidden="true">{[1, 2, 3, 4].map((step) => <span className={step <= setupStep ? "done" : ""} key={step} />)}</div>
            <div className="setup-content">
              {setupStep === 1 && (
                <div className="connect-step">
                  <p>Start with the account Bluechip uses. Robinhood handles the sign-in and asks you to approve DayTradingBot.</p>
                  <article><span className="rh-mark">R</span><div><strong>Robinhood Agentic</strong><small>{connectionCopy(dashboard.connection.state)}</small></div>{dashboard.connection.state === "connected" ? <span className="setup-check">✓</span> : <button type="button" onClick={() => void startConnection()} disabled={busy}>Connect</button>}</article>
                  <small>Use a dedicated Agentic account. Your regular Robinhood account stays separate.</small>
                </div>
              )}
              {setupStep === 2 && (
                <div className="agent-step">
                  <div className="pick-row"><p>Bluechip is the released bot for Robinhood stocks and ETFs.</p><button type="button">Pick for me ✓</button></div>
                  <article><span className="agent-letter">B</span><div><strong>Bluechip</strong><small>{dashboard.agent.summary}</small></div><span className="steady-tag">Steady</span><span className="setup-check">✓</span></article>
                  <dl><div><dt>Checks</dt><dd>Every 15 minutes</dd></div><div><dt>Looks for</dt><dd>Pullbacks of 1.5% or more</dd></div><div><dt>Watches</dt><dd>8 widely held stocks and funds</dd></div></dl>
                </div>
              )}
              {setupStep === 3 && (
                <div className="limits-step">
                  <label><span>Most in new trades today <strong>{money(dailyBudget)}</strong></span><input type="range" min="1" max="25" step="1" value={dailyBudget} onChange={(event) => { const value = Number(event.target.value); setDailyBudget(value); if (perTrade > value) setPerTrade(value); }} /><small>When this amount is reached, Bluechip cannot open another trade that day.</small></label>
                  <label><span>Most in one trade <strong>{money(perTrade)}</strong></span><input type="range" min="1" max={Math.min(5, dailyBudget)} step="1" value={perTrade} onChange={(event) => setPerTrade(Number(event.target.value))} /><small>No Bluechip trade can be larger than this.</small></label>
                  <p>The full amount you put at risk can be lost. Starting small makes it easier to learn how the bot behaves.</p>
                </div>
              )}
              {setupStep === 4 && (
                <div className="mode-step">
                  <button className={mode === "practice" ? "selected" : ""} type="button" onClick={() => setMode("practice")}><span>Practice</span><strong>Watch Bluechip make current decisions without placing an order.</strong><small>Recommended for your first run</small></button>
                  <button className={mode === "real" ? "selected" : ""} type="button" disabled={!dashboard.realTradingEnabled} onClick={() => setMode("real")}><span>Real trading</span><strong>Allow Bluechip to send trades to your Robinhood Agentic account.</strong><small>{dashboard.realTradingEnabled ? "Every trade can lose money" : "Temporarily unavailable"}</small></button>
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
            <p className="browser-eyebrow">Real money</p><h2 id="real-heading">Bluechip can now place trades.</h2>
            <p>It will use the dedicated Robinhood Agentic account you connected. A trade can lose money, and the full daily amount can be lost.</p>
            <p className="real-window">Real trading turns off after 24 hours. Press Start again if you want it to keep running.</p>
            <dl><div><dt>Bot</dt><dd>Bluechip</dd></div><div><dt>Most today</dt><dd>{money(dailyBudget)}</dd></div><div><dt>Most in one trade</dt><dd>{money(perTrade)}</dd></div></dl>
            <div><button type="button" onClick={() => setRealReviewOpen(false)}>Go back</button><button className="real-start" type="button" disabled={busy} onClick={() => void start(true)}>{busy ? "Starting…" : "Start real trading"}</button></div>
          </section>
        </div>
      )}

      {disconnectReview && (
        <div className="browser-modal-backdrop top" role="presentation">
          <section className="disconnect-dialog" role="alertdialog" aria-modal="true" aria-labelledby="disconnect-heading">
            <h2 id="disconnect-heading">Disconnect Robinhood?</h2><p>Trading will pause immediately and the encrypted Robinhood connection will be deleted from DayTradingBot.</p><div><button type="button" onClick={() => setDisconnectReview(false)}>Keep connected</button><button className="real-start" type="button" disabled={busy} onClick={() => void disconnect()}>Disconnect</button></div>
          </section>
        </div>
      )}
    </div>
  );
}
