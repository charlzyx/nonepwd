import { JSDOM } from 'jsdom';
import { initNonePwdCore, parseAuthenticatorExport } from '@nonepwd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cropAndDecodeQrDataUrl,
  decodeQrFromFiles,
  extractClipboardImages,
  extractOtpUrisFromQrResults,
  normalizeOtpQrText,
  readQrFromSystemClipboard,
} from '../src/qr.js';

const SAMPLE_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('@nonepwd/extension QR decoding & normalization', () => {
  it('normalizes otpauth://, otpauth-migration://, and standalone 16+ char Base32 TOTP secrets', async () => {
    expect(
      normalizeOtpQrText('  OTPAUTH://totp/GitHub:alice?\r\nsecret=JBSWY3DPEHPK3PXP&issuer=GitHub  ')
    ).toBe('otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub');

    expect(
      normalizeOtpQrText('  OTPAUTH-MIGRATION://offline?data=CjEKCkhlbGxv\nSGVsbG8= ')
    ).toBe('otpauth-migration://offline?data=CjEKCkhlbGxvSGVsbG8=');

    // Raw 16+ char Base32 secret (with lowercase, spaces, hyphens, padding) -> canonical otpauth URI
    expect(normalizeOtpQrText('jbsw y3dp-ehpk 3pxp====')).toBe(
      'otpauth://totp/?secret=JBSWY3DPEHPK3PXP'
    );

    // Rejects short strings, URLs, invalid Base32 digits (0/1/8/9), and NonePwd NP3 secret keys
    expect(normalizeOtpQrText('ABCDEFGH')).toBe('ABCDEFGH');
    expect(normalizeOtpQrText('JBSWY3DPEHPK3PX8')).toBe('JBSWY3DPEHPK3PX8');
    expect(normalizeOtpQrText('https://example.com/2fa')).toBe('https://example.com/2fa');
    expect(normalizeOtpQrText('NP3-ABCDEF-GHJKMN-PQRSTU-VWXYZA-BCDEFG')).toBe(
      'NP3-ABCDEF-GHJKMN-PQRSTU-VWXYZA-BCDEFG'
    );

    const extracted = extractOtpUrisFromQrResults([
      'https://example.com/not-otp',
      'OTPAUTH://totp/Acme:bob?secret=GEZDGNBVGY3TQOJQ\njbsw y3dp ehpk 3pxp',
      'otpauth://totp/Acme:bob?secret=GEZDGNBVGY3TQOJQ',
      'OTPAUTH-MIGRATION://offline?data=abc123',
    ]);
    expect(extracted).toEqual([
      'otpauth://totp/Acme:bob?secret=GEZDGNBVGY3TQOJQ',
      'otpauth://totp/?secret=JBSWY3DPEHPK3PXP',
      'otpauth-migration://offline?data=abc123',
    ]);

    await initNonePwdCore();
    const parsed = parseAuthenticatorExport(extracted.slice(0, 2).join('\n'));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].secret).toBe('GEZDGNBVGY3TQOJQ');
    expect(parsed[1].secret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects non-data URLs to enforce 100% local zero-knowledge QR decoding', async () => {
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        async detect() {
          return [];
        }
      }
    );
    await expect(cropAndDecodeQrDataUrl('https://evil.example/qr.png')).rejects.toThrow(/data:/i);
  });

  it('crops with DPR scaling, clamps bounds, draws 16px white quiet zone, and decodes in SW OffscreenCanvas', async () => {
    const canvasCreations: Array<{ width: number; height: number; calls: Array<unknown[]> }> = [];
    const closeSpy = vi.fn();

    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: 400,
        height: 300,
        close: closeSpy,
      }))
    );

    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        width: number;
        height: number;
        calls: Array<unknown[]> = [];
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
          canvasCreations.push(this);
        }
        getContext() {
          const calls = this.calls;
          return {
            fillStyle: '',
            fillRect: (...args: unknown[]) => calls.push(['fillRect', ...args]),
            drawImage: (...args: unknown[]) => calls.push(['drawImage', ...args]),
          };
        }
      }
    );

    const detectSpy = vi.fn(async () => [
      { rawValue: 'otpauth://totp/GitHub:dev@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub' },
    ]);
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        static async getSupportedFormats() {
          return ['qr_code'];
        }
        detect = detectSpy;
      }
    );

    // Out-of-bounds right/bottom coordinates should be clamped cleanly to 400x300
    const res = await cropAndDecodeQrDataUrl(SAMPLE_PNG_DATA_URL, {
      x: 150,
      y: 100,
      width: 120,
      height: 120,
      dpr: 2,
    });

    expect(res.otpUris).toEqual([
      'otpauth://totp/GitHub:dev@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    ]);
    // Scaled: sx=300, sy=200, ex=min(400, 540)=400 -> sw=100, ey=min(300, 440)=300 -> sh=100
    // Padded canvas: (100 + 32) x (100 + 32) = 132 x 132
    expect(canvasCreations).toHaveLength(1);
    expect(canvasCreations[0].width).toBe(132);
    expect(canvasCreations[0].height).toBe(132);
    expect(canvasCreations[0].calls).toEqual([
      ['fillRect', 0, 0, 132, 132],
      ['drawImage', expect.anything(), 300, 200, 100, 100, 16, 16, 100, 100],
    ]);
    expect(detectSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('retries unpadded raw crop then falls back to full-frame boundingBox overlap filtering', async () => {
    const canvasDims: Array<[number, number]> = [];

    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: 800,
        height: 600,
        close: vi.fn(),
      }))
    );

    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
          canvasDims.push([w, h]);
        }
        getContext() {
          return {
            fillStyle: '',
            fillRect: vi.fn(),
            drawImage: vi.fn(),
          };
        }
      }
    );

    let callNum = 0;
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        async detect() {
          callNum++;
          // Call 1: padded crop -> 0 barcodes
          // Call 2: raw unpadded crop -> 0 barcodes
          if (callNum <= 2) return [];
          // Call 3: full-frame -> two QRs, only the first overlaps user rect (90,90,120,120)
          return [
            {
              rawValue: 'otpauth://totp/Target:a@b.com?secret=JBSWY3DPEHPK3PXP',
              boundingBox: { x: 100, y: 100, width: 80, height: 80 },
            },
            {
              rawValue: 'otpauth://totp/Other:c@d.com?secret=GEZDGNBVGY3TQOJQ',
              boundingBox: { x: 500, y: 400, width: 80, height: 80 },
            },
          ];
        }
      }
    );

    const res = await cropAndDecodeQrDataUrl(SAMPLE_PNG_DATA_URL, {
      x: 90,
      y: 90,
      width: 120,
      height: 120,
      dpr: 1,
    });

    expect(canvasDims).toEqual([
      [152, 152], // padded crop (120 + 32)
      [120, 120], // unpadded crop retry
    ]);
    expect(callNum).toBe(3);
    expect(res.otpUris).toEqual(['otpauth://totp/Target:a@b.com?secret=JBSWY3DPEHPK3PXP']);
  });

  it('falls back cleanly to full-frame otpauth matches when overlap check finds none', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: 500,
        height: 500,
        close: vi.fn(),
      }))
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
        }
      }
    );

    let callNum = 0;
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        async detect() {
          callNum++;
          if (callNum <= 2) return [];
          return [
            { rawValue: 'https://example.com/banner' },
            {
              rawValue: 'otpauth://totp/ZoomOffset:u@x.com?secret=JBSWY3DPEHPK3PXP',
              boundingBox: { x: 300, y: 300, width: 80, height: 80 },
            },
          ];
        }
      }
    );

    const res = await cropAndDecodeQrDataUrl(SAMPLE_PNG_DATA_URL, {
      x: 10,
      y: 10,
      width: 100,
      height: 100,
      dpr: 1,
    });
    expect(res.otpUris).toEqual(['otpauth://totp/ZoomOffset:u@x.com?secret=JBSWY3DPEHPK3PXP']);
  });

  it('supports DOM Image + <canvas> fallback when OffscreenCanvas & createImageBitmap are absent', async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('OffscreenCanvas', undefined);
    vi.stubGlobal('createImageBitmap', undefined);
    vi.stubGlobal('document', dom.window.document);

    const drawCalls: Array<unknown[]> = [];
    const origCreateElement = dom.window.document.createElement.bind(dom.window.document);
    vi.spyOn(dom.window.document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'canvas') {
        (el as unknown as { getContext: () => unknown }).getContext = () => ({
          fillStyle: '',
          fillRect: vi.fn(),
          drawImage: (...args: unknown[]) => drawCalls.push(args),
        });
      }
      return el;
    });

    vi.stubGlobal(
      'Image',
      class MockImage {
        naturalWidth = 200;
        naturalHeight = 200;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_val: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
    );

    vi.stubGlobal(
      'BarcodeDetector',
      class {
        async detect() {
          return [{ rawValue: 'otpauth://totp/DomFallback:u@site.com?secret=JBSWY3DPEHPK3PXP' }];
        }
      }
    );

    const res = await cropAndDecodeQrDataUrl(SAMPLE_PNG_DATA_URL, {
      x: 20,
      y: 30,
      width: 80,
      height: 80,
      dpr: 1,
    });

    expect(res.otpUris).toEqual(['otpauth://totp/DomFallback:u@site.com?secret=JBSWY3DPEHPK3PXP']);
    expect(drawCalls).toHaveLength(1);
    expect(drawCalls[0].slice(1)).toEqual([20, 30, 80, 80, 16, 16, 80, 80]);
  });

  it('extracts clipboard images from DataTransfer items and files', () => {
    expect(extractClipboardImages(null)).toEqual([]);

    const png = new File(['png'], 'qr.png', { type: 'image/png' });
    const txt = new File(['hello'], 'note.txt', { type: 'text/plain' });

    const fromItems = extractClipboardImages({
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => png },
      ],
      files: [txt],
    } as unknown as DataTransfer);
    expect(fromItems).toEqual([png]);

    const webp = new File(['webp'], 'shot.webp', { type: '' });
    const fromFilesFallback = extractClipboardImages({
      items: [],
      files: [txt, webp],
    } as unknown as DataTransfer);
    expect(fromFilesFallback).toEqual([webp]);
  });

  it('decodes QR from uploaded image files and system clipboard', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: 120,
        height: 120,
        close: vi.fn(),
      }))
    );
    vi.stubGlobal(
      'BarcodeDetector',
      class {
        async detect() {
          return [{ rawValue: 'otpauth://totp/Clip:me@test.dev?secret=JBSWY3DPEHPK3PXP' }];
        }
      }
    );

    const fileResult = await decodeQrFromFiles([
      new File(['ignore'], 'readme.txt', { type: 'text/plain' }),
      new File(['png'], '2fa.png', { type: 'image/png' }),
    ]);
    expect(fileResult.imageFilesCount).toBe(1);
    expect(fileResult.otpUris).toEqual(['otpauth://totp/Clip:me@test.dev?secret=JBSWY3DPEHPK3PXP']);

    vi.stubGlobal('navigator', {
      clipboard: {
        read: async () => [
          {
            types: ['image/png'],
            getType: async () => new Blob(['png'], { type: 'image/png' }),
          },
        ],
      },
    });
    const clipResult = await readQrFromSystemClipboard();
    expect(clipResult.otpUris).toEqual(['otpauth://totp/Clip:me@test.dev?secret=JBSWY3DPEHPK3PXP']);
  });
});
