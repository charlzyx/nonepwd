//! Relay WebSocket client on tokio + rustls (no OpenSSL).

use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use ap_client::{ClientError, RelayClient};
use ap_relay_client::IncomingMessage;
use ap_relay_protocol::{
    IdentityFingerprint, IdentityKeyPair, Messages, RelayError, RendezvousCode,
};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{client_async, WebSocketStream};
use url::Url;

const PING_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

enum MaybeTls {
    Plain(TcpStream),
    Tls(TlsStream<TcpStream>),
}

impl AsyncRead for MaybeTls {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            MaybeTls::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            MaybeTls::Tls(stream) => Pin::new(stream).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for MaybeTls {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            MaybeTls::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            MaybeTls::Tls(stream) => Pin::new(stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            MaybeTls::Plain(stream) => Pin::new(stream).poll_flush(cx),
            MaybeTls::Tls(stream) => Pin::new(stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            MaybeTls::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            MaybeTls::Tls(stream) => Pin::new(stream).poll_shutdown(cx),
        }
    }
}

fn tls_config() -> Arc<ClientConfig> {
    let mut root_store = RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(rustls_rustcrypto::provider());
    let cfg = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("rustls protocol versions")
        .with_root_certificates(root_store)
        .with_no_client_auth();
    Arc::new(cfg)
}

async fn connect_socket(url: &str) -> Result<WebSocketStream<MaybeTls>, ClientError> {
    let parsed = Url::parse(url).map_err(|e| ClientError::ConnectionFailed(e.to_string()))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| ClientError::ConnectionFailed("relay URL is missing a host".into()))?
        .to_string();
    let tls = match parsed.scheme() {
        "ws" => false,
        "wss" => true,
        other => {
            return Err(ClientError::ConnectionFailed(format!(
                "unsupported relay scheme {other}"
            )))
        }
    };
    let port = parsed.port().unwrap_or(if tls { 443 } else { 80 });
    let tcp = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|e| ClientError::ConnectionFailed(format!("tcp connect {host}:{port}: {e}")))?;
    let stream = if tls {
        let name = ServerName::try_from(host.clone())
            .map_err(|e| ClientError::ConnectionFailed(format!("tls name: {e}")))?;
        let tls_stream = TlsConnector::from(tls_config())
            .connect(name, tcp)
            .await
            .map_err(|e| ClientError::ConnectionFailed(format!("tls handshake: {e}")))?;
        MaybeTls::Tls(tls_stream)
    } else {
        MaybeTls::Plain(tcp)
    };
    let request = url
        .into_client_request()
        .map_err(|e| ClientError::ConnectionFailed(e.to_string()))?;
    let (ws, _) = client_async(request, stream)
        .await
        .map_err(|e| ClientError::WebSocket(e.to_string()))?;
    Ok(ws)
}

/// `RelayClient` implementation used by `ap-client` user and remote sessions.
pub struct RustlsRelayClient {
    url: String,
    outgoing: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl RustlsRelayClient {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            outgoing: Mutex::new(None),
            tasks: Mutex::new(Vec::new()),
        }
    }

    fn send_raw(&self, msg: Message) -> Result<(), ClientError> {
        let guard = self
            .outgoing
            .lock()
            .map_err(|_| ClientError::ConnectionFailed("relay client lock poisoned".into()))?;
        let tx = guard.as_ref().ok_or_else(|| ClientError::NotInitialized)?;
        tx.send(msg)
            .map_err(|_| ClientError::ConnectionFailed("relay write channel closed".into()))
    }
}

