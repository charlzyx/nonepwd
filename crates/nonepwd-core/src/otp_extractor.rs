use std::collections::HashSet;
use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use url::Url;

fn two_level_tlds() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        [
            "co.uk", "org.uk", "ac.uk", "gov.uk", "com.cn", "net.cn", "org.cn", "gov.cn",
            "edu.cn", "co.jp", "ne.jp", "or.jp", "com.au", "net.au", "org.au", "com.br",
            "com.tw", "com.hk", "co.kr", "co.in",
        ]
        .into_iter()
        .collect()
    })
}

fn floor_char(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn ceil_char(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

pub fn extract_email_address(raw_header: &str) -> String {
    static ANGLE_RE: OnceLock<Regex> = OnceLock::new();
    static BARE_RE: OnceLock<Regex> = OnceLock::new();

    let angle_re = ANGLE_RE.get_or_init(|| Regex::new(r"<([^<>\s]+@[^<>\s]+)>").unwrap());
    if let Some(cap) = angle_re.captures(raw_header) {
        return cap[1].trim().to_ascii_lowercase();
    }

    let bare_re = BARE_RE
        .get_or_init(|| Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").unwrap());
    if let Some(m) = bare_re.find(raw_header) {
        return m.as_str().trim().to_ascii_lowercase();
    }
    raw_header.trim().to_ascii_lowercase()
}

pub fn extract_host(input: &str) -> String {
    let trimmed = input.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains('@') && !trimmed.contains("://") {
        let addr = extract_email_address(&trimmed);
        return addr.rsplit_once('@').map(|(_, h)| h.to_string()).unwrap_or_default();
    }
    let with_proto = if trimmed.contains("://") {
        trimmed.clone()
    } else {
        format!("https://{trimmed}")
    };
    if let Ok(u) = Url::parse(&with_proto) {
        if let Some(h) = u.host_str() {
            return h.to_ascii_lowercase();
        }
    }
    trimmed
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

pub fn extract_registrable_domain(host_or_email_or_url: &str) -> String {
    let host = extract_host(host_or_email_or_url)
        .trim_end_matches('.')
        .to_string();
    if host.is_empty() {
        return String::new();
    }
    if host == "localhost"
        || host
            .split('.')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
    {
        return host;
    }
    let parts: Vec<&str> = host.split('.').filter(|p| !p.is_empty()).collect();
    if parts.len() <= 2 {
        return parts.join(".");
    }
    let last_two = format!("{}.{}", parts[parts.len() - 2], parts[parts.len() - 1]);
    if two_level_tlds().contains(last_two.as_str()) && parts.len() >= 3 {
        return format!("{}.{}", parts[parts.len() - 3], last_two);
    }
    last_two
}

pub fn domains_match(url_or_host_a: &str, url_or_host_b: &str) -> bool {
    let host_a = extract_host(url_or_host_a);
    let host_b = extract_host(url_or_host_b);
    if host_a.is_empty() || host_b.is_empty() {
        return false;
    }
    if host_a == host_b {
        return true;
    }
    let reg_a = extract_registrable_domain(&host_a);
    let reg_b = extract_registrable_domain(&host_b);
    !reg_a.is_empty() && reg_a == reg_b
}

fn decode_html_entities(text: &str) -> String {
    static DEC_RE: OnceLock<Regex> = OnceLock::new();
    static HEX_RE: OnceLock<Regex> = OnceLock::new();

    let s = text
        .replace("&nbsp;", " ")
        .replace("&NBSP;", " ")
        .replace("&amp;", "&")
        .replace("&AMP;", "&")
        .replace("&lt;", "<")
        .replace("&LT;", "<")
        .replace("&gt;", ">")
        .replace("&GT;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");

    let dec_re = DEC_RE.get_or_init(|| Regex::new(r"&#(\d+);").unwrap());
    let s = dec_re
        .replace_all(&s, |caps: &Captures| {
            caps[1]
                .parse::<u32>()
                .ok()
                .and_then(char::from_u32)
                .map(|c| c.to_string())
                .unwrap_or_default()
        })
        .into_owned();

    let hex_re = HEX_RE.get_or_init(|| Regex::new(r"(?i)&#x([0-9a-f]+);").unwrap());
    hex_re
        .replace_all(&s, |caps: &Captures| {
            u32::from_str_radix(&caps[1], 16)
                .ok()
                .and_then(char::from_u32)
                .map(|c| c.to_string())
                .unwrap_or_default()
        })
        .into_owned()
}

pub fn strip_html_to_clean_text(html: &str) -> String {
    static RE_HEAD: OnceLock<Regex> = OnceLock::new();
    static RE_STYLE: OnceLock<Regex> = OnceLock::new();
    static RE_SCRIPT: OnceLock<Regex> = OnceLock::new();
    static RE_SVG: OnceLock<Regex> = OnceLock::new();
    static RE_COMMENT: OnceLock<Regex> = OnceLock::new();
    static RE_ANCHOR: OnceLock<Regex> = OnceLock::new();
    static RE_BR: OnceLock<Regex> = OnceLock::new();
    static RE_BLOCK: OnceLock<Regex> = OnceLock::new();
    static RE_TAGS: OnceLock<Regex> = OnceLock::new();
    static RE_SPACES: OnceLock<Regex> = OnceLock::new();
    static RE_LINE_SPACE: OnceLock<Regex> = OnceLock::new();
    static RE_MULTI_NL: OnceLock<Regex> = OnceLock::new();

    let mut cleaned = RE_HEAD
        .get_or_init(|| Regex::new(r"(?is)<head\b[^>]*>.*?</head>").unwrap())
        .replace_all(html, " ")
        .into_owned();
    cleaned = RE_STYLE
        .get_or_init(|| Regex::new(r"(?is)<style\b[^>]*>.*?</style>").unwrap())
        .replace_all(&cleaned, " ")
        .into_owned();
    cleaned = RE_SCRIPT
        .get_or_init(|| Regex::new(r"(?is)<script\b[^>]*>.*?</script>").unwrap())
        .replace_all(&cleaned, " ")
        .into_owned();
    cleaned = RE_SVG
        .get_or_init(|| Regex::new(r"(?is)<svg\b[^>]*>.*?</svg>").unwrap())
        .replace_all(&cleaned, " ")
        .into_owned();
    cleaned = RE_COMMENT
        .get_or_init(|| Regex::new(r"(?s)<!--.*?-->").unwrap())
        .replace_all(&cleaned, " ")
        .into_owned();

    cleaned = RE_ANCHOR
        .get_or_init(|| {
            Regex::new(r#"(?is)<a\b[^>]*href=["'](https?://[^"']+)["'][^>]*>(.*?)</a>"#).unwrap()
        })
        .replace_all(&cleaned, |caps: &Captures| format!("{} ({}) ", &caps[2], &caps[1]))
        .into_owned();

    cleaned = RE_BR
        .get_or_init(|| Regex::new(r"(?i)<(?:br|hr)\s*/?>").unwrap())
        .replace_all(&cleaned, "\n")
        .into_owned();
    cleaned = RE_BLOCK
        .get_or_init(|| {
            Regex::new(r"(?i)</(?:p|div|tr|li|h[1-6]|section|article|blockquote|table|td)>")
                .unwrap()
        })
        .replace_all(&cleaned, "\n")
        .into_owned();
    cleaned = RE_TAGS
        .get_or_init(|| Regex::new(r"<[^>]+>").unwrap())
        .replace_all(&cleaned, " ")
        .into_owned();

    cleaned = decode_html_entities(&cleaned)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    cleaned = RE_SPACES
        .get_or_init(|| Regex::new(r"[ \t\x0B\x0C]+").unwrap())
        .replace_all(&cleaned, " ")
        .into_owned();
    cleaned = RE_LINE_SPACE
        .get_or_init(|| Regex::new(r" *\n *").unwrap())
        .replace_all(&cleaned, "\n")
        .into_owned();
    cleaned = RE_MULTI_NL
        .get_or_init(|| Regex::new(r"\n{3,}").unwrap())
        .replace_all(&cleaned, "\n\n")
        .into_owned();

    cleaned.trim().to_string()
}

const STRONG_OTP_KEYWORDS: &[&str] = &[
    "verification code",
    "verify code",
    "security code",
    "login code",
    "sign-in code",
    "signin code",
    "one-time password",
    "one-time code",
    "one-time pin",
    "one time password",
    "one time code",
    "one time pin",
    "passcode",
    "confirm code",
    "confirmation code",
    "auth code",
    "authentication code",
    "access code",
    "temporary code",
    "single-use code",
    "use the following code",
    "enter this code",
    "enter the code",
    "your code is",
    "finish logging in",
    "cloudflare access",
    "2fa code",
    "otp",
    "pin code",
    "验证码",
    "登录验证码",
    "邮箱验证码",
    "身份验证",
    "校验码",
    "动态码",
    "安全码",
    "登录码",
    "确认码",
    "一次性密码",
    "认证码",
];

const WEAK_OTP_KEYWORDS: &[&str] = &[
    "code",
    "verify",
    "verification",
    "login",
    "confirm",
    "enter",
    "valid for",
    "expires in",
    "验证",
    "登录",
    "有效",
    "分钟",
    "minutes",
];

const NEGATIVE_CONTEXT_WORDS: &[&str] = &[
    "order",
    "invoice",
    "receipt",
    "tracking",
    "shipment",
    "ticket",
    "zip",
    "postal",
    "copyright",
    "©",
    "tel:",
    "phone",
    "fax",
    "price",
    "total",
    "amount",
    "订单",
    "运单",
    "邮编",
    "客服电话",
    "金额",
];

fn is_likely_year(token: &str) -> bool {
    if token.len() != 4 || !token.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    matches!(token.parse::<u32>(), Ok(1990..=2039))
}

fn is_trivial_repeated(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() >= 4 && bytes[0].is_ascii_digit() && bytes.iter().all(|&b| b == bytes[0])
}

fn is_inside_url(text: &str, start: usize, end: usize) -> bool {
    static URL_X_RE: OnceLock<Regex> = OnceLock::new();
    let left_start = floor_char(text, start.saturating_sub(140));
    let right_end = ceil_char(text, end.saturating_add(60));
    let combined = format!("{}X{}", &text[left_start..start], &text[end..right_end]);
    URL_X_RE
        .get_or_init(|| Regex::new(r"(?i)https?://\S*X\S*").unwrap())
        .is_match(&combined)
}

fn score_candidates_in_text(text: &str, base_score: i32) -> Vec<(String, i32)> {
    static CANDIDATE_RE: OnceLock<Regex> = OnceLock::new();
    static IMM_LABEL_RE: OnceLock<Regex> = OnceLock::new();
    static UNIT_AFTER_RE: OnceLock<Regex> = OnceLock::new();
    static FOOTER_RE: OnceLock<Regex> = OnceLock::new();

    let candidate_re = CANDIDATE_RE.get_or_init(|| {
        Regex::new(r"(?:\d{3}(?:[-\s]\d{3}){1,2}|\d{4,9}|[A-Z0-9]{5,8})").unwrap()
    });
    let imm_label_re = IMM_LABEL_RE.get_or_init(|| {
        Regex::new(r"(?i)(?:code|otp|pin|passcode|验证码|校验码|动态码|安全码|登录码|确认码)\s*(?:is|为)?\s*[:：]?\s*$").unwrap()
    });
    let unit_after_re =
        UNIT_AFTER_RE.get_or_init(|| Regex::new(r"(?i)^(?:px|pt|em|rem|%|usd|cny|eur|gbp|元)").unwrap());
    let footer_re =
        FOOTER_RE.get_or_init(|| Regex::new(r"(?i)all rights reserved|unsubscribe|隐私政策|退订").unwrap());

    let mut results = Vec::new();
    let mut running_offset = 0usize;

    for line in text.split('\n') {
        let line_trimmed = line.trim();
        for m in candidate_re.find_iter(line) {
            let raw = m.as_str();
            let global_start = running_offset + m.start();
            let global_end = running_offset + m.end();

            // Manual left/right boundary checks (Rust regex has no lookaround)
            if let Some(prev_ch) = text[..global_start].chars().next_back() {
                if prev_ch.is_ascii_alphanumeric()
                    || matches!(prev_ch, '#' | '$' | '.' | ':' | '/' | '\\' | '-')
                {
                    continue;
                }
                if matches!(prev_ch, '¥' | '€' | '£') {
                    continue;
                }
            }
            if let Some(next_ch) = text[global_end..].chars().next() {
                if next_ch.is_ascii_alphanumeric() || next_ch == '%' {
                    continue;
                }
                if next_ch == '.' {
                    let after_dot = text[global_end + 1..].chars().next();
                    if after_dot.is_some_and(|c| c.is_ascii_digit()) {
                        continue;
                    }
                }
            }

            let normalized: String = raw
                .chars()
                .filter(|c| !c.is_whitespace() && *c != '-')
                .collect();

            if !normalized.bytes().any(|b| b.is_ascii_digit()) {
                continue;
            }
            if normalized.len() < 4 || normalized.len() > 9 {
                continue;
            }

            let after_end = ceil_char(text, global_end.saturating_add(10));
            if unit_after_re.is_match(&text[global_end..after_end]) {
                continue;
            }

            if is_inside_url(text, global_start, global_end) {
                continue;
            }

            let ctx_start = floor_char(text, global_start.saturating_sub(90));
            let ctx_end = ceil_char(text, global_end.saturating_add(90));
            let context = text[ctx_start..ctx_end].to_lowercase();

            let imm_start = floor_char(text, global_start.saturating_sub(42));
            let immediate_prefix = text[imm_start..global_start].to_lowercase();

            let has_strong_kw = STRONG_OTP_KEYWORDS.iter().any(|kw| context.contains(kw));
            let has_weak_kw = WEAK_OTP_KEYWORDS.iter().any(|kw| context.contains(kw));
            let has_immediate_label = imm_label_re.is_match(&immediate_prefix);

            let neg_before_start = floor_char(text, global_start.saturating_sub(42));
            let neg_after_end = ceil_char(text, global_end.saturating_add(24));
            let before_slice = &text[neg_before_start..global_start];
            let clause_before = before_slice
                .rsplit(['\n', '。', '!', '?'])
                .next()
                .unwrap_or("");
            let clause_before = clause_before
                .rsplit(". ")
                .next()
                .unwrap_or(clause_before);
            let after_slice = &text[global_end..neg_after_end];
            let clause_after = after_slice
                .split(['\n', '。', '!', '?'])
                .next()
                .unwrap_or("");
            let clause_after = clause_after
                .split(". ")
                .next()
                .unwrap_or(clause_after);
            let local_clause = format!("{clause_before} {clause_after}").to_lowercase();

            if is_likely_year(&normalized) && !has_immediate_label {
                continue;
            }
            if is_trivial_repeated(&normalized) && !has_immediate_label {
                continue;
            }

            let is_pure_digits = normalized.bytes().all(|b| b.is_ascii_digit());
            if !is_pure_digits && !has_strong_kw && !has_immediate_label {
                continue;
            }

            let mut score = base_score;
            if is_pure_digits {
                score += match normalized.len() {
                    6 => 20,
                    7 | 8 => 16,
                    5 => 12,
                    9 => 10,
                    _ => 6,
                };
            } else {
                score += 10;
            }

            if has_strong_kw {
                score += 45;
            } else if has_weak_kw {
                score += 20;
            }
            if has_immediate_label {
                score += 25;
            }
            if line_trimmed == raw {
                score += 28;
            }
            if NEGATIVE_CONTEXT_WORDS.iter().any(|w| local_clause.contains(w)) {
                score -= 55;
            }
            if footer_re.is_match(line) {
                score -= 50;
            }

            results.push((normalized, score));
        }
        running_offset += line.len() + 1;
    }

    results
}

fn extract_magic_link(text: &str) -> Option<String> {
    static URL_RE: OnceLock<Regex> = OnceLock::new();
    static IGNORE_RE: OnceLock<Regex> = OnceLock::new();
    static ACTION_URL_RE: OnceLock<Regex> = OnceLock::new();
    static NEARBY_RE: OnceLock<Regex> = OnceLock::new();

    let url_re = URL_RE.get_or_init(|| Regex::new(r#"(?i)https?://[^\s<>"')]+"#).unwrap());
    let ignore_re = IGNORE_RE.get_or_init(|| {
        Regex::new(r"(?i)unsubscribe|privacy|terms|help|support|preferences|optout|mailto:|logo|favicon|\.(png|jpg|jpeg|gif|svg|css|js)(\?|$)").unwrap()
    });
    let action_url_re = ACTION_URL_RE.get_or_init(|| {
        Regex::new(r"(?i)verify|confirm|magic|signin|sign-in|login|auth|activate|token=|code=|otp=").unwrap()
    });
    let nearby_re = NEARBY_RE.get_or_init(|| {
        Regex::new(r"(?i)verify|confirm|sign in|log in|magic link|登录|验证|确认").unwrap()
    });

    let mut best_url: Option<String> = None;
    let mut best_score = -1i32;

    for m in url_re.find_iter(text) {
        let raw_url = m.as_str();
        let cleaned = raw_url
            .trim_end_matches(['.', ',', ';', '!', '?', ')'])
            .to_string();
        if ignore_re.is_match(&cleaned) {
            continue;
        }
        let mut score = 0;
        if action_url_re.is_match(&cleaned) {
            score += 40;
        }
        let left = floor_char(text, m.start().saturating_sub(80));
        let right = ceil_char(text, m.end().saturating_add(40));
        if nearby_re.is_match(&text[left..right]) {
            score += 25;
        }
        if score > best_score && score >= 25 {
            best_score = score;
            best_url = Some(cleaned);
        }
    }

    best_url
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailOtpExtractionInput {
    pub from: String,
    pub to: String,
    pub subject: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub html: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailOtpExtractionResult {
    pub otp_code: Option<String>,
    pub confidence: f64,
    pub magic_link: Option<String>,
    pub sender_address: String,
    pub sender_domain: String,
    pub snippet: String,
    pub clean_text: String,
}

pub fn extract_email_otp(input: &EmailOtpExtractionInput) -> EmailOtpExtractionResult {
    let sender_address = extract_email_address(&input.from);
    let sender_domain = extract_registrable_domain(&sender_address);

    let plain_from_text = input.text.as_deref().unwrap_or("").trim().to_string();
    let plain_from_html = input
        .html
        .as_deref()
        .map(strip_html_to_clean_text)
        .unwrap_or_default();

    let subject_candidates = score_candidates_in_text(&input.subject, 45);
    let text_candidates = if plain_from_text.is_empty() {
        Vec::new()
    } else {
        score_candidates_in_text(&plain_from_text, 10)
    };
    let html_candidates = if plain_from_html.is_empty() {
        Vec::new()
    } else {
        score_candidates_in_text(&plain_from_html, 10)
    };

    let text_has_winner = text_candidates.iter().any(|(_, s)| *s >= 55);
    let html_has_winner = html_candidates.iter().any(|(_, s)| *s >= 55);

    let clean_text = if !plain_from_html.is_empty() && !text_has_winner && html_has_winner {
        plain_from_html
    } else if plain_from_text.chars().count() >= 10 {
        plain_from_text
    } else if !plain_from_html.is_empty() {
        plain_from_html
    } else {
        plain_from_text
    };

    let mut all_candidates: Vec<(String, i32)> = Vec::new();
    for (code, score) in subject_candidates
        .into_iter()
        .chain(text_candidates)
        .chain(html_candidates)
    {
        if let Some(existing) = all_candidates.iter_mut().find(|(c, _)| *c == code) {
            if score > existing.1 {
                existing.1 = score;
            }
        } else {
            all_candidates.push((code, score));
        }
    }
    all_candidates.sort_by(|a, b| b.1.cmp(&a.1));

    let mut otp_code = None;
    let mut confidence = 0.0;
    if let Some((code, score)) = all_candidates.first() {
        if *score >= 55 {
            otp_code = Some(code.clone());
            let raw_conf = ((*score as f64) / 115.0).min(1.0);
            confidence = (raw_conf * 100.0).round() / 100.0;
        }
    }

    let link_search_text = format!("{clean_text}\n{}", input.html.as_deref().unwrap_or(""));
    let magic_link = extract_magic_link(&link_search_text);

    let snippet_source = clean_text.split_whitespace().collect::<Vec<_>>().join(" ");
    let snippet = if snippet_source.chars().count() > 180 {
        let prefix: String = snippet_source.chars().take(177).collect();
        format!("{prefix}...")
    } else {
        snippet_source
    };

    EmailOtpExtractionResult {
        otp_code,
        confidence,
        magic_link,
        sender_address,
        sender_domain,
        snippet,
        clean_text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloudflare_access_one_time_pin_plain_and_html_table() {
        let plain = "\
To finish logging in, please enter the following one-time PIN:

482910

This temporary code will expire in 10 minutes.

Cloudflare, Inc.
101 Townsend St, San Francisco, CA 94107";

        let html = r#"
        <html><body>
          <table role="presentation" width="100%">
            <tr><td><h2>Cloudflare Access</h2></td></tr>
            <tr><td>To finish logging in, enter this code:</td></tr>
            <tr><td style="font-size:32px;font-weight:bold;letter-spacing:4px;">482910</td></tr>
            <tr><td>Cloudflare, Inc. 101 Townsend St, San Francisco, CA 94107</td></tr>
          </table>
        </body></html>
        "#;

        let res = extract_email_otp(&EmailOtpExtractionInput {
            from: "Cloudflare <no-reply@notify.cloudflare.com>".into(),
            to: "user@example.com".into(),
            subject: "Your Cloudflare Access one-time PIN".into(),
            text: Some(plain.into()),
            html: Some(html.into()),
        });

        assert_eq!(res.otp_code.as_deref(), Some("482910"));
        assert!(res.confidence > 0.5, "expected confidence > 0.5, got {}", res.confidence);
        assert_eq!(res.sender_domain, "cloudflare.com");
    }

    #[test]
    fn cloudflare_access_prefers_html_when_plain_text_has_no_winner() {
        let plain = "Please view this message in an HTML-capable email client. Cloudflare, Inc. 101 Townsend St, San Francisco, CA 94107";
        let html = r#"
        <html><body>
          <table>
            <tr><td>Your Cloudflare Access one-time PIN</td></tr>
            <tr><td>Use the following code to finish logging in:</td></tr>
            <tr><td>628491</td></tr>
            <tr><td>101 Townsend St, San Francisco, CA 94107</td></tr>
          </table>
        </body></html>
        "#;

        let res = extract_email_otp(&EmailOtpExtractionInput {
            from: "Cloudflare <no-reply@notify.cloudflare.com>".into(),
            to: "user@example.com".into(),
            subject: "Your one-time PIN".into(),
            text: Some(plain.into()),
            html: Some(html.into()),
        });

        assert_eq!(res.otp_code.as_deref(), Some("628491"));
        assert!(res.confidence > 0.5, "expected confidence > 0.5, got {}", res.confidence);
        assert!(res.clean_text.contains("628491"));
        assert!(res.snippet.contains("628491"));
    }

    #[test]
    fn cloudflare_access_inline_and_zh_phrases_score_above_threshold() {
        let inline_en = extract_email_otp(&EmailOtpExtractionInput {
            from: "Cloudflare <no-reply@notify.cloudflare.com>".into(),
            to: "user@example.com".into(),
            subject: "Access request".into(),
            text: Some(
                "Use the following code 739154 to finish logging in. Cloudflare, Inc. San Francisco, CA 94107"
                    .into(),
            ),
            html: None,
        });
        assert_eq!(inline_en.otp_code.as_deref(), Some("739154"));
        assert!(inline_en.confidence > 0.5);

        let inline_zh = extract_email_otp(&EmailOtpExtractionInput {
            from: "Service <noreply@example.com>".into(),
            to: "user@example.com".into(),
            subject: "身份验证".into(),
            text: Some("您的邮箱验证码 524819 请在5分钟内输入。".into()),
            html: None,
        });
        assert_eq!(inline_zh.otp_code.as_deref(), Some("524819"));
        assert!(inline_zh.confidence > 0.5);
    }

    #[test]
    fn supports_four_to_nine_digit_and_grouped_codes_without_zip_false_positive() {
        let grouped9 = extract_email_otp(&EmailOtpExtractionInput {
            from: "Auth <noreply@example.com>".into(),
            to: "user@example.com".into(),
            subject: "Temporary code".into(),
            text: Some("Enter the code to finish logging in: 123-456-789".into()),
            html: None,
        });
        assert_eq!(grouped9.otp_code.as_deref(), Some("123456789"));
        assert!(grouped9.confidence > 0.5);

        let eight_digit = extract_email_otp(&EmailOtpExtractionInput {
            from: "Auth <noreply@example.com>".into(),
            to: "user@example.com".into(),
            subject: "Access code".into(),
            text: Some("Your single-use code is 84920173.".into()),
            html: None,
        });
        assert_eq!(eight_digit.otp_code.as_deref(), Some("84920173"));
        assert!(eight_digit.confidence > 0.5);

        let four_digit = extract_email_otp(&EmailOtpExtractionInput {
            from: "Auth <noreply@example.com>".into(),
            to: "user@example.com".into(),
            subject: "Access code".into(),
            text: Some("Your temporary code is 4829.".into()),
            html: None,
        });
        assert_eq!(four_digit.otp_code.as_deref(), Some("4829"));
        assert!(four_digit.confidence > 0.5);

        let footer_only = extract_email_otp(&EmailOtpExtractionInput {
            from: "Newsletter <news@example.com>".into(),
            to: "user@example.com".into(),
            subject: "Monthly update".into(),
            text: Some("Cloudflare, Inc. 101 Townsend St, San Francisco, CA 94107".into()),
            html: None,
        });
        assert_eq!(footer_only.otp_code, None);
    }
}
