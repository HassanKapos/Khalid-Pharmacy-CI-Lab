/**
 * Enterprise Barcode Scanner Service – Khalid Pharmacy
 * Multi-Engine Architecture with Adapter Pattern:
 * - Hardware Native BarcodeDetector API
 * - ZXing WebAssembly C++ Engine (zxing-wasm)
 * - Pure ZXing JS Fallback Engine
 * Advanced Camera Hardware Controls:
 * - Rear camera default (`facingMode: { ideal: 'environment' }`)
 * - Continuous Autofocus & Continuous Exposure
 * - Hardware Flash / Torch Control
 * - Optical / Digital Hardware Zoom Control
 * - Aspect-Ratio Preserving ROI Canvas Sampling
 * - Enterprise Diagnostics & Metrics
 * - 100% Offline Capable & Single-Session Guaranteed
 */

import type { BarcodeScanEvent, BarcodeType } from '../types/barcode';
import { validateBarcode } from './barcodeValidator';
import { BarcodeEngineManager } from './barcodeEngines/EngineManager';
import type { EngineName, EngineBenchmarkResult } from './barcodeEngines/types';

export type ScannerStatus = 'starting' | 'searching' | 'found' | 'error' | 'stopped';

export interface ZoomCapabilities {
  supported: boolean;
  min: number;
  max: number;
  step: number;
  current: number;
}

export interface ScannerDiagnostics {
  // Init & Hardware
  cameraInitTimeMs: number;
  resolution: string;
  activeCameraLabel: string | null;
  activeFocusMode: string | null;
  continuousFocusApplied: boolean;
  videoStabilizationTimeMs: number;
  torchAvailable: boolean;
  nativeFormats: string[];
  zoomCapabilities: ZoomCapabilities;
  isScanning: boolean;

  // Frame & Decode Counts
  receivedFrames: number;
  processedFrames: number;
  decodeAttempts: number;
  successfulScans: number;
  failedScans: number;
  cameraFrameFailures: number;
  barcodeDecodeFailures: number;

  // Timings & Metrics
  fps: number;
  avgDecodeTimeMs: number;
  lastDecodeTimeMs: number;

  // Engine Details
  activeDecoder: EngineName;
  fallbackReason: string | null;
  turboMode?: boolean;
  zoomMode?: 'hardware' | 'software';

  // Errors Log
  cameraErrors: string[];
  decodeErrors: string[];

  // Last Scanned Item
  lastScannedBarcode: string | null;
  lastScannedTime: number;
}

export interface ScannerOptions {
  videoElement: HTMLVideoElement;
  onScan: (event: BarcodeScanEvent) => void;
  onError?: (error: Error) => void;
  onStatusChange?: (status: ScannerStatus, details?: string) => void;
  onDiagnostics?: (diagnostics: ScannerDiagnostics) => void;
  cooldownMs?: number;
  playBeep?: boolean;
  vibrate?: boolean;
  turboMode?: boolean;
}

export class BarcodeScannerService {
  private videoElement: HTMLVideoElement | null = null;
  private mediaStream: MediaStream | null = null;
  private currentDeviceId: string | null = null;
  private activeCameraLabel: string | null = null;
  private activeFocusMode: string | null = null;
  private continuousFocusApplied = false;
  private availableCameras: MediaDeviceInfo[] = [];
  private _isScanning = false;
  private _isPaused = false;
  private animationFrameId: number | null = null;
  private isDecodingInProgress = false;

  // Engine Manager
  private engineManager: BarcodeEngineManager;

  // Offscreen canvas for frame extraction
  private offscreenCanvas: HTMLCanvasElement | null = null;
  private offscreenCtx: CanvasRenderingContext2D | null = null;

  // Hardware Controls State
  private torchEnabled = false;
  private currentZoom = 1.0;
  private turboMode = true;
  private zoomCapabilities: ZoomCapabilities = {
    supported: false,
    min: 1.0,
    max: 1.0,
    step: 0.1,
    current: 1.0
  };

  // Cooldown & Single Dispatch
  private lastScannedBarcode: string | null = null;
  private lastScannedTime = 0;
  private cooldownMs = 1800;

