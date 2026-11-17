import crypto from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AAD,
  deriveAccountKeys,
  encryptJson,
  decryptJson,
  generateEmailKeyPair,
  generateRawAesKey,
  generateSecretKey,
  openSealedJson,
  randomBytes,
  sealJsonForPublicKey,
  setNonePwdWasmModule,
  toBase64Url,
  utf8Encode,
  type DecryptedEmailPayload,
  type EncryptedEmailRecord,
  type EncryptedItemRecord,
  type ImapAccountPublic,
  type ImapConfigPublic,
  type VaultItemPayload,
  type VaultMetadata,
} from '@nonepwd/core/worker';
import { createCfApp, runScheduledMaintenance } from '../src/app.js';
import { hashSecret, verifySecret } from '../src/auth.js';
import { handleIncomingCfEmail } from '../src/email.js';
import type { EmailMessageLike } from '../src/types.js';
import { createMockCfEnv, loadCompiledWasmModule } from './helpers.js';

const { mockConnectRef } = vi.hoisted(() => ({
  mockConnectRef: {
    fn: null as null | ((addr: { hostname: string; port: number }, opts?: unknown) => unknown),
  },
}));

vi.mock('cloudflare:sockets', () => ({
  connect(addr: { hostname: string; port: number }, opts?: unknown) {
    if (!mockConnectRef.fn) {
      throw new Error('Mock cloudflare:sockets connect handler not configured');
    }
    return mockConnectRef.fn(addr, opts);
  },
}));

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function signWebhook(secret: string, timestamp: string, rawBody: Uint8Array): Promise<string> {
  const prefix = utf8Encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + rawBody.length);
  signed.set(prefix, 0);
  signed.set(rawBody, prefix.length);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    utf8Encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, signed));
  const hex = Array.from(mac)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `v1=${hex}`;
}

beforeAll(() => {
  setNonePwdWasmModule(loadCompiledWasmModule());
});

