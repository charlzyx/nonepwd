#[cfg(feature = "agent")]
mod agent_cmd;
mod client;
mod config;
mod connect_server;
mod net;

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::Read;
use std::process::{exit, Command};

use nonepwd_core::encoding::to_base64_url;
use nonepwd_core::random::random_bytes;
use nonepwd_core::secret_ref::{find_secret_refs, parse_dot_env, replace_secret_refs, resolve_item_field};
use nonepwd_core::totp_import::{detect_import_format, ImportFormat};
use nonepwd_core::types::ItemCategory;

use crate::client::NonePwdClient;
use crate::config::load_config;
use crate::connect_server::serve_connect;

pub(crate) struct ParsedArgs {
    positionals: Vec<String>,
    flags: HashMap<String, Vec<String>>,
    booleans: HashSet<String>,
    rest_after_dash_dash: Vec<String>,
}

fn is_boolean_flag(name: &str) -> bool {
    matches!(
        name,
        "json"
            | "no-dedupe"
            | "generate"
            | "auto-alias"
            | "help"
            | "h"
            | "version"
            | "connect"
            | "no-newline"
            | "otp"
            | "reveal"
            | "yes"
            | "env-all"
    )
}

fn parse_args(argv: &[String]) -> ParsedArgs {
    let dash_pos = argv.iter().position(|a| a == "--");
    let main_args = match dash_pos {
        Some(idx) => &argv[..idx],
        None => argv,
    };
    let rest_after_dash_dash = match dash_pos {
        Some(idx) => argv[idx + 1..].to_vec(),
        None => Vec::new(),
    };

    let mut positionals = Vec::new();
    let mut flags: HashMap<String, Vec<String>> = HashMap::new();
    let mut booleans = HashSet::new();

    let mut i = 0;
    while i < main_args.len() {
        let arg = &main_args[i];
        if let Some(body) = arg.strip_prefix("--") {
            if let Some((k, v)) = body.split_once('=') {
                flags.entry(k.to_string()).or_default().push(v.to_string());
            } else if !is_boolean_flag(body)
                && i + 1 < main_args.len()
                && !main_args[i + 1].starts_with('-')
            {
                flags
                    .entry(body.to_string())
                    .or_default()
                    .push(main_args[i + 1].clone());
                i += 1;
            } else {
                booleans.insert(body.to_string());
            }
        } else if arg == "-n" {
            booleans.insert("no-newline".to_string());
        } else if (arg == "-i" || arg == "-o" || arg == "-f") && i + 1 < main_args.len() {
            let key = match arg.as_str() {
                "-i" => "in",
                "-o" => "out",
                _ => "format",
            };
            flags
                .entry(key.to_string())
                .or_default()
                .push(main_args[i + 1].clone());
            i += 1;
        } else {
            positionals.push(arg.clone());
        }
        i += 1;
    }

    ParsedArgs {
        positionals,
        flags,
        booleans,
        rest_after_dash_dash,
    }
}

pub(crate) fn first_flag<'a>(parsed: &'a ParsedArgs, name: &str) -> Option<&'a str> {
    parsed.flags.get(name).and_then(|v| v.first()).map(String::as_str)
}

pub(crate) fn has_flag(parsed: &ParsedArgs, name: &str) -> bool {
    parsed.booleans.contains(name) || parsed.flags.contains_key(name)
}

fn parse_category(raw: Option<&str>) -> ItemCategory {
    let norm: String = raw
        .unwrap_or("login")
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
        .collect();
    match norm.as_str() {
        "apicredential" | "apikey" | "api" => ItemCategory::ApiCredential,
        "securenote" | "note" => ItemCategory::SecureNote,
        "sshkey" | "ssh" => ItemCategory::SshKey,
        "card" | "creditcard" => ItemCategory::Card,
        "identity" => ItemCategory::Identity,
        _ => ItemCategory::Login,
    }
}

fn parse_tags_flag(parsed: &ParsedArgs) -> Option<Vec<String>> {
    let raw_list = parsed.flags.get("tags")?;
    let mut tags = Vec::new();
    for entry in raw_list {
        for part in entry.split(',') {
            let t = part.trim();
            if !t.is_empty() && !tags.iter().any(|x: &String| x.eq_ignore_ascii_case(t)) {
                tags.push(t.to_string());
            }
        }
    }
    Some(tags)
}

#[derive(Default)]
struct FieldOverrides {
    urls: Vec<String>,
    username: Option<String>,
    password: Option<String>,
    totp: Option<String>,
    notes: Option<String>,
    custom_fields: Vec<(String, String, String)>,
}

