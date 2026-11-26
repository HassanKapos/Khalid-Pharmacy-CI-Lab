import type { BarcodeType } from '../../types/barcode';
import type { IBarcodeDecoderEngine, BarcodeEngineResult, EngineName } from './types';

export class NativeEngineAdapter implements IBarcodeDecoderEngine {
  readonly name: EngineName = 'native';
  private detector: any = null;
  private supportedFormats: string[] = [];
  private isInitialized = false;

  async init(): Promise<boolean> {
    try {
      if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
        const supported = await (window as any).BarcodeDetector.getSupportedFormats();
        if (Array.isArray(supported) && supported.length > 0) {
          this.supportedFormats = supported;
          const targetFormats = [
            'ean_13',
            'ean_8',
            'upc_a',
            'upc_e',
            'code_128',
            'code_39',
            'itf',
            'qr_code'
          ].filter((f) => supported.includes(f));

          this.detector = new (window as any).BarcodeDetector({
            formats: targetFormats.length > 0 ? targetFormats : supported
          });
          this.isInitialized = true;
          return true;
        }
      }
    } catch (err) {
      console.info('[NativeEngine] Native BarcodeDetector not supported in this context:', err);
    }
    this.detector = null;
    this.isInitialized = false;
    return false;
  }

  isAvailable(): boolean {
    return this.isInitialized && !!this.detector;
  }

  async decode(
    source: HTMLVideoElement | ImageBitmap | ImageData | HTMLCanvasElement
  ): Promise<BarcodeEngineResult | null> {
    if (!this.detector) return null;

    const tStart = performance.now();
    try {
      const barcodes = await this.detector.detect(source);
      const decodeTimeMs = Math.round(performance.now() - tStart);

      if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
        const raw = barcodes[0].rawValue.trim();
        const fmt = barcodes[0].format || 'unknown';
        return {
          barcode: raw,
          format: fmt,
          type: this.mapNativeFormatToType(fmt),
          engine: 'native',
          decodeTimeMs
        };
      }
    } catch (err: unknown) {
      console.error('[NativeEngine] Unexpected decode failure:', err);
      throw err;
    }
    return null;
  }

  destroy(): void {
    this.detector = null;
    this.isInitialized = false;
  }

  private mapNativeFormatToType(format: string): BarcodeType {
    const f = (format || '').toLowerCase();
    if (f.includes('ean_13') || f === 'ean13') return 'EAN-13';
    if (f.includes('ean_8') || f === 'ean8') return 'EAN-8';
    if (f.includes('upc_a') || f === 'upca') return 'UPC-A';
    if (f.includes('upc_e') || f === 'upce') return 'UPC-E';
    if (f.includes('code_128') || f === 'code128') return 'CODE-128';
    if (f.includes('code_39') || f === 'code39') return 'CODE-39';
    if (f.includes('itf')) return 'ITF';
    if (f.includes('qr')) return 'UNKNOWN'; // Will be validated by validator
    return 'UNKNOWN';
  }
}
