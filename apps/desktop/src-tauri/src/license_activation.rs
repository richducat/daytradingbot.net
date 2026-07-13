use crate::vault::{CredentialVault, VaultKey};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use daytradingbot_licensing::{LicenseGate, SignedLease};
use ed25519_dalek::SigningKey;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
#[cfg(feature = "owner-demo-license")]
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
#[cfg(feature = "owner-demo-license")]
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, Zeroizing};

const RENEWAL_WINDOW_SECONDS: i64 = 24 * 60 * 60;
#[cfg(feature = "owner-demo-license")]
const OWNER_DEMO_CODE_SHA256: &str = env!("DAYTRADINGBOT_OWNER_DEMO_CODE_SHA256");
#[cfg(feature = "owner-demo-license")]
const OWNER_DEMO_MARKER_VERSION: u16 = 1;

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

    #[cfg(feature = "owner-demo-license")]
    fn owner_demo() -> Self {
        Self {
            activated: true,
            real_trading_ready: true,
            renewal_needed: false,
            expires_at: None,
            message: "This private owner demo is activated for real trading.",
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

#[cfg(feature = "owner-demo-license")]
#[derive(Debug, Serialize, Deserialize)]
struct StoredOwnerDemoActivation {
    version: u16,
    device_public_key: [u8; 32],
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

#[cfg(feature = "owner-demo-license")]
fn owner_demo_activation_path(app: &AppHandle) -> Result<PathBuf, &'static str> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("owner-demo-activation.json"))
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

#[cfg(feature = "owner-demo-license")]
fn read_owner_demo_activation(
    app: &AppHandle,
) -> Result<Option<StoredOwnerDemoActivation>, &'static str> {
    let bytes = match fs::read(owner_demo_activation_path(app)?) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("LICENSE_STORAGE_UNAVAILABLE"),
    };
    let activation: StoredOwnerDemoActivation =
        serde_json::from_slice(&bytes).map_err(|_| "LICENSE_ACTIVATION_INVALID")?;
    if activation.version != OWNER_DEMO_MARKER_VERSION {
        return Err("LICENSE_ACTIVATION_INVALID");
    }
    Ok(Some(activation))
}

#[cfg(feature = "owner-demo-license")]
fn write_owner_demo_activation(
    app: &AppHandle,
    device_public_key: [u8; 32],
) -> Result<(), &'static str> {
    let path = owner_demo_activation_path(app)?;
    let parent = path.parent().ok_or("LICENSE_STORAGE_UNAVAILABLE")?;
    fs::create_dir_all(parent).map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?;
    let bytes = serde_json::to_vec(&StoredOwnerDemoActivation {
        version: OWNER_DEMO_MARKER_VERSION,
        device_public_key,
    })
    .map_err(|_| "LICENSE_ACTIVATION_INVALID")?;
    fs::write(&path, bytes).map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?;
    }
    Ok(())
}

#[cfg(feature = "owner-demo-license")]
fn decode_sha256_hex(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut decoded = [0_u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let text = std::str::from_utf8(pair).ok()?;
        decoded[index] = u8::from_str_radix(text, 16).ok()?;
    }
    Some(decoded)
}

#[cfg(feature = "owner-demo-license")]
fn owner_demo_code_matches_with_hash(code: &str, expected_hash: &str) -> bool {
    let Some(expected) = decode_sha256_hex(expected_hash) else {
        return false;
    };
    let actual: [u8; 32] = Sha256::digest(code.as_bytes()).into();
    bool::from(actual.ct_eq(&expected))
}

#[cfg(feature = "owner-demo-license")]
fn owner_demo_code_matches(code: &str) -> bool {
    owner_demo_code_matches_with_hash(code, OWNER_DEMO_CODE_SHA256)
}

#[cfg(feature = "owner-demo-license")]
fn restore_owner_demo(app: &AppHandle) -> Result<bool, &'static str> {
    let Some(activation) = read_owner_demo_activation(app)? else {
        return Ok(false);
    };
    let signing_key = load_or_create_owner_demo_device_key(app.state::<CredentialVault>().inner())?;
    if signing_key.verifying_key().to_bytes() != activation.device_public_key {
        return Err("LICENSE_ACTIVATION_INVALID");
    }
    app.state::<LicenseGate>()
        .install_owner_demo()
        .map_err(|_| "LICENSE_ACTIVATION_INVALID")?;
    Ok(true)
}

#[cfg(feature = "owner-demo-license")]
fn owner_demo_ready(app: &AppHandle) -> bool {
    read_owner_demo_activation(app).ok().flatten().is_some()
        && app
            .state::<LicenseGate>()
            .entries_allowed(unix_now(), unix_now())
}

fn load_or_create_device_key(vault: &CredentialVault) -> Result<SigningKey, &'static str> {
    load_or_create_signing_key(vault, VaultKey::DeviceSigningKey)
}

#[cfg(feature = "owner-demo-license")]
fn load_or_create_owner_demo_device_key(
    vault: &CredentialVault,
) -> Result<SigningKey, &'static str> {
    load_or_create_signing_key(vault, VaultKey::OwnerDemoDeviceSigningKey)
}

fn load_or_create_signing_key(
    vault: &CredentialVault,
    vault_key: VaultKey,
) -> Result<SigningKey, &'static str> {
    if let Some(seed) = vault
        .load_optional(vault_key)
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
        .store(vault_key, seed.as_ref())
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
    #[cfg(feature = "owner-demo-license")]
    if restore_owner_demo(app)? {
        return Ok(true);
    }
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
    #[cfg(feature = "owner-demo-license")]
    if owner_demo_ready(&app) {
        return EntryLicenseStatus::owner_demo();
    }
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
    #[cfg(feature = "owner-demo-license")]
    if owner_demo_code_matches(&request.license_code) {
        let signing_key =
            load_or_create_owner_demo_device_key(app.state::<CredentialVault>().inner())?;
        let device_public_key = signing_key.verifying_key().to_bytes();
        write_owner_demo_activation(&app, device_public_key)?;
        app.state::<LicenseGate>()
            .install_owner_demo()
            .map_err(|_| "LICENSE_ACTIVATION_INVALID")?;
        return Ok(EntryLicenseStatus::owner_demo());
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
    #[cfg(feature = "owner-demo-license")]
    if owner_demo_ready(&app) {
        return Ok(EntryLicenseStatus::owner_demo());
    }
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

    #[cfg(feature = "owner-demo-license")]
    #[test]
    fn owner_demo_code_check_accepts_only_the_matching_code() {
        let code = "DTB-OWNER-0123456789ABCDEF0123456789ABCDEF0123";
        let hash = format!("{:x}", Sha256::digest(code.as_bytes()));
        assert!(owner_demo_code_matches_with_hash(code, &hash));
        assert!(!owner_demo_code_matches_with_hash(
            "DTB-OWNER-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
            &hash,
        ));
        assert!(!owner_demo_code_matches_with_hash(code, "not-a-hash"));
    }
}
