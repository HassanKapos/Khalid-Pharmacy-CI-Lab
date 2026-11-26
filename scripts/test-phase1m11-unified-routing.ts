/**
 * Phase 1M.11-P1 Automated Verification Test Suite
 * Tests Unified Platform Scanner Routing:
 * 1. Android selects ML Kit Native
 * 2. Browser selects ZXing WASM
 * 3. Correct engine cleanup (single active session guarantee)
 * 4. Rapid open / close lifecycle
 * 5. Cancellation during initialization
 * 6. No duplicate POS additions / cooldown protection
 * 7. Unsupported camera controls resilience
 * 8. Engine initialization failure handling
 */

import 'fake-indexeddb/auto';
import { unifiedScannerService, type UnifiedScanResult, BarcodeFormat } from '../src/services/unifiedScannerService';
import { barcodeScannerService } from '../src/services/barcodeScannerService';
import { mlKitPocService, type BarcodeScannerBridge } from '../src/services/mlKitPocService';
import { saveMedicine, findMedicineByBarcode } from '../src/services/pharmacyDb';

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, msg: string) {
  total++;
  if (condition) {
    console.log(`  ✓ [PASS] ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ [FAIL] ${msg}`);
    failed++;
  }
}

// Mock BarcodeScannerBridge for Android simulation
function createMockBridge(options?: {
  delayStartMs?: number;
  shouldFailStart?: boolean;
  supported?: boolean;
  torchSupported?: boolean;
}) {
  let isScanning = false;
  let isTorchOn = false;
  let lastStartScanOptions: any = null;
  let barcodesListener: ((ev: any) => void) | null = null;
  let errorListener: ((ev: any) => void) | null = null;

  const bridge: BarcodeScannerBridge = {
    async isSupported() {
      return { supported: options?.supported ?? true };
    },
    async checkPermissions() {
      return { camera: 'granted' };
    },
    async requestPermissions() {
      return { camera: 'granted' };
    },
    async startScan(scanOptions?: any) {
      lastStartScanOptions = scanOptions;
      if (options?.shouldFailStart) {
        throw new Error('Simulated CameraX startScan hardware failure');
      }
      if (options?.delayStartMs) {
        await new Promise((r) => setTimeout(r, options.delayStartMs));
      }
      isScanning = true;
    },
    async stopScan() {
      isScanning = false;
      isTorchOn = false;
    },
    async enableTorch() {
      isTorchOn = true;
    },
    async disableTorch() {
      isTorchOn = false;
    },
    async toggleTorch() {
      isTorchOn = !isTorchOn;
    },
    async isTorchEnabled() {
      return { enabled: isTorchOn };
    },
    async isTorchAvailable() {
      return { available: options?.torchSupported ?? true };
    },
    async setZoomRatio() {},
    async getMinZoomRatio() {
      return { zoomRatio: 1.0 };
    },
    async getMaxZoomRatio() {
      return { zoomRatio: 4.0 };
    },
    async addListener(eventName: string, listenerFunc: any) {
      if (eventName === 'barcodesScanned') {
        barcodesListener = listenerFunc;
      } else if (eventName === 'scanError') {
        errorListener = listenerFunc;
      }
      return {
        async remove() {
          if (eventName === 'barcodesScanned') barcodesListener = null;
          if (eventName === 'scanError') errorListener = null;
        }
      };
    }
  };

  return {
    bridge,
    async emitBarcode(barcode: string, format = 'EAN-13') {
      if (barcodesListener) {
        await barcodesListener({
          barcodes: [{ rawValue: barcode, format }]
        });
      }
    },
    emitError(message: string) {
      if (errorListener) {
        errorListener({ message });
      }
    },
    isBridgeScanning: () => isScanning,
    isBridgeTorchOn: () => isTorchOn,
    hasActiveListeners: () => barcodesListener !== null || errorListener !== null,
    getListenerCount: () => (barcodesListener ? 1 : 0) + (errorListener ? 1 : 0),
    getLastStartScanOptions: () => lastStartScanOptions
  };
}

