/**
 * Standalone Automated Test Suite for Hardened Isolated Restore Sandbox Engine (P0.2.3-R2)
 * Khalid Pharmacy Management System
 *
 * Validates:
 * 1. Lossless Deep Clone in getStoreRecords (Date, BigInt, Map, Set, TypedArray, DataView, ArrayBuffer, RegExp, undefined, Sparse Array, Shared References, Circular Reference).
 * 2. ArrayBuffer & TypedArray Zeroing on close() (Direct references, shared buffers across views).
 * 3. Active Production Isolation Interceptor Spy (Intercepts & verifies ZERO IndexedDB access during sandbox operations).
 * 4. Deterministic Deferred Barrier Race Condition & Cancellation Guard (close() invoked during in-flight async loadEncryptedBackup cleanly invalidates session).
 * 5. Manifest Integrity Validation (duplicate storeNames, recordCount mismatches, payloadChecksum verification).
 * 6. State Preservation & Atomic Rollback on Reload Failure.
 * 7. Session Isolation & Rejection of Operations on Closed Sessions.
 */

import {
  createRestoreSandbox,
  getRestoreSandboxSession,
  destroyRestoreSandbox,
  destroyAllRestoreSandboxes,
  getActiveSandboxCount,
  RestoreSandboxSession,
} from '../src/services/restoreSandbox.js';

import {
  encryptBackup,
  EncryptedBackupPackageV1,
} from '../src/services/backupEncryption.js';

import * as backupFormat from '../src/services/backupFormat.js';

import {
  serializeLossless,
} from '../src/services/backupSerializer.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASS] ${testName}`);
  } else {
    failedTests++;
    console.error(`  [FAIL] ${testName}${detail ? ` - ${detail}` : ''}`);
  }
}

async function assertThrowsAsync(
  fn: () => Promise<any>,
  testName: string,
  expectedSubstring?: string
) {
  totalTests++;
  try {
    const res = await fn();
    failedTests++;
    console.error(
      `  [FAIL] ${testName} - Expected error to be thrown, but succeeded with output:`,
      typeof res === 'string' ? res.substring(0, 50) : res
    );
  } catch (err: any) {
    if (
      !expectedSubstring ||
      (typeof err.message === 'string' && err.message.includes(expectedSubstring))
    ) {
      passedTests++;
      console.log(`  [PASS] ${testName} (Caught expected: "${expectedSubstring || err.message}")`);
    } else {
      failedTests++;
      console.error(
        `  [FAIL] ${testName} - Threw unexpected error: "${err.message}", expected substring: "${expectedSubstring}"`
      );
    }
  }
}

function assertThrowsSync(
  fn: () => any,
  testName: string,
  expectedSubstring?: string
) {
  totalTests++;
  try {
    const res = fn();
    failedTests++;
    console.error(
      `  [FAIL] ${testName} - Expected synchronous error to be thrown, but succeeded:`,
      res
    );
  } catch (err: any) {
    if (
      !expectedSubstring ||
      (typeof err.message === 'string' && err.message.includes(expectedSubstring))
    ) {
      passedTests++;
      console.log(`  [PASS] ${testName} (Caught expected: "${expectedSubstring || err.message}")`);
    } else {
      failedTests++;
      console.error(
        `  [FAIL] ${testName} - Threw unexpected error: "${err.message}", expected substring: "${expectedSubstring}"`
      );
    }
  }
}

/**
 * Production IndexedDB Access Interceptor Spy
 */
