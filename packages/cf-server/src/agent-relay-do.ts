import { verifyAuthResponse } from '@nonepwd/agent-relay';
import type { CfServerEnv } from './types.js';

const AUTH_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 120_000;
const RENDEZVOUS_TTL_MS = 300_000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

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
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
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
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(message) as Record<string, unknown>;
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
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }

    if ('GetRendezvous' in parsed) {
      const code = freshCode();
      const record: StoredRendezvous = {
        fingerprint: ready.fingerprint,
        createdAt: Date.now(),
        used: false,
      };
      await this.ctx.storage.put(`rv:${code}`, record);
      ws.send(JSON.stringify({ RendezvousInfo: { code } }));
      return;
    }

    if ('GetIdentity' in parsed) {
      const body = parsed.GetIdentity as { code?: string } | null;
      const code = body?.code ?? '';
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

    if ('Send' in parsed) {
      const body = parsed.Send as { destination?: number[]; payload?: number[] } | null;
      if (!body?.destination || !body.payload) return;
      const destination = bytesToHex(Uint8Array.from(body.destination));
      const text = JSON.stringify({
        Send: {
          source: hexToBytes(ready.fingerprint),
          destination: body.destination,
          payload: body.payload,
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
    for (const [key, value] of keys) {
      if (now - value.createdAt > RENDEZVOUS_TTL_MS) await this.ctx.storage.delete(key);
    }
    if (this.ctx.getWebSockets().length > 0) {
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

function freshCode(): string {
  const raw = crypto.getRandomValues(new Uint8Array(9));
  let code = '';
  for (let i = 0; i < 9; i++) code += ALPHABET[raw[i]! % ALPHABET.length];
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}
