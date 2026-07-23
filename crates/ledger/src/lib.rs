use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use daytradingbot_contracts::{
    IntentPurpose, OrderSide, OrderState, PredictionOutcome, RiskDecision, RiskPolicy,
    RiskRejection, RiskSnapshot, SafetyState, TradeIntent, Venue,
};
use daytradingbot_core::RiskEngine;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use rust_decimal::Decimal;
use thiserror::Error;
use uuid::Uuid;

const MICROS_PER_DOLLAR: i64 = 1_000_000;
const SAFETY_MAX_AGE_SECONDS: i64 = 60;

#[derive(Debug, PartialEq, Eq)]
pub enum ReservationOutcome {
    Reserved(Box<ReservedIntent>),
    Duplicate,
    Rejected(RiskRejection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillOutcome {
    Recorded,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillRecord {
    pub venue_fill_id: String,
    pub quantity: Decimal,
    pub price: Decimal,
    pub notional: Decimal,
    pub fee: Decimal,
    pub filled_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmissionAttemptState {
    Submitting,
    Acknowledged,
    Unknown,
    Reconciled,
    Quarantined,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmissionAttemptRecord {
    pub attempt_id: Uuid,
    pub intent_id: Uuid,
    pub client_order_id: String,
    pub request_fingerprint: String,
    pub state: SubmissionAttemptState,
    pub reconciled_state: Option<OrderState>,
    pub venue_order_id: Option<String>,
    pub detail_code: Option<String>,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub instrument: String,
    pub notional_usd: Decimal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentActivityMode {
    Practice,
    Real,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentActivityKind {
    Started,
    Paused,
    MarketCheck,
    Signal,
    Skipped,
    Reviewed,
    OrderSubmitted,
    Filled,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewAgentActivity {
    pub agent_id: String,
    pub mode: AgentActivityMode,
    pub kind: AgentActivityKind,
    pub symbol: Option<String>,
    pub amount_usd: Option<Decimal>,
    pub message: String,
    pub occurred_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentActivityRecord {
    pub event_id: Uuid,
    pub agent_id: String,
    pub mode: AgentActivityMode,
    pub kind: AgentActivityKind,
    pub symbol: Option<String>,
    pub amount_usd: Option<Decimal>,
    pub message: String,
    pub occurred_at: DateTime<Utc>,
}

/// Single-use authorization emitted only after the durable reservation commits.
/// It is intentionally not `Clone`; venue submission consumes it by value.
#[derive(Debug, PartialEq, Eq)]
pub struct ReservedIntent {
    intent: TradeIntent,
    reserved_at: DateTime<Utc>,
}

impl ReservedIntent {
    #[must_use]
    pub fn intent(&self) -> &TradeIntent {
        &self.intent
    }

    #[must_use]
    pub fn reserved_at(&self) -> DateTime<Utc> {
        self.reserved_at
    }
}

#[derive(Debug, Error)]
pub enum LedgerError {
    #[error("ledger lock was poisoned")]
    Poisoned,
    #[error("money amount cannot be represented as integer microdollars")]
    MoneyOutOfRange,
    #[error("reservation release requires a terminal order state")]
    InvalidTerminalState,
    #[error("fill recording requires an active opening reservation")]
    MissingActiveOpeningReservation,
    #[error("fill recording requires an active reduce reservation and owned lot")]
    MissingActiveReduceReservation,
    #[error("fill values must be positive and notional cannot exceed reserved exposure")]
    InvalidFillExposure,
    #[error("terminal order state conflicts with durable fill records")]
    InvalidTerminalOutcome,
    #[error("submission requires an active reserved intent")]
    IntentNotReserved,
    #[error("a submission attempt already exists and must be reconciled, never retried")]
    SubmissionAlreadyExists,
    #[error("submission attempt does not exist")]
    MissingSubmissionAttempt,
    #[error("invalid durable submission transition")]
    InvalidSubmissionTransition,
    #[error("request fingerprint must be a lowercase SHA-256 hex digest")]
    InvalidRequestFingerprint,
    #[error("venue order identifier is missing")]
    InvalidVenueOrderId,
    #[error("stored submission data is invalid")]
    InvalidStoredSubmission,
    #[error("agent activity is invalid")]
    InvalidAgentActivity,
    #[error("stored agent activity is invalid")]
    InvalidStoredActivity,
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
}

pub struct Ledger {
    connection: Mutex<Connection>,
}

struct SnapshotContext<'a> {
    account_scope: &'a str,
    risk_scope: &'a str,
    venue: &'a str,
    strategy_id: &'a str,
    instrument: &'a str,
    observed_at: DateTime<Utc>,
}

struct SubmissionTransition<'a> {
    expected_state: &'static str,
    attempt_state: &'static str,
    order_state: OrderState,
    venue_order_id: Option<&'a str>,
    detail_code: Option<&'static str>,
    audit_event: &'static str,
}

impl Ledger {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, LedgerError> {
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    pub fn open_in_memory() -> Result<Self, LedgerError> {
        let connection = Connection::open_in_memory()?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> Result<Self, LedgerError> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.execute_batch(include_str!("schema.sql"))?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Appends one privacy-safe, customer-readable activity item. Account
    /// numbers, credential material, raw provider payloads, and order request
    /// bodies are intentionally not representable by this record type.
    pub fn record_agent_activity(&self, activity: &NewAgentActivity) -> Result<Uuid, LedgerError> {
        validate_agent_activity(activity)?;
        let amount_micros = activity.amount_usd.map(decimal_to_micros).transpose()?;
        let event_id = Uuid::new_v4();
        let connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        connection.execute(
            "INSERT INTO agent_activity
             (event_id, agent_id, mode, event_kind, symbol, amount_micros, message, occurred_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event_id.to_string(),
                activity.agent_id,
                activity_mode_key(activity.mode),
                activity_kind_key(activity.kind),
                activity.symbol,
                amount_micros,
                activity.message,
                activity.occurred_at.to_rfc3339(),
            ],
        )?;
        Ok(event_id)
    }

    pub fn recent_agent_activity(
        &self,
        limit: usize,
    ) -> Result<Vec<AgentActivityRecord>, LedgerError> {
        if !(1..=200).contains(&limit) {
            return Err(LedgerError::InvalidAgentActivity);
        }
        let connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT event_id, agent_id, mode, event_kind, symbol, amount_micros,
                    message, occurred_at
             FROM agent_activity
             ORDER BY occurred_at DESC, event_id DESC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([i64::try_from(limit).unwrap_or(200)], |row| {
            agent_activity_from_row(row)
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(LedgerError::from)
    }

    /// Stores the connector's latest reconciled venue-day P&L so the next
    /// opening reservation evaluates the hard daily-loss stop durably.
    pub fn update_venue_pnl(
        &self,
        account_scope: Uuid,
        venue: Venue,
        pnl: Decimal,
        observed_at: DateTime<Utc>,
    ) -> Result<(), LedgerError> {
        let pnl_micros = decimal_to_micros(pnl)?;
        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let account_scope = account_scope.to_string();
        let venue = venue_key(venue);
        let venue_day = canonical_venue_day(
            &tx,
            &account_scope,
            venue,
            &observed_at.date_naive().to_string(),
        )?;
        tx.execute(
            "INSERT INTO daily_usage
             (account_scope, venue, venue_day, pnl_micros, pnl_observed_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_scope, venue, venue_day)
             DO UPDATE SET pnl_micros = excluded.pnl_micros,
                           pnl_observed_at = excluded.pnl_observed_at",
            params![
                account_scope,
                venue,
                venue_day,
                pnl_micros,
                observed_at.to_rfc3339(),
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Persists the backend-owned safety heartbeat consumed by the final
    /// reservation transaction. Missing or stale state fails closed.
    pub fn update_safety_state(
        &self,
        risk_scope: Uuid,
        account_scope: Uuid,
        venue: Venue,
        state: &SafetyState,
        observed_at: DateTime<Utc>,
    ) -> Result<(), LedgerError> {
        let connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        connection.execute(
            "INSERT INTO safety_state
             (risk_scope, account_scope, venue, global_kill_switch, venue_paused,
              strategy_enabled, venue_eligible, connector_healthy, market_data_fresh,
              license_allows_entries, observed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(account_scope, venue) DO UPDATE SET
               risk_scope = excluded.risk_scope,
               global_kill_switch = excluded.global_kill_switch,
               venue_paused = excluded.venue_paused,
               strategy_enabled = excluded.strategy_enabled,
               venue_eligible = excluded.venue_eligible,
               connector_healthy = excluded.connector_healthy,
               market_data_fresh = excluded.market_data_fresh,
               license_allows_entries = excluded.license_allows_entries,
               observed_at = excluded.observed_at",
            params![
                risk_scope.to_string(),
                account_scope.to_string(),
                venue_key(venue),
                i64::from(state.global_kill_switch),
                i64::from(state.venue_paused),
                i64::from(state.strategy_enabled),
                i64::from(state.venue_eligible),
                i64::from(state.connector_healthy),
                i64::from(state.market_data_fresh),
                i64::from(state.license_allows_entries),
                observed_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    /// Atomically evaluates a raw intent against durable reservations and lots,
    /// then records either a single-use reservation or rejection.
    /// Separate workers cannot consume the same intent or cap twice.
    pub fn reserve(
        &self,
        intent: TradeIntent,
        policy: &RiskPolicy,
    ) -> Result<ReservationOutcome, LedgerError> {
        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let intent_id = intent.intent_id.to_string();

        let existing = tx
            .query_row(
                "SELECT 1 FROM intents WHERE intent_id = ?1",
                [&intent_id],
                |_| Ok(()),
            )
            .optional()?;
        if existing.is_some() {
            tx.commit()?;
            return Ok(ReservationOutcome::Duplicate);
        }

        let account_scope = intent.account_scope.to_string();
        let risk_scope = intent.risk_scope.to_string();
        let venue = venue_key(intent.venue);
        let reserved_at = Utc::now();
        let venue_day = canonical_venue_day(
            &tx,
            &account_scope,
            venue,
            &reserved_at.date_naive().to_string(),
        )?;
        let notional_micros = decimal_to_micros(intent.notional_usd)?;
        let snapshot_context = SnapshotContext {
            account_scope: &account_scope,
            risk_scope: &risk_scope,
            venue,
            strategy_id: &intent.strategy_id,
            instrument: &intent.instrument,
            observed_at: reserved_at,
        };
        let snapshot = durable_snapshot(&tx, &snapshot_context, &venue_day)?;
        let engine = RiskEngine::new();
        let decision = engine.evaluate(&intent, &snapshot, policy);
        let created_at = reserved_at.to_rfc3339();

        match decision {
            RiskDecision::Rejected { reason } => {
                insert_intent(&tx, &intent, notional_micros, "risk_rejected", &created_at)?;
                insert_audit(
                    &tx,
                    Some(&intent_id),
                    "risk_rejected",
                    Some(reason_key(reason)),
                )?;
                tx.commit()?;
                Ok(ReservationOutcome::Rejected(reason))
            }
            RiskDecision::Allowed => {
                insert_intent(&tx, &intent, notional_micros, "reserved", &created_at)?;
                let opening_micros = if intent.purpose == IntentPurpose::Open {
                    notional_micros
                } else {
                    0
                };
                tx.execute(
                    "INSERT INTO risk_reservations
                     (intent_id, risk_scope, account_scope, venue, venue_day, opening_notional_micros,
                      exposure_micros, active, reserved_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)",
                    params![
                        intent_id,
                        risk_scope,
                        account_scope,
                        venue,
                        venue_day,
                        opening_micros,
                        opening_micros,
                        created_at,
                    ],
                )?;
                if intent.purpose == IntentPurpose::Open {
                    tx.execute(
                        "INSERT INTO daily_usage
                         (account_scope, venue, venue_day, opening_notional_micros)
                         VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT(account_scope, venue, venue_day)
                         DO UPDATE SET opening_notional_micros =
                           opening_notional_micros + excluded.opening_notional_micros",
                        params![account_scope, venue, venue_day, opening_micros],
                    )?;
                }
                insert_audit(&tx, Some(&intent_id), "risk_reserved", None)?;
                tx.commit()?;
                Ok(ReservationOutcome::Reserved(Box::new(ReservedIntent {
                    intent,
                    reserved_at,
                })))
            }
        }
    }

    /// Persists the single submission attempt before any network write. The
    /// intent UUID is also the venue client-order ID, so crash recovery can
    /// find a possibly accepted order without ever creating a second ID.
    pub fn begin_submission(
        &self,
        intent_id: Uuid,
        attempt_id: Uuid,
        request_fingerprint: &str,
    ) -> Result<SubmissionAttemptRecord, LedgerError> {
        if request_fingerprint.len() != 64
            || !request_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(LedgerError::InvalidRequestFingerprint);
        }

        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let intent_id_text = intent_id.to_string();
        let already_exists = tx
            .query_row(
                "SELECT 1 FROM submission_attempts WHERE intent_id = ?1",
                [&intent_id_text],
                |_| Ok(()),
            )
            .optional()?;
        if already_exists.is_some() {
            tx.commit()?;
            return Err(LedgerError::SubmissionAlreadyExists);
        }

        let reserved = tx
            .query_row(
                "SELECT i.instrument, i.notional_micros
                 FROM intents i
                 JOIN risk_reservations r ON r.intent_id = i.intent_id
                 WHERE i.intent_id = ?1 AND i.state = 'reserved' AND r.active = 1",
                [&intent_id_text],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        let (instrument, notional_micros) = reserved.ok_or(LedgerError::IntentNotReserved)?;

        let now = Utc::now();
        let now_text = now.to_rfc3339();
        tx.execute(
            "INSERT INTO submission_attempts
             (attempt_id, intent_id, client_order_id, request_fingerprint, state,
              started_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'submitting', ?5, ?5)",
            params![
                attempt_id.to_string(),
                intent_id_text,
                intent_id_text,
                request_fingerprint,
                now_text,
            ],
        )?;
        tx.execute(
            "INSERT INTO orders (intent_id, state, updated_at)
             VALUES (?1, 'submitting', ?2)",
            params![intent_id_text, now_text],
        )?;
        tx.execute(
            "UPDATE intents SET state = 'submitting' WHERE intent_id = ?1",
            [&intent_id_text],
        )?;
        insert_audit(&tx, Some(&intent_id_text), "submission_started", None)?;
        tx.commit()?;

        Ok(SubmissionAttemptRecord {
            attempt_id,
            intent_id,
            client_order_id: intent_id_text,
            request_fingerprint: request_fingerprint.to_owned(),
            state: SubmissionAttemptState::Submitting,
            reconciled_state: None,
            venue_order_id: None,
            detail_code: None,
            started_at: now,
            updated_at: now,
            instrument,
            notional_usd: micros_to_decimal(notional_micros),
        })
    }

    pub fn acknowledge_submission(
        &self,
        intent_id: Uuid,
        venue_order_id: &str,
    ) -> Result<(), LedgerError> {
        if venue_order_id.trim().is_empty() {
            return Err(LedgerError::InvalidVenueOrderId);
        }
        self.transition_submission(
            intent_id,
            SubmissionTransition {
                expected_state: "submitting",
                attempt_state: "acknowledged",
                order_state: OrderState::Acknowledged,
                venue_order_id: Some(venue_order_id),
                detail_code: None,
                audit_event: "submission_acknowledged",
            },
        )
    }

    /// Marks an acknowledged venue order as terminal after an authoritative
    /// order-status read. Fill rows must be recorded separately before a
    /// `Filled` result is finalized.
    pub fn reconcile_acknowledged_submission(
        &self,
        intent_id: Uuid,
        resolved_state: OrderState,
    ) -> Result<(), LedgerError> {
        let resolved_key = match resolved_state {
            OrderState::Filled => "filled",
            OrderState::Canceled => "canceled",
            OrderState::Rejected => "rejected",
            _ => return Err(LedgerError::InvalidSubmissionTransition),
        };
        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let intent_id = intent_id.to_string();
        let now = Utc::now().to_rfc3339();
        let changed = tx.execute(
            "UPDATE submission_attempts
             SET state = 'reconciled', reconciled_state = ?2, updated_at = ?3
             WHERE intent_id = ?1 AND state = 'acknowledged'",
            params![intent_id, resolved_key, now],
        )?;
        if changed != 1 {
            return Err(LedgerError::InvalidSubmissionTransition);
        }
        insert_audit(
            &tx,
            Some(&intent_id),
            "acknowledged_submission_reconciled",
            Some(resolved_key),
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Atomically validates the terminal outcome, releases the remaining
    /// opening reservation, and reconciles an acknowledged broker order. A
    /// broker `Filled` response without a durable fill leaves both records
    /// untouched so the order remains visible for reconciliation.
    pub fn finalize_acknowledged_open_order(
        &self,
        intent_id: Uuid,
        terminal_state: OrderState,
    ) -> Result<(), LedgerError> {
        let state = match terminal_state {
            OrderState::Filled => "filled",
            OrderState::Canceled => "canceled",
            OrderState::Rejected => "rejected",
            _ => return Err(LedgerError::InvalidTerminalState),
        };
        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let intent_id = intent_id.to_string();
        let (fill_count, active_count): (i64, i64) = tx.query_row(
            "SELECT COUNT(f.fill_id), COUNT(DISTINCT r.intent_id)
               FROM intents i
               JOIN risk_reservations r ON r.intent_id = i.intent_id
               LEFT JOIN fills f ON f.intent_id = i.intent_id
              WHERE i.intent_id = ?1 AND i.purpose = 'open' AND r.active = 1",
            [&intent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if active_count != 1 {
            return Err(LedgerError::MissingActiveOpeningReservation);
        }
        if (terminal_state == OrderState::Filled && fill_count == 0)
            || (terminal_state == OrderState::Rejected && fill_count > 0)
        {
            return Err(LedgerError::InvalidTerminalOutcome);
        }

        let now = Utc::now().to_rfc3339();
        let changed = tx.execute(
            "UPDATE submission_attempts
                SET state = 'reconciled', reconciled_state = ?2, updated_at = ?3
              WHERE intent_id = ?1 AND state = 'acknowledged'",
            params![intent_id, state, now],
        )?;
        if changed != 1 {
            return Err(LedgerError::InvalidSubmissionTransition);
        }
        tx.execute(
            "UPDATE risk_reservations
                SET active = 0, released_at = datetime('now')
              WHERE intent_id = ?1 AND active = 1",
            [&intent_id],
        )?;
        tx.execute(
            "UPDATE intents SET state = ?2 WHERE intent_id = ?1",
            params![intent_id, state],
        )?;
        tx.execute(
            "UPDATE orders SET state = ?2, updated_at = ?3 WHERE intent_id = ?1",
            params![intent_id, state, now],
        )?;
        insert_audit(
            &tx,
            Some(&intent_id),
            "acknowledged_open_order_finalized",
            Some(state),
        )?;
        tx.commit()?;
        Ok(())
    }

    /// A timeout or malformed response after the request begins is always
    /// unknown. The same intent must be reconciled rather than submitted again.
    pub fn mark_submission_unknown(
        &self,
        intent_id: Uuid,
        detail_code: &'static str,
    ) -> Result<(), LedgerError> {
        self.transition_submission(
            intent_id,
            SubmissionTransition {
                expected_state: "submitting",
                attempt_state: "unknown",
                order_state: OrderState::Unknown,
                venue_order_id: None,
                detail_code: Some(detail_code),
                audit_event: "submission_unknown",
            },
        )
    }

    /// Moves an unknown submission back into the acknowledged reconciliation
    /// path after the venue returns an order for the exact same idempotency key.
    pub fn acknowledge_unknown_submission(
        &self,
        intent_id: Uuid,
        venue_order_id: &str,
    ) -> Result<(), LedgerError> {
        if venue_order_id.trim().is_empty() {
            return Err(LedgerError::InvalidVenueOrderId);
        }
        self.transition_submission(
            intent_id,
            SubmissionTransition {
                expected_state: "unknown",
                attempt_state: "acknowledged",
                order_state: OrderState::Acknowledged,
                venue_order_id: Some(venue_order_id),
                detail_code: Some("idempotent_recovery_acknowledged"),
                audit_event: "unknown_submission_acknowledged",
            },
        )
    }

    /// Atomically resolves an unknown opening submission after an authoritative
    /// rejection for the same idempotency key. No fill may exist and the
    /// original reservation is released in the same transaction.
    pub fn reject_unknown_open_submission(
        &self,
        intent_id: Uuid,
        detail_code: &'static str,
    ) -> Result<(), LedgerError> {
        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let intent_id = intent_id.to_string();
        let (fill_count, active_count): (i64, i64) = tx.query_row(
            "SELECT COUNT(f.fill_id), COUNT(DISTINCT r.intent_id)
               FROM intents i
               JOIN submission_attempts s ON s.intent_id = i.intent_id AND s.state = 'unknown'
               JOIN risk_reservations r ON r.intent_id = i.intent_id AND r.active = 1
               LEFT JOIN fills f ON f.intent_id = i.intent_id
              WHERE i.intent_id = ?1 AND i.purpose = 'open'",
            [&intent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if active_count != 1 {
            return Err(LedgerError::MissingActiveOpeningReservation);
        }
        if fill_count != 0 {
            return Err(LedgerError::InvalidTerminalOutcome);
        }
        let now = Utc::now().to_rfc3339();
        let changed = tx.execute(
            "UPDATE submission_attempts
                SET state = 'reconciled', reconciled_state = 'rejected',
                    detail_code = ?2, updated_at = ?3
              WHERE intent_id = ?1 AND state = 'unknown'",
            params![intent_id, detail_code, now],
        )?;
        if changed != 1 {
            return Err(LedgerError::InvalidSubmissionTransition);
        }
        tx.execute(
            "UPDATE risk_reservations
                SET active = 0, released_at = datetime('now')
              WHERE intent_id = ?1 AND active = 1",
            [&intent_id],
        )?;
        tx.execute(
            "UPDATE intents SET state = 'rejected' WHERE intent_id = ?1",
            [&intent_id],
        )?;
        tx.execute(
            "UPDATE orders SET state = 'rejected', updated_at = ?2 WHERE intent_id = ?1",
            params![intent_id, now],
        )?;
        insert_audit(
            &tx,
            Some(&intent_id),
            "unknown_open_submission_rejected",
            Some(detail_code),
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Records an authoritative pre-acceptance rejection (for example HTTP
    /// 400/401/403). Ambiguous transport and server failures must use
    /// `mark_submission_unknown` instead.
    pub fn reject_submission(
        &self,
        intent_id: Uuid,
        detail_code: &'static str,
    ) -> Result<(), LedgerError> {
        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let intent_id = intent_id.to_string();
        let now = Utc::now().to_rfc3339();
        let changed = tx.execute(
            "UPDATE submission_attempts
             SET state = 'reconciled', reconciled_state = 'rejected',
                 detail_code = ?2, updated_at = ?3
             WHERE intent_id = ?1 AND state = 'submitting'",
            params![intent_id, detail_code, now],
        )?;
        if changed != 1 {
            return Err(LedgerError::InvalidSubmissionTransition);
        }
        tx.execute(
            "UPDATE orders SET state = 'rejected', updated_at = ?2 WHERE intent_id = ?1",
            params![intent_id, now],
        )?;
        tx.execute(
            "UPDATE intents SET state = 'rejected' WHERE intent_id = ?1",
            [&intent_id],
        )?;
        insert_audit(
            &tx,
            Some(&intent_id),
            "submission_rejected",
            Some(detail_code),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn unresolved_submissions(&self) -> Result<Vec<SubmissionAttemptRecord>, LedgerError> {
        let connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT s.attempt_id, s.intent_id, s.client_order_id, s.request_fingerprint, s.state,
                    s.reconciled_state, s.venue_order_id, s.detail_code, s.started_at, s.updated_at,
                    i.instrument, i.notional_micros
               FROM submission_attempts s
               JOIN intents i ON i.intent_id = s.intent_id
              WHERE s.state IN ('submitting', 'acknowledged', 'unknown', 'quarantined')
              ORDER BY s.started_at",
        )?;
        let rows = statement.query_map([], submission_record_from_row)?;
        let records: rusqlite::Result<Vec<_>> = rows.collect();
        Ok(records?)
    }

    fn transition_submission(
        &self,
        intent_id: Uuid,
        transition: SubmissionTransition<'_>,
    ) -> Result<(), LedgerError> {
        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let intent_id = intent_id.to_string();
        let now = Utc::now().to_rfc3339();
        let changed = tx.execute(
            "UPDATE submission_attempts
             SET state = ?2, venue_order_id = COALESCE(?3, venue_order_id),
                 detail_code = ?4, updated_at = ?5
             WHERE intent_id = ?1 AND state = ?6",
            params![
                intent_id,
                transition.attempt_state,
                transition.venue_order_id,
                transition.detail_code,
                now,
                transition.expected_state,
            ],
        )?;
        if changed != 1 {
            return Err(LedgerError::InvalidSubmissionTransition);
        }
        let order_state = order_state_key(transition.order_state);
        tx.execute(
            "UPDATE orders
             SET venue_order_id = COALESCE(?2, venue_order_id), state = ?3, updated_at = ?4
             WHERE intent_id = ?1",
            params![intent_id, transition.venue_order_id, order_state, now],
        )?;
        tx.execute(
            "UPDATE intents SET state = ?2 WHERE intent_id = ?1",
            params![intent_id, order_state],
        )?;
        insert_audit(
            &tx,
            Some(&intent_id),
            transition.audit_event,
            transition.detail_code,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Idempotently records one opening fill and transfers only that filled
    /// exposure from the reservation into the strategy-owned lot.
    pub fn record_open_fill(
        &self,
        intent_id: Uuid,
        fill: &FillRecord,
    ) -> Result<FillOutcome, LedgerError> {
        let notional_micros = decimal_to_micros(fill.notional)?;
        let fee_micros = decimal_to_micros(fill.fee)?;
        if fill.venue_fill_id.is_empty()
            || fill.quantity <= Decimal::ZERO
            || fill.price <= Decimal::ZERO
            || notional_micros <= 0
            || fee_micros < 0
        {
            return Err(LedgerError::InvalidFillExposure);
        }

        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let intent_uuid = intent_id;
        let intent_id = intent_uuid.to_string();
        let duplicate = tx
            .query_row(
                "SELECT 1 FROM fills WHERE intent_id = ?1 AND venue_fill_id = ?2",
                params![intent_id, fill.venue_fill_id],
                |_| Ok(()),
            )
            .optional()?;
        if duplicate.is_some() {
            tx.commit()?;
            return Ok(FillOutcome::Duplicate);
        }

        let opening = tx
            .query_row(
                "SELECT i.risk_scope, i.account_scope, i.venue, i.strategy_id, i.instrument,
                        i.side, r.exposure_micros
                 FROM intents i
                 JOIN risk_reservations r ON r.intent_id = i.intent_id
                 WHERE i.intent_id = ?1 AND i.purpose = 'open' AND r.active = 1",
                [&intent_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            risk_scope,
            account_scope,
            venue,
            strategy_id,
            instrument,
            side,
            reserved_exposure_micros,
        )) = opening
        else {
            return Err(LedgerError::MissingActiveOpeningReservation);
        };
        if notional_micros > reserved_exposure_micros {
            return Err(LedgerError::InvalidFillExposure);
        }

        tx.execute(
            "INSERT INTO lots
             (lot_id, risk_scope, account_scope, venue, strategy_id, instrument, side,
              exposure_micros, status, opened_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', ?9)
             ON CONFLICT(lot_id) DO UPDATE SET
               exposure_micros = exposure_micros + excluded.exposure_micros",
            params![
                intent_id,
                risk_scope,
                account_scope,
                venue,
                strategy_id,
                instrument,
                side,
                notional_micros,
                fill.filled_at.to_rfc3339(),
            ],
        )?;
        tx.execute(
            "INSERT INTO fills
             (fill_id, intent_id, venue_fill_id, quantity, price, notional_micros,
              fee_micros, filled_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                Uuid::new_v5(&intent_uuid, fill.venue_fill_id.as_bytes()).to_string(),
                intent_id,
                fill.venue_fill_id,
                fill.quantity.normalize().to_string(),
                fill.price.normalize().to_string(),
                notional_micros,
                fee_micros,
                fill.filled_at.to_rfc3339(),
            ],
        )?;
        tx.execute(
            "UPDATE risk_reservations
             SET exposure_micros = exposure_micros - ?2
             WHERE intent_id = ?1 AND active = 1",
            params![intent_id, notional_micros],
        )?;
        tx.execute(
            "UPDATE intents SET state = 'partially_filled' WHERE intent_id = ?1",
            [&intent_id],
        )?;
        insert_audit(&tx, Some(&intent_id), "fill_recorded", None)?;
        tx.commit()?;
        Ok(FillOutcome::Recorded)
    }

    /// Idempotently records one reduce fill and decreases only the strategy's
    /// owned lot. A full reduction closes the lot atomically.
    pub fn record_reduce_fill(
        &self,
        intent_id: Uuid,
        fill: &FillRecord,
    ) -> Result<FillOutcome, LedgerError> {
        let notional_micros = decimal_to_micros(fill.notional)?;
        let fee_micros = decimal_to_micros(fill.fee)?;
        if fill.venue_fill_id.is_empty()
            || fill.quantity <= Decimal::ZERO
            || fill.price <= Decimal::ZERO
            || notional_micros <= 0
            || fee_micros < 0
        {
            return Err(LedgerError::InvalidFillExposure);
        }

        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let intent_uuid = intent_id;
        let intent_id = intent_uuid.to_string();
        let duplicate = tx
            .query_row(
                "SELECT 1 FROM fills WHERE intent_id = ?1 AND venue_fill_id = ?2",
                params![intent_id, fill.venue_fill_id],
                |_| Ok(()),
            )
            .optional()?;
        if duplicate.is_some() {
            tx.commit()?;
            return Ok(FillOutcome::Duplicate);
        }

        let reducible = tx
            .query_row(
                "SELECT l.lot_id, l.exposure_micros, i.notional_micros
                 FROM intents i
                 JOIN risk_reservations r ON r.intent_id = i.intent_id
                 JOIN lots l ON l.account_scope = i.account_scope
                   AND l.venue = i.venue
                   AND l.strategy_id = i.strategy_id
                   AND l.instrument = i.instrument
                 WHERE i.intent_id = ?1 AND i.purpose = 'reduce' AND r.active = 1
                   AND l.status = 'open' AND l.side <> i.side",
                [&intent_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((lot_id, lot_exposure_micros, intent_notional_micros)) = reducible else {
            return Err(LedgerError::MissingActiveReduceReservation);
        };
        let prior_fill_micros: i64 = tx.query_row(
            "SELECT COALESCE(SUM(notional_micros), 0) FROM fills WHERE intent_id = ?1",
            [&intent_id],
            |row| row.get(0),
        )?;
        let remaining_intent_micros = intent_notional_micros.saturating_sub(prior_fill_micros);
        if notional_micros > remaining_intent_micros || notional_micros > lot_exposure_micros {
            return Err(LedgerError::InvalidFillExposure);
        }

        tx.execute(
            "INSERT INTO fills
             (fill_id, intent_id, venue_fill_id, quantity, price, notional_micros,
              fee_micros, filled_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                Uuid::new_v5(&intent_uuid, fill.venue_fill_id.as_bytes()).to_string(),
                intent_id,
                fill.venue_fill_id,
                fill.quantity.normalize().to_string(),
                fill.price.normalize().to_string(),
                notional_micros,
                fee_micros,
                fill.filled_at.to_rfc3339(),
            ],
        )?;
        tx.execute(
            "UPDATE lots
             SET exposure_micros = exposure_micros - ?2,
                 status = CASE WHEN exposure_micros = ?2 THEN 'closed' ELSE 'open' END,
                 closed_at = CASE WHEN exposure_micros = ?2 THEN ?3 ELSE NULL END
             WHERE lot_id = ?1 AND status = 'open'",
            params![lot_id, notional_micros, fill.filled_at.to_rfc3339()],
        )?;
        tx.execute(
            "UPDATE intents SET state = 'partially_filled' WHERE intent_id = ?1",
            [&intent_id],
        )?;
        insert_audit(&tx, Some(&intent_id), "reduce_fill_recorded", None)?;
        tx.commit()?;
        Ok(FillOutcome::Recorded)
    }

    /// Releases only the unfilled remainder. Any partial fills must already be
    /// durable and materialized as a lot by `record_open_fill`.
    pub fn finalize_open_order(
        &self,
        intent_id: Uuid,
        terminal_state: OrderState,
    ) -> Result<(), LedgerError> {
        let state = match terminal_state {
            OrderState::Filled => "filled",
            OrderState::Canceled => "canceled",
            OrderState::Rejected => "rejected",
            _ => return Err(LedgerError::InvalidTerminalState),
        };
        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let intent_id = intent_id.to_string();
        let (fill_count, active_count): (i64, i64) = tx.query_row(
            "SELECT COUNT(f.fill_id), COUNT(DISTINCT r.intent_id)
                 FROM intents i
                 JOIN risk_reservations r ON r.intent_id = i.intent_id
                 LEFT JOIN fills f ON f.intent_id = i.intent_id
                 WHERE i.intent_id = ?1 AND i.purpose = 'open' AND r.active = 1",
            [&intent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if active_count != 1 {
            return Err(LedgerError::MissingActiveOpeningReservation);
        }
        if (terminal_state == OrderState::Filled && fill_count == 0)
            || (terminal_state == OrderState::Rejected && fill_count > 0)
        {
            return Err(LedgerError::InvalidTerminalOutcome);
        }
        tx.execute(
            "UPDATE risk_reservations
             SET active = 0, released_at = datetime('now')
             WHERE intent_id = ?1 AND active = 1",
            [&intent_id],
        )?;
        tx.execute(
            "UPDATE intents SET state = ?2 WHERE intent_id = ?1",
            params![intent_id, state],
        )?;
        tx.execute(
            "UPDATE orders SET state = ?2, updated_at = ?3 WHERE intent_id = ?1",
            params![intent_id, state, Utc::now().to_rfc3339()],
        )?;
        insert_audit(&tx, Some(&intent_id), "open_order_finalized", Some(state))?;
        tx.commit()?;
        Ok(())
    }

    pub fn finalize_reduce_order(
        &self,
        intent_id: Uuid,
        terminal_state: OrderState,
    ) -> Result<(), LedgerError> {
        let state = match terminal_state {
            OrderState::Filled => "filled",
            OrderState::Canceled => "canceled",
            OrderState::Rejected => "rejected",
            _ => return Err(LedgerError::InvalidTerminalState),
        };
        let mut connection = self.connection.lock().map_err(|_| LedgerError::Poisoned)?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let intent_id = intent_id.to_string();
        let (fill_count, active_count): (i64, i64) = tx.query_row(
            "SELECT COUNT(f.fill_id), COUNT(DISTINCT r.intent_id)
             FROM intents i
             JOIN risk_reservations r ON r.intent_id = i.intent_id
             LEFT JOIN fills f ON f.intent_id = i.intent_id
             WHERE i.intent_id = ?1 AND i.purpose = 'reduce' AND r.active = 1",
            [&intent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if active_count != 1 {
            return Err(LedgerError::MissingActiveReduceReservation);
        }
        if (terminal_state == OrderState::Filled && fill_count == 0)
            || (terminal_state == OrderState::Rejected && fill_count > 0)
        {
            return Err(LedgerError::InvalidTerminalOutcome);
        }
        tx.execute(
            "UPDATE risk_reservations
             SET active = 0, released_at = datetime('now')
             WHERE intent_id = ?1 AND active = 1",
            [&intent_id],
        )?;
        tx.execute(
            "UPDATE intents SET state = ?2 WHERE intent_id = ?1",
            params![intent_id, state],
        )?;
        tx.execute(
            "UPDATE orders SET state = ?2, updated_at = ?3 WHERE intent_id = ?1",
            params![intent_id, state, Utc::now().to_rfc3339()],
        )?;
        insert_audit(&tx, Some(&intent_id), "reduce_order_finalized", Some(state))?;
        tx.commit()?;
        Ok(())
    }
}

fn durable_snapshot(
    tx: &rusqlite::Transaction<'_>,
    context: &SnapshotContext<'_>,
    venue_day: &str,
) -> Result<RiskSnapshot, LedgerError> {
    let account_scope = context.account_scope;
    let risk_scope = context.risk_scope;
    let venue = context.venue;
    let strategy_id = context.strategy_id;
    let instrument = context.instrument;
    let (day_opening, daily_pnl) = tx
        .query_row(
            "SELECT opening_notional_micros, pnl_micros FROM daily_usage
             WHERE account_scope = ?1 AND venue = ?2 AND venue_day = ?3",
            params![account_scope, venue, venue_day],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?
        .unwrap_or((0, 0));

    let venue_reservations: i64 = tx.query_row(
        "SELECT COALESCE(SUM(exposure_micros), 0) FROM risk_reservations
         WHERE account_scope = ?1 AND venue = ?2 AND active = 1",
        params![account_scope, venue],
        |row| row.get(0),
    )?;
    let global_reservations: i64 = tx.query_row(
        "SELECT COALESCE(SUM(exposure_micros), 0) FROM risk_reservations
         WHERE risk_scope = ?1 AND active = 1",
        [risk_scope],
        |row| row.get(0),
    )?;
    let venue_lots: i64 = tx.query_row(
        "SELECT COALESCE(SUM(exposure_micros), 0) FROM lots
         WHERE account_scope = ?1 AND venue = ?2 AND status = 'open'",
        params![account_scope, venue],
        |row| row.get(0),
    )?;
    let global_lots: i64 = tx.query_row(
        "SELECT COALESCE(SUM(exposure_micros), 0) FROM lots
         WHERE risk_scope = ?1 AND status = 'open'",
        [risk_scope],
        |row| row.get(0),
    )?;
    let resting_entries: i64 = tx.query_row(
        "SELECT COUNT(*) FROM risk_reservations
         WHERE account_scope = ?1 AND venue = ?2 AND active = 1 AND opening_notional_micros > 0",
        params![account_scope, venue],
        |row| row.get(0),
    )?;
    let owned_lot: Option<(i64, String)> = tx
        .query_row(
            "SELECT exposure_micros, side FROM lots
             WHERE account_scope = ?1 AND venue = ?2 AND strategy_id = ?3
               AND instrument = ?4 AND status = 'open'",
            params![account_scope, venue, strategy_id, instrument],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let reserved_reductions: i64 = tx.query_row(
        "SELECT COALESCE(SUM(i.notional_micros), 0)
         FROM risk_reservations r
         JOIN intents i ON i.intent_id = r.intent_id
         WHERE i.account_scope = ?1 AND i.venue = ?2 AND i.strategy_id = ?3
           AND i.instrument = ?4 AND i.purpose = 'reduce' AND r.active = 1",
        params![account_scope, venue, strategy_id, instrument],
        |row| row.get(0),
    )?;
    let available_owned_exposure = owned_lot
        .as_ref()
        .map_or(0, |(exposure, _)| *exposure)
        .saturating_sub(reserved_reductions);

    let safety = durable_safety_state(tx, risk_scope, account_scope, venue, context.observed_at)?;

    Ok(RiskSnapshot {
        venue_day_opening_notional_usd: micros_to_decimal(day_opening),
        venue_open_exposure_usd: micros_to_decimal(venue_reservations + venue_lots),
        global_open_exposure_usd: micros_to_decimal(global_reservations + global_lots),
        venue_daily_pnl_usd: micros_to_decimal(daily_pnl),
        resting_entry_orders: u32::try_from(resting_entries).unwrap_or(u32::MAX),
        has_strategy_owned_lot: owned_lot.is_some(),
        strategy_owned_lot_side: owned_lot.as_ref().and_then(|(_, side)| side_from_key(side)),
        strategy_owned_lot_notional_usd: micros_to_decimal(available_owned_exposure),
        safety,
    })
}

fn durable_safety_state(
    tx: &rusqlite::Transaction<'_>,
    risk_scope: &str,
    account_scope: &str,
    venue: &str,
    now: DateTime<Utc>,
) -> Result<SafetyState, LedgerError> {
    let row = tx
        .query_row(
            "SELECT global_kill_switch, venue_paused, strategy_enabled, venue_eligible,
                    connector_healthy, market_data_fresh, license_allows_entries, observed_at
             FROM safety_state
             WHERE risk_scope = ?1 AND account_scope = ?2 AND venue = ?3",
            params![risk_scope, account_scope, venue],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((kill, paused, enabled, eligible, healthy, fresh, licensed, observed_at)) = row else {
        return Ok(SafetyState::default());
    };
    let parsed = DateTime::parse_from_rfc3339(&observed_at)
        .ok()
        .map(|value| value.with_timezone(&Utc));
    let current = parsed.is_some_and(|value| {
        let age = now.signed_duration_since(value).num_seconds();
        (0..=SAFETY_MAX_AGE_SECONDS).contains(&age)
    });
    if !current {
        return Ok(SafetyState::default());
    }
    Ok(SafetyState {
        global_kill_switch: kill != 0,
        venue_paused: paused != 0,
        strategy_enabled: enabled != 0,
        venue_eligible: eligible != 0,
        connector_healthy: healthy != 0,
        market_data_fresh: fresh != 0,
        license_allows_entries: licensed != 0,
    })
}

fn canonical_venue_day(
    tx: &rusqlite::Transaction<'_>,
    account_scope: &str,
    venue: &str,
    candidate: &str,
) -> Result<String, LedgerError> {
    let last_seen: Option<String> = tx.query_row(
        "SELECT MAX(venue_day) FROM daily_usage WHERE account_scope = ?1 AND venue = ?2",
        params![account_scope, venue],
        |row| row.get(0),
    )?;
    Ok(match last_seen {
        Some(last_seen) if last_seen.as_str() > candidate => last_seen,
        _ => candidate.to_owned(),
    })
}

fn insert_intent(
    tx: &rusqlite::Transaction<'_>,
    intent: &TradeIntent,
    notional_micros: i64,
    state: &str,
    created_at: &str,
) -> Result<(), LedgerError> {
    tx.execute(
        "INSERT INTO intents
         (intent_id, source_event_id, strategy_id, venue, risk_scope, account_scope, instrument,
          side, purpose, notional_micros, state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            intent.intent_id.to_string(),
            intent.source_event_id,
            intent.strategy_id,
            venue_key(intent.venue),
            intent.risk_scope.to_string(),
            intent.account_scope.to_string(),
            intent.instrument,
            side_key(intent.side),
            purpose_key(intent.purpose),
            notional_micros,
            state,
            created_at,
        ],
    )?;
    if let Some(prediction) = intent.prediction.as_ref() {
        tx.execute(
            "INSERT INTO prediction_intents
             (intent_id, outcome, contract_count, limit_price_cents, max_fee_cents)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                intent.intent_id.to_string(),
                prediction_outcome_key(prediction.outcome),
                i64::from(prediction.contract_count),
                i64::from(prediction.limit_price_cents),
                i64::from(prediction.max_fee_cents),
            ],
        )?;
    }
    Ok(())
}

fn insert_audit(
    tx: &rusqlite::Transaction<'_>,
    intent_id: Option<&str>,
    event_type: &str,
    detail_code: Option<&str>,
) -> Result<(), LedgerError> {
    tx.execute(
        "INSERT INTO audit_events (event_id, intent_id, event_type, detail_code, occurred_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'))",
        params![
            Uuid::new_v4().to_string(),
            intent_id,
            event_type,
            detail_code
        ],
    )?;
    Ok(())
}

fn validate_agent_activity(activity: &NewAgentActivity) -> Result<(), LedgerError> {
    let agent_id_valid = !activity.agent_id.is_empty()
        && activity.agent_id.len() <= 64
        && activity.agent_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        });
    let symbol_valid = activity.symbol.as_ref().is_none_or(|symbol| {
        !symbol.is_empty()
            && symbol.len() <= 16
            && symbol
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || matches!(byte, b'.' | b'-'))
    });
    let message_valid = !activity.message.trim().is_empty()
        && activity.message.len() <= 280
        && !activity
            .message
            .chars()
            .any(|character| character.is_control());
    let amount_valid = activity
        .amount_usd
        .is_none_or(|amount| amount >= Decimal::ZERO && amount <= Decimal::new(100_000_000, 2));
    if agent_id_valid && symbol_valid && message_valid && amount_valid {
        Ok(())
    } else {
        Err(LedgerError::InvalidAgentActivity)
    }
}

fn activity_mode_key(mode: AgentActivityMode) -> &'static str {
    match mode {
        AgentActivityMode::Practice => "practice",
        AgentActivityMode::Real => "real",
    }
}

fn activity_mode_from_key(value: &str) -> Option<AgentActivityMode> {
    match value {
        "practice" => Some(AgentActivityMode::Practice),
        "real" => Some(AgentActivityMode::Real),
        _ => None,
    }
}

fn activity_kind_key(kind: AgentActivityKind) -> &'static str {
    match kind {
        AgentActivityKind::Started => "started",
        AgentActivityKind::Paused => "paused",
        AgentActivityKind::MarketCheck => "market_check",
        AgentActivityKind::Signal => "signal",
        AgentActivityKind::Skipped => "skipped",
        AgentActivityKind::Reviewed => "reviewed",
        AgentActivityKind::OrderSubmitted => "order_submitted",
        AgentActivityKind::Filled => "filled",
        AgentActivityKind::Error => "error",
    }
}

fn activity_kind_from_key(value: &str) -> Option<AgentActivityKind> {
    match value {
        "started" => Some(AgentActivityKind::Started),
        "paused" => Some(AgentActivityKind::Paused),
        "market_check" => Some(AgentActivityKind::MarketCheck),
        "signal" => Some(AgentActivityKind::Signal),
        "skipped" => Some(AgentActivityKind::Skipped),
        "reviewed" => Some(AgentActivityKind::Reviewed),
        "order_submitted" => Some(AgentActivityKind::OrderSubmitted),
        "filled" => Some(AgentActivityKind::Filled),
        "error" => Some(AgentActivityKind::Error),
        _ => None,
    }
}

fn agent_activity_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentActivityRecord> {
    use rusqlite::types::Type;

    let invalid = |column: usize, message: &'static str| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            Type::Text,
            Box::new(std::io::Error::other(message)),
        )
    };
    let event_id_text: String = row.get(0)?;
    let mode_text: String = row.get(2)?;
    let kind_text: String = row.get(3)?;
    let occurred_at_text: String = row.get(7)?;
    let event_id =
        Uuid::parse_str(&event_id_text).map_err(|_| invalid(0, "invalid activity event id"))?;
    let mode =
        activity_mode_from_key(&mode_text).ok_or_else(|| invalid(2, "invalid activity mode"))?;
    let kind =
        activity_kind_from_key(&kind_text).ok_or_else(|| invalid(3, "invalid activity kind"))?;
    let occurred_at = DateTime::parse_from_rfc3339(&occurred_at_text)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| invalid(7, "invalid activity timestamp"))?;
    let amount_micros: Option<i64> = row.get(5)?;
    Ok(AgentActivityRecord {
        event_id,
        agent_id: row.get(1)?,
        mode,
        kind,
        symbol: row.get(4)?,
        amount_usd: amount_micros.map(micros_to_decimal),
        message: row.get(6)?,
        occurred_at,
    })
}

fn decimal_to_micros(amount: Decimal) -> Result<i64, LedgerError> {
    let scaled = amount * Decimal::from(MICROS_PER_DOLLAR);
    scaled.try_into().map_err(|_| LedgerError::MoneyOutOfRange)
}

fn micros_to_decimal(amount: i64) -> Decimal {
    Decimal::new(amount, 6)
}

fn venue_key(venue: Venue) -> &'static str {
    match venue {
        Venue::Robinhood => "robinhood",
        Venue::Coinbase => "coinbase",
        Venue::Kalshi => "kalshi",
        Venue::Polymarket => "polymarket",
    }
}

fn purpose_key(purpose: IntentPurpose) -> &'static str {
    match purpose {
        IntentPurpose::Open => "open",
        IntentPurpose::Reduce => "reduce",
    }
}

fn side_key(side: OrderSide) -> &'static str {
    match side {
        OrderSide::Buy => "buy",
        OrderSide::Sell => "sell",
    }
}

fn side_from_key(side: &str) -> Option<OrderSide> {
    match side {
        "buy" => Some(OrderSide::Buy),
        "sell" => Some(OrderSide::Sell),
        _ => None,
    }
}

fn order_state_key(state: OrderState) -> &'static str {
    match state {
        OrderState::Created => "created",
        OrderState::RiskRejected => "risk_rejected",
        OrderState::Reserved => "reserved",
        OrderState::Submitting => "submitting",
        OrderState::Acknowledged => "acknowledged",
        OrderState::PartiallyFilled => "partially_filled",
        OrderState::Filled => "filled",
        OrderState::Canceled => "canceled",
        OrderState::Rejected => "rejected",
        OrderState::Unknown => "unknown",
        OrderState::Reconciled => "reconciled",
    }
}

fn order_state_from_key(state: &str) -> Option<OrderState> {
    match state {
        "created" => Some(OrderState::Created),
        "risk_rejected" => Some(OrderState::RiskRejected),
        "reserved" => Some(OrderState::Reserved),
        "submitting" => Some(OrderState::Submitting),
        "acknowledged" => Some(OrderState::Acknowledged),
        "partially_filled" => Some(OrderState::PartiallyFilled),
        "filled" => Some(OrderState::Filled),
        "canceled" => Some(OrderState::Canceled),
        "rejected" => Some(OrderState::Rejected),
        "unknown" => Some(OrderState::Unknown),
        "reconciled" => Some(OrderState::Reconciled),
        _ => None,
    }
}

fn submission_record_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<SubmissionAttemptRecord> {
    use rusqlite::types::Type;

    let attempt_id_text: String = row.get(0)?;
    let intent_id_text: String = row.get(1)?;
    let state_text: String = row.get(4)?;
    let reconciled_state_text: Option<String> = row.get(5)?;
    let started_at_text: String = row.get(8)?;
    let updated_at_text: String = row.get(9)?;
    let attempt_id = Uuid::parse_str(&attempt_id_text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(error))
    })?;
    let intent_id = Uuid::parse_str(&intent_id_text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(1, Type::Text, Box::new(error))
    })?;
    let client_order_id: String = row.get(2)?;
    let client_order_uuid = Uuid::parse_str(&client_order_id).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, Type::Text, Box::new(error))
    })?;
    if client_order_uuid != intent_id {
        return Err(rusqlite::Error::FromSqlConversionFailure(
            2,
            Type::Text,
            Box::new(std::io::Error::other(
                "client order ID does not match intent",
            )),
        ));
    }
    let request_fingerprint: String = row.get(3)?;
    if request_fingerprint.len() != 64
        || !request_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(rusqlite::Error::FromSqlConversionFailure(
            3,
            Type::Text,
            Box::new(std::io::Error::other("invalid request fingerprint")),
        ));
    }
    let state = match state_text.as_str() {
        "submitting" => SubmissionAttemptState::Submitting,
        "acknowledged" => SubmissionAttemptState::Acknowledged,
        "unknown" => SubmissionAttemptState::Unknown,
        "reconciled" => SubmissionAttemptState::Reconciled,
        "quarantined" => SubmissionAttemptState::Quarantined,
        _ => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                4,
                Type::Text,
                Box::new(std::io::Error::other("invalid submission state")),
            ));
        }
    };
    let reconciled_state = reconciled_state_text
        .as_deref()
        .map(|value| {
            order_state_from_key(value).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    Type::Text,
                    Box::new(std::io::Error::other("invalid reconciled state")),
                )
            })
        })
        .transpose()?;
    let started_at = DateTime::parse_from_rfc3339(&started_at_text)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(8, Type::Text, Box::new(error))
        })?;
    let updated_at = DateTime::parse_from_rfc3339(&updated_at_text)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(9, Type::Text, Box::new(error))
        })?;
    let instrument: String = row.get(10)?;
    if instrument.is_empty() || instrument.len() > 32 {
        return Err(rusqlite::Error::FromSqlConversionFailure(
            10,
            Type::Text,
            Box::new(std::io::Error::other("invalid stored instrument")),
        ));
    }
    let notional_micros: i64 = row.get(11)?;
    if notional_micros <= 0 {
        return Err(rusqlite::Error::FromSqlConversionFailure(
            11,
            Type::Integer,
            Box::new(std::io::Error::other("invalid stored notional")),
        ));
    }

    Ok(SubmissionAttemptRecord {
        attempt_id,
        intent_id,
        client_order_id,
        request_fingerprint,
        state,
        reconciled_state,
        venue_order_id: row.get(6)?,
        detail_code: row.get(7)?,
        started_at,
        updated_at,
        instrument,
        notional_usd: micros_to_decimal(notional_micros),
    })
}

fn prediction_outcome_key(outcome: PredictionOutcome) -> &'static str {
    match outcome {
        PredictionOutcome::Yes => "yes",
        PredictionOutcome::No => "no",
    }
}

fn reason_key(reason: RiskRejection) -> &'static str {
    match reason {
        RiskRejection::PolicyInvalid => "policy_invalid",
        RiskRejection::InvalidNotional => "invalid_notional",
        RiskRejection::IntentExpired => "intent_expired",
        RiskRejection::ConnectorUnhealthy => "connector_unhealthy",
        RiskRejection::KillSwitchActive => "kill_switch_active",
        RiskRejection::VenuePaused => "venue_paused",
        RiskRejection::StrategyDisabled => "strategy_disabled",
        RiskRejection::VenueIneligible => "venue_ineligible",
        RiskRejection::MarketDataStale => "market_data_stale",
        RiskRejection::LicenseDisallowsEntry => "license_disallows_entry",
        RiskRejection::OrderLimitExceeded => "order_limit_exceeded",
        RiskRejection::DailyOpeningLimitExceeded => "daily_opening_limit_exceeded",
        RiskRejection::VenueExposureLimitExceeded => "venue_exposure_limit_exceeded",
        RiskRejection::GlobalExposureLimitExceeded => "global_exposure_limit_exceeded",
        RiskRejection::DailyLossStopReached => "daily_loss_stop_reached",
        RiskRejection::RestingEntryLimitExceeded => "resting_entry_limit_exceeded",
        RiskRejection::ExistingOwnedLot => "existing_owned_lot",
        RiskRejection::MissingOwnedLot => "missing_owned_lot",
        RiskRejection::ReduceExceedsOwnedLot => "reduce_exceeds_owned_lot",
        RiskRejection::ReduceWrongSide => "reduce_wrong_side",
        RiskRejection::InvalidPredictionOrder => "invalid_prediction_order",
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration as ChronoDuration, Utc};
    use daytradingbot_contracts::{IntentPurpose, OrderSide, OrderType, RiskPolicy, TradeIntent};
    use daytradingbot_core::{IntentIdentity, deterministic_intent_id};
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn activity_journal_is_customer_safe_and_newest_first() {
        let ledger = Ledger::open_in_memory().unwrap();
        let first_at = Utc::now() - ChronoDuration::minutes(1);
        ledger
            .record_agent_activity(&NewAgentActivity {
                agent_id: "bluechip".into(),
                mode: AgentActivityMode::Practice,
                kind: AgentActivityKind::MarketCheck,
                symbol: None,
                amount_usd: None,
                message: "Checked eight stocks. No trade matched today.".into(),
                occurred_at: first_at,
            })
            .unwrap();
        ledger
            .record_agent_activity(&NewAgentActivity {
                agent_id: "bluechip".into(),
                mode: AgentActivityMode::Practice,
                kind: AgentActivityKind::Signal,
                symbol: Some("AAPL".into()),
                amount_usd: Some(Decimal::new(500, 2)),
                message: "AAPL matched the agent's pullback rule.".into(),
                occurred_at: Utc::now(),
            })
            .unwrap();

        let activity = ledger.recent_agent_activity(10).unwrap();
        assert_eq!(activity.len(), 2);
        assert_eq!(activity[0].symbol.as_deref(), Some("AAPL"));
        assert_eq!(activity[0].amount_usd, Some(Decimal::new(500, 2)));
        assert_eq!(activity[1].occurred_at, first_at);
    }

    #[test]
    fn activity_journal_rejects_raw_or_unbounded_text() {
        let ledger = Ledger::open_in_memory().unwrap();
        let error = ledger
            .record_agent_activity(&NewAgentActivity {
                agent_id: "Bluechip With Spaces".into(),
                mode: AgentActivityMode::Real,
                kind: AgentActivityKind::Error,
                symbol: None,
                amount_usd: None,
                message: "bad\nraw payload".into(),
                occurred_at: Utc::now(),
            })
            .expect_err("unsafe activity must fail");
        assert!(matches!(error, LedgerError::InvalidAgentActivity));
    }

    fn trade_intent(account_scope: Uuid, event: &str) -> TradeIntent {
        trade_intent_for_purpose(account_scope, event, IntentPurpose::Open)
    }

    fn trade_intent_for_purpose(
        account_scope: Uuid,
        event: &str,
        purpose: IntentPurpose,
    ) -> TradeIntent {
        let now = Utc::now();
        let identity = IntentIdentity {
            source_event_id: event,
            strategy_id: "coinbase-spot-trend",
            venue: Venue::Coinbase,
            instrument: "BTC-USD",
            side: if purpose == IntentPurpose::Open {
                OrderSide::Buy
            } else {
                OrderSide::Sell
            },
            purpose,
        };
        TradeIntent {
            intent_id: deterministic_intent_id(identity),
            source_event_id: event.into(),
            strategy_id: identity.strategy_id.into(),
            venue: identity.venue,
            risk_scope: account_scope,
            account_scope,
            instrument: identity.instrument.into(),
            side: identity.side,
            order_type: OrderType::ImmediateOrCancel,
            purpose: identity.purpose,
            notional_usd: Decimal::new(500, 2),
            limit_price: None,
            prediction: None,
            signal_at: now,
            expires_at: now + ChronoDuration::minutes(1),
            rationale: "ledger test".into(),
        }
    }

    fn expect_reserved(outcome: ReservationOutcome) -> ReservedIntent {
        match outcome {
            ReservationOutcome::Reserved(reserved) => *reserved,
            other => panic!("expected reservation, got {other:?}"),
        }
    }

    fn reserve_with_state(
        ledger: &Ledger,
        intent: TradeIntent,
        policy: &RiskPolicy,
        state: &SafetyState,
    ) -> ReservationOutcome {
        ledger
            .update_safety_state(
                intent.risk_scope,
                intent.account_scope,
                intent.venue,
                state,
                Utc::now(),
            )
            .unwrap();
        ledger.reserve(intent, policy).unwrap()
    }

    fn reserve_ready(
        ledger: &Ledger,
        intent: TradeIntent,
        policy: &RiskPolicy,
    ) -> ReservationOutcome {
        reserve_with_state(ledger, intent, policy, &SafetyState::ready_for_entries())
    }

    fn fill(venue_fill_id: &str, notional: Decimal) -> FillRecord {
        FillRecord {
            venue_fill_id: venue_fill_id.into(),
            quantity: Decimal::ONE,
            price: notional,
            notional,
            fee: Decimal::ZERO,
            filled_at: Utc::now(),
        }
    }

    #[test]
    fn duplicate_intent_cannot_reserve_twice() {
        let ledger = Ledger::open_in_memory().unwrap();
        let intent = trade_intent(Uuid::new_v4(), "signal-1");
        expect_reserved(reserve_ready(
            &ledger,
            intent.clone(),
            &RiskPolicy::default(),
        ));
        assert_eq!(
            reserve_ready(&ledger, intent, &RiskPolicy::default()),
            ReservationOutcome::Duplicate
        );
    }

    #[test]
    fn durable_daily_cap_blocks_sixth_five_dollar_order() {
        let ledger = Ledger::open_in_memory().unwrap();
        let account = Uuid::new_v4();
        let policy = RiskPolicy::default();

        for index in 0..5 {
            let intent = trade_intent(account, &format!("signal-{index}"));
            let intent_id = intent.intent_id;
            expect_reserved(reserve_ready(&ledger, intent, &policy));
            ledger
                .finalize_open_order(intent_id, OrderState::Canceled)
                .unwrap();
        }
        let sixth = trade_intent(account, "signal-6");
        assert_eq!(
            reserve_ready(&ledger, sixth, &policy),
            ReservationOutcome::Rejected(RiskRejection::DailyOpeningLimitExceeded)
        );
    }

    #[test]
    fn two_connections_cannot_consume_same_intent() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("ledger.sqlite3");
        let first = Ledger::open(&path).unwrap();
        let second = Ledger::open(&path).unwrap();
        let intent = trade_intent(Uuid::new_v4(), "shared-signal");

        expect_reserved(reserve_ready(
            &first,
            intent.clone(),
            &RiskPolicy::default(),
        ));
        assert_eq!(
            second.reserve(intent, &RiskPolicy::default()).unwrap(),
            ReservationOutcome::Duplicate
        );
    }

    #[test]
    fn filled_order_cannot_release_without_recording_owned_lot() {
        let ledger = Ledger::open_in_memory().unwrap();
        let intent = trade_intent(Uuid::new_v4(), "filled-signal");
        let intent_id = intent.intent_id;
        let account_scope = intent.account_scope;
        expect_reserved(reserve_ready(&ledger, intent, &RiskPolicy::default()));

        assert!(matches!(
            ledger.finalize_open_order(intent_id, OrderState::Filled),
            Err(LedgerError::InvalidTerminalOutcome)
        ));
        ledger
            .record_open_fill(intent_id, &fill("venue-fill-1", Decimal::new(450, 2)))
            .unwrap();
        ledger
            .finalize_open_order(intent_id, OrderState::Filled)
            .unwrap();

        let next = trade_intent(account_scope, "next-signal");
        assert_eq!(
            reserve_ready(&ledger, next, &RiskPolicy::default()),
            ReservationOutcome::Rejected(RiskRejection::ExistingOwnedLot)
        );
    }

    #[test]
    fn oversized_fill_keeps_reservation_active() {
        let ledger = Ledger::open_in_memory().unwrap();
        let intent = trade_intent(Uuid::new_v4(), "oversized-fill");
        let intent_id = intent.intent_id;
        expect_reserved(reserve_ready(&ledger, intent, &RiskPolicy::default()));

        assert!(matches!(
            ledger.record_open_fill(
                intent_id,
                &fill("oversized-venue-fill", Decimal::new(501, 2)),
            ),
            Err(LedgerError::InvalidFillExposure)
        ));
        let active: i64 = ledger
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT active FROM risk_reservations WHERE intent_id = ?1",
                [intent_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active, 1);
    }

    #[test]
    fn durable_reservation_rechecks_current_kill_switch() {
        let ledger = Ledger::open_in_memory().unwrap();
        let intent = trade_intent(Uuid::new_v4(), "stale-approval");
        let safety = SafetyState {
            global_kill_switch: true,
            ..SafetyState::ready_for_entries()
        };

        assert_eq!(
            reserve_with_state(&ledger, intent, &RiskPolicy::default(), &safety),
            ReservationOutcome::Rejected(RiskRejection::KillSwitchActive)
        );
    }

    #[test]
    fn missing_or_stale_safety_heartbeat_fails_closed() {
        let ledger = Ledger::open_in_memory().unwrap();
        let missing = trade_intent(Uuid::new_v4(), "missing-safety");
        assert_eq!(
            ledger.reserve(missing, &RiskPolicy::default()).unwrap(),
            ReservationOutcome::Rejected(RiskRejection::ConnectorUnhealthy)
        );

        let stale = trade_intent(Uuid::new_v4(), "stale-safety");
        ledger
            .update_safety_state(
                stale.risk_scope,
                stale.account_scope,
                stale.venue,
                &SafetyState::ready_for_entries(),
                Utc::now() - ChronoDuration::seconds(SAFETY_MAX_AGE_SECONDS + 1),
            )
            .unwrap();
        assert_eq!(
            ledger.reserve(stale, &RiskPolicy::default()).unwrap(),
            ReservationOutcome::Rejected(RiskRejection::ConnectorUnhealthy)
        );
    }

    #[test]
    fn reduce_reservation_accepts_zero_new_exposure() {
        let ledger = Ledger::open_in_memory().unwrap();
        let account_scope = Uuid::new_v4();
        let open = trade_intent(account_scope, "open-before-reduce");
        let open_id = open.intent_id;
        expect_reserved(reserve_ready(&ledger, open, &RiskPolicy::default()));
        ledger
            .record_open_fill(
                open_id,
                &fill("open-fill-before-reduce", Decimal::new(500, 2)),
            )
            .unwrap();
        ledger
            .finalize_open_order(open_id, OrderState::Filled)
            .unwrap();

        let reduce =
            trade_intent_for_purpose(account_scope, "reduce-signal", IntentPurpose::Reduce);
        expect_reserved(reserve_ready(&ledger, reduce, &RiskPolicy::default()));
        assert_eq!(
            reserve_ready(
                &ledger,
                trade_intent_for_purpose(
                    account_scope,
                    "competing-reduce-signal",
                    IntentPurpose::Reduce,
                ),
                &RiskPolicy::default(),
            ),
            ReservationOutcome::Rejected(RiskRejection::ReduceExceedsOwnedLot)
        );
    }

    #[test]
    fn clock_rollback_cannot_reset_the_daily_bucket() {
        let ledger = Ledger::open_in_memory().unwrap();
        let account_scope = Uuid::new_v4();
        ledger
            .connection
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO daily_usage
                 (account_scope, venue, venue_day, opening_notional_micros)
                 VALUES (?1, 'coinbase', '2999-01-01', 25000000)",
                [account_scope.to_string()],
            )
            .unwrap();

        assert_eq!(
            reserve_ready(
                &ledger,
                trade_intent(account_scope, "after-clock-rollback"),
                &RiskPolicy::default(),
            ),
            ReservationOutcome::Rejected(RiskRejection::DailyOpeningLimitExceeded)
        );
    }

    #[test]
    fn partial_fill_then_cancel_keeps_real_exposure_in_the_lot() {
        let ledger = Ledger::open_in_memory().unwrap();
        let intent = trade_intent(Uuid::new_v4(), "partial-then-cancel");
        let intent_id = intent.intent_id;
        expect_reserved(reserve_ready(&ledger, intent, &RiskPolicy::default()));
        assert_eq!(
            ledger
                .record_open_fill(intent_id, &fill("partial-fill-1", Decimal::new(200, 2)))
                .unwrap(),
            FillOutcome::Recorded
        );
        ledger
            .finalize_open_order(intent_id, OrderState::Canceled)
            .unwrap();

        let (lot_exposure, reservation_active): (i64, i64) = ledger
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT l.exposure_micros, r.active
                 FROM lots l JOIN risk_reservations r ON r.intent_id = l.lot_id
                 WHERE l.lot_id = ?1",
                [intent_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(lot_exposure, 2_000_000);
        assert_eq!(reservation_active, 0);
    }

    #[test]
    fn reduce_fills_only_decrease_the_strategy_owned_lot() {
        let ledger = Ledger::open_in_memory().unwrap();
        let account_scope = Uuid::new_v4();
        let open = trade_intent(account_scope, "open-for-reduce-fills");
        let open_id = open.intent_id;
        expect_reserved(reserve_ready(&ledger, open, &RiskPolicy::default()));
        ledger
            .record_open_fill(open_id, &fill("opening-fill", Decimal::new(500, 2)))
            .unwrap();
        ledger
            .finalize_open_order(open_id, OrderState::Filled)
            .unwrap();

        let reduce =
            trade_intent_for_purpose(account_scope, "partial-reduce", IntentPurpose::Reduce);
        let reduce_id = reduce.intent_id;
        expect_reserved(reserve_ready(&ledger, reduce, &RiskPolicy::default()));
        ledger
            .record_reduce_fill(reduce_id, &fill("reduce-fill-1", Decimal::new(200, 2)))
            .unwrap();
        ledger
            .finalize_reduce_order(reduce_id, OrderState::Canceled)
            .unwrap();

        let mut final_reduce =
            trade_intent_for_purpose(account_scope, "final-reduce", IntentPurpose::Reduce);
        final_reduce.notional_usd = Decimal::new(300, 2);
        let final_reduce_id = final_reduce.intent_id;
        expect_reserved(reserve_ready(&ledger, final_reduce, &RiskPolicy::default()));
        ledger
            .record_reduce_fill(
                final_reduce_id,
                &fill("reduce-fill-2", Decimal::new(300, 2)),
            )
            .unwrap();
        ledger
            .finalize_reduce_order(final_reduce_id, OrderState::Filled)
            .unwrap();

        let (exposure, status): (i64, String) = ledger
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT exposure_micros, status FROM lots WHERE lot_id = ?1",
                [open_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(exposure, 0);
        assert_eq!(status, "closed");
    }

    #[test]
    fn reconciled_daily_loss_blocks_the_next_entry() {
        let ledger = Ledger::open_in_memory().unwrap();
        let account_scope = Uuid::new_v4();
        ledger
            .update_venue_pnl(
                account_scope,
                Venue::Coinbase,
                Decimal::new(-1_000, 2),
                Utc::now(),
            )
            .unwrap();

        assert_eq!(
            reserve_ready(
                &ledger,
                trade_intent(account_scope, "after-loss-stop"),
                &RiskPolicy::default(),
            ),
            ReservationOutcome::Rejected(RiskRejection::DailyLossStopReached)
        );
    }

    #[test]
    fn submission_is_durable_before_network_and_cannot_be_retried() {
        let ledger = Ledger::open_in_memory().unwrap();
        let account_scope = Uuid::new_v4();
        let intent = trade_intent(account_scope, "one-shot-submit");
        let intent_id = intent.intent_id;
        expect_reserved(reserve_ready(&ledger, intent, &RiskPolicy::default()));

        let attempt = ledger
            .begin_submission(intent_id, Uuid::new_v4(), &"a".repeat(64))
            .unwrap();
        assert_eq!(attempt.client_order_id, intent_id.to_string());
        assert_eq!(attempt.state, SubmissionAttemptState::Submitting);
        assert_eq!(ledger.unresolved_submissions().unwrap(), vec![attempt]);

        assert!(matches!(
            ledger.begin_submission(intent_id, Uuid::new_v4(), &"b".repeat(64)),
            Err(LedgerError::SubmissionAlreadyExists)
        ));
    }

    #[test]
    fn acknowledged_submission_stays_visible_until_terminal_reconciliation() {
        let ledger = Ledger::open_in_memory().unwrap();
        let account_scope = Uuid::new_v4();
        let intent = trade_intent(account_scope, "acknowledged-submit");
        let intent_id = intent.intent_id;
        expect_reserved(reserve_ready(&ledger, intent, &RiskPolicy::default()));
        ledger
            .begin_submission(intent_id, Uuid::new_v4(), &"d".repeat(64))
            .unwrap();
        ledger
            .acknowledge_submission(intent_id, "venue-order-id")
            .unwrap();
        assert_eq!(
            ledger.unresolved_submissions().unwrap()[0].state,
            SubmissionAttemptState::Acknowledged
        );

        ledger
            .record_open_fill(intent_id, &fill("venue-fill", Decimal::new(500, 2)))
            .unwrap();
        ledger
            .reconcile_acknowledged_submission(intent_id, OrderState::Filled)
            .unwrap();
        ledger
            .finalize_open_order(intent_id, OrderState::Filled)
            .unwrap();
        assert!(ledger.unresolved_submissions().unwrap().is_empty());
    }

    #[test]
    fn filled_acknowledgement_without_a_fill_remains_unresolved() {
        let ledger = Ledger::open_in_memory().unwrap();
        let account_scope = Uuid::new_v4();
        let intent = trade_intent(account_scope, "filled-without-execution");
        let intent_id = intent.intent_id;
        expect_reserved(reserve_ready(&ledger, intent, &RiskPolicy::default()));
        ledger
            .begin_submission(intent_id, Uuid::new_v4(), &"e".repeat(64))
            .unwrap();
        ledger
            .acknowledge_submission(intent_id, "venue-order-id")
            .unwrap();

        assert!(matches!(
            ledger.finalize_acknowledged_open_order(intent_id, OrderState::Filled),
            Err(LedgerError::InvalidTerminalOutcome)
        ));
        assert_eq!(
            ledger.unresolved_submissions().unwrap()[0].state,
            SubmissionAttemptState::Acknowledged
        );

        ledger
            .record_open_fill(intent_id, &fill("venue-fill", Decimal::new(500, 2)))
            .unwrap();
        ledger
            .finalize_acknowledged_open_order(intent_id, OrderState::Filled)
            .unwrap();
        assert!(ledger.unresolved_submissions().unwrap().is_empty());
    }

    #[test]
    fn unknown_submission_must_reconcile_before_terminal_release() {
        let ledger = Ledger::open_in_memory().unwrap();
        let account_scope = Uuid::new_v4();
        let intent = trade_intent(account_scope, "unknown-submit");
        let intent_id = intent.intent_id;
        expect_reserved(reserve_ready(&ledger, intent, &RiskPolicy::default()));
        ledger
            .begin_submission(intent_id, Uuid::new_v4(), &"c".repeat(64))
            .unwrap();
        ledger
            .mark_submission_unknown(intent_id, "response_timeout")
            .unwrap();

        let unresolved = ledger.unresolved_submissions().unwrap();
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].state, SubmissionAttemptState::Unknown);
        assert_eq!(unresolved[0].instrument, "BTC-USD");
        assert_eq!(unresolved[0].notional_usd, Decimal::new(500, 2));
        assert_eq!(
            unresolved[0].detail_code.as_deref(),
            Some("response_timeout")
        );
        assert!(matches!(
            ledger.acknowledge_submission(intent_id, "must-not-bypass-reconcile"),
            Err(LedgerError::InvalidSubmissionTransition)
        ));

        ledger
            .reject_unknown_open_submission(intent_id, "idempotent_retry_rejected")
            .unwrap();
        assert!(ledger.unresolved_submissions().unwrap().is_empty());
        assert!(matches!(
            ledger.finalize_open_order(intent_id, OrderState::Rejected),
            Err(LedgerError::MissingActiveOpeningReservation)
        ));
    }

    #[test]
    fn unknown_submission_can_rejoin_acknowledged_reconciliation() {
        let ledger = Ledger::open_in_memory().unwrap();
        let account_scope = Uuid::new_v4();
        let intent = trade_intent(account_scope, "unknown-idempotent-ack");
        let intent_id = intent.intent_id;
        expect_reserved(reserve_ready(&ledger, intent, &RiskPolicy::default()));
        ledger
            .begin_submission(intent_id, Uuid::new_v4(), &"d".repeat(64))
            .unwrap();
        ledger
            .mark_submission_unknown(intent_id, "response_timeout")
            .unwrap();
        ledger
            .acknowledge_unknown_submission(intent_id, "7d9cb833-f8df-4ec0-92c7-11999db88673")
            .unwrap();

        let unresolved = ledger.unresolved_submissions().unwrap();
        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0].state, SubmissionAttemptState::Acknowledged);
        ledger
            .finalize_acknowledged_open_order(intent_id, OrderState::Rejected)
            .unwrap();
        assert!(ledger.unresolved_submissions().unwrap().is_empty());
    }
}
