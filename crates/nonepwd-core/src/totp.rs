use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Sha256, Sha512};
use url::Url;

use crate::encoding::from_base32;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TotpAlgorithm {
    SHA1,
    SHA256,
    SHA512,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTotpConfig {
    pub secret: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub algorithm: TotpAlgorithm,
    pub digits: u32,
    pub period: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TotpResult {
    pub code: String,
    pub period: u64,
    pub remaining_seconds: u64,
    pub progress: f64,
}

fn normalize_algorithm(raw: Option<&str>) -> TotpAlgorithm {
    let cleaned: String = raw
        .unwrap_or("SHA1")
        .to_ascii_uppercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    match cleaned.as_str() {
        "SHA256" => TotpAlgorithm::SHA256,
        "SHA512" => TotpAlgorithm::SHA512,
        _ => TotpAlgorithm::SHA1,
    }
}

fn percent_decode_simple(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub fn parse_otp_input(input: &str) -> Result<ParsedTotpConfig, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Empty TOTP secret or URI".to_string());
    }

    if trimmed.to_ascii_lowercase().starts_with("otpauth://") {
        let url = Url::parse(trimmed).map_err(|e| format!("Invalid otpauth URI: {e}"))?;
        let kind = url.host_str().unwrap_or("");
        if kind.eq_ignore_ascii_case("hotp") {
            return Err("HOTP otpauth URIs are not supported (only TOTP is supported)".to_string());
        }
        if !kind.eq_ignore_ascii_case("totp") {
            return Err(format!("Unsupported otpauth type \"{kind}\" (expected totp)"));
        }
        let mut secret = String::new();
        let mut issuer_param: Option<String> = None;
        let mut digits_raw = 6u32;
        let mut period_raw = 30u64;
        let mut alg_param: Option<String> = None;

        for (k, v) in url.query_pairs() {
            match k.as_ref() {
                "secret" => secret = v.to_string(),
                "issuer" => issuer_param = Some(v.to_string()),
                "digits" => {
                    if let Ok(d) = v.parse::<u32>() {
                        digits_raw = d;
                    }
                }
                "period" => {
                    if let Ok(p) = v.parse::<u64>() {
                        period_raw = p;
                    }
                }
                "algorithm" => alg_param = Some(v.to_string()),
                _ => {}
            }
        }

        if secret.is_empty() {
            return Err("otpauth URI is missing secret parameter".to_string());
        }

        let raw_label = percent_decode_simple(url.path().trim_start_matches('/'));
        let mut label_issuer = None;
        let mut account = if raw_label.is_empty() {
            None
        } else {
            Some(raw_label.clone())
        };
        if let Some((iss, acc)) = raw_label.split_once(':') {
            let iss_t = iss.trim();
            let acc_t = acc.trim();
            if !iss_t.is_empty() {
                label_issuer = Some(iss_t.to_string());
            }
            account = if acc_t.is_empty() {
                None
            } else {
                Some(acc_t.to_string())
            };
        }

        let cleaned_secret: String = secret
            .to_ascii_uppercase()
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
            .collect();
        from_base32(&cleaned_secret)?;

        return Ok(ParsedTotpConfig {
            secret: cleaned_secret,
            issuer: issuer_param.or(label_issuer),
            account,
            algorithm: normalize_algorithm(alg_param.as_deref()),
            digits: if (6..=8).contains(&digits_raw) { digits_raw } else { 6 },
            period: if period_raw > 0 { period_raw } else { 30 },
        });
    }

    let cleaned: String = trimmed
        .to_ascii_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .collect();
    from_base32(&cleaned)?;
    Ok(ParsedTotpConfig {
        secret: cleaned,
        issuer: None,
        account: None,
        algorithm: TotpAlgorithm::SHA1,
        digits: 6,
        period: 30,
    })
}

fn hmac_digest(alg: TotpAlgorithm, key: &[u8], counter_bytes: &[u8; 8]) -> Result<Vec<u8>, String> {
    match alg {
        TotpAlgorithm::SHA1 => {
            let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(key)
                .map_err(|_| "HMAC-SHA1 init failed".to_string())?;
            mac.update(counter_bytes);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        TotpAlgorithm::SHA256 => {
            let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
                .map_err(|_| "HMAC-SHA256 init failed".to_string())?;
            mac.update(counter_bytes);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        TotpAlgorithm::SHA512 => {
            let mut mac = <Hmac<Sha512> as Mac>::new_from_slice(key)
                .map_err(|_| "HMAC-SHA512 init failed".to_string())?;
            mac.update(counter_bytes);
            Ok(mac.finalize().into_bytes().to_vec())
        }
    }
}

pub fn generate_totp(input: &str, timestamp_ms: u64) -> Result<TotpResult, String> {
    let config = parse_otp_input(input)?;
    let key_bytes = from_base32(&config.secret)?;
    if key_bytes.is_empty() {
        return Err("TOTP secret decoded to empty bytes".to_string());
    }

    let epoch_sec = timestamp_ms / 1000;
    let counter = epoch_sec / config.period;
    let elapsed = epoch_sec % config.period;
    let remaining_seconds = config.period - elapsed;
    let progress = (remaining_seconds as f64) / (config.period as f64);

    let counter_bytes = counter.to_be_bytes();
    let hmac = hmac_digest(config.algorithm, &key_bytes, &counter_bytes)?;

    let offset = (hmac[hmac.len() - 1] & 0x0f) as usize;
    let binary: u32 = (((hmac[offset] & 0x7f) as u32) << 24)
        | ((hmac[offset + 1] as u32) << 16)
        | ((hmac[offset + 2] as u32) << 8)
        | (hmac[offset + 3] as u32);

    let modulus = 10u32.pow(config.digits);
    let val = binary % modulus;
    let code = format!("{val:0width$}", width = config.digits as usize);

    Ok(TotpResult {
        code,
        period: config.period,
        remaining_seconds,
        progress,
    })
}

pub fn build_otp_auth_uri(
    secret: &str,
    account: Option<&str>,
    issuer: Option<&str>,
    digits: Option<u32>,
    period: Option<u64>,
    algorithm: Option<TotpAlgorithm>,
) -> String {
    let clean_secret: String = secret
        .to_ascii_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .collect();
    let acc = account.unwrap_or("user");
    let label = match issuer {
        Some(iss) if !iss.is_empty() => format!("{iss}:{acc}"),
        _ => acc.to_string(),
    };

    let mut url = Url::parse("otpauth://totp/").expect("valid base otpauth URL");
    url.set_path(&label);
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("secret", &clean_secret);
        if let Some(iss) = issuer {
            if !iss.is_empty() {
                qp.append_pair("issuer", iss);
            }
        }
        if let Some(d) = digits {
            if d != 6 {
                qp.append_pair("digits", &d.to_string());
            }
        }
        if let Some(p) = period {
            if p != 30 {
                qp.append_pair("period", &p.to_string());
            }
        }
        if let Some(alg) = algorithm {
            if alg != TotpAlgorithm::SHA1 {
                let s = match alg {
                    TotpAlgorithm::SHA1 => "SHA1",
                    TotpAlgorithm::SHA256 => "SHA256",
                    TotpAlgorithm::SHA512 => "SHA512",
                };
                qp.append_pair("algorithm", s);
            }
        }
    }
    url.to_string()
}
