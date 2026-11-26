import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { authenticateToken, extractBearerToken, type AuthContext } from './auth.js';
import type { NonePwdDb } from './db.js';

interface ConnectedClient {
  ws: WebSocket;
  auth: AuthContext;
}

export interface WsHub {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  broadcast(event: Record<string, unknown>, options?: { vaultId?: string; ownerOnly?: boolean }): void;
  closeByTokenHash(tokenHash: string): void;
  closeByServiceAccount(serviceAccountId: string): void;
  clientCount(): number;
  closeAll(): void;
}

export function createWsHub(db: NonePwdDb): WsHub {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<ConnectedClient>();

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, auth: AuthContext) => {
    const client: ConnectedClient = { ws, auth };
    clients.add(client);
    ws.send(JSON.stringify({ type: 'hello', kind: auth.kind, timestamp: new Date().toISOString() }));

    ws.on('close', () => {
      clients.delete(client);
    });
    ws.on('error', () => {
      clients.delete(client);
    });
  });

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/ws') {
        socket.destroy();
        return;
      }

      const token =
        url.searchParams.get('token') ?? extractBearerToken(req.headers.authorization);
      const auth = authenticateToken(db, token);
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, auth);
      });
    },

    broadcast(event, options) {
      const serialized = JSON.stringify(event);
      const now = Date.now();
      for (const client of clients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        if (client.auth.expiresAt <= now) {
          clients.delete(client);
          try {
            client.ws.close(1008, 'Session expired');
          } catch {
            // ignore
          }
          continue;
        }
        if (options?.ownerOnly && client.auth.kind !== 'owner') continue;
        if (
          options?.vaultId &&
          client.auth.kind === 'service_account' &&
          !client.auth.allowedVaultIds.has(options.vaultId)
        ) {
          continue;
        }
        client.ws.send(serialized);
      }
    },

    closeByTokenHash(tokenHash: string) {
      for (const client of clients) {
        if (client.auth.tokenHash === tokenHash) {
          clients.delete(client);
          try {
            client.ws.close(1008, 'Session revoked');
          } catch {
            // ignore
          }
        }
      }
    },

    closeByServiceAccount(serviceAccountId: string) {
      for (const client of clients) {
        if (
          client.auth.kind === 'service_account' &&
          client.auth.serviceAccountId === serviceAccountId
        ) {
          clients.delete(client);
          try {
            client.ws.close(1008, 'Service account revoked');
          } catch {
            // ignore
          }
        }
      }
    },

    clientCount(): number {
      return clients.size;
    },

    closeAll() {
      for (const client of clients) {
        try {
          client.ws.close();
        } catch {
          // ignore
        }
      }
      clients.clear();
      wss.close();
    },
  };
}
