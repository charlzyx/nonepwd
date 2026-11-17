use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use chrono::{Datelike, Utc};
use rusqlite::params;
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
use crate::db::NonePwdDb;
use crate::email_ingest::ingest_raw_email;
use crate::ws::{BroadcastOptions, WsHub};

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone)]
struct ImapRow {
    enabled: bool,
    host: String,
    port: u16,
    tls: bool,
    username: String,
    password_enc: String,
    last_uid: u32,
    status: String,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImapTestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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

    async fn login(&mut self, username: &str, password: &str) -> Result<(), String> {
        if username.contains(['\r', '\n']) || password.contains(['\r', '\n']) {
            return Err("IMAP credentials must not contain CR/LF".to_string());
        }
        let cmd = format!(
            "LOGIN {} {}",
            imap_quote_string(username),
            imap_quote_string(password)
        );
        self.run_command(&cmd).await.map(|_| ())
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

fn read_imap_row(db: &NonePwdDb) -> ImapRow {
    let conn = db.lock_conn();
    conn.query_row(
        "SELECT enabled, host, port, tls, username, password_enc, last_uid, status, last_error
         FROM imap_config WHERE id = 1",
        [],
        |r| {
            Ok(ImapRow {
                enabled: r.get::<_, i64>(0)? != 0,
                host: r.get(1)?,
                port: r.get::<_, i64>(2)?.clamp(1, 65535) as u16,
                tls: r.get::<_, i64>(3)? != 0,
                username: r.get(4)?,
                password_enc: r.get(5)?,
                last_uid: r.get::<_, i64>(6)?.max(0) as u32,
                status: r.get(7)?,
                last_error: r.get(8)?,
            })
        },
    )
    .unwrap_or(ImapRow {
        enabled: false,
        host: String::new(),
        port: 993,
        tls: true,
        username: String::new(),
        password_enc: String::new(),
        last_uid: 0,
        status: "disabled".to_string(),
        last_error: None,
    })
}

fn update_imap_status(db: &NonePwdDb, ws_hub: &WsHub, status: &str, last_error: Option<&str>) {
    {
        let conn = db.lock_conn();
        let _ = conn.execute(
            "UPDATE imap_config SET status = ?1, last_error = ?2, updated_at = ?3 WHERE id = 1",
            params![status, last_error, now_iso_millis()],
        );
    }
    ws_hub.broadcast(
        &json!({
            "type": "imap.status",
            "status": status,
            "lastError": last_error,
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
) -> Result<(), String> {
    let row = read_imap_row(db);
    let since_dt = Utc::now() - chrono::Duration::minutes(10);
    let search_cmd = format!("UID SEARCH UNSEEN SINCE {}", format_imap_date(since_dt));
    let search_res = client.run_command(&search_cmd).await?;

    let mut uids: Vec<u32> = Vec::new();
    for (line, _) in search_res {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("* SEARCH") {
            for tok in rest.split_whitespace() {
                if let Ok(uid) = tok.parse::<u32>() {
                    if uid > row.last_uid {
                        uids.push(uid);
                    }
                }
            }
        }
    }

    if uids.is_empty() {
        return Ok(());
    }

    uids.sort_unstable();
    uids.dedup();

    let mut highest_uid = row.last_uid;
    for uid in uids {
        let fetch_cmd = format!("UID FETCH {uid} (UID BODY.PEEK[])");
        let fetched = client.run_command(&fetch_cmd).await?;
        for (_, raw_mime) in fetched {
            if !raw_mime.is_empty() {
                let _ = ingest_raw_email(db, ws_hub, &raw_mime, "imap", None, None);
            }
        }
        if uid > highest_uid {
            highest_uid = uid;
        }
    }

    if highest_uid > row.last_uid {
        let conn = db.lock_conn();
        let _ = conn.execute(
            "UPDATE imap_config SET last_uid = ?1 WHERE id = 1",
            params![highest_uid as i64],
        );
    }

    Ok(())
}

pub struct ImapWorker {
    db: Arc<NonePwdDb>,
    ws_hub: Arc<WsHub>,
    stopped: Arc<AtomicBool>,
    reload_notify: Arc<Notify>,
}

impl ImapWorker {
    pub fn new(db: Arc<NonePwdDb>, ws_hub: Arc<WsHub>) -> Arc<Self> {
        let worker = Arc::new(Self {
            db,
            ws_hub,
            stopped: Arc::new(AtomicBool::new(false)),
            reload_notify: Arc::new(Notify::new()),
        });
        Self::spawn_loop(worker.clone());
        worker
    }

    pub fn get_public_config(&self) -> ImapConfigPublic {
        let row = read_imap_row(&self.db);
        ImapConfigPublic {
            enabled: row.enabled,
            host: row.host,
            port: row.port,
            tls: row.tls,
            username: row.username,
            has_password: !row.password_enc.is_empty(),
            status: row.status,
            last_error: row.last_error,
        }
    }

    pub fn reload(&self) {
        let row = read_imap_row(&self.db);
        if !row.enabled || row.host.is_empty() || row.username.is_empty() {
            update_imap_status(&self.db, &self.ws_hub, "disabled", None);
        } else if self.db.decrypt_local_secret(&row.password_enc).is_empty() {
            update_imap_status(
                &self.db,
                &self.ws_hub,
                "error",
                Some("IMAP password is empty"),
            );
        } else {
            update_imap_status(&self.db, &self.ws_hub, "connecting", None);
        }
        self.reload_notify.notify_one();
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.reload_notify.notify_waiters();
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
            client.login(&username, &password).await?;
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

    fn spawn_loop(self_arc: Arc<Self>) {
        tokio::spawn(async move {
            loop {
                if self_arc.stopped.load(Ordering::SeqCst) {
                    break;
                }

                let row = read_imap_row(&self_arc.db);
                if !row.enabled || row.host.is_empty() || row.username.is_empty() {
                    update_imap_status(&self_arc.db, &self_arc.ws_hub, "disabled", None);
                    self_arc.reload_notify.notified().await;
                    continue;
                }

                let password = self_arc.db.decrypt_local_secret(&row.password_enc);
                if password.is_empty() {
                    update_imap_status(
                        &self_arc.db,
                        &self_arc.ws_hub,
                        "error",
                        Some("IMAP password is empty"),
                    );
                    self_arc.reload_notify.notified().await;
                    continue;
                }

                update_imap_status(&self_arc.db, &self_arc.ws_hub, "connecting", None);

                let session_res = Self::run_single_session(&self_arc, &row, &password).await;
                if self_arc.stopped.load(Ordering::SeqCst) {
                    break;
                }

                if let Err(err) = session_res {
                    update_imap_status(&self_arc.db, &self_arc.ws_hub, "error", Some(&err));
                    tokio::select! {
                        _ = self_arc.reload_notify.notified() => {}
                        _ = tokio::time::sleep(Duration::from_secs(10)) => {}
                    }
                }
            }
        });
    }

    async fn run_single_session(&self, row: &ImapRow, password: &str) -> Result<(), String> {
        let mut client = ImapClient::connect(&row.host, row.port, row.tls).await?;
        client.login(&row.username, password).await?;
        client.run_command("SELECT \"INBOX\"").await?;

        update_imap_status(&self.db, &self.ws_hub, "listening", None);
        fetch_recent_messages(&mut client, &self.db, &self.ws_hub).await?;

        loop {
            if self.stopped.load(Ordering::SeqCst) {
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
                    _ = self.reload_notify.notified() => {
                        client.logout().await;
                        return Ok(());
                    }
                    _ = tokio::time::sleep(Duration::from_secs(15)) => {
                        fetch_recent_messages(&mut client, &self.db, &self.ws_hub).await?;
                        continue;
                    }
                }
            }

            let mut idle_line = String::new();
            let mut should_reload = false;

            loop {
                idle_line.clear();
                tokio::select! {
                    _ = self.reload_notify.notified() => {
                        should_reload = true;
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

            if should_reload || self.stopped.load(Ordering::SeqCst) {
                client.logout().await;
                return Ok(());
            }

            fetch_recent_messages(&mut client, &self.db, &self.ws_hub).await?;
        }
    }
}
