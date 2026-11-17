pub mod crypto;
pub mod encoding;
pub mod generator;
pub mod otp_extractor;
pub mod random;
pub mod secret_ref;
pub mod totp;
pub mod types;

#[cfg(target_arch = "wasm32")]
pub mod wasm_ffi;

#[cfg(test)]
mod tests {
    use super::crypto::{
        decode_service_account_token, decrypt_json, derive_account_keys_raw,
        encode_service_account_token, encrypt_json, generate_email_key_pair,
        generate_raw_aes_key, open_sealed_json, seal_json_for_public_key,
    };
    use super::encoding::{generate_secret_key, normalize_secret_key, to_base32, to_base64_url};
    use super::generator::{
        generate_email_alias, generate_passphrase, generate_password, PassphraseOptions,
        PasswordOptions,
    };
    use super::otp_extractor::{
        domains_match, extract_email_otp, extract_registrable_domain, EmailOtpExtractionInput,
    };
    use super::random::random_bytes;
    use super::secret_ref::{parse_dot_env, parse_secret_ref, resolve_item_field};
    use super::totp::{build_otp_auth_uri, generate_totp, TotpAlgorithm};
    use super::types::{
        aad, CustomField, ItemCategory, ServiceAccountTokenPayload, VaultItemPayload,
    };

    #[test]
    fn secret_key_and_dual_key_derivation() {
        let sk = generate_secret_key().unwrap();
        assert!(sk.starts_with("NP3-"));
        assert_eq!(normalize_secret_key(&sk.to_lowercase().replace('-', " ")), sk.replace('-', ""));

        let salt = to_base64_url(&random_bytes(16).unwrap());
        let (muk1, v1) = derive_account_keys_raw("Master#1", &sk, &salt, 10_000).unwrap();
        let (muk2, v2) =
            derive_account_keys_raw("Master#1", &sk.to_lowercase(), &salt, 10_000).unwrap();
        let (_, v_bad) = derive_account_keys_raw("Wrong", &sk, &salt, 10_000).unwrap();
        assert_eq!(muk1, muk2);
        assert_eq!(v1, v2);
        assert_ne!(v1, v_bad);
    }

    #[test]
    fn aes_gcm_aad_and_x25519_sealed_box() {
        let key = generate_raw_aes_key().unwrap();
        let item = VaultItemPayload {
            id: "i1".into(),
            vault_id: "v1".into(),
            category: ItemCategory::Login,
            title: "GitHub".into(),
            favorite: true,
            tags: vec![],
            urls: vec!["https://github.com".into()],
            username: Some("alice".into()),
            password: Some("s3cr3t".into()),
            totp: None,
            email_alias: None,
            notes: None,
            custom_fields: vec![CustomField {
                id: "f1".into(),
                label: "API Key".into(),
                value: "sk-123".into(),
                field_type: "concealed".into(),
            }],
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            last_used_at: None,
        };

        let blob = encrypt_json(&key, &item, Some(&aad::vault_item("v1", "i1"))).unwrap();
        let dec: VaultItemPayload =
            decrypt_json(&key, &blob, Some(&aad::vault_item("v1", "i1"))).unwrap();
        assert_eq!(dec, item);
        assert!(decrypt_json::<VaultItemPayload>(&key, &blob, Some(&aad::vault_item("v2", "i1"))).is_err());

        let kp = generate_email_key_pair().unwrap();
        let sealed = seal_json_for_public_key(&kp.public_key_b64, &item, "nonepwd-email-v1").unwrap();
        let opened: VaultItemPayload =
            open_sealed_json(&kp.private_key_pkcs8_b64, &sealed, "nonepwd-email-v1").unwrap();
        assert_eq!(opened, item);
    }

    #[test]
    fn totp_rfc6238_vector() {
        let secret_b32 = to_base32(b"12345678901234567890");
        let uri = build_otp_auth_uri(
            &secret_b32,
            Some("test"),
            Some("RFC"),
            Some(8),
            Some(30),
            Some(TotpAlgorithm::SHA1),
        );
        let res8 = generate_totp(&uri, 59_000).unwrap();
        assert_eq!(res8.code, "94287082");
        let res6 = generate_totp(&secret_b32, 59_000).unwrap();
        assert_eq!(res6.code, "287082");
    }

