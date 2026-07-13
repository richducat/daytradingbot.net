use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use chrono::{DateTime, Utc};
use daytradingbot_contracts::{
    IntentPurpose, OrderSide, OrderType, PredictionOutcome, TradeIntent, Venue,
};
use reqwest::{Client, Method, StatusCode, redirect::Policy};
use ring::{
    rand::SystemRandom,
    signature::{RSA_PSS_SHA256, RsaKeyPair},
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroizing;

const PRODUCTION_ORIGIN: &str = "https://external-api.kalshi.com";
const DEMO_ORIGIN: &str = "https://external-api.demo.kalshi.co";
const API_PREFIX: &str = "/trade-api/v2";
const CREATE_ORDER_PATH: &str = "/trade-api/v2/portfolio/events/orders";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const CANARY_MAX_LOSS_CENTS: u64 = 100;
const CANARY_CONTRACT_COUNT: u32 = 1;
const GENERAL_MAX_FEE_CENTS: u32 = 2;
const PREFLIGHT_MAX_AGE_SECONDS: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KalshiEnvironment {
    Production,
    Demo,
}

impl KalshiEnvironment {
    fn origin(self) -> &'static str {
        match self {
            Self::Production => PRODUCTION_ORIGIN,
            Self::Demo => DEMO_ORIGIN,
        }
    }
}

#[derive(Debug, Error)]
pub enum DirectKalshiError {
    #[error("Kalshi API key ID is invalid")]
    InvalidApiKeyId,
    #[error("Kalshi RSA private key is invalid")]
    InvalidPrivateKey,
    #[error("Kalshi one-shot order is invalid")]
    InvalidCanaryOrder,
    #[error("Kalshi market preflight failed closed")]
    MarketPreflightFailed,
    #[error("Kalshi authentication failed")]
    AuthenticationFailed,
    #[error("Kalshi account is not permitted to perform this operation")]
    PermissionDenied,
    #[error("Kalshi rate limit reached")]
    RateLimited,
    #[error("Kalshi rejected the order before acceptance")]
    OrderRejected,
    #[error("Kalshi submission outcome is unknown and must be reconciled")]
    SubmissionUnknown,
    #[error("Kalshi response exceeded the local safety limit")]
    ResponseTooLarge,
    #[error("Kalshi response was invalid")]
    InvalidResponse,
    #[error("Kalshi service could not be reached")]
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedCanaryOrder {
    pub intent_id: Uuid,
    pub ticker: String,
    pub outcome: PredictionOutcome,
    pub outcome_limit_price_cents: u8,
    pub max_fee_cents: u32,
    pub request_fingerprint: String,
    body: CreateOrderBody,
}

impl PreparedCanaryOrder {
    #[must_use]
    pub fn client_order_id(&self) -> String {
        self.intent_id.to_string()
    }

