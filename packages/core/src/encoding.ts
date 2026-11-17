import { invokeRust } from './wasm-runtime.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Return an exact ArrayBuffer slice for a Uint8Array so WebCrypto BufferSource
 * typechecks strictly under TypeScript 5.7+ without subarray leaks.
 */
export function asBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromBase64Url(input: string): Uint8Array {
  const normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLength);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function randomBytes(length: number): Uint8Array {
  return fromBase64Url(invokeRust<string>('random_bytes', { len: length }));
}

export function randomId(): string {
  return invokeRust<string>('random_id');
}

export function randomInt(maxExclusive: number): number {
  return invokeRust<number>('random_int', { max: maxExclusive });
}

export function toBase32(bytes: Uint8Array): string {
  return invokeRust<string>('to_base32', { bytesB64: toBase64Url(bytes) });
}

export function fromBase32(input: string): Uint8Array {
  return fromBase64Url(invokeRust<string>('from_base32', { input }));
}

export function generateSecretKey(): string {
  return invokeRust<string>('generate_secret_key');
}

export function normalizeSecretKey(secretKey: string): string {
  return invokeRust<string>('normalize_secret_key', { secretKey });
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return invokeRust<boolean>('constant_time_eq', {
    aB64: toBase64Url(a),
    bB64: toBase64Url(b),
  });
}
