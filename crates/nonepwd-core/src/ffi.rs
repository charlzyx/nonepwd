use std::alloc::{alloc, dealloc, Layout};
use std::slice;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroize;

use crate::crypto::{
    decode_service_account_token, decrypt_bytes, derive_account_keys,
    encode_service_account_token, encrypt_bytes, generate_email_key_pair, open_sealed_envelope,
    seal_for_public_key,
};
use crate::csv_import::parse_password_csv;
use crate::encoding::{
    constant_time_eq, from_base32, from_base64_url, generate_secret_key, normalize_secret_key,
    to_base32, to_base64_url,
};
use crate::generator::{
    generate_email_alias, generate_passphrase, generate_password, PassphraseOptions,
    PasswordOptions,
};
use crate::otp_extractor::{
    domains_match, extract_email_address, extract_email_otp, extract_host,
    extract_registrable_domain, strip_html_to_clean_text, EmailOtpExtractionInput,
};
use crate::random::{random_bytes, random_id, random_int};
use crate::secret_ref::{parse_dot_env, parse_secret_ref, resolve_item_field};
use crate::totp::{build_otp_auth_uri, generate_totp, parse_otp_input, TotpAlgorithm};
use crate::totp_import::{
    detect_import_format, has_same_totp_secret, parse_authenticator_export, plan_totp_import,
    totp_import_match, totp_issuer_matches_item, TotpImportEntry,
};
use crate::types::{SealedEnvelope, ServiceAccountTokenPayload, VaultItemPayload};

#[derive(Deserialize)]
struct InvokeRequest {
    op: String,
    #[serde(default)]
    args: Value,
}

#[derive(Serialize)]
struct InvokeResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

const MAX_RANDOM_BYTES_LEN: usize = 1_048_576;

#[no_mangle]
pub extern "C" fn np_alloc(len: usize) -> *mut u8 {
    let safe_len = len.max(1);
    let Ok(layout) = Layout::from_size_align(safe_len, 1) else {
        return std::ptr::null_mut();
    };
    unsafe { alloc(layout) }
}

#[no_mangle]
pub extern "C" fn np_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let safe_len = len.max(1);
    let Ok(layout) = Layout::from_size_align(safe_len, 1) else {
        return;
    };
    unsafe {
        slice::from_raw_parts_mut(ptr, safe_len).zeroize();
        dealloc(ptr, layout);
    }
}

#[no_mangle]
pub extern "C" fn np_free_result(ptr: *mut u8, len: usize) {
    np_dealloc(ptr, len);
}

