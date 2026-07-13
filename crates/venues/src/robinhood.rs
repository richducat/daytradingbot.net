use std::str::FromStr;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::{Client, StatusCode, redirect::Policy};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

const ROBINHOOD_MCP_URL: &str = "https://agent.robinhood.com/mcp/trading";
const MAX_RESPONSE_BYTES: usize = 512 * 1024;

/// Privacy-safe proof of the owner's official Robinhood Agentic connection.
/// Account numbers, balances, positions, orders, and credential material never
/// leave the native backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RobinhoodOwnerSnapshot {
    pub authenticated: bool,
    pub agentic_account_available: bool,
    pub agentic_account_count: usize,
    pub has_buying_power: bool,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Error)]
pub enum RobinhoodMcpError {
    #[error("Robinhood OAuth credential is missing or malformed")]
    InvalidCredential,
    #[error("Robinhood Agentic authentication failed")]
    AuthenticationFailed,
    #[error("Robinhood Agentic account is not permitted to access this resource")]
    PermissionDenied,
    #[error("Robinhood Agentic rate limit reached")]
    RateLimited,
    #[error("Robinhood Agentic service returned an unexpected status")]
    UnexpectedStatus,
    #[error("Robinhood Agentic response exceeded the local safety limit")]
    ResponseTooLarge,
    #[error("Robinhood Agentic response was invalid")]
    InvalidResponse,
    #[error("Robinhood Agentic tool returned an error")]
    ToolError,
    #[error("Robinhood Agentic service could not be reached")]
    Unavailable,
}

/// Fixed-origin, read-only client for Robinhood's official Trading MCP. This
/// type intentionally exposes no quote, review, place, cancel, or transfer
/// method. Its only reachable tool calls are `get_accounts` and
/// `get_portfolio`.
pub struct RobinhoodAgenticClient {
    http: Client,
    access_token: Zeroizing<String>,
}

impl RobinhoodAgenticClient {
    pub fn new(access_token: Zeroizing<String>) -> Result<Self, RobinhoodMcpError> {
        let token = access_token.trim();
        if token.len() < 24 || token.chars().any(char::is_whitespace) {
            return Err(RobinhoodMcpError::InvalidCredential);
        }

        let http = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .redirect(Policy::none())
            .user_agent("DayTradingBot/0.1 robinhood-owner-proof")
            .build()
            .map_err(|_| RobinhoodMcpError::Unavailable)?;

        Ok(Self { http, access_token })
    }

    pub async fn read_owner_snapshot(&self) -> Result<RobinhoodOwnerSnapshot, RobinhoodMcpError> {
        let (initialize, session_id) = self
            .post_rpc(
                &json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": {
                            "name": "daytradingbot-owner-proof",
                            "version": "0.1"
                        }
                    }
                }),
                None,
                true,
            )
            .await?;
        if initialize
            .pointer("/result/protocolVersion")
            .and_then(Value::as_str)
            != Some("2025-03-26")
        {
            return Err(RobinhoodMcpError::InvalidResponse);
        }
        let session_id = session_id.ok_or(RobinhoodMcpError::InvalidResponse)?;

        self.post_notification(
            &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            Some(session_id.as_str()),
        )
        .await?;

        let (response, _) = self
            .post_rpc(
                &json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": "get_accounts", "arguments": {}}
                }),
                Some(session_id.as_str()),
                false,
            )
            .await?;
        let accounts = accounts_from_tool_response(&response)?;
        let mut has_buying_power = false;
        let mut request_id = 3_u64;
        for account in accounts.iter().filter(|account| account.agentic_allowed) {
            let (portfolio_response, _) = self
                .post_rpc(
                    &json!({
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "method": "tools/call",
                        "params": {
                            "name": "get_portfolio",
                            "arguments": {"account_number": account.account_number.as_str()}
                        }
                    }),
                    Some(session_id.as_str()),
                    false,
                )
                .await?;
            has_buying_power |= buying_power_from_tool_response(&portfolio_response)?;
            request_id = request_id.saturating_add(1);
        }
        Ok(snapshot_from_accounts(&accounts, has_buying_power))
    }

    async fn post_rpc(
        &self,
        payload: &Value,
        session_id: Option<&str>,
        capture_session: bool,
    ) -> Result<(Value, Option<String>), RobinhoodMcpError> {
        let mut request = self
            .http
            .post(ROBINHOOD_MCP_URL)
            .bearer_auth(self.access_token.as_str())
            .header("Accept", "application/json, text/event-stream")
            .json(payload);
        if let Some(session_id) = session_id {
            request = request.header("Mcp-Session-Id", session_id);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| RobinhoodMcpError::Unavailable)?;
        validate_status(response.status())?;
        let returned_session = capture_session
            .then(|| {
                response
                    .headers()
                    .get("Mcp-Session-Id")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            })
            .flatten();
        let body = read_bounded_body(&mut response).await?;
        let expected_id = payload
            .get("id")
            .and_then(Value::as_u64)
            .ok_or(RobinhoodMcpError::InvalidResponse)?;
        let value = parse_mcp_payload(&body, expected_id)?;
        validate_rpc_response(&value, expected_id)?;
        Ok((value, returned_session))
    }

    async fn post_notification(
        &self,
        payload: &Value,
        session_id: Option<&str>,
    ) -> Result<(), RobinhoodMcpError> {
        let mut request = self
            .http
            .post(ROBINHOOD_MCP_URL)
            .bearer_auth(self.access_token.as_str())
            .header("Accept", "application/json, text/event-stream")
            .json(payload);
        if let Some(session_id) = session_id {
            request = request.header("Mcp-Session-Id", session_id);
        }
        let response = request
            .send()
            .await
            .map_err(|_| RobinhoodMcpError::Unavailable)?;
        validate_status(response.status())
    }
}

