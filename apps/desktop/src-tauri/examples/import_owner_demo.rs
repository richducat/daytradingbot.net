use std::error::Error;
use std::fs;
use std::path::PathBuf;

use daytradingbot_desktop_lib::vault::{CredentialVault, VaultKey};
use daytradingbot_venues::simmer::SimmerKalshiClient;
use serde::Deserialize;
use zeroize::Zeroizing;

#[derive(Deserialize)]
struct SimmerCredentials {
    api_key: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME is unavailable")?);
    let simmer_path = home.join(".config/simmer/credentials.json");
    let kalshi_path = home.join(".config/clawbot/kalshi.env");

    let simmer_raw = Zeroizing::new(fs::read_to_string(simmer_path)?);
    let mut simmer: SimmerCredentials = serde_json::from_str(&simmer_raw)?;
    let kalshi_raw = Zeroizing::new(fs::read_to_string(kalshi_path)?);
    let solana_key = kalshi_raw
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "SOLANA_PRIVATE_KEY").then(|| value.trim().trim_matches(['\'', '"']))
        })
        .filter(|value| !value.is_empty())
        .ok_or("SOLANA_PRIVATE_KEY is unavailable")?;

    let skip_vault_import = std::env::var_os("DAYTRADINGBOT_SKIP_VAULT_IMPORT").is_some();
    if !skip_vault_import {
        let vault = CredentialVault::new();
        vault.store(VaultKey::SimmerApiKey, simmer.api_key.as_bytes())?;
        vault.store(VaultKey::KalshiSolanaPrivateKey, solana_key.as_bytes())?;
    }

    let api_key = Zeroizing::new(std::mem::take(&mut simmer.api_key));
    let client = SimmerKalshiClient::new(api_key)?;
    let snapshot = client.read_owner_snapshot().await?;

    if skip_vault_import {
        println!("Existing owner demo credentials were not rewritten.");
    } else {
        println!("Owner demo credentials imported into the operating-system vault.");
    }
    println!("No credential values were printed or written to the repository.");
    println!(
        "Read-only account authentication: {}",
        snapshot.authenticated
    );
    println!(
        "Active Kalshi positions synchronized: {}",
        snapshot.active_position_count
    );
    println!("Live entries available: false");
    Ok(())
}
