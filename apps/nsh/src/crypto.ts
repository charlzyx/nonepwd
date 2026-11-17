import {
  DEFAULT_KDF_ITERATIONS,
  type SealedEnvelope,
  type VaultItemPayload,
} from "./types";

export * from "./types";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SECRET_KEY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

const TWO_LEVEL_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "co.jp", "ne.jp", "or.jp",
  "com.au", "net.au", "org.au",
  "com.br", "com.tw", "com.hk", "co.kr", "co.in",
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

/**
 * Base64URL encoding (no padding) using Buffer's "base64" conversion for LLRT compatibility.
 */
export function toBase64Url(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Base64URL / standard Base64 decoding via Buffer("base64").
 */
export function fromBase64Url(input: string): Uint8Array {
  const cleaned = input
    .trim()
    .replace(/\s+/g, "")
    .replace(/=+$/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (cleaned.length === 0) return new Uint8Array(0);
  if (cleaned.length % 4 === 1 || !/^[A-Za-z0-9+/]*$/.test(cleaned)) {
    throw new Error("Invalid Base64URL string");
  }
  const padLen = (4 - (cleaned.length % 4)) % 4;
  const padded = cleaned + "=".repeat(padLen);
  const buf = Buffer.from(padded, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      const idx = (value >>> (bits - 5)) & 31;
      out += BASE32_ALPHABET[idx];
      bits -= 5;
    }
  }
  if (bits > 0) {
    const idx = (value << (5 - bits)) & 31;
    out += BASE32_ALPHABET[idx];
  }
  return out;
}

export function fromBase32(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/[\s\-=]+/g, "");
  if (cleaned.length === 0) return new Uint8Array(0);
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new Error(`Invalid Base32 character at index ${i}: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function randomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError("maxExclusive must be a positive integer");
  }
  if (maxExclusive === 1) return 0;
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  while (true) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) {
      return buf[0] % maxExclusive;
    }
  }
}

export function randomId(): string {
  return globalThis.crypto.randomUUID();
}

export function normalizeSecretKey(secretKey: string): string {
  return secretKey.toUpperCase().replace(/[\s-]+/g, "");
}

export function generateSecretKey(): string {
  const groups: string[] = [];
  for (let g = 0; g < 5; g++) {
    let group = "";
    for (let i = 0; i < 6; i++) {
      group += SECRET_KEY_ALPHABET[randomInt(SECRET_KEY_ALPHABET.length)];
    }
    groups.push(group);
  }
  return `NP3-${groups.join("-")}`;
}

export const AAD = {
  ROOT_KEYSET: "nonepwd:root-keyset:v1",
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
  masterUnlockKeyB64: string;
  authVerifierB64: string;
}

export async function deriveAccountKeys(
  masterPassword: string,
  secretKey: string,
  kdfSaltB64: string,
  iterations: number = DEFAULT_KDF_ITERATIONS
): Promise<DerivedAccountKeys> {
  const normalizedSk = normalizeSecretKey(secretKey);
  const ikm = utf8Encode(`${normalizedSk}\x00${masterPassword}`);
  const saltBytes = fromBase64Url(kdfSaltB64);
  const saltBuf = asArrayBuffer(saltBytes);

  const pbkdf2Key = await globalThis.crypto.subtle.importKey(
    "raw",
    asArrayBuffer(ikm),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBuf,
      iterations,
    },
    pbkdf2Key,
    512
  );

  const full = new Uint8Array(derivedBits);
  const masterUnlockKeyBytes = full.slice(0, 32);
  const authSeed = full.slice(32, 64);

  const hkdfKey = await globalThis.crypto.subtle.importKey(
    "raw",
    asArrayBuffer(authSeed),
    "HKDF",
    false,
    ["deriveBits"]
  );

  const verifierBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: saltBuf,
      info: asArrayBuffer(utf8Encode("nonepwd-auth-verifier-v1")),
    },
    hkdfKey,
    256
  );

  const verifier = new Uint8Array(verifierBits);
  return {
    masterUnlockKeyBytes,
    masterUnlockKeyB64: toBase64Url(masterUnlockKeyBytes),
    authVerifierB64: toBase64Url(verifier),
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
  if (rawKey32.length !== 32) {
    throw new Error(`Expected 32-byte AES key, got ${rawKey32.length}`);
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    asArrayBuffer(rawKey32),
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const iv = randomBytes(12);
  const params: { name: "AES-GCM"; iv: ArrayBuffer; additionalData?: ArrayBuffer } = {
    name: "AES-GCM",
    iv: asArrayBuffer(iv),
  };
  if (aad !== undefined && aad.length > 0) {
    params.additionalData = asArrayBuffer(utf8Encode(aad));
  }
  const ctBuf = await globalThis.crypto.subtle.encrypt(params, key, asArrayBuffer(plaintext));
  const ct = new Uint8Array(ctBuf);
  return `v1.${toBase64Url(iv)}.${toBase64Url(ct)}`;
}

export async function decryptBytes(
  rawKey32: Uint8Array,
  blob: string,
  aad?: string
): Promise<Uint8Array> {
  if (rawKey32.length !== 32) {
    throw new Error(`Expected 32-byte AES key, got ${rawKey32.length}`);
  }
  const parts = blob.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("Unsupported encrypted blob format");
  }
  const iv = fromBase64Url(parts[1]);
  if (iv.length !== 12) {
    throw new Error("Invalid AES-GCM IV length");
  }
  const ct = fromBase64Url(parts[2]);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    asArrayBuffer(rawKey32),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const params: { name: "AES-GCM"; iv: ArrayBuffer; additionalData?: ArrayBuffer } = {
    name: "AES-GCM",
    iv: asArrayBuffer(iv),
  };
  if (aad !== undefined && aad.length > 0) {
    params.additionalData = asArrayBuffer(utf8Encode(aad));
  }
  const ptBuf = await globalThis.crypto.subtle.decrypt(params, key, asArrayBuffer(ct));
  return new Uint8Array(ptBuf);
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

type WebCryptoKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;
type WebCryptoKeyPair = { publicKey: WebCryptoKey; privateKey: WebCryptoKey };

export async function generateEmailKeyPair(): Promise<EmailKeyPair> {
  const kp = (await globalThis.crypto.subtle.generateKey("X25519", true, [
    "deriveBits",
  ])) as WebCryptoKeyPair;
  const pubRaw = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", kp.publicKey));
  const privPkcs8 = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey)
  );
  return {
    publicKeyB64: toBase64Url(pubRaw),
    privateKeyPkcs8B64: toBase64Url(privPkcs8),
  };
}

function normalizeX25519Pkcs8(privateKeyB64: string): Uint8Array {
  const raw = fromBase64Url(privateKeyB64);
  if (raw.length === 48) {
    return raw;
  }
  if (raw.length === 32) {
    const out = new Uint8Array(48);
    out.set(X25519_PKCS8_PREFIX, 0);
    out.set(raw, 16);
    return out;
  }
  throw new Error(`Unsupported X25519 private key length: ${raw.length}`);
}

async function deriveSealedAesKey(
  sharedBits: ArrayBuffer,
  ephPubRaw: Uint8Array,
  info: string
): Promise<WebCryptoKey> {
  const hkdfKey = await globalThis.crypto.subtle.importKey("raw", sharedBits, "HKDF", false, [
    "deriveBits",
  ]);
  const aesKeyBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asArrayBuffer(ephPubRaw),
      info: asArrayBuffer(utf8Encode(info)),
    },
    hkdfKey,
    256
  );
  return globalThis.crypto.subtle.importKey(
    "raw",
    aesKeyBits,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function sealForPublicKey(
  recipientPublicKeyB64: string,
  plaintext: Uint8Array,
  info: string = "nonepwd-email-v1"
): Promise<SealedEnvelope> {
  const recipientPubRaw = fromBase64Url(recipientPublicKeyB64);
  if (recipientPubRaw.length !== 32) {
    throw new Error(`Expected 32-byte X25519 public key, got ${recipientPubRaw.length}`);
  }
  const recipientPub = await globalThis.crypto.subtle.importKey(
    "raw",
    asArrayBuffer(recipientPubRaw),
    "X25519",
    false,
    []
  );
  const ephKp = (await globalThis.crypto.subtle.generateKey("X25519", true, [
    "deriveBits",
  ])) as WebCryptoKeyPair;
  const ephPubRaw = new Uint8Array(
    await globalThis.crypto.subtle.exportKey("raw", ephKp.publicKey)
  );
  const sharedBits = await globalThis.crypto.subtle.deriveBits(
    { name: "X25519", public: recipientPub },
    ephKp.privateKey,
    256
  );
  const aesKey = await deriveSealedAesKey(sharedBits, ephPubRaw, info);
  const iv = randomBytes(12);
  const ctBuf = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(iv),
      additionalData: asArrayBuffer(utf8Encode(info)),
    },
    aesKey,
    asArrayBuffer(plaintext)
  );
  return {
    v: 1,
    epk: toBase64Url(ephPubRaw),
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ctBuf)),
  };
}

export async function openSealedEnvelope(
  recipientPrivateKeyPkcs8B64: string,
  envelope: SealedEnvelope,
  info: string = "nonepwd-email-v1"
): Promise<Uint8Array> {
  if (envelope.v !== 1) {
    throw new Error(`Unsupported envelope version: ${envelope.v}`);
  }
  const pkcs8 = normalizeX25519Pkcs8(recipientPrivateKeyPkcs8B64);
  const ephPubRaw = fromBase64Url(envelope.epk);
  if (ephPubRaw.length !== 32) {
    throw new Error(`Expected 32-byte X25519 public key, got ${ephPubRaw.length}`);
  }
  const iv = fromBase64Url(envelope.iv);
  if (iv.length !== 12) {
    throw new Error("Invalid sealed envelope IV length");
  }
  const ct = fromBase64Url(envelope.ct);

  const privKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    asArrayBuffer(pkcs8),
    "X25519",
    false,
    ["deriveBits"]
  );
  const ephPub = await globalThis.crypto.subtle.importKey(
    "raw",
    asArrayBuffer(ephPubRaw),
    "X25519",
    false,
    []
  );
  const sharedBits = await globalThis.crypto.subtle.deriveBits(
    { name: "X25519", public: ephPub },
    privKey,
    256
  );
  const aesKey = await deriveSealedAesKey(sharedBits, ephPubRaw, info);
  const ptBuf = await globalThis.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: asArrayBuffer(iv),
      additionalData: asArrayBuffer(utf8Encode(info)),
    },
    aesKey,
    asArrayBuffer(ct)
  );
  return new Uint8Array(ptBuf);
}

export async function sealJsonForPublicKey<T>(
  recipientPublicKeyB64: string,
  data: T,
  info: string = "nonepwd-email-v1"
): Promise<SealedEnvelope> {
  return sealForPublicKey(recipientPublicKeyB64, utf8Encode(JSON.stringify(data)), info);
}

export async function openSealedJson<T>(
  recipientPrivateKeyPkcs8B64: string,
  envelope: SealedEnvelope,
  info: string = "nonepwd-email-v1"
): Promise<T> {
  const bytes = await openSealedEnvelope(recipientPrivateKeyPkcs8B64, envelope, info);
  return JSON.parse(utf8Decode(bytes)) as T;
}

// ---------- TOTP & OtpAuth ----------

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface ParsedTotpConfig {
  secret: string;
  issuer?: string;
  account?: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

export interface TotpResult {
  code: string;
  period: number;
  remainingSeconds: number;
  progress: number;
}

function normalizeAlgorithm(raw?: string | null): TotpAlgorithm {
  const cleaned = (raw ?? "SHA1").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned === "SHA256") return "SHA256";
  if (cleaned === "SHA512") return "SHA512";
  return "SHA1";
}

function percentDecodeSimple(input: string): string {
  const rawBytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "%" && i + 2 < input.length) {
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        rawBytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const encoded = utf8Encode(input[i]);
    for (let j = 0; j < encoded.length; j++) {
      rawBytes.push(encoded[j]);
    }
  }
  return utf8Decode(new Uint8Array(rawBytes));
}

function splitOtpAuthUrl(raw: string): { kind: string; path: string; query: string } {
  const match = raw.match(/^otpauth:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(?:#.*)?$/i);
  if (!match) {
    throw new Error("Invalid otpauth URI");
  }
  const kind = (match[1] ?? "").toLowerCase();
  const path = (match[2] ?? "").replace(/^\/+/, "");
  const query = (match[3] ?? "").replace(/^\?/, "");
  return { kind, path, query };
}

function cleanBase32Secret(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[\s\-=]+/g, "");
  if (!cleaned) {
    throw new Error("Empty TOTP secret");
  }
  const decoded = fromBase32(cleaned);
  if (decoded.length === 0) {
    throw new Error("TOTP secret decoded to empty bytes");
  }
  return cleaned;
}

export function parseOtpInput(input: string): ParsedTotpConfig {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty TOTP secret or URI");
  }

  if (trimmed.toLowerCase().startsWith("otpauth://")) {
    const { path, query } = splitOtpAuthUrl(trimmed);
    const params = new URLSearchParams(query);
    const secretRaw = params.get("secret") ?? "";
    if (!secretRaw) {
      throw new Error("otpauth URI is missing secret parameter");
    }
    const issuerParam = params.get("issuer");
    const digitsNum = Number.parseInt(params.get("digits") ?? "6", 10);
    const periodNum = Number.parseInt(params.get("period") ?? "30", 10);
    const algParam = params.get("algorithm");

    const rawLabel = percentDecodeSimple(path);
    let labelIssuer: string | undefined;
    let account: string | undefined = rawLabel || undefined;
    const colonIdx = rawLabel.indexOf(":");
    if (colonIdx >= 0) {
      const iss = rawLabel.slice(0, colonIdx).trim();
      const acc = rawLabel.slice(colonIdx + 1).trim();
      if (iss) labelIssuer = iss;
      account = acc || undefined;
    }

    const secret = cleanBase32Secret(secretRaw);
    return {
      secret,
      issuer: (issuerParam && issuerParam.trim()) || labelIssuer,
      account,
      algorithm: normalizeAlgorithm(algParam),
      digits: Number.isFinite(digitsNum) && digitsNum >= 6 && digitsNum <= 8 ? digitsNum : 6,
      period: Number.isFinite(periodNum) && periodNum > 0 ? periodNum : 30,
    };
  }

  const secret = cleanBase32Secret(trimmed);
  return {
    secret,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  };
}

export function buildOtpAuthUri(params: {
  secret: string;
  account?: string;
  issuer?: string;
  digits?: number;
  period?: number;
  algorithm?: TotpAlgorithm;
}): string {
  const cleanSecret = params.secret.toUpperCase().replace(/[\s\-=]+/g, "");
  const issClean = params.issuer?.trim() || "";
  const accClean = params.account?.trim() || "";
  const label =
    issClean && accClean
      ? `${issClean}:${accClean}`
      : issClean
        ? `${issClean}:`
        : accClean || "user";

  const qp = new URLSearchParams();
  qp.set("secret", cleanSecret);
  if (issClean) qp.set("issuer", issClean);
  if (params.digits && params.digits !== 6) qp.set("digits", String(params.digits));
  if (params.period && params.period !== 30) qp.set("period", String(params.period));
  if (params.algorithm && params.algorithm !== "SHA1") qp.set("algorithm", params.algorithm);

  const encodedPath = label.split(":").map(encodeURIComponent).join(":");
  return `otpauth://totp/${encodedPath}?${qp.toString()}`;
}

function hmacHashName(alg: TotpAlgorithm): "SHA-1" | "SHA-256" | "SHA-512" {
  if (alg === "SHA256") return "SHA-256";
  if (alg === "SHA512") return "SHA-512";
  return "SHA-1";
}

export async function generateTotp(
  input: string,
  timestampMs: number = Date.now()
): Promise<TotpResult> {
  const config = parseOtpInput(input);
  const keyBytes = fromBase32(config.secret);
  if (keyBytes.length === 0) {
    throw new Error("TOTP secret decoded to empty bytes");
  }

  const epochSec = Math.floor(timestampMs / 1000);
  const counter = Math.floor(epochSec / config.period);
  const elapsed = ((epochSec % config.period) + config.period) % config.period;
  const remainingSeconds = config.period - elapsed;
  const progress = remainingSeconds / config.period;

  const counterBytes = new Uint8Array(8);
  const hi = Math.floor(counter / 0x1_0000_0000);
  const lo = counter >>> 0;
  counterBytes[0] = (hi >>> 24) & 0xff;
  counterBytes[1] = (hi >>> 16) & 0xff;
  counterBytes[2] = (hi >>> 8) & 0xff;
  counterBytes[3] = hi & 0xff;
  counterBytes[4] = (lo >>> 24) & 0xff;
  counterBytes[5] = (lo >>> 16) & 0xff;
  counterBytes[6] = (lo >>> 8) & 0xff;
  counterBytes[7] = lo & 0xff;

  const hmacKey = await globalThis.crypto.subtle.importKey(
    "raw",
    asArrayBuffer(keyBytes),
    { name: "HMAC", hash: hmacHashName(config.algorithm) },
    false,
    ["sign"]
  );
  const sigBuf = await globalThis.crypto.subtle.sign("HMAC", hmacKey, asArrayBuffer(counterBytes));
  const hmac = new Uint8Array(sigBuf);

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const modulus = 10 ** config.digits;
  const val = (binary >>> 0) % modulus;
  const code = String(val).padStart(config.digits, "0");

  return {
    code,
    period: config.period,
    remainingSeconds,
    progress,
  };
}

// ---------- Domain Helpers ----------

export function extractEmailAddress(rawHeader: string): string {
  const angle = rawHeader.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  const bare = rawHeader.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (bare) return bare[0].trim().toLowerCase();
  return rawHeader.trim().toLowerCase();
}

export function extractHost(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.includes("@") && !trimmed.includes("://")) {
    const addr = extractEmailAddress(trimmed);
    const idx = addr.lastIndexOf("@");
    return idx >= 0 ? addr.slice(idx + 1) : "";
  }
  const withoutProto = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const hostPort = withoutProto.split(/[/?#]/)[0] ?? "";
  const atIdx = hostPort.lastIndexOf("@");
  const cleanHostPort = atIdx >= 0 ? hostPort.slice(atIdx + 1) : hostPort;
  if (cleanHostPort.startsWith("[")) {
    const endBracket = cleanHostPort.indexOf("]");
    return endBracket >= 0 ? cleanHostPort.slice(0, endBracket + 1) : cleanHostPort;
  }
  return cleanHostPort.split(":")[0] ?? "";
}

export function extractRegistrableDomain(hostOrEmailOrUrl: string): string {
  const host = extractHost(hostOrEmailOrUrl).replace(/\.+$/, "");
  if (!host) return "";
  const parts = host.split(".").filter(Boolean);
  if (host === "localhost" || parts.every((p) => /^\d+$/.test(p))) {
    return host;
  }
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (TWO_LEVEL_TLDS.has(lastTwo) && parts.length >= 3) {
    return `${parts[parts.length - 3]}.${lastTwo}`;
  }
  return lastTwo;
}

export function domainsMatch(a: string, b: string): boolean {
  const ha = extractHost(a);
  const hb = extractHost(b);
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  const ra = extractRegistrableDomain(ha);
  const rb = extractRegistrableDomain(hb);
  return Boolean(ra) && ra === rb;
}

// ---------- Authenticator Export & Migration Protobuf ----------

export interface TotpImportEntry {
  issuer?: string;
  account?: string;
  secret: string;
  otpauthUri: string;
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
}

export type TotpImportAction =
  | {
      action: "skip_duplicate";
      existingItemId?: string;
    }
  | {
      action: "attach";
      itemId: string;
      otpauthUri: string;
    }
  | {
      action: "create";
      title: string;
      username?: string;
      totp: string;
    };

export type TotpImportPlanItem = {
  entry: TotpImportEntry;
} & TotpImportAction;

function trimNonEmpty(raw?: string | null): string | undefined {
  const t = raw?.trim();
  return t ? t : undefined;
}

function formatTotpOtpauthUri(
  secret: string,
  account: string | undefined,
  issuer: string | undefined,
  digits: number,
  period: number,
  algorithm: TotpAlgorithm
): string {
  const issClean = trimNonEmpty(issuer);
  const accClean = trimNonEmpty(account);
  let label = "";
  if (issClean && accClean) label = `${issClean}:${accClean}`;
  else if (issClean) label = `${issClean}:`;
  else if (accClean) label = accClean;

  const qp = new URLSearchParams();
  qp.set("secret", secret);
  if (issClean) qp.set("issuer", issClean);
  if (digits !== 6) qp.set("digits", String(digits));
  if (period !== 30) qp.set("period", String(period));
  if (algorithm !== "SHA1") qp.set("algorithm", algorithm);

  const encodedPath = label ? label.split(":").map(encodeURIComponent).join(":") : "";
  return `otpauth://totp/${encodedPath}?${qp.toString()}`;
}

function buildImportEntry(
  secretRaw: string,
  issuer: string | undefined,
  account: string | undefined,
  digits: number,
  period: number,
  algorithm: TotpAlgorithm
): TotpImportEntry {
  const secret = cleanBase32Secret(secretRaw);
  const normDigits = digits >= 6 && digits <= 8 ? digits : 6;
  const normPeriod = period > 0 ? period : 30;
  const issuerClean = trimNonEmpty(issuer);
  const accountClean = trimNonEmpty(account);
  const otpauthUri = formatTotpOtpauthUri(
    secret,
    accountClean,
    issuerClean,
    normDigits,
    normPeriod,
    algorithm
  );
  return {
    ...(issuerClean ? { issuer: issuerClean } : {}),
    ...(accountClean ? { account: accountClean } : {}),
    secret,
    otpauthUri,
    digits: normDigits,
    period: normPeriod,
    algorithm,
  };
}

function percentDecodePreservingPlus(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "%" && i + 2 < input.length) {
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    const enc = utf8Encode(input[i]);
    for (let j = 0; j < enc.length; j++) out.push(enc[j]);
  }
  return new Uint8Array(out);
}

interface ProtoReader {
  buf: Uint8Array;
  pos: number;
}

function readVarint(r: ProtoReader): number {
  let result = 0;
  let shift = 0;
  while (r.pos < r.buf.length) {
    const byte = r.buf[r.pos++];
    if (shift >= 53) {
      throw new Error("Invalid protobuf varint: overflow");
    }
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return result;
    }
    shift += 7;
  }
  throw new Error("Unexpected EOF while decoding protobuf varint");
}

