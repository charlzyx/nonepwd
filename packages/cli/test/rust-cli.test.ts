import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AAD,
  decryptBytes,
  decryptJson,
  deriveAccountKeys,
  fromBase64Url,
  type EncryptedItemRecord,
  type EncryptedVaultRecord,
  type RootKeysetPayload,
  type VaultItemPayload,
} from '@nonepwd/core';
import { createNonePwdServer, type NonePwdServerInstance } from '../../server/src/app.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const nativeBin = path.join(repoRoot, 'dist', 'bin', process.platform === 'win32' ? 'np.exe' : 'np');

const cleanups: Array<{ close: () => Promise<void>; dirs: string[] }> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const entry = cleanups.pop()!;
    await entry.close();
    for (const d of entry.dirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

async function runNativeCli(
  args: string[],
  configDir: string,
  extraEnv?: Record<string, string>
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(nativeBin, args, {
    env: {
      ...process.env,
      NONEPWD_CONFIG_DIR: configDir,
      ...extraEnv,
    },
  });
}

describe('Native Rust `np` CLI (macOS/Linux) + WASM Core Interoperability', () => {
  it('runs native Rust CLI lifecycle and interoperates byte-for-byte with Rust WASM @nonepwd/core', async () => {
    expect(fs.existsSync(nativeBin)).toBe(true);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonepwd-rustcli-srv-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonepwd-rustcli-cfg-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonepwd-rustcli-work-'));

    const srv: NonePwdServerInstance = createNonePwdServer({ dataDir });
    const { url } = await srv.start(0, '127.0.0.1');
    cleanups.push({ close: () => srv.close(), dirs: [dataDir, configDir, workDir] });

    // 1. version check
    const ver = await runNativeCli(['version'], configDir);
    expect(ver.stdout.trim()).toContain('nonepwd-cli 0.1.0');

    // 2. np setup & verify 0600 permissions on config.json
    const setupOut = await runNativeCli(
      [
        'setup',
        '--server',
        url,
        '--email',
        'rust@example.com',
        '--password',
        'RustMaster#2026',
        '--alias-domain',
        'mail.example.com',
        '--kdf-iterations',
        '10000',
        '--json',
      ],
      configDir
    );
    const setupData = JSON.parse(setupOut.stdout) as { secretKey: string; email: string };
    expect(setupData.secretKey.startsWith('NP3-')).toBe(true);

    if (process.platform !== 'win32') {
      const cfgPath = path.join(configDir, 'config.json');
      const mode = fs.statSync(cfgPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // 3. Create items using native Rust CLI
    await runNativeCli(
      [
        'item',
        'create',
        '--vault',
        'Personal',
        '--title',
        'GitHub',
        '--url',
        'https://github.com/login',
        '--username',
        'octocat',
        '--password',
        'rust-gh-pass',
        '--totp',
        'JBSWY3DPEHPK3PXP',
        '--auto-alias',
        '--json',
      ],
      configDir
    );

    await runNativeCli(
      [
        'item',
        'create',
        '--vault',
        'DevOps',
        '--title',
        'OpenAI',
        '--category',
        'api_credential',
        '--password',
        'sk-rust-999',
        '--field',
        'api_key=sk-field-rust',
        '--json',
      ],
      configDir
    );

    // 4. Cross-check: decrypt items created by native Rust CLI inside Node via Rust WASM @nonepwd/core!
    const paramsRes = await fetch(`${url}/api/auth/params`);
    const params = (await paramsRes.json()) as { kdfSalt: string; kdfIterations: number };
    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      'RustMaster#2026',
      setupData.secretKey,
      params.kdfSalt,
      params.kdfIterations
    );
    const loginRes = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authVerifier: authVerifierB64 }),
    });
    const loginJson = (await loginRes.json()) as {
      token: string;
      account: { encryptedRootKeyset: string };
    };
    const rootKeyset = await decryptJson<RootKeysetPayload>(
      masterUnlockKeyBytes,
      loginJson.account.encryptedRootKeyset,
      AAD.ROOT_KEYSET
    );
    const rootKeyBytes = fromBase64Url(rootKeyset.rootKeyB64);

    const syncRes = await fetch(`${url}/api/sync`, {
      headers: { Authorization: `Bearer ${loginJson.token}` },
    });
    const syncData = (await syncRes.json()) as {
      vaults: EncryptedVaultRecord[];
      items: EncryptedItemRecord[];
    };
    const decryptedTitles: string[] = [];
    for (const v of syncData.vaults) {
      const vk = await decryptBytes(rootKeyBytes, v.encryptedKey, AAD.vaultOwnerKey(v.id));
      for (const it of syncData.items.filter((x) => x.vaultId === v.id)) {
        const payload = await decryptJson<VaultItemPayload>(
          vk,
          it.encryptedData,
          AAD.vaultItem(v.id, it.id)
        );
        decryptedTitles.push(payload.title);
      }
    }
    expect(decryptedTitles).toContain('GitHub');
    expect(decryptedTitles).toContain('OpenAI');

    // 5. np read & np otp & np inject & np run
    const readRes = await runNativeCli(['read', 'np://DevOps/OpenAI/api_key'], configDir);
    expect(readRes.stdout.trim()).toBe('sk-field-rust');

    const otpRes = await runNativeCli(['otp', 'GitHub', '--vault', 'Personal'], configDir);
    expect(otpRes.stdout.trim()).toMatch(/^\d{6}$/);

    const tplPath = path.join(workDir, 'tpl.txt');
    const outPath = path.join(workDir, 'out.txt');
    fs.writeFileSync(tplPath, 'KEY={{ np://DevOps/OpenAI/password }}', 'utf8');
    await runNativeCli(['inject', '-i', tplPath, '-o', outPath], configDir);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('KEY=sk-rust-999');

    const envTplPath = path.join(workDir, '.env.tpl');
    const envOutFile = path.join(workDir, 'env-out.txt');
    fs.writeFileSync(envTplPath, 'RUST_INJECTED=np://DevOps/OpenAI/api_key\n', 'utf8');
    await runNativeCli(
      [
        'run',
        '--env-file',
        envTplPath,
        '--',
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(envOutFile)}, process.env.RUST_INJECTED)`,
      ],
      configDir
    );
    expect(fs.readFileSync(envOutFile, 'utf8')).toBe('sk-field-rust');

    // 6. Native Rust WebSocket `np mail otp --domain github.com --wait 5`
    setTimeout(() => {
      void fetch(`${url}/api/emails/simulate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${loginJson.token}`,
        },
        body: JSON.stringify({
          from: 'GitHub <noreply@github.com>',
          to: 'github.rust@mail.example.com',
          subject: '[GitHub] Verification code',
          text: 'Your GitHub verification code is 774411.',
        }),
      });
    }, 150);

    const mailOtp = await runNativeCli(
      ['mail', 'otp', '--domain', 'github.com', '--wait', '5'],
      configDir
    );
    expect(mailOtp.stdout.trim()).toBe('774411');

    // 7. Service Account isolation via native Rust binary
    const saOut = await runNativeCli(
      ['service-account', 'create', 'rust-sa', '--vault', 'DevOps', '--json'],
      configDir
    );
    const { token: pstToken } = JSON.parse(saOut.stdout) as { token: string };
    const saConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonepwd-rustcli-sa-'));
    cleanups[cleanups.length - 1].dirs.push(saConfigDir);

    const saOk = await runNativeCli(['read', 'np://DevOps/OpenAI/password'], saConfigDir, {
      NONEPWD_TOKEN: pstToken,
    });
    expect(saOk.stdout.trim()).toBe('sk-rust-999');

    await expect(
      runNativeCli(['read', 'np://Personal/GitHub/password'], saConfigDir, {
        NONEPWD_TOKEN: pstToken,
      })
    ).rejects.toThrow();

    // 8. Native Rust `np serve --connect` HTTP API
    const connectPort = 18788 + Math.floor(Math.random() * 1000);
    const connectChild = spawn(
      nativeBin,
      ['serve', '--connect', '--host', '127.0.0.1', '--port', String(connectPort), '--token', 'rust-conn-tok'],
      {
        env: { ...process.env, NONEPWD_CONFIG_DIR: saConfigDir, NONEPWD_TOKEN: pstToken },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connect server startup timeout')), 5000);
        connectChild.stdout.on('data', (chunk) => {
          if (String(chunk).includes('listening on')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        connectChild.on('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Connect server exited early with ${code}`));
        });
      });

      const resolveHttp = await fetch(
        `http://127.0.0.1:${connectPort}/v1/resolve?ref=${encodeURIComponent('np://DevOps/OpenAI/password')}`,
        { headers: { Authorization: 'Bearer rust-conn-tok' } }
      );
      expect(resolveHttp.status).toBe(200);
      const resolveJson = (await resolveHttp.json()) as { value: string };
      expect(resolveJson.value).toBe('sk-rust-999');

      // 9. Native Rust `np import` + deduplication check
      const csvPath = path.join(workDir, 'Brave 密码.csv');
      fs.writeFileSync(
        csvPath,
        [
          '\uFEFFname,url,username,password,note',
          'Linear,https://linear.app/login,dev@example.com,lin-secret-1,issue tracker',
          ',https://vercel.com/login,dev@example.com,vc-secret-2,deploy',
        ].join('\n'),
        'utf8'
      );

      const imp1 = await runNativeCli(
        ['import', csvPath, '--vault', 'Personal', '--json'],
        configDir
      );
      const sum1 = JSON.parse(imp1.stdout) as {
        vaultName: string;
        total: number;
        imported: number;
        skipped: number;
      };
      expect(sum1).toMatchObject({
        vaultName: 'Personal',
        total: 2,
        imported: 2,
        skipped: 0,
      });

      const readLin = await runNativeCli(['read', 'np://Personal/Linear/password'], configDir);
      expect(readLin.stdout.trim()).toBe('lin-secret-1');

      const imp2 = await runNativeCli(
        ['import', '--json', csvPath, '--vault', 'Personal'],
        configDir
      );
      const sum2 = JSON.parse(imp2.stdout) as {
        total: number;
        imported: number;
        skipped: number;
      };
      expect(sum2).toMatchObject({ total: 2, imported: 0, skipped: 2 });

      // 10. Native Rust `np import` with synthetic authenticator export (auto-detect + idempotent)
      const totpPath = path.join(workDir, 'synthetic-authenticator.txt');
      fs.writeFileSync(
        totpPath,
        [
          '# Synthetic 2FA export',
          'otpauth://totp/Linear:dev%40example.com?secret=JBSWY3DPEHPK3PXQ&issuer=Linear',
          'otpauth://totp/Vercel:dev%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Vercel',
          'otpauth://totp/Stripe:ops%40example.com?secret=MFRGGZDFMZTWQ2LK&issuer=Stripe',
        ].join('\n'),
        'utf8'
      );

      const totpImp1 = await runNativeCli(
        ['import', totpPath, '--vault', 'Personal', '--json'],
        configDir
      );
      const totpSum1 = JSON.parse(totpImp1.stdout) as {
        format: string;
        total: number;
        imported: number;
        attached: number;
        created: number;
        skipped: number;
      };
      expect(totpSum1).toMatchObject({
        format: 'totp',
        total: 3,
        imported: 3,
        attached: 2,
        created: 1,
        skipped: 0,
      });

      const linearOtp = await runNativeCli(['otp', 'Linear', '--vault', 'Personal'], configDir);
      expect(linearOtp.stdout.trim()).toMatch(/^\d{6}$/);
      const stripeOtp = await runNativeCli(['otp', 'Stripe', '--vault', 'Personal'], configDir);
      expect(stripeOtp.stdout.trim()).toMatch(/^\d{6}$/);

      const totpImp2 = await runNativeCli(
        ['import', totpPath, '--format', 'totp', '--vault', 'Personal', '--json'],
        configDir
      );
      const totpSum2 = JSON.parse(totpImp2.stdout) as {
        total: number;
        imported: number;
        attached: number;
        created: number;
        skipped: number;
      };
      expect(totpSum2).toMatchObject({
        total: 3,
        imported: 0,
        attached: 0,
        created: 0,
        skipped: 3,
      });

      // 11. Native Rust `np import` with Google Authenticator otpauth-migration:// protobuf
      const migPath = path.join(workDir, 'google-migration-rust.txt');
      const otpEntryBytes = Buffer.concat([
        Buffer.from([0x0a, 10]),
        Buffer.from('1234567890', 'utf8'),
        Buffer.from([0x12, 22]),
        Buffer.from('GitLab:dev@example.com', 'utf8'),
        Buffer.from([0x1a, 6]),
        Buffer.from('GitLab', 'utf8'),
        Buffer.from([0x20, 1, 0x28, 1, 0x30, 2]),
      ]);
      const migPayload = Buffer.concat([
        Buffer.from([0x0a, otpEntryBytes.length]),
        otpEntryBytes,
        Buffer.from([0x10, 1]),
      ]);
      fs.writeFileSync(
        migPath,
        `otpauth-migration://offline?data=${encodeURIComponent(migPayload.toString('base64'))}\n`,
        'utf8'
      );

      const migImp1 = await runNativeCli(
        ['import', migPath, '--vault', 'Personal', '--json'],
        configDir
      );
      expect(JSON.parse(migImp1.stdout)).toMatchObject({
        format: 'totp',
        total: 1,
        imported: 1,
        created: 1,
        skipped: 0,
      });
      const gitlabOtp = await runNativeCli(['otp', 'GitLab', '--vault', 'Personal'], configDir);
      expect(gitlabOtp.stdout.trim()).toMatch(/^\d{6}$/);
    } finally {
      connectChild.kill('SIGTERM');
    }
  });

  it('launches embedded Rust server via `np server --port 0 --data-dir <tmp>`', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonepwd-np-server-'));
    const child = spawn(
      nativeBin,
      ['server', '--host', '127.0.0.1', '--port', '0', '--data-dir', tmpDataDir],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    cleanups.push({
      close: async () => {
        child.kill('SIGTERM');
      },
      dirs: [tmpDataDir],
    });

    const boundUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('np server startup timeout')), 5000);
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += String(chunk);
        const match = /nonepwd server listening on (http:\/\/[^\s]+)/.exec(buf);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`np server exited early with code ${code}`));
      });
    });

    const res = await fetch(`${boundUrl}/api/auth/params`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { initialized: boolean };
    expect(json.initialized).toBe(false);
  });
});
