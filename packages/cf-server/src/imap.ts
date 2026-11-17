import {
  randomId,
  type ImapAccountPublic,
  type ImapAccountStatus,
  type ImapConfigPublic,
} from '@nonepwd/core/worker';
import type { CfSocket } from 'cloudflare:sockets';
import { ingestRawEmail } from './email.js';
import { deriveImapLabel, ensureLegacyImapMigrated } from './schema.js';
import type { CfServerEnv } from './types.js';

const MAX_IMAP_LITERAL_BYTES = 8 * 1024 * 1024;
const IMAP_SYNC_MIN_INTERVAL_MS = 15_000;
const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

class SocketByteReader {
  private buf = new Uint8Array(0);
  private eof = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

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
    const merged = new Uint8Array(this.buf.byteLength + value.byteLength);
    merged.set(this.buf, 0);
    merged.set(value, this.buf.byteLength);
    this.buf = merged;
    return true;
  }

  async readLine(): Promise<string | null> {
    while (true) {
      const nlIdx = this.buf.indexOf(0x0a);
      if (nlIdx !== -1) {
        const lineBytes = this.buf.slice(0, nlIdx + 1);
        this.buf = this.buf.slice(nlIdx + 1);
        return textDecoder.decode(lineBytes);
      }
      const ok = await this.pull();
      if (!ok) {
        if (this.buf.byteLength === 0) return null;
        const tail = this.buf;
        this.buf = new Uint8Array(0);
        return textDecoder.decode(tail);
      }
    }
  }

  async readExact(length: number): Promise<Uint8Array> {
    while (this.buf.byteLength < length) {
      const ok = await this.pull();
      if (!ok) {
        throw new Error('IMAP stream ended mid-literal');
      }
    }
    const out = this.buf.slice(0, length);
    this.buf = this.buf.slice(length);
    return out;
  }
}

class WorkersImapClient {
  private tagSeq = 1;
  private readonly byteReader: SocketByteReader;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  private constructor(
    private readonly socket: CfSocket,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>
  ) {
    this.byteReader = new SocketByteReader(reader);
    this.writer = writer;
  }

