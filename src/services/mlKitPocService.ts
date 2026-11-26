import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
  BarcodeScanner,
  BarcodeFormat,
  LensFacing,
  Resolution,
  type BarcodesScannedEvent,
  type ScanErrorEvent
} from '@capacitor-mlkit/barcode-scanning';

/**
 * Result returned for an accepted barcode scan.
 * Note on latency: @capacitor-mlkit/barcode-scanning does not expose per-frame
 * native C++ ML Kit inference calculation durations. Latencies represent wall-clock
 * end-to-end elapsed time.
 */
export interface MlKitPocResult {
  barcode: string;
  format: string;
  engineUsed: 'ML Kit Native (Android)' | 'ZXing WASM / Web' | 'Native BarcodeDetector';
  
  /**
   * Wall-clock elapsed duration from startScan initiation to the first successful barcode event (ms).
   */
  timeToFirstSuccessfulScanMs: number;

  /**
   * Wall-clock interval between this accepted scan and the previous accepted scan (ms).
   */
  intervalBetweenAcceptedScansMs: number;

  /**
   * Backwards-compatible alias for timeToFirstSuccessfulScanMs
   */
  decodeTimeMs: number;

  /**
   * Backwards-compatible alias for intervalBetweenAcceptedScansMs
   */
  successiveTimeMs?: number;

  totalScans?: number;
  timestamp: number;
}

export interface MlKitPocMetrics {
  /** Wall-clock time taken for CameraX initialization and pipeline start to complete (ms) */
  cameraStartCompletionTimeMs: number;
  /** Wall-clock time from session initiation to first accepted scan delivery (ms) */
  timeToFirstSuccessfulScanMs: number | null;
  /** Wall-clock time between the last two accepted scans (ms) */
  intervalBetweenAcceptedScansMs: number | null;

  /** Backwards-compatible alias for cameraStartCompletionTimeMs */
  cameraOpenTimeMs: number;
  /** Backwards-compatible alias for timeToFirstSuccessfulScanMs */
  firstDecodeTimeMs: number | null;
  /** Backwards-compatible alias for intervalBetweenAcceptedScansMs */
  successiveIntervalMs: number | null;

  lastDecodeTimestampMs: number | null;
  successfulScansCount: number;
  lastScannedBarcode: string | null;
  lastScannedFormat: string | null;
  currentZoomRatio: number;
  minZoomRatio: number;
  maxZoomRatio: number;
  isTorchEnabled: boolean;
  isTorchAvailable: boolean;
}

export const RETAIL_POS_BARCODE_FORMATS: BarcodeFormat[] = [
  BarcodeFormat.Ean13,
  BarcodeFormat.Ean8,
  BarcodeFormat.Code128,
  BarcodeFormat.UpcA
];

export const DEFAULT_STOCKTAKING_BARCODE_FORMATS: BarcodeFormat[] = [
  BarcodeFormat.Ean13,
  BarcodeFormat.Ean8,
  BarcodeFormat.UpcA,
  BarcodeFormat.UpcE,
  BarcodeFormat.Code128,
  BarcodeFormat.Code39,
  BarcodeFormat.Itf,
  BarcodeFormat.QrCode
];

export interface StartNativeScanOptions {
  continuous?: boolean;
  formats?: BarcodeFormat[];
  /**
   * Optional cancellation callback invoked if user closes or cancels the scanner session.
   */
  onCancel?: () => void;
}

/**
 * Interface abstracting the underlying BarcodeScanner plugin operations.
 * Enables deterministic testing of native camera lifecycle and concurrency
 * in automated suites without changing production behavior.
 */
export interface BarcodeScannerBridge {
  isSupported(): Promise<{ supported: boolean }>;
  checkPermissions(): Promise<{ camera: string }>;
  requestPermissions(): Promise<{ camera: string }>;
  startScan(options?: any): Promise<void>;
  stopScan(): Promise<void>;
  enableTorch(): Promise<void>;
  disableTorch(): Promise<void>;
  toggleTorch(): Promise<void>;
  isTorchEnabled(): Promise<{ enabled: boolean }>;
  isTorchAvailable(): Promise<{ available: boolean }>;
  setZoomRatio(options: { zoomRatio: number }): Promise<void>;
  getMinZoomRatio(): Promise<{ zoomRatio: number }>;
  getMaxZoomRatio(): Promise<{ zoomRatio: number }>;
  addListener(eventName: 'barcodesScanned', listenerFunc: (event: BarcodesScannedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'scanError', listenerFunc: (event: ScanErrorEvent) => void): Promise<PluginListenerHandle>;
}

/**
 * Private session scope enforcing strong resource ownership.
 * Each start attempt holds a dedicated scope instance, preventing stale or
 * superseded sessions from tearing down newer sessions or leaving orphaned hardware.
 */
interface ScanSessionScope {
  readonly id: number;
  isAborted: boolean;
  scanListenerHandle: PluginListenerHandle | null;
  errorListenerHandle: PluginListenerHandle | null;
}

export class MlKitPocService {
  private isScanningActive = false;
  private isStarting = false;
  private currentSessionId = 0;
  private activeSession: ScanSessionScope | null = null;
  private activeStartPromise: Promise<void> | null = null;
  /**
   * Atomic Native Operation Queue:
   * Holds the tail of the serialized Promise chain for all conflicting native camera operations
   * (startScan and stopScan). Each operation is appended to this chain and executes only after
   * preceding native operations have fully settled (resolved or rejected).
   * Ensures zero overlap, strict FIFO ordering, and automatic recovery from rejections.
   */
  private nativeQueueTail: Promise<void> = Promise.resolve();
  private scannerBridge: BarcodeScannerBridge = BarcodeScanner as BarcodeScannerBridge;
  private lastConfiguredFormats: BarcodeFormat[] | null = null;

