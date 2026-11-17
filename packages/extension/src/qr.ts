export interface QrCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr?: number;
}

export interface DetectedBarcodeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedBarcode {
  rawValue?: string;
  format?: string;
  boundingBox?: DetectedBarcodeBox;
}

interface BarcodeDetectorInstance {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

interface Canvas2DContextLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ): void;
}

interface CanvasSurface {
  canvas: ImageBitmapSource & {
    width: number;
    height: number;
    transferToImageBitmap?: () => ImageBitmap;
  };
  ctx: Canvas2DContextLike;
}

interface DrawableImage {
  source: CanvasImageSource & ImageBitmapSource;
  width: number;
  height: number;
  cleanup: () => void;
}

const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const OTPAUTH_URI_RE = /^otpauth(-migration)?:\/\//i;
const RAW_BASE32_SECRET_RE = /^([A-Z2-7]{16,})=*$/;
const QUIET_ZONE_PX = 16;

export function isQrDetectionSupported(): boolean {
  return typeof globalThis !== 'undefined' && 'BarcodeDetector' in globalThis;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_FILE_EXT_RE.test(file.name);
}

export function isOtpQrUri(text: string): boolean {
  return OTPAUTH_URI_RE.test(text.trim());
}

/**
 * Normalizes decoded QR payload text for 2FA import:
 * - Normalizes `otpauth://` and `otpauth-migration://` URI schemes and strips line breaks.
 * - Converts standalone 16+ char Base32 TOTP secret strings into canonical `otpauth://totp/?secret=...` URIs.
 */
export function normalizeOtpQrText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  if (/^otpauth-migration:\/\//i.test(trimmed)) {
    return `otpauth-migration://${trimmed.slice('otpauth-migration://'.length)}`.replace(
      /[\r\n]+/g,
      ''
    );
  }
  if (/^otpauth:\/\//i.test(trimmed)) {
    return `otpauth://${trimmed.slice('otpauth://'.length)}`.replace(/[\r\n]+/g, '');
  }

  // Never misinterpret a NonePwd account Secret Key (NP3-...) or URL as a raw TOTP secret
  if (!/^NP3-/i.test(trimmed) && !trimmed.includes('://')) {
    const compact = trimmed.replace(/[\s-]+/g, '').toUpperCase();
    const match = RAW_BASE32_SECRET_RE.exec(compact);
    if (match) {
      const secret = match[1];
      return `otpauth://totp/?secret=${secret}`;
    }
  }

  return trimmed;
}

export function extractOtpUrisFromQrResults(values: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const val of values) {
    const lines = val.split(/\r?\n/);
    for (const line of lines) {
      const normalized = normalizeOtpQrText(line);
      if (normalized && isOtpQrUri(normalized) && !seen.has(normalized)) {
        seen.add(normalized);
        unique.push(normalized);
      }
    }
  }
  return unique;
}

