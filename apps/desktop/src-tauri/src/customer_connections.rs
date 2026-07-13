use crate::vault::{CredentialVault, VaultKey};
use daytradingbot_venues::coinbase::CoinbaseAdvancedTradeClient;
use daytradingbot_venues::kalshi::{DirectKalshiClient, DirectKalshiError, KalshiEnvironment};
use daytradingbot_venues::polymarket_us::PolymarketUsRetailClient;
use daytradingbot_venues::simmer::SimmerKalshiClient;
use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize)]
pub struct CoinbaseConnectionRequest {
    key_name: String,
    private_key_pem: String,
}

impl Drop for CoinbaseConnectionRequest {
    fn drop(&mut self) {
        self.key_name.zeroize();
        self.private_key_pem.zeroize();
    }
}

#[derive(Deserialize)]
pub struct SimmerConnectionRequest {
    api_key: String,
}

impl Drop for SimmerConnectionRequest {
    fn drop(&mut self) {
        self.api_key.zeroize();
    }
}

#[derive(Deserialize)]
pub struct PolymarketUsConnectionRequest {
    key_id: String,
    secret_key: String,
}

impl Drop for PolymarketUsConnectionRequest {
    fn drop(&mut self) {
        self.key_id.zeroize();
        self.secret_key.zeroize();
    }
}

#[derive(Deserialize)]
pub struct KalshiConnectionRequest {
    api_key_id: String,
    private_key_pem: String,
}

impl Drop for KalshiConnectionRequest {
    fn drop(&mut self) {
        self.api_key_id.zeroize();
        self.private_key_pem.zeroize();
    }
}

#[tauri::command]
pub async fn connect_coinbase_account(
    mut request: CoinbaseConnectionRequest,
    vault: tauri::State<'_, CredentialVault>,
) -> Result<bool, &'static str> {
    let key_name = Zeroizing::new(request.key_name.trim().to_string());
    let private_key = Zeroizing::new(request.private_key_pem.trim().to_string());
    let client = CoinbaseAdvancedTradeClient::new(key_name.clone(), private_key.clone())
        .map_err(|_| "COINBASE_CREDENTIAL_INVALID")?;
    let snapshot = client
        .read_owner_snapshot()
        .await
        .map_err(|_| "COINBASE_CONNECTION_FAILED")?;
    if !snapshot.authenticated || !snapshot.can_view || !snapshot.can_trade {
        return Err("COINBASE_VIEW_AND_TRADE_REQUIRED");
    }
    if snapshot.can_transfer || snapshot.can_receive || !snapshot.least_privilege_live_scope {
        return Err("COINBASE_KEY_PERMISSIONS_UNSAFE");
    }
    vault
        .store(VaultKey::CoinbaseKeyName, key_name.as_bytes())
        .map_err(|_| "ACCOUNT_VAULT_UNAVAILABLE")?;
    vault
        .store(VaultKey::CoinbasePrivateKeyPem, private_key.as_bytes())
        .map_err(|_| "ACCOUNT_VAULT_UNAVAILABLE")?;
    request.key_name.zeroize();
    request.private_key_pem.zeroize();
    Ok(true)
}

#[tauri::command]
pub async fn connect_simmer_account(
    mut request: SimmerConnectionRequest,
    vault: tauri::State<'_, CredentialVault>,
) -> Result<bool, &'static str> {
    let api_key = Zeroizing::new(request.api_key.trim().to_string());
    if api_key.len() < 16 || !api_key.starts_with("sk_") || api_key.chars().any(char::is_whitespace)
    {
        return Err("SIMMER_API_KEY_INVALID");
    }
    let client = SimmerKalshiClient::new(api_key.clone()).map_err(|_| "SIMMER_API_KEY_INVALID")?;
    let snapshot = client
        .read_owner_snapshot()
        .await
        .map_err(|_| "SIMMER_CONNECTION_FAILED")?;
    if !snapshot.authenticated {
        return Err("SIMMER_CONNECTION_FAILED");
    }
    vault
        .store(VaultKey::SimmerApiKey, api_key.as_bytes())
        .map_err(|_| "ACCOUNT_VAULT_UNAVAILABLE")?;
    request.api_key.zeroize();
    Ok(true)
}

#[tauri::command]
pub async fn connect_polymarket_us_account(
    mut request: PolymarketUsConnectionRequest,
    vault: tauri::State<'_, CredentialVault>,
) -> Result<bool, &'static str> {
    let key_id = Zeroizing::new(request.key_id.trim().to_ascii_lowercase());
    let secret_key = Zeroizing::new(request.secret_key.trim().to_string());
    let client = PolymarketUsRetailClient::new(key_id.clone(), secret_key.clone())
        .map_err(|_| "POLYMARKET_US_CREDENTIAL_INVALID")?;
    let snapshot = client
        .read_owner_snapshot()
        .await
        .map_err(|_| "POLYMARKET_US_CONNECTION_FAILED")?;
    if !snapshot.authenticated {
        return Err("POLYMARKET_US_CONNECTION_FAILED");
    }
    vault
        .store(VaultKey::PolymarketUsKeyId, key_id.as_bytes())
        .map_err(|_| "ACCOUNT_VAULT_UNAVAILABLE")?;
    vault
        .store(VaultKey::PolymarketUsSecretKey, secret_key.as_bytes())
        .map_err(|_| "ACCOUNT_VAULT_UNAVAILABLE")?;
    request.key_id.zeroize();
    request.secret_key.zeroize();
    Ok(true)
}

#[tauri::command]
pub async fn connect_kalshi_account(
    mut request: KalshiConnectionRequest,
    vault: tauri::State<'_, CredentialVault>,
) -> Result<bool, &'static str> {
    let key_id = Zeroizing::new(request.api_key_id.trim().to_ascii_lowercase());
    let private_key = Zeroizing::new(request.private_key_pem.trim().to_string());
    let client = DirectKalshiClient::new(
        KalshiEnvironment::Production,
        key_id.clone(),
        private_key.clone(),
    )
    .map_err(|_| "KALSHI_CREDENTIAL_INVALID")?;
    client.read_balance().await.map_err(|error| match error {
        DirectKalshiError::AuthenticationFailed => "KALSHI_AUTHENTICATION_FAILED",
        DirectKalshiError::PermissionDenied => "KALSHI_PERMISSION_DENIED",
        DirectKalshiError::RateLimited => "KALSHI_RATE_LIMITED",
        _ => "KALSHI_CONNECTION_FAILED",
    })?;
    vault
        .store(VaultKey::KalshiApiKeyId, key_id.as_bytes())
        .map_err(|_| "ACCOUNT_VAULT_UNAVAILABLE")?;
    vault
        .store(VaultKey::KalshiPrivateKeyPem, private_key.as_bytes())
        .map_err(|_| "ACCOUNT_VAULT_UNAVAILABLE")?;
    request.api_key_id.zeroize();
    request.private_key_pem.zeroize();
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_requests_zeroize_on_drop() {
        let request = CoinbaseConnectionRequest {
            key_name: "organizations/example/apiKeys/example".into(),
            private_key_pem: "sensitive-private-key".into(),
        };
        drop(request);
    }
}
