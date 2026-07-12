use daytradingbot_contracts::{IntentPurpose, OrderSide, Venue};
use uuid::Uuid;

const INTENT_NAMESPACE: Uuid = Uuid::from_u128(0x9c8f_79b7_3181_4ed1_98a4_eab3_9713_970a);

#[derive(Debug, Clone, Copy)]
pub struct IntentIdentity<'a> {
    pub source_event_id: &'a str,
    pub strategy_id: &'a str,
    pub venue: Venue,
    pub instrument: &'a str,
    pub side: OrderSide,
    pub purpose: IntentPurpose,
}

/// Creates the same venue-safe intent ID whenever one strategy sees the same
/// source event for the same instrument and action. This ID must be reused
/// across retries and crash recovery.
#[must_use]
pub fn deterministic_intent_id(identity: IntentIdentity<'_>) -> Uuid {
    let canonical = format!(
        "{}\u{1f}{}\u{1f}{:?}\u{1f}{}\u{1f}{:?}\u{1f}{:?}",
        identity.source_event_id,
        identity.strategy_id,
        identity.venue,
        identity.instrument,
        identity.side,
        identity.purpose,
    );
    Uuid::new_v5(&INTENT_NAMESPACE, canonical.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity<'a>(event: &'a str) -> IntentIdentity<'a> {
        IntentIdentity {
            source_event_id: event,
            strategy_id: "coinbase-spot-trend",
            venue: Venue::Coinbase,
            instrument: "BTC-USD",
            side: OrderSide::Buy,
            purpose: IntentPurpose::Open,
        }
    }

    #[test]
    fn same_source_event_produces_same_id() {
        assert_eq!(
            deterministic_intent_id(identity("candle-2026-07-12T21:00Z")),
            deterministic_intent_id(identity("candle-2026-07-12T21:00Z"))
        );
    }

    #[test]
    fn different_source_event_produces_different_id() {
        assert_ne!(
            deterministic_intent_id(identity("candle-1")),
            deterministic_intent_id(identity("candle-2"))
        );
    }
}
