import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import {
  extractEmailAddress,
  generateEmailAlias,
  randomId,
  type SealedEnvelope,
} from '@nonepwd/core';
import {
  authenticateToken,
  createSession,
  extractBearerToken,
  hashSecret,
  verifySecret,
  verifyWebhookHmac,
  type AuthContext,
} from './auth.js';
import { openNonePwdDb, type NonePwdDb } from './db.js';
import {
  ingestPreSealedEmail,
  ingestRawEmail,
  ingestSimulatedEmail,
} from './email-ingest.js';
import { createImapWorker, type ImapWorker } from './imap-worker.js';
import { createNodeAgentRelay } from './agent-relay-ws.js';
import { createWsHub, type WsHub } from './ws.js';

export interface NonePwdServerOptions {
  dataDir?: string;
  webDistDir?: string;
  binDistDir?: string;
}

export interface NonePwdServerInstance {
  app: Hono;
  db: NonePwdDb;
  wsHub: WsHub;
  imapWorker: ImapWorker;
  start(port?: number, host?: string): Promise<{ server: HttpServer; port: number; url: string }>;
  close(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function defaultWebDistDir(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.resolve(__dirname, '../web-dist');
  if (fs.existsSync(bundled)) return bundled;
  return path.resolve(__dirname, '../../web/dist');
}

function defaultBinDistDirs(): string[] {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(__dirname, '../bin-dist'),
    path.resolve(__dirname, '../../../dist/bin'),
  ];
}

const ALLOWED_CLI_BINARIES = new Set([
  'np',
  'np-darwin-arm64',
  'np-darwin-x86_64',
  'np-linux-x86_64',
  'np-linux-arm64',
  'nonepwd-extension.zip',
]);

export function createNonePwdServer(
  options: NonePwdServerOptions = {}
): NonePwdServerInstance {
  const dataDir =
    options.dataDir ?? process.env.NONEPWD_DATA_DIR ?? path.resolve(process.cwd(), 'data');
  const webDistDir =
    options.webDistDir ?? process.env.NONEPWD_WEB_DIST ?? defaultWebDistDir();
  const binDistDirOverride = options.binDistDir ?? process.env.NONEPWD_BIN_DIST;
  const binDistDirs = binDistDirOverride ? [binDistDirOverride] : defaultBinDistDirs();

  const db = openNonePwdDb(dataDir);
  const wsHub = createWsHub(db);
  const agentRelay = createNodeAgentRelay();
  const imapWorker = createImapWorker(db, wsHub);

  const app = new Hono();

  app.use(
    '/api/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'X-NonePwd-Timestamp',
        'X-NonePwd-Signature',
        'X-NonePwd-Envelope-From',
        'X-NonePwd-Envelope-To',
      ],
    })
  );

  function getAuth(c: Context): AuthContext | null {
    const token = extractBearerToken(c.req.header('authorization'));
    return authenticateToken(db, token);
  }

  function requireAuth(c: Context): AuthContext | Response {
    const auth = getAuth(c);
    if (!auth) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return auth;
  }

  function requireOwner(c: Context): Extract<AuthContext, { kind: 'owner' }> | Response {
    const auth = getAuth(c);
    if (!auth) return c.json({ error: 'Unauthorized' }, 401);
    if (auth.kind !== 'owner') {
      return c.json({ error: 'Owner authorization required' }, 403);
    }
    return auth;
  }

  app.get('/api/health', (c) => {
    const row = db.sqlite.prepare('SELECT id FROM account WHERE id = 1').get();
    return c.json({
      ok: true,
      initialized: Boolean(row),
      version: '0.1.0',
      agentRelay: '/agent/relay',
    });
  });

  app.get('/api/auth/params', (c) => {
    const row = db.sqlite
      .prepare('SELECT email, kdf_salt, kdf_iterations FROM account WHERE id = 1')
      .get() as { email: string; kdf_salt: string; kdf_iterations: number } | undefined;

    if (!row) {
      return c.json({ initialized: false });
    }
    return c.json({
      initialized: true,
      email: row.email,
      kdfSalt: row.kdf_salt,
      kdfIterations: row.kdf_iterations,
    });
  });

  app.post('/api/auth/setup', async (c) => {
    const body = (await c.req.json()) as {
      email?: string;
      kdfSalt?: string;
      kdfIterations?: number;
      authVerifier?: string;
      encryptedRootKeyset?: string;
      emailPublicKey?: string;
      aliasDomain?: string;
      vaults?: Array<{ id: string; encryptedKey: string; encryptedMeta: string }>;
    };

    if (
      !body.email ||
      !body.kdfSalt ||
      !body.kdfIterations ||
      !body.authVerifier ||
      !body.encryptedRootKeyset ||
      !body.emailPublicKey
    ) {
      return c.json({ error: 'Missing required setup fields' }, 400);
    }

    const now = new Date().toISOString();
    const cfWebhookSecret = crypto.randomBytes(32).toString('hex');
    const authHash = hashSecret(body.authVerifier);
    const aliasDomain = (body.aliasDomain ?? '').trim().toLowerCase();

    db.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.sqlite.prepare('SELECT id FROM account WHERE id = 1').get();
      if (existing) {
        db.sqlite.exec('ROLLBACK');
        return c.json({ error: 'Account already initialized' }, 409);
      }

      db.sqlite
        .prepare(
          `INSERT INTO account
           (id, email, kdf_salt, kdf_iterations, auth_verifier_hash, encrypted_root_keyset, email_public_key, cf_webhook_secret, alias_domain, created_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          body.email.trim().toLowerCase(),
          body.kdfSalt,
          body.kdfIterations,
          authHash,
          body.encryptedRootKeyset,
          body.emailPublicKey,
          cfWebhookSecret,
          aliasDomain,
          now
        );

      if (Array.isArray(body.vaults)) {
        const insertVault = db.sqlite.prepare(
          `INSERT INTO vaults (id, encrypted_key, encrypted_meta, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        );
        for (const v of body.vaults) {
          insertVault.run(v.id, v.encryptedKey, v.encryptedMeta, now, now);
        }
      }

      db.sqlite.exec('COMMIT');
    } catch (err) {
      try {
        db.sqlite.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }

    const token = createSession(db, 'owner');
    return c.json(
      {
        token,
        account: {
          email: body.email.trim().toLowerCase(),
          emailPublicKey: body.emailPublicKey,
          cfWebhookSecret,
          aliasDomain,
        },
      },
      201
    );
  });

  app.post('/api/auth/login', async (c) => {
    const body = (await c.req.json()) as { authVerifier?: string };
    if (!body.authVerifier) {
      return c.json({ error: 'Missing authVerifier' }, 400);
    }

    const row = db.sqlite
      .prepare(
        `SELECT email, kdf_salt, kdf_iterations, auth_verifier_hash, encrypted_root_keyset,
                email_public_key, cf_webhook_secret, alias_domain
         FROM account WHERE id = 1`
      )
      .get() as
      | {
          email: string;
          kdf_salt: string;
          kdf_iterations: number;
          auth_verifier_hash: string;
          encrypted_root_keyset: string;
          email_public_key: string;
          cf_webhook_secret: string;
          alias_domain: string;
        }
      | undefined;

    if (!row) {
      return c.json({ error: 'Account not initialized' }, 404);
    }

    if (!verifySecret(body.authVerifier, row.auth_verifier_hash)) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const token = createSession(db, 'owner');
    return c.json({
      token,
      account: {
        email: row.email,
        kdfSalt: row.kdf_salt,
        kdfIterations: row.kdf_iterations,
        encryptedRootKeyset: row.encrypted_root_keyset,
        emailPublicKey: row.email_public_key,
        cfWebhookSecret: row.cf_webhook_secret,
        aliasDomain: row.alias_domain,
      },
    });
  });

  app.post('/api/auth/service-account', async (c) => {
    const body = (await c.req.json()) as { tokenId?: string; authSecret?: string };
    if (!body.tokenId || !body.authSecret) {
      return c.json({ error: 'Missing tokenId or authSecret' }, 400);
    }

    const sa = db.sqlite
      .prepare('SELECT id, name, auth_secret_hash FROM service_accounts WHERE id = ?')
      .get(body.tokenId) as { id: string; name: string; auth_secret_hash: string } | undefined;

    if (!sa || !verifySecret(body.authSecret, sa.auth_secret_hash)) {
      return c.json({ error: 'Invalid Service Account token' }, 401);
    }

    db.sqlite
      .prepare('UPDATE service_accounts SET last_used_at = ? WHERE id = ?')
      .run(new Date().toISOString(), sa.id);

    const vaults = db.sqlite
      .prepare(
        `SELECT v.id, sav.encrypted_vault_key AS encryptedKey, v.encrypted_meta AS encryptedMeta,
                v.created_at AS createdAt, v.updated_at AS updatedAt
         FROM vaults v
         JOIN service_account_vaults sav ON sav.vault_id = v.id
         WHERE sav.service_account_id = ?
         ORDER BY v.created_at ASC`
      )
      .all(sa.id);

    const token = createSession(db, 'service_account', sa.id, 24 * 60 * 60 * 1000);
    return c.json({
      token,
      serviceAccount: { id: sa.id, name: sa.name },
      vaults,
    });
  });

  app.post('/api/auth/logout', (c) => {
    const auth = getAuth(c);
    if (auth) {
      db.sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.tokenHash);
    }
    return c.json({ ok: true });
  });

  app.get('/api/sync', (c) => {
    const authOrRes = requireAuth(c);
    if (authOrRes instanceof Response) return authOrRes;

    if (authOrRes.kind === 'service_account') {
      const vaults = db.sqlite
        .prepare(
          `SELECT v.id, sav.encrypted_vault_key AS encryptedKey, v.encrypted_meta AS encryptedMeta,
                  v.created_at AS createdAt, v.updated_at AS updatedAt
           FROM vaults v
           JOIN service_account_vaults sav ON sav.vault_id = v.id
           WHERE sav.service_account_id = ?
           ORDER BY v.created_at ASC`
        )
        .all(authOrRes.serviceAccountId);

      const items = db.sqlite
        .prepare(
          `SELECT i.id, i.vault_id AS vaultId, i.encrypted_data AS encryptedData,
                  i.created_at AS createdAt, i.updated_at AS updatedAt, i.version
           FROM items i
           JOIN service_account_vaults sav ON sav.vault_id = i.vault_id
           WHERE sav.service_account_id = ?
           ORDER BY i.updated_at DESC`
        )
        .all(authOrRes.serviceAccountId);

      return c.json({
        kind: 'service_account',
        vaults,
        items,
      });
    }

    const account = db.sqlite
      .prepare(
        `SELECT email, encrypted_root_keyset AS encryptedRootKeyset,
                email_public_key AS emailPublicKey, cf_webhook_secret AS cfWebhookSecret,
                alias_domain AS aliasDomain
         FROM account WHERE id = 1`
      )
      .get();

    const vaults = db.sqlite
      .prepare(
        `SELECT id, encrypted_key AS encryptedKey, encrypted_meta AS encryptedMeta,
                created_at AS createdAt, updated_at AS updatedAt
         FROM vaults ORDER BY created_at ASC`
      )
      .all();

    const items = db.sqlite
      .prepare(
        `SELECT id, vault_id AS vaultId, encrypted_data AS encryptedData,
                created_at AS createdAt, updated_at AS updatedAt, version
         FROM items ORDER BY updated_at DESC`
      )
      .all();

    const aliases = db.sqlite
      .prepare(
        `SELECT id, address, site_domain AS siteDomain, vault_id AS vaultId, item_id AS itemId,
                enabled, received_count AS receivedCount, created_at AS createdAt
         FROM aliases ORDER BY created_at DESC`
      )
      .all()
      .map((r) => ({ ...r, enabled: Boolean((r as { enabled: number }).enabled) }));

    const emails = db.sqlite
      .prepare(
        `SELECT id, source, envelope_to AS envelopeTo, has_otp AS hasOtp,
                sealed_envelope AS sealedEnvelope, received_at AS receivedAt
         FROM encrypted_emails ORDER BY received_at DESC LIMIT 100`
      )
      .all()
      .map((r) => ({
        ...r,
        hasOtp: Boolean((r as { hasOtp: number }).hasOtp),
        sealedEnvelope: JSON.parse((r as { sealedEnvelope: string }).sealedEnvelope) as SealedEnvelope,
      }));

    return c.json({
      kind: 'owner',
      account,
      vaults,
      items,
      aliases,
      emails,
      imapStatus: imapWorker.getPublicConfig(),
    });
  });

  // Vault routes
  app.get('/api/vaults', (c) => {
    const authOrRes = requireAuth(c);
    if (authOrRes instanceof Response) return authOrRes;

    if (authOrRes.kind === 'service_account') {
      const vaults = db.sqlite
        .prepare(
          `SELECT v.id, sav.encrypted_vault_key AS encryptedKey, v.encrypted_meta AS encryptedMeta,
                  v.created_at AS createdAt, v.updated_at AS updatedAt
           FROM vaults v
           JOIN service_account_vaults sav ON sav.vault_id = v.id
           WHERE sav.service_account_id = ?
           ORDER BY v.created_at ASC`
        )
        .all(authOrRes.serviceAccountId);
      return c.json({ vaults });
    }

    const vaults = db.sqlite
      .prepare(
        `SELECT id, encrypted_key AS encryptedKey, encrypted_meta AS encryptedMeta,
                created_at AS createdAt, updated_at AS updatedAt
         FROM vaults ORDER BY created_at ASC`
      )
      .all();
    return c.json({ vaults });
  });

  app.post('/api/vaults', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const body = (await c.req.json()) as {
      id?: string;
      encryptedKey?: string;
      encryptedMeta?: string;
    };
    if (!body.encryptedKey || !body.encryptedMeta) {
      return c.json({ error: 'Missing encryptedKey or encryptedMeta' }, 400);
    }

    const id = body.id ?? randomId();
    const now = new Date().toISOString();
    db.sqlite
      .prepare(
        `INSERT INTO vaults (id, encrypted_key, encrypted_meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, body.encryptedKey, body.encryptedMeta, now, now);

    const vault = {
      id,
      encryptedKey: body.encryptedKey,
      encryptedMeta: body.encryptedMeta,
      createdAt: now,
      updatedAt: now,
    };
    wsHub.broadcast({ type: 'vault.upserted', vault }, { ownerOnly: true });
    return c.json({ vault }, 201);
  });

  app.patch('/api/vaults/:id', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('id');
    const body = (await c.req.json()) as { encryptedMeta?: string; encryptedKey?: string };
    const existing = db.sqlite.prepare('SELECT id FROM vaults WHERE id = ?').get(vaultId);
    if (!existing) return c.json({ error: 'Vault not found' }, 404);

    const now = new Date().toISOString();
    if (body.encryptedMeta) {
      db.sqlite
        .prepare('UPDATE vaults SET encrypted_meta = ?, updated_at = ? WHERE id = ?')
        .run(body.encryptedMeta, now, vaultId);
    }
    if (body.encryptedKey) {
      db.sqlite
        .prepare('UPDATE vaults SET encrypted_key = ?, updated_at = ? WHERE id = ?')
        .run(body.encryptedKey, now, vaultId);
    }

    const vault = db.sqlite
      .prepare(
        `SELECT id, encrypted_key AS encryptedKey, encrypted_meta AS encryptedMeta,
                created_at AS createdAt, updated_at AS updatedAt
         FROM vaults WHERE id = ?`
      )
      .get(vaultId);

    wsHub.broadcast({ type: 'vault.upserted', vault }, { vaultId });
    return c.json({ vault });
  });

  app.delete('/api/vaults/:id', (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('id');
    const res = db.sqlite.prepare('DELETE FROM vaults WHERE id = ?').run(vaultId);
    if (res.changes === 0) return c.json({ error: 'Vault not found' }, 404);

    wsHub.broadcast({ type: 'vault.deleted', vaultId }, { ownerOnly: true });
    return c.json({ ok: true });
  });

  // Item routes
  app.get('/api/vaults/:vaultId/items', (c) => {
    const authOrRes = requireAuth(c);
    if (authOrRes instanceof Response) return authOrRes;

    const vaultId = c.req.param('vaultId');
    if (
      authOrRes.kind === 'service_account' &&
      !authOrRes.allowedVaultIds.has(vaultId)
    ) {
      return c.json({ error: 'Vault not authorized for this Service Account' }, 403);
    }

    const items = db.sqlite
      .prepare(
        `SELECT id, vault_id AS vaultId, encrypted_data AS encryptedData,
                created_at AS createdAt, updated_at AS updatedAt, version
         FROM items WHERE vault_id = ? ORDER BY updated_at DESC`
      )
      .all(vaultId);
    return c.json({ items });
  });

  app.post('/api/vaults/:vaultId/items', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('vaultId');
    const vault = db.sqlite.prepare('SELECT id FROM vaults WHERE id = ?').get(vaultId);
    if (!vault) return c.json({ error: 'Vault not found' }, 404);

    const body = (await c.req.json()) as { id?: string; encryptedData?: string };
    if (!body.encryptedData) {
      return c.json({ error: 'Missing encryptedData' }, 400);
    }

    const id = body.id ?? randomId();
    const now = new Date().toISOString();
    db.sqlite
      .prepare(
        `INSERT INTO items (id, vault_id, encrypted_data, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
      .run(id, vaultId, body.encryptedData, now, now);

    const item = {
      id,
      vaultId,
      encryptedData: body.encryptedData,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    wsHub.broadcast({ type: 'item.upserted', item }, { vaultId });
    return c.json({ item }, 201);
  });

  app.post('/api/vaults/:vaultId/items/batch', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('vaultId');
    const vault = db.sqlite.prepare('SELECT id FROM vaults WHERE id = ?').get(vaultId);
    if (!vault) return c.json({ error: 'Vault not found' }, 404);

    const body = (await c.req.json()) as {
      items?: Array<{ id?: string; encryptedData?: string }>;
    };
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return c.json({ error: 'Missing non-empty items array' }, 400);
    }

    for (const entry of body.items) {
      if (!entry.encryptedData) {
        return c.json({ error: 'Each item requires encryptedData' }, 400);
      }
    }

    const now = new Date().toISOString();
    const stmt = db.sqlite.prepare(
      `INSERT OR REPLACE INTO items (id, vault_id, encrypted_data, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, 1)`
    );

    const inserted: Array<{
      id: string;
      vaultId: string;
      encryptedData: string;
      createdAt: string;
      updatedAt: string;
      version: number;
    }> = [];

    db.sqlite.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of body.items) {
        const id = entry.id ?? randomId();
        const encryptedData = entry.encryptedData!;
        stmt.run(id, vaultId, encryptedData, now, now);
        inserted.push({
          id,
          vaultId,
          encryptedData,
          createdAt: now,
          updatedAt: now,
          version: 1,
        });
      }
      db.sqlite.exec('COMMIT');
    } catch (err) {
      db.sqlite.exec('ROLLBACK');
      throw err;
    }

    wsHub.broadcast({ type: 'item.upserted', count: inserted.length }, { vaultId });
    return c.json({ imported: inserted.length, items: inserted }, 201);
  });

  app.put('/api/vaults/:vaultId/items/:itemId', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('vaultId');
    const itemId = c.req.param('itemId');
    const body = (await c.req.json()) as { encryptedData?: string };
    if (!body.encryptedData) {
      return c.json({ error: 'Missing encryptedData' }, 400);
    }

    const existing = db.sqlite
      .prepare('SELECT id, created_at, version FROM items WHERE id = ? AND vault_id = ?')
      .get(itemId, vaultId) as { id: string; created_at: string; version: number } | undefined;

    const now = new Date().toISOString();
    let version = 1;
    let createdAt = now;
    if (existing) {
      version = existing.version + 1;
      createdAt = existing.created_at;
      db.sqlite
        .prepare('UPDATE items SET encrypted_data = ?, updated_at = ?, version = ? WHERE id = ?')
        .run(body.encryptedData, now, version, itemId);
    } else {
      const vault = db.sqlite.prepare('SELECT id FROM vaults WHERE id = ?').get(vaultId);
      if (!vault) return c.json({ error: 'Vault not found' }, 404);
      db.sqlite
        .prepare(
          `INSERT INTO items (id, vault_id, encrypted_data, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, 1)`
        )
        .run(itemId, vaultId, body.encryptedData, now, now);
    }

    const item = {
      id: itemId,
      vaultId,
      encryptedData: body.encryptedData,
      createdAt,
      updatedAt: now,
      version,
    };
    wsHub.broadcast({ type: 'item.upserted', item }, { vaultId });
    return c.json({ item });
  });

  app.delete('/api/vaults/:vaultId/items/:itemId', (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('vaultId');
    const itemId = c.req.param('itemId');
    const res = db.sqlite
      .prepare('DELETE FROM items WHERE id = ? AND vault_id = ?')
      .run(itemId, vaultId);
    if (res.changes === 0) return c.json({ error: 'Item not found' }, 404);

    wsHub.broadcast({ type: 'item.deleted', vaultId, itemId }, { vaultId });
    return c.json({ ok: true });
  });

  // Masked Email Aliases
  app.get('/api/aliases', (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const aliases = db.sqlite
      .prepare(
        `SELECT id, address, site_domain AS siteDomain, vault_id AS vaultId, item_id AS itemId,
                enabled, received_count AS receivedCount, created_at AS createdAt
         FROM aliases ORDER BY created_at DESC`
      )
      .all()
      .map((r) => ({ ...r, enabled: Boolean((r as { enabled: number }).enabled) }));

    return c.json({ aliases });
  });

  app.post('/api/aliases', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const body = (await c.req.json()) as {
      address?: string;
      siteDomain?: string;
      vaultId?: string;
      itemId?: string;
    };

    let address = body.address?.trim().toLowerCase() ?? '';
    if (!address) {
      const account = db.sqlite
        .prepare('SELECT alias_domain FROM account WHERE id = 1')
        .get() as { alias_domain: string } | undefined;
      const domain = account?.alias_domain;
      if (!domain) {
        return c.json({ error: 'No aliasDomain configured; provide explicit address' }, 400);
      }
      address = generateEmailAlias(body.siteDomain ?? 'site', domain);
    }

    const id = randomId();
    const now = new Date().toISOString();
    try {
      db.sqlite
        .prepare(
          `INSERT INTO aliases (id, address, site_domain, vault_id, item_id, enabled, received_count, created_at)
           VALUES (?, ?, ?, ?, ?, 1, 0, ?)`
        )
        .run(
          id,
          address,
          body.siteDomain?.trim().toLowerCase() || null,
          body.vaultId ?? null,
          body.itemId ?? null,
          now
        );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Alias already exists' }, 409);
    }

    const alias = {
      id,
      address,
      siteDomain: body.siteDomain?.trim().toLowerCase() || null,
      vaultId: body.vaultId ?? null,
      itemId: body.itemId ?? null,
      enabled: true,
      receivedCount: 0,
      createdAt: now,
    };
    wsHub.broadcast({ type: 'alias.upserted', alias }, { ownerOnly: true });
    return c.json({ alias }, 201);
  });

  app.patch('/api/aliases/:id', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      enabled?: boolean;
      vaultId?: string | null;
      itemId?: string | null;
      siteDomain?: string | null;
    };
    const existing = db.sqlite.prepare('SELECT * FROM aliases WHERE id = ?').get(id) as
      | {
          id: string;
          enabled: number;
          vault_id: string | null;
          item_id: string | null;
          site_domain: string | null;
        }
      | undefined;
    if (!existing) return c.json({ error: 'Alias not found' }, 404);

    const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;
    const vaultId = body.vaultId !== undefined ? body.vaultId : existing.vault_id;
    const itemId = body.itemId !== undefined ? body.itemId : existing.item_id;
    const siteDomain = body.siteDomain !== undefined ? body.siteDomain : existing.site_domain;

    db.sqlite
      .prepare('UPDATE aliases SET enabled = ?, vault_id = ?, item_id = ?, site_domain = ? WHERE id = ?')
      .run(enabled, vaultId, itemId, siteDomain, id);

    const updated = db.sqlite
      .prepare(
        `SELECT id, address, site_domain AS siteDomain, vault_id AS vaultId, item_id AS itemId,
                enabled, received_count AS receivedCount, created_at AS createdAt
         FROM aliases WHERE id = ?`
      )
      .get(id) as Record<string, unknown>;

    const alias = { ...updated, enabled: Boolean(updated.enabled) };
    wsHub.broadcast({ type: 'alias.upserted', alias }, { ownerOnly: true });
    return c.json({ alias });
  });

  app.delete('/api/aliases/:id', (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const id = c.req.param('id');
    const res = db.sqlite.prepare('DELETE FROM aliases WHERE id = ?').run(id);
    if (res.changes === 0) return c.json({ error: 'Alias not found' }, 404);

    wsHub.broadcast({ type: 'alias.deleted', id }, { ownerOnly: true });
    return c.json({ ok: true });
  });

  // Encrypted Email Inbox + Simulate OTP endpoint
  app.get('/api/emails', (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const emails = db.sqlite
      .prepare(
        `SELECT id, source, envelope_to AS envelopeTo, has_otp AS hasOtp,
                sealed_envelope AS sealedEnvelope, received_at AS receivedAt
         FROM encrypted_emails ORDER BY received_at DESC LIMIT 100`
      )
      .all()
      .map((r) => ({
        ...r,
        hasOtp: Boolean((r as { hasOtp: number }).hasOtp),
        sealedEnvelope: JSON.parse((r as { sealedEnvelope: string }).sealedEnvelope) as SealedEnvelope,
      }));

    return c.json({ emails });
  });

  app.delete('/api/emails/:id', (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const id = c.req.param('id');
    const res = db.sqlite.prepare('DELETE FROM encrypted_emails WHERE id = ?').run(id);
    if (res.changes === 0) return c.json({ error: 'Email not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/api/emails/simulate', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const body = (await c.req.json()) as {
      from?: string;
      to?: string;
      subject?: string;
      text?: string;
      html?: string;
    };
    if (!body.from || !body.to || !body.subject) {
      return c.json({ error: 'Missing from, to, or subject' }, 400);
    }

    const result = await ingestSimulatedEmail({
      db,
      wsHub,
      from: body.from,
      to: body.to,
      subject: body.subject,
      text: body.text,
      html: body.html,
    });

    if (!result.accepted) {
      return c.json(result, 202);
    }
    return c.json(result, 201);
  });

  // Service Accounts
  app.get('/api/service-accounts', (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const rows = db.sqlite
      .prepare('SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM service_accounts ORDER BY created_at DESC')
      .all() as Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }>;

    const stmtVaults = db.sqlite.prepare(
      'SELECT vault_id FROM service_account_vaults WHERE service_account_id = ?'
    );
    const serviceAccounts = rows.map((sa) => ({
      ...sa,
      vaultIds: (stmtVaults.all(sa.id) as Array<{ vault_id: string }>).map((v) => v.vault_id),
    }));

    return c.json({ serviceAccounts });
  });

  app.post('/api/service-accounts', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const body = (await c.req.json()) as {
      id?: string;
      name?: string;
      authSecret?: string;
      vaultKeys?: Array<{ vaultId: string; encryptedVaultKey: string }>;
    };

    if (!body.name || !body.authSecret || !Array.isArray(body.vaultKeys) || body.vaultKeys.length === 0) {
      return c.json({ error: 'Missing name, authSecret, or vaultKeys' }, 400);
    }

    const id = body.id ?? `sa_${randomId().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const authSecretHash = hashSecret(body.authSecret);

    db.sqlite.exec('BEGIN IMMEDIATE');
    try {
      db.sqlite
        .prepare(
          `INSERT INTO service_accounts (id, name, auth_secret_hash, created_at, last_used_at)
           VALUES (?, ?, ?, ?, NULL)`
        )
        .run(id, body.name.trim(), authSecretHash, now);

      const insertAccess = db.sqlite.prepare(
        `INSERT INTO service_account_vaults (service_account_id, vault_id, encrypted_vault_key)
         VALUES (?, ?, ?)`
      );
      for (const vk of body.vaultKeys) {
        insertAccess.run(id, vk.vaultId, vk.encryptedVaultKey);
      }

      db.sqlite.exec('COMMIT');
    } catch (err) {
      try {
        db.sqlite.exec('ROLLBACK');
      } catch {
        // ignore
      }
      return c.json({ error: err instanceof Error ? err.message : 'Failed creating service account' }, 400);
    }

    return c.json(
      {
        serviceAccount: {
          id,
          name: body.name.trim(),
          vaultIds: body.vaultKeys.map((v) => v.vaultId),
          createdAt: now,
          lastUsedAt: null,
        },
      },
      201
    );
  });

  app.delete('/api/service-accounts/:id', (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const id = c.req.param('id');
    db.sqlite.prepare('DELETE FROM sessions WHERE service_account_id = ?').run(id);
    const res = db.sqlite.prepare('DELETE FROM service_accounts WHERE id = ?').run(id);
    if (res.changes === 0) return c.json({ error: 'Service Account not found' }, 404);
    return c.json({ ok: true });
  });

  // Settings & IMAP
  app.get('/api/settings', (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const row = db.sqlite
      .prepare(
        `SELECT email, email_public_key AS emailPublicKey, cf_webhook_secret AS cfWebhookSecret,
                alias_domain AS aliasDomain
         FROM account WHERE id = 1`
      )
      .get();
    return c.json({ settings: row });
  });

  app.patch('/api/settings', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const body = (await c.req.json()) as {
      aliasDomain?: string;
      rotateWebhookSecret?: boolean;
    };

    if (body.aliasDomain !== undefined) {
      db.sqlite
        .prepare('UPDATE account SET alias_domain = ? WHERE id = 1')
        .run(body.aliasDomain.trim().toLowerCase());
    }
    if (body.rotateWebhookSecret) {
      const nextSecret = crypto.randomBytes(32).toString('hex');
      db.sqlite.prepare('UPDATE account SET cf_webhook_secret = ? WHERE id = 1').run(nextSecret);
    }

    const row = db.sqlite
      .prepare(
        `SELECT email, email_public_key AS emailPublicKey, cf_webhook_secret AS cfWebhookSecret,
                alias_domain AS aliasDomain
         FROM account WHERE id = 1`
      )
      .get();
    return c.json({ settings: row });
  });

  app.get('/api/imap', (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;
    return c.json({ imap: imapWorker.getPublicConfig() });
  });

  app.put('/api/imap', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const body = (await c.req.json()) as {
      enabled?: boolean;
      host?: string;
      port?: number;
      tls?: boolean;
      username?: string;
      password?: string;
    };

    const existing = db.sqlite
      .prepare('SELECT enabled, host, port, tls, username, password_enc FROM imap_config WHERE id = 1')
      .get() as {
      enabled: number;
      host: string;
      port: number;
      tls: number;
      username: string;
      password_enc: string;
    };

    const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;
    const host = body.host !== undefined ? body.host.trim() : existing.host;
    const port = body.port !== undefined ? Number(body.port) : existing.port;
    const tls = body.tls !== undefined ? (body.tls ? 1 : 0) : existing.tls;
    const username = body.username !== undefined ? body.username.trim() : existing.username;
    const passwordEnc =
      body.password && body.password.length > 0
        ? db.encryptLocalSecret(body.password)
        : existing.password_enc;

    db.sqlite
      .prepare(
        `UPDATE imap_config
         SET enabled = ?, host = ?, port = ?, tls = ?, username = ?, password_enc = ?, updated_at = ?
         WHERE id = 1`
      )
      .run(enabled, host, port, tls, username, passwordEnc, new Date().toISOString());

    await imapWorker.reload();
    return c.json({ imap: imapWorker.getPublicConfig() });
  });

  app.post('/api/imap/test', async (c) => {
    const ownerOrRes = requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const body = (await c.req.json()) as {
      host?: string;
      port?: number;
      tls?: boolean;
      username?: string;
      password?: string;
    };

    const existing = db.sqlite
      .prepare('SELECT host, port, tls, username, password_enc FROM imap_config WHERE id = 1')
      .get() as {
      host: string;
      port: number;
      tls: number;
      username: string;
      password_enc: string;
    };

    const host = (body.host ?? existing.host).trim();
    const port = Number(body.port ?? existing.port ?? 993);
    const tls = body.tls ?? existing.tls === 1;
    const username = (body.username ?? existing.username).trim();
    const password =
      body.password && body.password.length > 0
        ? body.password
        : db.decryptLocalSecret(existing.password_enc);

    if (!host || !username || !password) {
      return c.json({ ok: false, error: 'Missing host, username, or password' }, 400);
    }

    const result = await imapWorker.testConnection({ host, port, tls, username, password });
    return c.json(result);
  });

  // Cloudflare Email Worker Webhook
  app.post('/api/webhooks/email/cf', async (c) => {
    const account = db.sqlite
      .prepare('SELECT cf_webhook_secret FROM account WHERE id = 1')
      .get() as { cf_webhook_secret: string } | undefined;

    if (!account) {
      return c.json({ error: 'Account not initialized' }, 503);
    }

    const rawBytes = new Uint8Array(await c.req.arrayBuffer());
    const timestampHeader = c.req.header('x-nonepwd-timestamp');
    const signatureHeader = c.req.header('x-nonepwd-signature');

    if (
      !verifyWebhookHmac(
        account.cf_webhook_secret,
        timestampHeader,
        signatureHeader,
        rawBytes
      )
    ) {
      return c.json({ error: 'Invalid webhook signature' }, 401);
    }

    const contentType = (c.req.header('content-type') ?? '').toLowerCase();
    if (contentType.includes('application/json')) {
      const parsed = JSON.parse(new TextDecoder().decode(rawBytes)) as {
        mode?: string;
        envelopeFrom?: string;
        envelopeTo?: string;
        hasOtp?: boolean;
        sealedEnvelope?: SealedEnvelope;
      };
      if (parsed.mode !== 'edge_sealed' || !parsed.sealedEnvelope) {
        return c.json({ error: 'Unsupported JSON payload for CF email webhook' }, 400);
      }

      const result = await ingestPreSealedEmail({
        db,
        wsHub,
        sealedEnvelope: parsed.sealedEnvelope,
        hasOtp: Boolean(parsed.hasOtp),
        envelopeTo: parsed.envelopeTo ? extractEmailAddress(parsed.envelopeTo) : null,
        source: 'cloudflare',
      });
      if (!result.accepted) {
        return c.json(result, 202);
      }
      return c.json({ accepted: true, emailId: result.email?.id });
    }

    const result = await ingestRawEmail({
      db,
      wsHub,
      rawMime: rawBytes,
      source: 'cloudflare',
      envelopeFrom: c.req.header('x-nonepwd-envelope-from'),
      envelopeTo: c.req.header('x-nonepwd-envelope-to'),
    });

    if (!result.accepted) {
      return c.json(result, 202);
    }
    return c.json({ accepted: true, emailId: result.email?.id });
  });

  // Cross-platform native Rust `np` CLI installer script & binary downloads
  app.get('/install.sh', (c) => {
    const origin = new URL(c.req.url).origin;
    const script = `#!/usr/bin/env bash
set -euo pipefail

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS_KEY="darwin" ;;
  Linux)  OS_KEY="linux" ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH_KEY="arm64" ;;
  x86_64|amd64)  ARCH_KEY="x86_64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

