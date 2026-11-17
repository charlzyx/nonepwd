use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, OriginalUri, Path as AxumPath, Query, Request, State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use nonepwd_core::generator::generate_email_alias;
use nonepwd_core::otp_extractor::extract_email_address;
use nonepwd_core::random::{fill_random, random_id};
use nonepwd_core::types::SealedEnvelope;
use percent_encoding::percent_decode_str;
use rusqlite::{params, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{
    authenticate_token, create_session, extract_bearer_token, hash_secret, now_iso_millis,
    verify_secret, verify_webhook_hmac, AuthContext,
};
use crate::db::{EmailFilterConfig, NonePwdDb};
use crate::email_ingest::{ingest_pre_sealed_email, ingest_raw_email, ingest_simulated_email};
use crate::imap::ImapWorker;
use crate::ws::{BroadcastOptions, WsHub};

const OWNER_SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const SA_SESSION_TTL_MS: i64 = 24 * 60 * 60 * 1000;

const ALLOWED_CLI_BINARIES: &[&str] = &[
    "np",
    "np-darwin-arm64",
    "np-darwin-x86_64",
    "np-linux-x86_64",
    "np-linux-arm64",
    "nonepwd-extension.zip",
];

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<NonePwdDb>,
    pub ws_hub: Arc<WsHub>,
    pub imap_worker: Arc<ImapWorker>,
    pub web_dist_dir: PathBuf,
    pub bin_dist_dirs: Vec<PathBuf>,
}

fn json_err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

fn parse_json_body<T: DeserializeOwned>(bytes: &Bytes) -> Result<T, Response> {
    serde_json::from_slice(bytes)
        .map_err(|e| json_err(StatusCode::BAD_REQUEST, format!("Invalid JSON body: {e}")))
}

fn get_auth(db: &NonePwdDb, headers: &HeaderMap) -> Option<AuthContext> {
    let auth_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let token = extract_bearer_token(auth_header);
    authenticate_token(db, token.as_deref())
}

fn require_auth(db: &NonePwdDb, headers: &HeaderMap) -> Result<AuthContext, Response> {
    get_auth(db, headers).ok_or_else(|| json_err(StatusCode::UNAUTHORIZED, "Unauthorized"))
}

fn require_owner(db: &NonePwdDb, headers: &HeaderMap) -> Result<AuthContext, Response> {
    let auth = require_auth(db, headers)?;
    match auth {
        AuthContext::Owner { .. } => Ok(auth),
        AuthContext::ServiceAccount { .. } => {
            Err(json_err(StatusCode::FORBIDDEN, "Owner authorization required"))
        }
    }
}

fn random_hex_32() -> Result<String, Response> {
    let mut b = [0u8; 32];
    fill_random(&mut b)
        .map_err(|e| json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("RNG error: {e}")))?;
    Ok(hex::encode(b))
}

async fn api_cors_middleware(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let is_api = path == "/api" || path.starts_with("/api/");

    if is_api && req.method() == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        attach_cors_headers(res.headers_mut());
        return res;
    }

    let mut res = next.run(req).await;
    if is_api {
        attach_cors_headers(res.headers_mut());
    }
    res
}

fn attach_cors_headers(headers: &mut HeaderMap) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "Content-Type, Authorization, X-NonePwd-Timestamp, X-NonePwd-Signature, X-NonePwd-Envelope-From, X-NonePwd-Envelope-To",
        ),
    );
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(handle_health))
        .route("/api/auth/params", get(handle_auth_params))
        .route("/api/auth/setup", post(handle_auth_setup))
        .route("/api/auth/login", post(handle_auth_login))
        .route("/api/auth/service-account", post(handle_auth_service_account))
        .route("/api/auth/logout", post(handle_auth_logout))
        .route("/api/sync", get(handle_sync))
        .route("/api/vaults", get(handle_get_vaults).post(handle_create_vault))
        .route(
            "/api/vaults/{id}",
            patch(handle_patch_vault).delete(handle_delete_vault),
        )
        .route(
            "/api/vaults/{vault_id}/items",
            get(handle_get_items).post(handle_create_item),
        )
        .route(
            "/api/vaults/{vault_id}/items/batch",
            post(handle_batch_items),
        )
        .route(
            "/api/vaults/{vault_id}/items/{item_id}",
            put(handle_put_item).delete(handle_delete_item),
        )
        .route(
            "/api/aliases",
            get(handle_get_aliases).post(handle_create_alias),
        )
        .route(
            "/api/aliases/{id}",
            patch(handle_patch_alias).delete(handle_delete_alias),
        )
        .route("/api/emails", get(handle_get_emails))
        .route("/api/emails/{id}", delete(handle_delete_email))
        .route("/api/emails/simulate", post(handle_simulate_email))
        .route(
            "/api/email-filter",
            get(handle_get_email_filter).put(handle_put_email_filter),
        )
        .route(
            "/api/service-accounts",
            get(handle_get_service_accounts).post(handle_create_service_account),
        )
        .route(
            "/api/service-accounts/{id}",
            delete(handle_delete_service_account),
        )
        .route(
            "/api/settings",
            get(handle_get_settings).patch(handle_patch_settings),
        )
        .route("/api/imap", get(handle_get_imap).put(handle_put_imap))
        .route("/api/imap/test", post(handle_test_imap))
        .route("/api/imap/sync", post(handle_sync_imap))
        .route("/api/webhooks/email/cf", post(handle_cf_webhook))
        .route("/api/ws", get(handle_ws_upgrade))
        .route("/install.sh", get(handle_install_sh))
        .route("/downloads/{filename}", get(handle_download))
        .fallback(handle_fallback)
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(middleware::from_fn(api_cors_middleware))
        .with_state(state)
}

async fn handle_health(State(state): State<AppState>) -> Response {
    let initialized = {
        let conn = state.db.lock_conn();
        conn.query_row("SELECT id FROM account WHERE id = 1", [], |r| r.get::<_, i64>(0))
            .optional()
            .ok()
            .flatten()
            .is_some()
    };
    Json(json!({
        "ok": true,
        "initialized": initialized,
        "version": "0.1.0",
    }))
    .into_response()
}

