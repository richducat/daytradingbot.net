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
            {venues.map(([name, scope]) => (
              <div className="venue-item" key={name}>
                <span className="venue-mark">{name.slice(0, 1)}</span>
                <div><strong>{name}</strong><small>{scope}</small></div>
                <span className="not-connected">Not connected</span>
                <button type="button" disabled>Connect</button>
              </div>
            ))}
          </div>
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
