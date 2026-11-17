use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use tungstenite::WebSocket;
use url::Url;

pub enum HttpStream {
    Plain(TcpStream),
    Tls(Box<StreamOwned<ClientConnection, TcpStream>>),
}

impl HttpStream {
    pub fn set_read_timeout(&self, dur: Option<Duration>) -> io::Result<()> {
        match self {
            HttpStream::Plain(s) => s.set_read_timeout(dur),
            HttpStream::Tls(s) => s.sock.set_read_timeout(dur),
        }
    }
}

impl Read for HttpStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            HttpStream::Plain(s) => s.read(buf),
            HttpStream::Tls(s) => s.read(buf),
        }
    }
}

impl Write for HttpStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            HttpStream::Plain(s) => s.write(buf),
            HttpStream::Tls(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            HttpStream::Plain(s) => s.flush(),
            HttpStream::Tls(s) => s.flush(),
        }
    }
}

fn tls_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut root_store = RootCertStore::empty();
            root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let provider = Arc::new(rustls_rustcrypto::provider());
            let cfg = ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .expect("valid TLS versions")
                .with_root_certificates(root_store)
                .with_no_client_auth();
            Arc::new(cfg)
        })
        .clone()
}

pub fn connect_stream(url: &Url) -> Result<(HttpStream, String, String), String> {
    let scheme = url.scheme().to_ascii_lowercase();
    let use_tls = match scheme.as_str() {
        "https" | "wss" => true,
        "http" | "ws" => false,
        other => return Err(format!("Unsupported URL scheme: {other}")),
    };

    let host = url
        .host_str()
        .ok_or_else(|| format!("URL missing host: {url}"))?
        .to_string();
    let default_port = if use_tls { 443 } else { 80 };
    let port = url.port().unwrap_or(default_port);
    let addr = format!("{host}:{port}");
    let host_header = if url.port().is_some() {
        format!("{host}:{port}")
    } else {
        host.clone()
    };

    let path_and_query = match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => {
            if url.path().is_empty() {
                "/".to_string()
            } else {
                url.path().to_string()
            }
        }
    };

    let tcp = TcpStream::connect(&addr).map_err(|e| format!("TCP connect to {addr} failed: {e}"))?;
    tcp.set_nodelay(true).ok();

    if use_tls {
        let server_name = ServerName::try_from(host)
            .map_err(|e| format!("Invalid TLS server name: {e}"))?;
        let conn = ClientConnection::new(tls_config(), server_name)
            .map_err(|e| format!("TLS handshake init failed: {e}"))?;
        Ok((HttpStream::Tls(Box::new(StreamOwned::new(conn, tcp))), host_header, path_and_query))
    } else {
        Ok((HttpStream::Plain(tcp), host_header, path_and_query))
    }
}

fn decode_chunked(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos < body.len() {
        let line_end = body[pos..]
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(|| "Malformed chunked HTTP response".to_string())?;
        let size_str = std::str::from_utf8(&body[pos..pos + line_end])
            .map_err(|_| "Invalid chunk size UTF-8".to_string())?
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        let chunk_len = usize::from_str_radix(size_str, 16)
            .map_err(|_| format!("Invalid chunk hex size: {size_str}"))?;
        pos += line_end + 2;
        if chunk_len == 0 {
            break;
        }
        if pos + chunk_len > body.len() {
            out.extend_from_slice(&body[pos..]);
            break;
        }
        out.extend_from_slice(&body[pos..pos + chunk_len]);
        pos += chunk_len + 2;
    }
    Ok(out)
}

pub fn http_request(
    method: &str,
    full_url: &str,
    bearer_token: Option<&str>,
    body: Option<&[u8]>,
) -> Result<(u16, Vec<u8>), String> {
    let url = Url::parse(full_url).map_err(|e| format!("Invalid URL {full_url}: {e}"))?;
    let (mut stream, host_header, path_and_query) = connect_stream(&url)?;

    let mut req = format!(
        "{method} {path_and_query} HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: nonepwd-cli/0.1.0\r\nAccept: application/json\r\nConnection: close\r\n"
    );
    if let Some(tok) = bearer_token {
        req.push_str(&format!("Authorization: Bearer {tok}\r\n"));
    }
    if let Some(b) = body {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");

    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("HTTP write failed: {e}"))?;
    if let Some(b) = body {
        stream
            .write_all(b)
            .map_err(|e| format!("HTTP body write failed: {e}"))?;
    }
    stream.flush().ok();

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("HTTP read failed: {e}"))?;

    let header_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "Malformed HTTP response (no header delimiter)".to_string())?;

    let header_str = String::from_utf8_lossy(&raw[..header_end]);
    let mut lines = header_str.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("Malformed HTTP status line: {status_line}"))?;

    let mut is_chunked = false;
    let mut content_length: Option<usize> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let kl = k.trim().to_ascii_lowercase();
            let vl = v.trim();
            if kl == "transfer-encoding" && vl.to_ascii_lowercase().contains("chunked") {
                is_chunked = true;
            } else if kl == "content-length" {
                content_length = vl.parse::<usize>().ok();
            }
        }
    }

    let body_slice = &raw[header_end + 4..];
    let decoded = if is_chunked {
        decode_chunked(body_slice)?
    } else if let Some(len) = content_length {
        body_slice[..body_slice.len().min(len)].to_vec()
    } else {
        body_slice.to_vec()
    };

    Ok((status, decoded))
}

pub fn connect_ws(ws_url: &str, read_timeout: Option<Duration>) -> Result<WebSocket<HttpStream>, String> {
    let url = Url::parse(ws_url).map_err(|e| format!("Invalid WebSocket URL {ws_url}: {e}"))?;
    let (stream, _, _) = connect_stream(&url)?;
    stream
        .set_read_timeout(read_timeout)
        .map_err(|e| format!("Failed setting WS timeout: {e}"))?;
    let (ws, _) = tungstenite::client(ws_url, stream)
        .map_err(|e| format!("WebSocket handshake failed: {e}"))?;
    Ok(ws)
}
