import { randomHex } from './auth.js';
import { bumpSyncEpoch } from './sync-delta.js';
import type { CfServerEnv, R2BackupMeta } from './types.js';
import { broadcastEvent } from './ws-hub.js';

const MAX_SCHEDULED_SNAPSHOTS = 30;

interface SnapshotAccountRow {
  id: number;
  email: string;
  kdf_salt: string;
  kdf_iterations: number;
  auth_verifier_hash: string;
  encrypted_root_keyset: string;
  email_public_key: string;
  cf_webhook_secret: string;
  alias_domain: string;
  created_at: string;
}

interface SnapshotVaultRow {
  id: string;
  encrypted_key: string;
  encrypted_meta: string;
  created_at: string;
  updated_at: string;
}

interface SnapshotItemRow {
  id: string;
  vault_id: string;
  encrypted_data: string;
  created_at: string;
  updated_at: string;
  version: number;
}

interface SnapshotAliasRow {
  id: string;
  address: string;
  site_domain: string | null;
  vault_id: string | null;
  item_id: string | null;
  enabled: number;
  received_count: number;
  created_at: string;
}

interface SnapshotServiceAccountRow {
  id: string;
  name: string;
  auth_secret_hash: string;
  created_at: string;
  last_used_at: string | null;
}

interface SnapshotServiceAccountVaultRow {
  service_account_id: string;
  vault_id: string;
  encrypted_vault_key: string;
}

interface SnapshotEmailFilterRow {
  id: number;
  config_json: string;
  updated_at: string;
}

interface SnapshotEmailRow {
  id: string;
  source: string;
  envelope_to: string | null;
  has_otp: number;
  sealed_envelope: string;
  received_at: string;
}

export interface EncryptedVaultSnapshot {
  version: 1;
  createdAt: string;
  reason: 'manual' | 'scheduled';
  account: SnapshotAccountRow | null;
  vaults: SnapshotVaultRow[];
  items: SnapshotItemRow[];
  aliases: SnapshotAliasRow[];
  serviceAccounts: SnapshotServiceAccountRow[];
  serviceAccountVaults: SnapshotServiceAccountVaultRow[];
  emailFilter: SnapshotEmailFilterRow | null;
  encryptedEmails: SnapshotEmailRow[];
}

export async function createEncryptedSnapshot(
  env: CfServerEnv,
  reason: 'manual' | 'scheduled' = 'manual'
): Promise<R2BackupMeta> {
  if (!env.BUCKET) {
    throw new Error('R2 bucket binding (BUCKET) is not configured');
  }

  const [
    account,
    vaultsRes,
    itemsRes,
    aliasesRes,
    saRes,
    saVaultsRes,
    filterRow,
    emailsRes,
  ] = await Promise.all([
    env.DB.prepare('SELECT * FROM account WHERE id = 1').first<SnapshotAccountRow>(),
    env.DB.prepare('SELECT * FROM vaults ORDER BY created_at ASC').all<SnapshotVaultRow>(),
    env.DB.prepare('SELECT * FROM items ORDER BY updated_at DESC').all<SnapshotItemRow>(),
    env.DB.prepare('SELECT * FROM aliases ORDER BY created_at DESC').all<SnapshotAliasRow>(),
    env.DB.prepare('SELECT * FROM service_accounts ORDER BY created_at DESC').all<SnapshotServiceAccountRow>(),
    env.DB.prepare('SELECT * FROM service_account_vaults').all<SnapshotServiceAccountVaultRow>(),
    env.DB.prepare('SELECT * FROM email_filter WHERE id = 1').first<SnapshotEmailFilterRow>(),
    env.DB.prepare('SELECT * FROM encrypted_emails ORDER BY received_at DESC LIMIT 200').all<SnapshotEmailRow>(),
  ]);

  const createdAt = new Date().toISOString();
  const vaults = vaultsRes.results ?? [];
  const items = itemsRes.results ?? [];
  const encryptedEmails = emailsRes.results ?? [];

  const snapshot: EncryptedVaultSnapshot = {
    version: 1,
    createdAt,
    reason,
    account: account ?? null,
    vaults,
    items,
    aliases: aliasesRes.results ?? [],
    serviceAccounts: saRes.results ?? [],
    serviceAccountVaults: saVaultsRes.results ?? [],
    emailFilter: filterRow ?? null,
    encryptedEmails,
  };

  const payload = JSON.stringify(snapshot);
  const isoSafe = createdAt.replace(/[:.]/g, '-');
  const key = `backups/snapshot-${isoSafe}-${reason}-${randomHex(3)}.json`;

  const customMetadata: Record<string, string> = {
    reason,
    createdAt,
    vaultCount: String(vaults.length),
    itemCount: String(items.length),
    emailCount: String(encryptedEmails.length),
  };

  await Promise.all([
    env.BUCKET.put(key, payload, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata,
    }),
    env.BUCKET.put('backups/latest.json', payload, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata,
    }),
  ]);

  if (reason === 'scheduled') {
    const listed = await env.BUCKET.list({ prefix: 'backups/snapshot-', limit: 200 });
    const sorted = [...listed.objects].sort((a, b) => b.key.localeCompare(a.key));
    const stale = sorted.slice(MAX_SCHEDULED_SNAPSHOTS);
    if (stale.length > 0) {
      await Promise.all(stale.map((obj) => env.BUCKET!.delete(obj.key)));
    }
  }

  return {
    key,
    size: new TextEncoder().encode(payload).byteLength,
    uploadedAt: createdAt,
    reason,
    vaultCount: vaults.length,
    itemCount: items.length,
    emailCount: encryptedEmails.length,
  };
}