async fn handle_auth_params(State(state): State<AppState>) -> Response {
    let row: Option<(String, String, i64)> = {
        let conn = state.db.lock_conn();
        conn.query_row(
            "SELECT email, kdf_salt, kdf_iterations FROM account WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .ok()
        .flatten()
    };

    match row {
        None => Json(json!({ "initialized": false })).into_response(),
        Some((email, kdf_salt, kdf_iterations)) => Json(json!({
            "initialized": true,
            "email": email,
            "kdfSalt": kdf_salt,
            "kdfIterations": kdf_iterations,
        }))
        .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupVaultInput {
    id: String,
    encrypted_key: String,
    encrypted_meta: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupBody {
    email: Option<String>,
    kdf_salt: Option<String>,
    kdf_iterations: Option<i64>,
    auth_verifier: Option<String>,
    encrypted_root_keyset: Option<String>,
    email_public_key: Option<String>,
    alias_domain: Option<String>,
    vaults: Option<Vec<SetupVaultInput>>,
}

async fn handle_auth_setup(State(state): State<AppState>, body_bytes: Bytes) -> Response {
    let body: SetupBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };

    let email = body.email.unwrap_or_default().trim().to_ascii_lowercase();
    let kdf_salt = body.kdf_salt.unwrap_or_default();
    let kdf_iterations = body.kdf_iterations.unwrap_or(0);
    let auth_verifier = body.auth_verifier.unwrap_or_default();
    let encrypted_root_keyset = body.encrypted_root_keyset.unwrap_or_default();
    let email_public_key = body.email_public_key.unwrap_or_default();

    if email.is_empty()
        || kdf_salt.is_empty()
        || kdf_iterations <= 0
        || auth_verifier.is_empty()
        || encrypted_root_keyset.is_empty()
        || email_public_key.is_empty()
    {
        return json_err(StatusCode::BAD_REQUEST, "Missing required setup fields");
    }

    let now = now_iso_millis();
    let cf_webhook_secret = match random_hex_32() {
        Ok(s) => s,
        Err(res) => return res,
    };
    let auth_hash = match hash_secret(&auth_verifier) {
        Ok(h) => h,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let alias_domain = body
        .alias_domain
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    {
        let conn = state.db.lock_conn();
        if let Err(e) = conn.execute_batch("BEGIN IMMEDIATE") {
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}"));
        }

        let existing: Option<i64> = conn
            .query_row("SELECT id FROM account WHERE id = 1", [], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        if existing.is_some() {
            let _ = conn.execute_batch("ROLLBACK");
            return json_err(StatusCode::CONFLICT, "Account already initialized");
        }

        let insert_res = (|| -> Result<(), rusqlite::Error> {
            conn.execute(
                "INSERT INTO account
                 (id, email, kdf_salt, kdf_iterations, auth_verifier_hash, encrypted_root_keyset, email_public_key, cf_webhook_secret, alias_domain, created_at)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    email,
                    kdf_salt,
                    kdf_iterations,
                    auth_hash,
                    encrypted_root_keyset,
                    email_public_key,
                    cf_webhook_secret,
                    alias_domain,
                    now
                ],
            )?;

            if let Some(vaults) = body.vaults {
                let mut stmt = conn.prepare(
                    "INSERT INTO vaults (id, encrypted_key, encrypted_meta, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )?;
                for v in vaults {
                    stmt.execute(params![v.id, v.encrypted_key, v.encrypted_meta, now, now])?;
                }
            }

            conn.execute_batch("COMMIT")
        })();

        if let Err(e) = insert_res {
            let _ = conn.execute_batch("ROLLBACK");
            return json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Setup transaction failed: {e}"),
            );
        }
    }

    let token = match create_session(&state.db, "owner", None, OWNER_SESSION_TTL_MS) {
        Ok(t) => t,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    (
        StatusCode::CREATED,
        Json(json!({
            "token": token,
            "account": {
                "email": email,
                "emailPublicKey": email_public_key,
                "cfWebhookSecret": cf_webhook_secret,
                "aliasDomain": alias_domain,
            }
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    auth_verifier: Option<String>,
}

async fn handle_auth_login(State(state): State<AppState>, body_bytes: Bytes) -> Response {
    let body: LoginBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };
    let auth_verifier = body.auth_verifier.unwrap_or_default();
    if auth_verifier.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "Missing authVerifier");
    }

    let row = {
        let conn = state.db.lock_conn();
        conn.query_row(
            "SELECT email, kdf_salt, kdf_iterations, auth_verifier_hash, encrypted_root_keyset,
                    email_public_key, cf_webhook_secret, alias_domain
             FROM account WHERE id = 1",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten()
    };

    let Some((
        email,
        kdf_salt,
        kdf_iterations,
        auth_verifier_hash,
        encrypted_root_keyset,
        email_public_key,
        cf_webhook_secret,
        alias_domain,
    )) = row
    else {
        return json_err(StatusCode::NOT_FOUND, "Account not initialized");
    };

    if !verify_secret(&auth_verifier, &auth_verifier_hash) {
        return json_err(StatusCode::UNAUTHORIZED, "Invalid credentials");
    }

    let token = match create_session(&state.db, "owner", None, OWNER_SESSION_TTL_MS) {
        Ok(t) => t,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    Json(json!({
        "token": token,
        "account": {
            "email": email,
            "kdfSalt": kdf_salt,
            "kdfIterations": kdf_iterations,
            "encryptedRootKeyset": encrypted_root_keyset,
            "emailPublicKey": email_public_key,
            "cfWebhookSecret": cf_webhook_secret,
            "aliasDomain": alias_domain,
        }
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceAccountAuthBody {
    token_id: Option<String>,
    auth_secret: Option<String>,
}

async fn handle_auth_service_account(
    State(state): State<AppState>,
    body_bytes: Bytes,
) -> Response {
    let body: ServiceAccountAuthBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };
    let token_id = body.token_id.unwrap_or_default();
    let auth_secret = body.auth_secret.unwrap_or_default();
    if token_id.is_empty() || auth_secret.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "Missing tokenId or authSecret");
    }

    let sa = {
        let conn = state.db.lock_conn();
        conn.query_row(
            "SELECT id, name, auth_secret_hash FROM service_accounts WHERE id = ?1",
            params![token_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .ok()
        .flatten()
    };

    let Some((sa_id, sa_name, sa_hash)) = sa else {
        return json_err(StatusCode::UNAUTHORIZED, "Invalid Service Account token");
    };
    if !verify_secret(&auth_secret, &sa_hash) {
        return json_err(StatusCode::UNAUTHORIZED, "Invalid Service Account token");
    }

    let vaults = {
        let conn = state.db.lock_conn();
        let _ = conn.execute(
            "UPDATE service_accounts SET last_used_at = ?1 WHERE id = ?2",
            params![now_iso_millis(), sa_id],
        );
        query_sa_vaults(&conn, &sa_id)
    };

    let token = match create_session(&state.db, "service_account", Some(&sa_id), SA_SESSION_TTL_MS)
    {
        Ok(t) => t,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    Json(json!({
        "token": token,
        "serviceAccount": { "id": sa_id, "name": sa_name },
        "vaults": vaults,
    }))
    .into_response()
}

async fn handle_auth_logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(auth) = get_auth(&state.db, &headers) {
        let conn = state.db.lock_conn();
        let _ = conn.execute(
            "DELETE FROM sessions WHERE token_hash = ?1",
            params![auth.token_hash()],
        );
    }
    Json(json!({ "ok": true })).into_response()
}

fn query_sa_vaults(conn: &rusqlite::Connection, sa_id: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT v.id, sav.encrypted_vault_key, v.encrypted_meta, v.created_at, v.updated_at
         FROM vaults v
         JOIN service_account_vaults sav ON sav.vault_id = v.id
         WHERE sav.service_account_id = ?1
         ORDER BY v.created_at ASC",
    ) else {
        return out;
    };
    if let Ok(rows) = stmt.query_map(params![sa_id], |r| {
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "encryptedKey": r.get::<_, String>(1)?,
            "encryptedMeta": r.get::<_, String>(2)?,
            "createdAt": r.get::<_, String>(3)?,
            "updatedAt": r.get::<_, String>(4)?,
        }))
    }) {
        out.extend(rows.flatten());
    }
    out
}

fn query_owner_vaults(conn: &rusqlite::Connection) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, encrypted_key, encrypted_meta, created_at, updated_at
         FROM vaults ORDER BY created_at ASC",
    ) else {
        return out;
    };
    if let Ok(rows) = stmt.query_map([], |r| {
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "encryptedKey": r.get::<_, String>(1)?,
            "encryptedMeta": r.get::<_, String>(2)?,
            "createdAt": r.get::<_, String>(3)?,
            "updatedAt": r.get::<_, String>(4)?,
        }))
    }) {
        out.extend(rows.flatten());
    }
    out
}

fn query_aliases(conn: &rusqlite::Connection) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, address, site_domain, vault_id, item_id, enabled, received_count, created_at
         FROM aliases ORDER BY created_at DESC",
    ) else {
        return out;
    };
    if let Ok(rows) = stmt.query_map([], |r| {
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "address": r.get::<_, String>(1)?,
            "siteDomain": r.get::<_, Option<String>>(2)?,
            "vaultId": r.get::<_, Option<String>>(3)?,
            "itemId": r.get::<_, Option<String>>(4)?,
            "enabled": r.get::<_, i64>(5)? != 0,
            "receivedCount": r.get::<_, i64>(6)?,
            "createdAt": r.get::<_, String>(7)?,
        }))
    }) {
        out.extend(rows.flatten());
    }
    out
}

