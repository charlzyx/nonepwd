//! `np agent` — Agent Access protocol v0 over this user's nonepwd relay.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use nonepwd_agent::{
    connect_and_request, relay_url_from_server, resolve_items, run_with_credential,
    start_user_agent, ApprovalSource, CredentialQuery, IdentityKeyPair,
};
use nonepwd_core::crypto::decode_service_account_token;

use crate::client::NonePwdClient;
use crate::config::{ensure_config_dir, load_config, resolve_config_dir};
use crate::{first_flag, has_flag, is_dangerous_env_var, scrub_nonepwd_env, ParsedArgs};

pub(crate) fn run_agent(
    client: &mut NonePwdClient,
    parsed: &ParsedArgs,
    config_dir: &Option<String>,
) -> Result<i32, String> {
    let sub = parsed
        .positionals
        .get(1)
        .map(String::as_str)
        .unwrap_or("listen");
    let relay = resolve_relay_url(parsed, config_dir.as_deref())?;
    match sub {
        "listen" => {
            let identity = load_identity(config_dir.as_deref(), "agent-user-identity.cose")?;
            let shared = Arc::new(Mutex::new(std::mem::replace(
                client,
                NonePwdClient::new(config_dir.clone(), None),
            )));
            let resolver_client = Arc::clone(&shared);
            let approvals = if has_flag(parsed, "yes") {
                ApprovalSource::Always
            } else {
                ApprovalSource::Prompt
            };
            let runtime = tokio_runtime()?;
            let agent = runtime.block_on(start_user_agent(
                relay.clone(),
                identity,
                move |query| {
                    let mut guard = resolver_client
                        .lock()
                        .map_err(|_| "vault client lock poisoned".to_string())?;
                    guard.sync()?;
                    let now_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let payloads: Vec<_> = guard.items.iter().map(|item| &item.payload).collect();
                    // resolve_items wants owned payloads. Clone the matched path via a local copy.
                    let owned: Vec<_> = payloads.into_iter().cloned().collect();
                    resolve_items(&owned, query, now_ms)
                },
                approvals,
            ))?;
            eprintln!("nonepwd agent relay: {relay}");
            eprintln!("Waiting for credential requests. Each one needs approval.");
            eprintln!("Pairing token (PSK, give this to `np agent connect` or `aac --relay-url`):");
            println!("{}", agent.token);
            let _ = std::io::stdout().flush();
            runtime
                .block_on(agent.task)
                .map_err(|e| format!("agent listener stopped: {e}"))??;
            Ok(0)
        }
        "connect" => {
            let identity = load_identity(config_dir.as_deref(), "agent-remote-identity.cose")?;
            let token = require_token(parsed)?;
            let query = require_query(parsed)?;
            let runtime = tokio_runtime()?;
            let cred = runtime.block_on(connect_and_request(
                &relay,
                identity,
                &token,
                query,
                std::time::Duration::from_secs(120),
            ))?;
            if wants_json(parsed) {
                println!(
                    "{}",
                    serde_json::json!({
                        "success": true,
                        "credential": {
                            "credentialId": cred.credential_id,
                            "domain": cred.domain,
                            "uri": cred.uri,
                            "username": cred.username,
                            "password": cred.password.as_ref().map(|p| p.as_str()),
                            "totp": cred.totp,
                            "notes": cred.notes,
                        }
                    })
                );
            } else {
                println!("username: {}", cred.username.as_deref().unwrap_or(""));
                println!(
                    "password: {}",
                    cred.password.as_ref().map(|p| p.as_str()).unwrap_or("")
                );
                println!("totp: {}", cred.totp.as_deref().unwrap_or(""));
                println!("uri: {}", cred.uri.as_deref().unwrap_or(""));
                println!("domain: {}", cred.domain.as_deref().unwrap_or(""));
                println!(
                    "credential_id: {}",
                    cred.credential_id.as_deref().unwrap_or("")
                );
                if let Some(notes) = cred.notes.as_deref() {
                    println!("notes: {notes}");
                }
            }
            Ok(0)
        }
        "run" => {
            if parsed.rest_after_dash_dash.is_empty() {
                return Err("agent run requires `-- <command> [args...]`".into());
            }
            let identity = load_identity(config_dir.as_deref(), "agent-remote-identity.cose")?;
            let token = require_token(parsed)?;
            let query = require_query(parsed)?;
            let mappings = parsed.flags.get("env").cloned().unwrap_or_default();
            for spec in &mappings {
                if let Some((key, _)) = spec.split_once('=') {
                    if is_dangerous_env_var(key) {
                        return Err(format!(
                            "Refusing to set dangerous environment variable \"{}\" via --env",
                            key.trim()
                        ));
                    }
                }
            }
            let runtime = tokio_runtime()?;
            let pairs = runtime.block_on(run_with_credential(
                &relay,
                identity,
                &token,
                query,
                has_flag(parsed, "env-all"),
                &mappings,
            ))?;
            let mut child_env: std::collections::HashMap<String, String> =
                std::env::vars().collect();
            for (key, value) in pairs {
                if is_dangerous_env_var(&key) {
                    return Err(format!(
                        "Refusing to set dangerous environment variable \"{key}\" via --env"
                    ));
                }
                child_env.insert(key, value);
            }
            scrub_nonepwd_env(&mut child_env);
            let mut cmd = Command::new(&parsed.rest_after_dash_dash[0]);
            cmd.args(&parsed.rest_after_dash_dash[1..]);
            cmd.env_clear();
            cmd.envs(&child_env);
            let status = cmd
                .status()
                .map_err(|e| format!("failed to spawn {}: {e}", parsed.rest_after_dash_dash[0]))?;
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if let Some(sig) = status.signal() {
                    return Ok(128 + sig);
                }
            }
            Ok(status.code().unwrap_or(1))
        }
        other => Err(format!(
            "unknown agent subcommand \"{other}\" (listen, connect, run)"
        )),
    }
}