export async function listEncryptedSnapshots(env: CfServerEnv): Promise<{
  enabled: boolean;
  backups: R2BackupMeta[];
}> {
  if (!env.BUCKET) {
    return { enabled: false, backups: [] };
  }

  const listed = await env.BUCKET.list({
    prefix: 'backups/snapshot-',
    include: ['customMetadata'],
    limit: 100,
  } as R2ListOptions);

  const backups = [...listed.objects]
    .sort((a, b) => b.key.localeCompare(a.key))
    .map((obj): R2BackupMeta => {
      const meta = obj.customMetadata ?? {};
      const parseCount = (val?: string): number | null => {
        if (val === undefined) return null;
        const n = Number.parseInt(val, 10);
        return Number.isFinite(n) ? n : null;
      };
      return {
        key: obj.key,
        size: obj.size,
        uploadedAt: meta.createdAt || obj.uploaded.toISOString(),
        reason: meta.reason || 'manual',
        vaultCount: parseCount(meta.vaultCount),
        itemCount: parseCount(meta.itemCount),
        emailCount: parseCount(meta.emailCount),
      };
    });

  return { enabled: true, backups };
}

export async function restoreEncryptedSnapshot(
  env: CfServerEnv,
  key: string = 'backups/latest.json'
): Promise<{
  restored: boolean;
  key: string;
  vaultCount: number;
  itemCount: number;
  emailCount: number;
}> {
  if (!env.BUCKET) {
    throw new Error('R2 bucket binding (BUCKET) is not configured');
  }
  const normalizedKey = key.trim() || 'backups/latest.json';
  if (!normalizedKey.startsWith('backups/')) {
    throw new Error('Invalid backup key');
  }

  const obj = await env.BUCKET.get(normalizedKey);
  if (!obj) {
    throw new Error(`Backup snapshot not found: ${normalizedKey}`);
  }

  const snapshot = (await obj.json()) as Partial<EncryptedVaultSnapshot>;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.vaults) || !Array.isArray(snapshot.items)) {
    throw new Error('Invalid zero-knowledge snapshot format');
  }

  // Delete child rows before parent rows, then re-insert parent-first inside one D1 batch transaction
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('DELETE FROM items'),
    env.DB.prepare('DELETE FROM service_account_vaults'),
    env.DB.prepare('DELETE FROM service_accounts'),
    env.DB.prepare('DELETE FROM vaults'),
    env.DB.prepare('DELETE FROM aliases'),
    env.DB.prepare('DELETE FROM encrypted_emails'),
  ];

  if (snapshot.account) {
    const a = snapshot.account;
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO account
         (id, email, kdf_salt, kdf_iterations, auth_verifier_hash, encrypted_root_keyset, email_public_key, cf_webhook_secret, alias_domain, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        a.email,
        a.kdf_salt,
        a.kdf_iterations,
        a.auth_verifier_hash,
        a.encrypted_root_keyset,
        a.email_public_key,
        a.cf_webhook_secret,
        a.alias_domain ?? '',
        a.created_at
      )
    );
  }

  for (const v of snapshot.vaults) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO vaults (id, encrypted_key, encrypted_meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(v.id, v.encrypted_key, v.encrypted_meta, v.created_at, v.updated_at)
    );
  }

  for (const item of snapshot.items) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO items (id, vault_id, encrypted_data, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        item.id,
        item.vault_id,
        item.encrypted_data,
        item.created_at,
        item.updated_at,
        item.version ?? 1
      )
    );
  }

  for (const sa of snapshot.serviceAccounts ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO service_accounts (id, name, auth_secret_hash, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(sa.id, sa.name, sa.auth_secret_hash, sa.created_at, sa.last_used_at ?? null)
    );
  }

  for (const sav of snapshot.serviceAccountVaults ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO service_account_vaults (service_account_id, vault_id, encrypted_vault_key)
         VALUES (?, ?, ?)`
      ).bind(sav.service_account_id, sav.vault_id, sav.encrypted_vault_key)
    );
  }

  for (const alias of snapshot.aliases ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO aliases (id, address, site_domain, vault_id, item_id, enabled, received_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        alias.id,
        alias.address,
        alias.site_domain ?? null,
        alias.vault_id ?? null,
        alias.item_id ?? null,
        alias.enabled ?? 1,
        alias.received_count ?? 0,
        alias.created_at
      )
    );
  }

  for (const em of snapshot.encryptedEmails ?? []) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO encrypted_emails (id, source, envelope_to, has_otp, sealed_envelope, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        em.id,
        em.source,
        em.envelope_to ?? null,
        em.has_otp ?? 0,
        em.sealed_envelope,
        em.received_at
      )
    );
  }

  if (snapshot.emailFilter?.config_json) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO email_filter (id, config_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`
      ).bind(
        snapshot.emailFilter.config_json,
        snapshot.emailFilter.updated_at || new Date().toISOString()
      )
    );
  }

  await env.DB.batch(stmts);
  await bumpSyncEpoch(env.DB);
  await broadcastEvent(env, { type: 'vault.restored', key: normalizedKey }, { ownerOnly: true });

  return {
    restored: true,
    key: normalizedKey,
    vaultCount: snapshot.vaults.length,
    itemCount: snapshot.items.length,
    emailCount: snapshot.encryptedEmails?.length ?? 0,
  };
}

