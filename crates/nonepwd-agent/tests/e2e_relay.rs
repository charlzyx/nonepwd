use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nonepwd_agent::{
    connect_and_request, resolve_items, start_user_agent, ApprovalSource, CredentialQuery,
    IdentityKeyPair, RemoteSession,
};
use nonepwd_core::types::{ItemCategory, VaultItemPayload};
use nonepwd_server::agent_relay::AgentRelay;
use tokio::sync::mpsc;

fn login(id: &str, title: &str, url: &str, password: &str) -> VaultItemPayload {
    VaultItemPayload {
        id: id.into(),
        vault_id: "vault".into(),
        category: ItemCategory::Login,
        title: title.into(),
        favorite: false,
        tags: vec![],
        urls: vec![url.into()],
        username: Some("alice".into()),
        password: Some(password.into()),
        totp: Some("JBSWY3DPEHPK3PXP".into()),
        email_alias: None,
        notes: Some("from the vault".into()),
        card: None,
        identity: None,
        custom_fields: vec![],
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
        last_used_at: None,
    }
}

#[tokio::test]
async fn pairing_approved_request_then_denied_request() {
    let relay = AgentRelay::new();
    let addr = relay.listen_ephemeral().await.unwrap();
    let relay_url = format!("ws://{addr}/agent/relay");

    let items = vec![
        login("item-gh", "GitHub", "https://github.com/login", "hunter2"),
        login("item-gl", "GitLab", "https://gitlab.com", "other"),
    ];
    let (decision_tx, decision_rx) = mpsc::unbounded_channel();
    let user = start_user_agent(
        relay_url.clone(),
        IdentityKeyPair::generate(),
        move |query| {
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            resolve_items(&items, query, now_ms)
        },
        ApprovalSource::Queue(decision_rx),
    )
    .await
    .unwrap();

    assert_eq!(user.token.len(), 129);
    assert_eq!(user.token.as_bytes()[64], b'_');
    assert!(!user.token.contains("lesspassword"));

    let remote = RemoteSession::pair(&relay_url, IdentityKeyPair::generate(), &user.token)
        .await
        .unwrap();

    decision_tx.send(true).unwrap();
    let cred = remote
        .request(
            &CredentialQuery::Domain("https://github.com/settings".into()),
            Duration::from_secs(20),
        )
        .await
        .unwrap();
    assert_eq!(cred.username.as_deref(), Some("alice"));
    assert_eq!(cred.password.unwrap().as_str(), "hunter2");
    assert_eq!(cred.credential_id.as_deref(), Some("item-gh"));
    assert_eq!(cred.domain.as_deref(), Some("github.com"));
    assert_eq!(cred.notes.as_deref(), Some("from the vault"));
    let totp = cred.totp.expect("current totp");
    assert_eq!(totp.len(), 6);
    assert!(totp.chars().all(|c| c.is_ascii_digit()));
    assert_ne!(totp, "JBSWY3DPEHPK3PXP");

    decision_tx.send(false).unwrap();
    let denied = remote
        .request(
            &CredentialQuery::Id("item-gl".into()),
            Duration::from_secs(20),
        )
        .await
        .unwrap_err();
    assert!(
        denied.to_lowercase().contains("denied"),
        "denied request should surface as a denial, got {denied}"
    );

    // A fresh remote cannot reuse the consumed PSK.
    let again = connect_and_request(
        &relay_url,
        IdentityKeyPair::generate(),
        &user.token,
        CredentialQuery::Domain("github.com".into()),
        Duration::from_secs(8),
    )
    .await;
    assert!(again.is_err());
}
