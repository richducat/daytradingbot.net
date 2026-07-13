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

The owner build can verify an existing Robinhood Agentic Trading OAuth session through Robinhood's official MCP endpoint. The native client has a fixed origin and a compile-time read-only surface: it can call only `get_accounts` and `get_portfolio`, verifies a dedicated `agentic_allowed` account, and returns only redacted booleans/counts to the webview. It has no review, place, cancel, transfer, scanner, watchlist, or generic MCP tool method.

Debug builds may import the owner's existing `0600` Hermes OAuth session into the OS vault. Only the access token and finite expiry are retained; the refresh token is not imported. Release builds never read Hermes files. The current owner proof is therefore temporary and must fail closed when that access token expires. Commercial customer connection requires a native Robinhood OAuth authorization-code/PKCE flow and refresh-token rotation before Robinhood can move beyond read-only proof.

Authenticate the existing owner session and import the reduced bundle without printing credentials or account data:

```sh
ROBINHOOD_OAUTH_TOKEN_PATH=~/.hermes/mcp-tokens/robinhood.json \
cargo run -p daytradingbot-desktop --example import_robinhood_owner
```

The owner-only live read proof accepts an access token only through the process environment and prints no account identifiers or dollar values:

```sh
ROBINHOOD_ACCESS_TOKEN=... cargo run -p daytradingbot-venues --example robinhood_owner_probe
```