function readLenDelimited(r: ProtoReader): Uint8Array {
  const len = readVarint(r);
  const end = r.pos + len;
  if (end > r.buf.length) {
    throw new Error("Unexpected EOF in length-delimited protobuf field");
  }
  const slice = r.buf.subarray(r.pos, end);
  r.pos = end;
  return slice;
}

function skipWireValue(r: ProtoReader, wireType: number): void {
  if (wireType === 0) {
    readVarint(r);
  } else if (wireType === 1) {
    if (r.pos + 8 > r.buf.length) throw new Error("Unexpected EOF in 64-bit protobuf field");
    r.pos += 8;
  } else if (wireType === 2) {
    readLenDelimited(r);
  } else if (wireType === 5) {
    if (r.pos + 4 > r.buf.length) throw new Error("Unexpected EOF in 32-bit protobuf field");
    r.pos += 4;
  } else {
    throw new Error(`Unsupported protobuf wire type: ${wireType}`);
  }
}

function decodeMigrationOtpParameters(buf: Uint8Array): TotpImportEntry | null {
  const r: ProtoReader = { buf, pos: 0 };
  let secretBytes = new Uint8Array(0);
  let name = "";
  let issuer = "";
  let algorithmRaw = 0;
  let digitsRaw = 0;
  let otpTypeRaw = 0;

  while (r.pos < r.buf.length) {
    const tag = readVarint(r);
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 0x07;
    if (fieldNum === 1 && wireType === 2) {
      secretBytes = new Uint8Array(readLenDelimited(r));
    } else if (fieldNum === 2 && wireType === 2) {
      name = utf8Decode(readLenDelimited(r));
    } else if (fieldNum === 3 && wireType === 2) {
      issuer = utf8Decode(readLenDelimited(r));
    } else if (fieldNum === 4 && wireType === 0) {
      algorithmRaw = readVarint(r);
    } else if (fieldNum === 5 && wireType === 0) {
      digitsRaw = readVarint(r);
    } else if (fieldNum === 6 && wireType === 0) {
      otpTypeRaw = readVarint(r);
    } else {
      skipWireValue(r, wireType);
    }
  }

  if (otpTypeRaw !== 0 && otpTypeRaw !== 2) {
    return null;
  }
  if (secretBytes.length === 0) {
    throw new Error("Google Authenticator migration entry is missing secret bytes");
  }

  let algorithm: TotpAlgorithm = "SHA1";
  if (algorithmRaw === 0 || algorithmRaw === 1) algorithm = "SHA1";
  else if (algorithmRaw === 2) algorithm = "SHA256";
  else if (algorithmRaw === 3) algorithm = "SHA512";
  else if (algorithmRaw === 4) {
    throw new Error("Unsupported MD5 OTP algorithm in migration payload");
  } else {
    throw new Error(`Unknown OTP algorithm enum ${algorithmRaw} in migration payload`);
  }

  const digits = digitsRaw === 2 || digitsRaw === 8 ? 8 : digitsRaw === 7 ? 7 : 6;
  const explicitIssuer = trimNonEmpty(issuer);
  const rawName = name.trim();
  const colonIdx = rawName.indexOf(":");
  const labelIssuer = colonIdx >= 0 ? trimNonEmpty(rawName.slice(0, colonIdx)) : undefined;
  const account = colonIdx >= 0 ? trimNonEmpty(rawName.slice(colonIdx + 1)) : trimNonEmpty(rawName);
  const finalIssuer = explicitIssuer ?? labelIssuer;
  const secretB32 = toBase32(secretBytes);

  return buildImportEntry(secretB32, finalIssuer, account, digits, 30, algorithm);
}

