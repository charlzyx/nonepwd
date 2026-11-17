import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import {
  extractEmailAddress,
  generateEmailAlias,
  randomId,
  type SealedEnvelope,
} from '@nonepwd/core/worker';
import {
  authenticateToken,
  createSession,
  extractBearerToken,
  hashSecret,
  randomHex,
  verifySecret,
  verifyWebhookHmac,
  type AuthContext,
  type OwnerAuthContext,
} from './auth.js';
import {
  deleteStoredEmail,
  getEmailFilter,
  ingestPreSealedEmail,
  ingestRawEmail,
  ingestSimulatedEmail,
  queryEmails,
  saveEmailFilter,
} from './email.js';
import {
  createEncryptedSnapshot,
  deleteEncryptedSnapshot,
  listEncryptedSnapshots,
  maybeAutoSnapshot,
  restoreEncryptedSnapshot,
} from './r2-backup.js';
import { ensureSchema } from './schema.js';
import type { CfServerEnv, EmailFilterConfig } from './types.js';
import { broadcastEvent } from './ws-hub.js';

const OWNER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SA_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const ALLOWED_CLI_BINARIES = new Set([
  'np',
  'np-darwin-arm64',
  'np-darwin-x86_64',
  'np-linux-x86_64',
  'np-linux-arm64',
  'nonepwd-extension.zip',
  'NonePwd-macos-arm64.dmg',
]);

async function getAuth(c: Context<{ Bindings: CfServerEnv }>): Promise<AuthContext | null> {
  const token = extractBearerToken(c.req.header('authorization'));
  return authenticateToken(c.env.DB, token);
}

async function requireAuth(
  c: Context<{ Bindings: CfServerEnv }>
): Promise<AuthContext | Response> {
  const auth = await getAuth(c);
  if (!auth) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return auth;
}

async function requireOwner(
  c: Context<{ Bindings: CfServerEnv }>
): Promise<OwnerAuthContext | Response> {
  const auth = await getAuth(c);
  if (!auth) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (auth.kind !== 'owner') {
    return c.json({ error: 'Owner authorization required' }, 403);
  }
  return auth;
}

function scheduleAutoBackup(c: Context<{ Bindings: CfServerEnv }>): void {
  if (!c.env.BUCKET) return;
  try {
    c.executionCtx.waitUntil(maybeAutoSnapshot(c.env));
  } catch {
    // Unit tests call app.fetch without ExecutionContext
  }
}

async function queryOwnerVaults(db: D1Database) {
  const res = await db
    .prepare(
      `SELECT id, encrypted_key AS encryptedKey, encrypted_meta AS encryptedMeta,
              created_at AS createdAt, updated_at AS updatedAt
       FROM vaults ORDER BY created_at ASC`
    )
    .all<{
      id: string;
      encryptedKey: string;
      encryptedMeta: string;
      createdAt: string;
      updatedAt: string;
    }>();
  return res.results ?? [];
}

async function querySaVaults(db: D1Database, saId: string) {
  const res = await db
    .prepare(
      `SELECT v.id, sav.encrypted_vault_key AS encryptedKey, v.encrypted_meta AS encryptedMeta,
              v.created_at AS createdAt, v.updated_at AS updatedAt
       FROM vaults v
       JOIN service_account_vaults sav ON sav.vault_id = v.id
       WHERE sav.service_account_id = ?
       ORDER BY v.created_at ASC`
    )
    .bind(saId)
    .all<{
      id: string;
      encryptedKey: string;
      encryptedMeta: string;
      createdAt: string;
      updatedAt: string;
    }>();
  return res.results ?? [];
}

async function queryAliases(db: D1Database) {
  const res = await db
    .prepare(
      `SELECT id, address, site_domain AS siteDomain, vault_id AS vaultId, item_id AS itemId,
              enabled, received_count AS receivedCount, created_at AS createdAt
       FROM aliases ORDER BY created_at DESC`
    )
    .all<{
      id: string;
      address: string;
      siteDomain: string | null;
      vaultId: string | null;
      itemId: string | null;
      enabled: number;
      receivedCount: number;
      createdAt: string;
    }>();
  return (res.results ?? []).map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
}

function getImapPublicStatus() {
  return {
    enabled: false,
    host: '',
    port: 993,
    tls: true,
    username: '',
    hasPassword: false,
    status: 'disabled' as const,
    lastError: null as string | null,
    cloudflareMode: true,
  };
}