fn collect_field_overrides(parsed: &ParsedArgs, positional_start: usize) -> Result<FieldOverrides, String> {
    let mut out = FieldOverrides::default();
    let mut raw_assignments: Vec<String> = Vec::new();

    if let Some(fields) = parsed.flags.get("field") {
        raw_assignments.extend(fields.iter().cloned());
    }
    for arg in parsed.positionals.iter().skip(positional_start) {
        if arg.contains('=') {
            raw_assignments.push(arg.clone());
        }
    }

    for expr in raw_assignments {
        let (raw_k, raw_v) = expr
            .split_once('=')
            .ok_or_else(|| format!("Invalid field assignment \"{expr}\", expected key=value"))?;
        let raw_k = raw_k.trim();
        let val = raw_v.to_string();

        let (label, explicit_type) = if let Some(idx) = raw_k.rfind('[') {
            if raw_k.ends_with(']') {
                let kind = &raw_k[idx + 1..raw_k.len() - 1];
                let ft = if kind.eq_ignore_ascii_case("text") || kind.eq_ignore_ascii_case("url") {
                    "text"
                } else {
                    "concealed"
                };
                (raw_k[..idx].trim(), Some(ft))
            } else {
                (raw_k, None)
            }
        } else {
            (raw_k, None)
        };

        let norm: String = label
            .to_lowercase()
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
            .collect();

        match norm.as_str() {
            "username" | "user" if explicit_type.is_none() => out.username = Some(val),
            "password" | "pass" if explicit_type.is_none() => out.password = Some(val),
            "totp" | "otp" if explicit_type.is_none() => out.totp = Some(val),
            "notesplain" | "notes" | "note" if explicit_type.is_none() => out.notes = Some(val),
            "website" | "url" if explicit_type.is_none() => out.urls.push(val),
            _ => {
                if out.password.is_none()
                    && matches!(norm.as_str(), "credential" | "apikey" | "token" | "privatekey")
                {
                    out.password = Some(val.clone());
                }
                let field_type = explicit_type.unwrap_or_else(|| {
                    if matches!(norm.as_str(), "publickey" | "host" | "endpoint" | "region") {
                        "text"
                    } else {
                        "concealed"
                    }
                });
                out.custom_fields
                    .push((label.to_string(), val, field_type.to_string()));
            }
        }
    }

    Ok(out)
}

pub(crate) fn is_dangerous_env_var(name: &str) -> bool {
    let upper = name.trim().to_ascii_uppercase();
    upper.starts_with("LD_")
        || upper.starts_with("DYLD_")
        || matches!(
            upper.as_str(),
            "PATH"
                | "NODE_OPTIONS"
                | "BASH_ENV"
                | "ENV"
                | "IFS"
                | "PYTHONSTARTUP"
                | "PYTHONPATH"
                | "RUBYOPT"
                | "PERL5OPT"
        )
}

pub(crate) fn scrub_nonepwd_env(env_map: &mut HashMap<String, String>) {
    env_map.retain(|k, _| {
        !matches!(
            k.to_ascii_uppercase().as_str(),
            "NONEPWD_TOKEN"
                | "NONEPWD_MASTER_PASSWORD"
                | "NONEPWD_SECRET_KEY"
                | "NONEPWD_AGENT_TOKEN"
                | "NONEPWD_CONNECT_TOKEN"
        )
    });
}

fn write_secret_file(path: &str, content: &[u8]) -> Result<(), String> {
    let target = std::path::Path::new(path);
    if let Some(parent) = target.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating parent directory for {path}: {e}"))?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(target)
            .map_err(|e| format!("Failed creating {path}: {e}"))?;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed setting permissions on {path}: {e}"))?;
        file.write_all(content)
            .map_err(|e| format!("Failed writing {path}: {e}"))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(target, content).map_err(|e| format!("Failed writing {path}: {e}"))
    }
}

fn inject_template(client: &mut NonePwdClient, template: &str) -> Result<String, String> {
    let refs = find_secret_refs(template);
    if refs.is_empty() {
        return Ok(template.to_string());
    }
    let mut map = HashMap::new();
    for r in refs {
        let val = client.resolve_secret_ref(&r)?;
        map.insert(r, val);
    }
    Ok(replace_secret_refs(template, &map))
}

fn resolve_requested_import_format(
    raw_flag: Option<&str>,
    content: &str,
) -> Result<ImportFormat, String> {
    match raw_flag.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(detect_import_format(content)),
        Some(f) if f.eq_ignore_ascii_case("auto") => Ok(detect_import_format(content)),
        Some(f) if f.eq_ignore_ascii_case("csv") => Ok(ImportFormat::Csv),
        Some(f)
            if f.eq_ignore_ascii_case("totp")
                || f.eq_ignore_ascii_case("2fa")
                || f.eq_ignore_ascii_case("authenticator") =>
        {
            Ok(ImportFormat::Totp)
        }
        Some(other) => Err(format!(
            "Unsupported --format \"{other}\" (expected csv or totp)"
        )),
    }
}

