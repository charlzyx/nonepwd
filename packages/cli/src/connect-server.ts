import crypto from 'node:crypto';
import http from 'node:http';
import { generateTotp } from '@nonepwd/core';
import type { NonePwdCliClient } from './client.js';

export interface ConnectServerOptions {
  client: NonePwdCliClient;
  host?: string;
  port?: number;
  connectToken: string;
}

export interface ConnectServerInstance {
  server: http.Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function startConnectServer(
  options: ConnectServerOptions
): Promise<ConnectServerInstance> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8788;
  const expectedTokenBuf = Buffer.from(options.connectToken, 'utf8');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);

      if (url.pathname === '/v1/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const authHeader = req.headers.authorization ?? '';
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      const provided = match ? Buffer.from(match[1].trim(), 'utf8') : null;
      if (
        !provided ||
        provided.length !== expectedTokenBuf.length ||
        !crypto.timingSafeEqual(provided, expectedTokenBuf)
      ) {
        sendJson(res, 401, { error: 'Unauthorized Connect token' });
        return;
      }

      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      if (url.pathname === '/v1/vaults') {
        await options.client.sync();
        sendJson(res, 200, {
          vaults: options.client.vaults.map((v) => ({
            id: v.id,
            name: v.metadata.name,
            description: v.metadata.description ?? null,
          })),
        });
        return;
      }

      const itemsListMatch = url.pathname.match(/^\/v1\/vaults\/([^/]+)\/items$/);
      if (itemsListMatch) {
        await options.client.sync();
        const vault = options.client.findVault(decodeURIComponent(itemsListMatch[1]));
        const items = options.client.items
          .filter((i) => i.vaultId === vault.id)
          .map((i) => i.payload);
        sendJson(res, 200, { items });
        return;
      }

      const itemMatch = url.pathname.match(/^\/v1\/vaults\/([^/]+)\/items\/([^/]+)$/);
      if (itemMatch) {
        await options.client.sync();
        const item = options.client.findItem(
          decodeURIComponent(itemMatch[2]),
          decodeURIComponent(itemMatch[1])
        );
        sendJson(res, 200, { item: item.payload });
        return;
      }

      if (url.pathname === '/v1/resolve') {
        const ref = url.searchParams.get('ref');
        if (!ref) {
          sendJson(res, 400, { error: 'Missing ?ref=np://...' });
          return;
        }
        const value = await options.client.resolveSecretRef(ref);
        sendJson(res, 200, { ref, value });
        return;
      }

      const otpMatch = url.pathname.match(/^\/v1\/otp\/([^/]+)\/([^/]+)$/);
      if (otpMatch) {
        await options.client.sync();
        const item = options.client.findItem(
          decodeURIComponent(otpMatch[2]),
          decodeURIComponent(otpMatch[1])
        );
        if (!item.payload.totp) {
          sendJson(res, 404, { error: 'No TOTP configured on item' });
          return;
        }
        const totp = await generateTotp(item.payload.totp);
        sendJson(res, 200, totp);
        return;
      }

      if (url.pathname === '/v1/mail/otp') {
        const domain = url.searchParams.get('domain') ?? undefined;
        const alias = url.searchParams.get('alias') ?? undefined;
        const waitSeconds = Number.parseFloat(url.searchParams.get('waitSeconds') ?? '0');
        const clampedWait =
          Number.isFinite(waitSeconds) && waitSeconds > 0 ? Math.min(waitSeconds, 120) : 0;
        const email = await options.client.waitForEmailOtp({
          domain,
          alias,
          waitSeconds: clampedWait,
        });
        sendJson(res, 200, {
          otpCode: email.otpCode,
          from: email.from,
          to: email.to,
          subject: email.subject,
          receivedAt: email.receivedAt,
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    server,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