fn wants_json(parsed: &ParsedArgs) -> bool {
    has_flag(parsed, "json")
        || first_flag(parsed, "output").is_some_and(|v| v.eq_ignore_ascii_case("json"))
        || first_flag(parsed, "format").is_some_and(|v| v.eq_ignore_ascii_case("json"))
}

fn require_token(parsed: &ParsedArgs) -> Result<String, String> {
    first_flag(parsed, "token")
        .map(str::to_string)
        .or_else(|| std::env::var("NONEPWD_AGENT_TOKEN").ok())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "agent connect/run requires --token <psk> (or NONEPWD_AGENT_TOKEN)".into())
}

fn require_query(parsed: &ParsedArgs) -> Result<CredentialQuery, String> {
    let domain = first_flag(parsed, "domain").filter(|s| !s.is_empty());
    let id = first_flag(parsed, "id").filter(|s| !s.is_empty());
    let search = first_flag(parsed, "search").filter(|s| !s.is_empty());
    match (domain, id, search) {
        (Some(domain), None, None) => Ok(CredentialQuery::Domain(domain.to_string())),
        (None, Some(id), None) => Ok(CredentialQuery::Id(id.to_string())),
        (None, None, Some(search)) => Ok(CredentialQuery::Search(search.to_string())),
        (None, None, None) => Err("pass one of --domain, --id, or --search".into()),
        _ => Err("pass only one of --domain, --id, or --search".into()),
    }
}

fn resolve_relay_url(parsed: &ParsedArgs, config_dir: Option<&str>) -> Result<String, String> {
    if let Some(explicit) = first_flag(parsed, "relay-url")
        .map(str::to_string)
        .or_else(|| std::env::var("NONEPWD_RELAY_URL").ok())
        .filter(|s| !s.trim().is_empty())
    {
        return relay_url_from_server(&explicit);
    }
    let server = if let Some(server) = first_flag(parsed, "server") {
        Some(server.to_string())
    } else if let Ok(token) = std::env::var("NONEPWD_TOKEN") {
        decode_service_account_token(&token)
            .ok()
            .map(|payload| payload.server_url)
    } else {
        None
    };
    let server = server
        .or_else(|| load_config(config_dir).server_url)
        .ok_or_else(|| {
            "no nonepwd server URL. Sign in, or pass --server / --relay-url. The Bitwarden hosted relay is not used."
                .to_string()
        })?;
    relay_url_from_server(&server)
}

fn load_identity(config_dir: Option<&str>, file_name: &str) -> Result<IdentityKeyPair, String> {
    let path = resolve_config_dir(config_dir)?.join(file_name);
    if path.is_file() {
        let bytes =
            fs::read(&path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
        return IdentityKeyPair::from_cose(&bytes)
            .map_err(|e| format!("failed to load agent identity {}: {e}", path.display()));
    }
    let key = IdentityKeyPair::generate();
    write_private_file(&path, &key.to_cose())?;
    Ok(key)
}

fn write_private_file(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_config_dir(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("failed to create {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("failed to set permissions on {}: {e}", path.display()))?;
    }
    file.write_all(bytes)
        .map_err(|e| format!("failed to write {}: {e}", path.display()))?;
    Ok(())
}

fn tokio_runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("failed to start async runtime: {e}"))
}