function spyOnIndexedDBAccess(): { didAccess: () => boolean; restore: () => void } {
  let accessed = false;
  const originalIndexedDB = (globalThis as any).indexedDB;

  const fakeIndexedDB = new Proxy(originalIndexedDB || {}, {
    get(target, prop, receiver) {
      accessed = true;
      if (
        prop === 'open' ||
        prop === 'deleteDatabase' ||
        prop === 'databases' ||
        prop === 'cmp'
      ) {
        throw new Error(
          `SECURITY VIOLATION: Sandbox attempted production IndexedDB access via indexedDB.${String(prop)}`
        );
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  Object.defineProperty(globalThis, 'indexedDB', {
    value: fakeIndexedDB,
    configurable: true,
    writable: true,
  });

  return {
    didAccess: () => accessed,
    restore: () => {
      if (originalIndexedDB !== undefined) {
        Object.defineProperty(globalThis, 'indexedDB', {
          value: originalIndexedDB,
          configurable: true,
          writable: true,
        });
      } else {
        delete (globalThis as any).indexedDB;
      }
    },
  };
}

async function runTests() {
  console.log('======================================================================');
  console.log('KHALID PHARMACY — ISOLATED RESTORE SANDBOX TEST SUITE (P0.2.3-R2)');
  console.log('Testing Lossless Deep Clone, Shared References, Zeroing & Isolation');
  console.log('======================================================================\n');

  destroyAllRestoreSandboxes();

  const testPassword = 'CorrectPharmacistSecretPassphrase2026!';

  // Helper to construct a valid synthetic KhalidPharmacyBackupV1 object and encrypt it
  async function createSyntheticEncryptedBackup(
    customHeader?: Partial<backupFormat.KhalidPharmacyBackupV1['header']>,
    customSchema?: Partial<backupFormat.KhalidPharmacyBackupV1['schema']>,
    customPayload?: Record<string, any>,
    tamperChecksum = false
  ): Promise<EncryptedBackupPackageV1> {
    const sampleMedicines = [
      { id: 'MED-101', name: 'Amoxicillin 500mg', stock: 150, price: 450 },
      { id: 'MED-102', name: 'Paracetamol 500mg', stock: 600, price: 150 },
    ];

    const sampleSales = [
      { id: 'SALE-9001', totalAmount: 600, customerName: 'Ahmed Omar', timestamp: '2026-11-11T14:00:00.000Z' },
    ];

    const medSerialized = serializeLossless(sampleMedicines);
    const salesSerialized = serializeLossless(sampleSales);

    const medChecksum = await backupFormat.computeSha256(backupFormat.canonicalJsonStringify(medSerialized));
    const salesChecksum = await backupFormat.computeSha256(backupFormat.canonicalJsonStringify(salesSerialized));

    const backupData: Omit<backupFormat.KhalidPharmacyBackupV1, 'checksum'> = {
      header: {
        version: '1.0',
        appId: 'com.khalidpharmacy.app',
        format: 'KP_BACKUP_V1',
        createdAt: new Date().toISOString(),
        generator: 'Khalid Pharmacy Synthetic Test Engine',
        ...customHeader,
      },
      schema: {
        dbVersion: 4,
        stores: [
          { storeName: 'medicines', recordCount: 2, payloadChecksum: medChecksum },
          { storeName: 'sales', recordCount: 1, payloadChecksum: salesChecksum },
        ],
        ...customSchema,
      },
      payload: customPayload || {
        medicines: medSerialized,
        sales: salesSerialized,
      },
    };

    let computedChecksum = await backupFormat.computeBackupChecksum(backupData);
    if (tamperChecksum) {
      computedChecksum = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    }

    const fullBackup: backupFormat.KhalidPharmacyBackupV1 = {
      ...backupData,
      checksum: computedChecksum,
    };

    return encryptBackup(fullBackup, testPassword);
  }

  // -------------------------------------------------------------------------
  // SUITE 1: Sandbox Session Lifecycle & Unique Session Registry
  // -------------------------------------------------------------------------
  console.log('--- Suite 1: Sandbox Session Lifecycle & Registry ---');

  const session1 = createRestoreSandbox();
  const session2 = createRestoreSandbox();

  assert(
    session1.sandboxId !== session2.sandboxId,
    'Suite 1.1: Automatic sandbox IDs are unique across sessions'
  );
  assert(
    session1.getStatus() === 'initialized' && session2.getStatus() === 'initialized',
    'Suite 1.2: Newly created sandbox sessions are in "initialized" status'
  );
  assert(
    getActiveSandboxCount() === 2,
    'Suite 1.3: Active sandbox registry accurately tracks 2 open sessions'
  );

  const customSession = createRestoreSandbox('custom_audit_sandbox_001');
  assert(
    customSession.sandboxId === 'custom_audit_sandbox_001',
    'Suite 1.4: Custom sandbox ID assigned correctly'
  );

  assertThrowsSync(
    () => createRestoreSandbox('custom_audit_sandbox_001'),
    'Suite 1.5: Reject creation of duplicate sandbox ID',
    'already exists'
  );

  assert(
    typeof (session1 as any).getRawStoreRecords === 'undefined',
    'Suite 1.6: Public service interface strictly excludes getRawStoreRecords'
  );

  // -------------------------------------------------------------------------
  // SUITE 2: End-to-End Decryption & Record Restoration
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 2: End-to-End Decryption & Record Restoration ---');

  const validEncryptedPackage = await createSyntheticEncryptedBackup();
  const summary = await session1.loadEncryptedBackup(validEncryptedPackage, testPassword);

  assert(
    summary.status === 'loaded' && session1.getStatus() === 'loaded',
    'Suite 2.1: Sandbox status updated to "loaded" after valid decryption and schema verification'
  );
  assert(
    summary.totalStores === 2,
    'Suite 2.2: Summary correctly identifies 2 restored stores'
  );
  assert(
    summary.totalRecords === 3,
    'Suite 2.3: Summary correctly calculates 3 total restored records across stores'
  );

  const restoredMedicines = session1.getStoreRecords('medicines');
  assert(
    Array.isArray(restoredMedicines) && restoredMedicines.length === 2,
    'Suite 2.4: "medicines" store restored 2 records'
  );
  assert(
    restoredMedicines[0].id === 'MED-101' && restoredMedicines[0].name === 'Amoxicillin 500mg',
    'Suite 2.5: Lossless graph deserialization preserved exact medicine fields'
  );

  // -------------------------------------------------------------------------
  // SUITE 3: Lossless Deep Clone, Complex Types & Shared References
  // (ArrayBuffer, DataView, Sparse Array, Shared References, Circular References)
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 3: Lossless Deep Clone, Complex Types & Shared References ---');

  // Create shared object identity
  const sharedSupplierObj = { supplierId: 'SUP-777', supplierName: 'Pharmaland International' };

  // Create shared ArrayBuffer shared across a Uint8Array and an Int16Array
  const sharedBuffer = new Uint8Array([0x4b, 0x48, 0x50, 0x21, 0x00, 0x11, 0x22, 0x33]).buffer;
  const sharedViewU8 = new Uint8Array(sharedBuffer, 0, 8);
  const sharedViewI16 = new Int16Array(sharedBuffer, 0, 4);

  // DataView
  const dataViewInstance = new DataView(sharedBuffer, 0, 4);

  // Sparse Array
  const sparseArr: any[] = [];
  sparseArr[0] = 'FIRST_ITEM';
  sparseArr[1] = undefined;
  // Index 2 is an intentional empty hole
  sparseArr[3] = 'FOURTH_ITEM';

  const complexRecord: any = {
    id: 'COMPLEX-001',
    createdDate: new Date('2026-11-11T12:00:00.000Z'),
    bigIntValue: BigInt('9007199254740993'),
    metaMap: new Map<string, any>([['subCategory', 'ANTIBIOTIC'], ['dosage', 500]]),
    tagsSet: new Set(['CRITICAL', 'REFRIGERATED']),
    pattern: /^[A-Z]{3}-\d{4}$/gi,
    bufferObj: sharedBuffer,
    u8View: sharedViewU8,
    i16View: sharedViewI16,
    dvInstance: dataViewInstance,
    sparseData: sparseArr,
    primarySupplier: sharedSupplierObj,
    secondarySupplier: sharedSupplierObj, // Shared reference to primarySupplier
    optionalProp: undefined,
  };
  // Add circular self-reference
  complexRecord.selfRef = complexRecord;

  const complexSerialized = serializeLossless([complexRecord]);
  const complexChecksum = await backupFormat.computeSha256(backupFormat.canonicalJsonStringify(complexSerialized));

  const complexBackupPackage = await createSyntheticEncryptedBackup(
    {},
    { stores: [{ storeName: 'complex_store', recordCount: 1, payloadChecksum: complexChecksum }] },
    { complex_store: complexSerialized }
  );

  const sessionComplex = createRestoreSandbox('session_complex_test');
  await sessionComplex.loadEncryptedBackup(complexBackupPackage, testPassword);

  const clonedRecords = sessionComplex.getStoreRecords('complex_store');
  const recordCopy1 = clonedRecords[0];

  assert(
    recordCopy1.createdDate instanceof Date && recordCopy1.createdDate.toISOString() === '2026-11-11T12:00:00.000Z',
    'Suite 3.1: Date instance preserved exactly with ISO string in lossless clone'
  );

  assert(
    typeof recordCopy1.bigIntValue === 'bigint' && recordCopy1.bigIntValue === BigInt('9007199254740993'),
    'Suite 3.2: BigInt value preserved accurately in lossless clone'
  );

  assert(
    recordCopy1.metaMap instanceof Map && recordCopy1.metaMap.get('subCategory') === 'ANTIBIOTIC',
    'Suite 3.3: Map instance preserved with entries intact in lossless clone'
  );

  assert(
    recordCopy1.tagsSet instanceof Set && recordCopy1.tagsSet.has('REFRIGERATED'),
    'Suite 3.4: Set instance preserved with elements intact in lossless clone'
  );

  assert(
    recordCopy1.pattern instanceof RegExp && recordCopy1.pattern.test('KHP-2026'),
    'Suite 3.5: RegExp pattern & flags preserved and operational in lossless clone'
  );

  assert(
    recordCopy1.bufferObj instanceof ArrayBuffer && recordCopy1.bufferObj.byteLength === 8,
    'Suite 3.6: ArrayBuffer instance preserved with exact byteLength'
  );

  assert(
    recordCopy1.dvInstance instanceof DataView && recordCopy1.dvInstance.getUint8(0) === 0x4b,
    'Suite 3.7: DataView instance preserved and reads byte values accurately'
  );

  assert(
    recordCopy1.u8View.buffer === recordCopy1.i16View.buffer && recordCopy1.u8View.buffer === recordCopy1.bufferObj,
    'Suite 3.8: Shared ArrayBuffer identity preserved across multiple TypedArray and DataView instances'
  );

  assert(
    Array.isArray(recordCopy1.sparseData) &&
      recordCopy1.sparseData.length === 4 &&
      recordCopy1.sparseData[0] === 'FIRST_ITEM' &&
      recordCopy1.sparseData[1] === undefined &&
      !(2 in recordCopy1.sparseData) &&
      recordCopy1.sparseData[3] === 'FOURTH_ITEM',
    'Suite 3.9: Sparse array hole (index 2 in sparseData === false) and undefined element preserved'
  );

  assert(
    recordCopy1.primarySupplier === recordCopy1.secondarySupplier &&
      recordCopy1.primarySupplier.supplierId === 'SUP-777',
    'Suite 3.10: Shared object reference identity (primarySupplier === secondarySupplier) preserved in lossless clone'
  );

  assert(
    recordCopy1.selfRef === recordCopy1,
    'Suite 3.11: Circular self-reference identity preserved accurately in lossless clone'
  );

  // Verify independence of cloned copy from original sandbox state
  recordCopy1.createdDate.setFullYear(1990);
  recordCopy1.u8View[0] = 0x00;
  recordCopy1.primarySupplier.supplierName = 'MUTATED_NAME';

  const recordCopy2 = sessionComplex.getStoreRecords('complex_store')[0];
  assert(
    recordCopy2.createdDate.getFullYear() === 2026 &&
      recordCopy2.u8View[0] === 0x4b &&
      recordCopy2.primarySupplier.supplierName === 'Pharmaland International',
    'Suite 3.12: Mutating cloned record copy does NOT contaminate sandbox state or subsequent getStoreRecords calls'
  );

  // -------------------------------------------------------------------------
  // SUITE 4: ArrayBuffer & Shared Buffer Zeroing on close()
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 4: ArrayBuffer & Shared Buffer Zeroing on close() ---');

  // Retain direct references to inner restored ArrayBuffer and TypedArray views directly from Sandbox internal state via White-box test access
  const internalStoresMap = (sessionComplex as any).storesMap as Map<string, any[]>;
  const rawInternalRecord = internalStoresMap.get('complex_store')![0];
  const rawBufRef = rawInternalRecord.bufferObj as ArrayBuffer;
  const rawU8Ref = rawInternalRecord.u8View as Uint8Array;
  const rawI16Ref = rawInternalRecord.i16View as Int16Array;
  const rawDvRef = rawInternalRecord.dvInstance as DataView;

  assert(
    rawU8Ref[0] === 0x4b && rawDvRef.getUint8(0) === 0x4b,
    'Suite 4.1: ArrayBuffer and views contain non-zero payload before sandbox closure'
  );

  // Close sessionComplex
  sessionComplex.close();

  assert(
    sessionComplex.getStatus() === 'closed',
    'Suite 4.2: Sandbox session status updated to "closed"'
  );

  // Note on V8 memory: ArrayBuffers zeroed in memory via TypedArray.fill(0)
  assert(
    rawU8Ref[0] === 0 && rawU8Ref[1] === 0 && rawU8Ref[2] === 0 && rawU8Ref[3] === 0,
    'Suite 4.3: Memory Zeroing Verified: Uint8Array view bytes zeroed out completely after close()'
  );

  assert(
    rawI16Ref[0] === 0 && rawI16Ref[1] === 0,
    'Suite 4.4: Shared Int16Array view bytes zeroed out completely after close()'
  );

  assert(
    rawDvRef.getUint8(0) === 0 && rawDvRef.getUint8(1) === 0,
    'Suite 4.5: Shared DataView bytes zeroed out completely after close()'
  );

  const underlyingBytes = new Uint8Array(rawBufRef);
  let allZero = true;
  for (let b = 0; b < underlyingBytes.length; b++) {
    if (underlyingBytes[b] !== 0) {
      allZero = false;
      break;
    }
  }
  assert(
    allZero === true,
    'Suite 4.6: Underlying shared ArrayBuffer zero-filled 100% across all bytes after close()'
  );

  // -------------------------------------------------------------------------
  // SUITE 5: Active Production Isolation Spy (0 IndexedDB Access)
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 5: Active Production Isolation Spy ---');

  const spy = spyOnIndexedDBAccess();

  const sessionSpy = createRestoreSandbox('session_spy_test');
  await sessionSpy.loadEncryptedBackup(validEncryptedPackage, testPassword);
  sessionSpy.getStoreRecords('medicines');
  sessionSpy.inspectSummary();
  sessionSpy.close();

  assert(
    spy.didAccess() === false,
    'Suite 5.1: Production Isolation Verified: Zero IndexedDB calls (open, deleteDatabase, databases, cmp) executed during sandbox operations'
  );

  spy.restore();

  // -------------------------------------------------------------------------
  // SUITE 6: Deterministic Deferred Barrier Race Condition & Cancellation Guard
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 6: Deterministic Deferred Barrier Race Condition Guard ---');

  const sessionRace = createRestoreSandbox('session_race_test');

  // Create a controlled async barrier inside verifyBackupChecksum
  let resolveBarrier!: () => void;
  const barrierPromise = new Promise<void>((r) => {
    resolveBarrier = r;
  });

  // Launch loadEncryptedBackup async (pauses deterministically inside verifyChecksumFn)
  const raceLoadPromise = sessionRace.loadEncryptedBackup(validEncryptedPackage, testPassword, {
    verifyChecksumFn: async (backup) => {
      await barrierPromise; // Deterministic pause in async execution!
      return backupFormat.verifyBackupChecksum(backup);
    },
  });

  // Immediately close session while decryption/verification is paused at barrier
  sessionRace.close();

  // Resolve barrier to resume loadEncryptedBackup execution
  resolveBarrier();

  await assertThrowsAsync(
    () => raceLoadPromise,
    'Suite 6.1: loadEncryptedBackup rejects cleanly when close() is invoked during async execution',
    'was closed or invalidated during operation'
  );

  assert(
    sessionRace.getStatus() === 'closed',
    'Suite 6.2: Session status remains strictly "closed" after cancelled operation'
  );

  assert(
    getRestoreSandboxSession('session_race_test') === undefined,
    'Suite 6.3: Cancelled session is NOT re-registered in active sandbox registry'
  );

  // -------------------------------------------------------------------------
  // SUITE 7: Manifest Integrity Validation
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 7: Manifest Integrity Validation ---');

  // 7.1 Duplicate storeName in schema manifest
  const duplicateSchemaPackage = await createSyntheticEncryptedBackup(
    {},
    {
      stores: [
        { storeName: 'medicines', recordCount: 2, payloadChecksum: 'a' },
        { storeName: 'medicines', recordCount: 2, payloadChecksum: 'b' },
      ],
    }
  );
  await assertThrowsAsync(
    () => session2.loadEncryptedBackup(duplicateSchemaPackage, testPassword),
    'Suite 7.1: Reject schema manifest containing duplicate storeNames',
    'Duplicate storeName \'medicines\' in schema manifest'
  );

  // 7.2 Record count mismatch
  const countMismatchPackage = await createSyntheticEncryptedBackup(
    {},
    {
      stores: [
        { storeName: 'medicines', recordCount: 99, payloadChecksum: '' }, // 99 != 2
      ],
    }
  );
  await assertThrowsAsync(
    () => session2.loadEncryptedBackup(countMismatchPackage, testPassword),
    'Suite 7.2: Reject backup where restored record count differs from manifest recordCount',
    'Record count mismatch for store \'medicines\''
  );

  // 7.3 Store payload checksum mismatch
  const payloadChecksumMismatchPkg = await createSyntheticEncryptedBackup(
    {},
    {
      stores: [
        { storeName: 'medicines', recordCount: 2, payloadChecksum: '0000000000000000000000000000000000000000000000000000000000000000' },
      ],
    }
  );
  await assertThrowsAsync(
    () => session2.loadEncryptedBackup(payloadChecksumMismatchPkg, testPassword),
    'Suite 7.3: Reject backup where store payloadChecksum does not match calculated SHA-256',
    'Payload checksum mismatch for store \'medicines\''
  );

  // -------------------------------------------------------------------------
  // SUITE 8: Atomic State Preservation on Failed Reload
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 8: Atomic State Preservation on Reload Failure ---');

  const sessionAtomic = createRestoreSandbox('session_atomic_test');
  await sessionAtomic.loadEncryptedBackup(validEncryptedPackage, testPassword);

  assert(
    sessionAtomic.getRecordCount() === 3 && sessionAtomic.getStatus() === 'loaded',
    'Suite 8.1: Session successfully loaded 3 initial records'
  );

  // Attempt reloading invalid package with tampered checksum
  const tamperedPackage = await createSyntheticEncryptedBackup({}, {}, undefined, true);
  try {
    await sessionAtomic.loadEncryptedBackup(tamperedPackage, testPassword);
  } catch {
    // Expected rejection
  }

  assert(
    sessionAtomic.getStatus() === 'loaded' && sessionAtomic.getRecordCount() === 3,
    'Suite 8.2: Failed reload attempt preserves previous valid loaded state without corruption'
  );

  const intactMeds = sessionAtomic.getStoreRecords('medicines');
  assert(
    Array.isArray(intactMeds) && intactMeds.length === 2 && intactMeds[0].id === 'MED-101',
    'Suite 8.3: Previous store records remain completely intact and accessible after reload failure'
  );

  // Test successful reload: old binary data references zeroed out, new data committed and intact
  const sessionReloadZeroing = createRestoreSandbox('session_reload_zeroing_test');
  
  // 1. Initial load with binary payload
  const initialBinaryRecord: any = {
    id: 'OLD-BIN-001',
    oldBuffer: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]).buffer,
    oldView: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]),
  };
  const initBinSerialized = serializeLossless([initialBinaryRecord]);
  const initBinChecksum = await backupFormat.computeSha256(backupFormat.canonicalJsonStringify(initBinSerialized));
  
  const initialBinaryPkg = await createSyntheticEncryptedBackup(
    {},
    { stores: [{ storeName: 'binary_store', recordCount: 1, payloadChecksum: initBinChecksum }] },
    { binary_store: initBinSerialized }
  );

  await sessionReloadZeroing.loadEncryptedBackup(initialBinaryPkg, testPassword);

  // Retain direct reference to old binary buffers via White-box test access
  const oldInternalMap = (sessionReloadZeroing as any).storesMap as Map<string, any[]>;
  const oldRecord = oldInternalMap.get('binary_store')![0];
  const oldBufRef = oldRecord.oldBuffer as ArrayBuffer;
  const oldU8Ref = oldRecord.oldView as Uint8Array;

  assert(
    oldU8Ref[0] === 0xaa && new Uint8Array(oldBufRef)[0] === 0xaa,
    'Suite 8.4: Old binary buffers contain valid data before successful reload'
  );

  // 2. Perform successful reload with new package
  const newMedicinesPkg = await createSyntheticEncryptedBackup();
  await sessionReloadZeroing.loadEncryptedBackup(newMedicinesPkg, testPassword);

  // 3. Verify old binary buffers are zeroed out completely
  assert(
    oldU8Ref[0] === 0 && oldU8Ref[1] === 0 && new Uint8Array(oldBufRef)[0] === 0,
    'Suite 8.5: Successful reload zeroes out old session binary ArrayBuffer and TypedArray references'
  );

  // 4. Verify new session data is loaded and intact
  const newRestoredMeds = sessionReloadZeroing.getStoreRecords('medicines');
  assert(
    sessionReloadZeroing.getStatus() === 'loaded' &&
      Array.isArray(newRestoredMeds) &&
      newRestoredMeds.length === 2 &&
      newRestoredMeds[0].id === 'MED-101',
    'Suite 8.6: New session data is successfully committed and accessible after reload'
  );

  sessionReloadZeroing.close();

  // -------------------------------------------------------------------------
  // SUITE 9: Binary Zeroing & Closure Operations Guard
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 9: Binary Zeroing & Closure Guard ---');

  sessionAtomic.close();

  assert(
    sessionAtomic.getStatus() === 'closed',
    'Suite 9.1: Session status set to "closed"'
  );

  assertThrowsSync(
    () => sessionAtomic.getStoreRecords('medicines'),
    'Suite 9.2: Reject getStoreRecords on closed session',
    'is closed or invalid'
  );

  await assertThrowsAsync(
    () => sessionAtomic.loadEncryptedBackup(validEncryptedPackage, testPassword),
    'Suite 9.3: Reject loadEncryptedBackup on closed session',
    'is closed or invalid'
  );

  // Verify closing session A does not affect session B or active count
  session1.close();
  session2.close();
  destroyAllRestoreSandboxes();

  assert(
    getActiveSandboxCount() === 0,
    'Suite 9.4: All active sandbox sessions purged successfully'
  );

  // -------------------------------------------------------------------------
  // SUITE 10: Passwordless loadBackupPackage Verification & Tamper Rejection
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 10: Passwordless loadBackupPackage Verification ---');

  const plainMeds = [{ id: 'MED-PLAIN-1', name: 'Insulin Lantus', stock: 12 }];
  const plainSerialized = serializeLossless(plainMeds);
  const plainStoreChecksum = await backupFormat.computeSha256(backupFormat.canonicalJsonStringify(plainSerialized));
  const plainUnsigned: Omit<backupFormat.KhalidPharmacyBackupV1, 'checksum'> = {
    header: {
      version: '1.0',
      appId: 'com.khalidpharmacy.app',
      format: 'KP_BACKUP_V1',
      createdAt: '2026-11-13T08:00:00.000Z',
      generator: 'Passwordless Sandbox Test',
    },
    schema: {
      dbVersion: 4,
      stores: [{ storeName: 'medicines', recordCount: 1, payloadChecksum: plainStoreChecksum }],
    },
    payload: { medicines: plainSerialized },
  };
  const validPlainBackup: backupFormat.KhalidPharmacyBackupV1 = {
    ...plainUnsigned,
    checksum: await backupFormat.computeBackupChecksum(plainUnsigned),
  };

  const sessionPlain = createRestoreSandbox('session_plain_test');
  const plainSummary = await sessionPlain.loadBackupPackage(validPlainBackup);
  assert(
    plainSummary.status === 'loaded' && plainSummary.totalRecords === 1,
    'Suite 10.1: Passwordless KP_BACKUP_V1 loads cleanly into isolated restore sandbox'
  );
  const plainRestoredMeds = sessionPlain.getStoreRecords('medicines');
  assert(
    plainRestoredMeds.length === 1 && plainRestoredMeds[0].name === 'Insulin Lantus',
    'Suite 10.2: Passwordless sandbox deserializes lossless records accurately'
  );
  sessionPlain.close();

  const tamperedPlainBackup: backupFormat.KhalidPharmacyBackupV1 = {
    ...validPlainBackup,
    checksum: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  };
  const sessionPlainTampered = createRestoreSandbox('session_plain_tampered');
  await assertThrowsAsync(
    () => sessionPlainTampered.loadBackupPackage(tamperedPlainBackup),
    'Suite 10.3: Passwordless loadBackupPackage rejects tampered backup checksum',
    'checksum verification failed'
  );
  sessionPlainTampered.close();

  // -------------------------------------------------------------------------
  // TEST SUMMARY
  // -------------------------------------------------------------------------
  console.log('\n======================================================================');
  console.log(`TOTAL TESTS EXECUTED : ${totalTests}`);
  console.log(`PASSED               : ${passedTests}`);
  console.log(`FAILED               : ${failedTests}`);
  console.log('======================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled Test Execution Error in Restore Sandbox Suite:', err);
  process.exit(1);
});
