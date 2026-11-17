use nonepwd_core::crypto::seal_json_for_public_key;
use nonepwd_core::otp_extractor::{
    extract_email_address, extract_email_otp, EmailOtpExtractionInput,
};
use nonepwd_core::random::random_id;
use nonepwd_core::types::{DecryptedEmailPayload, SealedEnvelope};
use regex::RegexBuilder;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::now_iso_millis;
use crate::db::{EmailFilterConfig, EmailFilterField, EmailFilterMode, NonePwdDb};
use crate::mime::parse_mime;
use crate::ws::{BroadcastOptions, WsHub};

const MAX_STORED_EMAILS: i64 = 200;
const EMAIL_SEAL_INFO: &str = "nonepwd-email-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedEmailRecord {
    pub id: String,
    pub source: String,
    pub envelope_to: Option<String>,
    pub has_otp: bool,
    pub sealed_envelope: SealedEnvelope,
    pub received_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestResult {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<EncryptedEmailRecord>,
}

struct AliasCheck {
    allowed: bool,
    alias_id: Option<String>,
}

fn check_alias_allowed(db: &NonePwdDb, target_email: Option<&str>) -> AliasCheck {
    let Some(target) = target_email.filter(|s| !s.trim().is_empty()) else {
        return AliasCheck {
            allowed: true,
            alias_id: None,
        };
    };
    let clean = extract_email_address(target);
    if clean.is_empty() {
        return AliasCheck {
            allowed: true,
            alias_id: None,
        };
    }

    let conn = db.lock_conn();
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT id, enabled FROM aliases WHERE LOWER(address) = ?1",
            params![clean],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();

    match row {
        None => AliasCheck {
            allowed: true,
            alias_id: None,
        },
        Some((id, enabled)) => AliasCheck {
            allowed: enabled != 0,
            alias_id: Some(id),
        },
    }
}

pub struct FilterEvalContext<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub subject: &'a str,
    pub body: &'a str,
    pub raw_text: Option<&'a str>,
    pub has_otp: bool,
    pub edge_sealed: bool,
}

fn rule_matches_field(pattern: &str, field: EmailFilterField, ctx: &FilterEvalContext<'_>) -> bool {
    let Ok(re) = RegexBuilder::new(pattern).size_limit(1 << 20).build() else {
        return false;
    };
    match field {
        EmailFilterField::From => {
            if re.is_match(ctx.from) {
                return true;
            }
            let bare = extract_email_address(ctx.from);
            !bare.is_empty() && re.is_match(&bare)
        }
        EmailFilterField::To => {
            if re.is_match(ctx.to) {
                return true;
            }
            let bare = extract_email_address(ctx.to);
            !bare.is_empty() && re.is_match(&bare)
        }
        EmailFilterField::Subject => re.is_match(ctx.subject),
        EmailFilterField::Body => {
            re.is_match(ctx.body) || ctx.raw_text.is_some_and(|t| re.is_match(t))
        }
    }
}

pub fn evaluate_email_filter(filter: &EmailFilterConfig, ctx: &FilterEvalContext<'_>) -> bool {
    if !filter.enabled {
        return true;
    }

    if filter.otp_only && !ctx.has_otp {
        return false;
    }

    let enabled_rules: Vec<_> = filter.rules.iter().filter(|r| r.enabled).collect();
    if enabled_rules.is_empty() {
        if filter.otp_only {
            return true;
        }
        return matches!(filter.mode, EmailFilterMode::Deny);
    }

    if ctx.edge_sealed {
        let to_rules: Vec<_> = enabled_rules
            .into_iter()
            .filter(|r| r.field == EmailFilterField::To)
            .collect();
        if to_rules.is_empty() {
            return true;
        }
        let any_match = to_rules
            .iter()
            .any(|r| rule_matches_field(&r.pattern, r.field, ctx));
        return match filter.mode {
            EmailFilterMode::Allow => any_match,
            EmailFilterMode::Deny => !any_match,
        };
    }

    let any_match = enabled_rules
        .iter()
        .any(|r| rule_matches_field(&r.pattern, r.field, ctx));
    match filter.mode {
        EmailFilterMode::Allow => any_match,
        EmailFilterMode::Deny => !any_match,
    }
}

