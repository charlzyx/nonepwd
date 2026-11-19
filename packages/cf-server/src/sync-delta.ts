/**
 * Incremental /api/sync bookkeeping.
 *
 * Clients that send `since` plus the `epoch` they last observed receive only
 * rows changed after that cursor, plus deletions. A restore bumps the epoch so
 * those clients fall back to a full snapshot. Clients that omit `since` still
 * receive the full payload.
 */

export const SYNC_DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type SyncEntity = 'vault' | 'item' | 'alias' | 'email';

export interface SyncDeletionSets {
  vaults: string[];
  items: string[];
  aliases: string[];
  emails: string[];
}

export function emptySyncDeletions(): SyncDeletionSets {
  return { vaults: [], items: [], aliases: [], emails: [] };
}

/** Returns a canonical ISO cursor, or null when the client should take a full snapshot. */
export function parseSyncSince(raw: string | undefined | null, nowMs: number = Date.now()): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  if (ms > nowMs + 5 * 60 * 1000) return null;
  if (nowMs - ms > SYNC_DELETION_RETENTION_MS) return null;
  return new Date(ms).toISOString();
}

export function parseSyncEpoch(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export async function readSyncEpoch(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT epoch FROM sync_state WHERE id = 1').first<{ epoch: number }>();
  return Number(row?.epoch ?? 1) || 1;
}

export async function bumpSyncEpoch(db: D1Database): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_state (id, epoch) VALUES (1, 2)
       ON CONFLICT(id) DO UPDATE SET epoch = epoch + 1`
    )
    .run();
}

export function syncDeletionStatement(
  db: D1Database,
  entity: SyncEntity,
  entityId: string,
  deletedAt: string,
  vaultId?: string | null
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sync_deletions (entity, entity_id, vault_id, deleted_at)
       VALUES (?, ?, ?, ?)`
    )
    .bind(entity, entityId, vaultId ?? null, deletedAt);
}

export async function recordSyncDeletion(
  db: D1Database,
  entity: SyncEntity,
  entityId: string,
  deletedAt: string,
  vaultId?: string | null
): Promise<void> {
  await syncDeletionStatement(db, entity, entityId, deletedAt, vaultId).run();
}

export async function querySyncDeletions(
  db: D1Database,
  since: string,
  scope?: { vaultIds: ReadonlySet<string> }
): Promise<SyncDeletionSets> {
  const res = await db
    .prepare(
      `SELECT entity, entity_id, vault_id
       FROM sync_deletions
       WHERE deleted_at > ?`
    )
    .bind(since)
    .all<{ entity: string; entity_id: string; vault_id: string | null }>();

  const out = emptySyncDeletions();
  for (const row of res.results ?? []) {
    if (scope && (row.entity === 'alias' || row.entity === 'email')) continue;
    if (scope && (row.entity === 'item' || row.entity === 'vault')) {
      const vaultId = row.entity === 'vault' ? row.entity_id : row.vault_id;
      if (!vaultId || !scope.vaultIds.has(vaultId)) continue;
    }
    if (row.entity === 'vault') out.vaults.push(row.entity_id);
    else if (row.entity === 'item') out.items.push(row.entity_id);
    else if (row.entity === 'alias') out.aliases.push(row.entity_id);
    else if (row.entity === 'email') out.emails.push(row.entity_id);
  }
  return out;
}

export async function pruneSyncDeletions(db: D1Database, nowMs: number = Date.now()): Promise<void> {
  const cutoff = new Date(nowMs - SYNC_DELETION_RETENTION_MS).toISOString();
  await db.prepare('DELETE FROM sync_deletions WHERE deleted_at < ?').bind(cutoff).run();
}
