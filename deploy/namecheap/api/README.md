# DayTradingBot API upload

This package is for the isolated Namecheap cPanel Node.js app.

1. Upload these files to `~/daytradingbot-api`.
2. For a new database, apply `0001_commercial_schema.sql`, then `0002_web_sessions_only.sql`, with `npm run migrate:mysql -- FILE.sql`. When upgrading an older browser-trading install, back it up, verify that no customer trading data remains, then apply `0003_remove_shared_host_trading.sql`.
3. Select Node.js 22 and `dist/index.js` in **Setup Node.js App**.
4. Run `npm install --omit=dev` using the cPanel-provided virtual-environment command.
5. Add the environment variables described in `.env.example`, restart the app, and verify `/healthz` and `/readyz`.
6. Replace any old trading-worker cron entry with `~/daytradingbot-api/recover-api-health.sh` every five minutes.

The recovery script only restarts an unavailable API process and checks database readiness. It never runs an agent or contacts a brokerage.

This shared-host package is limited to checkout, licensing, browser access sessions, and health endpoints. Its packaged schema contains only commercial and browser-session tables. It contains and accepts no brokerage credentials, account data, trading settings, strategy decisions, orders, fills, or trading activity. Trading execution stays on the customer's device.