fn query_emails(conn: &rusqlite::Connection) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, source, envelope_to, has_otp, sealed_envelope, received_at
         FROM encrypted_emails ORDER BY received_at DESC LIMIT 100",
    ) else {
        return out;
    };
    if let Ok(rows) = stmt.query_map([], |r| {
        let sealed_str: String = r.get(4)?;
        let sealed_val: Value = serde_json::from_str(&sealed_str).unwrap_or(Value::Null);
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "source": r.get::<_, String>(1)?,
            "envelopeTo": r.get::<_, Option<String>>(2)?,
            "hasOtp": r.get::<_, i64>(3)? != 0,
            "sealedEnvelope": sealed_val,
            "receivedAt": r.get::<_, String>(5)?,
        }))
    }) {
        out.extend(rows.flatten());
    }
    out
}

async fn handle_sync(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let auth = match require_auth(&state.db, &headers) {
        Ok(a) => a,
        Err(res) => return res,
    };

    if let AuthContext::ServiceAccount {
        service_account_id, ..
    } = auth
    {
        let (vaults, items) = {
            let conn = state.db.lock_conn();
            let vaults = query_sa_vaults(&conn, &service_account_id);
            let mut items = Vec::new();
            if let Ok(mut stmt) = conn.prepare(
                "SELECT i.id, i.vault_id, i.encrypted_data, i.created_at, i.updated_at, i.version
                 FROM items i
                 JOIN service_account_vaults sav ON sav.vault_id = i.vault_id
                 WHERE sav.service_account_id = ?1
                 ORDER BY i.updated_at DESC",
            ) {
                if let Ok(rows) = stmt.query_map(params![service_account_id], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "vaultId": r.get::<_, String>(1)?,
                        "encryptedData": r.get::<_, String>(2)?,
                        "createdAt": r.get::<_, String>(3)?,
                        "updatedAt": r.get::<_, String>(4)?,
                        "version": r.get::<_, i64>(5)?,
                    }))
                }) {
                    items.extend(rows.flatten());
                }
            }
            (vaults, items)
        };

        return Json(json!({
            "kind": "service_account",
            "vaults": vaults,
            "items": items,
        }))
        .into_response();
    }

    let email_filter = state.db.get_email_filter();
    let imap_status = state.imap_worker.get_public_config();

    let (account, vaults, items, aliases, emails) = {
        let conn = state.db.lock_conn();
        let account = conn
            .query_row(
                "SELECT email, encrypted_root_keyset, email_public_key, cf_webhook_secret, alias_domain
                 FROM account WHERE id = 1",
                [],
                |r| {
                    Ok(json!({
                        "email": r.get::<_, String>(0)?,
                        "encryptedRootKeyset": r.get::<_, String>(1)?,
                        "emailPublicKey": r.get::<_, String>(2)?,
                        "cfWebhookSecret": r.get::<_, String>(3)?,
                        "aliasDomain": r.get::<_, String>(4)?,
                    }))
                },
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or(Value::Null);

        let vaults = query_owner_vaults(&conn);
        let mut items = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT id, vault_id, encrypted_data, created_at, updated_at, version
             FROM items ORDER BY updated_at DESC",
        ) {
            if let Ok(rows) = stmt.query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "vaultId": r.get::<_, String>(1)?,
                    "encryptedData": r.get::<_, String>(2)?,
                    "createdAt": r.get::<_, String>(3)?,
                    "updatedAt": r.get::<_, String>(4)?,
                    "version": r.get::<_, i64>(5)?,
                }))
            }) {
                items.extend(rows.flatten());
            }
        }
        let aliases = query_aliases(&conn);
        let emails = query_emails(&conn);
        (account, vaults, items, aliases, emails)
    };

    Json(json!({
        "kind": "owner",
        "account": account,
        "vaults": vaults,
        "items": items,
        "aliases": aliases,
        "emails": emails,
        "imapStatus": imap_status,
        "emailFilter": email_filter,
    }))
    .into_response()
}

