import { Capacitor } from '@capacitor/core';
import { BarcodeFormat } from '@capacitor-mlkit/barcode-scanning';
import { barcodeScannerService, type ScannerDiagnostics } from './barcodeScannerService';
import {
  mlKitPocService,
  type MlKitPocResult,
  RETAIL_POS_BARCODE_FORMATS,
  DEFAULT_STOCKTAKING_BARCODE_FORMATS
} from './mlKitPocService';

export { BarcodeFormat, RETAIL_POS_BARCODE_FORMATS, DEFAULT_STOCKTAKING_BARCODE_FORMATS };

export type ScannerPlatform = 'android' | 'web';
export type ActiveEngineType = 'mlkit-native' | 'zxing-wasm' | 'zxing-js';

export interface UnifiedScanResult {
  barcode: string;
  type?: string;
  engineUsed: 'ML Kit Native (Android)' | 'ZXing WASM / Web' | 'ZXing JS / Fallback';
  timestamp: number;
}

export interface UnifiedScannerStartOptions {
  videoElement?: HTMLVideoElement | null;
  target?: string;
  onScan: (result: UnifiedScanResult) => void;
  onError?: (err: Error) => void;
  onCancel?: () => void;
  onStatusChange?: (status: string, details?: string) => void;
  onDiagnostics?: (diag: ScannerDiagnostics) => void;
  continuous?: boolean;
  formats?: BarcodeFormat[];
}

/**
 * UnifiedScannerService:
 * Orchestrates platform-specific barcode engine selection:
 * - Android Native APK -> Google ML Kit Native via CameraX (mlKitPocService)
 * - Ordinary Web Browser -> ZXing WASM with JS fallback (barcodeScannerService)
 * Enforces single-camera session guarantees, clean lifecycle teardown, and normalized event contracts.
 */
export class UnifiedScannerService {
  private customPlatform: ScannerPlatform | null = null;
  private activeEngine: ActiveEngineType = 'zxing-wasm';
  private isSessionActive = false;
  private sessionCounter = 0;
  private lastRequestedContinuous: boolean | null = null;
  private lastConfiguredFormats: BarcodeFormat[] | null = null;

  public isNativePlatform(): boolean {
    if (this.customPlatform !== null) {
      return this.customPlatform === 'android';
    }
    return typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();
  }

  public getPlatform(): ScannerPlatform {
    return this.isNativePlatform() ? 'android' : 'web';
  }

  public getActiveEngine(): ActiveEngineType {
    return this.activeEngine;
  }

  public isScanning(): boolean {
    return (this.isSessionActive && (barcodeScannerService.isScanning() || mlKitPocService.isScanning())) ||
      barcodeScannerService.isScanning() ||
      mlKitPocService.isScanning();
  }

  public getLastRequestedContinuous(): boolean | null {
    return this.lastRequestedContinuous;
  }

  public getLastConfiguredFormats(): BarcodeFormat[] | null {
    return this.lastConfiguredFormats ? [...this.lastConfiguredFormats] : null;
  }

  public isSingleShotMode(): boolean {
    return this.lastRequestedContinuous === false;
  }

