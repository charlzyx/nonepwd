use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::encoding::{from_base32, from_base64_url, to_base32};
use crate::otp_extractor::extract_registrable_domain;
use crate::totp::{parse_otp_input, TotpAlgorithm};
use crate::types::{ItemCategory, VaultItemPayload};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TotpImportEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub secret: String,
    pub otpauth_uri: String,
    pub digits: u32,
    pub period: u64,
    pub algorithm: TotpAlgorithm,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImportFormat {
    Csv,
    Totp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TotpImportAction {
    #[serde(rename_all = "camelCase")]
    SkipDuplicate {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        existing_item_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Attach {
        item_id: String,
        otpauth_uri: String,
    },
    #[serde(rename_all = "camelCase")]
    Create {
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        username: Option<String>,
        totp: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TotpImportPlanItem {
    pub entry: TotpImportEntry,
    #[serde(flatten)]
    pub decision: TotpImportAction,
}

fn trim_non_empty(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn clean_base32_secret(raw: &str) -> Result<String, String> {
    let cleaned: String = raw
        .to_ascii_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != '=')
        .collect();
    if cleaned.is_empty() {
        return Err("Empty TOTP secret".to_string());
    }
    let decoded = from_base32(&cleaned)?;
    if decoded.is_empty() {
        return Err("TOTP secret decoded to empty bytes".to_string());
    }
    Ok(cleaned)
}

fn parse_algorithm_str(raw: Option<&str>) -> TotpAlgorithm {
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

pub fn format_totp_otpauth_uri(
    secret: &str,
    account: Option<&str>,
    issuer: Option<&str>,
    digits: u32,
    period: u64,
    algorithm: TotpAlgorithm,
) -> String {
    let iss_clean = issuer.map(str::trim).filter(|s| !s.is_empty());
    let acc_clean = account.map(str::trim).filter(|s| !s.is_empty());

    let label = match (iss_clean, acc_clean) {
        (Some(iss), Some(acc)) => format!("{iss}:{acc}"),
        (Some(iss), None) => format!("{iss}:"),
        (None, Some(acc)) => acc.to_string(),
        (None, None) => String::new(),
    };

    let mut url = Url::parse("otpauth://totp/").expect("valid base otpauth URL");
    url.set_path(&label);
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("secret", secret);
        if let Some(iss) = iss_clean {
            qp.append_pair("issuer", iss);
        }
        if digits != 6 {
            qp.append_pair("digits", &digits.to_string());
        }
        if period != 30 {
            qp.append_pair("period", &period.to_string());
        }
        if algorithm != TotpAlgorithm::SHA1 {
            let alg_str = match algorithm {
                TotpAlgorithm::SHA1 => "SHA1",
                TotpAlgorithm::SHA256 => "SHA256",
                TotpAlgorithm::SHA512 => "SHA512",
            };
            qp.append_pair("algorithm", alg_str);
        }
    }
    url.to_string()
}

fn build_entry(
    secret_raw: &str,
    issuer: Option<String>,
    account: Option<String>,
    digits: u32,
    period: u64,
    algorithm: TotpAlgorithm,
) -> Result<TotpImportEntry, String> {
    let secret = clean_base32_secret(secret_raw)?;
    let norm_digits = if (6..=8).contains(&digits) { digits } else { 6 };
    let norm_period = if period > 0 { period } else { 30 };
    let issuer_clean = issuer.and_then(|s| trim_non_empty(&s));
    let account_clean = account.and_then(|s| trim_non_empty(&s));
    let otpauth_uri = format_totp_otpauth_uri(
        &secret,
        account_clean.as_deref(),
        issuer_clean.as_deref(),
        norm_digits,
        norm_period,
        algorithm,
    );
    Ok(TotpImportEntry {
        issuer: issuer_clean,
        account: account_clean,
        secret,
        otpauth_uri,
        digits: norm_digits,
        period: norm_period,
        algorithm,
    })
}

fn percent_decode_preserving_plus(input: &str) -> Result<Vec<u8>, String> {
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
    Ok(out)
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut result = 0u64;
    let mut shift = 0u32;
    while *pos < buf.len() {
        let byte = buf[*pos];
        *pos += 1;
        if shift >= 64 {
            return Err("Invalid protobuf varint: integer overflow".to_string());
        }
        if shift == 63 && byte > 1 {
            return Err("Invalid protobuf varint: 64-bit overflow".to_string());
        }
        result |= ((byte & 0x7f) as u64) << shift;
        if (byte & 0x80) == 0 {
            return Ok(result);
        }
        shift += 7;
    }
    Err("Unexpected EOF while decoding protobuf varint".to_string())
}

fn read_len_delimited<'a>(buf: &'a [u8], pos: &mut usize) -> Result<&'a [u8], String> {
    let len = read_varint(buf, pos)? as usize;
    let end = pos
        .checked_add(len)
        .ok_or_else(|| "Protobuf length overflow".to_string())?;
    if end > buf.len() {
        return Err("Unexpected EOF in length-delimited protobuf field".to_string());
    }
    let slice = &buf[*pos..end];
    *pos = end;
    Ok(slice)
}

fn skip_wire_value(buf: &[u8], pos: &mut usize, wire_type: u8) -> Result<(), String> {
    match wire_type {
        0 => {
            let _ = read_varint(buf, pos)?;
            Ok(())
        }
        1 => {
            let end = pos
                .checked_add(8)
                .ok_or_else(|| "Protobuf 64-bit field overflow".to_string())?;
            if end > buf.len() {
                return Err("Unexpected EOF in 64-bit protobuf field".to_string());
            }
            *pos = end;
            Ok(())
        }
        2 => {
            let _ = read_len_delimited(buf, pos)?;
            Ok(())
        }
        5 => {
            let end = pos
                .checked_add(4)
                .ok_or_else(|| "Protobuf 32-bit field overflow".to_string())?;
            if end > buf.len() {
                return Err("Unexpected EOF in 32-bit protobuf field".to_string());
            }
            *pos = end;
            Ok(())
        }
        other => Err(format!("Unsupported protobuf wire type: {other}")),
    }
}

fn decode_migration_otp_parameters(buf: &[u8]) -> Result<Option<TotpImportEntry>, String> {
    let mut pos = 0usize;
    let mut secret_bytes: Vec<u8> = Vec::new();
    let mut name = String::new();
    let mut issuer = String::new();
    let mut algorithm_raw = 0u64;
    let mut digits_raw = 0u64;
    let mut otp_type_raw = 0u64;

    while pos < buf.len() {
        let tag = read_varint(buf, &mut pos)?;
        let field_number = tag >> 3;
        let wire_type = (tag & 0x07) as u8;
        match (field_number, wire_type) {
            (1, 2) => {
                secret_bytes = read_len_delimited(buf, &mut pos)?.to_vec();
            }
            (2, 2) => {
                let b = read_len_delimited(buf, &mut pos)?;
                name = String::from_utf8_lossy(b).to_string();
            }
            (3, 2) => {
                let b = read_len_delimited(buf, &mut pos)?;
                issuer = String::from_utf8_lossy(b).to_string();
            }
            (4, 0) => {
                algorithm_raw = read_varint(buf, &mut pos)?;
            }
            (5, 0) => {
                digits_raw = read_varint(buf, &mut pos)?;
            }
            (6, 0) => {
                otp_type_raw = read_varint(buf, &mut pos)?;
            }
            _ => {
                skip_wire_value(buf, &mut pos, wire_type)?;
            }
        }
    }

    // OtpType: 0 = UNSPECIFIED (default TOTP), 1 = HOTP, 2 = TOTP
    if otp_type_raw != 0 && otp_type_raw != 2 {
        return Ok(None);
    }

    if secret_bytes.is_empty() {
        return Err("Google Authenticator migration entry is missing secret bytes".to_string());
    }

    let algorithm = match algorithm_raw {
        0 | 1 => TotpAlgorithm::SHA1,
        2 => TotpAlgorithm::SHA256,
        3 => TotpAlgorithm::SHA512,
        4 => return Err("Unsupported MD5 OTP algorithm in migration payload".to_string()),
        other => return Err(format!("Unknown OTP algorithm enum {other} in migration payload")),
    };

    let digits = match digits_raw {
        0 | 1 | 6 => 6,
        2 | 8 => 8,
        7 => 7,
        _ => 6,
    };

    let explicit_issuer = trim_non_empty(&issuer);
    let raw_name = name.trim();
    let (label_issuer, account) = if let Some((iss_part, acc_part)) = raw_name.split_once(':') {
        (trim_non_empty(iss_part), trim_non_empty(acc_part))
    } else {
        (None, trim_non_empty(raw_name))
    };

    let final_issuer = explicit_issuer.or(label_issuer);
    let secret_b32 = to_base32(&secret_bytes);
    let entry = build_entry(&secret_b32, final_issuer, account, digits, 30, algorithm)?;
    Ok(Some(entry))
}

fn parse_otpauth_migration_uri(uri: &str) -> Result<Vec<TotpImportEntry>, String> {
    let trimmed = uri.trim();
    let (_, query_and_frag) = trimmed
        .split_once('?')
        .ok_or_else(|| "otpauth-migration URI is missing query parameters".to_string())?;
    let query = query_and_frag.split('#').next().unwrap_or(query_and_frag);

    let mut data_raw: Option<&str> = None;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k.eq_ignore_ascii_case("data") {
                data_raw = Some(v);
                break;
            }
        }
    }

    let data_param = data_raw
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "otpauth-migration URI is missing data parameter".to_string())?;

    let decoded_param_bytes = percent_decode_preserving_plus(data_param)?;
    let decoded_param_str = std::str::from_utf8(&decoded_param_bytes)
        .map_err(|_| "Invalid UTF-8 in otpauth-migration data parameter".to_string())?;
    let proto_bytes = from_base64_url(decoded_param_str)
        .map_err(|e| format!("Invalid Base64 in otpauth-migration data parameter: {e}"))?;

    if proto_bytes.is_empty() {
        return Err("Empty protobuf payload in otpauth-migration URI".to_string());
    }

    let mut pos = 0usize;
    let mut entries = Vec::new();
    while pos < proto_bytes.len() {
        let tag = read_varint(&proto_bytes, &mut pos)?;
        let field_number = tag >> 3;
        let wire_type = (tag & 0x07) as u8;
        if field_number == 1 && wire_type == 2 {
            let sub = read_len_delimited(&proto_bytes, &mut pos)?;
            if let Some(entry) = decode_migration_otp_parameters(sub)? {
                entries.push(entry);
            }
        } else {
            skip_wire_value(&proto_bytes, &mut pos, wire_type)?;
        }
    }

    Ok(entries)
}

