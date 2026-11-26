import {
  generateRendezvousCode,
  isGetRendezvousMessage,
  parseByteArray,
  verifyAuthResponse,
} from '@nonepwd/agent-relay';
import type { CfServerEnv } from './types.js';

const AUTH_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 120_000;
const RENDEZVOUS_TTL_MS = 300_000;
const MAX_RENDEZVOUS_PER_FINGERPRINT = 8;
const DESTINATION_BYTES = 32;
const MAX_PAYLOAD_BYTES = 65_536;

interface AuthAttachment {
  phase: 'auth';
  challenge: number[];
  openedAt: number;
}

interface ReadyAttachment {
  phase: 'ready';
  fingerprint: string;
  identity: number[];
  seenAt: number;
}

type Attachment = AuthAttachment | ReadyAttachment;

interface StoredRendezvous {
  fingerprint: string;
  createdAt: number;
  used: boolean;
}

/**
 * One Durable Object holds both WebSocket ends of the agent-access relay.
 * Hibernation keeps the authenticated fingerprint on the socket attachment.
 * The object only forwards ciphertext.
 */
export class AgentRelayHub implements DurableObject {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: CfServerEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const attachment: AuthAttachment = {
      phase: 'auth',
      challenge: [...challenge],
      openedAt: Date.now(),
    };
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ AuthChallenge: attachment.challenge }));
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const attachment = (ws.deserializeAttachment() as Attachment | null) ?? null;
    if (!attachment) {
      ws.close(1008, 'missing session');
      return;
    }
    if (attachment.phase === 'auth') {
      if (Date.now() - attachment.openedAt > AUTH_TIMEOUT_MS) {
        ws.close(1008, 'auth timeout');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        ws.close(1008, 'bad auth');
        return;
      }
      const verified = await verifyAuthResponse(Uint8Array.from(attachment.challenge), parsed);
      if (!verified) {
        ws.close(1008, 'auth failed');
        return;
      }
      const ready: ReadyAttachment = {
        phase: 'ready',
        fingerprint: verified.fingerprintHex,
        identity: verified.identity,
        seenAt: Date.now(),
      };
      ws.serializeAttachment(ready);
      return;
    }

    const ready: ReadyAttachment = { ...attachment, seenAt: Date.now() };
    ws.serializeAttachment(ready);
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    if (isGetRendezvousMessage(parsed)) {
      const now = Date.now();
      const existing = await this.ctx.storage.list<StoredRendezvous>({ prefix: 'rv:' });
      const activeForFp: Array<[string, StoredRendezvous]> = [];
      for (const [k, v] of existing) {
        if (v.used || now - v.createdAt > RENDEZVOUS_TTL_MS) {
          await this.ctx.storage.delete(k);
        } else if (v.fingerprint === ready.fingerprint) {
          activeForFp.push([k, v]);
        }
      }
      if (activeForFp.length >= MAX_RENDEZVOUS_PER_FINGERPRINT) {
        activeForFp.sort((a, b) => a[1].createdAt - b[1].createdAt);
        const excess = activeForFp.length - MAX_RENDEZVOUS_PER_FINGERPRINT + 1;
        for (let i = 0; i < excess; i++) {
          await this.ctx.storage.delete(activeForFp[i]![0]);
        }
      }
      let code: string | null = null;
      for (let i = 0; i < 16; i++) {
        const candidate = generateRendezvousCode();
        if (!existing.has(`rv:${candidate}`)) {
          code = candidate;
          break;
        }
      }
      if (!code) return;
      const record: StoredRendezvous = {
        fingerprint: ready.fingerprint,
        createdAt: now,
        used: false,
      };
      await this.ctx.storage.put(`rv:${code}`, record);
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(now + 60_000);
      }
      ws.send(JSON.stringify({ RendezvousInfo: { code } }));
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const msg = parsed as Record<string, unknown>;

    if ('GetIdentity' in msg) {
      const body = msg.GetIdentity;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return;
      const code = (body as { code?: unknown }).code;
      if (typeof code !== 'string' || code.length === 0 || code.length > 32) return;
      const record = await this.ctx.storage.get<StoredRendezvous>(`rv:${code}`);
      if (!record) return;
      if (record.used || Date.now() - record.createdAt > RENDEZVOUS_TTL_MS) {
        await this.ctx.storage.delete(`rv:${code}`);
        return;
      }
      record.used = true;
      await this.ctx.storage.put(`rv:${code}`, record);
      const target = this.socketForFingerprint(record.fingerprint);
      if (!target) return;
      const targetAttachment = target.deserializeAttachment() as ReadyAttachment;
      ws.send(
        JSON.stringify({
          IdentityInfo: {
            fingerprint: hexToBytes(record.fingerprint),
            identity: { cose_key_bytes: targetAttachment.identity },
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
      const text = JSON.stringify({
        Send: {
          source: hexToBytes(ready.fingerprint),
          destination: [...destBytes],
          payload: [...payloadBytes],
        },
      });
      for (const peer of this.ctx.getWebSockets()) {
        const peerAttachment = peer.deserializeAttachment() as Attachment | null;
        if (peerAttachment?.phase === 'ready' && peerAttachment.fingerprint === destination) {
          peer.send(text);
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      // already closed
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) {
        ws.close(1000, 'idle');
        continue;
      }
      const seen = attachment.phase === 'auth' ? attachment.openedAt : attachment.seenAt;
      const limit = attachment.phase === 'auth' ? AUTH_TIMEOUT_MS : IDLE_TIMEOUT_MS;
      if (now - seen > limit) ws.close(1000, 'idle');
    }
    const keys = await this.ctx.storage.list<StoredRendezvous>({ prefix: 'rv:' });
    let remainingKeys = 0;
    for (const [key, value] of keys) {
      if (now - value.createdAt > RENDEZVOUS_TTL_MS) {
        await this.ctx.storage.delete(key);
      } else {
        remainingKeys += 1;
      }
    }
    if (this.ctx.getWebSockets().length > 0 || remainingKeys > 0) {
      await this.ctx.storage.setAlarm(now + 60_000);
    }
  }

  private socketForFingerprint(fingerprint: string): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.phase === 'ready' && attachment.fingerprint === fingerprint) return ws;
    }
    return undefined;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}
