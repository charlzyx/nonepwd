use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use nonepwd_core::crypto::{
    decode_service_account_token, decrypt_bytes, decrypt_json, derive_account_keys_raw,
    encode_service_account_token, encrypt_bytes, encrypt_json, generate_email_key_pair,
    generate_raw_aes_key, open_sealed_json,
};
use nonepwd_core::encoding::{from_base64_url, generate_secret_key, to_base64_url};
use nonepwd_core::generator::{generate_password, PasswordOptions};
use nonepwd_core::otp_extractor::domains_match;
use nonepwd_core::random::{random_bytes, random_id};
use nonepwd_core::secret_ref::{parse_secret_ref, resolve_item_field};
use nonepwd_core::totp::{generate_totp, TotpResult};
use nonepwd_core::types::{
    aad, CustomField, DecryptedEmailPayload, ItemCategory, RootKeysetPayload, SealedEnvelope,
    ServiceAccountTokenPayload, VaultItemPayload, VaultMetadata, DEFAULT_KDF_ITERATIONS,
};
use serde::{Deserialize, Serialize};
use tungstenite::Message;

use crate::config::{load_config, save_config, CliSessionData};
use crate::net::{connect_ws, http_request};

pub fn now_iso_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    epoch_secs_to_iso(secs)
}

fn epoch_secs_to_iso(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;

    // Civil from days (Howard Hinnant algorithm)
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}Z")
}

fn parse_iso_epoch_secs(iso: &str) -> Option<i64> {
    let date_part = iso.get(0..10)?;
    let time_part = iso.get(11..19)?;
    let mut dp = date_part.split('-');
    let y: i64 = dp.next()?.parse().ok()?;
    let m: i64 = dp.next()?.parse().ok()?;
    let d: i64 = dp.next()?.parse().ok()?;
    let mut tp = time_part.split(':');
    let hh: i64 = tp.next()?.parse().ok()?;
    let mm: i64 = tp.next()?.parse().ok()?;
    let ss: i64 = tp.next()?.parse().ok()?;

    let y_adj = y - if m <= 2 { 1 } else { 0 };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = (y_adj - era * 400) as u64;
    let m_adj = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * m_adj + 2) / 5 + (d as u64) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + (doe as i64) - 719468;
    Some(days * 86400 + hh * 3600 + mm * 60 + ss)
}