async function createQrDetector(): Promise<BarcodeDetectorInstance> {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector;
  if (!Ctor) {
    throw new Error(
      '当前浏览器不支持原生二维码识别（BarcodeDetector），请升级 Chrome / Edge / Arc 浏览器。'
    );
  }
  if (typeof Ctor.getSupportedFormats === 'function') {
    try {
      const formats = await Ctor.getSupportedFormats();
      if (Array.isArray(formats) && formats.length > 0 && !formats.includes('qr_code')) {
        throw new Error(
          '当前浏览器未启用 qr_code 二维码识别，请使用 Chrome / Edge / Arc 浏览器。'
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('qr_code')) {
        throw err;
      }
    }
  }
  return new Ctor({ formats: ['qr_code'] });
}

function parseDataUrlToBlobFallback(dataUrl: string): Blob {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) {
    throw new Error('无效的本地图片 data URL');
  }
  const header = dataUrl.slice(5, commaIdx);
  const body = dataUrl.slice(commaIdx + 1);
  const mimeMatch = header.match(/^([^;]+)/);
  const mimeType = mimeMatch?.[1] || 'image/png';
  if (/;base64$/i.test(header)) {
    const binary = atob(body.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }
  return new Blob([decodeURIComponent(body)], { type: mimeType });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  if (!/^data:/i.test(dataUrl)) {
    throw new Error('仅支持本地 data: 图片数据进行二维码识别');
  }
  try {
    return parseDataUrlToBlobFallback(dataUrl);
  } catch {
    // Only local data: URIs reach here; fetch(dataUrl) handles non-standard encodings locally
    if (typeof fetch === 'function') {
      const res = await fetch(dataUrl);
      return await res.blob();
    }
    throw new Error('无法解析截图数据');
  }
}

async function loadDrawableImage(blob: Blob, fallbackDataUrl?: string): Promise<DrawableImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => {
          try {
            bitmap.close?.();
          } catch {
            // ignore
          }
        },
      };
    } catch {
      if (typeof Image === 'undefined') {
        throw new Error('无法解码截图图像（createImageBitmap 失败）');
      }
    }
  }

  if (typeof Image !== 'undefined') {
    const canObjectUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
    const src = canObjectUrl ? URL.createObjectURL(blob) : fallbackDataUrl;
    if (!src) {
      throw new Error('无法创建图片预览对象进行二维码识别');
    }
    try {
      const img = new Image();
      img.src = src;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('无法加载图片以识别二维码'));
      });
      return {
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        cleanup: () => {
          if (canObjectUrl) {
            URL.revokeObjectURL(src);
          }
        },
      };
    } catch (err) {
      if (canObjectUrl) {
        URL.revokeObjectURL(src);
      }
      throw err;
    }
  }

  throw new Error('当前环境缺少图像解码器，无法识别二维码');
}

function createCanvasSurface(width: number, height: number): CanvasSurface | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d') as unknown as Canvas2DContextLike | null;
      if (ctx) {
        return { canvas, ctx };
      }
    } catch {
      // fall through to DOM <canvas>
    }
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d') as unknown as Canvas2DContextLike | null;
    if (ctx) {
      return { canvas, ctx };
    }
  }

  return null;
}

async function detectOnCanvas(
  detector: BarcodeDetectorInstance,
  surface: CanvasSurface
): Promise<DetectedBarcode[]> {
  try {
    return await detector.detect(surface.canvas);
  } catch (err) {
    if (typeof surface.canvas.transferToImageBitmap === 'function') {
      const bmp = surface.canvas.transferToImageBitmap();
      try {
        return await detector.detect(bmp);
      } finally {
        try {
          bmp.close?.();
        } catch {
          // ignore
        }
      }
    }
    throw err;
  }
}

function extractRawValues(barcodes: DetectedBarcode[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of barcodes) {
    const raw = typeof b.rawValue === 'string' ? b.rawValue.trim() : '';
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

function boxesOverlap(
  a: DetectedBarcodeBox,
  b: { x: number; y: number; width: number; height: number }
): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
    return false;
  }
  return (
    Math.max(a.x, b.x) < Math.min(a.x + a.width, b.x + b.width) &&
    Math.max(a.y, b.y) < Math.min(a.y + a.height, b.y + b.height)
  );
}

/**
 * Decodes QR codes from a local `data:` screenshot URL, optionally cropping to `rect`
 * (with `16px` white quiet-zone border, raw crop retry, and full-frame overlap fallback).
 * Works in both MV3 Service Worker (`OffscreenCanvas` + `createImageBitmap`) and DOM (`<canvas>` + `Image`).
 */