PREFIX="\${PREFIX:-$HOME/.local/bin}"
mkdir -p "$PREFIX"

URL="${origin}/downloads/np-\${OS_KEY}-\${ARCH_KEY}"
echo "Downloading nonepwd CLI from $URL ..."
curl -fsSL "$URL" -o "$PREFIX/np"
chmod 755 "$PREFIX/np"
echo "Installed nonepwd native CLI -> $PREFIX/np"
"$PREFIX/np" version
`;
    return new Response(script, {
      status: 200,
      headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8' },
    });
  });

  app.get('/downloads/:filename', (c) => {
    const filename = c.req.param('filename');
    if (!ALLOWED_CLI_BINARIES.has(filename)) {
      return c.json({ error: 'Binary not found' }, 404);
    }
    const targetPath = binDistDirs
      .map((dir) => path.join(dir, filename))
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!targetPath) {
      return c.json({ error: 'Binary artifact not built' }, 404);
    }
    const content = fs.readFileSync(targetPath);
    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': filename.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });

  // Static Web Vault Hosting (if built)
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not found' }, 404);
    }
    if (!fs.existsSync(webDistDir)) {
      return c.text('nonepwd API server is running.', 200);
    }
    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
    const safeRel = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '');
    let targetFile = path.join(webDistDir, safeRel);
    if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
      targetFile = path.join(webDistDir, 'index.html');
    }
    if (!fs.existsSync(targetFile)) {
      return c.text('Web Vault index.html not found', 404);
    }
    const ext = path.extname(targetFile).toLowerCase();
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    const content = fs.readFileSync(targetFile);
    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': mime },
    });
  });

  let httpServer: HttpServer | null = null;

  return {
    app,
    db,
    wsHub,
    imapWorker,

    async start(port = 8787, host = '127.0.0.1') {
      const server = createAdaptorServer({ fetch: app.fetch }) as HttpServer;
      httpServer = server;
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/agent/relay') {
          agentRelay.handleUpgrade(req, socket, head);
          return;
        }
        wsHub.handleUpgrade(req, socket, head);
      });

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });

      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}`;

      // Boot IMAP worker asynchronously in background if configured
      void imapWorker.reload();

      return { server, port: boundPort, url };
    },

    async close() {
      await imapWorker.stop();
      wsHub.closeAll();
      agentRelay.close();
      if (httpServer) {
        const s = httpServer;
        httpServer = null;
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
      db.close();
    },
  };
}
