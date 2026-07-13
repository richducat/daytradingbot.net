const legalPages = {
  "/risk-disclosure/": {
    eyebrow: "Risk disclosure",
    title: "Trading automation can lose money.",
    intro: "DayTradingBot is self-directed software, not investment advice, a broker, an exchange, or a promise of returns.",
    sections: [
      ["Pre-purchase fit review", "The agent match is a software-compatibility and starting-setup result based on customer-provided preferences. It is not personalized investment advice, a suitability determination, or a prediction of performance."],
      ["Capital is at risk", "Orders can fill at worse prices than expected, markets can gap, and the full amount committed to a position may be lost. Hard software limits reduce possible exposure; they do not make a trade safe."],
      ["Automation can fail", "Market data, connectivity, venue APIs, local hardware, or software can fail or become stale. Orders may be delayed, rejected, duplicated by a venue, partially filled, or require reconciliation."],
      ["You remain responsible", "You choose whether to connect each venue and explicitly enable live entries. You are responsible for account permissions, available capital, taxes, and compliance with venue and local eligibility rules."],
      ["No performance guarantee", "Backtests, examples, signals, and prior outcomes do not guarantee future results. Do not trade money you cannot afford to lose."],
    ],
  },
  "/privacy/": {
    eyebrow: "Privacy notice",
    title: "Trading credentials stay local.",
    intro: "The desktop stores account credentials in your operating system's secure credential vault. DayTradingBot's purchase and license service is not designed to receive broker credentials, positions, or order details.",
    sections: [
      ["Fit-review answers", "During pre-launch testing, fit-review answers and progress are stored only in the visitor's browser. They are not submitted to DayTradingBot, a broker, or an analytics service."],
      ["Purchase and license data", "The purchase and license service will process purchase status, customer email, license identifiers, device public keys, activation state, refund requests, and signed release metadata."],
      ["Local trading data", "Venue credentials, local ledgers, strategy positions, and order history remain on the customer's device unless the customer deliberately exports and shares them for support."],
      ["Operational data", "Launch telemetry is limited to privacy-safe application health and license events. It must not include broker account numbers, API secrets, trade payloads, or position details."],
      ["Control and deletion", "Support and deletion requests will be handled through support@daytradingbot.net after the production mailbox and retention schedule pass the launch gate."],
    ],
  },
  "/terms/": {
    eyebrow: "Founder license terms",
    title: "One license. One active device.",
    intro: "The founding offer is a one-time $98 software license for one active Windows or Mac device, limited to ten licenses in total.",
    sections: [
      ["Required fit review", "Checkout may be offered only after the customer completes the pre-purchase fit review and receives a match for a released agent. A match helps configure the software; it is not investment advice or a guarantee of performance."],
      ["License", "The license covers perpetual access to the purchased v1 release and v1 updates. Venue accounts, market data, transaction fees, taxes, and trading capital are separate."],
      ["Live use", "Live entries remain disabled until the customer connects a supported account and explicitly enables live operation. Customers may lower risk limits but cannot raise the built-in maximums."],
      ["Refund", "The founder offer includes a 30-day get-running refund for installation or supported connection problems. Trading losses, fees, and strategy performance are not refundable."],
      ["Acceptable use", "The software may not be resold, shared across multiple active devices, used to evade venue eligibility controls, or modified to bypass license, safety, or risk enforcement."],
    ],
  },
} as const;

type LegalPath = keyof typeof legalPages;

export function isLegalPath(path: string): path is LegalPath {
  return path in legalPages;
}

export function LegalPage({ path }: { path: LegalPath }) {
  const page = legalPages[path];
  return (
    <main className="legal-page">
      <header className="site-header legal-header">
        <a className="wordmark" href="/">DAYTRADINGBOT</a>
        <a href="/">Back to product</a>
      </header>
      <article>
        <p className="eyebrow">{page.eyebrow}</p>
        <h1>{page.title}</h1>
        <p className="legal-intro">{page.intro}</p>
        <div className="draft-notice">Pre-launch draft — checkout remains closed until counsel approves the final text.</div>
        <div className="legal-sections">
          {page.sections.map(([heading, body]) => (
            <section key={heading}>
              <h2>{heading}</h2>
              <p>{body}</p>
            </section>
          ))}
        </div>
        <p className="legal-updated">Draft updated July 13, 2026</p>
      </article>
    </main>
  );
}
