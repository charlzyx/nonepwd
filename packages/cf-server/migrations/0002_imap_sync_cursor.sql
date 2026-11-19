-- Applied automatically by ensureSchema on Worker startup.
-- Safe to run once against a database created by 0001_init.sql.

ALTER TABLE imap_accounts ADD COLUMN sync_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imap_accounts ADD COLUMN uid_baselined INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sync_deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  vault_id TEXT,
  deleted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_deletions_deleted_at ON sync_deletions(deleted_at);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO sync_state (id, epoch) VALUES (1, 1);
