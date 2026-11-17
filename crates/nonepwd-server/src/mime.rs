use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine;
use encoding_rs::Encoding;
use nonepwd_core::otp_extractor::extract_email_address;

#[derive(Debug, Clone, Default)]
pub struct ParsedMimeEmail {
    pub from_header: Option<String>,
    pub to_address: Option<String>,
    pub subject: Option<String>,
    pub text: Option<String>,
    pub html: Option<String>,
}

fn split_headers_and_body(raw: &[u8]) -> (&[u8], &[u8]) {
    for i in 0..raw.len() {
        if i + 4 <= raw.len() && &raw[i..i + 4] == b"\r\n\r\n" {
            return (&raw[..i], &raw[i + 4..]);
        }
        if i + 2 <= raw.len() && &raw[i..i + 2] == b"\n\n" {
            return (&raw[..i], &raw[i + 2..]);
        }
    }
    (raw, &[])
}

fn parse_headers(header_bytes: &[u8]) -> Vec<(String, String)> {
    let raw_str = String::from_utf8_lossy(header_bytes);
    let mut unfolded: Vec<String> = Vec::new();

    for line in raw_str.split('\n') {
        let line = line.trim_end_matches('\r');
        if (line.starts_with(' ') || line.starts_with('\t')) && !unfolded.is_empty() {
            if let Some(last) = unfolded.last_mut() {
                last.push(' ');
                last.push_str(line.trim());
            }
        } else if !line.is_empty() {
            unfolded.push(line.to_string());
        }
    }

    let mut headers = Vec::with_capacity(unfolded.len());
    for line in unfolded {
        if let Some((name, val)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), val.trim().to_string()));
        }
    }
    headers
}

