import { describe, expect, it } from 'vitest';
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
});
