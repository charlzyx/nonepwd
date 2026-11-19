//! User-side approval loop and remote credential requests.

use std::io::{self, Write};
use std::sync::Arc;
use std::time::Duration;

use ap_client::{
    CredentialData, CredentialQuery, CredentialRequestReply, MemoryConnectionStore,
    MemoryIdentityProvider, PskToken, RemoteClient, UserClient, UserClientRequest,
};
use ap_relay_protocol::IdentityKeyPair;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use crate::relay_client::RustlsRelayClient;
use nonepwd_core::agent_access::{
    lookup_agent_item, map_agent_credential, AgentCredential, AgentLookupError, AgentQuery,
};

/// How `np agent listen` decides each credential request.
pub enum ApprovalSource {
    /// Read `y` / `yes` from stdin. Anything else denies the request.
    Prompt,
    /// Approve every request. Intended for an already-trusted local test.
    Always,
    /// Deny every request.
    Never,
    /// Test hook: one boolean per request, in order. A closed channel denies.
    Queue(mpsc::UnboundedReceiver<bool>),
}

pub struct UserAgent {
    pub token: String,
    pub task: JoinHandle<Result<(), String>>,
}

/// Connect to the relay, publish a one-time PSK token, and answer requests.
///
/// `resolver` decrypts on the user side. The relay only sees ciphertext.
pub async fn start_user_agent<F>(
    relay_url: String,
    identity: IdentityKeyPair,
    resolver: F,
    mut approvals: ApprovalSource,
) -> Result<UserAgent, String>
where
    F: Fn(&AgentQuery) -> Result<AgentCredential, String> + Send + Sync + 'static,
{
    let relay = Box::new(RustlsRelayClient::new(relay_url));
    let handle = UserClient::connect(
        Box::new(MemoryIdentityProvider::from_keypair(identity)),
        Box::new(MemoryConnectionStore::new()),
        relay,
        None,
        None,
    )
    .await
    .map_err(|e| format!("user client failed to join the relay: {e}"))?;

    let token = handle
        .client
        .get_psk_token(Some("nonepwd".into()), false)
        .await
        .map_err(|e| format!("failed to create a PSK pairing token: {e}"))?;

    let resolver = Arc::new(resolver);
    let mut requests = handle.requests;
    let mut notifications = handle.notifications;
    let client = handle.client;
    let task = tokio::spawn(async move {
        let _client = client;
        loop {
            tokio::select! {
                note = notifications.recv() => {
                    if note.is_none() {
                        break;
                    }
                }
                req = requests.recv() => {
                    let Some(req) = req else { break; };
                    match req {
                        UserClientRequest::VerifyFingerprint { reply, .. } => {
                            let _ = reply.send(ap_client::FingerprintVerificationReply {
                                approved: true,
                                name: Some("nonepwd".into()),
                            });
                        }
                        UserClientRequest::CredentialRequest { query, reply, .. } => {
                            let summary = query.to_string();
                            let approved = match &mut approvals {
                                ApprovalSource::Always => true,
                                ApprovalSource::Never => false,
                                ApprovalSource::Prompt => {
                                    let summary = summary.clone();
                                    tokio::task::spawn_blocking(move || prompt_yes(&summary))
                                        .await
                                        .unwrap_or(false)
                                }
                                ApprovalSource::Queue(rx) => rx.recv().await.unwrap_or(false),
                            };
                            let response = if approved {
                                let core_query = to_core_query(&query);
                                match resolver(&core_query) {
                                    Ok(cred) => CredentialRequestReply {
                                        approved: true,
                                        credential_id: cred.credential_id.clone(),
                                        credential: Some(to_sdk(&cred)),
                                    },
                                    Err(err) => {
                                        eprintln!("agent request ({summary}) not fulfilled: {err}");
                                        CredentialRequestReply {
                                            approved: false,
                                            credential: None,
                                            credential_id: None,
                                        }
                                    }
                                }
                            } else {
                                eprintln!("agent request ({summary}) denied");
                                CredentialRequestReply {
                                    approved: false,
                                    credential: None,
                                    credential_id: None,
                                }
                            };
                            let _ = reply.send(response);
                        }
                    }
                }
            }
        }
        Ok(())
    });

    Ok(UserAgent { token, task })
}

