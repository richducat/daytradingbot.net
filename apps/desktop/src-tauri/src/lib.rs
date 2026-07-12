pub mod vault;
pub use daytradingbot_release as release_verification;

use daytradingbot_contracts::RiskPolicy;
use daytradingbot_ledger::Ledger;
use daytradingbot_licensing::LicenseGate;
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use vault::{CredentialVault, VaultKey};

#[tauri::command]
fn launch_policy() -> RiskPolicy {
    RiskPolicy::default()
}

#[derive(Serialize)]
struct EntryLicenseStatus {
    entries_allowed: bool,
    mode: &'static str,
}

#[tauri::command]
fn entry_license_status(
    gate: tauri::State<'_, LicenseGate>,
    vault: tauri::State<'_, CredentialVault>,
) -> EntryLicenseStatus {
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(i64::MAX, |duration| {
            i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
        });
    let trusted_time_floor = vault
        .load_optional(VaultKey::LicenseLastTrustedTime)
        .ok()
        .flatten()
        .and_then(|value| std::str::from_utf8(&value).ok()?.parse::<i64>().ok());
    let trusted_time_floor = trusted_time_floor.unwrap_or(now_unix);
    let floor_to_store = now_unix.max(trusted_time_floor);
    let vault_available = vault
        .store(
            VaultKey::LicenseLastTrustedTime,
            floor_to_store.to_string().as_bytes(),
        )
        .is_ok();
    let entries_allowed = vault_available && gate.entries_allowed(now_unix, trusted_time_floor);
    EntryLicenseStatus {
        entries_allowed,
        mode: if entries_allowed {
            "entry_enabled"
        } else {
            "close_only"
        },
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CredentialVault::new())
        .manage(LicenseGate::new())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let ledger = Ledger::open(app_data_dir.join("ledger.sqlite3"))
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            app.manage(ledger);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launch_policy,
            entry_license_status
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DayTradingBot desktop application");
}
