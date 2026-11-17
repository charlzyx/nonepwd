import type { CfServerEnv } from './types.js';

interface WsAttachment {
  kind: 'owner' | 'service_account';
  allowedVaultIds: string[];
}

export interface BroadcastOptions {
  vaultId?: string;
  ownerOnly?: boolean;
}

/**
 * Durable Object coordinating real-time WebSocket push notifications using the
 * Cloudflare Workers WebSocket Hibernation API.
 */
export class VaultWsHub implements DurableObject {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: CfServerEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/upgrade') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const kindHeader = request.headers.get('x-np-auth-kind');
      const kind: WsAttachment['kind'] =
        kindHeader === 'service_account' ? 'service_account' : 'owner';

      let allowedVaultIds: string[] = [];
      const vaultsHeader = request.headers.get('x-np-allowed-vaults');
      if (vaultsHeader) {
        try {
          const parsed = JSON.parse(vaultsHeader);
          if (Array.isArray(parsed)) {
            allowedVaultIds = parsed.filter((x): x is string => typeof x === 'string');
          }
        } catch {
          allowedVaultIds = vaultsHeader
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.ctx.acceptWebSocket(server);
      const attachment: WsAttachment = { kind, allowedVaultIds };
      server.serializeAttachment(attachment);

      try {
        server.send(
          JSON.stringify({
            type: 'hello',
            kind,
            timestamp: new Date().toISOString(),
          })
        );
      } catch {
        // ignore transient send failures before client reads
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const body = (await request.json()) as {
        event?: Record<string, unknown>;
        options?: BroadcastOptions;
      };
      if (!body.event) {
        return Response.json({ delivered: 0 }, { status: 400 });
      }

      const serialized = JSON.stringify(body.event);
      const options = body.options;
      let delivered = 0;

      for (const ws of this.ctx.getWebSockets()) {
        const attachment = (ws.deserializeAttachment() as WsAttachment | null) ?? {
          kind: 'owner',
          allowedVaultIds: [],
        };

        if (options?.ownerOnly && attachment.kind !== 'owner') {
          continue;
        }
        if (
          options?.vaultId &&
          attachment.kind === 'service_account' &&
          !attachment.allowedVaultIds.includes(options.vaultId)
        ) {
          continue;
        }

        try {
          ws.send(serialized);
          delivered += 1;
        } catch {
          try {
            ws.close(1011, 'Send failed');
          } catch {
            // ignore
          }
        }
      }

      return Response.json({ delivered });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const trimmed = message.trim();
    if (trimmed === 'ping' || trimmed === '{"type":"ping"}') {
      try {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      } catch {
        // ignore
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // ignore
    }
  }
}

export async function broadcastEvent(
  env: CfServerEnv,
  event: Record<string, unknown>,
  options?: BroadcastOptions
): Promise<void> {
  if (!env.WS_HUB) return;
  try {
    const id = env.WS_HUB.idFromName('global');
    const stub = env.WS_HUB.get(id);
    await stub.fetch('https://do.internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, options }),
    });
  } catch {
    // WebSocket broadcast is best-effort so core D1 mutations never fail
  }
}
