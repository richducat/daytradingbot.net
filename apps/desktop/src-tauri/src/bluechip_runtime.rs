use crate::robinhood_connection::current_robinhood_access;
use crate::vault::{CredentialVault, VaultKey};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, Timelike, Utc, Weekday};
use chrono_tz::America::New_York;
use daytradingbot_contracts::{
    IntentPurpose, OrderSide, OrderState, OrderType, RiskPolicy, SafetyState, TradeIntent, Venue,
};
use daytradingbot_core::{IntentIdentity, deterministic_intent_id};
use daytradingbot_ledger::{
    AgentActivityKind, AgentActivityMode, AgentActivityRecord, FillOutcome, FillRecord, Ledger,
    NewAgentActivity, ReservationOutcome, SubmissionAttemptState,
};
use daytradingbot_licensing::LicenseGate;
use daytradingbot_venues::robinhood::{
    RobinhoodAgenticClient, RobinhoodEquityOrder, RobinhoodEquityOrderState, RobinhoodEquityQuote,
    RobinhoodPlacementError, RobinhoodTradingSession,
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
                    if buying_power < config.max_per_trade_usd {
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
        let recovered_order = reconcile_orders(
            ledger.inner(),
            &mut session,
            config,
            ReconcileMode::Running { app, generation },
        )
        .await?;
        if recovered_order {
            return Ok(
                "Robinhood confirmed an earlier order. Bluechip will wait until the next market check before considering another trade."
                    .into(),
            );
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

    let mut candidates: Vec<_> = quotes
        .into_iter()
        .filter(|quote| quote.change_percent() <= Decimal::new(DIP_THRESHOLD_PERCENT_HUNDREDTHS, 2))
        .filter(|quote| !held_symbols.contains(&quote.symbol))
        .filter(|quote| !pending_symbols.contains(&quote.symbol))
        .collect();
    candidates.sort_by_key(RobinhoodEquityQuote::change_percent);
    if candidates.is_empty() {
        let message = "Market check finished. No new trade matched Bluechip's rules.";
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

    let mut submitted = 0_usize;
    for quote in candidates {
        if submitted >= MAX_TRADES_PER_CYCLE {
            break;
        }
        let symbol = quote.symbol.clone();
        let amount = config.max_per_trade_usd.min(buying_power);
        if amount < Decimal::ONE {
            record_activity(
                ledger.inner(),
                config,
                AgentActivityKind::Skipped,
                Some(symbol.as_str()),
                None,
                "A trade matched, but the connected Robinhood account needs more buying power.",
            )?;
            break;
        }
        let reviewed = session
            .review_market_buy(&symbol, amount)
            .await
            .map_err(|_| "ROBINHOOD_ORDER_REVIEW_FAILED")?;
        if !quote_is_fresh(&reviewed.quote, Utc::now()) {
            record_activity(
                ledger.inner(),
                config,
                AgentActivityKind::Skipped,
                Some(symbol.as_str()),
                None,
                "A trade matched, but the latest price was too old to use safely.",
            )?;
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
            submitted = submitted.saturating_add(1);
            continue;
        }

        if !market_is_open(Utc::now()) {
            record_activity(
                ledger.inner(),
                config,
                AgentActivityKind::Skipped,
                Some(symbol.as_str()),
                None,
                "A trade matched, but the regular stock market is closed.",
            )?;
            continue;
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
        let (risk_scope, account_scope) = risk_scopes(app)?;
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
            ReservationOutcome::Duplicate => continue,
            ReservationOutcome::Rejected(reason) => {
                let message = risk_rejection_message(reason);
                record_activity(
                    ledger.inner(),
                    config,
                    AgentActivityKind::Skipped,
                    Some(symbol.as_str()),
                    Some(amount),
                    message,
                )?;
                continue;
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
                .finalize_open_order(intent_id, OrderState::Rejected)
                .map_err(|_| "TRADING_HISTORY_UNAVAILABLE")?;
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
                .reject_submission(intent_id, "paused_before_submission")
                .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
            ledger
                .finalize_open_order(intent_id, OrderState::Rejected)
                .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
            return Ok("Trading was paused before any new order was sent.".into());
        }

        if !placement_call_allowed(config.mode, submitted) {
            ledger
                .reject_submission(intent_id, "placement_mode_blocked")
                .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
            ledger
                .finalize_open_order(intent_id, OrderState::Rejected)
                .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
            return Err("ORDER_SUBMISSION_BLOCKED");
        }
        match session.place_reviewed_market_buy(reviewed, intent_id).await {
            Ok(placement) => {
                ledger
                    .acknowledge_submission(intent_id, &placement.order_id)
                    .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
                let message = format!(
                    "Bluechip sent a {} {} buy to Robinhood.",
                    money(amount),
                    symbol
                );
                record_activity(
                    ledger.inner(),
                    config,
                    AgentActivityKind::OrderSubmitted,
                    Some(symbol.as_str()),
                    Some(amount),
                    &message,
                )?;
                if let Ok(Some(order)) = session.equity_order(&placement.order_id).await {
                    settle_order(ledger.inner(), config, intent_id, &order)?;
                }
                submitted = submitted.saturating_add(1);
            }
            Err(RobinhoodPlacementError::Rejected) => {
                ledger
                    .reject_submission(intent_id, "robinhood_rejected")
                    .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
                ledger
                    .finalize_open_order(intent_id, OrderState::Rejected)
                    .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
                record_activity(
                    ledger.inner(),
                    config,
                    AgentActivityKind::Skipped,
                    Some(symbol.as_str()),
                    Some(amount),
                    "Robinhood did not accept this trade. No order was opened.",
                )?;
            }
            Err(RobinhoodPlacementError::Unknown) => {
                ledger
                    .mark_submission_unknown(intent_id, "robinhood_response_unknown")
                    .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
                record_activity(
                    ledger.inner(),
                    config,
                    AgentActivityKind::Error,
                    Some(symbol.as_str()),
                    Some(amount),
                    "Robinhood's response was unclear. Bluechip will not retry this trade.",
                )?;
                return Err("ORDER_RECONCILIATION_REQUIRED");
            }
        }
    }

    Ok(if config.mode == NativeTradingMode::Practice {
        format!("Practice check finished. {submitted} possible trade(s) recorded.")
    } else {
        format!("Market check finished. {submitted} order(s) sent to Robinhood.")
    })
}

async fn reconcile_orders(
    ledger: &Ledger,
    session: &mut RobinhoodTradingSession<'_>,
    config: &BluechipConfig,
    mode: ReconcileMode<'_>,
) -> Result<bool, &'static str> {
    let attempts = ledger
        .unresolved_submissions()
        .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
    let mut recovered_order = false;
    for attempt in attempts {
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
                if let ReconcileMode::Running { app, generation } = mode {
                    recovered_order |=
                        recover_unknown_order(ledger, session, config, &attempt, app, generation)
                            .await?
                            == RecoveryOutcome::Acknowledged;
                }
            }
            SubmissionAttemptState::Unknown => {
                if let ReconcileMode::Running { app, generation } = mode {
                    recovered_order |=
                        recover_unknown_order(ledger, session, config, &attempt, app, generation)
                            .await?
                            == RecoveryOutcome::Acknowledged;
                }
            }
            SubmissionAttemptState::Quarantined => {
                return Err("ORDER_RECONCILIATION_REQUIRED");
            }
            SubmissionAttemptState::Reconciled => {}
        }
    }
    Ok(recovered_order)
}

#[derive(Clone, Copy)]
enum ReconcileMode<'a> {
    ReadOnly,
    Running { app: &'a AppHandle, generation: u64 },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RecoveryOutcome {
    Acknowledged,
    Rejected,
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
            ledger
                .acknowledge_unknown_submission(attempt.intent_id, &placement.order_id)
                .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
            let order = session
                .equity_order(&placement.order_id)
                .await
                .map_err(|_| "ROBINHOOD_ORDER_CHECK_FAILED")?
                .ok_or("ORDER_RECONCILIATION_REQUIRED")?;
            settle_order(ledger, config, attempt.intent_id, &order)?;
            Ok(RecoveryOutcome::Acknowledged)
        }
        Err(RobinhoodPlacementError::Rejected) => {
            ledger
                .reject_unknown_open_submission(attempt.intent_id, "idempotent_recovery_rejected")
                .map_err(|_| "ORDER_HISTORY_UNAVAILABLE")?;
            Ok(RecoveryOutcome::Rejected)
        }
        Err(RobinhoodPlacementError::Unknown) => Err("ORDER_RECONCILIATION_REQUIRED"),
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
    Ok(())
}