fn decode_charset_bytes(bytes: &[u8], charset: &str) -> String {
    let label = charset.trim().trim_matches(['"', '\'']);
    if label.is_empty() || label.eq_ignore_ascii_case("utf-8") || label.eq_ignore_ascii_case("utf8") {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    if let Some(enc) = Encoding::for_label(label.as_bytes()) {
        let (cow, _, _) = enc.decode(bytes);
        return cow.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn decode_q_encoding(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'_' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'=' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((hi << 4) | lo) as u8);
                i += 3;
                continue;
            }
            out.push(bytes[i]);
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

fn decode_base64_lenient(input: &str) -> Vec<u8> {
    let clean: String = input.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    if clean.is_empty() {
        return Vec::new();
    }
    if let Ok(b) = STANDARD.decode(clean.as_bytes()) {
        return b;
    }
    let trimmed = clean.trim_end_matches('=');
    STANDARD_NO_PAD.decode(trimmed.as_bytes()).unwrap_or_default()
}

fn decode_quoted_printable(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'=' {
            if i + 2 < raw.len() && raw[i + 1] == b'\r' && raw[i + 2] == b'\n' {
                i += 3;
                continue;
            }
            if i + 1 < raw.len() && raw[i + 1] == b'\n' {
                i += 2;
                continue;
            }
            if i + 2 < raw.len() {
                if let (Some(hi), Some(lo)) = (
                    (raw[i + 1] as char).to_digit(16),
                    (raw[i + 2] as char).to_digit(16),
                ) {
                    out.push(((hi << 4) | lo) as u8);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

fn decode_rfc2047(input: &str) -> String {
    if !input.contains("=?") {
        return input.to_string();
    }

    let mut result = String::new();
    let mut rest = input;
    let mut prev_was_encoded = false;

    while let Some(start) = rest.find("=?") {
        let prefix = &rest[..start];
        if !(prev_was_encoded && prefix.chars().all(|c| c.is_ascii_whitespace())) {
            result.push_str(prefix);
        }

        let after_start = &rest[start + 2..];
        let mut parsed_word: Option<(String, usize)> = None;

        if let Some(q1) = after_start.find('?') {
            let charset = &after_start[..q1];
            let after_q1 = &after_start[q1 + 1..];
            if let Some(q2) = after_q1.find('?') {
                let enc_kind = &after_q1[..q2];
                let after_q2 = &after_q1[q2 + 1..];
                if let Some(end) = after_q2.find("?=") {
                    let payload = &after_q2[..end];
                    let raw_bytes = if enc_kind.eq_ignore_ascii_case("b") {
                        Some(decode_base64_lenient(payload))
                    } else if enc_kind.eq_ignore_ascii_case("q") {
                        Some(decode_q_encoding(payload))
                    } else {
                        None
                    };
                    if let Some(bytes) = raw_bytes {
                        let decoded = decode_charset_bytes(&bytes, charset);
                        let consumed = 2 + q1 + 1 + q2 + 1 + end + 2;
                        parsed_word = Some((decoded, consumed));
                    }
                }
            }
        }

        if let Some((decoded, consumed)) = parsed_word {
            result.push_str(&decoded);
            rest = &rest[start + consumed..];
            prev_was_encoded = true;
        } else {
            result.push_str("=?");
            rest = after_start;
            prev_was_encoded = false;
        }
    }

    result.push_str(rest);
    result
}

fn get_header_param(header_val: &str, param_name: &str) -> Option<String> {
    for part in header_val.split(';').skip(1) {
        if let Some((k, v)) = part.split_once('=') {
            if k.trim().eq_ignore_ascii_case(param_name) {
                let clean = v.trim().trim_matches(['"', '\'']).to_string();
                if !clean.is_empty() {
                    return Some(clean);
                }
            }
        }
    }
    None
}

fn format_from_header(raw_from: &str) -> Option<String> {
    let decoded = decode_rfc2047(raw_from);
    let trimmed = decoded.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let (Some(lt), Some(gt)) = (trimmed.rfind('<'), trimmed.rfind('>')) {
        if lt < gt {
            let addr = trimmed[lt + 1..gt].trim();
            if addr.contains('@') {
                let name = trimmed[..lt].trim().trim_matches('"').trim();
                if name.is_empty() {
                    return Some(format!("<{addr}>"));
                }
                return Some(format!("{name} <{addr}>"));
            }
        }
    }

    let addr = extract_email_address(trimmed);
    if addr.contains('@') {
        return Some(format!("<{addr}>"));
    }
    None
}

fn parse_part_recursive(
    raw: &[u8],
    depth: usize,
    plain_parts: &mut Vec<String>,
    html_parts: &mut Vec<String>,
) {
    if depth > 12 || raw.is_empty() {
        return;
    }

    let (header_bytes, body_bytes) = split_headers_and_body(raw);
    if body_bytes.is_empty() && !header_bytes.contains(&b':') {
        let s = String::from_utf8_lossy(raw).trim().to_string();
        if !s.is_empty() {
            plain_parts.push(s);
        }
        return;
    }

    let headers = parse_headers(header_bytes);
    let content_type = headers
        .iter()
        .find(|(k, _)| k == "content-type")
        .map(|(_, v)| v.as_str())
        .unwrap_or("text/plain; charset=utf-8");
    let disposition = headers
        .iter()
        .find(|(k, _)| k == "content-disposition")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    let transfer_encoding = headers
        .iter()
        .find(|(k, _)| k == "content-transfer-encoding")
        .map(|(_, v)| v.trim().to_ascii_lowercase())
        .unwrap_or_default();

    let disposition_main = disposition
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if disposition_main == "attachment" {
        return;
    }

    let mime_main = content_type
        .split(';')
        .next()
        .unwrap_or("text/plain")
        .trim()
        .to_ascii_lowercase();

    if mime_main.starts_with("multipart/") {
        if let Some(boundary) = get_header_param(content_type, "boundary") {
            let delim = format!("--{boundary}");
            let end_delim = format!("--{boundary}--");
            let delim_bytes = delim.as_bytes();

            let mut positions = Vec::new();
            let mut idx = 0;
            while idx + delim_bytes.len() <= body_bytes.len() {
                if &body_bytes[idx..idx + delim_bytes.len()] == delim_bytes
                    && (idx == 0 || body_bytes[idx - 1] == b'\n')
                {
                    positions.push(idx);
                    idx += delim_bytes.len();
                } else {
                    idx += 1;
                }
            }

            for w in positions.windows(2) {
                let start_delim = w[0];
                let next_delim = w[1];
                let after_delim = start_delim + delim_bytes.len();
                if body_bytes[after_delim..].starts_with(b"--") {
                    break;
                }
                let mut part_start = after_delim;
                while part_start < next_delim
                    && (body_bytes[part_start] == b' ' || body_bytes[part_start] == b'\t')
                {
                    part_start += 1;
                }
                if part_start + 2 <= next_delim && &body_bytes[part_start..part_start + 2] == b"\r\n"
                {
                    part_start += 2;
                } else if part_start < next_delim && body_bytes[part_start] == b'\n' {
                    part_start += 1;
                }

                let mut part_end = next_delim;
                if part_end >= 2 && &body_bytes[part_end - 2..part_end] == b"\r\n" {
                    part_end -= 2;
                } else if part_end >= 1 && body_bytes[part_end - 1] == b'\n' {
                    part_end -= 1;
                }

                if part_start < part_end {
                    let sub_slice = &body_bytes[part_start..part_end];
                    if !String::from_utf8_lossy(sub_slice)
                        .trim_start()
                        .starts_with(&end_delim)
                    {
                        parse_part_recursive(sub_slice, depth + 1, plain_parts, html_parts);
                    }
                }
            }
        }
        return;
    }

    if mime_main != "text/plain" && mime_main != "text/html" {
        return;
    }

    let decoded_bytes = match transfer_encoding.as_str() {
        "base64" => {
            let as_str = String::from_utf8_lossy(body_bytes);
            decode_base64_lenient(&as_str)
        }
        "quoted-printable" => decode_quoted_printable(body_bytes),
        _ => body_bytes.to_vec(),
    };

    let charset = get_header_param(content_type, "charset").unwrap_or_else(|| "utf-8".to_string());
    let text_str = decode_charset_bytes(&decoded_bytes, &charset);

    if mime_main == "text/html" {
        if !text_str.trim().is_empty() {
            html_parts.push(text_str);
        }
    } else if !text_str.trim().is_empty() {
        plain_parts.push(text_str);
    }
}

pub fn parse_mime(raw: &[u8]) -> ParsedMimeEmail {
    let (header_bytes, _) = split_headers_and_body(raw);
    let headers = parse_headers(header_bytes);

    let from_header = headers
        .iter()
        .find(|(k, _)| k == "from")
        .and_then(|(_, v)| format_from_header(v));

    let to_address = headers
        .iter()
        .find(|(k, _)| k == "to")
        .map(|(_, v)| extract_email_address(&decode_rfc2047(v)))
        .filter(|a| !a.is_empty());

    let subject = headers
        .iter()
        .find(|(k, _)| k == "subject")
        .map(|(_, v)| decode_rfc2047(v));

    let mut plain_parts = Vec::new();
    let mut html_parts = Vec::new();
    parse_part_recursive(raw, 0, &mut plain_parts, &mut html_parts);

    ParsedMimeEmail {
        from_header,
        to_address,
        subject,
        text: if plain_parts.is_empty() {
            None
        } else {
            Some(plain_parts.join("\n"))
        },
        html: if html_parts.is_empty() {
            None
        } else {
            Some(html_parts.join("\n"))
        },
    }
}
