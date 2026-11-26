/**
 * Static Image Barcode Extraction Engine (Barcode-First Offline Decoder)
 *
 * Extracts standard pharmaceutical barcodes (EAN-13, EAN-8, UPC-A, UPC-E, Code 128,
 * Code 39, ITF, QRCode, DataMatrix) directly from still captured photos or cropped regions
 * BEFORE OCR text recognition runs.
 *
 * Strictly offline-first (uses local zxing-wasm/reader + optional browser BarcodeDetector).
 */

import { readBarcodesFromImageData, type ReaderOptions } from 'zxing-wasm/reader';
import { validateBarcode } from './barcodeValidator.ts';
import type { BarcodeType } from '../types/barcode.ts';

export interface StaticBarcodeDecodeResult {
  barcode: string;
  format: string;
  type: BarcodeType;
  isValid: boolean;
  engine: 'zxing-wasm' | 'barcode-detector' | 'custom';
  decodeTimeMs: number;
}

export type StaticBarcodeCustomDecoder = (
  input: Blob | string | HTMLCanvasElement | ImageData
) => Promise<StaticBarcodeDecodeResult | null>;

const STATIC_READER_OPTIONS: ReaderOptions = {
  formats: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'Code39', 'ITF', 'QRCode', 'DataMatrix'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  binarizer: 'LocalAverage',
  maxNumberOfSymbols: 3
};

function mapFormatToType(format: string): BarcodeType {
  const f = String(format || '').toUpperCase();
  if (f.includes('EAN_13') || f.includes('EAN-13') || f.includes('EAN13')) return 'EAN-13';
  if (f.includes('EAN_8') || f.includes('EAN-8') || f.includes('EAN8')) return 'EAN-8';
  if (f.includes('UPC_A') || f.includes('UPC-A') || f.includes('UPCA')) return 'UPC-A';
  if (f.includes('UPC_E') || f.includes('UPC-E') || f.includes('UPCE')) return 'UPC-E';
  if (f.includes('CODE_128') || f.includes('CODE-128') || f.includes('CODE128')) return 'CODE-128';
  if (f.includes('CODE_39') || f.includes('CODE-39') || f.includes('CODE39')) return 'CODE-39';
  if (f.includes('ITF')) return 'ITF';
  return 'UNKNOWN';
}

function scoreCandidate(barcode: string, format: string): number {
  const val = validateBarcode(barcode);
  let score = val.isValid ? 100 : 10;
  if (/^\d{13}$/.test(val.normalizedBarcode) && val.type === 'EAN-13') score += 50;
  else if (/^\d{12}$/.test(val.normalizedBarcode) && val.type === 'UPC-A') score += 45;
  else if (/^\d{8}$/.test(val.normalizedBarcode) && val.type === 'EAN-8') score += 40;
  else if (format.toUpperCase().includes('CODE_128') || format.toUpperCase().includes('CODE128')) score += 25;
  return score;
}

class StaticImageBarcodeService {
  private customDecoder: StaticBarcodeCustomDecoder | null = null;

  /**
   * Optional hook primarily for deterministic offline/unit testing.
   */
  public setCustomDecoder(decoder: StaticBarcodeCustomDecoder | null): void {
    this.customDecoder = decoder;
  }

  private async toCanvas(input: Blob | string | HTMLCanvasElement): Promise<HTMLCanvasElement | null> {
    if (typeof document === 'undefined') return null;

    if (typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement) {
      return input;
    }

    if (typeof Image === 'undefined') return null;

    let srcUrl = '';
    let shouldRevoke = false;
    try {
      if (typeof input === 'string') {
        if (!input.startsWith('data:image/') && !input.startsWith('blob:')) return null;
        srcUrl = input;
      } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
        if (input.size <= 0 || (input.type && !input.type.startsWith('image/'))) return null;
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          srcUrl = URL.createObjectURL(input);
          shouldRevoke = true;
        }
      }
      if (!srcUrl) return null;