fn run_import_command(
    client: &mut NonePwdClient,
    parsed: &ParsedArgs,
    positional_idx: usize,
    as_json: bool,
) -> Result<i32, String> {
    let file_path = parsed
        .positionals
        .get(positional_idx)
        .map(String::as_str)
        .or_else(|| first_flag(parsed, "file"))
        .or_else(|| first_flag(parsed, "in"))
        .ok_or("import requires <file>")?;
    let raw_text = fs::read_to_string(file_path)
        .map_err(|e| format!("Failed reading import file {file_path}: {e}"))?;

    let format = resolve_requested_import_format(first_flag(parsed, "format"), &raw_text)?;
    match format {
        ImportFormat::Csv => {
            let summary = client.import_csv(
                &raw_text,
                first_flag(parsed, "vault"),
                !has_flag(parsed, "no-dedupe"),
            )?;
            if as_json {
                println!("{}", serde_json::to_string_pretty(&summary).unwrap());
            } else {
                println!(
                    "Imported {} items into [{}] (parsed: {}, skipped duplicates: {})",
                    summary.imported, summary.vault_name, summary.total, summary.skipped
                );
            }
        }
        ImportFormat::Totp => {
            let summary = client.import_totp(&raw_text, first_flag(parsed, "vault"))?;
            if as_json {
                println!("{}", serde_json::to_string_pretty(&summary).unwrap());
            } else {
                println!(
                    "Imported {} TOTP entries into [{}] (attached: {}, created: {}, skipped: {})",
                    summary.imported,
                    summary.vault_name,
                    summary.attached,
                    summary.created,
                    summary.skipped
                );
            }
        }
    }
    Ok(0)
}

const HELP_TEXT: &str = "nonepwd Native CLI (np) - 1Password (`op`)-compatible zero-knowledge secrets, API/SSH keys, TOTP & Email OTP

