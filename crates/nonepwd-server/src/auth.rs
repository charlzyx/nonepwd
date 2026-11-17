use std::collections::HashSet;

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use nonepwd_core::encoding::{constant_time_eq, from_base64_url, to_base64_url};
use nonepwd_core::random::fill_random;
use pbkdf2::pbkdf2_hmac;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::db::NonePwdDb;

type HmacSha256 = Hmac<Sha256>;

const SCRYPT_N: usize = 16_384;
const SCRYPT_R: usize = 8;
const SCRYPT_P: usize = 1;
const SCRYPT_KEYLEN: usize = 32;

#[derive(Debug, Clone)]
pub enum AuthContext {
    Owner {
        token_hash: String,
    },
    ServiceAccount {
        token_hash: String,
        service_account_id: String,
        allowed_vault_ids: HashSet<String>,
    },
}

impl AuthContext {
    pub fn kind_str(&self) -> &'static str {
        match self {
            AuthContext::Owner { .. } => "owner",
            AuthContext::ServiceAccount { .. } => "service_account",
        }
    }

    pub fn token_hash(&self) -> &str {
        match self {
            AuthContext::Owner { token_hash } => token_hash,
            AuthContext::ServiceAccount { token_hash, .. } => token_hash,
        }
    }
}

pub fn now_iso_millis() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn salsa20_8(block: &mut [u32; 16]) {
    let mut x = *block;
    for _ in 0..4 {
        // Column round
        x[4] ^= x[0].wrapping_add(x[12]).rotate_left(7);
        x[8] ^= x[4].wrapping_add(x[0]).rotate_left(9);
        x[12] ^= x[8].wrapping_add(x[4]).rotate_left(13);
        x[0] ^= x[12].wrapping_add(x[8]).rotate_left(18);

        x[9] ^= x[5].wrapping_add(x[1]).rotate_left(7);
        x[13] ^= x[9].wrapping_add(x[5]).rotate_left(9);
        x[1] ^= x[13].wrapping_add(x[9]).rotate_left(13);
        x[5] ^= x[1].wrapping_add(x[13]).rotate_left(18);

        x[14] ^= x[10].wrapping_add(x[6]).rotate_left(7);
        x[2] ^= x[14].wrapping_add(x[10]).rotate_left(9);
        x[6] ^= x[2].wrapping_add(x[14]).rotate_left(13);
        x[10] ^= x[6].wrapping_add(x[2]).rotate_left(18);

        x[3] ^= x[15].wrapping_add(x[11]).rotate_left(7);
        x[7] ^= x[3].wrapping_add(x[15]).rotate_left(9);
        x[11] ^= x[7].wrapping_add(x[3]).rotate_left(13);
        x[15] ^= x[11].wrapping_add(x[7]).rotate_left(18);

        // Row round
        x[1] ^= x[0].wrapping_add(x[3]).rotate_left(7);
        x[2] ^= x[1].wrapping_add(x[0]).rotate_left(9);
        x[3] ^= x[2].wrapping_add(x[1]).rotate_left(13);
        x[0] ^= x[3].wrapping_add(x[2]).rotate_left(18);

        x[6] ^= x[5].wrapping_add(x[4]).rotate_left(7);
        x[7] ^= x[6].wrapping_add(x[5]).rotate_left(9);
        x[4] ^= x[7].wrapping_add(x[6]).rotate_left(13);
        x[5] ^= x[4].wrapping_add(x[7]).rotate_left(18);

        x[11] ^= x[10].wrapping_add(x[9]).rotate_left(7);
        x[8] ^= x[11].wrapping_add(x[10]).rotate_left(9);
        x[9] ^= x[8].wrapping_add(x[11]).rotate_left(13);
        x[10] ^= x[9].wrapping_add(x[8]).rotate_left(18);

        x[12] ^= x[15].wrapping_add(x[14]).rotate_left(7);
        x[13] ^= x[12].wrapping_add(x[15]).rotate_left(9);
        x[14] ^= x[13].wrapping_add(x[12]).rotate_left(13);
        x[15] ^= x[14].wrapping_add(x[13]).rotate_left(18);
    }
    for i in 0..16 {
        block[i] = block[i].wrapping_add(x[i]);
    }
}

