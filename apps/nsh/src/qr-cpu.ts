/**
 * Pure-TypeScript ISO/IEC 18004 QR Code Model 2 decoder (ported from
 * apps/desktop/Sources/NonePwd/Core/QrCodeScanner.swift CpuQrDecoder +
 * GF(256) Reed-Solomon verification & error correction).
 *
 * Works completely offline across iOS, Android, Windows, macOS, and headless `nsh test`.
 */

interface FinderCandidate {
  cx: number;
  cy: number;
  moduleSize: number;
  count: number;
}

// (ecCodewordsPerBlock, numBlocks) for [L, M, Q, H] across Versions 1..40
const EC_TABLE: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[7, 1], [10, 1], [13, 1], [17, 1]],
  [[10, 1], [16, 1], [22, 1], [28, 1]],
  [[15, 1], [26, 1], [18, 2], [22, 2]],
  [[20, 1], [18, 2], [26, 2], [16, 4]],
  [[26, 1], [24, 2], [18, 4], [22, 4]],
  [[18, 2], [16, 4], [24, 4], [28, 4]],
  [[20, 2], [18, 4], [18, 6], [26, 5]],
  [[24, 2], [22, 4], [22, 6], [26, 6]],
  [[30, 2], [22, 5], [20, 8], [24, 8]],
  [[18, 4], [26, 5], [24, 8], [28, 8]],
  [[20, 4], [30, 5], [28, 8], [24, 11]],
  [[24, 4], [22, 8], [26, 10], [28, 11]],
  [[26, 4], [22, 9], [24, 12], [22, 16]],
  [[30, 4], [24, 9], [20, 16], [24, 16]],
  [[22, 6], [24, 10], [30, 12], [24, 18]],
  [[24, 6], [28, 10], [24, 17], [30, 16]],
  [[28, 6], [28, 11], [28, 16], [28, 19]],
  [[30, 6], [26, 13], [28, 18], [28, 21]],
  [[28, 7], [26, 14], [26, 21], [26, 25]],
  [[28, 8], [26, 16], [30, 20], [28, 25]],
  [[28, 8], [26, 17], [28, 23], [30, 25]],
  [[28, 9], [28, 17], [30, 23], [24, 34]],
  [[30, 9], [28, 18], [30, 25], [30, 30]],
  [[30, 10], [28, 20], [30, 27], [30, 32]],
  [[26, 12], [28, 21], [30, 29], [30, 35]],
  [[28, 12], [28, 23], [28, 34], [30, 37]],
  [[30, 12], [28, 25], [30, 34], [30, 40]],
  [[30, 13], [28, 26], [30, 35], [30, 42]],
  [[30, 14], [28, 28], [30, 38], [30, 45]],
  [[30, 15], [28, 29], [30, 40], [30, 48]],
  [[30, 16], [28, 31], [30, 43], [30, 51]],
  [[30, 17], [28, 33], [30, 45], [30, 54]],
  [[30, 18], [28, 35], [30, 48], [30, 57]],
  [[30, 19], [28, 37], [30, 51], [30, 60]],
  [[30, 19], [28, 38], [30, 53], [30, 63]],
  [[30, 20], [28, 40], [30, 56], [30, 66]],
  [[30, 21], [28, 43], [30, 59], [30, 70]],
  [[30, 22], [28, 45], [30, 62], [30, 74]],
  [[30, 24], [28, 47], [30, 65], [30, 77]],
  [[30, 25], [28, 49], [30, 68], [30, 81]],
];

// GF(256) lookup tables for QR primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (a === 0) return 0;
  if (b === 0) throw new Error("GF(256) division by zero");
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
}

function gfEvalHighFirst(poly: Uint8Array, x: number): number {
  let acc = 0;
  for (let i = 0; i < poly.length; i++) {
    acc = gfMul(acc, x) ^ poly[i];
  }
  return acc;
}

function gfEvalLowFirst(poly: number[], x: number): number {
  let acc = 0;
  let pow = 1;
  for (let i = 0; i < poly.length; i++) {
    if (poly[i] !== 0) {
      acc ^= gfMul(poly[i], pow);
    }
    pow = gfMul(pow, x);
  }
  return acc;
}

