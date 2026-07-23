use crate::robinhood_connection::current_robinhood_access;
use crate::vault::{CredentialVault, VaultKey};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, Timelike, Utc, Weekday};
use chrono_tz::America::New_York;
use daytradingbot_contracts::{
    IntentPurpose, OrderSide, OrderState, OrderType, RiskPolicy, RiskRejection, SafetyState,
    TradeIntent, Venue,
};
use daytradingbot_core::{IntentIdentity, RiskEngine, deterministic_intent_id};
use daytradingbot_ledger::{
    AgentActivityKind, AgentActivityMode, AgentActivityRecord, FillOutcome, FillRecord, Ledger,
    NewAgentActivity, ReservationOutcome, SubmissionAttemptState,
};
use daytradingbot_licensing::LicenseGate;
use daytradingbot_venues::robinhood::{
    RobinhoodAgenticClient, RobinhoodEquityOrder, RobinhoodEquityOrderState, RobinhoodEquityQuote,
    RobinhoodMcpError, RobinhoodPlacementError, RobinhoodTradingSession,
};
use rust_decimal::Decimal;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use uuid::Uuid;

const AGENT_ID: &str = "bluechip";
const STRATEGY_ID: &str = "bluechip-pullback-v1";
const WATCHLIST: [&str; 8] = ["AAPL", "NVDA", "TSLA", "SPY", "QQQ", "AMD", "MSFT", "GOOGL"];
const DIP_THRESHOLD_PERCENT_HUNDREDTHS: i64 = -150;
const CYCLE_SECONDS: u64 = 15 * 60;
const MAX_TRADES_PER_CYCLE: usize = 1;
const START_PREFLIGHT_TIMEOUT_SECONDS: u64 = 25;
const REAL_AUTHORIZATION_HOURS: i64 = 24;
const ACCEPTED_PLACEMENT_LOCAL_RECORD_ACTIVITY: &str = "Robinhood accepted this order, but the app could not finish saving the result. Real trading stopped. Check Robinhood and Activity before starting again.";
const UNCERTAIN_PLACEMENT_ACTIVITY: &str = "This order may have reached Robinhood, but Robinhood did not confirm it. Real trading stopped. Bluechip will check that exact order before it can trade again.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeTradingMode {
    Practice,
    Real,
}

impl NativeTradingMode {
    fn activity_mode(self) -> AgentActivityMode {
        match self {
            Self::Practice => AgentActivityMode::Practice,
            Self::Real => AgentActivityMode::Real,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Practice => "practice",
            Self::Real => "real",
        }
    }
}

#[derive(Clone, Debug)]
pub struct BluechipConfig {
    pub mode: NativeTradingMode,
    pub daily_budget_usd: Decimal,
    pub max_per_trade_usd: Decimal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TradeAmountDecision {
    Ready(Decimal),
    DailyRemainderBelowMinimum(Decimal),
    BuyingPowerBelowMinimum(Decimal),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RiskRejectionDisposition {
    ContinueCandidate,
    EndCycle,
    StopReal,
}

#[derive(Clone, Debug, Serialize)]
pub struct BluechipStatus {
    pub running: bool,
    pub mode: &'static str,
    pub message: String,
    pub last_checked_at: Option<String>,
    pub next_check_at: Option<String>,
}

impl Default for BluechipStatus {
    fn default() -> Self {
        Self {
            running: false,
            mode: "paused",
            message: "Trading is paused.".into(),
            last_checked_at: None,
            next_check_at: None,
        }
    }
}

#[derive(Default)]
struct RuntimeInner {
    generation: u64,
    status: BluechipStatus,
    active_config: Option<BluechipConfig>,
    cancel: Option<oneshot::Sender<()>>,
    real_authorized_until: Option<DateTime<Utc>>,
}

#[derive(Default)]
pub struct BluechipRuntime {
    inner: Mutex<RuntimeInner>,
}

impl BluechipRuntime {
    #[must_use]
    pub fn status(&self) -> BluechipStatus {
        self.inner
            .lock()
            .map(|inner| inner.status.clone())
            .unwrap_or_else(|_| BluechipStatus {
                message: "The trading agent needs to be restarted.".into(),
                ..BluechipStatus::default()
            })
    }

    fn watch_context(&self) -> (BluechipStatus, Option<BluechipConfig>) {
        self.inner
            .lock()
            .map(|inner| (inner.status.clone(), inner.active_config.clone()))
            .unwrap_or_else(|_| {
                (
                    BluechipStatus {
                        message: "The trading agent needs to be restarted.".into(),
                        ..BluechipStatus::default()
                    },
                    None,
                )
            })
    }

    fn is_active(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .is_ok_and(|inner| inner.generation == generation && inner.status.running)
    }

    fn real_entry_authorized(&self, generation: u64) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            inner.generation == generation
                && inner.status.running
                && inner.status.mode == "real"
                && inner
                    .real_authorized_until
                    .is_some_and(|expiry| expiry > Utc::now())
        })
    }

    fn stop_real_session(&self, generation: u64, message: &str) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.generation != generation || inner.status.mode != "real" {
            return;
        }
        inner.status.running = false;
        inner.status.message = message.into();
        inner.status.next_check_at = None;
        inner.active_config = None;
        inner.real_authorized_until = None;
        if let Some(cancel) = inner.cancel.take() {
            let _ = cancel.send(());
        }
    }

    fn expire_real_authorization(&self, generation: u64) {
        self.stop_real_session(
            generation,
            "Your 24-hour Robinhood permission ended. Review your limits to start again.",
        );
    }

    fn update_after_cycle(&self, generation: u64, message: String) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if inner.generation != generation || !inner.status.running {
            return;
        }
        let now = Utc::now();
        inner.status.message = message;
        inner.status.last_checked_at = Some(now.to_rfc3339());
        inner.status.next_check_at = Some(
            (now + ChronoDuration::seconds(i64::try_from(CYCLE_SECONDS).unwrap_or(900)))
                .to_rfc3339(),
        );
    }

    pub async fn start(
        &self,
        app: AppHandle,
        config: BluechipConfig,
    ) -> Result<BluechipStatus, &'static str> {
        validate_config(&config)?;
        tokio::time::timeout(
            Duration::from_secs(START_PREFLIGHT_TIMEOUT_SECONDS),
            async {
                let vault = app.state::<CredentialVault>();
                let token = current_robinhood_access(vault.inner()).await?;
                let client = RobinhoodAgenticClient::new(token)
                    .map_err(|_| "ROBINHOOD_ACCOUNT_CONNECTION_INVALID")?;
                let mut session = client
                    .trading_session()
                    .await
                    .map_err(|_| "ROBINHOOD_AGENTIC_ACCOUNT_REQUIRED")?;
                let buying_power = session
                    .buying_power()
                    .await
                    .map_err(|_| "ROBINHOOD_ACCOUNT_CHECK_FAILED")?;
                if config.mode == NativeTradingMode::Real {
                    if !license_entries_allowed(
                        app.state::<LicenseGate>().inner(),
                        app.state::<CredentialVault>().inner(),
                    )? {
                        return Err("REAL_TRADING_LICENSE_REQUIRED");
                    }
                    if buying_power < Decimal::ONE {
                        return Err("ADD_FUNDS_TO_ROBINHOOD");
                    }
                    let _ = reconcile_orders(
                        app.state::<Ledger>().inner(),
                        &mut session,
                        &config,
                        ReconcileMode::ReadOnly,
                    )
                    .await?;
                }
                Ok::<(), &'static str>(())
            },
        )
        .await
        .map_err(|_| "ROBINHOOD_CONNECTION_TIMED_OUT")??;

        let (cancel_sender, mut cancel_receiver) = oneshot::channel();
        let generation = {
            let mut inner = self.inner.lock().map_err(|_| "TRADING_AGENT_UNAVAILABLE")?;
            if let Some(cancel) = inner.cancel.take() {
                let _ = cancel.send(());
            }
            inner.generation = inner.generation.saturating_add(1);
            let generation = inner.generation;
            inner.cancel = Some(cancel_sender);
            inner.real_authorized_until = (config.mode == NativeTradingMode::Real)
                .then(|| Utc::now() + ChronoDuration::hours(REAL_AUTHORIZATION_HOURS));
            inner.active_config = Some(config.clone());
            inner.status = BluechipStatus {
                running: true,
                mode: config.mode.as_str(),
                message: match config.mode {
                    NativeTradingMode::Practice => {
                        "Practice started. Bluechip is checking the market now.".into()
                    }
                    NativeTradingMode::Real => {
                        "Real trading started. Bluechip is checking the market now.".into()
                    }
                },
                last_checked_at: None,
                next_check_at: None,
            };
            generation
        };

        record_activity(
            app.state::<Ledger>().inner(),
            &config,
            AgentActivityKind::Started,
            None,
            None,
            if config.mode == NativeTradingMode::Practice {
                "Practice started. No real money will be used."
            } else {
                "Real trading started with your daily and per-trade limits."
            },
        )?;

        let app_for_task = app.clone();
        let config_for_task = config.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let runtime = app_for_task.state::<BluechipRuntime>();
                if !runtime.is_active(generation) {
                    break;
                }
                if config_for_task.mode == NativeTradingMode::Real
                    && !runtime.real_entry_authorized(generation)
                {
                    runtime.expire_real_authorization(generation);
                    let _ = record_activity(
                        app_for_task.state::<Ledger>().inner(),
                        &config_for_task,
                        AgentActivityKind::Paused,
                        None,
                        None,
                        "Your 24-hour Robinhood permission ended. No new trades will start.",
                    );
                    break;
                }
                let message = match run_cycle(&app_for_task, generation, &config_for_task).await {
                    Ok(message) => message,
                    Err(error) => {
                        let plain = plain_cycle_error(error);
                        let _ = record_activity(
                            app_for_task.state::<Ledger>().inner(),
                            &config_for_task,
                            AgentActivityKind::Error,
                            None,
                            None,
                            plain,
                        );
                        if config_for_task.mode == NativeTradingMode::Real {
                            runtime.stop_real_session(generation, plain);
                        }
                        plain.to_string()
                    }
                };
                runtime.update_after_cycle(generation, message);
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(CYCLE_SECONDS)) => {},
                    _ = &mut cancel_receiver => break,
                }
            }
        });

        Ok(self.status())
    }

    pub fn pause(&self, ledger: &Ledger) -> Result<BluechipStatus, &'static str> {
        let (was_running, mode) = {
            let mut inner = self.inner.lock().map_err(|_| "TRADING_AGENT_UNAVAILABLE")?;
            let was_running = inner.status.running;
            let mode = if inner.status.mode == "real" {
                NativeTradingMode::Real
            } else {
                NativeTradingMode::Practice
            };
            inner.generation = inner.generation.saturating_add(1);
            if let Some(cancel) = inner.cancel.take() {
                let _ = cancel.send(());
            }
            inner.real_authorized_until = None;
            inner.active_config = None;
            inner.status = BluechipStatus::default();
            (was_running, mode)
        };
        if was_running {
            record_activity(
                ledger,
                &BluechipConfig {
                    mode,
                    daily_budget_usd: Decimal::ONE,
                    max_per_trade_usd: Decimal::ONE,
                },
                AgentActivityKind::Paused,
                None,
                None,
                "Trading paused. No new trades will start.",
            )?;
        }
        Ok(self.status())
    }
}

