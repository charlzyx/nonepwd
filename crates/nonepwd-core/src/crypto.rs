use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use pbkdf2::pbkdf2_hmac;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::encoding::{from_base64_url, normalize_secret_key, to_base64_url};
use crate::random::fill_random;
use crate::types::{SealedEnvelope, ServiceAccountTokenPayload};

const X25519_PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedAccountKeys {
    pub master_unlock_key_b64: String,
    pub auth_verifier_b64: String,
}

pub fn derive_account_keys_raw(
    master_password: &str,
    secret_key: &str,
    kdf_salt_b64: &str,
    iterations: u32,
) -> Result<([u8; 32], String), String> {
    let normalized_sk = normalize_secret_key(secret_key);
    let ikm = format!("{normalized_sk}\x00{master_password}");
    let salt_bytes = from_base64_url(kdf_salt_b64)?;

    let mut full = [0u8; 64];
    pbkdf2_hmac::<Sha256>(ikm.as_bytes(), &salt_bytes, iterations, &mut full);

    let mut muk = [0u8; 32];
    muk.copy_from_slice(&full[..32]);
    let auth_seed = &full[32..64];

    let hk = Hkdf::<Sha256>::new(Some(&salt_bytes), auth_seed);
    let mut verifier = [0u8; 32];
    hk.expand(b"nonepwd-auth-verifier-v1", &mut verifier)
        .map_err(|_| "HKDF expand failed".to_string())?;

    Ok((muk, to_base64_url(&verifier)))
}

pub fn derive_account_keys(
    master_password: &str,
    secret_key: &str,
    kdf_salt_b64: &str,
    iterations: u32,
) -> Result<DerivedAccountKeys, String> {
    let (muk, auth_verifier_b64) =
        derive_account_keys_raw(master_password, secret_key, kdf_salt_b64, iterations)?;
    Ok(DerivedAccountKeys {
        master_unlock_key_b64: to_base64_url(&muk),
        auth_verifier_b64,
    })
}

pub fn generate_raw_aes_key() -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    fill_random(&mut key)?;
    Ok(key)
}

pub fn encrypt_bytes(
    raw_key32: &[u8],
    plaintext: &[u8],
    aad: Option<&str>,
) -> Result<String, String> {
    if raw_key32.len() != 32 {
        return Err(format!("Expected 32-byte AES key, got {}", raw_key32.len()));
    }
    let cipher = Aes256Gcm::new_from_slice(raw_key32)
        .map_err(|_| "Failed to initialize AES-256-GCM".to_string())?;
    let mut iv = [0u8; 12];
    fill_random(&mut iv)?;
    let nonce = Nonce::from_slice(&iv);
    let aad_bytes = aad.unwrap_or("").as_bytes();

    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: aad_bytes,
            },
        )
        .map_err(|_| "AES-GCM encryption failed".to_string())?;

    Ok(format!("v1.{}.{}", to_base64_url(&iv), to_base64_url(&ciphertext)))
}

pub fn decrypt_bytes(
    raw_key32: &[u8],
    blob: &str,
    aad: Option<&str>,
) -> Result<Vec<u8>, String> {
    if raw_key32.len() != 32 {
        return Err(format!("Expected 32-byte AES key, got {}", raw_key32.len()));
    }
    let parts: Vec<&str> = blob.split('.').collect();
    if parts.len() != 3 || parts[0] != "v1" {
        return Err("Unsupported encrypted blob format".to_string());
    }
    let iv = from_base64_url(parts[1])?;
    if iv.len() != 12 {
        return Err("Invalid AES-GCM IV length".to_string());
    }
    let ciphertext = from_base64_url(parts[2])?;
    let cipher = Aes256Gcm::new_from_slice(raw_key32)
        .map_err(|_| "Failed to initialize AES-256-GCM".to_string())?;
    let nonce = Nonce::from_slice(&iv);
    let aad_bytes = aad.unwrap_or("").as_bytes();

    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &ciphertext,
                aad: aad_bytes,
            },
        )
        .map_err(|_| "AES-GCM decryption failed (wrong key or tampered AAD)".to_string())
}

pub fn encrypt_json<T: Serialize>(
    raw_key32: &[u8],
    data: &T,
    aad: Option<&str>,
) -> Result<String, String> {
    let json = serde_json::to_vec(data).map_err(|e| format!("JSON serialize failed: {e}"))?;
    encrypt_bytes(raw_key32, &json, aad)
}

