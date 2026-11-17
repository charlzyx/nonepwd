use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use chrono::{Datelike, Utc};
use nonepwd_core::random::random_id;
use rusqlite::{params, Connection, OptionalExtension};
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf,
};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

use crate::auth::now_iso_millis;
use crate::db::{derive_imap_label, ensure_legacy_imap_migrated_conn, NonePwdDb};
use crate::email_ingest::ingest_raw_email;
use crate::ws::{BroadcastOptions, WsHub};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImapConfigPublic {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub username: String,
    pub has_password: bool,
    pub status: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImapAccountPublic {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub username: String,
    pub has_password: bool,
    pub status: String,
    pub last_error: Option<String>,
    pub last_sync_at: Option<String>,
}

#[derive(Debug, Clone)]
struct ImapAccountRow {
    id: String,
    label: String,
    enabled: bool,
    host: String,
    port: u16,
    tls: bool,
    username: String,
    password_enc: String,
    last_uid: u32,
    status: String,
    last_error: Option<String>,
    last_sync_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImapTestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct SaveImapAccountInput {
    pub id: Option<String>,
    pub label: Option<String>,
    pub enabled: Option<bool>,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub tls: Option<bool>,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveImapMode {
    CreateOrUpsert,
    UpdateStrict,
    LegacyPut,
}

#[derive(Debug)]
pub enum SaveImapError {
    BadRequest(String),
    NotFound(String),
    Internal(String),
}

pub struct SavedImapAccountMeta {
    pub id: Option<String>,
    pub created: bool,
    pub enabled: bool,
}

pub struct ImapTestInput {
    pub id: Option<String>,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub tls: Option<bool>,
    pub username: Option<String>,
    pub password: Option<String>,
}

enum ImapIo {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl AsyncRead for ImapIo {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapIo::Plain(s) => Pin::new(s).poll_read(cx, buf),
            ImapIo::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for ImapIo {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            ImapIo::Plain(s) => Pin::new(s).poll_write(cx, buf),
            ImapIo::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapIo::Plain(s) => Pin::new(s).poll_flush(cx),
            ImapIo::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapIo::Plain(s) => Pin::new(s).poll_shutdown(cx),
            ImapIo::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

fn imap_tls_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut root_store = RootCertStore::empty();
            root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let provider = Arc::new(rustls_rustcrypto::provider());
            let cfg = ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .expect("valid TLS protocol versions")
                .with_root_certificates(root_store)
                .with_no_client_auth();
            Arc::new(cfg)
        })
        .clone()
}

fn imap_quote_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    out.push('"');
    for ch in s.chars() {
        if ch == '\\' || ch == '"' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

fn parse_literal_len(line: &str) -> Option<usize> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let close = trimmed.strip_suffix('}')?;
    let open = close.rfind('{')?;
    let digits = close[open + 1..].trim_end_matches('+');
    digits.parse::<usize>().ok()
}

struct ImapClient {
    reader: BufReader<ImapIo>,
    tag_seq: u32,
}

impl ImapClient {
    async fn connect(host: &str, port: u16, tls: bool) -> Result<Self, String> {
        let addr = format!("{host}:{port}");
        let tcp = TcpStream::connect(&addr)
            .await
            .map_err(|e| format!("IMAP TCP connect to {addr} failed: {e}"))?;
        let _ = tcp.set_nodelay(true);

        let io = if tls {
            let server_name = ServerName::try_from(host.to_string())
                .map_err(|e| format!("Invalid IMAP TLS server name \"{host}\": {e}"))?;
            let connector = TlsConnector::from(imap_tls_config());
            let tls_stream = connector
                .connect(server_name, tcp)
                .await
                .map_err(|e| format!("IMAP TLS handshake failed: {e}"))?;
            ImapIo::Tls(Box::new(tls_stream))
        } else {
            ImapIo::Plain(tcp)
        };

        let mut client = Self {
            reader: BufReader::new(io),
            tag_seq: 1,
        };

        let mut greeting = String::new();
        let n = client
            .reader
            .read_line(&mut greeting)
            .await
            .map_err(|e| format!("Failed reading IMAP greeting: {e}"))?;
        if n == 0 {
            return Err("IMAP server closed connection before greeting".to_string());
        }
        if !greeting.trim_start().starts_with("* OK") && !greeting.trim_start().starts_with("* PREAUTH")
        {
            return Err(format!("Unexpected IMAP greeting: {}", greeting.trim()));
        }

        Ok(client)
    }

    fn next_tag(&mut self) -> String {
        let t = format!("A{:04}", self.tag_seq);
        self.tag_seq = self.tag_seq.wrapping_add(1);
        t
    }

    async fn send_raw(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.reader
            .get_mut()
            .write_all(bytes)
            .await
            .map_err(|e| format!("IMAP write failed: {e}"))?;
        self.reader
            .get_mut()
            .flush()
            .await
            .map_err(|e| format!("IMAP flush failed: {e}"))
    }

    async fn run_command(&mut self, cmd_body: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
        let tag = self.next_tag();
        let full = format!("{tag} {cmd_body}\r\n");
        self.send_raw(full.as_bytes()).await?;
        self.read_until_tag(&tag).await
    }

    async fn read_until_tag(&mut self, tag: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
        let mut responses = Vec::new();
        let ok_prefix = format!("{tag} OK");
        let no_prefix = format!("{tag} NO");
        let bad_prefix = format!("{tag} BAD");

        loop {
            let mut line = String::new();
            let n = self
                .reader
                .read_line(&mut line)
                .await
                .map_err(|e| format!("IMAP read failed: {e}"))?;
            if n == 0 {
                return Err("IMAP connection closed unexpectedly".to_string());
            }

            if line.starts_with(&ok_prefix) {
                return Ok(responses);
            }
            if line.starts_with(&no_prefix) || line.starts_with(&bad_prefix) {
                return Err(format!("IMAP command rejected: {}", line.trim()));
            }

            let mut literal = Vec::new();
            while let Some(lit_len) = parse_literal_len(&line) {
                if lit_len > 32 * 1024 * 1024 {
                    return Err("IMAP literal exceeds 32 MiB safety limit".to_string());
                }
                let mut buf = vec![0u8; lit_len];
                self.reader
                    .read_exact(&mut buf)
                    .await
                    .map_err(|e| format!("IMAP literal read failed: {e}"))?;
                literal.extend_from_slice(&buf);

                // Read trailing line after literal (e.g. `)` + `\r\n`)
                line.clear();
                self.reader
                    .read_line(&mut line)
                    .await
                    .map_err(|e| format!("IMAP post-literal read failed: {e}"))?;
            }

            responses.push((line, literal));
        }
    }

    async fn login(&mut self, host: &str, username: &str, password: &str) -> Result<(), String> {
        if username.contains(['\r', '\n']) || password.contains(['\r', '\n']) {
            return Err("IMAP credentials must not contain CR/LF".to_string());
        }
        let cmd = format!(
            "LOGIN {} {}",
            imap_quote_string(username),
            imap_quote_string(password)
        );
        self.run_command(&cmd).await?;

        let lower_host = host.to_ascii_lowercase();
        if lower_host.contains("163.com")
            || lower_host.contains("126.com")
            || lower_host.contains("yeah.net")
        {
            // NetEase mail servers (163/126/yeah.net) require RFC 2971 ID before SELECT/STATUS
            let _ = self
                .run_command(r#"ID ("name" "nonepwd" "version" "0.1.0")"#)
                .await;
        }
        Ok(())
    }

    async fn status_messages(&mut self, mailbox: &str) -> Result<u32, String> {
        let cmd = format!("STATUS {} (MESSAGES)", imap_quote_string(mailbox));
        let lines = self.run_command(&cmd).await?;
        for (line, _) in lines {
            let upper = line.to_ascii_uppercase();
            if let Some(pos) = upper.find("MESSAGES") {
                let after = &upper[pos + "MESSAGES".len()..];
                let digits: String = after
                    .chars()
                    .skip_while(|c| !c.is_ascii_digit())
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                if let Ok(cnt) = digits.parse::<u32>() {
                    return Ok(cnt);
                }
            }
        }
        Ok(0)
    }

    async fn logout(&mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(2), self.run_command("LOGOUT")).await;
    }
}

fn format_imap_date(dt: chrono::DateTime<Utc>) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = MONTHS[(dt.month0() as usize).min(11)];
    format!("{:02}-{}-{}", dt.day(), month, dt.year())
}

pub fn clamp_imap_port(port: Option<i64>, fallback: u16) -> u16 {
    match port {
        Some(p) if (1..=65535).contains(&p) => p as u16,
        Some(_) => 993,
        None => fallback,
    }
}

fn normalize_status(raw: &str, enabled: bool) -> String {
    if !enabled {
        return "disabled".to_string();
    }
    match raw {
        "connecting" | "listening" | "error" => raw.to_string(),
        _ => "listening".to_string(),
    }
}

fn row_to_public(row: &ImapAccountRow) -> ImapAccountPublic {
    ImapAccountPublic {
        id: row.id.clone(),
        label: if row.label.trim().is_empty() {
            derive_imap_label(&row.username)
        } else {
            row.label.clone()
        },
        enabled: row.enabled,
        host: row.host.clone(),
        port: row.port,
        tls: row.tls,
        username: row.username.clone(),
        has_password: !row.password_enc.is_empty(),
        status: normalize_status(&row.status, row.enabled),
        last_error: row.last_error.clone(),
        last_sync_at: row.last_sync_at.clone(),
    }
}

pub fn compute_aggregate_imap_config(accounts: &[ImapAccountPublic]) -> ImapConfigPublic {
    if accounts.is_empty() {
        return ImapConfigPublic {
            enabled: false,
            host: String::new(),
            port: 993,
            tls: true,
            username: String::new(),
            has_password: false,
            status: "disabled".to_string(),
            last_error: None,
        };
    }

    let enabled_accounts: Vec<&ImapAccountPublic> =
        accounts.iter().filter(|a| a.enabled).collect();
    let primary = enabled_accounts.first().copied().unwrap_or(&accounts[0]);
    let any_enabled = !enabled_accounts.is_empty();

    let (status, last_error) = if any_enabled {
        if enabled_accounts.iter().any(|a| a.status == "listening") {
            ("listening".to_string(), None)
        } else if enabled_accounts.iter().any(|a| a.status == "connecting") {
            ("connecting".to_string(), None)
        } else if let Some(errored) = enabled_accounts.iter().find(|a| a.status == "error") {
            ("error".to_string(), errored.last_error.clone())
        } else {
            (primary.status.clone(), primary.last_error.clone())
        }
    } else {
        ("disabled".to_string(), None)
    };

    ImapConfigPublic {
        enabled: any_enabled,
        host: primary.host.clone(),
        port: primary.port,
        tls: primary.tls,
        username: primary.username.clone(),
        has_password: primary.has_password,
        status,
        last_error,
    }
}

fn map_imap_account_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ImapAccountRow> {
    Ok(ImapAccountRow {
        id: r.get(0)?,
        label: r.get(1)?,
        enabled: r.get::<_, i64>(2)? != 0,
        host: r.get(3)?,
        port: r.get::<_, i64>(4)?.clamp(1, 65535) as u16,
        tls: r.get::<_, i64>(5)? != 0,
        username: r.get(6)?,
        password_enc: r.get(7)?,
        last_uid: r.get::<_, i64>(8)?.max(0) as u32,
        status: r.get(9)?,
        last_error: r.get(10)?,
        last_sync_at: r.get(11)?,
    })
}

fn read_imap_account_rows_raw(conn: &Connection) -> Vec<ImapAccountRow> {
    let mut out = Vec::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, label, enabled, host, port, tls, username, password_enc,
                last_uid, status, last_error, last_sync_at
         FROM imap_accounts ORDER BY rowid ASC",
    ) else {
        return out;
    };
    if let Ok(rows) = stmt.query_map([], map_imap_account_row) {
        out.extend(rows.flatten());
    }
    out
}

fn read_imap_account_rows_conn(conn: &Connection) -> Vec<ImapAccountRow> {
    let mut rows = read_imap_account_rows_raw(conn);
    if rows.is_empty() {
        let _ = ensure_legacy_imap_migrated_conn(conn);
        rows = read_imap_account_rows_raw(conn);
    }
    rows
}

fn read_imap_account_by_id_conn(conn: &Connection, id: &str) -> Option<ImapAccountRow> {
    let _ = ensure_legacy_imap_migrated_conn(conn);
    conn.query_row(
        "SELECT id, label, enabled, host, port, tls, username, password_enc,
                last_uid, status, last_error, last_sync_at
         FROM imap_accounts WHERE id = ?1",
        params![id],
        map_imap_account_row,
    )
    .optional()
    .ok()
    .flatten()
}

pub fn list_imap_accounts(db: &NonePwdDb) -> Vec<ImapAccountPublic> {
    let conn = db.lock_conn();
    read_imap_account_rows_conn(&conn)
        .iter()
        .map(row_to_public)
        .collect()
}

pub fn get_imap_account_by_id(db: &NonePwdDb, id: &str) -> Option<ImapAccountPublic> {
    let conn = db.lock_conn();
    read_imap_account_by_id_conn(&conn, id).as_ref().map(row_to_public)
}

fn sync_legacy_imap_config_from_accounts_conn(conn: &Connection) {
    let rows = read_imap_account_rows_raw(conn);

    let now = now_iso_millis();
    if rows.is_empty() {
        let _ = conn.execute(
            "UPDATE imap_config
             SET enabled = 0, host = '', port = 993, tls = 1, username = '', password_enc = '',
                 last_uid = 0, status = 'disabled', last_error = NULL, updated_at = ?1
             WHERE id = 1",
            params![now],
        );
        return;
    }

    let public: Vec<ImapAccountPublic> = rows.iter().map(row_to_public).collect();
    let agg = compute_aggregate_imap_config(&public);
    let primary = rows.iter().find(|r| r.enabled).unwrap_or(&rows[0]);

    let _ = conn.execute(
        "UPDATE imap_config
         SET enabled = ?1, host = ?2, port = ?3, tls = ?4, username = ?5, password_enc = ?6,
             last_uid = ?7, status = ?8, last_error = ?9, updated_at = ?10
         WHERE id = 1",
        params![
            i64::from(agg.enabled),
            primary.host,
            i64::from(primary.port),
            i64::from(primary.tls),
            primary.username,
            primary.password_enc,
            i64::from(primary.last_uid),
            agg.status,
            agg.last_error,
            now,
        ],
    );
}

pub fn save_imap_account_in_db(
    db: &NonePwdDb,
    input: SaveImapAccountInput,
    mode: SaveImapMode,
) -> Result<SavedImapAccountMeta, SaveImapError> {
    let conn = db.lock_conn();
    let rows = read_imap_account_rows_conn(&conn);

    let mut target_id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let existing: Option<&ImapAccountRow> = match mode {
        SaveImapMode::UpdateStrict => {
            let id_str = target_id.as_deref().unwrap_or("");
            let found = rows.iter().find(|r| r.id == id_str);
            if found.is_none() {
                return Err(SaveImapError::NotFound("IMAP account not found".to_string()));
            }
            found
        }
        SaveImapMode::CreateOrUpsert => {
            if let Some(ref id_str) = target_id {
                rows.iter().find(|r| r.id == *id_str)
            } else {
                let gen_id = random_id().map_err(SaveImapError::Internal)?;
                target_id = Some(gen_id);
                None
            }
        }
        SaveImapMode::LegacyPut => {
            let req_user = input
                .username
                .as_deref()
                .map(|s| s.trim().to_ascii_lowercase())
                .unwrap_or_default();
            let by_user = if req_user.is_empty() {
                None
            } else {
                rows.iter()
                    .find(|r| r.username.trim().to_ascii_lowercase() == req_user)
            };
            let chosen = by_user.or_else(|| rows.first());
            target_id = Some(
                chosen
                    .map(|r| r.id.clone())
                    .unwrap_or_else(|| "legacy-1".to_string()),
            );
            chosen
        }
    };

    let target_id = target_id.unwrap_or_else(|| "legacy-1".to_string());
    let next_enabled = input.enabled.unwrap_or_else(|| {
        existing
            .map(|e| e.enabled)
            .unwrap_or(mode != SaveImapMode::LegacyPut)
    });
    let next_host = input
        .host
        .map(|h| h.trim().to_string())
        .unwrap_or_else(|| existing.map(|e| e.host.clone()).unwrap_or_default());
    let next_port = clamp_imap_port(input.port, existing.map(|e| e.port).unwrap_or(993));
    let next_tls = input
        .tls
        .unwrap_or_else(|| existing.map(|e| e.tls).unwrap_or(true));
    let next_username = input
        .username
        .map(|u| u.trim().to_string())
        .unwrap_or_else(|| existing.map(|e| e.username.clone()).unwrap_or_default());

    let next_password_enc = match input.password.filter(|p| !p.trim().is_empty()) {
        Some(pw) => db.encrypt_local_secret(&pw),
        None => existing
            .map(|e| e.password_enc.clone())
            .unwrap_or_default(),
    };

    let now = now_iso_millis();

    if mode == SaveImapMode::LegacyPut
        && existing.is_none()
        && (next_host.is_empty() || next_username.is_empty())
    {
        let _ = conn.execute(
            "UPDATE imap_config
             SET enabled = ?1, host = ?2, port = ?3, tls = ?4, username = ?5, password_enc = ?6,
                 last_uid = 0, status = ?7, last_error = NULL, updated_at = ?8
             WHERE id = 1",
            params![
                i64::from(next_enabled),
                next_host,
                i64::from(next_port),
                i64::from(next_tls),
                next_username,
                next_password_enc,
                if next_enabled { "connecting" } else { "disabled" },
                now,
            ],
        );
        return Ok(SavedImapAccountMeta {
            id: None,
            created: false,
            enabled: next_enabled,
        });
    }

    if next_host.is_empty() || next_username.is_empty() {
        return Err(SaveImapError::BadRequest(
            "Missing host or username".to_string(),
        ));
    }
    if mode == SaveImapMode::CreateOrUpsert && existing.is_none() && next_password_enc.is_empty() {
        return Err(SaveImapError::BadRequest(
            "Password is required for new IMAP account".to_string(),
        ));
    }

    let next_label = match input.label {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                derive_imap_label(&next_username)
            } else {
                trimmed.to_string()
            }
        }
        None => match existing {
            Some(ex) if !ex.label.trim().is_empty() => ex.label.trim().to_string(),
            _ => derive_imap_label(&next_username),
        },
    };

    let endpoint_changed = match existing {
        Some(ex) => {
            next_host != ex.host || next_port != ex.port || next_username != ex.username
        }
        None => true,
    };
    let next_last_uid = if endpoint_changed {
        0
    } else {
        existing.map(|e| e.last_uid).unwrap_or(0)
    };
    let next_status = if next_enabled {
        "connecting"
    } else {
        "disabled"
    };

    if existing.is_some() {
        conn.execute(
            "UPDATE imap_accounts
             SET label = ?1, enabled = ?2, host = ?3, port = ?4, tls = ?5, username = ?6,
                 password_enc = ?7, last_uid = ?8, status = ?9, last_error = NULL, updated_at = ?10
             WHERE id = ?11",
            params![
                next_label,
                i64::from(next_enabled),
                next_host,
                i64::from(next_port),
                i64::from(next_tls),
                next_username,
                next_password_enc,
                i64::from(next_last_uid),
                next_status,
                now,
                target_id,
            ],
        )
        .map_err(|e| SaveImapError::Internal(format!("DB error updating IMAP account: {e}")))?;
    } else {
        conn.execute(
            "INSERT INTO imap_accounts
             (id, label, enabled, host, port, tls, username, password_enc, last_uid, status, last_error, last_sync_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, ?11)",
            params![
                target_id,
                next_label,
                i64::from(next_enabled),
                next_host,
                i64::from(next_port),
                i64::from(next_tls),
                next_username,
                next_password_enc,
                i64::from(next_last_uid),
                next_status,
                now,
            ],
        )
        .map_err(|e| SaveImapError::Internal(format!("DB error inserting IMAP account: {e}")))?;
    }

    sync_legacy_imap_config_from_accounts_conn(&conn);

    Ok(SavedImapAccountMeta {
        id: Some(target_id),
        created: existing.is_none(),
        enabled: next_enabled,
    })
}

