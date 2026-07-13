use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use daytradingbot_desktop_lib::vault::{CredentialVault, VaultKey};
use daytradingbot_venues::robinhood::RobinhoodAgenticClient;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize)]
struct SourceToken {
    access_token: String,
    expires_at: f64,
}

impl Drop for SourceToken {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

#[derive(Serialize)]
struct VaultToken<'a> {
    access_token: &'a str,
    expires_at: f64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token_path = PathBuf::from(std::env::var("ROBINHOOD_OAUTH_TOKEN_PATH")?);
    let raw = Zeroizing::new(std::fs::read_to_string(token_path)?);
    let token: SourceToken = serde_json::from_str(&raw)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
    if token.access_token.len() < 24
        || token.access_token.chars().any(char::is_whitespace)
        || !token.expires_at.is_finite()
        || token.expires_at <= now + 120.0
    {
        return Err("Robinhood owner OAuth token is invalid or expired".into());
    }

    let client = RobinhoodAgenticClient::new(Zeroizing::new(token.access_token.clone()))?;
    let snapshot = client.read_owner_snapshot().await?;
    if !snapshot.authenticated || !snapshot.agentic_account_available {
        return Err("No eligible Robinhood Agentic account was found".into());
    }

    let reduced = Zeroizing::new(serde_json::to_vec(&VaultToken {
        access_token: &token.access_token,
        expires_at: token.expires_at,
    })?);
    CredentialVault::new().store(VaultKey::RobinhoodOAuthToken, &reduced)?;
    println!("Robinhood Agentic owner connection authenticated and stored in the OS vault.");
    Ok(())
}