  static async connect(host: string, port: number, tls: boolean): Promise<WorkersImapClient> {
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
    const client = new WorkersImapClient(socket, reader, writer);

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
        if (litLen > MAX_IMAP_LITERAL_BYTES) {
          throw new Error(`IMAP literal (${litLen} bytes) exceeds 8 MiB limit`);
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

export async function syncImapAccount(
  env: CfServerEnv,
  accountId: string,
  options?: { force?: boolean; rejectDisabled?: boolean }
): Promise<{ synced: number; error?: string }> {
  await ensureLegacyImapMigrated(env.DB);
  const row = await env.DB.prepare(
    `SELECT id, label, enabled, host, port, tls, username, password_enc,
            last_uid, status, last_error, last_sync_at, updated_at
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

  if (!options?.force && row.last_sync_at) {
    const lastMs = Date.parse(row.last_sync_at);
    if (!Number.isNaN(lastMs) && Date.now() - lastMs < IMAP_SYNC_MIN_INTERVAL_MS) {
      return { synced: 0 };
    }
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
    const now = new Date().toISOString();
    await env.DB.prepare(
      'UPDATE imap_accounts SET status = ?, last_error = ?, last_sync_at = ?, updated_at = ? WHERE id = ?'
    )
      .bind('error', msg, now, now, row.id)
      .run();
    await syncLegacyImapConfigFromAccounts(env.DB);
    return { synced: 0, error: msg };
  }

  let client: WorkersImapClient | null = null;
  let synced = 0;

  try {
    return await withTimeout(15_000, async () => {
      client = await WorkersImapClient.connect(row.host, clampImapPort(row.port), row.tls === 1);
      await client.login(row.host, row.username, password);
      await client.selectInbox();

      const sinceDate = new Date(Date.now() - 36 * 60 * 60 * 1000);
      const searchLines = await client.runCommand(
        `UID SEARCH SINCE ${formatImapDateUtc(sinceDate)}`
      );

      const allUids: number[] = [];
      for (const item of searchLines) {
        const trimmed = item.line.trim();
        if (trimmed.toUpperCase().startsWith('* SEARCH')) {
          const tokens = trimmed.slice('* SEARCH'.length).trim().split(/\s+/);
          for (const tok of tokens) {
            if (/^\d+$/.test(tok)) {
              allUids.push(Number(tok));
            }
          }
        }
      }

      const uniqueSorted = Array.from(new Set(allUids)).sort((a, b) => a - b);
      let highestUid = row.last_uid;
      let targetUids: number[] = [];

      if (uniqueSorted.length > 0) {
        const maxFound = uniqueSorted[uniqueSorted.length - 1];
        if (row.last_uid === 0) {
          // On initial sync, only process up to the 5 newest messages to avoid historical flood
          targetUids = uniqueSorted.slice(-5);
          highestUid = maxFound;
        } else {
          targetUids = uniqueSorted.filter((u) => u > row.last_uid).slice(-15);
          if (options?.force) {
            const countRow = await env.DB.prepare(
              'SELECT COUNT(*) AS cnt FROM encrypted_emails WHERE LOWER(envelope_to) = LOWER(?)'
            )
              .bind(row.username.trim())
              .first<{ cnt: number }>();
            if (Number(countRow?.cnt ?? 0) === 0) {
              targetUids = uniqueSorted.slice(-10);
            }
          }
          if (maxFound > highestUid) {
            highestUid = maxFound;
          }
        }
      }

      const envelopeTo = row.username.trim() || undefined;
      for (const uid of targetUids) {
        const fetched = await client.runCommand(`UID FETCH ${uid} (UID BODY.PEEK[])`);
        for (const item of fetched) {
          if (item.literal.byteLength > 0) {
            const res = await ingestRawEmail({
              env,
              rawMime: item.literal,
              source: 'imap',
              envelopeTo,
            });
            if (res.accepted) {
              synced += 1;
            }
          }
        }
        if (uid > highestUid) {
          highestUid = uid;
        }
      }

      await client.logout();

      const now = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE imap_accounts
         SET last_uid = ?, status = 'listening', last_error = NULL, last_sync_at = ?, updated_at = ?
         WHERE id = ?`
      )
        .bind(highestUid, now, now, row.id)
        .run();
      await syncLegacyImapConfigFromAccounts(env.DB);

      return { synced };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE imap_accounts
       SET status = 'error', last_error = ?, last_sync_at = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(msg, now, now, row.id)
      .run();
    await syncLegacyImapConfigFromAccounts(env.DB);
    return { synced, error: msg };
  } finally {
    if (client) {
      await (client as WorkersImapClient).close();
    }
  }
}

export async function syncImapInbox(
  env: CfServerEnv,
  options?: { force?: boolean; accountId?: string }
): Promise<{ synced: number; error?: string }> {
  await ensureLegacyImapMigrated(env.DB);
  if (options?.accountId) {
    return syncImapAccount(env, options.accountId, {
      force: options.force,
      rejectDisabled: true,
    });
  }

  const enabledRows = await env.DB.prepare(
    `SELECT id, username FROM imap_accounts WHERE enabled = 1 ORDER BY rowid ASC`
  ).all<{ id: string; username: string }>();

  const targets = enabledRows.results ?? [];
  if (targets.length === 0) {
    return { synced: 0 };
  }

  const results = await Promise.all(
    targets.map(async (target) => ({
      username: target.username,
      res: await syncImapAccount(env, target.id, { force: options?.force }),
    }))
  );

  let synced = 0;
  const errors: string[] = [];
  for (const item of results) {
    synced += item.res.synced;
    if (item.res.error) {
      errors.push(targets.length > 1 ? `${item.username}: ${item.res.error}` : item.res.error);
    }
  }

  return errors.length > 0 ? { synced, error: errors.join('; ') } : { synced };
}
