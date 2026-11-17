pub mod auth;
pub mod db;
pub mod email_ingest;
pub mod imap;
pub mod mime;
pub mod routes;
pub mod ws;

use std::env;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::db::NonePwdDb;
use crate::imap::ImapWorker;
use crate::routes::{build_router, AppState};
use crate::ws::WsHub;

#[derive(Debug, Clone)]
pub struct ServerOptions {
    pub host: String,
    pub port: u16,
    pub data_dir: Option<PathBuf>,
    pub web_dist: Option<PathBuf>,
    pub bin_dist: Option<PathBuf>,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 8787,
            data_dir: None,
            web_dist: None,
            bin_dist: None,
        }
    }
}

pub struct RunningServer {
    pub addr: SocketAddr,
    pub url: String,
    pub db: Arc<NonePwdDb>,
    pub ws_hub: Arc<WsHub>,
    pub imap_worker: Arc<ImapWorker>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    join_handle: Option<tokio::task::JoinHandle<()>>,
}

impl RunningServer {
    pub async fn shutdown(mut self) {
        self.imap_worker.stop();
        self.ws_hub.close_all();
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.await;
        }
    }
}

fn expand_tilde(path: PathBuf) -> PathBuf {
    let Some(s) = path.to_str() else {
        return path;
    };
    if s == "~" || s.starts_with("~/") {
        if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
            let home_path = PathBuf::from(home);
            if s == "~" {
                return home_path;
            }
            return home_path.join(&s[2..]);
        }
    }
    path
}

fn resolve_data_dir(opt: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = opt {
        return expand_tilde(dir);
    }
    if let Ok(env_dir) = env::var("NONEPWD_DATA_DIR") {
        let trimmed = env_dir.trim();
        if !trimmed.is_empty() {
            return expand_tilde(PathBuf::from(trimmed));
        }
    }
    if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        return PathBuf::from(home).join(".nonepwd").join("data");
    }
    env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("data")
}

fn resolve_web_dist(opt: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = opt {
        return expand_tilde(dir);
    }
    if let Ok(env_dir) = env::var("NONEPWD_WEB_DIST") {
        let trimmed = env_dir.trim();
        if !trimmed.is_empty() {
            return expand_tilde(PathBuf::from(trimmed));
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("web-dist"));
            candidates.push(exe_dir.join("../web-dist"));
            candidates.push(exe_dir.join("../../packages/web/dist"));
        }
    }
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("packages/web/dist"));
        candidates.push(cwd.join("../../packages/web/dist"));
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/web/dist"));

    for c in &candidates {
        if c.join("index.html").is_file() {
            return c.clone();
        }
    }
    candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("packages/web/dist"))
}

fn resolve_bin_dirs(opt: Option<PathBuf>) -> Vec<PathBuf> {
    if let Some(dir) = opt {
        return vec![expand_tilde(dir)];
    }
    if let Ok(env_dir) = env::var("NONEPWD_BIN_DIST") {
        let trimmed = env_dir.trim();
        if !trimmed.is_empty() {
            return vec![expand_tilde(PathBuf::from(trimmed))];
        }
    }

    let mut dirs = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            dirs.push(exe_dir.to_path_buf());
            dirs.push(exe_dir.join("bin-dist"));
            dirs.push(exe_dir.join("../../dist/bin"));
        }
    }
    if let Ok(cwd) = env::current_dir() {
        dirs.push(cwd.join("dist/bin"));
        dirs.push(cwd.join("../../dist/bin"));
    }
    dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dist/bin"));
    dirs
}

