import type { TotpAlgorithm } from './totp.js';
import type { VaultItemPayload } from './types.js';
import { invokeRust } from './wasm-runtime.js';

export interface TotpImportEntry {
  issuer?: string;
  account?: string;
  secret: string;
  otpauthUri: string;
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
}

export type ImportFormat = 'csv' | 'totp';

export type TotpImportAction =
  | {
      action: 'skip_duplicate';
      existingItemId?: string;
    }
  | {
      action: 'attach';
      itemId: string;
      otpauthUri: string;
    }
  | {
      action: 'create';
      title: string;
      username?: string;
      totp: string;
    };

export type TotpImportPlanItem = {
  entry: TotpImportEntry;
} & TotpImportAction;

/**
 * Parses 2FA authenticator exports via Rust WASM:
 * - One `otpauth://totp/...` URI per line (ignoring blank and `#`/`//` comment lines)
 * - Google Authenticator `otpauth-migration://offline?data=<base64 protobuf>` (multi-entry & multi-line)
 * - Aegis plain JSON, 2FAS JSON, or JSON arrays
 */
export function parseAuthenticatorExport(text: string): TotpImportEntry[] {
  return invokeRust<TotpImportEntry[]>('parse_authenticator_export', { text });
}

/**
 * Auto-detects whether an import file is a password CSV (`'csv'`) or an authenticator export (`'totp'`).
 */
export function detectImportFormat(text: string): ImportFormat {
  return invokeRust<ImportFormat>('detect_import_format', { text });
}

/**
 * Checks whether an item's existing `totp` URI/secret has the same normalized Base32 secret.
 */
export function hasSameTotpSecret(existingTotp: string | undefined, secret: string): boolean {
  return invokeRust<boolean>('has_same_totp_secret', { existingTotp, secret });
}

/**
 * Checks whether an entry's `issuer` matches an item's title or URL registrable domain (case-insensitive).
 */
export function totpIssuerMatchesItem(issuer: string, item: VaultItemPayload): boolean {
  return invokeRust<boolean>('totp_issuer_matches_item', { issuer, item });
}

/**
 * Matches a single `TotpImportEntry` against existing vault items:
 * - Skips (`action: 'skip_duplicate'`) if an item already has the same TOTP secret.
 * - Attaches (`action: 'attach'`) to an existing `login` item whose title/URL registrable domain
 *   matches `issuer` (case-insensitive) and (if `account` is set) `username` equals `account`.
 * - Otherwise creates (`action: 'create'`) a new `login` item `{ title: issuer || account, username: account, totp: otpauthUri }`.
 */
export function totpImportMatch(
  existingItems: VaultItemPayload[],
  entry: TotpImportEntry
): TotpImportAction {
  return invokeRust<TotpImportAction>('totp_import_match', { items: existingItems, entry });
}

/**
 * Plans a full batch of `TotpImportEntry` items against existing items in a target vault,
 * handling duplicate secrets and avoiding double-attachment within the same batch.
 */
export function planTotpImport(
  existingItems: VaultItemPayload[],
  entries: TotpImportEntry[]
): TotpImportPlanItem[] {
  return invokeRust<TotpImportPlanItem[]>('plan_totp_import', { items: existingItems, entries });
}
