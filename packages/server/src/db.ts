import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export interface NonePwdDb {
  sqlite: DatabaseSync;
  dataDir: string;
  encryptLocalSecret(plaintext: string): string;
  decryptLocalSecret(ciphertext: string): string;
  close(): void;
}

function loadOrCreateServerKey(dataDir: string): Buffer {
  const keyPath = path.join(dataDir, '.server_key');
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64url');
    if (buf.length === 32) return buf;
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, generated.toString('base64url'), { mode: 0o600 });
  return generated;
}

export function openNonePwdDb(dataDir: string): NonePwdDb {
  fs.mkdirSync(dataDir, { recursive: true });
  const serverKey = loadOrCreateServerKey(dataDir);
  const dbPath = path.join(dataDir, 'nonepwd.db');
  const sqlite = new DatabaseSync(dbPath);

  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS account (
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
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      service_account_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY,
      encrypted_key TEXT NOT NULL,
      encrypted_meta TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      encrypted_data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_items_vault_id ON items(vault_id);

    CREATE TABLE IF NOT EXISTS service_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      auth_secret_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS service_account_vaults (
      service_account_id TEXT NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      encrypted_vault_key TEXT NOT NULL,
      PRIMARY KEY (service_account_id, vault_id)
    );

    CREATE TABLE IF NOT EXISTS aliases (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      site_domain TEXT,
      vault_id TEXT,
      item_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      received_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS encrypted_emails (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      envelope_to TEXT,
      has_otp INTEGER NOT NULL DEFAULT 0,
      sealed_envelope TEXT NOT NULL,
      received_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_emails_received_at ON encrypted_emails(received_at DESC);

    CREATE TABLE IF NOT EXISTS imap_config (
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
      updated_at TEXT NOT NULL
    );
  `);

  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO imap_config (id, enabled, host, port, tls, username, password_enc, last_uid, status, last_error, updated_at)
       VALUES (1, 0, '', 993, 1, '', '', 0, 'disabled', NULL, ?)`
    )
    .run(now);

  return {
    sqlite,
    dataDir,
    encryptLocalSecret(plaintext: string): string {
      if (!plaintext) return '';
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', serverKey, iv);
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `s1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
    },
    decryptLocalSecret(blob: string): string {
      if (!blob) return '';
      try {
        const parts = blob.split('.');
        if (parts.length !== 4 || parts[0] !== 's1') return '';
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[2], 'base64url');
        const enc = Buffer.from(parts[3], 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', serverKey, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
      } catch {
        return '';
      }
    },
    close(): void {
      sqlite.close();
    },
  };
}
