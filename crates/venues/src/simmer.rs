use std::str::FromStr;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::{Client, StatusCode, redirect::Policy};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use zeroize::Zeroizing;

const SIMMER_API_ORIGIN: &str = "https://api.simmer.markets";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SimmerConnectionState {
    ReadOnlyReady,
    ClaimRequired,
    TradingNotEnabled,
}

/// Privacy-safe owner-demo account summary. It deliberately excludes wallet
/// addresses, market names, position values, P&L, and all credential material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SimmerKalshiSnapshot {
    pub connection_state: SimmerConnectionState,
    pub authenticated: bool,
    pub wallet_configured: bool,
    pub active_position_count: usize,
    pub has_spendable_balance: bool,
    pub has_open_exposure: bool,
    pub warning_count: usize,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Error)]
pub enum SimmerClientError {
    #[error("Simmer credential is missing or malformed")]
    InvalidCredential,
    #[error("Simmer authentication failed")]
    AuthenticationFailed,
    #[error("Simmer account is not permitted to access this resource")]
    PermissionDenied,
    #[error("Simmer rate limit reached")]
    RateLimited,
    #[error("Simmer service returned an unexpected status")]
    UnexpectedStatus,
    #[error("Simmer service response exceeded the local safety limit")]
    ResponseTooLarge,
    #[error("Simmer service response was invalid")]
    InvalidResponse,
    #[error("Simmer service could not be reached")]
    Unavailable,
}

pub struct SimmerKalshiClient {
    http: Client,
    api_key: Zeroizing<String>,
}

impl SimmerKalshiClient {
    pub fn new(api_key: Zeroizing<String>) -> Result<Self, SimmerClientError> {
        let key = api_key.trim();
        if key.len() < 16 || !key.starts_with("sk_") || key.chars().any(char::is_whitespace) {
            return Err(SimmerClientError::InvalidCredential);
        }

        let http = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(12))
            .redirect(Policy::none())
            .user_agent("DayTradingBot/0.1 owner-demo")
            .build()
            .map_err(|_| SimmerClientError::Unavailable)?;

        Ok(Self { http, api_key })
    }

    /// Confirms the existing owner account and reads only privacy-safe Kalshi
    /// health facts. No market import, setting change, quote, or order endpoint
    /// is reachable from this method.
    pub async fn read_owner_snapshot(&self) -> Result<SimmerKalshiSnapshot, SimmerClientError> {
        let agent: AgentResponse = self.get_json("/api/sdk/agents/me", &[]).await?;
        let portfolio: PortfolioResponse = self
            .get_json("/api/sdk/portfolio", &[("venue", "kalshi")])
            .await?;
        let positions: PositionsResponse = self
            .get_json(
                "/api/sdk/positions",
                &[("venue", "kalshi"), ("status", "active")],
            )
            .await?;

        Ok(snapshot_from_responses(agent, portfolio, positions))
    }

    async fn get_json<T: DeserializeOwned>(
        &self,
        path: &'static str,
        query: &[(&str, &str)],
    ) -> Result<T, SimmerClientError> {
        let url = format!("{SIMMER_API_ORIGIN}{path}");
        let mut response = self
            .http
            .get(url)
            .bearer_auth(self.api_key.as_str())
            .query(query)
            .send()
            .await
            .map_err(|_| SimmerClientError::Unavailable)?;

        match response.status() {
            StatusCode::UNAUTHORIZED => return Err(SimmerClientError::AuthenticationFailed),
            StatusCode::FORBIDDEN => return Err(SimmerClientError::PermissionDenied),
            StatusCode::TOO_MANY_REQUESTS => return Err(SimmerClientError::RateLimited),
            status if !status.is_success() => return Err(SimmerClientError::UnexpectedStatus),
            _ => {}
        }

        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(SimmerClientError::ResponseTooLarge);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| SimmerClientError::Unavailable)?
        {
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(SimmerClientError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| SimmerClientError::InvalidResponse)
    }
}

#[derive(Deserialize)]
struct AgentResponse {
    claimed: bool,
    real_trading_enabled: bool,
    wallet_address: Option<String>,
    per_agent_wallet_address: Option<String>,
}

