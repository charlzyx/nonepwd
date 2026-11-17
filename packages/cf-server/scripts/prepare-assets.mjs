import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(__dirname, '..');
const rootDir = path.resolve(pkgDir, '..', '..');

const rustWasmPath = path.join(
  rootDir,
  'target',
  'wasm32-unknown-unknown',
  'release',
  'nonepwd_core.wasm'
);
const embeddedTsPath = path.join(rootDir, 'packages', 'core', 'src', 'wasm-embedded.ts');
const srcWasmPath = path.join(pkgDir, 'src', 'nonepwd_core.wasm');
const distWasmPath = path.join(pkgDir, 'dist', 'nonepwd_core.wasm');
const webDistDir = path.join(rootDir, 'packages', 'web', 'dist');
const binDistDir = path.join(rootDir, 'dist', 'bin');
const publicDir = path.join(pkgDir, 'public');

function ensureWasmBytes() {
  if (fs.existsSync(rustWasmPath)) {
    fs.copyFileSync(rustWasmPath, srcWasmPath);
    return;
  }
  if (fs.existsSync(embeddedTsPath)) {
    const content = fs.readFileSync(embeddedTsPath, 'utf8');
    const match = content.match(/NONEPWD_CORE_WASM_B64\s*=\s*"([^"]+)"/);
    if (match?.[1]) {
      fs.writeFileSync(srcWasmPath, Buffer.from(match[1], 'base64'));
      return;
    }
  }
  if (!fs.existsSync(srcWasmPath)) {
    throw new Error(
      'Could not locate nonepwd_core.wasm. Run `pnpm build:rust` first.'
    );
  }
}

const mode = process.argv.includes('--post') ? 'post' : 'pre';

if (mode === 'pre') {
  ensureWasmBytes();
} else {
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  if (fs.existsSync(srcWasmPath)) {
    fs.copyFileSync(srcWasmPath, distWasmPath);
  }

  fs.rmSync(publicDir, { recursive: true, force: true });
  fs.mkdirSync(publicDir, { recursive: true });

  if (fs.existsSync(path.join(webDistDir, 'index.html'))) {
    fs.cpSync(webDistDir, publicDir, { recursive: true });
  }

  const downloadsDir = path.join(publicDir, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  for (const filename of ['nonepwd-extension.zip', 'np-darwin-arm64', 'np-linux-x86_64']) {
    const src = path.join(binDistDir, filename);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(downloadsDir, filename));
    }
  }
}