/**
 * Verifies and corrects a single Reed-Solomon block (data + ec codewords, high-degree first).
 * Returns corrected block or null if uncorrectable.
 */
function rsCorrectBlock(block: Uint8Array, ecCount: number): Uint8Array | null {
  const syndromes = new Array<number>(ecCount);
  let hasError = false;
  for (let i = 0; i < ecCount; i++) {
    const s = gfEvalHighFirst(block, GF_EXP[i]);
    syndromes[i] = s;
    if (s !== 0) hasError = true;
  }
  if (!hasError) return block;

  // Berlekamp-Massey for error locator polynomial C(x) = 1 + C1*x + ...
  let C: number[] = [1];
  let B: number[] = [1];
  let L = 0;
  let m = 1;
  let b = 1;

  for (let n = 0; n < ecCount; n++) {
    let d = syndromes[n];
    for (let i = 1; i <= L; i++) {
      d ^= gfMul(C[i] ?? 0, syndromes[n - i]);
    }
    if (d === 0) {
      m += 1;
    } else {
      const T = C.slice();
      const coef = gfDiv(d, b);
      const needed = B.length + m;
      while (C.length < needed) C.push(0);
      for (let i = 0; i < B.length; i++) {
        C[i + m] ^= gfMul(coef, B[i]);
      }
      if (2 * L <= n) {
        L = n + 1 - L;
        B = T;
        b = d;
        m = 1;
      } else {
        m += 1;
      }
    }
  }

  const maxErrors = Math.floor(ecCount / 2);
  if (L === 0 || L > maxErrors) return null;
  C = C.slice(0, L + 1);

  // Chien search over powers p = 0 .. N-1 (index = N - 1 - p)
  const N = block.length;
  const errPositions: Array<{ idx: number; x: number; xInv: number }> = [];
  for (let p = 0; p < N; p++) {
    const x = GF_EXP[p % 255];
    const xInv = GF_EXP[(255 - (p % 255)) % 255];
    if (gfEvalLowFirst(C, xInv) === 0) {
      errPositions.push({ idx: N - 1 - p, x, xInv });
    }
  }
  if (errPositions.length !== L) return null;

  // Omega(x) = (S(x) * C(x)) mod x^ecCount
  const omega = new Array<number>(ecCount).fill(0);
  for (let i = 0; i < ecCount; i++) {
    for (let j = 0; j < C.length && i + j < ecCount; j++) {
      omega[i + j] ^= gfMul(syndromes[i], C[j]);
    }
  }

  // Formal derivative C'(x) in GF(2^8): odd indices shift down by 1
  const cDeriv = new Array<number>(Math.max(1, C.length - 1)).fill(0);
  for (let i = 1; i < C.length; i += 2) {
    cDeriv[i - 1] = C[i];
  }

  const corrected = new Uint8Array(block);
  for (const pos of errPositions) {
    const denom = gfEvalLowFirst(cDeriv, pos.xInv);
    if (denom === 0) return null;
    const num = gfMul(pos.x, gfEvalLowFirst(omega, pos.xInv));
    corrected[pos.idx] ^= gfDiv(num, denom);
  }

  // Verify all syndromes are zero after correction
  for (let i = 0; i < ecCount; i++) {
    if (gfEvalHighFirst(corrected, GF_EXP[i]) !== 0) return null;
  }
  return corrected;
}

function computeOtsuThreshold(lums: Uint8Array): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < lums.length; i++) hist[lums[i]]++;
  const total = lums.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Decodes QR Code Model 2 payloads from an RGBA pixel buffer.
 * Returns deduplicated decoded payload strings (empty array if none detected).
 */
