import {
  randomId,
  type ImapAccountPublic,
  type ImapAccountStatus,
  type ImapConfigPublic,
} from '@nonepwd/core/worker';
import type { CfSocket } from 'cloudflare:sockets';
import { ingestRawEmail } from './email.js';
import { deriveImapLabel, ensureLegacyImapMigrated, ensureSchema } from './schema.js';
import type { CfServerEnv } from './types.js';

const MAX_IMAP_LITERAL_BYTES = 8 * 1024 * 1024;
/** Sync fetches headers plus a short text slice. Refuse anything larger than this. */
const IMAP_SYNC_MAX_LITERAL_BYTES = 64 * 1024;
/** Minimum gap between sync attempts, including attempts the isolate is killed during. */
export const IMAP_SYNC_MIN_INTERVAL_MS = 15_000;
/** First failure waits this long; each further failure doubles it. */
export const IMAP_SYNC_BACKOFF_BASE_MS = 60_000;
export const IMAP_SYNC_BACKOFF_MAX_MS = 15 * 60 * 1000;
/** Verification codes are useless after this. Also the gap that skips history. */
export const IMAP_CODE_WINDOW_MS = 15 * 60 * 1000;
export const IMAP_LONG_GAP_MS = IMAP_CODE_WINDOW_MS;
export const IMAP_MAX_MESSAGES_PER_ACCOUNT = 2;
export const IMAP_PARTIAL_TEXT_BYTES = 8192;
const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IMAP_MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export interface ImapAccountRow {
  id: string;
  label: string;
  enabled: number;
  host: string;
  port: number;
  tls: number;
  username: string;
  password_enc: string;
  last_uid: number;
  status: string;
  last_error: string | null;
  last_sync_at: string | null;
  sync_fail_count?: number;
  uid_baselined?: number;
  updated_at: string;
}

export interface ImapTestResult {
  ok: boolean;
  messages?: number;
  error?: string;
}

export interface SaveImapAccountInput {
  id?: string;
  label?: string;
  enabled?: boolean;
  host?: string;
  port?: number;
  tls?: boolean;
  username?: string;
  password?: string;
}

export class ImapAccountValidationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 = 400
  ) {
    super(message);
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function deriveImapAesKey(webhookSecret: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(webhookSecret),
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: textEncoder.encode('nonepwd:cf-imap-secret:v1'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts the IMAP app password using an HKDF-derived AES-256-GCM key bound to
 * the account webhook secret before persisting to D1.
 */
export async function encryptImapPassword(secretKeySource: string, plaintext: string): Promise<string> {
  const aesKey = await deriveImapAesKey(secretKeySource);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    textEncoder.encode(plaintext)
  );
  return `v1:${toHex(iv)}:${toHex(new Uint8Array(cipherBuf))}`;
}

export async function decryptImapPassword(secretKeySource: string, encoded: string): Promise<string> {
  if (!encoded) return '';
  const parts = encoded.split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Unsupported encrypted IMAP password format');
  }
  const aesKey = await deriveImapAesKey(secretKeySource);
  const iv = fromHex(parts[1]);
  const cipher = fromHex(parts[2]);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    aesKey,
    cipher as BufferSource
  );
  return textDecoder.decode(plainBuf);
}

export function clampImapPort(port: unknown, fallback: number = 993): number {
  if (port === undefined || port === null) return fallback;
  const parsed = Number(port);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535) {
    return Math.floor(parsed);
  }
  return 993;
}

function normalizeStatus(raw: string, enabled: boolean): ImapAccountStatus {
  if (!enabled) return 'disabled';
  if (raw === 'connecting' || raw === 'listening' || raw === 'error') {
    return raw;
  }
  return 'listening';
}

export function rowToImapAccountPublic(row: ImapAccountRow): ImapAccountPublic {
  const enabled = row.enabled === 1;
  return {
    id: row.id,
    label: row.label || deriveImapLabel(row.username),
    enabled,
    host: row.host,
    port: clampImapPort(row.port),
    tls: row.tls === 1,
    username: row.username,
    hasPassword: Boolean(row.password_enc),
    status: normalizeStatus(row.status, enabled),
    lastError: row.last_error ?? null,
    lastSyncAt: row.last_sync_at ?? null,
  };
}

export function computeAggregateImapConfig(accounts: ImapAccountPublic[]): ImapConfigPublic {
  if (accounts.length === 0) {
    return {
      enabled: false,
      host: '',
      port: 993,
      tls: true,
      username: '',
      hasPassword: false,
      status: 'disabled',
      lastError: null,
    };
  }

  const enabledAccounts = accounts.filter((a) => a.enabled);
  const primary = enabledAccounts[0] ?? accounts[0];
  let status: ImapAccountStatus = 'disabled';
  let lastError: string | null = null;

  if (enabledAccounts.length > 0) {
    const listening = enabledAccounts.find((a) => a.status === 'listening');
    const connecting = enabledAccounts.find((a) => a.status === 'connecting');
    const errored = enabledAccounts.find((a) => a.status === 'error');
    if (listening) {
      status = 'listening';
      lastError = null;
    } else if (connecting) {
      status = 'connecting';
      lastError = null;
    } else if (errored) {
      status = 'error';
      lastError = errored.lastError;
    } else {
      status = primary.status;
      lastError = primary.lastError;
    }
  }

  return {
    enabled: enabledAccounts.length > 0,
    host: primary.host,
    port: primary.port,
    tls: primary.tls,
    username: primary.username,
    hasPassword: primary.hasPassword,
    status,
    lastError,
  };
}

