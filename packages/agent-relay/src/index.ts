/**
 * Agent Access protocol v0 relay core.
 *
 * WebSocket text frames are the externally tagged `Messages` JSON used by
 * `ap-relay-protocol` 0.12. Authentication is an Ed25519 signature over the
 * raw 32-byte challenge, wrapped in COSE_Sign1 the way `coset` emits it.
 * Payloads are forwarded unchanged.
 */

export const AGENT_RELAY_PATH = '/agent/relay';
const AUTH_TIMEOUT_MS = 5_000;
const RENDEZVOUS_TTL_MS = 300_000;
const MAX_RENDEZVOUS_PER_FINGERPRINT = 8;
const MAX_COSE_KEY_BYTES = 128;
const MAX_COSE_SIGN1_BYTES = 256;
const DESTINATION_BYTES = 32;
const MAX_PAYLOAD_BYTES = 65_536;
const MAX_CBOR_DEPTH = 4;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function parseByteArray(value: unknown, minLen: number, maxLen: number): Uint8Array | null {
  if (!Array.isArray(value)) return null;
  const len = value.length;
  if (len < minLen || len > maxLen) return null;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const n = value[i];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
}

export function isGetRendezvousMessage(parsed: unknown): boolean {
  return (
    parsed === 'GetRendezvous' ||
    (typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      'GetRendezvous' in parsed)
  );
}

export function generateRendezvousCode(): string {
  let code = '';
  while (code.length < 9) {
    const raw = randomBytes(16);
    for (let i = 0; i < raw.length && code.length < 9; i++) {
      const byte = raw[i]!;
      if (byte < 252) code += ALPHABET[byte % ALPHABET.length];
    }
  }
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;
}

export interface RelaySender {
  send(text: string): void;
  close(): void;
}

type ConnPhase =
  | { phase: 'auth'; challenge: Uint8Array; openedAt: number }
  | { phase: 'ready'; fingerprint: string; identity: number[] };

interface Conn {
  id: number;
  phase: ConnPhase;
  sender: RelaySender;
  queue: Promise<void>;
}

interface Rendezvous {
  fingerprint: string;
  createdAt: number;
  used: boolean;
}

export class AgentRelay {
  private conns = new Map<number, Conn>();
  private byFingerprint = new Map<string, Set<number>>();
  private rendezvous = new Map<string, Rendezvous>();
  private nextId = 1;

  open(sender: RelaySender): { onMessage(text: string): void; onClose(): void; isAuthenticated(): boolean } {
    const id = this.nextId++;
    const challenge = randomBytes(32);
    const conn: Conn = {
      id,
      phase: { phase: 'auth', challenge, openedAt: Date.now() },
      sender,
      queue: Promise.resolve(),
    };
    this.conns.set(id, conn);
    sender.send(JSON.stringify({ AuthChallenge: [...challenge] }));
    return {
      onMessage: (text: string) => {
        conn.queue = conn.queue
          .then(() => this.handle(id, text))
          .catch(() => {
            this.drop(id);
          });
      },
      onClose: () => this.drop(id),
      isAuthenticated: () => this.conns.get(id)?.phase.phase === 'ready',
    };
  }

  sweep(now = Date.now()): void {
    for (const [code, entry] of this.rendezvous) {
      if (now - entry.createdAt > RENDEZVOUS_TTL_MS) this.rendezvous.delete(code);
    }
    for (const conn of this.conns.values()) {
      if (conn.phase.phase === 'auth' && now - conn.phase.openedAt > AUTH_TIMEOUT_MS) {
        this.drop(conn.id);
      }
    }
  }

