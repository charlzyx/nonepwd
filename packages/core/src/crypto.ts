import {
  fromBase64Url,
  randomBytes,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from './encoding.js';
import {
  DEFAULT_KDF_ITERATIONS,
  type SealedEnvelope,
  type ServiceAccountTokenPayload,
} from './types.js';
import { invokeRust, invokeRustAsync } from './wasm-bridge.js';

export const AAD = {
  ROOT_KEYSET: 'nonepwd:root-keyset:v1',
  vaultMeta(vaultId: string): string {
    return `nonepwd:vault:${vaultId}:meta`;
  },
  vaultOwnerKey(vaultId: string): string {
    return `nonepwd:vault:${vaultId}:owner-key`;
  },
  vaultSaKey(vaultId: string, serviceAccountId: string): string {
    return `nonepwd:vault:${vaultId}:sa:${serviceAccountId}`;
  },
  vaultItem(vaultId: string, itemId: string): string {
    return `nonepwd:vault:${vaultId}:item:${itemId}`;
  },
};

export interface DerivedAccountKeys {
  masterUnlockKeyBytes: Uint8Array;
  authVerifierB64: string;
}

export async function deriveAccountKeys(
  masterPassword: string,
  secretKey: string,
  kdfSaltB64: string,
  iterations: number = DEFAULT_KDF_ITERATIONS
): Promise<DerivedAccountKeys> {
  const res = await invokeRustAsync<{
    masterUnlockKeyB64: string;
    authVerifierB64: string;
  }>('derive_account_keys', {
    masterPassword,
    secretKey,
    kdfSaltB64,
    iterations,
  });

  return {
    masterUnlockKeyBytes: fromBase64Url(res.masterUnlockKeyB64),
    authVerifierB64: res.authVerifierB64,
  };
}

export function generateRawAesKey(): Uint8Array {
  return randomBytes(32);
}

export async function encryptBytes(
  rawKey32: Uint8Array,
  plaintext: Uint8Array,
  aad?: string
): Promise<string> {
  return invokeRustAsync<string>('encrypt_bytes', {
    keyB64: toBase64Url(rawKey32),
    plaintextB64: toBase64Url(plaintext),
    aad,
  });
}

export async function decryptBytes(
  rawKey32: Uint8Array,
  blob: string,
  aad?: string
): Promise<Uint8Array> {
  const b64 = await invokeRustAsync<string>('decrypt_bytes', {
    keyB64: toBase64Url(rawKey32),
    blob,
    aad,
  });
  return fromBase64Url(b64);
}

export async function encryptJson<T>(rawKey32: Uint8Array, data: T, aad?: string): Promise<string> {
  return encryptBytes(rawKey32, utf8Encode(JSON.stringify(data)), aad);
}

export async function decryptJson<T>(rawKey32: Uint8Array, blob: string, aad?: string): Promise<T> {
  const bytes = await decryptBytes(rawKey32, blob, aad);
  return JSON.parse(utf8Decode(bytes)) as T;
}

export interface EmailKeyPair {
  publicKeyB64: string;
  privateKeyPkcs8B64: string;
}

export async function generateEmailKeyPair(): Promise<EmailKeyPair> {
  return invokeRustAsync<EmailKeyPair>('generate_email_key_pair');
}

export async function sealForPublicKey(
  recipientPublicKeyB64: string,
  plaintext: Uint8Array,
  info: string = 'nonepwd-email-v1'
): Promise<SealedEnvelope> {
  return invokeRustAsync<SealedEnvelope>('seal_for_public_key', {
    publicKeyB64: recipientPublicKeyB64,
    plaintextB64: toBase64Url(plaintext),
    info,
  });
}

export async function openSealedEnvelope(
  recipientPrivateKeyPkcs8B64: string,
  envelope: SealedEnvelope,
  info: string = 'nonepwd-email-v1'
): Promise<Uint8Array> {
  const b64 = await invokeRustAsync<string>('open_sealed_envelope', {
    privateKeyPkcs8B64: recipientPrivateKeyPkcs8B64,
    envelope,
    info,
  });
  return fromBase64Url(b64);
}

export async function sealJsonForPublicKey<T>(
  recipientPublicKeyB64: string,
  data: T,
  info: string = 'nonepwd-email-v1'
): Promise<SealedEnvelope> {
  return sealForPublicKey(recipientPublicKeyB64, utf8Encode(JSON.stringify(data)), info);
}

export async function openSealedJson<T>(
  recipientPrivateKeyPkcs8B64: string,
  envelope: SealedEnvelope,
  info: string = 'nonepwd-email-v1'
): Promise<T> {
  const bytes = await openSealedEnvelope(recipientPrivateKeyPkcs8B64, envelope, info);
  return JSON.parse(utf8Decode(bytes)) as T;
}

export function encodeServiceAccountToken(payload: ServiceAccountTokenPayload): string {
  return invokeRust<string>('encode_service_account_token', { payload });
}

export function decodeServiceAccountToken(token: string): ServiceAccountTokenPayload {
  return invokeRust<ServiceAccountTokenPayload>('decode_service_account_token', { token });
}