  /**
   * Atomically enqueues a native camera operation behind all existing in-flight native calls.
   * Never overwrites or drops pending operations.
   * Catches errors in the previous link so a rejected native call never poisons subsequent operations.
   */
  private enqueueNativeOperation<T>(op: () => Promise<T>): Promise<T> {
    const nextPromise = this.nativeQueueTail
      .catch(() => {
        // Safe recovery: preceding failure does not block next queued operation
      })
      .then(() => op());

    // Update queue tail to follow this operation's settlement (ignoring rejection for chain health)
    this.nativeQueueTail = nextPromise.then(() => {}, () => {});
    return nextPromise;
  }

  private overlayElement: HTMLElement | null = null;

  // Timings and metrics
  private sessionStartTime = 0;
  private cameraStartCompletionTimeMs = 0;
  private timeToFirstSuccessfulScan: number | null = null;
  private lastDecodeTimestampMs: number | null = null;
  private intervalBetweenAcceptedScans: number | null = null;
  private successfulScansCount = 0;
  private lastScannedBarcode: string | null = null;
  private lastScannedFormat: string | null = null;
  private lastScannedWallClock = 0;

  // Hardware controls state
  private currentZoomRatio = 1.0;
  private minZoomRatio = 1.0;
  private maxZoomRatio = 5.0;
  private isTorchEnabledState = false;
  private isTorchAvailableState = false;

  // Active callbacks
  private onResultCallback: ((result: MlKitPocResult) => void) | null = null;
  private onErrorCallback: ((error: Error) => void) | null = null;
  private onCancelCallback: (() => void) | null = null;

  public isNativePlatform(): boolean {
    return typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();
  }

  public async isSupported(): Promise<boolean> {
    if (this.isNativePlatform()) {
      try {
        const res = await this.scannerBridge.isSupported();
        return !!res.supported;
      } catch (err) {
        console.warn('[MlKitPocService] isSupported probe warning:', err);
        return false;
      }
    }
    return true;
  }

  public async checkPermissions(): Promise<boolean> {
    if (this.isNativePlatform()) {
      try {
        const status = await this.scannerBridge.checkPermissions();
        if (status.camera === 'granted') return true;
        const request = await this.scannerBridge.requestPermissions();
        return request.camera === 'granted';
      } catch (err) {
        console.warn('[MlKitPocService] checkPermissions probe warning:', err);
        return false;
      }
    }
    return true;
  }

  /**
   * Granular permission acquisition tied to a specific session scope.
   * Checks status, and only if not granted and session remains active, prompts for permission.
   * Re-validates session scope after every asynchronous step.
   */
  private async checkAndRequestPermissions(session: ScanSessionScope): Promise<boolean> {
    if (!this.isNativePlatform()) return true;

    try {
      const status = await this.scannerBridge.checkPermissions();
      if (session.isAborted || this.activeSession !== session) return false;
      if (status.camera === 'granted') return true;

      const request = await this.scannerBridge.requestPermissions();
      if (session.isAborted || this.activeSession !== session) return false;
      return request.camera === 'granted';
    } catch (err) {
      console.warn('[MlKitPocService] checkAndRequestPermissions error:', err);
      return false;
    }
  }

  /**
   * Start native CameraX scan session using Google ML Kit Bundled Engine
   * strictly isolated from POS, Inventory Ledger, and PharmacyDB.
   */
  public async startNativeScanSession(
    onResult: (result: MlKitPocResult) => void,
    onError?: (err: Error) => void,
    options: StartNativeScanOptions = { continuous: true }
  ): Promise<void> {
    // 1. Concurrency guard: reject duplicate concurrent start attempts immediately
    if (this.isStarting || this.isScanningActive || this.activeStartPromise !== null) {
      const busyMsg = 'جلسة مسح قيد التشغيل أو جاري تهيئتها بالفعل. يرجى إيقاف الجلسة الحالية قبل بدء جلسة جديدة.';
      console.warn('[MlKitPocService]', busyMsg);
      const busyErr = new Error(busyMsg);
      if (onError) onError(busyErr);
      throw busyErr;
    }

    // Immediately lock startup state synchronously to guard subsequent async steps
    this.isStarting = true;

    const startTask = this.executeStartSession(onResult, onError, options);
    this.activeStartPromise = startTask;

    try {
      await startTask;
    } finally {
      this.activeStartPromise = null;
    }
  }

