use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

use crate::random::random_int;

const BASE32_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SECRET_KEY_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

pub fn to_base64_url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn from_base64_url(input: &str) -> Result<Vec<u8>, String> {
    let normalized: String = input
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    URL_SAFE_NO_PAD
        .decode(normalized.as_bytes())
        .map_err(|e| format!("Invalid Base64URL string: {e}"))
}

pub fn to_base32(bytes: &[u8]) -> String {
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut out = String::new();
    for &b in bytes {
        value = (value << 8) | (b as u32);
        bits += 8;
        while bits >= 5 {
            let idx = ((value >> (bits - 5)) & 31) as usize;
            out.push(BASE32_ALPHABET[idx] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        let idx = ((value << (5 - bits)) & 31) as usize;
        out.push(BASE32_ALPHABET[idx] as char);
    }
    out
}

pub fn from_base32(input: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = input
        .to_ascii_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .collect();
    if cleaned.is_empty() {
        return Ok(Vec::new());
    }
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut out = Vec::with_capacity((cleaned.len() * 5) / 8);
    for (i, ch) in cleaned.chars().enumerate() {
        let idx = BASE32_ALPHABET
            .iter()
            .position(|&c| c as char == ch)
            .ok_or_else(|| format!("Invalid Base32 character at index {i}: {ch}"))? as u32;
        value = (value << 5) | idx;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    Ok(out)
}

pub fn generate_secret_key() -> Result<String, String> {
    let mut groups = Vec::with_capacity(5);
    for _ in 0..5 {
        let mut group = String::with_capacity(6);
        for _ in 0..6 {
            let idx = random_int(SECRET_KEY_ALPHABET.len())?;
            group.push(SECRET_KEY_ALPHABET[idx] as char);
        }
        groups.push(group);
    }
    Ok(format!("NP3-{}", groups.join("-")))
}

pub fn normalize_secret_key(secret_key: &str) -> String {
    secret_key
        .to_ascii_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect()
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= std::hint::black_box(x ^ y);
    }
    std::hint::black_box(diff) == 0
}
