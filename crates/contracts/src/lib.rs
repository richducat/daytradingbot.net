use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Venue {
    Robinhood,
    Coinbase,
    Kalshi,
    Polymarket,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderType {
    Market,
    Limit,
    ImmediateOrCancel,
    FillAndKill,
    FillOrKill,
    GoodTilDate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentPurpose {
    Open,
    Reduce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PredictionOutcome {
    Yes,
    No,
}

/// Exact event-contract order semantics. Prices and fees are integer cents so
/// a connector never has to infer contract quantity from a floating-point
/// dollar amount.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PredictionOrderSpec {
    pub outcome: PredictionOutcome,
    pub contract_count: u32,
    pub limit_price_cents: u8,
    /// Total fee allowance for the complete order, not per contract.
    pub max_fee_cents: u32,
}

impl PredictionOrderSpec {
    #[must_use]
    pub fn worst_case_loss_cents(&self) -> Option<u64> {
        u64::from(self.contract_count)
            .checked_mul(u64::from(self.limit_price_cents))?
            .checked_add(u64::from(self.max_fee_cents))
    }

    #[must_use]
    pub fn is_valid(&self) -> bool {
        self.contract_count > 0
            && (1..=99).contains(&self.limit_price_cents)
            && self.worst_case_loss_cents().is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TradeIntent {
    pub intent_id: Uuid,
    pub source_event_id: String,
    pub strategy_id: String,
    pub venue: Venue,
    /// Stable installation/license scope used for the cross-venue global cap.
    pub risk_scope: Uuid,
    /// Random local identifier. Never use or transmit a raw broker account number here.
    pub account_scope: Uuid,
    pub instrument: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub purpose: IntentPurpose,
    #[serde(with = "rust_decimal::serde::str")]
    pub notional_usd: Decimal,
    #[serde(with = "rust_decimal::serde::str_option")]
    pub limit_price: Option<Decimal>,
    /// Required for event-contract venues and absent for spot/equity venues.
    pub prediction: Option<PredictionOrderSpec>,
    pub signal_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub rationale: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderState {
    Created,
    RiskRejected,
    Reserved,
    Submitting,
    Acknowledged,
    PartiallyFilled,
    Filled,
    Canceled,
    Rejected,
    Unknown,
    Reconciled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RiskPolicy {
    #[serde(with = "rust_decimal::serde::str")]
    pub max_opening_order_usd: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub max_daily_opening_notional_usd: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub max_venue_exposure_usd: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub max_global_exposure_usd: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub max_daily_loss_usd: Decimal,
    pub max_resting_entry_orders: u32,
}

impl Default for RiskPolicy {
    fn default() -> Self {
        Self {
            max_opening_order_usd: Decimal::new(500, 2),
            max_daily_opening_notional_usd: Decimal::new(2_500, 2),
            max_venue_exposure_usd: Decimal::new(10_000, 2),
            max_global_exposure_usd: Decimal::new(20_000, 2),
            max_daily_loss_usd: Decimal::new(1_000, 2),
            max_resting_entry_orders: 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafetyState {
    pub global_kill_switch: bool,
    pub venue_paused: bool,
    pub strategy_enabled: bool,
    pub venue_eligible: bool,
    pub connector_healthy: bool,
    pub market_data_fresh: bool,
    pub license_allows_entries: bool,
}

impl Default for SafetyState {
    fn default() -> Self {
        Self {
            global_kill_switch: true,
            venue_paused: true,
            strategy_enabled: false,
            venue_eligible: false,
            connector_healthy: false,
            market_data_fresh: false,
            license_allows_entries: false,
        }
    }
}

impl SafetyState {
    /// Explicit healthy state for a freshly verified connector and license.
    /// Production code must build this from authoritative backend checks.
    #[must_use]
    pub fn ready_for_entries() -> Self {
        Self {
            global_kill_switch: false,
            venue_paused: false,
            strategy_enabled: true,
            venue_eligible: true,
            connector_healthy: true,
            market_data_fresh: true,
            license_allows_entries: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RiskSnapshot {
    #[serde(with = "rust_decimal::serde::str")]
    pub venue_day_opening_notional_usd: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub venue_open_exposure_usd: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub global_open_exposure_usd: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub venue_daily_pnl_usd: Decimal,
    pub resting_entry_orders: u32,
    pub has_strategy_owned_lot: bool,
    pub strategy_owned_lot_side: Option<OrderSide>,
    #[serde(with = "rust_decimal::serde::str")]
    pub strategy_owned_lot_notional_usd: Decimal,
    pub safety: SafetyState,
}

impl Default for RiskSnapshot {
    fn default() -> Self {
        Self {
            venue_day_opening_notional_usd: Decimal::ZERO,
            venue_open_exposure_usd: Decimal::ZERO,
            global_open_exposure_usd: Decimal::ZERO,
            venue_daily_pnl_usd: Decimal::ZERO,
            resting_entry_orders: 0,
            has_strategy_owned_lot: false,
            strategy_owned_lot_side: None,
            strategy_owned_lot_notional_usd: Decimal::ZERO,
            safety: SafetyState::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskRejection {
    PolicyInvalid,
    InvalidNotional,
    IntentExpired,
    ConnectorUnhealthy,
    KillSwitchActive,
    VenuePaused,
    StrategyDisabled,
    VenueIneligible,
    MarketDataStale,
    LicenseDisallowsEntry,
    OrderLimitExceeded,
    DailyOpeningLimitExceeded,
    VenueExposureLimitExceeded,
    GlobalExposureLimitExceeded,
    DailyLossStopReached,
    RestingEntryLimitExceeded,
    ExistingOwnedLot,
    MissingOwnedLot,
    ReduceExceedsOwnedLot,
    ReduceWrongSide,
    InvalidPredictionOrder,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prediction_order_uses_exact_integer_worst_case_loss() {
        let spec = PredictionOrderSpec {
            outcome: PredictionOutcome::Yes,
            contract_count: 1,
            limit_price_cents: 99,
            max_fee_cents: 1,
        };

        assert!(spec.is_valid());
        assert_eq!(spec.worst_case_loss_cents(), Some(100));
    }

    #[test]
    fn prediction_order_rejects_zero_contracts_and_invalid_prices() {
        for spec in [
            PredictionOrderSpec {
                outcome: PredictionOutcome::No,
                contract_count: 0,
                limit_price_cents: 50,
                max_fee_cents: 1,
            },
            PredictionOrderSpec {
                outcome: PredictionOutcome::No,
                contract_count: 1,
                limit_price_cents: 100,
                max_fee_cents: 0,
            },
        ] {
            assert!(!spec.is_valid());
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum RiskDecision {
    Allowed,
    Rejected { reason: RiskRejection },
}