export async function deleteEncryptedSnapshot(env: CfServerEnv, key: string): Promise<void> {
  if (!env.BUCKET) {
    throw new Error('R2 bucket binding (BUCKET) is not configured');
  }
  const normalizedKey = key.trim();
  if (!normalizedKey.startsWith('backups/')) {
    throw new Error('Invalid backup key');
  }
  await env.BUCKET.delete(normalizedKey);
}

/**
 * Background auto-snapshot helper triggered via `executionCtx.waitUntil`
 * so R2 zero-knowledge snapshots happen every 6h on activity even when all
 * Free-tier Cron Trigger slots are occupied on an account.
 */
export async function maybeAutoSnapshot(
  env: CfServerEnv,
  minIntervalMs: number = 6 * 60 * 60 * 1000
): Promise<void> {
  if (!env.BUCKET) return;
  try {
    const latest = await env.BUCKET.head('backups/latest.json');
    if (latest && Date.now() - latest.uploaded.getTime() < minIntervalMs) {
      return;
    }
    const account = await env.DB.prepare('SELECT id FROM account WHERE id = 1').first<{
      id: number;
    }>();
    if (!account) return;
    await createEncryptedSnapshot(env, 'scheduled');
  } catch {
    // Non-fatal background snapshot; never interrupt primary API responses
  }
}
