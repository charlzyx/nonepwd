const textEncoder = new TextEncoder();

export interface OwnerAuthContext {
  kind: 'owner';
  tokenHash: string;
  expiresAt: number;
}

export interface ServiceAccountAuthContext {
  kind: 'service_account';
  tokenHash: string;
  serviceAccountId: string;
  allowedVaultIds: Set<string>;
  expiresAt: number;
}

export type AuthContext = OwnerAuthContext | ServiceAccountAuthContext;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(input: string): Uint8Array | null {
  try {
    const normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + '='.repeat(padLength);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function randomHex(byteLength: number): string {
  return bytesToHex(randomBytes(byteLength));
}

async function pbkdf2Sha256(
  secretBytes: Uint8Array,
  saltBytes: Uint8Array,
  iterations: number,
  keyLenBytes: number
): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBuffer(secretBytes),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(saltBytes),
      iterations,
      hash: 'SHA-256',
    },
    key,
    keyLenBytes * 8
  );
  return new Uint8Array(bits);
}

function rotl32(v: number, bits: number): number {
  return ((v << bits) | (v >>> (32 - bits))) >>> 0;
}

function salsa20_8(block: Uint32Array, offset: number): void {
  const x = new Uint32Array(16);
  for (let i = 0; i < 16; i++) x[i] = block[offset + i];

  for (let round = 0; round < 4; round++) {
    x[4] ^= rotl32((x[0] + x[12]) >>> 0, 7);
    x[8] ^= rotl32((x[4] + x[0]) >>> 0, 9);
    x[12] ^= rotl32((x[8] + x[4]) >>> 0, 13);
    x[0] ^= rotl32((x[12] + x[8]) >>> 0, 18);

    x[9] ^= rotl32((x[5] + x[1]) >>> 0, 7);
    x[13] ^= rotl32((x[9] + x[5]) >>> 0, 9);
    x[1] ^= rotl32((x[13] + x[9]) >>> 0, 13);
    x[5] ^= rotl32((x[1] + x[13]) >>> 0, 18);

    x[14] ^= rotl32((x[10] + x[6]) >>> 0, 7);
    x[2] ^= rotl32((x[14] + x[10]) >>> 0, 9);
    x[6] ^= rotl32((x[2] + x[14]) >>> 0, 13);
    x[10] ^= rotl32((x[6] + x[2]) >>> 0, 18);

    x[3] ^= rotl32((x[15] + x[11]) >>> 0, 7);
    x[7] ^= rotl32((x[3] + x[15]) >>> 0, 9);
    x[11] ^= rotl32((x[7] + x[3]) >>> 0, 13);
    x[15] ^= rotl32((x[11] + x[7]) >>> 0, 18);

    x[1] ^= rotl32((x[0] + x[3]) >>> 0, 7);
    x[2] ^= rotl32((x[1] + x[0]) >>> 0, 9);
    x[3] ^= rotl32((x[2] + x[1]) >>> 0, 13);
    x[0] ^= rotl32((x[3] + x[2]) >>> 0, 18);

    x[6] ^= rotl32((x[5] + x[4]) >>> 0, 7);
    x[7] ^= rotl32((x[6] + x[5]) >>> 0, 9);
    x[4] ^= rotl32((x[7] + x[6]) >>> 0, 13);
    x[5] ^= rotl32((x[4] + x[7]) >>> 0, 18);

    x[11] ^= rotl32((x[10] + x[9]) >>> 0, 7);
    x[8] ^= rotl32((x[11] + x[10]) >>> 0, 9);
    x[9] ^= rotl32((x[8] + x[11]) >>> 0, 13);
    x[10] ^= rotl32((x[9] + x[8]) >>> 0, 18);

    x[12] ^= rotl32((x[15] + x[14]) >>> 0, 7);
    x[13] ^= rotl32((x[12] + x[15]) >>> 0, 9);
    x[14] ^= rotl32((x[13] + x[12]) >>> 0, 13);
    x[15] ^= rotl32((x[14] + x[13]) >>> 0, 18);
  }

  for (let i = 0; i < 16; i++) {
    block[offset + i] = (block[offset + i] + x[i]) >>> 0;
  }
}

