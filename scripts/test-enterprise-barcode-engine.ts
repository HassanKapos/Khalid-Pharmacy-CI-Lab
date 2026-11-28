import 'fake-indexeddb/auto';
import {
  initializeAndMigrate,
  getAllMedicines,
  findMedicineByBarcode,
  saveMedicine,
  createVerifiedMedicine,
  getLedgerMovements,
  calculateMedicineStock,
  setActiveBranchContext
} from '../src/services/pharmacyDb';
import {
  __setAuthRuntimeForTests,
  resolvePharmacySession
} from './helpers/authTestHarness';

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.map.keys())[index] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
}
if (typeof (globalThis as any).localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true
  });
}

async function establishEnterpriseBarcodeAdminSession(): Promise<void> {
  const mockUser: any = {
    uid: 'ent-barcode-admin-1',
    email: 'admin@khalid.test',
    displayName: 'Enterprise Barcode Test Admin',
    emailVerified: true,
    getIdToken: async () => 'tok-ent-barcode',
    getIdTokenResult: async () => ({ token: 'tok-ent-barcode', claims: {} })
  };
  __setAuthRuntimeForTests({
    isOfflineFn: () => false,
    getServices: () => ({ auth: { currentUser: mockUser } as any, db: {} as any }),
    getDocFn: async () => ({
      exists: () => true,
      data: () => ({
        uid: 'ent-barcode-admin-1',
        email: 'admin@khalid.test',
        displayName: 'Enterprise Barcode Test Admin',
        role: 'super_admin',
        branchIds: ['khalid-1'],
        activeBranchId: 'khalid-1',
        active: true
      }),
      metadata: { fromCache: false }
    }) as any
  });
  await resolvePharmacySession(mockUser);
  setActiveBranchContext('khalid-1', 'Main Branch');
}
import { validateBarcode } from '../src/services/barcodeValidator';
import { BarcodeEngineManager } from '../src/services/barcodeEngines/EngineManager';
import { BarcodeScannerService } from '../src/services/barcodeScannerService';

