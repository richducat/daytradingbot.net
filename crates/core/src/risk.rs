use chrono::Utc;
use daytradingbot_contracts::{
    IntentPurpose, RiskDecision, RiskPolicy, RiskRejection, RiskSnapshot, TradeIntent, Venue,
};
use rust_decimal::Decimal;
use thiserror::Error;

#[derive(Debug, Clone, Copy, Default)]
pub struct RiskEngine;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PolicyError {
    #[error("risk limits must be positive")]
    NonPositiveLimit,
    #[error("customer limits may be lowered but never raised")]
    LimitRaised,
}

impl RiskEngine {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    pub fn validate_customer_policy(&self, candidate: &RiskPolicy) -> Result<(), PolicyError> {
        let positive = [
            candidate.max_opening_order_usd,
            candidate.max_daily_opening_notional_usd,
            candidate.max_venue_exposure_usd,
            candidate.max_global_exposure_usd,
            candidate.max_daily_loss_usd,
        ]
        .into_iter()
        .all(|value| value > Decimal::ZERO)
            && candidate.max_resting_entry_orders > 0;

        if !positive {
            return Err(PolicyError::NonPositiveLimit);
        }

        let launch_maximums = RiskPolicy::customer_configurable_maximums();
        let within_launch_maximums = candidate.max_opening_order_usd
            <= launch_maximums.max_opening_order_usd
            && candidate.max_daily_opening_notional_usd
                <= launch_maximums.max_daily_opening_notional_usd
            && candidate.max_venue_exposure_usd <= launch_maximums.max_venue_exposure_usd
            && candidate.max_global_exposure_usd <= launch_maximums.max_global_exposure_usd
            && candidate.max_daily_loss_usd <= launch_maximums.max_daily_loss_usd
            && candidate.max_resting_entry_orders <= launch_maximums.max_resting_entry_orders;

        if within_launch_maximums {
            Ok(())
        } else {
            Err(PolicyError::LimitRaised)
        }
    }

    #[must_use]
    pub fn evaluate(
        &self,
        intent: &TradeIntent,
        snapshot: &RiskSnapshot,
        policy: &RiskPolicy,
    ) -> RiskDecision {
        if self.validate_customer_policy(policy).is_err() {
            return reject(RiskRejection::PolicyInvalid);
        }
        if intent.notional_usd <= Decimal::ZERO {
            return reject(RiskRejection::InvalidNotional);
        }
        let prediction_valid = match (intent.venue, intent.prediction.as_ref()) {
            (Venue::Kalshi, Some(spec)) if spec.is_valid() => {
                if intent.purpose == IntentPurpose::Open {
                    spec.worst_case_loss_cents()
                        .and_then(|cents| i64::try_from(cents).ok())
                        .is_some_and(|cents| Decimal::new(cents, 2) == intent.notional_usd)
                } else {
                    true
                }
            }
            (Venue::Kalshi, _) => false,
            (_, None) => true,
            (_, Some(_)) => false,
        };
        if !prediction_valid {
            return reject(RiskRejection::InvalidPredictionOrder);
        }
        if intent.expires_at <= Utc::now() {
            return reject(RiskRejection::IntentExpired);
        }
        if !snapshot.safety.connector_healthy {
            return reject(RiskRejection::ConnectorUnhealthy);
        }

        if intent.purpose == IntentPurpose::Reduce {
            if !snapshot.has_strategy_owned_lot {
                return reject(RiskRejection::MissingOwnedLot);
            }
            if intent.notional_usd > snapshot.strategy_owned_lot_notional_usd {
                return reject(RiskRejection::ReduceExceedsOwnedLot);
            }
            if snapshot.strategy_owned_lot_side == Some(intent.side) {
                return reject(RiskRejection::ReduceWrongSide);
            }
            return RiskDecision::Allowed;
        }

        let entry_state_checks = [
            (
                snapshot.safety.global_kill_switch,
                RiskRejection::KillSwitchActive,
            ),
            (snapshot.safety.venue_paused, RiskRejection::VenuePaused),
            (
                !snapshot.safety.strategy_enabled,
                RiskRejection::StrategyDisabled,
            ),
            (
                !snapshot.safety.venue_eligible,
                RiskRejection::VenueIneligible,
            ),
            (
                !snapshot.safety.market_data_fresh,
                RiskRejection::MarketDataStale,
            ),
            (
                !snapshot.safety.license_allows_entries,
                RiskRejection::LicenseDisallowsEntry,
            ),
        ];
        if let Some((_, reason)) = entry_state_checks.iter().find(|(blocked, _)| *blocked) {
            return reject(*reason);
        }

        if intent.notional_usd > policy.max_opening_order_usd {
            return reject(RiskRejection::OrderLimitExceeded);
        }
        if snapshot.venue_day_opening_notional_usd + intent.notional_usd
            > policy.max_daily_opening_notional_usd
        {
            return reject(RiskRejection::DailyOpeningLimitExceeded);
        }
        if snapshot.venue_open_exposure_usd + intent.notional_usd > policy.max_venue_exposure_usd {
            return reject(RiskRejection::VenueExposureLimitExceeded);
        }
        if snapshot.global_open_exposure_usd + intent.notional_usd > policy.max_global_exposure_usd
        {
            return reject(RiskRejection::GlobalExposureLimitExceeded);
        }
        if snapshot.venue_daily_pnl_usd <= -policy.max_daily_loss_usd {
            return reject(RiskRejection::DailyLossStopReached);
        }
        if snapshot.resting_entry_orders >= policy.max_resting_entry_orders {
            return reject(RiskRejection::RestingEntryLimitExceeded);
        }
        if snapshot.has_strategy_owned_lot {
            return reject(RiskRejection::ExistingOwnedLot);
        }

        RiskDecision::Allowed
    }
}

