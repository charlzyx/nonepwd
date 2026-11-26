use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use nonepwd_core::encoding::constant_time_eq;
use nonepwd_core::totp::generate_totp;
use url::Url;

use crate::client::{EmailOtpWaitState, NonePwdClient};

const CONNECT_STREAM_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_EMAIL_OTP_WAIT_SECS: f64 = 120.0;

fn write_json_response(stream: &mut TcpStream, status: u16, body: &serde_json::Value) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    };
    let json = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        json.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&json);
    let _ = stream.flush();
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn handle_connection(
    mut stream: TcpStream,
    client_arc: Arc<Mutex<NonePwdClient>>,
    expected_token: String,
) {
    let _ = stream.set_read_timeout(Some(CONNECT_STREAM_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECT_STREAM_TIMEOUT));
    let mut buf = [0u8; 8192];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let req_text = String::from_utf8_lossy(&buf[..n]);
    let mut lines = req_text.split("\r\n");
    let first_line = lines.next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");

    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        write_json_response(&mut stream, 400, &serde_json::json!({ "error": "Invalid URL" }));
        return;
    };

    if url.path() == "/v1/health" {
        write_json_response(&mut stream, 200, &serde_json::json!({ "ok": true }));
        return;
    }

    let mut auth_header: Option<String> = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("authorization") {
                auth_header = Some(v.trim().to_string());
            }
        }
    }

    let provided_tok = auth_header
        .as_deref()
        .and_then(|h| h.strip_prefix("Bearer ").or_else(|| h.strip_prefix("bearer ")))
        .map(str::trim)
        .unwrap_or("");

    if !constant_time_eq(provided_tok.as_bytes(), expected_token.as_bytes()) {
        write_json_response(
            &mut stream,
            401,
            &serde_json::json!({ "error": "Unauthorized Connect token" }),
        );
        return;
    }

    if method != "GET" {
        write_json_response(&mut stream, 405, &serde_json::json!({ "error": "Method not allowed" }));
        return;
    }

    let path = url.path().to_string();

    if path == "/v1/mail/otp" {
        let mut domain = None;
        let mut alias = None;
        let mut wait_secs = 0.0f64;
        for (k, v) in url.query_pairs() {
            match k.as_ref() {
                "domain" => domain = Some(v.to_string()),
                "alias" => alias = Some(v.to_string()),
                "waitSeconds" => wait_secs = v.parse().unwrap_or(0.0),
                _ => {}
            }
        }
        let wait_secs = if wait_secs.is_finite() && wait_secs > 0.0 {
            wait_secs.min(MAX_EMAIL_OTP_WAIT_SECS)
        } else {
            0.0
        };

        let prep = {
            let Ok(mut client) = client_arc.lock() else {
                write_json_response(&mut stream, 500, &serde_json::json!({ "error": "Client lock poisoned" }));
                return;
            };
            client.prepare_email_otp_wait(domain.as_deref(), alias.as_deref(), wait_secs)
        };

        let result = match prep {
            Ok(EmailOtpWaitState::Found(em)) => Ok(em),
            Ok(EmailOtpWaitState::Wait {
                ws_url,
                priv_key,
                lookback_secs,
                wait_seconds,
            }) => NonePwdClient::poll_email_otp_ws(
                &ws_url,
                &priv_key,
                domain.as_deref(),
                alias.as_deref(),
                lookback_secs,
                wait_seconds,
            ),
            Err(e) => Err(e),
        };

        match result {
            Ok(em) => write_json_response(
                &mut stream,
                200,
                &serde_json::json!({
                    "otpCode": em.payload.otp_code,
                    "from": em.payload.from,
                    "to": em.payload.to,
                    "subject": em.payload.subject,
                    "receivedAt": em.payload.received_at,
                }),
            ),
            Err(e) => write_json_response(&mut stream, 400, &serde_json::json!({ "error": e })),
        }
        return;
    }

    let Ok(mut client) = client_arc.lock() else {
        write_json_response(&mut stream, 500, &serde_json::json!({ "error": "Client lock poisoned" }));
        return;
    };

    if path == "/v1/vaults" {
        if let Err(e) = client.sync() {
            write_json_response(&mut stream, 400, &serde_json::json!({ "error": e }));
            return;
        }
        let vaults: Vec<_> = client
            .vaults
            .iter()
            .map(|v| {
                serde_json::json!({
                    "id": v.id,
                    "name": v.metadata.name,
                    "description": v.metadata.description,
                })
            })
            .collect();
        write_json_response(&mut stream, 200, &serde_json::json!({ "vaults": vaults }));
        return;
    }

    if path == "/v1/resolve" {
        let ref_param = url
            .query_pairs()
            .find(|(k, _)| k == "ref")
            .map(|(_, v)| v.to_string());
        let Some(ref_uri) = ref_param else {
            write_json_response(&mut stream, 400, &serde_json::json!({ "error": "Missing ?ref=np://..." }));
            return;
        };
        match client.resolve_secret_ref(&ref_uri) {
            Ok(val) => write_json_response(
                &mut stream,
                200,
                &serde_json::json!({ "ref": ref_uri, "value": val }),
            ),
            Err(e) => write_json_response(&mut stream, 400, &serde_json::json!({ "error": e })),
        }
        return;
    }

    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if segs.len() == 4 && segs[0] == "v1" && segs[1] == "vaults" && segs[3] == "items" {
        if let Err(e) = client.sync() {
            write_json_response(&mut stream, 400, &serde_json::json!({ "error": e }));
            return;
        }
        let v_name = percent_decode(segs[2]);
        match client.find_vault(&v_name) {
            Ok(v) => {
                let vid = v.id.clone();
                let items: Vec<_> = client
                    .items
                    .iter()
                    .filter(|i| i.vault_id == vid)
                    .map(|i| &i.payload)
                    .collect();
                write_json_response(&mut stream, 200, &serde_json::json!({ "items": items }));
            }
            Err(e) => write_json_response(&mut stream, 404, &serde_json::json!({ "error": e })),
        }
        return;
    }

    if segs.len() == 5 && segs[0] == "v1" && segs[1] == "vaults" && segs[3] == "items" {
        if let Err(e) = client.sync() {
            write_json_response(&mut stream, 400, &serde_json::json!({ "error": e }));
            return;
        }
        let v_name = percent_decode(segs[2]);
        let i_name = percent_decode(segs[4]);
        match client.find_item(&i_name, Some(&v_name)) {
            Ok(it) => write_json_response(&mut stream, 200, &serde_json::json!({ "item": it.payload })),
            Err(e) => write_json_response(&mut stream, 404, &serde_json::json!({ "error": e })),
        }
        return;
    }

    if segs.len() == 4 && segs[0] == "v1" && segs[1] == "otp" {
        if let Err(e) = client.sync() {
            write_json_response(&mut stream, 400, &serde_json::json!({ "error": e }));
            return;
        }
        let v_name = percent_decode(segs[2]);
        let i_name = percent_decode(segs[3]);
        match client.find_item(&i_name, Some(&v_name)) {
            Ok(it) => match &it.payload.totp {
                Some(sec) => {
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    match generate_totp(sec, now_ms) {
                        Ok(res) => write_json_response(&mut stream, 200, &serde_json::json!(res)),
                        Err(e) => write_json_response(&mut stream, 400, &serde_json::json!({ "error": e })),
                    }
                }
                None => write_json_response(
                    &mut stream,
                    404,
                    &serde_json::json!({ "error": "No TOTP configured on item" }),
                ),
            },
            Err(e) => write_json_response(&mut stream, 404, &serde_json::json!({ "error": e })),
        }
        return;
    }

    write_json_response(&mut stream, 404, &serde_json::json!({ "error": "Not found" }));
}

pub fn serve_connect(
    client: NonePwdClient,
    host: &str,
    port: u16,
    connect_token: String,
) -> Result<(), String> {
    let listener = TcpListener::bind(format!("{host}:{port}"))
        .map_err(|e| format!("Failed binding Connect server on {host}:{port}: {e}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| format!("Failed reading local address: {e}"))?;

    println!("nonepwd Connect API listening on http://{}:{}", local_addr.ip(), local_addr.port());
    println!("Bearer token: {connect_token}");

    let client_arc = Arc::new(Mutex::new(client));
    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                let c = Arc::clone(&client_arc);
                let tok = connect_token.clone();
                thread::spawn(move || handle_connection(s, c, tok));
            }
            Err(_) => break,
        }
    }
    Ok(())
}
