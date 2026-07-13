use crate::vault::{CredentialVault, VaultKey};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const REGISTRATION_ENDPOINT: &str = "https://agent.robinhood.com/oauth/trading/register";
const AUTHORIZATION_ENDPOINT: &str = "https://robinhood.com/oauth";
const TOKEN_ENDPOINT: &str = "https://api.robinhood.com/oauth2/token/";
const MCP_RESOURCE: &str = "https://agent.robinhood.com/mcp/trading";
const OAUTH_SCOPE: &str = "internal";

#[derive(Deserialize)]
struct ClientRegistrationResponse {
    client_id: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Deserialize)]
struct StoredAccessBundle {
    access_token: String,
    expires_at: f64,
}

impl Drop for StoredAccessBundle {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

impl Drop for TokenResponse {
    fn drop(&mut self) {
        self.access_token.zeroize();
        if let Some(refresh_token) = &mut self.refresh_token {
            refresh_token.zeroize();
        }
    }
}

#[derive(Serialize)]
pub struct RobinhoodConnectionResult {
    connected: bool,
    message: &'static str,
}

fn unix_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(f64::MAX, |duration| duration.as_secs_f64())
}

fn oauth_client() -> Result<reqwest::Client, &'static str> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("DayTradingBot/0.1 robinhood-oauth")
        .build()
        .map_err(|_| "ROBINHOOD_CONNECTION_UNAVAILABLE")
}

