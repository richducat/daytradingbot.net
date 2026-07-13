pub mod vault;
pub use daytradingbot_release as release_verification;

use daytradingbot_contracts::RiskPolicy;
use daytradingbot_ledger::Ledger;
use daytradingbot_licensing::LicenseGate;
use daytradingbot_venues::robinhood::{RobinhoodAgenticClient, RobinhoodMcpError};
use daytradingbot_venues::simmer::{SimmerConnectionState, SimmerKalshiClient};
use serde::{Deserialize, Serialize};
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

#[derive(Serialize)]
struct RobinhoodOwnerDemoStatus {
    owner_import_available: bool,
    configured: bool,
    connection_state: &'static str,
    provider: &'static str,
    authenticated: bool,
    agentic_account_available: bool,
    agentic_account_count: usize,
    has_buying_power: bool,
    observed_at: Option<String>,
    live_entries_available: bool,
}

impl RobinhoodOwnerDemoStatus {
    fn not_configured() -> Self {
        Self {
            owner_import_available: cfg!(debug_assertions),
            configured: false,
            connection_state: "not_configured",
            provider: "robinhood_agentic_mcp",
            authenticated: false,
            agentic_account_available: false,
            agentic_account_count: 0,
            has_buying_power: false,
            observed_at: None,
            live_entries_available: false,
        }
    }

    fn authentication_expired() -> Self {
        Self {
            configured: true,
            connection_state: "authentication_expired",
            ..Self::not_configured()
        }
    }

    fn permission_denied() -> Self {
        Self {
            configured: true,
            connection_state: "permission_denied",
            ..Self::not_configured()
        }
    }
}

#[derive(Deserialize)]
struct StoredRobinhoodOAuthToken {
    access_token: String,
    expires_at: Option<f64>,
}

impl Drop for StoredRobinhoodOAuthToken {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

fn parse_robinhood_oauth_token(raw: &str) -> Result<StoredRobinhoodOAuthToken, &'static str> {
    let token: StoredRobinhoodOAuthToken =
        serde_json::from_str(raw).map_err(|_| "ROBINHOOD_OWNER_CREDENTIAL_INVALID")?;
    if token.access_token.len() < 24 || token.access_token.chars().any(char::is_whitespace) {
        return Err("ROBINHOOD_OWNER_CREDENTIAL_INVALID");
    }
    Ok(token)
}

fn reduce_robinhood_oauth_bundle(
    raw: &str,
) -> Result<(Zeroizing<Vec<u8>>, Option<f64>), &'static str> {
    #[derive(Serialize)]
    struct ReducedRobinhoodOAuthToken<'a> {
        access_token: &'a str,
        expires_at: Option<f64>,
    }

    let token = parse_robinhood_oauth_token(raw)?;
    let expires_at = token.expires_at;
    let reduced = serde_json::to_vec(&ReducedRobinhoodOAuthToken {
        access_token: &token.access_token,
        expires_at,
    })
    .map_err(|_| "ROBINHOOD_OWNER_CREDENTIAL_INVALID")?;
    Ok((Zeroizing::new(reduced), expires_at))
}

fn unix_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(f64::MAX, |duration| duration.as_secs_f64())
}

fn robinhood_token_is_current(expires_at: Option<f64>) -> bool {
    expires_at.is_some_and(|expiry| expiry.is_finite() && expiry > unix_now() + 120.0)
}

/// Reads only the official MCP `get_accounts` tool and returns a privacy-safe
/// proof that a dedicated Agentic account is reachable. No generic MCP tool
/// name, market, quote, review, order, cancel, or transfer operation is exposed.
#[tauri::command]
async fn robinhood_owner_demo_status(
    vault: tauri::State<'_, CredentialVault>,
) -> Result<RobinhoodOwnerDemoStatus, &'static str> {
    let Some(raw_bytes) = vault
        .load_optional(VaultKey::RobinhoodOAuthToken)
        .map_err(|_| "ROBINHOOD_OWNER_VAULT_UNAVAILABLE")?
    else {
        return Ok(RobinhoodOwnerDemoStatus::not_configured());
    };
    let raw = std::str::from_utf8(&raw_bytes).map_err(|_| "ROBINHOOD_OWNER_CREDENTIAL_INVALID")?;
    let token = parse_robinhood_oauth_token(raw)?;
    if !robinhood_token_is_current(token.expires_at) {
        return Ok(RobinhoodOwnerDemoStatus::authentication_expired());
    }
    let client = RobinhoodAgenticClient::new(Zeroizing::new(token.access_token.clone()))
        .map_err(|_| "ROBINHOOD_OWNER_CREDENTIAL_INVALID")?;
    let snapshot = match client.read_owner_snapshot().await {
        Ok(snapshot) => snapshot,
        Err(RobinhoodMcpError::AuthenticationFailed) => {
            return Ok(RobinhoodOwnerDemoStatus::authentication_expired());
        }
        Err(RobinhoodMcpError::PermissionDenied) => {
            return Ok(RobinhoodOwnerDemoStatus::permission_denied());
        }
        Err(RobinhoodMcpError::RateLimited) => {
            return Err("ROBINHOOD_OWNER_RATE_LIMITED");
        }
        Err(_) => return Err("ROBINHOOD_OWNER_PROVIDER_UNAVAILABLE"),
    };
    Ok(RobinhoodOwnerDemoStatus {
        owner_import_available: cfg!(debug_assertions),
        configured: true,
        connection_state: if snapshot.agentic_account_available {
            "read_only_ready"
        } else {
            "no_agentic_account"
        },
        provider: "robinhood_agentic_mcp",
        authenticated: snapshot.authenticated,
        agentic_account_available: snapshot.agentic_account_available,
        agentic_account_count: snapshot.agentic_account_count,
        has_buying_power: snapshot.has_buying_power,
        observed_at: Some(snapshot.observed_at.to_rfc3339()),
        live_entries_available: false,
    })
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
    direct_api_configured: bool,
    wallet_configured: bool,
    active_position_count: usize,
    has_spendable_balance: bool,
    has_open_exposure: bool,
    warning_count: usize,
    observed_at: Option<String>,
    live_entries_available: bool,
}

