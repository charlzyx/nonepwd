import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { CfServerEnv } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(__dirname, '..');

export function loadCompiledWasmModule(): WebAssembly.Module {
  const candidates = [
    path.join(pkgDir, 'src', 'nonepwd_core.wasm'),
    path.join(pkgDir, 'dist', 'nonepwd_core.wasm'),
    path.resolve(pkgDir, '..', '..', 'target', 'wasm32-unknown-unknown', 'release', 'nonepwd_core.wasm'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return new WebAssembly.Module(fs.readFileSync(p));
    }
  }
  throw new Error('Could not find nonepwd_core.wasm for cf-server tests');
}

type BindParam = string | number | bigint | Uint8Array | null;

function normalizeParams(values: unknown[]): BindParam[] {
  return values.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
    if (v instanceof Uint8Array) return v;
    return String(v);
  });
}

class MockD1PreparedStatement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly params: BindParam[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new MockD1PreparedStatement(
      this.sqlite,
      this.sql,
      normalizeParams(values)
    ) as unknown as D1PreparedStatement;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.sqlite.prepare(this.sql);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName !== undefined) {
      return (row[colName] as T) ?? null;
    }
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.sqlite.prepare(this.sql);
    const results = stmt.all(...this.params) as T[];
    return {
      results,
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: results.length,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.sqlite.prepare(this.sql);
    const trimmed = this.sql.trimStart().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
      const results = stmt.all(...this.params) as T[];
      return {
        results,
        success: true,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: results.length,
          rows_written: 0,
          last_row_id: 0,
          changed_db: false,
          changes: 0,
        },
      };
    }
    const res = stmt.run(...this.params);
    return {
      results: [],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: Number(res.changes ?? 0),
        last_row_id: Number(res.lastInsertRowid ?? 0),
        changed_db: Number(res.changes ?? 0) > 0,
        changes: Number(res.changes ?? 0),
      },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const all = await this.all<Record<string, unknown>>();
    return all.results.map((r) => Object.values(r)) as T[];
  }

  _executeSync(): D1Result<unknown> {
    const stmt = this.sqlite.prepare(this.sql);
    const trimmed = this.sql.trimStart().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
      const results = stmt.all(...this.params);
      return {
        results,
        success: true,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: results.length,
          rows_written: 0,
          last_row_id: 0,
          changed_db: false,
          changes: 0,
        },
      };
    }
    const res = stmt.run(...this.params);
    return {
      results: [],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: Number(res.changes ?? 0),
        last_row_id: Number(res.lastInsertRowid ?? 0),
        changed_db: Number(res.changes ?? 0) > 0,
        changes: Number(res.changes ?? 0),
      },
    };
  }
}

