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
use nonepwd_core::secret_ref::{find_secret_refs, parse_dot_env, replace_secret_refs};
use nonepwd_core::types::ItemCategory;

use crate::client::NonePwdClient;
use crate::config::load_config;
use crate::connect_server::serve_connect;

struct ParsedArgs {
    positionals: Vec<String>,
    flags: HashMap<String, Vec<String>>,
    booleans: HashSet<String>,
    rest_after_dash_dash: Vec<String>,
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
            } else if i + 1 < main_args.len() && !main_args[i + 1].starts_with('-') {
                flags
                    .entry(body.to_string())
                    .or_default()
                    .push(main_args[i + 1].clone());
                i += 1;
            } else {
                booleans.insert(body.to_string());
            }
        } else if (arg == "-i" || arg == "-o") && i + 1 < main_args.len() {
            let key = if arg == "-i" { "in" } else { "out" };
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

fn first_flag<'a>(parsed: &'a ParsedArgs, name: &str) -> Option<&'a str> {
    parsed.flags.get(name).and_then(|v| v.first()).map(String::as_str)
}

fn has_flag(parsed: &ParsedArgs, name: &str) -> bool {
    parsed.booleans.contains(name) || parsed.flags.contains_key(name)
}

fn parse_category(raw: Option<&str>) -> ItemCategory {
    match raw.unwrap_or("login") {
        "api_credential" => ItemCategory::ApiCredential,
        "secure_note" => ItemCategory::SecureNote,
        "ssh_key" => ItemCategory::SshKey,
        "card" => ItemCategory::Card,
        _ => ItemCategory::Login,
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

const HELP_TEXT: &str = "nonepwd Native CLI (np) - Cross-platform (macOS/Linux) zero-trust secrets, TOTP & Email OTP (0 > 1)

Usage:
  np setup --server <url> --email <email> --password <pass> [--alias-domain <dom>] [--json]
  np signin --server <url> --secret-key <NP3-...> --password <pass>
  np lock | np signout | np whoami | np version
  np vault list [--json] | np vault create <name> [--description <d>]
  np item list [--vault <v>] [--json]
  np item get <item> [--vault <v>] [--json]
  np item create --vault <v> --title <t> [--category <c>] [--url <u>] [--username <u>]
                 [--password <p> | --generate] [--totp <secret>] [--auto-alias]
                 [--field key=value ...] [--json]
  np item delete <item> [--vault <v>]
  np read <np://vault/item/field>
  np otp <item> [--vault <v>] [--json]
  np run [--env-file <path>] -- <command> [args...]
  np inject [-i <inputFile>] [-o <outputFile>]
  np alias list [--json] | np alias create --for <domain> [--json] | np alias toggle <alias>
  np mail list [--json] | np mail otp [--domain <d>] [--alias <a>] [--wait <sec>] [--json]
  np service-account list | create <name> --vault <v1> [--vault <v2>] [--json] | revoke <id>
  np serve --connect [--host 127.0.0.1] [--port 8788] [--token <tok>]";

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

    let as_json = has_flag(&parsed, "json");
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
                    let vault_filter = first_flag(&parsed, "vault");
                    let vault_id = match vault_filter {
                        Some(v) => Some(client.find_vault(v)?.id.clone()),
                        None => None,
                    };
                    let filtered: Vec<_> = client
                        .items
                        .iter()
                        .filter(|i| vault_id.as_ref().map(|vid| &i.vault_id == vid).unwrap_or(true))
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
                            println!(
                                "{}\t[{}]\t{}\t{}",
                                i.id,
                                i.vault_name,
                                i.payload.title,
                                i.payload.username.as_deref().unwrap_or("")
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
                    client.sync()?;
                    let it = client.find_item(item_arg, first_flag(&parsed, "vault"))?;
                    let mut v = serde_json::to_value(&it.payload).unwrap();
                    v["vault"] = serde_json::Value::String(it.vault_name.clone());
                    println!("{}", serde_json::to_string_pretty(&v).unwrap());
                    Ok(0)
                }
                "create" => {
                    let vault = first_flag(&parsed, "vault").unwrap_or("Personal");
                    let title = first_flag(&parsed, "title")
                        .or_else(|| parsed.positionals.get(2).map(String::as_str))
                        .ok_or("item create requires --title <title>")?;
                    let mut custom_fields = Vec::new();
                    if let Some(fields) = parsed.flags.get("field") {
                        for expr in fields {
                            let (k, v) = expr
                                .split_once('=')
                                .ok_or_else(|| format!("Invalid --field \"{expr}\", expected label=value"))?;
                            custom_fields.push((k.to_string(), v.to_string()));
                        }
                    }
                    let created = client.create_item(
                        vault,
                        title,
                        parse_category(first_flag(&parsed, "category")),
                        parsed.flags.get("url").cloned().unwrap_or_default(),
                        first_flag(&parsed, "username").map(str::to_string),
                        first_flag(&parsed, "password").map(str::to_string),
                        has_flag(&parsed, "generate"),
                        first_flag(&parsed, "totp").map(str::to_string),
                        first_flag(&parsed, "alias").map(str::to_string),
                        has_flag(&parsed, "auto-alias"),
                        first_flag(&parsed, "notes").map(str::to_string),
                        custom_fields,
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
                "delete" => {
                    let item_arg = parsed
                        .positionals
                        .get(2)
                        .ok_or("item delete requires <item>")?;
                    client.delete_item(item_arg, first_flag(&parsed, "vault"))?;
                    println!("Deleted item \"{item_arg}\"");
                    Ok(0)
                }
                other => Err(format!("Unknown item subcommand: {other}")),
            }
        }

        "read" => {
            let uri = parsed
                .positionals
                .get(1)
                .ok_or("read requires <np://vault/item/field>")?;
            let val = client.resolve_secret_ref(uri)?;
            println!("{val}");
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
                fs::write(out_file, rendered)
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
                    child_env.insert(k, v);
                }
            }
            let keys_to_resolve: Vec<String> = child_env
                .iter()
                .filter(|(_, v)| v.contains("np://"))
                .map(|(k, _)| k.clone())
                .collect();
            for k in keys_to_resolve {
                let raw = child_env[&k].clone();
                let resolved = inject_template(&mut client, &raw)?;
                child_env.insert(k, resolved);
            }

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
