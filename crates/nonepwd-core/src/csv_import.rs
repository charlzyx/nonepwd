use serde::{Deserialize, Serialize};

use crate::otp_extractor::{extract_host, extract_registrable_domain};
use crate::types::ItemCategory;

/// Parsed credential entry ready for encryption into a `VaultItemPayload`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportedEntry {
    pub category: ItemCategory,
    pub title: String,
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub totp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Stable deduplication key combining normalized URL, trimmed username, and exact password.
pub fn item_import_fingerprint(
    first_url: Option<&str>,
    username: Option<&str>,
    password: Option<&str>,
) -> String {
    let url_norm = first_url
        .unwrap_or("")
        .trim()
        .trim_end_matches('/')
        .to_ascii_lowercase();
    let user_norm = username.unwrap_or("").trim();
    let pass = password.unwrap_or("");
    format!("{url_norm}\0{user_norm}\0{pass}")
}

fn parse_rfc4180_rows(input: &str) -> Result<Vec<Vec<String>>, String> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut current_row: Vec<String> = Vec::new();
    let mut current_field = String::new();
    let mut in_quotes = false;
    let mut at_field_start = true;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    current_field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                current_field.push(ch);
            }
            continue;
        }

        if at_field_start && ch == '"' {
            in_quotes = true;
            at_field_start = false;
            continue;
        }

        match ch {
            ',' => {
                current_row.push(std::mem::take(&mut current_field));
                at_field_start = true;
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                current_row.push(std::mem::take(&mut current_field));
                rows.push(std::mem::take(&mut current_row));
                at_field_start = true;
            }
            '\n' => {
                current_row.push(std::mem::take(&mut current_field));
                rows.push(std::mem::take(&mut current_row));
                at_field_start = true;
            }
            _ => {
                current_field.push(ch);
                at_field_start = false;
            }
        }
    }

    if in_quotes {
        return Err("Invalid CSV format: unclosed quoted field".into());
    }

    if !at_field_start || !current_field.is_empty() || !current_row.is_empty() {
        current_row.push(current_field);
        rows.push(current_row);
    }

    Ok(rows)
}

#[derive(Default)]
struct ColumnMap {
    title: Option<usize>,
    url: Option<usize>,
    username: Option<usize>,
    password: Option<usize>,
    notes: Option<usize>,
    totp: Option<usize>,
}

fn match_header_columns(header: &[String]) -> ColumnMap {
    let mut map = ColumnMap::default();
    for (idx, raw) in header.iter().enumerate() {
        let key = raw.trim().trim_matches('\u{FEFF}').to_ascii_lowercase();
        match key.as_str() {
            "name" | "title" | "account" | "service" | "website name" | "名称" | "标题" => {
                if map.title.is_none() {
                    map.title = Some(idx);
                }
            }
            "url" | "urls" | "website" | "login_uri" | "origin" | "signon_realm"
            | "formactionorigin" | "网址" | "网站" | "链接" => {
                if map.url.is_none() {
                    map.url = Some(idx);
                }
            }
            "username" | "user" | "login_username" | "email" | "login" | "用户名" | "账号"
            | "邮箱" => {
                if map.username.is_none() {
                    map.username = Some(idx);
                }
            }
            "password" | "pass" | "login_password" | "密码" | "口令" => {
                if map.password.is_none() {
                    map.password = Some(idx);
                }
            }
            "note" | "notes" | "comment" | "comments" | "extra" | "description" | "备注"
            | "说明" | "笔记" => {
                if map.notes.is_none() {
                    map.notes = Some(idx);
                }
            }
            "totp" | "otp" | "otpauth" | "login_totp" | "one-time password"
            | "authenticator key" | "验证码密钥" | "动态口令" => {
                if map.totp.is_none() {
                    map.totp = Some(idx);
                }
            }
            _ => {}
        }
    }
    map
}

fn opt_trimmed(row: &[String], idx: Option<usize>) -> Option<String> {
    let raw = idx.and_then(|i| row.get(i))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn opt_non_empty_exact(row: &[String], idx: Option<usize>) -> Option<String> {
    let raw = idx.and_then(|i| row.get(i))?;
    if raw.is_empty() {
        None
    } else {
        Some(raw.clone())
    }
}

fn derive_title(
    raw_title: Option<String>,
    url: Option<&str>,
    username: Option<&str>,
) -> String {
    if let Some(t) = raw_title {
        return t;
    }
    if let Some(u) = url {
        let reg = extract_registrable_domain(u);
        if !reg.is_empty() {
            return reg;
        }
        let host = extract_host(u);
        if !host.is_empty() {
            return host;
        }
        return u.to_string();
    }
    if let Some(user) = username {
        return user.to_string();
    }
    "Imported Login".to_string()
}

/// Parses Brave/Chrome/Edge/Arc/Safari/Bitwarden/1Password RFC 4180 password CSV exports.
pub fn parse_password_csv(csv_text: &str) -> Result<Vec<CsvImportedEntry>, String> {
    let clean_input = csv_text.trim_start_matches('\u{FEFF}');
    let rows = parse_rfc4180_rows(clean_input)?;

    let mut non_empty_rows = rows
        .into_iter()
        .filter(|r| r.iter().any(|cell| !cell.trim().is_empty()));

    let header = non_empty_rows
        .next()
        .ok_or_else(|| "CSV 文件为空".to_string())?;
    let cols = match_header_columns(&header);

    if cols.url.is_none() && cols.username.is_none() && cols.password.is_none() {
        return Err(
            "CSV 表头未识别：请确认包含 url/username/password（或 网址/用户名/密码）列".into(),
        );
    }

    let mut entries = Vec::new();
    for row in non_empty_rows {
        let raw_title = opt_trimmed(&row, cols.title);
        let url = opt_trimmed(&row, cols.url);
        let username = opt_trimmed(&row, cols.username);
        let password = opt_non_empty_exact(&row, cols.password);
        let notes = opt_trimmed(&row, cols.notes);
        let totp = opt_trimmed(&row, cols.totp);

        if url.is_none()
            && username.is_none()
            && password.is_none()
            && totp.is_none()
            && notes.is_none()
        {
            continue;
        }

        let category = if url.is_none()
            && username.is_none()
            && password.is_none()
            && totp.is_none()
            && notes.is_some()
        {
            ItemCategory::SecureNote
        } else {
            ItemCategory::Login
        };

        let title = derive_title(raw_title, url.as_deref(), username.as_deref());
        entries.push(CsvImportedEntry {
            category,
            title,
            urls: url.into_iter().collect(),
            username,
            password,
            totp,
            notes,
        });
    }

    Ok(entries)
}