impl KalshiOwnerDemoStatus {
    fn not_configured(direct_api_configured: bool) -> Self {
        Self {
            owner_import_available: cfg!(debug_assertions),
            configured: false,
            connection_state: "not_configured",
            provider: "simmer_dflow",
            authenticated: false,
            signing_key_available: false,
            direct_api_configured,
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
    let direct_api_configured = vault
        .load_optional(VaultKey::KalshiApiKeyId)
        .map_err(|_| "OWNER_DEMO_VAULT_UNAVAILABLE")?
        .is_some()
        && vault
            .load_optional(VaultKey::KalshiPrivateKeyPem)
            .map_err(|_| "OWNER_DEMO_VAULT_UNAVAILABLE")?
            .is_some();
    let Some(api_key_bytes) = vault
        .load_optional(VaultKey::SimmerApiKey)
        .map_err(|_| "OWNER_DEMO_VAULT_UNAVAILABLE")?
    else {
        return Ok(KalshiOwnerDemoStatus::not_configured(direct_api_configured));
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
        direct_api_configured,
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

#[cfg(debug_assertions)]
fn import_robinhood_owner_connection_into(vault: &CredentialVault) -> Result<(), &'static str> {
    let home = std::path::PathBuf::from(
        std::env::var_os("HOME").ok_or("ROBINHOOD_OWNER_IMPORT_UNAVAILABLE")?,
    );
    let token_path = home.join(".hermes/mcp-tokens/robinhood.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&token_path)
            .map_err(|_| "ROBINHOOD_OWNER_IMPORT_UNAVAILABLE")?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err("ROBINHOOD_OWNER_IMPORT_INSECURE");
        }
    }
    let raw = Zeroizing::new(
        std::fs::read_to_string(token_path).map_err(|_| "ROBINHOOD_OWNER_IMPORT_UNAVAILABLE")?,
    );
    let (reduced, expires_at) = reduce_robinhood_oauth_bundle(&raw)?;
    if !robinhood_token_is_current(expires_at) {
        return Err("ROBINHOOD_OWNER_AUTHENTICATION_EXPIRED");
    }
    vault
        .store(VaultKey::RobinhoodOAuthToken, &reduced)
        .map_err(|_| "ROBINHOOD_OWNER_VAULT_UNAVAILABLE")?;
    Ok(())
}

/// One-time migration of the owner's already-authorized Robinhood Agentic MCP
/// OAuth session into the OS vault. Release builds never read Hermes files.
#[tauri::command]
fn import_robinhood_owner_connection(
    vault: tauri::State<'_, CredentialVault>,
) -> Result<bool, &'static str> {
    #[cfg(not(debug_assertions))]
    {
        let _ = vault;
        Err("ROBINHOOD_OWNER_IMPORT_UNAVAILABLE")
    }

    #[cfg(debug_assertions)]
    {
        import_robinhood_owner_connection_into(&vault)?;
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
                let _ = import_robinhood_owner_connection_into(&vault);
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
            robinhood_owner_demo_status,
            kalshi_owner_demo_status,
            import_owner_demo_credentials,
            import_robinhood_owner_connection
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DayTradingBot desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn robinhood_vault_bundle_excludes_refresh_token() {
        let raw = serde_json::json!({
            "access_token": "owner-access-token-that-is-long-enough",
            "refresh_token": "refresh-must-never-be-imported",
            "expires_at": unix_now() + 3600.0
        })
        .to_string();
        let (reduced, _) = reduce_robinhood_oauth_bundle(&raw).expect("valid owner token");
        let reduced = std::str::from_utf8(&reduced).expect("JSON is UTF-8");
        assert!(reduced.contains("access_token"));
        assert!(!reduced.contains("refresh_token"));
        assert!(!reduced.contains("refresh-must-never-be-imported"));
    }

    #[test]
    fn robinhood_token_requires_a_finite_future_expiry() {
        assert!(!robinhood_token_is_current(None));
        assert!(!robinhood_token_is_current(Some(f64::INFINITY)));
        assert!(!robinhood_token_is_current(Some(unix_now() - 1.0)));
        assert!(robinhood_token_is_current(Some(unix_now() + 3600.0)));
    }
}
