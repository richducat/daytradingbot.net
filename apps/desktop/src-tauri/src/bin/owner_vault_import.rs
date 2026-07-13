use std::io::{self, Read};

use keyring::Entry;
use uuid::Uuid;
use zeroize::Zeroize;

const VAULT_SERVICE: &str = "net.daytradingbot.desktop";
const MAX_SECRET_BYTES: u64 = 64 * 1024;

fn fail(reason: &'static str) -> ! {
    eprintln!("vault_import=failed reason={reason}");
    std::process::exit(1);
}

fn validate(account: &str, secret: &[u8]) -> bool {
    let Ok(value) = std::str::from_utf8(secret) else {
        return false;
    };
    match account {
        "polymarket-us:key-id" => Uuid::parse_str(value)
            .is_ok_and(|parsed| parsed.to_string() == value.to_ascii_lowercase()),
        "polymarket-us:ed25519-secret-key" => {
            value.len() == 88
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte))
        }
        "coinbase:key-name" => {
            (10..=512).contains(&value.len()) && !value.chars().any(char::is_whitespace)
        }
        "coinbase:ecdsa-private-key-pem" => {
            (100..=16 * 1024).contains(&value.len())
                && (value.contains("-----BEGIN EC PRIVATE KEY-----")
                    || value.contains("-----BEGIN PRIVATE KEY-----"))
                && (value.contains("-----END EC PRIVATE KEY-----")
                    || value.contains("-----END PRIVATE KEY-----"))
        }
        _ => false,
    }
}

fn main() {
    let Some(account) = std::env::args().nth(1) else {
        fail("account_required");
    };
    if !matches!(
        account.as_str(),
        "polymarket-us:key-id"
            | "polymarket-us:ed25519-secret-key"
            | "coinbase:key-name"
            | "coinbase:ecdsa-private-key-pem"
    ) {
        fail("account_not_allowed");
    }

    let mut secret = Vec::new();
    if io::stdin()
        .take(MAX_SECRET_BYTES + 1)
        .read_to_end(&mut secret)
        .is_err()
    {
        fail("input_unavailable");
    }
    if secret.is_empty() || secret.len() as u64 > MAX_SECRET_BYTES {
        secret.zeroize();
        fail("input_size_invalid");
    }
    if !validate(&account, &secret) {
        secret.zeroize();
        fail("credential_invalid");
    }

    let stored = Entry::new(VAULT_SERVICE, &account)
        .and_then(|entry| entry.set_secret(&secret))
        .is_ok();
    secret.zeroize();
    if !stored {
        fail("keychain_unavailable");
    }
    println!("vault_import=stored account={account}");
}