async fn run_cycle(
    app: &AppHandle,
    generation: u64,
    config: &BluechipConfig,
) -> Result<String, &'static str> {
    let ledger = app.state::<Ledger>();
    record_activity(
        ledger.inner(),
        config,
        AgentActivityKind::MarketCheck,
        None,
        None,
        "Bluechip is checking eight widely held stocks and funds.",
    )?;

    let token = current_robinhood_access(app.state::<CredentialVault>().inner()).await?;
    let client =
        RobinhoodAgenticClient::new(token).map_err(|_| "ROBINHOOD_ACCOUNT_CONNECTION_INVALID")?;
    let mut session = client
        .trading_session()
        .await
        .map_err(|_| "ROBINHOOD_AGENTIC_ACCOUNT_REQUIRED")?;
    if config.mode == NativeTradingMode::Real {
        let recovery_outcome = reconcile_orders(
            ledger.inner(),
            &mut session,
            config,
            ReconcileMode::Running { app, generation },
        )
        .await?;
        if let Some(outcome) = recovery_outcome {
            return Ok(recovery_cycle_message(outcome).into());
        }
    }

    let buying_power = session
        .buying_power()
        .await
        .map_err(|_| "ROBINHOOD_ACCOUNT_CHECK_FAILED")?;
    let positions = session
        .equity_positions()
        .await
        .map_err(|_| "ROBINHOOD_POSITION_CHECK_FAILED")?;
    let orders = session
        .recent_agentic_orders(Utc::now() - ChronoDuration::days(2))
        .await
        .map_err(|_| "ROBINHOOD_ORDER_CHECK_FAILED")?;
    let quotes = session
        .equity_quotes(&WATCHLIST)
        .await
        .map_err(|_| "ROBINHOOD_QUOTES_UNAVAILABLE")?;

    let held_symbols: HashSet<_> = positions
        .into_iter()
        .filter(|position| position.quantity > Decimal::ZERO)
        .map(|position| position.symbol)
        .collect();
    let pending_symbols: HashSet<_> = orders
        .into_iter()
        .filter(|order| {
            matches!(
                order.state,
                RobinhoodEquityOrderState::Pending
                    | RobinhoodEquityOrderState::PartiallyFilled
                    | RobinhoodEquityOrderState::Unknown
            )
        })
        .map(|order| order.symbol)
        .collect();

    let mut matching_count = 0_usize;
    let mut candidates = Vec::new();
    for quote in quotes {
        if quote.change_percent() > Decimal::new(DIP_THRESHOLD_PERCENT_HUNDREDTHS, 2) {
            continue;
        }
        matching_count = matching_count.saturating_add(1);
        if held_symbols.contains(&quote.symbol) || pending_symbols.contains(&quote.symbol) {
            continue;
        }
        candidates.push(quote);
    }
    candidates.sort_by_key(RobinhoodEquityQuote::change_percent);
    if candidates.is_empty() {
        let message = no_candidate_message(matching_count);
        record_activity(
            ledger.inner(),
            config,
            AgentActivityKind::Skipped,
            None,
            None,
            &message,
        )?;
        return Ok(message);
    }

    if config.mode == NativeTradingMode::Real && !market_is_open(Utc::now()) {
        let message = "Bluechip checked all eight stocks and found a price match, but the regular stock market is closed. It will keep checking and can trade after 9:30 a.m. Eastern on the next trading day.";
        record_activity(
            ledger.inner(),
            config,
            AgentActivityKind::Skipped,
            None,
            None,
            message,
        )?;
        return Ok(message.into());
    }

    let (risk_scope, account_scope, daily_opening_notional) =
        if config.mode == NativeTradingMode::Real {
            let (risk_scope, account_scope) = risk_scopes(app)?;
            let daily_opening_notional = ledger
                .daily_opening_notional_usd(account_scope, Venue::Robinhood, Utc::now())
                .map_err(|_| "TRADING_LIMITS_UNAVAILABLE")?;
            (risk_scope, account_scope, daily_opening_notional)
        } else {
            (Uuid::nil(), Uuid::nil(), Decimal::ZERO)
        };
    let sizing_buying_power = if config.mode == NativeTradingMode::Practice {
        config.max_per_trade_usd
    } else {
        buying_power
    };
    let amount = match trade_amount(config, daily_opening_notional, sizing_buying_power) {
        TradeAmountDecision::Ready(amount) => amount,
        decision => {
            let message = trade_amount_block_message(config, decision);
            record_activity(
                ledger.inner(),
                config,
                AgentActivityKind::Skipped,
                None,
                None,
                &message,
            )?;
            return Ok(message);
        }
    };

    let mut placement_calls = 0_usize;
    let mut last_skip_message = None;
    for quote in candidates {
        let symbol = quote.symbol.clone();
        let reviewed = match session.review_market_buy(&symbol, amount).await {
            Ok(reviewed) => reviewed,
            Err(RobinhoodMcpError::InvalidOrder) => {
                let message = format!(
                    "Robinhood could not review the {symbol} trade. Bluechip skipped it and will check any other matching stocks. It will retry {symbol} with fresh market data in 15 minutes."
                );
                record_activity(
                    ledger.inner(),
                    config,
                    AgentActivityKind::Skipped,
                    Some(symbol.as_str()),
                    Some(amount),
                    &message,
                )?;
                last_skip_message = Some(message);
                continue;
            }
            Err(_) => return Err("ROBINHOOD_ORDER_REVIEW_FAILED"),
        };
        if !quote_is_fresh(&reviewed.quote, Utc::now()) {
            let message = format!(
                "{symbol} matched, but its latest price was too old to use. Bluechip skipped it and will check any other matches. It will retry all eight stocks in 15 minutes."
            );
            record_activity(
                ledger.inner(),
                config,
                AgentActivityKind::Skipped,
                Some(symbol.as_str()),
                None,
                &message,
            )?;
            last_skip_message = Some(message);
            continue;
        }
        let signal_message = format!(
            "{} is {:.2}% below its previous close and matched Bluechip's rule.",
            symbol,
            reviewed.quote.change_percent()
        );
        record_activity(
            ledger.inner(),
            config,
            AgentActivityKind::Signal,
            Some(symbol.as_str()),
            Some(amount),
            &signal_message,
        )?;

        if config.mode == NativeTradingMode::Practice {
            let message = format!(
                "Practice only: Bluechip would buy {} of {}. No order was placed.",
                money(amount),
                symbol
            );
            record_activity(
                ledger.inner(),
                config,
                AgentActivityKind::Reviewed,
                Some(symbol.as_str()),
                Some(amount),
                &message,
            )?;
            return Ok(format!(
                "Practice check finished. Bluechip found one possible {} {} trade. No order was placed.",
                money(amount),
                symbol
            ));
        }
        if !app
            .state::<BluechipRuntime>()
            .real_entry_authorized(generation)
        {
            app.state::<BluechipRuntime>()
                .expire_real_authorization(generation);
            return Ok("Trading was paused before any new order was sent.".into());
        }
        let entries_allowed = license_entries_allowed(
            app.state::<LicenseGate>().inner(),
            app.state::<CredentialVault>().inner(),
        )?;
        let safety = SafetyState {
            global_kill_switch: false,
            venue_paused: false,
            strategy_enabled: true,
            venue_eligible: true,
            connector_healthy: true,
            market_data_fresh: true,
            license_allows_entries: entries_allowed,
        };
        ledger
            .update_safety_state(
                risk_scope,
                account_scope,
                Venue::Robinhood,
                &safety,
                Utc::now(),
            )
            .map_err(|_| "TRADING_LIMITS_UNAVAILABLE")?;
        let source_event_id = format!(
            "bluechip:{}:{}",
            symbol,
            reviewed.quote.venue_last_trade_time.to_rfc3339()
        );
        let intent_id = deterministic_intent_id(IntentIdentity {
            source_event_id: &source_event_id,
            strategy_id: STRATEGY_ID,
            venue: Venue::Robinhood,
            instrument: &symbol,
            side: OrderSide::Buy,
            purpose: IntentPurpose::Open,
        });
        let now = Utc::now();
        let intent = TradeIntent {
            intent_id,
            source_event_id,
            strategy_id: STRATEGY_ID.into(),
            venue: Venue::Robinhood,
            risk_scope,
            account_scope,
            instrument: symbol.clone(),
            side: OrderSide::Buy,
            order_type: OrderType::Market,
            purpose: IntentPurpose::Open,
            notional_usd: amount,
            limit_price: None,
            prediction: None,
            signal_at: now,
            expires_at: now + ChronoDuration::minutes(2),
            rationale: format!(
                "{} was {:.2}% below its previous close.",
                symbol,
                reviewed.quote.change_percent()
            ),
        };
        let policy = risk_policy(config);
        match ledger
            .reserve(intent, &policy)
            .map_err(|_| "TRADING_LIMITS_UNAVAILABLE")?
        {
            ReservationOutcome::Duplicate => {
                last_skip_message = Some(
                    "Bluechip already reviewed this matching price update. It will check any other matches and use fresh prices again in 15 minutes."
                        .into(),
                );
                continue;
            }
            ReservationOutcome::Rejected(reason) => {
                let disposition = risk_rejection_disposition(reason);
                let message = risk_rejection_message(reason);
                record_activity(
                    ledger.inner(),
                    config,
                    if disposition == RiskRejectionDisposition::StopReal {
                        AgentActivityKind::Error
                    } else {
                        AgentActivityKind::Skipped
                    },
                    Some(symbol.as_str()),
                    Some(amount),
                    message,
                )?;
                match disposition {
                    RiskRejectionDisposition::ContinueCandidate => {
                        last_skip_message = Some(message.into());
                        continue;
                    }
                    RiskRejectionDisposition::EndCycle => return Ok(message.into()),
                    RiskRejectionDisposition::StopReal => {
                        app.state::<BluechipRuntime>()
                            .stop_real_session(generation, message);
                        return Ok(message.into());
                    }
                }
            }
            ReservationOutcome::Reserved(_) => {}
        }
        if !app
            .state::<BluechipRuntime>()
            .real_entry_authorized(generation)
        {
            app.state::<BluechipRuntime>()
                .expire_real_authorization(generation);
            ledger
                .reject_reserved_open_and_restore_budget(
                    intent_id,
                    "authorization_ended_before_submission",
                )
                .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
            return Ok(
                "Your 24-hour Robinhood permission ended before any new order was sent.".into(),
            );
        }
        let fingerprint = request_fingerprint(intent_id, &symbol, amount);
        ledger
            .begin_submission(intent_id, Uuid::new_v4(), &fingerprint)
            .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
        let runtime = app.state::<BluechipRuntime>();
        let authorization_current = runtime.real_entry_authorized(generation);
        let license_current = license_entries_allowed(
            app.state::<LicenseGate>().inner(),
            app.state::<CredentialVault>().inner(),
        )?;
        if !authorization_current || !license_current {
            if authorization_current {
                runtime.stop_real_session(
                    generation,
                    "Your DayTradingBot access needs to be renewed. No new trade was sent.",
                );
            } else {
                runtime.expire_real_authorization(generation);
            }
            ledger
                .reject_open_submission_and_restore_budget(intent_id, "paused_before_submission")
                .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
            return Ok("Trading was paused before any new order was sent.".into());
        }

        if !claim_placement_call(config.mode, &mut placement_calls) {
            ledger
                .reject_open_submission_and_restore_budget(intent_id, "placement_mode_blocked")
                .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
            return Err("ORDER_SUBMISSION_BLOCKED");
        }
        match session.place_reviewed_market_buy(reviewed, intent_id).await {
            Ok(placement) => {
                if ledger
                    .acknowledge_submission(intent_id, &placement.order_id)
                    .is_err()
                {
                    let _ = record_activity(
                        ledger.inner(),
                        config,
                        AgentActivityKind::Error,
                        Some(symbol.as_str()),
                        Some(amount),
                        ACCEPTED_PLACEMENT_LOCAL_RECORD_ACTIVITY,
                    );
                    return Err("ORDER_ACCEPTED_LOCAL_RECORD_FAILED");
                }
                let message = format!(
                    "Bluechip sent a {} {} buy to Robinhood.",
                    money(amount),
                    symbol
                );
                if record_activity(
                    ledger.inner(),
                    config,
                    AgentActivityKind::OrderSubmitted,
                    Some(symbol.as_str()),
                    Some(amount),
                    &message,
                )
                .is_err()
                {
                    return Err("ORDER_ACCEPTED_LOCAL_RECORD_FAILED");
                }
                if let Ok(Some(order)) = session.equity_order(&placement.order_id).await
                    && settle_order(ledger.inner(), config, intent_id, &order).is_err()
                {
                    let _ = record_activity(
                        ledger.inner(),
                        config,
                        AgentActivityKind::Error,
                        Some(symbol.as_str()),
                        Some(amount),
                        ACCEPTED_PLACEMENT_LOCAL_RECORD_ACTIVITY,
                    );
                    return Err("ORDER_ACCEPTED_LOCAL_RECORD_FAILED");
                }
                return Ok("Market check finished. 1 order sent to Robinhood.".into());
            }
            Err(RobinhoodPlacementError::Rejected) => {
                if ledger
                    .reject_open_submission_and_restore_budget(intent_id, "robinhood_rejected")
                    .is_err()
                {
                    return Err("ORDER_REJECTED_LOCAL_RECORD_FAILED");
                }
                let message = "Robinhood did not accept this trade. No order was opened, and the amount remains available within today's limit. Bluechip will try fresh matches again in 15 minutes.";
                if record_activity(
                    ledger.inner(),
                    config,
                    AgentActivityKind::Skipped,
                    Some(symbol.as_str()),
                    Some(amount),
                    message,
                )
                .is_err()
                {
                    return Err("ORDER_REJECTED_LOCAL_RECORD_FAILED");
                }
                return Ok(message.into());
            }
            Err(RobinhoodPlacementError::Unknown) => {
                let _ = ledger.mark_submission_unknown(intent_id, "robinhood_response_unknown");
                let _ = record_activity(
                    ledger.inner(),
                    config,
                    AgentActivityKind::Error,
                    Some(symbol.as_str()),
                    Some(amount),
                    UNCERTAIN_PLACEMENT_ACTIVITY,
                );
                return Err("ORDER_PLACEMENT_RESPONSE_UNCERTAIN");
            }
        }
    }

    Ok(last_skip_message.unwrap_or_else(|| {
        "Bluechip checked every matching stock, but none could be used safely this time. It will check all eight again in 15 minutes."
            .into()
    }))
}