pub fn delete_imap_account_in_db(db: &NonePwdDb, id: &str) -> bool {
    let conn = db.lock_conn();
    let _ = ensure_legacy_imap_migrated_conn(&conn);
    let changes = conn
        .execute("DELETE FROM imap_accounts WHERE id = ?1", params![id])
        .unwrap_or(0);
    if changes == 0 {
        return false;
    }
    sync_legacy_imap_config_from_accounts_conn(&conn);
    true
}

pub fn resolve_imap_test_params_in_db(
    db: &NonePwdDb,
    input: ImapTestInput,
) -> (String, u16, bool, String, String) {
    let conn = db.lock_conn();
    let _ = ensure_legacy_imap_migrated_conn(&conn);

    let req_id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let req_user = input
        .username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let mut stored: Option<(String, i64, i64, String, String)> = if let Some(id) = req_id {
        conn.query_row(
            "SELECT host, port, tls, username, password_enc FROM imap_accounts WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .ok()
        .flatten()
    } else if let Some(user) = req_user {
        conn.query_row(
            "SELECT host, port, tls, username, password_enc FROM imap_accounts WHERE LOWER(username) = LOWER(?1)",
            params![user],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .ok()
        .flatten()
    } else {
        conn.query_row(
            "SELECT host, port, tls, username, password_enc FROM imap_accounts ORDER BY rowid ASC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .ok()
        .flatten()
    };

    if stored.is_none() {
        let legacy: Option<(String, i64, i64, String, String)> = conn
            .query_row(
                "SELECT host, port, tls, username, password_enc FROM imap_config WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .ok()
            .flatten();
        if let Some(leg) = legacy {
            let user_matches = req_user
                .map(|u| leg.3.trim().eq_ignore_ascii_case(u))
                .unwrap_or(true);
            if user_matches {
                stored = Some(leg);
            }
        }
    }

    let (st_host, st_port, st_tls, st_user, st_pw_enc) =
        stored.unwrap_or_else(|| (String::new(), 993, 1, String::new(), String::new()));

    let host = input
        .host
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or(st_host);
    let port = clamp_imap_port(input.port, st_port.clamp(1, 65535) as u16);
    let tls = input.tls.unwrap_or(st_tls != 0);
    let username = input
        .username
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or(st_user);
    let password = match input.password.filter(|p| !p.trim().is_empty()) {
        Some(pw) => pw,
        None => db.decrypt_local_secret(&st_pw_enc),
    };

    (host, port, tls, username, password)
}

fn update_imap_account_status(
    db: &NonePwdDb,
    ws_hub: &WsHub,
    account_id: &str,
    status: &str,
    last_error: Option<&str>,
) {
    let agg = {
        let conn = db.lock_conn();
        let _ = conn.execute(
            "UPDATE imap_accounts SET status = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4",
            params![status, last_error, now_iso_millis(), account_id],
        );
        sync_legacy_imap_config_from_accounts_conn(&conn);
        let public: Vec<ImapAccountPublic> = read_imap_account_rows_conn(&conn)
            .iter()
            .map(row_to_public)
            .collect();
        compute_aggregate_imap_config(&public)
    };
    ws_hub.broadcast(
        &json!({
            "type": "imap.status",
            "accountId": account_id,
            "status": status,
            "lastError": last_error,
            "aggregateStatus": agg.status,
            "aggregateError": agg.last_error,
        }),
        BroadcastOptions {
            vault_id: None,
            owner_only: true,
        },
    );
}

async fn fetch_recent_messages(
    client: &mut ImapClient,
    db: &NonePwdDb,
    ws_hub: &WsHub,
    account_id: &str,
) -> Result<(), String> {
    let row = {
        let conn = db.lock_conn();
        read_imap_account_by_id_conn(&conn, account_id)
    }
    .ok_or_else(|| "IMAP account removed".to_string())?;

    let since_dt = Utc::now() - chrono::Duration::hours(36);
    let search_cmd = format!("UID SEARCH SINCE {}", format_imap_date(since_dt));
    let search_res = client.run_command(&search_cmd).await?;

    let mut all_uids: Vec<u32> = Vec::new();
    for (line, _) in search_res {
        let trimmed = line.trim();
        if trimmed.len() >= 8 && trimmed[..8].eq_ignore_ascii_case("* SEARCH") {
            for tok in trimmed[8..].split_whitespace() {
                if let Ok(uid) = tok.parse::<u32>() {
                    all_uids.push(uid);
                }
            }
        }
    }

    let now = now_iso_millis();
    if all_uids.is_empty() {
        let conn = db.lock_conn();
        let _ = conn.execute(
            "UPDATE imap_accounts SET last_sync_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![now, account_id],
        );
        sync_legacy_imap_config_from_accounts_conn(&conn);
        return Ok(());
    }

    all_uids.sort_unstable();
    all_uids.dedup();

    let max_found = *all_uids.last().unwrap();
    let mut highest_uid = row.last_uid;
    let target_uids: Vec<u32> = if row.last_uid == 0 {
        // On initial sync, only process up to the 5 newest messages to avoid historical flood
        highest_uid = max_found;
        let start = all_uids.len().saturating_sub(5);
        all_uids[start..].to_vec()
    } else {
        all_uids
            .into_iter()
            .filter(|&uid| uid > row.last_uid)
            .collect()
    };

    let envelope_to = if row.username.trim().is_empty() {
        None
    } else {
        Some(row.username.trim())
    };

    for uid in target_uids {
        let fetch_cmd = format!("UID FETCH {uid} (UID BODY.PEEK[])");
        let fetched = client.run_command(&fetch_cmd).await?;
        for (_, raw_mime) in fetched {
            if !raw_mime.is_empty() {
                let _ = ingest_raw_email(db, ws_hub, &raw_mime, "imap", None, envelope_to);
            }
        }
        if uid > highest_uid {
            highest_uid = uid;
        }
    }

    {
        let conn = db.lock_conn();
        let _ = conn.execute(
            "UPDATE imap_accounts SET last_uid = ?1, last_sync_at = ?2, updated_at = ?2 WHERE id = ?3",
            params![highest_uid as i64, now_iso_millis(), account_id],
        );
        sync_legacy_imap_config_from_accounts_conn(&conn);
    }

    Ok(())
}

#[derive(Clone, PartialEq, Eq)]
struct AccountConfigSig {
    enabled: bool,
    host: String,
    port: u16,
    tls: bool,
    username: String,
    password_enc: String,
}

impl AccountConfigSig {
    fn from_row(row: &ImapAccountRow) -> Self {
        Self {
            enabled: row.enabled,
            host: row.host.clone(),
            port: row.port,
            tls: row.tls,
            username: row.username.clone(),
            password_enc: row.password_enc.clone(),
        }
    }
}

struct AccountRunnerHandle {
    sig: AccountConfigSig,
    stop_flag: Arc<AtomicBool>,
    stop_notify: Arc<Notify>,
    sync_notify: Arc<Notify>,
}

pub struct ImapWorker {
    db: Arc<NonePwdDb>,
    ws_hub: Arc<WsHub>,
    stopped: Arc<AtomicBool>,
    runners: Mutex<HashMap<String, AccountRunnerHandle>>,
}

impl ImapWorker {
    pub fn new(db: Arc<NonePwdDb>, ws_hub: Arc<WsHub>) -> Arc<Self> {
        Arc::new(Self {
            db,
            ws_hub,
            stopped: Arc::new(AtomicBool::new(false)),
            runners: Mutex::new(HashMap::new()),
        })
    }

    pub fn list_accounts(&self) -> Vec<ImapAccountPublic> {
        list_imap_accounts(&self.db)
    }

    pub fn get_public_config(&self) -> ImapConfigPublic {
        compute_aggregate_imap_config(&self.list_accounts())
    }

    pub fn reload(&self) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }

        let rows = {
            let conn = self.db.lock_conn();
            read_imap_account_rows_conn(&conn)
        };

        let mut desired: HashMap<String, ImapAccountRow> = HashMap::new();
        for r in &rows {
            desired.insert(r.id.clone(), r.clone());
        }

        let mut runners = self
            .runners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        // Stop runners for deleted, disabled, or modified accounts
        let existing_ids: Vec<String> = runners.keys().cloned().collect();
        for id in existing_ids {
            let keep = match desired.get(&id) {
                Some(row)
                    if row.enabled
                        && !row.host.trim().is_empty()
                        && !row.username.trim().is_empty()
                        && !self.db.decrypt_local_secret(&row.password_enc).is_empty() =>
                {
                    runners
                        .get(&id)
                        .is_some_and(|h| h.sig == AccountConfigSig::from_row(row))
                }
                _ => false,
            };
            if !keep {
                if let Some(handle) = runners.remove(&id) {
                    handle.stop_flag.store(true, Ordering::SeqCst);
                    handle.stop_notify.notify_waiters();
                }
            }
        }

        // Reconcile status & spawn runners for active accounts
        for row in rows {
            if !row.enabled || row.host.trim().is_empty() || row.username.trim().is_empty() {
                if row.status != "disabled" || row.last_error.is_some() {
                    update_imap_account_status(&self.db, &self.ws_hub, &row.id, "disabled", None);
                }
                continue;
            }
            if self.db.decrypt_local_secret(&row.password_enc).is_empty() {
                update_imap_account_status(
                    &self.db,
                    &self.ws_hub,
                    &row.id,
                    "error",
                    Some("IMAP password is empty"),
                );
                continue;
            }

            if runners.contains_key(&row.id) {
                continue;
            }

            update_imap_account_status(&self.db, &self.ws_hub, &row.id, "connecting", None);
            let stop_flag = Arc::new(AtomicBool::new(false));
            let stop_notify = Arc::new(Notify::new());
            let sync_notify = Arc::new(Notify::new());
            runners.insert(
                row.id.clone(),
                AccountRunnerHandle {
                    sig: AccountConfigSig::from_row(&row),
                    stop_flag: stop_flag.clone(),
                    stop_notify: stop_notify.clone(),
                    sync_notify: sync_notify.clone(),
                },
            );

            let db = self.db.clone();
            let ws_hub = self.ws_hub.clone();
            let global_stopped = self.stopped.clone();
            let account_id = row.id.clone();
            tokio::spawn(async move {
                Self::run_account_loop(
                    db,
                    ws_hub,
                    global_stopped,
                    account_id,
                    stop_flag,
                    stop_notify,
                    sync_notify,
                )
                .await;
            });
        }
    }

    pub fn trigger_sync(&self, account_id: Option<&str>) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        self.reload();
        let runners = self
            .runners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(id) = account_id {
            if let Some(handle) = runners.get(id) {
                handle.sync_notify.notify_one();
            }
        } else {
            for handle in runners.values() {
                handle.sync_notify.notify_one();
            }
        }
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let mut runners = self
            .runners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (_, handle) in runners.drain() {
            handle.stop_flag.store(true, Ordering::SeqCst);
            handle.stop_notify.notify_waiters();
        }
    }

    pub async fn test_connection(
        &self,
        host: &str,
        port: u16,
        tls: bool,
        username: &str,
        password: &str,
    ) -> ImapTestResult {
        let host = host.to_string();
        let username = username.to_string();
        let password = password.to_string();

        let fut = async move {
            let mut client = ImapClient::connect(&host, port, tls).await?;
            client.login(&host, &username, &password).await?;
            let messages = client.status_messages("INBOX").await?;
            client.logout().await;
            Ok::<u32, String>(messages)
        };

        match tokio::time::timeout(Duration::from_secs(8), fut).await {
            Ok(Ok(messages)) => ImapTestResult {
                ok: true,
                messages: Some(messages),
                error: None,
            },
            Ok(Err(err)) => ImapTestResult {
                ok: false,
                messages: None,
                error: Some(err),
            },
            Err(_) => ImapTestResult {
                ok: false,
                messages: None,
                error: Some("IMAP connection timed out".to_string()),
            },
        }
    }

    async fn run_account_loop(
        db: Arc<NonePwdDb>,
        ws_hub: Arc<WsHub>,
        global_stopped: Arc<AtomicBool>,
        account_id: String,
        stop_flag: Arc<AtomicBool>,
        stop_notify: Arc<Notify>,
        sync_notify: Arc<Notify>,
    ) {
        loop {
            if global_stopped.load(Ordering::SeqCst) || stop_flag.load(Ordering::SeqCst) {
                break;
            }

            let row = {
                let conn = db.lock_conn();
                read_imap_account_by_id_conn(&conn, &account_id)
            };
            let Some(row) = row else {
                break;
            };
            if !row.enabled || row.host.trim().is_empty() || row.username.trim().is_empty() {
                break;
            }

            let password = db.decrypt_local_secret(&row.password_enc);
            if password.is_empty() {
                update_imap_account_status(
                    &db,
                    &ws_hub,
                    &account_id,
                    "error",
                    Some("IMAP password is empty"),
                );
                tokio::select! {
                    biased;
                    _ = stop_notify.notified() => break,
                    _ = sync_notify.notified() => continue,
                    _ = tokio::time::sleep(Duration::from_secs(30)) => continue,
                }
            }

            update_imap_account_status(&db, &ws_hub, &account_id, "connecting", None);

            let session_res = Self::run_single_session(
                &db,
                &ws_hub,
                &global_stopped,
                &stop_flag,
                &stop_notify,
                &sync_notify,
                &row,
                &password,
            )
            .await;

            if global_stopped.load(Ordering::SeqCst) || stop_flag.load(Ordering::SeqCst) {
                break;
            }

            if let Err(err) = session_res {
                update_imap_account_status(&db, &ws_hub, &account_id, "error", Some(&err));
                tokio::select! {
                    biased;
                    _ = stop_notify.notified() => break,
                    _ = sync_notify.notified() => {}
                    _ = tokio::time::sleep(Duration::from_secs(10)) => {}
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_single_session(
        db: &NonePwdDb,
        ws_hub: &WsHub,
        global_stopped: &AtomicBool,
        stop_flag: &AtomicBool,
        stop_notify: &Notify,
        sync_notify: &Notify,
        row: &ImapAccountRow,
        password: &str,
    ) -> Result<(), String> {
        let mut client = ImapClient::connect(&row.host, row.port, row.tls).await?;
        client.login(&row.host, &row.username, password).await?;
        client.run_command("SELECT \"INBOX\"").await?;

        update_imap_account_status(db, ws_hub, &row.id, "listening", None);
        fetch_recent_messages(&mut client, db, ws_hub, &row.id).await?;

        loop {
            if global_stopped.load(Ordering::SeqCst) || stop_flag.load(Ordering::SeqCst) {
                client.logout().await;
                return Ok(());
            }

            // Enter IMAP IDLE to receive push notifications
            let idle_tag = client.next_tag();
            client
                .send_raw(format!("{idle_tag} IDLE\r\n").as_bytes())
                .await?;

            let mut cont_line = String::new();
            let n = client
                .reader
                .read_line(&mut cont_line)
                .await
                .map_err(|e| format!("IMAP IDLE read failed: {e}"))?;
            if n == 0 {
                return Err("IMAP connection closed while entering IDLE".to_string());
            }

            if !cont_line.starts_with('+') {
                // Server does not support IDLE; fall back to periodic polling
                tokio::select! {
                    biased;
                    _ = stop_notify.notified() => {
                        client.logout().await;
                        return Ok(());
                    }
                    _ = sync_notify.notified() => {
                        fetch_recent_messages(&mut client, db, ws_hub, &row.id).await?;
                        continue;
                    }
                    _ = tokio::time::sleep(Duration::from_secs(15)) => {
                        fetch_recent_messages(&mut client, db, ws_hub, &row.id).await?;
                        continue;
                    }
                }
            }

            let mut idle_line = String::new();
            let mut should_stop = false;

            loop {
                idle_line.clear();
                tokio::select! {
                    biased;
                    _ = stop_notify.notified() => {
                        should_stop = true;
                        break;
                    }
                    _ = sync_notify.notified() => {
                        break;
                    }
                    _ = tokio::time::sleep(Duration::from_secs(14 * 60)) => {
                        // RFC 2177: re-issue IDLE at least every 29 minutes
                        break;
                    }
                    read_res = client.reader.read_line(&mut idle_line) => {
                        let bytes_read = read_res.map_err(|e| format!("IMAP IDLE stream error: {e}"))?;
                        if bytes_read == 0 {
                            return Err("IMAP server closed IDLE connection".to_string());
                        }
                        let upper = idle_line.to_ascii_uppercase();
                        if upper.contains("EXISTS") || upper.contains("RECENT") {
                            break;
                        }
                    }
                }
            }

            // Exit IDLE cleanly with DONE
            client.send_raw(b"DONE\r\n").await?;
            let _ = client.read_until_tag(&idle_tag).await?;

            if should_stop
                || global_stopped.load(Ordering::SeqCst)
                || stop_flag.load(Ordering::SeqCst)
            {
                client.logout().await;
                return Ok(());
            }

            fetch_recent_messages(&mut client, db, ws_hub, &row.id).await?;
        }
    }
}
