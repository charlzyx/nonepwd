import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNonePwdServer } from './app.js';

export * from './app.js';
export * from './auth.js';
export * from './db.js';
export * from './email-ingest.js';
export * from './imap-worker.js';
export * from './ws.js';

const isDirectEntry =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectEntry) {
  const port = Number.parseInt(process.env.NONEPWD_PORT ?? process.env.PORT ?? '8787', 10);
  const host = process.env.NONEPWD_HOST ?? '0.0.0.0';
  const server = createNonePwdServer();

  const started = await server.start(port, host);
  console.log(`nonepwd server listening on http://${host}:${started.port}`);
  console.log(`Autofill playground ready at http://127.0.0.1:${started.port}/demo-login`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
