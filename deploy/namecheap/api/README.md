# DayTradingBot API upload

This directory is generated for the isolated Namecheap cPanel Node.js app.

1. Upload these files to `~/daytradingbot-api`.
2. Import `database/mysql/0001_commercial_schema.sql` into the dedicated DayTradingBot database.
3. Select Node.js 22 and `dist/index.js` in **Setup Node.js App**.
4. Run `npm install --omit=dev` using the cPanel-provided virtual-environment command.
5. Add the environment variables described in `.env.example`, restart the app, and verify `/healthz` and `/readyz`.

This package deliberately contains no secrets, installers, customer data, or brokerage credentials.
