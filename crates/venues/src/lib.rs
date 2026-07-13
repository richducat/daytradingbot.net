use async_trait::async_trait;
use chrono::{DateTime, Utc};
use daytradingbot_contracts::{OrderSide, OrderState, Venue};
use daytradingbot_ledger::ReservedIntent;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub mod kalshi;
pub mod simmer;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Ready,
    CloseOnly,
    ReauthenticationRequired,
    Ineligible,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct VenueCapabilities {
    pub has_native_client_order_id: bool,
    pub supports_order_preview: bool,
    pub supports_partial_fills: bool,
    pub supports_close_only: bool,
    pub supports_cancel: bool,
}

impl VenueCapabilities {
    #[must_use]
    pub fn for_venue(venue: Venue) -> Self {
        match venue {
            Venue::Robinhood => Self {
                has_native_client_order_id: true,
                supports_order_preview: true,
                supports_partial_fills: true,
                supports_close_only: true,
                supports_cancel: true,
            },
            Venue::Coinbase | Venue::Kalshi => Self {
                has_native_client_order_id: true,
                supports_order_preview: false,
                supports_partial_fills: true,
                supports_close_only: true,
                supports_cancel: true,
            },
            Venue::Polymarket => Self {
                has_native_client_order_id: false,
                supports_order_preview: false,
                supports_partial_fills: true,
                supports_close_only: true,
                supports_cancel: true,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialReference {
    /// Namespace and key reference an operating-system vault entry. Raw secrets
    /// are never transported through this contract.
    pub namespace: String,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionRequest {
    pub venue: Venue,
    pub account_scope: Uuid,
    pub credential_references: Vec<CredentialReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionHealth {
    pub venue: Venue,
    pub state: ConnectionState,
    pub permissions_verified: bool,
    pub eligibility_verified_at: Option<DateTime<Utc>>,
    pub market_data_at: Option<DateTime<Utc>>,
    pub detail_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BalanceSnapshot {
    #[serde(with = "rust_decimal::serde::str")]
    pub available_usd: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub total_usd: Decimal,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VenuePosition {
    pub lot_id: Uuid,
    pub strategy_id: String,
    pub instrument: String,
    pub side: OrderSide,
    #[serde(with = "rust_decimal::serde::str")]
    pub quantity: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub cost_usd: Decimal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VenueOrder {
    pub intent_id: Uuid,
    pub venue_order_id: String,
    pub state: OrderState,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderPreview {
    #[serde(with = "rust_decimal::serde::str")]
    pub estimated_notional_usd: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub estimated_fee_usd: Decimal,
    pub warnings: Vec<String>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubmissionReceipt {
    pub intent_id: Uuid,
    pub venue_order_id: String,
    pub state: OrderState,
    pub submitted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconciliationResult {
    pub intent_id: Uuid,
    pub state: OrderState,
    pub venue_order_id: Option<String>,
    pub reconciled_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryClass {
    RetryRead,
    ReconcileBeforeRetry,
    NeverRetry,
}

#[derive(Debug, Error)]
#[error("venue operation failed: {code}")]
pub struct VenueError {
    pub code: &'static str,
    pub retry: RetryClass,
}

#[async_trait]
pub trait VenueAdapter: Send + Sync {
    fn venue(&self) -> Venue;
    fn capabilities(&self) -> VenueCapabilities;

    async fn connect(&self, request: &ConnectionRequest) -> Result<ConnectionHealth, VenueError>;
    async fn health(&self) -> Result<ConnectionHealth, VenueError>;
    async fn balances(&self) -> Result<BalanceSnapshot, VenueError>;
    async fn positions(&self) -> Result<Vec<VenuePosition>, VenueError>;
    async fn open_orders(&self) -> Result<Vec<VenueOrder>, VenueError>;
    async fn preview(&self, intent: &ReservedIntent) -> Result<OrderPreview, VenueError>;
    async fn submit(&self, intent: ReservedIntent) -> Result<SubmissionReceipt, VenueError>;
    async fn cancel(&self, venue_order_id: &str) -> Result<ReconciliationResult, VenueError>;
    async fn reconcile(&self, intent_id: Uuid) -> Result<ReconciliationResult, VenueError>;
    async fn disconnect(&self) -> Result<(), VenueError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_launch_venue_can_cancel_and_reconcile() {
        for venue in [
            Venue::Robinhood,
            Venue::Coinbase,
            Venue::Kalshi,
            Venue::Polymarket,
        ] {
            let capabilities = VenueCapabilities::for_venue(venue);
            assert!(capabilities.supports_cancel);
            assert!(capabilities.supports_close_only);
        }
    }

    #[test]
    fn polymarket_requires_ledger_reconciliation_instead_of_native_client_id() {
        assert!(!VenueCapabilities::for_venue(Venue::Polymarket).has_native_client_order_id);
    }
}