  private async executeStartSession(
    onResult: (result: MlKitPocResult) => void,
    onError?: (err: Error) => void,
    options: StartNativeScanOptions = { continuous: true }
  ): Promise<void> {
    // Capture user error callback to prevent double delivery
    let errorDelivered = false;
    const dispatchError = (err: Error) => {
      if (errorDelivered) return;
      errorDelivered = true;
      if (onError) {
        try {
          onError(err);
        } catch (cbErr) {
          console.error('[MlKitPocService] Exception inside onError callback:', cbErr);
        }
      }
    };

    // 2. Allocate an isolated session scope with monotonic ID immediately
    const session: ScanSessionScope = {
      id: ++this.currentSessionId,
      isAborted: false,
      scanListenerHandle: null,
      errorListenerHandle: null
    };
    this.activeSession = session;

    this.onResultCallback = onResult;
    this.onErrorCallback = onError || null;
    this.onCancelCallback = options.onCancel || null;

    // 3. Platform guard
    if (!this.isNativePlatform()) {
      this.isStarting = false;
      this.activeSession = null;
      session.isAborted = true;
      const msg = 'محرك ML Kit Native متوفر فقط في بيئة تطبيق أندرويد الأصلي (Android APK). في وضع الويب الحالي، يعمل خيار الويب التلقائي.';
      const platErr = new Error(msg);
      dispatchError(platErr);
      throw platErr;
    }

    // 4. Granular Permission acquisition
    const hasPermission = await this.checkAndRequestPermissions(session);

    // Guard: Was this session aborted or cancelled while waiting for permissions?
    if (session.isAborted || this.activeSession !== session) {
      console.log(`[MlKitPocService] Session ${session.id} aborted during permission check/request.`);
      await this.cleanupAbortedSession(session);
      return;
    }

    if (!hasPermission) {
      this.isStarting = false;
      this.activeSession = null;
      session.isAborted = true;
      const permErr = new Error('تم رفض إذن استخدام الكاميرا. يرجى تفعيل إذن الكاميرا من إعدادات جهاز أندرويد.');
      dispatchError(permErr);
      throw permErr;
    }

    // Initialize metrics
    this.sessionStartTime = performance.now();
    this.cameraStartCompletionTimeMs = 0;
    this.timeToFirstSuccessfulScan = null;
    this.lastDecodeTimestampMs = null;
    this.intervalBetweenAcceptedScans = null;
    this.successfulScansCount = 0;
    this.lastScannedBarcode = null;
    this.lastScannedFormat = null;
    this.lastScannedWallClock = 0;

    try {
      // 5. Make WebView background transparent to reveal CameraX underneath
      if (typeof document !== 'undefined') {
        document.documentElement.classList.add('barcode-scanner-active');
        document.body.classList.add('barcode-scanner-active');
      }

      // 6. Create and inject standalone interactive HUD overlay
      this.createHudOverlay();

      // Guard: Was session aborted while setting up HUD?
      if (session.isAborted || this.activeSession !== session) {
        await this.cleanupAbortedSession(session);
        return;
      }

      // 7. Register native barcode listener on session scope BEFORE starting camera
      session.scanListenerHandle = await this.scannerBridge.addListener(
        'barcodesScanned',
        async (event: BarcodesScannedEvent) => {
          // Stale session or aborted check
          // Note: Also accept if isStarting is true so first barcode event arriving right as camera opens is captured
          if (session.isAborted || this.activeSession !== session || (!this.isScanningActive && !this.isStarting)) {
            return;
          }

          const now = performance.now();
          if (event.barcodes && event.barcodes.length > 0) {
            const rawItem = event.barcodes[0];
            const code = (rawItem.rawValue || rawItem.displayValue || '').trim();
            const format = rawItem.format || 'UNKNOWN';

            if (!code) return;

            // Anti-repeat debounce: ignore exact same barcode within 1200ms
            const wallNow = Date.now();
            const isSameAsLast = this.lastScannedBarcode === code;
            if (isSameAsLast && wallNow - this.lastScannedWallClock < 1200) {
              return;
            }

            // Calculate wall-clock metrics
            if (this.timeToFirstSuccessfulScan === null) {
              this.timeToFirstSuccessfulScan = Math.round(now - this.sessionStartTime);
              this.intervalBetweenAcceptedScans = this.timeToFirstSuccessfulScan;
            } else if (this.lastDecodeTimestampMs !== null) {
              this.intervalBetweenAcceptedScans = Math.round(now - this.lastDecodeTimestampMs);
            }

            this.lastDecodeTimestampMs = now;
            this.lastScannedBarcode = code;
            this.lastScannedFormat = format;
            this.lastScannedWallClock = wallNow;
            this.successfulScansCount++;

            // Update live HUD overlay
            this.updateHudMetrics();

            const resultPayload: MlKitPocResult = {
              barcode: code,
              format,
              engineUsed: 'ML Kit Native (Android)',
              timeToFirstSuccessfulScanMs: this.timeToFirstSuccessfulScan,
              intervalBetweenAcceptedScansMs: this.intervalBetweenAcceptedScans || this.timeToFirstSuccessfulScan,
              decodeTimeMs: this.timeToFirstSuccessfulScan,
              successiveTimeMs: this.intervalBetweenAcceptedScans || this.timeToFirstSuccessfulScan,
              totalScans: this.successfulScansCount,
              timestamp: wallNow
            };

            // Notify consumer callback
            if (this.onResultCallback) {
              try {
                this.onResultCallback(resultPayload);
              } catch (cbErr) {
                console.error('[MlKitPocService] Exception in onResult callback:', cbErr);
              }
            }

            // If single-shot requested, stop session immediately and ensure hardware unbind settles
            if (options.continuous === false) {
              await this.stopNativeScanSession('completed');
              await this.waitForNativeQueueToSettle();
            }
          }
        }
      );

      // Guard: Did session abort during first listener setup?
      if (session.isAborted || this.activeSession !== session) {
        await this.cleanupAbortedSession(session);
        return;
      }

      // 8. Register error listener on session scope
      session.errorListenerHandle = await this.scannerBridge.addListener(
        'scanError',
        (errEvent: ScanErrorEvent) => {
          if (session.isAborted || this.activeSession !== session || (!this.isScanningActive && !this.isStarting)) {
            return;
          }
          console.error('[MlKitPocService] Scan error event:', errEvent);
          const scanErr = new Error(errEvent.message || 'خطأ أثناء مسح الباركود');
          dispatchError(scanErr);

          if (options.continuous === false) {
            this.stopNativeScanSession('stopped');
          }
        }
      );

      // Guard: Was session aborted while registering listeners?
      if (session.isAborted || this.activeSession !== session) {
        await this.cleanupAbortedSession(session);
        return;
      }

      // 9. Mark scanning active synchronously BEFORE triggering native startScan
      // so any instantaneous barcode event delivered by CameraX right upon bind is accepted
      this.isScanningActive = true;

      // 10. Start CameraX native pipeline via serialized Atomic Native Operation Queue
      await this.enqueueNativeOperation(async () => {
        // Pre-execution guard: if session was cancelled while queued behind a prior operation, do not start camera
        if (session.isAborted || this.activeSession !== session) {
          return;
        }

        const validFormatsSet = new Set(Object.values(BarcodeFormat));
        let selectedFormats: BarcodeFormat[] = DEFAULT_STOCKTAKING_BARCODE_FORMATS;

        if (Array.isArray(options.formats) && options.formats.length > 0) {
          const sanitized = options.formats.filter((f) => validFormatsSet.has(f));
          selectedFormats = sanitized.length > 0 ? sanitized : DEFAULT_STOCKTAKING_BARCODE_FORMATS;
        }

        this.lastConfiguredFormats = [...selectedFormats];

        await this.scannerBridge.startScan({
          formats: selectedFormats,
          lensFacing: LensFacing.Back,
          resolution: Resolution['1280x720']
        });
      });

      // CRITICAL CHECK: Did session get aborted or superseded during startScan native execution?
      if (session.isAborted || this.activeSession !== session) {
        // Session A was cancelled or superseded while startScan was in flight!
        await this.cleanupAbortedSession(session);
        return;
      }

      this.cameraStartCompletionTimeMs = Math.round(performance.now() - this.sessionStartTime);
      this.isStarting = false;

      // 11. Probe hardware capabilities safely
      try {
        const torchAvail = await this.scannerBridge.isTorchAvailable();
        this.isTorchAvailableState = !!torchAvail.available;
      } catch {
        this.isTorchAvailableState = false;
      }

      try {
        const minZ = await this.scannerBridge.getMinZoomRatio();
        const maxZ = await this.scannerBridge.getMaxZoomRatio();
        this.minZoomRatio = minZ.zoomRatio || 1.0;
        this.maxZoomRatio = maxZ.zoomRatio || 4.0;
      } catch {
        this.minZoomRatio = 1.0;
        this.maxZoomRatio = 4.0;
      }

      this.updateHudControlsState();
    } catch (err: any) {
      if (this.activeSession === session) {
        this.isStarting = false;
        this.isScanningActive = false;
        const normalizedErr = err instanceof Error ? err : new Error(err?.message || 'تعذر تشغيل ماسح ML Kit عبر CameraX');
        dispatchError(normalizedErr);
        await this.stopNativeScanSession('stopped');
        throw normalizedErr;
      } else {
        // Session was already superseded; clean up only session's own resources
        await this.cleanupAbortedSession(session);
      }
    }
  }