export async function cropAndDecodeQrDataUrl(
  dataUrl: string,
  rect?: QrCropRect
): Promise<{ rawValues: string[]; otpUris: string[] }> {
  const detector = await createQrDetector();
  const blob = await dataUrlToBlob(dataUrl);
  const img = await loadDrawableImage(blob, dataUrl);

  try {
    if (!rect) {
      const barcodes = await detector.detect(img.source);
      const rawValues = extractRawValues(barcodes);
      return { rawValues, otpUris: extractOtpUrisFromQrResults(rawValues) };
    }

    const dpr = rect.dpr && Number.isFinite(rect.dpr) && rect.dpr > 0 ? rect.dpr : 1;
    const rawX = Math.floor(rect.x * dpr);
    const rawY = Math.floor(rect.y * dpr);
    const rawRight = Math.ceil((rect.x + rect.width) * dpr);
    const rawBottom = Math.ceil((rect.y + rect.height) * dpr);

    const sx = Math.max(0, Math.min(img.width, rawX));
    const sy = Math.max(0, Math.min(img.height, rawY));
    const ex = Math.max(0, Math.min(img.width, rawRight));
    const ey = Math.max(0, Math.min(img.height, rawBottom));
    const sw = ex - sx;
    const sh = ey - sy;

    if (sw > 0 && sh > 0) {
      // 1. Padded crop with 16px white quiet-zone border so tight edge crops decode reliably
      const paddedSurface = createCanvasSurface(sw + QUIET_ZONE_PX * 2, sh + QUIET_ZONE_PX * 2);
      if (paddedSurface) {
        paddedSurface.ctx.fillStyle = '#ffffff';
        paddedSurface.ctx.fillRect(0, 0, sw + QUIET_ZONE_PX * 2, sh + QUIET_ZONE_PX * 2);
        paddedSurface.ctx.drawImage(
          img.source,
          sx,
          sy,
          sw,
          sh,
          QUIET_ZONE_PX,
          QUIET_ZONE_PX,
          sw,
          sh
        );
        const paddedBarcodes = await detectOnCanvas(detector, paddedSurface);
        const paddedRaw = extractRawValues(paddedBarcodes);
        if (paddedRaw.length > 0) {
          return {
            rawValues: paddedRaw,
            otpUris: extractOtpUrisFromQrResults(paddedRaw),
          };
        }
      }

      // 2. Retry raw unpadded crop
      const rawSurface = createCanvasSurface(sw, sh);
      if (rawSurface) {
        rawSurface.ctx.drawImage(img.source, sx, sy, sw, sh, 0, 0, sw, sh);
        const croppedBarcodes = await detectOnCanvas(detector, rawSurface);
        const croppedRaw = extractRawValues(croppedBarcodes);
        if (croppedRaw.length > 0) {
          return {
            rawValues: croppedRaw,
            otpUris: extractOtpUrisFromQrResults(croppedRaw),
          };
        }
      }
    }

    // 3. Full-frame detection filtered by boundingBox overlap (or fallback to full-frame otpauth matches)
    const fullBarcodes = await detector.detect(img.source);
    const scaledRect = { x: sx, y: sy, width: sw, height: sh };
    const overlapping =
      sw > 0 && sh > 0
        ? fullBarcodes.filter((b) => b.boundingBox && boxesOverlap(b.boundingBox, scaledRect))
        : [];

    if (overlapping.length > 0) {
      const overlappingRaw = extractRawValues(overlapping);
      return {
        rawValues: overlappingRaw,
        otpUris: extractOtpUrisFromQrResults(overlappingRaw),
      };
    }

    const fullRaw = extractRawValues(fullBarcodes);
    const fullOtpUris = extractOtpUrisFromQrResults(fullRaw);
    if (fullOtpUris.length > 0) {
      const otpRaw = fullRaw.filter((raw) => extractOtpUrisFromQrResults([raw]).length > 0);
      return {
        rawValues: otpRaw.length > 0 ? otpRaw : fullRaw,
        otpUris: fullOtpUris,
      };
    }

    return { rawValues: [], otpUris: [] };
  } finally {
    img.cleanup();
  }
}

