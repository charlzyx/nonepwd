use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::types::VaultItemPayload;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSecretRef {
    pub raw: String,
    pub vault: String,
    pub item: String,
    pub field: String,
    pub params: HashMap<String, String>,
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
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

pub fn parse_secret_ref(uri: &str) -> Result<ParsedSecretRef, String> {
    let trimmed = uri.trim();
    let rest = trimmed
        .strip_prefix("np://")
        .or_else(|| trimmed.strip_prefix("op://"))
        .ok_or_else(|| format!("Invalid secret reference (must start with np:// or op://): {uri}"))?;

    let (path_part, query_part) = match rest.split_once('?') {
        Some((p, q)) => (p, q),
        None => (rest, ""),
    };

    let segments: Vec<String> = path_part
        .split('/')
        .map(|s| percent_decode(s).trim().to_string())
        .collect();

    if segments.len() < 3
        || segments.iter().any(|s| s.is_empty())
    {
        return Err(format!(
            "Invalid secret reference \"{uri}\". Expected np://<vault>/<item>/<field> (or op://...)"
        ));
    }

    let mut params = HashMap::new();
    if !query_part.is_empty() {
        for pair in query_part.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            params.insert(percent_decode(k), percent_decode(v));
        }
    }

    let field = if segments.len() >= 4 {
        let section = segments[2..segments.len() - 1].join("/");
        params.entry("section".to_string()).or_insert(section);
        segments.last().cloned().unwrap_or_default()
    } else {
        segments[2].clone()
    };

    Ok(ParsedSecretRef {
        raw: trimmed.to_string(),
        vault: segments[0].clone(),
        item: segments[1].clone(),
        field,
        params,
    })
}

pub fn resolve_item_field(item: &VaultItemPayload, field_name: &str) -> Option<String> {
    let key = field_name.trim().to_lowercase();
    match key.as_str() {
        "username" | "user" => item.username.clone().or_else(|| item.email_alias.clone()),
        "email" => item
            .username
            .clone()
            .or_else(|| item.email_alias.clone())
            .or_else(|| item.identity.as_ref().and_then(|id| id.email.clone())),
        "password" | "pass" | "secret" => item.password.clone(),
        "totp" | "otp" | "2fa" => item.totp.clone(),
        "url" | "website" => item.urls.first().cloned(),
        "notes" | "note" => item.notes.clone(),
        "alias" | "email_alias" | "emailalias" => item.email_alias.clone(),
        "title" => Some(item.title.clone()),
        _ => {
            let norm_key: String = key
                .chars()
                .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
                .collect();
            if let Some(card) = &item.card {
                let card_val = match norm_key.as_str() {
                    "cardholdername" | "cardholder" => card.cardholder_name.clone(),
                    "number" | "cardnumber" => card.number.clone(),
                    "expmonth" => card.exp_month.clone(),
                    "expyear" => card.exp_year.clone(),
                    "cvv" | "cvc" | "csc" => card.cvv.clone(),
                    "brand" => card.brand.clone(),
                    _ => None,
                };
                if card_val.is_some() {
                    return card_val;
                }
            }
            if let Some(ident) = &item.identity {
                let id_val = match norm_key.as_str() {
                    "fullname" | "name" => ident.full_name.clone(),
                    "firstname" | "givenname" => ident.first_name.clone(),
                    "lastname" | "familyname" => ident.last_name.clone(),
                    "phone" | "tel" => ident.phone.clone(),
                    "company" | "organization" => ident.company.clone(),
                    "address1" | "streetaddress" => ident.address1.clone(),
                    "address2" => ident.address2.clone(),
                    "city" => ident.city.clone(),
                    "state" | "province" => ident.state.clone(),
                    "postalcode" | "zip" | "zipcode" => ident.postal_code.clone(),
                    "country" => ident.country.clone(),
                    _ => None,
                };
                if id_val.is_some() {
                    return id_val;
                }
            }
            if let Some(cf) = item
                .custom_fields
                .iter()
                .find(|cf| {
                    let lbl = cf.label.trim().to_lowercase();
                    let id = cf.id.trim().to_lowercase();
                    let norm_lbl: String = lbl
                        .chars()
                        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
                        .collect();
                    lbl == key || id == key || norm_lbl == norm_key
                })
                .map(|cf| cf.value.clone())
            {
                return Some(cf);
            }
            match norm_key.as_str() {
                "credential" | "apikey" | "token" | "privatekey" | "sshkey" => {
                    item.password.clone()
                }
                _ => None,
            }
        }
    }
}

pub fn find_secret_refs(template: &str) -> Vec<String> {
    static REF_RE: OnceLock<Regex> = OnceLock::new();
    let re = REF_RE
        .get_or_init(|| Regex::new(r#"\{\{\s*((?:np|op)://[^\s{}]+)\s*\}\}|((?:np|op)://[^\s"'`<>|;]+)"#).unwrap());
    let mut out = Vec::new();
    for cap in re.captures_iter(template) {
        if let Some(m) = cap.get(1).or_else(|| cap.get(2)) {
            let s = m.as_str().to_string();
            if !out.contains(&s) {
                out.push(s);
            }
        }
    }
    out
}

pub fn replace_secret_refs(template: &str, resolved: &HashMap<String, String>) -> String {
    static REF_RE: OnceLock<Regex> = OnceLock::new();
    let re = REF_RE
        .get_or_init(|| Regex::new(r#"\{\{\s*((?:np|op)://[^\s{}]+)\s*\}\}|((?:np|op)://[^\s"'`<>|;]+)"#).unwrap());
    re.replace_all(template, |caps: &regex::Captures| {
        let key = caps
            .get(1)
            .or_else(|| caps.get(2))
            .map(|m| m.as_str())
            .unwrap_or("");
        resolved.get(key).cloned().unwrap_or_default()
    })
    .into_owned()
}

pub fn parse_dot_env(content: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let stripped = line.strip_prefix("export ").map(|s| s.trim()).unwrap_or(line);
        if let Some((k, v)) = stripped.split_once('=') {
            let key = k.trim();
            if key.is_empty() {
                continue;
            }
            let mut val = v.trim().to_string();
            if (val.starts_with('"') && val.ends_with('"') && val.len() >= 2)
                || (val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2)
            {
                val = val[1..val.len() - 1].to_string();
            }
            env.insert(key.to_string(), val);
        }
    }
    env
}
