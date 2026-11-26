import { runScheduledImapSync } from './app.js';
import { IMAP_ALARM_FOLLOWUP_MS, IMAP_ALARM_SOON_MS, ensureImapAlarm, nextImapAlarmAt } from './imap-alarm.js';
import type { CfServerEnv } from './types.js';

interface WsAttachment {
  kind: 'owner' | 'service_account';
  allowedVaultIds: string[];
  tokenHash: string;
  serviceAccountId?: string;
  expiresAt: number;
}

export interface BroadcastOptions {
  vaultId?: string;
  ownerOnly?: boolean;
}

export interface RevokeWsFilter {
  tokenHash?: string;
  serviceAccountId?: string;
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

    if (url.pathname === '/imap-alarm') {
      if (url.searchParams.get('soon') === '1') {
        await this.ctx.storage.setAlarm(Date.now() + IMAP_ALARM_SOON_MS);
        return Response.json({ ok: true, armed: true, soon: true });
      }
      const armed = await ensureImapAlarm(this.ctx.storage);
      return Response.json({ ok: true, armed });
    }

    if (url.pathname === '/upgrade') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const kindHeader = request.headers.get('x-np-auth-kind');
      if (kindHeader !== 'owner' && kindHeader !== 'service_account') {
        return new Response('Unauthorized', { status: 401 });
      }
      const kind: WsAttachment['kind'] = kindHeader;

      const tokenHash = request.headers.get('x-np-token-hash')?.trim() ?? '';
      const expiresAtRaw = request.headers.get('x-np-expires-at');
      const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : Number.NaN;
      const serviceAccountId = request.headers.get('x-np-service-account-id')?.trim() || undefined;
      if (!tokenHash || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (kind === 'service_account' && !serviceAccountId) {
        return new Response('Unauthorized', { status: 401 });
      }

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
      const attachment: WsAttachment = {
        kind,
        allowedVaultIds,
        tokenHash,
        ...(serviceAccountId ? { serviceAccountId } : {}),
        expiresAt,
      };
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

    if (url.pathname === '/revoke' && request.method === 'POST') {
      const filter = (await request.json()) as RevokeWsFilter;
      let closed = 0;
      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as WsAttachment | null;
        if (!attachment) continue;
        const matchToken = Boolean(filter.tokenHash && attachment.tokenHash === filter.tokenHash);
        const matchSa = Boolean(
          filter.serviceAccountId && attachment.serviceAccountId === filter.serviceAccountId
        );
        if (matchToken || matchSa) {
          try {
            ws.close(1008, 'Session revoked');
          } catch {
            // ignore
          }
          closed += 1;
        }
      }
      return Response.json({ closed });
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
      const now = Date.now();
      let delivered = 0;

      for (const ws of this.ctx.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as WsAttachment | null;
        if (!attachment || !Number.isFinite(attachment.expiresAt) || attachment.expiresAt <= now) {
          try {
            ws.close(1008, 'Session expired');
          } catch {
            // ignore
          }
          continue;
        }

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

  /**
   * Replaces the Free-plan Cron Trigger. The next alarm is stored before the
   * pull so a CPU kill still leaves a future run. The pull itself stays on the
   * same 1–2 message / validity-window / backoff path as a manual sync.
   */
  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(nextImapAlarmAt());
    try {
      const { moreDue } = await runScheduledImapSync(this.env);
      if (moreDue) {
        await this.ctx.storage.setAlarm(Date.now() + IMAP_ALARM_FOLLOWUP_MS);
      }
    } catch (err) {
      console.error('imap alarm failed', err instanceof Error ? err.message : String(err));
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

export async function revokeWsSessions(
  env: CfServerEnv,
  filter: RevokeWsFilter
): Promise<void> {
  if (!env.WS_HUB) return;
  try {
    const id = env.WS_HUB.idFromName('global');
    const stub = env.WS_HUB.get(id);
    await stub.fetch('https://do.internal/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filter),
    });
  } catch {
    // Best-effort WS session revocation
  }
}
