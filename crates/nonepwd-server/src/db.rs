use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use nonepwd_core::encoding::{from_base64_url, to_base64_url};
use nonepwd_core::random::{fill_random, random_id};
use regex::RegexBuilder;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::auth::now_iso_millis;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmailFilterMode {
    Allow,
    Deny,
}

fn default_filter_mode() -> EmailFilterMode {
    EmailFilterMode::Allow
}

fn default_true() -> bool {
    true
}

fn default_rule_id() -> String {
    random_id().unwrap_or_else(|_| "rule_default".to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmailFilterField {
    From,
    To,
    Subject,
    Body,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailFilterRule {
    #[serde(default = "default_rule_id")]
    pub id: String,
    pub field: EmailFilterField,
    pub pattern: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailFilterConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub otp_only: bool,
    #[serde(default = "default_filter_mode")]
    pub mode: EmailFilterMode,
    #[serde(default)]
    pub rules: Vec<EmailFilterRule>,
}

impl Default for EmailFilterConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            otp_only: false,
            mode: EmailFilterMode::Allow,
            rules: Vec::new(),
        }
    }
}

pub fn validate_and_normalize_email_filter(mut cfg: EmailFilterConfig) -> Result<EmailFilterConfig, String> {
    for rule in &mut cfg.rules {
        if rule.id.trim().is_empty() {
            rule.id = default_rule_id();
        }
        if rule.pattern.trim().is_empty() {
            return Err("Email filter rule pattern must not be empty".to_string());
        }
        RegexBuilder::new(&rule.pattern)
            .size_limit(1 << 20)
            .build()
            .map_err(|e| format!("Invalid regex pattern \"{}\": {e}", rule.pattern))?;
    }
    Ok(cfg)
}

fn load_or_create_server_key(data_dir: &Path) -> Result<[u8; 32], String> {
    let key_path = data_dir.join(".server_key");
    if key_path.exists() {
        if let Ok(raw) = fs::read_to_string(&key_path) {
            if let Ok(buf) = from_base64_url(raw.trim()) {
                if buf.len() == 32 {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&buf);
                    return Ok(arr);
                }
            }
        }
    }

    let mut generated = [0u8; 32];
    fill_random(&mut generated)?;
    let encoded = to_base64_url(&generated);
    fs::write(&key_path, encoded.as_bytes())
        .map_err(|e| format!("Failed writing {}: {e}", key_path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600));
    }

    Ok(generated)
}

pub fn encrypt_local_secret_with_key(server_key: &[u8; 32], plaintext: &str) -> String {
    if plaintext.is_empty() {
        return String::new();
    }
    let mut iv = [0u8; 12];
    if fill_random(&mut iv).is_err() {
        return String::new();
    }
    encrypt_local_secret_with_key_and_iv(server_key, &iv, plaintext)
}

pub fn encrypt_local_secret_with_key_and_iv(
    server_key: &[u8; 32],
    iv: &[u8; 12],
    plaintext: &str,
) -> String {
    if plaintext.is_empty() {
        return String::new();
    }
    let Ok(cipher) = Aes256Gcm::new_from_slice(server_key) else {
        return String::new();
    };
    let Ok(ct_with_tag) = cipher.encrypt(Nonce::from_slice(iv), plaintext.as_bytes()) else {
        return String::new();
    };
    if ct_with_tag.len() < 16 {
        return String::new();
    }
    let split_at = ct_with_tag.len() - 16;
    let enc = &ct_with_tag[..split_at];
    let tag = &ct_with_tag[split_at..];
    format!(
        "s1.{}.{}.{}",
        to_base64_url(iv),
        to_base64_url(tag),
        to_base64_url(enc)
    )
}

pub fn decrypt_local_secret_with_key(server_key: &[u8; 32], blob: &str) -> String {
    if blob.is_empty() {
        return String::new();
    }
    let parts: Vec<&str> = blob.split('.').collect();
    if parts.len() != 4 || parts[0] != "s1" {
        return String::new();
    }
    let Ok(iv) = from_base64_url(parts[1]) else {
        return String::new();
    };
    if iv.len() != 12 {
        return String::new();
    }
    let Ok(tag) = from_base64_url(parts[2]) else {
        return String::new();
    };
    if tag.len() != 16 {
        return String::new();
    }
    let Ok(mut enc) = from_base64_url(parts[3]) else {
        return String::new();
    };
    enc.extend_from_slice(&tag);

    let Ok(cipher) = Aes256Gcm::new_from_slice(server_key) else {
        return String::new();
    };
    let Ok(plain) = cipher.decrypt(Nonce::from_slice(&iv), enc.as_slice()) else {
        return String::new();
    };
    String::from_utf8(plain).unwrap_or_default()
}

pub struct NonePwdDb {
    conn: Mutex<Connection>,
    pub data_dir: PathBuf,
    server_key: [u8; 32],
}

impl NonePwdDb {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let data_dir = data_dir.as_ref().to_path_buf();
        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed creating data directory {}: {e}", data_dir.display()))?;

