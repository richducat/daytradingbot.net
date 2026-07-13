use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use reqwest::{Client, Response, StatusCode, redirect::Policy};
use ring::signature::Ed25519KeyPair;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const POLYMARKET_US_API_ORIGIN: &str = "https://api.polymarket.us";
const POLYMARKET_US_PUBLIC_ORIGIN: &str = "https://gateway.polymarket.us";
const BALANCES_PATH: &str = "/v1/account/balances";
const PUBLIC_MARKETS_PATH: &str = "/v1/markets?limit=1";
const MAX_RESPONSE_BYTES: usize = 512 * 1024;

/// Privacy-safe proof of an owner's separate Polymarket US retail connection.
/// The international CLOB and Polygon wallet credentials are intentionally not
/// supported by this client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PolymarketUsOwnerSnapshot {
    pub authenticated: bool,
    pub balance_account_count: usize,
    pub has_buying_power: bool,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PolymarketUsPublicSnapshot {
    pub market_data_available: bool,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Error)]
pub enum PolymarketUsError {
    #[error("Polymarket US credential is missing or malformed")]
    InvalidCredential,
    #[error("Polymarket US authentication failed")]
    AuthenticationFailed,
    #[error("Polymarket US account is not approved for this resource")]
    PermissionDenied,
    #[error("Polymarket US rate limit reached")]
    RateLimited,
    #[error("Polymarket US returned an unexpected status")]
    UnexpectedStatus,
    #[error("Polymarket US response exceeded the local safety limit")]
    ResponseTooLarge,
    #[error("Polymarket US response was invalid")]
    InvalidResponse,
    #[error("Polymarket US could not be reached")]
    Unavailable,
}

/// Fixed-origin, read-only public client. It proves that the US market-data
/// gateway is reachable but cannot authenticate or trade.
pub struct PolymarketUsPublicClient {
    http: Client,
}

impl PolymarketUsPublicClient {
    pub fn new() -> Result<Self, PolymarketUsError> {
        Ok(Self {
            http: build_http("polymarket-us-public-proof")?,
        })
    }

    pub async fn read_market_data_snapshot(
        &self,
    ) -> Result<PolymarketUsPublicSnapshot, PolymarketUsError> {
        let response = self
            .http
            .get(format!(
                "{POLYMARKET_US_PUBLIC_ORIGIN}{PUBLIC_MARKETS_PATH}"
            ))
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| PolymarketUsError::Unavailable)?;
        validate_status(response.status())?;
        let body = read_bounded_body(response).await?;
        let value: Value =
            serde_json::from_slice(&body).map_err(|_| PolymarketUsError::InvalidResponse)?;
        let market_data_available = value.as_object().is_some_and(|object| {
            object.contains_key("markets")
                || object.contains_key("data")
                || object.contains_key("results")
        });
        if !market_data_available {
            return Err(PolymarketUsError::InvalidResponse);
        }
        Ok(PolymarketUsPublicSnapshot {
            market_data_available,
            observed_at: Utc::now(),
        })
    }
}

/// Fixed-origin, read-only client for the Polymarket US retail API. It exposes
/// only the account-balances read needed to prove authentication and buying
/// power. It has no order, preview, cancel, withdrawal, or generic request API.
pub struct PolymarketUsRetailClient {
    http: Client,
    key_id: Zeroizing<String>,
    secret_key: Zeroizing<Vec<u8>>,
}

impl PolymarketUsRetailClient {
    pub fn new(
        key_id: Zeroizing<String>,
        secret_key_base64: Zeroizing<String>,
    ) -> Result<Self, PolymarketUsError> {
        validate_key_id(&key_id)?;
        let mut decoded = STANDARD
            .decode(secret_key_base64.as_bytes())
            .map_err(|_| PolymarketUsError::InvalidCredential)?;
        if decoded.len() < 32 {
            decoded.zeroize();
            return Err(PolymarketUsError::InvalidCredential);
        }
        decoded.truncate(32);
        Ed25519KeyPair::from_seed_unchecked(&decoded)
            .map_err(|_| PolymarketUsError::InvalidCredential)?;

        Ok(Self {
            http: build_http("polymarket-us-owner-proof")?,
            key_id,
            secret_key: Zeroizing::new(decoded),
        })
    }

