import crypto from 'node:crypto';
import type { NonePwdDb } from './db.js';

export type AuthContext =
  | {
      kind: 'owner';
      tokenHash: string;
    }
  | {
      kind: 'service_account';
      tokenHash: string;
      serviceAccountId: string;
      allowedVaultIds: Set<string>;
    };

export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(secret, salt, 32);
  return `s1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 's1') return false;
  const salt = Buffer.from(parts[1], 'base64url');
  const expected = Buffer.from(parts[2], 'base64url');
  const actual = crypto.scryptSync(secret, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createSession(
  db: NonePwdDb,
  kind: 'owner' | 'service_account',
  serviceAccountId?: string,
  ttlMs: number = 30 * 24 * 60 * 60 * 1000
): string {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  // Clean expired sessions opportunistically
  db.sqlite.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());

  db.sqlite
    .prepare(
      `INSERT INTO sessions (token_hash, kind, service_account_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(tokenHash, kind, serviceAccountId ?? null, now.toISOString(), expiresAt.toISOString());

  return rawToken;
}

export function authenticateToken(db: NonePwdDb, rawToken: string | null | undefined): AuthContext | null {
  if (!rawToken) return null;
  const tokenHash = hashSessionToken(rawToken);
  const row = db.sqlite
    .prepare(
      `SELECT token_hash, kind, service_account_id, expires_at
       FROM sessions WHERE token_hash = ?`
    )
    .get(tokenHash) as
    | {
        token_hash: string;
        kind: 'owner' | 'service_account';
        service_account_id: string | null;
        expires_at: string;
      }
    | undefined;

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }

  if (row.kind === 'owner') {
    return { kind: 'owner', tokenHash };
  }

  if (!row.service_account_id) return null;
  const saRow = db.sqlite
    .prepare('SELECT id FROM service_accounts WHERE id = ?')
    .get(row.service_account_id) as { id: string } | undefined;
  if (!saRow) {
    db.sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }

  const vaultRows = db.sqlite
    .prepare('SELECT vault_id FROM service_account_vaults WHERE service_account_id = ?')
    .all(row.service_account_id) as Array<{ vault_id: string }>;

  return {
    kind: 'service_account',
    tokenHash,
    serviceAccountId: row.service_account_id,
    allowedVaultIds: new Set(vaultRows.map((v) => v.vault_id)),
  };
}

export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function verifyWebhookHmac(
  secret: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  rawBody: Uint8Array,
  maxSkewSeconds: number = 300
): boolean {
  if (!secret || !timestampHeader || !signatureHeader) return false;
  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > maxSkewSeconds) return false;

  const expectedSigHex = crypto
    .createHmac('sha256', secret)
    .update(`${timestampHeader}.`)
    .update(rawBody)
    .digest('hex');

  const provided = signatureHeader.startsWith('v1=')
    ? signatureHeader.slice(3).trim().toLowerCase()
    : signatureHeader.trim().toLowerCase();

  if (provided.length !== expectedSigHex.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expectedSigHex, 'utf8'));
}
