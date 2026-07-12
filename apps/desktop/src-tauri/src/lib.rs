pub mod vault;
pub use daytradingbot_release as release_verification;

use daytradingbot_contracts::RiskPolicy;
use daytradingbot_ledger::Ledger;
use daytradingbot_licensing::LicenseGate;
use daytradingbot_venues::simmer::{SimmerConnectionState, SimmerKalshiClient};
use serde::Serialize;
#[cfg(not(debug_assertions))]
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use vault::{CredentialVault, VaultKey};
use zeroize::{Zeroize, Zeroizing};

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
    #[cfg(debug_assertions)]
    {
        let _ = (gate, vault);
        EntryLicenseStatus {
            entries_allowed: false,
            mode: "close_only",
        }
    }

    #[cfg(not(debug_assertions))]
    {
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
}

#[derive(Serialize)]
struct KalshiOwnerDemoStatus {
    owner_import_available: bool,
    configured: bool,
    connection_state: &'static str,
    provider: &'static str,
    authenticated: bool,
    signing_key_available: bool,
    wallet_configured: bool,
    active_position_count: usize,
    has_spendable_balance: bool,
    has_open_exposure: bool,
    warning_count: usize,
    observed_at: Option<String>,
    live_entries_available: bool,
}

impl KalshiOwnerDemoStatus {
    fn not_configured() -> Self {
        Self {
            owner_import_available: cfg!(debug_assertions),
            configured: false,
            connection_state: "not_configured",
            provider: "simmer_dflow",
            authenticated: false,
            signing_key_available: false,
            wallet_configured: false,
            active_position_count: 0,
            has_spendable_balance: false,
            has_open_exposure: false,
            warning_count: 0,
            observed_at: None,
            live_entries_available: false,
        }
    }
}

/// Reads a deliberately redacted summary of the owner's existing Kalshi
/// connection. It cannot import markets, change provider settings, quote, sign,
/// submit, cancel, or otherwise mutate the account.
#[tauri::command]
async fn kalshi_owner_demo_status(
    vault: tauri::State<'_, CredentialVault>,
) -> Result<KalshiOwnerDemoStatus, &'static str> {
    let Some(api_key_bytes) = vault
        .load_optional(VaultKey::SimmerApiKey)
        .map_err(|_| "OWNER_DEMO_VAULT_UNAVAILABLE")?
    else {
        return Ok(KalshiOwnerDemoStatus::not_configured());
    };
    let signing_key_available = vault
        .load_optional(VaultKey::KalshiSolanaPrivateKey)
        .map_err(|_| "OWNER_DEMO_VAULT_UNAVAILABLE")?
        .is_some();
    let api_key = Zeroizing::new(
        String::from_utf8(api_key_bytes.to_vec()).map_err(|_| "OWNER_DEMO_CREDENTIAL_INVALID")?,
    );
    let client = SimmerKalshiClient::new(api_key).map_err(|_| "OWNER_DEMO_CREDENTIAL_INVALID")?;
    let snapshot = client
        .read_owner_snapshot()
        .await
        .map_err(|_| "OWNER_DEMO_PROVIDER_UNAVAILABLE")?;
    let connection_state = match snapshot.connection_state {
        SimmerConnectionState::ReadOnlyReady => "read_only_ready",
        SimmerConnectionState::ClaimRequired => "claim_required",
        SimmerConnectionState::TradingNotEnabled => "trading_not_enabled",
    };

    Ok(KalshiOwnerDemoStatus {
        owner_import_available: cfg!(debug_assertions),
        configured: true,
        connection_state,
        provider: "simmer_dflow",
        authenticated: snapshot.authenticated,
        signing_key_available,
        wallet_configured: snapshot.wallet_configured,
        active_position_count: snapshot.active_position_count,
        has_spendable_balance: snapshot.has_spendable_balance,
        has_open_exposure: snapshot.has_open_exposure,
        warning_count: snapshot.warning_count,
        observed_at: Some(snapshot.observed_at.to_rfc3339()),
        live_entries_available: false,
    })
}

#[derive(serde::Deserialize)]
struct OwnerSimmerCredentials {
    api_key: String,
}

#[cfg(debug_assertions)]
fn import_owner_demo_credentials_into(vault: &CredentialVault) -> Result<(), &'static str> {
    let home =
        std::path::PathBuf::from(std::env::var_os("HOME").ok_or("OWNER_DEMO_IMPORT_UNAVAILABLE")?);
    let simmer_raw = Zeroizing::new(
        std::fs::read_to_string(home.join(".config/simmer/credentials.json"))
            .map_err(|_| "OWNER_DEMO_IMPORT_UNAVAILABLE")?,
    );
    let mut simmer: OwnerSimmerCredentials =
        serde_json::from_str(&simmer_raw).map_err(|_| "OWNER_DEMO_CREDENTIAL_INVALID")?;
    let kalshi_raw = Zeroizing::new(
        std::fs::read_to_string(home.join(".config/clawbot/kalshi.env"))
            .map_err(|_| "OWNER_DEMO_IMPORT_UNAVAILABLE")?,
    );
    let solana_key = kalshi_raw
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "SOLANA_PRIVATE_KEY").then(|| value.trim().trim_matches(['\'', '"']))
        })
        .filter(|value| {
            (32..=256).contains(&value.len()) && !value.chars().any(char::is_whitespace)
        })
        .ok_or("OWNER_DEMO_CREDENTIAL_INVALID")?;
    if simmer.api_key.len() < 16
        || !simmer.api_key.starts_with("sk_")
        || simmer.api_key.chars().any(char::is_whitespace)
    {
        simmer.api_key.zeroize();
        return Err("OWNER_DEMO_CREDENTIAL_INVALID");
    }

    let api_store = vault.store(VaultKey::SimmerApiKey, simmer.api_key.as_bytes());
    simmer.api_key.zeroize();
    api_store.map_err(|_| "OWNER_DEMO_VAULT_UNAVAILABLE")?;
    vault
        .store(VaultKey::KalshiSolanaPrivateKey, solana_key.as_bytes())
        .map_err(|_| "OWNER_DEMO_VAULT_UNAVAILABLE")?;
    Ok(())
}

/// One-time local migration for the owner's debug founder build. Release
/// builds retain the command contract but compile out all legacy file access.
#[tauri::command]
fn import_owner_demo_credentials(
    vault: tauri::State<'_, CredentialVault>,
) -> Result<bool, &'static str> {
    #[cfg(not(debug_assertions))]
    {
        let _ = vault;
        Err("OWNER_DEMO_IMPORT_UNAVAILABLE")
    }

    #[cfg(debug_assertions)]
    {
        import_owner_demo_credentials_into(&vault)?;
        Ok(true)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CredentialVault::new())
        .manage(LicenseGate::new())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let vault = app.state::<CredentialVault>();
                let _ = import_owner_demo_credentials_into(&vault);
            }
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let ledger = Ledger::open(app_data_dir.join("ledger.sqlite3"))
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            app.manage(ledger);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launch_policy,
            entry_license_status,
            kalshi_owner_demo_status,
            import_owner_demo_credentials
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DayTradingBot desktop application");
}