export function parseOtpauthMigrationUri(uri: string): TotpImportEntry[] {
  const trimmed = uri.trim();
  const qIdx = trimmed.indexOf("?");
  if (qIdx < 0) {
    throw new Error("otpauth-migration URI is missing query parameters");
  }
  const queryAndFrag = trimmed.slice(qIdx + 1);
  const hashIdx = queryAndFrag.indexOf("#");
  const query = hashIdx >= 0 ? queryAndFrag.slice(0, hashIdx) : queryAndFrag;

  let dataRaw: string | undefined;
  for (const pair of query.split("&")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx >= 0 && pair.slice(0, eqIdx).toLowerCase() === "data") {
      dataRaw = pair.slice(eqIdx + 1);
      break;
    }
  }
  if (!dataRaw || !dataRaw.trim()) {
    throw new Error("otpauth-migration URI is missing data parameter");
  }

  const decodedParamStr = utf8Decode(percentDecodePreservingPlus(dataRaw));
  const protoBytes = fromBase64Url(decodedParamStr);
  if (protoBytes.length === 0) {
    throw new Error("Empty protobuf payload in otpauth-migration URI");
  }

  const r: ProtoReader = { buf: protoBytes, pos: 0 };
  const entries: TotpImportEntry[] = [];
  while (r.pos < r.buf.length) {
    const tag = readVarint(r);
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 0x07;
    if (fieldNum === 1 && wireType === 2) {
      const sub = readLenDelimited(r);
      const entry = decodeMigrationOtpParameters(sub);
      if (entry) entries.push(entry);
    } else {
      skipWireValue(r, wireType);
    }
  }
  return entries;
}

