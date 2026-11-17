import { invokeRust } from './wasm-bridge.js';
import type { ItemCategory } from './types.js';

export interface CsvImportedEntry {
  category: ItemCategory;
  title: string;
  urls: string[];
  username?: string;
  password?: string;
  totp?: string;
  notes?: string;
}

export function parsePasswordCsv(csvText: string): CsvImportedEntry[] {
  return invokeRust<CsvImportedEntry[]>('parse_password_csv', { csvText });
}

export function itemImportFingerprint(entry: {
  urls?: string[];
  username?: string;
  password?: string;
}): string {
  const firstUrl = (entry.urls?.[0] ?? '').trim().replace(/\/+$/, '').toLowerCase();
  const user = (entry.username ?? '').trim();
  const pass = entry.password ?? '';
  return `${firstUrl}\u0000${user}\u0000${pass}`;
}