pub fn decrypt_json<T: DeserializeOwned>(
    raw_key32: &[u8],
    blob: &str,
    aad: Option<&str>,
) -> Result<T, String> {
    let bytes = decrypt_bytes(raw_key32, blob, aad)?;
    serde_json::from_slice(&bytes).map_err(|e| format!("JSON parse failed: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailKeyPair {
    pub public_key_b64: String,
    pub private_key_pkcs8_b64: String,
}

pub fn generate_email_key_pair() -> Result<EmailKeyPair, String> {
    let mut seed = [0u8; 32];
    fill_random(&mut seed)?;
    let secret = StaticSecret::from(seed);
    let public = PublicKey::from(&secret);

    let mut pkcs8 = Vec::with_capacity(48);
    pkcs8.extend_from_slice(&X25519_PKCS8_PREFIX);
    pkcs8.extend_from_slice(&secret.to_bytes());

    Ok(EmailKeyPair {
        public_key_b64: to_base64_url(public.as_bytes()),
        private_key_pkcs8_b64: to_base64_url(&pkcs8),
    })
}

fn decode_x25519_private_pkcs8(b64: &str) -> Result<StaticSecret, String> {
    let raw = from_base64_url(b64)?;
    let mut scalar = [0u8; 32];
    if raw.len() == 48 && raw[..16] == X25519_PKCS8_PREFIX {
        scalar.copy_from_slice(&raw[16..48]);
        return Ok(StaticSecret::from(scalar));
    }
    if raw.len() == 32 {
        scalar.copy_from_slice(&raw);
        return Ok(StaticSecret::from(scalar));
    }
    Err(format!("Unsupported X25519 private key length: {}", raw.len()))
}

fn decode_x25519_public_raw(b64: &str) -> Result<PublicKey, String> {
    let raw = from_base64_url(b64)?;
    if raw.len() != 32 {
        return Err(format!("Expected 32-byte X25519 public key, got {}", raw.len()));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&raw);
    Ok(PublicKey::from(arr))
}

fn derive_sealed_aes_key(shared: &[u8], eph_pub_raw: &[u8], info: &str) -> Result<[u8; 32], String> {
    let hk = Hkdf::<Sha256>::new(Some(eph_pub_raw), shared);
    let mut aes_key = [0u8; 32];
    hk.expand(info.as_bytes(), &mut aes_key)
        .map_err(|_| "Sealed-box HKDF failed".to_string())?;
    Ok(aes_key)
}

pub fn seal_for_public_key(
    recipient_public_key_b64: &str,
    plaintext: &[u8],
    info: &str,
) -> Result<SealedEnvelope, String> {
    let recipient_pub = decode_x25519_public_raw(recipient_public_key_b64)?;
    let mut eph_seed = [0u8; 32];
    fill_random(&mut eph_seed)?;
    let eph_secret = StaticSecret::from(eph_seed);
    let eph_pub = PublicKey::from(&eph_secret);

    let shared = eph_secret.diffie_hellman(&recipient_pub);
    let aes_key = derive_sealed_aes_key(shared.as_bytes(), eph_pub.as_bytes(), info)?;

    let mut iv = [0u8; 12];
    fill_random(&mut iv)?;
    let cipher = Aes256Gcm::new_from_slice(&aes_key)
        .map_err(|_| "Failed to init AES-256-GCM".to_string())?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: plaintext,
                aad: info.as_bytes(),
            },
        )
        .map_err(|_| "Sealed-box encryption failed".to_string())?;

    Ok(SealedEnvelope {
        v: 1,
        epk: to_base64_url(eph_pub.as_bytes()),
        iv: to_base64_url(&iv),
        ct: to_base64_url(&ct),
    })
}

pub fn open_sealed_envelope(
    recipient_private_key_pkcs8_b64: &str,
    envelope: &SealedEnvelope,
    info: &str,
) -> Result<Vec<u8>, String> {
    if envelope.v != 1 {
        return Err(format!("Unsupported envelope version: {}", envelope.v));
    }
    let priv_secret = decode_x25519_private_pkcs8(recipient_private_key_pkcs8_b64)?;
    let eph_pub = decode_x25519_public_raw(&envelope.epk)?;
    let shared = priv_secret.diffie_hellman(&eph_pub);
    let aes_key = derive_sealed_aes_key(shared.as_bytes(), eph_pub.as_bytes(), info)?;

    let iv = from_base64_url(&envelope.iv)?;
    if iv.len() != 12 {
        return Err("Invalid sealed envelope IV length".to_string());
    }
    let ct = from_base64_url(&envelope.ct)?;

    let cipher = Aes256Gcm::new_from_slice(&aes_key)
        .map_err(|_| "Failed to init AES-256-GCM".to_string())?;
    cipher
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &ct,
                aad: info.as_bytes(),
            },
        )
        .map_err(|_| "Failed to open sealed envelope".to_string())
}

pub fn seal_json_for_public_key<T: Serialize>(
    recipient_public_key_b64: &str,
    data: &T,
    info: &str,
) -> Result<SealedEnvelope, String> {
    let bytes = serde_json::to_vec(data).map_err(|e| format!("JSON serialize failed: {e}"))?;
    seal_for_public_key(recipient_public_key_b64, &bytes, info)
}

pub fn open_sealed_json<T: DeserializeOwned>(
    recipient_private_key_pkcs8_b64: &str,
    envelope: &SealedEnvelope,
    info: &str,
) -> Result<T, String> {
    let bytes = open_sealed_envelope(recipient_private_key_pkcs8_b64, envelope, info)?;
    serde_json::from_slice(&bytes).map_err(|e| format!("JSON parse failed: {e}"))
}

pub fn encode_service_account_token(payload: &ServiceAccountTokenPayload) -> Result<String, String> {
    let json = serde_json::to_vec(payload).map_err(|e| format!("JSON serialize failed: {e}"))?;
    Ok(format!("npst_v1_{}", to_base64_url(&json)))
}

pub fn decode_service_account_token(token: &str) -> Result<ServiceAccountTokenPayload, String> {
    let trimmed = token.trim();
    let rest = trimmed
        .strip_prefix("npst_v1_")
        .ok_or_else(|| "Invalid Service Account token format (expected npst_v1_...)".to_string())?;
    let bytes = from_base64_url(rest)?;
    let parsed: ServiceAccountTokenPayload =
        serde_json::from_slice(&bytes).map_err(|e| format!("Malformed Service Account token: {e}"))?;
    if parsed.v != 1
        || parsed.server_url.is_empty()
        || parsed.token_id.is_empty()
        || parsed.auth_secret.is_empty()
        || parsed.wrap_key_b64.is_empty()
    {
        return Err("Malformed Service Account token payload".to_string());
    }
    Ok(parsed)
}
