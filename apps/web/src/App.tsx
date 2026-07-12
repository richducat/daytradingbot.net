import { motion, useReducedMotion } from "framer-motion";
import { isLegalPath, LegalPage } from "./LegalPage";
import { siteConfig } from "./siteConfig";

const reveal = { hidden: { opacity: 0, y: 22 }, visible: { opacity: 1, y: 0 } };

function MarketLine({ reduceMotion }: { reduceMotion: boolean | null }) {
  return (
    <svg className="market-line" viewBox="0 0 1200 420" role="img" aria-label="A market signal passing through a five-dollar trade limit">
      <defs><linearGradient id="lineFade" x1="0" x2="1"><stop offset="0" stopColor="#b9ff58" stopOpacity="0" /><stop offset="0.32" stopColor="#b9ff58" stopOpacity="0.95" /><stop offset="1" stopColor="#f4efe3" stopOpacity="0.58" /></linearGradient></defs>
      <g className="market-grid" aria-hidden="true"><path d="M0 84H1200M0 168H1200M0 252H1200M0 336H1200" /><path d="M200 0V420M400 0V420M600 0V420M800 0V420M1000 0V420" /></g>
      <motion.path className="signal-path" d="M0 300 C95 312 110 208 190 230 S320 330 390 244 S500 130 565 212 S685 278 750 154 S865 94 922 170 S1040 290 1200 102" fill="none" stroke="url(#lineFade)" strokeWidth="4" initial={reduceMotion ? false : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ duration: 1.45, ease: "easeOut", delay: 0.35 }} />
      <motion.circle cx="922" cy="170" r="8" fill="#b9ff58" initial={reduceMotion ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 1.45, type: "spring", stiffness: 180 }} />
      <text x="940" y="164" className="chart-label">LIMIT CHECKED</text>
    </svg>
  );
}

