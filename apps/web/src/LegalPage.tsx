const legalPages = {
  "/risk-disclosure/": {
    eyebrow: "Risk disclosure",
    title: "Trading automation can lose money.",
    intro: "DayTradingBot is self-directed software, not investment advice, a broker, an exchange, or a promise of returns.",
    sections: [
      ["Bot suggestion", "The questionnaire suggests a bot and starting settings from the preferences you provide. It is optional guidance, not investment advice or a prediction of performance. You may choose any released bot."],
      ["Capital is at risk", "Orders can fill at worse prices than expected, markets can gap, and the full amount committed to a position may be lost. Hard software limits reduce possible exposure; they do not make a trade safe."],
      ["Automation can fail", "Market data, connectivity, venue APIs, local hardware, or software can fail or become stale. Orders may be delayed, rejected, duplicated by a venue, partially filled, or require reconciliation."],
      ["You remain responsible", "You choose whether to connect each venue and explicitly enable live entries. You are responsible for account permissions, available capital, taxes, and compliance with venue and local eligibility rules."],
      ["No performance guarantee", "Backtests, examples, signals, and prior outcomes do not guarantee future results. Do not trade money you cannot afford to lose."],
    ],
  },
  "/privacy/": {
    eyebrow: "Privacy notice",
    title: "Your trading connection stays protected.",
    intro: "The browser app encrypts the Robinhood connection before storing it on the DayTradingBot server. The Mac app stores account credentials in the operating system's secure credential vault. Credentials are never placed in browser storage.",
    sections: [
      ["Bot-picker answers", "Questionnaire answers and progress are stored only in the visitor's browser. They are not submitted to DayTradingBot, a broker, or an analytics service."],
      ["Payment data", "Stripe processes the payment and receipt. DayTradingBot does not receive or store the customer's full card or bank details."],
      ["Purchase and delivery data", "After payment, the buyer's email, Stripe checkout identifier, and encrypted license-delivery record are stored so the access code and app can be delivered. The purchase flow does not ask for a broker password, account number, or trading credentials."],
      ["Browser trading data", "The browser app stores an encrypted Robinhood OAuth connection, the limits you choose, bot status, and a plain-English activity and order record. Broker passwords are entered only on Robinhood's website. Encryption keys are stored separately from the database."],
      ["Mac trading data", "In the Mac app, venue credentials, the local ledger, strategy positions, and order history remain on the customer's device unless the customer deliberately exports and shares them for support."],
      ["Operational data", "Application health and license events must not include broker passwords, API secrets, full account numbers, or unencrypted credential material."],
      ["Control and deletion", "Support and deletion requests can be sent to support@daytradingbot.net."],
    ],
  },
  "/terms/": {
    eyebrow: "Software license terms",
    title: "One personal software license.",
    intro: "The launch offer is a one-time $98 personal license with browser access and one active Mac installation when the signed Mac download is available.",
    sections: [
      ["Bot picker and risk acknowledgement", "The questionnaire helps configure the software but does not restrict which released bot a customer may choose. A clear risk acknowledgement may be required before checkout and before Real trading. Neither is investment advice or a guarantee of performance."],
      ["License and delivery", "The license covers the DayTradingBot browser app, the current released bots, guided setup, v1 updates, and one active Mac installation when available. After payment, the access code and browser-app link are delivered on screen and by email. Venue accounts, market data, transaction fees, taxes, and trading capital are separate."],
      ["Live use", "Live entries remain disabled until the customer connects a supported account and explicitly enables live operation. Customers may lower risk limits but cannot raise the built-in maximums."],
      ["Refund", "The launch offer includes a 30-day get-running refund for installation or supported connection problems. Trading losses, fees, and strategy performance are not refundable."],
      ["Acceptable use", "The access code and software may not be resold or shared with another person, used to evade venue eligibility controls, or modified to bypass license, safety, or risk enforcement."],
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
        <div className="draft-notice">Read these terms and the risk disclosure before purchase. Buying the software does not guarantee trading results.</div>
        <div className="legal-sections">
          {page.sections.map(([heading, body]) => (
            <section key={heading}>
              <h2>{heading}</h2>
              <p>{body}</p>
            </section>
          ))}
        </div>
        <p className="legal-updated">Updated July 14, 2026</p>
      </article>
    </main>
  );
}
