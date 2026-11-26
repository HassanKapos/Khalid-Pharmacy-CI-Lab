import { readBarcodesFromImageData, type ReaderOptions } from 'zxing-wasm/reader';
import type { BarcodeType } from '../../types/barcode';
import type { IBarcodeDecoderEngine, BarcodeEngineResult, EngineName } from './types';

export class ZXingWasmEngineAdapter implements IBarcodeDecoderEngine {
  readonly name: EngineName = 'zxing-wasm';
  private isInitialized = false;
  private readerOptions: ReaderOptions = {
    formats: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'Code39', 'ITF', 'QRCode', 'DataMatrix'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    binarizer: 'LocalAverage',
    maxNumberOfSymbols: 1
  };
  private offscreenCanvas: HTMLCanvasElement | null = null;
  private offscreenCtx: CanvasRenderingContext2D | null = null;

  async init(): Promise<boolean> {
    try {
      // Pre-warm WASM reader options
      this.isInitialized = true;
      return true;
    } catch (err) {
      console.warn('[ZXingWasmEngine] Init failed:', err);
      this.isInitialized = false;
      return false;
    }
  }

  isAvailable(): boolean {
    return this.isInitialized;
  }

  async decode(
    source: HTMLVideoElement | ImageBitmap | ImageData | HTMLCanvasElement,
    width?: number,
    height?: number
  ): Promise<BarcodeEngineResult | null> {
    if (!this.isInitialized) return null;

    const tStart = performance.now();
    try {
      let imageData: ImageData | null = null;

      if (
        (typeof ImageData !== 'undefined' && source instanceof ImageData) ||
        (source && typeof source === 'object' && 'data' in source && 'width' in source && 'height' in source)
      ) {
        imageData = source as ImageData;
      } else if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
        const ctx = source.getContext('2d');
        if (ctx) {
          imageData = ctx.getImageData(0, 0, source.width, source.height);
        }
      } else if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
        const vw = width || source.videoWidth;
        const vh = height || source.videoHeight;
        if (vw > 0 && vh > 0) {
          if (!this.offscreenCanvas) {
            this.offscreenCanvas = document.createElement('canvas');
            this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
          }
          if (this.offscreenCanvas && this.offscreenCtx) {
            if (this.offscreenCanvas.width !== vw || this.offscreenCanvas.height !== vh) {
              this.offscreenCanvas.width = vw;
              this.offscreenCanvas.height = vh;
            }
            this.offscreenCtx.drawImage(source, 0, 0, vw, vh);
            imageData = this.offscreenCtx.getImageData(0, 0, vw, vh);
          }
        }
      }

      if (!imageData || !imageData.data || imageData.width <= 0 || imageData.height <= 0) return null;

      const results = await readBarcodesFromImageData(imageData, this.readerOptions);
      const decodeTimeMs = Math.round(performance.now() - tStart);

      if (results && results.length > 0 && results[0].text) {
        const raw = results[0].text.trim();
        const fmt = String(results[0].format || 'UNKNOWN');
        return {
          barcode: raw,
          format: fmt,
          type: this.mapZxingWasmFormatToType(fmt),
          engine: 'zxing-wasm',
          decodeTimeMs
        };
      }
    } catch (err: unknown) {
      console.error('[ZXingWasmEngine] Unexpected decode failure:', err);
      throw err;
    }
    return null;
  }

  destroy(): void {
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.isInitialized = false;
  }

  private mapZxingWasmFormatToType(format: string): BarcodeType {
    const f = (format || '').toUpperCase();
    if (f.includes('EAN_13') || f.includes('EAN13')) return 'EAN-13';
    if (f.includes('EAN_8') || f.includes('EAN8')) return 'EAN-8';
    if (f.includes('UPC_A') || f.includes('UPCA')) return 'UPC-A';
    if (f.includes('UPC_E') || f.includes('UPCE')) return 'UPC-E';
    if (f.includes('CODE_128') || f.includes('CODE128')) return 'CODE-128';
    if (f.includes('CODE_39') || f.includes('CODE39')) return 'CODE-39';
    if (f.includes('ITF')) return 'ITF';
    return 'UNKNOWN';
  }
}