async fn reconcile_orders(
    ledger: &Ledger,
    session: &mut RobinhoodTradingSession<'_>,
    config: &BluechipConfig,
    mode: ReconcileMode<'_>,
) -> Result<Option<RecoveryOutcome>, &'static str> {
    let attempts = ledger
        .unresolved_submissions()
        .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
    for attempt in &attempts {
        match attempt.state {
            SubmissionAttemptState::Acknowledged => {
                let Some(order_id) = attempt.venue_order_id.as_deref() else {
                    return Err("ORDER_RECONCILIATION_REQUIRED");
                };
                let order = session
                    .equity_order(order_id)
                    .await
                    .map_err(|_| "ROBINHOOD_ORDER_CHECK_FAILED")?
                    .ok_or("ORDER_RECONCILIATION_REQUIRED")?;
                settle_order(ledger, config, attempt.intent_id, &order)?;
            }
            SubmissionAttemptState::Submitting => {
                ledger
                    .mark_submission_unknown(attempt.intent_id, "recovered_after_restart")
                    .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
            }
            SubmissionAttemptState::Unknown => {}
            SubmissionAttemptState::Quarantined => {
                return Err("ORDER_RECONCILIATION_REQUIRED");
            }
            SubmissionAttemptState::Reconciled => {}
        }
    }

    let ReconcileMode::Running { app, generation } = mode else {
        return Ok(None);
    };
    let Some(attempt) = first_recovery_candidate(&attempts) else {
        return Ok(None);
    };

    // A recovery uses Robinhood's real placement endpoint, even though the
    // persisted ref_id makes it idempotent. End this cycle after exactly one
    // such call so multiple unresolved records can never fan out into multiple
    // placement calls.
    recover_unknown_order(ledger, session, config, attempt, app, generation)
        .await
        .map(Some)
}

