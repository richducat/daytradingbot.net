# DayTradingBot commercial rebuild

This branch contains the commercial desktop application, public website, licensing API, and shared trading contracts. The generated GitHub Pages site remains at the repository root until the replacement passes its launch gates.

## Product boundary

- Live trading begins only after a customer explicitly completes **Connect & Enable Live** for a venue.
- Every opening order flows through one local risk engine.
- Venue credentials and customer trading data stay on the customer's device.
- The cloud API handles checkout, license leases, releases, and privacy-safe operational events only.
- Legacy OpenClaw/Simmer scripts are migration references and are not part of the commercial runtime.

## Local prerequisites

- Node.js 22
- pnpm 10.28+
- Rust 1.97 through rustup
- Tauri 2 desktop prerequisites for the host platform

## Commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

The production topology is documented in `docs/hosting-namecheap.md` and is intentionally not deployed until the Namecheap account inventory and launch gates are complete.

## Direct Kalshi founder canary

Simmer/DFlow is read-only. The only live canary path uses direct Kalshi V2 credentials, exactly one FOK contract, a general-fee preflight, a maximum $1 all-in loss, a durable client-order ID, and no automatic retry.

After a production Kalshi API key is created, authenticate and import it into the OS vault without printing either credential:

```sh
KALSHI_API_KEY_ID=... \
KALSHI_PRIVATE_KEY_PATH=/absolute/path/to/kalshi.key \
cargo run -p daytradingbot-desktop --example import_direct_kalshi
```

The trade runner is deliberately two phase. `preview` is read-only and returns an intent ID plus a confirmation token bound to the exact market rules and order. `execute` requires both values and re-runs preflight before its single submission:

```sh
cargo run -p daytradingbot-desktop --example direct_kalshi_canary -- preview TICKER yes 50
cargo run -p daytradingbot-desktop --example direct_kalshi_canary -- execute TICKER yes 50 INTENT_ID CONFIRMATION_TOKEN
```

Do not run `execute` from automation. The global autonomous-trading kill switch remains separate and off.

## Robinhood Agentic founder proof

The commercial desktop now owns the complete Robinhood OAuth authorization-code/PKCE connection and refresh-token rotation. The native client uses Robinhood's fixed official Agentic endpoint and exactly one dedicated `agentic_allowed` account. Its typed surface is limited to account/buying-power reads, quotes, positions, recent Agentic orders, order lookup, market-buy review, and placement of the immutable reviewed order. It has no generic tool method and no transfer or withdrawal operation.

Bluechip Practice uses real account and market reads plus Robinhood's order review, but it has no placement call. Bluechip Real adds the signed-license check, customer dollar limits, current-position and open-order checks, fresh-price and market-hours checks, a durable local reservation, one deterministic order ID, and no retry when Robinhood's response is unclear.

Debug builds may still import the owner's existing `0600` Hermes OAuth session into the OS vault for a one-time founder migration. Only the access token and finite expiry are retained; the refresh token is not imported. Release builds never read Hermes files.

Authenticate the existing owner session and import the reduced bundle without printing credentials or account data:

```sh
ROBINHOOD_OAUTH_TOKEN_PATH=~/.hermes/mcp-tokens/robinhood.json \
cargo run -p daytradingbot-desktop --example import_robinhood_owner
```

The owner-only Practice proof reads the already-authorized local session, reviews matching sample trades, prints no account identifiers or dollar values, and contains no placement call:

```sh
cargo run -p daytradingbot-desktop --example native_robinhood_practice
```

## Coinbase and Polymarket US owner proofs

Coinbase Advanced Trade and Polymarket US have fixed-origin, read-only native clients. The owner connection probe reads only the closed Keychain entries used by the desktop app, prints redacted status flags, and has no order, transfer, withdrawal, cancel, or generic-request method:

```sh
cargo run -p daytradingbot-desktop --features owner-tools --bin owner_connection_probe -- --coinbase
cargo run -p daytradingbot-desktop --features owner-tools --bin owner_connection_probe -- --polymarket-us
```

For local owner setup, the vault importer accepts a credential only through standard input, validates its venue-specific shape, and can write only the four Coinbase/Polymarket Keychain accounts compiled into the tool. Never put a credential directly in the command line:

```sh
pbpaste | cargo run -p daytradingbot-desktop --features owner-tools --bin owner_vault_import -- 'coinbase:key-name'
pbpaste | cargo run -p daytradingbot-desktop --features owner-tools --bin owner_vault_import -- 'coinbase:ecdsa-private-key-pem'
pbpaste | cargo run -p daytradingbot-desktop --features owner-tools --bin owner_vault_import -- 'polymarket-us:key-id'
pbpaste | cargo run -p daytradingbot-desktop --features owner-tools --bin owner_vault_import -- 'polymarket-us:ed25519-secret-key'
```

These probes prove authentication and least-privilege scope only. Live entries remain locked.
