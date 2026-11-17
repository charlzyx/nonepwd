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

function generateThreeKeysPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2;
  const cy = size / 2;
  const half = size / 2;
  const radius = size * 0.225;
  const bg = [28, 29, 33];
  const keys = [
    { kx: -0.43, ky: -0.04, color: [245, 204, 46] },
    { kx: 0.0, ky: 0.06, color: [61, 204, 97] },
    { kx: 0.43, ky: -0.04, color: [61, 138, 250] },
  ];
  const subOffsets = [0.25, 0.75];

  const sampleAt = (px, py) => {
    const dx = Math.max(0, Math.abs(px - cx) - (half - radius));
    const dy = Math.max(0, Math.abs(py - cy) - (half - radius));
    if (dx * dx + dy * dy > radius * radius) {
      return null;
    }

    const nx = (px - cx) / half;
    const ny = (py - cy) / half;
    for (const k of keys) {
      const rx = nx - k.kx;
      const bowDy = ny - (-0.23 + k.ky);
      const holeDy = ny - (-0.25 + k.ky);
      const inBow = rx * rx + bowDy * bowDy <= 0.165 * 0.165;
      const inHole = rx * rx + holeDy * holeDy <= 0.055 * 0.055;
      const inShaft =
        (Math.abs(rx) <= 0.048 && ny >= -0.09 + k.ky && ny <= 0.39 + k.ky) ||
        (rx * rx + (ny - (0.39 + k.ky)) * (ny - (0.39 + k.ky)) <= 0.048 * 0.048);
      const inTeeth =
        rx >= 0.04 &&
        rx <= 0.135 &&
        ((ny >= 0.15 + k.ky && ny <= 0.225 + k.ky) ||
          (ny >= 0.285 + k.ky && ny <= 0.36 + k.ky));

      if ((inBow && !inHole) || inShaft || inTeeth) {
        return k.color;
      }
    }
    return bg;
  };

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const idx = rowStart + 1 + x * 4;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let hits = 0;

      for (const oy of subOffsets) {
        for (const ox of subOffsets) {
          const rgb = sampleAt(x + ox, y + oy);
          if (rgb) {
            sumR += rgb[0];
            sumG += rgb[1];
            sumB += rgb[2];
            hits++;
          }
        }
      }

      if (hits === 0) {
        raw[idx] = 0;
        raw[idx + 1] = 0;
        raw[idx + 2] = 0;
        raw[idx + 3] = 0;
      } else {
        raw[idx] = Math.round(sumR / hits);
        raw[idx + 1] = Math.round(sumG / hits);
        raw[idx + 2] = Math.round(sumB / hits);
        raw[idx + 3] = Math.round((hits / 4) * 255);
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

// 3. Copy manifest & icons (prefer native SF-Symbol PNGs from public/icons)
fs.copyFileSync(path.join(__dirname, 'public/manifest.json'), path.join(distDir, 'manifest.json'));
fs.mkdirSync(iconsDir, { recursive: true });
const publicIconsDir = path.join(__dirname, 'public/icons');
if (fs.existsSync(path.join(publicIconsDir, 'icon128.png'))) {
  for (const size of [16, 32, 48, 128]) {
    const srcIcon = path.join(publicIconsDir, `icon${size}.png`);
    if (fs.existsSync(srcIcon)) {
      fs.copyFileSync(srcIcon, path.join(iconsDir, `icon${size}.png`));
    } else {
      fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), generateThreeKeysPng(size));
    }
  }
} else {
  for (const size of [16, 32, 48, 128]) {
    fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), generateThreeKeysPng(size));
  }
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
