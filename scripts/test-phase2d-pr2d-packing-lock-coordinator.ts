import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import * as PharmacyDB from '../src/services/pharmacyDb.ts';
import {
  __setAuthRuntimeForTests,
  resolvePharmacySession,
} from './helpers/authTestHarness.ts';
import {
  applyStickyPackingLock,
  assertPackingMutationAllowed,
  evaluatePackingLockSnapshot,
  hasPackingDimensionChange,
} from '../src/services/packingLockCoordinator.ts';

class MemoryStorage {
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

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
});

async function establishTrustedAdminForPr2d(): Promise<void> {
  const mockUser: any = {
    uid: 'pr2d-admin-1',
    email: 'pr2d-admin@khalid.test',
    displayName: 'PR2D Admin',
    emailVerified: true,
    getIdToken: async () => 'tok-pr2d',
    getIdTokenResult: async () => ({ token: 'tok-pr2d', claims: {} }),
  };
  __setAuthRuntimeForTests({
    isOfflineFn: () => false,
    getServices: () => ({ auth: { currentUser: mockUser } as any, db: {} as any }),
    getDocFn: async () =>
      ({
        exists: () => true,
        data: () => ({
          uid: 'pr2d-admin-1',
          email: 'pr2d-admin@khalid.test',
          displayName: 'PR2D Admin',
          role: 'admin',
          branchIds: ['khalid-1', '__pr2d_test_reset__'],
          activeBranchId: 'khalid-1',
          active: true,
        }),
        metadata: { fromCache: false },
      }) as any,
  });
  await resolvePharmacySession(mockUser);
}

async function resetDatabase(): Promise<IDBDatabase> {
  await establishTrustedAdminForPr2d();
  PharmacyDB.setActiveBranchContext('__pr2d_test_reset__');
  PharmacyDB.setActiveBranchContext('khalid-1');
  const name = PharmacyDB.getActiveDbName();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('deleteDatabase failed'));
    request.onblocked = () => reject(new Error('deleteDatabase blocked'));
  });
  return PharmacyDB.openPharmacyDB();
}

async function putRecord(db: IDBDatabase, store: string, record: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([store], 'readwrite');
    tx.objectStore(store).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('put failed'));
    tx.onabort = () => reject(tx.error || new Error('put aborted'));
  });
}

let passed = 0;
async function testAsync(name: string, fn: () => Promise<void>) {
  await fn(); passed += 1; console.log('[PASS]', name);
}
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('[PASS]', name);
}

const clean = {
  firstInventoryMovement: false,
  historicalLedgerCount: 0,
  pendingV1SyncCount: 0,
  pendingV2SyncCount: 0,
  unresolvedBackupReview: false,
  openReconciliation: false,
  openStocktaking: false,
  unpostedOcrDraft: false,
  quarantineOrUnverified: false,
  permanentLock: false,
  evidenceAvailable: true,
};

test('clean evidence permits dimensional edits', () => {
  const result = evaluatePackingLockSnapshot(clean);
  assert.equal(result.locked, false);
  assert.equal(result.failClosed, false);
});

for (const [field, value] of [
  ['permanentLock', true],
  ['firstInventoryMovement', true],
  ['historicalLedgerCount', 1],
  ['pendingV1SyncCount', 1],
  ['pendingV2SyncCount', 1],
  ['unresolvedBackupReview', true],
  ['openReconciliation', true],
  ['openStocktaking', true],
  ['unpostedOcrDraft', true],
  ['quarantineOrUnverified', true],
] as const) {
  test(`locks when ${field} is present`, () => {
    const result = evaluatePackingLockSnapshot({ ...clean, [field]: value });
    assert.equal(result.locked, true);
    assert.equal(result.failClosed, false);
  });
}

test('missing evidence fails closed', () => {
  const result = evaluatePackingLockSnapshot({ ...clean, evidenceAvailable: false });
  assert.equal(result.locked, true);
  assert.equal(result.failClosed, true);
});

test('invalid evidence counts fail closed', () => {
  const result = evaluatePackingLockSnapshot({ ...clean, pendingV1SyncCount: -1 });
  assert.equal(result.locked, true);
  assert.equal(result.failClosed, true);
});

test('unknown reasons fail closed', () => {
  const result = evaluatePackingLockSnapshot({ ...clean, unknownReasons: ['STORE_READ_FAILED'] });
  assert.equal(result.locked, true);
  assert.equal(result.failClosed, true);
});

test('dimensional fields are compared structurally and deterministically', () => {
  assert.equal(hasPackingDimensionChange(
    { unitDefinition: { b: 2, a: 1 } },
    { unitDefinition: { a: 1, b: 2 } }
  ), false);
  assert.equal(hasPackingDimensionChange({ stripsPerPack: 2 }, { stripsPerPack: 3 }), true);
});

test('locked dimensional change is rejected', () => {
  const decision = evaluatePackingLockSnapshot({ ...clean, historicalLedgerCount: 1 });
  assert.throws(
    () => assertPackingMutationAllowed({ stripsPerPack: 2 }, { stripsPerPack: 3 }, decision),
    /PACKING_LOCKED/
  );
});

test('non-dimensional metadata edit remains allowed under lock', () => {
  const decision = evaluatePackingLockSnapshot({ ...clean, permanentLock: true });
  assert.doesNotThrow(
    () => assertPackingMutationAllowed({ stripsPerPack: 2 }, { stripsPerPack: 2 }, decision)
  );
});

test('sticky lock cannot be cleared by downstream patch', () => {
  const locked = applyStickyPackingLock({ packingLocked: false }, evaluatePackingLockSnapshot({ ...clean, firstInventoryMovement: true }));
  assert.equal(locked.packingLocked, true);
});


await (async () => {
  const db = await resetDatabase();
  const medicine = await PharmacyDB.saveMedicine({
    name: 'PR2D Test Medicine',
    category: 'Test',
    minStock: 1,
    buyPrice: 100,
    sellPrice: 120,
    expiry: '2028-12-31',
    unitType: 'pack',
    stripsPerPack: 2,
    pillsPerStrip: 10,
    batchNumber: 'PR2D-1',
    initialStock: 0,
  });
  const outbox = await new Promise<any[]>((resolve, reject) => {
    const tx = db.transaction(['outbox'], 'readonly');
    const req = tx.objectStore('outbox').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  for (const row of outbox) await putRecord(db, 'outbox', { ...row, status: 'synced' });
  await testAsync('saveMedicine allows packing edit only while evidence is clean', async () => {
    const updated = await PharmacyDB.saveMedicine({ id: medicine.id, stripsPerPack: 3 });
    assert.equal(updated.stripsPerPack, 3);
  });
  await testAsync('saveMedicine locks packing after initial stock movement', async () => {
    const stocked = await PharmacyDB.createVerifiedMedicine(
      {
        name: 'Stocked Test Medicine',
        category: 'Test',
        minStock: 1,
        buyPrice: 100,
        sellPrice: 120,
        expiry: '2028-12-31',
        unitType: 'pack',
        stripsPerPack: 2,
        pillsPerStrip: 10,
        batchNumber: 'PR2D-2',
        initialStock: 1,
      },
      {
        dosageForm: 'Tablet',
        stripsPerPack: 2,
        pillsPerStrip: 10,
        sellPack: true,
      }
    );
    assert.equal(stocked.packingLocked, true);
    await assert.rejects(
      () => PharmacyDB.saveMedicine({ id: stocked.id, stripsPerPack: 3 }),
      /PACKING_LOCKED/
    );
  });
})();

console.log(`PR-2D coordinator tests: ${passed}/${passed} passed`);