  private async handle(id: number, text: string): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (conn.phase.phase === 'auth') {
      if (Date.now() - conn.phase.openedAt > AUTH_TIMEOUT_MS) {
        this.drop(id);
        return;
      }
      const verified = await verifyAuthResponse(conn.phase.challenge, parsed);
      if (!verified) {
        this.drop(id);
        return;
      }
      conn.phase = {
        phase: 'ready',
        fingerprint: verified.fingerprintHex,
        identity: verified.identity,
      };
      let set = this.byFingerprint.get(verified.fingerprintHex);
      if (!set) {
        set = new Set();
        this.byFingerprint.set(verified.fingerprintHex, set);
      }
      set.add(id);
      return;
    }

    if (isGetRendezvousMessage(parsed)) {
      const now = Date.now();
      const activeForFp: Array<[string, Rendezvous]> = [];
      for (const [k, entry] of this.rendezvous) {
        if (entry.used || now - entry.createdAt > RENDEZVOUS_TTL_MS) {
          this.rendezvous.delete(k);
        } else if (entry.fingerprint === conn.phase.fingerprint) {
          activeForFp.push([k, entry]);
        }
      }
      if (activeForFp.length >= MAX_RENDEZVOUS_PER_FINGERPRINT) {
        activeForFp.sort((a, b) => a[1].createdAt - b[1].createdAt);
        const excess = activeForFp.length - MAX_RENDEZVOUS_PER_FINGERPRINT + 1;
        for (let i = 0; i < excess; i++) {
          this.rendezvous.delete(activeForFp[i]![0]);
        }
      }
      const code = this.freshCode();
      if (!code) return;
      this.rendezvous.set(code, {
        fingerprint: conn.phase.fingerprint,
        createdAt: now,
        used: false,
      });
      this.sendToFingerprint(conn.phase.fingerprint, JSON.stringify({ RendezvousInfo: { code } }));
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const msg = parsed as Record<string, unknown>;

    if ('GetIdentity' in msg) {
      const body = msg.GetIdentity;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return;
      const code = (body as { code?: unknown }).code;
      if (typeof code !== 'string' || code.length === 0 || code.length > 32) return;
      const entry = this.rendezvous.get(code);
      if (!entry) return;
      const age = Date.now() - entry.createdAt;
      if (entry.used || age > RENDEZVOUS_TTL_MS) {
        this.rendezvous.delete(code);
        return;
      }
      entry.used = true;
      const target = this.byFingerprint.get(entry.fingerprint);
      const targetId = target && [...target][0];
      const targetConn = targetId === undefined ? undefined : this.conns.get(targetId);
      if (!targetConn || targetConn.phase.phase !== 'ready') return;
      this.sendToFingerprint(
        conn.phase.fingerprint,
        JSON.stringify({
          IdentityInfo: {
            fingerprint: hexToBytes(entry.fingerprint),
            identity: { cose_key_bytes: targetConn.phase.identity },
          },
        })
      );
      return;
    }
    if ('Send' in msg) {
      const body = msg.Send;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return;
      const sendObj = body as { destination?: unknown; payload?: unknown };
      const destBytes = parseByteArray(sendObj.destination, DESTINATION_BYTES, DESTINATION_BYTES);
      const payloadBytes = parseByteArray(sendObj.payload, 0, MAX_PAYLOAD_BYTES);
      if (!destBytes || !payloadBytes) return;
      const destination = bytesToHex(destBytes);
      this.sendToFingerprint(
        destination,
        JSON.stringify({
          Send: {
            source: hexToBytes(conn.phase.fingerprint),
            destination: [...destBytes],
            payload: [...payloadBytes],
          },
        })
      );
    }
  }

  private freshCode(): string | null {
    for (let i = 0; i < 16; i++) {
      const formatted = generateRendezvousCode();
      if (!this.rendezvous.has(formatted)) return formatted;
    }
    return null;
  }

  private sendToFingerprint(fingerprint: string, text: string): void {
    const ids = this.byFingerprint.get(fingerprint);
    if (!ids) return;
    for (const id of ids) {
      this.conns.get(id)?.sender.send(text);
    }
  }

