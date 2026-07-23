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
    document.title = "Your DayTradingBot Mac app is ready";
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
          <h1>We are getting your Mac app ready.</h1>
          <p>Your access code and download are being prepared now. This usually takes a few seconds.</p>
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
              <h1>{isSandbox ? "Checkout and access are working." : "You're in. Download the app."}</h1>
              <p>{isSandbox
                ? "This test created an activation code and sent the delivery email. No money moved."
                : "Copy the code below, download DayTradingBot on the Mac you will use, and start with a Practice run."}</p>
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
              <h2>{isSandbox ? "Open the owner demo on this Mac." : "Download DayTradingBot for Mac."}</h2>
              <p>{isSandbox
                ? "Use the private owner copy already installed on this Mac and enter the owner access code."
                : "Install the app, enter your access code, then connect Robinhood and choose your dollar limits inside the app."}</p>
            </div>
            <div className="download-actions">
              {!isSandbox && <a className="button button-primary" href={result.downloads.macos ?? siteConfig.macosDownloadUrl}>Download for Mac</a>}
              <a className="button button-secondary" href={result.downloads.webApp ?? "/app/"}>Open customer access</a>
            </div>
          </section>

          <section className="setup-steps">
            <article><span>02</span><h2>Enter your code.</h2><p>Open the Mac app and enter your access code once to activate this computer.</p></article>
            <article><span>03</span><h2>Connect Robinhood.</h2><p>Connect inside the Mac app. Your Robinhood connection and trading history stay on your Mac, and your money stays at Robinhood.</p></article>
            <article><span>04</span><h2>Choose your limits.</h2><p>Pick Bluechip, Practice or Real, the dollars per trade, and the dollars per day. Real permission lasts no more than 24 hours.</p></article>
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
