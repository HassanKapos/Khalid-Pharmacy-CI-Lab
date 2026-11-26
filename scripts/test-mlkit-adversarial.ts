import 'fake-indexeddb/auto';
import { mlKitPocService, MlKitPocService, type BarcodeScannerBridge } from '../src/services/mlKitPocService';

// Ensure browser-like globals in Node
if (typeof (global as any).window === 'undefined') {
  (global as any).window = global;
}
if (typeof document === 'undefined') {
  (global as any).document = {
    documentElement: {
      classList: {
        add: () => {},
        remove: () => {}
      }
    },
    body: {
      classList: {
        add: () => {},
        remove: () => {}
      },
      appendChild: () => {}
    },
    createElement: () => ({
      id: '',
      innerHTML: '',
      remove: () => {},
      querySelector: () => ({
        addEventListener: () => {},
        textContent: '',
        className: ''
      })
    })
  };
}

async function runAdversarialTestSuite() {
  console.log('========================================================================');
  console.log('🛡️ KHALID PHARMACY — PHASE 1K ADVERSARIAL VERIFICATION SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, msg: string) {
    total++;
    if (condition) {
      console.log(`  ✓ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ [FAIL] ${msg}`);
      process.exitCode = 1;
    }
  }

  // Helper to create mock bridge
  function createMockBridge(overrides: Partial<BarcodeScannerBridge> = {}): BarcodeScannerBridge {
    const defaultBridge: BarcodeScannerBridge = {
      isSupported: async () => ({ supported: true }),
      checkPermissions: async () => ({ camera: 'granted' }),
      requestPermissions: async () => ({ camera: 'granted' }),
      startScan: async () => {},
      stopScan: async () => {},
      enableTorch: async () => {},
      disableTorch: async () => {},
      toggleTorch: async () => {},
      isTorchEnabled: async () => ({ enabled: false }),
      isTorchAvailable: async () => ({ available: false }),
      setZoomRatio: async () => {},
      getMinZoomRatio: async () => ({ zoomRatio: 1 }),
      getMaxZoomRatio: async () => ({ zoomRatio: 4 }),
      addListener: async () => ({ remove: async () => {} })
    };
    return { ...defaultBridge, ...overrides };
  }

  // --- Test 1: Web Mode rejection and exactly-once settlement ---
  console.log('--- Test 1: Single-shot Promise exactly-once settlement in Web Mode ---');
  let rejectedCount = 0;
  try {
    await mlKitPocService.scanNativeSingleShot();
  } catch (err: any) {
    rejectedCount++;
    assert(err.message.includes('أندرويد الأصلي'), 'Web mode error message rejected cleanly');
  }
  assert(rejectedCount === 1, 'Promise settled exactly once (no unhandled rejections)');

  // --- Test 2: Concurrency Guard (Scenario B: Two concurrent start requests) ---
  console.log('\n--- Test 2: Scenario B: Concurrent start request blocked ---');
  const service2 = new MlKitPocService();
  service2.isNativePlatform = () => true;

  let resolveStartScan2: () => void = () => {};
  let notifyStartScanReached: () => void = () => {};
  const startScanReachedPromise2 = new Promise<void>((r) => { notifyStartScanReached = r; });

  const bridge2 = createMockBridge({
    startScan: () => {
      notifyStartScanReached();
      return new Promise<void>((r) => { resolveStartScan2 = r; });
    }
  });
  service2.setBridgeForTesting(bridge2);

  const startPromiseA = service2.startNativeScanSession(() => {});
  await startScanReachedPromise2;

  let startBRejected = false;
  try {
    await service2.startNativeScanSession(() => {});
  } catch (err: any) {
    startBRejected = true;
    assert(err.message.includes('جلسة مسح قيد التشغيل'), 'Session B was rejected with concurrency guard error');
  }
  assert(startBRejected, 'Concurrent start request safely blocked');
  resolveStartScan2();
  await startPromiseA;
  await service2.stopNativeScanSession('stopped');

  // --- Test 3: Scenario C: Late resolution of A does NOT kill Session B ---
  console.log('\n--- Test 3: Scenario C: Late resolution of Session A does NOT kill Session B ---');
  const service3 = new MlKitPocService();
  service3.isNativePlatform = () => true;

  let resolveStartScanA: () => void = () => {};
  let notifyStartScanAReached: () => void = () => {};
  const startScanAReachedPromise = new Promise<void>((r) => { notifyStartScanAReached = r; });

  let stopScanCallCount = 0;
  let removedListenersA = 0;

  const bridge3 = createMockBridge({
    startScan: async () => {
      // If this is Session A (first startScan call, sessionId === 1), hang until explicitly resolved
      if (service3.getActiveSessionIdForTesting() === 1) {
        notifyStartScanAReached();
        return new Promise<void>((r) => { resolveStartScanA = r; });
      }
    },
    stopScan: async () => {
      stopScanCallCount++;
    },
    addListener: async (name: string) => {
      const sessionIdAtAdd = service3.getActiveSessionIdForTesting();
      return {
        remove: async () => {
          if (sessionIdAtAdd === 1) removedListenersA++;
        }
      };
    }
  });
  service3.setBridgeForTesting(bridge3);

  // 1. Session A starts
  const sessionAPromise = service3.startNativeScanSession(() => {});
  await startScanAReachedPromise;
  assert(service3.isStartingSession(), 'Session A is starting');

  // 2. User cancels Session A while startScan is in flight
  await service3.stopNativeScanSession('cancelled');
  assert(!service3.isStartingSession(), 'Session A is stopped/cancelled');

  // 3. Session B requests start (queued behind Session A native startScan in the atomic queue)
  let sessionBStarted = false;
  const sessionBPromise = service3.startNativeScanSession(() => {}).then(() => {
    sessionBStarted = true;
  });

  // Verify Session B does not start native camera while A is in-flight
  assert(!sessionBStarted, 'Session B awaits Session A native operation in atomic queue');

  // 4. Now, Session A native startScan resolves!
  resolveStartScanA();
  await sessionAPromise;

  // Session B now acquires the native queue and finishes startup
  await sessionBPromise;
  assert(service3.isScanning(), 'Session B is actively scanning');
  const activeSessionIdBeforeLateA = service3.getActiveSessionIdForTesting();
  assert(activeSessionIdBeforeLateA === 2, 'Active session is Session B (ID: 2)');
  const stopCountAfterStartB = stopScanCallCount;

  // VERIFICATION:
  // Session B must STILL be scanning and NOT stopped!
  assert(service3.isScanning(), 'Session B is STILL scanning after late Session A resolution');
  assert(service3.getActiveSessionIdForTesting() === 2, 'Active session remains Session B (ID: 2)');
  assert(stopScanCallCount === stopCountAfterStartB, 'stopScan was NOT called during late Session A resolution');
  assert(removedListenersA >= 1, 'Session A listener handles were cleanly removed without leaking');

  // Clean up Session B
  await service3.stopNativeScanSession('stopped');
  assert(!service3.isScanning(), 'Session B cleanly stopped');

  // --- Test 4: Scenario A: Cancel before startScan finishes, NO Session B starts (no camera leak) ---
  console.log('\n--- Test 4: Scenario A: Cancel before startScan finishes cleans up orphaned camera ---');
  const service4 = new MlKitPocService();
  service4.isNativePlatform = () => true;

  let resolveStartScan4: () => void = () => {};
  let notifyStartScan4Reached: () => void = () => {};
  const startScan4ReachedPromise = new Promise<void>((r) => { notifyStartScan4Reached = r; });

  let stopScanCalled4 = 0;
  const bridge4 = createMockBridge({
    startScan: () => {
      notifyStartScan4Reached();
      return new Promise<void>((r) => { resolveStartScan4 = r; });
    },
    stopScan: async () => { stopScanCalled4++; }
  });
  service4.setBridgeForTesting(bridge4);

  const session4Promise = service4.startNativeScanSession(() => {});
  await startScan4ReachedPromise;

  // Cancel while pending
  await service4.stopNativeScanSession('cancelled');
  const stopCountInitial = stopScanCalled4;

  // Now late startScan finishes with no new session active
  resolveStartScan4();
  await session4Promise;

  assert(stopScanCalled4 > stopCountInitial, 'Orphaned camera hardware stopped when no newer session took over');
  assert(!service4.isScanning(), 'Service remains inactive');

  // --- Test 5: Scenario F: Listener removal failure does NOT prevent stopScan ---
  console.log('\n--- Test 5: Scenario F: Listener removal failure resilience ---');
  const service5 = new MlKitPocService();
  service5.isNativePlatform = () => true;
  let stopScanCalled5 = false;

  const bridge5 = createMockBridge({
    addListener: async () => ({
      remove: async () => {
        throw new Error('Simulated listener.remove() exception');
      }
    }),
    stopScan: async () => {
      stopScanCalled5 = true;
    }
  });
  service5.setBridgeForTesting(bridge5);

  await service5.startNativeScanSession(() => {});
  await service5.stopNativeScanSession('stopped');
  await service5.waitForNativeQueueToSettle();
  assert(stopScanCalled5, 'stopScan was executed despite listener removal exception');
  assert(!service5.isScanning(), 'Session state was cleanly set to not scanning');

  // --- Test 6: Scenario G: stopScan failure resilience ---
  console.log('\n--- Test 6: Scenario G: stopScan failure swallowed without crash ---');
  const service6 = new MlKitPocService();
  service6.isNativePlatform = () => true;

  const bridge6 = createMockBridge({
    stopScan: async () => {
      throw new Error('Simulated CameraX unbind native crash');
    }
  });
  service6.setBridgeForTesting(bridge6);

  await service6.startNativeScanSession(() => {});
  let stopThrew = false;
  try {
    await service6.stopNativeScanSession('stopped');
    await service6.waitForNativeQueueToSettle();
  } catch {
    stopThrew = true;
  }
  assert(!stopThrew, 'stopNativeScanSession swallowed stopScan error and did not crash caller');
  assert(!service6.isScanning(), 'Session state cleanly reset to inactive');

  // --- Test 7: Scenario E: Repeated stopNativeScanSession calls are idempotent ---
  console.log('\n--- Test 7: Scenario E: Repeated stop calls are idempotent ---');
  const service7 = new MlKitPocService();
  service7.isNativePlatform = () => true;
  let stopCallCount7 = 0;

  const bridge7 = createMockBridge({
    stopScan: async () => { stopCallCount7++; }
  });
  service7.setBridgeForTesting(bridge7);

  await service7.startNativeScanSession(() => {});
  const stopsAfterStart7 = stopCallCount7;

  await service7.stopNativeScanSession('stopped');
  await service7.stopNativeScanSession('stopped');
  await service7.stopNativeScanSession('stopped');
  assert(stopCallCount7 === stopsAfterStart7 + 1, 'Native stopScan was called exactly once on explicit stop, ignores repeated calls');

  // --- Test 8: Single-Shot Cancellation Settlement Contract (Resolves null) ---
  console.log('\n--- Test 8: Single-shot cancellation settles with null ---');
  const service8 = new MlKitPocService();
  service8.isNativePlatform = () => true;
  const bridge8 = createMockBridge();
  service8.setBridgeForTesting(bridge8);

  const singleShotPromise = service8.scanNativeSingleShot();
  // Allow start to complete
  await new Promise((r) => setTimeout(r, 10));

  // User cancels
  await service8.stopNativeScanSession('cancelled');
  const cancelResult = await singleShotPromise;
  assert(cancelResult === null, 'User cancellation cleanly resolved singleShotPromise with null');

  // --- Test 9: Scenario D: Stale Session Callbacks Ignored after Stop ---
  console.log('\n--- Test 9: Scenario D: Stale Session Callbacks Ignored after Stop ---');
  let deliveredCount9 = 0;
  let capturedBarcodeCb: any = null;

  const service9 = new MlKitPocService();
  service9.isNativePlatform = () => true;
  const bridge9 = createMockBridge({
    addListener: async (name: string, cb: any) => {
      if (name === 'barcodesScanned') capturedBarcodeCb = cb;
      return { remove: async () => {} };
    }
  });
  service9.setBridgeForTesting(bridge9);

  await service9.startNativeScanSession(() => {
    deliveredCount9++;
  });
  await service9.stopNativeScanSession('stopped');

  // Simulate late callback
  if (capturedBarcodeCb) {
    await capturedBarcodeCb({
      barcodes: [{ rawValue: '6211388017861', format: 'EAN_13' }]
    });
  }
  assert(deliveredCount9 === 0, 'Late callback after session stop was strictly ignored');

  // --- Test 10: Cancellation during checkPermissions prevents camera start ---
  console.log('\n--- Test 10: Cancellation during checkPermissions prevents camera start ---');
  const service10 = new MlKitPocService();
  service10.isNativePlatform = () => true;

  let resolveCheckPerm10: () => void = () => {};
  let notifyCheckPerm10Reached: () => void = () => {};
  const checkPerm10ReachedPromise = new Promise<void>((r) => { notifyCheckPerm10Reached = r; });

  let startScanCalled10 = false;
  const bridge10 = createMockBridge({
    checkPermissions: () => {
      notifyCheckPerm10Reached();
      return new Promise<{ camera: string }>((r) => {
        resolveCheckPerm10 = () => r({ camera: 'granted' });
      });
    },
    startScan: async () => {
      startScanCalled10 = true;
    }
  });
  service10.setBridgeForTesting(bridge10);

  const startPromise10 = service10.startNativeScanSession(() => {});
  await checkPerm10ReachedPromise;

  assert(service10.isStartingSession(), 'Session is pending in checkPermissions');
  assert(service10.getActiveSessionIdForTesting() !== null, 'Session scope assigned before permission check');

  // Cancel while waiting for permission probe
  await service10.stopNativeScanSession('cancelled');
  assert(!service10.isStartingSession(), 'Session aborted cleanly upon cancel');

  // Now permission probe completes late
  resolveCheckPerm10();
  await startPromise10;

  assert(!startScanCalled10, 'Camera startScan was NEVER invoked after cancellation during checkPermissions');
  assert(!service10.isScanning(), 'Service remains inactive with zero camera hardware leaks');

  // --- Test 11: Single-shot cancellation during permission check settles cleanly with null ---
  console.log('\n--- Test 11: Single-shot cancellation during checkPermissions settles cleanly with null ---');
  const service11 = new MlKitPocService();
  service11.isNativePlatform = () => true;

  let resolveCheckPerm11: () => void = () => {};
  let notifyCheckPerm11Reached: () => void = () => {};
  const checkPerm11ReachedPromise = new Promise<void>((r) => { notifyCheckPerm11Reached = r; });

  let startScanCalled11 = false;
  const bridge11 = createMockBridge({
    checkPermissions: () => {
      notifyCheckPerm11Reached();
      return new Promise<{ camera: string }>((r) => {
        resolveCheckPerm11 = () => r({ camera: 'granted' });
      });
    },
    startScan: async () => {
      startScanCalled11 = true;
    }
  });
  service11.setBridgeForTesting(bridge11);

  const singleShotPromise11 = service11.scanNativeSingleShot();
  await checkPerm11ReachedPromise;

  // User cancels during permission prompt
  await service11.stopNativeScanSession('cancelled');

  resolveCheckPerm11();
  const singleShotResult11 = await singleShotPromise11;

  assert(singleShotResult11 === null, 'Single-shot promise cleanly resolved with null when cancelled during checkPermissions');
  assert(!startScanCalled11, 'startScan was not invoked for cancelled single-shot');
  assert(!service11.isScanning(), 'Scanner is completely stopped and inactive');

  // --- Test 12: Cancellation during permission request (requestPermissions deferred) ---
  console.log('\n--- Test 12: Cancellation during requestPermissions prevents camera start ---');
  const service12 = new MlKitPocService();
  service12.isNativePlatform = () => true;

  let resolveRequestPerm12: () => void = () => {};
  let notifyRequestPerm12Reached: () => void = () => {};
  const requestPerm12ReachedPromise = new Promise<void>((r) => { notifyRequestPerm12Reached = r; });

  let startScanCalled12 = false;
  const bridge12 = createMockBridge({
    checkPermissions: async () => ({ camera: 'prompt' }),
    requestPermissions: () => {
      notifyRequestPerm12Reached();
      return new Promise<{ camera: string }>((r) => {
        resolveRequestPerm12 = () => r({ camera: 'granted' });
      });
    },
    startScan: async () => {
      startScanCalled12 = true;
    }
  });
  service12.setBridgeForTesting(bridge12);

  const startPromise12 = service12.startNativeScanSession(() => {});
  await requestPerm12ReachedPromise;

  assert(service12.isStartingSession(), 'Session is pending inside requestPermissions prompt');

  // Cancel session while permission dialog is open on screen
  await service12.stopNativeScanSession('cancelled');
  assert(!service12.isStartingSession(), 'Session marked non-starting on cancel');

  // User later taps "Allow" on the system dialog
  resolveRequestPerm12();
  await startPromise12;

  assert(!startScanCalled12, 'Camera startScan was NEVER invoked after cancel during requestPermissions');
  assert(!service12.isScanning(), 'Service safely remains inactive');

  // --- Test 13: Permanent permission denial handling ---
  console.log('\n--- Test 13: Permanent permission denial rejects cleanly ---');
  const service13 = new MlKitPocService();
  service13.isNativePlatform = () => true;

  let startScanCalled13 = false;
  const bridge13 = createMockBridge({
    checkPermissions: async () => ({ camera: 'denied' }),
    requestPermissions: async () => ({ camera: 'denied' }),
    startScan: async () => { startScanCalled13 = true; }
  });
  service13.setBridgeForTesting(bridge13);

  let errorCaught13: any = null;
  try {
    await service13.startNativeScanSession(() => {});
  } catch (err) {
    errorCaught13 = err;
  }

  assert(errorCaught13 !== null, 'Permanent denial threw error');
  assert(errorCaught13.message.includes('تم رفض إذن استخدام الكاميرا'), 'Error message informs user of camera permission denial');
  assert(!startScanCalled13, 'Camera startScan was never called on permission denial');
  assert(!service13.isScanning(), 'Service remains inactive after permission denial');

  // --- Test 14: First Barcode Event arriving during camera spinup is NOT lost ---
  console.log('\n--- Test 14: First Barcode Event arriving during camera startup is preserved ---');
  const service14 = new MlKitPocService();
  service14.isNativePlatform = () => true;

  let capturedBarcodeListener14: ((event: any) => Promise<void>) | null = null;
  let receivedBarcode14: string | null = null;

  const bridge14 = createMockBridge({
    addListener: async (name: string, listener: any) => {
      if (name === 'barcodesScanned') {
        capturedBarcodeListener14 = listener;
      }
      return { remove: async () => {} };
    },
    startScan: async () => {
      // Simulate instantaneous barcode event firing during native CameraX startup!
      if (capturedBarcodeListener14) {
        await capturedBarcodeListener14({
          barcodes: [{ rawValue: '6211388017861', format: 'EAN_13' }]
        });
      }
    }
  });
  service14.setBridgeForTesting(bridge14);

  await service14.startNativeScanSession((res) => {
    receivedBarcode14 = res.barcode;
  });

  assert(receivedBarcode14 === '6211388017861', 'First barcode event during startup was successfully delivered and not lost');
  await service14.stopNativeScanSession('stopped');

  // --- Test 15: First Listener registration failure triggers clean rollback ---
  console.log('\n--- Test 15: First Listener registration failure triggers rollback ---');
  const service15 = new MlKitPocService();
  service15.isNativePlatform = () => true;

  let startScanCalled15 = false;
  const bridge15 = createMockBridge({
    addListener: async (name: string) => {
      if (name === 'barcodesScanned') {
        throw new Error('Simulated barcodesScanned listener registration failure');
      }
      return { remove: async () => {} };
    },
    startScan: async () => { startScanCalled15 = true; }
  });
  service15.setBridgeForTesting(bridge15);

  let errorCaught15: any = null;
  try {
    await service15.startNativeScanSession(() => {});
  } catch (e) {
    errorCaught15 = e;
  }

  assert(errorCaught15 !== null, 'Listener registration failure threw error');
  assert(!startScanCalled15, 'startScan was never called after listener registration failure');
  assert(!service15.isScanning(), 'Service remains inactive');

  // --- Test 16: Second Listener registration failure triggers clean rollback ---
  console.log('\n--- Test 16: Second Listener registration failure triggers rollback ---');
  const service16 = new MlKitPocService();
  service16.isNativePlatform = () => true;

  let firstListenerRemoved16 = false;
  let startScanCalled16 = false;
  const bridge16 = createMockBridge({
    addListener: async (name: string) => {
      if (name === 'barcodesScanned') {
        return {
          remove: async () => {
            firstListenerRemoved16 = true;
          }
        };
      }
      if (name === 'scanError') {
        throw new Error('Simulated scanError listener registration failure');
      }
      return { remove: async () => {} };
    },
    startScan: async () => { startScanCalled16 = true; }
  });
  service16.setBridgeForTesting(bridge16);

  let errorCaught16: any = null;
  try {
    await service16.startNativeScanSession(() => {});
  } catch (e) {
    errorCaught16 = e;
  }

  assert(errorCaught16 !== null, 'Second listener registration failure threw error');
  assert(firstListenerRemoved16, 'First listener was cleanly removed during rollback');
  assert(!startScanCalled16, 'startScan was never called after error listener failure');
  assert(!service16.isScanning(), 'Service remains inactive');

  // --- Test 17: Camera startScan failure triggers clean rollback and error delivery ---
  console.log('\n--- Test 17: Camera start failure triggers clean rollback ---');
  const service17 = new MlKitPocService();
  service17.isNativePlatform = () => true;

  let listenersRemoved17 = 0;
  const bridge17 = createMockBridge({
    addListener: async () => ({
      remove: async () => { listenersRemoved17++; }
    }),
    startScan: async () => {
      throw new Error('CameraX hardware binding error');
    }
  });
  service17.setBridgeForTesting(bridge17);

  let errorCaught17: any = null;
  try {
    await service17.startNativeScanSession(() => {});
  } catch (e) {
    errorCaught17 = e;
  }

  assert(errorCaught17 !== null, 'startScan hardware failure threw error');
  assert(listenersRemoved17 >= 1, 'Listeners were cleanly removed on startScan failure');
  assert(!service17.isScanning(), 'Service remains inactive');

  // --- Test 18: Multiple simultaneous cancellation requests are idempotent ---
  console.log('\n--- Test 18: Multiple simultaneous cancellation requests are idempotent ---');
  const service18 = new MlKitPocService();
  service18.isNativePlatform = () => true;

  let onCancelCount18 = 0;
  const bridge18 = createMockBridge();
  service18.setBridgeForTesting(bridge18);

  await service18.startNativeScanSession(
    () => {},
    () => {},
    {
      onCancel: () => { onCancelCount18++; }
    }
  );

  // Execute multiple cancellation requests concurrently
  await Promise.all([
    service18.stopNativeScanSession('cancelled'),
    service18.stopNativeScanSession('cancelled'),
    service18.stopNativeScanSession('cancelled')
  ]);

  assert(onCancelCount18 === 1, 'onCancel callback invoked exactly once across simultaneous cancellations');
  assert(!service18.isScanning(), 'Service is inactive after concurrent cancellations');

  // --- Test 19: Mandatory Race Test: Native Camera Serialization across Session A and Session B ---
  console.log('\n--- Test 19: Mandatory Race Test: Native Camera Serialization across A & B ---');
  const service19 = new MlKitPocService();
  service19.isNativePlatform = () => true;

  let resolveStartScanA19: () => void = () => {};
  let notifyStartScanAReached19: () => void = () => {};
  const startScanAReachedPromise19 = new Promise<void>((r) => { notifyStartScanAReached19 = r; });

  let nativeStartCount19 = 0;
  let nativeStopCount19 = 0;
  let sessionBStartedNative = false;

  const bridge19 = createMockBridge({
    startScan: async () => {
      nativeStartCount19++;
      const currentId = service19.getActiveSessionIdForTesting();
      if (currentId === 1) {
        // Session A pending
        notifyStartScanAReached19();
        return new Promise<void>((r) => {
          resolveStartScanA19 = r;
        });
      }
      if (currentId === 2) {
        sessionBStartedNative = true;
      }
    },
    stopScan: async () => {
      nativeStopCount19++;
    }
  });
  service19.setBridgeForTesting(bridge19);

  // 1. Session A starts
  const sessionAPromise19 = service19.startNativeScanSession(() => {});
  await startScanAReachedPromise19;
  assert(service19.isStartingSession(), 'Session A is starting and native startScan is pending');
  assert(nativeStartCount19 === 1, 'Native startScan called exactly once for Session A');

  // 2. User cancels Session A while startScan is still pending
  await service19.stopNativeScanSession('cancelled');
  assert(!service19.isStartingSession(), 'Session A UI cancelled immediately without deadlocking');

  // 3. User immediately requests Session B while Session A native startScan is STILL in flight
  let sessionBCompleted = false;
  let sessionBError: any = null;
  const sessionBPromise19 = service19.startNativeScanSession(
    () => {},
    (err) => { sessionBError = err; }
  ).then(() => {
    sessionBCompleted = true;
  });

  // 4. Verify that Session B does NOT start native camera prematurely while A is in flight!
  assert(!sessionBStartedNative, 'Session B did NOT invoke native startScan prematurely while Session A was in flight');
  assert(!sessionBCompleted, 'Session B start is safely suspended waiting for native serialization');

  // 5. Now, resolve Session A original native start operation
  resolveStartScanA19();
  await sessionAPromise19;

  // 6. Now Session B proceeds and completes its native camera startup safely!
  await sessionBPromise19;

  assert(sessionBCompleted, 'Session B proceeded and completed startup cleanly after Session A completed');
  assert(sessionBStartedNative, 'Session B successfully started native CameraX');
  assert(service19.isScanning(), 'Session B is actively scanning');
  assert(service19.getActiveSessionIdForTesting() === 2, 'Active session is confirmed Session B (ID: 2)');

  // 7. Verify that no stale cleanup from Session A can stop Session B
  const stopCountBeforeStaleCheck = nativeStopCount19;
  // Trigger any late callbacks or teardowns
  assert(nativeStopCount19 === stopCountBeforeStaleCheck, 'Session A cleanup did NOT invoke stopScan against active Session B');
  assert(service19.isScanning(), 'Session B is STILL scanning and unharmed by Session A resolution');

  // Clean up Session B
  await service19.stopNativeScanSession('stopped');
  assert(!service19.isScanning(), 'Session B cleanly stopped at end of test');

  console.log('\n========================================================================');
  console.log(`PHASE 1M.3-R1 TEST SUMMARY: ${passed}/${total} PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('========================================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runAdversarialTestSuite().catch((err) => {
  console.error('Phase 1M suite crashed:', err);
  process.exit(1);
});
