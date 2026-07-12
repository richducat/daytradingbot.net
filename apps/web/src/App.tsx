import { motion, useReducedMotion } from "framer-motion";
import { siteConfig } from "./siteConfig";
import { isLegalPath, LegalPage } from "./LegalPage";

const reveal = {
  hidden: { opacity: 0, y: 22 },
  visible: { opacity: 1, y: 0 },
};

function MarketLine({ reduceMotion }: { reduceMotion: boolean | null }) {
  return (
    <svg
      className="market-line"
      viewBox="0 0 1200 420"
      role="img"
      aria-label="Abstract market signal passing through a risk threshold"
    >
      <defs>
        <linearGradient id="lineFade" x1="0" x2="1">
          <stop offset="0" stopColor="#b9ff58" stopOpacity="0" />
          <stop offset="0.32" stopColor="#b9ff58" stopOpacity="0.95" />
          <stop offset="1" stopColor="#f4efe3" stopOpacity="0.58" />
        </linearGradient>
      </defs>
      <g className="market-grid" aria-hidden="true">
        <path d="M0 84H1200M0 168H1200M0 252H1200M0 336H1200" />
        <path d="M200 0V420M400 0V420M600 0V420M800 0V420M1000 0V420" />
      </g>
      <motion.path
        className="signal-path"
        d="M0 300 C95 312 110 208 190 230 S320 330 390 244 S500 130 565 212 S685 278 750 154 S865 94 922 170 S1040 290 1200 102"
        fill="none"
        stroke="url(#lineFade)"
        strokeWidth="4"
        initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 1.45, ease: "easeOut", delay: 0.35 }}
      />
      <motion.circle
        cx="922"
        cy="170"
        r="8"
        fill="#b9ff58"
        initial={reduceMotion ? false : { scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 1.45, type: "spring", stiffness: 180 }}
      />
      <text x="940" y="164" className="chart-label">RISK CLEARED</text>
    </svg>
  );
}

function SectionHeading({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return (
    <div className="section-heading">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{children}</h2>
    </div>
  );
}

export function App() {
  const reduceMotion = useReducedMotion();
  const path = window.location.pathname.endsWith("/")
    ? window.location.pathname
    : `${window.location.pathname}/`;

  if (isLegalPath(path)) {
    return <LegalPage path={path} />;
  }

  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="DayTradingBot home">
          DAYTRADINGBOT
        </a>
        <nav aria-label="Primary navigation">
          <a href="#agents">Agents</a>
          <a href="#risk">Risk</a>
          <a href="#founder">Founder access</a>
        </nav>
      </header>

      <section className="hero" id="top">
        <div className="hero-wash" aria-hidden="true" />
        <motion.div
          className="hero-copy"
          initial={reduceMotion ? false : "hidden"}
          animate="visible"
          variants={reveal}
          transition={{ duration: 0.62, ease: "easeOut" }}
        >
          <p className="eyebrow"><span className="status-dot" /> Commercial build in progress</p>
          <h1>Four live venues.<br />One hard risk core.</h1>
          <p className="hero-deck">
            A local-first agent set for equities, spot crypto, and event markets. Credentials stay on your machine. Limits cannot be raised.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#founder">See founder access</a>
            <a className="text-link" href="#risk">Read the limits <span aria-hidden="true">↘</span></a>
          </div>
        </motion.div>
        <div className="hero-visual">
          <MarketLine reduceMotion={reduceMotion} />
          <div className="risk-rule" aria-hidden="true">
            <span>MAX OPEN</span>
            <strong>${siteConfig.limits.maxOpeningOrderUsd}</strong>
          </div>
        </div>
        <p className="hero-footnote">Self-directed automation software. Trading involves loss risk. No performance guarantee.</p>
      </section>

      <motion.section
        className="agents section-shell"
        id="agents"
        initial={reduceMotion ? false : "hidden"}
        whileInView="visible"
        viewport={{ once: true, amount: 0.2 }}
        variants={reveal}
        transition={{ duration: 0.55 }}
      >
        <SectionHeading eyebrow="The agent set">Separate signals. Shared enforcement.</SectionHeading>
        <div className="venue-list">
          {siteConfig.venues.map((venue, index) => (
            <div className="venue-row" key={venue.name}>
              <span className="venue-index">0{index + 1}</span>
              <h3>{venue.name}</h3>
              <p>{venue.scope}</p>
              <small>{venue.gate}</small>
            </div>
          ))}
        </div>
      </motion.section>

      <section className="risk-section" id="risk">
        <div className="section-shell risk-layout">
          <div className="sticky-copy">
            <SectionHeading eyebrow="The control plane">The limit is the product.</SectionHeading>
            <p>
              Every signal becomes a deterministic intent. Exposure is reserved before submission, and unknown orders reconcile before retry.
            </p>
          </div>
          <div className="risk-ledger">
            {[
              ["Opening order", `$${siteConfig.limits.maxOpeningOrderUsd}`],
              ["New notional / venue day", `$${siteConfig.limits.maxDailyOpeningNotionalUsd}`],
              ["Open exposure / venue", `$${siteConfig.limits.maxVenueExposureUsd}`],
              ["Global open exposure", `$${siteConfig.limits.maxGlobalExposureUsd}`],
              ["Daily loss stop / venue", `$${siteConfig.limits.maxDailyLossUsd}`],
            ].map(([label, value]) => (
              <div className="limit-row" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>Customer may lower, never raise</small>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="flow section-shell" aria-labelledby="flow-heading">
        <SectionHeading eyebrow="Local by design"><span id="flow-heading">Signal → risk → venue.</span></SectionHeading>
        <div className="flow-line" aria-label="Trade lifecycle">
          <div><span>01</span><strong>Signal</strong><p>Fresh, strategy-owned event.</p></div>
          <div><span>02</span><strong>Reserve</strong><p>Atomic caps and eligibility.</p></div>
          <div><span>03</span><strong>Submit</strong><p>One deterministic order ID.</p></div>
          <div><span>04</span><strong>Reconcile</strong><p>No blind resubmission.</p></div>
        </div>
      </section>

      <section className="founder" id="founder">
        <div className="section-shell founder-inner">
          <div>
            <p className="eyebrow">Founding release</p>
            <h2>Ten seats.<br />One-time access.</h2>
          </div>
          <div className="offer-copy">
            <p className="price"><sup>$</sup>{siteConfig.founderPrice}</p>
            <p>One active Windows or Mac device. Perpetual v1 access and v1 updates. Venue accounts and trading capital are separate.</p>
            <button className="button button-disabled" type="button" disabled>
              Checkout opens after launch gates
            </button>
            <small>30-day get-running refund. Market losses and strategy performance are excluded.</small>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <a className="wordmark" href="#top">DAYTRADINGBOT</a>
        <p>Self-directed trading automation. Not investment advice.</p>
        <div>
          <a href="/risk-disclosure/">Risk</a>
          <a href="/privacy/">Privacy</a>
          <a href="/terms/">Terms</a>
          <a href="mailto:support@daytradingbot.net">Support</a>
        </div>
      </footer>
    </main>
  );
}
