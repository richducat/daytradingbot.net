import { useEffect, useMemo, useState } from "react";
import { siteConfig } from "./siteConfig";

type CheckoutResult = {
  status: "paid";
  email: string;
  activationCode: string;
  emailDelivered: boolean;
  downloads: {
    macos?: string;
    webApp?: string;
  };
};

function validResult(value: unknown): value is CheckoutResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CheckoutResult>;
  return candidate.status === "paid"
    && typeof candidate.email === "string"
    && typeof candidate.activationCode === "string"
    && /^DTB-[A-Z0-9-]{12,80}$/.test(candidate.activationCode)
    && typeof candidate.emailDelivered === "boolean"
    && Boolean(candidate.downloads)
    && typeof candidate.downloads === "object";
}

export function Welcome() {
  const sessionId = useMemo(
    () => {
      const params = new URLSearchParams(window.location.search);
      return params.get("session") ?? params.get("session_id");
    },
    [],
  );
  const isSandbox = sessionId?.startsWith("cs_test_") ?? false;
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = "Your Bluechip dashboard is ready | DayTradingBot";
    if (!sessionId) {
      setError("This page needs the private checkout link Stripe sent after payment.");
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;

    async function load(attempt: number) {
      try {
        const response = await fetch(
          `${siteConfig.apiBaseUrl}/v1/checkout/status?session=${encodeURIComponent(sessionId as string)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (response.status === 409 && attempt < 12) {
          timer = window.setTimeout(() => void load(attempt + 1), 2_000);
          return;
        }
        const payload: unknown = await response.json();
        if (!response.ok || !validResult(payload)) throw new Error("fulfillment_unavailable");
        setResult(payload);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError("We could not finish delivery on this screen. Your payment is safe. Please refresh once, or email support and include your Stripe receipt email.");
      }
    }

    void load(0);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [sessionId]);

  async function copyCode() {
    if (!result) return;
    await navigator.clipboard.writeText(result.activationCode);
    setCopied(true);
  }

  return (
    <main className="welcome-page">
      <header className="intake-header">
        <a className="wordmark" href="/">DAYTRADINGBOT</a>
        <span>Secure delivery</span>
      </header>

      {!result && !error && (
        <section className="welcome-state" aria-live="polite">
          <p className="eyebrow">Payment received</p>
          <h1>We are opening your Bluechip dashboard.</h1>
          <p>Your private access code is being created now. This usually takes a few seconds.</p>
          <div className="delivery-progress" aria-hidden="true"><span /></div>
        </section>
      )}

      {error && (
        <section className="welcome-state" role="alert">
          <p className="eyebrow">Delivery needs one more try</p>
          <h1>Your purchase is not lost.</h1>
          <p>{error}</p>
          <a className="button button-primary" href={`mailto:${siteConfig.supportEmail}`}>Email support</a>
        </section>
      )}

      {result && (
        <>
          <section className="welcome-hero">
            <div>
              <p className="eyebrow">{isSandbox ? "Sandbox demo complete" : "Purchase complete"}</p>
              <h1>{isSandbox ? "Checkout and access are working." : "You're in. Open your bot."}</h1>
              <p>{isSandbox
                ? "This test created an activation code and sent the delivery email. No money moved."
                : "Copy the code below, open your Bluechip dashboard, and start with a Practice run. Nothing needs to be downloaded."}</p>
              <p className="delivery-email">{result.emailDelivered
                ? `We also sent these details to ${result.email}.`
                : `Copy this code now. We are still sending a copy to ${result.email}.`}</p>
            </div>
            <div className="activation-card">
              <span>Your access code</span>
              <code>{result.activationCode}</code>
              <button type="button" onClick={() => void copyCode()}>{copied ? "Copied" : "Copy code"}</button>
            </div>
          </section>

          <section className="download-section">
            <div>
              <p className="eyebrow">Step 1</p>
              <h2>{isSandbox ? "Open the owner demo." : "Open Bluechip in your browser."}</h2>
              <p>{isSandbox
                ? "For the investor demo, open the browser app with the owner code. The signed public Mac download remains optional."
                : "Paste your access code, connect Robinhood, choose the most Bluechip may use, and start in Practice. The Mac app is optional."}</p>
            </div>
            <div className="download-actions">
              <a className="button button-primary" href={result.downloads.webApp ?? "/app/"}>Open my Bluechip dashboard</a>
              {!isSandbox && result.downloads.macos && <a className="button button-secondary" href={result.downloads.macos}>Download for Mac</a>}
            </div>
          </section>

          <section className="setup-steps">
            <article><span>02</span><h2>Paste your code.</h2><p>Your access code opens the dashboard on any modern phone or computer browser.</p></article>
            <article><span>03</span><h2>Connect Robinhood.</h2><p>Robinhood handles sign-in. Your trading money stays in its dedicated Agentic account.</p></article>
            <article><span>04</span><h2>Start with Practice.</h2><p>Review the suggested dollar limits, start Bluechip, and watch its first current-market decision without placing an order.</p></article>
          </section>

          <footer className="result-footer welcome-footer">
            <a href={`mailto:${siteConfig.supportEmail}`}>Need setup help?</a>
            <span>Real trading can lose money. Bluechip does not promise a profit.</span>
          </footer>
        </>
      )}
    </main>
  );
}