        let server_key = load_or_create_server_key(&data_dir)?;
        let db_path = data_dir.join("nonepwd.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed opening SQLite database {}: {e}", db_path.display()))?;

        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS account (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              email TEXT NOT NULL,
              kdf_salt TEXT NOT NULL,
              kdf_iterations INTEGER NOT NULL,
              auth_verifier_hash TEXT NOT NULL,
              encrypted_root_keyset TEXT NOT NULL,
              email_public_key TEXT NOT NULL,
              cf_webhook_secret TEXT NOT NULL,
              alias_domain TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
              token_hash TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              service_account_id TEXT,
              created_at TEXT NOT NULL,
              expires_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS vaults (
              id TEXT PRIMARY KEY,
              encrypted_key TEXT NOT NULL,
              encrypted_meta TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS items (
              id TEXT PRIMARY KEY,
              vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
              encrypted_data TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              version INTEGER NOT NULL DEFAULT 1
            );

            CREATE INDEX IF NOT EXISTS idx_items_vault_id ON items(vault_id);

            CREATE TABLE IF NOT EXISTS service_accounts (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              auth_secret_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              last_used_at TEXT
            );

            CREATE TABLE IF NOT EXISTS service_account_vaults (
              service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
              vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
              encrypted_vault_key TEXT NOT NULL,
              PRIMARY KEY (service_account_id, vault_id)
            );

            CREATE TABLE IF NOT EXISTS aliases (
              id TEXT PRIMARY KEY,
              address TEXT NOT NULL UNIQUE,
              site_domain TEXT,
              vault_id TEXT,
              item_id TEXT,
              enabled INTEGER NOT NULL DEFAULT 1,
              received_count INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS encrypted_emails (
              id TEXT PRIMARY KEY,
              source TEXT NOT NULL,
              envelope_to TEXT,
              has_otp INTEGER NOT NULL DEFAULT 0,
              sealed_envelope TEXT NOT NULL,
              received_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_emails_received_at ON encrypted_emails(received_at DESC);

            CREATE TABLE IF NOT EXISTS imap_config (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              enabled INTEGER NOT NULL DEFAULT 0,
              host TEXT NOT NULL DEFAULT '',
              port INTEGER NOT NULL DEFAULT 993,
              tls INTEGER NOT NULL DEFAULT 1,
              username TEXT NOT NULL DEFAULT '',
              password_enc TEXT NOT NULL DEFAULT '',
              last_uid INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'disabled',
              last_error TEXT,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS email_filter (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              config_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            ",
        )
        .map_err(|e| format!("Failed initializing SQLite schema: {e}"))?;

        let now = now_iso_millis();
        conn.execute(
            "INSERT OR IGNORE INTO imap_config
             (id, enabled, host, port, tls, username, password_enc, last_uid, status, last_error, updated_at)
             VALUES (1, 0, '', 993, 1, '', '', 0, 'disabled', NULL, ?1)",
            params![now],
        )
        .map_err(|e| format!("Failed seeding imap_config: {e}"))?;

        let default_filter_json = serde_json::to_string(&EmailFilterConfig::default())
            .unwrap_or_else(|_| "{\"enabled\":false,\"otpOnly\":false,\"mode\":\"allow\",\"rules\":[]}".to_string());
        conn.execute(
            "INSERT OR IGNORE INTO email_filter (id, config_json, updated_at) VALUES (1, ?1, ?2)",
            params![default_filter_json, now],
        )
        .map_err(|e| format!("Failed seeding email_filter: {e}"))?;

        Ok(Self {
            conn: Mutex::new(conn),
            data_dir,
            server_key,
        })
    }

    pub fn lock_conn(&self) -> MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn encrypt_local_secret(&self, plaintext: &str) -> String {
        encrypt_local_secret_with_key(&self.server_key, plaintext)
    }

    pub fn decrypt_local_secret(&self, blob: &str) -> String {
        decrypt_local_secret_with_key(&self.server_key, blob)
    }

    pub fn get_email_filter(&self) -> EmailFilterConfig {
        let conn = self.lock_conn();
        let raw: Option<String> = conn
            .query_row(
                "SELECT config_json FROM email_filter WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();

        match raw {
            Some(json_str) => serde_json::from_str(&json_str).unwrap_or_default(),
            None => EmailFilterConfig::default(),
        }
    }

    pub fn save_email_filter(&self, cfg: EmailFilterConfig) -> Result<EmailFilterConfig, String> {
        let validated = validate_and_normalize_email_filter(cfg)?;
        let json_str = serde_json::to_string(&validated)
            .map_err(|e| format!("Failed serializing email filter: {e}"))?;
        let now = now_iso_millis();
        let conn = self.lock_conn();
        conn.execute(
            "INSERT INTO email_filter (id, config_json, updated_at)
             VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at",
            params![json_str, now],
        )
        .map_err(|e| format!("Failed saving email filter: {e}"))?;
        Ok(validated)
    }
}