  // Callbacks
  private onScanCallback: ((event: BarcodeScanEvent) => void) | null = null;
  private onErrorCallback: ((error: Error) => void) | null = null;
  private onStatusCallback: ((status: ScannerStatus, details?: string) => void) | null = null;
  private onDiagnosticsCallback: ((diag: ScannerDiagnostics) => void) | null = null;
  private currentStatus: ScannerStatus = 'stopped';

  // Feedback
  private playBeep = true;
  private vibrate = true;

  // Diagnostics Metrics
  private cameraInitTimeMs = 0;
  private receivedFrames = 0;
  private processedFrames = 0;
  private decodeAttempts = 0;
  private successfulScans = 0;
  private failedScans = 0;
  private cameraFrameFailures = 0;
  private barcodeDecodeFailures = 0;
  private totalDecodeTimeSum = 0;
  private lastDecodeTimeMs = 0;
  private fps = 0;
  private lastFpsTimestamp = 0;
  private lastFrameTimestamp = 0;
  private lastDiagLogTime = 0;
  private scanCadenceCounter = 0;
  private cameraErrors: string[] = [];
  private decodeErrors: string[] = [];

  constructor() {
    this.engineManager = new BarcodeEngineManager();
    this.engineManager.initAll().catch((err) => {
      console.warn('[BarcodeScanner] EngineManager init warning:', err);
    });
  }

  private notifyStatus(status: ScannerStatus, details?: string): void {
    this.currentStatus = status;
    if (this.onStatusCallback) {
      try {
        this.onStatusCallback(status, details);
      } catch (err) {
        console.warn('[BarcodeScanner] Status callback error:', err);
      }
    }
  }

  public getStatus(): ScannerStatus {
    return this.currentStatus;
  }

  /**
   * Get real-time Enterprise Diagnostic snapshot
   */
  public getDiagnostics(): ScannerDiagnostics {
    const vw = this.videoElement?.videoWidth || 0;
    const vh = this.videoElement?.videoHeight || 0;
    const avgDecodeTimeMs =
      this.decodeAttempts > 0
        ? Math.round(this.totalDecodeTimeSum / this.decodeAttempts)
        : 0;

    return {
      cameraInitTimeMs: this.cameraInitTimeMs,
      resolution: vw > 0 ? `${vw}x${vh}` : 'N/A',
      activeCameraLabel: this.activeCameraLabel,
      activeFocusMode: this.activeFocusMode,
      continuousFocusApplied: this.continuousFocusApplied,
      videoStabilizationTimeMs: this.cameraInitTimeMs,
      torchAvailable: this.isTorchSupported(),
      nativeFormats: [
        'ean_13',
        'ean_8',
        'upc_a',
        'upc_e',
        'code_128',
        'code_39',
        'itf',
        'qr_code'
      ],
      zoomCapabilities: { ...this.zoomCapabilities },
      isScanning: this._isScanning,

      receivedFrames: this.receivedFrames,
      processedFrames: this.processedFrames,
      decodeAttempts: this.decodeAttempts,
      successfulScans: this.successfulScans,
      failedScans: this.failedScans,
      cameraFrameFailures: this.cameraFrameFailures,
      barcodeDecodeFailures: this.barcodeDecodeFailures,

      fps: this.fps,
      avgDecodeTimeMs,
      lastDecodeTimeMs: this.lastDecodeTimeMs,

      activeDecoder: this.engineManager.getActiveEngineName(),
      fallbackReason: this.engineManager.getFallbackReason(),
      turboMode: this.turboMode,
      zoomMode: this.zoomCapabilities.supported ? 'hardware' : 'software',

      cameraErrors: [...this.cameraErrors.slice(-5)],
      decodeErrors: [...this.decodeErrors.slice(-5)],

      lastScannedBarcode: this.lastScannedBarcode,
      lastScannedTime: this.lastScannedTime
    };
  }

