import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { signChallenge } from '@nonepwd/agent-relay';
import { createNonePwdServer, type NonePwdServerInstance } from '../src/app.js';

const servers: NonePwdServerInstance[] = [];

afterEach(async () => {
  while (servers.length) {
    await servers.pop()!.close();
  }
});

describe('node agent-access relay', () => {
  it('authenticates both ends and forwards one ciphertext payload', async () => {
    const srv = createNonePwdServer();
    servers.push(srv);
    const started = await srv.start(0, '127.0.0.1');
    const url = started.url.replace(/^http/, 'ws') + '/agent/relay';

    const a = await openAuthed(url);
    const b = await openAuthed(url);
    const payload = [9, 8, 7, 6];
    const destination = hexToBytes(b.fingerprintHex);
    const received = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no forwarded frame')), 5_000);
      b.ws.on('message', (data) => {
        const text = data.toString();
        if (text.includes('"Send"')) {
          clearTimeout(timer);
          resolve(text);
        }
      });
    });
    a.ws.send(JSON.stringify({ Send: { destination, payload } }));
    const forwarded = JSON.parse(await received) as {
      Send: { source: number[]; payload: number[] };
    };
    expect(forwarded.Send.payload).toEqual(payload);
    expect(bytesToHex(Uint8Array.from(forwarded.Send.source))).toBe(a.fingerprintHex);
    a.ws.close();
    b.ws.close();
  });
});

async function openAuthed(url: string): Promise<{
  ws: WebSocket;
  fingerprintHex: string;
}> {
  const ws = new WebSocket(url);
  const challenge = await new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no challenge')), 5_000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      const parsed = JSON.parse(data.toString()) as { AuthChallenge: number[] };
      resolve(Uint8Array.from(parsed.AuthChallenge));
    });
    ws.once('error', reject);
  });
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const auth = await signChallenge(keys.privateKey, publicKey, challenge);
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('auth was not accepted')), 5_000);
    ws.on('message', (data) => {
      const text = data.toString();
      if (text.includes('RendezvousInfo')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  ws.send(auth.authMessage);
  ws.send(JSON.stringify({ GetRendezvous: null }));
  await ready;
  return { ws, fingerprintHex: auth.fingerprintHex };
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