async fn handle_get_vaults(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let auth = match require_auth(&state.db, &headers) {
        Ok(a) => a,
        Err(res) => return res,
    };

    let vaults = {
        let conn = state.db.lock_conn();
        match auth {
            AuthContext::ServiceAccount {
                service_account_id, ..
            } => query_sa_vaults(&conn, &service_account_id),
            AuthContext::Owner { .. } => query_owner_vaults(&conn),
        }
    };

    Json(json!({ "vaults": vaults })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateVaultBody {
    id: Option<String>,
    encrypted_key: Option<String>,
    encrypted_meta: Option<String>,
}

async fn handle_create_vault(
    State(state): State<AppState>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let body: CreateVaultBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };
    let encrypted_key = body.encrypted_key.unwrap_or_default();
    let encrypted_meta = body.encrypted_meta.unwrap_or_default();
    if encrypted_key.is_empty() || encrypted_meta.is_empty() {
        return json_err(
            StatusCode::BAD_REQUEST,
            "Missing encryptedKey or encryptedMeta",
        );
    }

    let id = match body.id.filter(|s| !s.is_empty()) {
        Some(id) => id,
        None => match random_id() {
            Ok(id) => id,
            Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
        },
    };
    let now = now_iso_millis();

    {
        let conn = state.db.lock_conn();
        if let Err(e) = conn.execute(
            "INSERT INTO vaults (id, encrypted_key, encrypted_meta, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, encrypted_key, encrypted_meta, now, now],
        ) {
            return json_err(StatusCode::CONFLICT, format!("Failed creating vault: {e}"));
        }
    }

    let vault = json!({
        "id": id,
        "encryptedKey": encrypted_key,
        "encryptedMeta": encrypted_meta,
        "createdAt": now,
        "updatedAt": now,
    });
    state.ws_hub.broadcast(
        &json!({ "type": "vault.upserted", "vault": vault }),
        BroadcastOptions {
            vault_id: None,
            owner_only: true,
        },
    );

    (StatusCode::CREATED, Json(json!({ "vault": vault }))).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchVaultBody {
    encrypted_meta: Option<String>,
    encrypted_key: Option<String>,
}

async fn handle_patch_vault(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(vault_id): AxumPath<String>,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let body: PatchVaultBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };

    let vault = {
        let conn = state.db.lock_conn();
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM vaults WHERE id = ?1",
                params![vault_id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if exists.is_none() {
            return json_err(StatusCode::NOT_FOUND, "Vault not found");
        }

        let now = now_iso_millis();
        if let Some(meta) = body.encrypted_meta.filter(|s| !s.is_empty()) {
            let _ = conn.execute(
                "UPDATE vaults SET encrypted_meta = ?1, updated_at = ?2 WHERE id = ?3",
                params![meta, now, vault_id],
            );
        }
        if let Some(key) = body.encrypted_key.filter(|s| !s.is_empty()) {
            let _ = conn.execute(
                "UPDATE vaults SET encrypted_key = ?1, updated_at = ?2 WHERE id = ?3",
                params![key, now, vault_id],
            );
        }

        conn.query_row(
            "SELECT id, encrypted_key, encrypted_meta, created_at, updated_at
             FROM vaults WHERE id = ?1",
            params![vault_id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "encryptedKey": r.get::<_, String>(1)?,
                    "encryptedMeta": r.get::<_, String>(2)?,
                    "createdAt": r.get::<_, String>(3)?,
                    "updatedAt": r.get::<_, String>(4)?,
                }))
            },
        )
        .unwrap_or(Value::Null)
    };

    state.ws_hub.broadcast(
        &json!({ "type": "vault.upserted", "vault": vault }),
        BroadcastOptions {
            vault_id: Some(vault_id),
            owner_only: false,
        },
    );

    Json(json!({ "vault": vault })).into_response()
}

async fn handle_delete_vault(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(vault_id): AxumPath<String>,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let changes = {
        let conn = state.db.lock_conn();
        conn.execute("DELETE FROM vaults WHERE id = ?1", params![vault_id])
            .unwrap_or(0)
    };
    if changes == 0 {
        return json_err(StatusCode::NOT_FOUND, "Vault not found");
    }

    state.ws_hub.broadcast(
        &json!({ "type": "vault.deleted", "vaultId": vault_id }),
        BroadcastOptions {
            vault_id: None,
            owner_only: true,
        },
    );
    Json(json!({ "ok": true })).into_response()
}

async fn handle_get_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(vault_id): AxumPath<String>,
) -> Response {
    let auth = match require_auth(&state.db, &headers) {
        Ok(a) => a,
        Err(res) => return res,
    };
    if let AuthContext::ServiceAccount {
        allowed_vault_ids, ..
    } = auth
    {
        if !allowed_vault_ids.contains(&vault_id) {
            return json_err(
                StatusCode::FORBIDDEN,
                "Vault not authorized for this Service Account",
            );
        }
    }

    let items = {
        let conn = state.db.lock_conn();
        let mut out = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT id, vault_id, encrypted_data, created_at, updated_at, version
             FROM items WHERE vault_id = ?1 ORDER BY updated_at DESC",
        ) {
            if let Ok(rows) = stmt.query_map(params![vault_id], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "vaultId": r.get::<_, String>(1)?,
                    "encryptedData": r.get::<_, String>(2)?,
                    "createdAt": r.get::<_, String>(3)?,
                    "updatedAt": r.get::<_, String>(4)?,
                    "version": r.get::<_, i64>(5)?,
                }))
            }) {
                out.extend(rows.flatten());
            }
        }
        out
    };

    Json(json!({ "items": items })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateItemBody {
    id: Option<String>,
    encrypted_data: Option<String>,
}

async fn handle_create_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(vault_id): AxumPath<String>,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let body: CreateItemBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };
    let encrypted_data = body.encrypted_data.unwrap_or_default();
    if encrypted_data.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "Missing encryptedData");
    }

    let id = match body.id.filter(|s| !s.is_empty()) {
        Some(id) => id,
        None => match random_id() {
            Ok(id) => id,
            Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
        },
    };
    let now = now_iso_millis();

    {
        let conn = state.db.lock_conn();
        let vault_exists: Option<String> = conn
            .query_row(
                "SELECT id FROM vaults WHERE id = ?1",
                params![vault_id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if vault_exists.is_none() {
            return json_err(StatusCode::NOT_FOUND, "Vault not found");
        }

        if let Err(e) = conn.execute(
            "INSERT INTO items (id, vault_id, encrypted_data, created_at, updated_at, version)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)",
            params![id, vault_id, encrypted_data, now, now],
        ) {
            return json_err(StatusCode::CONFLICT, format!("Failed creating item: {e}"));
        }
    }

    let item = json!({
        "id": id,
        "vaultId": vault_id,
        "encryptedData": encrypted_data,
        "createdAt": now,
        "updatedAt": now,
        "version": 1,
    });
    state.ws_hub.broadcast(
        &json!({ "type": "item.upserted", "item": item }),
        BroadcastOptions {
            vault_id: Some(vault_id),
            owner_only: false,
        },
    );

    (StatusCode::CREATED, Json(json!({ "item": item }))).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchItemsBody {
    items: Option<Vec<CreateItemBody>>,
}

async fn handle_batch_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(vault_id): AxumPath<String>,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    {
        let conn = state.db.lock_conn();
        let vault_exists: Option<String> = conn
            .query_row(
                "SELECT id FROM vaults WHERE id = ?1",
                params![vault_id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if vault_exists.is_none() {
            return json_err(StatusCode::NOT_FOUND, "Vault not found");
        }
    }

    let body: BatchItemsBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };

    let Some(entries) = body.items.filter(|v| !v.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "Missing non-empty items array");
    };
    for entry in &entries {
        if entry.encrypted_data.as_deref().unwrap_or("").is_empty() {
            return json_err(StatusCode::BAD_REQUEST, "Each item requires encryptedData");
        }
    }

    let now = now_iso_millis();
    let mut inserted = Vec::with_capacity(entries.len());

    {
        let conn = state.db.lock_conn();
        if let Err(e) = conn.execute_batch("BEGIN IMMEDIATE") {
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}"));
        }

        let tx_res = (|| -> Result<(), String> {
            let mut stmt = conn
                .prepare(
                    "INSERT OR REPLACE INTO items (id, vault_id, encrypted_data, created_at, updated_at, version)
                     VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                )
                .map_err(|e| e.to_string())?;

            for entry in entries {
                let id = match entry.id.filter(|s| !s.is_empty()) {
                    Some(id) => id,
                    None => random_id()?,
                };
                let encrypted_data = entry.encrypted_data.unwrap_or_default();
                stmt.execute(params![id, vault_id, encrypted_data, now, now])
                    .map_err(|e| e.to_string())?;
                inserted.push(json!({
                    "id": id,
                    "vaultId": vault_id,
                    "encryptedData": encrypted_data,
                    "createdAt": now,
                    "updatedAt": now,
                    "version": 1,
                }));
            }
            drop(stmt);
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())
        })();

        if let Err(e) = tx_res {
            let _ = conn.execute_batch("ROLLBACK");
            return json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Batch insert failed: {e}"),
            );
        }
    }

    let count = inserted.len();
    state.ws_hub.broadcast(
        &json!({ "type": "item.upserted", "count": count }),
        BroadcastOptions {
            vault_id: Some(vault_id),
            owner_only: false,
        },
    );

    (
        StatusCode::CREATED,
        Json(json!({
            "imported": count,
            "items": inserted,
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutItemBody {
    encrypted_data: Option<String>,
}

async fn handle_put_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((vault_id, item_id)): AxumPath<(String, String)>,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let body: PutItemBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };
    let encrypted_data = body.encrypted_data.unwrap_or_default();
    if encrypted_data.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "Missing encryptedData");
    }

    let now = now_iso_millis();
    let (created_at, version) = {
        let conn = state.db.lock_conn();
        let existing: Option<(String, i64)> = conn
            .query_row(
                "SELECT created_at, version FROM items WHERE id = ?1 AND vault_id = ?2",
                params![item_id, vault_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .ok()
            .flatten();

        if let Some((created_at, old_ver)) = existing {
            let next_ver = old_ver + 1;
            if let Err(e) = conn.execute(
                "UPDATE items SET encrypted_data = ?1, updated_at = ?2, version = ?3 WHERE id = ?4",
                params![encrypted_data, now, next_ver, item_id],
            ) {
                return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("DB error: {e}"));
            }
            (created_at, next_ver)
        } else {
            let vault_exists: Option<String> = conn
                .query_row(
                    "SELECT id FROM vaults WHERE id = ?1",
                    params![vault_id],
                    |r| r.get(0),
                )
                .optional()
                .ok()
                .flatten();
            if vault_exists.is_none() {
                return json_err(StatusCode::NOT_FOUND, "Vault not found");
            }
            if let Err(e) = conn.execute(
                "INSERT INTO items (id, vault_id, encrypted_data, created_at, updated_at, version)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                params![item_id, vault_id, encrypted_data, now, now],
            ) {
                return json_err(StatusCode::CONFLICT, format!("Failed inserting item: {e}"));
            }
            (now.clone(), 1)
        }
    };

    let item = json!({
        "id": item_id,
        "vaultId": vault_id,
        "encryptedData": encrypted_data,
        "createdAt": created_at,
        "updatedAt": now,
        "version": version,
    });
    state.ws_hub.broadcast(
        &json!({ "type": "item.upserted", "item": item }),
        BroadcastOptions {
            vault_id: Some(vault_id),
            owner_only: false,
        },
    );

    Json(json!({ "item": item })).into_response()
}

async fn handle_delete_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((vault_id, item_id)): AxumPath<(String, String)>,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let changes = {
        let conn = state.db.lock_conn();
        conn.execute(
            "DELETE FROM items WHERE id = ?1 AND vault_id = ?2",
            params![item_id, vault_id],
        )
        .unwrap_or(0)
    };
    if changes == 0 {
        return json_err(StatusCode::NOT_FOUND, "Item not found");
    }

    state.ws_hub.broadcast(
        &json!({
            "type": "item.deleted",
            "vaultId": vault_id,
            "itemId": item_id,
        }),
        BroadcastOptions {
            vault_id: Some(vault_id),
            owner_only: false,
        },
    );
    Json(json!({ "ok": true })).into_response()
}

