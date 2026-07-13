use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use p256::SecretKey;
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use p256::elliptic_curve::pkcs8::DecodePrivateKey;
use reqwest::{Client, Response, StatusCode, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroizing;

const COINBASE_API_ORIGIN: &str = "https://api.coinbase.com";
const COINBASE_API_HOST: &str = "api.coinbase.com";
const PERMISSIONS_PATH: &str = "/api/v3/brokerage/key_permissions";
const ACCOUNTS_PATH: &str = "/api/v3/brokerage/accounts";
const MAX_RESPONSE_BYTES: usize = 512 * 1024;

/// Privacy-safe proof of an owner's Coinbase Advanced Trade connection.
/// Account identifiers, asset quantities, balances, orders, fills, and the
/// portfolio UUID never leave the native backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CoinbaseOwnerSnapshot {
    pub authenticated: bool,
    pub can_view: bool,
    pub can_trade: bool,
    pub can_transfer: bool,
    pub can_receive: bool,
    pub account_count: usize,
    pub more_accounts_available: bool,
    pub has_btc_or_eth_account: bool,
    pub least_privilege_live_scope: bool,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Error)]
pub enum CoinbaseError {
    #[error("Coinbase CDP credential is missing or malformed")]
    InvalidCredential,
    #[error("Coinbase authentication failed")]
    AuthenticationFailed,
    #[error("Coinbase denied access to the requested portfolio")]
    PermissionDenied,
    #[error("Coinbase rate limit reached")]
    RateLimited,
    #[error("Coinbase returned an unexpected status")]
    UnexpectedStatus,
    #[error("Coinbase response exceeded the local safety limit")]
    ResponseTooLarge,
    #[error("Coinbase response was invalid")]
    InvalidResponse,
    #[error("Coinbase could not be reached")]
    Unavailable,
}

/// Fixed-origin, read-only client for Coinbase Advanced Trade. This type
/// intentionally exposes no preview, order, cancel, convert, transfer, wallet,
/// or generic request method. It can read only key permissions and the first
/// account page needed to prove that the portfolio is reachable.
pub struct CoinbaseAdvancedTradeClient {
    http: Client,
    key_name: Zeroizing<String>,
    private_key_pem: Zeroizing<String>,
}

impl CoinbaseAdvancedTradeClient {
    pub fn new(
        key_name: Zeroizing<String>,
        private_key_pem: Zeroizing<String>,
    ) -> Result<Self, CoinbaseError> {
        validate_key_name(&key_name)?;
        parse_signing_key(&private_key_pem)?;

        let http = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .redirect(Policy::none())
            .user_agent("DayTradingBot/0.1 coinbase-owner-proof")
            .build()
            .map_err(|_| CoinbaseError::Unavailable)?;

        Ok(Self {
            http,
            key_name,
            private_key_pem,
        })
    }

    pub async fn read_owner_snapshot(&self) -> Result<CoinbaseOwnerSnapshot, CoinbaseError> {
        let permissions: KeyPermissions = self.get_json(PERMISSIONS_PATH).await?;
        if !permissions.can_view {
            return Err(CoinbaseError::PermissionDenied);
        }
        let accounts: AccountsResponse = self.get_json(ACCOUNTS_PATH).await?;
        let has_btc_or_eth_account = accounts.accounts.iter().any(|account| {
            account.active && account.ready && matches!(account.currency.as_str(), "BTC" | "ETH")
        });
        let least_privilege_live_scope = permissions.can_view
            && permissions.can_trade
            && !permissions.can_transfer
            && !permissions.can_receive;

        Ok(CoinbaseOwnerSnapshot {
            authenticated: true,
            can_view: permissions.can_view,
            can_trade: permissions.can_trade,
            can_transfer: permissions.can_transfer,
            can_receive: permissions.can_receive,
            account_count: accounts.accounts.len(),
            more_accounts_available: accounts.has_next,
            has_btc_or_eth_account,
            least_privilege_live_scope,
            observed_at: Utc::now(),
        })
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &'static str,
    ) -> Result<T, CoinbaseError> {
        let jwt = self.jwt_for_request("GET", path)?;
        let response = self
            .http
            .get(format!("{COINBASE_API_ORIGIN}{path}"))
            .bearer_auth(jwt.as_str())
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| CoinbaseError::Unavailable)?;
        validate_status(response.status())?;
        let body = read_bounded_body(response).await?;
        serde_json::from_slice(&body).map_err(|_| CoinbaseError::InvalidResponse)
    }

    fn jwt_for_request(
        &self,
        method: &'static str,
        path: &'static str,
    ) -> Result<Zeroizing<String>, CoinbaseError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| CoinbaseError::InvalidCredential)?
            .as_secs();
        let header = JwtHeader {
            alg: "ES256",
            typ: "JWT",
            kid: self.key_name.as_str(),
            nonce: Uuid::new_v4().simple().to_string(),
        };
        let claims = JwtClaims {
            sub: self.key_name.as_str(),
            iss: "cdp",
            nbf: now,
            exp: now.saturating_add(120),
            uri: format!("{method} {COINBASE_API_HOST}{path}"),
        };
        let header = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&header).map_err(|_| CoinbaseError::InvalidCredential)?);
        let claims = URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&claims).map_err(|_| CoinbaseError::InvalidCredential)?);
        let signing_input = Zeroizing::new(format!("{header}.{claims}"));
        let signing_key = parse_signing_key(&self.private_key_pem)?;
        let signature: Signature = signing_key.sign(signing_input.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        Ok(Zeroizing::new(format!(
            "{}.{}",
            signing_input.as_str(),
            signature
        )))
    }
}

