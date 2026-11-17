import type { VaultItemPayload } from './types.js';
import { invokeRust } from './wasm-runtime.js';

export interface ParsedSecretRef {
  raw: string;
  vault: string;
  item: string;
  field: string;
  params: Record<string, string>;
}

export function parseSecretRef(uri: string): ParsedSecretRef {
  return invokeRust<ParsedSecretRef>('parse_secret_ref', { uri });
}

export function resolveItemField(item: VaultItemPayload, fieldName: string): string | undefined {
  const res = invokeRust<string | null>('resolve_item_field', { item, field: fieldName });
  return res === null ? undefined : res;
}

/**
 * Replaces both `{{ np://Vault/Item/field }}` and bare `np://Vault/Item/field` tokens
 * inside a configuration template or .env file.
 */
export async function injectSecretRefs(
  template: string,
  resolver: (ref: string) => Promise<string>
): Promise<string> {
  const pattern = /\{\{\s*(np:\/\/[^\s{}]+)\s*\}\}|(np:\/\/[^\s"'`<>|;]+)/g;
  const matches = Array.from(template.matchAll(pattern));
  if (matches.length === 0) return template;

  const cache = new Map<string, string>();
  const uniqueRefs = new Set<string>();
  for (const m of matches) {
    const ref = m[1] ?? m[2];
    if (ref) uniqueRefs.add(ref);
  }

  for (const ref of uniqueRefs) {
    cache.set(ref, await resolver(ref));
  }

  return template.replace(pattern, (_, wrapped?: string, bare?: string) => {
    const ref = wrapped ?? bare ?? '';
    return cache.get(ref) ?? '';
  });
}

export function parseDotEnv(content: string): Record<string, string> {
  return invokeRust<Record<string, string>>('parse_dot_env', { content });
}