  /**
   * Safely cleans up resources of an aborted or superseded session.
   * If a newer active session exists, it removes only this session's own listener handles
   * and NEVER disturbs the newer session's camera, HUD, or state.
   * If NO newer session exists, it unbinds any orphaned camera hardware.
   */
  private async cleanupAbortedSession(session: ScanSessionScope): Promise<void> {
    session.isAborted = true;

    // 1. Remove this session's private listener handles
    if (session.scanListenerHandle) {
      try {
        await session.scanListenerHandle.remove();
      } catch (e) {
        console.warn('[MlKitPocService] Failed to remove aborted scanListenerHandle:', e);
      }
      session.scanListenerHandle = null;
    }

    if (session.errorListenerHandle) {
      try {
        await session.errorListenerHandle.remove();
      } catch (e) {
        console.warn('[MlKitPocService] Failed to remove aborted errorListenerHandle:', e);
      }
      session.errorListenerHandle = null;
    }

    // 2. Only if no newer session has taken over, shut down orphaned camera hardware
    if (this.activeSession === null || this.activeSession === session) {
      this.activeSession = null;
      this.isScanningActive = false;
      this.isStarting = false;

      if (this.isNativePlatform()) {
        try {
          await this.enqueueNativeOperation(async () => {
            // Pre-execution guard: if a newer active session took over while queued, do NOT stop its camera!
            if (this.activeSession !== null && this.activeSession !== session) {
              return;
            }
            await this.scannerBridge.stopScan();
          });
        } catch (e) {
          console.warn('[MlKitPocService] stopScan failed during aborted session cleanup:', e);
        }
      }

      try {
        if (typeof document !== 'undefined') {
          document.documentElement.classList.remove('barcode-scanner-active');
          document.body.classList.remove('barcode-scanner-active');
        }
      } catch {}

      if (this.overlayElement) {
        try {
          this.overlayElement.remove();
        } catch {}
        this.overlayElement = null;
      }
    }
  }