#[derive(Serialize)]
struct JwtHeader<'a> {
    alg: &'static str,
    typ: &'static str,
    kid: &'a str,
    nonce: String,
}

#[derive(Serialize)]
struct JwtClaims<'a> {
    sub: &'a str,
    iss: &'static str,
    nbf: u64,
    exp: u64,
    uri: String,
}

#[derive(Debug, Deserialize)]
struct KeyPermissions {
    #[serde(default)]
    can_view: bool,
    #[serde(default)]
    can_trade: bool,
    #[serde(default)]
    can_transfer: bool,
    #[serde(default)]
    can_receive: bool,
    // Coinbase also returns a portfolio UUID. It is deliberately not parsed or
    // retained by this privacy-safe proof client.
    #[serde(flatten)]
    _ignored: std::collections::HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
struct AccountsResponse {
    #[serde(default)]
    accounts: Vec<CoinbaseAccount>,
    #[serde(default)]
    has_next: bool,
}

#[derive(Debug, Deserialize)]
struct CoinbaseAccount {
    #[serde(default)]
    currency: String,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    ready: bool,
}

fn validate_key_name(key_name: &str) -> Result<(), CoinbaseError> {
    let valid = key_name.starts_with("organizations/")
        && key_name.contains("/apiKeys/")
        && (24..=256).contains(&key_name.len())
        && !key_name.chars().any(char::is_whitespace);
    valid.then_some(()).ok_or(CoinbaseError::InvalidCredential)
}

fn parse_signing_key(private_key_pem: &str) -> Result<SigningKey, CoinbaseError> {
    let secret = SecretKey::from_sec1_pem(private_key_pem)
        .or_else(|_| SecretKey::from_pkcs8_pem(private_key_pem))
        .map_err(|_| CoinbaseError::InvalidCredential)?;
    Ok(SigningKey::from(secret))
}

fn validate_status(status: StatusCode) -> Result<(), CoinbaseError> {
    match status {
        StatusCode::OK => Ok(()),
        StatusCode::UNAUTHORIZED => Err(CoinbaseError::AuthenticationFailed),
        StatusCode::FORBIDDEN => Err(CoinbaseError::PermissionDenied),
        StatusCode::TOO_MANY_REQUESTS => Err(CoinbaseError::RateLimited),
        status if status.is_server_error() => Err(CoinbaseError::Unavailable),
        _ => Err(CoinbaseError::UnexpectedStatus),
    }
}

async fn read_bounded_body(mut response: Response) -> Result<Vec<u8>, CoinbaseError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(CoinbaseError::ResponseTooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| CoinbaseError::Unavailable)?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(CoinbaseError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_name_must_be_a_fixed_cdp_resource_name() {
        assert!(validate_key_name("organizations/org-123/apiKeys/key-456").is_ok());
        assert!(validate_key_name("plain-api-key").is_err());
        assert!(validate_key_name("organizations/org/apiKeys/key\nInjected").is_err());
    }

    #[test]
    fn only_view_and_trade_is_the_live_scope() {
        let permissions = KeyPermissions {
            can_view: true,
            can_trade: true,
            can_transfer: false,
            can_receive: false,
            _ignored: Default::default(),
        };
        assert!(
            permissions.can_view
                && permissions.can_trade
                && !permissions.can_transfer
                && !permissions.can_receive
        );
    }
}