    pub async fn read_owner_snapshot(
        &self,
    ) -> Result<PolymarketUsOwnerSnapshot, PolymarketUsError> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| PolymarketUsError::InvalidCredential)?
            .as_millis()
            .to_string();
        let message = Zeroizing::new(format!("{timestamp}GET{BALANCES_PATH}"));
        let signer = Ed25519KeyPair::from_seed_unchecked(&self.secret_key)
            .map_err(|_| PolymarketUsError::InvalidCredential)?;
        let signature = Zeroizing::new(STANDARD.encode(signer.sign(message.as_bytes()).as_ref()));
        let response = self
            .http
            .get(format!("{POLYMARKET_US_API_ORIGIN}{BALANCES_PATH}"))
            .header("Accept", "application/json")
            .header("X-PM-Access-Key", self.key_id.as_str())
            .header("X-PM-Timestamp", timestamp)
            .header("X-PM-Signature", signature.as_str())
            .send()
            .await
            .map_err(|_| PolymarketUsError::Unavailable)?;
        validate_status(response.status())?;
        let body = read_bounded_body(response).await?;
        let balances: AccountBalances =
            serde_json::from_slice(&body).map_err(|_| PolymarketUsError::InvalidResponse)?;

        Ok(PolymarketUsOwnerSnapshot {
            authenticated: true,
            balance_account_count: balances.balances.len(),
            has_buying_power: balances
                .balances
                .iter()
                .filter_map(|balance| decimal_from_value(&balance.buying_power))
                .any(|value| value > Decimal::ZERO),
            observed_at: Utc::now(),
        })
    }
}

#[derive(Debug, Deserialize)]
struct AccountBalances {
    #[serde(default)]
    balances: Vec<AccountBalance>,
}

#[derive(Debug, Deserialize)]
struct AccountBalance {
    #[serde(rename = "buyingPower", default)]
    buying_power: Value,
}

fn build_http(user_agent_suffix: &'static str) -> Result<Client, PolymarketUsError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(Policy::none())
        .user_agent(format!("DayTradingBot/0.1 {user_agent_suffix}"))
        .build()
        .map_err(|_| PolymarketUsError::Unavailable)
}

fn validate_key_id(key_id: &str) -> Result<(), PolymarketUsError> {
    let parsed = Uuid::parse_str(key_id).map_err(|_| PolymarketUsError::InvalidCredential)?;
    (parsed.to_string() == key_id.to_ascii_lowercase())
        .then_some(())
        .ok_or(PolymarketUsError::InvalidCredential)
}

fn decimal_from_value(value: &Value) -> Option<Decimal> {
    match value {
        Value::String(value) => Decimal::from_str(value).ok(),
        Value::Number(value) => Decimal::from_str(&value.to_string()).ok(),
        _ => None,
    }
}

fn validate_status(status: StatusCode) -> Result<(), PolymarketUsError> {
    match status {
        StatusCode::OK => Ok(()),
        StatusCode::UNAUTHORIZED => Err(PolymarketUsError::AuthenticationFailed),
        StatusCode::FORBIDDEN => Err(PolymarketUsError::PermissionDenied),
        StatusCode::TOO_MANY_REQUESTS => Err(PolymarketUsError::RateLimited),
        status if status.is_server_error() => Err(PolymarketUsError::Unavailable),
        _ => Err(PolymarketUsError::UnexpectedStatus),
    }
}

async fn read_bounded_body(mut response: Response) -> Result<Vec<u8>, PolymarketUsError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(PolymarketUsError::ResponseTooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| PolymarketUsError::Unavailable)?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(PolymarketUsError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retail_key_id_must_be_a_uuid() {
        assert!(validate_key_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_key_id("international-clob-key").is_err());
    }

    #[test]
    fn buying_power_accepts_string_or_number_without_exposing_value() {
        assert_eq!(
            decimal_from_value(&Value::String("1.25".to_owned())),
            Some(Decimal::new(125, 2))
        );
        assert_eq!(
            decimal_from_value(&serde_json::json!(2.5)),
            Some(Decimal::new(25, 1))
        );
    }

    #[test]
    fn public_and_private_origins_are_fixed_to_polymarket_us() {
        assert_eq!(POLYMARKET_US_API_ORIGIN, "https://api.polymarket.us");
        assert_eq!(POLYMARKET_US_PUBLIC_ORIGIN, "https://gateway.polymarket.us");
    }
}