    #[test]
    fn email_otp_en_zh_and_period_handling() {
        let html = r##"
            <html><head><style>.box{color:#445566}</style></head>
            <body>
              <p>Your GitHub verification code is:</p>
              <div>839204</div>
              <a href="https://github.com/login/verify?token=abc">Sign in</a>
              <footer>© 2026 GitHub Inc. Order #998877</footer>
            </body></html>
        "##;
        let res = extract_email_otp(&EmailOtpExtractionInput {
            from: "GitHub <noreply@github.com>".into(),
            to: "me@example.com".into(),
            subject: "[GitHub] Please verify".into(),
            text: None,
            html: Some(html.into()),
        });
        assert_eq!(res.otp_code.as_deref(), Some("839204"));
        assert!(res.confidence > 0.7);
        assert_eq!(res.magic_link.as_deref(), Some("https://github.com/login/verify?token=abc"));
        assert_eq!(res.sender_domain, "github.com");

        let zh = extract_email_otp(&EmailOtpExtractionInput {
            from: "Steam <noreply@steampowered.com>".into(),
            to: "me@example.com".into(),
            subject: "您的 Steam 登录验证码".into(),
            text: Some("您好，您本次登录的安全验证码为：649-102，5分钟内有效。客服电话 4001234567。".into()),
            html: None,
        });
        assert_eq!(zh.otp_code.as_deref(), Some("649102"));

        let period = extract_email_otp(&EmailOtpExtractionInput {
            from: "Cursor <no-reply@cursor.com>".into(),
            to: "me@example.com".into(),
            subject: "Sign in to Cursor".into(),
            text: Some("Your verification code is 519382. Amount $1234.56 is unrelated.".into()),
            html: None,
        });
        assert_eq!(period.otp_code.as_deref(), Some("519382"));

        let promo = extract_email_otp(&EmailOtpExtractionInput {
            from: "Shop <promo@store.example.com>".into(),
            to: "me@example.com".into(),
            subject: "Spring Sale 2026".into(),
            text: Some("Order #441239 total price $1500 USD. Copyright 2026 Store Inc.".into()),
            html: None,
        });
        assert_eq!(promo.otp_code, None);

        assert_eq!(extract_registrable_domain("auth.service.co.uk"), "service.co.uk");
        assert!(domains_match("https://app.cursor.com", "no-reply@cursor.com"));
    }

    #[test]
    fn secret_ref_tokens_and_generators() {
        let parsed = parse_secret_ref("np://DevOps/OpenAI/api_key?wait=30").unwrap();
        assert_eq!(parsed.vault, "DevOps");
        assert_eq!(parsed.params.get("wait").map(String::as_str), Some("30"));

        let item = VaultItemPayload {
            id: "1".into(),
            vault_id: "v".into(),
            category: ItemCategory::ApiCredential,
            title: "OpenAI".into(),
            favorite: false,
            tags: vec![],
            urls: vec![],
            username: None,
            password: None,
            totp: None,
            email_alias: None,
            notes: None,
            custom_fields: vec![CustomField {
                id: "cf1".into(),
                label: "API Key".into(),
                value: "sk-abc".into(),
                field_type: "concealed".into(),
            }],
            created_at: "".into(),
            updated_at: "".into(),
            last_used_at: None,
        };
        assert_eq!(resolve_item_field(&item, "api_key").as_deref(), Some("sk-abc"));

        let env = parse_dot_env("export A=\"hello\"\n# c\nB=np://Dev/X/p");
        assert_eq!(env.get("A").map(String::as_str), Some("hello"));
        assert_eq!(env.get("B").map(String::as_str), Some("np://Dev/X/p"));

        let sa = ServiceAccountTokenPayload {
            v: 1,
            server_url: "http://127.0.0.1:8787".into(),
            token_id: "sa_1".into(),
            auth_secret: "sec".into(),
            wrap_key_b64: to_base64_url(&generate_raw_aes_key().unwrap()),
        };
        let encoded = encode_service_account_token(&sa).unwrap();
        assert_eq!(decode_service_account_token(&encoded).unwrap(), sa);

        assert_eq!(generate_password(&PasswordOptions::default()).unwrap().len(), 20);
        assert_eq!(
            generate_passphrase(&PassphraseOptions::default())
                .unwrap()
                .split('-')
                .count(),
            4
        );
        let alias = generate_email_alias("https://app.cursor.com", "mail.home.dev").unwrap();
        assert!(alias.starts_with("cursor.") && alias.ends_with("@mail.home.dev"));
    }
}
