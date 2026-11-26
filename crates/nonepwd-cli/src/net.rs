use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use tungstenite::WebSocket;
use url::Url;

const IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_RESPONSE_HEADER_BYTES: usize = 64 * 1024;

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

    let addrs: Vec<_> = addr
        .to_socket_addrs()
        .map_err(|e| format!("DNS resolve for {addr} failed: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("No socket addresses resolved for {addr}"));
    }
    let mut last_err = None;
    let mut tcp_opt = None;
    for sock_addr in addrs {
        match TcpStream::connect_timeout(&sock_addr, IO_TIMEOUT) {
            Ok(s) => {
                tcp_opt = Some(s);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let tcp = tcp_opt.ok_or_else(|| {
        format!(
            "TCP connect to {addr} failed: {}",
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "unknown error".to_string())
        )
    })?;
    tcp.set_nodelay(true).ok();
    tcp.set_read_timeout(Some(IO_TIMEOUT)).ok();
    tcp.set_write_timeout(Some(IO_TIMEOUT)).ok();

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

fn validate_header_value(name: &str, value: &str) -> Result<(), String> {
    if value.contains('\r') || value.contains('\n') || value.contains('\0') {
        return Err(format!("Invalid CR/LF/NUL character in HTTP {name}"));
    }
    Ok(())
}

fn decode_chunked(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut pos = 0usize;
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
        pos = pos
            .checked_add(line_end)
            .and_then(|p| p.checked_add(2))
            .ok_or_else(|| "Chunked HTTP response offset overflow".to_string())?;
        if chunk_len == 0 {
            return Ok(out);
        }
        let chunk_end = pos
            .checked_add(chunk_len)
            .ok_or_else(|| "Chunked HTTP response length overflow".to_string())?;
        if chunk_end > body.len() {
            return Err("Truncated chunked HTTP response body".to_string());
        }
        if out.len().saturating_add(chunk_len) > MAX_RESPONSE_BODY_BYTES {
            return Err("HTTP response body exceeds 64 MiB limit".to_string());
        }
        out.extend_from_slice(&body[pos..chunk_end]);
        let next_pos = chunk_end
            .checked_add(2)
            .ok_or_else(|| "Chunked HTTP response terminator overflow".to_string())?;
        if next_pos > body.len() || &body[chunk_end..next_pos] != b"\r\n" {
            return Err("Malformed chunked HTTP response terminator".to_string());
        }
        pos = next_pos;
    }
    Err("Truncated chunked HTTP response".to_string())
}

pub fn http_request(
    method: &str,
    full_url: &str,
    bearer_token: Option<&str>,
    body: Option<&[u8]>,
) -> Result<(u16, Vec<u8>), String> {
    let url = Url::parse(full_url).map_err(|e| format!("Invalid URL {full_url}: {e}"))?;
    let (mut stream, host_header, path_and_query) = connect_stream(&url)?;

    validate_header_value("method", method)?;
    validate_header_value("path", &path_and_query)?;
    validate_header_value("Host", &host_header)?;
    if let Some(tok) = bearer_token {
        validate_header_value("Authorization", tok)?;
    }

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

    let max_total = MAX_RESPONSE_BODY_BYTES + MAX_RESPONSE_HEADER_BYTES;
    let mut raw = Vec::new();
    (&mut stream)
        .take((max_total + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|e| format!("HTTP read failed: {e}"))?;
    if raw.len() > max_total {
        return Err("HTTP response exceeds 64 MiB limit".to_string());
    }

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
    if body_slice.len() > MAX_RESPONSE_BODY_BYTES {
        return Err("HTTP response body exceeds 64 MiB limit".to_string());
    }
    let decoded = if is_chunked {
        decode_chunked(body_slice)?
    } else if let Some(len) = content_length {
        if len > MAX_RESPONSE_BODY_BYTES {
            return Err("HTTP response Content-Length exceeds 64 MiB limit".to_string());
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_chunked_valid_and_rejects_overflow_or_truncation() {
        let valid = b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(valid).unwrap(), b"hello world");

        let overflow = b"ffffffffffffffff\r\nabc\r\n0\r\n\r\n";
        assert!(decode_chunked(overflow).is_err());

        let truncated = b"10\r\nshort";
        assert!(decode_chunked(truncated).is_err());

        let missing_zero = b"5\r\nhello\r\n";
        assert!(decode_chunked(missing_zero).is_err());
    }

    #[test]
    fn validate_header_value_rejects_crlf() {
        assert!(validate_header_value("Authorization", "valid-token_123").is_ok());
        assert!(validate_header_value("Authorization", "bad\r\nX-Injected: 1").is_err());
        assert!(validate_header_value("Host", "example.com\nEvil: 1").is_err());
    }
}