fn store_sealed_email(
    db: &NonePwdDb,
    ws_hub: &WsHub,
    id: String,
    source: &str,
    envelope_to: Option<String>,
    has_otp: bool,
    sealed_envelope: SealedEnvelope,
    received_at: String,
    alias_id: Option<String>,
) -> Result<EncryptedEmailRecord, String> {
    let sealed_json = serde_json::to_string(&sealed_envelope)
        .map_err(|e| format!("Failed serializing sealed envelope: {e}"))?;

    {
        let conn = db.lock_conn();
        conn.execute(
            "INSERT INTO encrypted_emails (id, source, envelope_to, has_otp, sealed_envelope, received_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                source,
                envelope_to,
                if has_otp { 1i64 } else { 0i64 },
                sealed_json,
                received_at
            ],
        )
        .map_err(|e| format!("Failed inserting encrypted email: {e}"))?;

        if let Some(ref aid) = alias_id {
            let _ = conn.execute(
                "UPDATE aliases SET received_count = received_count + 1 WHERE id = ?1",
                params![aid],
            );
        }

        let _ = conn.execute(
            "DELETE FROM encrypted_emails WHERE id NOT IN (
               SELECT id FROM encrypted_emails ORDER BY received_at DESC LIMIT ?1
             )",
            params![MAX_STORED_EMAILS],
        );
    }

    let record = EncryptedEmailRecord {
        id,
        source: source.to_string(),
        envelope_to,
        has_otp,
        sealed_envelope,
        received_at,
    };

    ws_hub.broadcast(
        &json!({
            "type": "email.received",
            "email": record,
        }),
        BroadcastOptions::default(),
    );

    Ok(record)
}

