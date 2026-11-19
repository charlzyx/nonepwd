//! Agent Access protocol v0 relay.
//!
//! Each WebSocket is authenticated with the protocol's Ed25519 COSE_Sign1
//! challenge. After that the relay only forwards opaque `Send` payloads and
//! keeps short-lived rendezvous codes. It cannot decrypt credential traffic.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use ap_relay_protocol::{Challenge, Identity, IdentityFingerprint, Messages, RendezvousCode};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Mutex};

const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const RENDEZVOUS_TTL: Duration = Duration::from_secs(300);

struct Conn {
    id: u64,
    identity: Identity,
    tx: mpsc::UnboundedSender<Message>,
}

struct RendezvousEntry {
    fingerprint: IdentityFingerprint,
    created_at: SystemTime,
    used: bool,
}

struct RelayState {
    connections: HashMap<IdentityFingerprint, Vec<Conn>>,
    rendezvous: HashMap<String, RendezvousEntry>,
}

/// In-process Agent Access relay. The nonepwd server mounts it at `/agent/relay`.
pub struct AgentRelay {
    state: Mutex<RelayState>,
    next_id: AtomicU64,
}

impl AgentRelay {
    pub fn new() -> Arc<Self> {
        let relay = Arc::new(Self {
            state: Mutex::new(RelayState {
                connections: HashMap::new(),
                rendezvous: HashMap::new(),
            }),
            next_id: AtomicU64::new(1),
        });
        let sweep = Arc::clone(&relay);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                sweep.sweep_rendezvous().await;
            }
        });
        relay
    }

    /// Router that exposes only the relay WebSocket. Tests use this directly.
    pub fn router(self: &Arc<Self>) -> Router {
        Router::new()
            .route("/agent/relay", get(upgrade))
            .with_state(Arc::clone(self))
    }

    /// Bind `127.0.0.1:0` and serve the relay until the process exits.
    pub async fn listen_ephemeral(self: &Arc<Self>) -> Result<std::net::SocketAddr, String> {
        let app = self.router();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("bind relay: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("relay address: {e}"))?;
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Ok(addr)
    }

    async fn sweep_rendezvous(&self) {
        let mut state = self.state.lock().await;
        let now = SystemTime::now();
        state.rendezvous.retain(|_, entry| {
            now.duration_since(entry.created_at).unwrap_or_default() <= RENDEZVOUS_TTL
        });
    }

    pub async fn handle_socket(self: &Arc<Self>, socket: WebSocket) {
        let conn_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (mut write, mut read) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let writer = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.send(msg).await.is_err() {
                    break;
                }
            }
        });

        let challenge = Challenge::new();
        let hello = match serde_json::to_string(&Messages::AuthChallenge(challenge.clone())) {
            Ok(text) => text,
            Err(_) => {
                writer.abort();
                return;
            }
        };
        if tx.send(Message::Text(hello.into())).is_err() {
            writer.abort();
            return;
        }

        let authed = match tokio::time::timeout(AUTH_TIMEOUT, next_frame(&mut read, &tx)).await {
            Ok(Frame::Text(text)) => match serde_json::from_str::<Messages>(&text) {
                Ok(Messages::AuthResponse(identity, response))
                    if response.verify(&challenge, &identity) =>
                {
                    Some((identity.fingerprint(), identity))
                }
                _ => None,
            },
            _ => None,
        };
        let Some((fingerprint, identity)) = authed else {
            drop(tx);
            writer.abort();
            return;
        };

        {
            let mut state = self.state.lock().await;
            state
                .connections
                .entry(fingerprint)
                .or_default()
                .push(Conn {
                    id: conn_id,
                    identity,
                    tx: tx.clone(),
                });
        }

        let mut idle = tokio::time::interval(IDLE_TIMEOUT);
        idle.tick().await;
        loop {
            let frame = tokio::select! {
                frame = next_frame(&mut read, &tx) => frame,
                _ = idle.tick() => Frame::Closed,
            };
            match frame {
                Frame::Text(text) => {
                    idle.reset();
                    if let Ok(parsed) = serde_json::from_str::<Messages>(&text) {
                        self.handle_frame(fingerprint, &parsed).await;
                    }
                }
                Frame::Activity => idle.reset(),
                Frame::Closed => break,
            }
        }

        {
            let mut state = self.state.lock().await;
            if let Some(list) = state.connections.get_mut(&fingerprint) {
                list.retain(|c| c.id != conn_id);
                if list.is_empty() {
                    state.connections.remove(&fingerprint);
                }
            }
        }
        drop(tx);
        writer.abort();
    }

    async fn handle_frame(&self, fingerprint: IdentityFingerprint, msg: &Messages) {
        match msg {
            Messages::GetRendezvous => {
                let code = {
                    let mut state = self.state.lock().await;
                    let mut code = RendezvousCode::new();
                    for _ in 0..8 {
                        if !state.rendezvous.contains_key(code.as_str()) {
                            break;
                        }
                        code = RendezvousCode::new();
                    }
                    state.rendezvous.insert(
                        code.as_str().to_string(),
                        RendezvousEntry {
                            fingerprint,
                            created_at: SystemTime::now(),
                            used: false,
                        },
                    );
                    code
                };
                let Ok(response) = serde_json::to_string(&Messages::RendezvousInfo(code)) else {
                    return;
                };
                self.send_text(fingerprint, response).await;
            }
            Messages::GetIdentity(code) => {
                let target = {
                    let mut state = self.state.lock().await;
                    let Some(entry) = state.rendezvous.get_mut(code.as_str()) else {
                        return;
                    };
                    let age = SystemTime::now()
                        .duration_since(entry.created_at)
                        .unwrap_or_default();
                    if entry.used || age > RENDEZVOUS_TTL {
                        let key = code.as_str().to_string();
                        state.rendezvous.remove(&key);
                        return;
                    }
                    entry.used = true;
                    entry.fingerprint
                };
                let identity = {
                    let state = self.state.lock().await;
                    state
                        .connections
                        .get(&target)
                        .and_then(|list| list.first())
                        .map(|c| c.identity.clone())
                };
                let Some(identity) = identity else {
                    return;
                };
                let Ok(response) = serde_json::to_string(&Messages::IdentityInfo {
                    fingerprint: target,
                    identity,
                }) else {
                    return;
                };
                self.send_text(fingerprint, response).await;
            }
            Messages::Send {
                destination,
                payload,
                ..
            } => {
                let Ok(forward) = serde_json::to_string(&Messages::Send {
                    source: Some(fingerprint),
                    destination: *destination,
                    payload: payload.clone(),
                }) else {
                    return;
                };
                self.send_text(*destination, forward).await;
            }
            Messages::AuthChallenge(_)
            | Messages::AuthResponse(_, _)
            | Messages::RendezvousInfo(_)
            | Messages::IdentityInfo { .. } => {}
        }
    }

    async fn send_text(&self, fingerprint: IdentityFingerprint, text: String) {
        let senders: Vec<mpsc::UnboundedSender<Message>> = {
            let state = self.state.lock().await;
            state
                .connections
                .get(&fingerprint)
                .map(|list| list.iter().map(|c| c.tx.clone()).collect())
                .unwrap_or_default()
        };
        let msg = Message::Text(text.into());
        for tx in senders {
            let _ = tx.send(msg.clone());
        }
    }
}

