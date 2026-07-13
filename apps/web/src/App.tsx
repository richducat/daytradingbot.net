import { motion, useReducedMotion } from "framer-motion";
import { isLegalPath, LegalPage } from "./LegalPage";
import { siteConfig } from "./siteConfig";

const reveal = { hidden: { opacity: 0, y: 20 }, visible: { opacity: 1, y: 0 } };

function SectionHeading({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return <div className="section-heading"><p className="eyebrow">{eyebrow}</p><h2>{children}</h2></div>;
}

function ProductPreview() {
  return (
    <div className="product-preview" aria-label="DayTradingBot setup preview">
      <div className="preview-top"><span>DayTradingBot</span><small>Ready when you are</small></div>
      <div className="preview-row complete"><span className="preview-number">1</span><div><small>Account</small><strong>Robinhood connected</strong></div><b>✓</b></div>
      <div className="preview-row"><span className="preview-number">2</span><div><small>Trading agent</small><strong>Bluechip</strong></div><button type="button" tabIndex={-1}>Pick for me</button></div>
      <div className="preview-limits"><div><small>Amount at risk today</small><strong>$15</strong></div><div><small>Most in one trade</small><strong>$3</strong></div></div>
      <div className="preview-mode"><span className="selected">Practice</span><span>Real trading</span></div>
      <div className="preview-start">Start Practice</div>
      <p>No real money will be used.</p>
    </div>
  );
}

const setupSteps = [
  ["Connect an account", "Sign in to a supported account or connect a wallet you already own. Your money stays there—DayTradingBot never holds it."],
  ["Choose an agent", "Pick the trading approach you want, or press Pick for me and let the app match an available agent to your connected account."],
  ["Set the dollar limits", "Choose the most the agents may put at risk today and the most they may use in any one trade."],
  ["Press Start", "Begin in Practice to see what the agent would do, or choose Real when you are ready. Press Pause whenever you want."],
] as const;

const faqs = [
  ["Where do I deposit money?", "You do not deposit money with DayTradingBot. If an account needs funds, add them directly through Robinhood, Coinbase, Kalshi, or your wallet provider. The app will tell you when there is not enough available to trade."],
  ["What does Pick for me do?", "It looks at the accounts you connected and chooses the best available agent for that market. You see the choice before anything starts, and you can change it."],
  ["What is Practice?", "Practice uses current market information and records what the agent would do, but it does not send a real trade."],
  ["Can the app move or withdraw my money?", "No. Supported connections must leave transfers and withdrawals turned off. Your money stays in accounts you control."],
  ["Does AI guarantee better results?", "No. The agents follow specific trading approaches, but every approach can lose money. Pick for me makes setup easier; it does not predict which agent will be profitable."],
  ["Can I buy it today?", "Not yet. Checkout will open after the signed Mac and Windows apps, purchase-code service, legal review, and final small-dollar live test are complete."],
] as const;

export function App() {
  const reduceMotion = useReducedMotion();
  const path = window.location.pathname.endsWith("/") ? window.location.pathname : `${window.location.pathname}/`;
  if (isLegalPath(path)) return <LegalPage path={path} />;

  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="DayTradingBot home">DAYTRADINGBOT</a>
        <nav aria-label="Primary navigation"><a href="#how">How it works</a><a href="#agents">Agents</a><a href="#accounts">Accounts</a><a href="#price">Price</a></nav>
      </header>

      <section className="hero" id="top">
        <div className="hero-wash" aria-hidden="true" />
        <motion.div className="hero-copy" initial={reduceMotion ? false : "hidden"} animate="visible" variants={reveal} transition={{ duration: 0.58, ease: "easeOut" }}>
          <p className="eyebrow"><span className="status-dot" /> Founder app in final testing</p>
          <h1>Connect your accounts. Pick an agent. Press Start.</h1>
          <p className="hero-deck">DayTradingBot puts a team of AI trading agents inside one desktop app. You choose where they can trade, how much they can use, and whether they are practicing or using real money.</p>
          <div className="hero-actions"><a className="button button-primary" href="#how">See the four steps</a><a className="text-link" href="#agents">Meet the agents <span aria-hidden="true">↓</span></a></div>
          <p className="hero-note">No coding. No money sent to us. Your accounts and wallets stay in your name.</p>
        </motion.div>
        <motion.div className="hero-visual" initial={reduceMotion ? false : { opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.65, delay: 0.18 }}><ProductPreview /></motion.div>
        <p className="hero-footnote">Trading can lose money. DayTradingBot is software, not investment advice.</p>
      </section>

      <motion.section className="how section-shell" id="how" initial={reduceMotion ? false : "hidden"} whileInView="visible" viewport={{ once: true, amount: 0.15 }} variants={reveal} transition={{ duration: 0.5 }}>
        <SectionHeading eyebrow="How it works">Four normal steps. You stay in control.</SectionHeading>
        <div className="step-list">{setupSteps.map(([title, body], index) => <div className="step-row" key={title}><span className="step-number">0{index + 1}</span><h3>{title}</h3><p>{body}</p></div>)}</div>
      </motion.section>

      <section className="choice-section"><div className="section-shell">
        <SectionHeading eyebrow="Practice or real">Learn the app first. Use real money only when you choose.</SectionHeading>
        <div className="choice-grid">
          <div><span>Practice</span><h3>Watch the agent work without placing trades.</h3><p>The app uses current market information, shows why the agent found or skipped a trade, and keeps a record for you.</p><small>Recommended for every new account and agent</small></div>
          <div><span>Real trading</span><h3>Let the agent place small trades within your limits.</h3><p>Before anything starts, you review the agent, the account, today’s dollar limit, and the maximum for one trade.</p><small>Every real trade can lose money</small></div>
          <div><span>Pause</span><h3>Stop new trades from one button.</h3><p>Pause does not move your money or sell investments behind your back. It simply stops the agents from starting another trade.</p><small>Your brokerage and wallet remain yours</small></div>
        </div>
      </div></section>

      <section className="auto-pick section-shell">
        <div><p className="eyebrow">Pick for me</p><h2>Not sure which agent to use? Let the app narrow it down.</h2></div>
        <div className="auto-pick-copy"><p>Pick for me checks which accounts are connected, looks at the agents available for those markets, and selects the best match. It shows you the choice before you press Start.</p><div className="match-card"><span>Connected account</span><strong>Robinhood</strong><i>→</i><span>Best available match</span><strong>Bluechip</strong></div><small>It makes setup easier. It does not promise that the selected agent will make money.</small></div>
      </section>

      <section className="agents-section" id="agents"><div className="section-shell">
        <SectionHeading eyebrow="The agents are the product">Each agent has one clear job.</SectionHeading>
        <p className="section-intro">Bluechip is the first agent fully packaged in the customer app. The rest have already run in the founder system and will be released as their customer account connections finish testing.</p>
        <div className="agent-grid">{siteConfig.agents.map((agent) => <article className="agent-card" key={`${agent.name}-${agent.market}`}><div><span className="agent-mark">{agent.name.slice(0, 1)}</span><small className={agent.available ? "available" : "next"}>{agent.available ? "Available first" : "Next release"}</small></div><h3>{agent.name}</h3><p>{agent.summary}</p><footer><span>{agent.account}</span><span>{agent.market}</span></footer></article>)}</div>
      </div></section>

      <section className="accounts section-shell" id="accounts">
        <SectionHeading eyebrow="Your accounts">Connect what you already use.</SectionHeading>
        <p className="section-intro">DayTradingBot checks whether the selected account is connected and has enough available for your per-trade limit. If it needs money, you add funds directly with that company—not with us.</p>
        <div className="account-list">{siteConfig.accounts.map((account, index) => <div className="account-row" key={account.name}><span className="account-index">0{index + 1}</span><h3>{account.name}</h3><p>{account.market}</p><small>{account.status}</small></div>)}</div>
      </section>

      <section className="limits-section"><div className="section-shell limits-layout">
        <div><SectionHeading eyebrow="Your limits">Decide the dollars before you start.</SectionHeading><p>You may choose smaller amounts. The app will not let a customer raise these built-in maximums.</p></div>
        <div className="limit-list">{[
          ["Most in one new trade", `$${siteConfig.limits.maxOpeningOrderUsd}`],
          ["Most used for new trades in a day", `$${siteConfig.limits.maxDailyOpeningNotionalUsd}`],
          ["Daily loss point that stops new trades", `$${siteConfig.limits.maxDailyLossUsd}`],
        ].map(([label, value]) => <div className="limit-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      </div></section>

      <section className="founder" id="price"><div className="section-shell founder-inner">
        <div><p className="eyebrow">Founding desktop license</p><h2>${siteConfig.founderPrice} once.<br />Ten early users.</h2></div>
        <div className="offer-copy"><p>One active Mac or Windows computer, version 1, and version 1 updates. Trading money, account fees, and taxes stay separate.</p><button className="button button-disabled" type="button" disabled>Sales open after final live testing</button><small>Checkout is intentionally closed today. We will not take payment before the installers, purchase codes, support address, and final real-trade test are ready.</small></div>
      </div></section>

      <section className="faq section-shell" aria-labelledby="faq-heading"><SectionHeading eyebrow="Straight answers"><span id="faq-heading">What a customer needs to know.</span></SectionHeading><div className="faq-list">{faqs.map(([question, answer]) => <details key={question}><summary>{question}</summary><p>{answer}</p></details>)}</div></section>

      <footer className="site-footer"><a className="wordmark" href="#top">DAYTRADINGBOT</a><p>Self-directed trading automation. Not investment advice.</p><div><a href="/risk-disclosure/">Risk</a><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="mailto:support@daytradingbot.net">Support</a></div></footer>
    </main>
  );
}
