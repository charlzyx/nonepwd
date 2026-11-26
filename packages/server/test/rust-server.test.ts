import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  AAD,
  decryptJson,
  deriveAccountKeys,
  encryptBytes,
  encryptJson,
  generateEmailKeyPair,
  generateRawAesKey,
  generateSecretKey,
  openSealedJson,
  randomBytes,
  randomId,
  sealJsonForPublicKey,
  toBase64Url,
  utf8Encode,
  type DecryptedEmailPayload,
  type EncryptedEmailRecord,
  type RootKeysetPayload,
  type VaultItemPayload,
  type VaultMetadata,
} from '@nonepwd/core';
import { processIncomingEmail, type EmailMessageLike } from '../../cf-email-worker/src/index.js';
import { createNonePwdServer } from '../src/app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const npBinPath = path.join(repoRoot, 'dist', 'bin', process.platform === 'win32' ? 'np.exe' : 'np');

interface SpawnedRustServer {
  proc: ChildProcessWithoutNullStreams;
  url: string;
  dirsToRemove: string[];
}

const runningServers: SpawnedRustServer[] = [];

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function spawnRustServer(opts?: {
  dataDir?: string;
  webDist?: string;
  extraCleanupDirs?: string[];
}): Promise<{ url: string; dataDir: string; proc: ChildProcessWithoutNullStreams }> {
  const dataDir = opts?.dataDir ?? makeTempDir('np-rust-srv-');
  const dirsToRemove = [dataDir, ...(opts?.extraCleanupDirs ?? [])];

  const args = ['server', '--host', '127.0.0.1', '--port', '0', '--data-dir', dataDir];
  if (opts?.webDist) {
    args.push('--web-dist', opts.webDist);
  }

  const proc = spawn(npBinPath, args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise<string>((resolve, reject) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(
        new Error(
          `Timed out waiting for Rust server listening line.\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`
        )
      );
    }, 15_000);

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      const match = stdoutBuf.match(/nonepwd server listening on (http:\/\/[^\s\r\n]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });

    proc.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });

    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Rust server exited early (code=${code}, signal=${signal}).\nstdout: ${stdoutBuf}\nstderr: ${stderrBuf}`
        )
      );
    });
  });

  runningServers.push({ proc, url, dirsToRemove });
  return { url, dataDir, proc };
}

async function stopProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 3_000);
    proc.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

afterEach(async () => {
  while (runningServers.length > 0) {
    const entry = runningServers.pop()!;
    await stopProcess(entry.proc);
    for (const dir of entry.dirsToRemove) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const bytes = utf8Encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('nonepwd-server (100% Rust via `np server`)', () => {
  it('enforces single-user zero-knowledge setup, login, vault/item CRUD, batch import, and service account isolation', async () => {
    const { url } = await spawnRustServer();

    const healthBefore = await fetch(`${url}/api/health`);
    expect(healthBefore.status).toBe(200);
    expect(await healthBefore.json()).toEqual({
      ok: true,
      initialized: false,
      version: '0.1.0',
      agentRelay: '/agent/relay',
    });

    // CORS preflight check
    const preflight = await fetch(`${url}/api/health`, { method: 'OPTIONS' });
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

    const secretKey = generateSecretKey();
    const kdfSalt = toBase64Url(randomBytes(16));
    const iterations = 10_000;
    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      'MasterPass#123',
      secretKey,
      kdfSalt,
      iterations
    );

    const rootKeyBytes = generateRawAesKey();
    const emailKp = await generateEmailKeyPair();
    const rootKeyset: RootKeysetPayload = {
      rootKeyB64: toBase64Url(rootKeyBytes),
      emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
    };
    const encryptedRootKeyset = await encryptJson(
      masterUnlockKeyBytes,
      rootKeyset,
      AAD.ROOT_KEYSET
    );

    const personalId = randomId();
    const personalKey = generateRawAesKey();
    const devopsId = randomId();
    const devopsKey = generateRawAesKey();

    const setupRes = await fetch(`${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.com',
        kdfSalt,
        kdfIterations: iterations,
        authVerifier: authVerifierB64,
        encryptedRootKeyset,
        emailPublicKey: emailKp.publicKeyB64,
        aliasDomain: 'mail.example.com',
        vaults: [
          {
            id: personalId,
            encryptedKey: await encryptBytes(rootKeyBytes, personalKey, AAD.vaultOwnerKey(personalId)),
            encryptedMeta: await encryptJson<VaultMetadata>(
              personalKey,
              { name: 'Personal' },
              AAD.vaultMeta(personalId)
            ),
          },
          {
            id: devopsId,
            encryptedKey: await encryptBytes(rootKeyBytes, devopsKey, AAD.vaultOwnerKey(devopsId)),
            encryptedMeta: await encryptJson<VaultMetadata>(
              devopsKey,
              { name: 'DevOps' },
              AAD.vaultMeta(devopsId)
            ),
          },
        ],
      }),
    });
    expect(setupRes.status).toBe(201);
    const setupJson = (await setupRes.json()) as {
      token: string;
      account: { cfWebhookSecret: string };
    };
    expect(setupJson.token).toBeTruthy();

    // Second setup must be blocked (single user)
    const setupAgain = await fetch(`${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'attacker@example.com',
        kdfSalt,
        kdfIterations: iterations,
        authVerifier: authVerifierB64,
        encryptedRootKeyset,
        emailPublicKey: emailKp.publicKeyB64,
      }),
    });
    expect(setupAgain.status).toBe(409);

    // Wrong authVerifier rejected
    const badLogin = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authVerifier: 'wrong-verifier' }),
    });
    expect(badLogin.status).toBe(401);

    // Batch import items into Personal vault
    const batchItem1Id = randomId();
    const batchItem2Id = randomId();
    const batchPayload1: VaultItemPayload = {
      id: batchItem1Id,
      vaultId: personalId,
      category: 'login',
      title: 'Personal Bank',
      favorite: true,
      tags: [],
      urls: ['https://bank.example.com'],
      username: 'owner',
      password: 'personal-only-password',
      customFields: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const batchPayload2: VaultItemPayload = {
      id: batchItem2Id,
      vaultId: personalId,
      category: 'login',
      title: 'Personal Mail',
      favorite: false,
      tags: [],
      urls: ['https://mail.example.com'],
      username: 'owner@mail.example.com',
      password: 'mail-password',
      customFields: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const batchRes = await fetch(`${url}/api/vaults/${personalId}/items/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${setupJson.token}`,
      },
      body: JSON.stringify({
        items: [
          {
            id: batchItem1Id,
            encryptedData: await encryptJson(
              personalKey,
              batchPayload1,
              AAD.vaultItem(personalId, batchItem1Id)
            ),
          },
          {
            id: batchItem2Id,
            encryptedData: await encryptJson(
              personalKey,
              batchPayload2,
              AAD.vaultItem(personalId, batchItem2Id)
            ),
          },
        ],
      }),
    });
    expect(batchRes.status).toBe(201);
    const batchJson = (await batchRes.json()) as { imported: number; items: Array<{ id: string }> };
    expect(batchJson.imported).toBe(2);
    expect(batchJson.items).toHaveLength(2);

    // Add item to DevOps vault
    const dItemId = randomId();
    const dPayload: VaultItemPayload = {
      id: dItemId,
      vaultId: devopsId,
      category: 'api_credential',
      title: 'OpenAI',
      favorite: false,
      tags: ['prod'],
      urls: ['https://api.openai.com'],
      password: 'sk-devops-secret',
      customFields: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const createDevRes = await fetch(`${url}/api/vaults/${devopsId}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${setupJson.token}`,
      },
      body: JSON.stringify({
        id: dItemId,
        encryptedData: await encryptJson(devopsKey, dPayload, AAD.vaultItem(devopsId, dItemId)),
      }),
    });
    expect(createDevRes.status).toBe(201);

    // Create Service Account scoped ONLY to DevOps vault
    const saId = 'sa_devops_only';
    const saAuthSecret = 'sa-secret-xyz';
    const saWrapKey = generateRawAesKey();
    const saRes = await fetch(`${url}/api/service-accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${setupJson.token}`,
      },
      body: JSON.stringify({
        id: saId,
        name: 'CI Runner',
        authSecret: saAuthSecret,
        vaultKeys: [
          {
            vaultId: devopsId,
            encryptedVaultKey: await encryptBytes(
              saWrapKey,
              devopsKey,
              AAD.vaultSaKey(devopsId, saId)
            ),
          },
        ],
      }),
    });
    expect(saRes.status).toBe(201);

    const saLogin = await fetch(`${url}/api/auth/service-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId: saId, authSecret: saAuthSecret }),
    });
    expect(saLogin.status).toBe(200);
    const saJson = (await saLogin.json()) as { token: string };

    // Service Account sync should ONLY return DevOps vault and item
    const saSync = await fetch(`${url}/api/sync`, {
      headers: { Authorization: `Bearer ${saJson.token}` },
    });
    expect(saSync.status).toBe(200);
    const saSyncData = (await saSync.json()) as {
      kind: string;
      vaults: Array<{ id: string }>;
      items: Array<{ id: string; encryptedData: string }>;
    };
    expect(saSyncData.kind).toBe('service_account');
    expect(saSyncData.vaults.map((v) => v.id)).toEqual([devopsId]);
    expect(saSyncData.items.map((i) => i.id)).toEqual([dItemId]);

    const decryptedDevItem = await decryptJson<VaultItemPayload>(
      devopsKey,
      saSyncData.items[0].encryptedData,
      AAD.vaultItem(devopsId, dItemId)
    );
    expect(decryptedDevItem.password).toBe('sk-devops-secret');

    // Service Account must get 403 on Personal vault, Owner settings, and Email Filter
    const forbiddenVault = await fetch(`${url}/api/vaults/${personalId}/items`, {
      headers: { Authorization: `Bearer ${saJson.token}` },
    });
    expect(forbiddenVault.status).toBe(403);

    const forbiddenSettings = await fetch(`${url}/api/settings`, {
      headers: { Authorization: `Bearer ${saJson.token}` },
    });
    expect(forbiddenSettings.status).toBe(403);

    const forbiddenFilter = await fetch(`${url}/api/email-filter`, {
      headers: { Authorization: `Bearer ${saJson.token}` },
    });
    expect(forbiddenFilter.status).toBe(403);
  });

  it('delivers CF Email Worker raw HMAC MIME & edge_sealed emails, drops disabled aliases, and pushes over WebSocket', async () => {
    const { url } = await spawnRustServer();

    const sk = generateSecretKey();
    const salt = toBase64Url(randomBytes(16));
    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      'CFWorkerPass#1',
      sk,
      salt,
      10_000
    );
    const emailKp = await generateEmailKeyPair();
    const encryptedRootKeyset = await encryptJson(
      masterUnlockKeyBytes,
      {
        rootKeyB64: toBase64Url(generateRawAesKey()),
        emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
      },
      AAD.ROOT_KEYSET
    );

    const setupRes = await fetch(`${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'cf@example.com',
        kdfSalt: salt,
        kdfIterations: 10_000,
        authVerifier: authVerifierB64,
        encryptedRootKeyset,
        emailPublicKey: emailKp.publicKeyB64,
        aliasDomain: 'mail.example.com',
      }),
    });
    const { token, account } = (await setupRes.json()) as {
      token: string;
      account: { cfWebhookSecret: string };
    };

    const aliasRes = await fetch(`${url}/api/aliases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        address: 'cursor.k9x2m@mail.example.com',
        siteDomain: 'cursor.com',
      }),
    });
    expect(aliasRes.status).toBe(201);
    const { alias } = (await aliasRes.json()) as { alias: { id: string; address: string } };

    // Connect WebSocket
    const wsUrl = url.replace('http://', 'ws://') + `/api/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));

    const wsEmails: EncryptedEmailRecord[] = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { type: string; email?: EncryptedEmailRecord };
      if (msg.type === 'email.received' && msg.email) {
        wsEmails.push(msg.email);
      }
    });

    // Bad HMAC signature rejected with 401
    const ts = String(Math.floor(Date.now() / 1000));
    const badWebhook = await fetch(`${url}/api/webhooks/email/cf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'message/rfc822',
        'X-NonePwd-Timestamp': ts,
        'X-NonePwd-Signature': 'v1=deadbeef',
      },
      body: 'From: a@b.com\r\nTo: c@d.com\r\nSubject: Hi\r\n\r\nCode 123456',
    });
    expect(badWebhook.status).toBe(401);

    // CF Worker Mode 1: Raw HMAC MIME forwarding
    const forwardSpy = vi.fn(async () => {});
    const msg1: EmailMessageLike = {
      from: 'no-reply@cursor.com',
      to: alias.address,
      raw: streamFromText(
        [
          'From: Cursor <no-reply@cursor.com>',
          `To: ${alias.address}`,
          'Subject: Sign in to Cursor',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Your one-time verification code is 519382.',
        ].join('\r\n')
      ),
      forward: forwardSpy,
    };
    const res1 = await processIncomingEmail(msg1, {
      NONEPWD_SERVER_URL: url,
      WEBHOOK_SECRET: account.cfWebhookSecret,
      FORWARD_TO_EMAIL: 'primary@gmail.com',
    });
    expect(res1.status).toBe(200);
    expect(forwardSpy).toHaveBeenCalledWith('primary@gmail.com');

    // CF Worker Mode 2: Edge Zero-Knowledge X25519 sealing
    const msg2: EmailMessageLike = {
      from: 'no-reply@linear.app',
      to: 'linear.z1a2b@mail.example.com',
      raw: streamFromText(
        [
          'From: Linear <no-reply@linear.app>',
          'To: linear.z1a2b@mail.example.com',
          'Subject: Linear Login Code: 904211',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Enter code 904211 to continue.',
        ].join('\r\n')
      ),
      forward: async () => {},
    };
    const res2 = await processIncomingEmail(msg2, {
      NONEPWD_SERVER_URL: url,
      WEBHOOK_SECRET: account.cfWebhookSecret,
      RECIPIENT_X25519_PUBLIC_KEY: emailKp.publicKeyB64,
    });
    expect(res2.status).toBe(200);

    // Wait briefly for both WS frames
    await vi.waitFor(() => {
      expect(wsEmails.length).toBeGreaterThanOrEqual(2);
    });

    const openedCodes = await Promise.all(
      wsEmails.map(async (em) =>
        (await openSealedJson<DecryptedEmailPayload>(emailKp.privateKeyPkcs8B64, em.sealedEnvelope))
          .otpCode
      )
    );
    expect(openedCodes).toContain('519382');
    expect(openedCodes).toContain('904211');

    // Disable alias and verify incoming mail is dropped with 202 alias_disabled
    await fetch(`${url}/api/aliases/${alias.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ enabled: false }),
    });

    const rawMime = 'From: Cursor <no-reply@cursor.com>\r\nTo: cursor.k9x2m@mail.example.com\r\nSubject: Code\r\n\r\nCode: 519382';
    const sigHex = crypto
      .createHmac('sha256', account.cfWebhookSecret)
      .update(`${ts}.`)
      .update(rawMime)
      .digest('hex');

    const droppedRes = await fetch(`${url}/api/webhooks/email/cf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'message/rfc822',
        'X-NonePwd-Timestamp': ts,
        'X-NonePwd-Signature': `v1=${sigHex}`,
        'X-NonePwd-Envelope-To': alias.address,
      },
      body: rawMime,
    });
    expect(droppedRes.status).toBe(202);
    expect(await droppedRes.json()).toEqual({ accepted: false, reason: 'alias_disabled' });

    ws.close();
  });

  it('validates and enforces email-filter rules (otpOnly, allow, deny, edge_sealed to+hasOtp, sync)', async () => {
    const { url } = await spawnRustServer();

    const sk = generateSecretKey();
    const salt = toBase64Url(randomBytes(16));
    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      'FilterPass#1',
      sk,
      salt,
      10_000
    );
    const emailKp = await generateEmailKeyPair();
    const encryptedRootKeyset = await encryptJson(
      masterUnlockKeyBytes,
      {
        rootKeyB64: toBase64Url(generateRawAesKey()),
        emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
      },
      AAD.ROOT_KEYSET
    );

    const setupRes = await fetch(`${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'filter@example.com',
        kdfSalt: salt,
        kdfIterations: 10_000,
        authVerifier: authVerifierB64,
        encryptedRootKeyset,
        emailPublicKey: emailKp.publicKeyB64,
      }),
    });
    const { token, account } = (await setupRes.json()) as {
      token: string;
      account: { cfWebhookSecret: string };
    };

    // Default filter is disabled
    const getInitial = await fetch(`${url}/api/email-filter`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getInitial.status).toBe(200);
    expect(await getInitial.json()).toEqual({
      enabled: false,
      otpOnly: false,
      mode: 'allow',
      rules: [],
    });

    // Invalid regex rejected with 400
    const badRegexRes = await fetch(`${url}/api/email-filter`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        enabled: true,
        otpOnly: false,
        mode: 'allow',
        rules: [{ id: 'r1', field: 'from', pattern: '(unclosed[', enabled: true }],
      }),
    });
    expect(badRegexRes.status).toBe(400);

    // 1) Allow-mode + otpOnly
    const allowCfg = {
      enabled: true,
      otpOnly: true,
      mode: 'allow',
      rules: [
        { id: 'r_from', field: 'from', pattern: '@github\\.com$', enabled: true },
        { id: 'r_to', field: 'to', pattern: '^alerts@', enabled: true },
      ],
    };
    const putAllow = await fetch(`${url}/api/email-filter`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(allowCfg),
    });
    expect(putAllow.status).toBe(200);

    // Sync includes emailFilter
    const syncRes = await fetch(`${url}/api/sync`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const syncData = (await syncRes.json()) as { emailFilter: typeof allowCfg };
    expect(syncData.emailFilter).toEqual(allowCfg);

    // Non-OTP mail from allowed sender -> dropped (202 filtered)
    const noOtpRes = await fetch(`${url}/api/emails/simulate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: 'GitHub <noreply@github.com>',
        to: 'me@example.com',
        subject: 'Weekly digest',
        text: 'Check out trending repositories this week.',
      }),
    });
    expect(noOtpRes.status).toBe(202);
    expect(await noOtpRes.json()).toEqual({ accepted: false, reason: 'filtered' });

    // OTP mail from non-allowed sender -> dropped (202 filtered)
    const wrongSenderRes = await fetch(`${url}/api/emails/simulate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: 'Unknown <noreply@random.org>',
        to: 'me@example.com',
        subject: 'Verification code',
        text: 'Your verification code is 314159.',
      }),
    });
    expect(wrongSenderRes.status).toBe(202);
    expect(await wrongSenderRes.json()).toEqual({ accepted: false, reason: 'filtered' });

    // OTP mail from GitHub -> accepted (201)
    const okRes = await fetch(`${url}/api/emails/simulate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: 'GitHub <noreply@github.com>',
        to: 'me@example.com',
        subject: 'Verification code',
        text: 'Your verification code is 271828.',
      }),
    });
    expect(okRes.status).toBe(201);

    // Edge-sealed CF mail: only `to` rules + hasOtp apply
    const sealedEnvelope = await sealJsonForPublicKey(emailKp.publicKeyB64, {
      from: 'Other <noreply@other.org>',
      to: 'alerts@example.com',
      subject: 'OTP',
      snippet: 'Code 112233',
      textBody: 'Code 112233',
      otpCode: '112233',
      confidence: 0.95,
      magicLink: null,
      senderDomain: 'other.org',
      receivedAt: new Date().toISOString(),
    });
    const ts = String(Math.floor(Date.now() / 1000));

    const edgeDropBody = JSON.stringify({
      mode: 'edge_sealed',
      envelopeTo: 'other@example.com',
      hasOtp: true,
      sealedEnvelope,
    });
    const edgeDropSig = crypto
      .createHmac('sha256', account.cfWebhookSecret)
      .update(`${ts}.`)
      .update(edgeDropBody)
      .digest('hex');
    const edgeDropRes = await fetch(`${url}/api/webhooks/email/cf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NonePwd-Timestamp': ts,
        'X-NonePwd-Signature': `v1=${edgeDropSig}`,
      },
      body: edgeDropBody,
    });
    expect(edgeDropRes.status).toBe(202);
    expect(await edgeDropRes.json()).toEqual({ accepted: false, reason: 'filtered' });

    const edgeOkBody = JSON.stringify({
      mode: 'edge_sealed',
      envelopeTo: 'alerts@example.com',
      hasOtp: true,
      sealedEnvelope,
    });
    const edgeOkSig = crypto
      .createHmac('sha256', account.cfWebhookSecret)
      .update(`${ts}.`)
      .update(edgeOkBody)
      .digest('hex');
    const edgeOkRes = await fetch(`${url}/api/webhooks/email/cf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NonePwd-Timestamp': ts,
        'X-NonePwd-Signature': `v1=${edgeOkSig}`,
      },
      body: edgeOkBody,
    });
    expect(edgeOkRes.status).toBe(200);

    // 2) Deny-mode rule on subject
    await fetch(`${url}/api/email-filter`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        enabled: true,
        otpOnly: false,
        mode: 'deny',
        rules: [{ id: 'r_deny', field: 'subject', pattern: '(?i)unsubscribe|promo', enabled: true }],
      }),
    });

    const deniedPromo = await fetch(`${url}/api/emails/simulate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: 'Store <news@store.com>',
        to: 'me@example.com',
        subject: 'Big Promo Sale',
        text: '50% off today',
      }),
    });
    expect(deniedPromo.status).toBe(202);
    expect(await deniedPromo.json()).toEqual({ accepted: false, reason: 'filtered' });

    const allowedNormal = await fetch(`${url}/api/emails/simulate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: 'Team <ops@company.com>',
        to: 'me@example.com',
        subject: 'Deployment finished',
        text: 'All checks passed.',
      }),
    });
    expect(allowedNormal.status).toBe(201);
  });

  it('serves CLI install script, binary downloads, static SPA fallback, and blocks path traversal', async () => {
    const webDir = makeTempDir('np-web-spa-');
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>NonePwd Web</title>');
    const { url } = await spawnRustServer({ webDist: webDir, extraCleanupDirs: [webDir] });

    const installRes = await fetch(`${url}/install.sh`);
    expect(installRes.status).toBe(200);
    expect(await installRes.text()).toContain('/downloads/np-');

    const badDownload = await fetch(`${url}/downloads/..%2F..%2Fetc%2Fpasswd`);
    expect(badDownload.status).toBe(404);

    // Send raw un-normalized path traversal probes over TCP (WHATWG `fetch` resolves dot-segments client-side)
    const parsedUrl = new URL(url);
    const sendRawGetStatus = (rawTargetPath: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const sock = net.createConnection(
          { host: parsedUrl.hostname, port: Number(parsedUrl.port) },
          () => {
            sock.write(
              `GET ${rawTargetPath} HTTP/1.1\r\nHost: ${parsedUrl.host}\r\nConnection: close\r\n\r\n`
            );
          }
        );
        let resp = '';
        sock.setEncoding('utf8');
        sock.on('data', (chunk: string) => {
          resp += chunk;
        });
        sock.on('error', reject);
        sock.on('end', () => {
          const statusMatch = resp.match(/^HTTP\/1\.[01]\s+(\d{3})/);
          resolve(statusMatch ? Number(statusMatch[1]) : 0);
        });
      });

    expect(await sendRawGetStatus('/%2e%2e/%2e%2e/etc/passwd')).toBe(404);
    expect(await sendRawGetStatus('/../../etc/passwd')).toBe(404);

    const spaRes = await fetch(`${url}/vault/settings`);
    expect(spaRes.status).toBe(200);
    expect(await spaRes.text()).toContain('NonePwd Web');

    const hostArch = process.arch === 'x64' ? 'x86_64' : process.arch;
    const binRes = await fetch(`${url}/downloads/np-${process.platform}-${hostArch}`);
    expect(binRes.status).toBe(200);
    const binBuf = await binRes.arrayBuffer();
    expect(binBuf.byteLength).toBeGreaterThan(100_000);

    const extZipRes = await fetch(`${url}/downloads/nonepwd-extension.zip`);
    expect(extZipRes.status).toBe(200);
    const extBytes = new Uint8Array(await extZipRes.arrayBuffer());
    expect(extBytes.byteLength).toBeGreaterThan(100_000);
    expect(extBytes[0]).toBe(0x50);
    expect(extBytes[1]).toBe(0x4b);
    expect(extBytes[2]).toBe(0x03);
    expect(extBytes[3]).toBe(0x04);
  });

  it('opens a copy of a SQLite DB created by the legacy Node server with full scrypt & session compatibility', async () => {
    const nodeDir = makeTempDir('np-legacy-node-');
    const copyDir = path.join(os.tmpdir(), `np-legacy-copy-${randomId()}`);

    const legacySrv = createNonePwdServer({ dataDir: nodeDir });
    const sk = generateSecretKey();
    const salt = toBase64Url(randomBytes(16));
    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      'LegacyNodePass#9',
      sk,
      salt,
      10_000
    );
    const rootKey = generateRawAesKey();
    const emailKp = await generateEmailKeyPair();
    const vaultId = randomId();
    const vaultKey = generateRawAesKey();

    const setupRes = await legacySrv.app.request('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'legacy@example.com',
        kdfSalt: salt,
        kdfIterations: 10_000,
        authVerifier: authVerifierB64,
        encryptedRootKeyset: await encryptJson(
          masterUnlockKeyBytes,
          { rootKeyB64: toBase64Url(rootKey), emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64 },
          AAD.ROOT_KEYSET
        ),
        emailPublicKey: emailKp.publicKeyB64,
        aliasDomain: 'legacy.example.com',
        vaults: [
          {
            id: vaultId,
            encryptedKey: await encryptBytes(rootKey, vaultKey, AAD.vaultOwnerKey(vaultId)),
            encryptedMeta: await encryptJson(vaultKey, { name: 'LegacyVault' }, AAD.vaultMeta(vaultId)),
          },
        ],
      }),
    });
    expect(setupRes.status).toBe(201);
    const { token: nodeSessionToken } = (await setupRes.json()) as { token: string };

    // Store an encrypted local IMAP secret via Node's `.server_key` + `s1.iv.tag.ct`
    await legacySrv.app.request('/api/imap', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${nodeSessionToken}`,
      },
      body: JSON.stringify({
        enabled: false,
        host: 'imap.legacy.example.com',
        port: 993,
        tls: true,
        username: 'legacy@example.com',
        password: 'super-secret-imap-pass',
      }),
    });

    await legacySrv.close();
    fs.cpSync(nodeDir, copyDir, { recursive: true });

    const { url } = await spawnRustServer({
      dataDir: copyDir,
      extraCleanupDirs: [nodeDir],
    });

    const paramsRes = await fetch(`${url}/api/auth/params`);
    expect(paramsRes.status).toBe(200);
    expect(await paramsRes.json()).toEqual({
      initialized: true,
      kdfSalt: salt,
      kdfIterations: 10_000,
    });

    // Existing Node session token works directly against Rust server
    const syncRes = await fetch(`${url}/api/sync`, {
      headers: { Authorization: `Bearer ${nodeSessionToken}` },
    });
    expect(syncRes.status).toBe(200);
    const syncJson = (await syncRes.json()) as {
      vaults: Array<{ id: string }>;
      imapStatus: { hasPassword: boolean; host: string };
    };
    expect(syncJson.vaults.map((v) => v.id)).toEqual([vaultId]);
    expect(syncJson.imapStatus.hasPassword).toBe(true);
    expect(syncJson.imapStatus.host).toBe('imap.legacy.example.com');

    // Fresh login verifies against Node's scrypt s1$salt$hash
    const loginRes = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authVerifier: authVerifierB64 }),
    });
    expect(loginRes.status).toBe(200);
  });
});