fn first_recovery_candidate(
    attempts: &[daytradingbot_ledger::SubmissionAttemptRecord],
) -> Option<&daytradingbot_ledger::SubmissionAttemptRecord> {
    attempts.iter().find(|attempt| {
        matches!(
            attempt.state,
            SubmissionAttemptState::Submitting | SubmissionAttemptState::Unknown
        )
    })
}

#[derive(Clone, Copy)]
enum ReconcileMode<'a> {
    ReadOnly,
    Running { app: &'a AppHandle, generation: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecoveryOutcome {
    Acknowledged,
    Rejected,
}

fn recovery_cycle_message(outcome: RecoveryOutcome) -> &'static str {
    match outcome {
        RecoveryOutcome::Acknowledged => {
            "Robinhood found the earlier order. Bluechip recorded its current status and will wait until the next market check before considering another trade."
        }
        RecoveryOutcome::Rejected => {
            "Robinhood confirmed the earlier order was not accepted. No order was opened. Bluechip will wait until the next market check before considering another trade."
        }
    }
}

/// Robinhood documents `ref_id` as an upstream idempotency key: sending the
/// same logical order with the same UUID returns the original order instead of
/// creating a second one. That is the only retry permitted here, and every
/// immutable field is reconstructed from the durable local reservation.
async fn recover_unknown_order(
    ledger: &Ledger,
    session: &mut RobinhoodTradingSession<'_>,
    config: &BluechipConfig,
    attempt: &daytradingbot_ledger::SubmissionAttemptRecord,
    app: &AppHandle,
    generation: u64,
) -> Result<RecoveryOutcome, &'static str> {
    let ref_id = validate_recovery_attempt(attempt, config)?;
    require_recovery_authorization(app, generation, config)?;
    let buying_power = session
        .buying_power()
        .await
        .map_err(|_| "ROBINHOOD_ACCOUNT_CHECK_FAILED")?;
    if buying_power < attempt.notional_usd {
        return Err("ADD_FUNDS_TO_ROBINHOOD");
    }
    let reviewed = session
        .review_market_buy(&attempt.instrument, attempt.notional_usd)
        .await
        .map_err(|_| "ROBINHOOD_ORDER_RECOVERY_FAILED")?;
    if !quote_is_fresh(&reviewed.quote, Utc::now()) {
        return Err("ROBINHOOD_ORDER_RECOVERY_QUOTE_STALE");
    }
    require_recovery_authorization(app, generation, config)?;
    match session.place_reviewed_market_buy(reviewed, ref_id).await {
        Ok(placement) => {
            if ledger
                .acknowledge_unknown_submission(attempt.intent_id, &placement.order_id)
                .is_err()
            {
                let _ = record_activity(
                    ledger,
                    config,
                    AgentActivityKind::Error,
                    Some(attempt.instrument.as_str()),
                    Some(attempt.notional_usd),
                    ACCEPTED_PLACEMENT_LOCAL_RECORD_ACTIVITY,
                );
                return Err("ORDER_ACCEPTED_LOCAL_RECORD_FAILED");
            }
            let order = match session.equity_order(&placement.order_id).await {
                Ok(Some(order)) => order,
                Ok(None) | Err(_) => return Err("ORDER_ACCEPTED_LOCAL_RECORD_FAILED"),
            };
            if settle_order(ledger, config, attempt.intent_id, &order).is_err()
                || record_recovered_order_activity(ledger, config, attempt, &order).is_err()
            {
                let _ = record_activity(
                    ledger,
                    config,
                    AgentActivityKind::Error,
                    Some(attempt.instrument.as_str()),
                    Some(attempt.notional_usd),
                    ACCEPTED_PLACEMENT_LOCAL_RECORD_ACTIVITY,
                );
                return Err("ORDER_ACCEPTED_LOCAL_RECORD_FAILED");
            }
            Ok(RecoveryOutcome::Acknowledged)
        }
        Err(RobinhoodPlacementError::Rejected) => {
            if ledger
                .reject_unknown_open_submission(attempt.intent_id, "idempotent_recovery_rejected")
                .is_err()
            {
                return Err("ORDER_REJECTED_LOCAL_RECORD_FAILED");
            }
            if record_activity(
                ledger,
                config,
                AgentActivityKind::Skipped,
                Some(attempt.instrument.as_str()),
                None,
                "Robinhood confirmed the earlier order was not accepted. No order was opened.",
            )
            .is_err()
            {
                return Err("ORDER_REJECTED_LOCAL_RECORD_FAILED");
            }
            Ok(RecoveryOutcome::Rejected)
        }
        Err(RobinhoodPlacementError::Unknown) => {
            let _ = record_activity(
                ledger,
                config,
                AgentActivityKind::Error,
                Some(attempt.instrument.as_str()),
                Some(attempt.notional_usd),
                UNCERTAIN_PLACEMENT_ACTIVITY,
            );
            Err("ORDER_PLACEMENT_RESPONSE_UNCERTAIN")
        }
    }
}

fn record_recovered_order_activity(
    ledger: &Ledger,
    config: &BluechipConfig,
    attempt: &daytradingbot_ledger::SubmissionAttemptRecord,
    order: &RobinhoodEquityOrder,
) -> Result<(), &'static str> {
    let (kind, message) = recovered_order_activity(order.state);
    record_activity(
        ledger,
        config,
        kind,
        Some(attempt.instrument.as_str()),
        None,
        message,
    )
}

fn recovered_order_activity(state: RobinhoodEquityOrderState) -> (AgentActivityKind, &'static str) {
    match state {
        RobinhoodEquityOrderState::Pending => (
            AgentActivityKind::OrderSubmitted,
            "Robinhood found the earlier order. It is waiting to be filled.",
        ),
        RobinhoodEquityOrderState::PartiallyFilled => (
            AgentActivityKind::OrderSubmitted,
            "Robinhood found the earlier order. It is partially filled and remains open.",
        ),
        RobinhoodEquityOrderState::Filled => (
            AgentActivityKind::OrderSubmitted,
            "Robinhood found the earlier order and reports it as filled.",
        ),
        RobinhoodEquityOrderState::Canceled => (
            AgentActivityKind::Skipped,
            "Robinhood found the earlier order and reports it as canceled.",
        ),
        RobinhoodEquityOrderState::Rejected => (
            AgentActivityKind::Skipped,
            "Robinhood found the earlier order and reports it as rejected. No order remains open.",
        ),
        RobinhoodEquityOrderState::Unknown => (
            AgentActivityKind::OrderSubmitted,
            "Robinhood found the earlier order, but its current status is still updating.",
        ),
    }
}

fn require_recovery_authorization(
    app: &AppHandle,
    generation: u64,
    config: &BluechipConfig,
) -> Result<(), &'static str> {
    if config.mode != NativeTradingMode::Real
        || !market_is_open(Utc::now())
        || !app
            .state::<BluechipRuntime>()
            .real_entry_authorized(generation)
        || !license_entries_allowed(
            app.state::<LicenseGate>().inner(),
            app.state::<CredentialVault>().inner(),
        )?
    {
        return Err("ORDER_RECOVERY_NOT_AUTHORIZED");
    }
    Ok(())
}

fn validate_recovery_attempt(
    attempt: &daytradingbot_ledger::SubmissionAttemptRecord,
    config: &BluechipConfig,
) -> Result<Uuid, &'static str> {
    let ref_id =
        Uuid::parse_str(&attempt.client_order_id).map_err(|_| "ORDER_RECONCILIATION_REQUIRED")?;
    if config.mode != NativeTradingMode::Real
        || ref_id != attempt.intent_id
        || !WATCHLIST.contains(&attempt.instrument.as_str())
        || attempt.notional_usd < Decimal::ONE
        || attempt.notional_usd > config.max_per_trade_usd
        || attempt.notional_usd > config.daily_budget_usd
        || request_fingerprint(attempt.intent_id, &attempt.instrument, attempt.notional_usd)
            != attempt.request_fingerprint
    {
        return Err("ORDER_RECONCILIATION_REQUIRED");
    }
    Ok(ref_id)
}

