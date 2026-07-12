# Namecheap production topology

DayTradingBot will not use Vercel or shared cPanel hosting. The founder release uses one Namecheap **Quasar VPS** running Ubuntu 24.04 in user-responsible mode, without cPanel/Webuzo.

## Services

- Nginx terminates TLS and serves `daytradingbot.net`, `www.daytradingbot.net`, `api.daytradingbot.net`, and `releases.daytradingbot.net`.
- Node.js 22 runs the Fastify control-plane API under systemd on `127.0.0.1:3000`.
- PostgreSQL 16 listens only on localhost/its Unix socket.
- Namecheap PremiumDNS supplies authoritative DNS, DNSSEC, and the documented DNS service SLA.
- Namecheap Private Email Launch supplies `support@daytradingbot.net`; `licenses@` and `security@` are aliases.
- Certbot manages the four TLS names. HSTS is introduced only after staged certificate and subdomain verification.

## Data boundary

The VPS stores purchases, seat reservations, hashed license secrets, activation public keys, signed lease metadata, release manifests, refund requests, and privacy-safe operational events. It never receives venue credentials, broker account numbers, customer positions, or customer order payloads.

## Reliability boundary

This is intentionally a single-node topology for ten founding customers. Desktop clients fail closed for new entries when license or policy renewal is unavailable while keeping local cancellation, close, reconciliation, and data export available. Nightly encrypted database/configuration backups must leave the VPS, retain 30 daily and 12 monthly copies, and pass a monthly restore drill.

## Account-dependent gate

The July 12, 2026 account inspection confirmed that Quasar VPS, PremiumDNS, and Private Email do not yet exist for DayTradingBot. Purchasing them requires checkout confirmation. Shared hosting is not an acceptable fallback for the licensing and Stripe webhook control plane.