fn dispatch(req: InvokeRequest) -> Result<Value, String> {
    match req.op.as_str() {
        "random_bytes" => {
            let len_u64 = req.args["len"].as_u64().unwrap_or(0);
            let len = usize::try_from(len_u64)
                .map_err(|_| format!("random_bytes len exceeds maximum ({MAX_RANDOM_BYTES_LEN})"))?;
            if len > MAX_RANDOM_BYTES_LEN {
                return Err(format!("random_bytes len exceeds maximum ({MAX_RANDOM_BYTES_LEN})"));
            }
            Ok(Value::String(to_base64_url(&random_bytes(len)?)))
        }
        "random_int" => {
            let max_u64 = req.args["max"].as_u64().unwrap_or(1);
            let max = usize::try_from(max_u64)
                .map_err(|_| format!("random_int max out of range: {max_u64}"))?;
            Ok(Value::Number((random_int(max)? as u64).into()))
        }
        "random_id" => Ok(Value::String(random_id()?)),
        "to_base32" => {
            let bytes = from_base64_url(req.args["bytesB64"].as_str().unwrap_or(""))?;
            Ok(Value::String(to_base32(&bytes)))
        }
        "from_base32" => {
            let bytes = from_base32(req.args["input"].as_str().unwrap_or(""))?;
            Ok(Value::String(to_base64_url(&bytes)))
        }
        "generate_secret_key" => Ok(Value::String(generate_secret_key()?)),
        "normalize_secret_key" => Ok(Value::String(normalize_secret_key(
            req.args["secretKey"].as_str().unwrap_or(""),
        ))),
        "constant_time_eq" => {
            let a = from_base64_url(req.args["aB64"].as_str().unwrap_or(""))?;
            let b = from_base64_url(req.args["bB64"].as_str().unwrap_or(""))?;
            Ok(Value::Bool(constant_time_eq(&a, &b)))
        }
        "derive_account_keys" => {
            let iterations = match req.args.get("iterations") {
                None | Some(Value::Null) => 600_000u32,
                Some(v) => {
                    let raw = v.as_u64().ok_or_else(|| {
                        "Invalid KDF iterations (expected non-negative integer)".to_string()
                    })?;
                    u32::try_from(raw)
                        .map_err(|_| format!("KDF iterations out of range: {raw}"))?
                }
            };
            let res = derive_account_keys(
                req.args["masterPassword"].as_str().unwrap_or(""),
                req.args["secretKey"].as_str().unwrap_or(""),
                req.args["kdfSaltB64"].as_str().unwrap_or(""),
                iterations,
            )?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "encrypt_bytes" => {
            let key = from_base64_url(req.args["keyB64"].as_str().unwrap_or(""))?;
            let pt = from_base64_url(req.args["plaintextB64"].as_str().unwrap_or(""))?;
            let aad = req.args["aad"].as_str();
            Ok(Value::String(encrypt_bytes(&key, &pt, aad)?))
        }
        "decrypt_bytes" => {
            let key = from_base64_url(req.args["keyB64"].as_str().unwrap_or(""))?;
            let blob = req.args["blob"].as_str().unwrap_or("");
            let aad = req.args["aad"].as_str();
            let pt = decrypt_bytes(&key, blob, aad)?;
            Ok(Value::String(to_base64_url(&pt)))
        }
        "generate_email_key_pair" => {
            let kp = generate_email_key_pair()?;
            serde_json::to_value(kp).map_err(|e| e.to_string())
        }
        "seal_for_public_key" => {
            let pub_b64 = req.args["publicKeyB64"].as_str().unwrap_or("");
            let pt = from_base64_url(req.args["plaintextB64"].as_str().unwrap_or(""))?;
            let info = req.args["info"].as_str().unwrap_or("nonepwd-email-v1");
            let env = seal_for_public_key(pub_b64, &pt, info)?;
            serde_json::to_value(env).map_err(|e| e.to_string())
        }
        "open_sealed_envelope" => {
            let priv_b64 = req.args["privateKeyPkcs8B64"].as_str().unwrap_or("");
            let env: SealedEnvelope =
                serde_json::from_value(req.args["envelope"].clone()).map_err(|e| e.to_string())?;
            let info = req.args["info"].as_str().unwrap_or("nonepwd-email-v1");
            let pt = open_sealed_envelope(priv_b64, &env, info)?;
            Ok(Value::String(to_base64_url(&pt)))
        }
        "encode_service_account_token" => {
            let payload: ServiceAccountTokenPayload =
                serde_json::from_value(req.args["payload"].clone()).map_err(|e| e.to_string())?;
            Ok(Value::String(encode_service_account_token(&payload)?))
        }
        "decode_service_account_token" => {
            let token = req.args["token"].as_str().unwrap_or("");
            let payload = decode_service_account_token(token)?;
            serde_json::to_value(payload).map_err(|e| e.to_string())
        }
        "parse_otp_input" => {
            let input = req.args["input"].as_str().unwrap_or("");
            let parsed = parse_otp_input(input)?;
            serde_json::to_value(parsed).map_err(|e| e.to_string())
        }
        "generate_totp" => {
            let input = req.args["input"].as_str().unwrap_or("");
            let ts = req.args["timestampMs"].as_u64().unwrap_or(0);
            let res = generate_totp(input, ts)?;
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "build_otp_auth_uri" => {
            let alg = req.args["algorithm"].as_str().and_then(|s| match s {
                "SHA256" => Some(TotpAlgorithm::SHA256),
                "SHA512" => Some(TotpAlgorithm::SHA512),
                "SHA1" => Some(TotpAlgorithm::SHA1),
                _ => None,
            });
            let uri = build_otp_auth_uri(
                req.args["secret"].as_str().unwrap_or(""),
                req.args["account"].as_str(),
                req.args["issuer"].as_str(),
                req.args["digits"].as_u64().map(|v| v as u32),
                req.args["period"].as_u64(),
                alg,
            );
            Ok(Value::String(uri))
        }
        "extract_email_address" => Ok(Value::String(extract_email_address(
            req.args["rawHeader"].as_str().unwrap_or(""),
        ))),
        "extract_host" => Ok(Value::String(extract_host(
            req.args["input"].as_str().unwrap_or(""),
        ))),
        "extract_registrable_domain" => Ok(Value::String(extract_registrable_domain(
            req.args["input"].as_str().unwrap_or(""),
        ))),
        "domains_match" => Ok(Value::Bool(domains_match(
            req.args["a"].as_str().unwrap_or(""),
            req.args["b"].as_str().unwrap_or(""),
        ))),
        "strip_html_to_clean_text" => Ok(Value::String(strip_html_to_clean_text(
            req.args["html"].as_str().unwrap_or(""),
        ))),
        "extract_email_otp" => {
            let input: EmailOtpExtractionInput =
                serde_json::from_value(req.args.clone()).map_err(|e| e.to_string())?;
            let res = extract_email_otp(&input);
            serde_json::to_value(res).map_err(|e| e.to_string())
        }
        "parse_secret_ref" => {
            let parsed = parse_secret_ref(req.args["uri"].as_str().unwrap_or(""))?;
            serde_json::to_value(parsed).map_err(|e| e.to_string())
        }
        "resolve_item_field" => {
            let item: VaultItemPayload =
                serde_json::from_value(req.args["item"].clone()).map_err(|e| e.to_string())?;
            let field = req.args["field"].as_str().unwrap_or("");
            Ok(match resolve_item_field(&item, field) {
                Some(v) => Value::String(v),
                None => Value::Null,
            })
        }
        "parse_dot_env" => {
            let map = parse_dot_env(req.args["content"].as_str().unwrap_or(""));
            serde_json::to_value(map).map_err(|e| e.to_string())
        }
        "generate_password" => {
            let opts: PasswordOptions =
                serde_json::from_value(req.args.clone()).unwrap_or_default();
            Ok(Value::String(generate_password(&opts)?))
        }
        "generate_passphrase" => {
            let opts: PassphraseOptions =
                serde_json::from_value(req.args.clone()).unwrap_or_default();
            Ok(Value::String(generate_passphrase(&opts)?))
        }
        "generate_email_alias" => Ok(Value::String(generate_email_alias(
            req.args["siteOrDomain"].as_str().unwrap_or(""),
            req.args["aliasDomain"].as_str().unwrap_or(""),
        )?)),
        "parse_password_csv" => {
            let csv_text = req.args["csvText"].as_str().unwrap_or("");
            let entries = parse_password_csv(csv_text)?;
            serde_json::to_value(entries).map_err(|e| e.to_string())
        }
        "parse_authenticator_export" => {
            let text = req.args["text"]
                .as_str()
                .or_else(|| req.args["input"].as_str())
                .unwrap_or("");
            let entries = parse_authenticator_export(text)?;
            serde_json::to_value(entries).map_err(|e| e.to_string())
        }
        "detect_import_format" => {
            let text = req.args["text"].as_str().unwrap_or("");
            serde_json::to_value(detect_import_format(text)).map_err(|e| e.to_string())
        }
        "totp_import_match" => {
            let items: Vec<VaultItemPayload> =
                serde_json::from_value(req.args["items"].clone()).map_err(|e| e.to_string())?;
            let entry: TotpImportEntry =
                serde_json::from_value(req.args["entry"].clone()).map_err(|e| e.to_string())?;
            serde_json::to_value(totp_import_match(&items, &entry)).map_err(|e| e.to_string())
        }
        "plan_totp_import" => {
            let items: Vec<VaultItemPayload> =
                serde_json::from_value(req.args["items"].clone()).map_err(|e| e.to_string())?;
            let entries: Vec<TotpImportEntry> =
                serde_json::from_value(req.args["entries"].clone()).map_err(|e| e.to_string())?;
            serde_json::to_value(plan_totp_import(&items, &entries)).map_err(|e| e.to_string())
        }
        "has_same_totp_secret" => {
            let existing_totp = req.args["existingTotp"].as_str();
            let secret = req.args["secret"].as_str().unwrap_or("");
            Ok(Value::Bool(has_same_totp_secret(existing_totp, secret)))
        }
        "totp_issuer_matches_item" => {
            let issuer = req.args["issuer"].as_str().unwrap_or("");
            let item: VaultItemPayload =
                serde_json::from_value(req.args["item"].clone()).map_err(|e| e.to_string())?;
            Ok(Value::Bool(totp_issuer_matches_item(issuer, &item)))
        }
        other => Err(format!("Unknown ffi op: {other}")),
    }
}

fn invoke_raw_bytes(input_slice: &[u8]) -> (*mut u8, usize) {
    let response = match serde_json::from_slice::<InvokeRequest>(input_slice) {
        Ok(req) => match dispatch(req) {
            Ok(val) => InvokeResponse {
                ok: true,
                result: Some(val),
                error: None,
            },
            Err(err) => InvokeResponse {
                ok: false,
                result: None,
                error: Some(err),
            },
        },
        Err(e) => InvokeResponse {
            ok: false,
            result: None,
            error: Some(format!("Invalid JSON request: {e}")),
        },
    };

    let mut bytes = serde_json::to_vec(&response)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"Serialization error"}"#.to_vec());
    let out_len = bytes.len();
    let out_ptr = np_alloc(out_len);
    if out_ptr.is_null() {
        bytes.zeroize();
        return (std::ptr::null_mut(), 0);
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, out_len);
    }
    bytes.zeroize();
    (out_ptr, out_len)
}

