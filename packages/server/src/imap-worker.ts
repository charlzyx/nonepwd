import { ImapFlow } from 'imapflow';
import type { ImapConfigPublic } from '@nonepwd/core';
import type { NonePwdDb } from './db.js';
import type { WsHub } from './ws.js';
import { ingestRawEmail } from './email-ingest.js';

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
}

export interface ImapWorker {
  getPublicConfig(): ImapConfigPublic;
  reload(): Promise<void>;
  stop(): Promise<void>;
  testConnection(params: {
    host: string;
    port: number;
    tls: boolean;
    username: string;
    password: string;
  }): Promise<{ ok: boolean; messages?: number; error?: string }>;
}

export function createImapWorker(db: NonePwdDb, wsHub: WsHub): ImapWorker {
  let client: ImapFlow | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollingBusy = false;

  function readRow(): ImapRow {
    return db.sqlite
      .prepare(
        `SELECT enabled, host, port, tls, username, password_enc, last_uid, status, last_error
         FROM imap_config WHERE id = 1`
      )
      .get() as unknown as ImapRow;
  }

  function updateStatus(status: ImapConfigPublic['status'], lastError: string | null = null) {
    db.sqlite
      .prepare('UPDATE imap_config SET status = ?, last_error = ?, updated_at = ? WHERE id = 1')
      .run(status, lastError, new Date().toISOString());
    wsHub.broadcast({ type: 'imap.status', status, lastError }, { ownerOnly: true });
  }

  async function disconnectClient() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (client) {
      const c = client;
      client = null;
      try {
        await c.logout();
      } catch {
        try {
          c.close();
        } catch {
          // ignore
        }
      }
    }
  }

  async function fetchRecentMessages(imap: ImapFlow) {
    if (pollingBusy) return;
    pollingBusy = true;
    try {
      const row = readRow();
      const since = new Date(Date.now() - 10 * 60 * 1000);
      const uids = await imap.search({ seen: false, since }, { uid: true });
      if (!uids || uids.length === 0) return;

      const sortedUids = [...uids].sort((a, b) => a - b);
      let highestUid = row.last_uid;

      for (const uid of sortedUids) {
        if (uid <= row.last_uid) continue;
        const msg = await imap.fetchOne(
          String(uid),
          { source: true, envelope: true, uid: true },
          { uid: true }
        );
        if (msg && msg.source) {
          const envelopeTo = msg.envelope?.to?.[0]?.address;
          const envelopeFrom = msg.envelope?.from?.[0]?.address;
          await ingestRawEmail({
            db,
            wsHub,
            rawMime: msg.source,
            source: 'imap',
            envelopeFrom,
            envelopeTo,
          });
        }
        if (uid > highestUid) {
          highestUid = uid;
        }
      }

      if (highestUid > row.last_uid) {
        db.sqlite.prepare('UPDATE imap_config SET last_uid = ? WHERE id = 1').run(highestUid);
      }
    } catch (err) {
      console.error('[imap] error fetching recent messages:', err);
    } finally {
      pollingBusy = false;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      void startIfEnabled();
    }, 10_000);
  }

  async function startIfEnabled() {
    await disconnectClient();
    if (stopped) return;

    const row = readRow();
    if (!row.enabled || !row.host || !row.username) {
      updateStatus('disabled', null);
      return;
    }

    const password = db.decryptLocalSecret(row.password_enc);
    if (!password) {
      updateStatus('error', 'IMAP password is empty');
      return;
    }

    updateStatus('connecting', null);

    const imap = new ImapFlow({
      host: row.host,
      port: row.port,
      secure: row.tls === 1,
      auth: {
        user: row.username,
        pass: password,
      },
      logger: false,
    });
    client = imap;

    imap.on('error', (err) => {
      if (client !== imap) return;
      updateStatus('error', err.message || 'IMAP connection error');
    });

    imap.on('close', () => {
      if (client !== imap || stopped) return;
      const latest = readRow();
      if (latest.enabled) {
        scheduleReconnect();
      }
    });

    try {
      await imap.connect();
      const lock = await imap.getMailboxLock('INBOX');
      updateStatus('listening', null);
      await fetchRecentMessages(imap);

      imap.on('exists', () => {
        if (client === imap) {
          void fetchRecentMessages(imap);
        }
      });

      // Keep lock until connection closes or reload/stop releases it
      imap.once('close', () => {
        try {
          lock.release();
        } catch {
          // ignore
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateStatus('error', msg);
      await disconnectClient();
      scheduleReconnect();
    }
  }

  return {
    getPublicConfig(): ImapConfigPublic {
      const row = readRow();
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
    },

    async reload() {
      await startIfEnabled();
    },

    async stop() {
      stopped = true;
      await disconnectClient();
    },

    async testConnection(params) {
      const testClient = new ImapFlow({
        host: params.host,
        port: params.port,
        secure: params.tls,
        auth: {
          user: params.username,
          pass: params.password,
        },
        logger: false,
        connectionTimeout: 8000,
      });
      try {
        await testClient.connect();
        const status = await testClient.status('INBOX', { messages: true });
        await testClient.logout();
        return { ok: true, messages: status.messages ?? 0 };
      } catch (err) {
        try {
          testClient.close();
        } catch {
          // ignore
        }
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