function parseOtpauthUriLine(line: string): TotpImportEntry | null {
  const trimmed = line.trim();
  const { kind } = splitOtpAuthUrl(trimmed);
  if (kind === "hotp") return null;
  if (kind !== "totp") {
    throw new Error(`Unsupported otpauth type "${kind}" (expected totp)`);
  }
  const cfg = parseOtpInput(trimmed);
  return buildImportEntry(cfg.secret, cfg.issuer, cfg.account, cfg.digits, cfg.period, cfg.algorithm);
}

function parseJsonAuthenticatorExport(jsonText: string): TotpImportEntry[] {
  const root = JSON.parse(jsonText) as unknown;
  const entries: TotpImportEntry[] = [];

  if (root && typeof root === "object" && !Array.isArray(root)) {
    const obj = root as Record<string, unknown>;
    if ("db" in obj && obj.db !== undefined) {
      if (typeof obj.db === "string") {
        throw new Error("Encrypted Aegis backup is not supported; export as plain JSON");
      }
      const db = obj.db as { entries?: Array<Record<string, unknown>> };
      if (Array.isArray(db.entries)) {
        for (const item of db.entries) {
          const entryType = typeof item.type === "string" ? item.type : "totp";
          if (entryType.toLowerCase() !== "totp") continue;
          const info = item.info as Record<string, unknown> | undefined;
          const secret = typeof info?.secret === "string" ? info.secret : "";
          if (!secret.trim()) continue;
          const issuer = typeof item.issuer === "string" ? item.issuer : undefined;
          const account = typeof item.name === "string" ? item.name : undefined;
          const digits = typeof info?.digits === "number" ? info.digits : 6;
          const period = typeof info?.period === "number" ? info.period : 30;
          const alg = normalizeAlgorithm(typeof info?.algo === "string" ? info.algo : undefined);
          entries.push(buildImportEntry(secret, issuer, account, digits, period, alg));
        }
        if (entries.length === 0) throw new Error("No TOTP entries found in Aegis JSON export");
        return entries;
      }
    }

    if ("services" in obj || "servicesEncrypted" in obj) {
      if (!Array.isArray(obj.services) && obj.servicesEncrypted != null) {
        throw new Error("Encrypted 2FAS backup is not supported; export without password");
      }
      if (Array.isArray(obj.services)) {
        for (const svc of obj.services as Array<Record<string, unknown>>) {
          const otp = svc.otp as Record<string, unknown> | undefined;
          const tokenType = typeof otp?.tokenType === "string" ? otp.tokenType : "TOTP";
          if (tokenType.toUpperCase() !== "TOTP") continue;
          const link = typeof otp?.link === "string" ? otp.link : undefined;
          if (link && link.trim().toLowerCase().startsWith("otpauth://")) {
            const parsed = parseOtpauthUriLine(link);
            if (parsed) {
              if (!parsed.issuer) {
                parsed.issuer = trimNonEmpty(
                  (typeof otp?.issuer === "string" ? otp.issuer : undefined) ??
                    (typeof svc.name === "string" ? svc.name : undefined)
                );
              }
              if (!parsed.account) {
                parsed.account = trimNonEmpty(
                  typeof otp?.account === "string" ? otp.account : undefined
                );
              }
              parsed.otpauthUri = formatTotpOtpauthUri(
                parsed.secret,
                parsed.account,
                parsed.issuer,
                parsed.digits,
                parsed.period,
                parsed.algorithm
              );
              entries.push(parsed);
              continue;
            }
          }
          const secret = typeof svc.secret === "string" ? svc.secret : "";
          if (!secret.trim()) continue;
          const issuer =
            (typeof otp?.issuer === "string" ? otp.issuer : undefined) ??
            (typeof svc.name === "string" ? svc.name : undefined);
          const account =
            (typeof otp?.account === "string" ? otp.account : undefined) ??
            (typeof otp?.label === "string" ? otp.label : undefined);
          const digits = typeof otp?.digits === "number" ? otp.digits : 6;
          const period = typeof otp?.period === "number" ? otp.period : 30;
          const alg = normalizeAlgorithm(
            typeof otp?.algorithm === "string" ? otp.algorithm : undefined
          );
          entries.push(buildImportEntry(secret, issuer, account, digits, period, alg));
        }
        if (entries.length === 0) throw new Error("No TOTP entries found in 2FAS JSON export");
        return entries;
      }
    }
  }

  if (Array.isArray(root)) {
    for (const item of root) {
      if (typeof item === "string") {
        const lower = item.trim().toLowerCase();
        if (lower.startsWith("otpauth-migration://")) {
          entries.push(...parseOtpauthMigrationUri(item));
        } else if (lower.startsWith("otpauth://")) {
          const parsed = parseOtpauthUriLine(item);
          if (parsed) entries.push(parsed);
        }
      } else if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const kind =
          (typeof obj.kind === "string" ? obj.kind : undefined) ??
          (typeof obj.type === "string" ? obj.type : undefined) ??
          "TOTP";
        if (kind.toLowerCase() !== "totp") continue;
        const uri =
          (typeof obj.otpauthUri === "string" ? obj.otpauthUri : undefined) ??
          (typeof obj.uri === "string" ? obj.uri : undefined);
        if (uri) {
          const parsed = parseOtpauthUriLine(uri);
          if (parsed) {
            entries.push(parsed);
            continue;
          }
        }
        if (typeof obj.secret === "string") {
          const issuer = typeof obj.issuer === "string" ? obj.issuer : undefined;
          const account =
            (typeof obj.account === "string" ? obj.account : undefined) ??
            (typeof obj.name === "string" ? obj.name : undefined) ??
            (typeof obj.username === "string" ? obj.username : undefined);
          const digits = Number(obj.digits ?? 6) || 6;
          const period = Number(obj.period ?? obj.timer ?? 30) || 30;
          const alg = normalizeAlgorithm(
            (typeof obj.algorithm === "string" ? obj.algorithm : undefined) ??
              (typeof obj.algo === "string" ? obj.algo : undefined)
          );
          entries.push(buildImportEntry(obj.secret, issuer, account, digits, period, alg));
        }
      }
    }
    if (entries.length === 0) throw new Error("No TOTP entries found in JSON authenticator export");
    return entries;
  }

  throw new Error("Unrecognized JSON authenticator export format");
}

