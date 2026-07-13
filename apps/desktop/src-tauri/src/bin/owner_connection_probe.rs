use daytradingbot_venues::coinbase::{CoinbaseAdvancedTradeClient, CoinbaseError};
use daytradingbot_venues::polymarket_us::{PolymarketUsError, PolymarketUsRetailClient};
use keyring::Entry;
use zeroize::Zeroizing;

const VAULT_SERVICE: &str = "net.daytradingbot.desktop";

fn load_secret(account: &'static str) -> Option<Zeroizing<String>> {
    let secret = Entry::new(VAULT_SERVICE, account).ok()?.get_secret().ok()?;
    String::from_utf8(secret).ok().map(Zeroizing::new)
}

fn polymarket_error_code(error: PolymarketUsError) -> &'static str {
    match error {
        PolymarketUsError::InvalidCredential => "credential_invalid",
        PolymarketUsError::AuthenticationFailed => "authentication_failed",
        PolymarketUsError::PermissionDenied => "account_not_approved",
        PolymarketUsError::RateLimited => "rate_limited",
        PolymarketUsError::UnexpectedStatus => "unexpected_status",
        PolymarketUsError::ResponseTooLarge => "response_too_large",
        PolymarketUsError::InvalidResponse => "invalid_response",
        PolymarketUsError::Unavailable => "provider_unavailable",
    }
}

fn coinbase_error_code(error: CoinbaseError) -> &'static str {
    match error {
        CoinbaseError::InvalidCredential => "credential_invalid",
        CoinbaseError::AuthenticationFailed => "authentication_failed",
        CoinbaseError::PermissionDenied => "permission_denied",
        CoinbaseError::RateLimited => "rate_limited",
        CoinbaseError::UnexpectedStatus => "unexpected_status",
        CoinbaseError::ResponseTooLarge => "response_too_large",
        CoinbaseError::InvalidResponse => "invalid_response",
        CoinbaseError::Unavailable => "provider_unavailable",
    }
}

async fn probe_polymarket_us() -> bool {
    let (Some(key_id), Some(secret_key)) = (
        load_secret("polymarket-us:key-id"),
        load_secret("polymarket-us:ed25519-secret-key"),
    ) else {
        println!("polymarket_us=missing order_access=locked");
        return false;
    };

    let client = match PolymarketUsRetailClient::new(key_id, secret_key) {
        Ok(client) => client,
        Err(error) => {
            println!(
                "polymarket_us=failed reason={} order_access=locked",
                polymarket_error_code(error)
            );
            return false;
        }
    };

    match client.read_owner_snapshot().await {
        Ok(snapshot) => {
            let buying_power = if snapshot.has_buying_power {
                "available"
            } else {
                "none"
            };
            println!(
                "polymarket_us=verified authenticated={} buying_power={} order_access=locked",
                snapshot.authenticated, buying_power
            );
            snapshot.authenticated
        }
        Err(error) => {
            println!(
                "polymarket_us=failed reason={} order_access=locked",
                polymarket_error_code(error)
            );
            false
        }
    }
}

async fn probe_coinbase() -> bool {
    let (Some(key_name), Some(private_key_pem)) = (
        load_secret("coinbase:key-name"),
        load_secret("coinbase:ecdsa-private-key-pem"),
    ) else {
        println!("coinbase=missing order_access=locked");
        return false;
    };

    let client = match CoinbaseAdvancedTradeClient::new(key_name, private_key_pem) {
        Ok(client) => client,
        Err(error) => {
            println!(
                "coinbase=failed reason={} order_access=locked",
                coinbase_error_code(error)
            );
            return false;
        }
    };

    match client.read_owner_snapshot().await {
        Ok(snapshot) => {
            let scope = if snapshot.least_privilege_live_scope {
                "view_trade_only"
            } else {
                "scope_mismatch"
            };
            println!(
                "coinbase=verified authenticated={} scope={} order_access=locked",
                snapshot.authenticated, scope
            );
            snapshot.authenticated && snapshot.least_privilege_live_scope
        }
        Err(error) => {
            println!(
                "coinbase=failed reason={} order_access=locked",
                coinbase_error_code(error)
            );
            false
        }
    }
}

#[tokio::main]
async fn main() {
    let requested = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "--all".to_owned());
    let ok = match requested.as_str() {
        "--polymarket-us" => probe_polymarket_us().await,
        "--coinbase" => probe_coinbase().await,
        "--all" => probe_polymarket_us().await & probe_coinbase().await,
        _ => {
            eprintln!("usage: owner_connection_probe [--all|--coinbase|--polymarket-us]");
            false
        }
    };

    if !ok {
        std::process::exit(1);
    }
}
