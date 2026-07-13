use daytradingbot_venues::robinhood::RobinhoodAgenticClient;
use zeroize::Zeroizing;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let access_token = Zeroizing::new(std::env::var("ROBINHOOD_ACCESS_TOKEN")?);
    let client = RobinhoodAgenticClient::new(access_token)?;
    let snapshot = client.read_owner_snapshot().await?;
    println!(
        "Robinhood Agentic owner proof: authenticated={}, eligible_account={}, account_count={}, buying_power_available={}",
        snapshot.authenticated,
        snapshot.agentic_account_available,
        snapshot.agentic_account_count,
        snapshot.has_buying_power
    );
    Ok(())
}
