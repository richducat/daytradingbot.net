import { motion, useReducedMotion } from "framer-motion";
import { isLegalPath, LegalPage } from "./LegalPage";
import { Onboarding } from "./Onboarding";
import { siteConfig } from "./siteConfig";

const reveal = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } };

function SectionHeading({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return <div className="section-heading"><p className="eyebrow">{eyebrow}</p><h2>{children}</h2></div>;
}

const productFlow = [
  ["Connect your own account", "The desktop app connects to a supported broker, exchange, or approved market account. Your trading money stays there."],
  ["One agent watches one kind of market", "Each agent follows a defined approach. It checks market information and either finds a matching opportunity or does nothing."],
  ["You choose Practice or Real", "Practice records what the agent would do and sends no order. Real may place an order only inside the dollar limits you chose."],
  ["You see every decision", "The app keeps an activity record showing what it checked, why it acted or skipped, the amount, and the account response."],
] as const;

const screeningReasons = [
  "what you want the software to help with",
  "which market and trading approach you understand",
  "which account you own or are willing to set up",
  "your experience and how often you will review activity",
  "the most the app may put into new trades each day",
  "whether you understand that the full amount may be lost",
] as const;

const faqs = [
  ["What exactly is DayTradingBot?", "It is a desktop software app. You connect a supported account, choose one specialized trading agent, set dollar limits, and choose Practice or Real. The agent checks its market automatically and records what happens."],
  ["Why do I have to answer so many questions?", "Because the account, market, strategy, experience, review habits, and dollar amount all affect which setup makes sense. If the answers point to an unreleased agent or an unsafe expectation, payment should not be offered."],
  ["Is the agent match investment advice?", "No. It is a software-compatibility and starting-setup recommendation based on the preferences you provide. It does not predict returns or tell you that a trade is suitable for your financial situation."],
  ["Where do I deposit trading money?", "Not with DayTradingBot. You add funds directly through the broker, exchange, or market account you own. The software is not a bank, broker, exchange, or custodian."],
  ["Can it place real trades?", "The Bluechip customer app has a protected Real-trading path for a dedicated Robinhood Agentic account. Sales remain closed until the production activation server, signed installers, and final approved small-dollar live test are complete."],
  ["What if my best-matched agent is not released?", "You will see the match and the reason, but no purchase option. We will not sell you a different agent merely because it is available."],
  ["What would the $98 license include?", "One active Mac or Windows computer, the version 1 desktop app, and version 1 updates. Trading capital, venue fees, taxes, and account charges are separate."],
] as const;

export function App() {
  const reduceMotion = useReducedMotion();
  const path = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
  if (isLegalPath(path)) return <LegalPage path={path} />;
  if (path === "/get-started/") return <Onboarding />;

  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="DayTradingBot home">DAYTRADINGBOT</a>
        <nav aria-label="Primary navigation"><a href="#product">What it is</a><a href="#example">Example</a><a href="#match">Your match</a><a href="#price">Price</a></nav>
        <a className="header-cta" href="/get-started/">Find my agent</a>
      </header>

      <section className="hero" id="top">
        <div className="hero-wash" aria-hidden="true" />
        <motion.div
          className="hero-copy"
          initial={reduceMotion ? false : "hidden"}
          animate="visible"
          variants={reveal}
          transition={{ duration: 0.55, ease: "easeOut" }}
        >
          <p className="eyebrow"><span className="status-dot" /> AI trading software for self-directed investors</p>
          <h1>Get matched before you buy.</h1>
          <p className="hero-deck">DayTradingBot is a desktop app that connects to your own trading account, gives one specialized AI agent a market to watch, and lets it practice or place trades inside dollar limits you set.</p>
          <div className="hero-actions">
            <a className="button button-primary" href="/get-started/">Find my agent <span>About 2 minutes</span></a>
            <a className="text-link" href="#product">See exactly what I am getting <span aria-hidden="true">↓</span></a>
          </div>
          <p className="hero-note">No payment before your result. No account password. No deposit to us. No promise of profit.</p>
        </motion.div>

        <motion.figure
          className="hero-product"
          initial={reduceMotion ? false : { opacity: 0, y: 28, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.7, delay: 0.12, ease: "easeOut" }}
        >
          <img src="/images/daytradingbot-desktop-setup.png" alt="The DayTradingBot desktop app showing the account connection step" />
          <figcaption><span>Actual desktop setup screen</span> Account connections happen after purchase and remain on your computer.</figcaption>
        </motion.figure>
      </section>

      <section className="product-explainer section-shell" id="product">
        <div className="product-statement">
          <p className="eyebrow">What am I buying?</p>
          <h2>A desktop app that watches a market and follows one agent's rules.</h2>
          <p>It is not an investing account and it is not a chat window giving random tips. It is software that runs a defined trading process through an account you control.</p>
        </div>
        <div className="product-flow">
          {productFlow.map(([title, body], index) => (
            <article key={title}>
              <span>0{index + 1}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="bluechip-example" id="example">
        <div className="section-shell example-layout">
          <div className="example-copy">
            <p className="eyebrow">A real example: Bluechip</p>
            <h2>Here is what the first customer agent actually does.</h2>
            <p>Bluechip is the first agent packaged in the customer app. Its job is narrow on purpose: look for pullbacks in a short list of widely held stocks and funds.</p>
            <a className="text-link dark-link" href="/get-started/">See if Bluechip fits me <span aria-hidden="true">→</span></a>
          </div>
          <dl className="example-rules">
            <div><dt>Market watched</dt><dd>AAPL, NVDA, TSLA, SPY, QQQ, AMD, MSFT, GOOGL</dd></div>
            <div><dt>How often it checks</dt><dd>About every 15 minutes while running</dd></div>
            <div><dt>What it looks for</dt><dd>A pullback of at least 1.5%</dd></div>
            <div><dt>How much it may use</dt><dd>$1–$5 per trade, up to $25 in new trades per day</dd></div>
            <div><dt>What Practice does</dt><dd>Uses current market information and records the decision; sends no order</dd></div>
            <div><dt>What it does not do</dt><dd>Promise a profit, transfer money, withdraw funds, or trade outside its rules</dd></div>
          </dl>
        </div>
      </section>

      <section className="screening-section" id="match">
        <div className="section-shell screening-layout">
          <div className="screening-title">
            <p className="eyebrow">Before payment</p>
            <span className="question-count">9</span>
            <h2>First, we interview you.</h2>
            <p>Every answer is used. We do not ask for a phone number, Social Security number, brokerage password, or deposit.</p>
          </div>
          <div className="screening-list">
            <p>We ask about:</p>
            <ol>{screeningReasons.map((reason, index) => <li key={reason}><span>0{index + 1}</span>{reason}</li>)}</ol>
            <div className="screening-stop"><strong>We may stop the sale.</strong><p>If you expect guaranteed returns, cannot afford the selected amount, will not review activity, or match an agent that is not released, you will not see checkout.</p></div>
            <a className="button button-primary" href="/get-started/">Start my fit review</a>
          </div>
        </div>
      </section>

      <section className="routing-section">
        <div className="section-shell">
          <SectionHeading eyebrow="Your answers change the result">There is no universal “best bot.”</SectionHeading>
          <div className="routing-table">
            <div className="routing-head"><span>If you want to trade</span><span>Your likely match</span><span>Purchase status</span></div>
            <div><span>Large stocks and ETFs</span><strong>Bluechip</strong><small className="available">Available first</small></div>
            <div><span>Short-term crypto moves</span><strong>Sprinter</strong><small>Still being packaged</small></div>
            <div><span>Weather and public data</span><strong>Stormfront or Barometer</strong><small>Still being packaged</small></div>
            <div><span>News and prediction markets</span><strong>News Watch or Oracle Gap</strong><small>Still being packaged</small></div>
          </div>
          <p className="routing-note">The match page explains why, which account is required, whether Practice is mandatory, and the exact starting limits. An unreleased match cannot continue to payment.</p>
        </div>
      </section>

      <section className="customer-journey">
        <div className="section-shell journey-layout">
          <SectionHeading eyebrow="After you are matched">Know every step before entering a card number.</SectionHeading>
          <ol>
            <li><span>01</span><div><h3>Review your plan</h3><p>Agent, required account, Practice or Real, daily amount, and per-trade amount.</p></div></li>
            <li><span>02</span><div><h3>Purchase the software</h3><p>One desktop license. Your trading funds and venue fees are separate.</p></div></li>
            <li><span>03</span><div><h3>Install and connect</h3><p>Connect the supported account in the app. Credentials stay in your computer's secure storage.</p></div></li>
            <li><span>04</span><div><h3>Press Start Practice</h3><p>Watch the agent check its market and review its activity without sending an order.</p></div></li>
            <li><span>05</span><div><h3>Choose Real only when ready</h3><p>Confirm the account and dollar limits again, then press Start. Pause stops new trades.</p></div></li>
          </ol>
        </div>
      </section>

      <section className="founder" id="price">
        <div className="section-shell founder-inner">
          <div>
            <p className="eyebrow">Price after a qualifying match</p>
            <h2>${siteConfig.founderPrice} once.</h2>
            <p className="price-qualifier">One active Mac or Windows computer. Version 1 and version 1 updates.</p>
          </div>
          <div className="offer-copy">
            <ul>
              <li>Desktop app and guided account setup</li>
              <li>Practice and protected Real modes for released agents</li>
              <li>Agent activity history and fixed customer maximums</li>
              <li>Trading capital, account fees, and taxes not included</li>
            </ul>
            <a className="button offer-button" href="/get-started/">Find my agent before I buy</a>
            <small>Checkout is closed during final testing. Completing the fit review does not create an account or charge you.</small>
          </div>
        </div>
      </section>

      <section className="faq section-shell" aria-labelledby="faq-heading">
        <SectionHeading eyebrow="Straight answers"><span id="faq-heading">What you should know before the fit review.</span></SectionHeading>
        <div className="faq-list">{faqs.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div>
      </section>

      <section className="final-cta">
        <p className="eyebrow">No blind checkout</p>
        <h2>Find out what fits—and what does not.</h2>
        <a className="button button-primary" href="/get-started/">Start my 2-minute fit review</a>
        <p>Answers stay in this browser during pre-launch testing.</p>
      </section>

      <footer className="site-footer">
        <a className="wordmark" href="#top">DAYTRADINGBOT</a>
        <p>Self-directed trading automation. Not investment advice.</p>
        <div><a href="/risk-disclosure/">Risk</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="mailto:support@daytradingbot.net">Support</a></div>
      </footer>
    </main>
  );
}
