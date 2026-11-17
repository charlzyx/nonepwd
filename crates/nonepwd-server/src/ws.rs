use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::auth::{now_iso_millis, AuthContext};

#[derive(Debug, Default, Clone)]
pub struct BroadcastOptions {
    pub vault_id: Option<String>,
    pub owner_only: bool,
}

struct ConnectedClient {
    auth: AuthContext,
    tx: mpsc::UnboundedSender<Message>,
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
        let clients = self
            .clients
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        for client in clients.values() {
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
            let _ = client.tx.send(Message::Text(serialized.clone().into()));
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
            let _ = client.tx.send(Message::Close(None));
        }
    }

    pub async fn handle_socket(self: Arc<Self>, socket: WebSocket, auth: AuthContext) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (mut ws_sink, mut ws_stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

        let hello = json!({
            "type": "hello",
            "kind": auth.kind_str(),
            "timestamp": now_iso_millis(),
        });
        let _ = tx.send(Message::Text(hello.to_string().into()));

        {
            let mut clients = self
                .clients
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            clients.insert(id, ConnectedClient { auth, tx: tx.clone() });
        }

        let write_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let is_close = matches!(msg, Message::Close(_));
                if ws_sink.send(msg).await.is_err() || is_close {
                    break;
                }
            }
        });

        while let Some(Ok(msg)) = ws_stream.next().await {
            match msg {
                Message::Ping(payload) => {
                    let _ = tx.send(Message::Pong(payload));
                }
                Message::Close(_) => break,
                _ => {}
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
