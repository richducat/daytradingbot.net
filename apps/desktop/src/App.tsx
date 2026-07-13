import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type RiskPolicy = {
  max_opening_order_usd: string;
  max_daily_opening_notional_usd: string;
  max_venue_exposure_usd: string;
  max_global_exposure_usd: string;
  max_daily_loss_usd: string;
  max_resting_entry_orders: number;
};

type EntryLicenseStatus = {
  entries_allowed: boolean;
  mode: "entry_enabled" | "close_only";
};

type KalshiOwnerDemoStatus = {
  owner_import_available: boolean;
  configured: boolean;
  connection_state: "not_configured" | "read_only_ready" | "claim_required" | "trading_not_enabled";
  provider: "simmer_dflow";
  authenticated: boolean;
  signing_key_available: boolean;
  direct_api_configured: boolean;
  wallet_configured: boolean;
  active_position_count: number;
  has_spendable_balance: boolean;
  has_open_exposure: boolean;
  warning_count: number;
  observed_at: string | null;
  live_entries_available: false;
};

const fallbackPolicy: RiskPolicy = {
  max_opening_order_usd: "5.00",
  max_daily_opening_notional_usd: "25.00",
  max_venue_exposure_usd: "100.00",
  max_global_exposure_usd: "200.00",
  max_daily_loss_usd: "10.00",
  max_resting_entry_orders: 2,
};

const venues = [
  ["Robinhood", "Equities"],
  ["Coinbase", "BTC + ETH spot"],
  ["Kalshi", "Event contracts"],
  ["Polymarket", "Eligible regions"],
] as const;

const disconnectedKalshi: KalshiOwnerDemoStatus = {
  owner_import_available: false,
  configured: false,
  connection_state: "not_configured",
  provider: "simmer_dflow",
  authenticated: false,
  signing_key_available: false,
  direct_api_configured: false,
  wallet_configured: false,
  active_position_count: 0,
  has_spendable_balance: false,
  has_open_exposure: false,
  warning_count: 0,
  observed_at: null,
  live_entries_available: false,
};

function money(value: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));
}