export function createCfApp(): Hono<{ Bindings: CfServerEnv }> {
  const app = new Hono<{ Bindings: CfServerEnv }>();

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

  app.use('/api/*', async (c, next) => {
    await ensureSchema(c.env.DB);
    await next();
  });

  app.get('/api/health', async (c) => {
    const row = await c.env.DB.prepare('SELECT id FROM account WHERE id = 1').first<{ id: number }>();
    return c.json({
      ok: true,
      initialized: Boolean(row),
      version: '0.1.0',
      runtime: 'cloudflare-workers',
      storage: {
        d1: true,
        r2: Boolean(c.env.BUCKET),
        durableObjects: Boolean(c.env.WS_HUB),
      },
    });
  });

  app.get('/api/auth/params', async (c) => {
    const row = await c.env.DB.prepare(
      'SELECT email, kdf_salt, kdf_iterations FROM account WHERE id = 1'
    ).first<{ email: string; kdf_salt: string; kdf_iterations: number }>();

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

    const existing = await c.env.DB.prepare('SELECT id FROM account WHERE id = 1').first<{
      id: number;
    }>();
    if (existing) {
      return c.json({ error: 'Account already initialized' }, 409);
    }

    const now = new Date().toISOString();
    const cfWebhookSecret = randomHex(32);
    const authHash = await hashSecret(body.authVerifier);
    const aliasDomain = (body.aliasDomain ?? '').trim().toLowerCase();
    const email = body.email.trim().toLowerCase();

    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO account
         (id, email, kdf_salt, kdf_iterations, auth_verifier_hash, encrypted_root_keyset, email_public_key, cf_webhook_secret, alias_domain, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        email,
        body.kdfSalt,
        body.kdfIterations,
        authHash,
        body.encryptedRootKeyset,
        body.emailPublicKey,
        cfWebhookSecret,
        aliasDomain,
        now
      ),
    ];

    if (Array.isArray(body.vaults)) {
      for (const v of body.vaults) {
        stmts.push(
          c.env.DB.prepare(
            `INSERT INTO vaults (id, encrypted_key, encrypted_meta, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`
          ).bind(v.id, v.encryptedKey, v.encryptedMeta, now, now)
        );
      }
    }

    try {
      await c.env.DB.batch(stmts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('unique') || msg.toLowerCase().includes('constraint')) {
        return c.json({ error: 'Account already initialized' }, 409);
      }
      return c.json({ error: `Setup transaction failed: ${msg}` }, 500);
    }

    const token = await createSession(c.env.DB, 'owner', undefined, OWNER_SESSION_TTL_MS);
    scheduleAutoBackup(c);
    return c.json(
      {
        token,
        account: {
          email,
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

    const row = await c.env.DB.prepare(
      `SELECT email, kdf_salt, kdf_iterations, auth_verifier_hash, encrypted_root_keyset,
              email_public_key, cf_webhook_secret, alias_domain
       FROM account WHERE id = 1`
    ).first<{
      email: string;
      kdf_salt: string;
      kdf_iterations: number;
      auth_verifier_hash: string;
      encrypted_root_keyset: string;
      email_public_key: string;
      cf_webhook_secret: string;
      alias_domain: string;
    }>();

    if (!row) {
      return c.json({ error: 'Account not initialized' }, 404);
    }

    if (!(await verifySecret(body.authVerifier, row.auth_verifier_hash))) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const token = await createSession(c.env.DB, 'owner', undefined, OWNER_SESSION_TTL_MS);
    scheduleAutoBackup(c);
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

    const sa = await c.env.DB.prepare(
      'SELECT id, name, auth_secret_hash FROM service_accounts WHERE id = ?'
    )
      .bind(body.tokenId)
      .first<{ id: string; name: string; auth_secret_hash: string }>();

    if (!sa || !(await verifySecret(body.authSecret, sa.auth_secret_hash))) {
      return c.json({ error: 'Invalid Service Account token' }, 401);
    }

    await c.env.DB.prepare('UPDATE service_accounts SET last_used_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), sa.id)
      .run();

    const vaults = await querySaVaults(c.env.DB, sa.id);
    const token = await createSession(c.env.DB, 'service_account', sa.id, SA_SESSION_TTL_MS);

    return c.json({
      token,
      serviceAccount: { id: sa.id, name: sa.name },
      vaults,
    });
  });

  app.post('/api/auth/logout', async (c) => {
    const auth = await getAuth(c);
    if (auth) {
      await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(auth.tokenHash).run();
    }
    return c.json({ ok: true });
  });

  app.get('/api/sync', async (c) => {
    const authOrRes = await requireAuth(c);
    if (authOrRes instanceof Response) return authOrRes;

    if (authOrRes.kind === 'service_account') {
      const [vaults, itemsRes] = await Promise.all([
        querySaVaults(c.env.DB, authOrRes.serviceAccountId),
        c.env.DB.prepare(
          `SELECT i.id, i.vault_id AS vaultId, i.encrypted_data AS encryptedData,
                  i.created_at AS createdAt, i.updated_at AS updatedAt, i.version
           FROM items i
           JOIN service_account_vaults sav ON sav.vault_id = i.vault_id
           WHERE sav.service_account_id = ?
           ORDER BY i.updated_at DESC`
        )
          .bind(authOrRes.serviceAccountId)
          .all(),
      ]);

      return c.json({
        kind: 'service_account',
        vaults,
        items: itemsRes.results ?? [],
      });
    }

    const [account, vaults, itemsRes, aliases, emails, emailFilter] = await Promise.all([
      c.env.DB.prepare(
        `SELECT email, encrypted_root_keyset AS encryptedRootKeyset,
                email_public_key AS emailPublicKey, cf_webhook_secret AS cfWebhookSecret,
                alias_domain AS aliasDomain
         FROM account WHERE id = 1`
      ).first(),
      queryOwnerVaults(c.env.DB),
      c.env.DB.prepare(
        `SELECT id, vault_id AS vaultId, encrypted_data AS encryptedData,
                created_at AS createdAt, updated_at AS updatedAt, version
         FROM items ORDER BY updated_at DESC`
      ).all(),
      queryAliases(c.env.DB),
      queryEmails(c.env, 100),
      getEmailFilter(c.env.DB),
    ]);

    return c.json({
      kind: 'owner',
      account,
      vaults,
      items: itemsRes.results ?? [],
      aliases,
      emails,
      imapStatus: getImapPublicStatus(),
      emailFilter,
      cfRuntime: {
        runtime: 'cloudflare-workers',
        r2Enabled: Boolean(c.env.BUCKET),
        wsEnabled: Boolean(c.env.WS_HUB),
      },
    });
  });

  // Vault routes
  app.get('/api/vaults', async (c) => {
    const authOrRes = await requireAuth(c);
    if (authOrRes instanceof Response) return authOrRes;

    const vaults =
      authOrRes.kind === 'service_account'
        ? await querySaVaults(c.env.DB, authOrRes.serviceAccountId)
        : await queryOwnerVaults(c.env.DB);
    return c.json({ vaults });
  });

  app.post('/api/vaults', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const body = (await c.req.json()) as {
      id?: string;
      encryptedKey?: string;
      encryptedMeta?: string;
    };
    if (!body.encryptedKey || !body.encryptedMeta) {
      return c.json({ error: 'Missing encryptedKey or encryptedMeta' }, 400);
    }

    const id = body.id?.trim() || randomId();
    const now = new Date().toISOString();
    try {
      await c.env.DB.prepare(
        `INSERT INTO vaults (id, encrypted_key, encrypted_meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(id, body.encryptedKey, body.encryptedMeta, now, now)
        .run();
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed creating vault' },
        409
      );
    }

    const vault = {
      id,
      encryptedKey: body.encryptedKey,
      encryptedMeta: body.encryptedMeta,
      createdAt: now,
      updatedAt: now,
    };
    await broadcastEvent(c.env, { type: 'vault.upserted', vault }, { ownerOnly: true });
    return c.json({ vault }, 201);
  });

  app.patch('/api/vaults/:id', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('id');
    const body = (await c.req.json()) as { encryptedMeta?: string; encryptedKey?: string };
    const existing = await c.env.DB.prepare('SELECT id FROM vaults WHERE id = ?')
      .bind(vaultId)
      .first<{ id: string }>();
    if (!existing) return c.json({ error: 'Vault not found' }, 404);

    const now = new Date().toISOString();
    if (body.encryptedMeta) {
      await c.env.DB.prepare('UPDATE vaults SET encrypted_meta = ?, updated_at = ? WHERE id = ?')
        .bind(body.encryptedMeta, now, vaultId)
        .run();
    }
    if (body.encryptedKey) {
      await c.env.DB.prepare('UPDATE vaults SET encrypted_key = ?, updated_at = ? WHERE id = ?')
        .bind(body.encryptedKey, now, vaultId)
        .run();
    }

    const vault = await c.env.DB.prepare(
      `SELECT id, encrypted_key AS encryptedKey, encrypted_meta AS encryptedMeta,
              created_at AS createdAt, updated_at AS updatedAt
       FROM vaults WHERE id = ?`
    )
      .bind(vaultId)
      .first();

    await broadcastEvent(c.env, { type: 'vault.upserted', vault }, { vaultId });
    return c.json({ vault });
  });

  app.delete('/api/vaults/:id', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('id');
    const existing = await c.env.DB.prepare('SELECT id FROM vaults WHERE id = ?')
      .bind(vaultId)
      .first<{ id: string }>();
    if (!existing) return c.json({ error: 'Vault not found' }, 404);

    // Delete dependent rows explicitly in batch so cleanup never depends on per-connection PRAGMA foreign_keys
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM items WHERE vault_id = ?').bind(vaultId),
      c.env.DB.prepare('DELETE FROM service_account_vaults WHERE vault_id = ?').bind(vaultId),
      c.env.DB.prepare('DELETE FROM vaults WHERE id = ?').bind(vaultId),
    ]);

    await broadcastEvent(c.env, { type: 'vault.deleted', vaultId }, { ownerOnly: true });
    return c.json({ ok: true });
  });

  // Item routes
  app.get('/api/vaults/:vaultId/items', async (c) => {
    const authOrRes = await requireAuth(c);
    if (authOrRes instanceof Response) return authOrRes;

    const vaultId = c.req.param('vaultId');
    if (authOrRes.kind === 'service_account' && !authOrRes.allowedVaultIds.has(vaultId)) {
      return c.json({ error: 'Vault not authorized for this Service Account' }, 403);
    }

    const res = await c.env.DB.prepare(
      `SELECT id, vault_id AS vaultId, encrypted_data AS encryptedData,
              created_at AS createdAt, updated_at AS updatedAt, version
       FROM items WHERE vault_id = ? ORDER BY updated_at DESC`
    )
      .bind(vaultId)
      .all();
    return c.json({ items: res.results ?? [] });
  });

  app.post('/api/vaults/:vaultId/items', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('vaultId');
    const vault = await c.env.DB.prepare('SELECT id FROM vaults WHERE id = ?')
      .bind(vaultId)
      .first<{ id: string }>();
    if (!vault) return c.json({ error: 'Vault not found' }, 404);

    const body = (await c.req.json()) as { id?: string; encryptedData?: string };
    if (!body.encryptedData) {
      return c.json({ error: 'Missing encryptedData' }, 400);
    }

    const id = body.id?.trim() || randomId();
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      `INSERT INTO items (id, vault_id, encrypted_data, created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, 1)`
    )
      .bind(id, vaultId, body.encryptedData, now, now)
      .run();

    const item = {
      id,
      vaultId,
      encryptedData: body.encryptedData,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await broadcastEvent(c.env, { type: 'item.upserted', item }, { vaultId });
    scheduleAutoBackup(c);
    return c.json({ item }, 201);
  });

  app.post('/api/vaults/:vaultId/items/batch', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('vaultId');
    const vault = await c.env.DB.prepare('SELECT id FROM vaults WHERE id = ?')
      .bind(vaultId)
      .first<{ id: string }>();
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
    const inserted: Array<{
      id: string;
      vaultId: string;
      encryptedData: string;
      createdAt: string;
      updatedAt: string;
      version: number;
    }> = [];
    const stmts: D1PreparedStatement[] = [];

    for (const entry of body.items) {
      const id = entry.id?.trim() || randomId();
      const encryptedData = entry.encryptedData!;
      stmts.push(
        c.env.DB.prepare(
          `INSERT OR REPLACE INTO items (id, vault_id, encrypted_data, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, 1)`
        ).bind(id, vaultId, encryptedData, now, now)
      );
      inserted.push({
        id,
        vaultId,
        encryptedData,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
    }

    await c.env.DB.batch(stmts);
    await broadcastEvent(c.env, { type: 'item.upserted', count: inserted.length }, { vaultId });
    scheduleAutoBackup(c);
    return c.json({ imported: inserted.length, items: inserted }, 201);
  });

  app.put('/api/vaults/:vaultId/items/:itemId', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('vaultId');
    const itemId = c.req.param('itemId');
    const body = (await c.req.json()) as { encryptedData?: string };
    if (!body.encryptedData) {
      return c.json({ error: 'Missing encryptedData' }, 400);
    }

    const existing = await c.env.DB.prepare(
      'SELECT id, created_at, version FROM items WHERE id = ? AND vault_id = ?'
    )
      .bind(itemId, vaultId)
      .first<{ id: string; created_at: string; version: number }>();

    const now = new Date().toISOString();
    let version = 1;
    let createdAt = now;

    if (existing) {
      version = existing.version + 1;
      createdAt = existing.created_at;
      await c.env.DB.prepare(
        'UPDATE items SET encrypted_data = ?, updated_at = ?, version = ? WHERE id = ?'
      )
        .bind(body.encryptedData, now, version, itemId)
        .run();
    } else {
      const vault = await c.env.DB.prepare('SELECT id FROM vaults WHERE id = ?')
        .bind(vaultId)
        .first<{ id: string }>();
      if (!vault) return c.json({ error: 'Vault not found' }, 404);

      await c.env.DB.prepare(
        `INSERT INTO items (id, vault_id, encrypted_data, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
        .bind(itemId, vaultId, body.encryptedData, now, now)
        .run();
    }

    const item = {
      id: itemId,
      vaultId,
      encryptedData: body.encryptedData,
      createdAt,
      updatedAt: now,
      version,
    };
    await broadcastEvent(c.env, { type: 'item.upserted', item }, { vaultId });
    scheduleAutoBackup(c);
    return c.json({ item });
  });

  app.delete('/api/vaults/:vaultId/items/:itemId', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const vaultId = c.req.param('vaultId');
    const itemId = c.req.param('itemId');
    const res = await c.env.DB.prepare('DELETE FROM items WHERE id = ? AND vault_id = ?')
      .bind(itemId, vaultId)
      .run();
    if (Number(res.meta?.changes ?? 0) === 0) {
      return c.json({ error: 'Item not found' }, 404);
    }

    await broadcastEvent(c.env, { type: 'item.deleted', vaultId, itemId }, { vaultId });
    scheduleAutoBackup(c);
    return c.json({ ok: true });
  });

  // Masked Email Aliases
  app.get('/api/aliases', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;
    const aliases = await queryAliases(c.env.DB);
    return c.json({ aliases });
  });

  app.post('/api/aliases', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const body = (await c.req.json()) as {
      address?: string;
      siteDomain?: string;
      vaultId?: string;
      itemId?: string;
    };

    let address = body.address?.trim().toLowerCase() ?? '';
    if (!address) {
      const account = await c.env.DB.prepare('SELECT alias_domain FROM account WHERE id = 1').first<{
        alias_domain: string;
      }>();
      const domain = account?.alias_domain;
      if (!domain) {
        return c.json({ error: 'No aliasDomain configured; provide explicit address' }, 400);
      }
      address = generateEmailAlias(body.siteDomain ?? 'site', domain);
    }

    const id = randomId();
    const now = new Date().toISOString();
    const siteDomain = body.siteDomain?.trim().toLowerCase() || null;
    const vaultId = body.vaultId ?? null;
    const itemId = body.itemId ?? null;

    try {
      await c.env.DB.prepare(
        `INSERT INTO aliases (id, address, site_domain, vault_id, item_id, enabled, received_count, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, ?)`
      )
        .bind(id, address, siteDomain, vaultId, itemId, now)
        .run();
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Alias already exists' },
        409
      );
    }

    const alias = {
      id,
      address,
      siteDomain,
      vaultId,
      itemId,
      enabled: true,
      receivedCount: 0,
      createdAt: now,
    };
    await broadcastEvent(c.env, { type: 'alias.upserted', alias }, { ownerOnly: true });
    return c.json({ alias }, 201);
  });

  app.patch('/api/aliases/:id', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      enabled?: boolean;
      vaultId?: string | null;
      itemId?: string | null;
      siteDomain?: string | null;
    };

    const existing = await c.env.DB.prepare('SELECT * FROM aliases WHERE id = ?')
      .bind(id)
      .first<{
        id: string;
        enabled: number;
        vault_id: string | null;
        item_id: string | null;
        site_domain: string | null;
      }>();
    if (!existing) return c.json({ error: 'Alias not found' }, 404);

    const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled;
    const vaultId = body.vaultId !== undefined ? body.vaultId : existing.vault_id;
    const itemId = body.itemId !== undefined ? body.itemId : existing.item_id;
    const siteDomain = body.siteDomain !== undefined ? body.siteDomain : existing.site_domain;

    await c.env.DB.prepare(
      'UPDATE aliases SET enabled = ?, vault_id = ?, item_id = ?, site_domain = ? WHERE id = ?'
    )
      .bind(enabled, vaultId, itemId, siteDomain, id)
      .run();

    const updated = await c.env.DB.prepare(
      `SELECT id, address, site_domain AS siteDomain, vault_id AS vaultId, item_id AS itemId,
              enabled, received_count AS receivedCount, created_at AS createdAt
       FROM aliases WHERE id = ?`
    )
      .bind(id)
      .first<{
        id: string;
        address: string;
        siteDomain: string | null;
        vaultId: string | null;
        itemId: string | null;
        enabled: number;
        receivedCount: number;
        createdAt: string;
      }>();

    const alias = updated ? { ...updated, enabled: Boolean(updated.enabled) } : null;
    await broadcastEvent(c.env, { type: 'alias.upserted', alias }, { ownerOnly: true });
    return c.json({ alias });
  });

  app.delete('/api/aliases/:id', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const id = c.req.param('id');
    const res = await c.env.DB.prepare('DELETE FROM aliases WHERE id = ?').bind(id).run();
    if (Number(res.meta?.changes ?? 0) === 0) {
      return c.json({ error: 'Alias not found' }, 404);
    }

    await broadcastEvent(c.env, { type: 'alias.deleted', id }, { ownerOnly: true });
    return c.json({ ok: true });
  });

  // Encrypted Email Inbox + Simulate OTP endpoint
  app.get('/api/emails', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const emails = await queryEmails(c.env, 100);
    return c.json({ emails });
  });

  app.delete('/api/emails/:id', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const id = c.req.param('id');
    const removed = await deleteStoredEmail(c.env, id);
    if (!removed) return c.json({ error: 'Email not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/api/emails/simulate', async (c) => {
    const ownerOrRes = await requireOwner(c);
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
      env: c.env,
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

  app.get('/api/email-filter', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const cfg = await getEmailFilter(c.env.DB);
    return c.json(cfg);
  });

  app.put('/api/email-filter', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const rawBody = (await c.req.json()) as
      | Partial<EmailFilterConfig>
      | { emailFilter?: Partial<EmailFilterConfig> };
    const candidate =
      'emailFilter' in rawBody && rawBody.emailFilter ? rawBody.emailFilter : (rawBody as Partial<EmailFilterConfig>);

    try {
      const saved = await saveEmailFilter(c.env.DB, candidate);
      return c.json(saved);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Invalid email filter config' },
        400
      );
    }
  });

  // Service Accounts
  app.get('/api/service-accounts', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const saRes = await c.env.DB.prepare(
      'SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM service_accounts ORDER BY created_at DESC'
    ).all<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }>();

    const vaultLinksRes = await c.env.DB.prepare(
      'SELECT service_account_id, vault_id FROM service_account_vaults'
    ).all<{ service_account_id: string; vault_id: string }>();

    const map = new Map<string, string[]>();
    for (const link of vaultLinksRes.results ?? []) {
      const arr = map.get(link.service_account_id) ?? [];
      arr.push(link.vault_id);
      map.set(link.service_account_id, arr);
    }

    const serviceAccounts = (saRes.results ?? []).map((sa) => ({
      ...sa,
      vaultIds: map.get(sa.id) ?? [],
    }));
    return c.json({ serviceAccounts });
  });

  app.post('/api/service-accounts', async (c) => {
    const ownerOrRes = await requireOwner(c);
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

    const id = body.id?.trim() || `sa_${randomId().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const authSecretHash = await hashSecret(body.authSecret);

    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO service_accounts (id, name, auth_secret_hash, created_at, last_used_at)
         VALUES (?, ?, ?, ?, NULL)`
      ).bind(id, body.name.trim(), authSecretHash, now),
    ];

    for (const vk of body.vaultKeys) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO service_account_vaults (service_account_id, vault_id, encrypted_vault_key)
           VALUES (?, ?, ?)`
        ).bind(id, vk.vaultId, vk.encryptedVaultKey)
      );
    }

    try {
      await c.env.DB.batch(stmts);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Failed creating service account' },
        400
      );
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

  app.delete('/api/service-accounts/:id', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const id = c.req.param('id');
    const existing = await c.env.DB.prepare('SELECT id FROM service_accounts WHERE id = ?')
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return c.json({ error: 'Service Account not found' }, 404);

    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM sessions WHERE service_account_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM service_account_vaults WHERE service_account_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM service_accounts WHERE id = ?').bind(id),
    ]);
    return c.json({ ok: true });
  });

  // Settings & IMAP (Informational on Cloudflare Workers)
  app.get('/api/settings', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const row = await c.env.DB.prepare(
      `SELECT email, email_public_key AS emailPublicKey, cf_webhook_secret AS cfWebhookSecret,
              alias_domain AS aliasDomain
       FROM account WHERE id = 1`
    ).first();
    return c.json({ settings: row });
  });

  app.patch('/api/settings', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;

    const body = (await c.req.json()) as {
      aliasDomain?: string;
      rotateWebhookSecret?: boolean;
    };

    if (body.aliasDomain !== undefined) {
      await c.env.DB.prepare('UPDATE account SET alias_domain = ? WHERE id = 1')
        .bind(body.aliasDomain.trim().toLowerCase())
        .run();
    }
    if (body.rotateWebhookSecret) {
      const nextSecret = randomHex(32);
      await c.env.DB.prepare('UPDATE account SET cf_webhook_secret = ? WHERE id = 1')
        .bind(nextSecret)
        .run();
    }

    const row = await c.env.DB.prepare(
      `SELECT email, email_public_key AS emailPublicKey, cf_webhook_secret AS cfWebhookSecret,
              alias_domain AS aliasDomain
       FROM account WHERE id = 1`
    ).first();
    return c.json({ settings: row });
  });

  app.get('/api/imap', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;
    return c.json({ imap: getImapPublicStatus() });
  });

  app.put('/api/imap', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;
    return c.json({ imap: getImapPublicStatus() });
  });

  app.post('/api/imap/test', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;
    return c.json({
      ok: false,
      error:
        'Cloudflare Workers 运行时请直接在 Cloudflare Dashboard 将域名 Catch-All Email Routing 绑定到 nonepwd-cf-server，无需配置 IMAP 长连接。',
    });
  });

  // External Cloudflare Email Worker Webhook (optional when forwarding from another Worker)
  app.post('/api/webhooks/email/cf', async (c) => {
    const account = await c.env.DB.prepare(
      'SELECT cf_webhook_secret FROM account WHERE id = 1'
    ).first<{ cf_webhook_secret: string }>();

    if (!account) {
      return c.json({ error: 'Account not initialized' }, 503);
    }

    const rawBytes = new Uint8Array(await c.req.arrayBuffer());
    const timestampHeader = c.req.header('x-nonepwd-timestamp');
    const signatureHeader = c.req.header('x-nonepwd-signature');

    if (
      !(await verifyWebhookHmac(
        account.cf_webhook_secret,
        timestampHeader,
        signatureHeader,
        rawBytes
      ))
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
        env: c.env,
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
      env: c.env,
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

  // R2 Zero-Knowledge Encrypted Snapshots
  app.get('/api/backups', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;
    const list = await listEncryptedSnapshots(c.env);
    return c.json(list);
  });

  app.post('/api/backups', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;
    if (!c.env.BUCKET) {
      return c.json({ error: 'R2 bucket binding (BUCKET) is not configured' }, 501);
    }
    const backup = await createEncryptedSnapshot(c.env, 'manual');
    return c.json({ backup }, 201);
  });

  app.post('/api/backups/restore', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;
    if (!c.env.BUCKET) {
      return c.json({ error: 'R2 bucket binding (BUCKET) is not configured' }, 501);
    }
    const body = (await c.req.json().catch(() => ({}))) as { key?: string };
    try {
      const result = await restoreEncryptedSnapshot(c.env, body.key || 'backups/latest.json');
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Restore failed' },
        400
      );
    }
  });

  app.delete('/api/backups/:key', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;
    if (!c.env.BUCKET) {
      return c.json({ error: 'R2 bucket binding (BUCKET) is not configured' }, 501);
    }
    const rawKey = decodeURIComponent(c.req.param('key'));
    const fullKey = rawKey.startsWith('backups/') ? rawKey : `backups/${rawKey}`;
    try {
      await deleteEncryptedSnapshot(c.env, fullKey);
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Delete failed' },
        400
      );
    }
  });

  app.delete('/api/backups', async (c) => {
    const ownerOrRes = await requireOwner(c);
    if (ownerOrRes instanceof Response) return ownerOrRes;
    if (!c.env.BUCKET) {
      return c.json({ error: 'R2 bucket binding (BUCKET) is not configured' }, 501);
    }
    const keyParam = c.req.query('key');
    let key = keyParam ? decodeURIComponent(keyParam) : '';
    if (!key) {
      const body = (await c.req.json().catch(() => ({}))) as { key?: string };
      key = body.key ?? '';
    }
    try {
      await deleteEncryptedSnapshot(c.env, key);
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : 'Delete failed' },
        400
      );
    }
  });

  // WebSocket live push via Durable Object
  app.get('/api/ws', async (c) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'Expected WebSocket upgrade' }, 426);
    }
    const token =
      c.req.query('token') ?? extractBearerToken(c.req.header('authorization'));
    const auth = await authenticateToken(c.env.DB, token);
    if (!auth) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!c.env.WS_HUB) {
      return c.json({ error: 'WS_HUB Durable Object not bound' }, 501);
    }

    const headers = new Headers(c.req.raw.headers);
    headers.set('X-NP-Auth-Kind', auth.kind);
    headers.set(
      'X-NP-Allowed-Vaults',
      auth.kind === 'service_account'
        ? JSON.stringify(Array.from(auth.allowedVaultIds))
        : '[]'
    );

    const id = c.env.WS_HUB.idFromName('global');
    const stub = c.env.WS_HUB.get(id);
    return stub.fetch(new Request('https://do.internal/upgrade', { headers }));
  });

  // Native CLI installer script
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
if curl -fsSL "$URL" -o "$PREFIX/np"; then
  chmod 755 "$PREFIX/np"
  echo "Installed nonepwd native CLI -> $PREFIX/np"
  "$PREFIX/np" version
  exit 0
fi

if command -v npm >/dev/null 2>&1; then
  echo "Falling back to npm install -g @nonepwd/cli..."
  npm install -g @nonepwd/cli
  exit 0
fi

echo "Failed downloading $URL and npm is not installed." >&2
exit 1
`;
    return new Response(script, {
      status: 200,
      headers: { 'Content-Type': 'text/x-shellscript; charset=utf-8' },
    });
  });

  // Binary downloads: check R2 bucket first (`downloads/<filename>`), then static ASSETS
  app.get('/downloads/:filename', async (c) => {
    const filename = c.req.param('filename');
    if (!ALLOWED_CLI_BINARIES.has(filename)) {
      return c.json({ error: 'Binary not found' }, 404);
    }

    if (c.env.BUCKET) {
      const r2Obj = await c.env.BUCKET.get(`downloads/${filename}`);
      if (r2Obj) {
        const headers = new Headers();
        r2Obj.writeHttpMetadata(headers);
        if (!headers.has('Content-Type')) {
          headers.set(
            'Content-Type',
            filename.endsWith('.zip') ? 'application/zip' : 'application/octet-stream'
          );
        }
        headers.set('Content-Disposition', `attachment; filename="${filename}"`);
        return new Response(r2Obj.body, { status: 200, headers });
      }
    }

    if (c.env.ASSETS) {
      const assetRes = await c.env.ASSETS.fetch(c.req.raw);
      if (assetRes.ok) return assetRes;
    }

    return c.json({ error: 'Binary artifact not uploaded yet' }, 404);
  });

  // Static Web Vault SPA fallback via ASSETS
  app.all('*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not found' }, 404);
    }
    if (c.env.ASSETS) {
      return c.env.ASSETS.fetch(c.req.raw);
    }
    return c.text('nonepwd Cloudflare Worker server is running.', 200);
  });

  return app;
}

export async function runScheduledMaintenance(env: CfServerEnv): Promise<void> {
  await ensureSchema(env.DB);
  const now = new Date().toISOString();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();

  if (env.BUCKET) {
    const account = await env.DB.prepare('SELECT id FROM account WHERE id = 1').first<{
      id: number;
    }>();
    if (account) {
      await createEncryptedSnapshot(env, 'scheduled');
    }
  }
}