  private drop(id: number): void {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    if (conn.phase.phase === 'ready') {
      const set = this.byFingerprint.get(conn.phase.fingerprint);
      set?.delete(id);
      if (set && set.size === 0) this.byFingerprint.delete(conn.phase.fingerprint);
    }
    try {
      conn.sender.close();
    } catch {
      // already closed
    }
  }
}

export interface VerifiedIdentity {
  fingerprintHex: string;
  identity: number[];
  publicKey: Uint8Array;
}

export async function verifyAuthResponse(
  challenge: Uint8Array,
  message: unknown
): Promise<VerifiedIdentity | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const pair = (message as Record<string, unknown>).AuthResponse;
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const identity = pair[0];
  const response = pair[1];
  if (
    !identity ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    !response ||
    typeof response !== 'object' ||
    Array.isArray(response)
  ) {
    return null;
  }
  const keyBytes = parseByteArray(
    (identity as { cose_key_bytes?: unknown }).cose_key_bytes,
    1,
    MAX_COSE_KEY_BYTES
  );
  const signBytes = parseByteArray(
    (response as { cose_sign1_bytes?: unknown }).cose_sign1_bytes,
    1,
    MAX_COSE_SIGN1_BYTES
  );
  if (!keyBytes || !signBytes) return null;
  const publicKey = extractOkpPublicKey(keyBytes);
  const signed = decodeCoseSign1(signBytes);
  if (!publicKey || !signed) return null;
  if (!bytesEqual(signed.payload, challenge)) return null;
  const ok = await verifyEd25519(publicKey, challenge, signed.signature);
  if (!ok) return null;
  const fingerprint = new Uint8Array(await crypto.subtle.digest('SHA-256', bytesToArrayBuffer(publicKey)));
  return {
    fingerprintHex: bytesToHex(fingerprint),
    identity: [...keyBytes],
    publicKey,
  };
}

/** coset OKP public key: kty=1, alg=EdDSA(-8), crv=-8, x=32 bytes. */
export function encodeOkpPublicKey(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return Uint8Array.from([
    0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x27, 0x21, 0x58, 0x20, ...publicKey,
  ]);
}

/** COSE_Sign1 with protected {1: -8}, empty unprotected map, raw payload and signature. */
export function encodeCoseSign1(payload: Uint8Array, signature: Uint8Array): Uint8Array {
  const body = [
    0x84, 0x43, 0xa1, 0x01, 0x27, 0xa0, 0x58, payload.length, ...payload, 0x58, signature.length,
    ...signature,
  ];
  return Uint8Array.from(body);
}

export async function signChallenge(
  privateKey: CryptoKey,
  publicKey: Uint8Array,
  challenge: Uint8Array
): Promise<{ authMessage: string; fingerprintHex: string }> {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      privateKey,
      bytesToArrayBuffer(challenge)
    )
  );
  const identity = [...encodeOkpPublicKey(publicKey)];
  const cose = [...encodeCoseSign1(challenge, signature)];
  const authMessage = JSON.stringify({
    AuthResponse: [{ cose_key_bytes: identity }, { cose_sign1_bytes: cose }],
  });
  const fingerprint = new Uint8Array(await crypto.subtle.digest('SHA-256', bytesToArrayBuffer(publicKey)));
  return { authMessage, fingerprintHex: bytesToHex(fingerprint) };
}

function extractOkpPublicKey(coseKey: Uint8Array): Uint8Array | null {
  const decoded = decodeCbor(coseKey);
  if (!decoded || !(decoded.value instanceof Map)) return null;
  let kty: number | null = null;
  let alg: number | null = null;
  let crv: number | null = null;
  let x: Uint8Array | null = null;
  for (const [key, value] of decoded.value) {
    if (key === 1 && typeof value === 'number') kty = value;
    if (key === 3 && typeof value === 'number') alg = value;
    if (key === -1 && typeof value === 'number') crv = value;
    if (key === -2 && value instanceof Uint8Array) x = value;
  }
  if (kty !== 1 || alg !== -8 || crv !== -8 || !x || x.length !== 32) return null;
  if (decoded.offset !== coseKey.length) return null;
  return x;
}