export function decodeQrFromRgba(
  rgba: Uint8Array,
  width: number,
  height: number
): string[] {
  if (width < 21 || height < 21 || rgba.length < width * height * 4) {
    return [];
  }

  const count = width * height;
  const lums = new Uint8Array(count);
  let minVal = 255;
  let maxVal = 0;

  for (let i = 0; i < count; i++) {
    const off = i * 4;
    const a = rgba[off + 3];
    let r = rgba[off];
    let g = rgba[off + 1];
    let b = rgba[off + 2];
    if (a < 255) {
      const inv = 255 - a;
      r = Math.round((r * a + 255 * inv) / 255);
      g = Math.round((g * a + 255 * inv) / 255);
      b = Math.round((b * a + 255 * inv) / 255);
    }
    const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    lums[i] = lum;
    if (lum < minVal) minVal = lum;
    if (lum > maxVal) maxVal = lum;
  }

  if (maxVal - minVal < 20) return [];

  const midThreshold = Math.floor((minVal + maxVal) / 2);
  const otsuThreshold = computeOtsuThreshold(lums);
  const thresholds =
    Math.abs(otsuThreshold - midThreshold) >= 8
      ? [midThreshold, otsuThreshold]
      : [midThreshold];

  const results: string[] = [];
  const seen = new Set<string>();

  for (const thresh of thresholds) {
    const normal = new Uint8Array(count);
    const inverted = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      normal[i] = lums[i] < thresh ? 1 : 0;
      inverted[i] = lums[i] >= thresh ? 1 : 0;
    }

    const resNormal = decodeBinary(normal, width, height);
    if (resNormal && !seen.has(resNormal)) {
      seen.add(resNormal);
      results.push(resNormal);
    }
    if (results.length === 0) {
      const resInv = decodeBinary(inverted, width, height);
      if (resInv && !seen.has(resInv)) {
        seen.add(resInv);
        results.push(resInv);
      }
    }
    if (results.length > 0) break;
  }

  return results;
}

function decodeBinary(grid: Uint8Array, w: number, h: number): string | null {
  const candidates = findFinderCandidates(grid, w, h);
  if (candidates.length < 3) return null;

  const topClusters = candidates.slice(0, 12);
  let bestTriple: [FinderCandidate, FinderCandidate, FinderCandidate] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let i = 0; i < topClusters.length; i++) {
    for (let j = 0; j < topClusters.length; j++) {
      if (j === i) continue;
      for (let k = 0; k < topClusters.length; k++) {
        if (k === i || k === j) continue;
        const tl = topClusters[i];
        const tr = topClusters[j];
        const bl = topClusters[k];
        const dxR = tr.cx - tl.cx;
        const dyR = tr.cy - tl.cy;
        const dxB = bl.cx - tl.cx;
        const dyB = bl.cy - tl.cy;

        const distR = Math.hypot(dxR, dyR);
        const distB = Math.hypot(dxB, dyB);
        if (distR <= tl.moduleSize * 10 || distB <= tl.moduleSize * 10) continue;

        // Cross product must be positive in image coordinates (tl->tr clockwise to tl->bl)
        const cross = dxR * dyB - dyR * dxB;
        if (cross <= 0) continue;

        const dot = Math.abs(dxR * dxB + dyR * dyB) / (distR * distB);
        if (dot > 0.28) continue;

        const orthoErr = Math.abs(dyR) + Math.abs(dxB);
        const sizeErr = Math.abs(distR - distB);
        if (sizeErr > Math.max(distR, distB) * 0.25) continue;

        const modErr =
          Math.abs(tl.moduleSize - tr.moduleSize) + Math.abs(tl.moduleSize - bl.moduleSize);
        const score = dot * 100 + orthoErr * 0.25 + sizeErr * 0.5 + modErr * 4.0;
        if (score < bestScore) {
          bestScore = score;
          bestTriple = [tl, tr, bl];
        }
      }
    }
  }

  if (!bestTriple) return null;
  const [tl, tr, bl] = bestTriple;
  const distR = Math.hypot(tr.cx - tl.cx, tr.cy - tl.cy);
  const distB = Math.hypot(bl.cx - tl.cx, bl.cy - tl.cy);
  const avgMod = (tl.moduleSize + tr.moduleSize + bl.moduleSize) / 3.0;
  const estSize = (distR + distB) / (2.0 * avgMod) + 7.0;
  const baseVersion = Math.max(1, Math.min(40, Math.round((estSize - 17.0) / 4.0)));

  const candidateVersions = [baseVersion];
  if (baseVersion > 1) candidateVersions.push(baseVersion - 1);
  if (baseVersion < 40) candidateVersions.push(baseVersion + 1);

  for (const version of candidateVersions) {
    const size = 4 * version + 17;
    const span = size - 7;
    // Affine basis vectors along columns (tl -> tr) and rows (tl -> bl)
    const colDx = (tr.cx - tl.cx) / span;
    const colDy = (tr.cy - tl.cy) / span;
    const rowDx = (bl.cx - tl.cx) / span;
    const rowDy = (bl.cy - tl.cy) / span;
    const originX = tl.cx - 3.5 * colDx - 3.5 * rowDx;
    const originY = tl.cy - 3.5 * colDy - 3.5 * rowDy;

    const modules: boolean[][] = new Array(size);
    for (let r = 0; r < size; r++) {
      const row = new Array<boolean>(size);
      for (let c = 0; c < size; c++) {
        const fx = originX + (c + 0.5) * colDx + (r + 0.5) * rowDx;
        const fy = originY + (c + 0.5) * colDy + (r + 0.5) * rowDy;
        const px = Math.min(w - 1, Math.max(0, Math.floor(fx)));
        const py = Math.min(h - 1, Math.max(0, Math.floor(fy)));
        row[c] = grid[py * w + px] === 1;
      }
      modules[r] = row;
    }

    const decoded = decodeModules(modules, version, size);
    if (decoded !== null) return decoded;
  }

  return null;
}