async fn handle_get_aliases(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let aliases = {
        let conn = state.db.lock_conn();
        query_aliases(&conn)
    };
    Json(json!({ "aliases": aliases })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAliasBody {
    address: Option<String>,
    site_domain: Option<String>,
    vault_id: Option<String>,
    item_id: Option<String>,
}

async fn handle_create_alias(
    State(state): State<AppState>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let body: CreateAliasBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };

    let mut address = body.address.unwrap_or_default().trim().to_ascii_lowercase();
    if address.is_empty() {
        let domain: String = {
            let conn = state.db.lock_conn();
            conn.query_row("SELECT alias_domain FROM account WHERE id = 1", [], |r| {
                r.get(0)
            })
            .optional()
            .ok()
            .flatten()
            .unwrap_or_default()
        };
        if domain.is_empty() {
            return json_err(
                StatusCode::BAD_REQUEST,
                "No aliasDomain configured; provide explicit address",
            );
        }
        let site = body.site_domain.as_deref().unwrap_or("site");
        address = match generate_email_alias(site, &domain) {
            Ok(a) => a,
            Err(e) => return json_err(StatusCode::BAD_REQUEST, e),
        };
    }

    let id = match random_id() {
        Ok(id) => id,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let now = now_iso_millis();
    let site_domain = body
        .site_domain
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty());
    let vault_id = body.vault_id.filter(|s| !s.is_empty());
    let item_id = body.item_id.filter(|s| !s.is_empty());

    {
        let conn = state.db.lock_conn();
        if let Err(e) = conn.execute(
            "INSERT INTO aliases (id, address, site_domain, vault_id, item_id, enabled, received_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, ?6)",
            params![id, address, site_domain, vault_id, item_id, now],
        ) {
            return json_err(StatusCode::CONFLICT, format!("Alias already exists: {e}"));
        }
    }

    let alias = json!({
        "id": id,
        "address": address,
        "siteDomain": site_domain,
        "vaultId": vault_id,
        "itemId": item_id,
        "enabled": true,
        "receivedCount": 0,
        "createdAt": now,
    });
    state.ws_hub.broadcast(
        &json!({ "type": "alias.upserted", "alias": alias }),
        BroadcastOptions {
            vault_id: None,
            owner_only: true,
        },
    );

    (StatusCode::CREATED, Json(json!({ "alias": alias }))).into_response()
}

async fn handle_patch_alias(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let body: Value = match parse_json_body(&body_bytes) {
        Ok(v) => v,
        Err(res) => return res,
    };
    let Some(obj) = body.as_object() else {
        return json_err(StatusCode::BAD_REQUEST, "Expected JSON object");
    };

    let alias = {
        let conn = state.db.lock_conn();
        let existing = conn
            .query_row(
                "SELECT enabled, vault_id, item_id, site_domain FROM aliases WHERE id = ?1",
                params![id],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()
            .ok()
            .flatten();

        let Some((cur_enabled, cur_vault_id, cur_item_id, cur_site_domain)) = existing else {
            return json_err(StatusCode::NOT_FOUND, "Alias not found");
        };

        let enabled = match obj.get("enabled").and_then(Value::as_bool) {
            Some(b) => i64::from(b),
            None => cur_enabled,
        };
        let vault_id = match obj.get("vaultId") {
            None => cur_vault_id,
            Some(Value::Null) => None,
            Some(v) => v.as_str().map(str::to_string),
        };
        let item_id = match obj.get("itemId") {
            None => cur_item_id,
            Some(Value::Null) => None,
            Some(v) => v.as_str().map(str::to_string),
        };
        let site_domain = match obj.get("siteDomain") {
            None => cur_site_domain,
            Some(Value::Null) => None,
            Some(v) => v.as_str().map(str::to_string),
        };

        let _ = conn.execute(
            "UPDATE aliases SET enabled = ?1, vault_id = ?2, item_id = ?3, site_domain = ?4 WHERE id = ?5",
            params![enabled, vault_id, item_id, site_domain, id],
        );

        conn.query_row(
            "SELECT id, address, site_domain, vault_id, item_id, enabled, received_count, created_at
             FROM aliases WHERE id = ?1",
            params![id],
            |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "address": r.get::<_, String>(1)?,
                    "siteDomain": r.get::<_, Option<String>>(2)?,
                    "vaultId": r.get::<_, Option<String>>(3)?,
                    "itemId": r.get::<_, Option<String>>(4)?,
                    "enabled": r.get::<_, i64>(5)? != 0,
                    "receivedCount": r.get::<_, i64>(6)?,
                    "createdAt": r.get::<_, String>(7)?,
                }))
            },
        )
        .unwrap_or(Value::Null)
    };

    state.ws_hub.broadcast(
        &json!({ "type": "alias.upserted", "alias": alias }),
        BroadcastOptions {
            vault_id: None,
            owner_only: true,
        },
    );
    Json(json!({ "alias": alias })).into_response()
}

