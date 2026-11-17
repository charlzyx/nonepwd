import { describe, expect, it } from 'vitest';
import {
  AAD,
  buildOtpAuthUri,
  decodeServiceAccountToken,
  decryptJson,
  deriveAccountKeys,
  domainsMatch,
  encodeServiceAccountToken,
  encryptJson,
  extractEmailOtp,
  extractRegistrableDomain,
  generateEmailAlias,
  generateEmailKeyPair,
  generatePassphrase,
  generatePassword,
  generateRawAesKey,
  generateSecretKey,
  generateTotp,
  injectSecretRefs,
  normalizeSecretKey,
  openSealedJson,
  parseDotEnv,
  parseSecretRef,
  randomBytes,
  resolveItemField,
  sealJsonForPublicKey,
  toBase32,
  toBase64Url,
  utf8Encode,
  type VaultItemPayload,
} from '../src/index.js';

describe('@nonepwd/core cryptography', () => {
  it('generates and normalizes secret keys properly', () => {
    const sk = generateSecretKey();
    expect(sk).toMatch(/^NP3(-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}){5}$/);
    expect(normalizeSecretKey(sk.toLowerCase().replace(/-/g, ' '))).toBe(sk.replace(/-/g, ''));
  });

  it('derives dual-key MUK + verifier deterministically and rejects wrong password or secret key', async () => {
    const sk = generateSecretKey();
    const salt = toBase64Url(randomBytes(16));
    // Use faster iteration count for unit test speed; production uses 600_000
    const a = await deriveAccountKeys('MyStrongPass#2026', sk, salt, 10_000);
    const b = await deriveAccountKeys('MyStrongPass#2026', sk.toLowerCase(), salt, 10_000);
    const wrongPass = await deriveAccountKeys('WrongPass', sk, salt, 10_000);
    const wrongSk = await deriveAccountKeys('MyStrongPass#2026', generateSecretKey(), salt, 10_000);

    expect(toBase64Url(a.masterUnlockKeyBytes)).toBe(toBase64Url(b.masterUnlockKeyBytes));
    expect(a.authVerifierB64).toBe(b.authVerifierB64);
    expect(a.authVerifierB64).not.toBe(wrongPass.authVerifierB64);
    expect(a.authVerifierB64).not.toBe(wrongSk.authVerifierB64);
  });

  it('encrypts/decrypts JSON with AES-GCM and enforces AAD binding', async () => {
    const vaultKey = generateRawAesKey();
    const item: VaultItemPayload = {
      id: 'item-1',
      vaultId: 'vault-1',
      category: 'login',
      title: 'GitHub',
      favorite: true,
      tags: ['dev'],
      urls: ['https://github.com/login'],
      username: 'alice',
      password: 'super-secret-password',
      totp: 'JBSWY3DPEHPK3PXP',
      customFields: [{ id: 'cf1', label: 'Recovery Token', value: 'rec-999', type: 'concealed' }],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const blob = await encryptJson(vaultKey, item, AAD.vaultItem('vault-1', 'item-1'));
    const decrypted = await decryptJson<VaultItemPayload>(
      vaultKey,
      blob,
      AAD.vaultItem('vault-1', 'item-1')
    );
    expect(decrypted).toEqual(item);

    // Tampered AAD (swapping blob into another item or vault) must fail
    await expect(
      decryptJson(vaultKey, blob, AAD.vaultItem('vault-2', 'item-1'))
    ).rejects.toThrow();
  });

  it('seals and opens X25519 zero-knowledge envelopes', async () => {
    const kp = await generateEmailKeyPair();
    const payload = { from: 'noreply@github.com', otpCode: '482910', subject: 'Login code' };
    const envelope = await sealJsonForPublicKey(kp.publicKeyB64, payload);
    expect(envelope.v).toBe(1);
    expect(envelope.ct).not.toContain('482910');

    const opened = await openSealedJson<typeof payload>(kp.privateKeyPkcs8B64, envelope);
    expect(opened).toEqual(payload);

    const otherKp = await generateEmailKeyPair();
    await expect(openSealedJson(otherKp.privateKeyPkcs8B64, envelope)).rejects.toThrow();
  });

  it('encodes and decodes Service Account tokens', () => {
    const token = encodeServiceAccountToken({
      v: 1,
      serverUrl: 'http://127.0.0.1:8787',
      tokenId: 'sa_123',
      authSecret: 'secret_abc',
      wrapKeyB64: toBase64Url(generateRawAesKey()),
    });
    expect(token.startsWith('npst_v1_')).toBe(true);
    const parsed = decodeServiceAccountToken(token);
    expect(parsed.tokenId).toBe('sa_123');
    expect(parsed.serverUrl).toBe('http://127.0.0.1:8787');
  });
});

describe('@nonepwd/core TOTP', () => {
  it('matches RFC 6238 SHA-1 test vector', async () => {
    // RFC 6238 test secret ASCII "12345678901234567890" -> Base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    const secretBase32 = toBase32(utf8Encode('12345678901234567890'));
    // At timestamp 59s, SHA1 8-digit TOTP is 94287082 -> 6-digit suffix is 287082
    const uri = buildOtpAuthUri({ secret: secretBase32, issuer: 'RFC', account: 'test', digits: 8 });
    const res8 = await generateTotp(uri, 59_000);
    expect(res8.code).toBe('94287082');

    const res6 = await generateTotp(secretBase32, 59_000);
    expect(res6.code).toBe('287082');
    expect(res6.remainingSeconds).toBe(1);
  });
});