function scryptBlockMix(b: Uint32Array, y: Uint32Array, r: number, tmp: Uint32Array): void {
  const lastOffset = (2 * r - 1) * 16;
  for (let k = 0; k < 16; k++) {
    tmp[k] = b[lastOffset + k];
  }
  for (let i = 0; i < 2 * r; i++) {
    const srcOffset = i * 16;
    for (let k = 0; k < 16; k++) {
      tmp[k] ^= b[srcOffset + k];
    }
    salsa20_8(tmp, 0);
    const destIdx = i % 2 === 0 ? i >>> 1 : r + (i >>> 1);
    const destOffset = destIdx * 16;
    for (let k = 0; k < 16; k++) {
      y[destOffset + k] = tmp[k];
    }
  }
}

/**
 * RFC 7914 scrypt (N=16384, r=8, p=1) in pure Web TypeScript for verifying
 * `s1$...` password hashes migrated from local `np server` / Node SQLite DBs.
 */
async function scryptVerifyDerive(
  secretBytes: Uint8Array,
  saltBytes: Uint8Array,
  keyLen: number
): Promise<Uint8Array> {
  const N = 16_384;
  const r = 8;
  const blockLen = 128 * r;
  const words = 32 * r;

  const b = await pbkdf2Sha256(secretBytes, saltBytes, 1, blockLen);
  const bView = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let x = new Uint32Array(words);
  let y = new Uint32Array(words);
  const tmp = new Uint32Array(16);
  for (let i = 0; i < words; i++) {
    x[i] = bView.getUint32(i * 4, true);
  }

  const v = new Uint32Array(N * words);
  for (let i = 0; i < N; i++) {
    v.set(x, i * words);
    scryptBlockMix(x, y, r, tmp);
    const swap = x;
    x = y;
    y = swap;
  }

  const intOffset = (2 * r - 1) * 16;
  const mask = N - 1;
  for (let i = 0; i < N; i++) {
    const j = (x[intOffset] & mask) >>> 0;
    const vOffset = j * words;
    for (let k = 0; k < words; k++) {
      x[k] ^= v[vOffset + k];
    }
    scryptBlockMix(x, y, r, tmp);
    const swap = x;
    x = y;
    y = swap;
  }

  for (let i = 0; i < words; i++) {
    bView.setUint32(i * 4, x[i], true);
  }
  return pbkdf2Sha256(secretBytes, b, 1, keyLen);
}

const DEFAULT_PBKDF2_ITERATIONS = 100_000;

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await pbkdf2Sha256(
    textEncoder.encode(secret),
    salt,
    DEFAULT_PBKDF2_ITERATIONS,
    32
  );
  return `pbkdf2$${DEFAULT_PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(derived)}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts[0] === 'pbkdf2' && parts.length === 4) {
    const iterations = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 1_000_000) {
      return false;
    }
    const salt = base64UrlToBytes(parts[2]);
    const expected = base64UrlToBytes(parts[3]);
    if (!salt || !expected || salt.length < 8 || expected.length < 32 || expected.length > 128) return false;
    const actual = await pbkdf2Sha256(
      textEncoder.encode(secret),
      salt,
      iterations,
      expected.length
    );
    return constantTimeEqualBytes(actual, expected);
  }

  if (parts[0] === 's1' && parts.length === 3) {
    const salt = base64UrlToBytes(parts[1]);
    const expected = base64UrlToBytes(parts[2]);
    if (!salt || !expected || salt.length < 8 || expected.length < 32 || expected.length > 128) return false;
    const actual = await scryptVerifyDerive(textEncoder.encode(secret), salt, expected.length);
    return constantTimeEqualBytes(actual, expected);
  }

  return false;
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    toArrayBuffer(textEncoder.encode(token))
  );
  return bytesToHex(new Uint8Array(digest));
}

export async function createSession(
  db: D1Database,
  kind: 'owner' | 'service_account',
  serviceAccountId?: string,
  ttlMs: number = 30 * 24 * 60 * 60 * 1000
): Promise<string> {
  const rawToken = bytesToBase64Url(randomBytes(32));
  const tokenHash = await hashSessionToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now.toISOString()),
    db
      .prepare(
        `INSERT INTO sessions (token_hash, kind, service_account_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(tokenHash, kind, serviceAccountId ?? null, now.toISOString(), expiresAt.toISOString()),
  ]);

  return rawToken;
}