enum Frame {
    Text(String),
    Activity,
    Closed,
}

async fn next_frame(
    read: &mut futures_util::stream::SplitStream<WebSocket>,
    tx: &mpsc::UnboundedSender<Message>,
) -> Frame {
    loop {
        match read.next().await {
            Some(Ok(Message::Text(text))) => return Frame::Text(text.to_string()),
            Some(Ok(Message::Ping(payload))) => {
                if tx.send(Message::Pong(payload)).is_err() {
                    return Frame::Closed;
                }
                return Frame::Activity;
            }
            Some(Ok(Message::Pong(_))) | Some(Ok(Message::Binary(_))) => return Frame::Activity,
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Frame::Closed,
        }
    }
}

async fn upgrade(ws: WebSocketUpgrade, State(relay): State<Arc<AgentRelay>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        relay.handle_socket(socket).await;
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ap_relay_protocol::IdentityKeyPair;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message as TungMessage;

    async fn spawn_relay() -> std::net::SocketAddr {
        let relay = AgentRelay::new();
        let app = relay.router();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        addr
    }

    async fn authed_client(
        addr: std::net::SocketAddr,
    ) -> (
        futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            TungMessage,
        >,
        futures_util::stream::SplitStream<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
        >,
        Identity,
        IdentityFingerprint,
    ) {
        let url = format!("ws://{addr}/agent/relay");
        let (ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let (mut write, mut read) = ws.split();
        let challenge_text = read.next().await.unwrap().unwrap().into_text().unwrap();
        let challenge = match serde_json::from_str::<Messages>(&challenge_text).unwrap() {
            Messages::AuthChallenge(c) => c,
            other => panic!("expected challenge, got {other:?}"),
        };
        let key = IdentityKeyPair::generate();
        let identity = key.identity();
        let response = challenge.sign(&key);
        let auth =
            serde_json::to_string(&Messages::AuthResponse(identity.clone(), response)).unwrap();
        write.send(TungMessage::Text(auth.into())).await.unwrap();
        let fingerprint = identity.fingerprint();
        (write, read, identity, fingerprint)
    }

    #[tokio::test]
    async fn routes_ciphertext_and_rejects_a_bad_signature() {
        let addr = spawn_relay().await;
        let (mut a_write, _a_read, _a_id, a_fp) = authed_client(addr).await;
        let (mut b_write, mut b_read, _b_id, b_fp) = authed_client(addr).await;

        let payload = b"opaque-ciphertext".to_vec();
        let send = serde_json::to_string(&Messages::Send {
            source: None,
            destination: b_fp,
            payload: payload.clone(),
        })
        .unwrap();
        a_write.send(TungMessage::Text(send.into())).await.unwrap();

        let forwarded = b_read.next().await.unwrap().unwrap().into_text().unwrap();
        match serde_json::from_str::<Messages>(&forwarded).unwrap() {
            Messages::Send {
                source,
                destination,
                payload: got,
            } => {
                assert_eq!(source, Some(a_fp));
                assert_eq!(destination, b_fp);
                assert_eq!(got, payload);
            }
            other => panic!("unexpected frame {other:?}"),
        }

        let url = format!("ws://{addr}/agent/relay");
        let (ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let (mut bad_write, mut bad_read) = ws.split();
        let challenge_text = bad_read.next().await.unwrap().unwrap().into_text().unwrap();
        let challenge = match serde_json::from_str::<Messages>(&challenge_text).unwrap() {
            Messages::AuthChallenge(c) => c,
            other => panic!("expected challenge, got {other:?}"),
        };
        let liar = IdentityKeyPair::generate();
        let other = IdentityKeyPair::generate();
        let response = challenge.sign(&other);
        let auth =
            serde_json::to_string(&Messages::AuthResponse(liar.identity(), response)).unwrap();
        bad_write
            .send(TungMessage::Text(auth.into()))
            .await
            .unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(2), bad_read.next())
            .await
            .expect("bad signature should close the socket");
        match closed {
            None | Some(Err(_)) => {}
            Some(Ok(msg)) => assert!(msg.is_close(), "expected close, got {msg:?}"),
        }

        // Keep the honest sockets alive until the assertion above finishes.
        let _ = a_write.close().await;
        let _ = b_write.close().await;
    }

    #[tokio::test]
    async fn auth_fixture_matches_cose_layout() {
        let key = IdentityKeyPair::generate();
        let identity = key.identity();
        let challenge = Challenge::new();
        let response = challenge.sign(&key);
        let challenge_message =
            serde_json::to_string(&Messages::AuthChallenge(challenge.clone())).unwrap();
        let auth_message =
            serde_json::to_string(&Messages::AuthResponse(identity.clone(), response)).unwrap();

        let challenge_bytes =
            serde_json::from_str::<serde_json::Value>(&challenge_message).unwrap();
        assert_eq!(
            challenge_bytes["AuthChallenge"].as_array().unwrap().len(),
            32
        );

        let auth_value: serde_json::Value = serde_json::from_str(&auth_message).unwrap();
        let cose_key = auth_value["AuthResponse"][0]["cose_key_bytes"]
            .as_array()
            .unwrap();
        let cose_sign = auth_value["AuthResponse"][1]["cose_sign1_bytes"]
            .as_array()
            .unwrap();
        let key_bytes: Vec<u8> = cose_key.iter().map(|n| n.as_u64().unwrap() as u8).collect();
        let sign_bytes: Vec<u8> = cose_sign
            .iter()
            .map(|n| n.as_u64().unwrap() as u8)
            .collect();
        // coset OKP map: kty=1, alg=EdDSA(-8), crv=-8, x=32 bytes.
        assert_eq!(
            &key_bytes[..9],
            &[0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x27, 0x21, 0x58]
        );
        assert_eq!(key_bytes[9], 0x20);
        assert_eq!(key_bytes.len(), 10 + 32);
        // COSE_Sign1: protected bstr {1: -8}, empty unprotected map, 32-byte payload, 64-byte sig.
        assert_eq!(&sign_bytes[..5], &[0x84, 0x43, 0xa1, 0x01, 0x27]);

        let fixture = serde_json::json!({
            "challengeMessage": challenge_message,
            "authResponseMessage": auth_message,
            "publicKey": identity.public_key_bytes().unwrap(),
            "fingerprintHex": identity.fingerprint().to_hex(),
        });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/agent-relay/test/fixtures/ed25519-auth.json");
        if std::env::var("NONEPWD_WRITE_AGENT_FIXTURE").ok().as_deref() == Some("1") {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, serde_json::to_vec_pretty(&fixture).unwrap()).unwrap();
        }
        if path.is_file() {
            let saved: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let saved_challenge =
                match serde_json::from_str::<Messages>(saved["challengeMessage"].as_str().unwrap())
                    .unwrap()
                {
                    Messages::AuthChallenge(c) => c,
                    other => panic!("fixture challenge {other:?}"),
                };
            let (saved_identity, saved_response) = match serde_json::from_str::<Messages>(
                saved["authResponseMessage"].as_str().unwrap(),
            )
            .unwrap()
            {
                Messages::AuthResponse(identity, response) => (identity, response),
                other => panic!("fixture auth {other:?}"),
            };
            assert!(saved_response.verify(&saved_challenge, &saved_identity));
            assert_eq!(
                saved["fingerprintHex"].as_str().unwrap(),
                saved_identity.fingerprint().to_hex()
            );
        }
    }
}