  /**
   * Deterministic platform routing:
   * - Android Native -> ML Kit Native via CameraX (mlKitPocService)
   * - Web Browser -> ZXing WASM (barcodeScannerService)
   * Enforces strict single camera session: tears down any pre-existing session before starting.
   */
  public async startScanning(options: UnifiedScannerStartOptions): Promise<void> {
    const entryToken = ++this.sessionCounter;

    // 1. Strict single-session guarantee: teardown any existing sessions first
    await this.stopScanning();

    // Check if an interleaving start or stop arrived while stopping
    if (this.sessionCounter !== entryToken + 1) {
      return;
    }

    const currentToken = ++this.sessionCounter;
    const isContinuous = options.continuous !== undefined ? options.continuous : (options.target === 'stocktaking');
    this.lastRequestedContinuous = isContinuous;
    const isSingleShot = !isContinuous;

    let formatsToUse: BarcodeFormat[];
    if (Array.isArray(options.formats) && options.formats.length > 0) {
      formatsToUse = options.formats;
    } else if (options.target === 'pos') {
      formatsToUse = RETAIL_POS_BARCODE_FORMATS;
    } else {
      formatsToUse = DEFAULT_STOCKTAKING_BARCODE_FORMATS;
    }
    this.lastConfiguredFormats = [...formatsToUse];

    const isNative = this.isNativePlatform();

    if (isNative) {
      this.activeEngine = 'mlkit-native';
      this.isSessionActive = true;

      try {
        await mlKitPocService.startNativeScanSession(
          (pocResult: MlKitPocResult) => {
            if (this.sessionCounter !== currentToken) return;
            if (isSingleShot) {
              this.isSessionActive = false;
            }
            const normalized: UnifiedScanResult = {
              barcode: pocResult.barcode,
              type: pocResult.format || 'EAN-13',
              engineUsed: 'ML Kit Native (Android)',
              timestamp: pocResult.timestamp || Date.now()
            };
            options.onScan(normalized);
          },
          (err: Error) => {
            if (this.sessionCounter === currentToken) {
              this.isSessionActive = false;
            }
            if (options.onError) {
              options.onError(err);
            }
          },
          {
            continuous: isContinuous,
            formats: formatsToUse,
            onCancel: () => {
              if (this.sessionCounter === currentToken) {
                this.isSessionActive = false;
              }
              if (options.onCancel) {
                options.onCancel();
              }
            }
          }
        );

        if (this.sessionCounter !== currentToken || !mlKitPocService.isScanning()) {
          this.isSessionActive = false;
        }
      } catch (err: any) {
        if (this.sessionCounter === currentToken) {
          this.isSessionActive = false;
        }
        throw err;
      }
    } else {
      // Web Browser environment: ZXing WASM
      this.activeEngine = 'zxing-wasm';
      this.isSessionActive = true;

      if (!options.videoElement) {
        this.isSessionActive = false;
        const err = new Error('عنصر الفيديو مطلوب لتشغيل ماسح الويب');
        if (options.onError) {
          options.onError(err);
        }
        throw err;
      }

      try {
        await barcodeScannerService.startScanning({
          videoElement: options.videoElement,
          onScan: (scanned) => {
            if (this.sessionCounter !== currentToken) return;
            const isSingleShot = !(options.continuous ?? (options.target === 'stocktaking'));
            if (isSingleShot) {
              this.isSessionActive = false;
              barcodeScannerService.stopScanning();
            }
            const normalized: UnifiedScanResult = {
              barcode: scanned.barcode,
              type: scanned.type,
              engineUsed: 'ZXing WASM / Web',
              timestamp: scanned.timestamp || Date.now()
            };
            options.onScan(normalized);
          },
          onError: (err) => {
            if (this.sessionCounter === currentToken) {
              this.isSessionActive = false;
            }
            if (options.onError) {
              options.onError(err);
            }
          },
          onStatusChange: options.onStatusChange,
          onDiagnostics: options.onDiagnostics
        });

        if (this.sessionCounter !== currentToken || !barcodeScannerService.isScanning()) {
          this.isSessionActive = false;
        }
      } catch (err: any) {
        if (this.sessionCounter === currentToken) {
          this.isSessionActive = false;
        }
        throw err;
      }
    }
  }

  /**
   * Stop scanning session and cleanly release all native or web camera resources
   */
  public async stopScanning(): Promise<void> {
    this.sessionCounter++;
    this.isSessionActive = false;

    if (barcodeScannerService.isScanning()) {
      barcodeScannerService.stopScanning();
    }

    await mlKitPocService.stopNativeScanSession('stopped');
    await mlKitPocService.waitForNativeQueueToSettle();
  }

  /**
   * Hardware Torch control routed to active engine
   */
  public async toggleTorch(): Promise<boolean> {
    if (this.isNativePlatform()) {
      return await mlKitPocService.toggleTorch();
    } else {
      return await barcodeScannerService.toggleTorch();
    }
  }

  /**
   * Hardware Zoom control routed to active engine
   */
  public async setZoom(zoomValue: number): Promise<number> {
    if (this.isNativePlatform()) {
      return await mlKitPocService.setZoomRatio(zoomValue);
    } else {
      return await barcodeScannerService.setZoom(zoomValue);
    }
  }

  /**
   * Testing hook to simulate Android vs Browser platforms deterministically
   */
  public setPlatformForTesting(platform: ScannerPlatform | null): void {
    this.customPlatform = platform;
  }
}

export const unifiedScannerService = new UnifiedScannerService();
