import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
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
  toBase64Url,
  type DecryptedEmailPayload,
  type EncryptedEmailRecord,
  type RootKeysetPayload,
  type VaultItemPayload,
  type VaultMetadata,
} from '@nonepwd/core';
import { createNonePwdServer, type NonePwdServerInstance } from '../src/app.js';

const servers: Array<{ srv: NonePwdServerInstance; dir: string }> = [];

async function spawnTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-srv-test-'));
  const srv = createNonePwdServer({ dataDir: dir });
  const started = await srv.start(0, '127.0.0.1');
  servers.push({ srv, dir });
  return { srv, dir, url: started.url };
}

afterEach(async () => {
  while (servers.length > 0) {
    const entry = servers.pop()!;
    await entry.srv.close();
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
});

describe('@nonepwd/server E2E', () => {
  it('enforces single-user zero-knowledge setup, login, vault/item CRUD, and service account isolation', async () => {
    const { url } = await spawnTestServer();

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

    // Wrong authVerifier must be rejected
    const badLogin = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authVerifier: 'wrong-verifier' }),
    });
    expect(badLogin.status).toBe(401);

    // Add one secret item to Personal and one to DevOps
    const pItemId = randomId();
    const pPayload: VaultItemPayload = {
      id: pItemId,
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
    await fetch(`${url}/api/vaults/${personalId}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${setupJson.token}`,
      },
      body: JSON.stringify({
        id: pItemId,
        encryptedData: await encryptJson(personalKey, pPayload, AAD.vaultItem(personalId, pItemId)),
      }),
    });

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
    await fetch(`${url}/api/vaults/${devopsId}/items`, {
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
      vaults: Array<{ id: string }>;
      items: Array<{ id: string; encryptedData: string }>;
    };
    expect(saSyncData.vaults.map((v) => v.id)).toEqual([devopsId]);
    expect(saSyncData.items.map((i) => i.id)).toEqual([dItemId]);

    const decryptedDevItem = await decryptJson<VaultItemPayload>(
      devopsKey,
      saSyncData.items[0].encryptedData,
      AAD.vaultItem(devopsId, dItemId)
    );
    expect(decryptedDevItem.password).toBe('sk-devops-secret');

    // Service Account must get 403 on Personal vault and Owner settings
    const forbiddenVault = await fetch(`${url}/api/vaults/${personalId}/items`, {
      headers: { Authorization: `Bearer ${saJson.token}` },
    });
    expect(forbiddenVault.status).toBe(403);

    const forbiddenSettings = await fetch(`${url}/api/settings`, {
      headers: { Authorization: `Bearer ${saJson.token}` },
    });
    expect(forbiddenSettings.status).toBe(403);
  });

  it('verifies CF webhook HMAC, drops disabled aliases, seals emails with X25519, and pushes via WebSocket', async () => {
    const { url } = await spawnTestServer();
    const secretKey = generateSecretKey();
    const kdfSalt = toBase64Url(randomBytes(16));
    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      'Pass#123',
      secretKey,
      kdfSalt,
      10_000
    );
    const rootKeyBytes = generateRawAesKey();
    const emailKp = await generateEmailKeyPair();
    const encryptedRootKeyset = await encryptJson(
      masterUnlockKeyBytes,
      { rootKeyB64: toBase64Url(rootKeyBytes), emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64 },
      AAD.ROOT_KEYSET
    );

    const setupRes = await fetch(`${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'me@example.com',
        kdfSalt,
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

    // Create an alias github.12345@mail.example.com
    const aliasRes = await fetch(`${url}/api/aliases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        address: 'github.12345@mail.example.com',
        siteDomain: 'github.com',
      }),
    });
    const { alias } = (await aliasRes.json()) as { alias: { id: string; address: string } };

    // Connect WebSocket
    const wsUrl = url.replace('http://', 'ws://') + `/api/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));

    const receivedPromise = new Promise<EncryptedEmailRecord>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as { type: string; email?: EncryptedEmailRecord };
        if (msg.type === 'email.received' && msg.email) {
          resolve(msg.email);
        }
      });
    });

    const rawMime = [
      'From: GitHub <noreply@github.com>',
      `To: ${alias.address}`,
      'Subject: [GitHub] Verification code',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Your verification code is: 739104',
    ].join('\r\n');

    const ts = String(Math.floor(Date.now() / 1000));
    const sigHex = crypto
      .createHmac('sha256', account.cfWebhookSecret)
      .update(`${ts}.`)
      .update(rawMime)
      .digest('hex');

    // Bad signature rejected
    const badWebhook = await fetch(`${url}/api/webhooks/email/cf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'message/rfc822',
        'X-NonePwd-Timestamp': ts,
        'X-NonePwd-Signature': 'v1=deadbeef',
      },
      body: rawMime,
    });
    expect(badWebhook.status).toBe(401);

    // Valid signature accepted & pushed over WS
    const goodWebhook = await fetch(`${url}/api/webhooks/email/cf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'message/rfc822',
        'X-NonePwd-Timestamp': ts,
        'X-NonePwd-Signature': `v1=${sigHex}`,
        'X-NonePwd-Envelope-To': alias.address,
      },
      body: rawMime,
    });
    expect(goodWebhook.status).toBe(200);

    const wsEmail = await receivedPromise;
    expect(wsEmail.hasOtp).toBe(true);
    const opened = await openSealedJson<DecryptedEmailPayload>(
      emailKp.privateKeyPkcs8B64,
      wsEmail.sealedEnvelope
    );
    expect(opened.otpCode).toBe('739104');
    expect(opened.senderDomain).toBe('github.com');

    // Replaying the exact same signature must be rejected (401)
    const replayRes = await fetch(`${url}/api/webhooks/email/cf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'message/rfc822',
        'X-NonePwd-Timestamp': ts,
        'X-NonePwd-Signature': `v1=${sigHex}`,
        'X-NonePwd-Envelope-To': alias.address,
      },
      body: rawMime,
    });
    expect(replayRes.status).toBe(401);

    // Disable alias and verify incoming mail with fresh signature is dropped (202 alias_disabled)
    await fetch(`${url}/api/aliases/${alias.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ enabled: false }),
    });

    const ts2 = String(Number(ts) + 1);
    const sigHex2 = crypto
      .createHmac('sha256', account.cfWebhookSecret)
      .update(`${ts2}.`)
      .update(rawMime)
      .digest('hex');

    const droppedRes = await fetch(`${url}/api/webhooks/email/cf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'message/rfc822',
        'X-NonePwd-Timestamp': ts2,
        'X-NonePwd-Signature': `v1=${sigHex2}`,
        'X-NonePwd-Envelope-To': alias.address,
      },
      body: rawMime,
    });
    expect(droppedRes.status).toBe(202);
    const droppedJson = (await droppedRes.json()) as { accepted: boolean; reason: string };
    expect(droppedJson.accepted).toBe(false);
    expect(droppedJson.reason).toBe('alias_disabled');

    ws.close();
  });

  it('hardens auth params, secret verification, local secret decryption, WS revocation/ACL, and item locking', async () => {
    const { srv, url } = await spawnTestServer();
    const { verifySecret } = await import('../src/auth.js');

    // Empty-hash bypass rejected; pbkdf2$ hashes supported
    expect(verifySecret('anything', 's1$aaaaaaaaaaaaaaaaaaaaaa$')).toBe(false);
    const salt = crypto.randomBytes(16);
    const derived = crypto.pbkdf2Sync('my-secret', salt, 10_000, 32, 'sha256');
    const pbkdf2Stored = `pbkdf2$10000$${salt.toString('base64url')}$${derived.toString('base64url')}`;
    expect(verifySecret('my-secret', pbkdf2Stored)).toBe(true);
    expect(verifySecret('wrong', pbkdf2Stored)).toBe(false);

    // Corrupt local secret returns empty string instead of throwing
    expect(srv.db.decryptLocalSecret('s1.invalid.tag.cipher')).toBe('');

    const sk = generateSecretKey();
    const kdfSalt = toBase64Url(randomBytes(16));
    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      'HardPass!1',
      sk,
      kdfSalt,
      10_000
    );
    const emailKp = await generateEmailKeyPair();
    const encRoot = await encryptJson(
      masterUnlockKeyBytes,
      { rootKeyB64: toBase64Url(generateRawAesKey()), emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64 },
      AAD.ROOT_KEYSET
    );

    const setupRes = await fetch(`${url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'private-owner@example.com',
        kdfSalt,
        kdfIterations: 10_000,
        authVerifier: authVerifierB64,
        encryptedRootKeyset: encRoot,
        emailPublicKey: emailKp.publicKeyB64,
        vaults: [
          { id: 'v1', encryptedKey: 'k1', encryptedMeta: 'm1' },
          { id: 'v2', encryptedKey: 'k2', encryptedMeta: 'm2' },
        ],
      }),
    });
    expect(setupRes.status).toBe(201);
    const { token } = (await setupRes.json()) as { token: string };

    // GET /api/auth/params must NOT leak email
    const paramsJson = (await (await fetch(`${url}/api/auth/params`)).json()) as Record<string, unknown>;
    expect(paramsJson.initialized).toBe(true);
    expect('email' in paramsJson).toBe(false);

    // Create SA and open WS; verify email.received is NOT delivered to SA, and SA delete closes WS
    await fetch(`${url}/api/service-accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: 'sa_ws_test',
        name: 'WS SA',
        authSecret: 'sa-pw-123',
        vaultKeys: [{ vaultId: 'v1', encryptedVaultKey: 'vk1' }],
      }),
    });
    const saLoginRes = await fetch(`${url}/api/auth/service-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId: 'sa_ws_test', authSecret: 'sa-pw-123' }),
    });
    const { token: saToken } = (await saLoginRes.json()) as { token: string };

    const saWs = new WebSocket(url.replace('http://', 'ws://') + `/api/ws?token=${encodeURIComponent(saToken)}`);
    const saMsgs: string[] = [];
    await new Promise<void>((resolve) => saWs.once('open', () => resolve()));
    saWs.on('message', (d) => saMsgs.push(String(d)));

    await fetch(`${url}/api/emails/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ from: 'a@b.com', to: 'private-owner@example.com', subject: 'OTP 112233', text: '112233' }),
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(saMsgs.some((m) => m.includes('email.received'))).toBe(false);

    const saClosed = new Promise<void>((resolve) => saWs.once('close', () => resolve()));
    await fetch(`${url}/api/service-accounts/sa_ws_test`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    await saClosed;

    // Logout closes owner WS
    const ownerWs = new WebSocket(url.replace('http://', 'ws://') + `/api/ws?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve) => ownerWs.once('open', () => resolve()));
    const ownerClosed = new Promise<void>((resolve) => ownerWs.once('close', () => resolve()));
    await fetch(`${url}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    await ownerClosed;
  });

  it('serves CLI install script and native binary downloads with path traversal protection', async () => {
    const { url } = await spawnTestServer();

    const installRes = await fetch(`${url}/install.sh`);
    expect(installRes.status).toBe(200);
    const installText = await installRes.text();
    expect(installText).toContain('/downloads/np-');

    const badRes = await fetch(`${url}/downloads/..%2F..%2Fetc%2Fpasswd`);
    expect(badRes.status).toBe(404);

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
});
