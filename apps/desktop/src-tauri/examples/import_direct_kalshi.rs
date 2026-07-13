use std::path::PathBuf;

use daytradingbot_desktop_lib::vault::{CredentialVault, VaultKey};
use daytradingbot_venues::kalshi::{DirectKalshiClient, KalshiEnvironment};
use zeroize::Zeroizing;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api_key_id = Zeroizing::new(std::env::var("KALSHI_API_KEY_ID")?);
    let key_path = PathBuf::from(std::env::var("KALSHI_PRIVATE_KEY_PATH")?);
    let private_key_pem = Zeroizing::new(std::fs::read_to_string(key_path)?);
    let environment = match std::env::var("KALSHI_ENVIRONMENT")
        .unwrap_or_else(|_| "production".to_owned())
        .as_str()
    {
        "production" => KalshiEnvironment::Production,
        "demo" => KalshiEnvironment::Demo,
        _ => return Err("KALSHI_ENVIRONMENT must be production or demo".into()),
    };

    let client = DirectKalshiClient::new(
        environment,
        Zeroizing::new(api_key_id.to_string()),
        Zeroizing::new(private_key_pem.to_string()),
    )?;
    let _redacted_balance_check = client.read_balance().await?;

    let vault = CredentialVault::new();
    vault.store(VaultKey::KalshiApiKeyId, api_key_id.as_bytes())?;
    vault.store(VaultKey::KalshiPrivateKeyPem, private_key_pem.as_bytes())?;
    println!("Direct Kalshi credentials authenticated and stored in the operating-system vault.");
    Ok(())
}