pub fn decimal_from_customer_amount(value: f64) -> Result<Decimal, &'static str> {
    if !value.is_finite() {
        return Err("TRADING_LIMIT_INVALID");
    }
    Decimal::from_str(&format!("{value:.2}")).map_err(|_| "TRADING_LIMIT_INVALID")
}

fn risk_policy(config: &BluechipConfig) -> RiskPolicy {
    RiskPolicy {
        max_opening_order_usd: config.max_per_trade_usd,
        max_daily_opening_notional_usd: config.daily_budget_usd,
        max_venue_exposure_usd: (config.daily_budget_usd * Decimal::from(4_u8))
            .min(Decimal::new(10_000, 2)),
        max_global_exposure_usd: (config.daily_budget_usd * Decimal::from(5_u8))
            .min(Decimal::new(20_000, 2)),
        max_daily_loss_usd: config.daily_budget_usd,
        max_resting_entry_orders: 2,
    }
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

fn risk_rejection_message(reason: daytradingbot_contracts::RiskRejection) -> &'static str {
    use daytradingbot_contracts::RiskRejection;
    match reason {
        RiskRejection::DailyOpeningLimitExceeded => {
            "Your daily limit has been reached. No new trade was opened."
        }
        RiskRejection::OrderLimitExceeded => {
            "This trade was above your per-trade limit. No order was sent."
        }
        RiskRejection::ExistingOwnedLot => {
            "Bluechip already owns this stock, so it did not buy it again."
        }
        RiskRejection::RestingEntryLimitExceeded => {
            "Two earlier orders are still open. Bluechip will wait before sending another."
        }
        RiskRejection::LicenseDisallowsEntry => {
            "Real trading authorization is not current. No order was sent."
        }
        RiskRejection::MarketDataStale => {
            "The latest price was too old to use safely. No order was sent."
        }
        _ => "A safety check stopped this trade before any order was sent.",
    }
}

fn plain_cycle_error(error: &'static str) -> &'static str {
    match error {
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
            "The connected Robinhood account needs more buying power before Bluechip can trade."
        }
        _ => "Bluechip could not finish this market check. No new order was sent.",
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
    symbol: Option<String>,
    amount_usd: Option<String>,
    message: String,
    occurred_at: String,
}

fn activity_item(record: AgentActivityRecord) -> ActivityItem {
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
        symbol: record.symbol,
        amount_usd: record.amount_usd.map(|amount| format!("{amount:.2}")),
        message: record.message,
        occurred_at: record.occurred_at.to_rfc3339(),
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
    }

    #[test]
    fn practice_cannot_reach_placement_and_real_is_one_per_cycle() {
        assert!(!placement_call_allowed(NativeTradingMode::Practice, 0));
        assert!(placement_call_allowed(NativeTradingMode::Real, 0));
        assert!(!placement_call_allowed(NativeTradingMode::Real, 1));
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
