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
  ["Connect an account you already use", "Connect a supported broker, exchange, or market account. Your trading money stays in that account—not with us."],
  ["Pick a bot", "Each bot watches one kind of market and follows one clear strategy. You can use our suggestion or choose a different released bot."],
  ["Set your limits", "Choose Practice or Real, then decide how much the bot may put into one trade and into new trades for the day."],
  ["Press Start", "See what the bot checks, what it does, and what it skips. Press Pause whenever you want to stop new trades."],
] as const;

const screeningReasons = [
  "what you want help with",
  "which market interests you",
  "what kind of strategy sounds right",
  "which account you already use",
  "how familiar you are with trading",
  "how much you want the bot to use",
] as const;

const faqs = [
  ["What exactly is DayTradingBot?", "It is a trading app you can use in your browser or on a Mac. Connect an account you own, pick a bot, choose Practice or Real, set dollar limits, and press Start. The app shows you what the bot does."],
  ["Why ask me questions?", "The answers help us suggest a bot and sensible starting settings. They do not approve you, reject you, or take away access to released bots."],
  ["Can I ignore the suggestion?", "Yes. The result is a starting suggestion, not a rule and not investment advice. You can choose any bot that has been released."],
  ["Where do I deposit trading money?", "Not with DayTradingBot. You add funds directly through the broker, exchange, or market account you own. The software is not a bank, broker, exchange, or custodian."],
  ["Can it place real trades?", "Bluechip includes a Real option for a supported Robinhood Agentic account. It starts in Practice. You must connect the account, set your limits, and deliberately choose Real before the app can send an order."],
  ["What if the suggested bot is not released?", "You can wait for it or choose a bot that is available. The suggestion never locks you in."],
  ["Why do I have to read the fine print?", "Because Real trading can lose money and automated software can fail. We require a clear risk acknowledgement, but your questionnaire answers do not decide which tools you may use."],
  ["What does the $98 license include?", "The browser app, the released Bluechip bot, guided setup, an optional Mac app when the signed download is available, and version 1 updates. Trading capital, venue fees, taxes, and account charges are separate."],
  ["What happens after I pay?", "Stripe sends you straight to a private delivery page. Your access code and a button to open the browser app appear as soon as payment is confirmed, and we send the same details by email."],
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
        <nav aria-label="Primary navigation"><a href="#product">How it works</a><a href="#example">Bluechip</a><a href="#bots">Bots</a><a href="#price">Price</a><a href="/app/">Sign in</a></nav>
        <a className="header-cta" href="/get-started/">Get started</a>
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
          <p className="eyebrow"><span className="status-dot" /> AI trading bots you control</p>
          <h1>Pick a bot. Set your limits. Press Start.</h1>
          <p className="hero-deck">DayTradingBot connects to accounts you already use. Open it in your browser or install it on a Mac, choose Practice or Real, tell your bot how much it can use, and press Start.</p>
          <div className="hero-actions">
            <a className="button button-primary" href="/get-started/">Get started <span>About 2 minutes</span></a>
            <a className="text-link" href="/app/">Already have a code? Open the app <span aria-hidden="true">→</span></a>
          </div>
          <p className="hero-note">The questions make a suggestion. They do not decide what you can use. Read the risk disclosure, then choose for yourself.</p>
        </motion.div>

        <motion.figure
          className="hero-product"
          initial={reduceMotion ? false : { opacity: 0, y: 28, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.7, delay: 0.12, ease: "easeOut" }}
        >
          <img src="/images/daytradingbot-desktop-setup.png" alt="DayTradingBot showing the guided account connection step" />
          <figcaption><span>The same guided setup</span> Use it in a browser or in the optional Mac app.</figcaption>
        </motion.figure>
      </section>

      <section className="product-explainer section-shell" id="product">
        <div className="product-statement">
          <p className="eyebrow">What am I buying?</p>
          <h2>You are buying the software—not sending us trading money.</h2>
          <p>Use it in your browser or on a Mac, connect an account you own, and choose which bot runs. Your money stays with your broker, exchange, or market account.</p>
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
            <h2>Here is what the first customer bot does.</h2>
            <p>Bluechip watches a short list of widely held stocks and funds. It looks for a specific kind of price drop, checks the limits you set, and either acts or does nothing.</p>
            <a className="text-link dark-link" href="/get-started/">Get a bot suggestion <span aria-hidden="true">→</span></a>
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
            <p className="eyebrow">Want help choosing?</p>
            <span className="question-count">8</span>
            <h2>A few questions. One suggestion. Your call.</h2>
            <p>We do not ask for a phone number, Social Security number, account password, or deposit.</p>
          </div>
          <div className="screening-list">
            <p>We ask about:</p>
            <ol>{screeningReasons.map((reason, index) => <li key={reason}><span>0{index + 1}</span>{reason}</li>)}</ol>
            <div className="screening-choice"><strong>Nothing you answer locks you out.</strong><p>We suggest a bot and starting settings. You can change the answers or choose any released bot after reading the risk disclosure.</p></div>
            <a className="button button-primary" href="/get-started/">Help me choose a bot</a>
          </div>
        </div>
      </section>

      <section className="routing-section" id="bots">
        <div className="section-shell">
          <SectionHeading eyebrow="Choose for yourself">Here is what each bot is built for.</SectionHeading>
          <div className="routing-table">
            <div className="routing-head"><span>If you want to trade</span><span>Likely suggestion</span><span>Release status</span></div>
            <div><span>Large stocks and ETFs</span><strong>Bluechip</strong><small className="available">Available first</small></div>
            <div><span>Short-term crypto moves</span><strong>Sprinter</strong><small>Still being packaged</small></div>
            <div><span>Weather and public data</span><strong>Stormfront or Barometer</strong><small>Still being packaged</small></div>
            <div><span>News and prediction markets</span><strong>News Watch or Oracle Gap</strong><small>Still being packaged</small></div>
          </div>
          <p className="routing-note">The quiz makes an optional suggestion and explains the account and starting limits. You can choose any released bot. Bots still being packaged are labeled clearly.</p>
        </div>
      </section>

      <section className="customer-journey">
        <div className="section-shell journey-layout">
          <SectionHeading eyebrow="From questions to setup">Here is the whole process.</SectionHeading>
          <ol>
            <li><span>01</span><div><h3>Choose a bot</h3><p>Use our suggestion or pick any released bot yourself.</p></div></li>
            <li><span>02</span><div><h3>Read the risk disclosure</h3><p>Know what can go wrong before you enter a card number or turn on Real trading.</p></div></li>
            <li><span>03</span><div><h3>Buy and open the app</h3><p>Pay $98 through Stripe. Your access code and browser-app button appear immediately. Nothing has to be downloaded.</p></div></li>
            <li><span>04</span><div><h3>Connect your account</h3><p>Robinhood handles sign-in. The browser app stores the connection encrypted on our server; the Mac app uses the computer's secure storage.</p></div></li>
            <li><span>05</span><div><h3>Set limits and press Start</h3><p>Choose Practice or Real. Set the dollars per trade and per day. Press Pause to stop new trades.</p></div></li>
          </ol>
        </div>
      </section>

      <section className="founder" id="price">
        <div className="section-shell founder-inner">
          <div>
            <p className="eyebrow">Founding price</p>
            <h2>${siteConfig.founderPrice} once.</h2>
            <p className="price-qualifier">Browser access, optional Mac app, and version 1 updates.</p>
          </div>
          <div className="offer-copy">
            <ul>
              <li>Browser app and guided account setup—no download required</li>
              <li>Optional Mac app when the signed public download is available</li>
              <li>Practice mode and Real trading for released bots</li>
              <li>A clear activity history and dollar limits you control</li>
              <li>Trading capital, account fees, and taxes not included</li>
            </ul>
            <a className="button offer-button" href="/get-started/">Help me choose a bot</a>
            <small>Checkout opens after the risk acknowledgement. Stripe sends your receipt, then your access code and browser-app button appear on the private delivery page.</small>
          </div>
        </div>
      </section>

      <section className="faq section-shell" aria-labelledby="faq-heading">
        <SectionHeading eyebrow="Straight answers"><span id="faq-heading">What you should know before you start.</span></SectionHeading>
        <div className="faq-list">{faqs.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div>
      </section>

      <section className="final-cta">
        <p className="eyebrow">Want a suggestion?</p>
        <h2>Tell us what you want. Then make your own choice.</h2>
        <a className="button button-primary" href="/get-started/">Help me choose a bot</a>
        <p>About two minutes. Your answers stay in this browser and are not sent to us.</p>
      </section>

      <footer className="site-footer">
        <a className="wordmark" href="#top">DAYTRADINGBOT</a>
        <p>Self-directed trading automation. Not investment advice.</p>
        <div><a href="/risk-disclosure/">Risk</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href={`mailto:${siteConfig.supportEmail}`}>Support</a></div>
      </footer>
    </main>
  );
}