export function App() {
  const [policy, setPolicy] = useState<RiskPolicy>(fallbackPolicy);
  const [coreOnline, setCoreOnline] = useState(false);
  const [licenseStatus, setLicenseStatus] = useState<EntryLicenseStatus>({
    entries_allowed: false,
    mode: "close_only",
  });
  const [kalshiDemo, setKalshiDemo] = useState<KalshiOwnerDemoStatus>(disconnectedKalshi);
  const [kalshiSyncFailed, setKalshiSyncFailed] = useState(false);
  const [kalshiImporting, setKalshiImporting] = useState(false);

  const refreshKalshiDemo = () => {
    return invoke<KalshiOwnerDemoStatus>("kalshi_owner_demo_status")
      .then((result) => {
        setKalshiDemo(result);
        setKalshiSyncFailed(false);
      })
      .catch(() => {
        setKalshiSyncFailed(true);
      });
  };

  useEffect(() => {
    let active = true;
    void Promise.all([
      invoke<RiskPolicy>("launch_policy"),
      invoke<EntryLicenseStatus>("entry_license_status"),
    ])
      .then(([policyResult, licenseResult]) => {
        if (active) {
          setPolicy(policyResult);
          setLicenseStatus(licenseResult);
          setCoreOnline(true);
        }
      })
      .catch(() => {
        if (active) setCoreOnline(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void invoke<KalshiOwnerDemoStatus>("kalshi_owner_demo_status")
      .then((result) => {
        if (active) {
          setKalshiDemo(result);
          setKalshiSyncFailed(false);
        }
      })
      .catch(() => {
        if (active) setKalshiSyncFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const importOwnerDemo = () => {
    setKalshiImporting(true);
    void invoke<boolean>("import_owner_demo_credentials")
      .then(() => refreshKalshiDemo())
      .finally(() => setKalshiImporting(false));
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="desktop-wordmark">DTB</div>
        <nav aria-label="Application">
          <button className="nav-item active" type="button">Overview</button>
          <button className="nav-item" type="button">Venues</button>
          <button className="nav-item" type="button">Strategies</button>
          <button className="nav-item" type="button">Orders</button>
          <button className="nav-item" type="button">Diagnostics</button>
        </nav>
        <div className="sidebar-foot">
          <span className="state-dot" />
          <span>{coreOnline ? "Risk core online" : "Preview mode"}</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <p className="kicker">Local execution workspace</p>
            <h1>Overview</h1>
          </div>
          <div className={`lock-state ${licenseStatus.entries_allowed ? "enabled" : ""}`}>
            <span /> {licenseStatus.entries_allowed ? "LIVE ENTRY ENABLED" : "LIVE LOCKED"}
          </div>
        </header>

        <section className="status-strip" aria-label="Account status">
          <div><span>License</span><strong>{licenseStatus.entries_allowed ? "Entry lease active" : "Not activated"}</strong></div>
          <div><span>Open exposure</span><strong>$0.00</strong></div>
          <div><span>Daily opening</span><strong>$0.00 / {money(policy.max_daily_opening_notional_usd)}</strong></div>
          <div><span>Resting entries</span><strong>0 / {policy.max_resting_entry_orders}</strong></div>
        </section>

        <section className="workspace-section">
          <div className="section-title">
            <div><p className="kicker">Connection state</p><h2>Venues</h2></div>
            <p>Credentials remain in your operating-system vault.</p>
          </div>
          <div className="venue-table">
            {venues.map(([name, scope]) => {
              const isKalshi = name === "Kalshi";
              const verified = isKalshi && kalshiDemo.connection_state === "read_only_ready";
              const stateLabel = isKalshi
                ? kalshiSyncFailed
                  ? "Sync unavailable"
                  : verified
                    ? "Read-only verified"
                    : "Not connected"
                : "Coming later";
              return <div className={`venue-item ${verified ? "verified" : ""}`} key={name}>
                <span className="venue-mark">{name.slice(0, 1)}</span>
                <div><strong>{name}</strong><small>{isKalshi ? `${scope} · owner demo via Simmer/DFlow` : scope}</small></div>
                <span className={verified ? "verified-state" : "not-connected"}>{stateLabel}</span>
                <button type="button" disabled>{verified ? "Synced" : "Connect"}</button>
              </div>;
            })}
          </div>
        </section>

        <section className="workspace-section demo-proof" aria-labelledby="demo-proof-heading">
          <div className="section-title">
            <div><p className="kicker">Private founder proof</p><h2 id="demo-proof-heading">Your Kalshi account, safely redacted</h2></div>
            <p>This view verifies the existing connection without showing balances, wallet addresses, positions, market names, or credentials.</p>
          </div>
          <div className="proof-grid">
            <div><span>Authentication</span><strong>{kalshiDemo.authenticated ? "Verified" : "Not verified"}</strong></div>
            <div><span>Local signing key</span><strong>{kalshiDemo.signing_key_available ? "In OS vault" : "Not imported"}</strong></div>
            <div><span>Direct Kalshi API</span><strong>{kalshiDemo.direct_api_configured ? "Configured" : "Required for live"}</strong></div>
            <div><span>Active positions synced</span><strong>{kalshiDemo.authenticated ? kalshiDemo.active_position_count : "—"}</strong></div>
            <div><span>Live entries</span><strong className="locked-copy">Locked</strong></div>
          </div>
          {kalshiDemo.owner_import_available && !kalshiDemo.configured ? <button className="owner-import" type="button" onClick={importOwnerDemo} disabled={kalshiImporting}>{kalshiImporting ? "Importing…" : "Use this Mac's existing owner connection"}</button> : null}
          <p className="proof-note">Simmer/DFlow remains read-only. A one-contract live canary can use only the direct Kalshi API after its separate credentials, market choice, fee check, and confirmation gates pass.</p>
        </section>

        <section className="workspace-section risk-panel">
          <div className="section-title">
            <div><p className="kicker">Non-overridable maximums</p><h2>Risk policy</h2></div>
            <p>Customers may lower these values after activation.</p>
          </div>
          <div className="policy-grid">
            <div><span>Opening order</span><strong>{money(policy.max_opening_order_usd)}</strong></div>
            <div><span>Venue exposure</span><strong>{money(policy.max_venue_exposure_usd)}</strong></div>
            <div><span>Global exposure</span><strong>{money(policy.max_global_exposure_usd)}</strong></div>
            <div><span>Venue daily loss stop</span><strong>{money(policy.max_daily_loss_usd)}</strong></div>
          </div>
        </section>
      </main>
    </div>
  );
}
