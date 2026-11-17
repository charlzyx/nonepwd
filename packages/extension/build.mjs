import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const iconsDir = path.join(distDir, 'icons');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, crcInput, crcBuf]);
}

function generateShieldPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * 0.22;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const idx = rowStart + 1 + x * 4;
      // Rounded square mask
      const dx = Math.max(0, Math.abs(x - cx) - (size / 2 - radius));
      const dy = Math.max(0, Math.abs(y - cy) - (size / 2 - radius));
      const inRoundedRect = dx * dx + dy * dy <= radius * radius;

      if (!inRoundedRect) {
        raw[idx] = 0;
        raw[idx + 1] = 0;
        raw[idx + 2] = 0;
        raw[idx + 3] = 0;
        continue;
      }

      // Draw crisp white keyhole silhouette in center
      const nx = (x - cx) / (size / 2);
      const ny = (y - cy) / (size / 2);
      const inKeyHead = nx * nx + (ny + 0.14) * (ny + 0.14) <= 0.22 * 0.22;
      const inKeyStem = Math.abs(nx) <= 0.1 && ny >= -0.04 && ny <= 0.44;
      const inOuterRing =
        Math.abs(nx) <= 0.56 &&
        ny >= -0.56 &&
        ny <= 0.56 &&
        (Math.abs(nx) >= 0.45 || Math.abs(ny) >= 0.45);

      if (inKeyHead || inKeyStem) {
        raw[idx] = 255;
        raw[idx + 1] = 255;
        raw[idx + 2] = 255;
        raw[idx + 3] = 255;
      } else if (inOuterRing) {
        raw[idx] = 165;
        raw[idx + 1] = 180;
        raw[idx + 2] = 252;
        raw[idx + 3] = 255;
      } else {
        // Indigo gradient (#4f46e5 -> #6366f1)
        const t = y / size;
        raw[idx] = Math.round(79 + t * 20);
        raw[idx + 1] = Math.round(70 + t * 32);
        raw[idx + 2] = Math.round(229 + t * 12);
        raw[idx + 3] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

fs.rmSync(distDir, { recursive: true, force: true });

// 1. Build popup HTML/React UI via Vite
await viteBuild({
  configFile: false,
  root: __dirname,
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: distDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: path.join(__dirname, 'popup.html'),
      },
    },
  },
});

// 2. Bundle background.ts (ESM service worker) and content.ts (single self-contained IIFE)
await esbuild.build({
  entryPoints: [path.join(__dirname, 'src/background.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outfile: path.join(distDir, 'background.js'),
  minify: true,
});

await esbuild.build({
  entryPoints: [path.join(__dirname, 'src/content.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outfile: path.join(distDir, 'content.js'),
  minify: true,
});

// 3. Copy manifest & generate valid PNG icons
fs.copyFileSync(path.join(__dirname, 'public/manifest.json'), path.join(distDir, 'manifest.json'));
fs.mkdirSync(iconsDir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), generateShieldPng(size));
}

// 4. Package built MV3 extension into dist/bin/nonepwd-extension.zip for one-click server download
function collectFilesRecursive(dir, baseDir = dir) {
  const entries = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...collectFilesRecursive(fullPath, baseDir));
    } else if (stat.isFile()) {
      entries.push({
        relPath: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
        data: fs.readFileSync(fullPath),
      });
    }
  }
  return entries;
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.relPath, 'utf8');
    const uncompressed = entry.data;
    const compressed = zlib.deflateRawSync(uncompressed);
    const crc = crc32(uncompressed);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x0021, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const zipOutPath = path.resolve(__dirname, '../../dist/bin/nonepwd-extension.zip');
fs.mkdirSync(path.dirname(zipOutPath), { recursive: true });
fs.writeFileSync(zipOutPath, buildZipBuffer(collectFilesRecursive(distDir)));

console.log('nonepwd MV3 extension built into packages/extension/dist and dist/bin/nonepwd-extension.zip');
