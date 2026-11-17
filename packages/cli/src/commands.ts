import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  detectImportFormat,
  injectSecretRefs,
  parseDotEnv,
  randomBytes,
  toBase64Url,
  type ImportFormat,
  type ItemCategory,
} from '@nonepwd/core';
import { NonePwdCliClient } from './client.js';
import { startConnectServer } from './connect-server.js';
import { loadCliConfig } from './config.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: Record<string, string | undefined>;
  configDir?: string;
}

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string[]>;
  booleans: Set<string>;
  restAfterDashDash: string[];
}

const BOOLEAN_FLAGS = new Set([
  'json',
  'no-dedupe',
  'generate',
  'auto-alias',
  'help',
  'version',
  'connect',
]);

function parseCliArgs(argv: string[]): ParsedArgs {
  const dashIdx = argv.indexOf('--');
  const mainArgs = dashIdx >= 0 ? argv.slice(0, dashIdx) : argv;
  const restAfterDashDash = dashIdx >= 0 ? argv.slice(dashIdx + 1) : [];

  const positionals: string[] = [];
  const flags: Record<string, string[]> = {};
  const booleans = new Set<string>();

  for (let i = 0; i < mainArgs.length; i++) {
    const arg = mainArgs[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        (flags[key] ??= []).push(val);
      } else {
        const key = arg.slice(2);
        const next = mainArgs[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('-')) {
          (flags[key] ??= []).push(next);
          i++;
        } else {
          booleans.add(key);
        }
      }
    } else if (arg === '-i' || arg === '-o') {
      const key = arg === '-i' ? 'in' : 'out';
      const next = mainArgs[i + 1];
      if (next !== undefined) {
        (flags[key] ??= []).push(next);
        i++;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags, booleans, restAfterDashDash };
}

function firstFlag(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.flags[name]?.[0];
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.booleans.has(name) || (parsed.flags[name]?.length ?? 0) > 0;
}

function resolveRequestedImportFormat(
  rawFlag: string | undefined,
  content: string
): ImportFormat {
  const trimmed = rawFlag?.trim().toLowerCase();
  if (!trimmed || trimmed === 'auto') {
    return detectImportFormat(content);
  }
  if (trimmed === 'csv') return 'csv';
  if (trimmed === 'totp' || trimmed === '2fa' || trimmed === 'authenticator') return 'totp';
  throw new Error(`Unsupported --format "${rawFlag}" (expected csv or totp)`);
}

async function runImportCommand(
  client: NonePwdCliClient,
  parsed: ParsedArgs,
  filePositional: string | undefined,
  asJson: boolean,
  io: CliIo
): Promise<number> {
  const filePath = filePositional ?? firstFlag(parsed, 'file') ?? firstFlag(parsed, 'in');
  if (!filePath) throw new Error('import requires <file>');
  const rawText = fs.readFileSync(filePath, 'utf8');
  const format = resolveRequestedImportFormat(firstFlag(parsed, 'format'), rawText);

  if (format === 'csv') {
    const summary = await client.importCsv({
      csvText: rawText,
      vaultNameOrId: firstFlag(parsed, 'vault'),
      skipDuplicates: !hasFlag(parsed, 'no-dedupe'),
    });
    io.stdout(
      asJson
        ? JSON.stringify(summary, null, 2)
        : `Imported ${summary.imported} items into [${summary.vaultName}] (parsed: ${summary.total}, skipped duplicates: ${summary.skipped})`
    );
    return 0;
  }

  const summary = await client.importTotp({
    exportText: rawText,
    vaultNameOrId: firstFlag(parsed, 'vault'),
  });
  io.stdout(
    asJson
      ? JSON.stringify(summary, null, 2)
      : `Imported ${summary.imported} TOTP entries into [${summary.vaultName}] (attached: ${summary.attached}, created: ${summary.created}, skipped: ${summary.skipped})`
  );
  return 0;
}

const HELP_TEXT = `nonepwd CLI (np) - Self-hosted zero-trust secrets, TOTP & Email OTP (0 > 1)

Usage:
  np setup --server <url> --email <email> --password <pass> [--alias-domain <dom>] [--json]
  np signin --server <url> --secret-key <NP3-...> --password <pass>
  np lock | np signout | np whoami
  np vault list [--json] | np vault create <name> [--description <d>]
  np item list [--vault <v>] [--json]
  np item get <item> [--vault <v>] [--json]
  np item create --vault <v> --title <t> [--category <c>] [--url <u>] [--username <u>]
                 [--password <p> | --generate] [--totp <secret>] [--auto-alias]
                 [--field key=value ...] [--json]
  np import <file> [--format csv|totp] [--vault Personal] [--no-dedupe] [--json]
  np item delete <item> [--vault <v>]
  np read <np://vault/item/field>
  np otp <item> [--vault <v>] [--json]
  np run [--env-file <path>] -- <command> [args...]
  np inject [-i <inputFile>] [-o <outputFile>]
  np alias list [--json] | np alias create --for <domain> [--json] | np alias toggle <alias>
  np mail list [--json] | np mail otp [--domain <d>] [--alias <a>] [--wait <sec>] [--json]
  np service-account list | create <name> --vault <v1> [--vault <v2>] [--json] | revoke <id>
  np serve --connect [--host 127.0.0.1] [--port 8788] [--token <tok>]
`;

export async function runCli(argv: string[], ioOverride?: Partial<CliIo>): Promise<number> {
  const io: CliIo = {
    stdout: ioOverride?.stdout ?? ((s) => process.stdout.write(`${s}\n`)),
    stderr: ioOverride?.stderr ?? ((s) => process.stderr.write(`${s}\n`)),
    env: ioOverride?.env ?? process.env,
    configDir: ioOverride?.configDir,
  };

  const parsed = parseCliArgs(argv);
  const [cmd, sub, ...rest] = parsed.positionals;

  if (!cmd || cmd === 'help' || hasFlag(parsed, 'help')) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  const client = new NonePwdCliClient({
    configDir: io.configDir,
    serverUrl: firstFlag(parsed, 'server'),
    env: io.env,
  });

  const asJson = hasFlag(parsed, 'json');

  try {
    switch (cmd) {
      case 'setup': {
        const serverUrl = firstFlag(parsed, 'server');
        const email = firstFlag(parsed, 'email');
        const password = firstFlag(parsed, 'password') ?? io.env?.NONEPWD_MASTER_PASSWORD;
        const aliasDomain = firstFlag(parsed, 'alias-domain') ?? '';
        const iterRaw = firstFlag(parsed, 'kdf-iterations');
        if (!serverUrl || !email || !password) {
          throw new Error('setup requires --server, --email, and --password');
        }
        const res = await client.setup({
          serverUrl,
          email,
          password,
          aliasDomain,
          kdfIterations: iterRaw ? Number.parseInt(iterRaw, 10) : undefined,
        });
        if (asJson) {
          io.stdout(JSON.stringify(res, null, 2));
        } else {
          io.stdout(`Account initialized for ${res.email}`);
          io.stdout(`Secret Key (SAVE THIS EMERGENCY KEY!): ${res.secretKey}`);
          io.stdout(`Vaults created: ${res.vaults.join(', ')}`);
        }
        return 0;
      }

      case 'signin': {
        const password = firstFlag(parsed, 'password') ?? io.env?.NONEPWD_MASTER_PASSWORD;
        if (!password) throw new Error('signin requires --password or NONEPWD_MASTER_PASSWORD');
        const res = await client.signin({
          serverUrl: firstFlag(parsed, 'server'),
          email: firstFlag(parsed, 'email'),
          secretKey: firstFlag(parsed, 'secret-key'),
          password,
        });
        io.stdout(asJson ? JSON.stringify(res) : `Signed in to ${res.serverUrl} as ${res.email}`);
        return 0;
      }

      case 'lock':
      case 'signout': {
        await client.lock();
        io.stdout('Locked and cleared local session.');
        return 0;
      }

      case 'whoami': {
        const cfg = loadCliConfig(io.configDir);
        io.stdout(
          asJson
            ? JSON.stringify({
                serverUrl: cfg.serverUrl ?? null,
                email: cfg.email ?? null,
                unlocked: Boolean(cfg.session?.token),
                serviceAccount: Boolean(io.env?.NONEPWD_TOKEN),
              })
            : `Server: ${cfg.serverUrl ?? '(unset)'} | Email: ${cfg.email ?? '(unset)'} | Unlocked: ${Boolean(cfg.session?.token)}`
        );
        return 0;
      }

      case 'vault': {
        if (sub === 'list' || !sub) {
          await client.sync();
          const list = client.vaults.map((v) => ({
            id: v.id,
            name: v.metadata.name,
            description: v.metadata.description ?? '',
          }));
          io.stdout(
            asJson
              ? JSON.stringify(list, null, 2)
              : list.map((v) => `${v.id}\t${v.name}`).join('\n')
          );
          return 0;
        }
        if (sub === 'create') {
          const name = rest[0] ?? firstFlag(parsed, 'name');
          if (!name) throw new Error('vault create requires <name>');
          const created = await client.createVault(name, firstFlag(parsed, 'description'));
          io.stdout(
            asJson
              ? JSON.stringify({ id: created.id, name: created.metadata.name })
              : `Created vault "${created.metadata.name}" (${created.id})`
          );
          return 0;
        }
        throw new Error(`Unknown vault subcommand: ${sub}`);
      }

      case 'item': {
        if (sub === 'list' || !sub) {
          await client.sync();
          const vaultFilter = firstFlag(parsed, 'vault');
          let list = client.items;
          if (vaultFilter) {
            const v = client.findVault(vaultFilter);
            list = list.filter((i) => i.vaultId === v.id);
          }
          io.stdout(
            asJson
              ? JSON.stringify(list.map((i) => ({ ...i.payload, vaultName: i.vaultName })), null, 2)
              : list.map((i) => `${i.id}\t[${i.vaultName}]\t${i.payload.title}\t${i.payload.username ?? ''}`).join('\n')
          );
          return 0;
        }
        if (sub === 'get') {
          const itemArg = rest[0];
          if (!itemArg) throw new Error('item get requires <item>');
          await client.sync();
          const item = client.findItem(itemArg, firstFlag(parsed, 'vault'));
          io.stdout(JSON.stringify({ vault: item.vaultName, ...item.payload }, null, 2));
          return 0;
        }
        if (sub === 'create') {
          const vault = firstFlag(parsed, 'vault') ?? 'Personal';
          const title = firstFlag(parsed, 'title') ?? rest[0];
          if (!title) throw new Error('item create requires --title <title>');
          const customFields = (parsed.flags.field ?? []).map((expr) => {
            const eq = expr.indexOf('=');
            if (eq <= 0) throw new Error(`Invalid --field "${expr}", expected label=value`);
            return { label: expr.slice(0, eq), value: expr.slice(eq + 1) };
          });
          const created = await client.createItem({
            vaultNameOrId: vault,
            title,
            category: (firstFlag(parsed, 'category') as ItemCategory | undefined) ?? 'login',
            urls: parsed.flags.url ?? [],
            username: firstFlag(parsed, 'username'),
            password: firstFlag(parsed, 'password'),
            generatePass: hasFlag(parsed, 'generate'),
            totp: firstFlag(parsed, 'totp'),
            emailAlias: firstFlag(parsed, 'alias'),
            autoAlias: hasFlag(parsed, 'auto-alias'),
            notes: firstFlag(parsed, 'notes'),
            customFields,
          });
          io.stdout(
            asJson
              ? JSON.stringify({ vault: created.vaultName, ...created.payload }, null, 2)
              : `Created item "${created.payload.title}" in [${created.vaultName}] (${created.id})`
          );
          return 0;
        }
        if (sub === 'delete') {
          const itemArg = rest[0];
          if (!itemArg) throw new Error('item delete requires <item>');
          await client.deleteItem(itemArg, firstFlag(parsed, 'vault'));
          io.stdout(`Deleted item "${itemArg}"`);
          return 0;
        }
        if (sub === 'import') {
          return runImportCommand(client, parsed, rest[0], asJson, io);
        }
        throw new Error(`Unknown item subcommand: ${sub}`);
      }

      case 'import': {
        return runImportCommand(client, parsed, sub, asJson, io);
      }

      case 'read': {
        const uri = sub;
        if (!uri) throw new Error('read requires <np://vault/item/field>');
        const value = await client.resolveSecretRef(uri);
        io.stdout(value);
        return 0;
      }

      case 'otp': {
        const itemArg = sub;
        if (!itemArg) throw new Error('otp requires <item>');
        const totp = await client.getTotp(itemArg, firstFlag(parsed, 'vault'));
        io.stdout(asJson ? JSON.stringify(totp) : totp.code);
        return 0;
      }

      case 'inject': {
        const inFile = firstFlag(parsed, 'in');
        const outFile = firstFlag(parsed, 'out');
        const rawTemplate = inFile
          ? fs.readFileSync(inFile, 'utf8')
          : fs.readFileSync(0, 'utf8');
        const rendered = await injectSecretRefs(rawTemplate, (ref) => client.resolveSecretRef(ref));
        if (outFile) {
          fs.writeFileSync(outFile, rendered, 'utf8');
          io.stdout(`Injected secrets into ${outFile}`);
        } else {
          io.stdout(rendered);
        }
        return 0;
      }

      case 'run': {
        const command = parsed.restAfterDashDash;
        if (command.length === 0) {
          throw new Error('run requires `-- <command> [args...]`');
        }
        const envFile = firstFlag(parsed, 'env-file');
        const childEnv: Record<string, string | undefined> = { ...process.env, ...io.env };
        if (envFile) {
          const parsedEnv = parseDotEnv(fs.readFileSync(envFile, 'utf8'));
          for (const [k, v] of Object.entries(parsedEnv)) {
            childEnv[k] = v;
          }
        }
        for (const [k, v] of Object.entries(childEnv)) {
          if (typeof v === 'string' && v.includes('np://')) {
            childEnv[k] = await injectSecretRefs(v, (ref) => client.resolveSecretRef(ref));
          }
        }

        const exitCode = await new Promise<number>((resolve, reject) => {
          const child = spawn(command[0], command.slice(1), {
            stdio: 'inherit',
            env: childEnv as NodeJS.ProcessEnv,
          });
          child.on('error', reject);
          child.on('exit', (code) => resolve(code ?? 1));
        });
        return exitCode;
      }

      case 'alias': {
        if (sub === 'list' || !sub) {
          await client.sync();
          io.stdout(
            asJson
              ? JSON.stringify(client.aliases, null, 2)
              : client.aliases
                  .map((a) => `${a.enabled ? 'ON ' : 'OFF'}\t${a.address}\t(${a.receivedCount} msgs)`)
                  .join('\n')
          );
          return 0;
        }
        if (sub === 'create') {
          const domain = firstFlag(parsed, 'for') ?? rest[0];
          if (!domain) throw new Error('alias create requires --for <domain>');
          const alias = await client.createAlias(domain, firstFlag(parsed, 'address'));
          io.stdout(asJson ? JSON.stringify(alias, null, 2) : alias.address);
          return 0;
        }
        if (sub === 'toggle') {
          const target = rest[0];
          if (!target) throw new Error('alias toggle requires <id-or-address>');
          const alias = await client.toggleAlias(target);
          io.stdout(asJson ? JSON.stringify(alias, null, 2) : `${alias.address} -> ${alias.enabled ? 'enabled' : 'disabled'}`);
          return 0;
        }
        throw new Error(`Unknown alias subcommand: ${sub}`);
      }

      case 'mail': {
        if (sub === 'list') {
          await client.sync();
          io.stdout(
            asJson
              ? JSON.stringify(client.emails, null, 2)
              : client.emails
                  .map((e) => `${e.receivedAt}\tOTP=${e.otpCode ?? '-'}\t${e.from}\t${e.subject}`)
                  .join('\n')
          );
          return 0;
        }
        if (sub === 'otp') {
          const waitRaw = firstFlag(parsed, 'wait');
          const waitSeconds = waitRaw ? Number.parseFloat(waitRaw.replace(/s$/i, '')) : 0;
          const email = await client.waitForEmailOtp({
            domain: firstFlag(parsed, 'domain'),
            alias: firstFlag(parsed, 'alias'),
            waitSeconds: Number.isFinite(waitSeconds) ? waitSeconds : 0,
          });
          io.stdout(
            asJson
              ? JSON.stringify({
                  otpCode: email.otpCode,
                  from: email.from,
                  to: email.to,
                  subject: email.subject,
                  magicLink: email.magicLink,
                })
              : email.otpCode ?? ''
          );
          return 0;
        }
        throw new Error(`Unknown mail subcommand: ${sub}`);
      }

      case 'service-account': {
        if (sub === 'list' || !sub) {
          const list = await client.listServiceAccounts();
          io.stdout(
            asJson
              ? JSON.stringify(list, null, 2)
              : list.map((sa) => `${sa.id}\t${sa.name}\tvaults=${sa.vaultIds.join(',')}`).join('\n')
          );
          return 0;
        }
        if (sub === 'create') {
          const name = rest[0] ?? firstFlag(parsed, 'name');
          const vaultRefs = parsed.flags.vault ?? [];
          if (!name || vaultRefs.length === 0) {
            throw new Error('service-account create requires <name> --vault <vaultNameOrId>');
          }
          const created = await client.createServiceAccount(name, vaultRefs);
          io.stdout(
            asJson
              ? JSON.stringify(created, null, 2)
              : `Created Service Account "${created.serviceAccount.name}"\nNONEPWD_TOKEN=${created.token}`
          );
          return 0;
        }
        if (sub === 'revoke') {
          const id = rest[0];
          if (!id) throw new Error('service-account revoke requires <id>');
          await client.revokeServiceAccount(id);
          io.stdout(`Revoked service account ${id}`);
          return 0;
        }
        throw new Error(`Unknown service-account subcommand: ${sub}`);
      }

      case 'serve': {
        if (!hasFlag(parsed, 'connect')) {
          throw new Error('Specify `np serve --connect` to start local Connect HTTP gateway');
        }
        await client.sync();
        const host = firstFlag(parsed, 'host') ?? '127.0.0.1';
        const port = Number.parseInt(firstFlag(parsed, 'port') ?? '8788', 10);
        const connectToken =
          firstFlag(parsed, 'token') ?? io.env?.NONEPWD_CONNECT_TOKEN ?? toBase64Url(randomBytes(24));

        const srv = await startConnectServer({ client, host, port, connectToken });
        io.stdout(`nonepwd Connect API listening on ${srv.url}`);
        io.stdout(`Bearer token: ${connectToken}`);

        await new Promise<void>((resolve) => {
          const stop = async () => {
            await srv.close();
            resolve();
          };
          process.once('SIGINT', () => void stop());
          process.once('SIGTERM', () => void stop());
        });
        return 0;
      }

      default:
        throw new Error(`Unknown command "${cmd}". Run \`np --help\` for usage.`);
    }
  } catch (err) {
    io.stderr(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
