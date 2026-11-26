import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNonePwdServer, type NonePwdServerInstance } from '../../server/src/app.js';
import { NonePwdCliClient } from '../src/client.js';
import { runCli } from '../src/commands.js';
import { resolveConfigDir, saveCliConfig } from '../src/config.js';
import { startConnectServer } from '../src/connect-server.js';

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

async function execCli(args: string[], configDir: string, env?: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, {
    configDir,
    env: { ...process.env, ...env },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('@nonepwd/cli & Connect API', () => {
  it('runs setup, item create, read, otp, inject, run, mail otp --wait, service-account isolation, and connect HTTP API', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonepwd-cli-srv-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonepwd-cli-cfg-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonepwd-cli-work-'));

    const srv: NonePwdServerInstance = createNonePwdServer({ dataDir });
    const { url } = await srv.start(0, '127.0.0.1');
    cleanups.push({ close: () => srv.close(), dirs: [dataDir, configDir, workDir] });

    // 1. np setup
    const setupRes = await execCli(
      [
        'setup',
        '--server',
        url,
        '--email',
        'cli@example.com',
        '--password',
        'CliMasterPass#2026',
        '--alias-domain',
        'mail.example.com',
        '--kdf-iterations',
        '10000',
        '--json',
      ],
      configDir
    );
    expect(setupRes.code).toBe(0);
    const setupData = JSON.parse(setupRes.stdout) as { secretKey: string; email: string };
    expect(setupData.secretKey.startsWith('NP3-')).toBe(true);

    // 2. Create items in Personal and DevOps vaults
    const personalItem = await execCli(
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
        'gh-personal-pass',
        '--totp',
        'JBSWY3DPEHPK3PXP',
        '--auto-alias',
        '--json',
      ],
      configDir
    );
    expect(personalItem.code).toBe(0);

    const devItem = await execCli(
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
        'sk-live-secret-999',
        '--field',
        'api_key=sk-field-abc',
        '--json',
      ],
      configDir
    );
    expect(devItem.code).toBe(0);

    // 3. np read & np otp
    const readPass = await execCli(['read', 'np://DevOps/OpenAI/api_key'], configDir);
    expect(readPass.code).toBe(0);
    expect(readPass.stdout.trim()).toBe('sk-field-abc');

    const otpRes = await execCli(['otp', 'GitHub', '--vault', 'Personal'], configDir);
    expect(otpRes.code).toBe(0);
    expect(otpRes.stdout.trim()).toMatch(/^\d{6}$/);

    const readTotp = await execCli(['read', 'np://Personal/GitHub/totp'], configDir);
    expect(readTotp.code).toBe(0);
    expect(readTotp.stdout.trim()).toMatch(/^\d{6}$/);

    // 4. np inject & np run --env-file
    const tplPath = path.join(workDir, 'config.tpl.txt');
    const outPath = path.join(workDir, 'config.out.txt');
    fs.writeFileSync(tplPath, 'KEY={{ np://DevOps/OpenAI/password }}', 'utf8');
    const injectRes = await execCli(['inject', '-i', tplPath, '-o', outPath], configDir);
    expect(injectRes.code).toBe(0);
    expect(fs.readFileSync(outPath, 'utf8')).toBe('KEY=sk-live-secret-999');

    const envTplPath = path.join(workDir, '.env.tpl');
    fs.writeFileSync(envTplPath, 'MY_API_KEY=np://DevOps/OpenAI/api_key\n', 'utf8');
    const outputFile = path.join(workDir, 'injected-env.txt');
    const runRes = await execCli(
      [
        'run',
        '--env-file',
        envTplPath,
        '--',
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(outputFile)}, process.env.MY_API_KEY)`,
      ],
      configDir
    );
    expect(runRes.code).toBe(0);
    expect(fs.readFileSync(outputFile, 'utf8')).toBe('sk-field-abc');

    // 5. np mail otp --domain github.com --wait 5 (simulated async incoming email via WS)
    const cfgJson = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')) as {
      session: { token: string };
    };
    setTimeout(() => {
      void fetch(`${url}/api/emails/simulate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfgJson.session.token}`,
        },
        body: JSON.stringify({
          from: 'GitHub <noreply@github.com>',
          to: 'github.test@mail.example.com',
          subject: '[GitHub] Verification code',
          text: 'Your GitHub verification code is: 918273',
        }),
      });
    }, 150);

    const mailOtpRes = await execCli(
      ['mail', 'otp', '--domain', 'github.com', '--wait', '5'],
      configDir
    );
    expect(mailOtpRes.code).toBe(0);
    expect(mailOtpRes.stdout.trim()).toBe('918273');

    // 6. Service Account token scoped ONLY to DevOps
    const saRes = await execCli(
      ['service-account', 'create', 'ci-agent', '--vault', 'DevOps', '--json'],
      configDir
    );
    expect(saRes.code).toBe(0);
    const { token: pstToken } = JSON.parse(saRes.stdout) as { token: string };
    expect(pstToken.startsWith('npst_v1_')).toBe(true);

    const isolatedCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonepwd-cli-sa-'));
    cleanups[cleanups.length - 1].dirs.push(isolatedCfgDir);

    const saReadDev = await execCli(['read', 'np://DevOps/OpenAI/password'], isolatedCfgDir, {
      NONEPWD_TOKEN: pstToken,
    });
    expect(saReadDev.code).toBe(0);
    expect(saReadDev.stdout.trim()).toBe('sk-live-secret-999');

    const saReadPersonal = await execCli(['read', 'np://Personal/GitHub/password'], isolatedCfgDir, {
      NONEPWD_TOKEN: pstToken,
    });
    expect(saReadPersonal.code).toBe(1);

    // 7. Connect HTTP Server using Service Account client
    const saClient = new NonePwdCliClient({ serviceAccountToken: pstToken });
    const connectSrv = await startConnectServer({
      client: saClient,
      host: '127.0.0.1',
      port: 0,
      connectToken: 'connect-secret-123',
    });
    try {
      const badRes = await fetch(`${connectSrv.url}/v1/vaults`);
      expect(badRes.status).toBe(401);

      const resolveRes = await fetch(
        `${connectSrv.url}/v1/resolve?ref=${encodeURIComponent('np://DevOps/OpenAI/password')}`,
        { headers: { Authorization: 'Bearer connect-secret-123' } }
      );
      expect(resolveRes.status).toBe(200);
      const resolveJson = (await resolveRes.json()) as { value: string };
      expect(resolveJson.value).toBe('sk-live-secret-999');

      // 8. CSV batch import + duplicate skipping (`np import`)
      const csvPath = path.join(workDir, 'brave-passwords.csv');
      fs.writeFileSync(
        csvPath,
        [
          '\uFEFFname,url,username,password,note',
          'Notion,https://www.notion.so/login,alice@example.com,"notion,pass#1",workspace',
          ',https://dash.cloudflare.com,cf@example.com,cf-pass-2,dns',
        ].join('\r\n'),
        'utf8'
      );

      const importRes1 = await execCli(
        ['import', csvPath, '--vault', 'Personal', '--json'],
        configDir
      );
      expect(importRes1.code).toBe(0);
      const summary1 = JSON.parse(importRes1.stdout) as {
        vaultName: string;
        total: number;
        imported: number;
        skipped: number;
      };
      expect(summary1).toMatchObject({
        vaultName: 'Personal',
        total: 2,
        imported: 2,
        skipped: 0,
      });

      const readImported = await execCli(['read', 'np://Personal/Notion/password'], configDir);
      expect(readImported.code).toBe(0);
      expect(readImported.stdout.trim()).toBe('notion,pass#1');

      const importRes2 = await execCli(
        ['import', csvPath, '--vault', 'Personal', '--json'],
        configDir
      );
      expect(importRes2.code).toBe(0);
      const summary2 = JSON.parse(importRes2.stdout) as {
        total: number;
        imported: number;
        skipped: number;
      };
      expect(summary2).toMatchObject({ total: 2, imported: 0, skipped: 2 });

      // 9. Authenticator 2FA export import (auto-detected + idempotent re-run)
      const totpExportPath = path.join(workDir, 'authenticator-synthetic.txt');
      fs.writeFileSync(
        totpExportPath,
        [
          '# Synthetic authenticator export',
          'otpauth://totp/Notion:alice%40example.com?secret=JBSWY3DPEHPK3PXQ&issuer=Notion',
          'otpauth://totp/Cloudflare:cf%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Cloudflare',
          'otpauth://totp/Stripe:ops%40example.com?secret=MFRGGZDFMZTWQ2LK&issuer=Stripe',
        ].join('\n'),
        'utf8'
      );

      const totpImp1 = await execCli(
        ['import', totpExportPath, '--vault', 'Personal', '--json'],
        configDir
      );
      expect(totpImp1.code).toBe(0);
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

      // Attached Notion item preserves original password and now produces TOTP codes
      const readNotionPass = await execCli(['read', 'np://Personal/Notion/password'], configDir);
      expect(readNotionPass.stdout.trim()).toBe('notion,pass#1');
      const notionOtp = await execCli(['otp', 'Notion', '--vault', 'Personal'], configDir);
      expect(notionOtp.code).toBe(0);
      expect(notionOtp.stdout.trim()).toMatch(/^\d{6}$/);

      // Newly created Stripe login item produces TOTP codes
      const stripeOtp = await execCli(['otp', 'Stripe', '--vault', 'Personal'], configDir);
      expect(stripeOtp.code).toBe(0);
      expect(stripeOtp.stdout.trim()).toMatch(/^\d{6}$/);

      // Idempotent second run skips all 3 secrets
      const totpImp2 = await execCli(
        ['import', totpExportPath, '--format', 'totp', '--vault', 'Personal', '--json'],
        configDir
      );
      expect(totpImp2.code).toBe(0);
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

      // 10. Google Authenticator otpauth-migration:// protobuf import via CLI
      const migPath = path.join(workDir, 'google-migration-synthetic.txt');
      // Protobuf OtpParameters: field 1 secret="1234567890" (10 bytes), field 2 name="GitLab:ops@example.com", field 3 issuer="GitLab", field 4 alg=1(SHA1), field 5 digits=1(6), field 6 type=2(TOTP)
      const otpEntryBytes = Buffer.concat([
        Buffer.from([0x0a, 10]),
        Buffer.from('1234567890', 'utf8'),
        Buffer.from([0x12, 22]),
        Buffer.from('GitLab:ops@example.com', 'utf8'),
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

      const migImp1 = await execCli(
        ['import', migPath, '--vault', 'Personal', '--json'],
        configDir
      );
      expect(migImp1.code).toBe(0);
      expect(JSON.parse(migImp1.stdout)).toMatchObject({
        format: 'totp',
        total: 1,
        imported: 1,
        attached: 0,
        created: 1,
        skipped: 0,
      });
      const gitlabOtp = await execCli(['otp', 'GitLab', '--vault', 'Personal'], configDir);
      expect(gitlabOtp.stdout.trim()).toMatch(/^\d{6}$/);

      // 11. Security regressions: NONEPWD_* scrubbing, op:// resolution in TS np run, LD_PRELOAD blocking, 0600 permissions
      const opEnvTplPath = path.join(workDir, '.env.op.tpl');
      fs.writeFileSync(opEnvTplPath, 'OP_SECRET=op://DevOps/OpenAI/api_key\n', 'utf8');
      const scrubDumpFile = path.join(workDir, 'scrub-dump.json');
      const opRunRes = await execCli(
        [
          'run',
          '--env-file',
          opEnvTplPath,
          '--',
          process.execPath,
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(scrubDumpFile)}, JSON.stringify({
            opSecret: process.env.OP_SECRET ?? null,
            hasToken: 'NONEPWD_TOKEN' in process.env,
            hasMaster: 'NONEPWD_MASTER_PASSWORD' in process.env,
            hasSecretKey: 'NONEPWD_SECRET_KEY' in process.env,
            hasAgentToken: 'NONEPWD_AGENT_TOKEN' in process.env,
            hasConnectToken: 'NONEPWD_CONNECT_TOKEN' in process.env,
          }))`,
        ],
        isolatedCfgDir,
        {
          NONEPWD_TOKEN: pstToken,
          NONEPWD_MASTER_PASSWORD: 'should-not-leak-master',
          NONEPWD_SECRET_KEY: 'NP3-SHOULD-NOT-LEAK',
          NONEPWD_AGENT_TOKEN: 'should-not-leak-agent',
          NONEPWD_CONNECT_TOKEN: 'should-not-leak-connect',
        }
      );
      expect(opRunRes.code).toBe(0);
      const scrubDump = JSON.parse(fs.readFileSync(scrubDumpFile, 'utf8')) as {
        opSecret: string | null;
        hasToken: boolean;
        hasMaster: boolean;
        hasSecretKey: boolean;
        hasAgentToken: boolean;
        hasConnectToken: boolean;
      };
      expect(scrubDump).toEqual({
        opSecret: 'sk-field-abc',
        hasToken: false,
        hasMaster: false,
        hasSecretKey: false,
        hasAgentToken: false,
        hasConnectToken: false,
      });

      const evilEnvPath = path.join(workDir, '.env.evil');
      fs.writeFileSync(evilEnvPath, 'LD_PRELOAD=/tmp/evil.so\nSAFE_VAR=ok\n', 'utf8');
      const blockedRun = await execCli(
        ['run', '--env-file', evilEnvPath, '--', process.execPath, '-e', 'process.exit(0)'],
        configDir
      );
      expect(blockedRun.code).toBe(1);
      expect(blockedRun.stderr).toContain('LD_PRELOAD');

      if (process.platform !== 'win32') {
        const modeOut = fs.statSync(outPath).mode & 0o777;
        expect(modeOut).toBe(0o600);

        // Overwriting a pre-existing 0644 config.json must enforce 0600
        const looseCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nonepwd-loose-cfg-'));
        cleanups[cleanups.length - 1].dirs.push(looseCfgDir);
        const looseCfgFile = path.join(looseCfgDir, 'config.json');
        fs.writeFileSync(looseCfgFile, '{}', { mode: 0o644 });
        fs.chmodSync(looseCfgFile, 0o644);
        saveCliConfig({ serverUrl: url }, looseCfgDir);
        expect(fs.statSync(looseCfgFile).mode & 0o777).toBe(0o600);
        expect(fs.statSync(looseCfgDir).mode & 0o777).toBe(0o700);
      }

      // XDG_CONFIG_HOME support matches Rust CLI
      const prevCfgEnv = process.env.NONEPWD_CONFIG_DIR;
      const prevXdgEnv = process.env.XDG_CONFIG_HOME;
      try {
        delete process.env.NONEPWD_CONFIG_DIR;
        process.env.XDG_CONFIG_HOME = '/tmp/xdg-nonepwd-test';
        expect(resolveConfigDir()).toBe(path.join('/tmp/xdg-nonepwd-test', 'nonepwd'));
      } finally {
        if (prevCfgEnv === undefined) delete process.env.NONEPWD_CONFIG_DIR;
        else process.env.NONEPWD_CONFIG_DIR = prevCfgEnv;
        if (prevXdgEnv === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdgEnv;
      }
    } finally {
      await connectSrv.close();
    }
  });
});