describe('@nonepwd/cf-server', () => {
  it('verifies both WebCrypto PBKDF2 hashes and migrated Node s1 scrypt hashes', async () => {
    const pbkdf2Hash = await hashSecret('MasterSecret#1');
    expect(pbkdf2Hash.startsWith('pbkdf2$100000$')).toBe(true);
    expect(await verifySecret('MasterSecret#1', pbkdf2Hash)).toBe(true);
    expect(await verifySecret('WrongSecret', pbkdf2Hash)).toBe(false);

    // Simulate migrated password hash created by local Node / Rust `np server`
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync('LegacyVerifier', salt, 32);
    const s1Hash = `s1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
    expect(await verifySecret('LegacyVerifier', s1Hash)).toBe(true);
    expect(await verifySecret('BadVerifier', s1Hash)).toBe(false);
  });

  it('runs full zero-knowledge vault lifecycle, direct CF email routing, R2 snapshots, and recovery', async () => {
    const { env, bucket, broadcasts } = createMockCfEnv();
    const app = createCfApp();

    const api = async (path: string, init?: RequestInit) =>
      app.fetch(
        new Request(`https://vault.example.com${path}`, init),
        env
      );

    // 1. Health & uninitialized auth params
    const healthRes = await api('/api/health');
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      initialized: boolean;
      runtime: string;
      storage: { d1: boolean; r2: boolean; durableObjects: boolean };
    };
    expect(health.ok).toBe(true);
    expect(health.initialized).toBe(false);
    expect(health.runtime).toBe('cloudflare-workers');
    expect(health.storage).toEqual({ d1: true, r2: true, durableObjects: true });

    const paramsEmpty = await (await api('/api/auth/params')).json();
    expect(paramsEmpty).toEqual({ initialized: false });

    // 2. Zero-knowledge setup (client-side KDF + X25519 keygen)
    const secretKey = generateSecretKey();
    const kdfSalt = toBase64Url(randomBytes(16));
    const masterPassword = 'CfMasterPassword!99';
    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      masterPassword,
      secretKey,
      kdfSalt,
      10_000
    );

    const rootKey = generateRawAesKey();
    const emailKp = await generateEmailKeyPair();
    const encryptedRootKeyset = await encryptJson(
      masterUnlockKeyBytes,
      {
        rootKeyB64: toBase64Url(rootKey),
        emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
      },
      AAD.ROOT_KEYSET
    );

    const personalVaultId = 'v_personal';
    const personalVaultKey = generateRawAesKey();
    const personalEncryptedKey = await encryptJson(
      rootKey,
      { vaultKeyB64: toBase64Url(personalVaultKey) },
      AAD.vaultOwnerKey(personalVaultId)
    );
    const personalEncryptedMeta = await encryptJson(
      personalVaultKey,
      { name: 'Personal' } satisfies VaultMetadata,
      AAD.vaultMeta(personalVaultId)
    );

    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.com',
        kdfSalt,
        kdfIterations: 10_000,
        authVerifier: authVerifierB64,
        encryptedRootKeyset,
        emailPublicKey: emailKp.publicKeyB64,
        aliasDomain: 'mail.example.com',
        vaults: [
          {
            id: personalVaultId,
            encryptedKey: personalEncryptedKey,
            encryptedMeta: personalEncryptedMeta,
          },
        ],
      }),
    });
    expect(setupRes.status).toBe(201);
    const { token: initialToken, account } = (await setupRes.json()) as {
      token: string;
      account: { cfWebhookSecret: string; aliasDomain: string };
    };
    expect(account.aliasDomain).toBe('mail.example.com');

    // Wrong password rejected; valid login returns new session token
    const paramsAfterSetup = (await (await api('/api/auth/params')).json()) as {
      initialized: boolean;
      email?: string;
      kdfSalt?: string;
      kdfIterations?: number;
    };
    expect(paramsAfterSetup).toEqual({
      initialized: true,
      kdfSalt,
      kdfIterations: 10_000,
    });
    expect(paramsAfterSetup.email).toBeUndefined();

    const badLoginRes = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authVerifier: 'wrong-verifier' }),
    });
    expect(badLoginRes.status).toBe(401);

    const logoutRes = await api('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${initialToken}` },
    });
    expect(logoutRes.status).toBe(200);

    const afterLogoutSync = await api('/api/sync', {
      headers: { Authorization: `Bearer ${initialToken}` },
    });
    expect(afterLogoutSync.status).toBe(401);

    const loginRes = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authVerifier: authVerifierB64 }),
    });
    expect(loginRes.status).toBe(200);
    const { token } = (await loginRes.json()) as { token: string };

    // 3. Item CRUD & batch import + Second Vault isolation for Service Account
    const devopsVaultId = 'v_devops';
    const devopsVaultKey = generateRawAesKey();
    await api('/api/vaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: devopsVaultId,
        encryptedKey: await encryptJson(
          rootKey,
          { vaultKeyB64: toBase64Url(devopsVaultKey) },
          AAD.vaultOwnerKey(devopsVaultId)
        ),
        encryptedMeta: await encryptJson(
          devopsVaultKey,
          { name: 'DevOps' } satisfies VaultMetadata,
          AAD.vaultMeta(devopsVaultId)
        ),
      }),
    });

    const personalItem: VaultItemPayload = {
      id: 'item_gh',
      vaultId: personalVaultId,
      category: 'login',
      title: 'GitHub',
      favorite: true,
      tags: ['dev'],
      urls: ['https://github.com'],
      username: 'alice',
      password: 'gh-secret-password',
      customFields: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const devopsItem: VaultItemPayload = {
      id: 'item_openai',
      vaultId: devopsVaultId,
      category: 'api_credential',
      title: 'OpenAI',
      favorite: false,
      tags: [],
      urls: [],
      password: 'sk-cf-test-key',
      customFields: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const batchRes = await api(`/api/vaults/${personalVaultId}/items/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        items: [
          {
            id: personalItem.id,
            encryptedData: await encryptJson(
              personalVaultKey,
              personalItem,
              AAD.vaultItem(personalVaultId, personalItem.id)
            ),
          },
        ],
      }),
    });
    expect(batchRes.status).toBe(201);

    const createDevopsItemRes = await api(`/api/vaults/${devopsVaultId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: devopsItem.id,
        encryptedData: await encryptJson(
          devopsVaultKey,
          devopsItem,
          AAD.vaultItem(devopsVaultId, devopsItem.id)
        ),
      }),
    });
    expect(createDevopsItemRes.status).toBe(201);

    // Create Service Account scoped ONLY to DevOps vault
    const saSecret = 'sa-secret-cf';
    const saWrapKey = generateRawAesKey();
    const createSaRes = await api('/api/service-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: 'sa_ci',
        name: 'ci-runner',
        authSecret: saSecret,
        vaultKeys: [
          {
            vaultId: devopsVaultId,
            encryptedVaultKey: await encryptJson(
              saWrapKey,
              { vaultKeyB64: toBase64Url(devopsVaultKey) },
              AAD.vaultSaKey(devopsVaultId, 'sa_ci')
            ),
          },
        ],
      }),
    });
    expect(createSaRes.status).toBe(201);

    const saAuthRes = await api('/api/auth/service-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId: 'sa_ci', authSecret: saSecret }),
    });
    expect(saAuthRes.status).toBe(200);
    const { token: saToken } = (await saAuthRes.json()) as { token: string };

    const saSync = (await (
      await api('/api/sync', { headers: { Authorization: `Bearer ${saToken}` } })
    ).json()) as { kind: string; vaults: Array<{ id: string }>; items: EncryptedItemRecord[] };
    expect(saSync.kind).toBe('service_account');
    expect(saSync.vaults.map((v) => v.id)).toEqual([devopsVaultId]);
    expect(saSync.items.map((i) => i.id)).toEqual(['item_openai']);

    // 4. Email Filter configuration + Direct Cloudflare Email Routing + R2 archive + WS broadcast
    const putFilterRes = await api('/api/email-filter', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        enabled: true,
        otpOnly: true,
        mode: 'allow',
        rules: [
          {
            id: 'rule_gh',
            field: 'from',
            pattern: '@(github\\.com|linear\\.app)$',
            enabled: true,
          },
        ],
      }),
    });
    expect(putFilterRes.status).toBe(200);
    const savedFilter = await putFilterRes.json();
    expect(savedFilter.otpOnly).toBe(true);

    // Direct Cloudflare Email Routing message matching allowlist + OTP
    const forwardSpy = vi.fn(async () => {});
    const validMsg: EmailMessageLike = {
      from: 'noreply@github.com',
      to: 'gh.k9x2@mail.example.com',
      raw: streamFromText(
        [
          'From: GitHub <noreply@github.com>',
          'To: gh.k9x2@mail.example.com',
          'Subject: [GitHub] Verification code',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Your GitHub sudo code is 742915.',
        ].join('\r\n')
      ),
      forward: forwardSpy,
    };

    const ingest1 = await handleIncomingCfEmail(validMsg, {
      ...env,
      FORWARD_TO_EMAIL: 'personal@gmail.com',
    });
    expect(ingest1.accepted).toBe(true);
    expect(forwardSpy).toHaveBeenCalledWith('personal@gmail.com');
    expect(bucket.keys().some((k) => k.startsWith('emails/') && k.endsWith('.json'))).toBe(true);
    expect(broadcasts.some((b) => b.event.type === 'email.received')).toBe(true);

    // Filtered out email (unknown sender)
    const blockedMsg: EmailMessageLike = {
      from: 'promo@spam.example.org',
      to: 'gh.k9x2@mail.example.com',
      raw: streamFromText(
        [
          'From: Promo <promo@spam.example.org>',
          'To: gh.k9x2@mail.example.com',
          'Subject: Sale 50% off',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Use code 123456 today.',
        ].join('\r\n')
      ),
      forward: async () => {},
    };
    const ingest2 = await handleIncomingCfEmail(blockedMsg, env);
    expect(ingest2.accepted).toBe(false);
    expect(ingest2.reason).toBe('filtered');

    // HMAC webhook endpoint with pre-sealed JSON
    const sealedEnvelope = await sealJsonForPublicKey(emailKp.publicKeyB64, {
      from: 'noreply@linear.app',
      to: 'linear.x1@mail.example.com',
      subject: 'Linear verification',
      snippet: 'Code 619204',
      textBody: 'Your Linear verification code is 619204',
      otpCode: '619204',
      confidence: 0.99,
      magicLink: null,
      senderDomain: 'linear.app',
      receivedAt: new Date().toISOString(),
    } satisfies DecryptedEmailPayload);

    const ts = String(Math.floor(Date.now() / 1000));
    const hookBody = utf8Encode(
      JSON.stringify({
        mode: 'edge_sealed',
        envelopeFrom: 'noreply@linear.app',
        envelopeTo: 'linear.x1@mail.example.com',
        hasOtp: true,
        sealedEnvelope,
      })
    );
    const sig = await signWebhook(account.cfWebhookSecret, ts, hookBody);
    const hookRes = await api('/api/webhooks/email/cf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NonePwd-Timestamp': ts,
        'X-NonePwd-Signature': sig,
      },
      body: hookBody,
    });
    expect(hookRes.status).toBe(200);

    const emailsRes = (await (
      await api('/api/emails', { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { emails: EncryptedEmailRecord[] };
    expect(emailsRes.emails).toHaveLength(2);
    const codes = await Promise.all(
      emailsRes.emails.map(
        async (em) =>
          (await openSealedJson<DecryptedEmailPayload>(emailKp.privateKeyPkcs8B64, em.sealedEnvelope))
            .otpCode
      )
    );
    expect(codes).toContain('742915');
    expect(codes).toContain('619204');

    // 5. R2 Zero-Knowledge Snapshots: manual create, cron scheduled backup, item deletion & recovery
    const createBackupRes = await api('/api/backups', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(createBackupRes.status).toBe(201);
    const { backup } = (await createBackupRes.json()) as {
      backup: { key: string; vaultCount: number; itemCount: number; emailCount: number };
    };
    expect(backup.vaultCount).toBe(2);
    expect(backup.itemCount).toBe(2);
    expect(backup.emailCount).toBe(2);

    // Scheduled cron creates an additional backup snapshot
    await runScheduledMaintenance(env);

    const listBackupsRes = (await (
      await api('/api/backups', { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { enabled: boolean; backups: Array<{ key: string }> };
    expect(listBackupsRes.enabled).toBe(true);
    expect(listBackupsRes.backups.length).toBeGreaterThanOrEqual(2);

    // Delete item_gh from D1, then restore from backup and verify decrypted recovery!
    const delItemRes = await api(`/api/vaults/${personalVaultId}/items/item_gh`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delItemRes.status).toBe(200);

    const afterDelSync = (await (
      await api('/api/sync', { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { items: EncryptedItemRecord[] };
    expect(afterDelSync.items).toHaveLength(1);

    const restoreRes = await api('/api/backups/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ key: backup.key }),
    });
    expect(restoreRes.status).toBe(200);
    const restoreJson = (await restoreRes.json()) as {
      restored: boolean;
      itemCount: number;
    };
    expect(restoreJson.restored).toBe(true);
    expect(restoreJson.itemCount).toBe(2);
    expect(broadcasts.some((b) => b.event.type === 'vault.restored')).toBe(true);

    const afterRestoreSync = (await (
      await api('/api/sync', { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { items: EncryptedItemRecord[] };
    expect(afterRestoreSync.items).toHaveLength(2);
    const restoredGh = afterRestoreSync.items.find((i) => i.id === 'item_gh')!;
    const decryptedGh = await decryptJson<VaultItemPayload>(
      personalVaultKey,
      restoredGh.encryptedData,
      AAD.vaultItem(personalVaultId, 'item_gh')
    );
    expect(decryptedGh.password).toBe('gh-secret-password');

    // Delete snapshot from R2
    const delBackupRes = await api(`/api/backups/${encodeURIComponent(backup.key)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delBackupRes.status).toBe(200);

    // 6. IMAP configuration persistence & encrypted password storage in D1
    const getImapInitial = await api('/api/imap', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getImapInitial.status).toBe(200);
    expect(await getImapInitial.json()).toEqual({
      imap: {
        enabled: false,
        host: '',
        port: 993,
        tls: true,
        username: '',
        hasPassword: false,
        status: 'disabled',
        lastError: null,
      },
      accounts: [],
    });

    const putImapRes = await api('/api/imap', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        enabled: false,
        host: 'imap.qq.com',
        port: 993,
        tls: true,
        username: 'user@qq.com',
        password: 'app-password-16chars',
      }),
    });
    expect(putImapRes.status).toBe(200);
    const putImapJson = (await putImapRes.json()) as {
      imap: {
        enabled: boolean;
        host: string;
        port: number;
        tls: boolean;
        username: string;
        hasPassword: boolean;
        status: string;
      };
    };
    expect(putImapJson.imap).toMatchObject({
      enabled: false,
      host: 'imap.qq.com',
      port: 993,
      tls: true,
      username: 'user@qq.com',
      hasPassword: true,
      status: 'disabled',
    });
  });

  it('ingests Cloudflare Access One-Time PIN emails when otpOnly is enabled', async () => {
    const { env, broadcasts } = createMockCfEnv();
    const app = createCfApp();

    const api = async (path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://vault.example.com${path}`, init), env);

    const secretKey = generateSecretKey();
    const kdfSalt = toBase64Url(randomBytes(16));
    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      'CfAccessTest!99',
      secretKey,
      kdfSalt,
      10_000
    );
    const rootKey = generateRawAesKey();
    const emailKp = await generateEmailKeyPair();
    const encryptedRootKeyset = await encryptJson(
      masterUnlockKeyBytes,
      {
        rootKeyB64: toBase64Url(rootKey),
        emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
      },
      AAD.ROOT_KEYSET
    );
    const vaultId = 'v_cf_otp';
    const vaultKey = generateRawAesKey();
    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.com',
        kdfSalt,
        kdfIterations: 10_000,
        authVerifier: authVerifierB64,
        encryptedRootKeyset,
        emailPublicKey: emailKp.publicKeyB64,
        aliasDomain: 'mail.example.com',
        vaults: [
          {
            id: vaultId,
            encryptedKey: await encryptJson(
              rootKey,
              { vaultKeyB64: toBase64Url(vaultKey) },
              AAD.vaultOwnerKey(vaultId)
            ),
            encryptedMeta: await encryptJson(
              vaultKey,
              { name: 'Personal' } satisfies VaultMetadata,
              AAD.vaultMeta(vaultId)
            ),
          },
        ],
      }),
    });
    expect(setupRes.status).toBe(201);
    const { token } = (await setupRes.json()) as { token: string };

    const putFilterRes = await api('/api/email-filter', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        enabled: true,
        otpOnly: true,
        mode: 'allow',
        rules: [
          {
            id: 'rule_cf',
            field: 'from',
            pattern: '@notify\\.cloudflare\\.com$',
            enabled: true,
          },
        ],
      }),
    });
    expect(putFilterRes.status).toBe(200);

    const boundary = 'cf_boundary_123';
    const cfHtmlMsg: EmailMessageLike = {
      from: 'no-reply@notify.cloudflare.com',
      to: 'cf.user@mail.example.com',
      raw: streamFromText(
        [
          'From: Cloudflare <no-reply@notify.cloudflare.com>',
          'To: cf.user@mail.example.com',
          'Subject: Your Cloudflare Access one-time PIN',
          'MIME-Version: 1.0',
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Please view this message in an HTML-capable email client. Cloudflare, Inc. 101 Townsend St, San Francisco, CA 94107',
          `--${boundary}`,
          'Content-Type: text/html; charset=utf-8',
          '',
          '<html><body><table><tr><td>Your Cloudflare Access one-time PIN</td></tr><tr><td>To finish logging in, enter this code:</td></tr><tr><td>482910</td></tr><tr><td>101 Townsend St, San Francisco, CA 94107</td></tr></table></body></html>',
          `--${boundary}--`,
          '',
        ].join('\r\n')
      ),
      forward: async () => {},
    };

    const htmlIngest = await handleIncomingCfEmail(cfHtmlMsg, env);
    expect(htmlIngest.accepted).toBe(true);
    expect(htmlIngest.email?.hasOtp).toBe(true);
    const openedHtml = await openSealedJson<DecryptedEmailPayload>(
      emailKp.privateKeyPkcs8B64,
      htmlIngest.email!.sealedEnvelope
    );
    expect(openedHtml.otpCode).toBe('482910');
    expect(openedHtml.confidence).toBeGreaterThan(0.5);
    expect(openedHtml.senderDomain).toBe('cloudflare.com');

    const cfInlineMsg: EmailMessageLike = {
      from: 'no-reply@notify.cloudflare.com',
      to: 'cf.user@mail.example.com',
      raw: streamFromText(
        [
          'From: Cloudflare <no-reply@notify.cloudflare.com>',
          'To: cf.user@mail.example.com',
          'Subject: Your one-time PIN',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Use the following code to finish logging in: 739154. Cloudflare, Inc. 101 Townsend St, San Francisco, CA 94107',
        ].join('\r\n')
      ),
      forward: async () => {},
    };

    const inlineIngest = await handleIncomingCfEmail(cfInlineMsg, env);
    expect(inlineIngest.accepted).toBe(true);
    expect(inlineIngest.email?.hasOtp).toBe(true);
    const openedInline = await openSealedJson<DecryptedEmailPayload>(
      emailKp.privateKeyPkcs8B64,
      inlineIngest.email!.sealedEnvelope
    );
    expect(openedInline.otpCode).toBe('739154');
    expect(openedInline.confidence).toBeGreaterThan(0.5);

    const nonOtpMsg: EmailMessageLike = {
      from: 'no-reply@notify.cloudflare.com',
      to: 'cf.user@mail.example.com',
      raw: streamFromText(
        [
          'From: Cloudflare <no-reply@notify.cloudflare.com>',
          'To: cf.user@mail.example.com',
          'Subject: Account notice',
          'Content-Type: text/plain; charset=utf-8',
          '',
          'Cloudflare, Inc. 101 Townsend St, San Francisco, CA 94107',
        ].join('\r\n')
      ),
      forward: async () => {},
    };

    const nonOtpIngest = await handleIncomingCfEmail(nonOtpMsg, env);
    expect(nonOtpIngest.accepted).toBe(false);
    expect(nonOtpIngest.reason).toBe('filtered');

    const emailsRes = (await (
      await api('/api/emails', { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { emails: EncryptedEmailRecord[] };
    expect(emailsRes.emails).toHaveLength(2);
    expect(broadcasts.filter((b) => b.event.type === 'email.received')).toHaveLength(2);
  });

  it('supports multi-account IMAP CRUD, password preservation, legacy migration, and per-account sync envelopeTo', async () => {
    const { env } = createMockCfEnv();
    const app = createCfApp();

    const api = async (path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://vault.example.com${path}`, init), env);

    const secretKey = generateSecretKey();
    const kdfSalt = toBase64Url(randomBytes(16));
    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      'MultiImapPass!99',
      secretKey,
      kdfSalt,
      10_000
    );
    const rootKey = generateRawAesKey();
    const emailKp = await generateEmailKeyPair();
    const encryptedRootKeyset = await encryptJson(
      masterUnlockKeyBytes,
      {
        rootKeyB64: toBase64Url(rootKey),
        emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64,
      },
      AAD.ROOT_KEYSET
    );

    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.com',
        kdfSalt,
        kdfIterations: 10_000,
        authVerifier: authVerifierB64,
        encryptedRootKeyset,
        emailPublicKey: emailKp.publicKeyB64,
        aliasDomain: 'mail.example.com',
        vaults: [],
      }),
    });
    expect(setupRes.status).toBe(201);
    const { token } = (await setupRes.json()) as { token: string };
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    // Mock cloudflare:sockets with an in-memory multi-mailbox IMAP server
    mockConnectRef.fn = () => {
      let loggedUser = '';
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      let buf = '';

      const push = (str: string) => {
        controllerRef?.enqueue(enc.encode(str));
      };

      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          push('* OK Mock IMAP Ready\r\n');
        },
      });

      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          buf += dec.decode(chunk, { stream: true });
          while (true) {
            const idx = buf.indexOf('\r\n');
            if (idx === -1) break;
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const spaceIdx = line.indexOf(' ');
            const tag = spaceIdx > 0 ? line.slice(0, spaceIdx) : 'A0001';
            const cmd = spaceIdx > 0 ? line.slice(spaceIdx + 1) : line;
            const upper = cmd.toUpperCase();

            if (upper.startsWith('LOGIN ')) {
              const match = cmd.match(/^LOGIN\s+"([^"]+)"\s+"([^"]+)"/i);
              loggedUser = match?.[1] ?? '';
              const pw = match?.[2] ?? '';
              if (
                (loggedUser === 'alice.work@gmail.com' && pw === 'work-app-pw-16') ||
                (loggedUser === 'alice.personal@gmail.com' && pw === 'personal-app-pw-16')
              ) {
                push(`${tag} OK LOGIN completed\r\n`);
              } else {
                push(`${tag} NO Invalid credentials\r\n`);
              }
            } else if (upper.startsWith('SELECT ')) {
              push('* 1 EXISTS\r\n');
              push(`${tag} OK [READ-WRITE] SELECT completed\r\n`);
            } else if (upper.startsWith('UID SEARCH ')) {
              push('* SEARCH 101\r\n');
              push(`${tag} OK SEARCH completed\r\n`);
            } else if (upper.startsWith('UID FETCH 101')) {
              const code = loggedUser === 'alice.work@gmail.com' ? '111222' : '333444';
              const mime = [
                'From: Security <noreply@service.example.com>',
                'To: undisclosed-recipients:;',
                'Subject: Login verification code',
                'Content-Type: text/plain; charset=utf-8',
                '',
                `Your verification code is ${code}.`,
                '',
              ].join('\r\n');
              const byteLen = enc.encode(mime).byteLength;
              push(`* 1 FETCH (UID 101 BODY[] {${byteLen}}\r\n${mime})\r\n`);
              push(`${tag} OK FETCH completed\r\n`);
            } else if (upper === 'LOGOUT') {
              push('* BYE\r\n');
              push(`${tag} OK LOGOUT completed\r\n`);
            } else {
              push(`${tag} OK\r\n`);
            }
          }
        },
      });

      return {
        readable,
        writable,
        async close() {
          try {
            controllerRef?.close();
          } catch {
            // ignore
          }
        },
      };
    };

    try {
      // Creating without password must fail with 400
      const missingPwRes = await api('/api/imap/accounts', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          host: 'imap.gmail.com',
          port: 993,
          tls: true,
          username: 'alice.work@gmail.com',
        }),
      });
      expect(missingPwRes.status).toBe(400);

      // 1. Create two Gmail accounts on the same IMAP host
      const createWorkRes = await api('/api/imap/accounts', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          label: 'Work Gmail',
          enabled: true,
          host: 'imap.gmail.com',
          port: 993,
          tls: true,
          username: 'alice.work@gmail.com',
          password: 'work-app-pw-16',
        }),
      });
      expect(createWorkRes.status).toBe(201);
      const createdWork = (await createWorkRes.json()) as {
        account: ImapAccountPublic;
        accounts: ImapAccountPublic[];
        imap: ImapConfigPublic;
      };
      expect(createdWork.account).toMatchObject({
        label: 'Work Gmail',
        enabled: true,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        username: 'alice.work@gmail.com',
        hasPassword: true,
        status: 'listening',
      });
      expect(createdWork.accounts).toHaveLength(1);

      const createPersonalRes = await api('/api/imap/accounts', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          enabled: true,
          host: 'imap.gmail.com',
          port: 993,
          tls: true,
          username: 'alice.personal@gmail.com',
          password: 'personal-app-pw-16',
        }),
      });
      expect(createPersonalRes.status).toBe(201);
      const createdPersonal = (await createPersonalRes.json()) as {
        account: ImapAccountPublic;
        accounts: ImapAccountPublic[];
        imap: ImapConfigPublic;
      };
      expect(createdPersonal.account.label).toBe('alice.personal');
      expect(createdPersonal.accounts).toHaveLength(2);
      expect(createdPersonal.imap.enabled).toBe(true);
      expect(createdPersonal.imap.status).toBe('listening');

      // Verify both synced emails have envelopeTo set to the receiving Gmail address despite generic To header
      const emailsAfterCreate = (await (
        await api('/api/emails', { headers: { Authorization: `Bearer ${token}` } })
      ).json()) as { emails: EncryptedEmailRecord[] };
      expect(emailsAfterCreate.emails).toHaveLength(2);
      const envelopes = emailsAfterCreate.emails.map((e) => e.envelopeTo).sort();
      expect(envelopes).toEqual(['alice.personal@gmail.com', 'alice.work@gmail.com']);

      // 2. Test saved account by id without re-sending password
      const testSavedRes = await api('/api/imap/test', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          id: createdWork.account.id,
          host: 'imap.gmail.com',
          port: 993,
          tls: true,
          username: 'alice.work@gmail.com',
        }),
      });
      expect(testSavedRes.status).toBe(200);
      expect(await testSavedRes.json()).toEqual({ ok: true, messages: 1 });

      // 3. Update one account without re-sending password (keeps password & preserves last_uid)
      const updateRes = await api(`/api/imap/accounts/${createdPersonal.account.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          label: 'Personal Gmail',
          enabled: true,
          host: 'imap.gmail.com',
          port: 993,
          tls: true,
          username: 'alice.personal@gmail.com',
        }),
      });
      expect(updateRes.status).toBe(200);
      const updatedJson = (await updateRes.json()) as {
        account: ImapAccountPublic;
        accounts: ImapAccountPublic[];
      };
      expect(updatedJson.account).toMatchObject({
        id: createdPersonal.account.id,
        label: 'Personal Gmail',
        hasPassword: true,
        status: 'listening',
      });
      const uidRow = await env.DB.prepare('SELECT last_uid FROM imap_accounts WHERE id = ?')
        .bind(createdPersonal.account.id)
        .first<{ last_uid: number }>();
      expect(uidRow?.last_uid).toBe(101);

      // 3b. Updating username/host/port resets last_uid to 0; upserting via POST with existing id keeps password
      const resetUidRes = await api(`/api/imap/accounts/${createdPersonal.account.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          enabled: false,
          host: 'imap.qq.com',
          port: 993,
          tls: true,
          username: 'alice.qq@qq.com',
        }),
      });
      expect(resetUidRes.status).toBe(200);
      const resetUidRow = await env.DB.prepare('SELECT last_uid FROM imap_accounts WHERE id = ?')
        .bind(createdPersonal.account.id)
        .first<{ last_uid: number }>();
      expect(resetUidRow?.last_uid).toBe(0);

      const upsertExistingRes = await api('/api/imap/accounts', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          id: createdPersonal.account.id,
          label: 'Personal Gmail Restored',
          enabled: true,
          host: 'imap.gmail.com',
          port: 993,
          tls: true,
          username: 'alice.personal@gmail.com',
        }),
      });
      expect(upsertExistingRes.status).toBe(200);
      const upsertedJson = (await upsertExistingRes.json()) as {
        account: ImapAccountPublic;
      };
      expect(upsertedJson.account).toMatchObject({
        id: createdPersonal.account.id,
        label: 'Personal Gmail Restored',
        hasPassword: true,
        status: 'listening',
      });

      // Legacy PUT /api/imap matches by username when multiple accounts exist
      const legacyPutMatchRes = await api('/api/imap', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          enabled: true,
          host: 'imap.gmail.com',
          port: 993,
          tls: true,
          username: 'alice.personal@gmail.com',
        }),
      });
      expect(legacyPutMatchRes.status).toBe(200);
      const legacyPutJson = (await legacyPutMatchRes.json()) as {
        accounts: ImapAccountPublic[];
      };
      expect(legacyPutJson.accounts).toHaveLength(2);

      // 4. GET /api/sync includes both imapAccounts and aggregate imapStatus
      const syncJson = (await (
        await api('/api/sync', { headers: { Authorization: `Bearer ${token}` } })
      ).json()) as {
        imapAccounts: ImapAccountPublic[];
        imapStatus: ImapConfigPublic;
      };
      expect(syncJson.imapAccounts).toHaveLength(2);
      expect(syncJson.imapAccounts.map((a) => a.username)).toEqual([
        'alice.work@gmail.com',
        'alice.personal@gmail.com',
      ]);
      expect(syncJson.imapStatus.enabled).toBe(true);
      expect(syncJson.imapStatus.status).toBe('listening');

      // 5. POST /api/imap/sync with explicit account id
      const syncOneRes = await api('/api/imap/sync', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ id: createdWork.account.id }),
      });
      expect(syncOneRes.status).toBe(200);
      const syncOneJson = (await syncOneRes.json()) as {
        ok: boolean;
        accounts: ImapAccountPublic[];
        imap: ImapConfigPublic;
      };
      expect(syncOneJson.ok).toBe(true);
      expect(syncOneJson.accounts).toHaveLength(2);

      // 6. Delete one account; missing id returns 404
      const delMissingRes = await api('/api/imap/accounts/nonexistent', {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(delMissingRes.status).toBe(404);

      const delWorkRes = await api(`/api/imap/accounts/${createdWork.account.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(delWorkRes.status).toBe(200);
      const delWorkJson = (await delWorkRes.json()) as {
        ok: boolean;
        accounts: ImapAccountPublic[];
        imap: ImapConfigPublic;
      };
      expect(delWorkJson.ok).toBe(true);
      expect(delWorkJson.accounts).toHaveLength(1);
      expect(delWorkJson.accounts[0].username).toBe('alice.personal@gmail.com');
      expect(delWorkJson.imap.username).toBe('alice.personal@gmail.com');

      // Delete remaining account and verify legacy imap_config is cleared (no zombie resurrection)
      const delPersonalRes = await api(`/api/imap/accounts/${createdPersonal.account.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(delPersonalRes.status).toBe(200);
      const afterEmptyGet = (await (
        await api('/api/imap', { headers: { Authorization: `Bearer ${token}` } })
      ).json()) as { imap: ImapConfigPublic; accounts: ImapAccountPublic[] };
      expect(afterEmptyGet.accounts).toEqual([]);
      expect(afterEmptyGet.imap.enabled).toBe(false);
      expect(afterEmptyGet.imap.status).toBe('disabled');

      // 7. Auto-migrate legacy imap_config row into 'legacy-1' when imap_accounts is empty
      await env.DB.prepare(
        `UPDATE imap_config
         SET enabled = 0, host = 'imap.163.com', port = 993, tls = 1,
             username = 'legacy_user@163.com', password_enc = 'v1:00:00', last_uid = 77, status = 'disabled'
         WHERE id = 1`
      ).run();
      const migratedGet = (await (
        await api('/api/imap', { headers: { Authorization: `Bearer ${token}` } })
      ).json()) as { imap: ImapConfigPublic; accounts: ImapAccountPublic[] };
      expect(migratedGet.accounts).toHaveLength(1);
      expect(migratedGet.accounts[0]).toMatchObject({
        id: 'legacy-1',
        label: 'legacy_user',
        enabled: false,
        host: 'imap.163.com',
        username: 'legacy_user@163.com',
        hasPassword: true,
        status: 'disabled',
      });
    } finally {
      mockConnectRef.fn = null;
    }
  });
});