async function listImapAccountRows(db: D1Database): Promise<ImapAccountRow[]> {
  let res = await db
    .prepare(
      `SELECT id, label, enabled, host, port, tls, username, password_enc,
              last_uid, status, last_error, last_sync_at, updated_at
       FROM imap_accounts ORDER BY rowid ASC`
    )
    .all<ImapAccountRow>();
  let rows = res.results ?? [];
  if (rows.length === 0) {
    await ensureLegacyImapMigrated(db);
    res = await db
      .prepare(
        `SELECT id, label, enabled, host, port, tls, username, password_enc,
                last_uid, status, last_error, last_sync_at, updated_at
         FROM imap_accounts ORDER BY rowid ASC`
      )
      .all<ImapAccountRow>();
    rows = res.results ?? [];
  }
  return rows;
}

export async function listImapAccounts(db: D1Database): Promise<ImapAccountPublic[]> {
  const rows = await listImapAccountRows(db);
  return rows.map(rowToImapAccountPublic);
}

export async function getImapAccountById(
  db: D1Database,
  id: string
): Promise<ImapAccountPublic | null> {
  await ensureLegacyImapMigrated(db);
  const row = await db
    .prepare(
      `SELECT id, label, enabled, host, port, tls, username, password_enc,
              last_uid, status, last_error, last_sync_at, updated_at
       FROM imap_accounts WHERE id = ?`
    )
    .bind(id)
    .first<ImapAccountRow>();
  return row ? rowToImapAccountPublic(row) : null;
}

export async function getImapPublicConfig(db: D1Database): Promise<ImapConfigPublic> {
  const accounts = await listImapAccounts(db);
  return computeAggregateImapConfig(accounts);
}

