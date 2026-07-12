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
