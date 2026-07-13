use std::path::PathBuf;

use chrono::{Duration, Utc};
use daytradingbot_contracts::{
    IntentPurpose, OrderSide, OrderState, OrderType, PredictionOrderSpec, PredictionOutcome,
    RiskPolicy, SafetyState, TradeIntent, Venue,
};
use daytradingbot_desktop_lib::vault::{CredentialVault, VaultKey};
use daytradingbot_ledger::{FillRecord, Ledger, ReservationOutcome};
use daytradingbot_venues::kalshi::{
    CanarySubmissionResult, DirectKalshiClient, DirectKalshiError, KalshiEnvironment,
    VerifiedCanaryOrder,
};
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

const CANARY_NAMESPACE: Uuid = Uuid::from_u128(0x4cf5_601b_d521_4931_bf86_d899_860c_dcb3);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or_default();
    if !matches!(mode, "preview" | "execute") || args.len() < 4 {
        return Err(
            "usage: direct_kalshi_canary preview TICKER yes|no LIMIT_CENTS\n       direct_kalshi_canary execute TICKER yes|no LIMIT_CENTS INTENT_ID CONFIRMATION_TOKEN"
                .into(),
        );
    }
    let ticker = args[1].to_owned();
    let outcome = parse_outcome(&args[2])?;
    let limit_price_cents: u8 = args[3].parse()?;
    let intent_id = if mode == "preview" {
        Uuid::new_v4()
    } else {
        Uuid::parse_str(args.get(4).ok_or("missing INTENT_ID")?)?
    };
    let intent = canary_intent(intent_id, ticker, outcome, limit_price_cents);
    let vault = CredentialVault::new();
    let api_key_id = vault.load(VaultKey::KalshiApiKeyId)?;
    let private_key = vault.load(VaultKey::KalshiPrivateKeyPem)?;
    let client = DirectKalshiClient::new(
        KalshiEnvironment::Production,
        Zeroizing::new(String::from_utf8(api_key_id.to_vec())?),
        Zeroizing::new(String::from_utf8(private_key.to_vec())?),
    )?;
    let prepared = DirectKalshiClient::prepare_canary(&intent)?;
    let verified = client.verify_canary(prepared).await?;
    let confirmation_token = confirmation_token(&verified);

    if mode == "preview" {
        println!("Intent ID: {intent_id}");
        println!("Market: {}", verified.market_title);
        println!("Ticker: {}", verified.prepared().ticker);
        println!("Outcome: {}", outcome_key(outcome));
        println!("Observed ask: {} cents", verified.observed_ask_cents);
        println!("Maximum outcome price: {limit_price_cents} cents");
        println!(
            "Maximum loss including fee allowance: {} cents",
            verified.prepared().worst_case_loss_cents()
        );
        println!("Rules: {}", verified.rules_primary);
        println!("Confirmation token: {confirmation_token}");
        return Ok(());
    }

    if args.get(5).map(String::as_str) != Some(confirmation_token.as_str()) {
        return Err("confirmation token does not match the freshly verified market".into());
    }
    execute(&client, intent, verified).await
}

async fn execute(
    client: &DirectKalshiClient,
    intent: TradeIntent,
    verified: VerifiedCanaryOrder,
) -> Result<(), Box<dyn std::error::Error>> {
    let intent_id = intent.intent_id;
    let ledger = Ledger::open(canary_ledger_path()?)?;
    ledger.update_safety_state(
        intent.risk_scope,
        intent.account_scope,
        Venue::Kalshi,
        &SafetyState::ready_for_entries(),
        Utc::now(),
    )?;
    match ledger.reserve(intent, &canary_policy())? {
        ReservationOutcome::Reserved(_) => {}
        ReservationOutcome::Duplicate => return Err("canary intent already exists".into()),
        ReservationOutcome::Rejected(reason) => {
            return Err(format!("canary risk gate rejected the order: {reason:?}").into());
        }
    }
    ledger.begin_submission(
        intent_id,
        Uuid::new_v4(),
        &verified.prepared().request_fingerprint,
    )?;

    match client.submit_verified_canary(verified).await {
        Ok(CanarySubmissionResult::Filled {
            order_id,
            filled_contracts,
            outcome_price_cents,
            fee_cents,
        }) => {
            ledger.acknowledge_submission(intent_id, &order_id)?;
            ledger.record_open_fill(
                intent_id,
                &FillRecord {
                    venue_fill_id: format!("{order_id}:initial"),
                    quantity: Decimal::from(filled_contracts),
                    price: Decimal::new(i64::from(outcome_price_cents), 2),
                    notional: Decimal::new(i64::from(outcome_price_cents), 2),
                    fee: Decimal::new(i64::from(fee_cents), 2),
                    filled_at: Utc::now(),
                },
            )?;
            ledger.finalize_open_order(intent_id, OrderState::Filled)?;
            println!("Live canary filled and reconciled as exactly one contract.");
            println!("Venue order ID: {order_id}");
        }
        Ok(CanarySubmissionResult::NoFill { order_id }) => {
            ledger.acknowledge_submission(intent_id, &order_id)?;
            ledger.finalize_open_order(intent_id, OrderState::Canceled)?;
            println!("Live canary returned a confirmed no-fill; no position was opened.");
            println!("Venue order ID: {order_id}");
        }
        Err(
            error @ (DirectKalshiError::AuthenticationFailed
            | DirectKalshiError::PermissionDenied
            | DirectKalshiError::OrderRejected
            | DirectKalshiError::MarketPreflightFailed),
        ) => {
            ledger.reject_submission(intent_id, definite_error_code(&error))?;
            ledger.finalize_open_order(intent_id, OrderState::Rejected)?;
            return Err(error.into());
        }
        Err(error) => {
            ledger.mark_submission_unknown(intent_id, "direct_kalshi_submission_unknown")?;
            return Err(error.into());
        }
    }
    Ok(())
}

