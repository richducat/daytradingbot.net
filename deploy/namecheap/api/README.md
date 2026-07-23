# DayTradingBot API upload

This directory is generated for the isolated Namecheap cPanel Node.js app.

1. Upload these files to `~/daytradingbot-api`.
2. Apply new files in `database/mysql/` in numeric order with
   `npm run migrate:mysql -- 0003_web_worker_status.sql`. The migration tool
   accepts only packaged migration filenames and never prints the database URL.
3. Select Node.js 22 and `dist/index.js` in **Setup Node.js App**.
4. Run `npm install --omit=dev` using the cPanel-provided virtual-environment command.
5. Add the environment variables described in `.env.example`, restart the app, and verify `/healthz` and `/readyz`.
6. Run `~/daytradingbot-api/run-web-worker-with-recovery.sh` every five minutes.
   It first restores the existing cPanel Node app if it stopped, verifies its
   health, and then runs one bounded trading check. The worker secret is read
   from its protected file and is never exposed in cron's command line.

This package deliberately contains no secrets, installers, customer data, or brokerage credentials. Browser-app credentials are encrypted before database storage and the encryption key stays outside the app directory.
