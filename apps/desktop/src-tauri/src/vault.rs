use keyring::Entry;
use thiserror::Error;
use zeroize::Zeroizing;

const VAULT_SERVICE: &str = "net.daytradingbot.desktop";

/// Closed set of operating-system vault entries used by the native backend.
/// No command accepts arbitrary service or key names from the webview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VaultKey {
    DeviceSigningKey,
    LicenseActivationToken,
    LicenseLastTrustedTime,
    RobinhoodOAuthToken,
    RobinhoodRefreshToken,
    RobinhoodOAuthClientId,
    CoinbaseKeyName,
    CoinbasePrivateKeyPem,
    SimmerApiKey,
    KalshiSolanaPrivateKey,
    KalshiApiKeyId,
    KalshiPrivateKeyPem,
    PolymarketUsKeyId,
    PolymarketUsSecretKey,
}

impl VaultKey {
    #[must_use]
    fn account(self) -> &'static str {
        match self {
            Self::DeviceSigningKey => "device:signing-key",
            Self::LicenseActivationToken => "license:activation-token",
            Self::LicenseLastTrustedTime => "license:last-trusted-time",
            Self::RobinhoodOAuthToken => "robinhood:oauth-token",
            Self::RobinhoodRefreshToken => "robinhood:refresh-token",
            Self::RobinhoodOAuthClientId => "robinhood:oauth-client-id",
            Self::CoinbaseKeyName => "coinbase:key-name",
            Self::CoinbasePrivateKeyPem => "coinbase:ecdsa-private-key-pem",
            Self::SimmerApiKey => "owner-demo:simmer-api-key",
            Self::KalshiSolanaPrivateKey => "owner-demo:kalshi-solana-private-key",
            Self::KalshiApiKeyId => "kalshi:api-key-id",
            Self::KalshiPrivateKeyPem => "kalshi:rsa-private-key-pem",
            Self::PolymarketUsKeyId => "polymarket-us:key-id",
            Self::PolymarketUsSecretKey => "polymarket-us:ed25519-secret-key",
        }
    }
}

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("operating-system credential vault operation failed")]
    Keyring(#[source] keyring::Error),
}

impl From<keyring::Error> for VaultError {
    fn from(error: keyring::Error) -> Self {
        Self::Keyring(error)
    }
}

#[derive(Default)]
pub struct CredentialVault;

impl CredentialVault {
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    pub fn store(&self, key: VaultKey, secret: &[u8]) -> Result<(), VaultError> {
        Entry::new(VAULT_SERVICE, key.account())?.set_secret(secret)?;
        Ok(())
    }

    pub fn load(&self, key: VaultKey) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        let secret = Entry::new(VAULT_SERVICE, key.account())?.get_secret()?;
        Ok(Zeroizing::new(secret))
    }

    pub fn load_optional(&self, key: VaultKey) -> Result<Option<Zeroizing<Vec<u8>>>, VaultError> {
        let entry = Entry::new(VAULT_SERVICE, key.account())?;
        match entry.get_secret() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn delete(&self, key: VaultKey) -> Result<(), VaultError> {
        Entry::new(VAULT_SERVICE, key.account())?.delete_credential()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn every_allowed_secret_has_a_unique_fixed_vault_account() {
        let keys = [
            VaultKey::DeviceSigningKey,
            VaultKey::LicenseActivationToken,
            VaultKey::LicenseLastTrustedTime,
            VaultKey::RobinhoodOAuthToken,
            VaultKey::RobinhoodRefreshToken,
            VaultKey::RobinhoodOAuthClientId,
            VaultKey::CoinbaseKeyName,
            VaultKey::CoinbasePrivateKeyPem,
            VaultKey::SimmerApiKey,
            VaultKey::KalshiSolanaPrivateKey,
            VaultKey::KalshiApiKeyId,
            VaultKey::KalshiPrivateKeyPem,
            VaultKey::PolymarketUsKeyId,
            VaultKey::PolymarketUsSecretKey,
        ];
        let accounts: HashSet<_> = keys.into_iter().map(VaultKey::account).collect();
        assert_eq!(accounts.len(), keys.len());
        assert!(accounts.iter().all(|account| !account.contains('@')));
    }
}
