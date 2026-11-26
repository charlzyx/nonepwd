import { describe, expect, it } from 'vitest';
import { signChallenge } from '@nonepwd/agent-relay';
import { AgentRelayHub } from '../src/agent-relay-do.js';
import { createCfApp } from '../src/app.js';
import { createMockCfEnv } from './helpers.js';

describe('cloudflare agent relay route', () => {
  it('asks for a websocket upgrade and a Durable Object binding', async () => {
    const { env } = createMockCfEnv();
    const app = createCfApp();
    const plain = await app.fetch(new Request('https://vault.example.com/agent/relay'), env);
    expect(plain.status).toBe(426);

    const upgrade = await app.fetch(
      new Request('https://vault.example.com/agent/relay', {
        headers: { upgrade: 'websocket' },
      }),
      env
    );
    expect(upgrade.status).toBe(501);
    const body = (await upgrade.json()) as { error: string };
    expect(body.error).toContain('AGENT_RELAY');
  });

  it('handles GetRendezvous string, guards OOM pseudo-arrays, and preserves DO alarm scheduling', async () => {
    const { env } = createMockCfEnv();
    const kv = new Map<string, unknown>();
    let currentAlarm: number | null = null;
    let setAlarmCalls = 0;
    const sockets: Array<{
      attachment: unknown;
      sent: string[];
      closed: boolean;
      serializeAttachment(v: unknown): void;
      deserializeAttachment(): unknown;
      send(t: string): void;
      close(): void;
    }> = [];

    const makeMockWs = () => {
      const ws = {
        attachment: null as unknown,
        sent: [] as string[],
        closed: false,
        serializeAttachment(v: unknown) {
          this.attachment = v;
        },
        deserializeAttachment() {
          return this.attachment;
        },
        send(t: string) {
          this.sent.push(t);
        },
        close() {
          this.closed = true;
        },
      };
      sockets.push(ws);
      return ws as unknown as WebSocket;
    };

    const ctx = {
      acceptWebSocket() {},
      getWebSockets: () => sockets.filter((s) => !s.closed) as unknown as WebSocket[],
      storage: {
        async getAlarm() {
          return currentAlarm;
        },
        async setAlarm(ts: number) {
          setAlarmCalls += 1;
          currentAlarm = ts;
        },
        async get<T>(k: string) {
          return kv.get(k) as T | undefined;
        },
        async put(k: string, v: unknown) {
          kv.set(k, v);
        },
        async delete(k: string) {
          return kv.delete(k);
        },
        async list<T>(opts?: { prefix?: string }) {
          const out = new Map<string, T>();
          for (const [k, v] of kv) {
            if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v as T);
          }
          return out;
        },
      },
    } as unknown as DurableObjectState;

    const hub = new AgentRelayHub(ctx, env);
    const ws = makeMockWs();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    ws.serializeAttachment({ phase: 'auth', challenge: [...challenge], openedAt: Date.now() });

    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign']);
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const auth = await signChallenge(keys.privateKey, pub, challenge);
    await hub.webSocketMessage(ws, auth.authMessage);

    // Primitive & pseudo-array payloads do not throw or OOM
    await hub.webSocketMessage(ws, 'null');
    await hub.webSocketMessage(
      ws,
      JSON.stringify({ Send: { destination: { length: 2_147_483_647 }, payload: [] } })
    );

    // Unit-variant "GetRendezvous" string works
    await hub.webSocketMessage(ws, JSON.stringify('GetRendezvous'));
    expect(sockets[0]!.sent).toHaveLength(1);
    const rv = (JSON.parse(sockets[0]!.sent[0]!) as { RendezvousInfo: { code: string } })
      .RendezvousInfo.code;
    expect(rv).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/);

    // Close all sockets; alarm() must still reschedule because rv: key remains active
    sockets[0]!.close();
    currentAlarm = null;
    const beforeCalls = setAlarmCalls;
    await hub.alarm();
    expect(setAlarmCalls).toBe(beforeCalls + 1);
    expect(currentAlarm).not.toBeNull();
  });
});