  /**
   * Single-shot Promise wrapper for ML Kit Native scan session.
   * 
   * Settlement Contract:
   * - Resolves MlKitPocResult on successful barcode detection.
   * - Resolves null if user cancels the scan (closes HUD or clicks stop).
   * - Rejects Error on hardware startup failure, permission denial, or native scanError event.
   * - Settles exactly once under all circumstances.
   */
  public async scanNativeSingleShot(): Promise<MlKitPocResult | null> {
    return new Promise<MlKitPocResult | null>((resolve, reject) => {
      let isSettled = false;

      const safeResolve = (val: MlKitPocResult | null) => {
        if (isSettled) return;
        isSettled = true;
        resolve(val);
      };

      const safeReject = (err: Error) => {
        if (isSettled) return;
        isSettled = true;
        reject(err);
      };

      this.startNativeScanSession(
        (res) => {
          safeResolve(res);
        },
        (err) => {
          safeReject(err);
        },
        {
          continuous: false,
          onCancel: () => {
            // Cancellation contract: resolves with null on user cancel
            safeResolve(null);
          }
        }
      ).catch((err) => {
        safeReject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /**
   * Stop scanning session cleanly, release hardware and teardown HUD overlay.
   * Performs independent cleanup steps so one failure does not halt remaining teardown.
   * Does NOT call removeAllListeners() to avoid interfering with other components.
   */
  public async stopNativeScanSession(reason: 'cancelled' | 'completed' | 'stopped' = 'stopped'): Promise<void> {
    if (!this.isScanningActive && !this.isStarting && !this.activeSession) {
      return;
    }

    const sessionToStop = this.activeSession;
    this.activeSession = null;
    this.isScanningActive = false;
    this.isStarting = false;
    this.activeStartPromise = null;

    if (sessionToStop) {
      sessionToStop.isAborted = true;
    }

    // Trigger onCancel if this stop was caused by user cancellation
    const cancelCb = this.onCancelCallback;
    this.onCancelCallback = null;
    this.onResultCallback = null;
    this.onErrorCallback = null;

    if (reason === 'cancelled' && cancelCb) {
      try {
        cancelCb();
      } catch (cbErr) {
        console.error('[MlKitPocService] Error in onCancel callback:', cbErr);
      }
    }

    // 1. Remove DOM transparency classes immediately
    try {
      if (typeof document !== 'undefined') {
        document.documentElement.classList.remove('barcode-scanner-active');
        document.body.classList.remove('barcode-scanner-active');
      }
    } catch (domErr) {
      console.warn('[MlKitPocService] Failed to remove transparency classes:', domErr);
    }

    // 2. Remove HUD overlay
    if (this.overlayElement) {
      try {
        this.overlayElement.remove();
      } catch (overlayErr) {
        console.warn('[MlKitPocService] Failed to remove HUD overlay:', overlayErr);
      }
      this.overlayElement = null;
    }

    // 3. Independent teardown of native hardware and session handles
    if (this.isNativePlatform()) {
      if (sessionToStop) {
        if (sessionToStop.scanListenerHandle) {
          try {
            await sessionToStop.scanListenerHandle.remove();
          } catch (hErr) {
            console.warn('[MlKitPocService] Failed to remove scanListenerHandle:', hErr);
          }
          sessionToStop.scanListenerHandle = null;
        }

        if (sessionToStop.errorListenerHandle) {
          try {
            await sessionToStop.errorListenerHandle.remove();
          } catch (hErr) {
            console.warn('[MlKitPocService] Failed to remove errorListenerHandle:', hErr);
          }
          sessionToStop.errorListenerHandle = null;
        }
      }

      if (this.isTorchEnabledState) {
        try {
          await this.scannerBridge.disableTorch();
        } catch (tErr) {
          console.warn('[MlKitPocService] Failed to disable torch during stop:', tErr);
        }
      }

      // Enqueue native stopScan atomically behind any pending native operations.
      // We do not block the caller of stopNativeScanSession so UI cancellation is instantaneous,
      // but the native queue guarantees that stopScan executes after the in-flight native startScan settles,
      // and before any subsequent native startScan begins.
      this.enqueueNativeOperation(async () => {
        // Pre-execution guard: if a newer session took over while this stop was queued, do NOT stop its camera!
        if (this.activeSession !== null && this.activeSession !== sessionToStop) {
          return;
        }
        try {
          await this.scannerBridge.stopScan();
        } catch (stopErr) {
          console.warn('[MlKitPocService] BarcodeScanner.stopScan() failed during stop:', stopErr);
        }
      });
    }

    this.isTorchEnabledState = false;
  }

  /**
   * Toggle camera hardware torch / flash
   */
  public async toggleTorch(): Promise<boolean> {
    if (!this.isNativePlatform()) return false;
    try {
      await this.scannerBridge.toggleTorch();
      const status = await this.scannerBridge.isTorchEnabled();
      this.isTorchEnabledState = !!status.enabled;
      this.updateHudControlsState();
      return this.isTorchEnabledState;
    } catch (err) {
      console.warn('[MlKitPocService] toggleTorch failed:', err);
      return false;
    }
  }

  /**
   * Set hardware zoom ratio
   */
  public async setZoomRatio(ratio: number): Promise<number> {
    if (!this.isNativePlatform()) return 1.0;
    try {
      const target = Math.max(this.minZoomRatio, Math.min(this.maxZoomRatio, ratio));
      await this.scannerBridge.setZoomRatio({ zoomRatio: target });
      this.currentZoomRatio = target;
      this.updateHudControlsState();
      return this.currentZoomRatio;
    } catch (err) {
      console.warn('[MlKitPocService] setZoomRatio failed:', err);
      return this.currentZoomRatio;
    }
  }

  public getMetrics(): MlKitPocMetrics {
    return {
      cameraStartCompletionTimeMs: this.cameraStartCompletionTimeMs,
      timeToFirstSuccessfulScanMs: this.timeToFirstSuccessfulScan,
      intervalBetweenAcceptedScansMs: this.intervalBetweenAcceptedScans,
      cameraOpenTimeMs: this.cameraStartCompletionTimeMs,
      firstDecodeTimeMs: this.timeToFirstSuccessfulScan,
      successiveIntervalMs: this.intervalBetweenAcceptedScans,
      lastDecodeTimestampMs: this.lastDecodeTimestampMs,
      successfulScansCount: this.successfulScansCount,
      lastScannedBarcode: this.lastScannedBarcode,
      lastScannedFormat: this.lastScannedFormat,
      currentZoomRatio: this.currentZoomRatio,
      minZoomRatio: this.minZoomRatio,
      maxZoomRatio: this.maxZoomRatio,
      isTorchEnabled: this.isTorchEnabledState,
      isTorchAvailable: this.isTorchAvailableState
    };
  }

  public isScanning(): boolean {
    return this.isScanningActive;
  }

  public isStartingSession(): boolean {
    return this.isStarting;
  }

  /**
   * Diagnostic helper: awaits complete settlement of all currently queued native camera operations.
   */
  public async waitForNativeQueueToSettle(): Promise<void> {
    try {
      await this.nativeQueueTail;
    } catch {}
  }

  /**
   * Allows injecting a mock BarcodeScannerBridge in automated tests to verify
   * hardware lifecycle, concurrency edge cases, and error resilience without
   * requiring native Android hardware or encountering Headless Web restrictions.
   */
  public setBridgeForTesting(bridge: BarcodeScannerBridge | null): void {
    this.scannerBridge = bridge || (BarcodeScanner as BarcodeScannerBridge);
  }

  public getActiveSessionIdForTesting(): number | null {
    return this.activeSession ? this.activeSession.id : null;
  }

  public getLastConfiguredFormats(): BarcodeFormat[] | null {
    return this.lastConfiguredFormats ? [...this.lastConfiguredFormats] : null;
  }

  /**
   * Injects the full-screen interactive PoC Viewfinder & HUD over the transparent WebView
   */
  private createHudOverlay(): void {
    if (typeof document === 'undefined') {
      return;
    }

    if (this.overlayElement) {
      try {
        this.overlayElement.remove();
      } catch {}
    }

    const overlay = document.createElement('div');
    overlay.id = 'mlkit-poc-overlay';
    overlay.innerHTML = `
      <!-- Top Action Bar -->
      <div class="p-4 bg-slate-900/95 border-b border-slate-700/80 text-white flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="w-8 h-8 rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center font-bold text-xs">
            ML
          </span>
          <div>
            <h2 class="font-bold text-sm text-slate-100">Google ML Kit — ماسح معزول</h2>
            <p class="text-[10px] text-emerald-400 font-medium">CameraX + Bundled C++ Model (100% Offline)</p>
          </div>
        </div>

        <!-- Controls: Flash & Close -->
        <div class="flex items-center gap-2">
          <button id="mlkit-btn-torch" class="px-3 py-1.5 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/40 text-xs font-bold hover:bg-amber-500/30 active:scale-95 transition flex items-center gap-1.5 cursor-pointer shadow-xs">
            <span>⚡ فلاش</span>
          </button>
          <button id="mlkit-btn-close" class="w-8 h-8 rounded-xl bg-rose-500/25 text-rose-200 border border-rose-500/40 hover:bg-rose-600 hover:text-white flex items-center justify-center font-bold text-sm transition cursor-pointer shadow-xs" title="إغلاق">
            ✕
          </button>
        </div>
      </div>

      <!-- Center Viewport with Viewfinder Cutout Mask -->
      <div class="flex-1 flex flex-col items-center justify-center p-4">
        <div class="w-72 h-48 sm:w-80 sm:h-52 mlkit-viewfinder-cutout flex items-center justify-center">
          <!-- Laser scanning beam -->
          <div class="mlkit-laser-line"></div>
          
          <!-- Viewfinder center target badge -->
          <div class="text-center px-3 py-1 rounded-lg bg-black/60 text-[11px] text-slate-200 border border-slate-700/50 backdrop-blur-xs font-mono">
            EAN-13 / EAN-8 / Code 128
          </div>
        </div>

        <!-- Zoom Bar under Viewfinder -->
        <div class="mt-4 flex items-center gap-2 bg-slate-900/95 px-3 py-1.5 rounded-2xl border border-slate-700 text-xs shadow-md">
          <span class="text-slate-400 text-[10px] font-bold">التقريب:</span>
          <button id="mlkit-zoom-1" class="px-2.5 py-1 rounded-lg bg-emerald-500 text-slate-950 font-bold text-xs shadow-xs cursor-pointer">1x</button>
          <button id="mlkit-zoom-2" class="px-2.5 py-1 rounded-lg bg-slate-800/90 text-slate-300 border border-slate-700/60 font-bold text-xs hover:bg-slate-700 hover:text-white transition cursor-pointer">2x</button>
          <button id="mlkit-zoom-3" class="px-2.5 py-1 rounded-lg bg-slate-800/90 text-slate-300 border border-slate-700/60 font-bold text-xs hover:bg-slate-700 hover:text-white transition cursor-pointer">3x</button>
        </div>
      </div>

      <!-- Bottom Real-time Diagnostics & Metrics Card -->
      <div class="p-4 bg-slate-900/95 border-t border-slate-700 text-white space-y-2.5">
        <!-- Live Scanned Value -->
        <div class="flex items-center justify-between bg-slate-950/80 px-3.5 py-2.5 rounded-xl border border-slate-800">
          <div>
            <div class="text-[10px] text-slate-400 font-medium">آخر باركود ملتقط:</div>
            <div id="mlkit-live-barcode" class="font-mono text-emerald-400 font-bold text-base tracking-wider dir-ltr">
              -- في انتظار توجيه الكاميرا --
            </div>
          </div>
          <div id="mlkit-live-format" class="px-2 py-1 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 font-mono text-xs font-bold">
            READY
          </div>
        </div>

        <!-- Metrics Grid: Accurate End-to-End Elapsed Latencies -->
        <div class="grid grid-cols-3 gap-2 text-center text-xs">
          <div class="bg-slate-950/80 p-2 rounded-xl border border-slate-800/80">
            <span class="block text-[10px] text-slate-400">أول التقاط (إجمالي)</span>
            <span id="mlkit-metric-first" class="font-bold text-emerald-400 text-xs">-- ms</span>
          </div>
          <div class="bg-slate-950/80 p-2 rounded-xl border border-slate-800/80">
            <span class="block text-[10px] text-slate-400">الفاصل بين الالتقاط</span>
            <span id="mlkit-metric-successive" class="font-bold text-amber-300 text-xs">-- ms</span>
          </div>
          <div class="bg-slate-950/80 p-2 rounded-xl border border-slate-800/80">
            <span class="block text-[10px] text-slate-400">عدد المقبول</span>
            <span id="mlkit-metric-count" class="font-bold text-indigo-300 text-xs">0</span>
          </div>
        </div>

        <!-- Stop Button -->
        <button id="mlkit-btn-stop" class="w-full py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white font-bold text-xs transition shadow-lg shadow-rose-600/30 flex items-center justify-center gap-1.5 cursor-pointer">
          <span>إيقاف الكاميرا وإنهاء الاختبار</span>
        </button>
      </div>
    `;

    document.body.appendChild(overlay);
    this.overlayElement = overlay;

    // Attach event listeners safely
    overlay.querySelector('#mlkit-btn-close')?.addEventListener('click', () => {
      this.stopNativeScanSession('cancelled');
    });
    overlay.querySelector('#mlkit-btn-stop')?.addEventListener('click', () => {
      this.stopNativeScanSession('cancelled');
    });
    overlay.querySelector('#mlkit-btn-torch')?.addEventListener('click', () => {
      this.toggleTorch();
    });
    overlay.querySelector('#mlkit-zoom-1')?.addEventListener('click', () => {
      this.setZoomRatio(1.0);
    });
    overlay.querySelector('#mlkit-zoom-2')?.addEventListener('click', () => {
      this.setZoomRatio(2.0);
    });
    overlay.querySelector('#mlkit-zoom-3')?.addEventListener('click', () => {
      this.setZoomRatio(3.0);
    });
  }

  private updateHudMetrics(): void {
    if (!this.overlayElement) return;

    const barcodeEl = this.overlayElement.querySelector('#mlkit-live-barcode');
    const formatEl = this.overlayElement.querySelector('#mlkit-live-format');
    const firstEl = this.overlayElement.querySelector('#mlkit-metric-first');
    const succEl = this.overlayElement.querySelector('#mlkit-metric-successive');
    const countEl = this.overlayElement.querySelector('#mlkit-metric-count');

    if (barcodeEl && this.lastScannedBarcode) {
      barcodeEl.textContent = this.lastScannedBarcode;
    }
    if (formatEl && this.lastScannedFormat) {
      formatEl.textContent = this.lastScannedFormat;
    }
    if (firstEl && this.timeToFirstSuccessfulScan !== null) {
      firstEl.textContent = `${this.timeToFirstSuccessfulScan} ms`;
    }
    if (succEl && this.intervalBetweenAcceptedScans !== null) {
      succEl.textContent = `${this.intervalBetweenAcceptedScans} ms`;
    }
    if (countEl) {
      countEl.textContent = String(this.successfulScansCount);
    }
  }

  private updateHudControlsState(): void {
    if (!this.overlayElement) return;

    const torchBtn = this.overlayElement.querySelector('#mlkit-btn-torch');
    if (torchBtn) {
      torchBtn.textContent = this.isTorchEnabledState ? '⚡ الفلاش: مشغل' : '⚡ الفلاش: مطفأ';
      torchBtn.className = this.isTorchEnabledState
        ? 'px-3 py-1.5 rounded-xl bg-amber-400 text-slate-950 border border-amber-300 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shadow-md shadow-amber-500/20'
        : 'px-3 py-1.5 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/40 text-xs font-bold hover:bg-amber-500/30 active:scale-95 transition flex items-center gap-1.5 cursor-pointer shadow-xs';
    }

    const z1 = this.overlayElement.querySelector('#mlkit-zoom-1');
    const z2 = this.overlayElement.querySelector('#mlkit-zoom-2');
    const z3 = this.overlayElement.querySelector('#mlkit-zoom-3');

    const updateZoomBtn = (btn: Element | null, active: boolean) => {
      if (!btn) return;
      btn.className = active
        ? 'px-2.5 py-1 rounded-lg bg-emerald-500 text-slate-950 font-bold text-xs shadow-xs'
        : 'px-2.5 py-1 rounded-lg bg-slate-800/90 text-slate-300 border border-slate-700/60 font-bold text-xs hover:bg-slate-700 hover:text-white transition cursor-pointer';
    };

    updateZoomBtn(z1, this.currentZoomRatio < 1.5);
    updateZoomBtn(z2, this.currentZoomRatio >= 1.5 && this.currentZoomRatio < 2.5);
    updateZoomBtn(z3, this.currentZoomRatio >= 2.5);
  }
}

export const mlKitPocService = new MlKitPocService();
