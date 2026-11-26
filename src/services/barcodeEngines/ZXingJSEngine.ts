import * as ZXingLib from '@zxing/library';
import type {
  MultiFormatReader as MultiFormatReaderType,
  DecodeHintType as DecodeHintTypeType
} from '@zxing/library';
import type { BarcodeType } from '../../types/barcode';
import type { IBarcodeDecoderEngine, BarcodeEngineResult, EngineName } from './types';

const zxingModule = ZXingLib as Record<string, any>;
const ZXing: any = zxingModule['default'] && zxingModule['default'].MultiFormatReader
  ? zxingModule['default']
  : ZXingLib;

const MultiFormatReader = ZXing.MultiFormatReader || (ZXingLib as any).MultiFormatReader;
const BarcodeFormat = ZXing.BarcodeFormat || (ZXingLib as any).BarcodeFormat;
const DecodeHintType = ZXing.DecodeHintType || (ZXingLib as any).DecodeHintType;
const RGBLuminanceSource = ZXing.RGBLuminanceSource || (ZXingLib as any).RGBLuminanceSource;
const BinaryBitmap = ZXing.BinaryBitmap || (ZXingLib as any).BinaryBitmap;
const HybridBinarizer = ZXing.HybridBinarizer || (ZXingLib as any).HybridBinarizer;
const NotFoundException = ZXing.NotFoundException || (ZXingLib as any).NotFoundException;
const ChecksumException = ZXing.ChecksumException || (ZXingLib as any).ChecksumException;
const FormatException = ZXing.FormatException || (ZXingLib as any).FormatException;
const ReaderException = ZXing.ReaderException || (ZXingLib as any).ReaderException;

function isExpectedZXingDecodeMiss(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (
    (typeof NotFoundException === 'function' && err instanceof NotFoundException) ||
    (typeof ChecksumException === 'function' && err instanceof ChecksumException) ||
    (typeof FormatException === 'function' && err instanceof FormatException) ||
    (typeof ReaderException === 'function' && err instanceof ReaderException)
  );
}

export class ZXingJSEngineAdapter implements IBarcodeDecoderEngine {
  readonly name: EngineName = 'zxing-js';
  private reader: MultiFormatReaderType | null = null;
  private isInitialized = false;
  private offscreenCanvas: HTMLCanvasElement | null = null;
  private offscreenCtx: CanvasRenderingContext2D | null = null;

  async init(): Promise<boolean> {
    try {
      const hints = new Map<DecodeHintTypeType, any>();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.ITF,
        BarcodeFormat.QR_CODE
      ]);
      hints.set(DecodeHintType.TRY_HARDER, true);

      const mfr = new MultiFormatReader();
      mfr.setHints(hints);
      this.reader = mfr;
      this.isInitialized = true;
      return true;
    } catch (e) {
      console.warn('[ZXingJSEngine] Init warning:', e);
      try {
        this.reader = new MultiFormatReader();
        this.isInitialized = true;
        return true;
      } catch (err) {
        this.isInitialized = false;
        return false;
      }
    }
  }

  isAvailable(): boolean {
    return this.isInitialized && !!this.reader;
  }

  async decode(
    source: HTMLVideoElement | ImageBitmap | ImageData | HTMLCanvasElement,
    width?: number,
    height?: number
  ): Promise<BarcodeEngineResult | null> {
    if (!this.reader) return null;

    const tStart = performance.now();
    try {
      let imageData: ImageData | null = null;
      let w = width || 0;
      let h = height || 0;

      if (
        (typeof ImageData !== 'undefined' && source instanceof ImageData) ||
        (source && typeof source === 'object' && 'data' in source && 'width' in source && 'height' in source)
      ) {
        imageData = source as ImageData;
        w = (source as any).width;
        h = (source as any).height;
      } else if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
        w = source.width;
        h = source.height;
        const ctx = source.getContext('2d');
        if (ctx) {
          imageData = ctx.getImageData(0, 0, w, h);
        }
      } else if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
        w = width || source.videoWidth;
        h = height || source.videoHeight;
        if (w > 0 && h > 0) {
          if (!this.offscreenCanvas) {
            this.offscreenCanvas = document.createElement('canvas');
            this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
          }
          if (this.offscreenCanvas && this.offscreenCtx) {
            if (this.offscreenCanvas.width !== w || this.offscreenCanvas.height !== h) {
              this.offscreenCanvas.width = w;
              this.offscreenCanvas.height = h;
            }
            this.offscreenCtx.drawImage(source, 0, 0, w, h);
            imageData = this.offscreenCtx.getImageData(0, 0, w, h);
          }
        }
      }

      if (!imageData || w <= 0 || h <= 0) return null;

      const pixels = imageData.data;
      const totalPixels = w * h;
      const grayscale = new Uint8ClampedArray(totalPixels);

      // Convert RGBA to 8-bit Grayscale
      for (let i = 0, j = 0; i < totalPixels; i++, j += 4) {
        grayscale[i] = (pixels[j] * 77 + pixels[j + 1] * 150 + pixels[j + 2] * 29) >> 8;
      }

      const lumSource = new RGBLuminanceSource(grayscale, w, h);
      const bitmap = new BinaryBitmap(new HybridBinarizer(lumSource));
      const result = this.reader.decode(bitmap);

      const decodeTimeMs = Math.round(performance.now() - tStart);

      if (result) {
        const raw = result.getText().trim();
        const fmt = String(result.getBarcodeFormat());
        return {
          barcode: raw,
          format: fmt,
          type: this.mapZxingFormatToType(fmt),
          engine: 'zxing-js',
          decodeTimeMs
        };
      }
    } catch (err: unknown) {
      if (isExpectedZXingDecodeMiss(err)) {
        // Normal unsuccessful decode attempt for current frame (no barcode, checksum mismatch, or unreadable format)
        return null;
      }
      console.error('[ZXingJSEngine] Unexpected decode failure:', err);
      throw err;
    }
    return null;
  }

  destroy(): void {
    this.reader = null;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.isInitialized = false;
  }

  private mapZxingFormatToType(format: string): BarcodeType {
    const f = String(format);
    if (f.includes('EAN_13') || f === '7') return 'EAN-13';
    if (f.includes('EAN_8') || f === '6') return 'EAN-8';
    if (f.includes('UPC_A') || f === '14') return 'UPC-A';
    if (f.includes('UPC_E') || f === '15') return 'UPC-E';
    if (f.includes('CODE_128') || f === '4') return 'CODE-128';
    if (f.includes('CODE_39') || f === '3') return 'CODE-39';
    if (f.includes('ITF') || f === '8') return 'ITF';
    return 'UNKNOWN';
  }
}