export async function authenticateToken(
  db: D1Database,
  rawToken: string | null | undefined
): Promise<AuthContext | null> {
  const trimmed = rawToken?.trim();
  if (!trimmed) return null;
  const tokenHash = await hashSessionToken(trimmed);

  const row = await db
    .prepare(
      `SELECT token_hash, kind, service_account_id, expires_at
       FROM sessions WHERE token_hash = ?`
    )
    .bind(tokenHash)
    .first<{
      token_hash: string;
      kind: string;
      service_account_id: string | null;
      expires_at: string;
    }>();

  if (!row) return null;
  const expMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expMs) || expMs < Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }

  if (row.kind === 'owner') {
    return { kind: 'owner', tokenHash, expiresAt: expMs };
  }

  if (!row.service_account_id) return null;
  const saRow = await db
    .prepare('SELECT id FROM service_accounts WHERE id = ?')
    .bind(row.service_account_id)
    .first<{ id: string }>();

  if (!saRow) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }

  const vaultsRes = await db
    .prepare('SELECT vault_id FROM service_account_vaults WHERE service_account_id = ?')
    .bind(row.service_account_id)
    .all<{ vault_id: string }>();

  return {
    kind: 'service_account',
    tokenHash,
    serviceAccountId: row.service_account_id,
    allowedVaultIds: new Set((vaultsRes.results ?? []).map((v) => v.vault_id)),
    expiresAt: expMs,
  };
}

export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function verifyWebhookHmac(
  secret: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  rawBody: Uint8Array,
  maxSkewSeconds: number = 300
): Promise<boolean> {
  if (!secret || !timestampHeader || !signatureHeader) return false;
  const ts = Number.parseInt(timestampHeader.trim(), 10);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > maxSkewSeconds) return false;

  const prefix = textEncoder.encode(`${timestampHeader.trim()}.`);
  const signedData = new Uint8Array(prefix.length + rawBody.length);
  signedData.set(prefix, 0);
  signedData.set(rawBody, prefix.length);

  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    toArrayBuffer(textEncoder.encode(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const mac = new Uint8Array(
    await globalThis.crypto.subtle.sign('HMAC', key, toArrayBuffer(signedData))
  );
  const expectedBytes = textEncoder.encode(bytesToHex(mac));

  const providedStr = signatureHeader.startsWith('v1=')
    ? signatureHeader.slice(3).trim().toLowerCase()
    : signatureHeader.trim().toLowerCase();
  const providedBytes = textEncoder.encode(providedStr);

  return constantTimeEqualBytes(providedBytes, expectedBytes);
}

const webhookReplayCache = new Map<string, number>();
const MAX_REPLAY_CACHE_SIZE = 4096;

export function claimWebhookSignature(
  timestampHeader: string,
  signatureHeader: string,
  ttlMs: number = 310_000
): boolean {
  const now = Date.now();
  for (const [k, exp] of webhookReplayCache) {
    if (exp <= now) webhookReplayCache.delete(k);
  }
  const normalizedSig = signatureHeader.startsWith('v1=')
    ? signatureHeader.slice(3).trim().toLowerCase()
    : signatureHeader.trim().toLowerCase();
  const key = `${timestampHeader.trim()}.${normalizedSig}`;
  if (webhookReplayCache.has(key)) return false;
  if (webhookReplayCache.size >= MAX_REPLAY_CACHE_SIZE) {
    const oldest = webhookReplayCache.keys().next().value;
    if (oldest !== undefined) webhookReplayCache.delete(oldest);
  }
  webhookReplayCache.set(key, now + ttlMs);
  return true;
}