fn scrypt_block_mix(b: &[u32], y: &mut [u32], r: usize) {
    let mut x = [0u32; 16];
    let last_offset = (2 * r - 1) * 16;
    x.copy_from_slice(&b[last_offset..last_offset + 16]);

    for i in 0..(2 * r) {
        let chunk = &b[i * 16..(i + 1) * 16];
        for k in 0..16 {
            x[k] ^= chunk[k];
        }
        salsa20_8(&mut x);
        let dest_idx = if i % 2 == 0 { i / 2 } else { r + i / 2 };
        y[dest_idx * 16..(dest_idx + 1) * 16].copy_from_slice(&x);
    }
}

fn scrypt_ro_mix(block_bytes: &mut [u8], r: usize, n: usize) {
    let words = 32 * r;
    let mut x = vec![0u32; words];
    let mut y = vec![0u32; words];
    for (i, chunk) in block_bytes.chunks_exact(4).enumerate() {
        x[i] = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
    }

    let mut v = vec![0u32; n * words];
    for i in 0..n {
        v[i * words..(i + 1) * words].copy_from_slice(&x);
        scrypt_block_mix(&x, &mut y, r);
        std::mem::swap(&mut x, &mut y);
    }

    let int_offset = (2 * r - 1) * 16;
    let mask = n - 1;
    for _ in 0..n {
        let j = (x[int_offset] as usize) & mask;
        let v_slice = &v[j * words..(j + 1) * words];
        for k in 0..words {
            x[k] ^= v_slice[k];
        }
        scrypt_block_mix(&x, &mut y, r);
        std::mem::swap(&mut x, &mut y);
    }

    for (i, word) in x.iter().enumerate() {
        block_bytes[i * 4..(i + 1) * 4].copy_from_slice(&word.to_le_bytes());
    }
}

/// RFC 7914 scrypt matching Node.js `crypto.scryptSync(secret, salt, keylen)` defaults (N=16384, r=8, p=1).
pub fn scrypt_derive(secret: &[u8], salt: &[u8], keylen: usize) -> Vec<u8> {
    let block_len = 128 * SCRYPT_R;
    let mut b = vec![0u8; SCRYPT_P * block_len];
    pbkdf2_hmac::<Sha256>(secret, salt, 1, &mut b);

    for p_idx in 0..SCRYPT_P {
        let slice = &mut b[p_idx * block_len..(p_idx + 1) * block_len];
        scrypt_ro_mix(slice, SCRYPT_R, SCRYPT_N);
    }

    let mut out = vec![0u8; keylen];
    pbkdf2_hmac::<Sha256>(secret, &b, 1, &mut out);
    out
}

pub fn hash_secret(secret: &str) -> Result<String, String> {
    let mut salt = [0u8; 16];
    fill_random(&mut salt)?;
    Ok(hash_secret_with_salt(secret, &salt))
}

pub fn hash_secret_with_salt(secret: &str, salt: &[u8]) -> String {
    let derived = scrypt_derive(secret.as_bytes(), salt, SCRYPT_KEYLEN);
    format!("s1${}${}", to_base64_url(salt), to_base64_url(&derived))
}

pub fn verify_secret(secret: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    if parts.len() != 3 || parts[0] != "s1" {
        return false;
    }
    let Ok(salt) = from_base64_url(parts[1]) else {
        return false;
    };
    let Ok(expected) = from_base64_url(parts[2]) else {
        return false;
    };
    if expected.is_empty() || expected.len() > 128 {
        return false;
    }
    let actual = scrypt_derive(secret.as_bytes(), &salt, expected.len());
    constant_time_eq(&actual, &expected)
}

pub fn hash_session_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex::encode(digest)
}