fn settle_order(
    ledger: &Ledger,
    config: &BluechipConfig,
    intent_id: Uuid,
    order: &RobinhoodEquityOrder,
) -> Result<(), &'static str> {
    for execution in &order.executions {
        let notional = execution.quantity * execution.price;
        let outcome = ledger
            .record_open_fill(
                intent_id,
                &FillRecord {
                    venue_fill_id: execution.execution_id.clone(),
                    quantity: execution.quantity,
                    price: execution.price,
                    notional,
                    fee: execution.fee,
                    filled_at: execution.executed_at,
                },
            )
            .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
        if outcome == FillOutcome::Recorded {
            let message = format!(
                "Robinhood filled {} of the {} trade.",
                money(notional),
                order.symbol
            );
            record_activity(
                ledger,
                config,
                AgentActivityKind::Filled,
                Some(order.symbol.as_str()),
                Some(notional),
                &message,
            )?;
        }
    }
    let terminal = match order.state {
        RobinhoodEquityOrderState::Filled => Some(OrderState::Filled),
        RobinhoodEquityOrderState::Canceled => Some(OrderState::Canceled),
        RobinhoodEquityOrderState::Rejected => Some(OrderState::Rejected),
        RobinhoodEquityOrderState::Pending
        | RobinhoodEquityOrderState::PartiallyFilled
        | RobinhoodEquityOrderState::Unknown => None,
    };
    if let Some(terminal) = terminal {
        ledger
            .finalize_acknowledged_open_order(intent_id, terminal)
            .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
    }
    Ok(())
}

fn validate_config(config: &BluechipConfig) -> Result<(), &'static str> {
    if config.daily_budget_usd < Decimal::ONE || config.daily_budget_usd > Decimal::new(2_500, 2) {
        return Err("DAILY_BUDGET_MUST_BE_BETWEEN_1_AND_25");
    }
    if config.max_per_trade_usd < Decimal::ONE
        || config.max_per_trade_usd > Decimal::new(500, 2)
        || config.max_per_trade_usd > config.daily_budget_usd
    {
        return Err("TRADE_LIMIT_MUST_BE_BETWEEN_1_AND_5");
    }
    RiskEngine::new()
        .validate_customer_policy(&risk_policy(config))
        .map_err(|_| "TRADING_LIMITS_INVALID")
}

pub fn decimal_from_customer_amount(value: f64) -> Result<Decimal, &'static str> {
    if !value.is_finite() {
        return Err("TRADING_LIMIT_INVALID");
    }
    Decimal::from_str(&format!("{value:.2}")).map_err(|_| "TRADING_LIMIT_INVALID")
}

fn risk_policy(config: &BluechipConfig) -> RiskPolicy {
    let platform_maximums = RiskPolicy::default();
    RiskPolicy {
        max_opening_order_usd: config.max_per_trade_usd,
        max_daily_opening_notional_usd: config.daily_budget_usd,
        max_venue_exposure_usd: (config.daily_budget_usd * Decimal::from(4_u8))
            .min(platform_maximums.max_venue_exposure_usd),
        max_global_exposure_usd: (config.daily_budget_usd * Decimal::from(5_u8))
            .min(platform_maximums.max_global_exposure_usd),
        max_daily_loss_usd: config
            .daily_budget_usd
            .min(platform_maximums.max_daily_loss_usd),
        max_resting_entry_orders: 2,
    }
}

fn trade_amount(
    config: &BluechipConfig,
    daily_opening_notional: Decimal,
    buying_power: Decimal,
) -> TradeAmountDecision {
    let remaining_daily_budget =
        (config.daily_budget_usd - daily_opening_notional).max(Decimal::ZERO);
    if remaining_daily_budget < Decimal::ONE {
        return TradeAmountDecision::DailyRemainderBelowMinimum(remaining_daily_budget);
    }
    let available_buying_power = buying_power.max(Decimal::ZERO);
    if available_buying_power < Decimal::ONE {
        return TradeAmountDecision::BuyingPowerBelowMinimum(available_buying_power);
    }
    TradeAmountDecision::Ready(
        config
            .max_per_trade_usd
            .min(remaining_daily_budget)
            .min(available_buying_power),
    )
}

fn trade_amount_block_message(config: &BluechipConfig, decision: TradeAmountDecision) -> String {
    match decision {
        TradeAmountDecision::Ready(_) => {
            "Bluechip found an available trade amount and will continue checking.".into()
        }
        TradeAmountDecision::DailyRemainderBelowMinimum(remaining)
            if remaining == Decimal::ZERO =>
        {
            format!(
                "Your {} daily limit is fully used. Bluechip will start fresh on the next trading day. To change it, pause trading and open Setup.",
                money(config.daily_budget_usd)
            )
        }
        TradeAmountDecision::DailyRemainderBelowMinimum(remaining) => format!(
            "{} remains in today's limit, below Robinhood's $1.00 minimum. Bluechip will start fresh on the next trading day. To use more today, pause trading and raise the daily limit in Setup.",
            money(remaining)
        ),
        TradeAmountDecision::BuyingPowerBelowMinimum(available) => format!(
            "Robinhood has {} of available buying power, below its $1.00 minimum. Add money or free up buying power in the Agentic account, then Bluechip will retry when you start it again.",
            money(available)
        ),
    }
}

fn no_candidate_message(matching_count: usize) -> String {
    if matching_count == 0 {
        return "Bluechip checked all eight stocks. None is down at least 1.50% today, so it did not force a trade. It will check again in 15 minutes."
            .into();
    }
    let noun = if matching_count == 1 {
        "price match"
    } else {
        "price matches"
    };
    format!(
        "Bluechip checked all eight stocks and found {matching_count} {noun}, but each is already owned or has an open Robinhood order. It will check again in 15 minutes."
    )
}

fn quote_is_fresh(quote: &RobinhoodEquityQuote, now: DateTime<Utc>) -> bool {
    let age = now.signed_duration_since(quote.venue_last_trade_time);
    age >= ChronoDuration::seconds(-30) && age <= ChronoDuration::minutes(5)
}

fn market_is_open(now: DateTime<Utc>) -> bool {
    let eastern = now.with_timezone(&New_York);
    if matches!(eastern.weekday(), Weekday::Sat | Weekday::Sun) {
        return false;
    }
    let minute = eastern.hour() * 60 + eastern.minute();
    (9 * 60 + 30..16 * 60).contains(&minute)
}

fn request_fingerprint(intent_id: Uuid, symbol: &str, amount: Decimal) -> String {
    let canonical = format!(
        "{intent_id}|{symbol}|buy|market|{}|gfd|regular",
        money(amount)
    );
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

fn placement_call_allowed(mode: NativeTradingMode, submitted: usize) -> bool {
    mode == NativeTradingMode::Real && submitted < MAX_TRADES_PER_CYCLE
}

fn claim_placement_call(mode: NativeTradingMode, placement_calls: &mut usize) -> bool {
    if !placement_call_allowed(mode, *placement_calls) {
        return false;
    }
    *placement_calls = placement_calls.saturating_add(1);
    true
}

fn risk_scopes(app: &AppHandle) -> Result<(Uuid, Uuid), &'static str> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "TRADING_HISTORY_UNAVAILABLE")?;
    let risk_scope = Uuid::new_v5(&Uuid::NAMESPACE_URL, app_data.to_string_lossy().as_bytes());
    let account_scope = Uuid::new_v5(&risk_scope, b"robinhood-agentic-account");
    Ok((risk_scope, account_scope))
}

pub(crate) fn license_entries_allowed(
    gate: &LicenseGate,
    vault: &CredentialVault,
) -> Result<bool, &'static str> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(i64::MAX, |duration| {
            i64::try_from(duration.as_secs()).unwrap_or(i64::MAX)
        });
    let trusted_floor = vault
        .load_optional(VaultKey::LicenseLastTrustedTime)
        .map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?
        .and_then(|value| std::str::from_utf8(&value).ok()?.parse::<i64>().ok())
        .unwrap_or(now);
    let floor_to_store = now.max(trusted_floor);
    vault
        .store(
            VaultKey::LicenseLastTrustedTime,
            floor_to_store.to_string().as_bytes(),
        )
        .map_err(|_| "LICENSE_STORAGE_UNAVAILABLE")?;
    Ok(gate.entries_allowed(now, trusted_floor))
}

fn record_activity(
    ledger: &Ledger,
    config: &BluechipConfig,
    kind: AgentActivityKind,
    symbol: Option<&str>,
    amount_usd: Option<Decimal>,
    message: &str,
) -> Result<(), &'static str> {
    ledger
        .record_agent_activity(&NewAgentActivity {
            agent_id: AGENT_ID.into(),
            mode: config.mode.activity_mode(),
            kind,
            symbol: symbol.map(str::to_owned),
            amount_usd,
            message: message.into(),
            occurred_at: Utc::now(),
        })
        .map(|_| ())
        .map_err(|_| "TRADING_HISTORY_UNAVAILABLE")
}

