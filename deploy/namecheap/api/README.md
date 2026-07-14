# DayTradingBot API upload

This directory is generated for the isolated Namecheap cPanel Node.js app.

1. Upload these files to `~/daytradingbot-api`.
2. Import the files in `database/mysql/` in numeric order into the dedicated DayTradingBot database.
3. Select Node.js 22 and `dist/index.js` in **Setup Node.js App**.
4. Run `npm install --omit=dev` using the cPanel-provided virtual-environment command.
5. Add the environment variables described in `.env.example`, restart the app, and verify `/healthz` and `/readyz`.
6. Run the bounded browser-app worker every five minutes with:
   `PUBLIC_API_URL=https://api.daytradingbot.net WORKER_SECRET_FILE=/home/CPANEL_USER/.daytradingbot-secrets/web-worker-secret node dist/run-worker.js`.
   The secret is read from its protected file and is never exposed in cron's
   command line.

This package deliberately contains no secrets, installers, customer data, or brokerage credentials. Browser-app credentials are encrypted before database storage and the encryption key stays outside the app directory.
