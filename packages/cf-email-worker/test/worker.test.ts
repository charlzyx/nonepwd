import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AAD,
  deriveAccountKeys,
  encryptJson,
  generateEmailKeyPair,
  generateRawAesKey,
  generateSecretKey,
  openSealedJson,
  randomBytes,
  toBase64Url,
  utf8Encode,
  type DecryptedEmailPayload,
  type EncryptedEmailRecord,
} from '@nonepwd/core';
import { createNonePwdServer, type NonePwdServerInstance } from '../../server/src/app.js';
import { processIncomingEmail, type EmailMessageLike } from '../src/index.js';

const cleanups: Array<{ srv: NonePwdServerInstance; dir: string }> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const entry = cleanups.pop()!;
    await entry.srv.close();
    fs.rmSync(entry.dir, { recursive: true, force: true });
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

describe('@nonepwd/cf-email-worker', () => {
  it('delivers both raw HMAC MIME and Edge Zero-Knowledge X25519 sealed emails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cf-test-'));
    const srv = createNonePwdServer({ dataDir: dir });
    const { url } = await srv.start(0, '127.0.0.1');
    cleanups.push({ srv, dir });

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
      }),
    });
    const { token, account } = (await setupRes.json()) as {
      token: string;
      account: { cfWebhookSecret: string };
    };

    const rawMime = [
      'From: Cursor <no-reply@cursor.com>',
      'To: cursor.k9x2m@mail.example.com',
      'Subject: Sign in to Cursor',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Your one-time verification code is 519382.',
    ].join('\r\n');

    const forwardSpy = vi.fn(async () => {});
    const msg1: EmailMessageLike = {
      from: 'no-reply@cursor.com',
      to: 'cursor.k9x2m@mail.example.com',
      raw: streamFromText(rawMime),
      forward: forwardSpy,
    };

    // Mode 1: Raw HMAC forwarding
    const res1 = await processIncomingEmail(msg1, {
      NONEPWD_SERVER_URL: url,
      WEBHOOK_SECRET: account.cfWebhookSecret,
      FORWARD_TO_EMAIL: 'primary@gmail.com',
    });
    expect(res1.status).toBe(200);
    expect(forwardSpy).toHaveBeenCalledWith('primary@gmail.com');

    // Mode 2: Edge Zero-Knowledge X25519 sealing
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

    const inboxRes = await fetch(`${url}/api/emails`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { emails } = (await inboxRes.json()) as { emails: EncryptedEmailRecord[] };
    expect(emails).toHaveLength(2);

    const openedCodes = await Promise.all(
      emails.map(async (em) =>
        (await openSealedJson<DecryptedEmailPayload>(emailKp.privateKeyPkcs8B64, em.sealedEnvelope)).otpCode
      )
    );
    expect(openedCodes).toContain('519382');
    expect(openedCodes).toContain('904211');
  });
});
