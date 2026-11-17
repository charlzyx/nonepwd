use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use chrono::Utc;
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use nonepwd_core::crypto::{
    derive_account_keys_raw, encrypt_bytes, encrypt_json, generate_email_key_pair,
    generate_raw_aes_key, open_sealed_json, seal_json_for_public_key,
};
use nonepwd_core::encoding::{generate_secret_key, to_base64_url};
use nonepwd_core::random::{random_bytes, random_id};
use nonepwd_core::types::{aad, DecryptedEmailPayload, RootKeysetPayload, VaultMetadata};
use nonepwd_server::auth::{hash_secret_with_salt, verify_secret};
use nonepwd_server::db::{
    decrypt_local_secret_with_key, encrypt_local_secret_with_key_and_iv, EmailFilterConfig,
    EmailFilterField, EmailFilterMode, EmailFilterRule, NonePwdDb,
};
use nonepwd_server::mime::parse_mime;
use nonepwd_server::{start_server, ServerOptions};
use serde_json::{json, Value};
use sha2::Sha256;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

type HmacSha256 = Hmac<Sha256>;

fn make_temp_dir(prefix: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("{prefix}-{}", random_id().unwrap()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

async fn raw_http(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
) -> (u16, String, Vec<u8>) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n",
        addr.port()
    );
    let mut has_ct = false;
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("content-type") {
            has_ct = true;
        }
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(b) = body {
        if !has_ct {
            req.push_str("Content-Type: application/json\r\n");
        }
        req.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");

    stream.write_all(req.as_bytes()).await.unwrap();
    if let Some(b) = body {
        stream.write_all(b).await.unwrap();
    }
    stream.flush().await.unwrap();

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.unwrap();

    let sep = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head_str = String::from_utf8_lossy(&raw[..sep]).to_string();
    let status_line = head_str.lines().next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();

    let body_bytes = raw[sep + 4..].to_vec();
    (status, head_str, body_bytes)
}

async fn http_json(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (u16, Value) {
    let mut hdrs = Vec::new();
    let auth_val = token.map(|t| format!("Bearer {t}"));
    if let Some(ref a) = auth_val {
        hdrs.push(("Authorization", a.as_str()));
    }
    let bytes = body.map(|v| serde_json::to_vec(&v).unwrap());
    let (status, _, resp_bytes) = raw_http(addr, method, path, &hdrs, bytes.as_deref()).await;
    let val = serde_json::from_slice(&resp_bytes).unwrap_or(Value::Null);
    (status, val)
}

fn sign_cf_webhook(secret: &str, ts: &str, body: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(ts.as_bytes());
    mac.update(b".");
    mac.update(body);
    format!("v1={}", hex::encode(mac.finalize().into_bytes()))
}

#[test]
fn node_scrypt_and_local_secret_vectors_match_byte_for_byte() {
    let salt = hex::decode("000102030405060708090a0b0c0d0e0f").unwrap();
    let expected_scrypt = "s1$AAECAwQFBgcICQoLDA0ODw$zc_sl5znJ2jJ-em_1GEQq-rDlfhT9cQth164XRrmtcs";
    assert_eq!(
        hash_secret_with_salt("verifier-secret-123", &salt),
        expected_scrypt
    );
    assert!(verify_secret("verifier-secret-123", expected_scrypt));
    assert!(!verify_secret("wrong-secret", expected_scrypt));

    let key = [0x42u8; 32];
    let iv = [0x07u8; 12];
    let expected_local = "s1.BwcHBwcHBwcHBwcH.IyuPqFS4JZ10YX0rz7HSlw.EY883JiQAosOJI1Drg";
    assert_eq!(
        encrypt_local_secret_with_key_and_iv(&key, &iv, "imap-app-pass"),
        expected_local
    );
    assert_eq!(
        decrypt_local_secret_with_key(&key, expected_local),
        "imap-app-pass"
    );
    assert_eq!(decrypt_local_secret_with_key(&[0x11u8; 32], expected_local), "");
}

#[test]
fn mime_parser_handles_multipart_rfc2047_qp_base64_and_bad_bytes() {
    let encoded_subj = "=?UTF-8?B?55m75b2V6aqM6K+B56CB?= =?UTF-8?Q?_Login_Code?=";
    let encoded_from = "=?UTF-8?B?5Y GitHub?= <noreply@github.com>";
    let html_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        "<html><body><p>Your verification code is <b>819203</b></p></body></html>",
    );

    let raw = format!(
        "From: {encoded_from}\r\n\
         To: \"User\" <alias.123@mail.example.com>\r\n\
         Subject: {encoded_subj}\r\n\
         MIME-Version: 1.0\r\n\
         Content-Type: multipart/mixed; boundary=\"mix-1\"\r\n\
         \r\n\
         --mix-1\r\n\
         Content-Type: multipart/alternative; boundary=\"alt-2\"\r\n\
         \r\n\
         --alt-2\r\n\
         Content-Type: text/plain; charset=\"utf-8\"\r\n\
         Content-Transfer-Encoding: quoted-printable\r\n\
         \r\n\
         Your verification code is =\r\n\
         819203=2E\r\n\
         --alt-2\r\n\
         Content-Type: text/html; charset=UTF-8\r\n\
         Content-Transfer-Encoding: base64\r\n\
         \r\n\
         {html_b64}\r\n\
         --alt-2--\r\n\
         --mix-1\r\n\
         Content-Type: text/plain; name=\"secret.txt\"\r\n\
         Content-Disposition: attachment; filename=\"secret.txt\"\r\n\
         \r\n\
         999999 attachment ignored\r\n\
         --mix-1--\r\n"
    );

    let parsed = parse_mime(raw.as_bytes());
    assert_eq!(parsed.to_address.as_deref(), Some("alias.123@mail.example.com"));
    assert_eq!(parsed.subject.as_deref(), Some("登录验证码 Login Code"));
    assert_eq!(
        parsed.text.as_deref().map(str::trim),
        Some("Your verification code is 819203.")
    );
    assert!(parsed.html.as_deref().unwrap().contains("819203"));
    assert!(!parsed.text.as_deref().unwrap().contains("999999"));

    // Arbitrary malformed bytes must never panic
    let garbage = [0xffu8, 0x00, b'\r', b'\n', b':', 0xfe, 0xa0];
    let _ = parse_mime(&garbage);
}

#[tokio::test]
async fn opens_copy_of_db_created_by_node_server() {
    let src_dir = make_temp_dir("np-node-src");
    let copy_dir = make_temp_dir("np-node-copy");
    fs::remove_dir_all(&copy_dir).unwrap();

    // Create a genuine Node server SQLite DB via Node's `node:sqlite` + `node:crypto` matching packages/server/src/{db,auth}.ts
    let node_script = r#"
      import fs from 'node:fs';
      import path from 'node:path';
      import crypto from 'node:crypto';
      import { DatabaseSync } from 'node:sqlite';

      const dataDir = process.argv[1];
      const verifier = process.argv[2];
      const rawSessionToken = process.argv[3];

      fs.mkdirSync(dataDir, { recursive: true });
      const serverKey = crypto.randomBytes(32);
      fs.writeFileSync(path.join(dataDir, '.server_key'), serverKey.toString('base64url'), { mode: 0o600 });

      const db = new DatabaseSync(path.join(dataDir, 'nonepwd.db'));
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE account (
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
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          service_account_id TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE vaults (
          id TEXT PRIMARY KEY,
          encrypted_key TEXT NOT NULL,
          encrypted_meta TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE items (
          id TEXT PRIMARY KEY,
          vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
          encrypted_data TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE service_accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          auth_secret_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_used_at TEXT
        );
        CREATE TABLE service_account_vaults (
          service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
          vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
          encrypted_vault_key TEXT NOT NULL,
          PRIMARY KEY (service_account_id, vault_id)
        );
        CREATE TABLE aliases (
          id TEXT PRIMARY KEY,
          address TEXT NOT NULL UNIQUE,
          site_domain TEXT,
          vault_id TEXT,
          item_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          received_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE encrypted_emails (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          envelope_to TEXT,
          has_otp INTEGER NOT NULL DEFAULT 0,
          sealed_envelope TEXT NOT NULL,
          received_at TEXT NOT NULL
        );
        CREATE TABLE imap_config (
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
      `);

      const salt = crypto.randomBytes(16);
      const authHash = `s1$${salt.toString('base64url')}$${crypto.scryptSync(verifier, salt, 32).toString('base64url')}`;
      const now = new Date().toISOString();
      const exp = new Date(Date.now() + 86400_000).toISOString();

      db.prepare(`INSERT INTO account VALUES (1, 'node-owner@example.com', 'kdfSalt123', 600000, ?, 'encKeyset', 'pubKey', 'cfsec', 'alias.dev', ?)`).run(authHash, now);
      db.prepare(`INSERT INTO vaults VALUES ('v_node', 'ek_1', 'em_1', ?, ?)`).run(now, now);
      db.prepare(`INSERT INTO items VALUES ('i_node', 'v_node', 'ed_1', ?, ?, 3)`).run(now, now);

      const tokenHash = crypto.createHash('sha256').update(rawSessionToken, 'utf8').digest('hex');
      db.prepare(`INSERT INTO sessions VALUES (?, 'owner', NULL, ?, ?)`).run(tokenHash, now, exp);

      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', serverKey, iv);
      const enc = Buffer.concat([cipher.update('node-imap-secret-pw', 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      const pwBlob = `s1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;

      db.prepare(`INSERT INTO imap_config VALUES (1, 0, 'imap.example.com', 993, 1, 'user@example.com', ?, 42, 'disabled', NULL, ?)`).run(pwBlob, now);
      db.close();
    "#;

    let status = Command::new("node")
        .arg("--input-type=module")
        .arg("-e")
        .arg(node_script)
        .arg(&src_dir)
        .arg("node-auth-verifier-xyz")
        .arg("node-raw-session-tok-123")
        .status()
        .expect("node binary must run");
    assert!(status.success());

    // Copy the Node-created data directory (including WAL/SHM if any + .server_key)
    let cp_status = Command::new("cp")
        .arg("-R")
        .arg(&src_dir)
        .arg(&copy_dir)
        .status()
        .unwrap();
    assert!(cp_status.success());

    // Verify Rust DB layer reads Node's .server_key + s1.iv.tag.ct + schema seamlessly
    {
        let opened = NonePwdDb::open(&copy_dir).unwrap();
        let pw_enc: String = opened
            .lock_conn()
            .query_row("SELECT password_enc FROM imap_config WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(opened.decrypt_local_secret(&pw_enc), "node-imap-secret-pw");
    }

    // Boot Rust HTTP server on the copied Node DB
    let srv = start_server(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: Some(copy_dir.clone()),
        web_dist: None,
        bin_dist: None,
    })
    .await
    .unwrap();

    let (st_params, params_json) = http_json(srv.addr, "GET", "/api/auth/params", None, None).await;
    assert_eq!(st_params, 200);
    assert_eq!(params_json["initialized"], true);
    assert_eq!(params_json["email"], "node-owner@example.com");
    assert_eq!(params_json["kdfIterations"], 600_000);

    // Existing Node session token must authenticate directly on /api/sync
    let (st_sync, sync_json) = http_json(
        srv.addr,
        "GET",
        "/api/sync",
        Some("node-raw-session-tok-123"),
        None,
    )
    .await;
    assert_eq!(st_sync, 200);
    assert_eq!(sync_json["vaults"][0]["id"], "v_node");
    assert_eq!(sync_json["items"][0]["id"], "i_node");
    assert_eq!(sync_json["items"][0]["version"], 3);
    assert_eq!(sync_json["emailFilter"]["enabled"], false);

    // Login against Node's scrypt s1$salt$hash must succeed
    let (st_login, login_json) = http_json(
        srv.addr,
        "POST",
        "/api/auth/login",
        None,
        Some(json!({ "authVerifier": "node-auth-verifier-xyz" })),
    )
    .await;
    assert_eq!(st_login, 200);
    assert!(login_json["token"].as_str().is_some_and(|t| !t.is_empty()));

    srv.shutdown().await;
    let _ = fs::remove_dir_all(&src_dir);
    let _ = fs::remove_dir_all(&copy_dir);
}

#[tokio::test]
async fn full_api_ws_webhook_email_filter_batch_and_imap_idle_e2e() {
    let data_dir = make_temp_dir("np-rust-e2e");
    let web_dir = make_temp_dir("np-rust-web");
    fs::write(web_dir.join("index.html"), "<!doctype html><title>Vault</title>").unwrap();

    let srv = start_server(ServerOptions {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: Some(data_dir.clone()),
        web_dist: Some(web_dir.clone()),
        bin_dist: None,
    })
    .await
    .unwrap();

    // 1. Setup single-owner account
    let sk = generate_secret_key().unwrap();
    let salt = to_base64_url(&random_bytes(16).unwrap());
    let (muk, verifier) = derive_account_keys_raw("Master#123", &sk, &salt, 10_000).unwrap();
    let root_key = generate_raw_aes_key().unwrap();
    let email_kp = generate_email_key_pair().unwrap();
    let enc_root = encrypt_json(
        &muk,
        &RootKeysetPayload {
            root_key_b64: to_base64_url(&root_key),
            email_private_key_pkcs8_b64: email_kp.private_key_pkcs8_b64.clone(),
        },
        Some(aad::ROOT_KEYSET),
    )
    .unwrap();

    let personal_id = random_id().unwrap();
    let personal_key = generate_raw_aes_key().unwrap();

    let (st_setup, setup_json) = http_json(
        srv.addr,
        "POST",
        "/api/auth/setup",
        None,
        Some(json!({
            "email": "Owner@Example.com",
            "kdfSalt": salt,
            "kdfIterations": 10_000,
            "authVerifier": verifier,
            "encryptedRootKeyset": enc_root,
            "emailPublicKey": email_kp.public_key_b64,
            "aliasDomain": "mail.example.com",
            "vaults": [{
                "id": personal_id,
                "encryptedKey": encrypt_bytes(&root_key, &personal_key, Some(&aad::vault_owner_key(&personal_id))).unwrap(),
                "encryptedMeta": encrypt_json(&personal_key, &VaultMetadata {
                    name: "Personal".into(),
                    description: None,
                    icon: None,
                    color: None,
                }, Some(&aad::vault_meta(&personal_id))).unwrap(),
            }]
        })),
    )
    .await;
    assert_eq!(st_setup, 201);
    let token = setup_json["token"].as_str().unwrap().to_string();
    let cf_secret = setup_json["account"]["cfWebhookSecret"]
        .as_str()
        .unwrap()
        .to_string();

    // Duplicate setup -> 409
    let (st_dup, _) = http_json(
        srv.addr,
        "POST",
        "/api/auth/setup",
        None,
        Some(json!({
            "email": "b@example.com",
            "kdfSalt": salt,
            "kdfIterations": 10_000,
            "authVerifier": verifier,
            "encryptedRootKeyset": enc_root,
            "emailPublicKey": email_kp.public_key_b64,
        })),
    )
    .await;
    assert_eq!(st_dup, 409);

    // Malformed JSON -> 400 (never panics)
    let (st_bad_json, _, _) =
        raw_http(srv.addr, "POST", "/api/auth/login", &[], Some(b"{not-json")).await;
    assert_eq!(st_bad_json, 400);

    // 2. Batch items endpoint
    let (st_batch, batch_json) = http_json(
        srv.addr,
        "POST",
        &format!("/api/vaults/{personal_id}/items/batch"),
        Some(&token),
        Some(json!({
            "items": [
                { "id": "b1", "encryptedData": "v1.iv.ct1" },
                { "id": "b2", "encryptedData": "v1.iv.ct2" }
            ]
        })),
    )
    .await;
    assert_eq!(st_batch, 201);
    assert_eq!(batch_json["imported"], 2);

    // 3. Connect WebSocket & verify hello + live events
    let ws_url = format!("ws://127.0.0.1:{}/api/ws?token={token}", srv.addr.port());
    let (mut ws_stream, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    let first_msg = ws_stream.next().await.unwrap().unwrap();
    let hello_val: Value = serde_json::from_str(first_msg.to_text().unwrap()).unwrap();
    assert_eq!(hello_val["type"], "hello");
    assert_eq!(hello_val["kind"], "owner");

    // 4. Email Filter validation & filtering semantics
    let (st_bad_re, _) = http_json(
        srv.addr,
        "PUT",
        "/api/email-filter",
        Some(&token),
        Some(json!({
            "enabled": true,
            "otpOnly": false,
            "mode": "allow",
            "rules": [{ "id": "r1", "field": "from", "pattern": "[unclosed", "enabled": true }]
        })),
    )
    .await;
    assert_eq!(st_bad_re, 400);

    // Configure allow-mode + otpOnly: accept only OTP mails from github.com or linear.app
    let filter_cfg = EmailFilterConfig {
        enabled: true,
        otp_only: true,
        mode: EmailFilterMode::Allow,
        rules: vec![
            EmailFilterRule {
                id: "r_gh".into(),
                field: EmailFilterField::From,
                pattern: r"@(github\.com|linear\.app)$".into(),
                enabled: true,
            },
            EmailFilterRule {
                id: "r_to".into(),
                field: EmailFilterField::To,
                pattern: r"^vip\.".into(),
                enabled: true,
            },
        ],
    };
    let (st_put_f, saved_f) = http_json(
        srv.addr,
        "PUT",
        "/api/email-filter",
        Some(&token),
        Some(serde_json::to_value(&filter_cfg).unwrap()),
    )
    .await;
    assert_eq!(st_put_f, 200);
    assert_eq!(saved_f["otpOnly"], true);

    // Simulate non-OTP mail from github.com -> dropped (202 reason: "filtered") because otpOnly=true
    let (st_sim_drop1, sim_drop1) = http_json(
        srv.addr,
        "POST",
        "/api/emails/simulate",
        Some(&token),
        Some(json!({
            "from": "GitHub <noreply@github.com>",
            "to": "me@mail.example.com",
            "subject": "Monthly newsletter",
            "text": "Welcome to our spring product update!"
        })),
    )
    .await;
    assert_eq!(st_sim_drop1, 202);
    assert_eq!(sim_drop1["accepted"], false);
    assert_eq!(sim_drop1["reason"], "filtered");

    // Simulate OTP mail from unknown sender -> dropped (202 reason: "filtered") because allow-mode
    let (st_sim_drop2, sim_drop2) = http_json(
        srv.addr,
        "POST",
        "/api/emails/simulate",
        Some(&token),
        Some(json!({
            "from": "Spam <bot@evil.org>",
            "to": "me@mail.example.com",
            "subject": "Verification code",
            "text": "Your verification code is 482910"
        })),
    )
    .await;
    assert_eq!(st_sim_drop2, 202);
    assert_eq!(sim_drop2["reason"], "filtered");

    // Simulate OTP mail from GitHub -> accepted (201) & broadcast on WS!
    let (st_sim_ok, sim_ok) = http_json(
        srv.addr,
        "POST",
        "/api/emails/simulate",
        Some(&token),
        Some(json!({
            "from": "GitHub <noreply@github.com>",
            "to": "me@mail.example.com",
            "subject": "[GitHub] Verification code",
            "text": "Your verification code is: 739104"
        })),
    )
    .await;
    assert_eq!(st_sim_ok, 201);
    assert_eq!(sim_ok["accepted"], true);

    let ws_evt = tokio::time::timeout(Duration::from_secs(2), ws_stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let ws_json: Value = serde_json::from_str(ws_evt.to_text().unwrap()).unwrap();
    assert_eq!(ws_json["type"], "email.received");
    let opened: DecryptedEmailPayload = open_sealed_json(
        &email_kp.private_key_pkcs8_b64,
        &serde_json::from_value(ws_json["email"]["sealedEnvelope"].clone()).unwrap(),
        "nonepwd-email-v1",
    )
    .unwrap();
    assert_eq!(opened.otp_code.as_deref(), Some("739104"));

    // 5. Edge-sealed CF webhook: only `to` rules + `hasOtp` apply
    let edge_env = seal_json_for_public_key(
        &email_kp.public_key_b64,
        &DecryptedEmailPayload {
            id: None,
            from: "Other <noreply@other.io>".into(),
            to: "vip.box@mail.example.com".into(),
            subject: "Code".into(),
            snippet: "Your code is 601928".into(),
            text_body: "Your code is 601928".into(),
            otp_code: Some("601928".into()),
            confidence: 0.9,
            magic_link: None,
            sender_domain: "other.io".into(),
            received_at: Utc::now().to_rfc3339(),
        },
        "nonepwd-email-v1",
    )
    .unwrap();

    // Non-matching `to` on edge_sealed -> 202 filtered
    let ts = Utc::now().timestamp().to_string();
    let drop_edge_bytes = serde_json::to_vec(&json!({
        "mode": "edge_sealed",
        "envelopeTo": "random@mail.example.com",
        "hasOtp": true,
        "sealedEnvelope": edge_env,
    }))
    .unwrap();
    let sig_drop = sign_cf_webhook(&cf_secret, &ts, &drop_edge_bytes);
    let (st_edge_drop, _, body_edge_drop) = raw_http(
        srv.addr,
        "POST",
        "/api/webhooks/email/cf",
        &[
            ("Content-Type", "application/json"),
            ("X-NonePwd-Timestamp", &ts),
            ("X-NonePwd-Signature", &sig_drop),
        ],
        Some(&drop_edge_bytes),
    )
    .await;
    assert_eq!(st_edge_drop, 202);
    let edge_drop_val: Value = serde_json::from_slice(&body_edge_drop).unwrap();
    assert_eq!(edge_drop_val["reason"], "filtered");

    // Matching `to` (`^vip\.`) + hasOtp=true -> 200 accepted even though `from` wasn't github!
    let ok_edge_bytes = serde_json::to_vec(&json!({
        "mode": "edge_sealed",
        "envelopeTo": "vip.box@mail.example.com",
        "hasOtp": true,
        "sealedEnvelope": edge_env,
    }))
    .unwrap();
    let sig_ok = sign_cf_webhook(&cf_secret, &ts, &ok_edge_bytes);
    let (st_edge_ok, _, _) = raw_http(
        srv.addr,
        "POST",
        "/api/webhooks/email/cf",
        &[
            ("Content-Type", "application/json"),
            ("X-NonePwd-Timestamp", &ts),
            ("X-NonePwd-Signature", &sig_ok),
        ],
        Some(&ok_edge_bytes),
    )
    .await;
    assert_eq!(st_edge_ok, 200);

    // 6. Path traversal protection on /downloads and static files
    let (st_trav1, _, _) =
        raw_http(srv.addr, "GET", "/downloads/..%2F..%2Fetc%2Fpasswd", &[], None).await;
    assert_eq!(st_trav1, 404);
    let (st_trav2, _, _) =
        raw_http(srv.addr, "GET", "/%2e%2e/%2e%2e/etc/passwd", &[], None).await;
    assert_eq!(st_trav2, 404);
    let (st_spa, _, spa_bytes) = raw_http(srv.addr, "GET", "/vault/items", &[], None).await;
    assert_eq!(st_spa, 200);
    assert!(String::from_utf8_lossy(&spa_bytes).contains("<title>Vault</title>"));

    // 7. Mock IMAP server: testConnection + IDLE live ingestion!
    // Disable email filter so IMAP message is accepted cleanly
    let _ = http_json(
        srv.addr,
        "PUT",
        "/api/email-filter",
        Some(&token),
        Some(json!({ "enabled": false, "otpOnly": false, "mode": "allow", "rules": [] })),
    )
    .await;

    let imap_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let imap_port = imap_listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        // Accept up to 2 connections: 1st for /api/imap/test, 2nd for live IDLE worker
        for conn_idx in 0..2 {
            let Ok((socket, _)) = imap_listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let (r, mut w) = socket.into_split();
                let mut reader = BufReader::new(r);
                let _ = w.write_all(b"* OK Mock IMAP Ready\r\n").await;

                let mut line = String::new();
                let mut sent_idle_push = false;
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    let trimmed = line.trim().to_string();
                    line.clear();
                    if trimmed.eq_ignore_ascii_case("DONE") {
                        continue;
                    }
                    let tag = trimmed.split_whitespace().next().unwrap_or("A0001");
                    let rest = trimmed[tag.len()..].trim();
                    let upper = rest.to_ascii_uppercase();

                    if upper.starts_with("LOGIN ") {
                        let _ = w.write_all(format!("{tag} OK Logged in\r\n").as_bytes()).await;
                    } else if upper.starts_with("STATUS ") {
                        let _ = w
                            .write_all(b"* STATUS \"INBOX\" (MESSAGES 7)\r\n")
                            .await;
                        let _ = w
                            .write_all(format!("{tag} OK STATUS completed\r\n").as_bytes())
                            .await;
                    } else if upper.starts_with("SELECT ") {
                        let _ = w.write_all(b"* 1 EXISTS\r\n").await;
                        let _ = w
                            .write_all(format!("{tag} OK [READ-WRITE] SELECT completed\r\n").as_bytes())
                            .await;
                    } else if upper.starts_with("UID SEARCH ") {
                        if sent_idle_push {
                            let _ = w.write_all(b"* SEARCH 101\r\n").await;
                        } else {
                            let _ = w.write_all(b"* SEARCH\r\n").await;
                        }
                        let _ = w
                            .write_all(format!("{tag} OK SEARCH completed\r\n").as_bytes())
                            .await;
                    } else if upper.starts_with("UID FETCH 101") {
                        let mime = b"From: Steam <noreply@steampowered.com>\r\nTo: me@mail.example.com\r\nSubject: Steam Login Code\r\n\r\nYour verification code is 928374.\r\n";
                        let header = format!("* 1 FETCH (UID 101 BODY[] {{{}}}\r\n", mime.len());
                        let _ = w.write_all(header.as_bytes()).await;
                        let _ = w.write_all(mime).await;
                        let _ = w.write_all(b")\r\n").await;
                        let _ = w
                            .write_all(format!("{tag} OK FETCH completed\r\n").as_bytes())
                            .await;
                    } else if upper == "IDLE" {
                        let _ = w.write_all(b"+ idling\r\n").await;
                        if conn_idx == 1 && !sent_idle_push {
                            sent_idle_push = true;
                            tokio::time::sleep(Duration::from_millis(60)).await;
                            let _ = w.write_all(b"* 2 EXISTS\r\n").await;
                        }
                        // Wait for DONE
                        let mut done_line = String::new();
                        let _ = reader.read_line(&mut done_line).await;
                        let _ = w
                            .write_all(format!("{tag} OK IDLE terminated\r\n").as_bytes())
                            .await;
                    } else if upper == "LOGOUT" {
                        let _ = w.write_all(b"* BYE Logging out\r\n").await;
                        let _ = w.write_all(format!("{tag} OK LOGOUT\r\n").as_bytes()).await;
                        break;
                    } else {
                        let _ = w.write_all(format!("{tag} OK\r\n").as_bytes()).await;
                    }
                }
            });
        }
    });

    let (st_imap_test, imap_test_json) = http_json(
        srv.addr,
        "POST",
        "/api/imap/test",
        Some(&token),
        Some(json!({
            "host": "127.0.0.1",
            "port": imap_port,
            "tls": false,
            "username": "me@example.com",
            "password": "app-password-123"
        })),
    )
    .await;
    assert_eq!(st_imap_test, 200);
    assert_eq!(imap_test_json["ok"], true);
    assert_eq!(imap_test_json["messages"], 7);

    // Enable live IMAP IDLE worker and assert email 928374 arrives via WS!
    let (st_imap_put, _) = http_json(
        srv.addr,
        "PUT",
        "/api/imap",
        Some(&token),
        Some(json!({
            "enabled": true,
            "host": "127.0.0.1",
            "port": imap_port,
            "tls": false,
            "username": "me@example.com",
            "password": "app-password-123"
        })),
    )
    .await;
    assert_eq!(st_imap_put, 200);

    let mut got_imap_otp = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(Ok(msg))) =
            tokio::time::timeout(Duration::from_millis(500), ws_stream.next()).await
        {
            if let Ok(txt) = msg.to_text() {
                if let Ok(v) = serde_json::from_str::<Value>(txt) {
                    if v["type"] == "email.received" && v["email"]["source"] == "imap" {
                        let env: nonepwd_core::types::SealedEnvelope =
                            serde_json::from_value(v["email"]["sealedEnvelope"].clone()).unwrap();
                        let dec: DecryptedEmailPayload = open_sealed_json(
                            &email_kp.private_key_pkcs8_b64,
                            &env,
                            "nonepwd-email-v1",
                        )
                        .unwrap();
                        got_imap_otp = dec.otp_code;
                        break;
                    }
                }
            }
        }
    }
    assert_eq!(got_imap_otp.as_deref(), Some("928374"));

    srv.shutdown().await;
    let _ = fs::remove_dir_all(&data_dir);
    let _ = fs::remove_dir_all(&web_dir);
}