fn risk_rejection_disposition(reason: RiskRejection) -> RiskRejectionDisposition {
    match reason {
        RiskRejection::IntentExpired
        | RiskRejection::MarketDataStale
        | RiskRejection::ExistingOwnedLot => RiskRejectionDisposition::ContinueCandidate,
        RiskRejection::DailyOpeningLimitExceeded
        | RiskRejection::VenueExposureLimitExceeded
        | RiskRejection::GlobalExposureLimitExceeded
        | RiskRejection::DailyLossStopReached
        | RiskRejection::RestingEntryLimitExceeded => RiskRejectionDisposition::EndCycle,
        RiskRejection::PolicyInvalid
        | RiskRejection::InvalidNotional
        | RiskRejection::ConnectorUnhealthy
        | RiskRejection::KillSwitchActive
        | RiskRejection::VenuePaused
        | RiskRejection::StrategyDisabled
        | RiskRejection::VenueIneligible
        | RiskRejection::LicenseDisallowsEntry
        | RiskRejection::OrderLimitExceeded
        | RiskRejection::MissingOwnedLot
        | RiskRejection::ReduceExceedsOwnedLot
        | RiskRejection::ReduceWrongSide
        | RiskRejection::InvalidPredictionOrder => RiskRejectionDisposition::StopReal,
    }
}

fn risk_rejection_message(reason: RiskRejection) -> &'static str {
    match reason {
        RiskRejection::PolicyInvalid => {
            "Your saved limits could not be used, so Real trading stopped. Open Setup, choose $1–$25 per day and $1–$5 per trade, then start again."
        }
        RiskRejection::InvalidNotional | RiskRejection::OrderLimitExceeded => {
            "Bluechip found an invalid trade amount, so Real trading stopped. Open Setup to review your limits before starting again."
        }
        RiskRejection::IntentExpired => {
            "This price moved before the trade was ready. Bluechip skipped it and will check any other matches. It will use fresh prices again in 15 minutes."
        }
        RiskRejection::ConnectorUnhealthy => {
            "Robinhood stopped responding, so Real trading stopped. Open Accounts, check the connection, then start trading again."
        }
        RiskRejection::KillSwitchActive
        | RiskRejection::VenuePaused
        | RiskRejection::StrategyDisabled => {
            "Real trading stopped because a safety setting is paused. Check Home and Accounts, then start Bluechip again when everything is ready."
        }
        RiskRejection::VenueIneligible => {
            "Real trading stopped because this Robinhood account is not ready for a new Bluechip trade. Open Accounts to check the connection and Agentic account."
        }
        RiskRejection::DailyOpeningLimitExceeded => {
            "Your daily limit is already used. Bluechip will start fresh on the next trading day. To change it, pause trading and open Setup."
        }
        RiskRejection::ExistingOwnedLot => {
            "Bluechip already owns this stock, so it skipped it and will check any other matches. It will try again in 15 minutes."
        }
        RiskRejection::RestingEntryLimitExceeded => {
            "Two Robinhood orders are still open. Bluechip will check them again and retry automatically."
        }
        RiskRejection::LicenseDisallowsEntry => {
            "Real trading stopped because your app activation or 24-hour trading permission needs attention. Return to Home and review Real trading again."
        }
        RiskRejection::MarketDataStale => {
            "The latest price was too old to use. Bluechip skipped it and will check any other matches. It will retry all eight stocks in 15 minutes."
        }
        RiskRejection::VenueExposureLimitExceeded | RiskRejection::GlobalExposureLimitExceeded => {
            "Your open Bluechip positions already use the current built-in allowance. Bluechip will retry automatically after room becomes available."
        }
        RiskRejection::DailyLossStopReached => {
            "Bluechip's built-in loss protection stopped new trades for today. It will reset on the next trading day."
        }
        RiskRejection::MissingOwnedLot
        | RiskRejection::ReduceExceedsOwnedLot
        | RiskRejection::ReduceWrongSide
        | RiskRejection::InvalidPredictionOrder => {
            "Real trading stopped because this trade did not match the account position Bluechip expected. Check Activity before starting again."
        }
    }
}

fn plain_cycle_error(error: &'static str) -> &'static str {
    match error {
        "ORDER_ACCEPTED_LOCAL_RECORD_FAILED" => ACCEPTED_PLACEMENT_LOCAL_RECORD_ACTIVITY,
        "ORDER_PLACEMENT_RESPONSE_UNCERTAIN" => UNCERTAIN_PLACEMENT_ACTIVITY,
        "ORDER_REJECTED_LOCAL_RECORD_FAILED" => {
            "Robinhood rejected this trade, but the app could not finish saving the result. Real trading stopped. Check Robinhood and Activity before starting again."
        }
        "ORDER_RECONCILIATION_REQUIRED" => {
            "One earlier Robinhood order needs to be checked before Bluechip can trade again."
        }
        "REAL_TRADING_LICENSE_REQUIRED" => {
            "Real trading authorization is not current. Bluechip did not place an order."
        }
        "ROBINHOOD_AUTHENTICATION_EXPIRED" => {
            "Robinhood needs to be reconnected before Bluechip can continue."
        }
        "ADD_FUNDS_TO_ROBINHOOD" => {
            "Robinhood needs at least $1.00 of available buying power. Add money or free up buying power, then start Bluechip again."
        }
        "TRADING_LIMITS_UNAVAILABLE" | "TRADING_LIMITS_INVALID" => {
            "Bluechip could not read your saved limits. Real trading stopped before any order was sent. Open Setup, choose the limits again, then restart."
        }
        "ROBINHOOD_QUOTES_UNAVAILABLE"
        | "ROBINHOOD_POSITION_CHECK_FAILED"
        | "ROBINHOOD_ORDER_CHECK_FAILED"
        | "ROBINHOOD_ACCOUNT_CHECK_FAILED" => {
            "Robinhood account or market data was unavailable. Real trading stopped before any order was sent. Check Accounts, then start again."
        }
        "ROBINHOOD_ORDER_REVIEW_FAILED" => {
            "Robinhood could not price the matched trade. Real trading stopped before any order was sent. Check Accounts, then start again."
        }
        "ROBINHOOD_ORDER_RECOVERY_QUOTE_STALE" => {
            "An earlier trade needs a fresh Robinhood price before it can be checked. Real trading stopped; start again after prices update."
        }
        _ => {
            "Bluechip could not finish this market check. Real trading stopped before any new order was sent. Check Activity, then start again."
        }
    }
}

fn money(amount: Decimal) -> String {
    format!("${amount:.2}")
}

#[derive(Serialize)]
pub struct ActivityItem {
    id: String,
    agent_id: String,
    mode: &'static str,
    kind: &'static str,
    recorded_order_state: Option<&'static str>,
    symbol: Option<String>,
    amount_usd: Option<String>,
    message: String,
    occurred_at: String,
}

fn activity_item(record: AgentActivityRecord) -> ActivityItem {
    let recorded_order_state = activity_order_state(&record);
    ActivityItem {
        id: record.event_id.to_string(),
        agent_id: record.agent_id,
        mode: match record.mode {
            AgentActivityMode::Practice => "practice",
            AgentActivityMode::Real => "real",
        },
        kind: match record.kind {
            AgentActivityKind::Started => "started",
            AgentActivityKind::Paused => "paused",
            AgentActivityKind::MarketCheck => "market_check",
            AgentActivityKind::Signal => "signal",
            AgentActivityKind::Skipped => "skipped",
            AgentActivityKind::Reviewed => "reviewed",
            AgentActivityKind::OrderSubmitted => "order_submitted",
            AgentActivityKind::Filled => "filled",
            AgentActivityKind::Error => "error",
        },
        recorded_order_state,
        symbol: record.symbol,
        amount_usd: record.amount_usd.map(|amount| format!("{amount:.2}")),
        message: record.message,
        occurred_at: record.occurred_at.to_rfc3339(),
    }
}

fn activity_order_state(record: &AgentActivityRecord) -> Option<&'static str> {
    match record.kind {
        AgentActivityKind::Reviewed if record.mode == AgentActivityMode::Practice => {
            Some("practice_review")
        }
        AgentActivityKind::OrderSubmitted => match record.message.as_str() {
            "Robinhood found the earlier order. It is waiting to be filled." => Some("pending"),
            "Robinhood found the earlier order. It is partially filled and remains open." => {
                Some("partially_filled")
            }
            "Robinhood found the earlier order and reports it as filled." => Some("filled"),
            "Robinhood found the earlier order, but its current status is still updating." => {
                Some("unknown")
            }
            _ => Some("submitted"),
        },
        AgentActivityKind::Filled => Some("filled"),
        AgentActivityKind::Skipped => match record.message.as_str() {
            "Robinhood found the earlier order and reports it as canceled." => Some("canceled"),
            "Robinhood found the earlier order and reports it as rejected. No order remains open."
            | "Robinhood did not accept this trade. No order was opened, and the amount remains available within today's limit. Bluechip will try fresh matches again in 15 minutes." => {
                Some("rejected")
            }
            _ => None,
        },
        AgentActivityKind::Error
            if matches!(
                record.message.as_str(),
                UNCERTAIN_PLACEMENT_ACTIVITY | ACCEPTED_PLACEMENT_LOCAL_RECORD_ACTIVITY
            ) =>
        {
            Some("unknown")
        }
        _ => None,
    }
}

