use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use thiserror::Error;
use uuid::Uuid;

const LEASE_FORMAT_VERSION: u16 = 1;
const MAX_LEASE_SECONDS: i64 = 7 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS: i64 = 5 * 60;
const MAX_CLOCK_ROLLBACK_SECONDS: i64 = 5 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseClaims {
    pub version: u16,
    pub lease_id: Uuid,
    pub license_id: Uuid,
    pub device_public_key: [u8; 32],
    pub issued_at_unix: i64,
    pub expires_at_unix: i64,
    pub allows_entries: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedLease {
    pub claims: LeaseClaims,
    /// URL-safe, unpadded base64 Ed25519 signature over the versioned claims bytes.
    pub signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedLease {
    lease_id: Uuid,
    license_id: Uuid,
    expires_at_unix: i64,
    allows_entries: bool,
}

impl VerifiedLease {
    #[must_use]
    pub fn lease_id(&self) -> Uuid {
        self.lease_id
    }

    #[must_use]
    pub fn license_id(&self) -> Uuid {
        self.license_id
    }

    #[must_use]
    pub fn expires_at_unix(&self) -> i64 {
        self.expires_at_unix
    }

    #[must_use]
    pub fn allows_entries(&self) -> bool {
        self.allows_entries
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum LeaseError {
    #[error("unsupported license lease format")]
    UnsupportedVersion,
    #[error("license lease signature is invalid")]
    InvalidSignature,
    #[error("license lease is bound to another device")]
    DeviceMismatch,
    #[error("license lease timestamps are invalid")]
    InvalidLifetime,
    #[error("license lease is expired")]
    Expired,
    #[error("license gate lock was poisoned")]
    Poisoned,
    #[error("production license verification key is not embedded in this build")]
    MissingTrustAnchor,
}

#[derive(Default)]
pub struct LicenseGate {
    lease: RwLock<Option<VerifiedLease>>,
}

impl LicenseGate {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn verify_and_install(
        &self,
        lease: &SignedLease,
        expected_device_public_key: &[u8; 32],
        now_unix: i64,
    ) -> Result<(), LeaseError> {
        let lease = verify_lease(lease, expected_device_public_key, now_unix)?;
        let mut current = self.lease.write().map_err(|_| LeaseError::Poisoned)?;
        *current = Some(lease);
        Ok(())
    }

    /// Fails closed on no lease, expiry, revoked entry permission, or lock failure.
    /// This decision is intentionally scoped to opening trades only.
    #[must_use]
    pub fn entries_allowed(&self, now_unix: i64, trusted_time_floor_unix: i64) -> bool {
        if now_unix + MAX_CLOCK_ROLLBACK_SECONDS < trusted_time_floor_unix {
            return false;
        }
        let effective_now = now_unix.max(trusted_time_floor_unix);
        self.lease
            .read()
            .ok()
            .and_then(|lease| *lease)
            .is_some_and(|lease| lease.allows_entries && lease.expires_at_unix > effective_now)
    }
}

/// Verifies a server-signed lease against the embedded server public key and
/// this installation's device public key. Callers use `allows_entries` only for
/// opening trades; reduce-only/exit paths remain available after expiry.
pub fn verify_lease(
    lease: &SignedLease,
    expected_device_public_key: &[u8; 32],
    now_unix: i64,
) -> Result<VerifiedLease, LeaseError> {
    let encoded = option_env!("DAYTRADINGBOT_LEASE_PUBLIC_KEY_B64URL")
        .ok_or(LeaseError::MissingTrustAnchor)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|_| LeaseError::MissingTrustAnchor)?;
    let server_public_key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| LeaseError::MissingTrustAnchor)?;
    verify_lease_with_key(
        lease,
        &server_public_key,
        expected_device_public_key,
        now_unix,
    )
}

fn verify_lease_with_key(
    lease: &SignedLease,
    server_public_key: &[u8; 32],
    expected_device_public_key: &[u8; 32],
    now_unix: i64,
) -> Result<VerifiedLease, LeaseError> {
    let claims = &lease.claims;
    if claims.version != LEASE_FORMAT_VERSION {
        return Err(LeaseError::UnsupportedVersion);
    }
    if &claims.device_public_key != expected_device_public_key {
        return Err(LeaseError::DeviceMismatch);
    }
    if claims.expires_at_unix <= claims.issued_at_unix
        || claims.expires_at_unix - claims.issued_at_unix > MAX_LEASE_SECONDS
        || claims.issued_at_unix > now_unix + CLOCK_SKEW_SECONDS
    {
        return Err(LeaseError::InvalidLifetime);
    }
    if claims.expires_at_unix <= now_unix {
        return Err(LeaseError::Expired);
    }

    let signature_bytes = URL_SAFE_NO_PAD
        .decode(lease.signature.as_bytes())
        .map_err(|_| LeaseError::InvalidSignature)?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| LeaseError::InvalidSignature)?;
    let verifying_key =
        VerifyingKey::from_bytes(server_public_key).map_err(|_| LeaseError::InvalidSignature)?;
    verifying_key
        .verify(&claims_signing_bytes(claims), &signature)
        .map_err(|_| LeaseError::InvalidSignature)?;

    Ok(VerifiedLease {
        lease_id: claims.lease_id,
        license_id: claims.license_id,
        expires_at_unix: claims.expires_at_unix,
        allows_entries: claims.allows_entries,
    })
}

#[must_use]
pub fn claims_signing_bytes(claims: &LeaseClaims) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(2 + 16 + 16 + 32 + 8 + 8 + 1);
    bytes.extend_from_slice(&claims.version.to_be_bytes());
    bytes.extend_from_slice(claims.lease_id.as_bytes());
    bytes.extend_from_slice(claims.license_id.as_bytes());
    bytes.extend_from_slice(&claims.device_public_key);
    bytes.extend_from_slice(&claims.issued_at_unix.to_be_bytes());
    bytes.extend_from_slice(&claims.expires_at_unix.to_be_bytes());
    bytes.push(u8::from(claims.allows_entries));
    bytes
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    fn signed_lease(allows_entries: bool) -> (SignedLease, [u8; 32], [u8; 32]) {
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let device_key = [9; 32];
        let claims = LeaseClaims {
            version: LEASE_FORMAT_VERSION,
            lease_id: Uuid::new_v4(),
            license_id: Uuid::new_v4(),
            device_public_key: device_key,
            issued_at_unix: 1_700_000_000,
            expires_at_unix: 1_700_000_000 + MAX_LEASE_SECONDS,
            allows_entries,
        };
        let signature = signing_key.sign(&claims_signing_bytes(&claims));
        (
            SignedLease {
                claims,
                signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            },
            signing_key.verifying_key().to_bytes(),
            device_key,
        )
    }

    #[test]
    fn valid_device_bound_lease_allows_entry() {
        let (lease, server_key, device_key) = signed_lease(true);
        let verified =
            verify_lease_with_key(&lease, &server_key, &device_key, 1_700_000_001).unwrap();
        assert!(verified.allows_entries);
    }

    #[test]
    fn tampered_entry_permission_breaks_signature() {
        let (mut lease, server_key, device_key) = signed_lease(true);
        lease.claims.allows_entries = false;
        assert_eq!(
            verify_lease_with_key(&lease, &server_key, &device_key, 1_700_000_001),
            Err(LeaseError::InvalidSignature)
        );
    }

    #[test]
    fn lease_for_another_device_is_rejected() {
        let (lease, server_key, _) = signed_lease(true);
        assert_eq!(
            verify_lease_with_key(&lease, &server_key, &[8; 32], 1_700_000_001),
            Err(LeaseError::DeviceMismatch)
        );
    }

    #[test]
    fn expired_lease_is_rejected() {
        let (lease, server_key, device_key) = signed_lease(true);
        assert_eq!(
            verify_lease_with_key(
                &lease,
                &server_key,
                &device_key,
                lease.claims.expires_at_unix,
            ),
            Err(LeaseError::Expired)
        );
    }

    #[test]
    fn server_cannot_issue_a_lease_longer_than_seven_days() {
        let (mut lease, server_key, device_key) = signed_lease(true);
        lease.claims.expires_at_unix += 1;
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        lease.signature = URL_SAFE_NO_PAD.encode(
            signing_key
                .sign(&claims_signing_bytes(&lease.claims))
                .to_bytes(),
        );
        assert_eq!(
            verify_lease_with_key(&lease, &server_key, &device_key, 1_700_000_001),
            Err(LeaseError::InvalidLifetime)
        );
    }

    #[test]
    fn gate_is_close_only_without_a_current_entry_lease() {
        let gate = LicenseGate::new();
        assert!(!gate.entries_allowed(1_700_000_001, 1_700_000_001));

        let (lease, server_key, device_key) = signed_lease(true);
        let verified =
            verify_lease_with_key(&lease, &server_key, &device_key, 1_700_000_001).unwrap();
        *gate.lease.write().unwrap() = Some(verified);
        assert!(gate.entries_allowed(1_700_000_001, 1_700_000_001));
        assert!(!gate.entries_allowed(lease.claims.expires_at_unix, lease.claims.expires_at_unix,));
        assert!(!gate.entries_allowed(1_700_000_001, lease.claims.expires_at_unix));
    }
}
