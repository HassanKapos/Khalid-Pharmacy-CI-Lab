import type { BarcodeType } from '../../types/barcode';

export type EngineName = 'native' | 'zxing-wasm' | 'zxing-js';

export interface BarcodeEngineResult {
  barcode: string;
  format: string;
  type: BarcodeType;
  engine: EngineName;
  decodeTimeMs: number;
}

export interface IBarcodeDecoderEngine {
  readonly name: EngineName;
  init(): Promise<boolean>;
  isAvailable(): boolean;
  decode(
    source: HTMLVideoElement | ImageBitmap | ImageData | HTMLCanvasElement,
    width?: number,
    height?: number
  ): Promise<BarcodeEngineResult | null>;
  destroy(): void;
}

export interface EngineBenchmarkResult {
  engineName: EngineName;
  supported: boolean;
  initSuccess: boolean;
  avgDecodeTimeMs: number;
  successRatePercent: number;
  decodesCount: number;
  lastDecodedBarcode: string | null;
  errorReason: string | null;
}