#[tauri::command]
pub fn recent_trading_activity(
    ledger: tauri::State<'_, Ledger>,
) -> Result<Vec<ActivityItem>, &'static str> {
    ledger
        .recent_agent_activity(100)
        .map(|items| items.into_iter().map(activity_item).collect())
        .map_err(|_| "TRADING_HISTORY_UNAVAILABLE")
}

#[derive(Serialize)]
pub struct BluechipWatchState {
    running: bool,
    mode: &'static str,
    message: String,
    last_checked_at: Option<String>,
    next_check_at: Option<String>,
    budget_state: &'static str,
    daily_limit_usd: Option<String>,
    per_trade_limit_usd: Option<String>,
    used_or_held_usd: Option<String>,
    pending_usd: Option<String>,
    committed_usd: Option<String>,
    remaining_usd: Option<String>,
    has_unresolved_real_order: bool,
}

#[tauri::command]
pub fn bluechip_watch_state(
    app: AppHandle,
    runtime: tauri::State<'_, BluechipRuntime>,
    ledger: tauri::State<'_, Ledger>,
) -> BluechipWatchState {
    let (status, config) = runtime.watch_context();
    let account_scope = risk_scopes(&app).map(|(_, account_scope)| account_scope);
    let has_unresolved_real_order = match &account_scope {
        Ok(account_scope) => ledger
            .has_unresolved_opening_submission(*account_scope, Venue::Robinhood)
            .unwrap_or(true),
        Err(_) => true,
    };
    let Some(config) = config.filter(|_| status.running) else {
        return BluechipWatchState {
            running: status.running,
            mode: status.mode,
            message: status.message,
            last_checked_at: status.last_checked_at,
            next_check_at: status.next_check_at,
            budget_state: "paused",
            daily_limit_usd: None,
            per_trade_limit_usd: None,
            used_or_held_usd: None,
            pending_usd: None,
            committed_usd: None,
            remaining_usd: None,
            has_unresolved_real_order,
        };
    };
    let daily_limit_usd = Some(format!("{:.2}", config.daily_budget_usd));
    let per_trade_limit_usd = Some(format!("{:.2}", config.max_per_trade_usd));
    if config.mode == NativeTradingMode::Practice {
        return BluechipWatchState {
            running: true,
            mode: "practice",
            message: status.message,
            last_checked_at: status.last_checked_at,
            next_check_at: status.next_check_at,
            budget_state: "practice",
            daily_limit_usd,
            per_trade_limit_usd,
            used_or_held_usd: None,
            pending_usd: None,
            committed_usd: None,
            remaining_usd: None,
            has_unresolved_real_order,
        };
    }

    let accounting = account_scope
        .and_then(|account_scope| {
            ledger
                .daily_opening_notional_breakdown(account_scope, Venue::Robinhood, Utc::now())
                .map_err(|_| "TRADING_HISTORY_UNAVAILABLE")
        })
        .and_then(|breakdown| {
            let remaining =
                (config.daily_budget_usd - breakdown.used_or_held_usd).max(Decimal::ZERO);
            (breakdown.used_or_held_usd == breakdown.committed_usd + breakdown.pending_usd)
                .then_some((breakdown, remaining))
                .ok_or("TRADING_HISTORY_UNAVAILABLE")
        });
    match accounting {
        Ok((breakdown, remaining)) => BluechipWatchState {
            running: true,
            mode: "real",
            message: status.message,
            last_checked_at: status.last_checked_at,
            next_check_at: status.next_check_at,
            budget_state: "available",
            daily_limit_usd,
            per_trade_limit_usd,
            used_or_held_usd: Some(format!("{:.2}", breakdown.used_or_held_usd)),
            pending_usd: Some(format!("{:.2}", breakdown.pending_usd)),
            committed_usd: Some(format!("{:.2}", breakdown.committed_usd)),
            remaining_usd: Some(format!("{remaining:.2}")),
            has_unresolved_real_order,
        },
        Err(_) => BluechipWatchState {
            running: true,
            mode: "real",
            message: status.message,
            last_checked_at: status.last_checked_at,
            next_check_at: status.next_check_at,
            budget_state: "unavailable",
            daily_limit_usd,
            per_trade_limit_usd,
            used_or_held_usd: None,
            pending_usd: None,
            committed_usd: None,
            remaining_usd: None,
            has_unresolved_real_order,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn customer_limits_are_exact_and_bounded() {
        let config = BluechipConfig {
            mode: NativeTradingMode::Real,
            daily_budget_usd: Decimal::new(2_500, 2),
            max_per_trade_usd: Decimal::new(500, 2),
        };
        assert!(validate_config(&config).is_ok());
        let policy = risk_policy(&config);
        assert_eq!(
            policy.max_daily_opening_notional_usd,
            Decimal::new(2_500, 2)
        );
        assert_eq!(policy.max_opening_order_usd, Decimal::new(500, 2));
        assert_eq!(
            policy.max_daily_loss_usd,
            RiskPolicy::default().max_daily_loss_usd
        );
    }

    #[test]
    fn every_customer_selectable_limit_produces_a_valid_risk_policy() {
        let engine = RiskEngine::new();
        let mut tested = 0_usize;
        for daily_dollars in 1_i64..=25 {
            for trade_dollars in 1_i64..=5_i64.min(daily_dollars) {
                let config = BluechipConfig {
                    mode: NativeTradingMode::Real,
                    daily_budget_usd: Decimal::from(daily_dollars),
                    max_per_trade_usd: Decimal::from(trade_dollars),
                };
                assert!(
                    validate_config(&config).is_ok(),
                    "daily={daily_dollars}, trade={trade_dollars}"
                );
                assert!(
                    engine
                        .validate_customer_policy(&risk_policy(&config))
                        .is_ok(),
                    "daily={daily_dollars}, trade={trade_dollars}"
                );
                tested = tested.saturating_add(1);
            }
        }
        assert_eq!(tested, 115);
    }

    #[test]
    fn non_divisible_daily_budget_uses_a_final_smaller_trade() {
        let config = BluechipConfig {
            mode: NativeTradingMode::Real,
            daily_budget_usd: Decimal::from(20),
            max_per_trade_usd: Decimal::from(3),
        };
        assert_eq!(
            trade_amount(&config, Decimal::from(18), Decimal::from(100)),
            TradeAmountDecision::Ready(Decimal::from(2))
        );
        assert_eq!(
            trade_amount(&config, Decimal::from(20), Decimal::from(100)),
            TradeAmountDecision::DailyRemainderBelowMinimum(Decimal::ZERO)
        );
        assert_eq!(
            trade_amount(&config, Decimal::ZERO, Decimal::new(250, 2)),
            TradeAmountDecision::Ready(Decimal::new(250, 2))
        );
    }

    #[test]
    fn practice_cannot_claim_placement_and_real_claims_only_one_per_cycle() {
        let mut practice_calls = 0;
        assert!(!claim_placement_call(
            NativeTradingMode::Practice,
            &mut practice_calls
        ));
        assert_eq!(practice_calls, 0);

        let mut real_calls = 0;
        assert!(claim_placement_call(
            NativeTradingMode::Real,
            &mut real_calls
        ));
        assert_eq!(real_calls, 1);
        assert!(!claim_placement_call(
            NativeTradingMode::Real,
            &mut real_calls
        ));
        assert_eq!(real_calls, 1);
    }

    #[test]
    fn no_trade_copy_names_the_reason_and_next_step() {
        let no_match = no_candidate_message(0);
        assert!(no_match.contains("checked all eight"));
        assert!(no_match.contains("did not force a trade"));
        assert!(no_match.contains("check again in 15 minutes"));

        let held = no_candidate_message(2);
        assert!(held.contains("already owned or has an open Robinhood order"));
        assert!(held.contains("check again in 15 minutes"));

        let config = BluechipConfig {
            mode: NativeTradingMode::Real,
            daily_budget_usd: Decimal::from(20),
            max_per_trade_usd: Decimal::from(3),
        };
        let remainder = trade_amount_block_message(
            &config,
            TradeAmountDecision::DailyRemainderBelowMinimum(Decimal::new(75, 2)),
        );
        assert!(remainder.contains("$0.75 remains"));
        assert!(remainder.contains("below Robinhood's $1.00 minimum"));
        assert!(remainder.contains("pause trading and raise the daily limit in Setup"));

        let buying_power = trade_amount_block_message(
            &config,
            TradeAmountDecision::BuyingPowerBelowMinimum(Decimal::new(50, 2)),
        );
        assert!(buying_power.contains("$0.50 of available buying power"));
        assert!(buying_power.contains("Add money or free up buying power"));

        assert!(
            risk_rejection_message(daytradingbot_contracts::RiskRejection::PolicyInvalid)
                .contains("Open Setup")
        );
    }

    #[test]
    fn every_risk_rejection_has_an_explicit_cycle_disposition() {
        let expectations = [
            (
                RiskRejection::PolicyInvalid,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::InvalidNotional,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::IntentExpired,
                RiskRejectionDisposition::ContinueCandidate,
            ),
            (
                RiskRejection::ConnectorUnhealthy,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::KillSwitchActive,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::VenuePaused,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::StrategyDisabled,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::VenueIneligible,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::MarketDataStale,
                RiskRejectionDisposition::ContinueCandidate,
            ),
            (
                RiskRejection::LicenseDisallowsEntry,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::OrderLimitExceeded,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::DailyOpeningLimitExceeded,
                RiskRejectionDisposition::EndCycle,
            ),
            (
                RiskRejection::VenueExposureLimitExceeded,
                RiskRejectionDisposition::EndCycle,
            ),
            (
                RiskRejection::GlobalExposureLimitExceeded,
                RiskRejectionDisposition::EndCycle,
            ),
            (
                RiskRejection::DailyLossStopReached,
                RiskRejectionDisposition::EndCycle,
            ),
            (
                RiskRejection::RestingEntryLimitExceeded,
                RiskRejectionDisposition::EndCycle,
            ),
            (
                RiskRejection::ExistingOwnedLot,
                RiskRejectionDisposition::ContinueCandidate,
            ),
            (
                RiskRejection::MissingOwnedLot,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::ReduceExceedsOwnedLot,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::ReduceWrongSide,
                RiskRejectionDisposition::StopReal,
            ),
            (
                RiskRejection::InvalidPredictionOrder,
                RiskRejectionDisposition::StopReal,
            ),
        ];

        assert_eq!(expectations.len(), 21);
        for (reason, expected) in expectations {
            assert_eq!(risk_rejection_disposition(reason), expected, "{reason:?}");
        }
        assert_eq!(
            expectations
                .into_iter()
                .filter(|(_, disposition)| {
                    *disposition == RiskRejectionDisposition::ContinueCandidate
                })
                .count(),
            3
        );
    }

    #[test]
    fn post_placement_failures_never_claim_no_order_was_sent() {
        let accepted = plain_cycle_error("ORDER_ACCEPTED_LOCAL_RECORD_FAILED");
        assert!(accepted.contains("Robinhood accepted this order"));
        assert!(accepted.contains("Real trading stopped"));

        let uncertain = plain_cycle_error("ORDER_PLACEMENT_RESPONSE_UNCERTAIN");
        assert!(uncertain.contains("may have reached Robinhood"));
        assert!(uncertain.contains("check that exact order"));

        let rejected = plain_cycle_error("ORDER_REJECTED_LOCAL_RECORD_FAILED");
        assert!(rejected.contains("Robinhood rejected this trade"));
        assert!(rejected.contains("Real trading stopped"));

        for message in [
            accepted,
            uncertain,
            rejected,
            ACCEPTED_PLACEMENT_LOCAL_RECORD_ACTIVITY,
            UNCERTAIN_PLACEMENT_ACTIVITY,
        ] {
            let normalized = message.to_ascii_lowercase();
            assert!(!normalized.contains("no order was sent"), "{message}");
            assert!(
                !normalized.contains("before any new order was sent"),
                "{message}"
            );
            assert!(!normalized.contains("reconcile"), "{message}");
            assert!(!normalized.contains("local record"), "{message}");
        }
    }

    #[test]
    fn unknown_recovery_reuses_only_the_exact_bounded_order() {
        let intent_id = Uuid::new_v4();
        let amount = Decimal::new(500, 2);
        let mut attempt = daytradingbot_ledger::SubmissionAttemptRecord {
            attempt_id: Uuid::new_v4(),
            intent_id,
            client_order_id: intent_id.to_string(),
            request_fingerprint: request_fingerprint(intent_id, "AAPL", amount),
            state: SubmissionAttemptState::Unknown,
            reconciled_state: None,
            venue_order_id: None,
            detail_code: Some("response_timeout".into()),
            started_at: Utc::now(),
            updated_at: Utc::now(),
            instrument: "AAPL".into(),
            notional_usd: amount,
        };
        let config = BluechipConfig {
            mode: NativeTradingMode::Real,
            daily_budget_usd: Decimal::new(2_500, 2),
            max_per_trade_usd: amount,
        };
        assert_eq!(
            validate_recovery_attempt(&attempt, &config).expect("exact recovery"),
            intent_id
        );

        attempt.notional_usd = Decimal::new(600, 2);
        assert!(validate_recovery_attempt(&attempt, &config).is_err());
        attempt.notional_usd = amount;
        attempt.request_fingerprint = "0".repeat(64);
        assert!(validate_recovery_attempt(&attempt, &config).is_err());
    }

    #[test]
    fn multiple_unresolved_orders_yield_one_recovery_candidate() {
        let amount = Decimal::new(500, 2);
        let first_intent_id = Uuid::new_v4();
        let first = daytradingbot_ledger::SubmissionAttemptRecord {
            attempt_id: Uuid::new_v4(),
            intent_id: first_intent_id,
            client_order_id: first_intent_id.to_string(),
            request_fingerprint: request_fingerprint(first_intent_id, "AAPL", amount),
            state: SubmissionAttemptState::Unknown,
            reconciled_state: None,
            venue_order_id: None,
            detail_code: Some("response_timeout".into()),
            started_at: Utc::now(),
            updated_at: Utc::now(),
            instrument: "AAPL".into(),
            notional_usd: amount,
        };
        let second_intent_id = Uuid::new_v4();
        let second = daytradingbot_ledger::SubmissionAttemptRecord {
            attempt_id: Uuid::new_v4(),
            intent_id: second_intent_id,
            client_order_id: second_intent_id.to_string(),
            request_fingerprint: request_fingerprint(second_intent_id, "MSFT", amount),
            state: SubmissionAttemptState::Submitting,
            reconciled_state: None,
            venue_order_id: None,
            detail_code: None,
            started_at: Utc::now(),
            updated_at: Utc::now(),
            instrument: "MSFT".into(),
            notional_usd: amount,
        };

        let attempts = vec![first, second];
        let selected = first_recovery_candidate(&attempts).expect("one recovery candidate");
        assert_eq!(selected.intent_id, first_intent_id);
        assert_ne!(selected.intent_id, second_intent_id);
    }

    #[test]
    fn uncertain_and_recovered_order_copy_is_truthful() {
        assert!(UNCERTAIN_PLACEMENT_ACTIVITY.contains("check that exact order"));
        assert!(!UNCERTAIN_PLACEMENT_ACTIVITY.contains("will not retry"));

        assert!(
            recovery_cycle_message(RecoveryOutcome::Acknowledged)
                .starts_with("Robinhood found the earlier order.")
        );
        assert!(
            recovery_cycle_message(RecoveryOutcome::Rejected)
                .contains("earlier order was not accepted")
        );

        let (pending_kind, pending_message) =
            recovered_order_activity(RobinhoodEquityOrderState::Pending);
        assert_eq!(pending_kind, AgentActivityKind::OrderSubmitted);
        assert!(pending_message.contains("waiting to be filled"));

        let (rejected_kind, rejected_message) =
            recovered_order_activity(RobinhoodEquityOrderState::Rejected);
        assert_eq!(rejected_kind, AgentActivityKind::Skipped);
        assert!(rejected_message.contains("rejected"));
        assert!(!rejected_message.contains("order_id"));
    }

    #[test]
    fn quote_must_be_recent_before_real_trading() {
        let now = Utc::now();
        let fresh = RobinhoodEquityQuote {
            symbol: "AAPL".into(),
            last_trade_price: Decimal::new(19000, 2),
            previous_close: Decimal::new(19400, 2),
            venue_last_trade_time: now - ChronoDuration::minutes(1),
        };
        let stale = RobinhoodEquityQuote {
            venue_last_trade_time: now - ChronoDuration::minutes(6),
            ..fresh.clone()
        };
        assert!(quote_is_fresh(&fresh, now));
        assert!(!quote_is_fresh(&stale, now));
    }

    #[test]
    fn real_orders_require_a_current_local_authorization_window() {
        let runtime = BluechipRuntime::default();
        {
            let mut inner = runtime.inner.lock().expect("runtime lock");
            inner.generation = 7;
            inner.status.running = true;
            inner.status.mode = "real";
            inner.real_authorized_until = Some(Utc::now() + ChronoDuration::hours(1));
        }
        assert!(runtime.real_entry_authorized(7));

        {
            let mut inner = runtime.inner.lock().expect("runtime lock");
            inner.real_authorized_until = Some(Utc::now() - ChronoDuration::seconds(1));
        }
        assert!(!runtime.real_entry_authorized(7));
        runtime.expire_real_authorization(7);
        assert!(!runtime.status().running);
    }

    #[test]
    fn deterministic_request_fingerprint_is_lowercase_sha256() {
        let first = request_fingerprint(Uuid::nil(), "AAPL", Decimal::new(500, 2));
        let second = request_fingerprint(Uuid::nil(), "AAPL", Decimal::new(500, 2));
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(
            first
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        );
    }
}