async fn handle_delete_alias(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let changes = {
        let conn = state.db.lock_conn();
        conn.execute("DELETE FROM aliases WHERE id = ?1", params![id])
            .unwrap_or(0)
    };
    if changes == 0 {
        return json_err(StatusCode::NOT_FOUND, "Alias not found");
    }

    state.ws_hub.broadcast(
        &json!({ "type": "alias.deleted", "id": id }),
        BroadcastOptions {
            vault_id: None,
            owner_only: true,
        },
    );
    Json(json!({ "ok": true })).into_response()
}

async fn handle_get_emails(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let emails = {
        let conn = state.db.lock_conn();
        query_emails(&conn)
    };
    Json(json!({ "emails": emails })).into_response()
}

async fn handle_delete_email(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let changes = {
        let conn = state.db.lock_conn();
        conn.execute("DELETE FROM encrypted_emails WHERE id = ?1", params![id])
            .unwrap_or(0)
    };
    if changes == 0 {
        return json_err(StatusCode::NOT_FOUND, "Email not found");
    }
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimulateEmailBody {
    from: Option<String>,
    to: Option<String>,
    subject: Option<String>,
    text: Option<String>,
    html: Option<String>,
}

async fn handle_simulate_email(
    State(state): State<AppState>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let body: SimulateEmailBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };

    let from = body.from.unwrap_or_default();
    let to = body.to.unwrap_or_default();
    let subject = body.subject.unwrap_or_default();
    if from.is_empty() || to.is_empty() || subject.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "Missing from, to, or subject");
    }

    match ingest_simulated_email(
        &state.db,
        &state.ws_hub,
        &from,
        &to,
        &subject,
        body.text,
        body.html,
    ) {
        Ok(result) => {
            let status = if result.accepted {
                StatusCode::CREATED
            } else {
                StatusCode::ACCEPTED
            };
            (status, Json(result)).into_response()
        }
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn handle_get_email_filter(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    Json(state.db.get_email_filter()).into_response()
}

async fn handle_put_email_filter(
    State(state): State<AppState>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let raw_val: Value = match parse_json_body(&body_bytes) {
        Ok(v) => v,
        Err(res) => return res,
    };
    let target_val = if raw_val.get("emailFilter").is_some()
        && raw_val.get("enabled").is_none()
        && raw_val.get("mode").is_none()
        && raw_val.get("rules").is_none()
    {
        raw_val["emailFilter"].clone()
    } else {
        raw_val
    };

    let cfg: EmailFilterConfig = match serde_json::from_value(target_val) {
        Ok(c) => c,
        Err(e) => {
            return json_err(
                StatusCode::BAD_REQUEST,
                format!("Invalid email filter payload: {e}"),
            )
        }
    };

    match state.db.save_email_filter(cfg) {
        Ok(saved) => Json(saved).into_response(),
        Err(e) => json_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn handle_get_service_accounts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let service_accounts = {
        let conn = state.db.lock_conn();
        let mut rows_vec = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT id, name, created_at, last_used_at FROM service_accounts ORDER BY created_at DESC",
        ) {
            if let Ok(rows) = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            }) {
                rows_vec.extend(rows.flatten());
            }
        }

        let mut out = Vec::with_capacity(rows_vec.len());
        if let Ok(mut vstmt) =
            conn.prepare("SELECT vault_id FROM service_account_vaults WHERE service_account_id = ?1")
        {
            for (id, name, created_at, last_used_at) in rows_vec {
                let mut vault_ids = Vec::new();
                if let Ok(vrows) = vstmt.query_map(params![id], |r| r.get::<_, String>(0)) {
                    vault_ids.extend(vrows.flatten());
                }
                out.push(json!({
                    "id": id,
                    "name": name,
                    "createdAt": created_at,
                    "lastUsedAt": last_used_at,
                    "vaultIds": vault_ids,
                }));
            }
        }
        out
    };

    Json(json!({ "serviceAccounts": service_accounts })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaVaultKeyInput {
    vault_id: String,
    encrypted_vault_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateServiceAccountBody {
    id: Option<String>,
    name: Option<String>,
    auth_secret: Option<String>,
    vault_keys: Option<Vec<SaVaultKeyInput>>,
}

async fn handle_create_service_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let body: CreateServiceAccountBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };

    let name = body.name.unwrap_or_default().trim().to_string();
    let auth_secret = body.auth_secret.unwrap_or_default();
    let Some(vault_keys) = body.vault_keys.filter(|v| !v.is_empty()) else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "Missing name, authSecret, or vaultKeys",
        );
    };
    if name.is_empty() || auth_secret.is_empty() {
        return json_err(
            StatusCode::BAD_REQUEST,
            "Missing name, authSecret, or vaultKeys",
        );
    }

    let id = match body.id.filter(|s| !s.is_empty()) {
        Some(id) => id,
        None => match random_id() {
            Ok(rid) => {
                let hex_part: String = rid.chars().filter(|c| *c != '-').take(16).collect();
                format!("sa_{hex_part}")
            }
            Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
        },
    };
    let now = now_iso_millis();
    let auth_secret_hash = match hash_secret(&auth_secret) {
        Ok(h) => h,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let vault_ids: Vec<String> = vault_keys.iter().map(|v| v.vault_id.clone()).collect();

    {
        let conn = state.db.lock_conn();
        if let Err(e) = conn.execute_batch("BEGIN IMMEDIATE") {
            return json_err(StatusCode::BAD_REQUEST, format!("DB error: {e}"));
        }

        let tx_res = (|| -> Result<(), rusqlite::Error> {
            conn.execute(
                "INSERT INTO service_accounts (id, name, auth_secret_hash, created_at, last_used_at)
                 VALUES (?1, ?2, ?3, ?4, NULL)",
                params![id, name, auth_secret_hash, now],
            )?;
            let mut stmt = conn.prepare(
                "INSERT INTO service_account_vaults (service_account_id, vault_id, encrypted_vault_key)
                 VALUES (?1, ?2, ?3)",
            )?;
            for vk in vault_keys {
                stmt.execute(params![id, vk.vault_id, vk.encrypted_vault_key])?;
            }
            conn.execute_batch("COMMIT")
        })();

        if let Err(e) = tx_res {
            let _ = conn.execute_batch("ROLLBACK");
            return json_err(
                StatusCode::BAD_REQUEST,
                format!("Failed creating service account: {e}"),
            );
        }
    }

    (
        StatusCode::CREATED,
        Json(json!({
            "serviceAccount": {
                "id": id,
                "name": name,
                "vaultIds": vault_ids,
                "createdAt": now,
                "lastUsedAt": Value::Null,
            }
        })),
    )
        .into_response()
}