Usage:
  np setup --server <url> --email <email> --password <pass> [--alias-domain <dom>] [--json]
  np signin [--server <url>] [--secret-key <NP3-...>] [--password <pass>]
  np lock | np signout | np whoami | np version
  np vault list [--format json] | np vault get <vault> [--format json] | np vault create <name> [--description <d>]
  np item list [--vault <v>] [--tags <a,b>] [--categories <c>] [--format json]
  np item get <item> [--vault <v>] [--fields f1,f2 | --otp] [--format json]
  np item create [--vault <v>] [--title <t>] [--category login|api_credential|ssh_key|card|identity|secure_note]
                 [--url <u>] [--username <u>] [--password <p> | --generate] [--totp <secret>] [--auto-alias]
                 [--tags <a,b>] [--field key=value ...] [key[concealed]=value ...] [--format json]
  np item edit <item> [--vault <v>] [--title <t>] [--username <u>] [--password <p> | --generate]
               [--tags <a,b>] [--field key=value ...] [key=value ...] [--format json]
  np item delete <item> [--vault <v>]
  np import <file> [--format csv|totp] [--vault Personal] [--no-dedupe] [--json]
  np read <np://vault/item/field | op://vault/item/field> [-n|--no-newline] [-o|--out-file <path>]
  np otp <item> [--vault <v>] [--format json]
  np run [--env-file <path>] -- <command> [args...]        (resolves both np:// and op:// references)
  np inject [-i <inputFile>] [-o <outputFile>]             (resolves both {{ np://... }} and {{ op://... }})
  np alias list [--json] | np alias create --for <domain> [--json] | np alias toggle <alias>
  np mail list [--json] | np mail otp [--domain <d>] [--alias <a>] [--wait <sec>] [--json]
  np service-account list | create <name> --vault <v1> [--vault <v2>] [--json] | revoke <id>
  np server [--host 127.0.0.1] [--port 8787] [--data-dir ~/.nonepwd/data]
  np serve --connect [--host 127.0.0.1] [--port 8788] [--token <tok>]
  np agent listen [--relay-url <ws-url>] [--yes]
  np agent connect --token <psk> (--domain <host> | --id <item> | --search <q>) [--json]
  np agent run --token <psk> (--domain <host> | --id <item> | --search <q>) (--env-all | --env KEY=field) -- <cmd>";

fn run() -> Result<i32, String> {
    let raw_args: Vec<String> = env::args().skip(1).collect();
    let parsed = parse_args(&raw_args);
    let cmd = parsed.positionals.first().map(String::as_str);

    if cmd.is_none() || cmd == Some("help") || has_flag(&parsed, "help") || has_flag(&parsed, "h") {
        println!("{HELP_TEXT}");
        return Ok(0);
    }

    let cmd = cmd.unwrap();
    if cmd == "version" || has_flag(&parsed, "version") {
        println!(
            "nonepwd-cli 0.1.0 ({}/{})",
            env::consts::OS,
            env::consts::ARCH
        );
        return Ok(0);
    }

    let as_json = has_flag(&parsed, "json")
        || (cmd != "import"
            && first_flag(&parsed, "format").is_some_and(|f| f.eq_ignore_ascii_case("json")));
    let config_dir = first_flag(&parsed, "config-dir").map(str::to_string);
    let mut client = NonePwdClient::new(
        config_dir.clone(),
        first_flag(&parsed, "server").map(str::to_string),
    );

    match cmd {
        "setup" => {
            let server_url = first_flag(&parsed, "server").ok_or("setup requires --server")?;
            let email = first_flag(&parsed, "email").ok_or("setup requires --email")?;
            let env_pw = env::var("NONEPWD_MASTER_PASSWORD").ok();
            let password = first_flag(&parsed, "password")
                .or(env_pw.as_deref())
                .ok_or("setup requires --password")?;
            let alias_domain = first_flag(&parsed, "alias-domain").unwrap_or("");
            let iter = first_flag(&parsed, "kdf-iterations").and_then(|s| s.parse::<u32>().ok());
            let res = client.setup(server_url, email, password, alias_domain, iter)?;
            if as_json {
                println!("{}", serde_json::to_string_pretty(&res).unwrap());
            } else {
                println!("Account initialized for {}", res["email"].as_str().unwrap_or(""));
                println!(
                    "Secret Key (SAVE THIS EMERGENCY KEY!): {}",
                    res["secretKey"].as_str().unwrap_or("")
                );
            }
            Ok(0)
        }

        "signin" => {
            let env_pw = env::var("NONEPWD_MASTER_PASSWORD").ok();
            let password = first_flag(&parsed, "password")
                .or(env_pw.as_deref())
                .ok_or("signin requires --password or NONEPWD_MASTER_PASSWORD")?;
            let res = client.signin(
                first_flag(&parsed, "server"),
                first_flag(&parsed, "email"),
                first_flag(&parsed, "secret-key"),
                password,
            )?;
            if as_json {
                println!("{}", serde_json::to_string(&res).unwrap());
            } else {
                println!(
                    "Signed in to {} as {}",
                    res["serverUrl"].as_str().unwrap_or(""),
                    res["email"].as_str().unwrap_or("")
                );
            }
            Ok(0)
        }

        "lock" | "signout" => {
            client.lock()?;
            println!("Locked and cleared local session.");
            Ok(0)
        }

        "whoami" => {
            let cfg = load_config(config_dir.as_deref());
            let unlocked = cfg.session.is_some();
            let sa = env::var("NONEPWD_TOKEN").is_ok_and(|v| !v.is_empty());
            if as_json {
                println!(
                    "{}",
                    serde_json::to_string(&serde_json::json!({
                        "serverUrl": cfg.server_url,
                        "email": cfg.email,
                        "unlocked": unlocked,
                        "serviceAccount": sa,
                        "os": env::consts::OS,
                        "arch": env::consts::ARCH,
                    }))
                    .unwrap()
                );
            } else {
                println!(
                    "Server: {} | Email: {} | Unlocked: {} | Platform: {}/{}",
                    cfg.server_url.as_deref().unwrap_or("(unset)"),
                    cfg.email.as_deref().unwrap_or("(unset)"),
                    unlocked,
                    env::consts::OS,
                    env::consts::ARCH,
                );
            }
            Ok(0)
        }

        "vault" => {
            let sub = parsed.positionals.get(1).map(String::as_str).unwrap_or("list");
            match sub {
                "list" => {
                    client.sync()?;
                    if as_json {
                        let list: Vec<_> = client
                            .vaults
                            .iter()
                            .map(|v| {
                                serde_json::json!({
                                    "id": v.id,
                                    "name": v.metadata.name,
                                    "description": v.metadata.description.clone().unwrap_or_default(),
                                })
                            })
                            .collect();
                        println!("{}", serde_json::to_string_pretty(&list).unwrap());
                    } else {
                        for v in &client.vaults {
                            println!("{}\t{}", v.id, v.metadata.name);
                        }
                    }
                    Ok(0)
                }
                "get" => {
                    let target = parsed
                        .positionals
                        .get(2)
                        .map(String::as_str)
                        .or_else(|| first_flag(&parsed, "vault"))
                        .ok_or("vault get requires <vault>")?;
                    client.sync()?;
                    let v = client.find_vault(target)?;
                    if as_json {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(&serde_json::json!({
                                "id": v.id,
                                "name": v.metadata.name,
                                "description": v.metadata.description.clone().unwrap_or_default(),
                            }))
                            .unwrap()
                        );
                    } else {
                        println!("{}\t{}", v.id, v.metadata.name);
                    }
                    Ok(0)
                }
                "create" => {
                    let name = parsed
                        .positionals
                        .get(2)
                        .map(String::as_str)
                        .or_else(|| first_flag(&parsed, "name"))
                        .ok_or("vault create requires <name>")?;
                    let v = client.create_vault(name, first_flag(&parsed, "description"))?;
                    if as_json {
                        println!(
                            "{}",
                            serde_json::to_string(&serde_json::json!({
                                "id": v.id,
                                "name": v.metadata.name,
                            }))
                            .unwrap()
                        );
                    } else {
                        println!("Created vault \"{}\" ({})", v.metadata.name, v.id);
                    }
                    Ok(0)
                }
                other => Err(format!("Unknown vault subcommand: {other}")),
            }
        }

        "item" => {
            let sub = parsed.positionals.get(1).map(String::as_str).unwrap_or("list");
            match sub {
                "list" => {
                    client.sync()?;
                    let vault_filter = first_flag(&parsed, "vault")
                        .or_else(|| first_flag(&parsed, "vaults"));
                    let vault_id = match vault_filter {
                        Some(v) => Some(client.find_vault(v)?.id.clone()),
                        None => None,
                    };
                    let tag_filters = parse_tags_flag(&parsed);
                    let cat_filters: Option<Vec<ItemCategory>> = parsed
                        .flags
                        .get("categories")
                        .or_else(|| parsed.flags.get("category"))
                        .map(|list| {
                            list.iter()
                                .flat_map(|s| s.split(','))
                                .map(|c| parse_category(Some(c)))
                                .collect()
                        });
                    let filtered: Vec<_> = client
                        .items
                        .iter()
                        .filter(|i| vault_id.as_ref().map(|vid| &i.vault_id == vid).unwrap_or(true))
                        .filter(|i| {
                            tag_filters.as_ref().map_or(true, |tf| {
                                tf.is_empty()
                                    || tf.iter().any(|wanted| {
                                        i.payload.tags.iter().any(|t| t.eq_ignore_ascii_case(wanted))
                                    })
                            })
                        })
                        .filter(|i| {
                            cat_filters
                                .as_ref()
                                .map_or(true, |cf| cf.is_empty() || cf.contains(&i.payload.category))
                        })
                        .collect();
                    if as_json {
                        let arr: Vec<_> = filtered
                            .iter()
                            .map(|i| {
                                let mut v = serde_json::to_value(&i.payload).unwrap();
                                v["vaultName"] = serde_json::Value::String(i.vault_name.clone());
                                v
                            })
                            .collect();
                        println!("{}", serde_json::to_string_pretty(&arr).unwrap());
                    } else {
                        for i in filtered {
                            let tags_disp = if i.payload.tags.is_empty() {
                                String::new()
                            } else {
                                format!("\t#{}", i.payload.tags.join(","))
                            };
                            println!(
                                "{}\t[{}]\t{}\t{}{}",
                                i.id,
                                i.vault_name,
                                i.payload.title,
                                i.payload.username.as_deref().unwrap_or(""),
                                tags_disp
                            );
                        }
                    }
                    Ok(0)
                }
                "get" => {
                    let item_arg = parsed
                        .positionals
                        .get(2)
                        .ok_or("item get requires <item>")?;
                    let vault_opt = first_flag(&parsed, "vault");
                    if has_flag(&parsed, "otp") {
                        let totp = client.get_totp(item_arg, vault_opt)?;
                        if as_json {
                            println!("{}", serde_json::to_string(&totp).unwrap());
                        } else {
                            println!("{}", totp.code);
                        }
                        return Ok(0);
                    }
                    client.sync()?;
                    let it = client.find_item(item_arg, vault_opt)?;
                    if let Some(fields_raw) = first_flag(&parsed, "fields") {
                        let req_fields: Vec<&str> = fields_raw
                            .split(',')
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .collect();
                        if req_fields.len() == 1 && !as_json {
                            let val = resolve_item_field(&it.payload, req_fields[0])
                                .ok_or_else(|| {
                                    format!(
                                        "Field \"{}\" not found on item \"{}\"",
                                        req_fields[0], it.payload.title
                                    )
                                })?;
                            println!("{val}");
                        } else {
                            let mut obj = serde_json::Map::new();
                            for f in req_fields {
                                let val = resolve_item_field(&it.payload, f);
                                obj.insert(
                                    f.to_string(),
                                    val.map(serde_json::Value::String)
                                        .unwrap_or(serde_json::Value::Null),
                                );
                            }
                            println!("{}", serde_json::to_string_pretty(&obj).unwrap());
                        }
                    } else {
                        let mut v = serde_json::to_value(&it.payload).unwrap();
                        v["vault"] = serde_json::Value::String(it.vault_name.clone());
                        println!("{}", serde_json::to_string_pretty(&v).unwrap());
                    }
                    Ok(0)
                }
                "create" => {
                    let vault = first_flag(&parsed, "vault").unwrap_or("Personal");
                    let title = first_flag(&parsed, "title")
                        .or_else(|| {
                            parsed
                                .positionals
                                .get(2)
                                .filter(|s| !s.contains('='))
                                .map(String::as_str)
                        })
                        .ok_or("item create requires --title <title>")?;
                    let overrides = collect_field_overrides(&parsed, 2)?;
                    let mut urls = parsed.flags.get("url").cloned().unwrap_or_default();
                    urls.extend(overrides.urls);
                    let tags = parse_tags_flag(&parsed).unwrap_or_default();
                    let created = client.create_item(
                        vault,
                        title,
                        parse_category(first_flag(&parsed, "category")),
                        urls,
                        first_flag(&parsed, "username")
                            .map(str::to_string)
                            .or(overrides.username),
                        first_flag(&parsed, "password")
                            .map(str::to_string)
                            .or(overrides.password),
                        has_flag(&parsed, "generate"),
                        first_flag(&parsed, "totp")
                            .map(str::to_string)
                            .or(overrides.totp),
                        first_flag(&parsed, "alias").map(str::to_string),
                        has_flag(&parsed, "auto-alias"),
                        first_flag(&parsed, "notes")
                            .map(str::to_string)
                            .or(overrides.notes),
                        tags,
                        overrides.custom_fields,
                    )?;
                    if as_json {
                        let mut v = serde_json::to_value(&created.payload).unwrap();
                        v["vault"] = serde_json::Value::String(created.vault_name);
                        println!("{}", serde_json::to_string_pretty(&v).unwrap());
                    } else {
                        println!(
                            "Created item \"{}\" in [{}] ({})",
                            created.payload.title, created.vault_name, created.id
                        );
                    }
                    Ok(0)
                }
                "edit" => {
                    let item_arg = parsed
                        .positionals
                        .get(2)
                        .ok_or("item edit requires <item>")?;
                    let overrides = collect_field_overrides(&parsed, 3)?;
                    let mut urls = parsed.flags.get("url").cloned().unwrap_or_default();
                    urls.extend(overrides.urls);
                    let updated = client.edit_item(
                        item_arg,
                        first_flag(&parsed, "vault"),
                        first_flag(&parsed, "title").map(str::to_string),
                        urls,
                        first_flag(&parsed, "username")
                            .map(str::to_string)
                            .or(overrides.username),
                        first_flag(&parsed, "password")
                            .map(str::to_string)
                            .or(overrides.password),
                        has_flag(&parsed, "generate"),
                        first_flag(&parsed, "totp")
                            .map(str::to_string)
                            .or(overrides.totp),
                        first_flag(&parsed, "notes")
                            .map(str::to_string)
                            .or(overrides.notes),
                        parse_tags_flag(&parsed),
                        overrides.custom_fields,
                    )?;
                    if as_json {
                        let mut v = serde_json::to_value(&updated.payload).unwrap();
                        v["vault"] = serde_json::Value::String(updated.vault_name);
                        println!("{}", serde_json::to_string_pretty(&v).unwrap());
                    } else {
                        println!(
                            "Updated item \"{}\" in [{}] ({})",
                            updated.payload.title, updated.vault_name, updated.id
                        );
                    }
                    Ok(0)
                }
                "delete" => {
                    let item_arg = parsed
                        .positionals
                        .get(2)
                        .ok_or("item delete requires <item>")?;
                    client.delete_item(item_arg, first_flag(&parsed, "vault"))?;
                    println!("Deleted item \"{item_arg}\"");
                    Ok(0)
                }
                "import" => run_import_command(&mut client, &parsed, 2, as_json),
                other => Err(format!("Unknown item subcommand: {other}")),
            }
        }

        "import" => run_import_command(&mut client, &parsed, 1, as_json),

        "read" => {
            let uri = parsed
                .positionals
                .get(1)
                .ok_or("read requires <np://vault/item/field | op://vault/item/field>")?;
            let val = client.resolve_secret_ref(uri)?;
            if let Some(out_file) = first_flag(&parsed, "out").or_else(|| first_flag(&parsed, "out-file")) {
                write_secret_file(out_file, val.as_bytes())
                    .map_err(|e| format!("Failed writing secret to {out_file}: {e}"))?;
                eprintln!("Wrote secret to {out_file}");
            } else if has_flag(&parsed, "no-newline") {
                print!("{val}");
            } else {
                println!("{val}");
            }
            Ok(0)
        }

        "otp" => {
            let item_arg = parsed
                .positionals
                .get(1)
                .ok_or("otp requires <item>")?;
            let totp = client.get_totp(item_arg, first_flag(&parsed, "vault"))?;
            if as_json {
                println!("{}", serde_json::to_string(&totp).unwrap());
            } else {
                println!("{}", totp.code);
            }
            Ok(0)
        }

        "inject" => {
            let raw_template = if let Some(in_file) = first_flag(&parsed, "in") {
                fs::read_to_string(in_file)
                    .map_err(|e| format!("Failed reading {in_file}: {e}"))?
            } else {
                let mut s = String::new();
                std::io::stdin()
                    .read_to_string(&mut s)
                    .map_err(|e| format!("Failed reading stdin: {e}"))?;
                s
            };
            let rendered = inject_template(&mut client, &raw_template)?;
            if let Some(out_file) = first_flag(&parsed, "out") {
                write_secret_file(out_file, rendered.as_bytes())
                    .map_err(|e| format!("Failed writing {out_file}: {e}"))?;
                println!("Injected secrets into {out_file}");
            } else {
                print!("{rendered}");
            }
            Ok(0)
        }

        "run" => {
            if parsed.rest_after_dash_dash.is_empty() {
                return Err("run requires `-- <command> [args...]`".into());
            }
            let mut child_env: HashMap<String, String> = env::vars().collect();
            if let Some(env_file) = first_flag(&parsed, "env-file") {
                let content = fs::read_to_string(env_file)
                    .map_err(|e| format!("Failed reading {env_file}: {e}"))?;
                for (k, v) in parse_dot_env(&content) {
                    if is_dangerous_env_var(&k) {
                        return Err(format!(
                            "Refusing to load dangerous environment variable \"{k}\" from --env-file"
                        ));
                    }
                    child_env.insert(k, v);
                }
            }
            let keys_to_resolve: Vec<String> = child_env
                .iter()
                .filter(|(_, v)| v.contains("np://") || v.contains("op://"))
                .map(|(k, _)| k.clone())
                .collect();
            for k in keys_to_resolve {
                let raw = child_env[&k].clone();
                let resolved = inject_template(&mut client, &raw)?;
                child_env.insert(k, resolved);
            }
            scrub_nonepwd_env(&mut child_env);

            let mut cmd_proc = Command::new(&parsed.rest_after_dash_dash[0]);
            cmd_proc.args(&parsed.rest_after_dash_dash[1..]);
            cmd_proc.env_clear();
            cmd_proc.envs(&child_env);
            let status = cmd_proc
                .status()
                .map_err(|e| format!("Failed spawning {}: {e}", parsed.rest_after_dash_dash[0]))?;

            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if let Some(sig) = status.signal() {
                    return Ok(128 + sig);
                }
            }
            Ok(status.code().unwrap_or(1))
        }

        "alias" => {
            let sub = parsed.positionals.get(1).map(String::as_str).unwrap_or("list");
            match sub {
                "list" => {
                    client.sync()?;
                    if as_json {
                        println!("{}", serde_json::to_string_pretty(&client.aliases).unwrap());
                    } else {
                        for a in &client.aliases {
                            println!(
                                "{}\t{}\t({} msgs)",
                                if a.enabled { "ON " } else { "OFF" },
                                a.address,
                                a.received_count
                            );
                        }
                    }
                    Ok(0)
                }
                "create" => {
                    let domain = first_flag(&parsed, "for")
                        .or_else(|| parsed.positionals.get(2).map(String::as_str))
                        .ok_or("alias create requires --for <domain>")?;
                    let alias = client.create_alias(domain, first_flag(&parsed, "address"), None, None)?;
                    if as_json {
                        println!("{}", serde_json::to_string_pretty(&alias).unwrap());
                    } else {
                        println!("{}", alias.address);
                    }
                    Ok(0)
                }
                "toggle" => {
                    let target = parsed
                        .positionals
                        .get(2)
                        .ok_or("alias toggle requires <id-or-address>")?;
                    let alias = client.toggle_alias(target)?;
                    if as_json {
                        println!("{}", serde_json::to_string_pretty(&alias).unwrap());
                    } else {
                        println!(
                            "{} -> {}",
                            alias.address,
                            if alias.enabled { "enabled" } else { "disabled" }
                        );
                    }
                    Ok(0)
                }
                other => Err(format!("Unknown alias subcommand: {other}")),
            }
        }

        "mail" => {
            let sub = parsed.positionals.get(1).map(String::as_str).unwrap_or("list");
            match sub {
                "list" => {
                    client.sync()?;
                    if as_json {
                        println!("{}", serde_json::to_string_pretty(&client.emails).unwrap());
                    } else {
                        for e in &client.emails {
                            println!(
                                "{}\tOTP={}\t{}\t{}",
                                e.payload.received_at,
                                e.payload.otp_code.as_deref().unwrap_or("-"),
                                e.payload.from,
                                e.payload.subject
                            );
                        }
                    }
                    Ok(0)
                }
                "otp" => {
                    let wait_secs: f64 = first_flag(&parsed, "wait")
                        .map(|w| w.trim_end_matches(['s', 'S']).parse().unwrap_or(0.0))
                        .unwrap_or(0.0);
                    let email = client.wait_for_email_otp(
                        first_flag(&parsed, "domain"),
                        first_flag(&parsed, "alias"),
                        wait_secs,
                    )?;
                    if as_json {
                        println!(
                            "{}",
                            serde_json::to_string(&serde_json::json!({
                                "otpCode": email.payload.otp_code,
                                "from": email.payload.from,
                                "to": email.payload.to,
                                "subject": email.payload.subject,
                                "magicLink": email.payload.magic_link,
                            }))
                            .unwrap()
                        );
                    } else {
                        println!("{}", email.payload.otp_code.as_deref().unwrap_or(""));
                    }
                    Ok(0)
                }
                other => Err(format!("Unknown mail subcommand: {other}")),
            }
        }

        "service-account" => {
            let sub = parsed.positionals.get(1).map(String::as_str).unwrap_or("list");
            match sub {
                "list" => {
                    let list = client.list_service_accounts()?;
                    if as_json {
                        println!("{}", serde_json::to_string_pretty(&list).unwrap());
                    } else {
                        for sa in list {
                            println!("{}\t{}\tvaults={}", sa.id, sa.name, sa.vault_ids.join(","));
                        }
                    }
                    Ok(0)
                }
                "create" => {
                    let name = parsed
                        .positionals
                        .get(2)
                        .map(String::as_str)
                        .or_else(|| first_flag(&parsed, "name"))
                        .ok_or("service-account create requires <name>")?;
                    let vaults = parsed
                        .flags
                        .get("vault")
                        .cloned()
                        .ok_or("service-account create requires --vault <vaultNameOrId>")?;
                    let res = client.create_service_account(name, &vaults)?;
                    if as_json {
                        println!("{}", serde_json::to_string_pretty(&res).unwrap());
                    } else {
                        println!(
                            "Created Service Account \"{}\"\nNONEPWD_TOKEN={}",
                            res["serviceAccount"]["name"].as_str().unwrap_or(name),
                            res["token"].as_str().unwrap_or("")
                        );
                    }
                    Ok(0)
                }
                "revoke" => {
                    let id = parsed
                        .positionals
                        .get(2)
                        .ok_or("service-account revoke requires <id>")?;
                    client.revoke_service_account(id)?;
                    println!("Revoked service account {id}");
                    Ok(0)
                }
                other => Err(format!("Unknown service-account subcommand: {other}")),
            }
        }

        "server" => {
            #[cfg(not(target_env = "musl"))]
            {
                let mut opts = nonepwd_server::ServerOptions::default();
                let env_host = env::var("NONEPWD_HOST").ok().filter(|s| !s.is_empty());
                if let Some(h) = first_flag(&parsed, "host").or(env_host.as_deref()) {
                    opts.host = h.to_string();
                }
                let env_port = env::var("NONEPWD_PORT")
                    .ok()
                    .or_else(|| env::var("PORT").ok())
                    .filter(|s| !s.is_empty());
                if let Some(p_raw) = first_flag(&parsed, "port").or(env_port.as_deref()) {
                    opts.port = p_raw
                        .parse::<u16>()
                        .map_err(|_| format!("Invalid --port value: \"{p_raw}\""))?;
                }
                if let Some(dd) = first_flag(&parsed, "data-dir") {
                    opts.data_dir = Some(std::path::PathBuf::from(dd));
                }
                if let Some(wd) = first_flag(&parsed, "web-dist") {
                    opts.web_dist = Some(std::path::PathBuf::from(wd));
                }
                if let Some(bd) = first_flag(&parsed, "bin-dist") {
                    opts.bin_dist = Some(std::path::PathBuf::from(bd));
                }
                nonepwd_server::run_blocking(opts)?;
                Ok(0)
            }
            #[cfg(target_env = "musl")]
            {
                Err("`np server` is not bundled in cross-compiled musl client binaries; build natively for host".into())
            }
        }

        "agent" => {
            #[cfg(feature = "agent")]
            {
                return agent_cmd::run_agent(&mut client, &parsed, &config_dir);
            }
            #[cfg(not(feature = "agent"))]
            {
                Err("this np binary was built without the `agent` feature".into())
            }
        }

        "serve" => {
            if !has_flag(&parsed, "connect") {
                return Err("Specify `np serve --connect` to start local Connect HTTP gateway".into());
            }
            client.sync()?;
            let host = first_flag(&parsed, "host").unwrap_or("127.0.0.1");
            let port: u16 = first_flag(&parsed, "port")
                .and_then(|s| s.parse().ok())
                .unwrap_or(8788);
            let env_tok = env::var("NONEPWD_CONNECT_TOKEN").ok().filter(|s| !s.is_empty());
            let token = match first_flag(&parsed, "token").map(str::to_string).or(env_tok) {
                Some(t) => t,
                None => to_base64_url(&random_bytes(24)?),
            };
            serve_connect(client, host, port, token)?;
            Ok(0)
        }

        other => Err(format!("Unknown command \"{other}\". Run `np --help` for usage.")),
    }
}

fn main() {
    match run() {
        Ok(code) => exit(code),
        Err(err) => {
            eprintln!("Error: {err}");
            exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_dangerous_env_vars_and_allows_normal_vars() {
        for name in [
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "LD_AUDIT",
            "ld_debug",
            "DYLD_INSERT_LIBRARIES",
            "DYLD_LIBRARY_PATH",
            "PATH",
            "NODE_OPTIONS",
            "BASH_ENV",
            "ENV",
            "IFS",
            "PYTHONSTARTUP",
            "PYTHONPATH",
            "RUBYOPT",
            "PERL5OPT",
        ] {
            assert!(is_dangerous_env_var(name), "expected {name} to be blocked");
        }
        for safe in ["API_KEY", "DATABASE_URL", "OPENAI_API_KEY", "MY_LD_VAR"] {
            assert!(!is_dangerous_env_var(safe), "expected {safe} to be allowed");
        }
    }

    #[test]
    fn scrubs_nonepwd_secret_env_vars() {
        let mut env_map = HashMap::from([
            ("NONEPWD_TOKEN".into(), "sa-tok".into()),
            ("NONEPWD_MASTER_PASSWORD".into(), "pw".into()),
            ("NONEPWD_SECRET_KEY".into(), "NP3-xxx".into()),
            ("NONEPWD_AGENT_TOKEN".into(), "psk".into()),
            ("NONEPWD_CONNECT_TOKEN".into(), "conn".into()),
            ("APP_SECRET".into(), "keep-me".into()),
        ]);
        scrub_nonepwd_env(&mut env_map);
        assert!(!env_map.contains_key("NONEPWD_TOKEN"));
        assert!(!env_map.contains_key("NONEPWD_MASTER_PASSWORD"));
        assert!(!env_map.contains_key("NONEPWD_SECRET_KEY"));
        assert!(!env_map.contains_key("NONEPWD_AGENT_TOKEN"));
        assert!(!env_map.contains_key("NONEPWD_CONNECT_TOKEN"));
        assert_eq!(env_map.get("APP_SECRET").map(String::as_str), Some("keep-me"));
    }

    #[cfg(unix)]
    #[test]
    fn write_secret_file_enforces_0600_even_on_existing_0644_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = env::temp_dir().join(format!("nonepwd-cli-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("secret.txt");
        fs::write(&target, "old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();

        write_secret_file(target.to_str().unwrap(), b"top-secret").unwrap();
        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        assert_eq!(fs::read_to_string(&target).unwrap(), "top-secret");

        let _ = fs::remove_dir_all(&dir);
    }
}