function findFinderCandidates(grid: Uint8Array, w: number, h: number): FinderCandidate[] {
  const clusters: FinderCandidate[] = [];

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    let stateCount = [0, 0, 0, 0, 0];
    let currentState = 0;
    let x = 0;

    while (x < w) {
      const dark = grid[rowOffset + x] === 1;
      if (dark) {
        if ((currentState & 1) === 1) {
          currentState += 1;
        }
        stateCount[currentState] += 1;
      } else if (currentState === 0 && stateCount[0] === 0) {
        // Skip leading light pixels before first dark module
      } else if ((currentState & 1) === 0) {
        if (currentState === 4) {
          if (checkRatio(stateCount)) {
            const total = stateCount[0] + stateCount[1] + stateCount[2] + stateCount[3] + stateCount[4];
            const cx = x - (stateCount[4] + stateCount[3]) - stateCount[2] / 2.0;
            const vert = crossCheckVertical(grid, w, h, Math.floor(cx), y, stateCount[2]);
            if (vert) {
              const modSize = (total + vert.total) / 14.0;
              mergeCandidate(cx, vert.cy, modSize, clusters);
            }
            stateCount = [0, 0, 0, 0, 0];
            currentState = 0;
            x += 1;
            continue;
          } else {
            stateCount[0] = stateCount[2];
            stateCount[1] = stateCount[3];
            stateCount[2] = stateCount[4];
            stateCount[3] = 1;
            stateCount[4] = 0;
            currentState = 3;
          }
        } else {
          currentState += 1;
          stateCount[currentState] += 1;
        }
      } else {
        stateCount[currentState] += 1;
      }
      x += 1;
    }

    if (currentState === 4 && checkRatio(stateCount)) {
      const total = stateCount[0] + stateCount[1] + stateCount[2] + stateCount[3] + stateCount[4];
      const cx = w - (stateCount[4] + stateCount[3]) - stateCount[2] / 2.0;
      const vert = crossCheckVertical(grid, w, h, Math.floor(cx), y, stateCount[2]);
      if (vert) {
        const modSize = (total + vert.total) / 14.0;
        mergeCandidate(cx, vert.cy, modSize, clusters);
      }
    }
  }

  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

function checkRatio(counts: number[]): boolean {
  const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
  if (total < 7) return false;
  const mod = total / 7.0;
  const tol = Math.max(0.8, mod * 0.55);
  return (
    Math.abs(counts[0] - mod) <= tol &&
    Math.abs(counts[1] - mod) <= tol &&
    Math.abs(counts[2] - 3.0 * mod) <= tol * 3.0 &&
    Math.abs(counts[3] - mod) <= tol &&
    Math.abs(counts[4] - mod) <= tol
  );
}