    #[must_use]
    pub fn worst_case_loss_cents(&self) -> u64 {
        u64::from(self.outcome_limit_price_cents) + u64::from(self.max_fee_cents)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedCanaryOrder {
    prepared: PreparedCanaryOrder,
    pub market_title: String,
    pub rules_primary: String,
    pub observed_ask_cents: u8,
    verified_at: DateTime<Utc>,
}

impl VerifiedCanaryOrder {
    #[must_use]
    pub fn prepared(&self) -> &PreparedCanaryOrder {
        &self.prepared
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanarySubmissionResult {
    Filled {
        order_id: String,
        filled_contracts: u32,
        outcome_price_cents: u8,
        fee_cents: u32,
    },
    NoFill {
        order_id: String,
    },
}

pub struct DirectKalshiClient {
    http: Client,
    environment: KalshiEnvironment,
    api_key_id: Zeroizing<String>,
    signing_key: RsaKeyPair,
}

impl DirectKalshiClient {
    pub fn new(
        environment: KalshiEnvironment,
        api_key_id: Zeroizing<String>,
        private_key_pem: Zeroizing<String>,
    ) -> Result<Self, DirectKalshiError> {
        let api_key = api_key_id.trim();
        if Uuid::parse_str(api_key).is_err() {
            return Err(DirectKalshiError::InvalidApiKeyId);
        }
        let signing_key = parse_rsa_private_key(private_key_pem.as_str())?;
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(12))
            .redirect(Policy::none())
            .user_agent("DayTradingBot/0.1 direct-kalshi")
            .build()
            .map_err(|_| DirectKalshiError::Unavailable)?;

        Ok(Self {
            http,
            environment,
            api_key_id,
            signing_key,
        })
    }

    /// Builds the only live-entry shape allowed during the founder canary:
    /// one FOK contract, integer-cent outcome price, two-cent fee allowance,
    /// and no more than one dollar of worst-case loss including fees.
    pub fn prepare_canary(intent: &TradeIntent) -> Result<PreparedCanaryOrder, DirectKalshiError> {
        let prediction = intent
            .prediction
            .as_ref()
            .ok_or(DirectKalshiError::InvalidCanaryOrder)?;
        if intent.venue != Venue::Kalshi
            || intent.purpose != IntentPurpose::Open
            || intent.side != OrderSide::Buy
            || intent.order_type != OrderType::FillOrKill
            || prediction.contract_count != CANARY_CONTRACT_COUNT
            || prediction.max_fee_cents != GENERAL_MAX_FEE_CENTS
            || !valid_ticker(&intent.instrument)
            || intent.expires_at <= Utc::now()
        {
            return Err(DirectKalshiError::InvalidCanaryOrder);
        }
        let worst_case_loss_cents = prediction
            .worst_case_loss_cents()
            .ok_or(DirectKalshiError::InvalidCanaryOrder)?;
        if worst_case_loss_cents > CANARY_MAX_LOSS_CENTS
            || i64::try_from(worst_case_loss_cents)
                .ok()
                .is_none_or(|cents| Decimal::new(cents, 2) != intent.notional_usd)
        {
            return Err(DirectKalshiError::InvalidCanaryOrder);
        }

        let yes_price_cents = match prediction.outcome {
            PredictionOutcome::Yes => prediction.limit_price_cents,
            PredictionOutcome::No => 100_u8
                .checked_sub(prediction.limit_price_cents)
                .ok_or(DirectKalshiError::InvalidCanaryOrder)?,
        };
        let side = match prediction.outcome {
            PredictionOutcome::Yes => BookSide::Bid,
            PredictionOutcome::No => BookSide::Ask,
        };
        let body = CreateOrderBody {
            ticker: intent.instrument.clone(),
            client_order_id: intent.intent_id.to_string(),
            side,
            count: "1.00".to_owned(),
            price: cents_as_fixed_dollars(yes_price_cents),
            time_in_force: "fill_or_kill",
            self_trade_prevention_type: "taker_at_cross",
            post_only: false,
            cancel_order_on_pause: true,
            reduce_only: false,
            subaccount: 0,
            exchange_index: 0,
        };
        let canonical =
            serde_json::to_vec(&body).map_err(|_| DirectKalshiError::InvalidCanaryOrder)?;
        let request_fingerprint = format!("{:x}", Sha256::digest(canonical));

        Ok(PreparedCanaryOrder {
            intent_id: intent.intent_id,
            ticker: intent.instrument.clone(),
            outcome: prediction.outcome,
            outcome_limit_price_cents: prediction.limit_price_cents,
            max_fee_cents: prediction.max_fee_cents,
            request_fingerprint,
            body,
        })
    }

    /// Reads the authoritative market, event, and series immediately before a
    /// possible write. Special/overridden fee schedules and provisional or
    /// stale markets are rejected.
    pub async fn verify_canary(
        &self,
        prepared: PreparedCanaryOrder,
    ) -> Result<VerifiedCanaryOrder, DirectKalshiError> {
        let market_path = format!("{API_PREFIX}/markets/{}", prepared.ticker);
        let market: MarketResponse = self.get_public(&market_path).await?;
        if market.market.ticker != prepared.ticker
            || market.market.is_provisional
            || market.market.close_time <= Utc::now() + chrono::Duration::seconds(60)
            || market.market.rules_primary.trim().is_empty()
        {
            return Err(DirectKalshiError::MarketPreflightFailed);
        }
        let observed_ask_cents = match prepared.outcome {
            PredictionOutcome::Yes => parse_exact_cents(&market.market.yes_ask_dollars),
            PredictionOutcome::No => parse_exact_cents(&market.market.no_ask_dollars),
        }
        .ok_or(DirectKalshiError::MarketPreflightFailed)?;
        if observed_ask_cents == 0 || observed_ask_cents > prepared.outcome_limit_price_cents {
            return Err(DirectKalshiError::MarketPreflightFailed);
        }

        let event_path = format!("{API_PREFIX}/events/{}", market.market.event_ticker);
        let event: EventResponse = self.get_public(&event_path).await?;
        if event.event.event_ticker != market.market.event_ticker
            || !fee_schedule_is_general(
                event.event.fee_type_override.as_deref(),
                event.event.fee_multiplier_override,
            )
        {
            return Err(DirectKalshiError::MarketPreflightFailed);
        }
        let series_path = format!("{API_PREFIX}/series/{}", event.event.series_ticker);
        let series: SeriesResponse = self.get_public(&series_path).await?;
        if series.series.ticker != event.event.series_ticker
            || !fee_schedule_is_general(
                Some(series.series.fee_type.as_str()),
                Some(series.series.fee_multiplier),
            )
        {
            return Err(DirectKalshiError::MarketPreflightFailed);
        }

        Ok(VerifiedCanaryOrder {
            prepared,
            market_title: market.market.title,
            rules_primary: market.market.rules_primary,
            observed_ask_cents,
            verified_at: Utc::now(),
        })
    }

    /// Sends exactly one already-verified request. This function never retries.
    /// The caller must durably call `Ledger::begin_submission` first and mark
    /// any `SubmissionUnknown` result for read-only reconciliation.
    pub async fn submit_verified_canary(
        &self,
        verified: VerifiedCanaryOrder,
    ) -> Result<CanarySubmissionResult, DirectKalshiError> {
        let age = Utc::now()
            .signed_duration_since(verified.verified_at)
            .num_seconds();
        if !(0..=PREFLIGHT_MAX_AGE_SECONDS).contains(&age) {
            return Err(DirectKalshiError::MarketPreflightFailed);
        }

        let headers = self.signed_headers(Method::POST, CREATE_ORDER_PATH, Utc::now())?;
        let url = format!("{}{CREATE_ORDER_PATH}", self.environment.origin());
        let response = self
            .http
            .post(url)
            .header("KALSHI-ACCESS-KEY", self.api_key_id.as_str())
            .header("KALSHI-ACCESS-TIMESTAMP", headers.timestamp)
            .header("KALSHI-ACCESS-SIGNATURE", headers.signature)
            .json(&verified.prepared.body)
            .send()
            .await
            .map_err(|_| DirectKalshiError::SubmissionUnknown)?;

        match response.status() {
            StatusCode::CREATED => {}
            StatusCode::UNAUTHORIZED => return Err(DirectKalshiError::AuthenticationFailed),
            StatusCode::FORBIDDEN => return Err(DirectKalshiError::PermissionDenied),
            StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => {
                return Err(DirectKalshiError::OrderRejected);
            }
            _ => return Err(DirectKalshiError::SubmissionUnknown),
        }
        let response: CreateOrderResponse = read_json_limited(response)
            .await
            .map_err(|_| DirectKalshiError::SubmissionUnknown)?;
        validate_create_response(&verified.prepared, response)
            .ok_or(DirectKalshiError::SubmissionUnknown)
    }

    /// Confirms that the direct credentials authenticate without writing.
    pub async fn read_balance(&self) -> Result<BalanceResponse, DirectKalshiError> {
        let path = "/trade-api/v2/portfolio/balance";
        let headers = self.signed_headers(Method::GET, path, Utc::now())?;
        let url = format!("{}{path}", self.environment.origin());
        let response = self
            .http
            .get(url)
            .header("KALSHI-ACCESS-KEY", self.api_key_id.as_str())
            .header("KALSHI-ACCESS-TIMESTAMP", headers.timestamp)
            .header("KALSHI-ACCESS-SIGNATURE", headers.signature)
            .send()
            .await
            .map_err(|_| DirectKalshiError::Unavailable)?;
        match response.status() {
            StatusCode::UNAUTHORIZED => return Err(DirectKalshiError::AuthenticationFailed),
            StatusCode::FORBIDDEN => return Err(DirectKalshiError::PermissionDenied),
            StatusCode::TOO_MANY_REQUESTS => return Err(DirectKalshiError::RateLimited),
            status if !status.is_success() => return Err(DirectKalshiError::Unavailable),
            _ => {}
        }
        read_json_limited(response).await
    }

    async fn get_public<T: DeserializeOwned>(&self, path: &str) -> Result<T, DirectKalshiError> {
        if !valid_api_path(path) {
            return Err(DirectKalshiError::MarketPreflightFailed);
        }
        let url = format!("{}{path}", self.environment.origin());
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| DirectKalshiError::Unavailable)?;
        if !response.status().is_success() {
            return Err(DirectKalshiError::MarketPreflightFailed);
        }
        read_json_limited(response).await
    }

    fn signed_headers(
        &self,
        method: Method,
        path: &str,
        now: DateTime<Utc>,
    ) -> Result<SignedHeaders, DirectKalshiError> {
        if !valid_api_path(path) || path.contains('?') {
            return Err(DirectKalshiError::InvalidResponse);
        }
        let timestamp = now.timestamp_millis().to_string();
        let message = format!("{timestamp}{}{path}", method.as_str());
        let mut signature = vec![0_u8; self.signing_key.public().modulus_len()];
        self.signing_key
            .sign(
                &RSA_PSS_SHA256,
                &SystemRandom::new(),
                message.as_bytes(),
                &mut signature,
            )
            .map_err(|_| DirectKalshiError::InvalidPrivateKey)?;
        Ok(SignedHeaders {
            timestamp,
            signature: BASE64_STANDARD.encode(signature),
        })
    }
}

#[derive(Debug)]
struct SignedHeaders {
    timestamp: String,
    signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum BookSide {
    Bid,
    Ask,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct CreateOrderBody {
    ticker: String,
    client_order_id: String,
    side: BookSide,
    count: String,
    price: String,
    time_in_force: &'static str,
    self_trade_prevention_type: &'static str,
    post_only: bool,
    cancel_order_on_pause: bool,
    reduce_only: bool,
    subaccount: u8,
    exchange_index: u8,
}

#[derive(Debug, Deserialize)]
struct CreateOrderResponse {
    order_id: String,
    client_order_id: Option<String>,
    fill_count: String,
    remaining_count: String,
    average_fill_price: Option<String>,
    average_fee_paid: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MarketResponse {
    market: MarketRecord,
}

#[derive(Debug, Deserialize)]
struct MarketRecord {
    ticker: String,
    event_ticker: String,
    title: String,
    rules_primary: String,
    close_time: DateTime<Utc>,
    yes_ask_dollars: String,
    no_ask_dollars: String,
    #[serde(default)]
    is_provisional: bool,
}

#[derive(Debug, Deserialize)]
struct EventResponse {
    event: EventRecord,
}

#[derive(Debug, Deserialize)]
struct EventRecord {
    event_ticker: String,
    series_ticker: String,
    fee_type_override: Option<String>,
    fee_multiplier_override: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct SeriesResponse {
    series: SeriesRecord,
}

#[derive(Debug, Deserialize)]
struct SeriesRecord {
    ticker: String,
    fee_type: String,
    fee_multiplier: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BalanceResponse {
    /// Current API uses cents here; retain the raw integer and do not expose it
    /// in redacted UI or logs.
    pub balance: i64,
    pub portfolio_value: i64,
}

fn validate_create_response(
    prepared: &PreparedCanaryOrder,
    response: CreateOrderResponse,
) -> Option<CanarySubmissionResult> {
    if response.order_id.trim().is_empty()
        || response.client_order_id.as_deref() != Some(prepared.client_order_id().as_str())
        || parse_contract_count(&response.remaining_count)? != 0
    {
        return None;
    }
    let filled = parse_contract_count(&response.fill_count)?;
    match filled {
        0 if response.average_fill_price.is_none() && response.average_fee_paid.is_none() => {
            Some(CanarySubmissionResult::NoFill {
                order_id: response.order_id,
            })
        }
        CANARY_CONTRACT_COUNT => {
            let yes_price = parse_exact_cents(response.average_fill_price.as_deref()?)?;
            let outcome_price = match prepared.outcome {
                PredictionOutcome::Yes => yes_price,
                PredictionOutcome::No => 100_u8.checked_sub(yes_price)?,
            };
            let fee_cents = parse_fee_cents(response.average_fee_paid.as_deref()?)?;
            if outcome_price > prepared.outcome_limit_price_cents
                || fee_cents > prepared.max_fee_cents
                || u64::from(outcome_price) + u64::from(fee_cents) > CANARY_MAX_LOSS_CENTS
            {
                return None;
            }
            Some(CanarySubmissionResult::Filled {
                order_id: response.order_id,
                filled_contracts: CANARY_CONTRACT_COUNT,
                outcome_price_cents: outcome_price,
                fee_cents,
            })
        }
        _ => None,
    }
}

async fn read_json_limited<T: DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T, DirectKalshiError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(DirectKalshiError::ResponseTooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| DirectKalshiError::Unavailable)?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(DirectKalshiError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| DirectKalshiError::InvalidResponse)
}

fn valid_ticker(ticker: &str) -> bool {
    !ticker.is_empty()
        && ticker.len() <= 128
        && ticker
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}

fn parse_rsa_private_key(pem: &str) -> Result<RsaKeyPair, DirectKalshiError> {
    const PKCS8_BEGIN: &str = "-----BEGIN PRIVATE KEY-----";
    const PKCS8_END: &str = "-----END PRIVATE KEY-----";
    const PKCS1_BEGIN: &str = "-----BEGIN RSA PRIVATE KEY-----";
    const PKCS1_END: &str = "-----END RSA PRIVATE KEY-----";

    let trimmed = pem.trim();
    let (begin, end, is_pkcs8) = if trimmed.starts_with(PKCS8_BEGIN) && trimmed.ends_with(PKCS8_END)
    {
        (PKCS8_BEGIN, PKCS8_END, true)
    } else if trimmed.starts_with(PKCS1_BEGIN) && trimmed.ends_with(PKCS1_END) {
        (PKCS1_BEGIN, PKCS1_END, false)
    } else {
        return Err(DirectKalshiError::InvalidPrivateKey);
    };
    let body = &trimmed[begin.len()..trimmed.len().saturating_sub(end.len())];
    if body.contains("-----") {
        return Err(DirectKalshiError::InvalidPrivateKey);
    }
    let encoded = Zeroizing::new(
        body.chars()
            .filter(|character| !character.is_ascii_whitespace())
            .collect::<String>(),
    );
    let der = Zeroizing::new(
        BASE64_STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| DirectKalshiError::InvalidPrivateKey)?,
    );
    if is_pkcs8 {
        RsaKeyPair::from_pkcs8(der.as_slice())
    } else {
        RsaKeyPair::from_der(der.as_slice())
    }
    .map_err(|_| DirectKalshiError::InvalidPrivateKey)
}

fn valid_api_path(path: &str) -> bool {
    path.starts_with(API_PREFIX) && !path.contains("..") && !path.contains(['?', '#', '\r', '\n'])
}

fn cents_as_fixed_dollars(cents: u8) -> String {
    format!("0.{cents:02}00")
}

fn parse_exact_cents(value: &str) -> Option<u8> {
    let decimal: Decimal = value.parse().ok()?;
    if decimal <= Decimal::ZERO || decimal >= Decimal::ONE {
        return None;
    }
    let cents = decimal * Decimal::from(100_u32);
    let cents: u8 = cents.try_into().ok()?;
    (Decimal::from(cents) == decimal * Decimal::from(100_u32)).then_some(cents)
}

fn parse_fee_cents(value: &str) -> Option<u32> {
    let decimal: Decimal = value.parse().ok()?;
    if decimal < Decimal::ZERO {
        return None;
    }
    let cents = decimal * Decimal::from(100_u32);
    let cents: u32 = cents.ceil().try_into().ok()?;
    Some(cents)
}

fn parse_contract_count(value: &str) -> Option<u32> {
    let decimal: Decimal = value.parse().ok()?;
    decimal.try_into().ok()
}

fn fee_schedule_is_general(fee_type: Option<&str>, multiplier: Option<u32>) -> bool {
    match (fee_type, multiplier) {
        (None, None) => true,
        (Some("quadratic"), Some(value)) => value <= 1,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration as ChronoDuration;
    use daytradingbot_contracts::PredictionOrderSpec;

    use super::*;

    fn canary_intent(outcome: PredictionOutcome, price_cents: u8) -> TradeIntent {
        let now = Utc::now();
        let fee_cents = GENERAL_MAX_FEE_CENTS;
        TradeIntent {
            intent_id: Uuid::new_v4(),
            source_event_id: "manual-founder-canary".into(),
            strategy_id: "founder-one-shot".into(),
            venue: Venue::Kalshi,
            risk_scope: Uuid::new_v4(),
            account_scope: Uuid::new_v4(),
            instrument: "KXTEST-26JUL12".into(),
            side: OrderSide::Buy,
            order_type: OrderType::FillOrKill,
            purpose: IntentPurpose::Open,
            notional_usd: Decimal::new(i64::from(price_cents) + i64::from(fee_cents), 2),
            limit_price: Some(Decimal::new(i64::from(price_cents), 2)),
            prediction: Some(PredictionOrderSpec {
                outcome,
                contract_count: CANARY_CONTRACT_COUNT,
                limit_price_cents: price_cents,
                max_fee_cents: fee_cents,
            }),
            signal_at: now,
            expires_at: now + ChronoDuration::minutes(1),
            rationale: "user-selected founder canary".into(),
        }
    }

    #[test]
    fn prepares_exact_one_contract_yes_canary() {
        let intent = canary_intent(PredictionOutcome::Yes, 50);
        let prepared = DirectKalshiClient::prepare_canary(&intent).unwrap();

        assert_eq!(prepared.body.side, BookSide::Bid);
        assert_eq!(prepared.body.count, "1.00");
        assert_eq!(prepared.body.price, "0.5000");
        assert_eq!(prepared.client_order_id(), intent.intent_id.to_string());
        assert_eq!(prepared.worst_case_loss_cents(), 52);
        assert_eq!(prepared.request_fingerprint.len(), 64);
    }

    #[test]
    fn no_outcome_maps_to_yes_book_ask_without_float_math() {
        let intent = canary_intent(PredictionOutcome::No, 40);
        let prepared = DirectKalshiClient::prepare_canary(&intent).unwrap();

        assert_eq!(prepared.body.side, BookSide::Ask);
        assert_eq!(prepared.body.price, "0.6000");
        assert_eq!(prepared.outcome_limit_price_cents, 40);
    }

    #[test]
    fn rejects_more_than_one_contract_or_more_than_one_dollar() {
        let mut multiple = canary_intent(PredictionOutcome::Yes, 50);
        multiple.prediction.as_mut().unwrap().contract_count = 2;
        assert!(DirectKalshiClient::prepare_canary(&multiple).is_err());

        let over_cap = canary_intent(PredictionOutcome::Yes, 99);
        assert!(DirectKalshiClient::prepare_canary(&over_cap).is_err());
    }

    #[test]
    fn validates_fok_response_and_total_loss_cap() {
        let prepared =
            DirectKalshiClient::prepare_canary(&canary_intent(PredictionOutcome::No, 40)).unwrap();
        let response = CreateOrderResponse {
            order_id: "order-1".into(),
            client_order_id: Some(prepared.client_order_id()),
            fill_count: "1.00".into(),
            remaining_count: "0.00".into(),
            average_fill_price: Some("0.6000".into()),
            average_fee_paid: Some("0.0200".into()),
        };

        assert_eq!(
            validate_create_response(&prepared, response),
            Some(CanarySubmissionResult::Filled {
                order_id: "order-1".into(),
                filled_contracts: 1,
                outcome_price_cents: 40,
                fee_cents: 2,
            })
        );
    }

    #[test]
    fn only_general_quadratic_fee_schedule_passes() {
        assert!(fee_schedule_is_general(Some("quadratic"), Some(1)));
        assert!(fee_schedule_is_general(None, None));
        assert!(!fee_schedule_is_general(Some("quadratic"), Some(2)));
        assert!(!fee_schedule_is_general(Some("flat"), Some(1)));
        assert!(!fee_schedule_is_general(Some("quadratic"), None));
    }

    #[test]
    fn private_key_parser_rejects_non_pem_and_nested_blocks() {
        assert!(parse_rsa_private_key("not a private key").is_err());
        assert!(
            parse_rsa_private_key(
                "-----BEGIN PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
            )
            .is_err()
        );
    }
}
