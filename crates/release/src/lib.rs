use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MANIFEST_FORMAT_VERSION: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleasePlatform {
    MacosUniversal,
    WindowsX64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseClaims {
    pub format_version: u16,
    pub app_version: String,
    pub platform: ReleasePlatform,
    pub asset_name: String,
    pub asset_sha256: [u8; 32],
    pub asset_size_bytes: u64,
    pub published_at_unix: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedReleaseManifest {
    pub claims: ReleaseClaims,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRelease {
    claims: ReleaseClaims,
}

impl VerifiedRelease {
    #[must_use]
    pub fn claims(&self) -> &ReleaseClaims {
        &self.claims
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ReleaseError {
    #[error("production release verification key is not embedded in this build")]
    MissingTrustAnchor,
    #[error("release manifest is invalid")]
    InvalidManifest,
    #[error("release manifest signature is invalid")]
    InvalidSignature,
    #[error("release asset size or SHA-256 does not match the signed manifest")]
    AssetMismatch,
}

pub fn verify_manifest(manifest: &SignedReleaseManifest) -> Result<VerifiedRelease, ReleaseError> {
    let encoded = option_env!("DAYTRADINGBOT_RELEASE_PUBLIC_KEY_B64URL")
        .ok_or(ReleaseError::MissingTrustAnchor)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|_| ReleaseError::MissingTrustAnchor)?;
    let public_key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ReleaseError::MissingTrustAnchor)?;
    verify_manifest_with_key(manifest, &public_key)
}

pub fn verify_asset(release: &VerifiedRelease, asset: &[u8]) -> Result<(), ReleaseError> {
    if u64::try_from(asset.len()).ok() != Some(release.claims.asset_size_bytes) {
        return Err(ReleaseError::AssetMismatch);
    }
    let digest: [u8; 32] = Sha256::digest(asset).into();
    if digest != release.claims.asset_sha256 {
        return Err(ReleaseError::AssetMismatch);
    }
    Ok(())
}

fn verify_manifest_with_key(
    manifest: &SignedReleaseManifest,
    public_key: &[u8; 32],
) -> Result<VerifiedRelease, ReleaseError> {
    let claims = &manifest.claims;
    if claims.format_version != MANIFEST_FORMAT_VERSION
        || claims.app_version.is_empty()
        || claims.asset_name.is_empty()
        || claims.asset_name.contains('/')
        || claims.asset_name.contains('\\')
        || claims.asset_size_bytes == 0
        || claims.published_at_unix <= 0
    {
        return Err(ReleaseError::InvalidManifest);
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(manifest.signature.as_bytes())
        .map_err(|_| ReleaseError::InvalidSignature)?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| ReleaseError::InvalidSignature)?;
    let verifying_key =
        VerifyingKey::from_bytes(public_key).map_err(|_| ReleaseError::InvalidSignature)?;
    verifying_key
        .verify(&claims_signing_bytes(claims), &signature)
        .map_err(|_| ReleaseError::InvalidSignature)?;
    Ok(VerifiedRelease {
        claims: claims.clone(),
    })
}

#[must_use]
pub fn claims_signing_bytes(claims: &ReleaseClaims) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&claims.format_version.to_be_bytes());
    push_string(&mut bytes, &claims.app_version);
    bytes.push(match claims.platform {
        ReleasePlatform::MacosUniversal => 1,
        ReleasePlatform::WindowsX64 => 2,
    });
    push_string(&mut bytes, &claims.asset_name);
    bytes.extend_from_slice(&claims.asset_sha256);
    bytes.extend_from_slice(&claims.asset_size_bytes.to_be_bytes());
    bytes.extend_from_slice(&claims.published_at_unix.to_be_bytes());
    bytes
}

fn push_string(bytes: &mut Vec<u8>, value: &str) {
    let length = u32::try_from(value.len()).unwrap_or(u32::MAX);
    bytes.extend_from_slice(&length.to_be_bytes());
    bytes.extend_from_slice(value.as_bytes());
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::{Signer, SigningKey};

    use super::*;

    fn fixture() -> (SignedReleaseManifest, [u8; 32], Vec<u8>) {
        let signing_key = SigningKey::from_bytes(&[11; 32]);
        let asset = b"signed installer bytes".to_vec();
        let claims = ReleaseClaims {
            format_version: MANIFEST_FORMAT_VERSION,
            app_version: "1.0.0".into(),
            platform: ReleasePlatform::MacosUniversal,
            asset_name: "DayTradingBot-1.0.0-universal.dmg".into(),
            asset_sha256: Sha256::digest(&asset).into(),
            asset_size_bytes: u64::try_from(asset.len()).unwrap(),
            published_at_unix: 1_700_000_000,
        };
        let signature = signing_key.sign(&claims_signing_bytes(&claims));
        (
            SignedReleaseManifest {
                claims,
                signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            },
            signing_key.verifying_key().to_bytes(),
            asset,
        )
    }

    #[test]
    fn signed_manifest_and_exact_asset_pass() {
        let (manifest, key, asset) = fixture();
        let release = verify_manifest_with_key(&manifest, &key).unwrap();
        verify_asset(&release, &asset).unwrap();
    }

    #[test]
    fn tampered_manifest_or_asset_fails() {
        let (mut manifest, key, mut asset) = fixture();
        manifest.claims.asset_name = "other.dmg".into();
        assert_eq!(
            verify_manifest_with_key(&manifest, &key),
            Err(ReleaseError::InvalidSignature)
        );

        let (manifest, key, _) = fixture();
        let release = verify_manifest_with_key(&manifest, &key).unwrap();
        asset[0] ^= 1;
        assert_eq!(
            verify_asset(&release, &asset),
            Err(ReleaseError::AssetMismatch)
        );
    }
}
