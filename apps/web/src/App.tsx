import { motion, useReducedMotion } from "framer-motion";
import { isLegalPath, LegalPage } from "./LegalPage";
import { Onboarding } from "./Onboarding";
import { siteConfig } from "./siteConfig";
import { Welcome } from "./Welcome";
import { WebApp } from "./WebApp";

const reveal = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } };

function SectionHeading({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return <div className="section-heading"><p className="eyebrow">{eyebrow}</p><h2>{children}</h2></div>;
}

const productFlow = [
  ["You stop refreshing charts", "Bluechip checks eight popular stocks and ETFs about every 15 minutes while the Mac app is running."],
  ["The rule stays the same", "It waits for a specific pullback. It does not get impatient, chase a price, or change the plan halfway through the day."],
  ["You choose the maximum dollars", "Set a limit for each trade and another for the whole day. Bluechip cannot open a trade above either one."],
  ["You can see every decision", "Open Activity in the Mac app to see what Bluechip checked, why it waited, and whether an order was sent."],
] as const;

const screeningReasons = [
  "the bot that fits what you want",
  "the account you will need",
  "whether to start in Practice or Real",
  "a daily dollar limit",
  "a limit for each trade",
  "what to expect after checkout",
] as const;

const faqs = [
  ["So what am I actually buying?", "A personal license for the DayTradingBot Mac app. It includes Bluechip, Practice, Real trading controls, your activity history, guided setup, and version 1 updates."],
  ["What does Bluechip do while I am at work?", "When it is running, Bluechip checks eight stocks and ETFs about every 15 minutes. If one falls enough to meet its rule, it checks the current price, your open positions, pending orders, and the dollar limits you chose before it does anything."],
  ["Can I watch it before it touches real money?", "Yes. Practice uses current market information and shows what Bluechip would do without sending an order. You decide if and when to switch to Real."],
  ["Do I send my trading money to DayTradingBot?", "No. Your trading money stays in the dedicated Robinhood Agentic account you control. DayTradingBot is software. It is not a bank, broker, exchange, or place to deposit funds."],
  ["Can Bluechip place real trades?", "Yes. In the Mac app, connect a supported Robinhood Agentic account, choose your per-trade and daily dollar limits, and deliberately turn on Real. That permission lasts no more than 24 hours before you must approve it again."],
  ["Can I lose money?", "Yes. A rule-based bot can still make a losing trade, and software or account connections can fail. Your limits cap how much Bluechip may put into new trades. They cannot prevent a loss or promise a profit."],
  ["Do I need a Mac or an Apple account?", "You need a compatible Mac for the current release. You do not need an Apple account to use DayTradingBot. The website handles the questionnaire, checkout, license sign-in, and download."],
  ["Why do you ask eight questions?", "So you can see a suggested bot, account, mode, and dollar limits before you pay. Your answers are not a test, and they never remove access to a released bot."],
  ["What happens after I pay?", "Stripe confirms the payment, then your private access code and Mac download appear on screen. We also send them to the email used at checkout."],
] as const;

export function App() {
  const reduceMotion = useReducedMotion();
  const path = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
  if (isLegalPath(path)) return <LegalPage path={path} />;
  if (path === "/get-started/") return <Onboarding />;
  if (path === "/welcome/") return <Welcome />;
  if (path === "/app/") return <WebApp />;

  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="DayTradingBot home">DAYTRADINGBOT</a>
        <nav aria-label="Primary navigation"><a href="#product">Why use it</a><a href="#example">Bluechip</a><a href="#setup">Setup</a><a href="#price">Price</a><a href="/app/">Sign in</a></nav>
        <a className="header-cta" href="/get-started/">Find my setup</a>
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
          <p className="eyebrow"><span className="status-dot" /> A stock trading bot you can understand</p>
          <h1>Stop watching stock charts all day.</h1>
          <p className="hero-deck">Install Bluechip on your Mac. It watches eight popular stocks and ETFs, follows one clear buying rule, and stays inside the dollar limits you set. Try every decision in Practice before you let it place a real Robinhood trade.</p>
          <div className="hero-actions">
            <a className="button button-primary" href="/get-started/">Build my starting setup <span>About 2 minutes</span></a>
            <a className="text-link" href="#example">See exactly how it works <span aria-hidden="true">→</span></a>
          </div>
          <p className="hero-note">Your $98 license buys the software. Your trading money stays in Robinhood.</p>
        </motion.div>

        <motion.figure
          className="hero-product"
          initial={reduceMotion ? false : { opacity: 0, y: 28, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.7, delay: 0.12, ease: "easeOut" }}
        >
          <div className="market-example" aria-label="Example Bluechip Practice decision">
            <div className="market-example-top"><span>Example</span><strong>Practice mode</strong><time>10:15 AM</time></div>
            <div className="market-example-quote"><div><span>QQQ</span><small>Nasdaq 100 ETF</small></div><strong>Down 1.7%</strong></div>
            <div className="market-example-checks">
              <p><span>✓</span> Price move meets Bluechip's rule</p>
              <p><span>✓</span> No open QQQ position or pending order</p>
              <p><span>✓</span> Inside your $2 trade and $10 daily limits</p>
            </div>
            <div className="market-example-result"><span>Bluechip's decision</span><strong>Would buy $2 of QQQ</strong><small>No order is placed in Practice.</small></div>
          </div>
          <figcaption><span>A real rule, shown in plain English.</span> This is an example, not a performance claim.</figcaption>
        </motion.figure>
      </section>

      <section className="product-explainer section-shell" id="product">
        <div className="product-statement">
          <p className="eyebrow">What changes for you</p>
          <h2>Let Bluechip do the watching. You make the money decisions.</h2>
          <p>You don't build an algorithm or run a server. In the Mac app, you connect Robinhood, choose the dollars, and decide whether Bluechip is practicing or placing real trades. Bluechip keeps checking while you're doing something else.</p>
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
            <p className="eyebrow">Meet Bluechip</p>
            <h2>One focused stock strategy. Every decision explained.</h2>
            <p>Bluechip looks for a 1.5% pullback in eight familiar stocks and ETFs. When it finds one, it checks the price, your positions, pending orders, and your limits. If every check passes, it can make a small buy. If one check fails, it waits.</p>
            <p className="example-honesty">Bluechip can lose money. The value is consistent execution and clear limits, not a promise that every trade wins.</p>
            <a className="text-link dark-link" href="/get-started/">See if Bluechip fits me <span aria-hidden="true">→</span></a>
          </div>
          <dl className="example-rules">
            <div><dt>What it watches</dt><dd>AAPL, NVDA, TSLA, SPY, QQQ, AMD, MSFT, and GOOGL</dd></div>
            <div><dt>When it looks</dt><dd>About every 15 minutes while it is running</dd></div>
            <div><dt>What gets its attention</dt><dd>One of those stocks or ETFs falling at least 1.5%</dd></div>
            <div><dt>What it checks next</dt><dd>Current price, existing positions, pending orders, and your dollar limits</dd></div>
            <div><dt>What Practice does</dt><dd>Shows the decision using current market information without sending an order</dd></div>
            <div><dt>What Real does</dt><dd>Can send a market buy to the dedicated Robinhood Agentic account you connected</dd></div>
          </dl>
        </div>
      </section>

      <section className="screening-section" id="match">
        <div className="section-shell screening-layout">
          <div className="screening-title">
            <p className="eyebrow">Know what fits before you buy</p>
            <span className="question-count">8</span>
            <h2>Tell us how you trade. We will build a starting setup.</h2>
            <p>You will see the bot, account, mode, and dollar limits we suggest before checkout. No phone number, Social Security number, broker password, or deposit.</p>
          </div>
          <div className="screening-list">
            <p>Your result includes:</p>
            <ol>{screeningReasons.map((reason, index) => <li key={reason}><span>0{index + 1}</span>{reason}</li>)}</ol>
            <div className="screening-choice"><strong>You can change every part of the suggestion.</strong><p>The questions help us give you a useful starting point. They never approve you, reject you, or remove a released bot.</p></div>
            <a className="button button-primary" href="/get-started/">Build my starting setup</a>
          </div>
        </div>
      </section>

      <section className="customer-journey" id="setup">
        <div className="section-shell journey-layout">
          <SectionHeading eyebrow="From $98 to your first Practice run">You can be set up in a few clear steps.</SectionHeading>
          <ol>
            <li><span>01</span><div><h3>See your setup first</h3><p>Answer eight questions and review the bot, account, mode, and limits we suggest.</p></div></li>
            <li><span>02</span><div><h3>Buy the software</h3><p>Pay $98 once through Stripe. Your access code appears as soon as payment is confirmed.</p></div></li>
            <li><span>03</span><div><h3>Download the Mac app</h3><p>Enter your access code once. Your website account stays available for license and download help.</p></div></li>
            <li><span>04</span><div><h3>Connect Robinhood in the app</h3><p>Robinhood handles the approval. Your connection and trading history stay on your Mac, and your money stays at Robinhood.</p></div></li>
            <li><span>05</span><div><h3>Choose your limits and press Start</h3><p>Start with Practice. If you choose Real, review the dollars per trade and per day; permission ends within 24 hours.</p></div></li>
          </ol>
        </div>
      </section>

      <section className="founder" id="price">
        <div className="section-shell founder-inner">
          <div>
            <p className="eyebrow">One-time price</p>
            <h2>${siteConfig.founderPrice} once.</h2>
            <p className="price-qualifier">One active Mac. No subscription.</p>
          </div>
          <div className="offer-copy">
            <ul>
              <li>Bluechip for Robinhood stocks and ETFs</li>
              <li>Practice with current market information before using real money</li>
              <li>Real trading controls with per-trade and daily dollar limits</li>
              <li>A plain-English history of every check, skip, and order</li>
              <li>The Mac app, guided setup, and version 1 updates</li>
            </ul>
            <a className="button offer-button" href="/get-started/">See my setup before I buy</a>
            <small>Trading money, Robinhood fees, taxes, and other account costs are separate. No trading result is promised.</small>
          </div>
        </div>
      </section>

      <section className="faq section-shell" aria-labelledby="faq-heading">
        <SectionHeading eyebrow="Straight answers"><span id="faq-heading">What you should know before you start.</span></SectionHeading>
        <div className="faq-list">{faqs.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div>
      </section>

      <section className="final-cta">
        <p className="eyebrow">See if Bluechip fits you</p>
        <h2>Get a starting setup before you spend $98.</h2>
        <a className="button button-primary" href="/get-started/">Show me my setup</a>
        <p>About two minutes. No phone number, broker login, or deposit.</p>
      </section>

      <footer className="site-footer">
        <a className="wordmark" href="#top">DAYTRADINGBOT</a>
        <p>Bluechip watches. You set the limits. Trading can lose money.</p>
        <div><a href="/risk-disclosure/">Risk</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href={`mailto:${siteConfig.supportEmail}`}>Support</a></div>
      </footer>
    </main>
  );
}
