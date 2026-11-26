/**
 * Phase R22-FINAL — Production-Safe First-Run Initialization Test Suite
 * Khalid Pharmacy ("com.khalidpharmacy.app")
 *
 * Verifies:
 * 1. Fresh production database initializes empty without demo records.
 * 2. Explicit Demo Mode inserts the intended demo dataset (only when gated).
 * 3. Repeated initialization is idempotent and does not duplicate records.
 * 4. Existing initialized database (`metadata.is_initialized = true`) retains all fields, stock, and ledger records unchanged.
 * 5. Pre-existing business records without `metadata.is_initialized` are preserved unchanged and never receive demo records.
 * 6. Explicit demo seeding (`{ seedDemo: true }`) on a non-empty database without `is_initialized` does not inject demo records.
 * 7. Genuine static/config checks across production entry, Vite build, Capacitor Android assets, and `pharmacyDb.ts`.
 */

import 'fake-indexeddb/auto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DB_NAME,
  initializeAndMigrate,
  openPharmacyDB,
  setActiveBranchContext,
  getAllMedicines,
  getAllSuppliers,
  getAllSales,
  getLedgerMovements,
  saveMedicine,
  createVerifiedMedicine,
  calculateMedicineStock,
  type Medicine
} from '../src/services/pharmacyDb';
import {
  __resetAuthStateForTests,
  __setAuthRuntimeForTests,
  resolvePharmacySession,
} from './helpers/authTestHarness';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

if (!(globalThis as any).localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}

async function establishTrustedAdminSession(branchId = 'khalid-1', branchName = 'صيدلية خالد 1'): Promise<void> {
  const uid = 'prod-init-admin';
  const mockUser: any = {
    uid,
    email: 'admin@khalid.local',
    displayName: 'Admin R22',
    emailVerified: true,
    getIdToken: async () => 'tok-prod-init',
    getIdTokenResult: async () => ({ token: 'tok-prod-init', claims: {} }),
  };
  await __resetAuthStateForTests();
  __setAuthRuntimeForTests({
    isOfflineFn: () => false,
    getServices: () => ({ auth: { currentUser: mockUser } as any, db: {} as any }),
    getDocFn: async () =>
      ({
        exists: () => true,
        data: () => ({
          uid,
          email: 'admin@khalid.local',
          displayName: 'Admin R22',
          role: 'super_admin',
          branchIds: [branchId],
          activeBranchId: branchId,
          active: true,
        }),
        metadata: { fromCache: false },
      }) as any,
  });
  await resolvePharmacySession(mockUser);
  setActiveBranchContext(branchId, branchName);
}

let testCount = 0;
let passedCount = 0;

function assert(condition: boolean, description: string) {
  testCount++;
  if (condition) {
    passedCount++;
    console.log(`  [PASS] Test ${testCount}: ${description}`);
  } else {
    console.error(`  [FAIL] Test ${testCount}: ${description}`);
    process.exitCode = 1;
  }
}

const trackedConnections = new Set<IDBDatabase>();
let idbTrackerInstalled = false;

function installIdbConnectionTracker() {
  if (idbTrackerInstalled) return;
  const originalOpen = indexedDB.open.bind(indexedDB);

  indexedDB.open = function patchedOpen(name: string, version?: number): IDBOpenDBRequest {
    const req = version !== undefined ? originalOpen(name, version) : originalOpen(name);
    req.addEventListener('success', () => {
      const db = req.result;
      if (db) {
        trackedConnections.add(db);
        db.addEventListener('close', () => {
          trackedConnections.delete(db);
        });
      }
    });
    return req;
  };

  idbTrackerInstalled = true;
}

async function closeAllTrackedConnections(): Promise<void> {
  // Reset cached dbInstance inside pharmacyDb cleanly via branch context switch
  try {
    setActiveBranchContext('__r22_isolation_reset__');
    try {
      setActiveBranchContext(null);
    } catch {
      setActiveBranchContext('khalid-1');
    }
  } catch {
    // ignore if branch context reset is unavailable
  }

  const connections = Array.from(trackedConnections);
  for (const conn of connections) {
    try {
      conn.close();
    } catch {
      // ignore already-closed connection errors
    }
    trackedConnections.delete(conn);
  }

  // Allow microtasks / close handlers to settle before deleteDatabase
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function deleteDatabaseStrict(dbName: string): Promise<void> {
  await closeAllTrackedConnections();

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName);
    let settled = false;

    req.onsuccess = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    req.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`IndexedDB deleteDatabase("${dbName}") was blocked by an active connection`));
    };

    req.onerror = () => {
      if (settled) return;
      settled = true;
      reject(req.error || new Error(`IndexedDB deleteDatabase("${dbName}") failed`));
    };
  });
}

async function resetAllPharmacyDatabases(): Promise<void> {
  await deleteDatabaseStrict('KhalidPharmacyDB');
  await deleteDatabaseStrict('KhalidPharmacyBankakDB');
}