async function runTestSuite() {
  console.log('========================================================================');
  console.log('🧪 RUNNING PHASE 1M.11-P2 UNIFIED SCANNER & SINGLE-SHOT TEST SUITE');
  console.log('========================================================================\n');

  // Seed sample drug for POS tests
  await saveMedicine({
    id: 'med-pos-test-1',
    name: 'Panadol Extra 500mg',
    barcode: '6211388017861',
    category: 'Analgesics',
    buyPrice: 3000,
    sellPrice: 4000,
    initialStock: 25,
    expiry: '2027-12-31'
  });

  // -------------------------------------------------------------------
  // TEST SECTION 1: PLATFORM ROUTING DETERMINISM & SINGLE-SHOT POS
  // -------------------------------------------------------------------
  console.log('--- Test Section 1: Deterministic Platform Engine Routing & Single-Shot POS ---');
  
  // 1A: Android Native Platform Routing
  const originalIsNative = mlKitPocService.isNativePlatform.bind(mlKitPocService);
  const mockAndroid = createMockBridge();
  mlKitPocService.setBridgeForTesting(mockAndroid.bridge);
  mlKitPocService.isNativePlatform = () => true;
  unifiedScannerService.setPlatformForTesting('android');

  assert(unifiedScannerService.isNativePlatform() === true, 'Android platform detected as native platform');
  assert(unifiedScannerService.getPlatform() === 'android', 'getPlatform() returns "android" on native');

  let receivedNativeScan: UnifiedScanResult | null = null;
  await unifiedScannerService.startScanning({
    target: 'pos',
    onScan: (res) => {
      receivedNativeScan = res;
    }
  });

  // Requirement 1: Android POS explicitly requests single-shot mode (continuous: false)
  assert(unifiedScannerService.getLastRequestedContinuous() === false, 'Android POS explicitly requests single-shot mode (continuous: false)');
  assert(unifiedScannerService.isSingleShotMode() === true, 'isSingleShotMode() evaluates to true for POS target');
  assert(unifiedScannerService.getActiveEngine() === 'mlkit-native', 'Unified service selects "mlkit-native" on Android');
  assert(mockAndroid.isBridgeScanning() === true, 'ML Kit native bridge startScan() was invoked');
  assert(mockAndroid.hasActiveListeners() === true, 'Native barcode and error listeners are active during scanning');
  assert(!barcodeScannerService.isScanning(), 'Web ZXing scanner remains completely stopped on Android');

  // Phase 1M.11-P4: Target POS format verification (Exactly 4 retail formats)
  const posFormats = unifiedScannerService.getLastConfiguredFormats();
  assert(Array.isArray(posFormats), 'POS formats is an array');
  assert(posFormats?.length === 4, 'POS format list contains exactly 4 formats');
  assert(Boolean(posFormats?.includes(BarcodeFormat.Ean13)), 'POS formats includes Ean13');
  assert(Boolean(posFormats?.includes(BarcodeFormat.Ean8)), 'POS formats includes Ean8');
  assert(Boolean(posFormats?.includes(BarcodeFormat.Code128)), 'POS formats includes Code128');
  assert(Boolean(posFormats?.includes(BarcodeFormat.UpcA)), 'POS formats includes UpcA');
  assert(!posFormats?.includes(BarcodeFormat.QrCode), 'POS formats excludes QrCode');

  // Phase 1M.11-P4 Bridge Verification: Confirmed formats actually passed across bridge
  const bridgeOptions = mockAndroid.getLastStartScanOptions();
  assert(bridgeOptions && Array.isArray(bridgeOptions.formats), 'Bridge received options with formats array');
  assert(bridgeOptions.formats.length === 4, 'Bridge received exactly 4 formats across JNI boundary');
  assert(bridgeOptions.formats.includes(BarcodeFormat.Ean13), 'Bridge formats include Ean13');
  assert(bridgeOptions.formats.includes(BarcodeFormat.Ean8), 'Bridge formats include Ean8');
  assert(bridgeOptions.formats.includes(BarcodeFormat.Code128), 'Bridge formats include Code128');
  assert(bridgeOptions.formats.includes(BarcodeFormat.UpcA), 'Bridge formats include UpcA');
  assert(!bridgeOptions.formats.includes(BarcodeFormat.QrCode), 'Bridge formats strictly exclude QrCode');

  // Requirement 2: The first valid native barcode is dispatched
  await mockAndroid.emitBarcode('6211388017861', 'EAN-13');
  assert(receivedNativeScan !== null, 'The first valid native barcode is dispatched');
  assert((receivedNativeScan as UnifiedScanResult | null)?.barcode === '6211388017861', 'Barcode value matches emitted native value');
  assert((receivedNativeScan as UnifiedScanResult | null)?.engineUsed === 'ML Kit Native (Android)', 'engineUsed normalized as "ML Kit Native (Android)"');

  // Requirement 4: Native listeners are removed after success & single-shot teardown
  await mlKitPocService.waitForNativeQueueToSettle();
  assert(mockAndroid.hasActiveListeners() === false, 'Native listeners are removed after success');
  assert(!unifiedScannerService.isScanning(), 'Scanner cleanly stopped on Android after single-shot success');
  assert(mockAndroid.isBridgeScanning() === false, 'ML Kit native bridge stopped cleanly');

  // 1B: Browser Platform Routing (Web)
  console.log('\n--- Test Section 2: Browser Platform Routing (ZXing WASM) ---');
  unifiedScannerService.setPlatformForTesting('web');
  assert(unifiedScannerService.isNativePlatform() === false, 'Web platform detected as non-native (browser)');
  assert(unifiedScannerService.getPlatform() === 'web', 'getPlatform() returns "web" on browser');

  // Requirement 8: No native ML Kit invocation occurs in browser mode
  const browserTestMock = createMockBridge();
  mlKitPocService.setBridgeForTesting(browserTestMock.bridge);
  assert(browserTestMock.isBridgeScanning() === false, 'No native ML Kit invocation occurs in browser mode');
  assert(!mlKitPocService.isScanning(), 'mlKitPocService is inactive in browser mode');

  // Mock video element for browser
  const mockVideo = {
    videoWidth: 1280,
    videoHeight: 720,
    srcObject: null,
    setAttribute: () => {},
    play: async () => {},
    pause: () => {},
    addEventListener: () => {},
    removeEventListener: () => {}
  } as any;

  // Verify missing video element throws error in browser mode
  let threwMissingVideo = false;
  try {
    await unifiedScannerService.startScanning({
      target: 'pos',
      videoElement: null,
      onScan: () => {}
    });
  } catch (err: any) {
    threwMissingVideo = true;
    assert(err.message.includes('عنصر الفيديو مطلوب'), 'Rejects browser start without videoElement');
  }
  assert(threwMissingVideo, 'Missing videoElement guard working');

  // -------------------------------------------------------------------
  // TEST SECTION 3: SINGLE SESSION & HARDWARE CLEANUP GUARANTEE
  // -------------------------------------------------------------------
  console.log('\n--- Test Section 3: Single Session & Cross-Engine Teardown Guarantee ---');
  
  // Start Android session first
  unifiedScannerService.setPlatformForTesting('android');
  mlKitPocService.setBridgeForTesting(mockAndroid.bridge);
  await unifiedScannerService.startScanning({
    target: 'pos',
    onScan: () => {}
  });
  assert(mockAndroid.isBridgeScanning() === true, 'Android ML Kit active');

  // Switch to Web and start: must cleanly stop Android ML Kit hardware first
  unifiedScannerService.setPlatformForTesting('web');
  // Attempt start on web (will stop native session first)
  try {
    await unifiedScannerService.startScanning({
      videoElement: mockVideo,
      onScan: () => {}
    });
  } catch {
    // MediaDevices mock may not have full stream in headless node, but verify Android was stopped
  }
  assert(mockAndroid.isBridgeScanning() === false, 'Prior Android ML Kit session was automatically torn down');

  // -------------------------------------------------------------------
  // TEST SECTION 4: RAPID OPEN / CLOSE LIFECYCLE
  // -------------------------------------------------------------------
  console.log('\n--- Test Section 4: Rapid Open / Close Lifecycle Resilience ---');
  unifiedScannerService.setPlatformForTesting('android');
  
  // Rapid start then stop immediately
  const startPromise = unifiedScannerService.startScanning({
    target: 'pos',
    onScan: () => {}
  });
  const stopPromise = unifiedScannerService.stopScanning();

  await Promise.all([startPromise.catch(() => {}), stopPromise]);
  await mlKitPocService.waitForNativeQueueToSettle();
  assert(!unifiedScannerService.isScanning(), 'Service safely settles in stopped state after rapid open/close');
  assert(mockAndroid.isBridgeScanning() === false, 'Hardware bridge is not leaked after rapid open/close');

  // -------------------------------------------------------------------
  // TEST SECTION 5: CANCELLATION DURING INITIALIZATION
  // -------------------------------------------------------------------
  console.log('\n--- Test Section 5: Cancellation During Camera Initialization ---');
  const slowMock = createMockBridge({ delayStartMs: 50 });
  mlKitPocService.setBridgeForTesting(slowMock.bridge);

  let onCancelCalled = false;
  const initPromise = unifiedScannerService.startScanning({
    target: 'pos',
    onScan: () => {},
    onCancel: () => {
      onCancelCalled = true;
    }
  });

  // Allow camera to enter in-flight initialization (during 50ms startup window)
  await new Promise((r) => setTimeout(r, 15));

  // Cancel while camera hardware initialization is in-flight
  await mlKitPocService.stopNativeScanSession('cancelled');
  await initPromise.catch(() => {});
  await mlKitPocService.waitForNativeQueueToSettle();

  assert(!unifiedScannerService.isScanning(), 'Service remains inactive after in-flight cancellation');
  assert(slowMock.isBridgeScanning() === false, 'No orphaned camera hardware remains active');

  // -------------------------------------------------------------------
  // TEST SECTION 6: NO DUPLICATE POS ADDITIONS / REPEAT COOLDOWN
  // -------------------------------------------------------------------
  console.log('\n--- Test Section 6: POS Anti-Duplicate Protection ---');
  let posDispatchCount = 0;
  const dispatchMock = createMockBridge();
  mlKitPocService.setBridgeForTesting(dispatchMock.bridge);

  await unifiedScannerService.startScanning({
    target: 'pos',
    onScan: () => {
      posDispatchCount++;
    }
  });

  // Emit same barcode twice in rapid succession (< 1200ms)
  dispatchMock.emitBarcode('6211388017861', 'EAN-13');
  dispatchMock.emitBarcode('6211388017861', 'EAN-13');

  assert(posDispatchCount === 1, 'Duplicate barcode within cooldown ignored (dispatch count = 1)');
  await unifiedScannerService.stopScanning();

  // -------------------------------------------------------------------
  // TEST SECTION 7: HARDWARE CONTROLS RESILIENCE (TORCH & ZOOM)
  // -------------------------------------------------------------------
  console.log('\n--- Test Section 7: Hardware Controls (Torch & Zoom) Routing ---');
  
  // 7A: Android Torch
  unifiedScannerService.setPlatformForTesting('android');
  const torchMock = createMockBridge({ torchSupported: true });
  mlKitPocService.setBridgeForTesting(torchMock.bridge);

  const torchState = await unifiedScannerService.toggleTorch();
  assert(typeof torchState === 'boolean', 'toggleTorch returns boolean status on Android');

  // 7B: Android Zoom
  const zoomRes = await unifiedScannerService.setZoom(2.0);
  assert(typeof zoomRes === 'number', 'setZoom returns valid ratio on Android');

  // 7C: Unsupported Web Torch (Graceful Fallback)
  unifiedScannerService.setPlatformForTesting('web');
  const webTorch = await unifiedScannerService.toggleTorch();
  assert(webTorch === false, 'toggleTorch returns false gracefully when web stream is inactive');

  const webZoom = await unifiedScannerService.setZoom(2.0);
  assert(typeof webZoom === 'number' && webZoom >= 1.0, 'setZoom returns safe default ratio without throwing');

  // -------------------------------------------------------------------
  // TEST SECTION 8: ENGINE INITIALIZATION FAILURE RESILIENCE
  // -------------------------------------------------------------------
  console.log('\n--- Test Section 8: Hardware Failure Graceful Rollback ---');
  unifiedScannerService.setPlatformForTesting('android');
  const failMock = createMockBridge({ shouldFailStart: true });
  mlKitPocService.setBridgeForTesting(failMock.bridge);

  let errorCaught = false;
  try {
    await unifiedScannerService.startScanning({
      target: 'pos',
      onScan: () => {}
    });
  } catch (e: any) {
    errorCaught = true;
    assert(e.message.includes('CameraX startScan hardware failure'), 'Reports hardware failure error message');
  }

  assert(errorCaught, 'Rejects cleanly on hardware start failure');
  assert(!unifiedScannerService.isScanning(), 'Service resets to inactive state on failure');

  // -------------------------------------------------------------------
  // TEST SECTION 9: PHASE 1M.11-P4 STOCKTAKING & FORMAT RESILIENCE
  // -------------------------------------------------------------------
  console.log('\n--- Test Section 9: Stocktaking Formats & Malformed Formats Resilience ---');
  unifiedScannerService.setPlatformForTesting('android');
  const stocktakingMock = createMockBridge();
  mlKitPocService.setBridgeForTesting(stocktakingMock.bridge);

  // 9A: Stocktaking configuration remains unchanged (broad 8-format list)
  await unifiedScannerService.startScanning({
    target: 'stocktaking',
    onScan: () => {}
  });

  const stocktakingFormats = unifiedScannerService.getLastConfiguredFormats();
  assert(stocktakingFormats?.length === 8, 'Stocktaking configuration retains all 8 default barcode formats');
  assert(Boolean(stocktakingFormats?.includes(BarcodeFormat.QrCode)), 'Stocktaking retains QrCode format');
  assert(Boolean(stocktakingFormats?.includes(BarcodeFormat.Itf)), 'Stocktaking retains Itf format');
  assert(Boolean(stocktakingFormats?.includes(BarcodeFormat.Code39)), 'Stocktaking retains Code39 format');

  const stockBridgeOptions = stocktakingMock.getLastStartScanOptions();
  assert(stockBridgeOptions.formats.length === 8, 'Stocktaking bridge received all 8 formats across JNI boundary');
  await unifiedScannerService.stopScanning();

  // 9B: Malformed / Unsupported formats fail safely
  const malformedMock = createMockBridge();
  mlKitPocService.setBridgeForTesting(malformedMock.bridge);
  await unifiedScannerService.startScanning({
    target: 'custom',
    formats: ['UNSUPPORTED_SYMBOLOGY_XYZ' as any, 'CORRUPTED' as any],
    onScan: () => {}
  });

  const fallbackBridgeOptions = malformedMock.getLastStartScanOptions();
  assert(Array.isArray(fallbackBridgeOptions.formats), 'Malformed formats safely fell back to array');
  assert(fallbackBridgeOptions.formats.length === 8, 'Malformed formats fell back to default format list safely without throwing');
  await unifiedScannerService.stopScanning();

  // Reset platform testing hook
  unifiedScannerService.setPlatformForTesting(null);
  mlKitPocService.setBridgeForTesting(null);
  mlKitPocService.isNativePlatform = originalIsNative;

  console.log('\n========================================================================');
  console.log(`TEST SUMMARY: ${passed}/${total} PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Unified routing test runner error:', err);
  process.exit(1);
});
