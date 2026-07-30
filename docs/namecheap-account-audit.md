# Namecheap account audit

## Current production state — 2026-07-29

- `daytradingbot.net` is served from GitHub Pages through Namecheap DNS.
- `api.daytradingbot.net` runs the commerce, licensing, browser-session, email, and health API on the already-paid Stellar Business account.
- `releases.daytradingbot.net` provides the branded redirect to the public GitHub Release installer.
- No VPS, PremiumDNS, Windows certificate, or other paid infrastructure is required for the initial release.
- No brokerage credentials, account data, risk settings, trading decisions, or orders are sent to or stored on Namecheap.
- The production API has no trading worker or brokerage routes. The prohibited route checks in `docs/production-launch-status.md` return `404`.
- DayTradingBot uses isolated application, database, secret, and release directories inside the shared account. It does not use the TYFYS document root or data.

The historical July 12 dashboard inventory below records why the architecture was changed from a proposed VPS to the existing shared-host plan. It is not the current deployment status.

## Historical baseline — 2026-07-12

Read-only dashboard inspection established the following baseline without changing the account:

- `daytradingbot.net` is active through July 9, 2027 with domain privacy and auto-renew enabled.
- The only hosting subscription was Stellar Business for `tyfys.net`.
- There is no VPS subscription and the account balance is $0.
- There is no Namecheap Private Email subscription.
- PremiumDNS is not enabled for `daytradingbot.net`; the domain uses Namecheap BasicDNS and DNSSEC is off.
- Account-level two-factor authentication was off at the time of this snapshot.
- Current apex DNS has three GitHub Pages A records (`185.199.108.153`, `.109.153`, `.110.153`). The fourth GitHub Pages record and a `www` record are absent.
- Mail is currently Namecheap Email Forwarding, not a commercial support mailbox.

## Superseded VPS proposal

The following proposal is retained only as history and must not be executed for the initial release:

1. Enable Namecheap account two-factor authentication with the owner present for enrollment and recovery-code custody.
2. Purchase Quasar VPS, PremiumDNS for `daytradingbot.net`, and one Private Email Launch mailbox only after presenting the exact cart total for confirmation. This purchase is not currently needed.
3. Provision Ubuntu 24.04 and the repository's Nginx/systemd/PostgreSQL configuration without cPanel/Webuzo.
4. Add and verify `support@`, `licenses@`, and `security@`, including SPF, DKIM, and DMARC.
5. Stage VPS records under temporary `api` and `releases` hosts, validate TLS and health checks, then schedule the apex/`www` cutover with rollback TTLs.
