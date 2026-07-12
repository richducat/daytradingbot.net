# Namecheap account audit — 2026-07-12

Read-only dashboard inspection established the following launch baseline without changing the account:

- `daytradingbot.net` is active through July 9, 2027 with domain privacy and auto-renew enabled.
- The only hosting subscription is Stellar Business for `tyfys.net`; it must not host the DayTradingBot control plane.
- There is no VPS subscription and the account balance is $0.
- There is no Namecheap Private Email subscription.
- PremiumDNS is not enabled for `daytradingbot.net`; the domain uses Namecheap BasicDNS and DNSSEC is off.
- Account-level two-factor authentication is off and must be enabled before VPS or production secrets are provisioned.
- Current apex DNS has three GitHub Pages A records (`185.199.108.153`, `.109.153`, `.110.153`). The fourth GitHub Pages record and a `www` record are absent.
- Mail is currently Namecheap Email Forwarding, not a commercial support mailbox.

## Provisioning gate

When the API, database migrations, signed release flow, and rollback package pass staging:

1. Enable Namecheap account two-factor authentication with the owner present for enrollment and recovery-code custody.
2. Purchase Quasar VPS, PremiumDNS for `daytradingbot.net`, and one Private Email Launch mailbox only after presenting the exact cart total for confirmation.
3. Provision Ubuntu 24.04 and the repository's Nginx/systemd/PostgreSQL configuration without cPanel/Webuzo.
4. Add and verify `support@`, `licenses@`, and `security@`, including SPF, DKIM, and DMARC.
5. Stage VPS records under temporary `api` and `releases` hosts, validate TLS and health checks, then schedule the apex/`www` cutover with rollback TTLs.