fn parse_otpauth_uri_line(line: &str) -> Result<Option<TotpImportEntry>, String> {
    let trimmed = line.trim();
    let url = Url::parse(trimmed).map_err(|e| format!("Invalid otpauth URI: {e}"))?;
    let kind = url.host_str().unwrap_or("");
    if kind.eq_ignore_ascii_case("hotp") {
        return Ok(None);
    }
    if !kind.eq_ignore_ascii_case("totp") {
        return Err(format!("Unsupported otpauth type \"{kind}\" (expected totp)"));
    }

    let cfg = parse_otp_input(trimmed)?;
    let entry = build_entry(
        &cfg.secret,
        cfg.issuer,
        cfg.account,
        cfg.digits,
        cfg.period,
        cfg.algorithm,
    )?;
    Ok(Some(entry))
}

fn parse_json_authenticator_export(json_text: &str) -> Result<Vec<TotpImportEntry>, String> {
    let root: Value = serde_json::from_str(json_text)
        .map_err(|e| format!("Invalid JSON authenticator export: {e}"))?;

    let mut entries = Vec::new();

    if let Some(obj) = root.as_object() {
        // 1. Aegis JSON format: { "db": { "entries": [...] } }
        if let Some(db) = obj.get("db") {
            if db.is_string() {
                return Err(
                    "Encrypted Aegis backup is not supported; export as plain JSON".to_string(),
                );
            }
            if let Some(arr) = db.get("entries").and_then(Value::as_array) {
                for item in arr {
                    let entry_type = item
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("totp");
                    if !entry_type.eq_ignore_ascii_case("totp") {
                        continue;
                    }
                    let info = match item.get("info") {
                        Some(v) => v,
                        None => continue,
                    };
                    let secret = match info.get("secret").and_then(Value::as_str) {
                        Some(s) if !s.trim().is_empty() => s,
                        _ => continue,
                    };
                    let issuer = item
                        .get("issuer")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let account = item
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let digits = info.get("digits").and_then(Value::as_u64).unwrap_or(6) as u32;
                    let period = info.get("period").and_then(Value::as_u64).unwrap_or(30);
                    let alg = parse_algorithm_str(info.get("algo").and_then(Value::as_str));
                    entries.push(build_entry(secret, issuer, account, digits, period, alg)?);
                }
                if entries.is_empty() {
                    return Err("No TOTP entries found in Aegis JSON export".to_string());
                }
                return Ok(entries);
            }
        }

        // 2. 2FAS JSON format: { "services": [...] }
        if obj.contains_key("services") || obj.contains_key("servicesEncrypted") {
            if obj.get("services").and_then(Value::as_array).is_none()
                && obj.get("servicesEncrypted").is_some_and(|v| !v.is_null())
            {
                return Err(
                    "Encrypted 2FAS backup is not supported; export without password".to_string(),
                );
            }
            if let Some(services) = obj.get("services").and_then(Value::as_array) {
                for svc in services {
                    let otp = svc.get("otp");
                    let token_type = otp
                        .and_then(|o| o.get("tokenType"))
                        .and_then(Value::as_str)
                        .unwrap_or("TOTP");
                    if !token_type.eq_ignore_ascii_case("TOTP") {
                        continue;
                    }

                    if let Some(link) = otp.and_then(|o| o.get("link")).and_then(Value::as_str) {
                        if link.trim().to_ascii_lowercase().starts_with("otpauth://") {
                            if let Some(mut parsed) = parse_otpauth_uri_line(link)? {
                                if parsed.issuer.is_none() {
                                    parsed.issuer = otp
                                        .and_then(|o| o.get("issuer"))
                                        .and_then(Value::as_str)
                                        .or_else(|| svc.get("name").and_then(Value::as_str))
                                        .and_then(trim_non_empty);
                                }
                                if parsed.account.is_none() {
                                    parsed.account = otp
                                        .and_then(|o| o.get("account"))
                                        .and_then(Value::as_str)
                                        .and_then(trim_non_empty);
                                }
                                parsed.otpauth_uri = format_totp_otpauth_uri(
                                    &parsed.secret,
                                    parsed.account.as_deref(),
                                    parsed.issuer.as_deref(),
                                    parsed.digits,
                                    parsed.period,
                                    parsed.algorithm,
                                );
                                entries.push(parsed);
                                continue;
                            }
                        }
                    }

                    let secret = match svc.get("secret").and_then(Value::as_str) {
                        Some(s) if !s.trim().is_empty() => s,
                        _ => continue,
                    };
                    let issuer = otp
                        .and_then(|o| o.get("issuer"))
                        .and_then(Value::as_str)
                        .or_else(|| svc.get("name").and_then(Value::as_str))
                        .map(str::to_string);
                    let account = otp
                        .and_then(|o| o.get("account"))
                        .and_then(Value::as_str)
                        .or_else(|| otp.and_then(|o| o.get("label")).and_then(Value::as_str))
                        .map(str::to_string);
                    let digits = otp
                        .and_then(|o| o.get("digits"))
                        .and_then(Value::as_u64)
                        .unwrap_or(6) as u32;
                    let period = otp
                        .and_then(|o| o.get("period"))
                        .and_then(Value::as_u64)
                        .unwrap_or(30);
                    let alg = parse_algorithm_str(
                        otp.and_then(|o| o.get("algorithm")).and_then(Value::as_str),
                    );
                    entries.push(build_entry(secret, issuer, account, digits, period, alg)?);
                }
                if entries.is_empty() {
                    return Err("No TOTP entries found in 2FAS JSON export".to_string());
                }
                return Ok(entries);
            }
        }
    }

    // 3. Generic JSON array (Raivo plain JSON / array of URIs or objects)
    if let Some(arr) = root.as_array() {
        for item in arr {
            if let Some(s) = item.as_str() {
                let lower = s.trim().to_ascii_lowercase();
                if lower.starts_with("otpauth-migration://") {
                    entries.extend(parse_otpauth_migration_uri(s)?);
                } else if lower.starts_with("otpauth://") {
                    if let Some(e) = parse_otpauth_uri_line(s)? {
                        entries.push(e);
                    }
                }
            } else if let Some(obj) = item.as_object() {
                let kind = obj
                    .get("kind")
                    .or_else(|| obj.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or("TOTP");
                if !kind.eq_ignore_ascii_case("totp") {
                    continue;
                }
                if let Some(uri) = obj
                    .get("otpauthUri")
                    .or_else(|| obj.get("uri"))
                    .and_then(Value::as_str)
                {
                    if let Some(e) = parse_otpauth_uri_line(uri)? {
                        entries.push(e);
                        continue;
                    }
                }
                if let Some(secret) = obj.get("secret").and_then(Value::as_str) {
                    let issuer = obj
                        .get("issuer")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let account = obj
                        .get("account")
                        .or_else(|| obj.get("name"))
                        .or_else(|| obj.get("username"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let digits = obj
                        .get("digits")
                        .and_then(|v| {
                            v.as_u64()
                                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                        })
                        .unwrap_or(6) as u32;
                    let period = obj
                        .get("period")
                        .or_else(|| obj.get("timer"))
                        .and_then(|v| {
                            v.as_u64()
                                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                        })
                        .unwrap_or(30);
                    let alg = parse_algorithm_str(
                        obj.get("algorithm")
                            .or_else(|| obj.get("algo"))
                            .and_then(Value::as_str),
                    );
                    entries.push(build_entry(secret, issuer, account, digits, period, alg)?);
                }
            }
        }
        if entries.is_empty() {
            return Err("No TOTP entries found in JSON authenticator export".to_string());
        }
        return Ok(entries);
    }

    Err("Unrecognized JSON authenticator export format".to_string())
}

/// Auto-detects whether an import payload is a password CSV or a 2FA authenticator export.
pub fn detect_import_format(text: &str) -> ImportFormat {
    let cleaned = text.trim_start_matches('\u{FEFF}').trim();
    if cleaned.starts_with('{') || cleaned.starts_with('[') {
        return ImportFormat::Totp;
    }

    for raw_line in cleaned.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("otpauth://") || lower.starts_with("otpauth-migration://") {
            return ImportFormat::Totp;
        }
        break;
    }

    ImportFormat::Csv
}

/// Parses authenticator 2FA exports:
/// - `otpauth://totp/...` URIs (one per line; blank and `#`/`//` comment lines ignored)
/// - Google Authenticator `otpauth-migration://offline?data=<base64 protobuf>` URIs
/// - Aegis plain JSON, 2FAS JSON, or JSON arrays of TOTP entries
pub fn parse_authenticator_export(text: &str) -> Result<Vec<TotpImportEntry>, String> {
    let cleaned = text.trim_start_matches('\u{FEFF}').trim();
    if cleaned.is_empty() {
        return Err("Authenticator export is empty".to_string());
    }

    if cleaned.starts_with('{') || cleaned.starts_with('[') {
        return parse_json_authenticator_export(cleaned);
    }

    let mut entries = Vec::new();
    for (idx, raw_line) in cleaned.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("otpauth-migration://") {
            let batch = parse_otpauth_migration_uri(line)
                .map_err(|e| format!("Line {}: {e}", idx + 1))?;
            entries.extend(batch);
        } else if lower.starts_with("otpauth://") {
            if let Some(entry) =
                parse_otpauth_uri_line(line).map_err(|e| format!("Line {}: {e}", idx + 1))?
            {
                entries.push(entry);
            }
        } else {
            return Err(format!(
                "Line {}: expected otpauth:// or otpauth-migration:// URI",
                idx + 1
            ));
        }
    }

    if entries.is_empty() {
        return Err("No valid TOTP entries found in authenticator export".to_string());
    }

    Ok(entries)
}

fn extract_normalized_totp_secret(totp_field: &str) -> Option<String> {
    parse_otp_input(totp_field).ok().map(|cfg| cfg.secret)
}

/// Checks whether an item's existing `totp` field shares the exact same Base32 secret.
pub fn has_same_totp_secret(existing_totp: Option<&str>, secret_b32: &str) -> bool {
    let target = match clean_base32_secret(secret_b32) {
        Ok(s) => s,
        Err(_) => return false,
    };
    existing_totp
        .and_then(extract_normalized_totp_secret)
        .is_some_and(|existing| existing == target)
}

fn primary_domain_label(reg_domain: &str) -> &str {
    reg_domain.split('.').next().unwrap_or(reg_domain)
}

fn compact_alnum_lower(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Checks whether a TOTP `issuer` matches an existing item's title or URL registrable domain
/// (case-insensitive).
pub fn totp_issuer_matches_item(issuer: &str, item: &VaultItemPayload) -> bool {
    let iss_trimmed = issuer.trim();
    if iss_trimmed.is_empty() {
        return false;
    }
    let iss_lower = iss_trimmed.to_lowercase();
    let iss_looks_like_domain = iss_lower.contains('.') && !iss_lower.contains(' ');
    let iss_reg = if iss_looks_like_domain {
        extract_registrable_domain(&iss_lower)
    } else {
        String::new()
    };
    let iss_label = if !iss_reg.is_empty() {
        primary_domain_label(&iss_reg).to_string()
    } else {
        iss_lower.clone()
    };
    let iss_compact = compact_alnum_lower(iss_trimmed);

    // 1. Check item title
    let title_trimmed = item.title.trim();
    if !title_trimmed.is_empty() {
        let title_lower = title_trimmed.to_lowercase();
        if title_lower == iss_lower {
            return true;
        }
        if !iss_compact.is_empty() && iss_compact.len() >= 2 && compact_alnum_lower(title_trimmed) == iss_compact {
            return true;
        }
        if title_lower.contains('.') && !title_lower.contains(' ') {
            let title_reg = extract_registrable_domain(&title_lower);
            if !title_reg.is_empty() {
                if !iss_reg.is_empty() && title_reg == iss_reg {
                    return true;
                }
                if primary_domain_label(&title_reg) == iss_label {
                    return true;
                }
            }
        } else if !iss_reg.is_empty() && title_lower == iss_label {
            return true;
        }
    }

    // 2. Check item URLs registrable domain
    for url in &item.urls {
        let url_reg = extract_registrable_domain(url);
        if url_reg.is_empty() {
            continue;
        }
        if !iss_reg.is_empty() && url_reg == iss_reg {
            return true;
        }
        let url_label = primary_domain_label(&url_reg);
        if url_label == iss_label {
            return true;
        }
        if iss_compact.len() >= 3 && url_label == iss_compact {
            return true;
        }
    }

    false
}

fn find_matching_item_index(
    items: &[VaultItemPayload],
    entry: &TotpImportEntry,
    already_attached_ids: &HashSet<String>,
) -> Option<usize> {
    let issuer = entry.issuer.as_deref()?.trim();
    if issuer.is_empty() {
        return None;
    }
    let account_opt = entry.account.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let matches_candidate = |item: &VaultItemPayload, require_empty_totp: bool| -> bool {
        if item.category != ItemCategory::Login {
            return false;
        }
        if already_attached_ids.contains(&item.id) {
            return false;
        }
        if require_empty_totp && item.totp.as_deref().is_some_and(|t| !t.trim().is_empty()) {
            return false;
        }
        if !totp_issuer_matches_item(issuer, item) {
            return false;
        }
        if let Some(acc) = account_opt {
            let user = match item.username.as_deref() {
                Some(u) if !u.trim().is_empty() => u.trim(),
                _ => return false,
            };
            if !user.eq_ignore_ascii_case(acc) {
                return false;
            }
        }
        true
    };

    // Prefer exact username case match without existing TOTP first, then case-insensitive without existing TOTP
    if let Some(acc) = account_opt {
        if let Some(idx) = items.iter().position(|it| {
            matches_candidate(it, true)
                && it.username.as_deref().is_some_and(|u| u.trim() == acc)
        }) {
            return Some(idx);
        }
    }
    items.iter().position(|it| matches_candidate(it, true))
}

/// Evaluates how a single `TotpImportEntry` applies to `existing_items` in the target vault:
/// - Skips if any item in `existing_items` already has the same Base32 TOTP secret.
/// - Attaches to an existing `login` item whose title/URL registrable domain matches `issuer`
///   (case-insensitive) and (when `account` is set) `username == account`.
/// - Otherwise creates a new `login` item `{ title: issuer || account, username: account, totp: otpauthUri }`.
pub fn totp_import_match(
    existing_items: &[VaultItemPayload],
    entry: &TotpImportEntry,
) -> TotpImportAction {
    if let Some(dup) = existing_items
        .iter()
        .find(|it| has_same_totp_secret(it.totp.as_deref(), &entry.secret))
    {
        return TotpImportAction::SkipDuplicate {
            existing_item_id: Some(dup.id.clone()),
        };
    }

    let empty_set = HashSet::new();
    if let Some(idx) = find_matching_item_index(existing_items, entry, &empty_set) {
        return TotpImportAction::Attach {
            item_id: existing_items[idx].id.clone(),
            otpauth_uri: entry.otpauth_uri.clone(),
        };
    }

    let title = entry
        .issuer
        .as_deref()
        .and_then(trim_non_empty)
        .or_else(|| entry.account.as_deref().and_then(trim_non_empty))
        .unwrap_or_else(|| "Imported TOTP".to_string());

    TotpImportAction::Create {
        title,
        username: entry.account.as_deref().and_then(trim_non_empty),
        totp: entry.otpauth_uri.clone(),
    }
}

/// Plans a full batch of `TotpImportEntry` items against `existing_items` in a target vault,
/// tracking newly attached items and duplicate secrets across the batch itself.
pub fn plan_totp_import(
    existing_items: &[VaultItemPayload],
    entries: &[TotpImportEntry],
) -> Vec<TotpImportPlanItem> {
    let mut seen_secrets: HashSet<String> = HashSet::new();
    let mut secret_to_item_id = std::collections::HashMap::<String, String>::new();

    for item in existing_items {
        if let Some(totp_raw) = item.totp.as_deref() {
            if let Some(sec) = extract_normalized_totp_secret(totp_raw) {
                seen_secrets.insert(sec.clone());
                secret_to_item_id.entry(sec).or_insert_with(|| item.id.clone());
            }
        }
    }

    let mut attached_item_ids: HashSet<String> = HashSet::new();
    let mut plan = Vec::with_capacity(entries.len());

    for entry in entries {
        if !seen_secrets.insert(entry.secret.clone()) {
            plan.push(TotpImportPlanItem {
                entry: entry.clone(),
                decision: TotpImportAction::SkipDuplicate {
                    existing_item_id: secret_to_item_id.get(&entry.secret).cloned(),
                },
            });
            continue;
        }

        if let Some(idx) = find_matching_item_index(existing_items, entry, &attached_item_ids) {
            let item_id = existing_items[idx].id.clone();
            attached_item_ids.insert(item_id.clone());
            secret_to_item_id.insert(entry.secret.clone(), item_id.clone());
            plan.push(TotpImportPlanItem {
                entry: entry.clone(),
                decision: TotpImportAction::Attach {
                    item_id,
                    otpauth_uri: entry.otpauth_uri.clone(),
                },
            });
        } else {
            let title = entry
                .issuer
                .as_deref()
                .and_then(trim_non_empty)
                .or_else(|| entry.account.as_deref().and_then(trim_non_empty))
                .unwrap_or_else(|| "Imported TOTP".to_string());
            plan.push(TotpImportPlanItem {
                entry: entry.clone(),
                decision: TotpImportAction::Create {
                    title,
                    username: entry.account.as_deref().and_then(trim_non_empty),
                    totp: entry.otpauth_uri.clone(),
                },
            });
        }
    }

    plan
}
