---
name: nonepwd
description: Use nonepwd (np CLI) — an op-compatible zero-knowledge secret manager, API/SSH key vault, 2FA TOTP generator, real-time Email OTP tool, and Agent Access (protocol v0) credential broker — to inject secrets without plaintext .env files, approve one-credential remote requests, and await email verification codes.
---

# nonepwd (`np`) — Agent & CLI Skill Guide

**nonepwd** is a self-hosted, zero-knowledge secret manager written in pure Rust with full **1Password CLI (`op`) ergonomics** (`op://` and `np://` secret URIs, `run`, `inject`, `read`, `item`, `vault`) plus real-time **IMAP / Cloudflare Email Routing OTP extraction**.

- Official Website: `https://nonepwd.charlzyx.workers.dev`
- Machine-readable docs (this exact file): `/llms.txt` and `/SKILL.md`

---

## 1. Quick Install & Authentication

```bash
# macOS / Linux native binary (zero Node/OpenSSL runtime dependencies)
curl -fsSL https://nonepwd.charlzyx.workers.dev/install.sh | bash
# or npm package:
npm install -g @nonepwd/cli
```

### Recommended Auth for AI Agents / CI (`Service Account`, least-privilege)
Create a Vault-scoped Service Account (`np service-account create ci-agent --vault DevOps`) and pass only `NONEPWD_TOKEN`:

```bash
export NONEPWD_TOKEN="npst_v1_..."
np whoami --format json
```

### Interactive Owner Auth
```bash
np signin --server https://vault.yourdomain.com --secret-key "NP3-..." --password "$NONEPWD_MASTER_PASSWORD"
```

---

## 2. 1Password (`op`) Compatibility Cheatsheet

`np` understands both **`np://`** and **`op://`** secret references (3 segments or 4 segments with a section):

- `np://DevOps/OpenAI/api_key` or `op://DevOps/OpenAI/credential`
- `op://DevOps/OpenAI/API/api_key`
- `np://DevOps/ProdSSH/private_key` or `op://DevOps/ProdSSH/public_key`
- `np://Personal/GitHub/totp` (live 6-digit RFC 6238 TOTP code)
- `np://Personal/GitHub/email_otp?wait=30` (blocks up to 30s for incoming verification email)

| 1Password `op` pattern | `np` equivalent (supported directly) |
|---|---|
| `op vault list --format json` | `np vault list --format json` (or `--json`) |
| `op vault get DevOps --format json` | `np vault get DevOps --format json` |
| `op item list --vault DevOps --tags prod` | `np item list --vault DevOps --tags prod` |
| `op item get "OpenAI" --fields credential` | `np item get "OpenAI" --fields credential` |
| `op item get "GitHub" --otp` | `np item get "GitHub" --otp` or `np otp "GitHub"` |
| `op item create ... --tags a,b key=val` | `np item create --vault DevOps --title ... --tags a,b key=val` |
| `op item edit "OpenAI" --tags a,b token=...` | `np item edit "OpenAI" --tags a,b token=...` |
| `op read -n op://DevOps/OpenAI/credential` | `np read -n op://DevOps/OpenAI/credential` |
| `op read -o ~/.ssh/id_ed25519 op://DevOps/SSH/private_key` | `np read -o ~/.ssh/id_ed25519 op://DevOps/SSH/private_key` |
| `op run --env-file=.env.tpl -- cmd` | `np run --env-file .env.tpl -- cmd` |
| `op inject -i tpl.env -o .env` | `np inject -i tpl.env -o .env` |

---

## 3. Common Agent Workflows

### A. Store & Read API Keys (`api_credential`)
```bash
np item create --vault DevOps --title OpenAI \
  --category api_credential \
  --tags ai,prod \
  --url https://api.openai.com/v1 \
  credential=sk-proj-xxxx \
  org_id[text]=org-abc

np read -n op://DevOps/OpenAI/credential
np read -n np://DevOps/OpenAI/org_id
```

### B. Store & Export SSH Keys (`ssh_key`)
```bash
np item create --vault DevOps --title ProdSSH \
  --category ssh_key \
  --tags infra,ssh \
  private_key="$(cat ~/.ssh/id_ed25519)" \
  public_key[text]="$(cat ~/.ssh/id_ed25519.pub)"

# Materialize private key safely with chmod 0600
np read -o /tmp/deploy_key np://DevOps/ProdSSH/private_key
```

### C. Inject Secrets into Any Process (No Plaintext `.env` on Disk)
`.env.tpl`:
```env
OPENAI_API_KEY=op://DevOps/OpenAI/credential
DATABASE_URL=np://DevOps/Postgres/password
```
Run:
```bash
np run --env-file .env.tpl -- python agent.py
```

### D. Wait for Real-Time Email Verification Code (Browser / Playwright Automation)
```bash
OTP=$(np mail otp --domain github.com --wait 30s)
echo "Verification code: $OTP"
```

---

## 4. `np --help` Command Reference

```text
nonepwd Native CLI (np) - 1Password (`op`)-compatible zero-knowledge secrets, API/SSH keys, TOTP & Email OTP

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
  np agent run --token <psk> (--domain <host> | --id <item> | --search <q>) (--env-all | --env KEY=field) -- <cmd>
```

---

## 5. Agent Access (protocol v0)

Remote agents can ask for **one** vault item at a time. The user approves each request. The tunnel is Noise NNpsk2 (XChaCha20-Poly1305). nonepwd decrypts only on the user side. The relay at `/agent/relay` authenticates device identities and forwards ciphertext.

The relay is part of both self-hosted flavours (the Rust/`npx @nonepwd/server` process and the Cloudflare Worker Durable Object `AgentRelayHub`). Clients derive the relay from the signed-in server URL (`https://vault.example.com` → `wss://vault.example.com/agent/relay`). nonepwd does not fall back to `wss://ap.lesspassword.dev`.

```bash
# User side (unlocked session). Prints a 129-character PSK token: <64-hex-psk>_<64-hex-fingerprint>
np agent listen

# Remote side
np agent connect --token "$TOKEN" --domain github.com --json
np agent run --token "$TOKEN" --domain github.com --env-all -- deploy.sh
np agent run --token "$TOKEN" --id <item-id> --env DB_PASSWORD=password -- psql
```

`--env-all` injects `NP_USERNAME`, `NP_PASSWORD`, `NP_TOTP`, `NP_URI`, `NP_NOTES`, `NP_DOMAIN`, and `NP_CREDENTIAL_ID` into the child process only. `--env KEY=field` maps one of `username`, `password`, `totp`, `uri`, `notes`, `domain`, `credential_id`. TOTP is the current code, never the seed.

Official `aac` (agent-access protocol v0 / `ap-client` 0.12) can use the same relay:

```bash
aac --relay-url ws://127.0.0.1:8787/agent/relay --token "$TOKEN" --domain github.com --output json
```

Domain matching uses the vault's existing host and eTLD+1 rules. Two items on the same domain is an ambiguous denial; ask again with `--id`. Each PSK token pairs once. Device identity keys are stored under the nonepwd config directory (`agent-user-identity.cose` and `agent-remote-identity.cose`, mode `0600`) and are not vault secrets.
