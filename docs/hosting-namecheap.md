# Namecheap production hosting without a new server

DayTradingBot's initial commercial release uses the already-paid Namecheap **Stellar Business** account. This adds no server purchase and does not use Vercel.

Customers can use the browser app or the Mac app. The browser app runs its bounded Bluechip checks on Namecheap; Robinhood credentials are encrypted before database storage and real orders are sent only through Robinhood's official Agentic Trading connection. The Mac app keeps its connected-account execution on the customer's computer. This fits the included Node.js, MariaDB, email, SSL, and backup features without buying another server.

## Isolated layout

- `daytradingbot.net`: existing public website.
- `api.daytradingbot.net`: dedicated Node.js 22 application root, `~/daytradingbot-api`.
- `releases.daytradingbot.net`: a small branded download/redirect site, separate from the API and every other hosted site. Large installer files live in GitHub Releases so they do not consume the shared account's disk-I/O allowance.
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

The uploadable directory is `artifacts/namecheap-api`. It contains the compiled API, the production package manifest, and the MariaDB schema. It contains no credentials.

## One-time cPanel setup

1. Add `api.daytradingbot.net` and `releases.daytradingbot.net` as isolated domains/subdomains in cPanel.
2. Create a dedicated MariaDB database and user. Grant that user all privileges on only the DayTradingBot database.
3. Import `database/mysql/0001_commercial_schema.sql` through phpMyAdmin.
4. Upload the API package to `~/daytradingbot-api`; never put the API root under `public_html`.
5. In **Setup Node.js App**, select Node.js 22, Production, application root `daytradingbot-api`, application URL `api.daytradingbot.net`, and startup file `dist/index.js`.
6. Run the virtual-environment command cPanel displays, then run `npm install --omit=dev` inside the application root.
7. Add the non-secret environment values from `.env.example`. Store secret values in individual files under `~/.daytradingbot-secrets` and set the corresponding `_FILE` variables.
8. Restart the Node.js application and verify `/healthz` and `/readyz` before connecting Stripe.
9. Publish signed installers as public GitHub Release assets only after their signatures and checksums pass release verification. Deploy `deploy/namecheap/releases` to the release document root; its stable branded URLs redirect to the latest verified assets.

## DNS and HTTPS

Keep the public site records in place. Add only the `api` and `releases` records pointing to the shared-hosting server IP shown in cPanel. Wait for both names to resolve and for cPanel AutoSSL to issue valid certificates before adding the Stripe webhook.

If the included cPanel email is used, create the mailboxes first and copy the exact MX, SPF, DKIM, and mail-host records cPanel provides. Do not replace existing email routing speculatively.

## Required production values

- `DATABASE_PROVIDER=mysql`
- `DATABASE_URL_FILE`: `mysql://USER:URL_ENCODED_PASSWORD@localhost/DATABASE`
- `STRIPE_SECRET_KEY_FILE`, `STRIPE_WEBHOOK_SECRET_FILE`, and the live `STRIPE_PRICE_ID`
- `CHECKOUT_ENABLED=false` until the signed and notarized Mac installer is published; set it to `true` only after the stable URL passes on a clean Mac
- `COMMERCE_ENCRYPTION_KEY_FILE`: a random 32-byte base64url value
- `LICENSE_SIGNING_PRIVATE_KEY_PEM_FILE`: the private half matching the public key embedded in the desktop app
- `LICENSE_SECRET_PEPPER_FILE`: at least 32 random characters
- `SMTP_URL_FILE`: an authenticated SMTP URL with a URL-encoded password
- The stable Mac installer URL

The private signing key, encryption key, database password, Stripe secrets, and SMTP password must never be committed, uploaded to a public document root, or pasted into logs.

## Launch proof

Commercial checkout stays unavailable until all of these pass:

1. `https://api.daytradingbot.net/readyz` returns `{"status":"ready"}` over valid HTTPS.
2. A Stripe test checkout creates exactly one purchase and one activation code when the webhook is retried.
3. The buyer receives the same code by email and sees the same code on the welcome page.
4. A clean Mac installation can activate, start Practice, connect a supported account, and stop safely.
5. A refund or dispute disables the matching activation.
6. The public checkout is then switched from Stripe test mode to live mode without placing any trade or incurring any hosting purchase.

If traffic later exceeds the shared account's measured limits, use the reviewed VPS fallback in `docs/hosting-namecheap-vps-fallback.md`; do not pre-purchase it.
