import { useCallback, useEffect, useState } from "react";
import { siteConfig } from "./siteConfig";
import "./webapp.css";

type EntitlementDashboard = {
  app: "daytradingbot-web";
  entitlement: {
    status: "active";
  };
};

type SessionPayload = {
  authenticated: true;
  csrfToken: string;
  expiresAt: string;
  dashboard: EntitlementDashboard;
};

type SessionResponse = SessionPayload | { authenticated: false };

export const browserSessionPaths = {
  session: "/v1/web/session",
  logout: "/v1/web/session/logout",
} as const;

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

function Login({ onSignedIn }: { onSignedIn: (payload: SessionPayload) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await api<SessionPayload>(browserSessionPaths.session, {
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
      <header>
        <a href="/" className="browser-wordmark">DAYTRADINGBOT</a>
        <a href="/get-started/">Buy Bluechip</a>
      </header>
      <section>
        <div className="login-copy">
          <p className="browser-eyebrow"><span /> Customer access</p>
          <h1>Open your DayTradingBot account.</h1>
          <p>Use the access code from your receipt to confirm your license, get the Mac app, and see the exact steps for connecting Robinhood.</p>
          <ul>
            <li>Your license is one payment, not a subscription.</li>
            <li>Robinhood connects inside the Mac app—not on this website.</li>
            <li>Your trading money stays in Robinhood.</li>
          </ul>
        </div>
        <form className="login-card" onSubmit={signIn}>
          <p>Customer sign-in</p>
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
          <button type="submit" disabled={busy || code.trim().length < 16}>
            {busy ? "Checking…" : "Open my account"}
          </button>
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
  const [entitlement, setEntitlement] = useState<EntitlementDashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const acceptSession = useCallback((payload: SessionPayload) => {
    setCsrf(payload.csrfToken);
    setEntitlement(payload.dashboard);
    setPhase("ready");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const payload = await api<SessionResponse>(browserSessionPaths.session);
      if (!payload.authenticated) {
        setCsrf("");
        setEntitlement(null);
        setPhase("signed-out");
        return;
      }
      acceptSession(payload);
    } catch (caught) {
      if (caught instanceof BrowserAppError && caught.status === 401) {
        setCsrf("");
        setEntitlement(null);
        setPhase("signed-out");
        return;
      }
      setError(caught instanceof Error ? caught.message : "Your account could not load.");
      setPhase("signed-out");
    }
  }, [acceptSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      await api(browserSessionPaths.logout, { method: "POST" }, csrf);
      setCsrf("");
      setEntitlement(null);
      setPhase("signed-out");
    } catch (caught) {
      if (caught instanceof BrowserAppError && caught.status === 401) {
        setCsrf("");
        setEntitlement(null);
        setPhase("signed-out");
      } else {
        setError(caught instanceof Error ? caught.message : "Sign-out did not finish.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (phase === "loading") {
    return <main className="browser-loading"><span /><p>Checking your access…</p></main>;
  }
  if (phase === "signed-out" || entitlement?.entitlement.status !== "active") {
    return <Login onSignedIn={acceptSession} />;
  }

  return (
    <main className="access-page">
      <header className="access-header">
        <a href="/" className="browser-wordmark">DAYTRADINGBOT</a>
        <div>
          <span><i aria-hidden="true" /> License active</span>
          <button type="button" onClick={() => void logout()} disabled={busy}>Sign out</button>
        </div>
      </header>

      <section className="access-hero">
        <div>
          <p className="browser-eyebrow"><span /> Your Bluechip access is active</p>
          <h1>Trade through Robinhood from the Mac app.</h1>
          <p>Download DayTradingBot on the Mac you will use. That is where you connect Robinhood, choose Bluechip, set your dollar limits, and start Practice or Real.</p>
          <div className="access-actions">
            <a className="access-primary" href={siteConfig.macosDownloadUrl}>Download DayTradingBot for Mac</a>
            <a className="access-secondary" href={`mailto:${siteConfig.supportEmail}?subject=DayTradingBot%20Mac%20setup`}>Get setup help</a>
          </div>
          <small>Keep the access code from your receipt. You will enter it once in the Mac app.</small>
        </div>
        <aside className="access-why">
          <p>Why the Mac app?</p>
          <h2>Your Robinhood connection stays with you.</h2>
          <p>The website confirms your license. The Mac app keeps your Robinhood connection and trading history on your computer instead of storing them on DayTradingBot's website.</p>
        </aside>
      </section>

      {error && <div className="browser-error access-error" role="alert">{error}</div>}

      <section className="access-steps" aria-labelledby="access-steps-title">
        <div>
          <p className="browser-eyebrow">Four clear steps</p>
          <h2 id="access-steps-title">From download to your first Practice run.</h2>
        </div>
        <ol>
          <li>
            <span>01</span>
            <div><strong>Open the Mac app</strong><p>Install DayTradingBot and enter the access code from your receipt.</p></div>
          </li>
          <li>
            <span>02</span>
            <div><strong>Connect Robinhood</strong><p>Connect your Robinhood Agentic account inside the app. Your money stays at Robinhood.</p></div>
          </li>
          <li>
            <span>03</span>
            <div><strong>Choose Bluechip and your limits</strong><p>Pick Practice or Real, then set the most it may use for one trade and for the whole day.</p></div>
          </li>
          <li>
            <span>04</span>
            <div><strong>Press Start</strong><p>Start with Practice to watch current decisions without sending an order. Choose Real only when you are ready.</p></div>
          </li>
        </ol>
      </section>

      <section className="access-facts" aria-label="What to expect">
        <article><span>YOUR MONEY</span><h2>Stays at Robinhood</h2><p>DayTradingBot cannot deposit, transfer, or withdraw your money.</p></article>
        <article><span>YOUR LIMITS</span><h2>Dollars, not jargon</h2><p>You choose a maximum for one trade and another for new trades that day.</p></article>
        <article><span>YOUR CHOICE</span><h2>Practice or Real</h2><p>Practice sends no order. Real can place allowed orders and must be approved again within 24 hours.</p></article>
      </section>

      <footer className="access-footer">
        <p>Real trading can lose money. DayTradingBot does not promise a profit.</p>
        <div><a href="/risk-disclosure/">Risk</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a></div>
      </footer>
    </main>
  );
}