#[derive(Default, Deserialize)]
struct PortfolioResponse {
    kalshi: Option<PortfolioBucket>,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Default, Deserialize)]
struct PortfolioBucket {
    balance: Option<f64>,
    #[serde(default)]
    positions_count: usize,
    #[serde(default)]
    total_exposure: f64,
}

#[derive(Default, Deserialize)]
struct PositionsResponse {
    #[serde(default)]
    positions: Vec<serde_json::Value>,
}

fn snapshot_from_responses(
    agent: AgentResponse,
    portfolio: PortfolioResponse,
    positions: PositionsResponse,
) -> SimmerKalshiSnapshot {
    let bucket = portfolio.kalshi.unwrap_or_default();
    let position_count = bucket.positions_count.max(positions.positions.len());
    let balance = decimal_from_f64(bucket.balance.unwrap_or_default());
    let exposure = decimal_from_f64(bucket.total_exposure);
    let connection_state = if !agent.claimed {
        SimmerConnectionState::ClaimRequired
    } else if !agent.real_trading_enabled {
        SimmerConnectionState::TradingNotEnabled
    } else {
        SimmerConnectionState::ReadOnlyReady
    };

    SimmerKalshiSnapshot {
        connection_state,
        authenticated: true,
        wallet_configured: agent.wallet_address.is_some()
            || agent.per_agent_wallet_address.is_some(),
        active_position_count: position_count,
        has_spendable_balance: balance > Decimal::ZERO,
        has_open_exposure: exposure > Decimal::ZERO || position_count > 0,
        warning_count: portfolio.warnings.len(),
        observed_at: Utc::now(),
    }
}

fn decimal_from_f64(value: f64) -> Decimal {
    if !value.is_finite() {
        return Decimal::ZERO;
    }
    Decimal::from_str(&value.to_string()).unwrap_or(Decimal::ZERO)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_api_key_is_rejected_before_any_request() {
        let error = SimmerKalshiClient::new(Zeroizing::new("not-a-secret".to_owned()))
            .err()
            .expect("invalid key must fail");
        assert!(matches!(error, SimmerClientError::InvalidCredential));
    }

    #[test]
    fn owner_snapshot_is_redacted_and_uses_position_fallback() {
        let snapshot = snapshot_from_responses(
            AgentResponse {
                claimed: true,
                real_trading_enabled: true,
                wallet_address: Some("wallet-must-not-be-returned".into()),
                per_agent_wallet_address: None,
            },
            PortfolioResponse {
                kalshi: Some(PortfolioBucket {
                    balance: Some(5.12),
                    positions_count: 0,
                    total_exposure: 0.0,
                }),
                warnings: vec!["private upstream detail".into()],
            },
            PositionsResponse {
                positions: vec![serde_json::json!({}), serde_json::json!({})],
            },
        );

        assert_eq!(
            snapshot.connection_state,
            SimmerConnectionState::ReadOnlyReady
        );
        assert!(snapshot.wallet_configured);
        assert!(snapshot.has_spendable_balance);
        assert!(snapshot.has_open_exposure);
        assert_eq!(snapshot.active_position_count, 2);
        assert_eq!(snapshot.warning_count, 1);

        let serialized = serde_json::to_string(&snapshot).expect("snapshot serializes");
        assert!(!serialized.contains("wallet-must-not-be-returned"));
        assert!(!serialized.contains("private upstream detail"));
        assert!(!serialized.contains("5.12"));
    }

    #[test]
    fn unclaimed_account_stays_fail_closed() {
        let snapshot = snapshot_from_responses(
            AgentResponse {
                claimed: false,
                real_trading_enabled: false,
                wallet_address: None,
                per_agent_wallet_address: None,
            },
            PortfolioResponse::default(),
            PositionsResponse::default(),
        );

        assert_eq!(
            snapshot.connection_state,
            SimmerConnectionState::ClaimRequired
        );
        assert!(!snapshot.wallet_configured);
        assert!(!snapshot.has_spendable_balance);
        assert!(!snapshot.has_open_exposure);
    }
}