fn reject(reason: RiskRejection) -> RiskDecision {
    RiskDecision::Rejected { reason }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;
    use daytradingbot_contracts::{
        IntentPurpose, OrderSide, OrderType, PredictionOrderSpec, PredictionOutcome, RiskRejection,
        Venue,
    };
    use uuid::Uuid;

    use super::*;

    fn intent(purpose: IntentPurpose, notional: Decimal) -> TradeIntent {
        let now = Utc::now();
        TradeIntent {
            intent_id: Uuid::new_v4(),
            source_event_id: "fixture-1".into(),
            strategy_id: "coinbase-spot-trend".into(),
            venue: Venue::Coinbase,
            risk_scope: Uuid::new_v4(),
            account_scope: Uuid::new_v4(),
            instrument: "BTC-USD".into(),
            side: if purpose == IntentPurpose::Open {
                OrderSide::Buy
            } else {
                OrderSide::Sell
            },
            order_type: OrderType::ImmediateOrCancel,
            purpose,
            notional_usd: notional,
            limit_price: None,
            prediction: None,
            signal_at: now,
            expires_at: now + Duration::minutes(1),
            rationale: "test fixture".into(),
        }
    }

    fn ready_snapshot() -> RiskSnapshot {
        RiskSnapshot {
            safety: daytradingbot_contracts::SafetyState::ready_for_entries(),
            ..RiskSnapshot::default()
        }
    }

    #[test]
    fn kalshi_entry_requires_exact_contract_semantics_and_worst_case_notional() {
        let engine = RiskEngine::new();
        let mut kalshi = intent(IntentPurpose::Open, Decimal::new(52, 2));
        kalshi.venue = Venue::Kalshi;
        kalshi.prediction = Some(PredictionOrderSpec {
            outcome: PredictionOutcome::Yes,
            contract_count: 1,
            limit_price_cents: 50,
            max_fee_cents: 2,
        });
        assert_eq!(
            engine.evaluate(&kalshi, &ready_snapshot(), &RiskPolicy::default()),
            RiskDecision::Allowed
        );

        kalshi.notional_usd = Decimal::new(50, 2);
        assert_eq!(
            engine.evaluate(&kalshi, &ready_snapshot(), &RiskPolicy::default()),
            RiskDecision::Rejected {
                reason: RiskRejection::InvalidPredictionOrder
            }
        );
    }

    #[test]
    fn allows_entry_at_every_exact_boundary() {
        let engine = RiskEngine::new();
        let policy = RiskPolicy::default();
        let snapshot = RiskSnapshot {
            venue_day_opening_notional_usd: Decimal::new(2_000, 2),
            venue_open_exposure_usd: Decimal::new(9_500, 2),
            global_open_exposure_usd: Decimal::new(19_500, 2),
            safety: daytradingbot_contracts::SafetyState::ready_for_entries(),
            ..RiskSnapshot::default()
        };

        assert_eq!(
            engine.evaluate(
                &intent(IntentPurpose::Open, Decimal::new(500, 2)),
                &snapshot,
                &policy
            ),
            RiskDecision::Allowed
        );
    }

    #[test]
    fn blocks_entry_one_cent_over_order_cap() {
        let engine = RiskEngine::new();
        let policy = RiskPolicy::default();
        assert_eq!(
            engine.evaluate(
                &intent(IntentPurpose::Open, Decimal::new(501, 2)),
                &ready_snapshot(),
                &policy,
            ),
            reject(RiskRejection::OrderLimitExceeded)
        );
    }

    #[test]
    fn kill_switch_blocks_entry_but_not_owned_exit() {
        let engine = RiskEngine::new();
        let policy = RiskPolicy::default();
        let snapshot = RiskSnapshot {
            has_strategy_owned_lot: true,
            strategy_owned_lot_side: Some(OrderSide::Buy),
            strategy_owned_lot_notional_usd: Decimal::new(1_250, 2),
            safety: daytradingbot_contracts::SafetyState {
                global_kill_switch: true,
                ..daytradingbot_contracts::SafetyState::ready_for_entries()
            },
            ..RiskSnapshot::default()
        };

        assert_eq!(
            engine.evaluate(
                &intent(IntentPurpose::Open, Decimal::new(500, 2)),
                &snapshot,
                &policy
            ),
            reject(RiskRejection::KillSwitchActive)
        );
        assert_eq!(
            engine.evaluate(
                &intent(IntentPurpose::Reduce, Decimal::new(1_250, 2)),
                &snapshot,
                &policy
            ),
            RiskDecision::Allowed
        );
    }

    #[test]
    fn customer_may_lower_but_not_raise_limits() {
        let engine = RiskEngine::new();
        let lower = RiskPolicy {
            max_opening_order_usd: Decimal::new(400, 2),
            ..RiskPolicy::default()
        };
        assert_eq!(engine.validate_customer_policy(&lower), Ok(()));

        let raised = RiskPolicy {
            max_opening_order_usd: Decimal::from(1_000_001_u64),
            ..RiskPolicy::default()
        };
        assert_eq!(
            engine.validate_customer_policy(&raised),
            Err(PolicyError::LimitRaised)
        );
    }

    #[test]
    fn exit_cannot_touch_an_unowned_position() {
        let engine = RiskEngine::new();
        assert_eq!(
            engine.evaluate(
                &intent(IntentPurpose::Reduce, Decimal::new(500, 2)),
                &ready_snapshot(),
                &RiskPolicy::default(),
            ),
            reject(RiskRejection::MissingOwnedLot)
        );
    }

    #[test]
    fn reduce_order_must_oppose_the_owned_lot() {
        let engine = RiskEngine::new();
        let mut reduce = intent(IntentPurpose::Reduce, Decimal::new(500, 2));
        reduce.side = OrderSide::Buy;
        let snapshot = RiskSnapshot {
            has_strategy_owned_lot: true,
            strategy_owned_lot_side: Some(OrderSide::Buy),
            strategy_owned_lot_notional_usd: Decimal::new(500, 2),
            safety: daytradingbot_contracts::SafetyState::ready_for_entries(),
            ..RiskSnapshot::default()
        };
        assert_eq!(
            engine.evaluate(&reduce, &snapshot, &RiskPolicy::default()),
            reject(RiskRejection::ReduceWrongSide)
        );
    }
}