function crossCheckVertical(
  grid: Uint8Array,
  w: number,
  h: number,
  x: number,
  startY: number,
  maxCount: number
): { cy: number; total: number } | null {
  if (x < 0 || x >= w || startY < 0 || startY >= h || grid[startY * w + x] !== 1) {
    return null;
  }
  const counts = [0, 0, 0, 0, 0];
  let y = startY;
  while (y >= 0 && grid[y * w + x] === 1) {
    counts[2] += 1;
    y -= 1;
  }
  if (y < 0 || counts[2] > maxCount * 2) return null;
  while (y >= 0 && grid[y * w + x] === 0) {
    counts[1] += 1;
    y -= 1;
  }
  if (y < 0) return null;
  while (y >= 0 && grid[y * w + x] === 1) {
    counts[0] += 1;
    y -= 1;
  }

  y = startY + 1;
  while (y < h && grid[y * w + x] === 1) {
    counts[2] += 1;
    y += 1;
  }
  if (y >= h || counts[2] > maxCount * 2) return null;
  while (y < h && grid[y * w + x] === 0) {
    counts[3] += 1;
    y += 1;
  }
  if (y >= h) return null;
  while (y < h && grid[y * w + x] === 1) {
    counts[4] += 1;
    y += 1;
  }

  if (!checkRatio(counts)) return null;
  const total = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
  const cy = y - (counts[4] + counts[3]) - counts[2] / 2.0;
  return { cy, total };
}

function mergeCandidate(
  cx: number,
  cy: number,
  moduleSize: number,
  clusters: FinderCandidate[]
): void {
  for (let idx = 0; idx < clusters.length; idx++) {
    const c = clusters[idx];
    const thresh = Math.max(2.5, c.moduleSize * 2.5);
    if (
      Math.abs(c.cx - cx) < thresh &&
      Math.abs(c.cy - cy) < thresh &&
      Math.abs(c.moduleSize - moduleSize) <= Math.max(1.5, c.moduleSize)
    ) {
      const n = c.count;
      c.cx = (c.cx * n + cx) / (n + 1);
      c.cy = (c.cy * n + cy) / (n + 1);
      c.moduleSize = (c.moduleSize * n + moduleSize) / (n + 1);
      c.count = n + 1;
      return;
    }
  }
  clusters.push({ cx, cy, moduleSize, count: 1 });
}

function popcount15(n: number): number {
  let c = 0;
  let v = n;
  while (v !== 0) {
    v &= v - 1;
    c += 1;
  }
  return c;
}

function decodeFormatInfo(
  modules: boolean[][],
  size: number
): { ecIndex: number; maskId: number } | null {
  const readBit = (r: number, c: number): number => (modules[r][c] ? 1 : 0);

  let fmt1 = 0;
  for (let c = 0; c <= 5; c++) fmt1 = (fmt1 << 1) | readBit(8, c);
  fmt1 = (fmt1 << 1) | readBit(8, 7);
  fmt1 = (fmt1 << 1) | readBit(8, 8);
  fmt1 = (fmt1 << 1) | readBit(7, 8);
  for (let r = 5; r >= 0; r--) fmt1 = (fmt1 << 1) | readBit(r, 8);

  let fmt2 = 0;
  for (let r = size - 1; r >= size - 7; r--) fmt2 = (fmt2 << 1) | readBit(r, 8);
  for (let c = size - 8; c < size; c++) fmt2 = (fmt2 << 1) | readBit(8, c);

  let bestData = -1;
  let bestDist = 999;
  for (let d = 0; d < 32; d++) {
    let rem = d << 10;
    for (let b = 14; b >= 10; b--) {
      if ((rem & (1 << b)) !== 0) {
        rem ^= 0x537 << (b - 10);
      }
    }
    const codeword = ((d << 10) | rem) ^ 0x5412;
    const dist = Math.min(popcount15(fmt1 ^ codeword), popcount15(fmt2 ^ codeword));
    if (dist < bestDist) {
      bestDist = dist;
      bestData = d;
    }
  }

  if (bestData < 0 || bestDist > 3) return null;
  const rawEc = (bestData >> 3) & 0x3;
  const maskId = bestData & 0x7;
  const ecMap = [1, 0, 3, 2]; // 00->M(1), 01->L(0), 10->H(3), 11->Q(2)
  return { ecIndex: ecMap[rawEc], maskId };
}

