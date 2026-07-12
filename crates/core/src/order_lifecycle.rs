use daytradingbot_contracts::OrderState;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
#[error("invalid order transition from {from:?} to {to:?}")]
pub struct InvalidTransition {
    pub from: OrderState,
    pub to: OrderState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrderLifecycle {
    state: OrderState,
}

impl Default for OrderLifecycle {
    fn default() -> Self {
        Self {
            state: OrderState::Created,
        }
    }
}

impl OrderLifecycle {
    #[must_use]
    pub fn state(&self) -> OrderState {
        self.state
    }

    pub fn transition(&mut self, to: OrderState) -> Result<(), InvalidTransition> {
        if transition_allowed(self.state, to) {
            self.state = to;
            Ok(())
        } else {
            Err(InvalidTransition {
                from: self.state,
                to,
            })
        }
    }
}

fn transition_allowed(from: OrderState, to: OrderState) -> bool {
    use OrderState::{
        Acknowledged, Canceled, Created, Filled, PartiallyFilled, Reconciled, Rejected, Reserved,
        RiskRejected, Submitting, Unknown,
    };

    matches!(
        (from, to),
        (Created, RiskRejected | Reserved)
            | (Reserved, Submitting | Canceled)
            | (Submitting, Acknowledged | Rejected | Unknown)
            | (
                Acknowledged,
                PartiallyFilled | Filled | Canceled | Rejected | Unknown
            )
            | (
                PartiallyFilled,
                PartiallyFilled | Filled | Canceled | Unknown
            )
            | (Unknown, Reconciled)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_order_can_fill() {
        let mut lifecycle = OrderLifecycle::default();
        for state in [
            OrderState::Reserved,
            OrderState::Submitting,
            OrderState::Acknowledged,
            OrderState::PartiallyFilled,
            OrderState::Filled,
        ] {
            lifecycle.transition(state).expect("transition should work");
        }
        assert_eq!(lifecycle.state(), OrderState::Filled);
    }

    #[test]
    fn unknown_must_reconcile_before_completion() {
        let mut lifecycle = OrderLifecycle::default();
        lifecycle.transition(OrderState::Reserved).unwrap();
        lifecycle.transition(OrderState::Submitting).unwrap();
        lifecycle.transition(OrderState::Unknown).unwrap();

        assert_eq!(
            lifecycle.transition(OrderState::Filled),
            Err(InvalidTransition {
                from: OrderState::Unknown,
                to: OrderState::Filled,
            })
        );
        lifecycle.transition(OrderState::Reconciled).unwrap();
    }

    #[test]
    fn terminal_state_cannot_be_resubmitted() {
        let mut lifecycle = OrderLifecycle::default();
        lifecycle.transition(OrderState::RiskRejected).unwrap();
        assert!(lifecycle.transition(OrderState::Submitting).is_err());
    }
}