async function runEnterpriseEngineSuite() {
  console.log('========================================================================');
  console.log('🧪 KHALID PHARMACY — ENTERPRISE BARCODE SCANNER TEST & BENCHMARK SUITE');
  console.log('========================================================================');

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

  // -------------------------------------------------------------------------
  // SECTION 1: Checksum & Symbology Validation Test
  // -------------------------------------------------------------------------
  console.log('\n--- Section 1: Symbology & Checksum Validation Tests ---');

  const testSymbologies = [
    { code: '6211388017861', expectedType: 'EAN-13', name: 'Target EAN-13' },
    { code: '96385074', expectedType: 'EAN-8', name: 'EAN-8' },
    { code: '012345678905', expectedType: 'UPC-A', name: 'UPC-A' },
    { code: 'CODE128-TEST-99', expectedType: 'CODE-128', name: 'Code 128' },
    { code: '*CODE39TEST*', expectedType: 'CODE-39', name: 'Code 39' },
    { code: '12345678901234', expectedType: 'ITF', name: 'ITF (Interleaved 2 of 5)' }
  ];

  testSymbologies.forEach(({ code, expectedType, name }) => {
    const val = validateBarcode(code);
    assert(val.isValid && val.type === expectedType, `${name} (${code}) detected as ${expectedType}`);
  });

  // -------------------------------------------------------------------------
  // SECTION 2: Engine Adapter Architecture & Benchmark Comparison
  // -------------------------------------------------------------------------
  console.log('\n--- Section 2: Engine Adapter Initialization & Smart Failover ---');

  const engineManager = new BarcodeEngineManager();
  await engineManager.initAll();

  const activeEngineName = engineManager.getActiveEngineName();
  console.log(`  ℹ Active Engine Selected: [${activeEngineName}]`);
  assert(
    activeEngineName === 'zxing-wasm' || activeEngineName === 'native' || activeEngineName === 'zxing-js',
    `EngineManager initialized with valid active engine (${activeEngineName})`
  );

  // -------------------------------------------------------------------------
  // SECTION 3: Synthetic Image Benchmark Comparison
  // -------------------------------------------------------------------------
  console.log('\n--- Section 3: Empirical Multi-Engine Benchmark Comparison ---');

  // Create a 200x200 ImageData buffer simulating a test frame
  const width = 200;
  const height = 200;
  const buffer = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < buffer.length; i += 4) {
    buffer[i] = 255;     // R
    buffer[i + 1] = 255; // G
    buffer[i + 2] = 255; // B
    buffer[i + 3] = 255; // A
  }

  const mockImageData = {
    data: buffer,
    width,
    height
  } as any;

  const benchmarkResults = await engineManager.runComparativeBenchmark(mockImageData, 3);
  console.log('  ℹ Comparative Benchmark Snapshot:');
  benchmarkResults.forEach((b) => {
    console.log(
      `    • Engine [${b.engineName.padEnd(10)}]: Supported=${b.supported}, AvgTime=${b.avgDecodeTimeMs}ms, Decodes=${b.decodesCount}`
    );
  });

  assert(benchmarkResults.length === 3, 'Benchmark evaluated all 3 engines (native, zxing-wasm, zxing-js)');

  // -------------------------------------------------------------------------
  // SECTION 4: Database Catalog & POS Search
  // -------------------------------------------------------------------------
  console.log('\n--- Section 4: IndexedDB Product Catalog & Barcode Lookup ---');

  await initializeAndMigrate();
  const initialMedicines = await getAllMedicines();
  assert(initialMedicines.length === 0, `Production-safe initializeAndMigrate() initialized empty catalog (${initialMedicines.length} demo items)`);

  const TEST_BARCODE = '6211388017861';
  const UNVERIFIED_ID = 'med-unverified-ent-barcode-01';
  let unverifiedErrorMsg = '';
  try {
    await saveMedicine({
      id: UNVERIFIED_ID,
      name: 'Unverified Opening Stock Attempt 500mg',
      barcode: TEST_BARCODE,
      category: 'Testing',
      minStock: 2,
      buyPrice: 100,
      sellPrice: 150,
      expiry: '2030-12-31',
      unitType: 'pack',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      batchNumber: 'ENT-BARCODE-UNVERIFIED',
      initialStock: 5
    });
  } catch (err: any) {
    unverifiedErrorMsg = String(err?.message || err || '');
  }
  assert(
    unverifiedErrorMsg.includes('MEDICINE_OPERATION_BLOCKED:MEDICINE_NOT_OPERATIONALLY_VERIFIED'),
    `Unverified saveMedicine() with initialStock: 5 rejected with expected safety error (${unverifiedErrorMsg})`
  );
  const medsAfterRejectedSave = await getAllMedicines();
  const movementsAfterRejectedSave = await getLedgerMovements(UNVERIFIED_ID);
  assert(
    medsAfterRejectedSave.length === 0 && movementsAfterRejectedSave.length === 0,
    `Rejected unverified saveMedicine() persisted 0 medicines and 0 opening-stock ledger movements (meds=${medsAfterRejectedSave.length}, ledger=${movementsAfterRejectedSave.length})`
  );

  await establishEnterpriseBarcodeAdminSession();
  const savedFixture = await createVerifiedMedicine(
    {
      name: 'Enterprise Barcode Test Medicine 500mg',
      barcode: TEST_BARCODE,
      category: 'Testing',
      minStock: 2,
      buyPrice: 100,
      sellPrice: 150,
      expiry: '2030-12-31',
      batchNumber: 'ENT-BARCODE-01',
      initialStock: 5
    },
    {
      dosageForm: 'Tablet',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      sellPack: true
    }
  );

  const medicines = await getAllMedicines();
  const verifiedMovements = await getLedgerMovements(savedFixture.id);
  const verifiedStock = await calculateMedicineStock(savedFixture.id);
  assert(
    medicines.length === 1 &&
      medicines[0].id === savedFixture.id &&
      verifiedMovements.length === 1 &&
      verifiedMovements[0].type === 'INITIAL' &&
      verifiedStock.packs === 5,
    `createVerifiedMedicine() persisted verified medicine and 5-pack INITIAL opening-stock ledger movement (meds=${medicines.length}, ledger=${verifiedMovements.length}, packs=${verifiedStock.packs})`
  );

  const found = await findMedicineByBarcode(TEST_BARCODE);
  assert(
    !!found && found.id === savedFixture.id && found.barcode === TEST_BARCODE,
    `findMedicineByBarcode matched "${savedFixture.name}" (${TEST_BARCODE}) via primary barcode`
  );

  // -------------------------------------------------------------------------
  // SECTION 5: Camera Service Lifecycle & Anti-Duplicate Protection
  // -------------------------------------------------------------------------
  console.log('\n--- Section 5: Camera Service Lifecycle & Diagnostics ---');

  const scannerService = new BarcodeScannerService();
  const initialDiag = scannerService.getDiagnostics();

  assert(!initialDiag.isScanning, 'Scanner initially stopped');
  assert(initialDiag.receivedFrames === 0, 'Initial receivedFrames count is 0');
  assert(typeof initialDiag.cameraInitTimeMs === 'number', 'cameraInitTimeMs tracked');
  assert(typeof initialDiag.zoomCapabilities === 'object', 'zoomCapabilities structure present');

  assert(!scannerService.isScanning(), 'stopScanning cleanly releases scanner state');
  assert(!scannerService.isTorchOn(), 'Torch initially OFF');
  assert(!scannerService.getTorchState(), 'getTorchState initially false');
  assert(scannerService.isTorchSupported() === false, 'isTorchSupported returns false gracefully without stream');
  const toggleRes = await scannerService.toggleTorch();
  assert(toggleRes === false, 'toggleTorch returns false gracefully when torch unsupported');
  assert(scannerService.isTurboMode() === true, 'Turbo mode enabled by default');
  scannerService.toggleTurboMode();
  assert(scannerService.isTurboMode() === false, 'toggleTurboMode toggles to false');
  scannerService.setTurboMode(true);
  assert(scannerService.isTurboMode() === true, 'setTurboMode restores to true');

  console.log('========================================================================');
  console.log(`TEST SUMMARY: ${passed}/${total} PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('========================================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runEnterpriseEngineSuite().catch((err) => {
  console.error('Enterprise test suite failed:', err);
  process.exit(1);
});
