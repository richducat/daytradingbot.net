use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use daytradingbot_contracts::{
    IntentPurpose, OrderSide, OrderState, RiskDecision, RiskPolicy, RiskRejection, RiskSnapshot,
    SafetyState, TradeIntent, Venue,
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
    }
}

#[cfg(test)]
mod tests {
    use chrono::{Duration as ChronoDuration, Utc};
    use daytradingbot_contracts::{IntentPurpose, OrderSide, OrderType, RiskPolicy, TradeIntent};
    use daytradingbot_core::{IntentIdentity, deterministic_intent_id};
    use tempfile::tempdir;

    use super::*;

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
}