async fn handle_delete_service_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let changes = {
        let conn = state.db.lock_conn();
        let _ = conn.execute(
            "DELETE FROM sessions WHERE service_account_id = ?1",
            params![id],
        );
        conn.execute("DELETE FROM service_accounts WHERE id = ?1", params![id])
            .unwrap_or(0)
    };
    if changes == 0 {
        return json_err(StatusCode::NOT_FOUND, "Service Account not found");
    }
    Json(json!({ "ok": true })).into_response()
}

fn read_settings_json(conn: &rusqlite::Connection) -> Value {
    conn.query_row(
        "SELECT email, email_public_key, cf_webhook_secret, alias_domain
         FROM account WHERE id = 1",
        [],
        |r| {
            Ok(json!({
                "email": r.get::<_, String>(0)?,
                "emailPublicKey": r.get::<_, String>(1)?,
                "cfWebhookSecret": r.get::<_, String>(2)?,
                "aliasDomain": r.get::<_, String>(3)?,
            }))
        },
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(Value::Null)
}

async fn handle_get_settings(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let settings = {
        let conn = state.db.lock_conn();
        read_settings_json(&conn)
    };
    Json(json!({ "settings": settings })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchSettingsBody {
    alias_domain: Option<String>,
    rotate_webhook_secret: Option<bool>,
}

async fn handle_patch_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let body: PatchSettingsBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };

    let next_secret = if body.rotate_webhook_secret.unwrap_or(false) {
        match random_hex_32() {
            Ok(s) => Some(s),
            Err(res) => return res,
        }
    } else {
        None
    };

    let settings = {
        let conn = state.db.lock_conn();
        if let Some(dom) = body.alias_domain {
            let _ = conn.execute(
                "UPDATE account SET alias_domain = ?1 WHERE id = 1",
                params![dom.trim().to_ascii_lowercase()],
            );
        }
        if let Some(secret) = next_secret {
            let _ = conn.execute(
                "UPDATE account SET cf_webhook_secret = ?1 WHERE id = 1",
                params![secret],
            );
        }
        read_settings_json(&conn)
    };

    Json(json!({ "settings": settings })).into_response()
}

async fn handle_get_imap(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    Json(json!({ "imap": state.imap_worker.get_public_config() })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutImapBody {
    enabled: Option<bool>,
    host: Option<String>,
    port: Option<u16>,
    tls: Option<bool>,
    username: Option<String>,
    password: Option<String>,
}

async fn handle_put_imap(
    State(state): State<AppState>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let body: PutImapBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };

    {
        let conn = state.db.lock_conn();
        let existing = conn
            .query_row(
                "SELECT enabled, host, port, tls, username, password_enc FROM imap_config WHERE id = 1",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                },
            )
            .unwrap_or((0, String::new(), 993, 1, String::new(), String::new()));

        let enabled = body.enabled.map(i64::from).unwrap_or(existing.0);
        let host = body
            .host
            .map(|h| h.trim().to_string())
            .unwrap_or(existing.1);
        let port = body.port.map(i64::from).unwrap_or(existing.2);
        let tls = body.tls.map(i64::from).unwrap_or(existing.3);
        let username = body
            .username
            .map(|u| u.trim().to_string())
            .unwrap_or(existing.4);
        let password_enc = match body.password.filter(|p| !p.is_empty()) {
            Some(pw) => state.db.encrypt_local_secret(&pw),
            None => existing.5,
        };

        let _ = conn.execute(
            "UPDATE imap_config
             SET enabled = ?1, host = ?2, port = ?3, tls = ?4, username = ?5, password_enc = ?6, updated_at = ?7
             WHERE id = 1",
            params![
                enabled,
                host,
                port,
                tls,
                username,
                password_enc,
                now_iso_millis()
            ],
        );
    }

    state.imap_worker.reload();
    Json(json!({ "imap": state.imap_worker.get_public_config() })).into_response()
}

async fn handle_test_imap(
    State(state): State<AppState>,
    headers: HeaderMap,
    body_bytes: Bytes,
) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    let body: PutImapBody = match parse_json_body(&body_bytes) {
        Ok(b) => b,
        Err(res) => return res,
    };

    let existing = {
        let conn = state.db.lock_conn();
        conn.query_row(
            "SELECT host, port, tls, username, password_enc FROM imap_config WHERE id = 1",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .unwrap_or((String::new(), 993, 1, String::new(), String::new()))
    };

    let host = body.host.unwrap_or(existing.0).trim().to_string();
    let port = body
        .port
        .unwrap_or_else(|| existing.1.clamp(1, 65535) as u16);
    let tls = body.tls.unwrap_or(existing.2 != 0);
    let username = body.username.unwrap_or(existing.3).trim().to_string();
    let password = match body.password.filter(|p| !p.is_empty()) {
        Some(pw) => pw,
        None => state.db.decrypt_local_secret(&existing.4),
    };

    if host.is_empty() || username.is_empty() || password.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": "Missing host, username, or password",
            })),
        )
            .into_response();
    }

    let result = state
        .imap_worker
        .test_connection(&host, port, tls, &username, &password)
        .await;
    Json(result).into_response()
}