function decodeCoseSign1(bytes: Uint8Array): { payload: Uint8Array; signature: Uint8Array } | null {
  const decoded = decodeCbor(bytes);
  if (!decoded || !Array.isArray(decoded.value) || decoded.value.length !== 4) return null;
  const [protectedBytes, , payload, signature] = decoded.value;
  if (!(protectedBytes instanceof Uint8Array) || !(payload instanceof Uint8Array)) return null;
  if (!(signature instanceof Uint8Array)) return null;
  const header = decodeCbor(protectedBytes);
  if (!header || !(header.value instanceof Map)) return null;
  if (header.value.get(1) !== -8) return null;
  if (decoded.offset !== bytes.length) return null;
  return { payload, signature };
}

type Cbor = number | Uint8Array | string | Cbor[] | Map<Cbor, Cbor> | null | boolean;

function decodeCbor(data: Uint8Array, offset = 0, depth = 0): { value: Cbor; offset: number } | null {
  if (depth > MAX_CBOR_DEPTH || offset >= data.length) return null;
  const initial = data[offset]!;
  const major = initial >> 5;
  const additional = initial & 0x1f;
  let cursor = offset + 1;
  const readLen = (): number | null => {
    if (additional < 24) return additional;
    if (additional === 24) {
      if (cursor >= data.length) return null;
      return data[cursor++]!;
    }
    if (additional === 25) {
      if (cursor + 1 >= data.length) return null;
      const value = (data[cursor]! << 8) | data[cursor + 1]!;
      cursor += 2;
      return value;
    }
    if (additional === 26) {
      if (cursor + 3 >= data.length) return null;
      const value =
        (data[cursor]! * 2 ** 24) +
        (data[cursor + 1]! << 16) +
        (data[cursor + 2]! << 8) +
        data[cursor + 3]!;
      cursor += 4;
      return value;
    }
    return null;
  };
  if (major === 0) {
    const value = readLen();
    if (value === null) return null;
    return { value, offset: cursor };
  }
  if (major === 1) {
    const value = readLen();
    if (value === null) return null;
    return { value: -1 - value, offset: cursor };
  }
  if (major === 2 || major === 3) {
    const len = readLen();
    if (len === null || cursor + len > data.length) return null;
    const slice = data.slice(cursor, cursor + len);
    cursor += len;
    if (major === 2) return { value: slice, offset: cursor };
    return { value: new TextDecoder().decode(slice), offset: cursor };
  }
  if (major === 4) {
    const len = readLen();
    if (len === null || len > data.length - cursor) return null;
    const items: Cbor[] = [];
    for (let i = 0; i < len; i++) {
      const item = decodeCbor(data, cursor, depth + 1);
      if (!item) return null;
      items.push(item.value);
      cursor = item.offset;
    }
    return { value: items, offset: cursor };
  }
  if (major === 5) {
    const len = readLen();
    if (len === null || len * 2 > data.length - cursor) return null;
    const map = new Map<Cbor, Cbor>();
    for (let i = 0; i < len; i++) {
      const key = decodeCbor(data, cursor, depth + 1);
      if (!key) return null;
      const value = decodeCbor(data, key.offset, depth + 1);
      if (!value) return null;
      map.set(key.value, value.value);
      cursor = value.offset;
    }
    return { value: map, offset: cursor };
  }
  if (initial === 0xf6) return { value: null, offset: cursor };
  if (initial === 0xf4) return { value: false, offset: cursor };
  if (initial === 0xf5) return { value: true, offset: cursor };
  return null;
}

async function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      bytesToArrayBuffer(publicKey),
      { name: 'Ed25519' } as AlgorithmIdentifier,
      false,
      ['verify']
    );
    return crypto.subtle.verify(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      key,
      bytesToArrayBuffer(signature),
      bytesToArrayBuffer(message)
    );
  } catch {
    return false;
  }
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