fn alloc_panic_error() -> (*mut u8, usize) {
    const ERR_BYTES: &[u8] = br#"{"ok":false,"error":"Internal panic in nonepwd-core"}"#;
    let out_ptr = np_alloc(ERR_BYTES.len());
    if out_ptr.is_null() {
        return (std::ptr::null_mut(), 0);
    }
    unsafe {
        std::ptr::copy_nonoverlapping(ERR_BYTES.as_ptr(), out_ptr, ERR_BYTES.len());
    }
    (out_ptr, ERR_BYTES.len())
}

/// 64-bit native-safe C ABI entry point: reads `in_len` bytes of JSON from `in_ptr`,
/// writes output length to `*out_len`, and returns a heap `*mut u8` buffer allocated
/// via `np_alloc` (caller frees with `np_free_result(out_ptr, out_len)`).
#[no_mangle]
pub unsafe extern "C" fn np_invoke_native(
    in_ptr: *const u8,
    in_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let input_slice = if in_ptr.is_null() || in_len == 0 {
            &[][..]
        } else {
            unsafe { slice::from_raw_parts(in_ptr, in_len) }
        };
        invoke_raw_bytes(input_slice)
    }));
    let (ptr, len) = result.unwrap_or_else(|_| alloc_panic_error());
    if !out_len.is_null() {
        unsafe {
            *out_len = len;
        }
    }
    ptr
}

/// WASM 32-bit packed C ABI entry point returning `((out_ptr as u64) << 32) | (out_len as u64)`.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn np_invoke(ptr: *const u8, len: usize) -> u64 {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let input_slice = if ptr.is_null() || len == 0 {
            &[][..]
        } else {
            unsafe { slice::from_raw_parts(ptr, len) }
        };
        invoke_raw_bytes(input_slice)
    }));
    let (out_ptr, out_len) = result.unwrap_or_else(|_| alloc_panic_error());
    ((out_ptr as u64) << 32) | (out_len as u64)
}
