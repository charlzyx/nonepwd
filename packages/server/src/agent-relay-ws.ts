import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { AgentRelay } from '@nonepwd/agent-relay';

const AUTH_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 120_000;

export interface NodeAgentRelay {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

export function createNodeAgentRelay(): NodeAgentRelay {
  const relay = new AgentRelay();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const sweep = setInterval(() => relay.sweep(), 30_000);
  sweep.unref?.();

  wss.on('connection', (ws: WebSocket) => {
    const conn = relay.open({
      send: (text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close: () => {
        try {
          ws.close();
        } catch {
          // already closed
        }
      },
    });

    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (ms: number) => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        if (!conn.isAuthenticated() || ms === IDLE_TIMEOUT_MS) ws.close();
      }, ms);
    };
    armIdle(AUTH_TIMEOUT_MS);

    ws.on('message', (data, isBinary) => {
      armIdle(IDLE_TIMEOUT_MS);
      if (isBinary) return;
      conn.onMessage(data.toString());
    });
    ws.on('ping', () => armIdle(IDLE_TIMEOUT_MS));
    ws.on('pong', () => armIdle(IDLE_TIMEOUT_MS));
    ws.on('close', () => {
      if (idle) clearTimeout(idle);
      conn.onClose();
    });
    ws.on('error', () => {
      if (idle) clearTimeout(idle);
      conn.onClose();
    });
  });

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    },
    close() {
      clearInterval(sweep);
      wss.close();
    },
  };
}
