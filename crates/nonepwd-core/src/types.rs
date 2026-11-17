use serde::{Deserialize, Serialize};

pub const DEFAULT_KDF_ITERATIONS: u32 = 600_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultMetadata {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ItemCategory {
    Login,
    ApiCredential,
    SecureNote,
    SshKey,
    Card,
    Identity,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CardDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cardholder_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exp_month: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exp_year: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cvv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdentityDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub company: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address2: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postal_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomField {
    pub id: String,
    pub label: String,
    pub value: String,
    #[serde(rename = "type")]
    pub field_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultItemPayload {
    pub id: String,
    pub vault_id: String,
    pub category: ItemCategory,
    pub title: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<CardDetails>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<IdentityDetails>,
    #[serde(default)]
    pub custom_fields: Vec<CustomField>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RootKeysetPayload {
    pub root_key_b64: String,
    pub email_private_key_pkcs8_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SealedEnvelope {
    pub v: u8,
    pub epk: String,
    pub iv: String,
    pub ct: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DecryptedEmailPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub from: String,
    pub to: String,
    pub subject: String,
    pub snippet: String,
    pub text_body: String,
    pub otp_code: Option<String>,
    pub confidence: f64,
    pub magic_link: Option<String>,
    pub sender_domain: String,
    pub received_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceAccountTokenPayload {
    pub v: u8,
    pub server_url: String,
    pub token_id: String,
    pub auth_secret: String,
    pub wrap_key_b64: String,
}

pub mod aad {
    pub const ROOT_KEYSET: &str = "nonepwd:root-keyset:v1";

    pub fn vault_meta(vault_id: &str) -> String {
        format!("nonepwd:vault:{vault_id}:meta")
    }

    pub fn vault_owner_key(vault_id: &str) -> String {
        format!("nonepwd:vault:{vault_id}:owner-key")
    }

    pub fn vault_sa_key(vault_id: &str, service_account_id: &str) -> String {
        format!("nonepwd:vault:{vault_id}:sa:{service_account_id}")
    }

    pub fn vault_item(vault_id: &str, item_id: &str) -> String {
        format!("nonepwd:vault:{vault_id}:item:{item_id}")
    }
}