async function readMetadataEntry(db: IDBDatabase, key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('metadata', 'readonly');
    const store = tx.objectStore('metadata');
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function runTests() {
  installIdbConnectionTracker();

  console.log('========================================================================');
  console.log('Phase R22-FINAL — Production-Safe First-Run Initialization Test Suite');
  console.log('========================================================================\n');

  // -----------------------------------------------------------------------
  // Scenario 1: Fresh Production Installation Initializes Empty DB
  // -----------------------------------------------------------------------
  console.log('--- Scenario 1: Fresh Production DB Initializes Empty ---');
  await resetAllPharmacyDatabases();
  await initializeAndMigrate(); // Default production init (no arguments)

  const medsProd = await getAllMedicines();
  const supsProd = await getAllSuppliers();
  const salesProd = await getAllSales();
  const ledgerProd = await getLedgerMovements();
  const dbScenario1 = await openPharmacyDB();
  const initMetaScenario1 = await readMetadataEntry(dbScenario1, 'is_initialized');

  assert(medsProd.length === 0, `Fresh production init has 0 demo medicines (found: ${medsProd.length})`);
  assert(supsProd.length === 0, `Fresh production init has 0 demo suppliers (found: ${supsProd.length})`);
  assert(salesProd.length === 0, `Fresh production init has 0 demo sales (found: ${salesProd.length})`);
  assert(ledgerProd.length === 0, `Fresh production init has 0 demo ledger movements (found: ${ledgerProd.length})`);
  assert(initMetaScenario1?.value === true, 'metadata.is_initialized is strictly set to true after fresh init');

  // -----------------------------------------------------------------------
  // Scenario 2: Explicit Demo Mode Seeds Demo Dataset (Only When Requested)
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 2: Explicit Demo Mode Seeding & Gate Verification ---');
  await resetAllPharmacyDatabases();

  const pharmacyDbPath = path.resolve(process.cwd(), 'src/services/pharmacyDb.ts');
  const pharmacyDbSrc = fs.readFileSync(pharmacyDbPath, 'utf8');
  const initFnMatch = pharmacyDbSrc.match(/export\s+async\s+function\s+initializeAndMigrate\s*\(([^)]*)\)/);
  const initSignatureParams = initFnMatch ? initFnMatch[1].trim() : '';
  const hasSeedDemoOption = /seedDemo/.test(initSignatureParams) || /seedDemo/.test(pharmacyDbSrc.slice(pharmacyDbSrc.indexOf('export async function initializeAndMigrate')));

  assert(hasSeedDemoOption, 'initializeAndMigrate() accepts and enforces an explicit seedDemo option in src/services/pharmacyDb.ts');

  const initWithOptions = initializeAndMigrate as unknown as (options?: { seedDemo?: boolean }) => Promise<void>;
  await initWithOptions({ seedDemo: true });

  const medsDemo = await getAllMedicines();
  const supsDemo = await getAllSuppliers();
  const salesDemo = await getAllSales();
  const ledgerDemo = await getLedgerMovements();

  assert(
    hasSeedDemoOption && medsDemo.length === 8 && supsDemo.length === 3 && salesDemo.length === 3 && ledgerDemo.length === 8,
    `Explicit Demo Mode ({ seedDemo: true }) seeds demo dataset under explicit gate (meds=${medsDemo.length}, sups=${supsDemo.length}, sales=${salesDemo.length}, ledger=${ledgerDemo.length})`
  );

  // -----------------------------------------------------------------------
  // Scenario 3: Repeated Initialization Does Not Duplicate Records
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 3: Repeated Initialization Idempotency ---');
  const beforeRepeatMeds = (await getAllMedicines()).length;
  const beforeRepeatSups = (await getAllSuppliers()).length;
  const beforeRepeatSales = (await getAllSales()).length;
  const beforeRepeatLedger = (await getLedgerMovements()).length;

  await initializeAndMigrate();
  await initWithOptions({ seedDemo: true });

  const afterRepeatMeds = (await getAllMedicines()).length;
  const afterRepeatSups = (await getAllSuppliers()).length;
  const afterRepeatSales = (await getAllSales()).length;
  const afterRepeatLedger = (await getLedgerMovements()).length;

  assert(
    afterRepeatMeds === beforeRepeatMeds &&
    afterRepeatSups === beforeRepeatSups &&
    afterRepeatSales === beforeRepeatSales &&
    afterRepeatLedger === beforeRepeatLedger,
    `Repeated initialization preserves exact record counts (meds=${afterRepeatMeds}, sups=${afterRepeatSups}, sales=${afterRepeatSales}, ledger=${afterRepeatLedger})`
  );

  // -----------------------------------------------------------------------
  // Scenario 4: Existing Initialized DB Retains Full Fields & Stock/Ledger
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 4: Existing Initialized DB Field & Ledger Preservation ---');
  await resetAllPharmacyDatabases();
  await establishTrustedAdminSession('khalid-1', 'صيدلية خالد 1');
  await initializeAndMigrate();

  const savedCustom = await createVerifiedMedicine(
    {
      name: 'Custom Pharmacy Product 500mg',
      barcode: '999000111222',
      category: 'Analgesics',
      minStock: 7,
      buyPrice: 1234,
      sellPrice: 2345,
      expiry: '2028-12-31',
      unitType: 'pack',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      batchNumber: 'CUST-991',
      initialStock: 12
    },
    {
      dosageForm: 'Tablet',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      sellPack: true
    }
  );

  const beforeStock = await calculateMedicineStock(savedCustom.id);
  const beforeLedger = await getLedgerMovements(savedCustom.id);

  assert(!!savedCustom.id && beforeStock.totalPills === 240 && beforeLedger.length === 1, 'Custom medicine and initial ledger movement created accurately (240 base pills)');

  await initializeAndMigrate();

  const medsAfterReinit = await getAllMedicines();
  const afterCustom = medsAfterReinit.find((m) => m.id === savedCustom.id) as Medicine | undefined;
  const afterStock = await calculateMedicineStock(savedCustom.id);
  const afterLedger = await getLedgerMovements(savedCustom.id);

  assert(
    !!afterCustom &&
    afterCustom.id === savedCustom.id &&
    afterCustom.name === savedCustom.name &&
    afterCustom.barcode === savedCustom.barcode &&
    afterCustom.buyPrice === savedCustom.buyPrice &&
    afterCustom.sellPrice === savedCustom.sellPrice &&
    afterCustom.expiry === savedCustom.expiry &&
    afterCustom.batchNumber === savedCustom.batchNumber &&
    afterStock.totalPills === beforeStock.totalPills &&
    afterLedger.length === beforeLedger.length &&
    afterLedger[0]?.id === beforeLedger[0]?.id &&
    afterLedger[0]?.baseUnitsDelta === beforeLedger[0]?.baseUnitsDelta,
    'Existing initialized DB retains exact medicine fields (id, name, barcode, buyPrice, sellPrice, expiry, batchNumber), stock, and ledger movements'
  );

  // -----------------------------------------------------------------------
  // Scenario 5: Legacy DB With Pre-Existing Records Without is_initialized
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 5: Legacy DB Without metadata.is_initialized (Strict IDB Isolation) ---');
  let isolationDeletedCleanly = false;
  try {
    await resetAllPharmacyDatabases();
    isolationDeletedCleanly = true;
  } catch (delErr) {
    console.error('Strict IndexedDB deletion failed:', delErr);
  }
  assert(isolationDeletedCleanly, 'Strict IndexedDB connection close & deleteDatabase.onsuccess completed without onblocked');

  const dbLegacy = await openPharmacyDB();
  const legacyMedInput = {
    id: 'pre-existing-legacy-1',
    name: 'Legacy Manual Medicine 750mg',
    barcode: '777888999000',
    category: 'General',
    minStock: 10,
    buyPrice: 540,
    sellPrice: 890,
    expiry: '2029-01-15',
    unitType: 'pack' as const,
    stripsPerPack: 2,
    pillsPerStrip: 10,
    batchNumber: 'LEGACY-R22-01',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
  const legacyMovInput = {
    id: 'legacy-mov-1',
    medicineId: 'pre-existing-legacy-1',
    batchNumber: 'LEGACY-R22-01',
    expiry: '2029-01-15',
    type: 'INITIAL' as const,
    unit: 'pack' as const,
    quantityDelta: 5,
    baseUnitsDelta: 100,
    costPerUnit: 540,
    costPerBaseUnit: 27,
    referenceId: 'LEGACY-OPEN-01',
    deviceId: 'dev-legacy',
    userId: 'admin-01',
    employeeName: 'Legacy Operator',
    notes: 'Pre-existing manual opening stock',
    timestamp: '2026-01-01T00:00:00.000Z',
    synced: 1 as const
  };

  await new Promise<void>((resolve, reject) => {
    const tx = dbLegacy.transaction(['medicines', 'inventory_ledger'], 'readwrite');
    tx.objectStore('medicines').put(legacyMedInput);
    tx.objectStore('inventory_ledger').put(legacyMovInput);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  const preInitMeta = await readMetadataEntry(dbLegacy, 'is_initialized');
  const preInitMeds = await getAllMedicines();
  const preInitLegacyMed = preInitMeds.find((m) => m.id === legacyMedInput.id);
  const preInitLegacyStock = await calculateMedicineStock(legacyMedInput.id);
  const preInitLegacyLedger = await getLedgerMovements(legacyMedInput.id);

  assert(
    preInitMeta === undefined &&
    !!preInitLegacyMed &&
    preInitLegacyStock.totalPills === 100 &&
    preInitLegacyLedger.length === 1,
    'Pre-existing legacy record and ledger movement verified in DB before initializeAndMigrate() with metadata.is_initialized absent'
  );

  await initializeAndMigrate();

  const postInitMeds = await getAllMedicines();
  const postInitSups = await getAllSuppliers();
  const postInitSales = await getAllSales();
  const postInitAllLedger = await getLedgerMovements();
  const postInitLegacyMed = postInitMeds.find((m) => m.id === legacyMedInput.id);
  const postInitLegacyStock = await calculateMedicineStock(legacyMedInput.id);
  const postInitLegacyLedger = await getLedgerMovements(legacyMedInput.id);

  assert(
    !!postInitLegacyMed &&
    postInitLegacyMed.id === legacyMedInput.id &&
    postInitLegacyMed.name === legacyMedInput.name &&
    postInitLegacyMed.barcode === legacyMedInput.barcode &&
    postInitLegacyMed.buyPrice === legacyMedInput.buyPrice &&
    postInitLegacyMed.sellPrice === legacyMedInput.sellPrice &&
    postInitLegacyMed.expiry === legacyMedInput.expiry &&
    postInitLegacyMed.batchNumber === legacyMedInput.batchNumber &&
    postInitLegacyStock.totalPills === 100 &&
    postInitLegacyLedger.length === 1 &&
    postInitLegacyLedger[0]?.id === 'legacy-mov-1' &&
    postInitLegacyLedger[0]?.baseUnitsDelta === 100,
    'Legacy pre-existing medicine fields, stock, and ledger movements remain completely unchanged after initializeAndMigrate()'
  );

  const injectedDemoMed = postInitMeds.find((m) => m.barcode === '6285001' || /^p[1-8]$/.test(m.id));
  const injectedDemoSup = postInitSups.find((s) => /^s[1-3]$/.test(s.id));
  const injectedDemoSale = postInitSales.find((s) => s.invoiceNumber === '1084' || s.invoiceNumber === '1083' || s.invoiceNumber === '1082');
  const injectedDemoLedger = postInitAllLedger.find((l) => l.referenceId === 'INIT-SETUP-2026');

  assert(
    !injectedDemoMed && !injectedDemoSup && !injectedDemoSale && !injectedDemoLedger,
    `No demo records are injected into a pre-existing DB missing metadata.is_initialized (totalMeds=${postInitMeds.length}, totalSups=${postInitSups.length}, totalSales=${postInitSales.length})`
  );

  // -----------------------------------------------------------------------
  // Scenario 6: Explicit { seedDemo: true } Requested on Non-Empty DB
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 6: Explicit Demo Seed Requested on Non-Empty DB ---');
  await resetAllPharmacyDatabases();
  const dbNonEmpty = await openPharmacyDB();
  await new Promise<void>((resolve, reject) => {
    const tx = dbNonEmpty.transaction(['medicines'], 'readwrite');
    tx.objectStore('medicines').put({
      id: 'non-empty-guard-1',
      name: 'Non-Empty Protected Medicine',
      barcode: '555444333222',
      category: 'Chronic',
      minStock: 4,
      buyPrice: 3100,
      sellPrice: 4200,
      expiry: '2029-06-30',
      unitType: 'pack',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      batchNumber: 'GUARD-01',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z'
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await initWithOptions({ seedDemo: true });
  const medsAfterDemoOnNonEmpty = await getAllMedicines();
  const supsAfterDemoOnNonEmpty = await getAllSuppliers();
  const salesAfterDemoOnNonEmpty = await getAllSales();
  const guardMedPreserved = medsAfterDemoOnNonEmpty.find((m) => m.id === 'non-empty-guard-1');
  const demoInjectedIntoNonEmpty = medsAfterDemoOnNonEmpty.find((m) => m.barcode === '6285001');

  assert(
    !!guardMedPreserved &&
    !demoInjectedIntoNonEmpty &&
    supsAfterDemoOnNonEmpty.length === 0 &&
    salesAfterDemoOnNonEmpty.length === 0,
    `Requesting { seedDemo: true } on a non-empty database without is_initialized refuses demo seeding and preserves existing records (meds=${medsAfterDemoOnNonEmpty.length})`
  );

  // -----------------------------------------------------------------------
  // Scenario 7: Unknown metadata-only state must be treated as existing data
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 7: Unknown Metadata-Only Legacy State ---');
  await resetAllPharmacyDatabases();
  const dbMetadataOnly = await openPharmacyDB();
  await new Promise<void>((resolve, reject) => {
    const tx = dbMetadataOnly.transaction(['metadata'], 'readwrite');
    tx.objectStore('metadata').put({ key: 'custom_categories', value: ['Chronic', 'Analgesics'] });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Metadata-only fixture transaction aborted'));
  });
  await initWithOptions({ seedDemo: true });
  const metadataOnlyMeds = await getAllMedicines();
  const customCategoriesAfterInit = await readMetadataEntry(await openPharmacyDB(), 'custom_categories');
  const metadataOnlyInit = await readMetadataEntry(await openPharmacyDB(), 'is_initialized');
  assert(
    metadataOnlyMeds.length === 0 &&
    Array.isArray(customCategoriesAfterInit?.value) &&
    customCategoriesAfterInit.value.length === 2 &&
    metadataOnlyInit?.value === true,
    'Unknown metadata-only legacy state is preserved and never receives demo medicines'
  );

  // -----------------------------------------------------------------------
  // Scenario 8: Secondary branch legacy data is censused before initialization
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 8: Secondary Branch Legacy Database Protection ---');
  await resetAllPharmacyDatabases();
  const secondaryBranchId = 'r22-secondary-legacy';
  setActiveBranchContext(secondaryBranchId, 'Secondary Legacy');
  const secondaryDb = await openPharmacyDB();
  await new Promise<void>((resolve, reject) => {
    const tx = secondaryDb.transaction(['medicines', 'inventory_ledger', 'sales', 'suppliers'], 'readwrite');
    tx.objectStore('medicines').put({
      id: 'secondary-legacy-med',
      name: 'Secondary Legacy Medicine',
      barcode: '666777888999',
      category: 'General',
      minStock: 3,
      buyPrice: 700,
      sellPrice: 1000,
      expiry: '2030-01-01',
      unitType: 'pack',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      batchNumber: 'SEC-LEGACY-01',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
    tx.objectStore('inventory_ledger').put({
      id: 'secondary-legacy-ledger',
      medicineId: 'secondary-legacy-med',
      batchNumber: 'SEC-LEGACY-01',
      type: 'INITIAL',
      unit: 'pack',
      quantityDelta: 2,
      baseUnitsDelta: 40,
      costPerUnit: 700,
      referenceId: 'SEC-LEGACY-OPEN',
      timestamp: '2026-01-01T00:00:00.000Z',
      synced: 1
    });
    tx.objectStore('sales').put({
      id: 'secondary-legacy-sale',
      invoiceNumber: 'SEC-LEGACY-SALE-01',
      items: [],
      total: 1000,
      timestamp: '2026-01-01T00:00:00.000Z'
    });
    tx.objectStore('suppliers').put({
      id: 'secondary-legacy-supplier',
      name: { ar: 'مورد قديم', en: 'Legacy Supplier' },
      balance: 500,
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Secondary legacy fixture transaction aborted'));
  });

  await initWithOptions({ seedDemo: true });
  const secondaryMeds = await getAllMedicines();
  const secondarySales = await getAllSales();
  const secondarySuppliers = await getAllSuppliers();
  const secondaryLedger = await getLedgerMovements();
  const secondaryMeta = await readMetadataEntry(await openPharmacyDB(), 'is_initialized');
  const secondaryBranchMeta = await readMetadataEntry(await openPharmacyDB(), 'branch_id');
  assert(
    secondaryMeds.length === 1 &&
    secondaryMeds[0]?.id === 'secondary-legacy-med' &&
    secondarySales.length === 1 &&
    secondarySuppliers.length === 1 &&
    secondaryLedger.length === 1 &&
    secondaryMeta?.value === true &&
    secondaryBranchMeta?.value === secondaryBranchId,
    'Secondary branch preserves legacy medicine, supplier, sale, and ledger without demo injection'
  );
  setActiveBranchContext('khalid-1');
  await deleteDatabaseStrict(`KhalidPharmacyDB__branch__${secondaryBranchId}`);

  // -----------------------------------------------------------------------
  // Scenario 9: Concurrent initialization is serialized and idempotent
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 9: Concurrent Demo Initialization Idempotency ---');
  await resetAllPharmacyDatabases();
  await Promise.all([
    initWithOptions({ seedDemo: true }),
    initWithOptions({ seedDemo: true })
  ]);
  const concurrentMeds = await getAllMedicines();
  const concurrentSuppliers = await getAllSuppliers();
  const concurrentSales = await getAllSales();
  const concurrentLedger = await getLedgerMovements();
  assert(
    concurrentMeds.length === 8 &&
    concurrentSuppliers.length === 3 &&
    concurrentSales.length === 3 &&
    concurrentLedger.length === 8,
    `Concurrent initialization seeds exactly one demo dataset (meds=${concurrentMeds.length}, suppliers=${concurrentSuppliers.length}, sales=${concurrentSales.length}, ledger=${concurrentLedger.length})`
  );

  // -----------------------------------------------------------------------
  // Scenario 10: Census read failure must fail closed without is_initialized
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 10: Census Read Failure Fails Closed ---');
  await resetAllPharmacyDatabases();
  const originalCount = IDBObjectStore.prototype.count;
  let injectedCensusFailure = false;
  let censusFailureRejected = false;
  IDBObjectStore.prototype.count = function (this: IDBObjectStore) {
    if (!injectedCensusFailure && this.name === 'medicines' && this.transaction.mode === 'readonly') {
      injectedCensusFailure = true;
      throw new Error('SYNTHETIC_CENSUS_READ_FAILURE');
    }
    return originalCount.call(this);
  };
  try {
    await initializeAndMigrate();
  } catch (error) {
    censusFailureRejected = error instanceof Error && /SYNTHETIC_CENSUS_READ_FAILURE/.test(error.message);
  } finally {
    IDBObjectStore.prototype.count = originalCount;
  }
  const dbAfterCensusFailure = await openPharmacyDB();
  const initAfterCensusFailure = await readMetadataEntry(dbAfterCensusFailure, 'is_initialized');
  assert(
    injectedCensusFailure &&
    censusFailureRejected &&
    initAfterCensusFailure === undefined,
    'Census read failure rejects initialization and never writes metadata.is_initialized'
  );

  // -----------------------------------------------------------------------
  // Scenario 11: Census transaction abort must fail closed
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 11: Census Transaction Abort Fails Closed ---');
  await resetAllPharmacyDatabases();
  const originalCountForAbort = IDBObjectStore.prototype.count;
  let injectedCensusAbort = false;
  let censusAbortRejected = false;
  IDBObjectStore.prototype.count = function (this: IDBObjectStore) {
    const request = originalCountForAbort.call(this);
    if (!injectedCensusAbort && this.name === 'medicines' && this.transaction.mode === 'readonly') {
      injectedCensusAbort = true;
      const transaction = this.transaction;
      queueMicrotask(() => {
        try { transaction.abort(); } catch { /* already inactive */ }
      });
    }
    return request;
  };
  try {
    await initializeAndMigrate();
  } catch {
    censusAbortRejected = true;
  } finally {
    IDBObjectStore.prototype.count = originalCountForAbort;
  }
  const dbAfterCensusAbort = await openPharmacyDB();
  const initAfterCensusAbort = await readMetadataEntry(dbAfterCensusAbort, 'is_initialized');
  assert(
    injectedCensusAbort &&
    censusAbortRejected &&
    initAfterCensusAbort === undefined,
    'Census transaction abort rejects initialization and never writes metadata.is_initialized'
  );

  // -----------------------------------------------------------------------
  // Scenario 12: Unexpected extra existing IndexedDB store blocks demo seeding
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 12: Extra Existing IndexedDB Store Blocks Demo Seeding ---');
  await resetAllPharmacyDatabases();
  const probeDbForVersion = await openPharmacyDB();
  const legacyPreUpgradeVersion = Math.max(1, probeDbForVersion.version - 1);
  probeDbForVersion.close();
  await resetAllPharmacyDatabases();
  const dbWithExtraStore = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, legacyPreUpgradeVersion);
    req.onupgradeneeded = () => {
      const upgradeDb = req.result;
      if (!upgradeDb.objectStoreNames.contains('custom_legacy_archive')) {
        upgradeDb.createObjectStore('custom_legacy_archive', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to create extra legacy object store'));
  });
  await new Promise<void>((resolve, reject) => {
    const tx = dbWithExtraStore.transaction(['custom_legacy_archive'], 'readwrite');
    tx.objectStore('custom_legacy_archive').put({ id: 'extra-rec-1', payload: 'preserved' });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to seed extra legacy store'));
    tx.onabort = () => reject(tx.error || new Error('Extra legacy store tx aborted'));
  });
  dbWithExtraStore.close();

  await initWithOptions({ seedDemo: true });
  const medsAfterExtraStore = await getAllMedicines();
  const dbAfterExtraInit = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const extraStoreRecord = await new Promise<any>((resolve, reject) => {
    const tx = dbAfterExtraInit.transaction(['custom_legacy_archive'], 'readonly');
    const req = tx.objectStore('custom_legacy_archive').get('extra-rec-1');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const initMetaAfterExtra = await readMetadataEntry(dbAfterExtraInit, 'is_initialized');
  dbAfterExtraInit.close();
  assert(
    medsAfterExtraStore.length === 0 &&
    extraStoreRecord?.payload === 'preserved' &&
    initMetaAfterExtra?.value === true,
    'Extra existing IndexedDB object store is censused, blocks demo seeding, and preserves its records'
  );

  // -----------------------------------------------------------------------
  // Scenario 13: Missing required census store fails closed
  // -----------------------------------------------------------------------
  console.log('\n--- Scenario 13: Missing Required Census Store Fails Closed ---');
  await resetAllPharmacyDatabases();
  const probeDbForMissing = await openPharmacyDB();
  const currentVersionForMissing = probeDbForMissing.version;
  const requiredStoresMinusOne = Array.from(probeDbForMissing.objectStoreNames).filter(
    (name) => name !== 'purchase_invoices'
  );
  probeDbForMissing.close();
  await resetAllPharmacyDatabases();
  const dbMissingStore = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, currentVersionForMissing);
    req.onupgradeneeded = () => {
      const upgradeDb = req.result;
      for (const storeName of requiredStoresMinusOne) {
        if (!upgradeDb.objectStoreNames.contains(storeName)) {
          upgradeDb.createObjectStore(
            storeName,
            storeName === 'metadata' ? { keyPath: 'key' } : { keyPath: 'id' }
          );
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to create missing-store fixture DB'));
  });
  dbMissingStore.close();

  let missingStoreRejected = false;
  try {
    await initializeAndMigrate();
  } catch (error) {
    missingStoreRejected =
      error instanceof Error && /INITIALIZATION_CENSUS_STORES_MISSING:purchase_invoices/.test(error.message);
  }
  const dbAfterMissingStore = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const initAfterMissingStore = await readMetadataEntry(dbAfterMissingStore, 'is_initialized');
  dbAfterMissingStore.close();
  assert(
    missingStoreRejected && initAfterMissingStore === undefined,
    'Missing required census store fails closed with INITIALIZATION_CENSUS_STORES_MISSING without writing is_initialized'
  );

  // -----------------------------------------------------------------------
  // Scenarios A – E Explicit Security Gate Verification Suite
  // -----------------------------------------------------------------------
  console.log('\n--- Scenarios A – E Explicit Security Gate Verification Suite ---');

  // Scenario A: Development/Test environment + empty DB + seedDemo omitted
  await resetAllPharmacyDatabases();
  await initWithOptions();
  const medsA = await getAllMedicines();
  const dbA = await openPharmacyDB();
  const metaA = await readMetadataEntry(dbA, 'is_initialized');
  assert(medsA.length === 0 && metaA?.value === true, 'Scenario A: Dev/Test + empty DB + seedDemo omitted succeeds with zero demo records');

  // Scenario B: Authorized non-production Demo/Test + empty DB + seedDemo: true
  await resetAllPharmacyDatabases();
  await initWithOptions({ seedDemo: true });
  const medsB = await getAllMedicines();
  const supsB = await getAllSuppliers();
  const salesB = await getAllSales();
  const ledgerB = await getLedgerMovements();
  assert(medsB.length === 8 && supsB.length === 3 && salesB.length === 3 && ledgerB.length === 8, 'Scenario B: Dev/Test + empty DB + seedDemo: true successfully seeds demo dataset');

  // Scenarios C – E: Execute the ACTUAL Vite-compiled production bundle in an isolated
  // Node ESM process with TEST_FORCE_PROD removed, NODE_ENV=development, no import.meta mocks,
  // and full IndexedDB open/transaction/write instrumentation.
  const rootDir = process.cwd();
  const distDir = path.join(rootDir, 'dist');
  const distHtmlPath = path.join(distDir, 'index.html');
  const pharmacyDbStat = fs.statSync(pharmacyDbPath);
  const distIsFresh =
    fs.existsSync(distHtmlPath) &&
    fs.statSync(distHtmlPath).mtimeMs >= pharmacyDbStat.mtimeMs;

  let bundleDir = distDir;
  let tempBuildDir: string | null = null;
  if (!distIsFresh) {
    tempBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khalid-prod-bundle-'));
    bundleDir = tempBuildDir;
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
    delete cleanEnv.TEST_FORCE_PROD;
    const viteBin = path.join(rootDir, 'node_modules/vite/bin/vite.js');
    execFileSync(process.execPath, [viteBin, 'build', '--outDir', tempBuildDir, '--emptyOutDir'], {
      cwd: rootDir,
      env: cleanEnv,
      stdio: 'pipe',
    });
  }

  let prodBundleResults: {
    scenarioC: { medsCount: number; isInitialized: boolean };
    scenarioD: { rejected: boolean; openCount: number; txCount: number; putCount: number; addCount: number; medsCount: number; isInitialized: unknown };
    scenarioE: { rejected: boolean; openCount: number; txCount: number; putCount: number; addCount: number; medsCount: number; soleId: string | null };
  };

  try {
    const bundleHtml = fs.readFileSync(path.join(bundleDir, 'index.html'), 'utf8');
    const entryMatch = bundleHtml.match(/assets\/(index-[^"]+\.js)/);
    if (!entryMatch) {
      throw new Error(`Could not locate production entry chunk in ${path.join(bundleDir, 'index.html')}`);
    }
    const entryFileUrl = pathToFileURL(path.join(bundleDir, 'assets', entryMatch[1])).href;

    const probeScript = `
      import 'fake-indexeddb/auto';
      delete process.env.TEST_FORCE_PROD;
      process.env.NODE_ENV = 'development';

      const metrics = { open: 0, tx: 0, put: 0, add: 0 };
      const origOpen = indexedDB.open.bind(indexedDB);
      indexedDB.open = function(name, version) {
        metrics.open++;
        return version !== undefined ? origOpen(name, version) : origOpen(name);
      };
      const origTx = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(...args) {
        metrics.tx++;
        return origTx.apply(this, args);
      };
      const origPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        metrics.put++;
        return origPut.apply(this, args);
      };
      const origAdd = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function(...args) {
        metrics.add++;
        return origAdd.apply(this, args);
      };

      const storage = new Map();
      const noop = () => {};
      const fakeEl = () => ({ style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop, removeEventListener: noop, classList: { add: noop, remove: noop } });
      globalThis.window = globalThis;
      globalThis.self = globalThis;
      globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
      globalThis.Element = class {};
      globalThis.HTMLElement = class {};
      globalThis.SVGElement = class {};
      globalThis.Node = class {};
      globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', hash: '' };
      if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
      if (!globalThis.navigator.locks) {
        Object.defineProperty(globalThis.navigator, 'locks', {
          configurable: true,
          value: { request: (_name, _options, callback) => Promise.resolve().then(callback) }
        });
      }
      globalThis.localStorage = {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k),
        clear: () => storage.clear()
      };
      globalThis.document = {
        readyState: 'loading',
        head: fakeEl(),
        body: fakeEl(),
        documentElement: fakeEl(),
        createElement: fakeEl,
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: noop,
        removeEventListener: noop
      };
      globalThis.addEventListener = noop;
      globalThis.removeEventListener = noop;

      await import(${JSON.stringify(entryFileUrl)});
      const PharmacyDB = globalThis.window.PharmacyDB;

      async function deleteDb(name) {
        try {
          PharmacyDB.setActiveBranchContext('__probe_reset__');
          PharmacyDB.setActiveBranchContext(null);
        } catch {}
        await new Promise((resolve, reject) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error('deleteDatabase blocked: ' + name));
        });
      }
      async function resetDbs() {
        await deleteDb('KhalidPharmacyDB');
        await deleteDb('KhalidPharmacyBankakDB');
      }
      async function openDb(name) {
        return await new Promise((resolve, reject) => {
          const req = indexedDB.open(name);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      async function readInitMeta(db) {
        return new Promise((resolve, reject) => {
          const tx = db.transaction('metadata', 'readonly');
          const req = tx.objectStore('metadata').get('is_initialized');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }

      // Scenario C
      await resetDbs();
      await PharmacyDB.initializeAndMigrate();
      const medsC = await PharmacyDB.getAllMedicinesWithLiveStock();
      const dbC = await openDb('KhalidPharmacyDB');
      const metaC = await readInitMeta(dbC);
      dbC.close();

      // Scenario D
      await resetDbs();
      metrics.open = 0; metrics.tx = 0; metrics.put = 0; metrics.add = 0;
      let rejectedD = false;
      try {
        await PharmacyDB.initializeAndMigrate({ seedDemo: true });
      } catch (err) {
        if (/SECURITY_VIOLATION/.test(err?.message)) rejectedD = true;
      }
      const dOpen = metrics.open, dTx = metrics.tx, dPut = metrics.put, dAdd = metrics.add;
      const medsD = await PharmacyDB.getAllMedicinesWithLiveStock();
      const dbD = await openDb('KhalidPharmacyDB');
      const metaD = await readInitMeta(dbD);
      dbD.close();

      // Scenario E
      await resetDbs();
      // Create the real schema through the application initializer before seeding
      // the fixture; opening a deleted database without a version creates no stores.
      await PharmacyDB.initializeAndMigrate();
      const dbE = await openDb('KhalidPharmacyDB');
      await new Promise((resolve, reject) => {
        const tx = dbE.transaction(['medicines', 'metadata'], 'readwrite');
        tx.objectStore('metadata').delete('is_initialized');
        tx.objectStore('medicines').put({
          id: 'prod-nonempty-1',
          name: 'Existing Prod Med',
          barcode: '111222333444',
          category: 'General',
          minStock: 5,
          buyPrice: 1000,
          sellPrice: 2000,
          expiry: '2030-01-01',
          unitType: 'pack',
          stripsPerPack: 2,
          pillsPerStrip: 10,
          batchNumber: 'PROD-01',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      dbE.close();
      metrics.open = 0; metrics.tx = 0; metrics.put = 0; metrics.add = 0;
      let rejectedE = false;
      try {
        await PharmacyDB.initializeAndMigrate({ seedDemo: true });
      } catch (err) {
        if (/SECURITY_VIOLATION/.test(err?.message)) rejectedE = true;
      }
      const eOpen = metrics.open, eTx = metrics.tx, ePut = metrics.put, eAdd = metrics.add;
      const medsE = await PharmacyDB.getAllMedicinesWithLiveStock();

      console.log('__PROBE_JSON__' + JSON.stringify({
        scenarioC: { medsCount: medsC.length, isInitialized: metaC?.value === true },
        scenarioD: { rejected: rejectedD, openCount: dOpen, txCount: dTx, putCount: dPut, addCount: dAdd, medsCount: medsD.length, isInitialized: metaD },
        scenarioE: { rejected: rejectedE, openCount: eOpen, txCount: eTx, putCount: ePut, addCount: eAdd, medsCount: medsE.length, soleId: medsE[0]?.id ?? null }
      }));
    `;

    const probeEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' };
    delete probeEnv.TEST_FORCE_PROD;
    const rawOut = execFileSync(process.execPath, ['--input-type=module', '-e', probeScript], {
      cwd: rootDir,
      env: probeEnv,
      encoding: 'utf8',
    });
    const jsonLine = rawOut.split('\n').find((line) => line.startsWith('__PROBE_JSON__'));
    if (!jsonLine) {
      throw new Error(`Missing probe output from compiled bundle test:\n${rawOut}`);
    }
    prodBundleResults = JSON.parse(jsonLine.slice('__PROBE_JSON__'.length));
  } finally {
    if (tempBuildDir) {
      fs.rmSync(tempBuildDir, { recursive: true, force: true });
    }
  }

  // Scenario C: Production build + empty DB + seedDemo omitted
  assert(
    prodBundleResults.scenarioC.medsCount === 0 && prodBundleResults.scenarioC.isInitialized === true,
    'Scenario C: Production build + empty DB + seedDemo omitted succeeds with zero demo records'
  );

  // Scenario D: Production build + empty DB + seedDemo: true (CRITICAL SECURITY REGRESSION TEST)
  assert(
    prodBundleResults.scenarioD.rejected &&
    prodBundleResults.scenarioD.openCount === 0 &&
    prodBundleResults.scenarioD.txCount === 0 &&
    prodBundleResults.scenarioD.putCount === 0 &&
    prodBundleResults.scenarioD.addCount === 0 &&
    prodBundleResults.scenarioD.medsCount === 0 &&
    prodBundleResults.scenarioD.isInitialized === undefined,
    'Scenario D: Production build + empty DB + seedDemo: true explicitly rejects request before any IndexedDB open/tx/write and leaves zero partial metadata'
  );

  // Scenario E: Production build + non-empty DB + seedDemo: true
  assert(
    prodBundleResults.scenarioE.rejected &&
    prodBundleResults.scenarioE.openCount === 0 &&
    prodBundleResults.scenarioE.txCount === 0 &&
    prodBundleResults.scenarioE.putCount === 0 &&
    prodBundleResults.scenarioE.addCount === 0 &&
    prodBundleResults.scenarioE.medsCount === 1 &&
    prodBundleResults.scenarioE.soleId === 'prod-nonempty-1',
    'Scenario E: Production build + non-empty DB + seedDemo: true rejects request before any IndexedDB open/tx/write and preserves all existing operational records unchanged'
  );

  // -----------------------------------------------------------------------
  // Real Static & Build Configuration Safety Verification (No Placeholders)
  // -----------------------------------------------------------------------
  console.log('\n--- Production & Android Build Configuration Integrity Checks ---');
  const indexHtmlSrc = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const viteConfigSrc = fs.readFileSync(path.join(rootDir, 'vite.config.ts'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const capacitorConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'capacitor.config.json'), 'utf8'));
  const androidCapacitorConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'android/app/src/main/assets/capacitor.config.json'), 'utf8'));
  const androidBuildGradleSrc = fs.readFileSync(path.join(rootDir, 'android/app/build.gradle'), 'utf8');
  const androidIndexHtmlSrc = fs.readFileSync(path.join(rootDir, 'android/app/src/main/assets/public/index.html'), 'utf8');

  const webCalls = indexHtmlSrc.match(/initializeAndMigrate\s*\([^)]*\)/g) || [];
  const webCallsWithoutDemo = webCalls.length > 0 && webCalls.every((call) => /initializeAndMigrate\s*\(\s*\)/.test(call));
  assert(webCallsWithoutDemo, `Production index.html calls initializeAndMigrate() strictly without seedDemo args (${webCalls.join(', ')})`);

  const srcFilesSeedDemoHits: string[] = [];
  const scanDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (/initializeAndMigrate\s*\([^)]*seedDemo\s*:\s*true/.test(content)) {
          srcFilesSeedDemoHits.push(path.relative(rootDir, fullPath));
        }
      }
    }
  };
  scanDir(path.join(rootDir, 'src'));
  assert(srcFilesSeedDemoHits.length === 0, `No production source files under src/ pass { seedDemo: true } (hits: ${srcFilesSeedDemoHits.length})`);

  assert(
    !/seedDemo/.test(viteConfigSrc) && packageJson?.scripts?.build === 'vite build',
    'Vite build configuration (vite.config.ts & package.json build script) contains no automatic demo seeding flags'
  );

  const androidCalls = androidIndexHtmlSrc.match(/initializeAndMigrate\s*\([^)]*\)/g) || [];
  const androidCallsWithoutDemo = androidCalls.length > 0 && androidCalls.every((call) => /initializeAndMigrate\s*\(\s*\)/.test(call));
  assert(
    capacitorConfig.appId === 'com.khalidpharmacy.app' &&
    capacitorConfig.webDir === 'dist' &&
    androidCapacitorConfig.appId === 'com.khalidpharmacy.app' &&
    /applicationId\s+"com\.khalidpharmacy\.app"/.test(androidBuildGradleSrc) &&
    androidCallsWithoutDemo,
    'Android/Capacitor configuration (capacitor.config.json, build.gradle, bundled index.html) targets com.khalidpharmacy.app without passing seedDemo: true'
  );

  const androidAssetsDir = path.join(rootDir, 'android/app/src/main/assets/public/assets');
  const androidBundleHasSeedDemoGuard = fs
    .readdirSync(androidAssetsDir)
    .filter((f) => f.endsWith('.js'))
    .some((f) => {
      const bundle = fs.readFileSync(path.join(androidAssetsDir, f), 'utf8');
      return bundle.includes('initializeAndMigrate') && bundle.includes('seedDemo') && bundle.includes('SECURITY_VIOLATION');
    });
  assert(
    hasSeedDemoOption && !pharmacyDbSrc.includes('TEST_FORCE_PROD') && androidBundleHasSeedDemoGuard,
    'Both src/services/pharmacyDb.ts and bundled Android Capacitor JS enforce SECURITY_VIOLATION guard without TEST_FORCE_PROD'
  );

  console.log('\n========================================================================');
  console.log(`RESULTS: ${passedCount} / ${testCount} TESTS PASSED`);
  console.log('========================================================================\n');

  await resetAllPharmacyDatabases();

  if (passedCount !== testCount) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
