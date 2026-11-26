pub mod agent_access;
pub mod crypto;
pub mod csv_import;
pub mod encoding;
pub mod ffi;
pub mod generator;
pub mod otp_extractor;
pub mod random;
pub mod secret_ref;
pub mod totp;
pub mod totp_import;
pub mod types;

#[cfg(test)]
mod tests {
    use super::crypto::{
        decode_service_account_token, decrypt_json, derive_account_keys_raw,
        encode_service_account_token, encrypt_json, generate_email_key_pair,
        generate_raw_aes_key, open_sealed_json, seal_json_for_public_key,
    };
    use super::csv_import::{item_import_fingerprint, parse_password_csv};
    use super::encoding::{generate_secret_key, normalize_secret_key, to_base32, to_base64_url};
    use super::ffi::{np_alloc, np_dealloc, np_free_result, np_invoke_native};
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
    use super::totp_import::{
        detect_import_format, parse_authenticator_export, plan_totp_import, totp_import_match,
        ImportFormat, TotpImportAction,
    };
    use super::types::{
        aad, CardDetails, CustomField, IdentityDetails, ItemCategory, ServiceAccountTokenPayload,
        VaultItemPayload,
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
            card: None,
            identity: None,
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

        let parsed_op = parse_secret_ref("op://DevOps/OpenAI/credential").unwrap();
        assert_eq!(parsed_op.vault, "DevOps");
        assert_eq!(parsed_op.item, "OpenAI");
        assert_eq!(parsed_op.field, "credential");

        let parsed_op_sec = parse_secret_ref("op://DevOps/OpenAI/API/api_key").unwrap();
        assert_eq!(parsed_op_sec.field, "api_key");
        assert_eq!(parsed_op_sec.params.get("section").map(String::as_str), Some("API"));

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
            card: None,
            identity: None,
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

        let mut ssh_item = item.clone();
        ssh_item.category = ItemCategory::SshKey;
        ssh_item.password = Some("-----BEGIN OPENSSH PRIVATE KEY-----".into());
        ssh_item.custom_fields = vec![CustomField {
            id: "pk1".into(),
            label: "public_key".into(),
            value: "ssh-ed25519 AAAA".into(),
            field_type: "text".into(),
        }];
        assert_eq!(
            resolve_item_field(&ssh_item, "private_key").as_deref(),
            Some("-----BEGIN OPENSSH PRIVATE KEY-----")
        );
        assert_eq!(
            resolve_item_field(&ssh_item, "public_key").as_deref(),
            Some("ssh-ed25519 AAAA")
        );

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

    #[test]
    fn brave_and_localized_csv_password_import() {
        let brave_csv = "\u{FEFF}name,url,username,password,note\r\n\
GitHub,https://github.com/login,octocat,\"p@ss,with\"\"quote\"\"\",\"line 1\nline 2\"\r\n\
,https://accounts.google.com/v3/signin,user@gmail.com, my pass ,中文备注\r\n\
,,,,\r\n";

        let entries = parse_password_csv(brave_csv).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title, "GitHub");
        assert_eq!(entries[0].urls, vec!["https://github.com/login"]);
        assert_eq!(entries[0].username.as_deref(), Some("octocat"));
        assert_eq!(entries[0].password.as_deref(), Some("p@ss,with\"quote\""));
        assert_eq!(entries[0].notes.as_deref(), Some("line 1\nline 2"));

        // Blank name falls back to registrable domain; password preserves exact spaces
        assert_eq!(entries[1].title, "google.com");
        assert_eq!(entries[1].password.as_deref(), Some(" my pass "));
        assert_eq!(entries[1].notes.as_deref(), Some("中文备注"));

        assert_eq!(
            item_import_fingerprint(Some("HTTPS://GitHub.com/login/"), Some(" octocat "), Some("abc")),
            item_import_fingerprint(Some("https://github.com/login"), Some("octocat"), Some("abc"))
        );

        let zh_csv = "名称,网址,用户名,密码,备注\nCloudflare,https://dash.cloudflare.com,admin@test.dev,cf-secret,主账号\n";
        let zh_entries = parse_password_csv(zh_csv).unwrap();
        assert_eq!(zh_entries.len(), 1);
        assert_eq!(zh_entries[0].title, "Cloudflare");
        assert_eq!(zh_entries[0].password.as_deref(), Some("cf-secret"));

        assert!(parse_password_csv("foo,bar,baz\n1,2,3\n").is_err());
    }

