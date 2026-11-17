import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDistDir = path.join(rootDir, 'packages', 'web', 'dist');
const binDistDir = path.join(rootDir, 'dist', 'bin');
const sitePublicDir = path.join(rootDir, 'site', 'public');

if (!fs.existsSync(path.join(webDistDir, 'index.html'))) {
  throw new Error('packages/web/dist not found. Run `pnpm --filter @nonepwd/web build` first.');
}

fs.rmSync(sitePublicDir, { recursive: true, force: true });
fs.mkdirSync(sitePublicDir, { recursive: true });
fs.cpSync(webDistDir, sitePublicDir, { recursive: true });

// Copy browser extension bundle (and native CLI binaries if built in dist/bin)
const downloadsDir = path.join(sitePublicDir, 'downloads');
fs.mkdirSync(downloadsDir, { recursive: true });
for (const filename of ['nonepwd-extension.zip', 'np-darwin-arm64', 'np-linux-x86_64']) {
  const src = path.join(binDistDir, filename);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(downloadsDir, filename));
  }
}

// Publish canonical single-source Agent docs at both /SKILL.md and /llms.txt
const skillSrc = path.join(rootDir, 'SKILL.md');
if (fs.existsSync(skillSrc)) {
  fs.copyFileSync(skillSrc, path.join(sitePublicDir, 'SKILL.md'));
  fs.copyFileSync(skillSrc, path.join(sitePublicDir, 'llms.txt'));
}

console.log(`Built Cloudflare site static assets in ${sitePublicDir}`);