pub async fn start_server(opts: ServerOptions) -> Result<RunningServer, String> {
    let host = if opts.host.trim().is_empty() {
        "127.0.0.1".to_string()
    } else {
        opts.host.trim().to_string()
    };
    let data_dir = resolve_data_dir(opts.data_dir);
    let web_dist_dir = resolve_web_dist(opts.web_dist);
    let bin_dist_dirs = resolve_bin_dirs(opts.bin_dist);

    let db = Arc::new(NonePwdDb::open(&data_dir)?);
    let ws_hub = Arc::new(WsHub::new());
    let imap_worker = ImapWorker::new(db.clone(), ws_hub.clone());
    imap_worker.reload();

    let app_state = AppState {
        db: db.clone(),
        ws_hub: ws_hub.clone(),
        imap_worker: imap_worker.clone(),
        web_dist_dir,
        bin_dist_dirs,
    };
    let router = build_router(app_state);

    let bind_target = format!("{host}:{}", opts.port);
    let listener = TcpListener::bind(&bind_target)
        .await
        .map_err(|e| format!("Failed binding {bind_target}: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("Failed reading bound address: {e}"))?;

    let connect_host = if host == "0.0.0.0" {
        "127.0.0.1"
    } else {
        host.as_str()
    };
    let url = format!("http://{connect_host}:{}", addr.port());

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let join_handle = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    Ok(RunningServer {
        addr,
        url,
        db,
        ws_hub,
        imap_worker,
        shutdown_tx: Some(shutdown_tx),
        join_handle: Some(join_handle),
    })
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut sigterm) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = sigterm.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

pub fn run_blocking(opts: ServerOptions) -> Result<(), String> {
    let display_host = if opts.host.trim().is_empty() {
        "127.0.0.1".to_string()
    } else {
        opts.host.trim().to_string()
    };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("Failed initializing Tokio runtime: {e}"))?;

    rt.block_on(async move {
        let srv = start_server(opts).await?;
        println!(
            "nonepwd server listening on http://{}:{}",
            display_host,
            srv.addr.port()
        );
        let _ = std::io::stdout().flush();

        wait_for_shutdown_signal().await;
        srv.shutdown().await;
        Ok(())
    })
}

#[cfg(test)]
mod unit_tests {
    use crate::auth::extract_bearer_token;
    use crate::db::{EmailFilterConfig, EmailFilterField, EmailFilterMode, EmailFilterRule};
    use crate::email_ingest::{evaluate_email_filter, FilterEvalContext};

    #[test]
    fn bearer_token_handles_multibyte_utf8_without_panic() {
        assert_eq!(extract_bearer_token(Some("中文中文中文中文")), None);
        assert_eq!(extract_bearer_token(Some("Bearer ")), None);
        assert_eq!(
            extract_bearer_token(Some("bearer   tok_123  ")),
            Some("tok_123".to_string())
        );
    }

    #[test]
    fn email_filter_matrix_otp_only_allow_deny_and_edge_sealed() {
        // 1) Disabled filter accepts everything
        let disabled = EmailFilterConfig::default();
        assert!(evaluate_email_filter(
            &disabled,
            &FilterEvalContext {
                from: "Spam <a@b.com>",
                to: "me@x.com",
                subject: "Ad",
                body: "Buy now",
                raw_text: None,
                has_otp: false,
                edge_sealed: false,
            }
        ));

        // 2) Enabled + otpOnly=true + no rules (default mode='allow' from UI) accepts OTP and drops non-OTP
        let otp_only_no_rules = EmailFilterConfig {
            enabled: true,
            otp_only: true,
            mode: EmailFilterMode::Allow,
            rules: vec![],
        };
        assert!(!evaluate_email_filter(
            &otp_only_no_rules,
            &FilterEvalContext {
                from: "GitHub <noreply@github.com>",
                to: "me@x.com",
                subject: "News",
                body: "Hello",
                raw_text: None,
                has_otp: false,
                edge_sealed: false,
            }
        ));
        assert!(evaluate_email_filter(
            &otp_only_no_rules,
            &FilterEvalContext {
                from: "GitHub <noreply@github.com>",
                to: "me@x.com",
                subject: "OTP",
                body: "Your code is 123456",
                raw_text: None,
                has_otp: true,
                edge_sealed: false,
            }
        ));

        // 3) Deny mode drops matching rule and accepts non-matching
        let deny_cfg = EmailFilterConfig {
            enabled: true,
            otp_only: false,
            mode: EmailFilterMode::Deny,
            rules: vec![EmailFilterRule {
                id: "1".into(),
                field: EmailFilterField::Body,
                pattern: "(?i)unsubscribe".into(),
                enabled: true,
            }],
        };
        assert!(!evaluate_email_filter(
            &deny_cfg,
            &FilterEvalContext {
                from: "a@b.com",
                to: "me@x.com",
                subject: "Hi",
                body: "Click here to UNSUBSCRIBE today",
                raw_text: None,
                has_otp: false,
                edge_sealed: false,
            }
        ));
        assert!(evaluate_email_filter(
            &deny_cfg,
            &FilterEvalContext {
                from: "a@b.com",
                to: "me@x.com",
                subject: "Hi",
                body: "Important security notice",
                raw_text: None,
                has_otp: false,
                edge_sealed: false,
            }
        ));

        // 4) Edge-sealed ignores non-`to` rules and applies `to` + `hasOtp`
        let edge_cfg = EmailFilterConfig {
            enabled: true,
            otp_only: true,
            mode: EmailFilterMode::Deny,
            rules: vec![
                EmailFilterRule {
                    id: "1".into(),
                    field: EmailFilterField::From,
                    pattern: ".*".into(),
                    enabled: true,
                },
                EmailFilterRule {
                    id: "2".into(),
                    field: EmailFilterField::To,
                    pattern: "^blocked@".into(),
                    enabled: true,
                },
            ],
        };
        assert!(evaluate_email_filter(
            &edge_cfg,
            &FilterEvalContext {
                from: "anything@anywhere.com",
                to: "allowed@example.com",
                subject: "",
                body: "",
                raw_text: None,
                has_otp: true,
                edge_sealed: true,
            }
        ));
        assert!(!evaluate_email_filter(
            &edge_cfg,
            &FilterEvalContext {
                from: "",
                to: "blocked@example.com",
                subject: "",
                body: "",
                raw_text: None,
                has_otp: true,
                edge_sealed: true,
            }
        ));
    }
}