fn generate_pkce() -> (Zeroizing<String>, String) {
    let verifier = Zeroizing::new(format!(
        "{}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    ));
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn open_browser(url: &str) -> Result<(), &'static str> {
    let parsed = Url::parse(url).map_err(|_| "ROBINHOOD_CONNECTION_UNAVAILABLE")?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("robinhood.com") {
        return Err("ROBINHOOD_CONNECTION_UNAVAILABLE");
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("/usr/bin/open").arg(url).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd").args(["/C", "start", "", url]).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(url).status();

    status
        .map_err(|_| "ROBINHOOD_BROWSER_OPEN_FAILED")?
        .success()
        .then_some(())
        .ok_or("ROBINHOOD_BROWSER_OPEN_FAILED")
}

fn write_callback_page(stream: &mut TcpStream, success: bool) {
    let (title, body) = if success {
        (
            "Robinhood connected",
            "Robinhood is connected. You can close this page and return to DayTradingBot.",
        )
    } else {
        (
            "Connection did not finish",
            "The Robinhood connection did not finish. Return to DayTradingBot and try again.",
        )
    };
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{title}</title><style>body{{margin:0;display:grid;place-items:center;min-height:100vh;background:#0d0f0d;color:#f4f2eb;font:16px system-ui}}main{{max-width:560px;padding:44px}}h1{{font-size:40px}}p{{color:#aab0a5;line-height:1.6}}</style><main><h1>{title}</h1><p>{body}</p></main>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn wait_for_callback(listener: TcpListener, expected_state: &str) -> Result<String, &'static str> {
    listener
        .set_nonblocking(true)
        .map_err(|_| "ROBINHOOD_CONNECTION_UNAVAILABLE")?;
    let deadline = Instant::now() + Duration::from_secs(300);
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut request = [0_u8; 16_384];
                let read = stream
                    .read(&mut request)
                    .map_err(|_| "ROBINHOOD_CALLBACK_INVALID")?;
                let first_line = std::str::from_utf8(&request[..read])
                    .map_err(|_| "ROBINHOOD_CALLBACK_INVALID")?
                    .lines()
                    .next()
                    .ok_or("ROBINHOOD_CALLBACK_INVALID")?;
                let target = first_line
                    .strip_prefix("GET ")
                    .and_then(|value| value.split_once(' ').map(|(path, _)| path))
                    .ok_or("ROBINHOOD_CALLBACK_INVALID")?;
                let callback = Url::parse(&format!("http://127.0.0.1{target}"))
                    .map_err(|_| "ROBINHOOD_CALLBACK_INVALID")?;
                let parameters: std::collections::HashMap<_, _> =
                    callback.query_pairs().into_owned().collect();
                if parameters.get("state").map(String::as_str) != Some(expected_state) {
                    write_callback_page(&mut stream, false);
                    return Err("ROBINHOOD_CALLBACK_STATE_MISMATCH");
                }
                if parameters.contains_key("error") {
                    write_callback_page(&mut stream, false);
                    return Err("ROBINHOOD_CONNECTION_DECLINED");
                }
                let code = parameters
                    .get("code")
                    .filter(|value| !value.is_empty() && value.len() <= 4096)
                    .cloned()
                    .ok_or("ROBINHOOD_CALLBACK_INVALID")?;
                write_callback_page(&mut stream, true);
                return Ok(code);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(_) => return Err("ROBINHOOD_CONNECTION_UNAVAILABLE"),
        }
    }
    Err("ROBINHOOD_CONNECTION_TIMED_OUT")
}

fn validate_client_id(client_id: &str) -> Result<(), &'static str> {
    if client_id.is_empty() || client_id.len() > 1024 || client_id.chars().any(char::is_whitespace)
    {
        return Err("ROBINHOOD_REGISTRATION_INVALID");
    }
    Ok(())
}

fn validate_token(token: &str) -> Result<(), &'static str> {
    if token.len() < 24 || token.len() > 16_384 || token.chars().any(char::is_whitespace) {
        return Err("ROBINHOOD_TOKEN_INVALID");
    }
    Ok(())
}

fn store_tokens(
    vault: &CredentialVault,
    client_id: &str,
    tokens: &TokenResponse,
) -> Result<(), &'static str> {
    validate_client_id(client_id)?;
    validate_token(&tokens.access_token)?;
    let expires_at = unix_now() + tokens.expires_in.unwrap_or(3600) as f64;
    let access_bundle = serde_json::to_vec(&serde_json::json!({
        "access_token": tokens.access_token,
        "expires_at": expires_at
    }))
    .map_err(|_| "ROBINHOOD_TOKEN_INVALID")?;
    vault
        .store(VaultKey::RobinhoodOAuthToken, &access_bundle)
        .map_err(|_| "ROBINHOOD_VAULT_UNAVAILABLE")?;
    vault
        .store(VaultKey::RobinhoodOAuthClientId, client_id.as_bytes())
        .map_err(|_| "ROBINHOOD_VAULT_UNAVAILABLE")?;
    if let Some(refresh_token) = &tokens.refresh_token {
        validate_token(refresh_token)?;
        vault
            .store(VaultKey::RobinhoodRefreshToken, refresh_token.as_bytes())
            .map_err(|_| "ROBINHOOD_VAULT_UNAVAILABLE")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn connect_robinhood() -> Result<RobinhoodConnectionResult, &'static str> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|_| "ROBINHOOD_CALLBACK_UNAVAILABLE")?;
    let callback_address = listener
        .local_addr()
        .map_err(|_| "ROBINHOOD_CALLBACK_UNAVAILABLE")?;
    let redirect_uri = format!("http://127.0.0.1:{}/callback", callback_address.port());
    let client = oauth_client()?;
    let registration = client
        .post(REGISTRATION_ENDPOINT)
        .json(&serde_json::json!({
            "client_name": "DayTradingBot",
            "application_type": "native",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": OAUTH_SCOPE
        }))
        .send()
        .await
        .map_err(|_| "ROBINHOOD_REGISTRATION_UNAVAILABLE")?;
    if !registration.status().is_success() {
        return Err("ROBINHOOD_REGISTRATION_REJECTED");
    }
    let registration: ClientRegistrationResponse = registration
        .json()
        .await
        .map_err(|_| "ROBINHOOD_REGISTRATION_INVALID")?;
    validate_client_id(&registration.client_id)?;

    let (verifier, challenge) = generate_pkce();
    let state = Uuid::new_v4().simple().to_string();
    let mut authorization =
        Url::parse(AUTHORIZATION_ENDPOINT).map_err(|_| "ROBINHOOD_CONNECTION_UNAVAILABLE")?;
    authorization
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &registration.client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", OAUTH_SCOPE)
        .append_pair("resource", MCP_RESOURCE)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state);
    open_browser(authorization.as_str())?;

    let expected_state = state.clone();
    let code =
        tauri::async_runtime::spawn_blocking(move || wait_for_callback(listener, &expected_state))
            .await
            .map_err(|_| "ROBINHOOD_CONNECTION_UNAVAILABLE")??;

    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", &code)
        .append_pair("client_id", &registration.client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("code_verifier", verifier.as_str())
        .append_pair("resource", MCP_RESOURCE)
        .finish();
    let token_response = client
        .post(TOKEN_ENDPOINT)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(body)
        .send()
        .await
        .map_err(|_| "ROBINHOOD_TOKEN_EXCHANGE_UNAVAILABLE")?;
    if !token_response.status().is_success() {
        return Err("ROBINHOOD_TOKEN_EXCHANGE_REJECTED");
    }
    let tokens: TokenResponse = token_response
        .json()
        .await
        .map_err(|_| "ROBINHOOD_TOKEN_INVALID")?;
    store_tokens(&CredentialVault::new(), &registration.client_id, &tokens)?;
    Ok(RobinhoodConnectionResult {
        connected: true,
        message: "Robinhood is connected.",
    })
}

pub async fn refresh_robinhood_access(vault: &CredentialVault) -> Result<bool, &'static str> {
    let refresh_token = vault
        .load_optional(VaultKey::RobinhoodRefreshToken)
        .map_err(|_| "ROBINHOOD_VAULT_UNAVAILABLE")?;
    let client_id = vault
        .load_optional(VaultKey::RobinhoodOAuthClientId)
        .map_err(|_| "ROBINHOOD_VAULT_UNAVAILABLE")?;
    let (Some(refresh_token), Some(client_id)) = (refresh_token, client_id) else {
        return Ok(false);
    };
    let refresh_token = Zeroizing::new(
        String::from_utf8(refresh_token.to_vec()).map_err(|_| "ROBINHOOD_TOKEN_INVALID")?,
    );
    let client_id = Zeroizing::new(
        String::from_utf8(client_id.to_vec()).map_err(|_| "ROBINHOOD_TOKEN_INVALID")?,
    );
    validate_token(refresh_token.as_str())?;
    validate_client_id(client_id.as_str())?;
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "refresh_token")
        .append_pair("refresh_token", refresh_token.as_str())
        .append_pair("client_id", client_id.as_str())
        .append_pair("resource", MCP_RESOURCE)
        .finish();
    let response = oauth_client()?
        .post(TOKEN_ENDPOINT)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(body)
        .send()
        .await
        .map_err(|_| "ROBINHOOD_TOKEN_REFRESH_UNAVAILABLE")?;
    if !response.status().is_success() {
        return Ok(false);
    }
    let tokens: TokenResponse = response
        .json()
        .await
        .map_err(|_| "ROBINHOOD_TOKEN_INVALID")?;
    store_tokens(vault, client_id.as_str(), &tokens)?;
    Ok(true)
}

