//! User and remote Agent Access clients for nonepwd.
//!
//! Noise sessions come from `ap-client` (pinned to agent-access protocol v0).
//! The WebSocket transport is implemented here on rustls so the CLI does not
//! pull OpenSSL in through `ap-relay-client`'s `native-tls` feature. The relay
//! URL is always the caller's nonepwd server; this crate has no hosted-relay default.

mod relay_client;
mod session;

pub use nonepwd_core::agent_access::{
    lookup_agent_item, map_agent_credential, relay_url_from_server, AgentCredential, AgentQuery,
};
pub use relay_client::RustlsRelayClient;
pub use session::{
    connect_and_request, resolve_items, run_with_credential, sanitize_terminal_text,
    start_user_agent, ApprovalSource, RemoteSession, UserAgent,
};

pub use ap_client::{CredentialData, CredentialQuery, PskToken};
pub use ap_relay_protocol::IdentityKeyPair;