    fn pb_varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let mut b = (v & 0x7f) as u8;
            v >>= 7;
            if v != 0 {
                b |= 0x80;
            }
            out.push(b);
            if v == 0 {
                break;
            }
        }
    }

    fn pb_len_field(field_num: u64, bytes: &[u8], out: &mut Vec<u8>) {
        pb_varint((field_num << 3) | 2, out);
        pb_varint(bytes.len() as u64, out);
        out.extend_from_slice(bytes);
    }

    fn pb_varint_field(field_num: u64, val: u64, out: &mut Vec<u8>) {
        pb_varint((field_num << 3) | 0, out);
        pb_varint(val, out);
    }

    #[test]
    fn card_identity_payload_backward_and_forward_compat() {
        let legacy_json = r#"{
            "id": "legacy-1",
            "vaultId": "v1",
            "category": "login",
            "title": "Legacy Login",
            "favorite": false,
            "tags": [],
            "urls": ["https://example.com"],
            "username": "bob",
            "customFields": [],
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z"
        }"#;
        let legacy: VaultItemPayload = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(legacy.card, None);
        assert_eq!(legacy.identity, None);
        let reserialized = serde_json::to_value(&legacy).unwrap();
        assert!(reserialized.get("card").is_none());
        assert!(reserialized.get("identity").is_none());

        let card_item = VaultItemPayload {
            id: "c1".into(),
            vault_id: "v1".into(),
            category: ItemCategory::Card,
            title: "Personal Visa".into(),
            favorite: false,
            tags: vec![],
            urls: vec![],
            username: None,
            password: None,
            totp: None,
            email_alias: None,
            notes: None,
            card: Some(CardDetails {
                cardholder_name: Some("Alice Chen".into()),
                number: Some("4242424242424242".into()),
                exp_month: Some("09".into()),
                exp_year: Some("2029".into()),
                cvv: Some("123".into()),
                brand: Some("visa".into()),
            }),
            identity: None,
            custom_fields: vec![],
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            last_used_at: None,
        };
        let card_json = serde_json::to_value(&card_item).unwrap();
        assert_eq!(card_json["category"], "card");
        assert_eq!(card_json["card"]["cardholderName"], "Alice Chen");
        assert_eq!(card_json["card"]["expMonth"], "09");
        assert_eq!(resolve_item_field(&card_item, "cvv").as_deref(), Some("123"));

        let id_item = VaultItemPayload {
            id: "id1".into(),
            vault_id: "v1".into(),
            category: ItemCategory::Identity,
            title: "Home Address".into(),
            favorite: false,
            tags: vec![],
            urls: vec![],
            username: None,
            password: None,
            totp: None,
            email_alias: None,
            notes: None,
            card: None,
            identity: Some(IdentityDetails {
                full_name: Some("Alice Chen".into()),
                first_name: Some("Alice".into()),
                last_name: Some("Chen".into()),
                email: Some("alice@example.com".into()),
                phone: Some("+1-555-0100".into()),
                company: Some("Acme Corp".into()),
                address1: Some("100 Market St".into()),
                address2: Some("Suite 200".into()),
                city: Some("San Francisco".into()),
                state: Some("CA".into()),
                postal_code: Some("94105".into()),
                country: Some("US".into()),
            }),
            custom_fields: vec![],
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            last_used_at: None,
        };
        let id_json = serde_json::to_value(&id_item).unwrap();
        assert_eq!(id_json["category"], "identity");
        assert_eq!(id_json["identity"]["address1"], "100 Market St");
        assert_eq!(id_json["identity"]["postalCode"], "94105");
        assert_eq!(resolve_item_field(&id_item, "email").as_deref(), Some("alice@example.com"));
        assert_eq!(resolve_item_field(&id_item, "postalCode").as_deref(), Some("94105"));
    }

    #[test]
    fn authenticator_export_parser_and_matching() {
        // 1. otpauth://totp lines with comments & blank lines
        let lines_export = "\
            # Exported TOTP URIs\n\
            \n\
            otpauth://totp/GitHub:octocat@github.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub\n\
            otpauth://hotp/Legacy:old?secret=JBSWY3DPEHPK3PXP&counter=1\n\
            otpauth://totp/Cloudflare:ops%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Cloudflare&digits=8&period=60&algorithm=SHA256\n";

        assert_eq!(detect_import_format(lines_export), ImportFormat::Totp);
        assert_eq!(
            detect_import_format("name,url,username,password\nGitHub,https://github.com,a,b\n"),
            ImportFormat::Csv
        );

        let parsed_lines = parse_authenticator_export(lines_export).unwrap();
        assert_eq!(parsed_lines.len(), 2);
        assert_eq!(parsed_lines[0].issuer.as_deref(), Some("GitHub"));
        assert_eq!(parsed_lines[0].account.as_deref(), Some("octocat@github.com"));
        assert_eq!(parsed_lines[0].secret, "JBSWY3DPEHPK3PXP");
        assert_eq!(parsed_lines[0].digits, 6);
        assert_eq!(parsed_lines[0].period, 30);
        assert_eq!(parsed_lines[0].algorithm, TotpAlgorithm::SHA1);

        assert_eq!(parsed_lines[1].issuer.as_deref(), Some("Cloudflare"));
        assert_eq!(parsed_lines[1].account.as_deref(), Some("ops@example.com"));
        assert_eq!(parsed_lines[1].digits, 8);
        assert_eq!(parsed_lines[1].period, 60);
        assert_eq!(parsed_lines[1].algorithm, TotpAlgorithm::SHA256);

        // 2. Google Authenticator otpauth-migration://offline?data=<url-encoded base64 protobuf>
        let mut entry1 = Vec::new();
        pb_len_field(1, b"12345678901234567890", &mut entry1);
        pb_len_field(2, b"Google:alice@gmail.com", &mut entry1);
        pb_len_field(3, b"Google", &mut entry1);
        pb_varint_field(4, 1, &mut entry1); // SHA1
        pb_varint_field(5, 1, &mut entry1); // 6 digits
        pb_varint_field(6, 2, &mut entry1); // TOTP

        let mut entry2_hotp = Vec::new();
        pb_len_field(1, b"hotpsecret", &mut entry2_hotp);
        pb_len_field(2, b"SkipMe", &mut entry2_hotp);
        pb_varint_field(6, 1, &mut entry2_hotp); // HOTP -> skipped

        let mut entry3 = Vec::new();
        // Raw bytes chosen to produce '+' and '/' in standard base64 when combined
        pb_len_field(1, &[0xfb, 0xff, 0xbf, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77], &mut entry3);
        pb_len_field(2, b"dev@stripe.com", &mut entry3);
        pb_len_field(3, b"Stripe", &mut entry3);
        pb_varint_field(4, 2, &mut entry3); // SHA256
        pb_varint_field(5, 2, &mut entry3); // 8 digits
        pb_varint_field(6, 2, &mut entry3); // TOTP

        let mut migration = Vec::new();
        pb_len_field(1, &entry1, &mut migration);
        pb_len_field(1, &entry2_hotp, &mut migration);
        pb_len_field(1, &entry3, &mut migration);
        pb_varint_field(2, 1, &mut migration); // version = 1
        pb_varint_field(3, 1, &mut migration); // batch_size = 1

        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        let std_b64 = STANDARD.encode(&migration);
        let url_encoded_b64 = std_b64
            .replace('+', "%2B")
            .replace('/', "%2F")
            .replace('=', "%3D");
        let migration_uri = format!("otpauth-migration://offline?data={url_encoded_b64}");
        let mig_entries = parse_authenticator_export(&migration_uri).unwrap();
        assert_eq!(mig_entries.len(), 2);
        assert_eq!(mig_entries[0].issuer.as_deref(), Some("Google"));
        assert_eq!(mig_entries[0].account.as_deref(), Some("alice@gmail.com"));
        assert_eq!(mig_entries[0].secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        assert_eq!(generate_totp(&mig_entries[0].otpauth_uri, 59_000).unwrap().code, "287082");

        assert_eq!(mig_entries[1].issuer.as_deref(), Some("Stripe"));
        assert_eq!(mig_entries[1].account.as_deref(), Some("dev@stripe.com"));
        assert_eq!(mig_entries[1].digits, 8);
        assert_eq!(mig_entries[1].algorithm, TotpAlgorithm::SHA256);

        // 3. Aegis plain JSON & 2FAS JSON
        let aegis_json = r#"{
            "version": 1,
            "header": { "slots": null, "params": null },
            "db": {
                "version": 2,
                "entries": [
                    {
                        "type": "totp",
                        "name": "octocat@github.com",
                        "issuer": "GitHub",
                        "info": { "secret": "JBSWY3DPEHPK3PXP", "algo": "SHA1", "digits": 6, "period": 30 }
                    }
                ]
            }
        }"#;
        let aegis_entries = parse_authenticator_export(aegis_json).unwrap();
        assert_eq!(aegis_entries.len(), 1);
        assert_eq!(aegis_entries[0].issuer.as_deref(), Some("GitHub"));

        let twofas_json = r#"{
            "schemaVersion": 4,
            "services": [
                {
                    "name": "Discord",
                    "secret": "JBSWY3DPEHPK3PXP",
                    "otp": { "account": "gamer@example.com", "issuer": "Discord", "digits": 6, "period": 30, "algorithm": "SHA1", "tokenType": "TOTP" }
                }
            ]
        }"#;
        let twofas_entries = parse_authenticator_export(twofas_json).unwrap();
        assert_eq!(twofas_entries.len(), 1);
        assert_eq!(twofas_entries[0].issuer.as_deref(), Some("Discord"));
        assert_eq!(twofas_entries[0].account.as_deref(), Some("gamer@example.com"));

        // 4. Matching & duplicate secret skipping
        let existing = vec![
            VaultItemPayload {
                id: "item-google".into(),
                vault_id: "v1".into(),
                category: ItemCategory::Login,
                title: "google.com".into(),
                favorite: false,
                tags: vec![],
                urls: vec!["https://accounts.google.com/v3/signin".into()],
                username: Some("alice@gmail.com".into()),
                password: Some("pw".into()),
                totp: None,
                email_alias: None,
                notes: None,
                card: None,
                identity: None,
                custom_fields: vec![],
                created_at: "".into(),
                updated_at: "".into(),
                last_used_at: None,
            },
            VaultItemPayload {
                id: "item-existing-totp".into(),
                vault_id: "v1".into(),
                category: ItemCategory::Login,
                title: "GitHub".into(),
                favorite: false,
                tags: vec![],
                urls: vec!["https://github.com".into()],
                username: Some("octocat@github.com".into()),
                password: Some("pw".into()),
                totp: Some("JBSWY3DPEHPK3PXP".into()),
                email_alias: None,
                notes: None,
                card: None,
                identity: None,
                custom_fields: vec![],
                created_at: "".into(),
                updated_at: "".into(),
                last_used_at: None,
            },
        ];

        assert!(matches!(
            totp_import_match(&existing, &parsed_lines[0]),
            TotpImportAction::SkipDuplicate { .. }
        ));
        let plan = plan_totp_import(&existing, &mig_entries);
        assert_eq!(plan.len(), 2);
        assert!(matches!(
            &plan[0].decision,
            TotpImportAction::Attach { item_id, .. } if item_id == "item-google"
        ));
        assert!(matches!(
            &plan[1].decision,
            TotpImportAction::Create { title, username, .. }
                if title == "Stripe" && username.as_deref() == Some("dev@stripe.com")
        ));
    }

    #[test]
    fn native_c_abi_roundtrip() {
        let req = br#"{"op":"generate_secret_key","args":{}}"#;
        let in_ptr = np_alloc(req.len());
        let mut out_len: usize = 0;
        let out_ptr = unsafe {
            std::ptr::copy_nonoverlapping(req.as_ptr(), in_ptr, req.len());
            np_invoke_native(in_ptr, req.len(), &mut out_len)
        };
        np_dealloc(in_ptr, req.len());
        assert!(!out_ptr.is_null());
        assert!(out_len > 0);
        let resp_bytes = unsafe { std::slice::from_raw_parts(out_ptr, out_len) };
        let resp: serde_json::Value = serde_json::from_slice(resp_bytes).unwrap();
        np_free_result(out_ptr, out_len);
        assert_eq!(resp["ok"], true);
        assert!(resp["result"].as_str().unwrap().starts_with("NP3-"));
    }

    #[test]
    fn psl_multi_tenant_protocol_downgrade_and_at_query_host_parsing() {
        use super::otp_extractor::extract_host;

        // Multi-tenant hosting isolation
        assert_eq!(extract_registrable_domain("https://alice.github.io"), "alice.github.io");
        assert_eq!(extract_registrable_domain("https://sub.alice.github.io"), "alice.github.io");
        assert!(!domains_match("https://a.github.io", "https://b.github.io"));
        assert!(!domains_match("https://a.pages.dev", "https://b.pages.dev"));
        assert!(!domains_match("https://a.vercel.app", "https://b.vercel.app"));
        assert!(!domains_match("https://a.netlify.app", "https://b.netlify.app"));
        assert!(!domains_match("https://a.herokuapp.com", "https://b.herokuapp.com"));
        assert!(!domains_match("https://a.fly.dev", "https://b.fly.dev"));
        assert!(!domains_match("https://a.onrender.com", "https://b.onrender.com"));
        assert!(!domains_match("https://a.web.app", "https://b.web.app"));
        assert!(!domains_match("https://a.firebaseapp.com", "https://b.firebaseapp.com"));
        assert!(!domains_match("https://a.azurewebsites.net", "https://b.azurewebsites.net"));
        assert_eq!(
            extract_registrable_domain("https://app.alice.workers.dev"),
            "app.alice.workers.dev"
        );
        assert!(!domains_match(
            "https://a.alice.workers.dev",
            "https://b.bob.workers.dev"
        ));
        assert!(!domains_match(
            "https://bucket-a.s3.us-east-1.amazonaws.com",
            "https://bucket-b.s3.us-east-1.amazonaws.com"
        ));

        // Added 2-level ccTLDs
        assert_eq!(extract_registrable_domain("auth.shop.co.nz"), "shop.co.nz");
        assert_eq!(extract_registrable_domain("www.school.edu.sg"), "school.edu.sg");
        assert_eq!(extract_registrable_domain("portal.agency.gov.au"), "agency.gov.au");
        assert_eq!(extract_registrable_domain("app.bank.co.za"), "bank.co.za");
        assert_eq!(extract_registrable_domain("mail.store.com.ar"), "store.com.ar");
        assert!(!domains_match("https://a.co.nz", "https://b.co.nz"));

        // Scheme-less URL containing `@` in path/query/fragment must NOT be parsed as email
        assert_eq!(extract_host("evil.com/login?user=victim@github.com"), "evil.com");
        assert_eq!(extract_host("evil.com?user=victim@github.com"), "evil.com");
        assert_eq!(extract_host("evil.com#victim@github.com"), "evil.com");
        assert_eq!(extract_host("GitHub <noreply@github.com>"), "github.com");
        assert!(!domains_match(
            "evil.com/login?user=victim@github.com",
            "https://github.com"
        ));

        // Protocol downgrade rejection (https:// vs http://)
        assert!(!domains_match("https://github.com", "http://github.com"));
        assert!(!domains_match("http://github.com", "https://github.com"));
        assert!(domains_match("https://github.com", "github.com"));
        assert!(domains_match("https://app.github.com", "noreply@github.com"));

        // Localhost / 127.0.0.1 explicit port isolation
        assert!(!domains_match("http://localhost:3000", "http://localhost:8787"));
        assert!(domains_match("http://localhost:8787", "http://localhost:8787/login"));
        assert!(!domains_match("http://127.0.0.1:3000", "http://127.0.0.1:8787"));
        assert!(domains_match("http://127.0.0.1:8787", "http://127.0.0.1:8787"));
    }

    #[test]
    fn x25519_rejects_low_order_zero_public_key() {
        use super::crypto::{open_sealed_envelope, seal_for_public_key};
        use super::types::SealedEnvelope;

        let zero_pub_b64 = to_base64_url(&[0u8; 32]);
        let seal_err = seal_for_public_key(&zero_pub_b64, b"secret", "nonepwd-email-v1")
            .expect_err("zero public key must be rejected");
        assert!(seal_err.contains("Non-contributory"), "unexpected err: {seal_err}");

        let kp = generate_email_key_pair().unwrap();
        let bad_env = SealedEnvelope {
            v: 1,
            epk: zero_pub_b64,
            iv: to_base64_url(&[0u8; 12]),
            ct: to_base64_url(&[0u8; 32]),
        };
        let open_err = open_sealed_envelope(&kp.private_key_pkcs8_b64, &bad_env, "nonepwd-email-v1")
            .expect_err("zero ephemeral public key must be rejected");
        assert!(open_err.contains("Non-contributory"), "unexpected err: {open_err}");
    }

    #[test]
    fn kdf_bounds_and_ffi_safety() {
        let sk = generate_secret_key().unwrap();
        let valid_salt = to_base64_url(&random_bytes(16).unwrap());
        let short_salt = to_base64_url(&random_bytes(8).unwrap());

        assert!(derive_account_keys_raw("Pass#1", &sk, &valid_salt, 0).is_err());
        assert!(derive_account_keys_raw("Pass#1", &sk, &valid_salt, 999).is_err());
        assert!(derive_account_keys_raw("Pass#1", &sk, &valid_salt, 5_000_001).is_err());
        assert!(derive_account_keys_raw("Pass#1", &sk, &short_salt, 1_000).is_err());
        assert!(derive_account_keys_raw("Pass#1", &sk, &valid_salt, 1_000).is_ok());

        // Oversized u64 iterations (would have truncated to 1 with `as u32`) must error via FFI
        let req = serde_json::json!({
            "op": "derive_account_keys",
            "args": {
                "masterPassword": "Pass#1",
                "secretKey": sk,
                "kdfSaltB64": valid_salt,
                "iterations": 4_294_967_297u64
            }
        });
        let req_bytes = serde_json::to_vec(&req).unwrap();
        let in_ptr = np_alloc(req_bytes.len());
        let mut out_len: usize = 0;
        let out_ptr = unsafe {
            std::ptr::copy_nonoverlapping(req_bytes.as_ptr(), in_ptr, req_bytes.len());
            np_invoke_native(in_ptr, req_bytes.len(), &mut out_len)
        };
        np_dealloc(in_ptr, req_bytes.len());
        let resp: serde_json::Value =
            serde_json::from_slice(unsafe { std::slice::from_raw_parts(out_ptr, out_len) }).unwrap();
        np_free_result(out_ptr, out_len);
        assert_eq!(resp["ok"], false);

        // random_bytes cap > 1 MiB must error via FFI
        let cap_req = br#"{"op":"random_bytes","args":{"len":1048577}}"#;
        let in_ptr = np_alloc(cap_req.len());
        let mut out_len: usize = 0;
        let out_ptr = unsafe {
            std::ptr::copy_nonoverlapping(cap_req.as_ptr(), in_ptr, cap_req.len());
            np_invoke_native(in_ptr, cap_req.len(), &mut out_len)
        };
        np_dealloc(in_ptr, cap_req.len());
        let cap_resp: serde_json::Value =
            serde_json::from_slice(unsafe { std::slice::from_raw_parts(out_ptr, out_len) }).unwrap();
        np_free_result(out_ptr, out_len);
        assert_eq!(cap_resp["ok"], false);

        // Invalid layout length must return null instead of panicking
        assert!(np_alloc(usize::MAX).is_null());
    }

    #[test]
    fn random_int_above_u32_max_and_hotp_rejection() {
        use super::random::random_int;
        use super::totp::parse_otp_input;

        #[cfg(target_pointer_width = "64")]
        {
            let bound = (u32::MAX as usize) + 12_345;
            let val = random_int(bound).unwrap();
            assert!(val < bound);
        }

        let err = parse_otp_input("otpauth://hotp/Legacy:old?secret=JBSWY3DPEHPK3PXP&counter=1")
            .expect_err("HOTP URI must be rejected");
        assert!(err.to_ascii_lowercase().contains("hotp"), "unexpected err: {err}");
        assert!(generate_totp("otpauth://hotp/Legacy:old?secret=JBSWY3DPEHPK3PXP&counter=1", 59_000).is_err());
    }
}
