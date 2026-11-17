import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDistDir = path.join(rootDir, 'packages', 'web', 'dist');
const binDistDir = path.join(rootDir, 'dist', 'bin');
const demoLoginTs = path.join(rootDir, 'packages', 'server', 'src', 'demo-login.ts');
const sitePublicDir = path.join(rootDir, 'site', 'public');

if (!fs.existsSync(path.join(webDistDir, 'index.html'))) {
  throw new Error('packages/web/dist not found. Run `pnpm --filter @nonepwd/web build` first.');
}

fs.rmSync(sitePublicDir, { recursive: true, force: true });
fs.mkdirSync(sitePublicDir, { recursive: true });
fs.cpSync(webDistDir, sitePublicDir, { recursive: true });

// Static /demo-login/index.html (Node 18+ compatible, no TS loader required)
const demoSource = fs.readFileSync(demoLoginTs, 'utf8').replace(/^export\s+const\s+/, 'var ');
const demoHtml = vm.runInNewContext(`${demoSource}\nDEMO_LOGIN_HTML;`);
const demoDir = path.join(sitePublicDir, 'demo-login');
fs.mkdirSync(demoDir, { recursive: true });
fs.writeFileSync(path.join(demoDir, 'index.html'), demoHtml, 'utf8');

// Copy browser extension bundle (and native CLI binaries if built in dist/bin)
const downloadsDir = path.join(sitePublicDir, 'downloads');
fs.mkdirSync(downloadsDir, { recursive: true });
for (const filename of ['nonepwd-extension.zip', 'np-darwin-arm64', 'np-linux-x86_64']) {
  const src = path.join(binDistDir, filename);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(downloadsDir, filename));
  }
}

console.log(`Built Cloudflare site static assets in ${sitePublicDir}`);
