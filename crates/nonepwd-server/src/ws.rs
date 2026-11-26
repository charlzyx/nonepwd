use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use axum::extract::ws::{Message, WebSocket};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::auth::{now_iso_millis, AuthContext};

const OUTBOUND_QUEUE_CAPACITY: usize = 64;

#[derive(Debug, Default, Clone)]
pub struct BroadcastOptions {
    pub vault_id: Option<String>,
    pub owner_only: bool,
}

struct ConnectedClient {
    auth: AuthContext,
    tx: mpsc::Sender<Message>,
}

pub struct WsHub {
    next_id: AtomicU64,
    clients: RwLock<HashMap<u64, ConnectedClient>>,
}

impl Default for WsHub {
    fn default() -> Self {
        Self::new()
    }
}

impl WsHub {
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            clients: RwLock::new(HashMap::new()),
        }
    }

    pub fn broadcast(&self, event: &Value, options: BroadcastOptions) {
        let Ok(serialized) = serde_json::to_string(event) else {
            return;
        };
        let now_ms = Utc::now().timestamp_millis();
        let mut expired_ids = Vec::new();
        {
            let clients = self
                .clients
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            for (&id, client) in clients.iter() {
                if client.auth.expires_at_ms() <= now_ms {
                    let _ = client.tx.try_send(Message::Close(None));
                    expired_ids.push(id);
                    continue;
                }
                if options.owner_only && !matches!(client.auth, AuthContext::Owner { .. }) {
                    continue;
                }
                if let Some(ref vault_id) = options.vault_id {
                    if let AuthContext::ServiceAccount {
                        ref allowed_vault_ids,
                        ..
                    } = client.auth
                    {
                        if !allowed_vault_ids.contains(vault_id) {
                            continue;
                        }
                    }
                }
                let _ = client.tx.try_send(Message::Text(serialized.clone().into()));
            }
        }
        if !expired_ids.is_empty() {
            let mut clients = self
                .clients
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for id in expired_ids {
                clients.remove(&id);
            }
        }
    }

    pub fn close_by_token_hash(&self, token_hash: &str) {
        let mut clients = self
            .clients
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let matching: Vec<u64> = clients
            .iter()
            .filter(|(_, c)| c.auth.token_hash() == token_hash)
            .map(|(&id, _)| id)
            .collect();
        for id in matching {
            if let Some(client) = clients.remove(&id) {
                let _ = client.tx.try_send(Message::Close(None));
            }
        }
    }

    pub fn close_by_service_account(&self, service_account_id: &str) {
        let mut clients = self
            .clients
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let matching: Vec<u64> = clients
            .iter()
            .filter(|(_, c)| c.auth.service_account_id() == Some(service_account_id))
            .map(|(&id, _)| id)
            .collect();
        for id in matching {
            if let Some(client) = clients.remove(&id) {
                let _ = client.tx.try_send(Message::Close(None));
            }
        }
    }

    pub fn client_count(&self) -> usize {
        self.clients
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    pub fn close_all(&self) {
        let mut clients = self
            .clients
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (_, client) in clients.drain() {
            let _ = client.tx.try_send(Message::Close(None));
        }
    }

    pub async fn handle_socket(self: Arc<Self>, socket: WebSocket, auth: AuthContext) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (mut ws_sink, mut ws_stream) = socket.split();
        let (tx, mut rx) = mpsc::channel::<Message>(OUTBOUND_QUEUE_CAPACITY);

        let hello = json!({
            "type": "hello",
            "kind": auth.kind_str(),
            "timestamp": now_iso_millis(),
        });
        let _ = tx.try_send(Message::Text(hello.to_string().into()));

        {
            let mut clients = self
                .clients
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            clients.insert(id, ConnectedClient { auth, tx: tx.clone() });
        }

        let mut write_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let is_close = matches!(msg, Message::Close(_));
                if ws_sink.send(msg).await.is_err() || is_close {
                    break;
                }
            }
        });

        loop {
            tokio::select! {
                _ = &mut write_task => break,
                next_msg = ws_stream.next() => {
                    match next_msg {
                        Some(Ok(Message::Ping(payload))) => {
                            let _ = tx.try_send(Message::Pong(payload));
                        }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                        _ => {}
                    }
                }
            }
        }

        {
            let mut clients = self
                .clients
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            clients.remove(&id);
        }
        write_task.abort();
    }
}