#[derive(Debug, Clone)]
pub struct DecryptedVault {
    pub id: String,
    pub metadata: VaultMetadata,
    pub key_bytes: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct DecryptedItem {
    pub id: String,
    pub vault_id: String,
    pub vault_name: String,
    pub payload: VaultItemPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AliasRecord {
    pub id: String,
    pub address: String,
    pub site_domain: Option<String>,
    pub vault_id: Option<String>,
    pub item_id: Option<String>,
    pub enabled: bool,
    pub received_count: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAccountRecord {
    pub id: String,
    pub name: String,
    pub vault_ids: Vec<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedVaultRow {
    id: String,
    encrypted_key: String,
    encrypted_meta: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedItemRow {
    id: String,
    vault_id: String,
    encrypted_data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedEmailRow {
    id: String,
    source: String,
    envelope_to: Option<String>,
    sealed_envelope: SealedEnvelope,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecryptedEmailItem {
    pub id: String,
    pub source: String,
    pub envelope_to: Option<String>,
    #[serde(flatten)]
    pub payload: DecryptedEmailPayload,
}

pub struct NonePwdClient {
    config_dir: Option<String>,
    server_override: Option<String>,
    service_account_token: Option<String>,
    active_mode: String,
    session_token: Option<String>,
    root_key_bytes: Option<[u8; 32]>,
    email_private_key_pkcs8_b64: Option<String>,
    pub vaults: Vec<DecryptedVault>,
    pub items: Vec<DecryptedItem>,
    pub aliases: Vec<AliasRecord>,
    pub emails: Vec<DecryptedEmailItem>,
}

impl NonePwdClient {
    pub fn new(config_dir: Option<String>, server_override: Option<String>) -> Self {
        let sa_tok = std::env::var("NONEPWD_TOKEN").ok().filter(|s| !s.is_empty());
        Self {
            config_dir,
            server_override,
            service_account_token: sa_tok,
            active_mode: "owner".into(),
            session_token: None,
            root_key_bytes: None,
            email_private_key_pkcs8_b64: None,
            vaults: Vec::new(),
            items: Vec::new(),
            aliases: Vec::new(),
            emails: Vec::new(),
        }
    }

    fn get_server_url(&self) -> Result<String, String> {
        if let Some(u) = &self.server_override {
            return Ok(u.trim_end_matches('/').to_string());
        }
        if let Some(tok) = &self.service_account_token {
            let parsed = decode_service_account_token(tok)?;
            return Ok(parsed.server_url.trim_end_matches('/').to_string());
        }
        if let Ok(u) = std::env::var("NONEPWD_SERVER") {
            if !u.is_empty() {
                return Ok(u.trim_end_matches('/').to_string());
            }
        }
        let cfg = load_config(self.config_dir.as_deref());
        cfg.server_url
            .map(|u| u.trim_end_matches('/').to_string())
            .ok_or_else(|| {
                "No nonepwd server configured. Run `np setup` or `np signin --server <url>`."
                    .to_string()
            })
    }

    fn request_json<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
        skip_auth: bool,
    ) -> Result<T, String> {
        let base = self.get_server_url()?;
        let url = format!("{base}{path}");
        let body_bytes = body.map(|v| serde_json::to_vec(v).unwrap());
        let token = if skip_auth {
            None
        } else {
            self.session_token.as_deref()
        };
        let (status, resp_bytes) = http_request(method, &url, token, body_bytes.as_deref())?;
        if status < 200 || status >= 300 {
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&resp_bytes) {
                if let Some(err) = val.get("error").and_then(|v| v.as_str()) {
                    return Err(err.to_string());
                }
            }
            return Err(format!("HTTP {status} on {path}"));
        }
        if resp_bytes.is_empty() {
            return serde_json::from_slice(b"{}").map_err(|e| e.to_string());
        }
        serde_json::from_slice(&resp_bytes).map_err(|e| format!("Invalid JSON from {path}: {e}"))
    }

    pub fn setup(
        &mut self,
        server_url: &str,
        email: &str,
        password: &str,
        alias_domain: &str,
        kdf_iterations: Option<u32>,
    ) -> Result<serde_json::Value, String> {
        let clean_server = server_url.trim_end_matches('/').to_string();
        self.server_override = Some(clean_server.clone());
        let secret_key = generate_secret_key()?;
        let kdf_salt = to_base64_url(&random_bytes(16)?);
        let iterations = kdf_iterations.unwrap_or(DEFAULT_KDF_ITERATIONS);

        let (muk, auth_verifier) =
            derive_account_keys_raw(password, &secret_key, &kdf_salt, iterations)?;
        let root_key = generate_raw_aes_key()?;
        let email_kp = generate_email_key_pair()?;

        let root_key_b64 = to_base64_url(&root_key);
        let keyset = RootKeysetPayload {
            root_key_b64: root_key_b64.clone(),
            email_private_key_pkcs8_b64: email_kp.private_key_pkcs8_b64.clone(),
        };
        let encrypted_root_keyset = encrypt_json(&muk, &keyset, Some(aad::ROOT_KEYSET))?;

        let vault_names = ["Personal", "DevOps"];
        let mut initial_vaults = Vec::new();
        for name in vault_names {
            let vid = random_id()?;
            let vk = generate_raw_aes_key()?;
            let meta = VaultMetadata {
                name: name.into(),
                description: None,
                icon: None,
                color: None,
            };
            initial_vaults.push(serde_json::json!({
                "id": vid,
                "encryptedKey": encrypt_bytes(&root_key, &vk, Some(&aad::vault_owner_key(&vid)))?,
                "encryptedMeta": encrypt_json(&vk, &meta, Some(&aad::vault_meta(&vid)))?,
            }));
        }

        let resp: serde_json::Value = self.request_json(
            "POST",
            "/api/auth/setup",
            Some(&serde_json::json!({
                "email": email,
                "kdfSalt": kdf_salt,
                "kdfIterations": iterations,
                "authVerifier": auth_verifier,
                "encryptedRootKeyset": encrypted_root_keyset,
                "emailPublicKey": email_kp.public_key_b64,
                "aliasDomain": alias_domain,
                "vaults": initial_vaults,
            })),
            true,
        )?;

        let token = resp["token"]
            .as_str()
            .ok_or_else(|| "Missing token from setup response".to_string())?
            .to_string();

        self.active_mode = "owner".into();
        self.session_token = Some(token.clone());
        self.root_key_bytes = Some(root_key);
        self.email_private_key_pkcs8_b64 = Some(email_kp.private_key_pkcs8_b64.clone());

        let mut cfg = load_config(self.config_dir.as_deref());
        cfg.server_url = Some(clean_server.clone());
        cfg.email = Some(email.trim().to_ascii_lowercase());
        cfg.secret_key = Some(secret_key.clone());
        cfg.session = Some(CliSessionData {
            token,
            root_key_b64,
            email_private_key_pkcs8_b64: email_kp.private_key_pkcs8_b64,
            saved_at: now_iso_utc(),
        });
        save_config(&cfg, self.config_dir.as_deref())?;
        self.sync()?;

        Ok(serde_json::json!({
            "email": email.trim().to_ascii_lowercase(),
            "secretKey": secret_key,
            "serverUrl": clean_server,
            "vaults": vault_names,
        }))
    }

    pub fn signin(
        &mut self,
        server_url: Option<&str>,
        email_opt: Option<&str>,
        secret_key_opt: Option<&str>,
        password: &str,
    ) -> Result<serde_json::Value, String> {
        let mut cfg = load_config(self.config_dir.as_deref());
        let env_server = std::env::var("NONEPWD_SERVER").ok().filter(|s| !s.is_empty());
        let server = server_url
            .map(str::to_string)
            .or(cfg.server_url.clone())
            .or(env_server)
            .ok_or_else(|| "Server URL is required for signin".to_string())?
            .trim_end_matches('/')
            .to_string();
        self.server_override = Some(server.clone());

        let env_sk = std::env::var("NONEPWD_SECRET_KEY").ok().filter(|s| !s.is_empty());
        let secret_key = secret_key_opt
            .map(str::to_string)
            .or(cfg.secret_key.clone())
            .or(env_sk)
            .ok_or_else(|| "Secret Key (NP3-...) is required for signin".to_string())?;

        let params: serde_json::Value = self.request_json("GET", "/api/auth/params", None, true)?;
        if !params["initialized"].as_bool().unwrap_or(false) {
            return Err("Server is not initialized. Run `np setup` first.".into());
        }
        let kdf_salt = params["kdfSalt"].as_str().ok_or("Missing kdfSalt")?;
        let kdf_iter = params["kdfIterations"].as_u64().ok_or("Missing kdfIterations")? as u32;

        let (muk, auth_verifier) =
            derive_account_keys_raw(password, &secret_key, kdf_salt, kdf_iter)?;
        let login_res: serde_json::Value = self.request_json(
            "POST",
            "/api/auth/login",
            Some(&serde_json::json!({ "authVerifier": auth_verifier })),
            true,
        )?;

        let token = login_res["token"].as_str().ok_or("Missing token")?.to_string();
        let account_email = login_res["account"]["email"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let enc_keyset = login_res["account"]["encryptedRootKeyset"]
            .as_str()
            .ok_or("Missing encryptedRootKeyset")?;

        let keyset: RootKeysetPayload = decrypt_json(&muk, enc_keyset, Some(aad::ROOT_KEYSET))?;
        let root_vec = from_base64_url(&keyset.root_key_b64)?;
        let mut root_arr = [0u8; 32];
        if root_vec.len() != 32 {
            return Err("Invalid root key length".into());
        }
        root_arr.copy_from_slice(&root_vec);

        self.active_mode = "owner".into();
        self.session_token = Some(token.clone());
        self.root_key_bytes = Some(root_arr);
        self.email_private_key_pkcs8_b64 = Some(keyset.email_private_key_pkcs8_b64.clone());

        cfg.server_url = Some(server.clone());
        cfg.email = Some(email_opt.map(str::to_string).unwrap_or(account_email.clone()));
        cfg.secret_key = Some(secret_key);
        cfg.session = Some(CliSessionData {
            token,
            root_key_b64: keyset.root_key_b64,
            email_private_key_pkcs8_b64: keyset.email_private_key_pkcs8_b64,
            saved_at: now_iso_utc(),
        });
        save_config(&cfg, self.config_dir.as_deref())?;
        self.sync()?;

        Ok(serde_json::json!({ "email": account_email, "serverUrl": server }))
    }

    pub fn lock(&mut self) -> Result<(), String> {
        let mut cfg = load_config(self.config_dir.as_deref());
        if let Some(sess) = cfg.session.take() {
            self.session_token = Some(sess.token);
            let _ = self.request_json::<serde_json::Value>("POST", "/api/auth/logout", None, false);
            save_config(&cfg, self.config_dir.as_deref())?;
        }
        self.session_token = None;
        self.root_key_bytes = None;
        self.email_private_key_pkcs8_b64 = None;
        Ok(())
    }

    pub fn ensure_authenticated(&mut self) -> Result<(), String> {
        if self.session_token.is_some() {
            return Ok(());
        }
        if let Some(tok) = self.service_account_token.clone() {
            let parsed = decode_service_account_token(&tok)?;
            self.server_override = Some(parsed.server_url.trim_end_matches('/').to_string());
            let res: serde_json::Value = self.request_json(
                "POST",
                "/api/auth/service-account",
                Some(&serde_json::json!({
                    "tokenId": parsed.token_id,
                    "authSecret": parsed.auth_secret,
                })),
                true,
            )?;
            let sess_tok = res["token"].as_str().ok_or("Missing SA session token")?.to_string();
            self.active_mode = "service_account".into();
            self.session_token = Some(sess_tok);
            return Ok(());
        }

        let cfg = load_config(self.config_dir.as_deref());
        if let Some(sess) = cfg.session {
            let root_vec = from_base64_url(&sess.root_key_b64)?;
            if root_vec.len() == 32 {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&root_vec);
                self.active_mode = "owner".into();
                self.session_token = Some(sess.token);
                self.root_key_bytes = Some(arr);
                self.email_private_key_pkcs8_b64 = Some(sess.email_private_key_pkcs8_b64);
                return Ok(());
            }
        }

        if let Ok(pw) = std::env::var("NONEPWD_MASTER_PASSWORD") {
            if !pw.is_empty() && cfg.secret_key.is_some() {
                self.signin(None, None, None, &pw)?;
                return Ok(());
            }
        }

        Err("nonepwd CLI is locked. Run `np signin` or set NONEPWD_TOKEN.".into())
    }

    pub fn sync(&mut self) -> Result<(), String> {
        self.ensure_authenticated()?;

        #[derive(Deserialize)]
        struct SyncResp {
            kind: String,
            vaults: Vec<EncryptedVaultRow>,
            items: Vec<EncryptedItemRow>,
            #[serde(default)]
            aliases: Vec<AliasRecord>,
            #[serde(default)]
            emails: Vec<EncryptedEmailRow>,
        }

        let data: SyncResp = self.request_json("GET", "/api/sync", None, false)?;
        let mut vault_map: HashMap<String, DecryptedVault> = HashMap::new();
        let mut decrypted_vaults = Vec::new();

        if data.kind == "service_account" {
            let tok = self
                .service_account_token
                .as_ref()
                .ok_or("Missing service account token")?;
            let sa = decode_service_account_token(tok)?;
            let wrap_key = from_base64_url(&sa.wrap_key_b64)?;
            for v in data.vaults {
                let key_vec =
                    decrypt_bytes(&wrap_key, &v.encrypted_key, Some(&aad::vault_sa_key(&v.id, &sa.token_id)))?;
                let mut key_arr = [0u8; 32];
                if key_vec.len() != 32 {
                    return Err("Invalid vault key length".into());
                }
                key_arr.copy_from_slice(&key_vec);
                let metadata: VaultMetadata =
                    decrypt_json(&key_arr, &v.encrypted_meta, Some(&aad::vault_meta(&v.id)))?;
                let dv = DecryptedVault {
                    id: v.id.clone(),
                    metadata,
                    key_bytes: key_arr,
                };
                vault_map.insert(v.id, dv.clone());
                decrypted_vaults.push(dv);
            }
        } else {
            let root_key = self.root_key_bytes.ok_or("Missing owner root key")?;
            for v in data.vaults {
                let key_vec =
                    decrypt_bytes(&root_key, &v.encrypted_key, Some(&aad::vault_owner_key(&v.id)))?;
                let mut key_arr = [0u8; 32];
                if key_vec.len() != 32 {
                    return Err("Invalid vault key length".into());
                }
                key_arr.copy_from_slice(&key_vec);
                let metadata: VaultMetadata =
                    decrypt_json(&key_arr, &v.encrypted_meta, Some(&aad::vault_meta(&v.id)))?;
                let dv = DecryptedVault {
                    id: v.id.clone(),
                    metadata,
                    key_bytes: key_arr,
                };
                vault_map.insert(v.id, dv.clone());
                decrypted_vaults.push(dv);
            }
        }

        let mut decrypted_items = Vec::new();
        for item in data.items {
            if let Some(vault) = vault_map.get(&item.vault_id) {
                let payload: VaultItemPayload = decrypt_json(
                    &vault.key_bytes,
                    &item.encrypted_data,
                    Some(&aad::vault_item(&item.vault_id, &item.id)),
                )?;
                decrypted_items.push(DecryptedItem {
                    id: item.id,
                    vault_id: item.vault_id,
                    vault_name: vault.metadata.name.clone(),
                    payload,
                });
            }
        }

        let mut decrypted_emails = Vec::new();
        if let Some(priv_key) = &self.email_private_key_pkcs8_b64 {
            for em in data.emails {
                if let Ok(opened) =
                    open_sealed_json::<DecryptedEmailPayload>(priv_key, &em.sealed_envelope, "nonepwd-email-v1")
                {
                    decrypted_emails.push(DecryptedEmailItem {
                        id: em.id,
                        source: em.source,
                        envelope_to: em.envelope_to,
                        payload: opened,
                    });
                }
            }
        }

        self.vaults = decrypted_vaults;
        self.items = decrypted_items;
        self.aliases = data.aliases;
        self.emails = decrypted_emails;
        Ok(())
    }

    pub fn find_vault(&self, name_or_id: &str) -> Result<&DecryptedVault, String> {
        let q = name_or_id.trim();
        self.vaults
            .iter()
            .find(|v| v.id == q)
            .or_else(|| {
                self.vaults
                    .iter()
                    .find(|v| v.metadata.name.eq_ignore_ascii_case(q))
            })
            .ok_or_else(|| format!("Vault not found: \"{name_or_id}\""))
    }

    pub fn find_item(
        &self,
        item_name_or_id: &str,
        vault_name_or_id: Option<&str>,
    ) -> Result<&DecryptedItem, String> {
        let vault_id = match vault_name_or_id {
            Some(v) => Some(self.find_vault(v)?.id.clone()),
            None => None,
        };
        let q = item_name_or_id.trim();
        self.items
            .iter()
            .filter(|i| vault_id.as_ref().map(|vid| &i.vault_id == vid).unwrap_or(true))
            .find(|i| i.id == q)
            .or_else(|| {
                self.items
                    .iter()
                    .filter(|i| vault_id.as_ref().map(|vid| &i.vault_id == vid).unwrap_or(true))
                    .find(|i| i.payload.title.eq_ignore_ascii_case(q))
            })
            .ok_or_else(|| format!("Item not found: \"{item_name_or_id}\""))
    }

    pub fn create_vault(&mut self, name: &str, description: Option<&str>) -> Result<DecryptedVault, String> {
        self.ensure_authenticated()?;
        let root_key = self
            .root_key_bytes
            .ok_or("Only owner session can create vaults")?;
        let id = random_id()?;
        let key_bytes = generate_raw_aes_key()?;
        let meta = VaultMetadata {
            name: name.trim().to_string(),
            description: description.map(str::to_string),
            icon: None,
            color: None,
        };
        let encrypted_key = encrypt_bytes(&root_key, &key_bytes, Some(&aad::vault_owner_key(&id)))?;
        let encrypted_meta = encrypt_json(&key_bytes, &meta, Some(&aad::vault_meta(&id)))?;

        let _: serde_json::Value = self.request_json(
            "POST",
            "/api/vaults",
            Some(&serde_json::json!({
                "id": id,
                "encryptedKey": encrypted_key,
                "encryptedMeta": encrypted_meta,
            })),
            false,
        )?;

        let dv = DecryptedVault {
            id,
            metadata: meta,
            key_bytes,
        };
        self.vaults.push(dv.clone());
        Ok(dv)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_item(
        &mut self,
        vault_name_or_id: &str,
        title: &str,
        category: ItemCategory,
        urls: Vec<String>,
        username: Option<String>,
        password: Option<String>,
        generate_pass: bool,
        totp: Option<String>,
        email_alias: Option<String>,
        auto_alias: bool,
        notes: Option<String>,
        custom_fields: Vec<(String, String)>,
    ) -> Result<DecryptedItem, String> {
        self.sync()?;
        if self.active_mode != "owner" {
            return Err("Only owner session can create items".into());
        }
        let vault = self.find_vault(vault_name_or_id)?.clone();
        let id = random_id()?;
        let now = now_iso_utc();

        let final_alias = if auto_alias && email_alias.is_none() {
            let site = urls.first().map(String::as_str).unwrap_or(title);
            let alias = self.create_alias(site, None, Some(&vault.id), Some(&id))?;
            Some(alias.address)
        } else {
            email_alias
        };

        let final_pass = if generate_pass {
            Some(generate_password(&PasswordOptions::default())?)
        } else {
            password
        };

        let mut cf_list = Vec::with_capacity(custom_fields.len());
        for (label, value) in custom_fields {
            cf_list.push(CustomField {
                id: random_id()?,
                label,
                value,
                field_type: "concealed".into(),
            });
        }

        let payload = VaultItemPayload {
            id: id.clone(),
            vault_id: vault.id.clone(),
            category,
            title: title.trim().to_string(),
            favorite: false,
            tags: Vec::new(),
            urls,
            username: username.or_else(|| final_alias.clone()),
            password: final_pass,
            totp,
            email_alias: final_alias,
            notes,
            custom_fields: cf_list,
            created_at: now.clone(),
            updated_at: now,
            last_used_at: None,
        };

        let encrypted_data =
            encrypt_json(&vault.key_bytes, &payload, Some(&aad::vault_item(&vault.id, &id)))?;
        let path = format!("/api/vaults/{}/items", vault.id);
        let _: serde_json::Value = self.request_json(
            "POST",
            &path,
            Some(&serde_json::json!({ "id": id, "encryptedData": encrypted_data })),
            false,
        )?;

        let created = DecryptedItem {
            id,
            vault_id: vault.id,
            vault_name: vault.metadata.name,
            payload,
        };
        self.items.insert(0, created.clone());
        Ok(created)
    }

    pub fn delete_item(&mut self, item_ref: &str, vault_ref: Option<&str>) -> Result<(), String> {
        self.sync()?;
        let item = self.find_item(item_ref, vault_ref)?.clone();
        let path = format!("/api/vaults/{}/items/{}", item.vault_id, item.id);
        let _: serde_json::Value = self.request_json("DELETE", &path, None, false)?;
        self.items.retain(|i| i.id != item.id);
        Ok(())
    }

    pub fn get_totp(&mut self, item_ref: &str, vault_ref: Option<&str>) -> Result<TotpResult, String> {
        self.sync()?;
        let item = self.find_item(item_ref, vault_ref)?;
        let secret = item
            .payload
            .totp
            .as_deref()
            .ok_or_else(|| format!("Item \"{}\" has no TOTP secret configured", item.payload.title))?;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        generate_totp(secret, now_ms)
    }

    pub fn resolve_secret_ref(&mut self, uri: &str) -> Result<String, String> {
        self.sync()?;
        let parsed = parse_secret_ref(uri)?;
        let item = self.find_item(&parsed.item, Some(&parsed.vault))?.clone();
        let field_lower = parsed.field.to_ascii_lowercase();

        if field_lower == "totp" || field_lower == "otp" {
            let secret = item
                .payload
                .totp
                .as_deref()
                .ok_or_else(|| format!("No TOTP secret configured for {uri}"))?;
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            return Ok(generate_totp(secret, now_ms)?.code);
        }

        if field_lower == "email_otp" || field_lower == "email-otp" {
            let wait_secs: f64 = parsed
                .params
                .get("wait")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            let email = self.wait_for_email_otp(
                item.payload.urls.first().map(String::as_str),
                item.payload.email_alias.as_deref(),
                wait_secs,
            )?;
            return email
                .payload
                .otp_code
                .ok_or_else(|| format!("No email OTP found for {uri}"));
        }

        resolve_item_field(&item.payload, &parsed.field).ok_or_else(|| {
            format!(
                "Field \"{}\" not found on item \"{}\"",
                parsed.field, item.payload.title
            )
        })
    }

    fn matches_email_filter(
        em: &DecryptedEmailPayload,
        domain: Option<&str>,
        alias: Option<&str>,
        min_epoch_secs: i64,
    ) -> bool {
        if em.otp_code.is_none() {
            return false;
        }
        if let Some(ts) = parse_iso_epoch_secs(&em.received_at) {
            if ts < min_epoch_secs {
                return false;
            }
        }
        if let Some(a) = alias {
            if !em.to.eq_ignore_ascii_case(a) {
                return false;
            }
        }
        if let Some(d) = domain {
            let candidate = if em.sender_domain.is_empty() {
                em.from.as_str()
            } else {
                em.sender_domain.as_str()
            };
            if !domains_match(candidate, d) {
                return false;
            }
        }
        true
    }

    pub fn wait_for_email_otp(
        &mut self,
        domain: Option<&str>,
        alias: Option<&str>,
        wait_seconds: f64,
    ) -> Result<DecryptedEmailItem, String> {
        self.sync()?;
        let priv_key = self
            .email_private_key_pkcs8_b64
            .clone()
            .ok_or("Email OTP decryption requires an owner session (not Service Account)")?;

        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let lookback_secs = now_secs - 300;

        if let Some(found) = self
            .emails
            .iter()
            .find(|em| Self::matches_email_filter(&em.payload, domain, alias, lookback_secs))
        {
            return Ok(found.clone());
        }

        if wait_seconds <= 0.0 {
            return Err("No matching email OTP code found".into());
        }

        let base = self.get_server_url()?;
        let ws_base = if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            base
        };
        let token = self
            .session_token
            .as_deref()
            .ok_or("Missing session token")?;
        let ws_url = format!("{ws_base}/api/ws?token={token}");

        let deadline = Instant::now() + Duration::from_secs_f64(wait_seconds);
        let mut ws = connect_ws(&ws_url, Some(Duration::from_millis(500)))?;

        loop {
            if Instant::now() >= deadline {
                let _ = ws.close(None);
                return Err(format!("Timed out after {wait_seconds}s waiting for email OTP"));
            }

            match ws.read() {
                Ok(Message::Text(txt)) => {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(txt.as_ref()) {
                        if val["type"].as_str() == Some("email.received") {
                            if let Ok(row) =
                                serde_json::from_value::<EncryptedEmailRow>(val["email"].clone())
                            {
                                if let Ok(opened) = open_sealed_json::<DecryptedEmailPayload>(
                                    &priv_key,
                                    &row.sealed_envelope,
                                    "nonepwd-email-v1",
                                ) {
                                    let item = DecryptedEmailItem {
                                        id: row.id,
                                        source: row.source,
                                        envelope_to: row.envelope_to,
                                        payload: opened,
                                    };
                                    if Self::matches_email_filter(
                                        &item.payload,
                                        domain,
                                        alias,
                                        lookback_secs,
                                    ) {
                                        let _ = ws.close(None);
                                        return Ok(item);
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(Message::Ping(payload)) => {
                    let _ = ws.send(Message::Pong(payload));
                }
                Ok(Message::Close(_)) => {
                    return Err("WebSocket closed before email OTP arrived".into());
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(ref e))
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    continue;
                }
                Err(e) => return Err(format!("WebSocket error: {e}")),
            }
        }
    }

    pub fn create_alias(
        &mut self,
        site_domain: &str,
        address: Option<&str>,
        vault_id: Option<&str>,
        item_id: Option<&str>,
    ) -> Result<AliasRecord, String> {
        self.ensure_authenticated()?;
        let resp: serde_json::Value = self.request_json(
            "POST",
            "/api/aliases",
            Some(&serde_json::json!({
                "siteDomain": site_domain,
                "address": address,
                "vaultId": vault_id,
                "itemId": item_id,
            })),
            false,
        )?;
        serde_json::from_value(resp["alias"].clone()).map_err(|e| e.to_string())
    }

    pub fn toggle_alias(&mut self, id_or_addr: &str) -> Result<AliasRecord, String> {
        self.sync()?;
        let found = self
            .aliases
            .iter()
            .find(|a| a.id == id_or_addr || a.address.eq_ignore_ascii_case(id_or_addr))
            .ok_or_else(|| format!("Alias not found: {id_or_addr}"))?
            .clone();
        let path = format!("/api/aliases/{}", found.id);
        let resp: serde_json::Value = self.request_json(
            "PATCH",
            &path,
            Some(&serde_json::json!({ "enabled": !found.enabled })),
            false,
        )?;
        serde_json::from_value(resp["alias"].clone()).map_err(|e| e.to_string())
    }

    pub fn list_service_accounts(&mut self) -> Result<Vec<ServiceAccountRecord>, String> {
        self.ensure_authenticated()?;
        let resp: serde_json::Value =
            self.request_json("GET", "/api/service-accounts", None, false)?;
        serde_json::from_value(resp["serviceAccounts"].clone()).map_err(|e| e.to_string())
    }

    pub fn create_service_account(
        &mut self,
        name: &str,
        vault_refs: &[String],
    ) -> Result<serde_json::Value, String> {
        self.sync()?;
        if self.active_mode != "owner" {
            return Err("Only owner session can create Service Accounts".into());
        }
        let rand_id = random_id()?.replace('-', "");
        let sa_id = format!("sa_{}", &rand_id[..16]);
        let auth_secret = to_base64_url(&random_bytes(24)?);
        let wrap_key = generate_raw_aes_key()?;

        let mut vault_keys = Vec::with_capacity(vault_refs.len());
        for vr in vault_refs {
            let v = self.find_vault(vr)?;
            vault_keys.push(serde_json::json!({
                "vaultId": v.id,
                "encryptedVaultKey": encrypt_bytes(&wrap_key, &v.key_bytes, Some(&aad::vault_sa_key(&v.id, &sa_id)))?,
            }));
        }

        let resp: serde_json::Value = self.request_json(
            "POST",
            "/api/service-accounts",
            Some(&serde_json::json!({
                "id": sa_id,
                "name": name,
                "authSecret": auth_secret,
                "vaultKeys": vault_keys,
            })),
            false,
        )?;

        let token = encode_service_account_token(&ServiceAccountTokenPayload {
            v: 1,
            server_url: self.get_server_url()?,
            token_id: sa_id,
            auth_secret,
            wrap_key_b64: to_base64_url(&wrap_key),
        })?;

        Ok(serde_json::json!({
            "serviceAccount": resp["serviceAccount"],
            "token": token,
        }))
    }

    pub fn revoke_service_account(&mut self, id: &str) -> Result<(), String> {
        self.ensure_authenticated()?;
        let path = format!("/api/service-accounts/{id}");
        let _: serde_json::Value = self.request_json("DELETE", &path, None, false)?;
        Ok(())
    }
}
