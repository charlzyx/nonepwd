import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AgentRelay,
  bytesToHex,
  encodeCoseSign1,
  encodeOkpPublicKey,
  signChallenge,
  verifyAuthResponse,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

class FakeSocket {
  sent: string[] = [];
  closed = false;
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
}

describe('agent-access relay', () => {
  it('verifies a COSE_Sign1 produced by ap-relay-protocol', async () => {
    const fixture = JSON.parse(
      readFileSync(join(here, 'fixtures/ed25519-auth.json'), 'utf8')
    ) as {
      challengeMessage: string;
      authResponseMessage: string;
      publicKey: number[];
      fingerprintHex: string;
    };
    const challenge = Uint8Array.from(
      (JSON.parse(fixture.challengeMessage) as { AuthChallenge: number[] }).AuthChallenge
    );
    const message = JSON.parse(fixture.authResponseMessage) as Record<string, unknown>;
    const verified = await verifyAuthResponse(challenge, message);
    expect(verified).not.toBeNull();
    expect(verified!.fingerprintHex).toBe(fixture.fingerprintHex);
    expect([...verified!.publicKey]).toEqual(fixture.publicKey);
    expect(bytesToHex(verified!.publicKey)).toBe(
      bytesToHex(Uint8Array.from(fixture.publicKey))
    );

    const forged = structuredClone(message) as {
      AuthResponse: [{ cose_key_bytes: number[] }, { cose_sign1_bytes: number[] }];
    };
    forged.AuthResponse[1].cose_sign1_bytes[forged.AuthResponse[1].cose_sign1_bytes.length - 1]! ^=
      0xff;
    expect(await verifyAuthResponse(challenge, forged)).toBeNull();
  });

  it('encodes the coset OKP and COSE_Sign1 prefixes', () => {
    const key = new Uint8Array(32).fill(7);
    const sig = new Uint8Array(64).fill(9);
    const payload = new Uint8Array(32).fill(3);
    expect([...encodeOkpPublicKey(key).slice(0, 10)]).toEqual([
      0xa4, 0x01, 0x01, 0x03, 0x27, 0x20, 0x27, 0x21, 0x58, 0x20,
    ]);
    expect([...encodeCoseSign1(payload, sig).slice(0, 6)]).toEqual([
      0x84, 0x43, 0xa1, 0x01, 0x27, 0xa0,
    ]);
  });

  it('forwards ciphertext after approval of the signature and drops a bad one', async () => {
    const relay = new AgentRelay();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const aConn = relay.open(a);
    const bConn = relay.open(b);
    const aChallenge = Uint8Array.from(
      (JSON.parse(a.sent[0]!) as { AuthChallenge: number[] }).AuthChallenge
    );
    const bChallenge = Uint8Array.from(
      (JSON.parse(b.sent[0]!) as { AuthChallenge: number[] }).AuthChallenge
    );
    const aKeys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign']);
    const bKeys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign']);
    const aPub = new Uint8Array(await crypto.subtle.exportKey('raw', aKeys.publicKey));
    const bPub = new Uint8Array(await crypto.subtle.exportKey('raw', bKeys.publicKey));
    const aAuth = await signChallenge(aKeys.privateKey, aPub, aChallenge);
    const bAuth = await signChallenge(bKeys.privateKey, bPub, bChallenge);
    aConn.onMessage(aAuth.authMessage);
    bConn.onMessage(bAuth.authMessage);
    await waitFor(() => aConn.isAuthenticated() && bConn.isAuthenticated());
    expect(aConn.isAuthenticated()).toBe(true);
    expect(bConn.isAuthenticated()).toBe(true);

    const payload = [1, 2, 3, 9];
    const destination = [...(await sha256(bPub))];
    aConn.onMessage(JSON.stringify({ Send: { destination, payload } }));
    await waitFor(() => b.sent.length > 1);
    const forwarded = JSON.parse(b.sent.at(-1)!) as {
      Send: { source: number[]; destination: number[]; payload: number[] };
    };
    expect(forwarded.Send.payload).toEqual(payload);
    expect(forwarded.Send.destination).toEqual(destination);
    expect(bytesToHex(Uint8Array.from(forwarded.Send.source))).toBe(aAuth.fingerprintHex);

    const liar = new FakeSocket();
    const liarConn = relay.open(liar);
    const liarChallenge = Uint8Array.from(
      (JSON.parse(liar.sent[0]!) as { AuthChallenge: number[] }).AuthChallenge
    );
    const other = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign']);
    const otherPub = new Uint8Array(await crypto.subtle.exportKey('raw', other.publicKey));
    const signedByOther = await signChallenge(other.privateKey, otherPub, liarChallenge);
    const body = JSON.parse(signedByOther.authMessage) as {
      AuthResponse: [{ cose_key_bytes: number[] }, { cose_sign1_bytes: number[] }];
    };
    // Claim Alice's public key while the signature was produced by a different key.
    body.AuthResponse[0].cose_key_bytes = [...encodeOkpPublicKey(aPub)];
    liarConn.onMessage(JSON.stringify(body));
    await waitFor(() => liar.closed);
    expect(liar.closed).toBe(true);
    expect(liarConn.isAuthenticated()).toBe(false);
  });
});

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for relay state');
}