#[async_trait]
impl RelayClient for RustlsRelayClient {
    async fn connect(
        &mut self,
        identity: IdentityKeyPair,
    ) -> Result<mpsc::UnboundedReceiver<IncomingMessage>, ClientError> {
        if self
            .outgoing
            .lock()
            .map_err(|_| ClientError::ConnectionFailed("relay client lock poisoned".into()))?
            .is_some()
        {
            return Err(ClientError::InvalidState {
                expected: "disconnected".into(),
                current: "connected".into(),
            });
        }

        let ws = connect_socket(&self.url).await?;
        let (mut write, mut read) = ws.split();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let (in_tx, in_rx) = mpsc::unbounded_channel::<IncomingMessage>();

        let writer = tokio::spawn(async move {
            let mut ping = tokio::time::interval(PING_INTERVAL);
            ping.tick().await;
            loop {
                tokio::select! {
                    msg = out_rx.recv() => {
                        match msg {
                            Some(msg) => {
                                if write.send(msg).await.is_err() {
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                    _ = ping.tick() => {
                        if write.send(Message::Ping(vec![].into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let challenge_msg = read
            .next()
            .await
            .ok_or(ClientError::ConnectionFailed(
                RelayError::ConnectionClosed.to_string(),
            ))?
            .map_err(|e| ClientError::WebSocket(e.to_string()))?;
        let Message::Text(challenge_text) = challenge_msg else {
            return Err(ClientError::RelayAuthFailed(
                "expected text auth challenge".into(),
            ));
        };
        let challenge = match serde_json::from_str::<Messages>(challenge_text.as_ref())? {
            Messages::AuthChallenge(challenge) => challenge,
            _ => {
                return Err(ClientError::RelayAuthFailed(
                    "expected AuthChallenge".into(),
                ))
            }
        };
        let response = challenge.sign(&identity);
        let auth = serde_json::to_string(&Messages::AuthResponse(identity.identity(), response))?;
        out_tx
            .send(Message::Text(auth.into()))
            .map_err(|_| ClientError::ConnectionFailed("failed to queue auth response".into()))?;

        let reader = tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                let Ok(msg) = msg else {
                    break;
                };
                let Message::Text(text) = msg else {
                    continue;
                };
                let Ok(parsed) = serde_json::from_str::<Messages>(text.as_ref()) else {
                    continue;
                };
                let incoming = match parsed {
                    Messages::Send {
                        source: Some(source),
                        destination,
                        payload,
                    } => Some(IncomingMessage::Send {
                        source,
                        destination,
                        payload,
                    }),
                    Messages::RendezvousInfo(code) => Some(IncomingMessage::RendezvousInfo(code)),
                    Messages::IdentityInfo {
                        fingerprint,
                        identity,
                    } => Some(IncomingMessage::IdentityInfo {
                        fingerprint,
                        identity,
                    }),
                    _ => None,
                };
                if let Some(incoming) = incoming {
                    if in_tx.send(incoming).is_err() {
                        break;
                    }
                }
            }
        });

        *self
            .outgoing
            .lock()
            .map_err(|_| ClientError::ConnectionFailed("relay client lock poisoned".into()))? =
            Some(out_tx);
        self.tasks
            .lock()
            .map_err(|_| ClientError::ConnectionFailed("relay client lock poisoned".into()))?
            .extend([writer, reader]);
        Ok(in_rx)
    }

    async fn request_rendezvous(&self) -> Result<(), ClientError> {
        let json = serde_json::to_string(&Messages::GetRendezvous)?;
        self.send_raw(Message::Text(json.into()))
    }

    async fn request_identity(&self, code: RendezvousCode) -> Result<(), ClientError> {
        let json = serde_json::to_string(&Messages::GetIdentity(code))?;
        self.send_raw(Message::Text(json.into()))
    }

    async fn send_to(
        &self,
        fingerprint: IdentityFingerprint,
        data: Vec<u8>,
    ) -> Result<(), ClientError> {
        let json = serde_json::to_string(&Messages::Send {
            source: None,
            destination: fingerprint,
            payload: data,
        })?;
        self.send_raw(Message::Text(json.into()))
    }

    async fn disconnect(&mut self) -> Result<(), ClientError> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| ClientError::ConnectionFailed("relay client lock poisoned".into()))?;
        for task in tasks.drain(..) {
            task.abort();
        }
        *self
            .outgoing
            .lock()
            .map_err(|_| ClientError::ConnectionFailed("relay client lock poisoned".into()))? =
            None;
        Ok(())
    }
}
