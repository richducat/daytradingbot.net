# DayTradingBot production launch status

Verified on July 29, 2026. This document separates what is already live from what still blocks a public Mac release.

## Live and verified

- Public pages at `daytradingbot.net`, `/get-started/`, `/app/`, `/privacy/`, and `/terms/` return `200`.
- Namecheap API health and readiness return `200`.
- Checkout can create an unpaid Stripe Checkout session for the active one-time $98 Mac product.
- The Stripe webhook is active for successful and failed checkout completion, refunds, and disputes.
- Commerce database behavior was verified with temporary test records for purchase, activation, renewal, browser access, delivery state, and refund revocation. The test records were removed.
- SMTP authentication was verified without sending an email.
- Browser access fails closed: an unauthenticated session reports `authenticated: false`, the dashboard returns `401`, and an invalid purchase code returns `401`.
- Shared-host route inspection returns `404` for trading start, trading settings, Robinhood accounts, orders, and worker endpoints.
- The desktop test suite proves Practice cannot place an order and Real Trading requires the current license, a connected dedicated Robinhood Agentic account, customer-selected positive limits, exact review confirmation, and a locally recorded order reservation.

## Current public-release blockers

1. The Mac retail app needs a Developer ID Application certificate for Apple team `WN3K69XEP4`.
2. The signed installer must pass Apple notarization and stapling.
3. The notarized universal DMG must be published as `DayTradingBot-macos-universal.dmg` in a public GitHub Release.
4. The stable Namecheap download redirect must be verified through to a `200` installer response.
5. A final clean-Mac activation and Practice run must pass against the public artifact.

Until these five items pass, the public site and commerce services are live but the retail Mac download is not commercially releasable.

## Explicit boundaries

- No live trade is required for release verification.
- No automated test may place a live trade.
- No charge, purchase, paid service, certificate purchase, or infrastructure upgrade is required by this checklist.
- Creating Apple signing and notarization credentials is a persistent security change and requires the owner’s confirmation at the time it is performed.
- Real Trading, when later chosen by the customer, runs from the customer’s Mac and uses only the limits and dedicated Robinhood Agentic account that customer selects.
