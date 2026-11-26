/**
 * Phase 2D — Workstream D: Firebase Spark Direct Firestore Sync Suite (Bankak-Free)
 * Covers D1 (Medicine V2 DTO), D3 (Sale + Ledger syncState consistency),
 * D4 (Offline/Online recovery & retry queue persistence), D5 (Multi-device conflict policy),
 * and D6 (Zero-Cost Spark compliance audit).
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deleteApp, initializeApp } from 'firebase/app';
import firebaseCompat from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { getFirestore, terminate, Timestamp } from 'firebase/firestore';
import {
  areCanonicalTimestampsEqual,
  clearBranchSyncRetryQueue,
  detectLockedPackingViolations,
  detectMedicineSyncConflict,
  enumerateV1InFlightOperations,
  getPendingBranchSyncs,
  isCloudSaleReconciled,
  isV1EntitySyncInFlight,
  isValidFirestoreDbInstance,
  normalizeSalePayloadForFirestore,
  parseStrictPositiveSaleBaseUnits,
  parseStrictPositiveSaleQuantity,
  prepareMedicineFirestoreV2Payload,
  pushBranchMedicineV2ToFirestore,
  pushBranchSaleToFirestore,
  reconcileRemoteSaleExpectedLedgerIds,
  serializePackingLockedAt,
  SPARK_DIRECT_COMPLETE_MAX_DOC_ACCESS_BUDGET,
  SPARK_DIRECT_COMPLETE_MAX_LEDGERS,
  SPARK_LEDGER_VERIFICATION_SLICE_SIZE,
  validateExistingSaleLedgerMovement,
} from '../src/services/branchSyncService.ts';
import type { PharmacySession } from '../src/services/firebaseAuthService.ts';

let passed = 0;

async function runTest(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

// Setup deterministic in-memory localStorage for offline/restart retry queue verification
const storageMap = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    get length() {
      return storageMap.size;
    },
    key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, v),
    removeItem: (k: string) => storageMap.delete(k),
    clear: () => storageMap.clear(),
  },
});

const adminSession: PharmacySession = {
  uid: 'admin-spark-1',
  email: 'admin@khalid.test',
  displayName: 'Branch Admin',
  role: 'admin',
  branchIds: ['khalid-1'],
  activeBranchId: 'khalid-1',
  emailVerified: true,
};

const cashierSession: PharmacySession = {
  uid: 'cashier-spark-1',
  email: 'cashier@khalid.test',
  displayName: 'Branch Cashier',
  role: 'cashier',
  branchIds: ['khalid-1'],
  activeBranchId: 'khalid-1',
  emailVerified: true,
};

async function main() {
  // ===========================================================================
  // D1: MEDICINE V2 DTO — DIRECT_PACK & SOLID_TWO_LEVEL
  // ===========================================================================
  await runTest('D1-01: DIRECT_PACK V2 DTO emits verified unitDefinition and STRICTLY OMITS solid-only mirrors', () => {
    const res = prepareMedicineFirestoreV2Payload({
      id: 'med-syrup-v2',
      name: 'Amoxicillin Suspension 100ml',
      barcode: '628990001',
      category: 'Syrups',
      buyPrice: 700,
      sellPrice: 1100,
      dosageForm: 'Syrup',
      baseUnitLabel: 'bottle',
      baseUnitsPerPack: 1,
      sellPack: true,
      sellStrip: false,
      sellPill: false,
      configStatus: 'VERIFIED',
      unitOperationalAllowed: true,
      unitMigrationStatus: 'NATIVE_V2',
      packingLocked: false,
      syncVersion: 1,
      openingStockEvidence: {
        mode: 'POSITIVE',
        intendedInitialStock: 5,
        intendedBaseUnits: 5,
        initialLedgerMovementId: 'mov-init-syrup-v2',
      },
      unitDefinition: {
        mode: 'DIRECT_PACK',
        dosageForm: 'Syrup',
        baseUnitLabel: 'bottle',
        baseUnitsPerPack: 1,
        verificationState: 'VERIFIED',
      },
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.mode, 'DIRECT_PACK');
      assert.equal('stripsPerPack' in res.mutableFields, false, 'DIRECT_PACK must NOT have stripsPerPack');
      assert.equal('pillsPerStrip' in res.mutableFields, false, 'DIRECT_PACK must NOT have pillsPerStrip');
      assert.equal(res.mutableFields.sellStrip, false);
      assert.equal(res.mutableFields.sellPill, false);
      assert.equal(res.mutableFields.baseUnitsPerPack, 1);
      assert.equal(res.mutableFields.unitSchemaVersion, 2);
      assert.equal((res.mutableFields.unitDefinition as any).mode, 'DIRECT_PACK');
      assert.equal(res.openingStockEvidence?.mode, 'POSITIVE');
      assert.equal(res.openingStockEvidence?.initialLedgerMovementId, 'mov-init-syrup-v2');
    }
  });

  await runTest('D1-02: SOLID_TWO_LEVEL V2 DTO enforces exact mirror parity (strips * pills === baseUnitsPerPack)', () => {
    const res = prepareMedicineFirestoreV2Payload({
      id: 'med-tab-v2',
      name: 'Paracetamol 500mg',
      buyPrice: 300,
      sellPrice: 500,
      dosageForm: 'Tablet',
      baseUnitLabel: 'tablet',
      stripsPerPack: 3,
      pillsPerStrip: 10,
      baseUnitsPerPack: 30,
      sellPack: true,
      sellStrip: true,
      sellPill: true,
      configStatus: 'VERIFIED',
      unitOperationalAllowed: true,
      unitDefinition: {
        mode: 'SOLID_TWO_LEVEL',
        dosageForm: 'Tablet',
        baseUnitLabel: 'tablet',
        baseUnitsPerPack: 30,
        stripsPerPack: 3,
        pillsPerStrip: 10,
        verificationState: 'VERIFIED',
      },
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.mode, 'SOLID_TWO_LEVEL');
      assert.equal(res.mutableFields.stripsPerPack, 3);
      assert.equal(res.mutableFields.pillsPerStrip, 10);
      assert.equal(res.mutableFields.baseUnitsPerPack, 30);
    }
  });

  await runTest('D1-03: Rejects DIRECT_PACK with solid mirrors/sellStrip, SOLID parity mismatch, QUARANTINED, UNVERIFIED, Unknown dosageForm, and zero/unknown packing', () => {
    // DIRECT_PACK carrying stripsPerPack
    const badDp1 = prepareMedicineFirestoreV2Payload({
      id: 'bad-dp-1',
      name: 'Bad Syrup',
      stripsPerPack: 1,
      configStatus: 'VERIFIED',
      unitDefinition: { mode: 'DIRECT_PACK', dosageForm: 'Syrup', baseUnitLabel: 'bottle', baseUnitsPerPack: 1, verificationState: 'VERIFIED' },
    });
    assert.equal(badDp1.ok, false);
    if (!badDp1.ok) assert.equal(badDp1.reasonCode, 'MEDICINE_SYNC_REJECTED_INVALID_PACKING');

    // DIRECT_PACK enabling sellStrip
    const badDp2 = prepareMedicineFirestoreV2Payload({
      id: 'bad-dp-2',
      name: 'Bad Syrup 2',
      sellStrip: true,
      configStatus: 'VERIFIED',
      unitDefinition: { mode: 'DIRECT_PACK', dosageForm: 'Syrup', baseUnitLabel: 'bottle', baseUnitsPerPack: 1, verificationState: 'VERIFIED' },
    });
    assert.equal(badDp2.ok, false);

    // SOLID parity mismatch (3 * 10 != 25)
    const badSolid = prepareMedicineFirestoreV2Payload({
      id: 'bad-solid',
      name: 'Bad Tablet',
      stripsPerPack: 3,
      pillsPerStrip: 10,
      baseUnitsPerPack: 25,
      configStatus: 'VERIFIED',
    });
    assert.equal(badSolid.ok, false);
    if (!badSolid.ok) assert.equal(badSolid.reasonCode, 'MEDICINE_SYNC_REJECTED_INVALID_PACKING');

    // QUARANTINED & UNVERIFIED & UNKNOWN
    const quar = prepareMedicineFirestoreV2Payload({ id: 'q', name: 'Q', stripsPerPack: 2, pillsPerStrip: 10, unitMigrationStatus: 'QUARANTINED' });
    assert.equal(quar.ok, false);
    if (!quar.ok) assert.equal(quar.reasonCode, 'MEDICINE_SYNC_DEFERRED_QUARANTINED_PACKING');

    const unver = prepareMedicineFirestoreV2Payload({ id: 'u', name: 'U', stripsPerPack: 2, pillsPerStrip: 10, unitOperationalAllowed: false });
    assert.equal(unver.ok, false);
    if (!unver.ok) assert.equal(unver.reasonCode, 'MEDICINE_SYNC_DEFERRED_UNVERIFIED_PACKING');

    const unk = prepareMedicineFirestoreV2Payload({ id: 'x', name: 'X' });
    assert.equal(unk.ok, false);
    if (!unk.ok) assert.equal(unk.reasonCode, 'MEDICINE_SYNC_DEFERRED_UNKNOWN_PACKING');

    const unkForm = prepareMedicineFirestoreV2Payload({ id: 'uf', name: 'UF', dosageForm: 'Unknown', stripsPerPack: 2, pillsPerStrip: 10, configStatus: 'VERIFIED' });
    assert.equal(unkForm.ok, false);
  });

  // ===========================================================================
  // D3: SALE + LEDGER CONSISTENCY MODEL (syncState + expectedLedgerCount)
  // ===========================================================================
  await runTest('D3-01: Single-batch sale normalizes with syncState=complete; multi-batch sale normalizes with syncState=pending_ledger', () => {
    const single = normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
      id: 'sale-single-1',
      invoiceNumber: 'INV-S1',
      subtotal: 1500,
      discount: 0,
      total: 1500,
      paymentMethod: 'Cash',
      items: [{ medicineId: 'med-1', name: 'Med 1', qty: 1, unit: 'pack', subtotal: 1500, baseUnits: 10 }],
    });
    assert.equal(single.saleDoc.syncState, 'complete');
    assert.equal(single.saleDoc.expectedLedgerCount, 1);
    assert.ok(typeof single.saleDoc.syncOperationId === 'string' && single.saleDoc.syncOperationId.length > 0);
    assert.equal(isCloudSaleReconciled(single.saleDoc), true);

    // Multi-batch (> 450 FEFO movements across 50 items x 10 batch allocations = 500 movements)
    const manyItems = Array.from({ length: 50 }, (_, idx) => ({
      medicineId: `med-${idx % 5}`,
      name: `Med ${idx}`,
      qty: 10,
      unit: 'pack',
      subtotal: 100,
      batchAllocations: Array.from({ length: 10 }, (_, b) => ({
        batchNumber: `B-${idx}-${b}`,
        expiry: '2028-12-31',
        quantity: 1,
        unit: 'pack',
        baseUnits: 10,
        ledgerMovementId: `mov-m500-${idx}-${b}`,
        costPerBaseUnit: 5,
      })),
    }));
    const multi = normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
      id: 'sale-multi-500',
      invoiceNumber: 'INV-M500',
      subtotal: 5000,
      discount: 0,
      total: 5000,
      paymentMethod: 'Cash',
      items: manyItems,
    });
    assert.equal(multi.ledgerDocs.length, 500);
    assert.equal(multi.saleDoc.syncState, 'pending_ledger');
    assert.equal(multi.saleDoc.expectedLedgerCount, 500);
    assert.equal(multi.saleDoc.expectedLedgerIds.length, 500);
    assert.equal(multi.saleDoc.verifiedLedgerCount, 0);
    assert.equal(isCloudSaleReconciled(multi.saleDoc), false, 'pending_ledger sale MUST NOT report reconciled');
    assert.equal(
      isCloudSaleReconciled({ ...multi.saleDoc, syncState: 'complete', verifiedLedgerCount: 500 }),
      true
    );
    assert.equal(
      isCloudSaleReconciled({ ...multi.saleDoc, syncState: 'complete', verifiedLedgerCount: 499 }),
      false,
      'complete sale with verifiedLedgerCount < expectedLedgerCount MUST NOT report reconciled'
    );
    assert.equal(isCloudSaleReconciled({ id: 'legacy-sale' }), true, 'Legacy sales without syncState remain compatible');
  });

  await runTest('D1-04: Genuine openingStockEvidence rejects base-unit parity mismatch and malformed initialLedgerMovementId', () => {
    const badParity = prepareMedicineFirestoreV2Payload({
      id: 'med-ev-bad-parity',
      name: 'Amox',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      baseUnitsPerPack: 20,
      configStatus: 'VERIFIED',
      openingStockEvidence: {
        mode: 'POSITIVE',
        intendedInitialStock: 5,
        intendedBaseUnits: 99, // must be 5 * 20 = 100
        initialLedgerMovementId: 'mov-init-1',
      },
    });
    assert.equal(badParity.ok, false);

    const badMovId = prepareMedicineFirestoreV2Payload({
      id: 'med-ev-bad-id',
      name: 'Amox',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      baseUnitsPerPack: 20,
      configStatus: 'VERIFIED',
      openingStockEvidence: {
        mode: 'POSITIVE',
        intendedInitialStock: 5,
        intendedBaseUnits: 100,
        initialLedgerMovementId: 'bad/mov/id',
      },
    });
    assert.equal(badMovId.ok, false);
  });

  await runTest('D3-02 (H-43-2 cross-PR): 7 distinct medicines + 7 ledgers routes to pending_ledger with exact expectedLedgerIds & safe read budget', () => {
    assert.equal(SPARK_DIRECT_COMPLETE_MAX_LEDGERS, 6);
    assert.equal(SPARK_DIRECT_COMPLETE_MAX_DOC_ACCESS_BUDGET, 12);
    assert.equal(SPARK_LEDGER_VERIFICATION_SLICE_SIZE, 6);

    const sixItems = Array.from({ length: 6 }, (_, i) => ({
      medicineId: `med-d6-${i}`,
      name: `Med ${i}`,
      qty: 1,
      unit: 'pack',
      subtotal: 100,
      baseUnits: 10,
    }));
    const sixRes = normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
      id: 'sale-six-distinct',
      invoiceNumber: 'INV-SIX',
      subtotal: 600,
      discount: 0,
      total: 600,
      paymentMethod: 'Cash',
      items: sixItems,
    });
    assert.equal(sixRes.saleDoc.syncState, 'complete');
    assert.equal(sixRes.saleDoc.expectedLedgerCount, 6);
    assert.equal(sixRes.saleDoc.verifiedLedgerCount, 6);
    assert.deepEqual(sixRes.saleDoc.expectedLedgerIds, sixRes.ledgerDocs.map((m) => m.id));

    const sevenItems = Array.from({ length: 7 }, (_, i) => ({
      medicineId: `med-d7-${i}`,
      name: `Med ${i}`,
      qty: 1,
      unit: 'pack',
      subtotal: 100,
      baseUnits: 10,
    }));
    const sevenRes = normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
      id: 'sale-seven-distinct',
      invoiceNumber: 'INV-SEVEN',
      subtotal: 700,
      discount: 0,
      total: 700,
      paymentMethod: 'Cash',
      items: sevenItems,
    });
    assert.equal(sevenRes.saleDoc.syncState, 'pending_ledger', '7 distinct meds + 7 ledgers must route through pending_ledger for safe read headroom');
    assert.equal(sevenRes.saleDoc.expectedLedgerCount, 7);
    assert.equal(sevenRes.saleDoc.verifiedLedgerCount, 0);
    assert.deepEqual(sevenRes.saleDoc.expectedLedgerIds, sevenRes.ledgerDocs.map((m) => m.id));
  });

  await runTest('D3-03 (H-45-2): Strict pending-sale recovery reconciles remote expectedLedgerIds and validates EVERY existing movement field (rejects forged/corrupt docs)', () => {
    const norm = normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
      id: 'sale-rec-1',
      invoiceNumber: 'INV-REC-1',
      subtotal: 400,
      discount: 0,
      total: 400,
      paymentMethod: 'Cash',
      items: [
        {
          medicineId: 'med-rec-1',
          name: 'Med Rec',
          qty: 2,
          unit: 'pack',
          subtotal: 400,
          baseUnits: 40,
          batchNumber: 'B-100',
          expiry: '2028-05-01',
          costPerUnit: 120,
          costPerBaseUnit: 6,
        },
      ],
    });
    const expectedIds = norm.ledgerDocs.map((m) => m.id);
    const mov = norm.ledgerDocs[0];

    // 1. Valid remote expectedLedgerIds reconciliation
    const okRec = reconcileRemoteSaleExpectedLedgerIds({
      branchId: 'khalid-1',
      saleId: 'sale-rec-1',
      remoteSaleData: { ...norm.saleDoc, syncState: 'pending_ledger', verifiedLedgerCount: 0 },
      localExpectedLedgerIds: expectedIds,
    });
    assert.equal(okRec.ok, true);
    assert.equal(okRec.verifiedLedgerCount, 0);

    // 2. Mismatched / duplicate / unexpected remote expectedLedgerIds rejected
    const badMissing = reconcileRemoteSaleExpectedLedgerIds({
      branchId: 'khalid-1',
      saleId: 'sale-rec-1',
      remoteSaleData: { ...norm.saleDoc, expectedLedgerIds: ['mov-other'] },
      localExpectedLedgerIds: expectedIds,
    });
    assert.equal(badMissing.ok, false);

    const badDup = reconcileRemoteSaleExpectedLedgerIds({
      branchId: 'khalid-1',
      saleId: 'sale-rec-1',
      remoteSaleData: { ...norm.saleDoc, expectedLedgerCount: 2, expectedLedgerIds: [expectedIds[0], expectedIds[0]] },
      localExpectedLedgerIds: expectedIds,
    });
    assert.equal(badDup.ok, false);

    const badBranch = reconcileRemoteSaleExpectedLedgerIds({
      branchId: 'khalid-2',
      saleId: 'sale-rec-1',
      remoteSaleData: norm.saleDoc,
      localExpectedLedgerIds: expectedIds,
    });
    assert.equal(badBranch.ok, false);

    // 3. Valid existing movement passes full field check
    const validMovCheck = validateExistingSaleLedgerMovement({
      expectedId: mov.id,
      branchId: 'khalid-1',
      saleId: 'sale-rec-1',
      expectedData: mov.data,
      actualDoc: { ...mov.data },
    });
    assert.equal(validMovCheck.ok, true);

    // 4. Forged / corrupted existing movements MUST BE REJECTED (snap.exists() alone is insufficient)
    const corruptCases: Array<[string, Record<string, unknown>]> = [
      ['wrong branchId', { ...mov.data, branchId: 'khalid-2' }],
      ['wrong referenceId', { ...mov.data, referenceId: 'sale-other' }],
      ['wrong type', { ...mov.data, type: 'PURCHASE' }],
      ['wrong medicineId', { ...mov.data, medicineId: 'med-other' }],
      ['positive quantityDelta', { ...mov.data, quantityDelta: 2 }],
      ['positive baseUnitsDelta', { ...mov.data, baseUnitsDelta: 40 }],
      ['mismatched quantityDelta', { ...mov.data, quantityDelta: -1 }],
      ['mismatched baseUnitsDelta', { ...mov.data, baseUnitsDelta: -20 }],
      ['wrong userId', { ...mov.data, userId: 'attacker-uid' }],
      ['wrong batchNumber', { ...mov.data, batchNumber: 'B-FORGED' }],
      ['wrong costPerBaseUnit', { ...mov.data, costPerBaseUnit: 99 }],
    ];
    for (const [label, corruptDoc] of corruptCases) {
      const res = validateExistingSaleLedgerMovement({
        expectedId: mov.id,
        branchId: 'khalid-1',
        saleId: 'sale-rec-1',
        expectedData: mov.data,
        actualDoc: corruptDoc,
      });
      assert.equal(res.ok, false, `Expected corrupt existing movement (${label}) to be rejected`);
      assert.ok(res.mismatches.length > 0);
    }
  });

  // ===========================================================================
  // D4: OFFLINE / ONLINE RECOVERY & RETRY QUEUE PERSISTENCE
  // ===========================================================================
  await runTest('D4-01: Offline failure queues sale/medicine cleanly in persistent storage without losing payload across simulated restart', async () => {
    clearBranchSyncRetryQueue();
    const offlineApp = initializeApp(
      { apiKey: 'demo', projectId: 'demo-d4-offline' },
      'd4-offline-transport-app'
    );
    const offlineDb = getFirestore(offlineApp);
    await terminate(offlineDb);

    try {
      const failingResult = await pushBranchSaleToFirestore(
        cashierSession,
        'khalid-1',
        {
          id: 'sale-offline-recover-1',
          invoiceNumber: 'INV-OFF-1',
          subtotal: 2000,
          discount: 0,
          total: 2000,
          paymentMethod: 'Cash',
          items: [{ medicineId: 'med-1', name: 'Med 1', qty: 2, unit: 'pack', subtotal: 2000, baseUnits: 20 }],
        },
        { dbOverride: offlineDb }
      );
      assert.equal(failingResult.status, 'queued');

      // Verify retry queue persisted to localStorage (survives app restart)
      const pending = getPendingBranchSyncs(cashierSession.uid);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].entityId, 'sale-offline-recover-1');
      assert.equal(pending[0].payload.cashierUid, cashierSession.uid);

      // Re-pushing same offline sale deduplicates into the SAME queue key (zero duplicate queue entries)
      await pushBranchSaleToFirestore(
        cashierSession,
        'khalid-1',
        {
          id: 'sale-offline-recover-1',
          invoiceNumber: 'INV-OFF-1',
          subtotal: 2000,
          discount: 0,
          total: 2000,
          paymentMethod: 'Cash',
          items: [{ medicineId: 'med-1', name: 'Med 1', qty: 2, unit: 'pack', subtotal: 2000, baseUnits: 20 }],
        },
        { dbOverride: offlineDb }
      );
      assert.equal(getPendingBranchSyncs(cashierSession.uid).length, 1, 'Retry queue must deduplicate identical sale ID');

      // Deferred invalid medicine V2 does NOT pollute retry queue
      const deferredV2 = await pushBranchMedicineV2ToFirestore(
        adminSession,
        'khalid-1',
        {
          id: 'med-quar-no-queue',
          name: 'Quarantined',
          unitMigrationStatus: 'QUARANTINED',
        },
        { dbOverride: offlineDb }
      );
      assert.equal(deferredV2.status, 'deferred');
      assert.equal(getPendingBranchSyncs(adminSession.uid).length, 0);
    } finally {
      clearBranchSyncRetryQueue();
      await deleteApp(offlineApp);
    }
  });

  await runTest('D4-01_FAIL_CLOSED: Explicit dbOverride enforces strict conjunctive Firestore validation before leases, mutexes, retry queues, or network calls', async () => {
    clearBranchSyncRetryQueue();
    const modularApp = initializeApp(
      { apiKey: 'demo', projectId: 'demo-d4-valid-mod' },
      'd4-valid-modular-app'
    );
    const modularDb = getFirestore(modularApp);
    const compatApp = firebaseCompat.initializeApp(
      { apiKey: 'demo', projectId: 'demo-d4-valid-compat' },
      'd4-valid-compat-app'
    );
    const compatDb = compatApp.firestore();

    try {
      assert.equal(isValidFirestoreDbInstance(modularDb), true, 'Genuine modular Firestore must be accepted');
      assert.equal(isValidFirestoreDbInstance(compatDb), true, 'Genuine compat Firestore (_delegate) must be accepted');

      const invalidOverrides: Array<[string, unknown]> = [
        ['undefined', undefined],
        ['null', null],
        ['string', 'not-a-db'],
        ['number', 123],
        ['boolean true', true],
        ['array', []],
        ['Date', new Date()],
        ['empty object', {}],
        ['superficial { type: string }', { type: 'string' }],
        ['superficial { type: firestore }', { type: 'firestore' }],
        ['superficial { app: null }', { app: null }],
        ['superficial { _databaseId: {} }', { _databaseId: {} }],
        ['superficial { toJSON() {} }', { toJSON() {} }],
        [
          'spoofed non-instance Firestore-like object',
          {
            type: 'firestore',
            app: {},
            _databaseId: { projectId: 'spoof' },
            toJSON: () => ({ databaseId: { projectId: 'spoof' } }),
          },
        ],
        ['_delegate without app', { _delegate: modularDb }],
        ['_delegate with fake inner', { app: {}, _delegate: { type: 'string' } }],
        ['chained _delegate', { app: {}, _delegate: compatDb }],
      ];

      const validSalePayload = {
        id: 'sale-fail-closed-d4',
        invoiceNumber: 'INV-FC-1',
        subtotal: 500,
        discount: 0,
        total: 500,
        paymentMethod: 'Cash',
        items: [{ medicineId: 'med-1', name: 'Med 1', qty: 1, unit: 'pack', subtotal: 500, baseUnits: 10 }],
      };

      const validV2MedPayload = {
        id: 'med-fail-closed-d4',
        name: 'Amox',
        dosageForm: 'Syrup',
        baseUnitLabel: 'bottle',
        baseUnitsPerPack: 1,
        configStatus: 'VERIFIED',
        unitDefinition: { mode: 'DIRECT_PACK', dosageForm: 'Syrup', baseUnitLabel: 'bottle', baseUnitsPerPack: 1, verificationState: 'VERIFIED' },
      };

      for (const [label, badDb] of invalidOverrides) {
        assert.equal(isValidFirestoreDbInstance(badDb), false, `Expected isValidFirestoreDbInstance(${label}) === false`);

        await assert.rejects(
          () => pushBranchSaleToFirestore(cashierSession, 'khalid-1', validSalePayload, { dbOverride: badDb }),
          /SYNC_DB_OVERRIDE_REQUIRED/,
          `pushBranchSaleToFirestore must fail closed for dbOverride=${label}`
        );

        await assert.rejects(
          () => pushBranchMedicineV2ToFirestore(adminSession, 'khalid-1', validV2MedPayload, { dbOverride: badDb }),
          /SYNC_DB_OVERRIDE_REQUIRED/,
          `pushBranchMedicineV2ToFirestore must fail closed for dbOverride=${label}`
        );

        assert.equal(getPendingBranchSyncs(cashierSession.uid).length, 0, `No sale retry entry allowed after fail-closed (${label})`);
        assert.equal(getPendingBranchSyncs(adminSession.uid).length, 0, `No med retry entry allowed after fail-closed (${label})`);
        assert.equal(isV1EntitySyncInFlight(cashierSession.uid, 'khalid-1', 'sale', 'sale-fail-closed-d4'), false);
        const leases = await enumerateV1InFlightOperations();
        assert.equal(leases.activeLeases.length, 0, `No active leases allowed after fail-closed (${label})`);
      }

      // Genuine compat Firestore (_delegate) passes D4-01 validation (reaches transport/terminated error -> queued, never SYNC_DB_OVERRIDE_REQUIRED)
      await compatDb.terminate();
      const compatRes = await pushBranchSaleToFirestore(cashierSession, 'khalid-1', validSalePayload, { dbOverride: compatDb });
      assert.equal(compatRes.status, 'queued');
    } finally {
      clearBranchSyncRetryQueue();
      await terminate(modularDb).catch(() => {});
      await deleteApp(modularApp);
      await compatApp.delete().catch(() => {});
    }
  });

  await runTest('SDI-04: Strict positive sale quantity and base-unit parsing enforces positive bounds, allows fractional strips, and rejects explicit null alias fallthrough', () => {
    // Direct helper checks: quantity allows positive finite floats (fractional strips), rejects <= 0 / non-finite / malformed types
    assert.equal(parseStrictPositiveSaleQuantity(0.5), 0.5);
    assert.equal(parseStrictPositiveSaleQuantity(3), 3);
    for (const badQty of [0, -0, -1, -0.5, NaN, Infinity, -Infinity, '1', '', true, false, null, undefined, {}, []]) {
      assert.throws(() => parseStrictPositiveSaleQuantity(badQty), /SDI-04_INVALID_SALE_QUANTITY/);
    }

    // Direct helper checks: baseUnits requires positive safe integer >= 1
    assert.equal(parseStrictPositiveSaleBaseUnits(1), 1);
    assert.equal(parseStrictPositiveSaleBaseUnits(5), 5);
    for (const badBase of [0, -1, 0.5, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '5', true, false, null, undefined, {}, []]) {
      assert.throws(() => parseStrictPositiveSaleBaseUnits(badBase), /SDI-04_INVALID_SALE_BASE_UNITS/);
    }

    // Valid fractional strip sale (0.5 strip = 5 base units) preserves exact fractional quantityDelta and integer baseUnitsDelta
    const fractionalStrip = normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
      id: 'sale-sdi04-frac-strip',
      invoiceNumber: 'INV-SDI-FRAC',
      subtotal: 750,
      discount: 0,
      total: 750,
      items: [
        {
          medicineId: 'med-solid-1',
          unit: 'strip',
          quantity: 0.5,
          baseUnits: 5,
          subtotal: 750,
        },
      ],
    });
    assert.equal(fractionalStrip.ledgerDocs[0].data.quantityDelta, -0.5);
    assert.equal(fractionalStrip.ledgerDocs[0].data.baseUnitsDelta, -5);

    // Reject fabricated baseUnits from qty alone (no ?? qtyVal fallback)
    assert.throws(
      () =>
        normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
          id: 'sale-sdi04-no-base',
          items: [{ medicineId: 'med-1', qty: 2, unit: 'pack', subtotal: 200 }],
        }),
      /SDI-04_INVALID_SALE_BASE_UNITS/
    );

    // Explicit null on primary or secondary alias MUST NOT fall through ?? to another alias
    const nullAliasPayloads: Array<[string, Record<string, unknown>]> = [
      ['item.qty null -> item.quantity', { medicineId: 'med-1', qty: null, quantity: 2, baseUnits: 20 }],
      ['item.quantity null with item.qty', { medicineId: 'med-1', qty: 2, quantity: null, baseUnits: 20 }],
      ['item.baseUnits null -> item.totalBaseUnits', { medicineId: 'med-1', qty: 2, baseUnits: null, totalBaseUnits: 20 }],
      ['item.totalBaseUnits null with item.baseUnits', { medicineId: 'med-1', qty: 2, baseUnits: 20, totalBaseUnits: null }],
      [
        'alloc.quantity null -> alloc.qty / item.qty',
        { medicineId: 'med-1', qty: 2, baseUnits: 20, batchAllocations: [{ quantity: null, qty: 1, baseUnits: 10 }] },
      ],
      [
        'alloc.qty null with alloc.quantity',
        { medicineId: 'med-1', qty: 2, baseUnits: 20, batchAllocations: [{ quantity: 1, qty: null, baseUnits: 10 }] },
      ],
      [
        'alloc.baseUnits null -> alloc.quantityBaseUnits',
        { medicineId: 'med-1', qty: 2, baseUnits: 20, batchAllocations: [{ quantity: 1, baseUnits: null, quantityBaseUnits: 10 }] },
      ],
      [
        'alloc.quantityBaseUnits null with alloc.baseUnits',
        { medicineId: 'med-1', qty: 2, baseUnits: 20, batchAllocations: [{ quantity: 1, baseUnits: 10, quantityBaseUnits: null }] },
      ],
    ];
    for (const [label, badItem] of nullAliasPayloads) {
      assert.throws(
        () =>
          normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
            id: 'sale-sdi04-null-alias',
            items: [badItem],
          }),
        /SDI-04_INVALID_SALE_INPUT/,
        `Expected explicit null rejection for ${label}`
      );
    }

    // Reject fractional baseUnits, zero/negative quantity, and multi-batch allocation lacking explicit baseUnits
    assert.throws(
      () =>
        normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
          id: 'sale-sdi04-frac-base',
          items: [{ medicineId: 'med-1', qty: 1, baseUnits: 1.5 }],
        }),
      /SDI-04_INVALID_SALE_BASE_UNITS/
    );
    assert.throws(
      () =>
        normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
          id: 'sale-sdi04-zero-qty',
          items: [{ medicineId: 'med-1', qty: 0, baseUnits: 10 }],
        }),
      /SDI-04_INVALID_SALE_QUANTITY/
    );
    assert.throws(
      () =>
        normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
          id: 'sale-sdi04-neg-qty',
          items: [{ medicineId: 'med-1', qty: -2, baseUnits: 10 }],
        }),
      /SDI-04_INVALID_SALE_QUANTITY/
    );
    assert.throws(
      () =>
        normalizeSalePayloadForFirestore(cashierSession, 'khalid-1', {
          id: 'sale-sdi04-multi-alloc-no-base',
          items: [
            {
              medicineId: 'med-1',
              qty: 2,
              baseUnits: 20,
              batchAllocations: [{ quantity: 1, baseUnits: 10 }, { quantity: 1 }],
            },
          ],
        }),
      /SDI-04_INVALID_SALE_BASE_UNITS/
    );
  });

  // ===========================================================================
  // D5: MULTI-DEVICE CONFLICT POLICY (NEVER SILENT OVERWRITE)
  // ===========================================================================
  await runTest('D5-01: Multi-device conflict detector preserves evidence without silent overwrite for packingLocked, stale version, and unit-mode divergence', () => {
    const remoteLocked = {
      id: 'med-1',
      name: 'Amoxicillin 500mg',
      buyPrice: 1000,
      sellPrice: 1500,
      dosageForm: 'Capsule',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      baseUnitsPerPack: 20,
      packingLocked: true,
      syncVersion: 3,
      unitDefinition: { mode: 'SOLID_TWO_LEVEL', dosageForm: 'Capsule', baseUnitLabel: 'capsule', baseUnitsPerPack: 20, stripsPerPack: 2, pillsPerStrip: 10 },
    };

    // Case 1: Local attempts dimensional change on remotely locked medicine -> PACKING_LOCK_VIOLATION
    const lockConflict = detectMedicineSyncConflict({
      localPayload: { ...remoteLocked, stripsPerPack: 3, baseUnitsPerPack: 30, unitDefinition: { ...remoteLocked.unitDefinition, stripsPerPack: 3, baseUnitsPerPack: 30 } },
      remoteDoc: remoteLocked,
      expectedRemoteSyncVersion: 3,
    });
    assert.equal(lockConflict.hasConflict, true);
    assert.equal(lockConflict.conflictType, 'PACKING_LOCK_VIOLATION');
    assert.equal(lockConflict.requiresManualReview, true);
    assert.equal((lockConflict.remoteSnapshot as any).stripsPerPack, 2);
    assert.equal((lockConflict.localSnapshot as any).stripsPerPack, 3);

    // Case 2: Remote syncVersion advanced concurrently by another device (remote=4 > localBase=3) with different price -> STALE_VERSION_CONFLICT
    const staleConflict = detectMedicineSyncConflict({
      localPayload: { ...remoteLocked, sellPrice: 1600, syncVersion: 3 },
      remoteDoc: { ...remoteLocked, sellPrice: 1700, syncVersion: 4 },
      expectedRemoteSyncVersion: 3,
    });
    assert.equal(staleConflict.hasConflict, true);
    assert.equal(staleConflict.conflictType, 'STALE_VERSION_CONFLICT');
    assert.equal(staleConflict.requiresManualReview, true);
    assert.equal((staleConflict.remoteSnapshot as any).sellPrice, 1700);
    assert.equal((staleConflict.localSnapshot as any).sellPrice, 1600);

    // Case 3: Unit-mode divergence (SOLID_TWO_LEVEL vs DIRECT_PACK) -> UNIT_DEFINITION_DIVERGENCE
    const modeConflict = detectMedicineSyncConflict({
      localPayload: { name: 'Med', dosageForm: 'Syrup', baseUnitsPerPack: 1, syncVersion: 1, unitDefinition: { mode: 'DIRECT_PACK', dosageForm: 'Syrup', baseUnitLabel: 'bottle', baseUnitsPerPack: 1 } },
      remoteDoc: { ...remoteLocked, packingLocked: false, syncVersion: 2 },
      expectedRemoteSyncVersion: 1,
    });
    assert.equal(modeConflict.hasConflict, true);
    assert.equal(modeConflict.conflictType, 'UNIT_DEFINITION_DIVERGENCE');

    // Case 4: Identical remote state converges cleanly (isIdentical=true, hasConflict=false)
    const identical = detectMedicineSyncConflict({
      localPayload: { ...remoteLocked },
      remoteDoc: remoteLocked,
      expectedRemoteSyncVersion: 3,
    });
    assert.equal(identical.hasConflict, false);
    assert.equal(identical.isIdentical, true);

    // Case 5: Clean price update on locked medicine at current version (no dimensional change) -> NO_CONFLICT
    const cleanPriceEdit = detectMedicineSyncConflict({
      localPayload: { ...remoteLocked, sellPrice: 1650 },
      remoteDoc: remoteLocked,
      expectedRemoteSyncVersion: 3,
    });
    assert.equal(cleanPriceEdit.hasConflict, false);
    assert.equal(cleanPriceEdit.isIdentical, false);
  });

  await runTest('D5-02 (H-45-1): Genuine Firestore Timestamp packingLockedAt matches local ISO/Date without false PACKING_LOCK_VIOLATION, while real lock mutations are rejected', () => {
    const lockInstantMs = 1700000000123;
    const firestoreTs = Timestamp.fromMillis(lockInstantMs);
    const isoString = new Date(lockInstantMs).toISOString();

    assert.equal(areCanonicalTimestampsEqual(isoString, firestoreTs), true);
    assert.equal(areCanonicalTimestampsEqual(new Date(lockInstantMs), firestoreTs), true);
    assert.equal(areCanonicalTimestampsEqual({ seconds: firestoreTs.seconds, nanoseconds: firestoreTs.nanoseconds }, firestoreTs), true);
    assert.equal(serializePackingLockedAt(firestoreTs), isoString);

    const remoteLockedWithTs = {
      id: 'med-ts-locked',
      name: 'Amoxicillin 500mg',
      barcode: '628111222',
      minStock: 10,
      buyPrice: 1000,
      sellPrice: 1500,
      dosageForm: 'Capsule',
      baseUnitLabel: 'capsule',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      baseUnitsPerPack: 20,
      sellPack: true,
      sellStrip: true,
      sellPill: false,
      unitType: 'pack',
      unitSchemaVersion: 2,
      configStatus: 'VERIFIED',
      unitMigrationStatus: 'VERIFIED',
      packingLocked: true,
      packingLockedAt: firestoreTs,
      packingLockReason: 'FIRST_MOVEMENT',
      syncVersion: 3,
      unitDefinition: {
        mode: 'SOLID_TWO_LEVEL',
        dosageForm: 'Capsule',
        baseUnitLabel: 'capsule',
        baseUnitsPerPack: 20,
        stripsPerPack: 2,
        pillsPerStrip: 10,
        verificationState: 'VERIFIED',
      },
    };

    // Permitted metadata update (sellPrice, minStock, name, barcode) with local ISO string matching remote Timestamp -> MUST PASS
    const preparedFromIso = prepareMedicineFirestoreV2Payload({
      ...remoteLockedWithTs,
      packingLockedAt: isoString,
      sellPrice: 1750,
      minStock: 25,
      name: 'Amoxicillin 500mg (Updated)',
      barcode: '628999888',
    });
    assert.equal(preparedFromIso.ok, true);
    if (preparedFromIso.ok) {
      assert.equal(preparedFromIso.mutableFields.packingLockedAt, isoString);
      const conflictIso = detectMedicineSyncConflict({
        localPayload: preparedFromIso.mutableFields,
        remoteDoc: remoteLockedWithTs,
        expectedRemoteSyncVersion: 3,
      });
      assert.equal(conflictIso.hasConflict, false, 'Permitted metadata update with matching Timestamp/ISO must NOT raise PACKING_LOCK_VIOLATION');
      assert.equal(conflictIso.isIdentical, false, 'Updated metadata fields must NOT be falsely skipped as identical');
    }

    // Permitted metadata update where local carries genuine Firestore Timestamp object -> MUST PASS
    const preparedFromTs = prepareMedicineFirestoreV2Payload({
      ...remoteLockedWithTs,
      packingLockedAt: firestoreTs,
      minStock: 30,
    });
    assert.equal(preparedFromTs.ok, true);
    if (preparedFromTs.ok) {
      assert.equal(preparedFromTs.mutableFields.packingLockedAt, isoString, 'Timestamp must serialize to ISO, never "Timestamp(...)"');
      const conflictTs = detectMedicineSyncConflict({
        localPayload: preparedFromTs.mutableFields,
        remoteDoc: remoteLockedWithTs,
        expectedRemoteSyncVersion: 3,
      });
      assert.equal(conflictTs.hasConflict, false);
      assert.equal(conflictTs.isIdentical, false);
    }

    // Unauthorized mutation of packingLockedAt to a DIFFERENT timestamp -> MUST FAIL with PACKING_LOCK_VIOLATION
    const forgedLockedAt = detectMedicineSyncConflict({
      localPayload: { ...remoteLockedWithTs, packingLockedAt: '2025-01-01T00:00:00.000Z', sellPrice: 1600 },
      remoteDoc: remoteLockedWithTs,
      expectedRemoteSyncVersion: 3,
    });
    assert.equal(forgedLockedAt.hasConflict, true);
    assert.equal(forgedLockedAt.conflictType, 'PACKING_LOCK_VIOLATION');

    // Unauthorized unlock, sellPill flip, or packingLockReason tamper -> ALL REJECTED
    assert.ok(detectLockedPackingViolations({ ...remoteLockedWithTs, packingLocked: false }, remoteLockedWithTs).includes('packingLocked'));
    assert.ok(detectLockedPackingViolations({ ...remoteLockedWithTs, sellPill: true }, remoteLockedWithTs).includes('sellPill'));
    assert.ok(detectLockedPackingViolations({ ...remoteLockedWithTs, packingLockReason: 'TAMPERED' }, remoteLockedWithTs).includes('packingLockReason'));
  });

  // ===========================================================================
  // D6: STRICT ZERO-COST SPARK COMPLIANCE AUDIT
  // ===========================================================================
  await runTest('D6-01: Zero-Cost compliance — zero Cloud Functions SDK imports, httpsCallable, or paid Blaze calls in src/', () => {
    const srcRoot = path.resolve(process.cwd(), 'src');
    const violations: string[] = [];
    const scanDir = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.toLowerCase().includes('bankak')) continue; // strictly respect Bankak boundary
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(full);
        } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/\bfirebase\/functions\b|httpsCallable\s*\(|cloudfunctions\.net/i.test(text)) {
            violations.push(path.relative(process.cwd(), full));
          }
        }
      }
    };
    scanDir(srcRoot);
    assert.deepEqual(violations, [], `Paid Cloud Functions references found: ${violations.join(', ')}`);
  });

  console.log('========================================================================');
  console.log(`PHASE 2D SPARK DIRECT SYNC SUITE: ${passed}/${passed} PASSED, 0 FAILED`);
  console.log('========================================================================');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('SPARK DIRECT SYNC SUITE FAILED:', err);
    process.exit(1);
  });
