use crate::vault::{CredentialVault, VaultKey};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use daytradingbot_licensing::{LicenseGate, SignedLease};
use ed25519_dalek::SigningKey;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, Zeroizing};

const RENEWAL_WINDOW_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Serialize)]
pub struct EntryLicenseStatus {
    activated: bool,
    real_trading_ready: bool,
    renewal_needed: bool,
    expires_at: Option<String>,
    message: &'static str,
}

impl EntryLicenseStatus {
    fn not_activated(message: &'static str) -> Self {
        Self {
            activated: false,
            real_trading_ready: false,
            renewal_needed: false,
            expires_at: None,
            message,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ActivateLicenseRequest {
    license_code: String,
}

impl Drop for ActivateLicenseRequest {
    fn drop(&mut self) {
        self.license_code.zeroize();
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiActivationRequest<'a> {
    license_code: &'a str,
    device_public_key: &'a str,
    platform: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiRenewalRequest<'a> {
    activation_token: &'a str,
    device_public_key: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiActivationResponse {
    activated: bool,
    activation_token: Option<String>,
    signed_lease: SignedLease,
}

impl Drop for ApiActivationResponse {
    fn drop(&mut self) {
        if let Some(token) = &mut self.activation_token {
            token.zeroize();
        }
    }
}

#[derive(Debug, Deserialize)]
struct ApiErrorResponse {
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredActivation {
    device_public_key: [u8; 32],
    signed_lease: SignedLease,
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(i64::MAX, |duration| {
            i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
        })
}

fn api_base_url() -> &'static str {
    option_env!("DAYTRADINGBOT_API_BASE_URL").unwrap_or("https://api.daytradingbot.net")
}

fn activation_path(app: &AppHandle) -> Result<PathBuf, &'static str> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("license-activation.json"))
        .map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")
}

fn read_activation(app: &AppHandle) -> Result<Option<StoredActivation>, &'static str> {
    let path = activation_path(app)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("LICENSE_STORAGE_UNAVAILABLE"),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "LICENSE_ACTIVATION_INVALID")
}

fn write_activation(app: &AppHandle, activation: &StoredActivation) -> Result<(), &'static str> {
    let path = activation_path(app)?;
    let parent = path.parent().ok_or("LICENSE_STORAGE_UNAVAILABLE")?;
    fs::create_dir_all(parent).map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?;
    let bytes = serde_json::to_vec(activation).map_err(|_| "LICENSE_ACTIVATION_INVALID")?;
    fs::write(&path, bytes).map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?;
    }
    Ok(())
}

fn load_or_create_device_key(vault: &CredentialVault) -> Result<SigningKey, &'static str> {
    if let Some(seed) = vault
        .load_optional(VaultKey::DeviceSigningKey)
        .map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?
    {
        let seed: [u8; 32] = seed
            .as_slice()
            .try_into()
            .map_err(|_| "LICENSE_ACTIVATION_INVALID")?;
        return Ok(SigningKey::from_bytes(&seed));
    }

    let mut seed = Zeroizing::new([0_u8; 32]);
    SystemRandom::new()
        .fill(seed.as_mut())
        .map_err(|_| "LICENSE_ACTIVATION_UNAVAILABLE")?;
    vault
        .store(VaultKey::DeviceSigningKey, seed.as_ref())
        .map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?;
    Ok(SigningKey::from_bytes(&seed))
}

fn install_response(
    app: &AppHandle,
    response: &ApiActivationResponse,
    device_public_key: [u8; 32],
) -> Result<(), &'static str> {
    if !response.activated || response.signed_lease.claims.device_public_key != device_public_key {
        return Err("LICENSE_ACTIVATION_INVALID");
    }
    let now = unix_now();
    app.state::<LicenseGate>()
        .verify_and_install(&response.signed_lease, &device_public_key, now)
        .map_err(|_| "LICENSE_ACTIVATION_INVALID")?;
    write_activation(
        app,
        &StoredActivation {
            device_public_key,
            signed_lease: response.signed_lease.clone(),
        },
    )?;
    app.state::<CredentialVault>()
        .store(VaultKey::LicenseLastTrustedTime, now.to_string().as_bytes())
        .map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?;
    Ok(())
}

fn http_client() -> Result<reqwest::Client, &'static str> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("DayTradingBot/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "LICENSE_ACTIVATION_UNAVAILABLE")
}

async fn parse_api_response(
    response: reqwest::Response,
) -> Result<ApiActivationResponse, &'static str> {
    let status = response.status();
    if status.is_success() {
        return response
            .json::<ApiActivationResponse>()
            .await
            .map_err(|_| "LICENSE_ACTIVATION_INVALID");
    }
    let error = response
        .json::<ApiErrorResponse>()
        .await
        .ok()
        .and_then(|body| body.error);
    match (status.as_u16(), error.as_deref()) {
        (401, Some("invalid_license")) => Err("PURCHASE_CODE_NOT_RECOGNIZED"),
        (409, Some("device_already_active")) => Err("PURCHASE_CODE_ACTIVE_ELSEWHERE"),
        _ => Err("LICENSE_ACTIVATION_UNAVAILABLE"),
    }
}