      return await new Promise<HTMLCanvasElement | null>((resolve) => {
        const img = new Image();
        img.onload = () => {
          try {
            const natW = img.naturalWidth || img.width || 0;
            const natH = img.naturalHeight || img.height || 0;
            if (natW <= 0 || natH <= 0) {
              resolve(null);
              return;
            }
            // Cap longest edge at 1400px for fast decode on mobile while keeping crisp 1D bars
            const maxEdge = 1400;
            const scale = Math.max(natW, natH) > maxEdge ? maxEdge / Math.max(natW, natH) : 1;
            const targetW = Math.max(1, Math.round(natW * scale));
            const targetH = Math.max(1, Math.round(natH * scale));
            const canvas = document.createElement('canvas');
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d', { willReadFrequently: true }) : null;
            if (!ctx) {
              resolve(null);
              return;
            }
            ctx.drawImage(img, 0, 0, targetW, targetH);
            resolve(canvas);
          } catch {
            resolve(null);
          } finally {
            if (shouldRevoke) {
              try { URL.revokeObjectURL(srcUrl); } catch { /* ignore */ }
            }
          }
        };
        img.onerror = () => {
          if (shouldRevoke) {
            try { URL.revokeObjectURL(srcUrl); } catch { /* ignore */ }
          }
          resolve(null);
        };
        img.src = srcUrl;
      });
    } catch {
      if (shouldRevoke && srcUrl) {
        try { URL.revokeObjectURL(srcUrl); } catch { /* ignore */ }
      }
      return null;
    }
  }

  public async decodeFromImageData(imageData: ImageData): Promise<StaticBarcodeDecodeResult | null> {
    if (!imageData || !imageData.data || imageData.width <= 0 || imageData.height <= 0) return null;
    const tStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      const results = await readBarcodesFromImageData(imageData, STATIC_READER_OPTIONS);
      const elapsed = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tStart);
      if (results && results.length > 0) {
        const sorted = results
          .filter((r) => Boolean(r && r.text && r.text.trim()))
          .map((r) => ({
            text: r.text.trim(),
            format: String(r.format || 'UNKNOWN'),
            score: scoreCandidate(r.text.trim(), String(r.format || ''))
          }))
          .sort((a, b) => b.score - a.score);

        if (sorted.length > 0) {
          const top = sorted[0];
          const validated = validateBarcode(top.text);
          const detectedType = mapFormatToType(top.format);
          return {
            barcode: validated.normalizedBarcode || top.text,
            format: top.format,
            type: detectedType !== 'UNKNOWN' ? detectedType : validated.type,
            isValid: validated.isValid,
            engine: 'zxing-wasm',
            decodeTimeMs: elapsed
          };
        }
      }
    } catch {
      // ZXing WASM unavailable or decode error in current runtime
    }
    return null;
  }

  public async decodeFromImage(
    input: Blob | string | HTMLCanvasElement | ImageData | undefined | null
  ): Promise<StaticBarcodeDecodeResult | null> {
    if (!input) return null;

    if (this.customDecoder) {
      try {
        const customRes = await this.customDecoder(input);
        if (customRes && customRes.barcode) return customRes;
      } catch {
        // Fallback to native/WASM decoders
      }
    }

    if (
      (typeof ImageData !== 'undefined' && input instanceof ImageData) ||
      (typeof input === 'object' && input !== null && 'data' in input && 'width' in input && 'height' in input)
    ) {
      return this.decodeFromImageData(input as ImageData);
    }

    const canvas = await this.toCanvas(input as Blob | string | HTMLCanvasElement);
    if (!canvas) return null;

    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d', { willReadFrequently: true }) : null;
    if (ctx && canvas.width > 0 && canvas.height > 0) {
      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const zxingRes = await this.decodeFromImageData(imageData);
        if (zxingRes && zxingRes.barcode) {
          return zxingRes;
        }
      } catch {
        // Canvas tainted or synthetic mock without pixel buffer
      }
    }

    // Optional browser-native BarcodeDetector fallback
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      const tStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
      try {
        const BarcodeDetectorCtor = (window as unknown as { BarcodeDetector: any }).BarcodeDetector;
        const detector = new BarcodeDetectorCtor({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix']
        });
        const detected = await detector.detect(canvas);
        const elapsed = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tStart);
        if (Array.isArray(detected) && detected.length > 0 && detected[0]?.rawValue) {
          const raw = String(detected[0].rawValue).trim();
          const fmt = String(detected[0].format || 'UNKNOWN');
          const validated = validateBarcode(raw);
          const mappedType = mapFormatToType(fmt);
          return {
            barcode: validated.normalizedBarcode || raw,
            format: fmt,
            type: mappedType !== 'UNKNOWN' ? mappedType : validated.type,
            isValid: validated.isValid,
            engine: 'barcode-detector',
            decodeTimeMs: elapsed
          };
        }
      } catch {
        // Native BarcodeDetector fallback failed silently
      }
    }

    return null;
  }
}

export const staticImageBarcodeService = new StaticImageBarcodeService();