fn prompt_yes(summary: &str) -> bool {
    eprint!("Approve credential request ({summary})? [y/N] ");
    let _ = io::stderr().flush();
    let mut line = String::new();
    if io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

fn to_core_query(query: &CredentialQuery) -> AgentQuery {
    match query {
        CredentialQuery::Domain(value) => AgentQuery::Domain(value.clone()),
        CredentialQuery::Id(value) => AgentQuery::Id(value.clone()),
        CredentialQuery::Search(value) => AgentQuery::Search(value.clone()),
    }
}

fn to_sdk(cred: &AgentCredential) -> CredentialData {
    CredentialData {
        username: cred.username.clone(),
        password: cred.password.clone().map(Zeroizing::new),
        totp: cred.totp.clone(),
        uri: cred.uri.clone(),
        notes: cred.notes.clone(),
        credential_id: cred.credential_id.clone(),
        domain: cred.domain.clone(),
    }
}

/// A paired remote session. Further requests reuse the Noise transport.
pub struct RemoteSession {
    client: RemoteClient,
    _drain: JoinHandle<()>,
}

impl RemoteSession {
    pub async fn pair(
        relay_url: &str,
        identity: IdentityKeyPair,
        token: &str,
    ) -> Result<Self, String> {
        let parsed = PskToken::parse(token).map_err(|e| format!("invalid PSK token: {e}"))?;
        let (psk, fingerprint) = parsed.into_parts();
        let relay = Box::new(RustlsRelayClient::new(relay_url.to_string()));
        let handle = RemoteClient::connect(
            Box::new(MemoryIdentityProvider::from_keypair(identity)),
            Box::new(MemoryConnectionStore::new()),
            relay,
        )
        .await
        .map_err(|e| format!("remote client failed to join the relay: {e}"))?;

        let mut notifications = handle.notifications;
        let mut requests = handle.requests;
        let drain = tokio::spawn(async move {
            loop {
                tokio::select! {
                    note = notifications.recv() => {
                        if note.is_none() { break; }
                    }
                    req = requests.recv() => {
                        match req {
                            Some(ap_client::RemoteClientRequest::VerifyFingerprint { reply, .. }) => {
                                let _ = reply.send(ap_client::RemoteClientFingerprintReply { approved: true });
                            }
                            None => break,
                        }
                    }
                }
            }
        });

        handle
            .client
            .pair_with_psk(psk, fingerprint)
            .await
            .map_err(|e| format!("PSK handshake failed: {e}"))?;
        Ok(Self {
            client: handle.client,
            _drain: drain,
        })
    }

    pub async fn request(
        &self,
        query: &CredentialQuery,
        timeout: Duration,
    ) -> Result<CredentialData, String> {
        self.client
            .request_credential(query, Some(timeout))
            .await
            .map_err(|e| format!("credential request failed: {e}"))
    }
}

/// Pair with a PSK token and request one credential.
pub async fn connect_and_request(
    relay_url: &str,
    identity: IdentityKeyPair,
    token: &str,
    query: CredentialQuery,
    timeout: Duration,
) -> Result<CredentialData, String> {
    let session = RemoteSession::pair(relay_url, identity, token).await?;
    session.request(&query, timeout).await
}

/// Environment injected by `np agent run --env-all`.
pub fn env_all(cred: &CredentialData) -> Vec<(String, String)> {
    let mut out = Vec::new();
    push_env(&mut out, "NP_USERNAME", cred.username.as_deref());
    push_env(
        &mut out,
        "NP_PASSWORD",
        cred.password.as_ref().map(|p| p.as_str()),
    );
    push_env(&mut out, "NP_TOTP", cred.totp.as_deref());
    push_env(&mut out, "NP_URI", cred.uri.as_deref());
    push_env(&mut out, "NP_NOTES", cred.notes.as_deref());
    push_env(&mut out, "NP_DOMAIN", cred.domain.as_deref());
    push_env(&mut out, "NP_CREDENTIAL_ID", cred.credential_id.as_deref());
    out
}

fn push_env(out: &mut Vec<(String, String)>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        out.push((key.to_string(), value.to_string()));
    }
}

/// Resolve `KEY=field` mappings against a credential. `field` is one of
/// `username`, `password`, `totp`, `uri`, `notes`, `domain`, `credential_id`.
pub fn env_mapping(cred: &CredentialData, spec: &str) -> Result<(String, String), String> {
    let (key, field) = spec
        .split_once('=')
        .ok_or_else(|| format!("expected KEY=field, got \"{spec}\""))?;
    let key = key.trim();
    if key.is_empty() || key.contains('\0') || key.contains('=') {
        return Err(format!("invalid environment name in \"{spec}\""));
    }
    let value = field_value(cred, field.trim())?;
    Ok((key.to_string(), value))
}

fn field_value(cred: &CredentialData, field: &str) -> Result<String, String> {
    let norm: String = field
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();
    let value = match norm.as_str() {
        "username" => cred.username.clone(),
        "password" => cred.password.as_ref().map(|p| p.to_string()),
        "totp" => cred.totp.clone(),
        "uri" | "url" => cred.uri.clone(),
        "notes" | "note" => cred.notes.clone(),
        "domain" => cred.domain.clone(),
        "credentialid" | "id" => cred.credential_id.clone(),
        _ => {
            return Err(format!(
                "unknown credential field \"{field}\" (username, password, totp, uri, notes, domain, credential_id)"
            ))
        }
    };
    value.ok_or_else(|| format!("credential has no {field}"))
}

/// Pair, fetch one credential, and return the env pairs for a child process.
pub async fn run_with_credential(
    relay_url: &str,
    identity: IdentityKeyPair,
    token: &str,
    query: CredentialQuery,
    env_all_fields: bool,
    mappings: &[String],
) -> Result<Vec<(String, String)>, String> {
    if !env_all_fields && mappings.is_empty() {
        return Err("np agent run requires --env-all or at least one --env KEY=field".into());
    }
    let cred =
        connect_and_request(relay_url, identity, token, query, Duration::from_secs(120)).await?;
    let mut pairs = Vec::new();
    if env_all_fields {
        pairs.extend(env_all(&cred));
    }
    for spec in mappings {
        let (key, value) = env_mapping(&cred, spec)?;
        if let Some(existing) = pairs.iter_mut().find(|(k, _)| k == &key) {
            existing.1 = value;
        } else {
            pairs.push((key, value));
        }
    }
    Ok(pairs)
}

/// Build a resolver over an in-memory item list. Used by tests and by the CLI
/// after it has decrypted the vault.
pub fn resolve_items(
    items: &[nonepwd_core::types::VaultItemPayload],
    query: &AgentQuery,
    now_ms: u64,
) -> Result<AgentCredential, String> {
    let refs: Vec<&nonepwd_core::types::VaultItemPayload> = items.iter().collect();
    let item = lookup_agent_item(&refs, query).map_err(|err| match err {
        AgentLookupError::NotFound => "no matching credential".to_string(),
        other => other.to_string(),
    })?;
    map_agent_credential(item, now_ms)
}