export function createMockD1Database(): D1Database {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  const db = {
    prepare(query: string): D1PreparedStatement {
      return new MockD1PreparedStatement(sqlite, query) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results: D1Result<T>[] = [];
        for (const s of statements) {
          results.push((s as unknown as MockD1PreparedStatement)._executeSync() as D1Result<T>);
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (err) {
        try {
          sqlite.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw err;
      }
    },
    async exec(query: string): Promise<D1ExecResult> {
      sqlite.exec(query);
      return { count: 1, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
  };

  return db as unknown as D1Database;
}

interface StoredR2Entry {
  key: string;
  data: Uint8Array;
  uploaded: Date;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

async function toBytes(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob
): Promise<Uint8Array> {
  if (value === null) return new Uint8Array(0);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  const reader = (value as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    if (chunk) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return merged;
}

export function createMockR2Bucket(): R2Bucket & { keys(): string[] } {
  const store = new Map<string, StoredR2Entry>();

  const makeMeta = (entry: StoredR2Entry, includeCustom = true): R2Object =>
    ({
      key: entry.key,
      version: '1',
      size: entry.data.byteLength,
      etag: 'mock-etag',
      httpEtag: '"mock-etag"',
      uploaded: entry.uploaded,
      httpMetadata: entry.httpMetadata,
      customMetadata: includeCustom ? entry.customMetadata : undefined,
      checksums: { toJSON: () => ({}) },
      storageClass: 'Standard',
      writeHttpMetadata(headers: Headers) {
        if (entry.httpMetadata?.contentType) {
          headers.set('Content-Type', entry.httpMetadata.contentType);
        }
      },
    }) as unknown as R2Object;

  const bucket = {
    keys(): string[] {
      return Array.from(store.keys()).sort();
    },
    async head(key: string): Promise<R2Object | null> {
      const entry = store.get(key);
      return entry ? makeMeta(entry) : null;
    },
    async get(key: string): Promise<R2ObjectBody | null> {
      const entry = store.get(key);
      if (!entry) return null;
      const meta = makeMeta(entry);
      return {
        ...meta,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(entry.data);
            controller.close();
          },
        }),
        bodyUsed: false,
        async arrayBuffer() {
          return entry.data.buffer.slice(
            entry.data.byteOffset,
            entry.data.byteOffset + entry.data.byteLength
          ) as ArrayBuffer;
        },
        async bytes() {
          return entry.data;
        },
        async text() {
          return new TextDecoder().decode(entry.data);
        },
        async json<T = unknown>() {
          return JSON.parse(new TextDecoder().decode(entry.data)) as T;
        },
        async blob() {
          return new Blob([entry.data as unknown as BlobPart]);
        },
      } as unknown as R2ObjectBody;
    },
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
      options?: R2PutOptions
    ): Promise<R2Object> {
      const data = await toBytes(value);
      const entry: StoredR2Entry = {
        key,
        data,
        uploaded: new Date(),
        httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined,
        customMetadata: options?.customMetadata,
      };
      store.set(key, entry);
      return makeMeta(entry);
    },
    async delete(keys: string | string[]): Promise<void> {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) store.delete(k);
    },
    async list(options?: R2ListOptions & { include?: string[] }): Promise<R2Objects> {
      const prefix = options?.prefix ?? '';
      const limit = options?.limit ?? 1000;
      const includeCustom = Boolean(options?.include?.includes('customMetadata'));
      const matched = Array.from(store.values())
        .filter((e) => e.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key))
        .slice(0, limit)
        .map((e) => makeMeta(e, includeCustom));
      return {
        objects: matched,
        truncated: false,
        delimitedPrefixes: [],
      };
    },
  };

  return bucket as unknown as R2Bucket & { keys(): string[] };
}

export interface RecordedBroadcast {
  event: Record<string, unknown>;
  options?: { vaultId?: string; ownerOnly?: boolean };
}

export function createMockWsHubNamespace(): {
  namespace: DurableObjectNamespace;
  broadcasts: RecordedBroadcast[];
} {
  const broadcasts: RecordedBroadcast[] = [];
  const namespace = {
    idFromName(name: string) {
      return { toString: () => name, equals: (o: DurableObjectId) => o.toString() === name };
    },
    idFromString(hex: string) {
      return { toString: () => hex, equals: (o: DurableObjectId) => o.toString() === hex };
    },
    newUniqueId() {
      return { toString: () => 'unique', equals: () => false };
    },
    jurisdiction() {
      return namespace;
    },
    get() {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
          if (url.pathname === '/broadcast' && init?.body) {
            const payload = JSON.parse(String(init.body)) as RecordedBroadcast;
            broadcasts.push(payload);
            return Response.json({ delivered: 1 });
          }
          return Response.json({ ok: true });
        },
      };
    },
  };

  return {
    namespace: namespace as unknown as DurableObjectNamespace,
    broadcasts,
  };
}

export function createMockCfEnv(): {
  env: CfServerEnv;
  bucket: R2Bucket & { keys(): string[] };
  broadcasts: RecordedBroadcast[];
} {
  const db = createMockD1Database();
  const bucket = createMockR2Bucket();
  const { namespace, broadcasts } = createMockWsHubNamespace();
  return {
    env: {
      DB: db,
      BUCKET: bucket,
      WS_HUB: namespace,
    },
    bucket,
    broadcasts,
  };
}