export function parseAuthenticatorExport(text: string): TotpImportEntry[] {
  const cleaned = text.replace(/^\uFEFF/, "").trim();
  if (!cleaned) {
    throw new Error("Authenticator export is empty");
  }
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    return parseJsonAuthenticatorExport(cleaned);
  }

  const entries: TotpImportEntry[] = [];
  const lines = cleaned.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith("otpauth-migration://")) {
      entries.push(...parseOtpauthMigrationUri(line));
    } else if (lower.startsWith("otpauth://")) {
      const parsed = parseOtpauthUriLine(line);
      if (parsed) entries.push(parsed);
    } else {
      throw new Error(`Line ${idx + 1}: expected otpauth:// or otpauth-migration:// URI`);
    }
  }

  if (entries.length === 0) {
    throw new Error("No valid TOTP entries found in authenticator export");
  }
  return entries;
}

function extractNormalizedTotpSecret(totpField: string): string | null {
  try {
    return parseOtpInput(totpField).secret;
  } catch {
    return null;
  }
}

function primaryDomainLabel(regDomain: string): string {
  const dot = regDomain.indexOf(".");
  return dot >= 0 ? regDomain.slice(0, dot) : regDomain;
}

function compactAlnumLower(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function totpIssuerMatchesItem(issuer: string, item: VaultItemPayload): boolean {
  const issTrimmed = issuer.trim();
  if (!issTrimmed) return false;
  const issLower = issTrimmed.toLowerCase();
  const issLooksLikeDomain = issLower.includes(".") && !issLower.includes(" ");
  const issReg = issLooksLikeDomain ? extractRegistrableDomain(issLower) : "";
  const issLabel = issReg ? primaryDomainLabel(issReg) : issLower;
  const issCompact = compactAlnumLower(issTrimmed);

  const titleTrimmed = item.title.trim();
  if (titleTrimmed) {
    const titleLower = titleTrimmed.toLowerCase();
    if (titleLower === issLower) return true;
    if (issCompact.length >= 2 && compactAlnumLower(titleTrimmed) === issCompact) return true;
    if (titleLower.includes(".") && !titleLower.includes(" ")) {
      const titleReg = extractRegistrableDomain(titleLower);
      if (titleReg) {
        if (issReg && titleReg === issReg) return true;
        if (primaryDomainLabel(titleReg) === issLabel) return true;
      }
    } else if (issReg && titleLower === issLabel) {
      return true;
    }
  }

  for (const url of item.urls) {
    const urlReg = extractRegistrableDomain(url);
    if (!urlReg) continue;
    if (issReg && urlReg === issReg) return true;
    const urlLabel = primaryDomainLabel(urlReg);
    if (urlLabel === issLabel) return true;
    if (issCompact.length >= 3 && urlLabel === issCompact) return true;
  }

  return false;
}

function findMatchingItemIndex(
  items: VaultItemPayload[],
  entry: TotpImportEntry,
  alreadyAttachedIds: Set<string>
): number {
  const issuer = entry.issuer?.trim();
  if (!issuer) return -1;
  const accountOpt = trimNonEmpty(entry.account);

  const matches = (item: VaultItemPayload): boolean => {
    if (item.category !== "login") return false;
    if (alreadyAttachedIds.has(item.id)) return false;
    if (item.totp && item.totp.trim()) return false;
    if (!totpIssuerMatchesItem(issuer, item)) return false;
    if (accountOpt) {
      const user = item.username?.trim();
      if (!user || user.toLowerCase() !== accountOpt.toLowerCase()) return false;
    }
    return true;
  };

  if (accountOpt) {
    const exactIdx = items.findIndex(
      (it) => matches(it) && it.username?.trim() === accountOpt
    );
    if (exactIdx >= 0) return exactIdx;
  }
  return items.findIndex(matches);
}

export function planTotpImport(
  existingItems: VaultItemPayload[],
  entries: TotpImportEntry[]
): TotpImportPlanItem[] {
  const seenSecrets = new Set<string>();
  const secretToItemId = new Map<string, string>();

  for (const item of existingItems) {
    if (item.totp) {
      const sec = extractNormalizedTotpSecret(item.totp);
      if (sec) {
        seenSecrets.add(sec);
        if (!secretToItemId.has(sec)) secretToItemId.set(sec, item.id);
      }
    }
  }

  const attachedItemIds = new Set<string>();
  const plan: TotpImportPlanItem[] = [];

  for (const entry of entries) {
    if (seenSecrets.has(entry.secret)) {
      plan.push({
        entry,
        action: "skip_duplicate",
        existingItemId: secretToItemId.get(entry.secret),
      });
      continue;
    }
    seenSecrets.add(entry.secret);

    const idx = findMatchingItemIndex(existingItems, entry, attachedItemIds);
    if (idx >= 0) {
      const itemId = existingItems[idx].id;
      attachedItemIds.add(itemId);
      secretToItemId.set(entry.secret, itemId);
      plan.push({
        entry,
        action: "attach",
        itemId,
        otpauthUri: entry.otpauthUri,
      });
    } else {
      const title =
        trimNonEmpty(entry.issuer) ?? trimNonEmpty(entry.account) ?? "Imported TOTP";
      plan.push({
        entry,
        action: "create",
        title,
        username: trimNonEmpty(entry.account),
        totp: entry.otpauthUri,
      });
    }
  }

  return plan;
}

// ---------- Password Generator & Security Audit ----------

const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PW_LOWER = "abcdefghijkmnopqrstuvwxyz";
const PW_DIGITS = "23456789";
const PW_SYMBOLS = "!@#$%^&*-_=+?";

export interface PasswordOptions {
  length?: number;
  uppercase?: boolean;
  lowercase?: boolean;
  digits?: boolean;
  symbols?: boolean;
}

export function generatePassword(options: PasswordOptions = {}): string {
  const length = Math.min(128, Math.max(8, options.length ?? 20));
  const useUpper = options.uppercase ?? true;
  const useLower = options.lowercase ?? true;
  const useDigits = options.digits ?? true;
  const useSymbols = options.symbols ?? true;

  const pools: string[] = [];
  if (useUpper) pools.push(PW_UPPER);
  if (useLower) pools.push(PW_LOWER);
  if (useDigits) pools.push(PW_DIGITS);
  if (useSymbols) pools.push(PW_SYMBOLS);
  if (pools.length === 0) {
    pools.push(PW_LOWER, PW_DIGITS);
  }

  const allChars = pools.join("");
  const chars: string[] = [];
  for (const pool of pools) {
    if (chars.length < length) {
      chars.push(pool[randomInt(pool.length)]);
    }
  }
  while (chars.length < length) {
    chars.push(allChars[randomInt(allChars.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join("");
}

export interface SecurityAuditSummary {
  totalLogins: number;
  weakItems: VaultItemPayload[];
  reusedItems: VaultItemPayload[];
  missingTotpItems: VaultItemPayload[];
  issuesByItemId: Record<string, string[]>;
  score: number;
}

export function auditVaultItems(items: VaultItemPayload[]): SecurityAuditSummary {
  const logins = items.filter((it) => it.category === "login");
  const pwCounts = new Map<string, number>();
  for (const it of logins) {
    if (it.password) {
      pwCounts.set(it.password, (pwCounts.get(it.password) ?? 0) + 1);
    }
  }

  const weakItems: VaultItemPayload[] = [];
  const reusedItems: VaultItemPayload[] = [];
  const missingTotpItems: VaultItemPayload[] = [];
  const issuesByItemId: Record<string, string[]> = {};

  for (const it of logins) {
    const issues: string[] = [];
    if (it.password) {
      if ((pwCounts.get(it.password) ?? 0) > 1) {
        reusedItems.push(it);
        issues.push("重复使用密码");
      }
      if (it.password.length < 10) {
        weakItems.push(it);
        issues.push("弱密码（少于 10 位）");
      }
    }
    if (!it.totp || !it.totp.trim()) {
      missingTotpItems.push(it);
      issues.push("未配置 2FA");
    }
    if (issues.length > 0) {
      issuesByItemId[it.id] = issues;
    }
  }

  const totalLogins = logins.length;
  let score = 100;
  if (totalLogins > 0) {
    const penalty =
      weakItems.length * 15 + reusedItems.length * 20 + missingTotpItems.length * 5;
    score = Math.max(0, Math.min(100, Math.round(100 - penalty / Math.max(1, totalLogins * 0.4))));
  }

  return {
    totalLogins,
    weakItems,
    reusedItems,
    missingTotpItems,
    issuesByItemId,
    score,
  };
}
