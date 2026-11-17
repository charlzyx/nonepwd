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
];

export async function ensureSchema(db: D1Database): Promise<void> {
  if (initializedDbs.has(db)) return;

  const existingPromise = inflightInits.get(db);
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const initPromise = (async () => {
    const stmts = SCHEMA_STATEMENTS.map((sql) => db.prepare(sql));
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO email_filter (id, config_json, updated_at)
           VALUES (1, ?, ?)`
        )
        .bind(
          '{"enabled":false,"otpOnly":false,"mode":"allow","rules":[]}',
          new Date().toISOString()
        )
    );
    await db.batch(stmts);
    initializedDbs.add(db);
  })();

  inflightInits.set(db, initPromise);
  try {
    await initPromise;
  } finally {
    inflightInits.delete(db);
  }
}