#[derive(Deserialize)]
struct AccountToolPayload {
    data: AccountData,
}

#[derive(Deserialize)]
struct AccountData {
    #[serde(default)]
    accounts: Vec<RobinhoodAccount>,
}

#[derive(Deserialize)]
struct RobinhoodAccount {
    account_number: String,
    #[serde(default)]
    agentic_allowed: bool,
}

impl Drop for RobinhoodAccount {
    fn drop(&mut self) {
        self.account_number.zeroize();
    }
}

#[derive(Debug, Deserialize)]
struct PortfolioToolPayload {
    data: PortfolioData,
}

#[derive(Debug, Default, Deserialize)]
struct PortfolioData {
    buying_power: Option<BuyingPower>,
}

#[derive(Debug, Default, Deserialize)]
struct BuyingPower {
    buying_power: Option<Value>,
    unleveraged_buying_power: Option<Value>,
}

fn accounts_from_tool_response(
    response: &Value,
) -> Result<Vec<RobinhoodAccount>, RobinhoodMcpError> {
    let result = tool_result(response)?;
    if let Some(structured) = result.get("structuredContent") {
        let payload: AccountToolPayload = serde_json::from_value(structured.clone())
            .map_err(|_| RobinhoodMcpError::InvalidResponse)?;
        return Ok(payload.data.accounts);
    }
    let text = text_from_tool_response(response)?;
    let payload: AccountToolPayload =
        serde_json::from_str(text).map_err(|_| RobinhoodMcpError::InvalidResponse)?;
    Ok(payload.data.accounts)
}

fn buying_power_from_tool_response(response: &Value) -> Result<bool, RobinhoodMcpError> {
    let result = tool_result(response)?;
    let payload: PortfolioToolPayload = if let Some(structured) = result.get("structuredContent") {
        serde_json::from_value(structured.clone())
            .map_err(|_| RobinhoodMcpError::InvalidResponse)?
    } else {
        let text = text_from_tool_response(response)?;
        serde_json::from_str(text).map_err(|_| RobinhoodMcpError::InvalidResponse)?
    };
    let buying_power = payload.data.buying_power.unwrap_or_default();
    Ok([
        buying_power.buying_power.as_ref(),
        buying_power.unleveraged_buying_power.as_ref(),
    ]
    .into_iter()
    .flatten()
    .filter_map(decimal_from_value)
    .any(|value| value > Decimal::ZERO))
}

fn tool_result(response: &Value) -> Result<&serde_json::Map<String, Value>, RobinhoodMcpError> {
    if response.get("error").is_some() {
        return Err(RobinhoodMcpError::ToolError);
    }
    let result = response
        .get("result")
        .and_then(Value::as_object)
        .ok_or(RobinhoodMcpError::InvalidResponse)?;
    if result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(RobinhoodMcpError::ToolError);
    }
    Ok(result)
}

fn text_from_tool_response(response: &Value) -> Result<&str, RobinhoodMcpError> {
    let result = tool_result(response)?;
    result
        .get("content")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|item| {
                (item.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| item.get("text").and_then(Value::as_str))
                    .flatten()
            })
        })
        .ok_or(RobinhoodMcpError::InvalidResponse)
}

fn snapshot_from_accounts(
    accounts: &[RobinhoodAccount],
    has_buying_power: bool,
) -> RobinhoodOwnerSnapshot {
    let agentic_accounts: Vec<_> = accounts
        .iter()
        .filter(|account| account.agentic_allowed)
        .collect();
    RobinhoodOwnerSnapshot {
        authenticated: true,
        agentic_account_available: !agentic_accounts.is_empty(),
        agentic_account_count: agentic_accounts.len(),
        has_buying_power: !agentic_accounts.is_empty() && has_buying_power,
        observed_at: Utc::now(),
    }
}

fn decimal_from_value(value: &Value) -> Option<Decimal> {
    match value {
        Value::String(value) => Decimal::from_str(value).ok(),
        Value::Number(value) => Decimal::from_str(&value.to_string()).ok(),
        _ => None,
    }
}

