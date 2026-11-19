import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AAD,
  deriveAccountKeys,
  encryptJson,
  generateEmailKeyPair,
  generateRawAesKey,
  generateSecretKey,
  randomBytes,
  setNonePwdWasmModule,
  toBase64Url,
  type VaultMetadata,
} from '@nonepwd/core/worker';
import { createCfApp } from '../src/app.js';
import {
  IMAP_CODE_WINDOW_MS,
  IMAP_PARTIAL_TEXT_BYTES,
  IMAP_SYNC_BACKOFF_BASE_MS,
  IMAP_SYNC_BACKOFF_MAX_MS,
  IMAP_SYNC_MIN_INTERVAL_MS,
  SocketByteReader,
  buildPartialBodyFetch,
  buildVerificationUidSearch,
  isSyncThrottled,
  isWithinCodeWindow,
  parseFetchInternalDate,
  parseImapSearchUids,
  selectNewestUids,
  shouldBaselineUid,
  shouldSkipStaleCode,
  syncMinIntervalMs,
} from '../src/imap.js';
import { ensureImapSyncColumns } from '../src/schema.js';
import { parseSyncSince } from '../src/sync-delta.js';
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

beforeAll(() => {
  setNonePwdWasmModule(loadCompiledWasmModule());
});

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('IMAP sync planning', () => {
  it('backs off after failures and throttles from last_sync_at', () => {
    expect(syncMinIntervalMs(0)).toBe(IMAP_SYNC_MIN_INTERVAL_MS);
    expect(syncMinIntervalMs(1)).toBe(IMAP_SYNC_BACKOFF_BASE_MS);
    expect(syncMinIntervalMs(2)).toBe(IMAP_SYNC_BACKOFF_BASE_MS * 2);
    expect(syncMinIntervalMs(12)).toBe(IMAP_SYNC_BACKOFF_MAX_MS);

    const now = Date.now();
    const recent = new Date(now - 30_000).toISOString();
    expect(isSyncThrottled(recent, 1, now)).toBe(true);
    expect(isSyncThrottled(new Date(now - 2 * 60_000).toISOString(), 1, now)).toBe(false);
    expect(isSyncThrottled(null, 4, now)).toBe(false);
  });

  it('baselines on first contact and after a gap longer than a code stays valid', () => {
    const now = Date.now();
    expect(shouldBaselineUid(false, null, now)).toBe(true);
    expect(shouldBaselineUid(true, new Date(now - 60_000).toISOString(), now)).toBe(false);
    expect(shouldBaselineUid(true, new Date(now - IMAP_CODE_WINDOW_MS).toISOString(), now)).toBe(true);
  });

  it('searches only UIDs after last_uid inside the recent window and keeps the newest two', () => {
    const now = new Date('2026-11-19T15:00:00.000Z');
    const cmd = buildVerificationUidSearch(100, now);
    expect(cmd).toContain('UID SEARCH UID 101:*');
    expect(cmd).toContain('SINCE ');
    expect(cmd).not.toContain('BODY');

    expect(parseImapSearchUids(['* SEARCH 41 42 48', 'A0001 OK'])).toEqual([41, 42, 48]);
    expect(selectNewestUids([41, 42, 48], 40, 2)).toEqual({ fetch: [42, 48], advanceTo: 48 });
    expect(selectNewestUids([41], 40, 2)).toEqual({ fetch: [41], advanceTo: 41 });
    expect(selectNewestUids([10], 40, 2)).toEqual({ fetch: [], advanceTo: 40 });

    const fetch = buildPartialBodyFetch(48);
    expect(fetch).toContain('BODY.PEEK[HEADER]');
    expect(fetch).toContain(`BODY.PEEK[TEXT]<0.${IMAP_PARTIAL_TEXT_BYTES}>`);
    expect(fetch).not.toContain('BODY.PEEK[]');
    expect(fetch).not.toContain('BODY[]');
  });

  it('skips messages older than the code window and keeps undated ones', () => {
    const now = Date.parse('2026-11-19T15:00:00.000Z');
    const fresh = parseFetchInternalDate(
      '* 1 FETCH (UID 9 INTERNALDATE "19-Nov-2026 14:55:00 +0000" BODY[HEADER] {1}'
    );
    const stale = parseFetchInternalDate(
      '* 1 FETCH (UID 8 INTERNALDATE "18-Nov-2026 14:55:00 -0500" BODY[HEADER] {1}'
    );
    expect(fresh && isWithinCodeWindow(fresh, now)).toBe(true);
    expect(stale && shouldSkipStaleCode(stale, now)).toBe(true);
    expect(shouldSkipStaleCode(null, now)).toBe(false);
    expect(parseSyncSince('not-a-date', now)).toBeNull();
    expect(parseSyncSince(new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(), now)).toBeNull();
    expect(parseSyncSince(new Date(now - 60_000).toISOString(), now)).toBe(
      new Date(now - 60_000).toISOString()
    );
  });

  it('queues socket chunks in pull() without copying the buffered prefix', async () => {
    const enc = new TextEncoder();
    const chunks = [enc.encode('hel'), enc.encode('lo\n'), enc.encode('wor'), enc.encode('ld\n')];
    const reader = new SocketByteReader(byteStream(chunks).getReader());
    expect(await reader.readLine()).toBe('hello\n');
    expect(reader.pullCopyBytes).toBe(0);
    expect(await reader.readLine()).toBe('world\n');
    expect(await reader.readLine()).toBeNull();

    const n = 4000;
    const tiny = Array.from({ length: n }, (_, i) => Uint8Array.of(i % 256));
    const bulk = new SocketByteReader(byteStream(tiny).getReader());
    const started = Date.now();
    const exact = await bulk.readExact(n);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(exact.length).toBe(n);
    expect(exact[0]).toBe(0);
    expect(exact[255]).toBe(255);
    expect(exact[256]).toBe(0);
    expect(bulk.pullCopyBytes).toBe(0);
    expect(bulk.pendingChunkCount()).toBe(0);
  });
});