function SectionHeading({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return <div className="section-heading"><p className="eyebrow">{eyebrow}</p><h2>{children}</h2></div>;
}

const setupSteps = [
  ["Install the app", "Download DayTradingBot on your Windows PC or Mac."],
  ["Connect an account", "Use a supported trading account you already own. Your login stays on your computer."],
  ["Choose what runs", "Pick an available trading strategy and lower the limits if you want less risk."],
  ["Turn it on—or stop it", "Nothing trades until you enable live entries. Pause new trades from the desktop app anytime."],
] as const;

const faqs = [
  ["Do I need to know how to code?", "No. DayTradingBot is being built as a guided desktop app, not a developer tool."],
  ["Does it guarantee a profit?", "No. Every trade can lose money. The limits reduce how much the software can put at risk; they cannot make trading safe or profitable."],
  ["Can the bot withdraw my money?", "No. Supported connections must not include transfer or withdrawal permission. Your cash and investments remain at your broker or exchange."],
  ["Can I make the limits higher?", "No. You may lower the limits, but the built-in maximums cannot be raised from the app."],
  ["Can I buy it today?", "Not yet. Checkout stays closed until account connections, signed installers, legal review, and live-order testing are complete."],
] as const;

export function App() {
  const reduceMotion = useReducedMotion();
  const path = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
  if (isLegalPath(path)) return <LegalPage path={path} />;

  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="DayTradingBot home">DAYTRADINGBOT</a>
        <nav aria-label="Primary navigation"><a href="#how">How it works</a><a href="#safety">Safety limits</a><a href="#accounts">Accounts</a><a href="#founder">Price</a></nav>
      </header>

      <section className="hero" id="top">
        <div className="hero-wash" aria-hidden="true" />
        <motion.div className="hero-copy" initial={reduceMotion ? false : "hidden"} animate="visible" variants={reveal} transition={{ duration: 0.62, ease: "easeOut" }}>
          <p className="eyebrow"><span className="status-dot" /> Founder release in testing</p>
          <h1>Put a trading bot to work—without giving it a blank check.</h1>
          <p className="hero-deck">DayTradingBot watches selected markets and places small trades from your own accounts. Every new trade is capped at $5, total exposure is limited, and you can stop it from one desktop app.</p>
          <div className="hero-actions"><a className="button button-primary" href="#how">See how it works</a><a className="text-link" href="#safety">View the safety limits <span aria-hidden="true">↘</span></a></div>
          <p className="hero-note">Designed for Windows and Mac. No coding required. Your trading accounts stay in your name.</p>
        </motion.div>
        <div className="hero-visual"><MarketLine reduceMotion={reduceMotion} /><div className="risk-rule" aria-hidden="true"><span>EACH NEW TRADE</span><strong>${siteConfig.limits.maxOpeningOrderUsd} MAX</strong></div></div>
        <p className="hero-footnote">Trading can lose money. DayTradingBot is software, not investment advice.</p>
      </section>

      <motion.section className="how section-shell" id="how" initial={reduceMotion ? false : "hidden"} whileInView="visible" viewport={{ once: true, amount: 0.18 }} variants={reveal} transition={{ duration: 0.55 }}>
        <SectionHeading eyebrow="How it works">You stay in control from setup to stop.</SectionHeading>
        <div className="step-list">{setupSteps.map(([title, body], index) => <motion.div className="step-row" key={title} whileHover={reduceMotion ? undefined : { x: 6 }} transition={{ duration: 0.16 }}><span className="step-number">0{index + 1}</span><h3>{title}</h3><p>{body}</p></motion.div>)}</div>
      </motion.section>

      <section className="safety-section" id="safety"><div className="section-shell safety-layout">
        <div className="sticky-copy"><SectionHeading eyebrow="Built-in guardrails">The bot gets rules. You keep control.</SectionHeading><p>These are ceilings, not settings you can accidentally raise. You can always choose lower limits.</p></div>
        <div className="limit-list" aria-label="Maximum trading limits">{[
          ["Each new trade", `$${siteConfig.limits.maxOpeningOrderUsd}`, "The most it can put into one new order."],
          ["New trades in one account per day", `$${siteConfig.limits.maxDailyOpeningNotionalUsd}`, "Stops a strategy from repeatedly opening new positions."],
          ["In one connected account", `$${siteConfig.limits.maxVenueExposureUsd}`, "Maximum open exposure at one broker or exchange."],
          ["Across every connected account", `$${siteConfig.limits.maxGlobalExposureUsd}`, "One limit across the whole desktop app."],
          ["Loss stop for one account per day", `$${siteConfig.limits.maxDailyLossUsd}`, "New trades stop after the daily loss threshold is reached."],
        ].map(([label, value, explanation]) => <div className="limit-row" key={label}><span>{label}</span><strong>{value}</strong><small>{explanation}</small></div>)}</div>
      </div></section>

      <section className="accounts section-shell" id="accounts">
        <SectionHeading eyebrow="Planned account connections">Use the accounts you already have.</SectionHeading>
        <p className="section-intro">Connections will roll out one at a time after each passes account, order, cancellation, and recovery testing.</p>
        <div className="account-list">{siteConfig.accounts.map((account, index) => <div className="account-row" key={account.name}><span className="account-index">0{index + 1}</span><h3>{account.name}</h3><p>{account.market}</p><small>{account.status}</small></div>)}</div>
      </section>

      <section className="boundaries"><div className="section-shell boundary-layout">
        <div><p className="eyebrow">What it can do</p><h2>Automate a small, clearly limited trading plan.</h2><ul><li>Watch supported markets for a selected strategy</li><li>Place small orders only after you enable live trading</li><li>Keep a local history of signals, orders, and fills</li><li>Pause new entries while leaving position exits available</li></ul></div>
        <div><p className="eyebrow">What it cannot do</p><h2>Move your money, raise its limits, or promise a return.</h2><ul><li>No withdrawal or transfer permission</li><li>No hidden increase to the built-in maximums</li><li>No blind order retry when an account response is unclear</li><li>No guarantee that a strategy will make money</li></ul></div>
      </div></section>

      <section className="founder" id="founder"><div className="section-shell founder-inner">
        <div><p className="eyebrow">Founding desktop license</p><h2>${siteConfig.founderPrice} once.<br />Only {siteConfig.founderSeats} early users.</h2></div>
        <div className="offer-copy"><p>One active Windows or Mac device, perpetual access to version 1, and version 1 updates. Your trading accounts and trading money are separate.</p><button className="button button-disabled" type="button" disabled>Sales open after live testing</button><small>Includes a 30-day get-running refund for setup problems. Trading losses, fees, and strategy results are not refundable.</small></div>
      </div></section>

      <section className="faq section-shell" aria-labelledby="faq-heading"><SectionHeading eyebrow="Straight answers"><span id="faq-heading">Questions a first-time buyer should ask.</span></SectionHeading><div className="faq-list">{faqs.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div></section>

      <footer className="site-footer"><a className="wordmark" href="#top">DAYTRADINGBOT</a><p>Self-directed trading automation. Not investment advice.</p><div><a href="/risk-disclosure/">Risk</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="mailto:support@daytradingbot.net">Support</a></div></footer>
    </main>
  );
}
