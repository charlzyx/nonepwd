interface DetectedBarcode {
  rawValue?: string;
  format?: string;
}

interface BarcodeDetectorInstance {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

const IMAGE_FILE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
const OTPAUTH_URI_RE = /^otpauth(-migration)?:\/\//i;

export function isQrDetectionSupported(): boolean {
  return typeof globalThis !== 'undefined' && 'BarcodeDetector' in globalThis;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_FILE_EXT_RE.test(file.name);
}

export function normalizeOtpQrText(raw: string): string {
  const trimmed = raw.trim();
  if (/^otpauth-migration:\/\//i.test(trimmed)) {
    return `otpauth-migration://${trimmed.slice('otpauth-migration://'.length)}`.replace(/[\r\n]+/g, '');
  }
  if (/^otpauth:\/\//i.test(trimmed)) {
    return `otpauth://${trimmed.slice('otpauth://'.length)}`.replace(/[\r\n]+/g, '');
  }
  return trimmed;
}

export function isOtpQrUri(text: string): boolean {
  return OTPAUTH_URI_RE.test(text.trim());
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
      '当前浏览器不支持原生二维码识别（BarcodeDetector），请使用 Chrome / Edge / Arc 浏览器，或直接粘贴 otpauth:// 文本。'
    );
  }
  if (typeof Ctor.getSupportedFormats === 'function') {
    try {
      const formats = await Ctor.getSupportedFormats();
      if (Array.isArray(formats) && formats.length > 0 && !formats.includes('qr_code')) {
        throw new Error(
          '当前浏览器未启用 qr_code 二维码识别，请使用 Chrome / Edge / Arc 浏览器，或直接粘贴 otpauth:// 文本。'
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

async function detectWithBitmapOrImage(
  detector: BarcodeDetectorInstance,
  blob: Blob
): Promise<DetectedBarcode[]> {
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(blob);
      return await detector.detect(bitmap);
    } catch {
      // fall through to HTMLImageElement fallback
    } finally {
      bitmap?.close();
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = objectUrl;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('无法加载图片以识别二维码'));
    });
    return await detector.detect(img);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function decodeQrFromBlob(
  blob: Blob
): Promise<{ rawValues: string[]; otpUris: string[] }> {
  const detector = await createQrDetector();
  const barcodes = await detectWithBitmapOrImage(detector, blob);
  const rawValues = barcodes
    .map((b) => (typeof b.rawValue === 'string' ? b.rawValue.trim() : ''))
    .filter(Boolean);
  return {
    rawValues,
    otpUris: extractOtpUrisFromQrResults(rawValues),
  };
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

export function extractClipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const images: File[] = [];
  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) images.push(file);
      }
    }
  }
  if (images.length === 0 && data.files) {
    for (const file of Array.from(data.files)) {
      if (isImageFile(file)) {
        images.push(file);
      }
    }
  }
  return images;
}

export function extractClipboardText(data: DataTransfer | null): string {
  if (!data) return '';
  return data.getData('text/plain') ?? '';
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

export interface CameraQrScannerOptions {
  video: HTMLVideoElement;
  onDetect: (otpUris: string[], rawValues: string[]) => void;
  onError?: (error: Error) => void;
  intervalMs?: number;
}

export async function startQrCameraScan(
  options: CameraQrScannerOptions
): Promise<() => void> {
  const { video, onDetect, onError, intervalMs = 250 } = options;
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持摄像头访问（getUserMedia）。');
  }

  const detector = await createQrDetector();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
  }

  let stopped = false;
  let inFlight = false;
  let timerId: number | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
    if (video.srcObject === stream) {
      video.srcObject = null;
    }
  };

  try {
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
  } catch (err) {
    stop();
    throw err instanceof Error ? err : new Error('无法启动摄像头预览');
  }

  timerId = window.setInterval(() => {
    if (stopped || inFlight) return;
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;

    inFlight = true;
    void detector
      .detect(video)
      .then((barcodes) => {
        if (stopped || barcodes.length === 0) return;
        const rawValues = barcodes
          .map((b) => (typeof b.rawValue === 'string' ? b.rawValue.trim() : ''))
          .filter(Boolean);
        if (rawValues.length === 0) return;
        const otpUris = extractOtpUrisFromQrResults(rawValues);
        onDetect(otpUris, rawValues);
      })
      .catch((err) => {
        if (!stopped && onError) {
          onError(err instanceof Error ? err : new Error('摄像头二维码检测失败'));
        }
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  return stop;
}
