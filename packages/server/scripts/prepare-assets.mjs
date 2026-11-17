import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '../..');

const srcWebDist = path.join(repoRoot, 'packages', 'web', 'dist');
const dstWebDist = path.join(pkgRoot, 'web-dist');
if (fs.existsSync(srcWebDist)) {
  fs.rmSync(dstWebDist, { recursive: true, force: true });
  fs.cpSync(srcWebDist, dstWebDist, { recursive: true });
}

const srcExtZip = path.join(repoRoot, 'dist', 'bin', 'nonepwd-extension.zip');
const dstBinDir = path.join(pkgRoot, 'bin-dist');
if (fs.existsSync(srcExtZip)) {
  fs.rmSync(dstBinDir, { recursive: true, force: true });
  fs.mkdirSync(dstBinDir, { recursive: true });
  fs.copyFileSync(srcExtZip, path.join(dstBinDir, 'nonepwd-extension.zip'));
}

const binEntry = path.join(pkgRoot, 'dist', 'index.js');
if (fs.existsSync(binEntry) && process.platform !== 'win32') {
  fs.chmodSync(binEntry, 0o755);
}