pub fn ingest_raw_email(
    db: &NonePwdDb,
    ws_hub: &WsHub,
    raw_mime: &[u8],
    source: &str,
    envelope_from: Option<&str>,
    envelope_to: Option<&str>,
) -> Result<IngestResult, String> {
    let email_public_key: Option<String> = {
        let conn = db.lock_conn();
        conn.query_row(
            "SELECT email_public_key FROM account WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("DB error reading account: {e}"))?
    };

    let Some(email_public_key) = email_public_key else {
        return Ok(IngestResult {
            accepted: false,
            reason: Some("account_not_initialized".to_string()),
            email: None,
        });
    };

    let parsed = parse_mime(raw_mime);
    let from_header = parsed
        .from_header
        .or_else(|| {
            envelope_from
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown@unknown".to_string());

    let to_addr = envelope_to
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or(parsed.to_address)
        .unwrap_or_default();

    let alias_check = check_alias_allowed(
        db,
        if to_addr.is_empty() {
            None
        } else {
            Some(&to_addr)
        },
    );
    if !alias_check.allowed {
        return Ok(IngestResult {
            accepted: false,
            reason: Some("alias_disabled".to_string()),
            email: None,
        });
    }

    let subject = parsed
        .subject
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(No Subject)".to_string());

    let extracted = extract_email_otp(&EmailOtpExtractionInput {
        from: from_header.clone(),
        to: to_addr.clone(),
        subject: subject.clone(),
        text: parsed.text.clone(),
        html: parsed.html.clone(),
    });

    let has_otp = extracted.otp_code.is_some();
    let clean_to = if to_addr.is_empty() {
        String::new()
    } else {
        extract_email_address(&to_addr)
    };

    let filter = db.get_email_filter();
    if !evaluate_email_filter(
        &filter,
        &FilterEvalContext {
            from: &from_header,
            to: if clean_to.is_empty() { &to_addr } else { &clean_to },
            subject: &subject,
            body: &extracted.clean_text,
            raw_text: parsed.text.as_deref(),
            has_otp,
            edge_sealed: false,
        },
    ) {
        return Ok(IngestResult {
            accepted: false,
            reason: Some("filtered".to_string()),
            email: None,
        });
    }

    let id = random_id()?;
    let received_at = now_iso_millis();
    let text_body: String = extracted.clean_text.chars().take(6000).collect();

    let payload = DecryptedEmailPayload {
        id: Some(id.clone()),
        from: from_header,
        to: clean_to.clone(),
        subject,
        snippet: extracted.snippet,
        text_body,
        otp_code: extracted.otp_code,
        confidence: extracted.confidence,
        magic_link: extracted.magic_link,
        sender_domain: extracted.sender_domain,
        received_at: received_at.clone(),
    };

    let sealed_envelope = seal_json_for_public_key(&email_public_key, &payload, EMAIL_SEAL_INFO)?;
    let record = store_sealed_email(
        db,
        ws_hub,
        id,
        source,
        if clean_to.is_empty() {
            None
        } else {
            Some(clean_to)
        },
        has_otp,
        sealed_envelope,
        received_at,
        alias_check.alias_id,
    )?;

    Ok(IngestResult {
        accepted: true,
        reason: None,
        email: Some(record),
    })
}

pub fn ingest_pre_sealed_email(
    db: &NonePwdDb,
    ws_hub: &WsHub,
    sealed_envelope: SealedEnvelope,
    has_otp: bool,
    envelope_to: Option<&str>,
    source: &str,
) -> Result<IngestResult, String> {
    let initialized: bool = {
        let conn = db.lock_conn();
        conn.query_row("SELECT id FROM account WHERE id = 1", [], |r| r.get::<_, i64>(0))
            .optional()
            .map_err(|e| format!("DB error reading account: {e}"))?
            .is_some()
    };

    if !initialized {
        return Ok(IngestResult {
            accepted: false,
            reason: Some("account_not_initialized".to_string()),
            email: None,
        });
    };

    let normalized_to = envelope_to
        .map(extract_email_address)
        .filter(|s| !s.is_empty());
    let alias_check = check_alias_allowed(db, normalized_to.as_deref());
    if !alias_check.allowed {
        return Ok(IngestResult {
            accepted: false,
            reason: Some("alias_disabled".to_string()),
            email: None,
        });
    }

    let filter = db.get_email_filter();
    if !evaluate_email_filter(
        &filter,
        &FilterEvalContext {
            from: "",
            to: normalized_to.as_deref().unwrap_or(""),
            subject: "",
            body: "",
            raw_text: None,
            has_otp,
            edge_sealed: true,
        },
    ) {
        return Ok(IngestResult {
            accepted: false,
            reason: Some("filtered".to_string()),
            email: None,
        });
    }

    let id = random_id()?;
    let received_at = now_iso_millis();
    let record = store_sealed_email(
        db,
        ws_hub,
        id,
        source,
        normalized_to,
        has_otp,
        sealed_envelope,
        received_at,
        alias_check.alias_id,
    )?;

    Ok(IngestResult {
        accepted: true,
        reason: None,
        email: Some(record),
    })
}

pub fn ingest_simulated_email(
    db: &NonePwdDb,
    ws_hub: &WsHub,
    from: &str,
    to: &str,
    subject: &str,
    text: Option<String>,
    html: Option<String>,
) -> Result<IngestResult, String> {
    let email_public_key: Option<String> = {
        let conn = db.lock_conn();
        conn.query_row(
            "SELECT email_public_key FROM account WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("DB error reading account: {e}"))?
    };

    let Some(email_public_key) = email_public_key else {
        return Ok(IngestResult {
            accepted: false,
            reason: Some("account_not_initialized".to_string()),
            email: None,
        });
    };

    let clean_to = extract_email_address(to);
    let alias_check = check_alias_allowed(
        db,
        if clean_to.is_empty() {
            None
        } else {
            Some(&clean_to)
        },
    );
    if !alias_check.allowed {
        return Ok(IngestResult {
            accepted: false,
            reason: Some("alias_disabled".to_string()),
            email: None,
        });
    }

    let extracted = extract_email_otp(&EmailOtpExtractionInput {
        from: from.to_string(),
        to: clean_to.clone(),
        subject: subject.to_string(),
        text: text.clone(),
        html,
    });

    let has_otp = extracted.otp_code.is_some();
    let filter = db.get_email_filter();
    if !evaluate_email_filter(
        &filter,
        &FilterEvalContext {
            from,
            to: if clean_to.is_empty() { to } else { &clean_to },
            subject,
            body: &extracted.clean_text,
            raw_text: text.as_deref(),
            has_otp,
            edge_sealed: false,
        },
    ) {
        return Ok(IngestResult {
            accepted: false,
            reason: Some("filtered".to_string()),
            email: None,
        });
    }

    let id = random_id()?;
    let received_at = now_iso_millis();
    let text_body: String = extracted.clean_text.chars().take(6000).collect();

    let payload = DecryptedEmailPayload {
        id: Some(id.clone()),
        from: from.to_string(),
        to: clean_to.clone(),
        subject: subject.to_string(),
        snippet: extracted.snippet,
        text_body,
        otp_code: extracted.otp_code,
        confidence: extracted.confidence,
        magic_link: extracted.magic_link,
        sender_domain: extracted.sender_domain,
        received_at: received_at.clone(),
    };

    let sealed_envelope = seal_json_for_public_key(&email_public_key, &payload, EMAIL_SEAL_INFO)?;
    let record = store_sealed_email(
        db,
        ws_hub,
        id,
        "simulate",
        if clean_to.is_empty() {
            None
        } else {
            Some(clean_to)
        },
        has_otp,
        sealed_envelope,
        received_at,
        alias_check.alias_id,
    )?;

    Ok(IngestResult {
        accepted: true,
        reason: None,
        email: Some(record),
    })
}
