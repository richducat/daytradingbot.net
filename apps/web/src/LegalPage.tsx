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
    title: "Your trading information stays on your Mac.",
    intro: "The DayTradingBot website handles checkout, license delivery, and customer sign-in. Robinhood connects inside the Mac app, where the operating system's secure storage protects the connection.",
    sections: [
      ["Bot-picker answers", "Questionnaire answers and progress are stored only in the visitor's browser. They are not submitted to DayTradingBot, a broker, or an analytics service."],
      ["Payment data", "Stripe processes the payment and receipt. DayTradingBot does not receive or store the customer's full card or bank details."],
      ["Purchase and delivery data", "After payment, the buyer's email, Stripe checkout identifier, and encrypted license-delivery record are stored so the access code and app can be delivered. The purchase flow does not ask for a broker password, account number, or trading credentials."],
      ["Website account data", "The customer website stores a protected sign-in session and whether the software license is active. It does not connect to Robinhood, run a bot, place orders, or store brokerage credentials, positions, balances, or trading history."],
      ["Mac trading data", "Robinhood connection details, bot settings, positions, and order history stay on the customer's Mac unless the customer deliberately exports and shares them for support."],
      ["Operational data", "Website health and license events do not include broker passwords, API secrets, full account numbers, positions, balances, or trading history."],
      ["Control and deletion", "Support and deletion requests can be sent to support@daytradingbot.net."],
    ],
  },
  "/terms/": {
    eyebrow: "Software license terms",
    title: "One personal software license.",
    intro: "The launch offer is a one-time $98 personal license with a customer account page and one active Mac installation.",
    sections: [
      ["Bot picker and risk acknowledgement", "The questionnaire helps configure the software but does not restrict which released bot a customer may choose. A clear risk acknowledgement may be required before checkout and before Real trading. Neither is investment advice or a guarantee of performance."],
      ["License and delivery", "The license covers the DayTradingBot Mac app, the current released bots, guided setup, version 1 updates, and one active Mac installation. After payment, the access code and download link are delivered on screen and by email. Venue accounts, market data, transaction fees, taxes, and trading capital are separate."],
      ["Real trading", "Real trading stays off until the customer connects a supported account inside the Mac app, chooses per-trade and daily dollar limits, and deliberately approves Real. That permission lasts no more than 24 hours before the customer must approve it again."],
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
        <p className="legal-updated">Updated July 22, 2026</p>
      </article>
    </main>
  );
}
