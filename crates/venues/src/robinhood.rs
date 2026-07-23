use std::str::FromStr;
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::{Client, StatusCode, redirect::Policy};
use rust_decimal::Decimal;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;
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

/// A privacy-safe market quote used by product-owned trading agents. Broker
/// account identifiers and raw provider payloads never cross this boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RobinhoodEquityQuote {
    pub symbol: String,
    pub last_trade_price: Decimal,
    pub previous_close: Decimal,
    pub venue_last_trade_time: DateTime<Utc>,
}

impl RobinhoodEquityQuote {
    #[must_use]
    pub fn change_percent(&self) -> Decimal {
        if self.previous_close <= Decimal::ZERO {
            return Decimal::ZERO;
        }
        ((self.last_trade_price - self.previous_close) / self.previous_close)
            * Decimal::from(100_u8)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RobinhoodEquityPosition {
    pub symbol: String,
    pub quantity: Decimal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RobinhoodEquityOrderState {
    Pending,
    PartiallyFilled,
    Filled,
    Canceled,
    Rejected,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RobinhoodExecution {
    pub execution_id: String,
    pub quantity: Decimal,
    pub price: Decimal,
    pub fee: Decimal,
    pub executed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RobinhoodEquityOrder {
    pub order_id: String,
    pub symbol: String,
    pub state: RobinhoodEquityOrderState,
    pub executions: Vec<RobinhoodExecution>,
}

/// A successful broker-side review. Private fields make it impossible for a
/// caller to fabricate or edit the reviewed order before placement.
pub struct ReviewedRobinhoodMarketBuy {
    account_number: Zeroizing<String>,
    symbol: String,
    dollar_amount: Decimal,
    pub quote: RobinhoodEquityQuote,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RobinhoodPlacement {
    pub order_id: String,
    pub state: RobinhoodEquityOrderState,
}

#[derive(Debug, Error)]
pub enum RobinhoodPlacementError {
    #[error("Robinhood rejected the order before accepting it")]
    Rejected,
    #[error("Robinhood may have accepted the order; reconcile before any retry")]
    Unknown,
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
    #[error("exactly one dedicated Robinhood Agentic account is required")]
    AmbiguousAgenticAccounts,
    #[error("Robinhood order input is invalid")]
    InvalidOrder,
}

/// Fixed-origin client for Robinhood's official Trading MCP. Only the typed,
/// product-owned operations below are exposed; there is deliberately no
/// generic tool-name or arbitrary-arguments method and no transfer surface.
pub struct RobinhoodAgenticClient {
    http: Client,
    access_token: Zeroizing<String>,
}

/// One initialized official MCP session bound to exactly one dedicated
/// `agentic_allowed` account. The account number remains native-only and is
/// zeroized when the session ends.
pub struct RobinhoodTradingSession<'a> {
    client: &'a RobinhoodAgenticClient,
    session_id: String,
    next_request_id: u64,
    account_number: Zeroizing<String>,
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

    /// Opens a native trading session only when Robinhood returns exactly one
    /// dedicated Agentic account. This is the only account-selection case that
    /// is unambiguous without showing account identifiers to the webview.
    pub async fn trading_session(&self) -> Result<RobinhoodTradingSession<'_>, RobinhoodMcpError> {
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
                            "name": "daytradingbot-native-agent",
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
        let allowed: Vec<_> = accounts
            .iter()
            .filter(|account| account.agentic_allowed)
            .collect();
        if allowed.len() != 1 {
            return Err(RobinhoodMcpError::AmbiguousAgenticAccounts);
        }
        let account_number = Zeroizing::new(allowed[0].account_number.clone());
        Ok(RobinhoodTradingSession {
            client: self,
            session_id,
            next_request_id: 3,
            account_number,
        })
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

impl RobinhoodTradingSession<'_> {
    async fn call_tool(
        &mut self,
        name: &'static str,
        arguments: Value,
    ) -> Result<Value, RobinhoodMcpError> {
        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.saturating_add(1);
        let (response, _) = self
            .client
            .post_rpc(
                &json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments}
                }),
                Some(self.session_id.as_str()),
                false,
            )
            .await?;
        Ok(response)
    }

    pub async fn buying_power(&mut self) -> Result<Decimal, RobinhoodMcpError> {
        let account_number = self.account_number.to_string();
        let response = self
            .call_tool("get_portfolio", json!({"account_number": account_number}))
            .await?;
        buying_power_decimal_from_tool_response(&response)
    }

    pub async fn equity_quotes(
        &mut self,
        symbols: &[&str],
    ) -> Result<Vec<RobinhoodEquityQuote>, RobinhoodMcpError> {
        let symbols = validate_symbols(symbols)?;
        let response = self
            .call_tool("get_equity_quotes", json!({"symbols": symbols}))
            .await?;
        quotes_from_tool_response(&response)
    }

    pub async fn equity_positions(
        &mut self,
    ) -> Result<Vec<RobinhoodEquityPosition>, RobinhoodMcpError> {
        let account_number = self.account_number.to_string();
        let response = self
            .call_tool(
                "get_equity_positions",
                json!({"account_number": account_number}),
            )
            .await?;
        positions_from_tool_response(&response)
    }

    pub async fn recent_agentic_orders(
        &mut self,
        created_at_gte: DateTime<Utc>,
    ) -> Result<Vec<RobinhoodEquityOrder>, RobinhoodMcpError> {
        let account_number = self.account_number.to_string();
        let response = self
            .call_tool(
                "get_equity_orders",
                json!({
                    "account_number": account_number,
                    "created_at_gte": created_at_gte.to_rfc3339(),
                    "placed_agent": "agentic"
                }),
            )
            .await?;
        orders_from_tool_response(&response)
    }

    pub async fn equity_order(
        &mut self,
        order_id: &str,
    ) -> Result<Option<RobinhoodEquityOrder>, RobinhoodMcpError> {
        validate_order_id(order_id)?;
        let account_number = self.account_number.to_string();
        let response = self
            .call_tool(
                "get_equity_orders",
                json!({"account_number": account_number, "order_id": order_id}),
            )
            .await?;
        Ok(orders_from_tool_response(&response)?.into_iter().next())
    }

    pub async fn review_market_buy(
        &mut self,
        symbol: &str,
        dollar_amount: Decimal,
    ) -> Result<ReviewedRobinhoodMarketBuy, RobinhoodMcpError> {
        let symbol = validate_symbol(symbol)?;
        validate_dollar_amount(dollar_amount)?;
        let amount = format_money(dollar_amount);
        let account_number = self.account_number.to_string();
        let response = self
            .call_tool(
                "review_equity_order",
                json!({
                    "account_number": account_number,
                    "symbol": symbol,
                    "side": "buy",
                    "type": "market",
                    "dollar_amount": amount,
                    "time_in_force": "gfd",
                    "market_hours": "regular_hours"
                }),
            )
            .await?;
        let quote = reviewed_quote_from_tool_response(&response, &symbol, dollar_amount)?;
        Ok(ReviewedRobinhoodMarketBuy {
            account_number: Zeroizing::new(self.account_number.to_string()),
            symbol,
            dollar_amount,
            quote,
        })
    }

    /// Places exactly the immutable order returned by `review_market_buy`.
    /// Ambiguous transport or parsing failures are returned as `Unknown`; the
    /// caller must quarantine and reconcile the durable intent, never retry it.
    pub async fn place_reviewed_market_buy(
        &mut self,
        reviewed: ReviewedRobinhoodMarketBuy,
        ref_id: Uuid,
    ) -> Result<RobinhoodPlacement, RobinhoodPlacementError> {
        if reviewed.account_number.as_str() != self.account_number.as_str() {
            return Err(RobinhoodPlacementError::Rejected);
        }
        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.saturating_add(1);
        let payload = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {
                "name": "place_equity_order",
                "arguments": {
                    "account_number": self.account_number.as_str(),
                    "symbol": reviewed.symbol,
                    "side": "buy",
                    "type": "market",
                    "dollar_amount": format_money(reviewed.dollar_amount),
                    "time_in_force": "gfd",
                    "market_hours": "regular_hours",
                    "ref_id": ref_id.to_string()
                }
            }
        });
        let response = self
            .client
            .post_rpc(&payload, Some(self.session_id.as_str()), false)
            .await
            .map_err(classify_placement_error)?
            .0;
        placement_from_tool_response(&response).map_err(classify_placement_error)
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

#[derive(Debug, Deserialize)]
struct QuoteToolPayload {
    data: QuoteData,
}

#[derive(Debug, Default, Deserialize)]
struct QuoteData {
    #[serde(default)]
    results: Vec<QuoteResult>,
}

#[derive(Debug, Deserialize)]
struct QuoteResult {
    quote: Option<QuoteWire>,
}

#[derive(Debug, Deserialize)]
struct QuoteWire {
    symbol: String,
    last_trade_price: Option<Value>,
    price: Option<Value>,
    previous_close: Option<Value>,
    adjusted_previous_close: Option<Value>,
    venue_last_trade_time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PositionToolPayload {
    data: PositionData,
}

#[derive(Debug, Default, Deserialize)]
struct PositionData {
    #[serde(default)]
    positions: Vec<PositionWire>,
}

#[derive(Debug, Deserialize)]
struct PositionWire {
    symbol: String,
    quantity: Value,
}

#[derive(Debug, Deserialize)]
struct OrderToolPayload {
    data: OrderData,
}

#[derive(Debug, Default, Deserialize)]
struct OrderData {
    #[serde(default)]
    orders: Vec<OrderWire>,
}

#[derive(Debug, Deserialize)]
struct OrderWire {
    id: String,
    symbol: String,
    state: String,
    #[serde(default)]
    executions: Vec<ExecutionWire>,
}

#[derive(Debug, Deserialize)]
struct ExecutionWire {
    id: String,
    quantity: Value,
    price: Value,
    fees: Option<Value>,
    timestamp: String,
}

#[derive(Debug, Deserialize)]
struct ReviewToolPayload {
    data: ReviewData,
}

#[derive(Debug, Deserialize)]
struct ReviewData {
    symbol: String,
    side: String,
    #[serde(rename = "type")]
    order_type: String,
    dollar_amount: Value,
    quote_data: QuoteWire,
}

fn decode_tool_payload<T: DeserializeOwned>(response: &Value) -> Result<T, RobinhoodMcpError> {
    let value = decode_tool_value(response)?;
    serde_json::from_value(value).map_err(|_| RobinhoodMcpError::InvalidResponse)
}

fn decode_tool_value(response: &Value) -> Result<Value, RobinhoodMcpError> {
    let result = tool_result(response)?;
    if let Some(structured) = result.get("structuredContent") {
        return Ok(structured.clone());
    }
    let text = text_from_tool_response(response)?;
    serde_json::from_str(text).map_err(|_| RobinhoodMcpError::InvalidResponse)
}

fn accounts_from_tool_response(
    response: &Value,
) -> Result<Vec<RobinhoodAccount>, RobinhoodMcpError> {
    let payload: AccountToolPayload = decode_tool_payload(response)?;
    Ok(payload.data.accounts)
}

fn buying_power_from_tool_response(response: &Value) -> Result<bool, RobinhoodMcpError> {
    Ok(buying_power_decimal_from_tool_response(response)? > Decimal::ZERO)
}

fn buying_power_decimal_from_tool_response(response: &Value) -> Result<Decimal, RobinhoodMcpError> {
    let payload: PortfolioToolPayload = decode_tool_payload(response)?;
    let buying_power = payload.data.buying_power.unwrap_or_default();
    let value = buying_power
        .unleveraged_buying_power
        .as_ref()
        .and_then(decimal_from_value)
        .or_else(|| {
            buying_power
                .buying_power
                .as_ref()
                .and_then(decimal_from_value)
        })
        .ok_or(RobinhoodMcpError::InvalidResponse)?;
    (value >= Decimal::ZERO)
        .then_some(value)
        .ok_or(RobinhoodMcpError::InvalidResponse)
}

fn quotes_from_tool_response(
    response: &Value,
) -> Result<Vec<RobinhoodEquityQuote>, RobinhoodMcpError> {
    let payload: QuoteToolPayload = decode_tool_payload(response)?;
    payload
        .data
        .results
        .into_iter()
        .filter_map(|result| result.quote)
        .map(quote_from_wire)
        .collect()
}

fn quote_from_wire(wire: QuoteWire) -> Result<RobinhoodEquityQuote, RobinhoodMcpError> {
    let symbol = validate_symbol(&wire.symbol)?;
    let last_trade_price = wire
        .last_trade_price
        .as_ref()
        .or(wire.price.as_ref())
        .and_then(decimal_from_value)
        .filter(|value| *value > Decimal::ZERO)
        .ok_or(RobinhoodMcpError::InvalidResponse)?;
    let previous_close = wire
        .previous_close
        .as_ref()
        .or(wire.adjusted_previous_close.as_ref())
        .and_then(decimal_from_value)
        .filter(|value| *value > Decimal::ZERO)
        .ok_or(RobinhoodMcpError::InvalidResponse)?;
    let venue_last_trade_time = wire
        .venue_last_trade_time
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
        .ok_or(RobinhoodMcpError::InvalidResponse)?;
    Ok(RobinhoodEquityQuote {
        symbol,
        last_trade_price,
        previous_close,
        venue_last_trade_time,
    })
}

fn positions_from_tool_response(
    response: &Value,
) -> Result<Vec<RobinhoodEquityPosition>, RobinhoodMcpError> {
    let payload: PositionToolPayload = decode_tool_payload(response)?;
    payload
        .data
        .positions
        .into_iter()
        .map(|position| {
            let symbol = validate_symbol(&position.symbol)?;
            let quantity = decimal_from_value(&position.quantity)
                .filter(|value| *value >= Decimal::ZERO)
                .ok_or(RobinhoodMcpError::InvalidResponse)?;
            Ok(RobinhoodEquityPosition { symbol, quantity })
        })
        .collect()
}

fn orders_from_tool_response(
    response: &Value,
) -> Result<Vec<RobinhoodEquityOrder>, RobinhoodMcpError> {
    let payload: OrderToolPayload = decode_tool_payload(response)?;
    payload
        .data
        .orders
        .into_iter()
        .map(order_from_wire)
        .collect()
}

fn order_from_wire(wire: OrderWire) -> Result<RobinhoodEquityOrder, RobinhoodMcpError> {
    validate_order_id(&wire.id)?;
    let symbol = validate_symbol(&wire.symbol)?;
    let executions = wire
        .executions
        .into_iter()
        .map(|execution| {
            if execution.id.trim().is_empty() || execution.id.len() > 256 {
                return Err(RobinhoodMcpError::InvalidResponse);
            }
            let quantity = decimal_from_value(&execution.quantity)
                .filter(|value| *value > Decimal::ZERO)
                .ok_or(RobinhoodMcpError::InvalidResponse)?;
            let price = decimal_from_value(&execution.price)
                .filter(|value| *value > Decimal::ZERO)
                .ok_or(RobinhoodMcpError::InvalidResponse)?;
            let fee = execution
                .fees
                .as_ref()
                .and_then(decimal_from_value)
                .unwrap_or(Decimal::ZERO);
            if fee < Decimal::ZERO {
                return Err(RobinhoodMcpError::InvalidResponse);
            }
            let executed_at = DateTime::parse_from_rfc3339(&execution.timestamp)
                .map(|value| value.with_timezone(&Utc))
                .map_err(|_| RobinhoodMcpError::InvalidResponse)?;
            Ok(RobinhoodExecution {
                execution_id: execution.id,
                quantity,
                price,
                fee,
                executed_at,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RobinhoodEquityOrder {
        order_id: wire.id,
        symbol,
        state: order_state_from_str(&wire.state),
        executions,
    })
}

fn reviewed_quote_from_tool_response(
    response: &Value,
    expected_symbol: &str,
    expected_amount: Decimal,
) -> Result<RobinhoodEquityQuote, RobinhoodMcpError> {
    let payload: ReviewToolPayload = decode_tool_payload(response)?;
    let amount = decimal_from_value(&payload.data.dollar_amount)
        .ok_or(RobinhoodMcpError::InvalidResponse)?;
    if payload.data.symbol != expected_symbol
        || payload.data.side != "buy"
        || payload.data.order_type != "market"
        || amount != expected_amount
    {
        return Err(RobinhoodMcpError::InvalidResponse);
    }
    let quote = quote_from_wire(payload.data.quote_data)?;
    (quote.symbol == expected_symbol)
        .then_some(quote)
        .ok_or(RobinhoodMcpError::InvalidResponse)
}

fn placement_from_tool_response(response: &Value) -> Result<RobinhoodPlacement, RobinhoodMcpError> {
    let value = decode_tool_value(response)?;
    let order_id = ["/data/id", "/data/order/id", "/data/order_id"]
        .into_iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .ok_or(RobinhoodMcpError::InvalidResponse)?;
    validate_order_id(order_id)?;
    let state = ["/data/state", "/data/order/state"]
        .into_iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_str))
        .map(order_state_from_str)
        .unwrap_or(RobinhoodEquityOrderState::Pending);
    Ok(RobinhoodPlacement {
        order_id: order_id.to_owned(),
        state,
    })
}

fn classify_placement_error(error: RobinhoodMcpError) -> RobinhoodPlacementError {
    match error {
        RobinhoodMcpError::AuthenticationFailed
        | RobinhoodMcpError::PermissionDenied
        | RobinhoodMcpError::RateLimited
        | RobinhoodMcpError::InvalidCredential
        | RobinhoodMcpError::InvalidOrder
        | RobinhoodMcpError::AmbiguousAgenticAccounts => RobinhoodPlacementError::Rejected,
        RobinhoodMcpError::UnexpectedStatus
        | RobinhoodMcpError::ResponseTooLarge
        | RobinhoodMcpError::InvalidResponse
        | RobinhoodMcpError::ToolError
        | RobinhoodMcpError::Unavailable => RobinhoodPlacementError::Unknown,
    }
}

fn order_state_from_str(value: &str) -> RobinhoodEquityOrderState {
    match value {
        "partially_filled" => RobinhoodEquityOrderState::PartiallyFilled,
        "filled" => RobinhoodEquityOrderState::Filled,
        "cancelled" | "canceled" | "voided" => RobinhoodEquityOrderState::Canceled,
        "rejected" | "failed" => RobinhoodEquityOrderState::Rejected,
        "new" | "queued" | "confirmed" | "unconfirmed" => RobinhoodEquityOrderState::Pending,
        _ => RobinhoodEquityOrderState::Unknown,
    }
}

fn validate_symbols(symbols: &[&str]) -> Result<Vec<String>, RobinhoodMcpError> {
    if symbols.is_empty() || symbols.len() > 20 {
        return Err(RobinhoodMcpError::InvalidOrder);
    }
    let mut normalized = Vec::with_capacity(symbols.len());
    for symbol in symbols {
        let symbol = validate_symbol(symbol)?;
        if normalized.contains(&symbol) {
            return Err(RobinhoodMcpError::InvalidOrder);
        }
        normalized.push(symbol);
    }
    Ok(normalized)
}

fn validate_symbol(symbol: &str) -> Result<String, RobinhoodMcpError> {
    let normalized = symbol.trim().to_ascii_uppercase();
    if normalized.is_empty()
        || normalized.len() > 10
        || !normalized
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || matches!(byte, b'.' | b'-'))
    {
        return Err(RobinhoodMcpError::InvalidOrder);
    }
    Ok(normalized)
}

fn validate_dollar_amount(amount: Decimal) -> Result<(), RobinhoodMcpError> {
    if amount <= Decimal::ZERO || amount > Decimal::new(50_000, 2) || amount.scale() > 2 {
        return Err(RobinhoodMcpError::InvalidOrder);
    }
    Ok(())
}

fn validate_order_id(order_id: &str) -> Result<(), RobinhoodMcpError> {
    Uuid::parse_str(order_id)
        .map(|_| ())
        .map_err(|_| RobinhoodMcpError::InvalidResponse)
}

fn format_money(amount: Decimal) -> String {
    format!("{amount:.2}")
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
    fn parses_quotes_without_exposing_provider_payloads() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "result": {
                "content": [{
                    "type": "text",
                    "text": "{\"data\":{\"results\":[{\"quote\":{\"symbol\":\"AAPL\",\"last_trade_price\":\"190.00\",\"previous_close\":\"194.00\",\"venue_last_trade_time\":\"2026-07-13T14:00:00Z\"}}]}}"
                }],
                "isError": false
            }
        });
        let quotes = quotes_from_tool_response(&response).expect("valid quote payload");
        assert_eq!(quotes.len(), 1);
        assert_eq!(quotes[0].symbol, "AAPL");
        assert!(quotes[0].change_percent() < Decimal::new(-2, 0));
    }