fn canary_intent(
    intent_id: Uuid,
    ticker: String,
    outcome: PredictionOutcome,
    limit_price_cents: u8,
) -> TradeIntent {
    let now = Utc::now();
    let fee_cents = 2_u32;
    let risk_scope = Uuid::new_v5(&CANARY_NAMESPACE, b"owner-direct-kalshi-risk");
    let account_scope = Uuid::new_v5(&CANARY_NAMESPACE, b"owner-direct-kalshi-account");
    TradeIntent {
        intent_id,
        source_event_id: format!("founder-canary:{intent_id}"),
        strategy_id: "founder-one-shot".into(),
        venue: Venue::Kalshi,
        risk_scope,
        account_scope,
        instrument: ticker,
        side: OrderSide::Buy,
        order_type: OrderType::FillOrKill,
        purpose: IntentPurpose::Open,
        notional_usd: Decimal::new(i64::from(limit_price_cents) + i64::from(fee_cents), 2),
        limit_price: Some(Decimal::new(i64::from(limit_price_cents), 2)),
        prediction: Some(PredictionOrderSpec {
            outcome,
            contract_count: 1,
            limit_price_cents,
            max_fee_cents: fee_cents,
        }),
        signal_at: now,
        expires_at: now + Duration::minutes(2),
        rationale: "explicit user-selected founder canary".into(),
    }
}

fn canary_policy() -> RiskPolicy {
    RiskPolicy {
        max_opening_order_usd: Decimal::ONE,
        max_daily_opening_notional_usd: Decimal::ONE,
        max_venue_exposure_usd: Decimal::ONE,
        max_global_exposure_usd: Decimal::ONE,
        max_daily_loss_usd: Decimal::ONE,
        max_resting_entry_orders: 1,
    }
}

fn confirmation_token(verified: &VerifiedCanaryOrder) -> String {
    let prepared = verified.prepared();
    let canonical = format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        prepared.intent_id,
        prepared.ticker,
        outcome_key(prepared.outcome),
        prepared.outcome_limit_price_cents,
        verified.market_title,
        verified.rules_primary,
    );
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

fn parse_outcome(value: &str) -> Result<PredictionOutcome, &'static str> {
    match value {
        "yes" => Ok(PredictionOutcome::Yes),
        "no" => Ok(PredictionOutcome::No),
        _ => Err("outcome must be yes or no"),
    }
}

fn outcome_key(outcome: PredictionOutcome) -> &'static str {
    match outcome {
        PredictionOutcome::Yes => "YES",
        PredictionOutcome::No => "NO",
    }
}

fn definite_error_code(error: &DirectKalshiError) -> &'static str {
    match error {
        DirectKalshiError::AuthenticationFailed => "authentication_failed",
        DirectKalshiError::PermissionDenied => "permission_denied",
        DirectKalshiError::OrderRejected => "order_rejected",
        DirectKalshiError::MarketPreflightFailed => "market_preflight_failed",
        _ => "unexpected_definite_rejection",
    }
}

fn canary_ledger_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unavailable")?);
    let directory = home.join("Library/Application Support/net.daytradingbot.desktop");
    std::fs::create_dir_all(&directory)?;
    Ok(directory.join("direct-kalshi-canary.sqlite3"))
}
