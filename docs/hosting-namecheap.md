# Namecheap production hosting without a trading server

DayTradingBot uses the already-paid Namecheap **Stellar Business** account for lightweight commercial services. This adds no server purchase and does not use Vercel.

Namecheap handles the public site, Stripe checkout and webhook fulfillment, license activation and renewal, access-code browser sessions, email delivery, and health checks. Brokerage connections and every trading operation stay on the customer's device. The shared host must never accept, proxy, store, return, or execute brokerage credentials, account balances, positions, risk settings, strategy decisions, orders, fills, or trading activity.

## Isolated layout

- `daytradingbot.net`: public website and licensed browser entry point.
- `api.daytradingbot.net`: dedicated Node.js 22 application root, `~/daytradingbot-api`, limited to commerce, licensing, sessions, and health.
- `releases.daytradingbot.net`: branded download redirects. Large installers live in GitHub Releases.
- Dedicated MariaDB database and database user whose names start with the cPanel account prefix.
- Dedicated `licenses@daytradingbot.net`, `support@daytradingbot.net`, and `security@daytradingbot.net` mailboxes.
- Dedicated secret directory at `~/.daytradingbot-secrets`, mode `0700`, outside every public document root.

Do not place files in the TYFYS document root, reuse its database, change its runtime, or share its environment variables. Sharing a hosting subscription must not mean sharing application data.

## Build the API upload

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build:namecheap-api
```

The uploadable directory is `artifacts/namecheap-api`. It contains the compiled API, production package manifest, MariaDB migrations, and health-recovery script. It contains no credentials or customer data.

## One-time cPanel setup

1. Add `api.daytradingbot.net` and `releases.daytradingbot.net` as isolated domains or subdomains in cPanel.
2. Create a dedicated MariaDB database and user. Grant that user privileges only on the DayTradingBot database.
3. Import `database/mysql/0001_commercial_schema.sql`, then `database/mysql/0002_web_sessions_only.sql`. When upgrading a former browser-trading install, take a database backup, confirm the retired trading tables contain no customer records, and apply `database/mysql/0003_remove_shared_host_trading.sql`. The production package intentionally excludes brokerage and trading schemas.
4. Upload the API package to `~/daytradingbot-api`; never put the API root under `public_html`.
5. In **Setup Node.js App**, select Node.js 22, Production, application root `daytradingbot-api`, application URL `api.daytradingbot.net`, and startup file `dist/index.js`.
6. Run the virtual-environment command cPanel displays, then run `npm install --omit=dev` inside the application root.
7. Add the non-secret environment values from `.env.example`. Store secret values in individual files under `~/.daytradingbot-secrets` and set the corresponding `_FILE` variables.
8. Restart the Node.js application and verify `/healthz` and `/readyz` before connecting Stripe.
9. Remove any cron entry that invokes a trading worker. Run `~/daytradingbot-api/recover-api-health.sh` every five minutes only if process recovery is needed.
10. Publish signed installers as public GitHub Release assets only after their signatures and checksums pass release verification.

## DNS and HTTPS

Keep the public site records in place. Add only the `api` and `releases` records pointing to the shared-hosting server IP shown in cPanel. Wait for both names to resolve and for cPanel AutoSSL to issue valid certificates before adding the Stripe webhook.

If cPanel email is used, create the mailboxes first and copy the exact MX, SPF, DKIM, and mail-host records cPanel provides. Do not replace existing email routing speculatively.

## Required production values

- `DATABASE_PROVIDER=mysql`
- `DATABASE_URL_FILE`: dedicated MariaDB URL
- `STRIPE_SECRET_KEY_FILE`, `STRIPE_WEBHOOK_SECRET_FILE`, and the live `STRIPE_PRICE_ID`
- `CHECKOUT_ENABLED=false` until the commercial release gates pass
- `COMMERCE_ENCRYPTION_KEY_FILE`: a random 32-byte base64url value
- `WEBAPP_ENABLED=true`
- `WEB_SESSION_SECRET_FILE`: at least 32 random characters
- `LICENSE_SIGNING_PRIVATE_KEY_PEM_FILE`: the private half matching the public key embedded in the desktop app
- `LICENSE_SECRET_PEPPER_FILE`: at least 32 random characters
- `SMTP_URL_FILE`: an authenticated SMTP URL with a URL-encoded password
- The stable Mac installer URL

Do not configure a brokerage-token key, real-trading switch, or trading-worker secret on Namecheap. The private signing key, encryption key, database password, Stripe secrets, and SMTP password must never be committed, uploaded to a public document root, or pasted into logs.

## Launch proof

Commercial checkout stays unavailable until all of these pass:

1. `https://api.daytradingbot.net/readyz` returns `{"status":"ready"}` over valid HTTPS.
2. A Stripe test checkout creates exactly one purchase and one activation code when its webhook is retried.
3. The buyer receives the same code by email and sees the same code on the welcome page.
4. The browser app can sign in, read active entitlement, and sign out without sending any brokerage or trading data to Namecheap.
5. A clean Mac installation can activate and complete mocked or Practice-mode execution checks locally.
6. A refund or dispute disables the matching activation and browser session.
7. Production route inspection confirms that brokerage connection, trading settings, trading start, and worker endpoints all return `404`.

Switch Stripe from test mode to live mode only after these checks pass. No launch test may place a trade or incur a hosting purchase without the user's exact approval.

If traffic later exceeds measured shared-account limits, review the fallback in `docs/hosting-namecheap-vps-fallback.md`; do not pre-purchase it.