fn validate_status(status: StatusCode) -> Result<(), RobinhoodMcpError> {
    match status {
        StatusCode::UNAUTHORIZED => Err(RobinhoodMcpError::AuthenticationFailed),
        StatusCode::FORBIDDEN => Err(RobinhoodMcpError::PermissionDenied),
        StatusCode::TOO_MANY_REQUESTS => Err(RobinhoodMcpError::RateLimited),
        status if !status.is_success() => Err(RobinhoodMcpError::UnexpectedStatus),
        _ => Ok(()),
    }
}

fn validate_rpc_response(response: &Value, expected_id: u64) -> Result<(), RobinhoodMcpError> {
    let has_result = response.get("result").is_some();
    let has_error = response.get("error").is_some();
    if response.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || response.get("id").and_then(Value::as_u64) != Some(expected_id)
        || has_result == has_error
    {
        return Err(RobinhoodMcpError::InvalidResponse);
    }
    Ok(())
}

async fn read_bounded_body(
    response: &mut reqwest::Response,
) -> Result<Zeroizing<Vec<u8>>, RobinhoodMcpError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(RobinhoodMcpError::ResponseTooLarge);
    }
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| RobinhoodMcpError::Unavailable)?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(RobinhoodMcpError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn parse_mcp_payload(body: &[u8], expected_id: u64) -> Result<Value, RobinhoodMcpError> {
    let text = std::str::from_utf8(body).map_err(|_| RobinhoodMcpError::InvalidResponse)?;
    for line in text.lines() {
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim_start();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(data)
                && value.get("id").and_then(Value::as_u64) == Some(expected_id)
            {
                return Ok(value);
            }
        }
    }
    let value: Value =
        serde_json::from_str(text).map_err(|_| RobinhoodMcpError::InvalidResponse)?;
    if value.get("id").and_then(Value::as_u64) != Some(expected_id) {
        return Err(RobinhoodMcpError::InvalidResponse);
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_oauth_token_is_rejected_before_any_request() {
        let error = RobinhoodAgenticClient::new(Zeroizing::new("short token".to_owned()))
            .err()
            .expect("invalid token must fail");
        assert!(matches!(error, RobinhoodMcpError::InvalidCredential));
    }

    #[test]
    fn parses_sse_tool_response_and_keeps_only_redacted_account_facts() {
        let raw = br#"event: message
data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"data\":{\"accounts\":[{\"account_number\":\"must-not-escape\",\"agentic_allowed\":true,\"buying_power\":\"12.34\"},{\"account_number\":\"primary-must-not-escape\",\"agentic_allowed\":false,\"buying_power\":\"999.00\"}]}}"}],"isError":false}}

"#;
        let value = parse_mcp_payload(raw, 2).expect("valid SSE payload");
        validate_rpc_response(&value, 2).expect("matching JSON-RPC response");
        let accounts = accounts_from_tool_response(&value).expect("valid account tool result");
        let snapshot = snapshot_from_accounts(&accounts, true);
        assert!(snapshot.authenticated);
        assert!(snapshot.agentic_account_available);
        assert_eq!(snapshot.agentic_account_count, 1);
        assert!(snapshot.has_buying_power);
        let serialized = serde_json::to_string(&snapshot).expect("serialize redacted snapshot");
        assert!(!serialized.contains("must-not-escape"));
        assert!(!serialized.contains("12.34"));
        assert!(!serialized.contains("999.00"));
    }

    #[test]
    fn primary_account_never_counts_as_agentic_or_funded() {
        let snapshot = snapshot_from_accounts(
            &[RobinhoodAccount {
                account_number: "primary-must-not-escape".to_owned(),
                agentic_allowed: false,
            }],
            true,
        );
        assert!(!snapshot.agentic_account_available);
        assert_eq!(snapshot.agentic_account_count, 0);
        assert!(!snapshot.has_buying_power);
    }

    #[test]
    fn portfolio_buying_power_is_read_only_and_redacted() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "result": {
                "content": [{
                    "type": "text",
                    "text": "{\"data\":{\"buying_power\":{\"buying_power\":\"25.00\",\"display_currency\":\"USD\"}}}"
                }],
                "isError": false
            }
        });
        assert!(buying_power_from_tool_response(&response).expect("valid portfolio"));
    }

    #[test]
    fn tool_errors_fail_closed() {
        let error = match accounts_from_tool_response(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {"isError": true, "content": []}
        })) {
            Err(error) => error,
            Ok(_) => panic!("tool error must not become a ready connection"),
        };
        assert!(matches!(error, RobinhoodMcpError::ToolError));
    }

    #[test]
    fn mismatched_rpc_id_fails_closed() {
        let error = validate_rpc_response(&json!({"jsonrpc": "2.0", "id": 999, "result": {}}), 2)
            .expect_err("response for another request must fail");
        assert!(matches!(error, RobinhoodMcpError::InvalidResponse));
    }

    #[test]
    fn rpc_result_and_error_together_fail_closed() {
        let error = validate_rpc_response(
            &json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {},
                "error": {"code": -32000, "message": "ambiguous"}
            }),
            2,
        )
        .expect_err("ambiguous response must fail");
        assert!(matches!(error, RobinhoodMcpError::InvalidResponse));
    }
}