export async function decodeQrFromBlob(
  blob: Blob
): Promise<{ rawValues: string[]; otpUris: string[] }> {
  const detector = await createQrDetector();
  const img = await loadDrawableImage(blob);
  try {
    const barcodes = await detector.detect(img.source);
    let rawValues = extractRawValues(barcodes);
    if (rawValues.length === 0 && img.width > 0 && img.height > 0) {
      const paddedSurface = createCanvasSurface(
        img.width + QUIET_ZONE_PX * 2,
        img.height + QUIET_ZONE_PX * 2
      );
      if (paddedSurface) {
        paddedSurface.ctx.fillStyle = '#ffffff';
        paddedSurface.ctx.fillRect(
          0,
          0,
          img.width + QUIET_ZONE_PX * 2,
          img.height + QUIET_ZONE_PX * 2
        );
        paddedSurface.ctx.drawImage(
          img.source,
          0,
          0,
          img.width,
          img.height,
          QUIET_ZONE_PX,
          QUIET_ZONE_PX,
          img.width,
          img.height
        );
        const paddedBarcodes = await detectOnCanvas(detector, paddedSurface);
        rawValues = extractRawValues(paddedBarcodes);
      }
    }
    return {
      rawValues,
      otpUris: extractOtpUrisFromQrResults(rawValues),
    };
  } finally {
    img.cleanup();
  }
}

export async function decodeQrFromFiles(
  files: FileList | File[]
): Promise<{ rawValues: string[]; otpUris: string[]; imageFilesCount: number }> {
  const imageFiles = Array.from(files).filter(isImageFile);
  if (imageFiles.length === 0) {
    return { rawValues: [], otpUris: [], imageFilesCount: 0 };
  }

  const allRaw: string[] = [];
  for (const file of imageFiles) {
    const { rawValues } = await decodeQrFromBlob(file);
    for (const v of rawValues) {
      if (!allRaw.includes(v)) {
        allRaw.push(v);
      }
    }
  }

  return {
    rawValues: allRaw,
    otpUris: extractOtpUrisFromQrResults(allRaw),
    imageFilesCount: imageFiles.length,
  };
}

export function extractClipboardImages(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  const images: File[] = [];
  if (dataTransfer.items) {
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) images.push(file);
      }
    }
  }
  if (images.length === 0 && dataTransfer.files) {
    for (const file of Array.from(dataTransfer.files)) {
      if (isImageFile(file)) {
        images.push(file);
      }
    }
  }
  return images;
}

export function extractClipboardText(dataTransfer: DataTransfer | null): string {
  if (!dataTransfer) return '';
  return dataTransfer.getData('text/plain') ?? '';
}

export async function readQrFromSystemClipboard(): Promise<{
  otpUris: string[];
  rawValues: string[];
}> {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    throw new Error('当前环境不支持读取剪贴板，请截图后直接按 ⌘V / Ctrl+V 粘贴。');
  }

  try {
    if (typeof navigator.clipboard.read === 'function') {
      const items = await navigator.clipboard.read();
      const rawValues: string[] = [];
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const decoded = await decodeQrFromBlob(blob);
          rawValues.push(...decoded.rawValues);
        }
      }
      if (rawValues.length > 0) {
        return {
          rawValues,
          otpUris: extractOtpUrisFromQrResults(rawValues),
        };
      }

      for (const item of items) {
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          const text = await blob.text();
          const uris = extractOtpUrisFromQrResults([text]);
          if (uris.length > 0) {
            return { rawValues: [text.trim()], otpUris: uris };
          }
        }
      }
      throw new Error('剪贴板中未找到二维码图片或 otpauth:// 链接，请先截图或复制二维码。');
    }

    if (typeof navigator.clipboard.readText === 'function') {
      const text = await navigator.clipboard.readText();
      const uris = extractOtpUrisFromQrResults([text]);
      if (uris.length > 0) {
        return { rawValues: [text.trim()], otpUris: uris };
      }
    }
    throw new Error('请截图后直接按 ⌘V / Ctrl+V 粘贴二维码图片。');
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      throw new Error('剪贴板读取未获授权，请允许权限或直接按 ⌘V / Ctrl+V 粘贴截图。');
    }
    throw err;
  }
}