function applyMask(maskId: number, r: number, c: number): boolean {
  switch (maskId) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function alignmentPositions(version: number, size: number): number[] {
  if (version < 2) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step =
    version === 32
      ? 26
      : Math.floor((version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  let pos = size - 7;
  for (let i = 1; i < numAlign; i++) {
    result.splice(1, 0, pos);
    pos -= step;
  }
  return result;
}

function buildFunctionMask(version: number, size: number): boolean[][] {
  const mask: boolean[][] = new Array(size);
  for (let r = 0; r < size; r++) {
    mask[r] = new Array<boolean>(size).fill(false);
  }
  const markRect = (r0: number, c0: number, h: number, w: number) => {
    const rMax = Math.min(size, r0 + h);
    const cMax = Math.min(size, c0 + w);
    for (let r = Math.max(0, r0); r < rMax; r++) {
      for (let c = Math.max(0, c0); c < cMax; c++) {
        mask[r][c] = true;
      }
    }
  };
  markRect(0, 0, 9, 9);
  markRect(0, size - 8, 9, 8);
  markRect(size - 8, 0, 8, 9);
  for (let i = 0; i < size; i++) {
    mask[6][i] = true;
    mask[i][6] = true;
  }
  if (version >= 7) {
    markRect(0, size - 11, 6, 3);
    markRect(size - 11, 0, 3, 6);
  }
  const alignPos = alignmentPositions(version, size);
  for (const ar of alignPos) {
    for (const ac of alignPos) {
      if (
        (ar === 6 && ac === 6) ||
        (ar === 6 && ac === size - 7) ||
        (ar === size - 7 && ac === 6)
      ) {
        continue;
      }
      markRect(ar - 2, ac - 2, 5, 5);
    }
  }
  return mask;
}

export function decodeModules(
  modules: boolean[][],
  version: number,
  size: number
): string | null {
  const fmt = decodeFormatInfo(modules, size);
  if (!fmt) return null;
  const { ecIndex, maskId } = fmt;
  const isFunc = buildFunctionMask(version, size);

  const bits: boolean[] = [];
  let right = size - 1;
  let upward = true;
  while (right >= 1) {
    if (right === 6) right -= 1;
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i;
      for (let dx = 0; dx <= 1; dx++) {
        const c = right - dx;
        if (c < 0 || isFunc[r][c]) continue;
        const raw = modules[r][c];
        bits.push(applyMask(maskId, r, c) ? !raw : raw);
      }
    }
    upward = !upward;
    right -= 2;
  }

  const totalCodewords = Math.floor(bits.length / 8);
  if (totalCodewords < 26) return null;
  const codewords = new Uint8Array(totalCodewords);
  for (let i = 0; i < totalCodewords; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      if (bits[i * 8 + b]) byte |= 1 << (7 - b);
    }
    codewords[i] = byte;
  }

  const [ecPerBlock, numBlocks] = EC_TABLE[version - 1][ecIndex];
  const totalDataBytes = totalCodewords - ecPerBlock * numBlocks;
  if (totalDataBytes <= 0 || numBlocks <= 0) return null;

  const shortBlockLen = Math.floor(totalDataBytes / numBlocks);
  const longBlocks = totalDataBytes % numBlocks;
  const shortBlocks = numBlocks - longBlocks;

  const dataBlocks: number[][] = Array.from({ length: numBlocks }, () => []);
  const ecBlocks: number[][] = Array.from({ length: numBlocks }, () => []);

  let idx = 0;
  for (let row = 0; row < shortBlockLen; row++) {
    for (let b = 0; b < numBlocks; b++) {
      if (idx >= codewords.length) return null;
      dataBlocks[b].push(codewords[idx++]);
    }
  }
  if (longBlocks > 0) {
    for (let b = shortBlocks; b < numBlocks; b++) {
      if (idx >= codewords.length) return null;
      dataBlocks[b].push(codewords[idx++]);
    }
  }
  for (let row = 0; row < ecPerBlock; row++) {
    for (let b = 0; b < numBlocks; b++) {
      if (idx >= codewords.length) return null;
      ecBlocks[b].push(codewords[idx++]);
    }
  }

  const dataStream: number[] = [];
  for (let b = 0; b < numBlocks; b++) {
    const dLen = dataBlocks[b].length;
    const fullBlock = new Uint8Array(dLen + ecBlocks[b].length);
    fullBlock.set(dataBlocks[b], 0);
    fullBlock.set(ecBlocks[b], dLen);
    const corrected = rsCorrectBlock(fullBlock, ecPerBlock);
    if (!corrected) return null;
    for (let i = 0; i < dLen; i++) {
      dataStream.push(corrected[i]);
    }
  }

  return decodeDataStream(new Uint8Array(dataStream), version);
}

const ALPHA_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

function decodeDataStream(bytes: Uint8Array, version: number): string | null {
  let bitPos = 0;
  const totalBits = bytes.length * 8;

  const readBits = (count: number): number | null => {
    if (count < 0 || bitPos + count > totalBits) return null;
    let val = 0;
    for (let i = 0; i < count; i++) {
      const byteIdx = bitPos >> 3;
      const bitIdx = 7 - (bitPos & 7);
      val = (val << 1) | ((bytes[byteIdx] >> bitIdx) & 1);
      bitPos += 1;
    }
    return val;
  };

  const outBytes: number[] = [];
  while (bitPos + 4 <= totalBits) {
    const mode = readBits(4);
    if (mode === null || mode === 0) break;

    if (mode === 1) {
      const ccBits = version <= 9 ? 10 : version <= 26 ? 12 : 14;
      const count = readBits(ccBits);
      if (count === null) return null;
      let rem = count;
      while (rem >= 3) {
        const v = readBits(10);
        if (v === null || v >= 1000) return null;
        const s = String(v).padStart(3, "0");
        outBytes.push(s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2));
        rem -= 3;
      }
      if (rem === 2) {
        const v = readBits(7);
        if (v === null || v >= 100) return null;
        const s = String(v).padStart(2, "0");
        outBytes.push(s.charCodeAt(0), s.charCodeAt(1));
      } else if (rem === 1) {
        const v = readBits(4);
        if (v === null || v >= 10) return null;
        outBytes.push(48 + v);
      }
    } else if (mode === 2) {
      const ccBits = version <= 9 ? 9 : version <= 26 ? 11 : 13;
      const count = readBits(ccBits);
      if (count === null) return null;
      let rem = count;
      while (rem >= 2) {
        const v = readBits(11);
        if (v === null) return null;
        const a = Math.floor(v / 45);
        const b = v % 45;
        if (a >= ALPHA_CHARS.length || b >= ALPHA_CHARS.length) return null;
        outBytes.push(ALPHA_CHARS.charCodeAt(a), ALPHA_CHARS.charCodeAt(b));
        rem -= 2;
      }
      if (rem === 1) {
        const v = readBits(6);
        if (v === null || v >= ALPHA_CHARS.length) return null;
        outBytes.push(ALPHA_CHARS.charCodeAt(v));
      }
    } else if (mode === 4) {
      const ccBits = version <= 9 ? 8 : 16;
      const count = readBits(ccBits);
      if (count === null) return null;
      for (let i = 0; i < count; i++) {
        const b = readBits(8);
        if (b === null) return null;
        outBytes.push(b);
      }
    } else if (mode === 7) {
      const first = readBits(8);
      if (first === null) return null;
      if ((first & 0x80) === 0) {
        // 1-byte ECI
      } else if ((first & 0xc0) === 0x80) {
        if (readBits(8) === null) return null;
      } else if ((first & 0xe0) === 0xc0) {
        if (readBits(16) === null) return null;
      } else {
        return null;
      }
    } else {
      return null;
    }
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(outBytes));
}
