//! Founder-only, read-only verification of the native Bluechip connector.
//! It uses the already-authorized local Hermes token, fetches real market
//! data, and invokes Robinhood's review operation. It has no placement call.

use daytradingbot_venues::robinhood::RobinhoodAgenticClient;
use rust_decimal::Decimal;
use serde::Deserialize;
use std::path::PathBuf;
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize)]
struct StoredToken {
    access_token: String,
}

impl Drop for StoredToken {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unavailable")?);
    let raw = Zeroizing::new(std::fs::read_to_string(
        home.join(".hermes/mcp-tokens/robinhood.json"),
    )?);
    let token: StoredToken = serde_json::from_str(&raw)?;
    let client = RobinhoodAgenticClient::new(Zeroizing::new(token.access_token.clone()))?;
    let mut session = client.trading_session().await?;
    let buying_power = session.buying_power().await?;
    let positions = session.equity_positions().await?;
    let watchlist = ["AAPL", "NVDA", "TSLA", "SPY", "QQQ", "AMD", "MSFT", "GOOGL"];
    let quotes = session.equity_quotes(&watchlist).await?;
    let candidates: Vec<_> = quotes
        .iter()
        .filter(|quote| quote.change_percent() <= Decimal::new(-150, 2))
        .collect();
    let mut reviewed = 0_usize;
    for quote in candidates.iter().take(2) {
        session
            .review_market_buy(&quote.symbol, Decimal::new(100, 2))
            .await?;
        reviewed = reviewed.saturating_add(1);
    }
    println!(
        "Native Practice proof: account ready={}, quotes={}, positions={}, matches={}, reviewed={}, orders placed=0",
        buying_power > Decimal::ZERO,
        quotes.len(),
        positions.len(),
        candidates.len(),
        reviewed,
    );
    Ok(())
}
