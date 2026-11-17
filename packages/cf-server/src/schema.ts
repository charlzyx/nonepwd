const initializedDbs = new WeakSet<object>();
const inflightInits = new WeakMap<object, Promise<void>>();

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    email TEXT NOT NULL,
    kdf_salt TEXT NOT NULL,
    kdf_iterations INTEGER NOT NULL,
    auth_verifier_hash TEXT NOT NULL,
    encrypted_root_keyset TEXT NOT NULL,
    email_public_key TEXT NOT NULL,
    cf_webhook_secret TEXT NOT NULL,
    alias_domain TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    service_account_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vaults (
    id TEXT PRIMARY KEY,
    encrypted_key TEXT NOT NULL,
    encrypted_meta TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    encrypted_data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS idx_items_vault_id ON items(vault_id)`,
  `CREATE TABLE IF NOT EXISTS service_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    auth_secret_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS service_account_vaults (
    service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    encrypted_vault_key TEXT NOT NULL,
    PRIMARY KEY (service_account_id, vault_id)
  )`,
  `CREATE TABLE IF NOT EXISTS aliases (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    site_domain TEXT,
    vault_id TEXT,
    item_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    received_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS encrypted_emails (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    envelope_to TEXT,
    has_otp INTEGER NOT NULL DEFAULT 0,
    sealed_envelope TEXT NOT NULL,
    received_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_emails_received_at ON encrypted_emails(received_at DESC)`,
  `CREATE TABLE IF NOT EXISTS email_filter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS imap_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    host TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 993,
    tls INTEGER NOT NULL DEFAULT 1,
    username TEXT NOT NULL DEFAULT '',
    password_enc TEXT NOT NULL DEFAULT '',
    last_uid INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'disabled',
    last_error TEXT,
    last_sync_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS imap_accounts (
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
  )`,
];

export function deriveImapLabel(username: string): string {
  const trimmed = username.trim();
  if (!trimmed) return '';
  const at = trimmed.indexOf('@');
  return at > 0 ? trimmed.slice(0, at) : trimmed;
}

export async function ensureLegacyImapMigrated(db: D1Database): Promise<void> {
  const countRow = await db
    .prepare('SELECT COUNT(*) AS cnt FROM imap_accounts')
    .first<{ cnt: number }>();
  if (Number(countRow?.cnt ?? 0) > 0) return;

  const legacy = await db
    .prepare(
      `SELECT enabled, host, port, tls, username, password_enc, last_uid, status, last_error, last_sync_at, updated_at
       FROM imap_config WHERE id = 1`
    )
    .first<{
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
    }>();

  if (!legacy || !legacy.host.trim() || !legacy.username.trim()) return;

  const enabled = legacy.enabled === 1 ? 1 : 0;
  const status =
    enabled === 1
      ? legacy.status === 'connecting' || legacy.status === 'listening' || legacy.status === 'error'
        ? legacy.status
        : 'listening'
      : 'disabled';
  const label = deriveImapLabel(legacy.username);
  const updatedAt = legacy.updated_at || new Date().toISOString();

  await db
    .prepare(
      `INSERT OR IGNORE INTO imap_accounts
       (id, label, enabled, host, port, tls, username, password_enc, last_uid, status, last_error, last_sync_at, updated_at)
       VALUES ('legacy-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      label,
      enabled,
      legacy.host.trim(),
      legacy.port || 993,
      legacy.tls === 1 ? 1 : 0,
      legacy.username.trim(),
      legacy.password_enc ?? '',
      legacy.last_uid ?? 0,
      status,
      legacy.last_error ?? null,
      legacy.last_sync_at ?? null,
      updatedAt
    )
    .run();
}

export async function ensureSchema(db: D1Database): Promise<void> {
  if (initializedDbs.has(db)) return;

  const existingPromise = inflightInits.get(db);
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const initPromise = (async () => {
    const now = new Date().toISOString();
    const stmts = SCHEMA_STATEMENTS.map((sql) => db.prepare(sql));
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO email_filter (id, config_json, updated_at)
           VALUES (1, ?, ?)`
        )
        .bind(
          '{"enabled":false,"otpOnly":false,"mode":"allow","rules":[]}',
          now
        ),
      db
        .prepare(
          `INSERT OR IGNORE INTO imap_config
           (id, enabled, host, port, tls, username, password_enc, last_uid, status, updated_at)
           VALUES (1, 0, '', 993, 1, '', '', 0, 'disabled', ?)`
        )
        .bind(now)
    );
    await db.batch(stmts);
    await ensureLegacyImapMigrated(db);
    initializedDbs.add(db);
  })();

  inflightInits.set(db, initPromise);
  try {
    await initPromise;
  } finally {
    inflightInits.delete(db);
  }
}
