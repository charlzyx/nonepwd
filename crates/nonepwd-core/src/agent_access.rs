//! Map nonepwd vault items onto Agent Access protocol v0 credential queries.
//!
//! Domain matching reuses the vault's existing host / eTLD+1 rules. TOTP seeds
//! stay on this side: callers only ever receive the current code.

use crate::otp_extractor::{domains_match, extract_host};
use crate::totp::generate_totp;
use crate::types::VaultItemPayload;

/// One credential lookup from a remote agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentQuery {
    Domain(String),
    Id(String),
    Search(String),
}

impl std::fmt::Display for AgentQuery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentQuery::Domain(v) => write!(f, "domain {v}"),
            AgentQuery::Id(v) => write!(f, "id {v}"),
            AgentQuery::Search(v) => write!(f, "search {v}"),
        }
    }
}

/// Credential fields carried by an Agent Access `credential-response`.
///
/// `totp` is the current one-time code when the item has a seed. The seed
/// itself is never copied into any field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCredential {
    pub credential_id: Option<String>,
    pub domain: Option<String>,
    pub uri: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub totp: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentLookupError {
    EmptyQuery,
    NotFound,
    Ambiguous { count: usize },
}

impl std::fmt::Display for AgentLookupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentLookupError::EmptyQuery => write!(f, "empty credential query"),
            AgentLookupError::NotFound => write!(f, "no matching credential"),
            AgentLookupError::Ambiguous { count } => {
                write!(f, "ambiguous credential query ({count} matches)")
            }
        }
    }
}

/// Find the single vault item a remote query is allowed to see.
pub fn lookup_agent_item<'a>(
    items: &[&'a VaultItemPayload],
    query: &AgentQuery,
) -> Result<&'a VaultItemPayload, AgentLookupError> {
    let matched: Vec<&VaultItemPayload> = match query {
        AgentQuery::Domain(raw) => {
            let q = raw.trim();
            if q.is_empty() {
                return Err(AgentLookupError::EmptyQuery);
            }
            items
                .iter()
                .copied()
                .filter(|item| item_matches_domain(item, q))
                .collect()
        }
        AgentQuery::Id(raw) => {
            let q = raw.trim();
            if q.is_empty() {
                return Err(AgentLookupError::EmptyQuery);
            }
            items.iter().copied().filter(|item| item.id == q).collect()
        }
        AgentQuery::Search(raw) => {
            let q = raw.trim().to_lowercase();
            if q.is_empty() {
                return Err(AgentLookupError::EmptyQuery);
            }
            items
                .iter()
                .copied()
                .filter(|item| search_blob(item).contains(&q))
                .collect()
        }
    };
    match matched.len() {
        0 => Err(AgentLookupError::NotFound),
        1 => Ok(matched[0]),
        n => Err(AgentLookupError::Ambiguous { count: n }),
    }
}

fn item_matches_domain(item: &VaultItemPayload, query: &str) -> bool {
    item.urls.iter().any(|url| domains_match(url, query))
}

fn search_blob(item: &VaultItemPayload) -> String {
    let mut parts = Vec::new();
    parts.push(item.title.as_str());
    parts.push(item.id.as_str());
    if let Some(u) = item.username.as_deref() {
        parts.push(u);
    }
    if let Some(n) = item.notes.as_deref() {
        parts.push(n);
    }
    if let Some(a) = item.email_alias.as_deref() {
        parts.push(a);
    }
    for url in &item.urls {
        parts.push(url);
    }
    parts.join("\n").to_lowercase()
}

/// Project a vault item into Agent Access credential fields.
///
/// `now_ms` is the unix time in milliseconds used for the TOTP counter.
pub fn map_agent_credential(
    item: &VaultItemPayload,
    now_ms: u64,
) -> Result<AgentCredential, String> {
    let uri = select_uri(item);
    let domain = uri.as_deref().map(extract_host).filter(|h| !h.is_empty());
    let totp = match item
        .totp
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(seed) => match generate_totp(seed, now_ms) {
            Ok(result) => Some(result.code),
            Err(_) => None,
        },
        None => None,
    };
    Ok(AgentCredential {
        credential_id: Some(item.id.clone()),
        domain,
        uri,
        username: nonempty(item.username.clone()),
        password: password_field(item),
        totp,
        notes: nonempty(item.notes.clone()),
    })
}