pub fn create_session(
    db: &NonePwdDb,
    kind: &str,
    service_account_id: Option<&str>,
    ttl_ms: i64,
) -> Result<String, String> {
    let mut raw_bytes = [0u8; 32];
    fill_random(&mut raw_bytes)?;
    let raw_token = to_base64_url(&raw_bytes);
    let token_hash = hash_session_token(&raw_token);

    let now = Utc::now();
    let expires_at = now + Duration::milliseconds(ttl_ms);
    let now_str = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let exp_str = expires_at.to_rfc3339_opts(SecondsFormat::Millis, true);

    let conn = db.lock_conn();
    let _ = conn.execute(
        "DELETE FROM sessions WHERE expires_at < ?1",
        params![now_str],
    );
    conn.execute(
        "INSERT INTO sessions (token_hash, kind, service_account_id, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![token_hash, kind, service_account_id, now_str, exp_str],
    )
    .map_err(|e| format!("Failed creating session: {e}"))?;

    Ok(raw_token)
}

fn is_expired(expires_at: &str) -> bool {
    match DateTime::parse_from_rfc3339(expires_at) {
        Ok(dt) => dt.timestamp_millis() < Utc::now().timestamp_millis(),
        Err(_) => true,
    }
}

pub fn authenticate_token(db: &NonePwdDb, raw_token: Option<&str>) -> Option<AuthContext> {
    let raw_token = raw_token?.trim();
    if raw_token.is_empty() {
        return None;
    }
    let token_hash = hash_session_token(raw_token);
    let conn = db.lock_conn();

    let row: Option<(String, Option<String>, String)> = conn
        .query_row(
            "SELECT kind, service_account_id, expires_at FROM sessions WHERE token_hash = ?1",
            params![token_hash],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .ok()
        .flatten();

    let (kind, sa_id, expires_at) = row?;
    if is_expired(&expires_at) {
        let _ = conn.execute(
            "DELETE FROM sessions WHERE token_hash = ?1",
            params![token_hash],
        );
        return None;
    }

    if kind == "owner" {
        return Some(AuthContext::Owner { token_hash });
    }

    let sa_id = sa_id?;
    let sa_exists: Option<String> = conn
        .query_row(
            "SELECT id FROM service_accounts WHERE id = ?1",
            params![sa_id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();

    if sa_exists.is_none() {
        let _ = conn.execute(
            "DELETE FROM sessions WHERE token_hash = ?1",
            params![token_hash],
        );
        return None;
    }

    let mut allowed_vault_ids = HashSet::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT vault_id FROM service_account_vaults WHERE service_account_id = ?1")
    {
        if let Ok(rows) = stmt.query_map(params![sa_id], |r| r.get::<_, String>(0)) {
            for vid in rows.flatten() {
                allowed_vault_ids.insert(vid);
            }
        }
    }

    Some(AuthContext::ServiceAccount {
        token_hash,
        service_account_id: sa_id,
        allowed_vault_ids,
    })
}

pub fn extract_bearer_token(header: Option<&str>) -> Option<String> {
    let h = header?.trim();
    let prefix = h.get(..7)?;
    let rest = h.get(7..)?;
    if prefix.eq_ignore_ascii_case("bearer ") {
        let tok = rest.trim();
        if !tok.is_empty() {
            return Some(tok.to_string());
        }
    }
    None
}

pub fn verify_webhook_hmac(
    secret: &str,
    timestamp_header: Option<&str>,
    signature_header: Option<&str>,
    raw_body: &[u8],
    max_skew_seconds: i64,
) -> bool {
    let Some(timestamp_header) = timestamp_header else {
        return false;
    };
    let Some(signature_header) = signature_header else {
        return false;
    };
    if secret.is_empty() || timestamp_header.is_empty() || signature_header.is_empty() {
        return false;
    }

    let Ok(ts) = timestamp_header.trim().parse::<i64>() else {
        return false;
    };
    let now_sec = Utc::now().timestamp();
    if (now_sec - ts).abs() > max_skew_seconds {
        return false;
    }

    let Ok(mut mac) = HmacSha256::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(timestamp_header.as_bytes());
    mac.update(b".");
    mac.update(raw_body);
    let expected_hex = hex::encode(mac.finalize().into_bytes());

    let provided = signature_header
        .strip_prefix("v1=")
        .unwrap_or(signature_header)
        .trim()
        .to_ascii_lowercase();

    constant_time_eq(provided.as_bytes(), expected_hex.as_bytes())
}