/// Returns a current product-owned access token, refreshing it first when the
/// stored token is close to expiry. The token never crosses the native command
/// boundary and is zeroized after the caller's official MCP client is dropped.
pub async fn current_robinhood_access(
    vault: &CredentialVault,
) -> Result<Zeroizing<String>, &'static str> {
    fn load(vault: &CredentialVault) -> Result<Option<StoredAccessBundle>, &'static str> {
        let Some(raw) = vault
            .load_optional(VaultKey::RobinhoodOAuthToken)
            .map_err(|_| "ROBINHOOD_VAULT_UNAVAILABLE")?
        else {
            return Ok(None);
        };
        let mut bundle: StoredAccessBundle =
            serde_json::from_slice(&raw).map_err(|_| "ROBINHOOD_TOKEN_INVALID")?;
        if validate_token(&bundle.access_token).is_err()
            || !bundle.expires_at.is_finite()
            || bundle.expires_at <= 0.0
        {
            bundle.access_token.zeroize();
            return Err("ROBINHOOD_TOKEN_INVALID");
        }
        Ok(Some(bundle))
    }

    let mut bundle = load(vault)?.ok_or("ROBINHOOD_ACCOUNT_NOT_CONNECTED")?;
    if bundle.expires_at <= unix_now() + 120.0 {
        bundle.access_token.zeroize();
        if !refresh_robinhood_access(vault).await? {
            return Err("ROBINHOOD_AUTHENTICATION_EXPIRED");
        }
        bundle = load(vault)?.ok_or("ROBINHOOD_AUTHENTICATION_EXPIRED")?;
        if bundle.expires_at <= unix_now() + 120.0 {
            return Err("ROBINHOOD_AUTHENTICATION_EXPIRED");
        }
    }
    Ok(Zeroizing::new(bundle.access_token.clone()))
}

#[tauri::command]
pub fn disconnect_robinhood(
    vault: tauri::State<'_, CredentialVault>,
) -> Result<bool, &'static str> {
    for key in [
        VaultKey::RobinhoodOAuthToken,
        VaultKey::RobinhoodRefreshToken,
        VaultKey::RobinhoodOAuthClientId,
    ] {
        if let Err(error) = vault.delete(key) {
            let no_entry = matches!(
                error,
                crate::vault::VaultError::Keyring(keyring::Error::NoEntry)
            );
            if !no_entry {
                return Err("ROBINHOOD_VAULT_UNAVAILABLE");
            }
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_url_safe_and_sha256_sized() {
        let (verifier, challenge) = generate_pkce();
        assert!(verifier.len() >= 43);
        assert_eq!(challenge.len(), 43);
        assert!(!challenge.contains('='));
    }

    #[test]
    fn browser_guard_rejects_non_robinhood_urls_before_opening() {
        assert_eq!(
            open_browser("https://example.com/not-robinhood"),
            Err("ROBINHOOD_CONNECTION_UNAVAILABLE")
        );
    }

    #[test]
    fn token_validation_rejects_whitespace_and_short_values() {
        assert!(validate_token("short").is_err());
        assert!(validate_token("this-token-is-long-enough but-has-space").is_err());
        assert!(validate_token("this-token-is-long-enough-and-clean").is_ok());
    }
}