export async function syncLegacyImapConfigFromAccounts(db: D1Database): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT id, label, enabled, host, port, tls, username, password_enc,
              last_uid, status, last_error, last_sync_at, updated_at
       FROM imap_accounts ORDER BY rowid ASC`
    )
    .all<ImapAccountRow>();
  const all = rows.results ?? [];
  const now = new Date().toISOString();

  if (all.length === 0) {
    await db
      .prepare(
        `UPDATE imap_config
         SET enabled = 0, host = '', port = 993, tls = 1, username = '', password_enc = '',
             last_uid = 0, status = 'disabled', last_error = NULL, last_sync_at = NULL, updated_at = ?
         WHERE id = 1`
      )
      .bind(now)
      .run();
    return;
  }

  const publicAccounts = all.map(rowToImapAccountPublic);
  const agg = computeAggregateImapConfig(publicAccounts);
  const primaryRow = all.find((r) => r.enabled === 1) ?? all[0];

  await db
    .prepare(
      `UPDATE imap_config
       SET enabled = ?, host = ?, port = ?, tls = ?, username = ?, password_enc = ?,
           last_uid = ?, status = ?, last_error = ?, last_sync_at = ?, updated_at = ?
       WHERE id = 1`
    )
    .bind(
      agg.enabled ? 1 : 0,
      primaryRow.host,
      clampImapPort(primaryRow.port),
      primaryRow.tls === 1 ? 1 : 0,
      primaryRow.username,
      primaryRow.password_enc,
      primaryRow.last_uid ?? 0,
      agg.status,
      agg.lastError,
      primaryRow.last_sync_at ?? null,
      now
    )
    .run();
}

async function getWebhookSecret(db: D1Database): Promise<string> {
  const account = await db
    .prepare('SELECT cf_webhook_secret FROM account WHERE id = 1')
    .first<{ cf_webhook_secret: string }>();
  if (!account?.cf_webhook_secret) {
    throw new ImapAccountValidationError('Account not initialized', 400);
  }
  return account.cf_webhook_secret;
}

export async function saveImapAccount(
  db: D1Database,
  input: SaveImapAccountInput,
  mode: 'create_or_upsert' | 'update_strict' | 'legacy_put'
): Promise<{
  id: string | null;
  created: boolean;
  enabled: boolean;
  hasPassword: boolean;
}> {
  await ensureLegacyImapMigrated(db);
  const webhookSecret = await getWebhookSecret(db);
  const rows = await listImapAccountRows(db);

  let existing: ImapAccountRow | undefined;
  let targetId = input.id?.trim() || '';

  if (mode === 'update_strict') {
    existing = rows.find((r) => r.id === targetId);
    if (!existing) {
      throw new ImapAccountValidationError('IMAP account not found', 404);
    }
  } else if (mode === 'create_or_upsert') {
    if (targetId) {
      existing = rows.find((r) => r.id === targetId);
    } else {
      targetId = randomId();
    }
  } else {
    // legacy_put: match by username, else first account, else 'legacy-1'
    const reqUsername = input.username?.trim().toLowerCase() ?? '';
    if (reqUsername) {
      existing = rows.find((r) => r.username.trim().toLowerCase() === reqUsername);
    }
    if (!existing && rows.length > 0) {
      existing = rows[0];
    }
    targetId = existing?.id ?? 'legacy-1';
  }

  const nextEnabled =
    input.enabled !== undefined
      ? Boolean(input.enabled)
      : existing
        ? existing.enabled === 1
        : mode !== 'legacy_put';
  const nextHost =
    input.host !== undefined ? input.host.trim() : existing?.host ?? '';
  const nextPort = clampImapPort(input.port, existing?.port ?? 993);
  const nextTls =
    input.tls !== undefined ? Boolean(input.tls) : existing ? existing.tls === 1 : true;
  const nextUsername =
    input.username !== undefined ? input.username.trim() : existing?.username ?? '';

  let nextPasswordEnc = existing?.password_enc ?? '';
  if (input.password && input.password.trim().length > 0) {
    nextPasswordEnc = await encryptImapPassword(webhookSecret, input.password);
  }

  const now = new Date().toISOString();

  // Preserve legacy PUT /api/imap behavior when clearing/saving empty config on fresh DB
  if (mode === 'legacy_put' && !existing && (!nextHost || !nextUsername)) {
    await db
      .prepare(
        `UPDATE imap_config
         SET enabled = ?, host = ?, port = ?, tls = ?, username = ?, password_enc = ?,
             last_uid = 0, status = ?, last_error = NULL, updated_at = ?
         WHERE id = 1`
      )
      .bind(
        nextEnabled ? 1 : 0,
        nextHost,
        nextPort,
        nextTls ? 1 : 0,
        nextUsername,
        nextPasswordEnc,
        nextEnabled ? 'listening' : 'disabled',
        now
      )
      .run();
    return { id: null, created: false, enabled: nextEnabled, hasPassword: Boolean(nextPasswordEnc) };
  }

  if (!nextHost || !nextUsername) {
    throw new ImapAccountValidationError('Missing host or username', 400);
  }

  if (mode === 'create_or_upsert' && !existing && !nextPasswordEnc) {
    throw new ImapAccountValidationError('Password is required for new IMAP account', 400);
  }

  let nextLabel: string;
  if (input.label !== undefined) {
    nextLabel = input.label.trim() || deriveImapLabel(nextUsername);
  } else if (existing?.label?.trim()) {
    nextLabel = existing.label.trim();
  } else {
    nextLabel = deriveImapLabel(nextUsername);
  }

  const endpointChanged =
    !existing ||
    nextHost !== existing.host ||
    nextPort !== clampImapPort(existing.port) ||
    nextUsername !== existing.username;
  const nextLastUid = endpointChanged ? 0 : existing?.last_uid ?? 0;
  const nextStatus: ImapAccountStatus = nextEnabled ? 'listening' : 'disabled';

  if (existing) {
    await db
      .prepare(
        `UPDATE imap_accounts
         SET label = ?, enabled = ?, host = ?, port = ?, tls = ?, username = ?, password_enc = ?,
             last_uid = ?, status = ?, last_error = NULL, updated_at = ?
         WHERE id = ?`
      )
      .bind(
        nextLabel,
        nextEnabled ? 1 : 0,
        nextHost,
        nextPort,
        nextTls ? 1 : 0,
        nextUsername,
        nextPasswordEnc,
        nextLastUid,
        nextStatus,
        now,
        targetId
      )
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO imap_accounts
         (id, label, enabled, host, port, tls, username, password_enc, last_uid, status, last_error, last_sync_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
      )
      .bind(
        targetId,
        nextLabel,
        nextEnabled ? 1 : 0,
        nextHost,
        nextPort,
        nextTls ? 1 : 0,
        nextUsername,
        nextPasswordEnc,
        nextLastUid,
        nextStatus,
        now
      )
      .run();
  }

  await syncLegacyImapConfigFromAccounts(db);

  return {
    id: targetId,
    created: !existing,
    enabled: nextEnabled,
    hasPassword: Boolean(nextPasswordEnc),
  };
}

export async function deleteImapAccount(db: D1Database, id: string): Promise<boolean> {
  await ensureLegacyImapMigrated(db);
  const res = await db.prepare('DELETE FROM imap_accounts WHERE id = ?').bind(id).run();
  const changes = Number(res.meta?.changes ?? 0);
  if (changes === 0) return false;
  await syncLegacyImapConfigFromAccounts(db);
  return true;
}

export async function resolveImapTestParams(
  db: D1Database,
  webhookSecret: string | undefined,
  body: {
    id?: string;
    host?: string;
    port?: number;
    tls?: boolean;
    username?: string;
    password?: string;
  }
): Promise<{ host: string; port: number; tls: boolean; username: string; password: string }> {
  await ensureLegacyImapMigrated(db);

  const requestedId = body.id?.trim();
  const requestedUser = body.username?.trim();
  let stored: {
    host: string;
    port: number;
    tls: number;
    username: string;
    password_enc: string;
  } | null = null;

  if (requestedId) {
    stored = await db
      .prepare(
        'SELECT host, port, tls, username, password_enc FROM imap_accounts WHERE id = ?'
      )
      .bind(requestedId)
      .first();
  } else if (requestedUser) {
    stored = await db
      .prepare(
        'SELECT host, port, tls, username, password_enc FROM imap_accounts WHERE LOWER(username) = LOWER(?)'
      )
      .bind(requestedUser)
      .first();
  } else {
    stored = await db
      .prepare(
        'SELECT host, port, tls, username, password_enc FROM imap_accounts ORDER BY rowid ASC LIMIT 1'
      )
      .first();
  }

  if (!stored) {
    const legacy = await db
      .prepare('SELECT host, port, tls, username, password_enc FROM imap_config WHERE id = 1')
      .first<{
        host: string;
        port: number;
        tls: number;
        username: string;
        password_enc: string;
      }>();
    if (
      legacy &&
      (!requestedUser || legacy.username.trim().toLowerCase() === requestedUser.toLowerCase())
    ) {
      stored = legacy;
    }
  }

  const host = (body.host ?? stored?.host ?? '').trim();
  const port = clampImapPort(body.port, stored?.port ?? 993);
  const tls = body.tls !== undefined ? Boolean(body.tls) : (stored?.tls ?? 1) === 1;
  const username = (body.username ?? stored?.username ?? '').trim();

  let password = body.password && body.password.trim().length > 0 ? body.password : '';
  if (!password && stored?.password_enc && webhookSecret) {
    password = await decryptImapPassword(webhookSecret, stored.password_enc);
  }

  return { host, port, tls, username, password };
}

function imapQuoteString(val: string): string {
  if (/[\r\n\0]/.test(val)) {
    throw new Error('IMAP parameter must not contain CR/LF/NUL');
  }
  const escaped = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function parseLiteralLen(line: string): number | null {
  const trimmed = line.replace(/\r?\n$/, '');
  if (!trimmed.endsWith('}')) return null;
  const openIdx = trimmed.lastIndexOf('{');
  if (openIdx < 0) return null;
  const inner = trimmed.slice(openIdx + 1, -1).replace(/\+$/, '');
  if (!/^\d+$/.test(inner)) return null;
  return Number(inner);
}

function formatImapDateUtc(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = IMAP_MONTHS[date.getUTCMonth()] ?? 'Jan';
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

/** 15s after success. Failures back off from 1 minute, doubling, capped at 15 minutes. */
export function syncMinIntervalMs(failCount: number): number {
  const n = Math.max(0, Math.floor(failCount));
  if (n <= 0) return IMAP_SYNC_MIN_INTERVAL_MS;
  const shift = Math.min(n - 1, 8);
  return Math.min(IMAP_SYNC_BACKOFF_MAX_MS, IMAP_SYNC_BACKOFF_BASE_MS * 2 ** shift);
}

export function isSyncThrottled(
  lastSyncAt: string | null,
  failCount: number,
  nowMs: number = Date.now()
): boolean {
  if (!lastSyncAt) return false;
  const last = Date.parse(lastSyncAt);
  if (Number.isNaN(last)) return false;
  return nowMs - last < syncMinIntervalMs(failCount);
}

/**
 * First contact, or a gap longer than a verification code stays valid:
 * record the current high-water UID and do not download history.
 */
export function shouldBaselineUid(
  uidBaselined: boolean,
  lastSyncAt: string | null,
  nowMs: number = Date.now()
): boolean {
  if (!uidBaselined) return true;
  if (!lastSyncAt) return true;
  const last = Date.parse(lastSyncAt);
  if (Number.isNaN(last)) return true;
  return nowMs - last >= IMAP_LONG_GAP_MS;
}

export function buildVerificationUidSearch(lastUid: number, now: Date = new Date()): string {
  const since = new Date(now.getTime() - IMAP_CODE_WINDOW_MS);
  const start = Math.max(0, Math.floor(lastUid)) + 1;
  return `UID SEARCH UID ${start}:* SINCE ${formatImapDateUtc(since)}`;
}

export function buildPartialBodyFetch(uid: number): string {
  return `UID FETCH ${uid} (UID INTERNALDATE BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.${IMAP_PARTIAL_TEXT_BYTES}>)`;
}

export function parseImapSearchUids(lines: string[]): number[] {
  const uids: number[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.toUpperCase().startsWith('* SEARCH')) continue;
    const tokens = trimmed.slice('* SEARCH'.length).trim().split(/\s+/);
    for (const tok of tokens) {
      if (/^\d+$/.test(tok)) uids.push(Number(tok));
    }
  }
  return uids;
}

/** Oldest UIDs still above last_uid, so a run cannot skip a message it did not read. */
export function selectNextUids(
  uids: number[],
  lastUid: number,
  limit: number = IMAP_MAX_MESSAGES_PER_ACCOUNT
): number[] {
  const fresh = [...new Set(uids.filter((u) => Number.isFinite(u) && u > lastUid))].sort((a, b) => a - b);
  const take = Math.max(0, Math.floor(limit));
  return take === 0 ? [] : fresh.slice(0, take);
}

export function selectNewestUids(
  uids: number[],
  lastUid: number,
  limit: number = IMAP_MAX_MESSAGES_PER_ACCOUNT
): { fetch: number[]; advanceTo: number } {
  const fresh = [...new Set(uids.filter((u) => Number.isFinite(u) && u > lastUid))].sort((a, b) => a - b);
  if (fresh.length === 0) return { fetch: [], advanceTo: lastUid };
  const take = Math.max(0, Math.floor(limit));
  return {
    fetch: take === 0 ? [] : fresh.slice(-take),
    advanceTo: fresh[fresh.length - 1]!,
  };
}

export function parseUidNext(lines: string[]): number | null {
  for (const line of lines) {
    const m = line.match(/\bUIDNEXT\s+(\d+)/i);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

export function parseHighestFetchedUid(lines: string[]): number | null {
  let max: number | null = null;
  for (const line of lines) {
    const m = line.match(/\bUID\s+(\d+)/i);
    if (!m?.[1]) continue;
    const n = Number(m[1]);
    if (max === null || n > max) max = n;
  }
  return max;
}

export function parseFetchInternalDate(line: string): Date | null {
  const m = line.match(
    /INTERNALDATE\s+"(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})"/i
  );
  if (!m) return null;
  const month = IMAP_MONTH_INDEX[m[2]!.toLowerCase()];
  if (month === undefined) return null;
  const sign = m[7]!.startsWith('-') ? -1 : 1;
  const tzMin = sign * (Number(m[7]!.slice(1, 3)) * 60 + Number(m[7]!.slice(3, 5)));
  const utc =
    Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) -
    tzMin * 60 * 1000;
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function messageDateFromRaw(bytes: Uint8Array): Date | null {
  if (bytes.byteLength === 0) return null;
  const n = Math.min(bytes.byteLength, 8192);
  const text = textDecoder.decode(bytes.subarray(0, n));
  const headerEnd = text.search(/\r?\n\r?\n/);
  const headers = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const m = headers.match(/^Date:\s*(.+)$/im);
  if (!m?.[1]) return null;
  const date = new Date(m[1].trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isWithinCodeWindow(
  date: Date,
  nowMs: number = Date.now(),
  windowMs: number = IMAP_CODE_WINDOW_MS
): boolean {
  const t = date.getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t <= windowMs;
}

/** True when the message is dated and that date is outside the code window. Undated messages are kept. */
export function shouldSkipStaleCode(date: Date | null, nowMs: number = Date.now()): boolean {
  if (!date) return false;
  return !isWithinCodeWindow(date, nowMs);
}

/** Permanent reasons only. Never include message contents. */
const IMAP_DROP_REASONS = new Set([
  'stale',
  'filtered',
  'alias_disabled',
  'account_not_initialized',
  'empty',
  'baseline',
]);

export function logImapDrop(reason: string): void {
  const safe = IMAP_DROP_REASONS.has(reason) ? reason : 'rejected';
  console.log(`imap drop ${safe}`);
}

/**
 * Byte queue over a socket reader.
 * `pull()` appends each chunk by reference. It does not copy the bytes already buffered,
 * so a large message is O(n) instead of O(n^2).
 */
export class SocketByteReader {
  private chunks: Uint8Array[] = [];
  private startChunk = 0;
  private startOffset = 0;
  private buffered = 0;
  private eof = false;
  /** Bytes copied while appending a chunk. Always 0: pull() does not merge buffers. */
  pullCopyBytes = 0;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /** How many unread socket chunks are queued. Useful to show pull() did not merge them. */
  pendingChunkCount(): number {
    return this.chunks.length - this.startChunk;
  }

  private async pull(): Promise<boolean> {
    if (this.eof) return false;
    const { done, value } = await this.reader.read();
    if (done || !value) {
      this.eof = true;
      return false;
    }
    if (value.byteLength === 0) {
      return this.pull();
    }
    this.chunks.push(value);
    this.buffered += value.byteLength;
    return true;
  }

  private compact(): void {
    if (this.startChunk > 16) {
      this.chunks.splice(0, this.startChunk);
      this.startChunk = 0;
    }
  }

  private findByte(byte: number): number {
    let pos = 0;
    for (let i = this.startChunk; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      const offset = i === this.startChunk ? this.startOffset : 0;
      const idx = chunk.indexOf(byte, offset);
      if (idx !== -1) return pos + (idx - offset);
      pos += chunk.byteLength - offset;
    }
    return -1;
  }

  private copyAndDiscard(length: number): Uint8Array {
    const out = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const chunk = this.chunks[this.startChunk];
      if (!chunk) throw new Error('IMAP buffer underflow');
      const avail = chunk.byteLength - this.startOffset;
      const take = Math.min(avail, length - written);
      out.set(chunk.subarray(this.startOffset, this.startOffset + take), written);
      written += take;
      this.buffered -= take;
      if (take === avail) {
        this.startChunk += 1;
        this.startOffset = 0;
      } else {
        this.startOffset += take;
      }
    }
    this.compact();
    return out;
  }

  async readLine(): Promise<string | null> {
    while (true) {
      const nlIdx = this.findByte(0x0a);
      if (nlIdx !== -1) {
        return textDecoder.decode(this.copyAndDiscard(nlIdx + 1));
      }
      const ok = await this.pull();
      if (!ok) {
        if (this.buffered === 0) return null;
        return textDecoder.decode(this.copyAndDiscard(this.buffered));
      }
    }
  }

  async readExact(length: number): Promise<Uint8Array> {
    while (this.buffered < length) {
      const ok = await this.pull();
      if (!ok) {
        throw new Error('IMAP stream ended mid-literal');
      }
    }
    return this.copyAndDiscard(length);
  }
}

class WorkersImapClient {
  private tagSeq = 1;
  private readonly byteReader: SocketByteReader;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  private constructor(
    private readonly socket: CfSocket,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    private readonly maxLiteral: number
  ) {
    this.byteReader = new SocketByteReader(reader);
    this.writer = writer;
  }

  static async connect(
    host: string,
    port: number,
    tls: boolean,
    opts?: { maxLiteral?: number }
  ): Promise<WorkersImapClient> {
    const cleanHost = host.trim();
    if (!cleanHost) {
      throw new Error('IMAP host must not be empty');
    }
    const { connect } = await import('cloudflare:sockets');
    const socket = connect(
      { hostname: cleanHost, port },
      { secureTransport: tls ? 'on' : 'off' }
    );
    const reader = socket.readable.getReader();
    const writer = socket.writable.getWriter();
    const client = new WorkersImapClient(
      socket,
      reader,
      writer,
      opts?.maxLiteral ?? MAX_IMAP_LITERAL_BYTES
    );

    const greeting = await client.byteReader.readLine();
    if (!greeting) {
      await client.close();
      throw new Error('IMAP server closed connection before greeting');
    }
    const trimmed = greeting.trimStart().toUpperCase();
    if (!trimmed.startsWith('* OK') && !trimmed.startsWith('* PREAUTH')) {
      await client.close();
      throw new Error(`Unexpected IMAP greeting: ${greeting.trim()}`);
    }
    return client;
  }

  private nextTag(): string {
    const t = `A${String(this.tagSeq).padStart(4, '0')}`;
    this.tagSeq += 1;
    return t;
  }

  async runCommand(cmdBody: string): Promise<Array<{ line: string; literal: Uint8Array }>> {
    const tag = this.nextTag();
    await this.writer.write(textEncoder.encode(`${tag} ${cmdBody}\r\n`));

    const responses: Array<{ line: string; literal: Uint8Array }> = [];
    const okPrefix = `${tag} OK`;
    const noPrefix = `${tag} NO`;
    const badPrefix = `${tag} BAD`;

    while (true) {
      const line = await this.byteReader.readLine();
      if (line === null) {
        throw new Error('IMAP connection closed unexpectedly');
      }
      const upper = line.trimStart().toUpperCase();
      if (upper.startsWith(okPrefix)) {
        return responses;
      }
      if (upper.startsWith(noPrefix) || upper.startsWith(badPrefix)) {
        throw new Error(`IMAP command rejected: ${line.trim()}`);
      }

      const literalChunks: Uint8Array[] = [];
      let currentLine = line;
      while (true) {
        const litLen = parseLiteralLen(currentLine);
        if (litLen === null) break;
        if (litLen > this.maxLiteral) {
          throw new Error(`IMAP literal (${litLen} bytes) exceeds ${this.maxLiteral} byte limit`);
        }
        const rawLit = await this.byteReader.readExact(litLen);
        literalChunks.push(rawLit);
        const postLine = await this.byteReader.readLine();
        if (postLine === null) {
          throw new Error('IMAP connection closed after literal');
        }
        currentLine = postLine;
      }

      let combinedLiteral: Uint8Array;
      if (literalChunks.length === 0) {
        combinedLiteral = new Uint8Array(0);
      } else if (literalChunks.length === 1) {
        combinedLiteral = literalChunks[0];
      } else {
        const total = literalChunks.reduce((acc, c) => acc + c.byteLength, 0);
        combinedLiteral = new Uint8Array(total);
        let offset = 0;
        for (const c of literalChunks) {
          combinedLiteral.set(c, offset);
          offset += c.byteLength;
        }
      }

      responses.push({ line, literal: combinedLiteral });
    }
  }

  async login(host: string, username: string, password: string): Promise<void> {
    await this.runCommand(`LOGIN ${imapQuoteString(username)} ${imapQuoteString(password)}`);
    const lowerHost = host.toLowerCase();
    // NetEase mail servers (163/126/yeah.net) require RFC 2971 ID before SELECT INBOX
    if (
      lowerHost.includes('163.com') ||
      lowerHost.includes('126.com') ||
      lowerHost.includes('yeah.net')
    ) {
      try {
        await this.runCommand('ID ("name" "nonepwd" "version" "0.1.0")');
      } catch {
        // ignore if unsupported
      }
    }
  }

  async selectInbox(): Promise<number> {
    const lines = await this.runCommand('SELECT "INBOX"');
    for (const item of lines) {
      const m = item.line.match(/^\*\s+(\d+)\s+EXISTS\b/i);
      if (m?.[1]) {
        return Number(m[1]);
      }
    }
    return 0;
  }

  async logout(): Promise<void> {
    try {
      await Promise.race([
        this.runCommand('LOGOUT'),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch {
      // ignore logout error
    }
  }

  async close(): Promise<void> {
    try {
      this.writer.releaseLock();
    } catch {
      // ignore
    }
    try {
      await this.socket.close();
    } catch {
      // ignore
    }
  }
}

async function withTimeout<T>(ms: number, task: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`IMAP operation timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function testImapConnection(params: {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
}): Promise<ImapTestResult> {
  let client: WorkersImapClient | null = null;
  try {
    return await withTimeout(10_000, async () => {
      client = await WorkersImapClient.connect(params.host, params.port, params.tls);
      await client.login(params.host, params.username, params.password);
      const messages = await client.selectInbox();
      await client.logout();
      return { ok: true, messages };
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (client) {
      await (client as WorkersImapClient).close();
    }
  }
}

export interface ImapSyncResult {
  synced: number;
  error?: string;
  throttled?: boolean;
  baselined?: boolean;
}

async function markImapFailure(env: CfServerEnv, accountId: string, message: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE imap_accounts
     SET status = 'error', last_error = ?, last_sync_at = ?,
         sync_fail_count = COALESCE(sync_fail_count, 0) + 1, updated_at = ?
     WHERE id = ?`
  )
    .bind(message, now, now, accountId)
    .run();
  await syncLegacyImapConfigFromAccounts(env.DB);
}

async function markImapAttempt(env: CfServerEnv, accountId: string): Promise<void> {
  const now = new Date().toISOString();
  // Stamp before any socket work. A CPU kill still leaves last_sync_at set, so the next
  // invocation is throttled instead of restarting a full mailbox download.
  await env.DB.prepare(
    `UPDATE imap_accounts SET status = 'connecting', last_sync_at = ?, updated_at = ? WHERE id = ?`
  )
    .bind(now, now, accountId)
    .run();
}

async function markImapSuccess(env: CfServerEnv, accountId: string, lastUid: number): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE imap_accounts
     SET last_uid = ?, status = 'listening', last_error = NULL, last_sync_at = ?,
         sync_fail_count = 0, uid_baselined = 1, updated_at = ?
     WHERE id = ?`
  )
    .bind(lastUid, now, now, accountId)
    .run();
  await syncLegacyImapConfigFromAccounts(env.DB);
}

async function readMailboxHighWater(client: WorkersImapClient): Promise<number> {
  const statusLines = await client.runCommand('STATUS "INBOX" (UIDNEXT)');
  const uidNext = parseUidNext(statusLines.map((item) => item.line));
  if (uidNext !== null) return Math.max(0, uidNext - 1);
  const fetched = await client.runCommand('UID FETCH * (UID)');
  const highest = parseHighestFetchedUid(fetched.map((item) => item.line));
  return highest ?? 0;
}

type ImapReadOutcome =
  | 'stored'
  | 'stale'
  | 'filtered'
  | 'alias_disabled'
  | 'account_not_initialized'
  | 'empty'
  | 'failed';

function messageDateFromFetch(items: Array<{ line: string; literal: Uint8Array }>): Date | null {
  for (const item of items) {
    const dated = parseFetchInternalDate(item.line) ?? messageDateFromRaw(item.literal);
    if (dated) return dated;
  }
  return null;
}

/**
 * Date probe first so a stale message is not parsed or encrypted.
 * A throw, including an oversized literal, is a failed read: the caller must not
 * move last_uid past this UID.
 */
async function readOneImapMessage(
  client: WorkersImapClient,
  env: CfServerEnv,
  uid: number,
  envelopeTo: string | undefined
): Promise<ImapReadOutcome> {
  try {
    const meta = await client.runCommand(`UID FETCH ${uid} (UID INTERNALDATE)`);
    const receivedAt = messageDateFromFetch(meta);
    if (shouldSkipStaleCode(receivedAt)) return 'stale';

    const fetched = await client.runCommand(buildPartialBodyFetch(uid));
    // INTERNALDATE is when the mailbox received the code. The Date header can be
    // older (a forward, or a few minutes of transit) and must not discard it.
    if (!receivedAt && shouldSkipStaleCode(messageDateFromFetch(fetched))) return 'stale';

    let sawBody = false;
    for (const item of fetched) {
      if (item.literal.byteLength === 0) continue;
      sawBody = true;
      const res = await ingestRawEmail({
        env,
        rawMime: item.literal,
        source: 'imap',
        envelopeTo,
      });
      if (res.accepted) return 'stored';
      if (
        res.reason === 'filtered' ||
        res.reason === 'alias_disabled' ||
        res.reason === 'account_not_initialized'
      ) {
        return res.reason;
      }
      return 'failed';
    }
    return sawBody ? 'failed' : 'empty';
  } catch {
    return 'failed';
  }
}

export async function syncImapAccount(
  env: CfServerEnv,
  accountId: string,
  options?: { rejectDisabled?: boolean }
): Promise<ImapSyncResult> {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare(
    `SELECT id, label, enabled, host, port, tls, username, password_enc,
            last_uid, status, last_error, last_sync_at, sync_fail_count, uid_baselined, updated_at
     FROM imap_accounts WHERE id = ?`
  )
    .bind(accountId)
    .first<ImapAccountRow>();

  if (!row) {
    return { synced: 0, error: 'IMAP account not found' };
  }

  if (row.enabled !== 1) {
    return options?.rejectDisabled
      ? { synced: 0, error: 'IMAP account is disabled' }
      : { synced: 0 };
  }

  if (!row.host || !row.username || !row.password_enc) {
    return { synced: 0 };
  }

  const failCount = Number(row.sync_fail_count ?? 0);
  if (isSyncThrottled(row.last_sync_at, failCount)) {
    return { synced: 0, throttled: true };
  }

  const account = await env.DB.prepare('SELECT cf_webhook_secret FROM account WHERE id = 1').first<{
    cf_webhook_secret: string;
  }>();
  if (!account?.cf_webhook_secret) {
    return { synced: 0 };
  }

  let password = '';
  try {
    password = await decryptImapPassword(account.cf_webhook_secret, row.password_enc);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markImapFailure(env, row.id, msg);
    return { synced: 0, error: msg };
  }

  const baseline = shouldBaselineUid(Number(row.uid_baselined ?? 0) === 1, row.last_sync_at);
  await markImapAttempt(env, row.id);

  let client: WorkersImapClient | null = null;
  let synced = 0;

  try {
    return await withTimeout(15_000, async () => {
      client = await WorkersImapClient.connect(row.host, clampImapPort(row.port), row.tls === 1, {
        maxLiteral: IMAP_SYNC_MAX_LITERAL_BYTES,
      });
      await client.login(row.host, row.username, password);
      await client.selectInbox();

      const searchLines = await client.runCommand(buildVerificationUidSearch(row.last_uid ?? 0));
      const found = parseImapSearchUids(searchLines.map((item) => item.line));
      const targetUids = selectNextUids(found, row.last_uid ?? 0, IMAP_MAX_MESSAGES_PER_ACCOUNT);

      const envelopeTo = row.username.trim() || undefined;
      let committedUid = row.last_uid ?? 0;
      let failed = false;

      for (const uid of targetUids) {
        const outcome = await readOneImapMessage(client, env, uid, envelopeTo);
        if (outcome === 'failed') {
          failed = true;
          break;
        }
        if (outcome === 'stored') synced += 1;
        else logImapDrop(outcome);
        committedUid = Math.max(committedUid, uid);
        await env.DB.prepare(
          'UPDATE imap_accounts SET last_uid = ? WHERE id = ? AND last_uid < ?'
        )
          .bind(committedUid, row.id, committedUid)
          .run();
      }

      if (failed) {
        throw new Error('IMAP message was not processed');
      }

      // Nothing in the code window: park last_uid at the mailbox high-water mark
      // so the next alarm does not keep listing history that SINCE already excluded.
      if (baseline && found.length === 0) {
        const highWater = await readMailboxHighWater(client);
        if (highWater > committedUid) {
          logImapDrop('baseline');
          committedUid = highWater;
        }
      }

      await client.logout();
      await markImapSuccess(env, row.id, committedUid);
      return { synced, baselined: baseline };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markImapFailure(env, row.id, msg);
    return { synced, error: msg };
  } finally {
    if (client) {
      await (client as WorkersImapClient).close();
    }
  }
}

/** The single enabled account that is past its throttle, oldest sync first. */
export async function syncNextDueImapAccount(
  env: CfServerEnv
): Promise<ImapSyncResult & { moreDue: boolean }> {
  await ensureSchema(env.DB);
  const rows = await env.DB.prepare(
    `SELECT id, last_sync_at, sync_fail_count
     FROM imap_accounts
     WHERE enabled = 1
     ORDER BY last_sync_at IS NULL DESC, last_sync_at ASC, rowid ASC`
  ).all<{ id: string; last_sync_at: string | null; sync_fail_count: number | null }>();
  const all = rows.results ?? [];
  const now = Date.now();
  const due = all.filter(
    (row) => !isSyncThrottled(row.last_sync_at, Number(row.sync_fail_count ?? 0), now)
  );
  if (due.length === 0) {
    return { synced: 0, throttled: all.length > 0, moreDue: false };
  }
  const res = await syncImapAccount(env, due[0]!.id);
  return { ...res, moreDue: due.length > 1 };
}

export async function syncImapInbox(
  env: CfServerEnv,
  options?: { accountId?: string }
): Promise<ImapSyncResult> {
  await ensureSchema(env.DB);
  if (options?.accountId) {
    return syncImapAccount(env, options.accountId, { rejectDisabled: true });
  }

  const enabledRows = await env.DB.prepare(
    `SELECT id, username FROM imap_accounts WHERE enabled = 1 ORDER BY rowid ASC`
  ).all<{ id: string; username: string }>();

  const targets = enabledRows.results ?? [];
  if (targets.length === 0) {
    return { synced: 0 };
  }

  let synced = 0;
  let throttledCount = 0;
  const errors: string[] = [];
  for (const target of targets) {
    const res = await syncImapAccount(env, target.id);
    synced += res.synced;
    if (res.throttled) throttledCount += 1;
    if (res.error) {
      errors.push(targets.length > 1 ? `${target.username}: ${res.error}` : res.error);
    }
  }

  return {
    synced,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    ...(throttledCount === targets.length ? { throttled: true } : {}),
  };
}