fn select_uri(item: &VaultItemPayload) -> Option<String> {
    item.urls
        .iter()
        .find(|u| !u.trim().is_empty())
        .cloned()
        .map(|u| u.trim().to_string())
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.trim().is_empty())
}

fn password_field(item: &VaultItemPayload) -> Option<String> {
    if let Some(password) = nonempty(item.password.clone()) {
        return Some(password);
    }
    for field in &item.custom_fields {
        if is_secret_label(&field.label) {
            if let Some(value) = nonempty(Some(field.value.clone())) {
                return Some(value);
            }
        }
    }
    None
}

fn is_secret_label(label: &str) -> bool {
    let norm: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();
    matches!(
        norm.as_str(),
        "password" | "pass" | "credential" | "apikey" | "token" | "secret"
    )
}

/// Turn an http(s) nonepwd server origin into the built-in relay WebSocket URL.
///
/// `ws://` and `wss://` inputs are treated as an already-qualified relay base
/// and gain `/agent/relay` when that path is missing. The Bitwarden hosted
/// relay is never substituted.
pub fn relay_url_from_server(server_or_relay: &str) -> Result<String, String> {
    let trimmed = server_or_relay.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("server URL is empty".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("ap.lesspassword.dev") {
        return Err(
            "refusing Bitwarden's hosted relay (ap.lesspassword.dev); point --relay-url at this nonepwd server"
                .into(),
        );
    }
    if lower.starts_with("ws://") || lower.starts_with("wss://") {
        if lower.ends_with("/agent/relay") {
            return Ok(trimmed.to_string());
        }
        return Ok(format!("{trimmed}/agent/relay"));
    }
    let (scheme, rest) = if let Some(rest) = trimmed.strip_prefix("https://") {
        ("wss", rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        ("ws", rest)
    } else if let Some(rest) = lower.strip_prefix("https://") {
        ("wss", rest)
    } else if let Some(rest) = lower.strip_prefix("http://") {
        ("ws", rest)
    } else {
        return Err(format!(
            "unsupported server URL \"{trimmed}\" (expected http, https, ws, or wss)"
        ));
    };
    if rest.is_empty() {
        return Err("server URL is missing a host".into());
    }
    let rest = rest.trim_end_matches('/');
    if rest.to_ascii_lowercase().ends_with("/agent/relay") {
        return Ok(format!("{scheme}://{rest}"));
    }
    Ok(format!("{scheme}://{rest}/agent/relay"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::totp::generate_totp;
    use crate::types::{CustomField, ItemCategory, VaultItemPayload};

    fn item(id: &str, title: &str, urls: &[&str]) -> VaultItemPayload {
        VaultItemPayload {
            id: id.into(),
            vault_id: "v1".into(),
            category: ItemCategory::Login,
            title: title.into(),
            favorite: false,
            tags: vec![],
            urls: urls.iter().map(|s| (*s).to_string()).collect(),
            username: Some(format!("{id}@example.com")),
            password: Some(format!("pw-{id}")),
            totp: None,
            email_alias: None,
            notes: Some(format!("notes-{id}")),
            card: None,
            identity: None,
            custom_fields: vec![],
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            last_used_at: None,
        }
    }

    #[test]
    fn domain_lookup_matches_host_and_etld_plus_one() {
        let github = item("gh", "GitHub", &["https://github.com/login"]);
        let docs = item("docs", "Docs", &["https://docs.github.com/path"]);
        let other = item("gl", "GitLab", &["https://gitlab.com"]);
        let not = item("ng", "Not GitHub", &["https://notgithub.com"]);
        let items = vec![&github, &docs, &other, &not];

        let hit = lookup_agent_item(
            &[&github, &other, &not],
            &AgentQuery::Domain("github.com".into()),
        )
        .unwrap();
        assert_eq!(hit.id, "gh");

        let err = lookup_agent_item(
            &items,
            &AgentQuery::Domain("https://github.com/settings".into()),
        )
        .unwrap_err();
        assert_eq!(err, AgentLookupError::Ambiguous { count: 2 });

        let miss = lookup_agent_item(&items, &AgentQuery::Domain("notgithub.com".into())).unwrap();
        assert_eq!(miss.id, "ng");

        assert_eq!(
            lookup_agent_item(&items, &AgentQuery::Domain("example.org".into())).unwrap_err(),
            AgentLookupError::NotFound
        );
    }

    #[test]
    fn id_is_exact_and_search_is_ambiguous_on_multiple_hits() {
        let github = item("id-gh", "GitHub", &["https://github.com"]);
        let gitlab = item("id-gl", "GitLab", &["https://gitlab.com"]);
        let items = vec![&github, &gitlab];

        assert_eq!(
            lookup_agent_item(&items, &AgentQuery::Id("id-gh".into()))
                .unwrap()
                .id,
            "id-gh"
        );
        assert_eq!(
            lookup_agent_item(&items, &AgentQuery::Id("GitHub".into())).unwrap_err(),
            AgentLookupError::NotFound
        );
        assert_eq!(
            lookup_agent_item(&items, &AgentQuery::Search("git".into())).unwrap_err(),
            AgentLookupError::Ambiguous { count: 2 }
        );
        assert_eq!(
            lookup_agent_item(&items, &AgentQuery::Search("gitlab.com".into()))
                .unwrap()
                .id,
            "id-gl"
        );
        assert_eq!(
            lookup_agent_item(&items, &AgentQuery::Search("  ".into())).unwrap_err(),
            AgentLookupError::EmptyQuery
        );
    }

    #[test]
    fn mapping_emits_login_fields_and_current_totp_only() {
        let mut login = item("id-1", "GitHub", &["https://github.com/login"]);
        login.username = Some("alice".into());
        login.password = Some("hunter2".into());
        login.notes = Some("work account".into());
        let seed = "JBSWY3DPEHPK3PXP";
        login.totp = Some(seed.into());
        let now_ms = 1_700_000_000_000u64;
        let mapped = map_agent_credential(&login, now_ms).unwrap();
        let expected = generate_totp(seed, now_ms).unwrap().code;

        assert_eq!(mapped.credential_id.as_deref(), Some("id-1"));
        assert_eq!(mapped.username.as_deref(), Some("alice"));
        assert_eq!(mapped.password.as_deref(), Some("hunter2"));
        assert_eq!(mapped.notes.as_deref(), Some("work account"));
        assert_eq!(mapped.uri.as_deref(), Some("https://github.com/login"));
        assert_eq!(mapped.domain.as_deref(), Some("github.com"));
        assert_eq!(mapped.totp.as_deref(), Some(expected.as_str()));
        assert_ne!(mapped.totp.as_deref(), Some(seed));
        let rendered = format!("{mapped:?}");
        assert!(!rendered.contains(seed));
    }

    #[test]
    fn api_credential_secret_comes_from_custom_field_not_totp_seed() {
        let mut api = item("api-1", "OpenAI", &["https://api.openai.com/v1"]);
        api.category = ItemCategory::ApiCredential;
        api.password = None;
        api.username = None;
        api.totp = Some("JBSWY3DPEHPK3PXP".into());
        api.custom_fields = vec![CustomField {
            id: "f1".into(),
            label: "credential".into(),
            value: "sk-test".into(),
            field_type: "concealed".into(),
        }];
        let mapped = map_agent_credential(&api, 1_700_000_000_000).unwrap();
        assert_eq!(mapped.password.as_deref(), Some("sk-test"));
        assert!(mapped
            .totp
            .as_ref()
            .is_some_and(|c| c.chars().all(|ch| ch.is_ascii_digit())));
        assert_ne!(mapped.password.as_deref(), api.totp.as_deref());
    }

    #[test]
    fn relay_url_defaults_to_the_callers_server() {
        assert_eq!(
            relay_url_from_server("https://vault.example.com").unwrap(),
            "wss://vault.example.com/agent/relay"
        );
        assert_eq!(
            relay_url_from_server("http://127.0.0.1:8787/").unwrap(),
            "ws://127.0.0.1:8787/agent/relay"
        );
        assert_eq!(
            relay_url_from_server("ws://127.0.0.1:8787/agent/relay").unwrap(),
            "ws://127.0.0.1:8787/agent/relay"
        );
        assert!(relay_url_from_server("wss://ap.lesspassword.dev").is_err());
    }
}