describe('IMAP sync on the worker', () => {
  async function setupOwner(): Promise<{
    env: ReturnType<typeof createMockCfEnv>['env'];
    token: string;
    api: (path: string, init?: RequestInit) => Promise<Response>;
  }> {
    const { env } = createMockCfEnv();
    const app = createCfApp();
    const api = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://vault.example.com${path}`, init), env);

    const secretKey = generateSecretKey();
    const kdfSalt = toBase64Url(randomBytes(16));
    const { masterUnlockKeyBytes, authVerifierB64 } = await deriveAccountKeys(
      'ImapWindow!99',
      secretKey,
      kdfSalt,
      10_000
    );
    const rootKey = generateRawAesKey();
    const emailKp = await generateEmailKeyPair();
    const vaultId = 'v_imap';
    const vaultKey = generateRawAesKey();
    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'owner@example.com',
        kdfSalt,
        kdfIterations: 10_000,
        authVerifier: authVerifierB64,
        encryptedRootKeyset: await encryptJson(
          masterUnlockKeyBytes,
          { rootKeyB64: toBase64Url(rootKey), emailPrivateKeyPkcs8B64: emailKp.privateKeyPkcs8B64 },
          AAD.ROOT_KEYSET
        ),
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
    return { env, token, api };
  }

  function scriptedImap(options: {
    loginOk?: boolean;
    uidNext?: number;
    search?: string;
    internalDate?: string;
    commands: string[];
  }) {
    return () => {
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      let buf = '';
      const push = (str: string) => controllerRef?.enqueue(enc.encode(str));
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          push('* OK ready\r\n');
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
            options.commands.push(cmd);
            if (upper.startsWith('LOGIN ')) {
              push(options.loginOk === false ? `${tag} NO bad\r\n` : `${tag} OK LOGIN\r\n`);
            } else if (upper.startsWith('SELECT ')) {
              push(`* 1 EXISTS\r\n${tag} OK SELECT\r\n`);
            } else if (upper.startsWith('STATUS ')) {
              push(`* STATUS "INBOX" (UIDNEXT ${options.uidNext ?? 50})\r\n${tag} OK STATUS\r\n`);
            } else if (upper.startsWith('UID SEARCH ')) {
              push(`* SEARCH ${options.search ?? ''}\r\n${tag} OK SEARCH\r\n`);
            } else if (upper.startsWith('UID FETCH ')) {
              const mime = 'Subject: code\r\n\r\n123456\r\n';
              const byteLen = enc.encode(mime).byteLength;
              const date = options.internalDate ?? '19-Nov-2026 14:59:00 +0000';
              push(
                `* 1 FETCH (UID 48 INTERNALDATE "${date}" BODY[HEADER] {${byteLen}}\r\n${mime})\r\n${tag} OK FETCH\r\n`
              );
            } else if (upper === 'LOGOUT') {
              push(`* BYE\r\n${tag} OK LOGOUT\r\n`);
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
  }

  it('adds backoff columns to an imap_accounts table created before this change', async () => {
    const { env } = createMockCfEnv();
    await env.DB.exec(
      `CREATE TABLE imap_accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 993,
        tls INTEGER NOT NULL DEFAULT 1,
        username TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        last_uid INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'listening',
        last_error TEXT,
        last_sync_at TEXT,
        updated_at TEXT NOT NULL
      )`
    );
    await ensureImapSyncColumns(env.DB);
    const info = await env.DB.prepare('PRAGMA table_info(imap_accounts)').all<{ name: string }>();
    const names = new Set((info.results ?? []).map((row) => row.name));
    expect(names.has('sync_fail_count')).toBe(true);
    expect(names.has('uid_baselined')).toBe(true);
  });

  it('keeps IMAP off /api/sync and /api/emails, baselines without backfill, and backs off after failure', async () => {
    const { env, token, api } = await setupOwner();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    let connects = 0;
    const commands: string[] = [];
    mockConnectRef.fn = () => {
      connects += 1;
      return scriptedImap({ loginOk: false, commands })();
    };

    const created = await api('/api/imap/accounts', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        enabled: true,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        username: 'alice@gmail.com',
        password: 'app-password-16',
      }),
    });
    expect(created.status).toBe(201);
    expect(connects).toBe(0);

    const sync = await api('/api/sync', { headers: { Authorization: `Bearer ${token}` } });
    const emails = await api('/api/emails', { headers: { Authorization: `Bearer ${token}` } });
    expect(sync.status).toBe(200);
    expect(emails.status).toBe(200);
    expect(connects).toBe(0);

    const failed = await api('/api/imap/sync', { method: 'POST', headers: auth, body: '{}' });
    expect(failed.status).toBe(200);
    const failedJson = (await failed.json()) as { ok: boolean; error: string | null };
    expect(failedJson.ok).toBe(false);
    expect(failedJson.error).toBeTruthy();
    expect(connects).toBe(1);

    const row = await env.DB.prepare(
      'SELECT last_sync_at, sync_fail_count, status, uid_baselined FROM imap_accounts'
    ).first<{
      last_sync_at: string | null;
      sync_fail_count: number;
      status: string;
      uid_baselined: number;
    }>();
    expect(row?.last_sync_at).toBeTruthy();
    expect(Number(row?.sync_fail_count)).toBeGreaterThanOrEqual(1);
    expect(row?.status).toBe('error');
    expect(Number(row?.uid_baselined)).toBe(0);

    const retried = await api('/api/imap/sync', { method: 'POST', headers: auth, body: '{}' });
    const retriedJson = (await retried.json()) as { throttled: boolean; ok: boolean };
    expect(retriedJson.throttled).toBe(true);
    expect(retriedJson.ok).toBe(true);
    expect(connects).toBe(1);

    mockConnectRef.fn = null;
  });

  it('baselines to UIDNEXT, then fetches only the newest two partial bodies and skips stale mail', async () => {
    const { env, token, api } = await setupOwner();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const commands: string[] = [];
    mockConnectRef.fn = () =>
      scriptedImap({
        commands,
        uidNext: 50,
        search: '41 42 48',
        internalDate: '01-Jan-2020 00:00:00 +0000',
      })();

    const created = await api('/api/imap/accounts', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        enabled: true,
        host: 'imap.qq.com',
        port: 993,
        tls: true,
        username: 'alice@qq.com',
        password: 'app-password-16',
      }),
    });
    expect(created.status).toBe(201);
    const { account } = (await created.json()) as { account: { id: string } };

    commands.length = 0;
    const baseline = await api('/api/imap/sync', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: account.id }),
    });
    const baselineJson = (await baseline.json()) as { ok: boolean; synced: number; baselined: boolean };
    expect(baselineJson.ok).toBe(true);
    expect(baselineJson.synced).toBe(0);
    expect(baselineJson.baselined).toBe(true);
    expect(commands.some((cmd) => cmd.toUpperCase().startsWith('UID FETCH'))).toBe(false);
    const afterBase = await env.DB.prepare('SELECT last_uid, uid_baselined FROM imap_accounts WHERE id = ?')
      .bind(account.id)
      .first<{ last_uid: number; uid_baselined: number }>();
    expect(afterBase?.last_uid).toBe(49);
    expect(Number(afterBase?.uid_baselined)).toBe(1);

    await env.DB.prepare(
      `UPDATE imap_accounts
       SET last_uid = 40, last_sync_at = ?, uid_baselined = 1, sync_fail_count = 0
       WHERE id = ?`
    )
      .bind(new Date(Date.now() - 60_000).toISOString(), account.id)
      .run();
    commands.length = 0;
    const fetched = await api('/api/imap/sync', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: account.id }),
    });
    const fetchedJson = (await fetched.json()) as { ok: boolean; synced: number };
    expect(fetchedJson.ok).toBe(true);
    expect(fetchedJson.synced).toBe(0);

    const search = commands.find((cmd) => cmd.toUpperCase().startsWith('UID SEARCH'));
    expect(search).toContain('UID 41:*');
    expect(search?.toUpperCase()).toContain('SINCE');
    const fetches = commands.filter((cmd) => cmd.toUpperCase().startsWith('UID FETCH'));
    expect(fetches).toHaveLength(2);
    expect(fetches.every((cmd) => cmd.includes(`BODY.PEEK[TEXT]<0.${IMAP_PARTIAL_TEXT_BYTES}>`))).toBe(true);
    expect(fetches.some((cmd) => cmd.includes('BODY.PEEK[]') || cmd.includes('BODY[]'))).toBe(false);
    expect(fetches.some((cmd) => cmd.includes(' 41 '))).toBe(false);

    const emails = (await (await api('/api/emails', { headers: { Authorization: `Bearer ${token}` } })).json()) as {
      emails: unknown[];
    };
    expect(emails.emails).toHaveLength(0);
    const after = await env.DB.prepare('SELECT last_uid FROM imap_accounts WHERE id = ?')
      .bind(account.id)
      .first<{ last_uid: number }>();
    expect(after?.last_uid).toBe(48);

    mockConnectRef.fn = null;
  });

  it('returns an incremental sync cursor and deletions without dropping older clients', async () => {
    const { env, token, api } = await setupOwner();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const full = await api('/api/sync', { headers: { Authorization: `Bearer ${token}` } });
    const fullJson = (await full.json()) as {
      incremental: boolean;
      cursor: string;
      epoch: number;
      items: Array<{ id: string }>;
      vaults: unknown[];
    };
    expect(fullJson.incremental).toBe(false);
    expect(fullJson.cursor).toBeTruthy();
    expect(fullJson.epoch).toBe(1);
    expect(fullJson.vaults.length).toBeGreaterThan(0);
    const before = fullJson.items.length;

    const itemRes = await api('/api/vaults/v_imap/items', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id: 'item_new', encryptedData: 'cipher-1' }),
    });
    expect(itemRes.status).toBe(201);

    const delta = await api(
      `/api/sync?since=${encodeURIComponent(fullJson.cursor)}&epoch=${fullJson.epoch}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const deltaJson = (await delta.json()) as {
      incremental: boolean;
      cursor: string;
      items: Array<{ id: string }>;
      vaults: unknown[];
    };
    expect(deltaJson.incremental).toBe(true);
    expect(deltaJson.items.map((item) => item.id)).toEqual(['item_new']);
    expect(deltaJson.vaults).toEqual([]);

    const removed = await api('/api/vaults/v_imap/items/item_new', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(removed.status).toBe(200);
    const afterDelete = await api(
      `/api/sync?since=${encodeURIComponent(deltaJson.cursor)}&epoch=${fullJson.epoch}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const afterJson = (await afterDelete.json()) as {
      incremental: boolean;
      items: unknown[];
      deleted: { items: string[] };
    };
    expect(afterJson.incremental).toBe(true);
    expect(afterJson.items).toEqual([]);
    expect(afterJson.deleted.items).toContain('item_new');

    await env.DB.prepare('UPDATE sync_state SET epoch = 2 WHERE id = 1').run();
    const reset = await api(
      `/api/sync?since=${encodeURIComponent(deltaJson.cursor)}&epoch=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const resetJson = (await reset.json()) as { incremental: boolean; epoch: number; items: unknown[] };
    expect(resetJson.incremental).toBe(false);
    expect(resetJson.epoch).toBe(2);
    expect(resetJson.items).toHaveLength(before);

    const ancient = await api('/api/sync?since=1970-01-01T00:00:00.000Z&epoch=2', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const ancientJson = (await ancient.json()) as { incremental: boolean };
    expect(ancientJson.incremental).toBe(false);
  });
});
