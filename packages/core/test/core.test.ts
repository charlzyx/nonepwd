import { describe, expect, it } from 'vitest';
import {
  AAD,
  buildOtpAuthUri,
  decodeServiceAccountToken,
  decryptJson,
  deriveAccountKeys,
  detectImportFormat,
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
  hasSameTotpSecret,
  injectSecretRefs,
  itemImportFingerprint,
  normalizeSecretKey,
  openSealedJson,
  parseAuthenticatorExport,
  parseDotEnv,
  parsePasswordCsv,
  parseSecretRef,
  planTotpImport,
  randomBytes,
  resolveItemField,
  sealJsonForPublicKey,
  toBase32,
  toBase64Url,
  totpImportMatch,
  totpIssuerMatchesItem,
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

  it('parses Brave and localized RFC 4180 password CSV exports via Rust WASM', () => {
    const braveCsv = [
      '\uFEFFname,url,username,password,note',
      'GitHub,https://github.com/login,octocat,"p@ss,with""quote""","line 1',
      'line 2"',
      ',https://accounts.google.com/v3/signin,user@gmail.com, my pass ,中文备注',
      ',,,,',
    ].join('\r\n');

    const entries = parsePasswordCsv(braveCsv);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      category: 'login',
      title: 'GitHub',
      urls: ['https://github.com/login'],
      username: 'octocat',
      password: 'p@ss,with"quote"',
      notes: 'line 1\r\nline 2',
    });
    expect(entries[1]).toMatchObject({
      category: 'login',
      title: 'google.com',
      urls: ['https://accounts.google.com/v3/signin'],
      username: 'user@gmail.com',
      password: ' my pass ',
      notes: '中文备注',
    });

    expect(
      itemImportFingerprint({
        urls: ['HTTPS://GitHub.com/login/'],
        username: ' octocat ',
        password: 'secret',
      })
    ).toBe(
      itemImportFingerprint({
        urls: ['https://github.com/login'],
        username: 'octocat',
        password: 'secret',
      })
    );

    const zhEntries = parsePasswordCsv(
      '名称,网址,用户名,密码,备注\nCloudflare,https://dash.cloudflare.com,admin@test.dev,cf-secret,主账号\n'
    );
    expect(zhEntries).toHaveLength(1);
    expect(zhEntries[0].title).toBe('Cloudflare');
    expect(zhEntries[0].password).toBe('cf-secret');

    expect(() => parsePasswordCsv('colA,colB,colC\n1,2,3\n')).toThrow();
  });

  it('supports Card and Identity VaultItemPayloads and preserves legacy payload compatibility', async () => {
    const key = generateRawAesKey();
    const cardItem: VaultItemPayload = {
      id: 'card-1',
      vaultId: 'v1',
      category: 'card',
      title: 'Personal Visa',
      favorite: false,
      tags: [],
      urls: [],
      card: {
        cardholderName: 'Alice Chen',
        number: '4242424242424242',
        expMonth: '08',
        expYear: '2029',
        cvv: '999',
        brand: 'visa',
      },
      customFields: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const identityItem: VaultItemPayload = {
      id: 'ident-1',
      vaultId: 'v1',
      category: 'identity',
      title: 'Home Address',
      favorite: false,
      tags: [],
      urls: [],
      identity: {
        fullName: 'Alice Chen',
        firstName: 'Alice',
        lastName: 'Chen',
        email: 'alice@example.com',
        phone: '+1-555-0100',
        company: 'Example Labs',
        address1: '123 Main St',
        address2: 'Apt 4B',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94105',
        country: 'US',
      },
      customFields: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const encCard = await encryptJson(key, cardItem, AAD.vaultItem('v1', 'card-1'));
    const decCard = await decryptJson<VaultItemPayload>(key, encCard, AAD.vaultItem('v1', 'card-1'));
    expect(decCard).toEqual(cardItem);
    expect(resolveItemField(decCard, 'cvv')).toBe('999');

    const encIdent = await encryptJson(key, identityItem, AAD.vaultItem('v1', 'ident-1'));
    const decIdent = await decryptJson<VaultItemPayload>(key, encIdent, AAD.vaultItem('v1', 'ident-1'));
    expect(decIdent).toEqual(identityItem);
    expect(resolveItemField(decIdent, 'postalCode')).toBe('94105');
    expect(resolveItemField(decIdent, 'email')).toBe('alice@example.com');
  });

  it('parses otpauth lines, Google Authenticator migration protobuf, and Aegis/2FAS JSON via WASM', async () => {
    const pbVarint = (val: number): number[] => {
      const out: number[] = [];
      let v = val >>> 0;
      while (true) {
        let b = v & 0x7f;
        v >>>= 7;
        if (v !== 0) b |= 0x80;
        out.push(b);
        if (v === 0) break;
      }
      return out;
    };
    const pbBytes = (field: number, data: Uint8Array): number[] => [
      ...pbVarint((field << 3) | 2),
      ...pbVarint(data.length),
      ...data,
    ];
    const pbUint = (field: number, val: number): number[] => [
      ...pbVarint((field << 3) | 0),
      ...pbVarint(val),
    ];

    const otp1 = new Uint8Array([
      ...pbBytes(1, utf8Encode('12345678901234567890')),
      ...pbBytes(2, utf8Encode('Google:alice@gmail.com')),
      ...pbBytes(3, utf8Encode('Google')),
      ...pbUint(4, 1), // SHA1
      ...pbUint(5, 1), // 6 digits
      ...pbUint(6, 2), // TOTP
    ]);
    const otp2 = new Uint8Array([
      ...pbBytes(1, new Uint8Array([0xfb, 0xff, 0xbf, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70])),
      ...pbBytes(2, utf8Encode('Stripe:billing@example.com')),
      ...pbBytes(3, utf8Encode('Stripe')),
      ...pbUint(4, 2), // SHA256
      ...pbUint(5, 2), // 8 digits
      ...pbUint(6, 2), // TOTP
    ]);
    const migrationPayload = new Uint8Array([
      ...pbBytes(1, otp1),
      ...pbBytes(1, otp2),
      ...pbUint(2, 1),
    ]);
    const stdB64 = Buffer.from(migrationPayload).toString('base64');
    const migrationUri = `otpauth-migration://offline?data=${encodeURIComponent(stdB64)}`;

    expect(detectImportFormat(migrationUri)).toBe('totp');
    const migParsed = parseAuthenticatorExport(migrationUri);
    expect(migParsed).toHaveLength(2);
    expect(migParsed[0]).toMatchObject({
      issuer: 'Google',
      account: 'alice@gmail.com',
      secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      digits: 6,
      period: 30,
      algorithm: 'SHA1',
    });
    const codeAt59 = await generateTotp(migParsed[0].otpauthUri, 59_000);
    expect(codeAt59.code).toBe('287082');

    expect(migParsed[1]).toMatchObject({
      issuer: 'Stripe',
      account: 'billing@example.com',
      digits: 8,
      algorithm: 'SHA256',
    });

    const linesExport = [
      '# Backup file',
      '',
      'otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
      'otpauth://totp/Linear:dev%40example.com?secret=JBSWY3DPEHPK3PXQ&issuer=Linear',
    ].join('\n');
    const linesParsed = parseAuthenticatorExport(linesExport);
    expect(linesParsed).toHaveLength(2);
    expect(linesParsed[1].account).toBe('dev@example.com');

    const aegisParsed = parseAuthenticatorExport(
      JSON.stringify({
        version: 1,
        db: {
          entries: [
            {
              type: 'totp',
              name: 'alice@example.com',
              issuer: 'Notion',
              info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30 },
            },
          ],
        },
      })
    );
    expect(aegisParsed).toHaveLength(1);
    expect(aegisParsed[0].issuer).toBe('Notion');

    const existingItems: VaultItemPayload[] = [
      {
        id: 'existing-google',
        vaultId: 'v1',
        category: 'login',
        title: 'google.com',
        favorite: false,
        tags: [],
        urls: ['https://accounts.google.com/signin'],
        username: 'alice@gmail.com',
        password: 'pw',
        customFields: [],
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'existing-gh',
        vaultId: 'v1',
        category: 'login',
        title: 'GitHub',
        favorite: false,
        tags: [],
        urls: ['https://github.com'],
        username: 'octocat',
        totp: 'JBSWY3DPEHPK3PXP',
        customFields: [],
        createdAt: '',
        updatedAt: '',
      },
    ];

    expect(hasSameTotpSecret(existingItems[1].totp, 'jbsw y3dp ehpk 3pxp')).toBe(true);
    expect(totpIssuerMatchesItem('Google', existingItems[0])).toBe(true);
    expect(totpImportMatch(existingItems, linesParsed[0]).action).toBe('skip_duplicate');

    const plan = planTotpImport(existingItems, migParsed);
    expect(plan[0]).toMatchObject({ action: 'attach', itemId: 'existing-google' });
    expect(plan[1]).toMatchObject({
      action: 'create',
      title: 'Stripe',
      username: 'billing@example.com',
    });
  });
});