  /**
   * Enumerate available video input devices (cameras) on this device
   */
  public async getAvailableCameras(): Promise<MediaDeviceInfo[]> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return [];
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.availableCameras = devices.filter((d) => d.kind === 'videoinput');
      return this.availableCameras;
    } catch (err: any) {
      console.warn('[BarcodeScanner] Could not enumerate cameras:', err);
      this.cameraErrors.push(err?.message || 'Error enumerating devices');
      return [];
    }
  }

  /**
   * Start scanning session on target HTMLVideoElement with single session guarantee
   */
  public async startScanning(options: ScannerOptions): Promise<void> {
    // Ensure clean teardown of any pre-existing session before starting a new one
    this.stopScanning();

    this.videoElement = options.videoElement;
    this.onScanCallback = options.onScan;
    this.onErrorCallback = options.onError || null;
    this.onStatusCallback = options.onStatusChange || null;
    this.onDiagnosticsCallback = options.onDiagnostics || null;
    this.cooldownMs = options.cooldownMs ?? 1800;
    this.playBeep = options.playBeep ?? true;
    this.vibrate = options.vibrate ?? true;

    // Reset Metrics
    this.receivedFrames = 0;
    this.processedFrames = 0;
    this.decodeAttempts = 0;
    this.successfulScans = 0;
    this.failedScans = 0;
    this.cameraFrameFailures = 0;
    this.barcodeDecodeFailures = 0;
    this.totalDecodeTimeSum = 0;
    this.lastDecodeTimeMs = 0;
    this.fps = 0;
    this.lastFpsTimestamp = Date.now();
    this.lastDiagLogTime = Date.now();
    this.cameraErrors = [];
    this.decodeErrors = [];

    this.notifyStatus('starting', 'جارٍ تشغيل الكاميرا وإعداد المورد الحياتي...');

    const tInitStart = performance.now();
    try {
      await this.initCameraStream();
      this.cameraInitTimeMs = Math.round(performance.now() - tInitStart);
      this._isScanning = true;
      this._isPaused = false;
      this.notifyStatus('searching', 'الكاميرا جاهزة والمحرك نشط');
      this.startDetectionLoop();
    } catch (err: any) {
      const error = this.normalizeCameraError(err);
      this.cameraErrors.push(error.message);
      this.notifyStatus('error', error.message);
      if (this.onErrorCallback) {
        this.onErrorCallback(error);
      }
      throw error;
    }
  }

  /**
   * Initialize MediaStream with rear camera preference, continuous focus/exposure & zoom capabilities
   */
  private async initCameraStream(preferredDeviceId?: string): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('الكاميرا غير مدعومة في هذا المتصفح');
    }

    // Step 1: Enumerate and audit cameras if not already populated
    await this.getAvailableCameras();

    let targetDeviceId = preferredDeviceId;

    // Step 2: Smart Selection of Main Rear Camera if no preferred device specified
    if (!targetDeviceId && this.availableCameras.length > 0) {
      const backCameras = this.availableCameras.filter((cam) => {
        const label = (cam.label || '').toLowerCase();
        return (
          label.includes('back') ||
          label.includes('rear') ||
          label.includes('الخلفية') ||
          label.includes('environment') ||
          (!label.includes('front') && !label.includes('selfie') && !label.includes('امامية'))
        );
      });

      if (backCameras.length > 0) {
        // Prioritize main back camera by avoiding ultra-wide or telephoto if multiple back options exist
        const mainBack = backCameras.find((cam) => {
          const l = (cam.label || '').toLowerCase();
          return !l.includes('ultra') && !l.includes('wide-angle') && !l.includes('telephoto');
        });
        targetDeviceId = mainBack ? mainBack.deviceId : backCameras[0].deviceId;
      }
    }

    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: 1920, min: 1280 },
      height: { ideal: 1080, min: 720 },
      facingMode: targetDeviceId ? undefined : { ideal: 'environment' },
      ...(targetDeviceId ? { deviceId: { exact: targetDeviceId } } : {})
    };

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });
    } catch (err: any) {
      console.warn('[BarcodeScanner] getUserMedia with primary constraints failed, retrying with relaxed constraints:', err);
      await new Promise((r) => setTimeout(r, 200));
      try {
        // Retry with basic environment or deviceId without strict resolution
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          video: targetDeviceId
            ? { deviceId: { exact: targetDeviceId }, width: { ideal: 1280, min: 640 }, height: { ideal: 720, min: 480 } }
            : { facingMode: { ideal: 'environment' }, width: { ideal: 1280, min: 640 }, height: { ideal: 720, min: 480 } },
          audio: false
        });
      } catch (retryErr: any) {
        // Final fallback to any available video stream
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });
      }
    }

    if (this.videoElement) {
      this.videoElement.srcObject = this.mediaStream;
      this.videoElement.setAttribute('playsinline', 'true');
      this.videoElement.muted = true;
      try {
        await this.videoElement.play();
      } catch (playErr: any) {
        console.warn('[BarcodeScanner] Autoplay prevented, awaiting user gesture:', playErr);
        this.cameraErrors.push('Autoplay prevented: ' + (playErr?.message || 'gesture required'));
      }
    }

    // Step 3: Apply continuous focus mode, exposure, zoom constraints and verify actual settings
    const activeTrack = this.mediaStream.getVideoTracks()[0];
    if (activeTrack) {
      const settings = activeTrack.getSettings();
      this.currentDeviceId = settings.deviceId || null;

      // Find label from available cameras list matching current deviceId
      const matchedCam = this.availableCameras.find((c) => c.deviceId === this.currentDeviceId);
      this.activeCameraLabel = matchedCam?.label || activeTrack.label || 'Default Camera';

      try {
        const caps = (activeTrack.getCapabilities ? activeTrack.getCapabilities() : {}) as any;
        const advanced: any = {};

        if (caps.focusMode && Array.isArray(caps.focusMode)) {
          if (caps.focusMode.includes('continuous')) {
            advanced.focusMode = 'continuous';
          } else if (caps.focusMode.includes('macro')) {
            advanced.focusMode = 'macro';
          }
        }

        if (caps.exposureMode && Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) {
          advanced.exposureMode = 'continuous';
        }

        // Hardware Zoom Capabilities
        if (caps.zoom) {
          this.zoomCapabilities = {
            supported: true,
            min: caps.zoom.min || 1.0,
            max: caps.zoom.max || 4.0,
            step: caps.zoom.step || 0.1,
            current: settings.zoom || 1.0
          };
          this.currentZoom = this.zoomCapabilities.current;
        } else {
          this.zoomCapabilities = { supported: false, min: 1.0, max: 1.0, step: 0.1, current: 1.0 };
        }

        if (Object.keys(advanced).length > 0 && typeof activeTrack.applyConstraints === 'function') {
          await activeTrack.applyConstraints({ advanced: [advanced] });
        }
      } catch (constraintErr: any) {
        console.warn('[BarcodeScanner] Optional advanced constraints failed:', constraintErr);
      }

      // Re-read settings to verify actual focus mode applied
      const finalSettings = activeTrack.getSettings();
      this.activeFocusMode = (finalSettings as any).focusMode || 'unknown';
      this.continuousFocusApplied = this.activeFocusMode === 'continuous';
    }

    await this.getAvailableCameras();
  }

  /**
   * Set camera zoom level (Hardware optical/sensor zoom with transparent Software Digital ROI zoom fallback)
   */
  public async setZoom(zoomValue: number): Promise<number> {
    const minZoom = this.zoomCapabilities.supported ? this.zoomCapabilities.min : 1.0;
    const maxZoom = this.zoomCapabilities.supported ? Math.max(3.0, this.zoomCapabilities.max) : 3.0;
    const targetZoom = Math.min(maxZoom, Math.max(minZoom, zoomValue));

    this.currentZoom = targetZoom;
    this.zoomCapabilities.current = targetZoom;

    if (this.zoomCapabilities.supported && this.mediaStream) {
      const track = this.mediaStream.getVideoTracks()[0];
      if (track) {
        try {
          await (track as any).applyConstraints({
            advanced: [{ zoom: targetZoom }]
          });
        } catch (err: any) {
          console.warn('[BarcodeScanner] Hardware zoom constraint error, software crop active:', err);
        }
      }
    }

    return this.currentZoom;
  }

  public getZoomCapabilities(): ZoomCapabilities {
    if (this.zoomCapabilities.supported) {
      return { ...this.zoomCapabilities };
    }
    return {
      supported: true,
      min: 1.0,
      max: 3.0,
      step: 0.5,
      current: this.currentZoom
    };
  }

  /**
   * Switch active camera device
   */
  public async switchCamera(deviceId?: string): Promise<string | null> {
    if (this.availableCameras.length <= 1 && !deviceId) {
      return this.currentDeviceId;
    }

    let targetId = deviceId;
    if (!targetId) {
      const currentIndex = this.availableCameras.findIndex((c) => c.deviceId === this.currentDeviceId);
      const nextIndex = (currentIndex + 1) % this.availableCameras.length;
      targetId = this.availableCameras[nextIndex]?.deviceId;
    }

    if (!targetId) return this.currentDeviceId;

    try {
      this.stopStreamOnly();
      await new Promise((r) => setTimeout(r, 150));
      await this.initCameraStream(targetId);
      return this.currentDeviceId;
    } catch (err: any) {
      console.error('[BarcodeScanner] Camera switch error:', err);
      const normalized = this.normalizeCameraError(err);
      this.cameraErrors.push(normalized.message);
      if (this.onErrorCallback) {
        this.onErrorCallback(normalized);
      }
      return null;
    }
  }

  public isTorchSupported(): boolean {
    if (!this.mediaStream) return false;
    const track = this.mediaStream.getVideoTracks()[0];
    if (!track) return false;
    const capabilities = (track.getCapabilities ? track.getCapabilities() : {}) as any;
    return !!capabilities.torch;
  }

  public async toggleTorch(forceState?: boolean): Promise<boolean> {
    if (!this.isTorchSupported()) return false;
    const track = this.mediaStream?.getVideoTracks()[0];
    if (!track) return false;

    const newState = forceState !== undefined ? forceState : !this.torchEnabled;
    try {
      const caps = (track.getCapabilities ? track.getCapabilities() : {}) as any;
      const advancedConstraint: any = { torch: newState };

      // Capability-Gated Exposure Compensation:
      // If hardware explicitly reports exposureCompensation support, apply moderate negative compensation
      // when torch is ON to suppress specular blowout, and restore to neutral (0) when torch is OFF.
      if (newState && caps.exposureCompensation && typeof caps.exposureCompensation.min === 'number') {
        advancedConstraint.exposureCompensation = Math.max(caps.exposureCompensation.min, -0.75);
      } else if (!newState && caps.exposureCompensation) {
        advancedConstraint.exposureCompensation = 0;
      }

      await (track as any).applyConstraints({
        advanced: [advancedConstraint]
      });

      // Synchronize state directly from track settings if reported by driver
      const appliedSettings = (track.getSettings ? track.getSettings() : {}) as any;
      if (typeof appliedSettings.torch === 'boolean') {
        this.torchEnabled = appliedSettings.torch;
      } else {
        this.torchEnabled = newState;
      }
      return this.torchEnabled;
    } catch (e: any) {
      console.warn('[BarcodeScanner] Could not toggle torch:', e);
      return false;
    }
  }

  public getTorchState(): boolean {
    return this.torchEnabled;
  }

  public pauseScanning(): void {
    this._isPaused = true;
  }

  public resumeScanning(): void {
    this._isPaused = false;
  }

  public isPaused(): boolean {
    return this._isPaused;
  }

  /**
   * Single-Scheduled Frame Detection Loop (~15-20 FPS)
   * Prevents parallel execution, preserves aspect ratio on offscreen canvas,
   * distinguishes Camera Frame Failures vs Barcode Decode Failures.
   */
  private startDetectionLoop(): void {
    if (!this._isScanning || !this.videoElement) return;

    let unreadyFrameCount = 0;

    const processFrame = async () => {
      if (!this._isScanning || !this.videoElement) return;

      this.receivedFrames++;
      const now = performance.now();

      // Cadence throttle (~55ms i.e. 18 FPS)
      if (now - this.lastFrameTimestamp < 55) {
        if (this._isScanning) {
          this.animationFrameId = requestAnimationFrame(processFrame);
        }
        return;
      }
      this.lastFrameTimestamp = now;

      // Prevent overlapping decode jobs
      if (this.isDecodingInProgress) {
        if (this._isScanning) {
          this.animationFrameId = requestAnimationFrame(processFrame);
        }
        return;
      }

      // 1. Camera Frame Readiness Check (readyState >= 2 HAVE_CURRENT_DATA)
      if (
        this._isPaused ||
        this.videoElement.readyState < 2 ||
        this.videoElement.videoWidth === 0 ||
        this.videoElement.videoHeight === 0
      ) {
        this.cameraFrameFailures++;
        unreadyFrameCount++;
        if (unreadyFrameCount > 60) {
          this.notifyStatus('searching', 'انتظار وصول جاري لإطارات الفيديو المستقرة...');
        }
        if (this._isScanning) {
          this.animationFrameId = requestAnimationFrame(processFrame);
        }
        return;
      }

      unreadyFrameCount = 0;
      this.isDecodingInProgress = true;
      this.processedFrames++;
      this.scanCadenceCounter++;

      const wallNow = Date.now();
      if (wallNow - this.lastFpsTimestamp >= 1000) {
        this.fps = Math.round((this.processedFrames * 1000) / (wallNow - this.lastFpsTimestamp));
        this.lastFpsTimestamp = wallNow;
        this.processedFrames = 0;
      }

      const vw = this.videoElement.videoWidth;
      const vh = this.videoElement.videoHeight;
      const tStart = performance.now();

      try {
        this.decodeAttempts++;

        // Sample Offscreen Canvas preserving aspect ratio
        if (!this.offscreenCanvas) {
          this.offscreenCanvas = document.createElement('canvas');
          this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
        }

        if (this.offscreenCtx) {
          const scanFullFrame = this.scanCadenceCounter % 4 === 0;
          let sx = 0;
          let sy = 0;
          let sw = vw;
          let sh = vh;

          if (!scanFullFrame) {
            sw = Math.floor(vw * 0.75);
            sh = Math.floor(vh * 0.55);
            sx = Math.floor((vw - sw) / 2);
            sy = Math.floor((vh - sh) / 2);
          }

          // Apply software digital zoom if hardware zoom is not supported and currentZoom > 1.0
          if (!this.zoomCapabilities.supported && this.currentZoom > 1.0) {
            const zoomCropW = Math.floor(sw / this.currentZoom);
            const zoomCropH = Math.floor(sh / this.currentZoom);
            sx += Math.floor((sw - zoomCropW) / 2);
            sy += Math.floor((sh - zoomCropH) / 2);
            sw = zoomCropW;
            sh = zoomCropH;
          }

          // High-Resolution Sampling for enhanced 1D barcode edge clarity
          const maxDimension = this.turboMode ? 1280 : 960;
          let targetW = sw;
          let targetH = sh;
          if (targetW > maxDimension) {
            const ratio = maxDimension / targetW;
            targetW = maxDimension;
            targetH = Math.round(sh * ratio); // Preserves aspect ratio exactly!
          }

          if (
            this.offscreenCanvas.width !== targetW ||
            this.offscreenCanvas.height !== targetH
          ) {
            this.offscreenCanvas.width = targetW;
            this.offscreenCanvas.height = targetH;
          }

          // Adaptive Preprocessing Filter: boost contrast & brightness on alternate frames for low-contrast/reflective barcodes
          const applyEnhancement = this.turboMode && (this.scanCadenceCounter % 2 === 1);
          if (applyEnhancement) {
            if (this.torchEnabled) {
              this.offscreenCtx.filter = 'contrast(1.40) brightness(0.95)';
            } else {
              this.offscreenCtx.filter = 'contrast(1.35) brightness(1.05)';
            }
          } else {
            this.offscreenCtx.filter = 'none';
          }

          this.offscreenCtx.drawImage(
            this.videoElement,
            sx,
            sy,
            sw,
            sh,
            0,
            0,
            targetW,
            targetH
          );

          if (applyEnhancement) {
            this.offscreenCtx.filter = 'none';
          }

          // Execute Unified Engine Manager Decode Strategy
          const decodeResult = await this.engineManager.decodeFrame(
            this.offscreenCanvas,
            targetW,
            targetH
          );

          const elapsedMs = Math.round(performance.now() - tStart);
          this.lastDecodeTimeMs = elapsedMs;
          this.totalDecodeTimeSum += elapsedMs;

          if (decodeResult && decodeResult.barcode) {
            this.successfulScans++;
            this.notifyStatus('found', `تم استخراج الباركود: ${decodeResult.barcode}`);
            this.handleDetectedBarcode(decodeResult.barcode, decodeResult.type);
          } else {
            this.failedScans++;
            this.barcodeDecodeFailures++;
            this.notifyStatus('searching', 'جارٍ المسح والبحث عن باركود...');
          }
        }

        // Emit Diagnostics Snapshot every 1000ms
        if (wallNow - this.lastDiagLogTime >= 1000) {
          this.lastDiagLogTime = wallNow;
          if (this.onDiagnosticsCallback) {
            this.onDiagnosticsCallback(this.getDiagnostics());
          }
        }
      } catch (loopErr: any) {
        this.decodeErrors.push(loopErr?.message || 'Frame processing error');
      } finally {
        this.isDecodingInProgress = false;
      }

      if (this._isScanning) {
        this.animationFrameId = requestAnimationFrame(processFrame);
      }
    };

    this.animationFrameId = requestAnimationFrame(processFrame);
  }

  /**
   * Handle barcode candidate with checksum validation, anti-repeat cooldown & single dispatch
   */
  private handleDetectedBarcode(rawBarcode: string, hintType: BarcodeType): void {
    const validation = validateBarcode(rawBarcode);
    if (!validation.isValid) {
      return;
    }

    const now = Date.now();
    const barcode = validation.normalizedBarcode;

    // Anti-repeat cooldown
    if (this.lastScannedBarcode === barcode && now - this.lastScannedTime < this.cooldownMs) {
      return;
    }

    // Pause scanning immediately during POS dispatch
    this.pauseScanning();

    this.lastScannedBarcode = barcode;
    this.lastScannedTime = now;

    // Audio & Haptic feedback
    this.triggerFeedback();

    if (this.onScanCallback) {
      this.onScanCallback({
        barcode,
        type: validation.type !== 'UNKNOWN' ? validation.type : hintType,
        timestamp: now
      });
    }
  }

  /**
   * Run Comparative Benchmark across all engines for diagnostic analysis
   */
  public async runEngineBenchmark(sampleImageData: ImageData, iterations = 5): Promise<EngineBenchmarkResult[]> {
    return await this.engineManager.runComparativeBenchmark(sampleImageData, iterations);
  }

  /**
   * Audio & Haptic Feedback
   */
  public triggerFeedback(): void {
    if (this.playBeep && typeof window !== 'undefined') {
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = 'sine';
          osc.frequency.setValueAtTime(1200, ctx.currentTime);
          gain.gain.setValueAtTime(0.12, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.09);
        }
      } catch {}
    }

    if (this.vibrate && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate([60]);
      } catch {}
    }
  }

  public resetCooldown(): void {
    this.lastScannedBarcode = null;
    this.lastScannedTime = 0;
  }

  private normalizeCameraError(err: any): Error {
    if (err instanceof Error && err.message && (!err.name || err.name === 'Error')) {
      if (err.message.includes('تم رفض') || err.message.includes('الكاميرا غير') || err.message.includes('لم يتم العثور')) {
        return err;
      }
    }
    const name = typeof err === 'string' ? err : (err?.name || '');
    const msg = typeof err === 'string' ? err : (err?.message || '');
    if (
      name === 'NotAllowedError' ||
      name === 'PermissionDeniedError' ||
      msg.includes('Permission denied') ||
      msg.includes('denied') ||
      msg.includes('تم رفض إذن')
    ) {
      return new Error('تم رفض إذن الوصول إلى الكاميرا. يرجى السماح بالوصول من إعدادات المتصفح.');
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || msg.includes('NotFound') || msg.includes('لم يتم العثور')) {
      return new Error('لم يتم العثور على أي كاميرا متصلة بالجهاز.');
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || msg.includes('NotReadable')) {
      return new Error('الكاميرا قيد الاستخدام بواسطة تطبيق آخر أو غير مستجيبة.');
    }
    if (name === 'OverconstrainedError') {
      return new Error('إعدادات دقة الكاميرا المطلوبة غير مدعومة في هذا الجهاز.');
    }
    if (name === 'SecurityError') {
      return new Error('تم تقييد الوصول إلى الكاميرا لأسباب أمنية (يتطلب اتصال آمن HTTPS).');
    }
    return new Error(msg || 'تعذر تشغيل كاميرا مسح الباركود.');
  }

  private stopStreamOnly(): void {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      this.mediaStream = null;
    }
    this.torchEnabled = false;
  }

  /**
   * Stop scanning completely and release all camera and media resources
   */
  public stopScanning(): void {
    this._isScanning = false;

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    this.stopStreamOnly();

    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }

    this.onScanCallback = null;
    this.onErrorCallback = null;
    this.onStatusCallback = null;
    this.onDiagnosticsCallback = null;
    this.notifyStatus('stopped', 'تم إيقاف الكاميرا وتفريغ الموارد');
  }

  public async decodeImageBuffer(grayPixels: Uint8ClampedArray, width: number, height: number): Promise<{ barcode: string; type: BarcodeType } | null> {
    // Create ImageData from grayscale buffer
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < grayPixels.length; i++) {
      const v = grayPixels[i];
      const idx = i * 4;
      rgba[idx] = v;
      rgba[idx + 1] = v;
      rgba[idx + 2] = v;
      rgba[idx + 3] = 255;
    }
    const imageData = typeof ImageData !== 'undefined'
      ? new ImageData(rgba, width, height)
      : ({ data: rgba, width, height } as unknown as ImageData);

    // Call active engine via EngineManager
    const res = await this.engineManager.decodeFrame(imageData);
    if (res && res.barcode) {
      return {
        barcode: res.barcode,
        type: res.type || (res.format as BarcodeType)
      };
    }
    return null;
  }

  public isScanning(): boolean {
    return this._isScanning;
  }

  public isTorchOn(): boolean {
    return this.torchEnabled;
  }

  public toggleTurboMode(): boolean {
    this.turboMode = !this.turboMode;
    return this.turboMode;
  }

  public setTurboMode(enabled: boolean): boolean {
    this.turboMode = enabled;
    return this.turboMode;
  }

  public isTurboMode(): boolean {
    return this.turboMode;
  }

  /**
   * Tap-to-Focus: re-triggers hardware continuous autofocus on the active camera track
   */
  public async triggerFocus(clientX?: number, clientY?: number): Promise<boolean> {
    if (!this.mediaStream) return false;
    const track = this.mediaStream.getVideoTracks()[0];
    if (!track) return false;

    try {
      if (typeof track.applyConstraints === 'function') {
        const advanced: any = { focusMode: 'continuous' };
        if (clientX !== undefined && clientY !== undefined && typeof (track.getCapabilities as any) === 'function') {
          const caps = (track.getCapabilities as any)() || {};
          if (caps.pointsOfInterest) {
            advanced.pointsOfInterest = [{ x: clientX, y: clientY }];
          }
        }
        await track.applyConstraints({ advanced: [advanced] });
        return true;
      }
    } catch (e) {
      console.warn('[BarcodeScanner] Tap-to-focus trigger notice:', e);
    }
    return false;
  }

  public getCachedCameras(): MediaDeviceInfo[] {
    return this.availableCameras;
  }
}

// Global Singleton Instance
export const barcodeScannerService = new BarcodeScannerService();