pub fn restore_license(app: &AppHandle) -> Result<bool, &'static str> {
    let Some(activation) = read_activation(app)? else {
        return Ok(false);
    };
    app.state::<LicenseGate>()
        .verify_and_install(
            &activation.signed_lease,
            &activation.device_public_key,
            unix_now(),
        )
        .map_err(|_| "LICENSE_ACTIVATION_INVALID")?;
    Ok(true)
}

#[tauri::command]
pub fn entry_license_status(app: AppHandle) -> EntryLicenseStatus {
    let Ok(Some(activation)) = read_activation(&app) else {
        return EntryLicenseStatus::not_activated("Activate the app before using real money.");
    };
    let now = unix_now();
    let expires_at_unix = activation.signed_lease.claims.expires_at_unix;
    let ready = app.state::<LicenseGate>().entries_allowed(now, now);
    EntryLicenseStatus {
        activated: ready,
        real_trading_ready: ready,
        renewal_needed: expires_at_unix <= now.saturating_add(RENEWAL_WINDOW_SECONDS),
        expires_at: chrono::DateTime::from_timestamp(expires_at_unix, 0)
            .map(|value| value.to_rfc3339()),
        message: if ready {
            "This app is activated for real trading."
        } else {
            "Renew this app before using real money."
        },
    }
}

#[tauri::command]
pub async fn activate_license(
    app: AppHandle,
    mut request: ActivateLicenseRequest,
) -> Result<EntryLicenseStatus, &'static str> {
    request.license_code = request.license_code.trim().to_uppercase();
    if !request.license_code.starts_with("DTB-")
        || !(16..=84).contains(&request.license_code.len())
        || request.license_code.chars().any(|character| {
            !(character.is_ascii_uppercase() || character.is_ascii_digit() || character == '-')
        })
    {
        return Err("PURCHASE_CODE_NOT_RECOGNIZED");
    }
    let signing_key = load_or_create_device_key(app.state::<CredentialVault>().inner())?;
    let device_public_key = signing_key.verifying_key().to_bytes();
    let encoded_public_key = URL_SAFE_NO_PAD.encode(device_public_key);
    let response = http_client()?
        .post(format!("{}/v1/licenses/activate", api_base_url()))
        .json(&ApiActivationRequest {
            license_code: &request.license_code,
            device_public_key: &encoded_public_key,
            platform: if cfg!(target_os = "windows") {
                "windows-x64"
            } else {
                "macos-universal"
            },
        })
        .send()
        .await
        .map_err(|_| "LICENSE_ACTIVATION_UNAVAILABLE")?;
    let response = parse_api_response(response).await?;
    let token = response
        .activation_token
        .as_deref()
        .ok_or("LICENSE_ACTIVATION_INVALID")?;
    app.state::<CredentialVault>()
        .store(VaultKey::LicenseActivationToken, token.as_bytes())
        .map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?;
    install_response(&app, &response, device_public_key)?;
    Ok(entry_license_status(app))
}

#[tauri::command]
pub async fn renew_license(app: AppHandle) -> Result<EntryLicenseStatus, &'static str> {
    let activation = read_activation(&app)?.ok_or("PURCHASE_CODE_NOT_RECOGNIZED")?;
    let token = app
        .state::<CredentialVault>()
        .load(VaultKey::LicenseActivationToken)
        .map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?;
    let token = Zeroizing::new(
        String::from_utf8(token.to_vec()).map_err(|_| "LICENSE_ACTIVATION_INVALID")?,
    );
    let encoded_public_key = URL_SAFE_NO_PAD.encode(activation.device_public_key);
    let response = http_client()?
        .post(format!("{}/v1/licenses/renew", api_base_url()))
        .json(&ApiRenewalRequest {
            activation_token: token.as_str(),
            device_public_key: &encoded_public_key,
        })
        .send()
        .await
        .map_err(|_| "LICENSE_ACTIVATION_UNAVAILABLE")?;
    let response = parse_api_response(response).await?;
    install_response(&app, &response, activation.device_public_key)?;
    Ok(entry_license_status(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_api_is_the_default() {
        if option_env!("DAYTRADINGBOT_API_BASE_URL").is_none() {
            assert_eq!(api_base_url(), "https://api.daytradingbot.net");
        }
    }

    #[test]
    fn device_public_key_has_the_expected_wire_length() {
        let key = SigningKey::from_bytes(&[7_u8; 32]);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes()).len(),
            43
        );
    }
}
