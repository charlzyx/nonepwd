import type { ImapConfigPublic } from '@nonepwd/core/worker';
import type { CfSocket } from 'cloudflare:sockets';
import { ingestRawEmail } from './email.js';
import type { CfServerEnv } from './types.js';

const MAX_IMAP_LITERAL_BYTES = 8 * 1024 * 1024;
const IMAP_SYNC_MIN_INTERVAL_MS = 15_000;
const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface ImapRow {
  enabled: number;
  host: string;
  port: number;
  tls: number;
  username: string;
  password_enc: string;
  last_uid: number;
  status: 'disabled' | 'connecting' | 'listening' | 'error';
  last_error: string | null;
  last_sync_at: string | null;
}

export interface ImapTestResult {
  ok: boolean;
  messages?: number;
  error?: string;
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

export async function getImapPublicConfig(db: D1Database): Promise<ImapConfigPublic> {
  const row = await db
    .prepare(
      `SELECT enabled, host, port, tls, username, password_enc, status, last_error
       FROM imap_config WHERE id = 1`
    )
    .first<Omit<ImapRow, 'last_uid' | 'last_sync_at'>>();

  if (!row) {
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

  return {
    enabled: row.enabled === 1,
    host: row.host,
    port: row.port,
    tls: row.tls === 1,
    username: row.username,
    hasPassword: Boolean(row.password_enc),
    status: row.status,
    lastError: row.last_error,
  };
}

export async function getStoredImapPassword(
  db: D1Database,
  webhookSecret: string
): Promise<string> {
  const row = await db
    .prepare('SELECT password_enc FROM imap_config WHERE id = 1')
    .first<{ password_enc: string }>();
  if (!row?.password_enc) return '';
  return decryptImapPassword(webhookSecret, row.password_enc);
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

export async function syncImapInbox(
  env: CfServerEnv,
  options?: { force?: boolean }
): Promise<{ synced: number; error?: string }> {
  const row = await env.DB.prepare(
    `SELECT enabled, host, port, tls, username, password_enc, last_uid, status, last_error, last_sync_at
     FROM imap_config WHERE id = 1`
  ).first<ImapRow>();

  if (!row || row.enabled !== 1 || !row.host || !row.username || !row.password_enc) {
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
    await env.DB.prepare(
      'UPDATE imap_config SET status = ?, last_error = ?, last_sync_at = ?, updated_at = ? WHERE id = 1'
    )
      .bind('error', msg, new Date().toISOString(), new Date().toISOString())
      .run();
    return { synced: 0, error: msg };
  }

  let client: WorkersImapClient | null = null;
  let synced = 0;

  try {
    return await withTimeout(15_000, async () => {
      client = await WorkersImapClient.connect(row.host, row.port, row.tls === 1);
      await client.login(row.host, row.username, password);
      await client.selectInbox();

      const sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
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
          if (maxFound > highestUid) {
            highestUid = maxFound;
          }
        }
      }

      for (const uid of targetUids) {
        const fetched = await client.runCommand(`UID FETCH ${uid} (UID BODY.PEEK[])`);
        for (const item of fetched) {
          if (item.literal.byteLength > 0) {
            const res = await ingestRawEmail({
              env,
              rawMime: item.literal,
              source: 'imap',
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
        `UPDATE imap_config
         SET last_uid = ?, status = 'listening', last_error = NULL, last_sync_at = ?, updated_at = ?
         WHERE id = 1`
      )
        .bind(highestUid, now, now)
        .run();

      return { synced };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE imap_config
       SET status = 'error', last_error = ?, last_sync_at = ?, updated_at = ?
       WHERE id = 1`
    )
      .bind(msg, now, now)
      .run();
    return { synced, error: msg };
  } finally {
    if (client) {
      await (client as WorkersImapClient).close();
    }
  }
}