async fn handle_sync_imap(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_owner(&state.db, &headers) {
        return res;
    }
    state.imap_worker.trigger_sync();
    Json(json!({
        "ok": true,
        "imap": state.imap_worker.get_public_config(),
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EdgeSealedWebhookPayload {
    mode: Option<String>,
    envelope_to: Option<String>,
    #[serde(default)]
    has_otp: bool,
    sealed_envelope: Option<SealedEnvelope>,
}

async fn handle_cf_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    raw_bytes: Bytes,
) -> Response {
    let secret: Option<String> = {
        let conn = state.db.lock_conn();
        conn.query_row(
            "SELECT cf_webhook_secret FROM account WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    };

    let Some(secret) = secret else {
        return json_err(StatusCode::SERVICE_UNAVAILABLE, "Account not initialized");
    };

    let timestamp_header = headers
        .get("x-nonepwd-timestamp")
        .and_then(|v| v.to_str().ok());
    let signature_header = headers
        .get("x-nonepwd-signature")
        .and_then(|v| v.to_str().ok());

    if !verify_webhook_hmac(&secret, timestamp_header, signature_header, &raw_bytes, 300) {
        return json_err(StatusCode::UNAUTHORIZED, "Invalid webhook signature");
    }

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if content_type.contains("application/json") {
        let parsed: EdgeSealedWebhookPayload = match serde_json::from_slice(&raw_bytes) {
            Ok(p) => p,
            Err(_) => {
                return json_err(
                    StatusCode::BAD_REQUEST,
                    "Unsupported JSON payload for CF email webhook",
                )
            }
        };
        let Some(sealed_envelope) = parsed
            .sealed_envelope
            .filter(|_| parsed.mode.as_deref() == Some("edge_sealed"))
        else {
            return json_err(
                StatusCode::BAD_REQUEST,
                "Unsupported JSON payload for CF email webhook",
            );
        };

        let env_to = parsed
            .envelope_to
            .as_deref()
            .map(extract_email_address)
            .filter(|s| !s.is_empty());

        return match ingest_pre_sealed_email(
            &state.db,
            &state.ws_hub,
            sealed_envelope,
            parsed.has_otp,
            env_to.as_deref(),
            "cloudflare",
        ) {
            Ok(result) => {
                if !result.accepted {
                    (StatusCode::ACCEPTED, Json(result)).into_response()
                } else {
                    Json(json!({
                        "accepted": true,
                        "emailId": result.email.map(|e| e.id),
                    }))
                    .into_response()
                }
            }
            Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
        };
    }

    let envelope_from = headers
        .get("x-nonepwd-envelope-from")
        .and_then(|v| v.to_str().ok());
    let envelope_to = headers
        .get("x-nonepwd-envelope-to")
        .and_then(|v| v.to_str().ok());

    match ingest_raw_email(
        &state.db,
        &state.ws_hub,
        &raw_bytes,
        "cloudflare",
        envelope_from,
        envelope_to,
    ) {
        Ok(result) => {
            if !result.accepted {
                (StatusCode::ACCEPTED, Json(result)).into_response()
            } else {
                Json(json!({
                    "accepted": true,
                    "emailId": result.email.map(|e| e.id),
                }))
                .into_response()
            }
        }
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn handle_ws_upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let token = query
        .get("token")
        .cloned()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            extract_bearer_token(
                headers
                    .get(header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok()),
            )
        });

    let Some(auth) = authenticate_token(&state.db, token.as_deref()) else {
        return json_err(StatusCode::UNAUTHORIZED, "Unauthorized");
    };

    let hub = state.ws_hub.clone();
    ws.on_upgrade(move |socket| hub.handle_socket(socket, auth))
}

async fn handle_install_sh(headers: HeaderMap) -> Response {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(str::trim)
        .filter(|s| *s == "https" || *s == "http")
        .unwrap_or("http");
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .unwrap_or("127.0.0.1:8787");
    let origin = format!("{scheme}://{host}");

    let script = format!(
        r#"#!/usr/bin/env bash
set -euo pipefail

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_KEY="darwin" ;;
  Linux)  OS_KEY="linux" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH_KEY="arm64" ;;
  x86_64|amd64)  ARCH_KEY="x86_64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

PREFIX="${{PREFIX:-$HOME/.local/bin}}"
mkdir -p "$PREFIX"

URL="{origin}/downloads/np-${{OS_KEY}}-${{ARCH_KEY}}"
echo "Downloading nonepwd CLI from $URL ..."
curl -fsSL "$URL" -o "$PREFIX/np"
chmod 755 "$PREFIX/np"
echo "Installed nonepwd native CLI -> $PREFIX/np"
"$PREFIX/np" version
"#
    );

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/x-shellscript; charset=utf-8")],
        script,
    )
        .into_response()
}

async fn handle_download(
    State(state): State<AppState>,
    AxumPath(filename): AxumPath<String>,
) -> Response {
    if !ALLOWED_CLI_BINARIES.contains(&filename.as_str()) {
        return json_err(StatusCode::NOT_FOUND, "Binary not found");
    }

    let target_path = state
        .bin_dist_dirs
        .iter()
        .map(|dir| dir.join(&filename))
        .find(|candidate| candidate.is_file());

    let Some(target_path) = target_path else {
        return json_err(StatusCode::NOT_FOUND, "Binary artifact not built");
    };

    let Ok(content) = fs::read(&target_path) else {
        return json_err(StatusCode::NOT_FOUND, "Binary artifact not built");
    };

    let content_type = if filename.ends_with(".zip") {
        "application/zip"
    } else {
        "application/octet-stream"
    };
    let disposition = format!("attachment; filename=\"{filename}\"");

    let mut res = (StatusCode::OK, content).into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(disp_val) = HeaderValue::from_str(&disposition) {
        res.headers_mut()
            .insert(header::CONTENT_DISPOSITION, disp_val);
    }
    res
}

fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn has_path_traversal(raw_path: &str, decoded_path: &str) -> bool {
    if raw_path.contains('\0') || decoded_path.contains('\0') {
        return true;
    }
    for s in [raw_path, decoded_path] {
        for seg in s.split(['/', '\\']) {
            if seg == ".." {
                return true;
            }
        }
    }
    false
}

fn safe_join_under(base: &Path, decoded_req_path: &str) -> Option<PathBuf> {
    let mut rel = PathBuf::new();
    for comp in Path::new(decoded_req_path).components() {
        match comp {
            Component::Normal(seg) => rel.push(seg),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    let joined = base.join(rel);
    if !joined.exists() || !joined.is_file() {
        return None;
    }
    let canon_base = fs::canonicalize(base).ok()?;
    let canon_target = fs::canonicalize(&joined).ok()?;
    if canon_target.starts_with(&canon_base) {
        Some(canon_target)
    } else {
        None
    }
}

async fn handle_fallback(
    State(state): State<AppState>,
    OriginalUri(orig_uri): OriginalUri,
    method: Method,
) -> Response {
    let raw_path = orig_uri.path();
    let decoded = percent_decode_str(raw_path).decode_utf8_lossy();

    if raw_path == "/api" || raw_path.starts_with("/api/") || decoded.starts_with("/api/") {
        return json_err(StatusCode::NOT_FOUND, "Not found");
    }
    if raw_path == "/downloads"
        || raw_path.starts_with("/downloads/")
        || decoded.starts_with("/downloads/")
    {
        return json_err(StatusCode::NOT_FOUND, "Binary not found");
    }
    if method != Method::GET && method != Method::HEAD {
        return json_err(StatusCode::NOT_FOUND, "Not found");
    }
    if has_path_traversal(raw_path, &decoded) {
        return json_err(StatusCode::NOT_FOUND, "Not found");
    }

    if !state.web_dist_dir.exists() {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "nonepwd API server is running.",
        )
            .into_response();
    }

    let req_target = if decoded == "/" || decoded.is_empty() {
        "/index.html"
    } else {
        decoded.as_ref()
    };

    let target_file = safe_join_under(&state.web_dist_dir, req_target)
        .or_else(|| safe_join_under(&state.web_dist_dir, "index.html"));

    let Some(target_file) = target_file else {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "Web Vault index.html not found",
        )
            .into_response();
    };

    let Ok(content) = fs::read(&target_file) else {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "Web Vault index.html not found",
        )
            .into_response();
    };

    let mime = mime_for_path(&target_file);
    (StatusCode::OK, [(header::CONTENT_TYPE, mime)], content).into_response()
}