    #[test]
    fn reviewed_order_must_match_every_immutable_field() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "result": {
                "structuredContent": {
                    "data": {
                        "symbol": "AAPL",
                        "side": "buy",
                        "type": "market",
                        "dollar_amount": "5.00",
                        "quote_data": {
                            "symbol": "AAPL",
                            "last_trade_price": "190.00",
                            "previous_close": "194.00",
                            "venue_last_trade_time": "2026-07-13T14:00:00Z"
                        }
                    }
                },
                "isError": false
            }
        });
        let quote = reviewed_quote_from_tool_response(&response, "AAPL", Decimal::new(500, 2))
            .expect("matching review");
        assert_eq!(quote.symbol, "AAPL");
        assert!(
            reviewed_quote_from_tool_response(&response, "MSFT", Decimal::new(500, 2)).is_err()
        );
        assert!(
            reviewed_quote_from_tool_response(&response, "AAPL", Decimal::new(400, 2)).is_err()
        );
    }

    #[test]
    fn order_history_parses_execution_for_reconciliation() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 5,
            "result": {
                "content": [{
                    "type": "text",
                    "text": "{\"data\":{\"orders\":[{\"id\":\"7d9cb833-f8df-4ec0-92c7-11999db88673\",\"symbol\":\"AAPL\",\"state\":\"filled\",\"executions\":[{\"id\":\"fill-1\",\"quantity\":\"0.025\",\"price\":\"190.00\",\"fees\":\"0.00\",\"timestamp\":\"2026-07-13T14:01:00Z\"}]}]}}"
                }],
                "isError": false
            }
        });
        let orders = orders_from_tool_response(&response).expect("valid order history");
        assert_eq!(orders[0].state, RobinhoodEquityOrderState::Filled);
        assert_eq!(orders[0].executions.len(), 1);
        assert_eq!(orders[0].executions[0].quantity, Decimal::new(25, 3));
    }

    #[test]
    fn placement_requires_a_real_uuid_order_id() {
        let response = json!({
            "jsonrpc": "2.0",
            "id": 6,
            "result": {
                "structuredContent": {
                    "data": {
                        "id": "7d9cb833-f8df-4ec0-92c7-11999db88673",
                        "state": "queued"
                    }
                },
                "isError": false
            }
        });
        let placement = placement_from_tool_response(&response).expect("valid placement");
        assert_eq!(placement.state, RobinhoodEquityOrderState::Pending);

        let invalid = json!({
            "jsonrpc": "2.0",
            "id": 6,
            "result": {
                "structuredContent": {"data": {"id": "not-an-order-id"}},
                "isError": false
            }
        });
        assert!(placement_from_tool_response(&invalid).is_err());
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
        assert!(matches!(
            classify_placement_error(error),
            RobinhoodPlacementError::Unknown
        ));
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