describe('@nonepwd/core Email OTP & Domain matching', () => {
  it('extracts registrable domains accurately including 2-level ccTLDs', () => {
    expect(extractRegistrableDomain('https://app.github.com/login')).toBe('github.com');
    expect(extractRegistrableDomain('noreply@notify.steampowered.com')).toBe('steampowered.com');
    expect(extractRegistrableDomain('auth.service.co.uk')).toBe('service.co.uk');
    expect(domainsMatch('https://accounts.cursor.com/signin', 'no-reply@cursor.com')).toBe(true);
    expect(domainsMatch('https://evil.com', 'no-reply@cursor.com')).toBe(false);
  });

  it('extracts English HTML OTP codes and magic links while ignoring CSS colors & years', () => {
    const html = `
      <html><head><style>.box { color: #445566; font-size: 16px; }</style></head>
      <body>
        <p>Hello developer,</p>
        <p>Your GitHub verification code is:</p>
        <div style="font-size:24px;color:#112233">839204</div>
        <p>Or click to sign in: <a href="https://github.com/login/verify?token=abc123">Sign in now</a></p>
        <footer>© 2026 GitHub Inc. Order #998877. <a href="https://github.com/unsubscribe">Unsubscribe</a></footer>
      </body></html>
    `;
    const res = extractEmailOtp({
      from: 'GitHub <noreply@github.com>',
      to: 'github.a1b2c@mail.example.com',
      subject: '[GitHub] Please verify your device',
      html,
    });
    expect(res.otpCode).toBe('839204');
    expect(res.confidence).toBeGreaterThan(0.7);
    expect(res.magicLink).toBe('https://github.com/login/verify?token=abc123');
    expect(res.senderDomain).toBe('github.com');
  });

  it('extracts Chinese OTP codes accurately', () => {
    const res = extractEmailOtp({
      from: 'Steam <noreply@steampowered.com>',
      to: 'me@example.com',
      subject: '您的 Steam 登录验证码',
      text: '您好，您本次登录的安全验证码为：649-102，5分钟内有效。客服电话 4001234567。',
    });
    expect(res.otpCode).toBe('649102');
    expect(res.senderDomain).toBe('steampowered.com');
  });

  it('returns null otpCode on non-OTP promotional newsletters with prices and years', () => {
    const res = extractEmailOtp({
      from: 'Shop <promo@store.example.com>',
      to: 'me@example.com',
      subject: 'Spring Sale 2026 - Save $1500 today!',
      text: 'Order #441239 total price $1500 USD. Copyright 2026 Store Inc.',
    });
    expect(res.otpCode).toBeNull();
  });

  it('extracts OTP codes followed by a trailing sentence period while rejecting decimals', () => {
    const res = extractEmailOtp({
      from: 'Cursor <no-reply@cursor.com>',
      to: 'me@example.com',
      subject: 'Sign in to Cursor',
      text: 'Your verification code is 519382. Amount $1234.56 is unrelated.',
    });
    expect(res.otpCode).toBe('519382');
  });
});

describe('@nonepwd/core Secret References & Generators', () => {
  it('parses and injects np:// references', async () => {
    const parsed = parseSecretRef('np://DevOps/Postgres Production/password?wait=30');
    expect(parsed.vault).toBe('DevOps');
    expect(parsed.item).toBe('Postgres Production');
    expect(parsed.field).toBe('password');
    expect(parsed.params.wait).toBe('30');

    const item: VaultItemPayload = {
      id: '1',
      vaultId: 'v1',
      category: 'api_credential',
      title: 'OpenAI',
      favorite: false,
      tags: [],
      urls: [],
      customFields: [{ id: 'f1', label: 'API Key', value: 'sk-test-xyz', type: 'concealed' }],
      createdAt: '',
      updatedAt: '',
    };
    expect(resolveItemField(item, 'api key')).toBe('sk-test-xyz');

    const rendered = await injectSecretRefs(
      'TOKEN={{ np://Dev/OpenAI/api_key }}\nDB=np://Dev/PG/password',
      async (ref) => (ref.includes('OpenAI') ? 'sk-123' : 'pg-pass')
    );
    expect(rendered).toBe('TOKEN=sk-123\nDB=pg-pass');

    expect(parseDotEnv('export A="hello"\n# comment\nB=np://Dev/X/pass')).toEqual({
      A: 'hello',
      B: 'np://Dev/X/pass',
    });
  });

  it('generates strong passwords, passphrases, and site email aliases', () => {
    const pw = generatePassword({ length: 24, uppercase: true, lowercase: true, digits: true, symbols: true });
    expect(pw).toHaveLength(24);
    expect(/[A-Z]/.test(pw)).toBe(true);
    expect(/[a-z]/.test(pw)).toBe(true);
    expect(/[0-9]/.test(pw)).toBe(true);

    const phrase = generatePassphrase({ words: 4, separator: '-' });
    expect(phrase.split('-')).toHaveLength(4);

    const alias = generateEmailAlias('https://app.cursor.com/signin', 'mail.myhome.dev');
    expect(alias).toMatch(/^cursor\.[a-z0-9]{5}@mail\.myhome\.dev$/);
  });
});
