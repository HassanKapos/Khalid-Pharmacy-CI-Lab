/**
 * Phase 2E-B.3 (R3.2 Security Reconciliation + Phase 2F Stocktake Rules)
 * REAL Firebase Firestore Emulator Verification Suite
 *
 * Covers:
 * - Complete R3.2 Security Matrix M-01..M-33 (M-30 explicitly marked non-emulator Browser SOP boundary)
 * - Phase 2F Collaborative Continuous Stocktake Rules & Real `runTransaction` CAS Concurrency ST-01..ST-15
 * - Zero-cost local OpenJDK 21 + Firebase Firestore Emulator (`demo-khalid-pharmacy`)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertFails as rawAssertFails,
  assertSucceeds as rawAssertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  setLogLevel,
  Timestamp,
  updateDoc,
  writeBatch,
  where,
  type Firestore,
} from 'firebase/firestore';
import {
  assertNoCashierForbiddenFields,
  buildDeterministicSaleItemId,
  buildOperationalSaleItems,
  compareRational,
  normalizeRational,
  resolveMovementHistoricalCost,
  sanitizeMedicineForCashier,
  sanitizeOperationalSnapshotForRole,
  splitMedicineOperationalAndFinancial,
  verifyHistoricalCostProvenanceAndEligibility,
  type FifoCostLayer,
} from '../src/services/r32FinancialSplitContract';
import {
  claimOrTakeoverSaleReconciliationLease,
  finalizeSaleFinancialReconciliation,
} from '../src/services/r32AdminReconciliationService';

const PROJECT_ID = 'demo-khalid-pharmacy';
const RULES_PATH = path.resolve(process.cwd(), 'firestore.rules');

let positiveAssertions = 0;
let negativeAssertions = 0;
let passed = 0;
let failed = 0;
let skippedNonEmulator = 0;

interface CaseResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED_NON_EMULATOR';
  detail?: string;
}
const results: CaseResult[] = [];

async function assertSucceeds<T>(pr: Promise<T>): Promise<T> {
  const res = await rawAssertSucceeds(pr);
  positiveAssertions++;
  return res;
}

async function assertFails(pr: Promise<unknown>): Promise<unknown> {
  const res = await rawAssertFails(pr);
  negativeAssertions++;
  return res;
}

async function runCase(id: string, name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    results.push({ id, name, status: 'PASS' });
    console.log(`[PASS] ${id} — ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ id, name, status: 'FAIL', detail: msg });
    console.error(`[FAIL] ${id} — ${name}:`, err);
  }
}

function recordNonEmulatorBoundary(id: string, name: string, reason: string) {
  skippedNonEmulator++;
  results.push({ id, name, status: 'SKIPPED_NON_EMULATOR', detail: reason });
  console.log(`[BOUNDARY] ${id} — ${name} (${reason})`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeOperationalMedicine(
  branchId: string,
  id: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    branchId,
    name: `Panadol ${id}`,
    barcode: `622000${id.replace(/[^0-9]/g, '').padEnd(7, '1').slice(0, 7)}`,
    category: 'Painkillers',
    sellPrice: 120,
    sellPriceStrip: 60,
    sellPricePill: 6,
    sellPack: true,
    sellStrip: true,
    sellPill: true,
    dosageForm: 'tablet',
    unitType: 'solid',
    unitSchemaVersion: 2,
    stripsPerPack: 2,
    pillsPerStrip: 10,
    baseUnitsPerPack: 20,
    baseUnitLabel: 'pill',
    configStatus: 'VERIFIED',
    unitMigrationStatus: 'NATIVE_V2',
    packingLocked: false,
    syncVersion: 1,
    unitDefinition: {
      mode: 'SOLID_TWO_LEVEL',
      dosageForm: 'tablet',
      baseUnitLabel: 'pill',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      baseUnitsPerPack: 20,
      verificationState: 'VERIFIED',
    },
    openingStockEvidence: {
      mode: 'EXPLICIT_ZERO',
      intendedInitialStock: 0,
      intendedBaseUnits: 0,
      recordedAt: '2026-11-26T00:00:00.000Z',
    },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

async function seedBase(testEnv: RulesTestEnvironment) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = Timestamp.now();

    await setDoc(doc(db, 'branches/khalid-1'), {
      id: 'khalid-1',
      name: 'Khalid Branch 1',
      active: true,
      adminUids: ['admin-1', 'admin-1b'],
      memberUids: ['admin-1', 'admin-1b', 'cashier-1', 'cashier-1b'],
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'branches/khalid-2'), {
      id: 'khalid-2',
      name: 'Khalid Branch 2',
      active: true,
      adminUids: ['admin-2'],
      memberUids: ['admin-2', 'cashier-2'],
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'branches/khalid-inactive'), {
      id: 'khalid-inactive',
      name: 'Inactive Branch',
      active: false,
      adminUids: ['admin-1'],
      memberUids: ['admin-1', 'cashier-1'],
      createdAt: now,
      updatedAt: now,
    });

    const users = [
      { uid: 'super-1', email: 'super1@khalid.test', displayName: 'Super Admin', role: 'super_admin', branchIds: ['khalid-1', 'khalid-2'], activeBranchId: 'khalid-1', active: true },
      { uid: 'admin-1', email: 'admin1@khalid.test', displayName: 'Admin 1', role: 'admin', branchIds: ['khalid-1', 'khalid-inactive'], activeBranchId: 'khalid-1', active: true },
      { uid: 'admin-1b', email: 'admin1b@khalid.test', displayName: 'Admin 1B', role: 'admin', branchIds: ['khalid-1'], activeBranchId: 'khalid-1', active: true },
      { uid: 'admin-2', email: 'admin2@khalid.test', displayName: 'Admin 2', role: 'admin', branchIds: ['khalid-2'], activeBranchId: 'khalid-2', active: true },
      { uid: 'cashier-1', email: 'cashier1@khalid.test', displayName: 'Cashier 1', role: 'cashier', branchIds: ['khalid-1'], activeBranchId: 'khalid-1', active: true },
      { uid: 'cashier-1b', email: 'cashier1b@khalid.test', displayName: 'Cashier 1B', role: 'cashier', branchIds: ['khalid-1'], activeBranchId: 'khalid-1', active: true },
      { uid: 'cashier-2', email: 'cashier2@khalid.test', displayName: 'Cashier 2', role: 'cashier', branchIds: ['khalid-2'], activeBranchId: 'khalid-2', active: true },
      { uid: 'inactive-1', email: 'inactive@khalid.test', displayName: 'Inactive User', role: 'cashier', branchIds: ['khalid-1'], activeBranchId: 'khalid-1', active: false },
    ];
    for (const u of users) {
      await setDoc(doc(db, `users/${u.uid}`), {
        ...u,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Seed two operational medicines in khalid-1 (no buyPrice!) + one in khalid-2
    for (const [br, medId] of [
      ['khalid-1', 'med-1'],
      ['khalid-1', 'med-2'],
      ['khalid-2', 'med-b2'],
    ]) {
      await setDoc(doc(db, `branches/${br}/medicines/${medId}`), {
        ...makeOperationalMedicine(br, medId),
        createdAt: now,
        updatedAt: now,
      });
    }

    // Seed legacy stocktaking session & item in khalid-1 (historical record for OD-2 verification)
    await setDoc(doc(db, 'branches/khalid-1/stocktaking_sessions/legacy-sess-1'), {
      id: 'legacy-sess-1',
      branchId: 'khalid-1',
      title: 'Historical Legacy Stocktake 2025',
      status: 'completed',
      createdByUid: 'admin-1',
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(
      doc(db, 'branches/khalid-1/stocktaking_sessions/legacy-sess-1/items/legacy-item-1'),
      {
        id: 'legacy-item-1',
        branchId: 'khalid-1',
        sessionId: 'legacy-sess-1',
        medicineId: 'med-1',
        countedBaseUnits: 40,
        createdAt: now,
        updatedAt: now,
      }
    );
  });
}

function authedDb(
  testEnv: RulesTestEnvironment,
  uid: string,
  emailVerified = true
): Firestore {
  return testEnv
    .authenticatedContext(uid, {
      email: `${uid}@khalid.test`,
      email_verified: emailVerified,
    })
    .firestore() as unknown as Firestore;
}

async function main() {
  setLogLevel('error');
  const rules = fs.readFileSync(RULES_PATH, 'utf8');
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: '127.0.0.1',
      port: 8080,
    },
  });

  try {
    await seedBase(testEnv);

    const superDb = authedDb(testEnv, 'super-1');
    const admin1Db = authedDb(testEnv, 'admin-1');
    const admin1bDb = authedDb(testEnv, 'admin-1b');
    const cashier1Db = authedDb(testEnv, 'cashier-1');
    const cashier1bDb = authedDb(testEnv, 'cashier-1b');
    const cashier2Db = authedDb(testEnv, 'cashier-2');
    const unverifiedDb = authedDb(testEnv, 'cashier-1', false);
    const inactiveDb = authedDb(testEnv, 'inactive-1', true);
    const unauthDb = testEnv.unauthenticatedContext().firestore() as unknown as Firestore;

    // =========================================================================
    // PART 1: R3.2 SECURITY MATRIX (M-01 .. M-33)
    // =========================================================================

    await runCase('M-01', 'Operational medicines zero-cost split & buyPrice rejection', async () => {
      const snap = await assertSucceeds(getDoc(doc(cashier1Db, 'branches/khalid-1/medicines/med-1')));
      assert.equal(snap.exists(), true);
      assertNoCashierForbiddenFields(snap.data(), 'medicines/med-1');

      // Admin trying to write buyPrice into operational medicines MUST fail
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/medicines/med-cost-leak'), {
          ...makeOperationalMedicine('khalid-1', 'med-cost-leak'),
          buyPrice: 80,
        })
      );

      // Clean split helper succeeds
      const split = splitMedicineOperationalAndFinancial(
        { ...makeOperationalMedicine('khalid-1', 'med-clean'), buyPrice: 80 },
        'khalid-1',
        'med-clean',
        'admin-1'
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/medicines/med-clean'), {
          ...split.operational,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-02', 'medicines_financials Admin-only & Cashier ABSOLUTE DENY', async () => {
      const refAdmin = doc(admin1Db, 'branches/khalid-1/medicines_financials/med-1');
      await assertSucceeds(
        setDoc(refAdmin, {
          id: 'med-1',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          buyPrice: 80,
          costPerBaseUnitExact: { num: 4, den: 1 },
          updatedByUid: 'admin-1',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(getDoc(refAdmin));

      // Cashier get, list, write ALL denied
      await assertFails(getDoc(doc(cashier1Db, 'branches/khalid-1/medicines_financials/med-1')));
      await assertFails(
        getDocs(query(collection(cashier1Db, 'branches/khalid-1/medicines_financials'), where('branchId', '==', 'khalid-1')))
      );
      await assertFails(
        setDoc(doc(cashier1Db, 'branches/khalid-1/medicines_financials/med-2'), {
          id: 'med-2',
          branchId: 'khalid-1',
          medicineId: 'med-2',
          buyPrice: 50,
          updatedByUid: 'cashier-1',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-03', 'Operational inventory_ledger zero-cost & costPerUnit/costPerBaseUnit rejection', async () => {
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/inventory_ledger/mov-pur-1'), {
          id: 'mov-pur-1',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: 'PURCHASE',
          unit: 'pack',
          quantityDelta: 10,
          baseUnitsDelta: 200,
          userId: 'admin-1',
          createdAt: serverTimestamp(),
        })
      );
      const snap = await assertSucceeds(getDoc(doc(cashier1Db, 'branches/khalid-1/inventory_ledger/mov-pur-1')));
      assertNoCashierForbiddenFields(snap.data(), 'inventory_ledger/mov-pur-1');

      // Writing costPerUnit or costPerBaseUnit into operational ledger MUST fail
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/inventory_ledger/mov-pur-leak'), {
          id: 'mov-pur-leak',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: 'PURCHASE',
          unit: 'pack',
          quantityDelta: 1,
          baseUnitsDelta: 20,
          costPerUnit: 80,
          userId: 'admin-1',
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/inventory_ledger/mov-pur-leak2'), {
          id: 'mov-pur-leak2',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: 'PURCHASE',
          unit: 'pack',
          quantityDelta: 1,
          baseUnitsDelta: 20,
          costPerBaseUnit: 4,
          userId: 'admin-1',
          createdAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-04', 'inventory_financials Admin-only, immutable & Cashier ABSOLUTE DENY', async () => {
      const refAdmin = doc(admin1Db, 'branches/khalid-1/inventory_financials/mov-pur-1');
      await assertSucceeds(
        setDoc(refAdmin, {
          id: 'mov-pur-1',
          branchId: 'khalid-1',
          movementId: 'mov-pur-1',
          medicineId: 'med-1',
          movementType: 'PURCHASE',
          costPerUnitExact: { num: 80, den: 1 },
          costPerBaseUnitExact: { num: 4, den: 1 },
          totalCostExact: { num: 800, den: 1 },
          costStatus: 'EXACT_RECONCILED',
          costProvenanceType: 'PURCHASE_INVOICE_EXACT',
          unresolvedBaseUnits: 0,
          reconciledByUid: 'admin-1',
          createdAt: serverTimestamp(),
        })
      );
      await assertSucceeds(getDoc(refAdmin));
      // Immutable: update & delete denied even for Admin
      await assertFails(updateDoc(refAdmin, { notes: 'tamper' }));
      await assertFails(deleteDoc(refAdmin));
      // Cashier denied
      await assertFails(getDoc(doc(cashier1Db, 'branches/khalid-1/inventory_financials/mov-pur-1')));
      await assertFails(
        getDocs(query(collection(cashier1Db, 'branches/khalid-1/inventory_financials'), where('branchId', '==', 'khalid-1')))
      );
    });

    await runCase('M-05', 'Operational sales header rejects costOfGoods/grossProfit/netProfit/items[]', async () => {
      const baseSale = {
        id: 'sale-leak-1',
        branchId: 'khalid-1',
        invoiceNumber: 'INV-LEAK-1',
        itemsCount: 1,
        totalBaseUnits: 20,
        subtotal: 120,
        discount: 0,
        total: 120,
        paymentMethod: 'Cash',
        cashierUid: 'cashier-1',
        syncState: 'pending_items',
        expectedLedgerCount: 1,
        expectedLedgerIds: ['mov-sale-leak-1'],
        verifiedItemsCount: 0,
        verifiedItemsSubtotal: 0,
        verifiedItemsBaseUnits: 0,
        verifiedItemsLedgerCount: 0,
        verifiedLedgerCount: 0,
        verifiedLedgerBaseUnits: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      for (const forbidden of [
        { costOfGoods: 80 },
        { grossProfit: 40 },
        { netProfit: 40 },
        { items: [{ medicineId: 'med-1' }] },
      ]) {
        await assertFails(
          setDoc(doc(cashier1Db, 'branches/khalid-1/sales/sale-leak-1'), {
            ...baseSale,
            ...forbidden,
          })
        );
      }
      // Clean operational sale header succeeds
      await assertSucceeds(
        setDoc(doc(cashier1Db, 'branches/khalid-1/sales/sale-ok-1'), {
          ...baseSale,
          id: 'sale-ok-1',
          invoiceNumber: 'INV-OK-1',
          expectedLedgerIds: ['mov-sale-ok-1'],
        })
      );
    });

    await runCase('M-06', 'sales_financials Cashier ABSOLUTE DENY (get/list/create/update)', async () => {
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/sales_financials/sale-ok-1'), {
          id: 'sale-ok-1',
          branchId: 'khalid-1',
          saleId: 'sale-ok-1',
          reconciliationStatus: 'UNRECONCILED',
          leaseVersion: 0,
          expectedFinancialLedgerCount: 1,
          verifiedFinancialLedgerCount: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(getDoc(doc(cashier1Db, 'branches/khalid-1/sales_financials/sale-ok-1')));
      await assertFails(
        getDocs(query(collection(cashier1Db, 'branches/khalid-1/sales_financials'), where('branchId', '==', 'khalid-1')))
      );
      await assertFails(
        updateDoc(doc(cashier1Db, 'branches/khalid-1/sales_financials/sale-ok-1'), {
          reconciliationStatus: 'RECONCILING',
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-07', 'reconciliation_operations Admin append-only & Cashier ABSOLUTE DENY', async () => {
      const opRef = doc(admin1Db, 'branches/khalid-1/reconciliation_operations/op-1');
      await assertSucceeds(
        setDoc(opRef, {
          id: 'op-1',
          branchId: 'khalid-1',
          operationType: 'SALE_RECONCILIATION',
          targetId: 'sale-ok-1',
          actorUid: 'admin-1',
          status: 'STARTED',
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(updateDoc(opRef, { status: 'COMPLETED' }));
      await assertFails(deleteDoc(opRef));
      await assertFails(getDoc(doc(cashier1Db, 'branches/khalid-1/reconciliation_operations/op-1')));
      await assertFails(
        setDoc(doc(cashier1Db, 'branches/khalid-1/reconciliation_operations/op-c1'), {
          id: 'op-c1',
          branchId: 'khalid-1',
          operationType: 'SALE_RECONCILIATION',
          targetId: 'sale-ok-1',
          actorUid: 'cashier-1',
          status: 'STARTED',
          createdAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-08', 'Normalized sale items deterministic IDs, immutability, zero cost keys', async () => {
      // Non-deterministic item ID rejected
      await assertFails(
        setDoc(doc(cashier1Db, 'branches/khalid-1/sales/sale-ok-1/items/random-id'), {
          id: 'random-id',
          branchId: 'khalid-1',
          saleId: 'sale-ok-1',
          itemIndex: 0,
          medicineId: 'med-1',
          medicineName: 'Panadol med-1',
          unit: 'pack',
          quantity: 1,
          baseUnits: 20,
          unitPrice: 120,
          lineSubtotal: 120,
          expectedLedgerCount: 1,
          createdAt: serverTimestamp(),
        })
      );
      // Cost key in sale item rejected
      const detId = buildDeterministicSaleItemId('sale-ok-1', 0);
      await assertFails(
        setDoc(doc(cashier1Db, `branches/khalid-1/sales/sale-ok-1/items/${detId}`), {
          id: detId,
          branchId: 'khalid-1',
          saleId: 'sale-ok-1',
          itemIndex: 0,
          medicineId: 'med-1',
          medicineName: 'Panadol med-1',
          unit: 'pack',
          quantity: 1,
          baseUnits: 20,
          unitPrice: 120,
          lineSubtotal: 120,
          buyPrice: 80,
          expectedLedgerCount: 1,
          createdAt: serverTimestamp(),
        })
      );
      // Valid deterministic sale item succeeds
      await assertSucceeds(
        setDoc(doc(cashier1Db, `branches/khalid-1/sales/sale-ok-1/items/${detId}`), {
          id: detId,
          branchId: 'khalid-1',
          saleId: 'sale-ok-1',
          itemIndex: 0,
          medicineId: 'med-1',
          medicineName: 'Panadol med-1',
          unit: 'pack',
          quantity: 1,
          baseUnits: 20,
          unitPrice: 120,
          lineSubtotal: 120,
          expectedLedgerCount: 1,
          createdAt: serverTimestamp(),
        })
      );
      // Immutable: update & delete denied
      await assertFails(
        updateDoc(doc(cashier1Db, `branches/khalid-1/sales/sale-ok-1/items/${detId}`), { quantity: 2 })
      );
      await assertFails(
        deleteDoc(doc(admin1Db, `branches/khalid-1/sales/sale-ok-1/items/${detId}`))
      );
    });

    await runCase('M-09', 'Progressive 5-stage sale sync (pending_items -> pending_ledger -> verification_pending -> complete)', async () => {
      // Stage 2: verify items slice -> pending_ledger
      await assertSucceeds(
        updateDoc(doc(cashier1Db, 'branches/khalid-1/sales/sale-ok-1'), {
          syncState: 'pending_ledger',
          verifiedItemsCount: 1,
          verifiedItemsSubtotal: 120,
          verifiedItemsBaseUnits: 20,
          verifiedItemsLedgerCount: 1,
          updatedAt: serverTimestamp(),
        })
      );
      // Stage 3: write linked SALE ledger doc
      await assertSucceeds(
        setDoc(doc(cashier1Db, 'branches/khalid-1/inventory_ledger/mov-sale-ok-1'), {
          id: 'mov-sale-ok-1',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: 'SALE',
          unit: 'pack',
          quantityDelta: -1,
          baseUnitsDelta: -20,
          referenceId: 'sale-ok-1',
          saleItemId: 'sale-ok-1-item-0',
          saleItemIndex: 0,
          userId: 'cashier-1',
          createdAt: serverTimestamp(),
        })
      );
      // Stage 4: verify ledger slice -> verification_pending
      await assertSucceeds(
        updateDoc(doc(cashier1Db, 'branches/khalid-1/sales/sale-ok-1'), {
          syncState: 'verification_pending',
          verifiedLedgerCount: 1,
          verifiedLedgerBaseUnits: 20,
          updatedAt: serverTimestamp(),
        })
      );
      // Stage 5: complete
      await assertSucceeds(
        updateDoc(doc(cashier1Db, 'branches/khalid-1/sales/sale-ok-1'), {
          syncState: 'complete',
          syncCompletedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-10', 'Per-sale-item 2-medicine swap attack (7/3 vs 5/5) REJECTED at Rules layer', async () => {
      // Sale with 2 medicines: med-1 (5 pills) + med-2 (5 pills) = 10 baseUnits total
      const saleId = 'sale-swap-1';
      await assertSucceeds(
        setDoc(doc(cashier1Db, `branches/khalid-1/sales/${saleId}`), {
          id: saleId,
          branchId: 'khalid-1',
          invoiceNumber: 'INV-SWAP-1',
          itemsCount: 2,
          totalBaseUnits: 10,
          subtotal: 60,
          discount: 0,
          total: 60,
          paymentMethod: 'Cash',
          cashierUid: 'cashier-1',
          syncState: 'pending_items',
          expectedLedgerCount: 2,
          expectedLedgerIds: ['mov-swap-0', 'mov-swap-1'],
          verifiedItemsCount: 0,
          verifiedItemsSubtotal: 0,
          verifiedItemsBaseUnits: 0,
          verifiedItemsLedgerCount: 0,
          verifiedLedgerCount: 0,
          verifiedLedgerBaseUnits: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      const items = buildOperationalSaleItems('khalid-1', saleId, [
        { medicineId: 'med-1', medicineName: 'Panadol med-1', unit: 'pill', quantity: 5, baseUnits: 5, unitPrice: 6 },
        { medicineId: 'med-2', medicineName: 'Panadol med-2', unit: 'pill', quantity: 5, baseUnits: 5, unitPrice: 6 },
      ]);
      for (const it of items) {
        await assertSucceeds(
          setDoc(doc(cashier1Db, `branches/khalid-1/sales/${saleId}/items/${it.id}`), {
            ...it,
            createdAt: serverTimestamp(),
          })
        );
      }
      await assertSucceeds(
        updateDoc(doc(cashier1Db, `branches/khalid-1/sales/${saleId}`), {
          syncState: 'pending_ledger',
          verifiedItemsCount: 2,
          verifiedItemsSubtotal: 60,
          verifiedItemsBaseUnits: 10,
          verifiedItemsLedgerCount: 2,
          updatedAt: serverTimestamp(),
        })
      );
      // ATTACK 1: 7 pills on med-1 instead of 5 (would pair with 3 on med-2 to preserve total=10) -> MUST FAIL!
      await assertFails(
        setDoc(doc(cashier1Db, 'branches/khalid-1/inventory_ledger/mov-swap-0'), {
          id: 'mov-swap-0',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: 'SALE',
          unit: 'pill',
          quantityDelta: -7,
          baseUnitsDelta: -7,
          referenceId: saleId,
          saleItemId: `${saleId}-item-0`,
          saleItemIndex: 0,
          userId: 'cashier-1',
          createdAt: serverTimestamp(),
        })
      );
      // ATTACK 2: Wrong medicineId (med-2 on item-0 which belongs to med-1) -> MUST FAIL!
      await assertFails(
        setDoc(doc(cashier1Db, 'branches/khalid-1/inventory_ledger/mov-swap-0'), {
          id: 'mov-swap-0',
          branchId: 'khalid-1',
          medicineId: 'med-2',
          type: 'SALE',
          unit: 'pill',
          quantityDelta: -5,
          baseUnitsDelta: -5,
          referenceId: saleId,
          saleItemId: `${saleId}-item-0`,
          saleItemIndex: 0,
          userId: 'cashier-1',
          createdAt: serverTimestamp(),
        })
      );
      // Legitimate 5/5 succeeds
      await assertSucceeds(
        setDoc(doc(cashier1Db, 'branches/khalid-1/inventory_ledger/mov-swap-0'), {
          id: 'mov-swap-0',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: 'SALE',
          unit: 'pill',
          quantityDelta: -5,
          baseUnitsDelta: -5,
          referenceId: saleId,
          saleItemId: `${saleId}-item-0`,
          saleItemIndex: 0,
          userId: 'cashier-1',
          createdAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(cashier1Db, 'branches/khalid-1/inventory_ledger/mov-swap-1'), {
          id: 'mov-swap-1',
          branchId: 'khalid-1',
          medicineId: 'med-2',
          type: 'SALE',
          unit: 'pill',
          quantityDelta: -5,
          baseUnitsDelta: -5,
          referenceId: saleId,
          saleItemId: `${saleId}-item-1`,
          saleItemIndex: 1,
          userId: 'cashier-1',
          createdAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-11', 'SALE ledger positive delta & foreign-cashier hijack DENIED', async () => {
      // Positive delta on SALE denied
      await assertFails(
        setDoc(doc(cashier1Db, 'branches/khalid-1/inventory_ledger/mov-pos-sale'), {
          id: 'mov-pos-sale',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: 'SALE',
          unit: 'pill',
          quantityDelta: 5,
          baseUnitsDelta: 5,
          referenceId: 'sale-swap-1',
          saleItemId: 'sale-swap-1-item-0',
          saleItemIndex: 0,
          userId: 'cashier-1',
          createdAt: serverTimestamp(),
        })
      );
      // Cashier 1B trying to finalize Cashier 1's sale denied
      await assertFails(
        updateDoc(doc(cashier1bDb, 'branches/khalid-1/sales/sale-swap-1'), {
          syncState: 'verification_pending',
          verifiedLedgerCount: 2,
          verifiedLedgerBaseUnits: 10,
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-12', 'Large 10-item invoice multi-slice verification within 10-read Rules budget', async () => {
      const saleId = 'sale-large-10';
      const ledgerIds = Array.from({ length: 10 }, (_, i) => `mov-lg10-${i}`);
      await assertSucceeds(
        setDoc(doc(cashier1Db, `branches/khalid-1/sales/${saleId}`), {
          id: saleId,
          branchId: 'khalid-1',
          invoiceNumber: 'INV-LG-10',
          itemsCount: 10,
          totalBaseUnits: 10,
          subtotal: 60,
          discount: 0,
          total: 60,
          paymentMethod: 'Cash',
          cashierUid: 'cashier-1',
          syncState: 'pending_items',
          expectedLedgerCount: 10,
          expectedLedgerIds: ledgerIds,
          verifiedItemsCount: 0,
          verifiedItemsSubtotal: 0,
          verifiedItemsBaseUnits: 0,
          verifiedItemsLedgerCount: 0,
          verifiedLedgerCount: 0,
          verifiedLedgerBaseUnits: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      for (let i = 0; i < 10; i++) {
        const itemId = buildDeterministicSaleItemId(saleId, i);
        await assertSucceeds(
          setDoc(doc(cashier1Db, `branches/khalid-1/sales/${saleId}/items/${itemId}`), {
            id: itemId,
            branchId: 'khalid-1',
            saleId,
            itemIndex: i,
            medicineId: i % 2 === 0 ? 'med-1' : 'med-2',
            medicineName: 'Panadol',
            unit: 'pill',
            quantity: 1,
            baseUnits: 1,
            unitPrice: 6,
            lineSubtotal: 6,
            expectedLedgerCount: 1,
            createdAt: serverTimestamp(),
          })
        );
      }
      // Slice 1: items 0..5 (6 items, exact 10-call Firestore Rules budget: 4 auth/branch + 6 getAfter) -> stays pending_items
      await assertSucceeds(
        updateDoc(doc(cashier1Db, `branches/khalid-1/sales/${saleId}`), {
          syncState: 'pending_items',
          verifiedItemsCount: 6,
          verifiedItemsSubtotal: 36,
          verifiedItemsBaseUnits: 6,
          verifiedItemsLedgerCount: 6,
          updatedAt: serverTimestamp(),
        })
      );
      // Slice 2: items 7..9 (3 items) -> transitions to pending_ledger
      await assertSucceeds(
        updateDoc(doc(cashier1Db, `branches/khalid-1/sales/${saleId}`), {
          syncState: 'pending_ledger',
          verifiedItemsCount: 10,
          verifiedItemsSubtotal: 60,
          verifiedItemsBaseUnits: 10,
          verifiedItemsLedgerCount: 10,
          updatedAt: serverTimestamp(),
        })
      );
      for (let i = 0; i < 10; i++) {
        await assertSucceeds(
          setDoc(doc(cashier1Db, `branches/khalid-1/inventory_ledger/${ledgerIds[i]}`), {
            id: ledgerIds[i],
            branchId: 'khalid-1',
            medicineId: i % 2 === 0 ? 'med-1' : 'med-2',
            type: 'SALE',
            unit: 'pill',
            quantityDelta: -1,
            baseUnitsDelta: -1,
            referenceId: saleId,
            saleItemId: buildDeterministicSaleItemId(saleId, i),
            saleItemIndex: i,
            userId: 'cashier-1',
            createdAt: serverTimestamp(),
          })
        );
      }
      // Ledger Slice 1: 0..5 (6 rows, exact 10-call Firestore Rules budget)
      await assertSucceeds(
        updateDoc(doc(cashier1Db, `branches/khalid-1/sales/${saleId}`), {
          syncState: 'pending_ledger',
          verifiedLedgerCount: 6,
          verifiedLedgerBaseUnits: 6,
          updatedAt: serverTimestamp(),
        })
      );
      // Ledger Slice 2: 7..9 -> verification_pending
      await assertSucceeds(
        updateDoc(doc(cashier1Db, `branches/khalid-1/sales/${saleId}`), {
          syncState: 'verification_pending',
          verifiedLedgerCount: 10,
          verifiedLedgerBaseUnits: 10,
          updatedAt: serverTimestamp(),
        })
      );
      // Complete
      await assertSucceeds(
        updateDoc(doc(cashier1Db, `branches/khalid-1/sales/${saleId}`), {
          syncState: 'complete',
          syncCompletedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-13', 'Sale syncState downgrade & post-complete mutation DENIED', async () => {
      await assertFails(
        updateDoc(doc(cashier1Db, 'branches/khalid-1/sales/sale-ok-1'), {
          syncState: 'pending_ledger',
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/sales/sale-ok-1'), {
          total: 999,
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-14', 'Admin metadata-only sale update allowed; financial field tamper denied', async () => {
      await assertSucceeds(
        updateDoc(doc(admin1Db, 'branches/khalid-1/sales/sale-ok-1'), {
          customer: 'Walk-in Updated',
          bankakTransactionId: 'BNK-2026-001',
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/sales/sale-ok-1'), {
          subtotal: 200,
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-15', 'PURCHASE_RETURN negative-only Admin ledger rule & Cashier DENY', async () => {
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/inventory_ledger/mov-pr-1'), {
          id: 'mov-pr-1',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: 'PURCHASE_RETURN',
          unit: 'pack',
          quantityDelta: -2,
          baseUnitsDelta: -40,
          userId: 'admin-1',
          createdAt: serverTimestamp(),
        })
      );
      // Positive PURCHASE_RETURN denied
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/inventory_ledger/mov-pr-pos'), {
          id: 'mov-pr-pos',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: 'PURCHASE_RETURN',
          unit: 'pack',
          quantityDelta: 2,
          baseUnitsDelta: 40,
          userId: 'admin-1',
          createdAt: serverTimestamp(),
        })
      );
      // Cashier PURCHASE_RETURN denied
      await assertFails(
        setDoc(doc(cashier1Db, 'branches/khalid-1/inventory_ledger/mov-pr-c1'), {
          id: 'mov-pr-c1',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: 'PURCHASE_RETURN',
          unit: 'pack',
          quantityDelta: -1,
          baseUnitsDelta: -20,
          userId: 'cashier-1',
          createdAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-16', 'TRANSFER_IN / TRANSFER_OUT hard-blocked in Rules & costing engine', async () => {
      for (const badType of ['TRANSFER_IN', 'TRANSFER_OUT'] as const) {
        await assertFails(
          setDoc(doc(admin1Db, `branches/khalid-1/inventory_ledger/mov-${badType}`), {
            id: `mov-${badType}`,
            branchId: 'khalid-1',
            medicineId: 'med-1',
            type: badType,
            unit: 'pack',
            quantityDelta: badType === 'TRANSFER_IN' ? 1 : -1,
            baseUnitsDelta: badType === 'TRANSFER_IN' ? 20 : -20,
            userId: 'admin-1',
            createdAt: serverTimestamp(),
          })
        );
        assert.throws(
          () =>
            resolveMovementHistoricalCost(
              {
                movementId: 'x',
                medicineId: 'med-1',
                movementType: badType,
                baseUnitsDelta: 1,
                quantityDelta: 1,
                baseUnitsPerMovementUnit: 1,
              },
              []
            ),
          /BLOCKED_MOVEMENT_TYPE/
        );
      }
    });

    // Exact Rational Historical Costing Matrix M-17 .. M-22
    let sharedLayers: FifoCostLayer[] = [];

    await runCase('M-17', 'Exact rational INITIAL & PURCHASE layers (100/3 exact fraction)', async () => {
      const r1 = resolveMovementHistoricalCost(
        {
          movementId: 'm-init',
          medicineId: 'med-1',
          movementType: 'INITIAL',
          baseUnitsDelta: 3,
          quantityDelta: 1,
          baseUnitsPerMovementUnit: 3,
          explicitUnitCostExact: normalizeRational(100, 1), // 100/3 per base unit!
        },
        []
      );
      assert.equal(r1.costStatus, 'EXACT_RECONCILED');
      assert.deepEqual(r1.costPerBaseUnitExact, { num: 100, den: 3 });

      const r2 = resolveMovementHistoricalCost(
        {
          movementId: 'm-pur',
          medicineId: 'med-1',
          movementType: 'PURCHASE',
          baseUnitsDelta: 6,
          quantityDelta: 2,
          baseUnitsPerMovementUnit: 3,
          explicitUnitCostExact: normalizeRational(120, 1), // 40 per base unit
        },
        r1.updatedLayers
      );
      assert.equal(r2.costStatus, 'EXACT_RECONCILED');
      assert.deepEqual(r2.costPerBaseUnitExact, { num: 40, den: 1 });
      sharedLayers = r2.updatedLayers;
    });

    await runCase('M-18', 'SALE multi-layer exact FIFO depletion', async () => {
      // Sell 5 base units: 3 @ 100/3 (= 100) + 2 @ 40 (= 80) = exact 180!
      const s = resolveMovementHistoricalCost(
        {
          movementId: 'm-sale',
          medicineId: 'med-1',
          movementType: 'SALE',
          baseUnitsDelta: -5,
          quantityDelta: -5,
          baseUnitsPerMovementUnit: 1,
        },
        sharedLayers
      );
      assert.equal(s.costStatus, 'EXACT_RECONCILED');
      assert.equal(compareRational(s.totalCostExact!, { num: 180, den: 1 }), 0);
      sharedLayers = s.updatedLayers;
    });

    await runCase('M-19', 'Customer RETURN uses original sale exact cost or fails closed to NEEDS_REVIEW', async () => {
      const okRet = resolveMovementHistoricalCost(
        {
          movementId: 'm-ret-ok',
          medicineId: 'med-1',
          movementType: 'RETURN',
          baseUnitsDelta: 2,
          quantityDelta: 2,
          baseUnitsPerMovementUnit: 1,
          originalSaleCostPerBaseUnitExact: { num: 36, den: 1 },
        },
        sharedLayers
      );
      assert.equal(okRet.costStatus, 'EXACT_RECONCILED');
      assert.deepEqual(okRet.totalCostExact, { num: 72, den: 1 });

      const badRet = resolveMovementHistoricalCost(
        {
          movementId: 'm-ret-missing',
          medicineId: 'med-1',
          movementType: 'RETURN',
          baseUnitsDelta: 2,
          quantityDelta: 2,
          baseUnitsPerMovementUnit: 1,
        },
        sharedLayers
      );
      assert.equal(badRet.costStatus, 'NEEDS_REVIEW');
      assert.equal(badRet.unresolvedBaseUnits, 2);
      sharedLayers = okRet.updatedLayers;
    });

    await runCase('M-20', 'PURCHASE_RETURN exact variance calculation vs supplier credit', async () => {
      // Remaining FIFO: 4 units @ 40 (=160), then 2 @ 36. Return 2 units @ supplier credit 35 (=70) -> variance = 70 - 80 = -10
      const pr = resolveMovementHistoricalCost(
        {
          movementId: 'm-pr-var',
          medicineId: 'med-1',
          movementType: 'PURCHASE_RETURN',
          baseUnitsDelta: -2,
          quantityDelta: -2,
          baseUnitsPerMovementUnit: 1,
          supplierCreditPerBaseUnitExact: { num: 35, den: 1 },
        },
        sharedLayers
      );
      assert.equal(pr.costStatus, 'EXACT_RECONCILED');
      assert.deepEqual(pr.totalCostExact, { num: 80, den: 1 });
      assert.deepEqual(pr.purchaseReturnVarianceExact, { num: -10, den: 1 });
      sharedLayers = pr.updatedLayers;
    });

    await runCase('M-21', 'DAMAGE & signed ADJUSTMENT costing semantics', async () => {
      const dmg = resolveMovementHistoricalCost(
        {
          movementId: 'm-dmg',
          medicineId: 'med-1',
          movementType: 'DAMAGE',
          baseUnitsDelta: -1,
          quantityDelta: -1,
          baseUnitsPerMovementUnit: 1,
        },
        sharedLayers
      );
      assert.equal(dmg.costStatus, 'EXACT_RECONCILED');
      assert.deepEqual(dmg.totalCostExact, { num: 40, den: 1 });

      const posAdjMissing = resolveMovementHistoricalCost(
        {
          movementId: 'm-adj-empty',
          medicineId: 'med-1',
          movementType: 'ADJUSTMENT',
          baseUnitsDelta: 3,
          quantityDelta: 3,
          baseUnitsPerMovementUnit: 1,
        },
        []
      );
      assert.equal(posAdjMissing.costStatus, 'NEEDS_REVIEW');
      assert.equal(posAdjMissing.unresolvedBaseUnits, 3);
    });

    await runCase('M-22', 'Insufficient cost layers on SALE fails closed to NEEDS_REVIEW (zero buyPrice fallback)', async () => {
      const shortSale = resolveMovementHistoricalCost(
        {
          movementId: 'm-sale-short',
          medicineId: 'med-1',
          movementType: 'SALE',
          baseUnitsDelta: -50,
          quantityDelta: -50,
          baseUnitsPerMovementUnit: 1,
        },
        [{ layerId: 'l1', remainingBaseUnits: 10, costPerBaseUnitExact: { num: 5, den: 1 } }]
      );
      assert.equal(shortSale.costStatus, 'NEEDS_REVIEW');
      assert.equal(shortSale.unresolvedBaseUnits, 40);
      assert.equal(shortSale.totalCostExact, null);
    });

    await runCase('M-23', 'Admin reconciliation concurrency lease (runTransaction) blocks concurrent hijack', async () => {
      const c1 = await claimOrTakeoverSaleReconciliationLease(
        admin1Db,
        'khalid-1',
        'sale-ok-1',
        'admin-1',
        1,
        1500 // 1.5s short lease for M-24 takeover test
      );
      assert.equal(c1.claimed, true);
      assert.equal(c1.leaseVersion, 1);

      // Admin 1B sees lease held by other
      const c2 = await claimOrTakeoverSaleReconciliationLease(
        admin1bDb,
        'khalid-1',
        'sale-ok-1',
        'admin-1b',
        1,
        60_000
      );
      assert.equal(c2.claimed, false);
      assert.equal(c2.status, 'LEASE_HELD_BY_OTHER');

      // Direct Rules hijack attempt by Admin 1B while active MUST fail!
      await assertFails(
        updateDoc(doc(admin1bDb, 'branches/khalid-1/sales_financials/sale-ok-1'), {
          reconciliationStatus: 'RECONCILING',
          leaseOwnerUid: 'admin-1b',
          leaseExpiresAt: Timestamp.fromMillis(Date.now() + 60_000),
          leaseVersion: 2,
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-24', 'Expired reconciliation lease takeover & atomic EXACT_RECONCILED finalization', async () => {
      // Wait for M-23's 1.5s lease to expire against real Firestore request.time
      await sleep(2200);
      const takeover = await claimOrTakeoverSaleReconciliationLease(
        admin1bDb,
        'khalid-1',
        'sale-ok-1',
        'admin-1b',
        1,
        60_000
      );
      assert.equal(takeover.claimed, true);
      assert.equal(takeover.leaseVersion, 2);

      const mr = resolveMovementHistoricalCost(
        {
          movementId: 'mov-sale-ok-1',
          medicineId: 'med-1',
          movementType: 'SALE',
          baseUnitsDelta: -20,
          quantityDelta: -1,
          baseUnitsPerMovementUnit: 20,
        },
        [{ layerId: 'mov-pur-1', remainingBaseUnits: 200, costPerBaseUnitExact: { num: 4, den: 1 } }]
      );

      const fin = await finalizeSaleFinancialReconciliation(admin1bDb, {
        branchId: 'khalid-1',
        saleId: 'sale-ok-1',
        adminUid: 'admin-1b',
        expectedLeaseVersion: takeover.leaseVersion,
        saleSubtotal: 120,
        saleTotal: 120,
        movementResults: [mr],
        operationId: 'op-fin-sale-ok-1',
      });
      assert.equal(fin.status, 'EXACT_RECONCILED');
      assert.equal(fin.unresolvedBaseUnits, 0);

      const sfSnap = await assertSucceeds(getDoc(doc(admin1bDb, 'branches/khalid-1/sales_financials/sale-ok-1')));
      assert.equal(sfSnap.data()?.reconciliationStatus, 'EXACT_RECONCILED');
      assert.deepEqual(sfSnap.data()?.costOfGoodsExact, { num: 80, den: 1 });
      assert.deepEqual(sfSnap.data()?.grossProfitExact, { num: 40, den: 1 });
    });

    await runCase('M-25', 'Terminal EXACT_RECONCILED immutability (even Super Admin cannot mutate)', async () => {
      await assertFails(
        updateDoc(doc(superDb, 'branches/khalid-1/sales_financials/sale-ok-1'), {
          reconciliationStatus: 'NEEDS_REVIEW',
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-26', 'Unresolved sale transitions to NEEDS_REVIEW; cannot claim EXACT_RECONCILED with unresolved > 0', async () => {
      const claim = await claimOrTakeoverSaleReconciliationLease(
        admin1Db,
        'khalid-1',
        'sale-swap-1',
        'admin-1',
        2,
        60_000
      );
      assert.equal(claim.claimed, true);

      // Rules block claiming EXACT_RECONCILED with unresolvedBaseUnits > 0
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/sales_financials/sale-swap-1'), {
          reconciliationStatus: 'EXACT_RECONCILED',
          verifiedFinancialLedgerCount: 2,
          unresolvedBaseUnits: 5,
          reconciledByUid: 'admin-1',
          reconciledAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );

      // Legitimate NEEDS_REVIEW transition succeeds
      const unresolvedRes = resolveMovementHistoricalCost(
        {
          movementId: 'mov-swap-0',
          medicineId: 'med-1',
          movementType: 'SALE',
          baseUnitsDelta: -5,
          quantityDelta: -5,
          baseUnitsPerMovementUnit: 1,
        },
        []
      );
      const res = await finalizeSaleFinancialReconciliation(admin1Db, {
        branchId: 'khalid-1',
        saleId: 'sale-swap-1',
        adminUid: 'admin-1',
        expectedLeaseVersion: claim.leaseVersion,
        saleSubtotal: 60,
        saleTotal: 60,
        movementResults: [unresolvedRes],
        operationId: 'op-needs-review-1',
      });
      assert.equal(res.status, 'NEEDS_REVIEW');
      assert.equal(res.unresolvedBaseUnits, 5);
    });

    await runCase('M-27', 'super_admin /branches list succeeds; cashier/admin unfiltered list denied', async () => {
      const allBranches = await assertSucceeds(getDocs(collection(superDb, 'branches')));
      assert.equal(allBranches.size, 3);

      // Unfiltered list denied for cashier-1 & admin-1
      await assertFails(getDocs(collection(cashier1Db, 'branches')));
      await assertFails(getDocs(collection(admin1Db, 'branches')));

      // Assigned active scoped list succeeds for cashier-1 & admin-1 (inactive branches excluded by rule)
      const cBranches = await assertSucceeds(
        getDocs(query(collection(cashier1Db, 'branches'), where('active', '==', true), where('memberUids', 'array-contains', 'cashier-1')))
      );
      assert.equal(cBranches.size, 1); // only active khalid-1
      const aBranches = await assertSucceeds(
        getDocs(query(collection(admin1Db, 'branches'), where('active', '==', true), where('adminUids', 'array-contains', 'admin-1')))
      );
      assert.equal(aBranches.size, 1); // only active khalid-1
    });

    await runCase('M-28', 'audit_logs actorRole spoofing blocked by hasMatchingAuditActorRole', async () => {
      // Cashier spoofing actorRole: 'admin' MUST FAIL
      await assertFails(
        setDoc(doc(cashier1Db, 'branches/khalid-1/audit_logs/aud-spoof'), {
          id: 'aud-spoof',
          branchId: 'khalid-1',
          actorUid: 'cashier-1',
          actorRole: 'admin',
          action: 'SALE_CREATED',
          createdAt: serverTimestamp(),
        })
      );
      // Cashier with honest actorRole: 'cashier' SUCCEEDS
      await assertSucceeds(
        setDoc(doc(cashier1Db, 'branches/khalid-1/audit_logs/aud-ok'), {
          id: 'aud-ok',
          branchId: 'khalid-1',
          actorUid: 'cashier-1',
          actorRole: 'cashier',
          action: 'SALE_CREATED',
          createdAt: serverTimestamp(),
        })
      );
      // Cashier reading audit_logs DENIED; Admin reading ALLOWED
      await assertFails(getDoc(doc(cashier1Db, 'branches/khalid-1/audit_logs/aud-ok')));
      await assertSucceeds(getDoc(doc(admin1Db, 'branches/khalid-1/audit_logs/aud-ok')));
    });

    await runCase('M-29', 'Cross-branch & inactive-branch isolation enforced', async () => {
      await assertFails(getDoc(doc(cashier1Db, 'branches/khalid-2/medicines/med-b2')));
      await assertFails(getDoc(doc(admin1Db, 'branches/khalid-2/medicines/med-b2')));
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-inactive/medicines/med-inact'), makeOperationalMedicine('khalid-inactive', 'med-inact'))
      );
    });

    recordNonEmulatorBoundary(
      'M-30',
      'Browser SOP / IndexedDB / LocalStorage origin isolation boundary',
      'NOT EXECUTABLE IN FIRESTORE EMULATOR — requires browser E2E/SOP verification per R3.2'
    );

    await runCase('M-31', 'Unauthenticated, unverified email, inactive user, and forged pharmacist role DENIED', async () => {
      await assertFails(getDoc(doc(unauthDb, 'branches/khalid-1/medicines/med-1')));
      await assertFails(getDoc(doc(unverifiedDb, 'branches/khalid-1/medicines/med-1')));
      await assertFails(getDoc(doc(inactiveDb, 'branches/khalid-1/medicines/med-1')));
      await assertFails(
        setDoc(doc(superDb, 'users/pharm-1'), {
          uid: 'pharm-1',
          email: 'pharm@khalid.test',
          displayName: 'Pharmacist',
          role: 'pharmacist',
          branchIds: ['khalid-1'],
          activeBranchId: 'khalid-1',
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-32', 'Medicine V2 sticky packingLocked & immutable openingStockEvidence preserved', async () => {
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/medicines/med-locked'), {
          ...makeOperationalMedicine('khalid-1', 'med-locked', {
            packingLocked: true,
            packingLockedAt: '2026-11-26T00:00:00Z',
            packingLockReason: 'MOVEMENT_EXISTS',
            openingStockEvidence: {
              mode: 'POSITIVE',
              intendedInitialStock: 5,
              intendedBaseUnits: 100,
              initialLedgerMovementId: 'mov-init-locked',
              recordedAt: '2026-11-26T00:00:00.000Z',
            },
          }),
        })
      );
      // Trying to unlock packingLocked or mutate baseUnitsPerPack MUST FAIL
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/medicines/med-locked'), {
          packingLocked: false,
          syncVersion: 2,
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/medicines/med-locked'), {
          openingStockEvidence: { source: 'EXPLICIT_ZERO', intendedInitialStock: 0, intendedBaseUnits: 0 },
          syncVersion: 2,
          updatedAt: serverTimestamp(),
        })
      );
      // Matching INITIAL movement succeeds; forged amount fails
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/inventory_ledger/mov-init-locked'), {
          id: 'mov-init-locked',
          branchId: 'khalid-1',
          medicineId: 'med-locked',
          type: 'INITIAL',
          unit: 'pack',
          quantityDelta: 99,
          baseUnitsDelta: 1980,
          userId: 'admin-1',
          createdAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/inventory_ledger/mov-init-locked'), {
          id: 'mov-init-locked',
          branchId: 'khalid-1',
          medicineId: 'med-locked',
          type: 'INITIAL',
          unit: 'pack',
          quantityDelta: 5,
          baseUnitsDelta: 100,
          userId: 'admin-1',
          createdAt: serverTimestamp(),
        })
      );
    });

    await runCase('M-33', 'suppliers & purchase_invoices remain Admin-only (Cashier DENIED)', async () => {
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/suppliers/sup-1'), {
          id: 'sup-1',
          branchId: 'khalid-1',
          name: 'Al-Shifa Pharma',
          balance: 0,
          status: 'active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(getDoc(doc(cashier1Db, 'branches/khalid-1/suppliers/sup-1')));
      await assertFails(
        getDocs(query(collection(cashier1Db, 'branches/khalid-1/suppliers'), where('branchId', '==', 'khalid-1')))
      );
      await assertFails(
        getDocs(query(collection(cashier1Db, 'branches/khalid-1/purchase_invoices'), where('branchId', '==', 'khalid-1')))
      );
    });

    // =========================================================================
    // PART 2: PHASE 2F STOCKTAKE SECURITY & CONCURRENCY (ST-01 .. ST-15)
    // =========================================================================

    const sessId = 'st-v2-sess-1';
    const sessPath = `branches/khalid-1/stocktake_sessions_v2/${sessId}`;

    await runCase('ST-01', 'Admin creates Phase 2F session & items; Cashier create DENIED', async () => {
      await assertFails(
        setDoc(doc(cashier1Db, sessPath), {
          id: sessId,
          branchId: 'khalid-1',
          sessionNumber: 'ST-2026-0001',
          schemaVersion: 2,
          scopeMode: 'FULL',
          status: 'DRAFT',
          totalTargetItems: 2,
          createdByUid: 'cashier-1',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, sessPath), {
          id: sessId,
          branchId: 'khalid-1',
          sessionNumber: 'ST-2026-0001',
          schemaVersion: 2,
          scopeMode: 'FULL',
          status: 'DRAFT',
          totalTargetItems: 2,
          createdByUid: 'admin-1',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      for (const medId of ['med-1', 'med-2']) {
        await assertSucceeds(
          setDoc(doc(admin1Db, `${sessPath}/items/${medId}`), {
            id: medId,
            branchId: 'khalid-1',
            sessionId: sessId,
            medicineId: medId,
            medicineName: `Panadol ${medId}`,
            state: 'AVAILABLE',
            syncStatus: 'CONFIRMED',
            activeLease: null,
            leaseVersion: 0,
            countRevision: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      }
      // Transition DRAFT -> IN_PROGRESS
      await assertSucceeds(
        updateDoc(doc(admin1Db, sessPath), {
          status: 'IN_PROGRESS',
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('ST-02', 'Cashier reads blind operational session & items (zero financial/systemQty keys)', async () => {
      const sSnap = await assertSucceeds(getDoc(doc(cashier1Db, sessPath)));
      const iSnap = await assertSucceeds(getDoc(doc(cashier1Db, `${sessPath}/items/med-1`)));
      assertNoCashierForbiddenFields(sSnap.data(), 'stocktake_sessions_v2');
      assertNoCashierForbiddenFields(iSnap.data(), 'stocktake_sessions_v2/items/med-1');
      assert.equal('systemQty' in (iSnap.data() ?? {}), false);
      assert.equal('sellPrice' in (iSnap.data() ?? {}), false);
    });

    await runCase('ST-03', 'Cashier acquires server-time CAS lease (AVAILABLE -> RESERVED)', async () => {
      const itemRef = doc(cashier1Db, `${sessPath}/items/med-1`);
      await assertSucceeds(
        updateDoc(itemRef, {
          state: 'RESERVED',
          leaseVersion: 1,
          activeLease: {
            leaseId: 'lease-c1-1',
            ownerUid: 'cashier-1',
            ownerDisplayName: 'Cashier 1',
            deviceId: 'dev-c1',
            leaseVersion: 1,
            renewalCount: 0,
            createdAt: serverTimestamp(),
            expiresAt: Timestamp.fromMillis(Date.now() + 120_000),
          },
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('ST-04', 'Concurrent 2-cashier CAS race blocks Cashier 1B steal while lease active', async () => {
      await assertFails(
        updateDoc(doc(cashier1bDb, `${sessPath}/items/med-1`), {
          state: 'RESERVED',
          leaseVersion: 2,
          activeLease: {
            leaseId: 'lease-c1b-steal',
            ownerUid: 'cashier-1b',
            ownerDisplayName: 'Cashier 1B',
            deviceId: 'dev-c1b',
            leaseVersion: 2,
            renewalCount: 0,
            createdAt: serverTimestamp(),
            expiresAt: Timestamp.fromMillis(Date.now() + 120_000),
          },
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('ST-05', 'Lease holder renew succeeds; non-owner renew & >10m duration DENIED', async () => {
      const snap = await getDoc(doc(cashier1Db, `${sessPath}/items/med-1`));
      const curLease = snap.data()!.activeLease;

      // Excessive duration (>10m) denied
      await assertFails(
        updateDoc(doc(cashier1Db, `${sessPath}/items/med-1`), {
          activeLease: {
            ...curLease,
            renewalCount: 1,
            expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60_000),
          },
          updatedAt: serverTimestamp(),
        })
      );
      // Non-owner renew denied
      await assertFails(
        updateDoc(doc(cashier1bDb, `${sessPath}/items/med-1`), {
          activeLease: {
            ...curLease,
            renewalCount: 1,
            expiresAt: Timestamp.fromMillis(Date.now() + 120_000),
          },
          updatedAt: serverTimestamp(),
        })
      );
      // Legitimate owner renew succeeds
      await assertSucceeds(
        updateDoc(doc(cashier1Db, `${sessPath}/items/med-1`), {
          activeLease: {
            ...curLease,
            renewalCount: 1,
            expiresAt: Timestamp.fromMillis(Date.now() + 180_000),
          },
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('ST-06', 'Real server-time request.time lease expiry allows Cashier 1B takeover on med-2', async () => {
      // Cashier 1 acquires a short 1500ms lease on med-2
      await assertSucceeds(
        updateDoc(doc(cashier1Db, `${sessPath}/items/med-2`), {
          state: 'RESERVED',
          leaseVersion: 1,
          activeLease: {
            leaseId: 'lease-short-c1',
            ownerUid: 'cashier-1',
            ownerDisplayName: 'Cashier 1',
            deviceId: 'dev-c1',
            leaseVersion: 1,
            renewalCount: 0,
            createdAt: serverTimestamp(),
            expiresAt: Timestamp.fromMillis(Date.now() + 1500),
          },
          updatedAt: serverTimestamp(),
        })
      );
      await sleep(2200);
      // Now request.time > expiresAt -> Cashier 1B takes over cleanly
      await assertSucceeds(
        updateDoc(doc(cashier1bDb, `${sessPath}/items/med-2`), {
          state: 'RESERVED',
          leaseVersion: 2,
          activeLease: {
            leaseId: 'lease-takeover-c1b',
            ownerUid: 'cashier-1b',
            ownerDisplayName: 'Cashier 1B',
            deviceId: 'dev-c1b',
            leaseVersion: 2,
            renewalCount: 0,
            createdAt: serverTimestamp(),
            expiresAt: Timestamp.fromMillis(Date.now() + 120_000),
          },
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('ST-07', 'Atomic count submission (count_events + item COUNTED) in single runTransaction', async () => {
      const itemRef = doc(cashier1Db, `${sessPath}/items/med-1`);
      const evId = 'med-1__r1';
      const evRef = doc(cashier1Db, `${sessPath}/count_events/${evId}`);

      await assertSucceeds(
        runTransaction(cashier1Db, async (tx) => {
          const itemSnap = await tx.get(itemRef);
          const item = itemSnap.data()!;
          assert.equal(item.state, 'RESERVED');
          tx.set(evRef, {
            eventId: evId,
            idempotencyKey: 'idem-med1-rev1-key',
            sessionId: sessId,
            branchId: 'khalid-1',
            medicineId: 'med-1',
            countRevision: 1,
            leaseId: item.activeLease.leaseId,
            leaseVersion: item.leaseVersion,
            countedQuantity: 9,
            countUnit: 'pack',
            baseUnitsPerCountUnit: 20,
            countedBaseUnits: 180,
            actorUid: 'cashier-1',
            actorDisplayName: 'Cashier 1',
            deviceId: 'dev-c1',
            watermark: {
              countBusinessAtMs: Date.now(),
              localPersistedAtMs: Date.now(),
              knownMovementIdsAtCount: ['mov-pur-1', 'mov-sale-ok-1'],
              knownMovementCount: 2,
              watermarkDigest: 'sha256-test-digest-1',
            },
            createdAt: serverTimestamp(),
          });
          // OD-4 / Fix A: Shared item doc holds ONLY workflow/concurrency metadata (ZERO count quantity/actor)
          tx.update(itemRef, {
            state: 'COUNTED',
            activeLease: null,
            leaseVersion: item.leaseVersion + 1,
            countRevision: item.countRevision + 1,
            updatedAt: serverTimestamp(),
          });
        })
      );
    });

    await runCase('ST-08', 'Orphan count_event without active lease & count_event update/delete DENIED', async () => {
      await assertFails(
        setDoc(doc(cashier1Db, `${sessPath}/count_events/evt-orphan`), {
          eventId: 'evt-orphan',
          idempotencyKey: 'idem-orphan-key',
          sessionId: sessId,
          branchId: 'khalid-1',
          medicineId: 'med-1', // Already COUNTED, not RESERVED!
          countRevision: 2,
          leaseId: 'lease-c1-1',
          leaseVersion: 1,
          countedQuantity: 5,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 20,
          countedBaseUnits: 100,
          actorUid: 'cashier-1',
          deviceId: 'dev-c1',
          watermark: {
            countBusinessAtMs: Date.now(),
            localPersistedAtMs: Date.now(),
            knownMovementIdsAtCount: [],
            knownMovementCount: 0,
            watermarkDigest: 'digest',
          },
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(updateDoc(doc(admin1Db, `${sessPath}/count_events/med-1__r1`), { countedQuantity: 99 }));
      await assertFails(deleteDoc(doc(admin1Db, `${sessPath}/count_events/med-1__r1`)));
    });

    await runCase('ST-09', 'Financial & system-stock field smuggling into Domain A stocktake DENIED', async () => {
      await assertFails(
        setDoc(doc(admin1Db, `${sessPath}/items/med-smuggle`), {
          id: 'med-smuggle',
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-1',
          medicineName: 'Smuggle',
          state: 'AVAILABLE',
          syncStatus: 'CONFIRMED',
          activeLease: null,
          leaseVersion: 0,
          countRevision: 0,
          buyPrice: 80,
          systemQty: 200,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('ST-10', 'ABSOLUTE Cashier DENY on Phase 2F Domain B stocktake_financials & ALL 4 subcollections', async () => {
      const finPath = `branches/khalid-1/stocktake_financials/${sessId}`;
      // Seed Admin docs first (verified in ST-11 too)
      await assertSucceeds(
        setDoc(doc(admin1Db, finPath), {
          id: sessId,
          branchId: 'khalid-1',
          sessionId: sessId,
          reconciliationStatus: 'RECONCILING',
          totalExpectedValuationExact: { num: 720, den: 1 },
          totalSystemValuationExact: { num: 720, den: 1 },
          netVarianceValuationExact: { num: 0, den: 1 },
          unresolvedItemsCount: 0,
          updatedByUid: 'admin-1',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, `${finPath}/lines/med-1`), {
          id: 'med-1',
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-1',
          varianceBaseUnits: 0,
          updatedByUid: 'admin-1',
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, `${finPath}/approvals/apr-1`), {
          id: 'apr-1',
          branchId: 'khalid-1',
          sessionId: sessId,
          approvedByUid: 'admin-1',
          createdAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, `${finPath}/postings/post-1`), {
          id: 'post-1',
          branchId: 'khalid-1',
          sessionId: sessId,
          postedByUid: 'admin-1',
          createdAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, `${finPath}/financial_audit/faud-1`), {
          id: 'faud-1',
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'admin-1',
          actorRole: 'admin',
          action: 'FINANCIAL_RECONCILED',
          createdAt: serverTimestamp(),
        })
      );

      // Cashier get, list, and write on ALL 5 Domain B paths MUST FAIL!
      for (const rel of [
        finPath,
        `${finPath}/lines/med-1`,
        `${finPath}/approvals/apr-1`,
        `${finPath}/postings/post-1`,
        `${finPath}/financial_audit/faud-1`,
      ]) {
        await assertFails(getDoc(doc(cashier1Db, rel)));
        await assertFails(setDoc(doc(cashier1Db, rel), { hack: true }));
      }
      for (const colPath of [
        'branches/khalid-1/stocktake_financials',
        `${finPath}/lines`,
        `${finPath}/approvals`,
        `${finPath}/postings`,
        `${finPath}/financial_audit`,
      ]) {
        await assertFails(getDocs(query(collection(cashier1Db, colPath), where('branchId', '==', 'khalid-1'))));
      }
    });

    await runCase('ST-11', 'Domain B approvals, postings, financial_audit immutability enforced', async () => {
      const finPath = `branches/khalid-1/stocktake_financials/${sessId}`;
      await assertFails(updateDoc(doc(admin1Db, `${finPath}/approvals/apr-1`), { approvedByUid: 'admin-1' }));
      await assertFails(deleteDoc(doc(admin1Db, `${finPath}/approvals/apr-1`)));
      await assertFails(updateDoc(doc(admin1Db, `${finPath}/postings/post-1`), { postedByUid: 'admin-1' }));
      await assertFails(deleteDoc(doc(admin1Db, `${finPath}/postings/post-1`)));
      await assertFails(updateDoc(doc(admin1Db, `${finPath}/financial_audit/faud-1`), { action: 'EDITED' }));
      await assertFails(deleteDoc(doc(admin1Db, `${finPath}/financial_audit/faud-1`)));
    });

    await runCase('ST-12', 'Admin NEEDS_RECOUNT & VERIFIED transitions; Cashier DENIED', async () => {
      // Cashier cannot mark VERIFIED or NEEDS_RECOUNT
      await assertFails(
        updateDoc(doc(cashier1Db, `${sessPath}/items/med-1`), {
          state: 'VERIFIED',
          updatedAt: serverTimestamp(),
        })
      );
      // Admin requests recount on med-1
      await assertSucceeds(
        updateDoc(doc(admin1Db, `${sessPath}/items/med-1`), {
          state: 'NEEDS_RECOUNT',
          activeLease: null,
          leaseVersion: 3,
          recountReason: 'Variance exceeds threshold; recount shelf A2',
          operationalDiscrepancyFlag: true,
          updatedAt: serverTimestamp(),
        })
      );
    });

    await runCase('ST-13', 'operational_audit enforces hasMatchingAuditActorRole & Admin-only read', async () => {
      await assertFails(
        setDoc(doc(cashier1Db, `${sessPath}/operational_audit/oaud-spoof`), {
          id: 'oaud-spoof',
          branchId: 'khalid-1',
          sessionId: sessId,
          action: 'COUNT_SUBMITTED',
          actorUid: 'cashier-1',
          actorRole: 'admin',
          deviceId: 'dev-c1',
          summary: 'Spoof attempt',
          createdAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(cashier1Db, `${sessPath}/operational_audit/oaud-ok`), {
          id: 'oaud-ok',
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-1',
          action: 'COUNT_SUBMITTED',
          actorUid: 'cashier-1',
          actorRole: 'cashier',
          deviceId: 'dev-c1',
          summary: 'Submitted count revision 1',
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(getDoc(doc(cashier1Db, `${sessPath}/operational_audit/oaud-ok`)));
      await assertSucceeds(getDoc(doc(admin1Db, `${sessPath}/operational_audit/oaud-ok`)));
    });

    await runCase('ST-14', 'Retired Legacy stocktaking_sessions & items: Admin historical READ-ONLY, ALL writes & Cashier DENIED', async () => {
      // Admin & Super Admin CAN read historical legacy records (OD-2 preservation!)
      await assertSucceeds(getDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/legacy-sess-1')));
      await assertSucceeds(
        getDoc(doc(superDb, 'branches/khalid-1/stocktaking_sessions/legacy-sess-1/items/legacy-item-1'))
      );
      await assertSucceeds(
        getDocs(query(collection(admin1Db, 'branches/khalid-1/stocktaking_sessions'), where('branchId', '==', 'khalid-1')))
      );

      // Cashier CANNOT read or write legacy records
      await assertFails(getDoc(doc(cashier1Db, 'branches/khalid-1/stocktaking_sessions/legacy-sess-1')));
      await assertFails(
        getDoc(doc(cashier1Db, 'branches/khalid-1/stocktaking_sessions/legacy-sess-1/items/legacy-item-1'))
      );

      // ALL writes (create, update, delete) DENIED even for Admin & Super Admin!
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/new-legacy-blocked'), {
          id: 'new-legacy-blocked',
          branchId: 'khalid-1',
          status: 'in_progress',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(superDb, 'branches/khalid-1/stocktaking_sessions/legacy-sess-1'), {
          title: 'Mutated Legacy',
        })
      );
      await assertFails(deleteDoc(doc(superDb, 'branches/khalid-1/stocktaking_sessions/legacy-sess-1')));
      await assertFails(
        deleteDoc(doc(superDb, 'branches/khalid-1/stocktaking_sessions/legacy-sess-1/items/legacy-item-1'))
      );
    });

    await runCase('ST-15', 'Phase 2F session terminal lifecycle lock & Domain B cross-document gate (CLOSED cannot revert or delete)', async () => {
      const finPath = `branches/khalid-1/stocktake_financials/${sessId}`;
      await assertSucceeds(
        updateDoc(doc(admin1Db, sessPath), {
          status: 'RECONCILING',
          updatedAt: serverTimestamp(),
        })
      );
      // F-05: Cannot transition to PENDING_APPROVAL while stocktake_financials is still RECONCILING
      await assertFails(
        updateDoc(doc(admin1Db, sessPath), {
          status: 'PENDING_APPROVAL',
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, finPath), {
          reconciliationStatus: 'PENDING_APPROVAL',
          unresolvedItemsCount: 0,
          updatedByUid: 'admin-1',
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, sessPath), {
          status: 'PENDING_APPROVAL',
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, sessPath), {
          status: 'APPROVED',
          updatedAt: serverTimestamp(),
        })
      );
      // F-05: Cannot transition APPROVED -> POSTED unless stocktake_financials is POSTED with approvedByUid and postedByUid
      await assertFails(
        updateDoc(doc(admin1Db, sessPath), {
          status: 'POSTED',
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, finPath), {
          reconciliationStatus: 'POSTED',
          approvedByUid: 'admin-1',
          approvedAt: serverTimestamp(),
          postedByUid: 'admin-1',
          postedAt: serverTimestamp(),
          updatedByUid: 'admin-1',
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, sessPath), {
          status: 'POSTED',
          updatedAt: serverTimestamp(),
        })
      );
      // F-05: Cannot transition POSTED -> CLOSED without closedAt == request.time
      await assertFails(
        updateDoc(doc(admin1Db, sessPath), {
          status: 'CLOSED',
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, sessPath), {
          status: 'CLOSED',
          closedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      // Cannot reopen CLOSED session or delete it
      await assertFails(
        updateDoc(doc(admin1Db, sessPath), {
          status: 'IN_PROGRESS',
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(deleteDoc(doc(admin1Db, sessPath)));
    });


    await runCase('ST-16', 'Adversarial clock manipulation on lease acquire (+30m future / -5m past) DENIED by request.time', async () => {
      const advSessId = 'st-v2-adv-lease';
      const advSessPath = `branches/khalid-1/stocktake_sessions_v2/${advSessId}`;
      const b = writeBatch(admin1Db);
      b.set(doc(admin1Db, advSessPath), {
        id: advSessId,
        branchId: 'khalid-1',
        sessionNumber: 'ST-2026-ADV1',
        schemaVersion: 2,
        scopeMode: 'PARTIAL',
        status: 'DRAFT',
        totalTargetItems: 1,
        createdByUid: 'admin-1',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      b.set(doc(admin1Db, `${advSessPath}/items/med-1`), {
        id: 'med-1',
        branchId: 'khalid-1',
        sessionId: advSessId,
        medicineId: 'med-1',
        medicineName: 'Panadol med-1',
        state: 'AVAILABLE',
        syncStatus: 'CONFIRMED',
        activeLease: null,
        leaseVersion: 0,
        countRevision: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await assertSucceeds(b.commit());
      await assertSucceeds(updateDoc(doc(admin1Db, advSessPath), { status: 'IN_PROGRESS', updatedAt: serverTimestamp() }));

      const advItemRef = doc(cashier1Db, `${advSessPath}/items/med-1`);
      // Manipulated +30m future clock -> DENIED (> request.time + 10m)
      await assertFails(updateDoc(advItemRef, {
        state: 'RESERVED',
        leaseVersion: 1,
        activeLease: {
          leaseId: 'lease-future-30m',
          ownerUid: 'cashier-1',
          deviceId: 'dev-c1',
          leaseVersion: 1,
          renewalCount: 0,
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + 30 * 60_000),
        },
        updatedAt: serverTimestamp(),
      }));
      // Manipulated -5m past clock -> DENIED (<= request.time)
      await assertFails(updateDoc(advItemRef, {
        state: 'RESERVED',
        leaseVersion: 1,
        activeLease: {
          leaseId: 'lease-past-5m',
          ownerUid: 'cashier-1',
          deviceId: 'dev-c1',
          leaseVersion: 1,
          renewalCount: 0,
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() - 5 * 60_000),
        },
        updatedAt: serverTimestamp(),
      }));
      // Legitimate 90s TTL -> SUCCEEDS
      await assertSucceeds(updateDoc(advItemRef, {
        state: 'RESERVED',
        leaseVersion: 1,
        activeLease: {
          leaseId: 'lease-valid-1',
          ownerUid: 'cashier-1',
          deviceId: 'dev-c1',
          leaseVersion: 1,
          renewalCount: 0,
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + 90_000),
        },
        updatedAt: serverTimestamp(),
      }));
    });

    await runCase('ST-17', 'Adversarial lease renewal (+20m future, >30m cumulative cap, >12 renewals, expired renew) DENIED', async () => {
      const advSessPath = 'branches/khalid-1/stocktake_sessions_v2/st-v2-adv-lease';
      const advItemRef = doc(cashier1Db, `${advSessPath}/items/med-1`);
      const curSnap = await assertSucceeds(getDoc(advItemRef));
      const curLease = curSnap.data()!.activeLease;

      // Renew with +20m future clock -> DENIED (> request.time + 10m)
      await assertFails(updateDoc(advItemRef, {
        activeLease: {
          ...curLease,
          renewalCount: 1,
          expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60_000),
        },
        updatedAt: serverTimestamp(),
      }));

      // Seed a lease whose createdAt was 29m ago and try to renew +5m (exceeds 30m cumulative ceiling!) -> DENIED
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const sDb = ctx.firestore();
        await updateDoc(doc(sDb, `${advSessPath}/items/med-1`), {
          activeLease: {
            ...curLease,
            createdAt: Timestamp.fromMillis(Date.now() - 29 * 60_000),
            expiresAt: Timestamp.fromMillis(Date.now() + 30_000),
            renewalCount: 3,
          },
        });
      });
      const oldSnap = await assertSucceeds(getDoc(advItemRef));
      const oldLease = oldSnap.data()!.activeLease;
      await assertFails(updateDoc(advItemRef, {
        activeLease: {
          ...oldLease,
          renewalCount: 4,
          expiresAt: Timestamp.fromMillis(Date.now() + 5 * 60_000),
        },
        updatedAt: serverTimestamp(),
      }));

      // Seed renewalCount == 12 and try 13th renewal -> DENIED
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const sDb = ctx.firestore();
        await updateDoc(doc(sDb, `${advSessPath}/items/med-1`), {
          activeLease: {
            ...curLease,
            createdAt: Timestamp.fromMillis(Date.now() - 60_000),
            expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
            renewalCount: 12,
          },
        });
      });
      const capSnap = await assertSucceeds(getDoc(advItemRef));
      const capLease = capSnap.data()!.activeLease;
      await assertFails(updateDoc(advItemRef, {
        activeLease: {
          ...capLease,
          renewalCount: 13,
          expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
        },
        updatedAt: serverTimestamp(),
      }));

      // Seed already-expired lease and try to renew -> DENIED (request.time > prevLease.expiresAt)
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const sDb = ctx.firestore();
        await updateDoc(doc(sDb, `${advSessPath}/items/med-1`), {
          activeLease: {
            ...curLease,
            createdAt: Timestamp.fromMillis(Date.now() - 120_000),
            expiresAt: Timestamp.fromMillis(Date.now() - 2_000),
            renewalCount: 1,
          },
        });
      });
      const expSnap = await assertSucceeds(getDoc(advItemRef));
      const expLease = expSnap.data()!.activeLease;
      await assertFails(updateDoc(advItemRef, {
        activeLease: {
          ...expLease,
          renewalCount: 2,
          expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
        },
        updatedAt: serverTimestamp(),
      }));
    });

    await runCase('ST-18', 'Session initialization atomicity: direct IN_PROGRESS DENIED, DRAFT un-leasable, post-IN_PROGRESS item add DENIED', async () => {
      const directPath = 'branches/khalid-1/stocktake_sessions_v2/st-v2-direct-bad';
      // Direct creation in IN_PROGRESS -> DENIED (must initialize in DRAFT!)
      await assertFails(setDoc(doc(admin1Db, directPath), {
        id: 'st-v2-direct-bad',
        branchId: 'khalid-1',
        sessionNumber: 'ST-2026-BAD',
        schemaVersion: 2,
        scopeMode: 'PARTIAL',
        status: 'IN_PROGRESS',
        totalTargetItems: 1,
        createdByUid: 'admin-1',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }));

      // Create partial DRAFT session with 1 item; verify Cashier CANNOT acquire lease while DRAFT
      const draftPath = 'branches/khalid-1/stocktake_sessions_v2/st-v2-draft-partial';
      const b = writeBatch(admin1Db);
      b.set(doc(admin1Db, draftPath), {
        id: 'st-v2-draft-partial',
        branchId: 'khalid-1',
        sessionNumber: 'ST-2026-DRFT',
        schemaVersion: 2,
        scopeMode: 'PARTIAL',
        status: 'DRAFT',
        totalTargetItems: 2,
        createdByUid: 'admin-1',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      b.set(doc(admin1Db, `${draftPath}/items/med-1`), {
        id: 'med-1',
        branchId: 'khalid-1',
        sessionId: 'st-v2-draft-partial',
        medicineId: 'med-1',
        medicineName: 'Panadol med-1',
        state: 'AVAILABLE',
        syncStatus: 'CONFIRMED',
        activeLease: null,
        leaseVersion: 0,
        countRevision: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await assertSucceeds(b.commit());

      await assertFails(updateDoc(doc(cashier1Db, `${draftPath}/items/med-1`), {
        state: 'RESERVED',
        leaseVersion: 1,
        activeLease: {
          leaseId: 'lease-on-draft',
          ownerUid: 'cashier-1',
          deviceId: 'dev-c1',
          leaseVersion: 1,
          renewalCount: 0,
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
        },
        updatedAt: serverTimestamp(),
      }));

      // Safe cleanup: DRAFT -> CANCELLED with reason SUCCEEDS
      await assertSucceeds(updateDoc(doc(admin1Db, draftPath), {
        status: 'CANCELLED',
        cancelledByUid: 'admin-1',
        cancellationReason: 'Aborted incomplete initialization',
        updatedAt: serverTimestamp(),
      }));

      // Adding stray items after IN_PROGRESS on active session -> DENIED
      await assertFails(setDoc(doc(admin1Db, 'branches/khalid-1/stocktake_sessions_v2/st-v2-adv-lease/items/med-2'), {
        id: 'med-2',
        branchId: 'khalid-1',
        sessionId: 'st-v2-adv-lease',
        medicineId: 'med-2',
        medicineName: 'Panadol med-2',
        state: 'AVAILABLE',
        syncStatus: 'CONFIRMED',
        activeLease: null,
        leaseVersion: 0,
        countRevision: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }));
    });

    await runCase('ST-19', 'Fix A (OD-4): Cashier A reads OWN count_event (getDoc + actor-scoped list); Cashier B direct getDoc DENIED', async () => {
      const ownSnap = await assertSucceeds(getDoc(doc(cashier1Db, `${sessPath}/count_events/med-1__r1`)));
      assert.equal(ownSnap.exists(), true);
      assert.equal(ownSnap.data()?.countedQuantity, 9);
      assert.equal(ownSnap.data()?.actorUid, 'cashier-1');

      const ownList = await assertSucceeds(
        getDocs(
          query(
            collection(cashier1Db, `${sessPath}/count_events`),
            where('branchId', '==', 'khalid-1'),
            where('sessionId', '==', sessId),
            where('actorUid', '==', 'cashier-1')
          )
        )
      );
      assert.equal(ownList.size, 1);
      assert.equal(ownList.docs[0].data().countedQuantity, 9);

      // Cashier B direct getDoc on Cashier A's count_event -> HARD DENIED!
      await assertFails(getDoc(doc(cashier1bDb, `${sessPath}/count_events/med-1__r1`)));
    });

    await runCase('ST-20', 'Fix A (OD-4): Cross-cashier isolation across getDoc, unfiltered list, alt queries, collectionGroup & operational_audit', async () => {
      const isoSess = 'sess-iso-fix-a';
      const isoPath = `branches/khalid-1/stocktake_sessions_v2/${isoSess}`;
      await assertSucceeds(
        setDoc(doc(admin1Db, isoPath), {
          id: isoSess,
          branchId: 'khalid-1',
          sessionNumber: 'ST-2026-ISO1',
          status: 'DRAFT',
          scopeMode: 'PARTIAL',
          schemaVersion: 2,
          createdByUid: 'admin-1',
          createdByName: 'Admin 1',
          totalTargetItems: 2,
          confirmedCountedItems: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      for (const m of ['med-1', 'med-2']) {
        await assertSucceeds(
          setDoc(doc(admin1Db, `${isoPath}/items/${m}`), {
            id: m,
            sessionId: isoSess,
            branchId: 'khalid-1',
            medicineId: m,
            medicineName: `Medicine ${m}`,
            availableUnits: ['pack', 'strip', 'pill'],
            state: 'AVAILABLE',
            syncStatus: 'CONFIRMED',
            activeLease: null,
            leaseVersion: 0,
            countRevision: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      }
      await assertSucceeds(
        updateDoc(doc(admin1Db, isoPath), { status: 'IN_PROGRESS', updatedAt: serverTimestamp() })
      );

      const nowMs = Date.now();
      await assertSucceeds(
        updateDoc(doc(cashier1bDb, `${isoPath}/items/med-2`), {
          state: 'RESERVED',
          leaseVersion: 1,
          activeLease: {
            leaseId: 'lease-c1b-iso',
            ownerUid: 'cashier-1b',
            ownerDisplayName: 'Cashier 1B',
            deviceId: 'dev-c1b',
            createdAt: serverTimestamp(),
            expiresAt: Timestamp.fromMillis(nowMs + 120_000),
            leaseVersion: 1,
            renewalCount: 0,
          },
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        runTransaction(cashier1bDb, async (tx) => {
          tx.set(doc(cashier1bDb, `${isoPath}/count_events/med-2__r1`), {
            eventId: 'med-2__r1',
            idempotencyKey: 'idem-iso-med2-r1',
            sessionId: isoSess,
            branchId: 'khalid-1',
            medicineId: 'med-2',
            countRevision: 1,
            leaseId: 'lease-c1b-iso',
            leaseVersion: 1,
            countedQuantity: 77,
            countUnit: 'pack',
            baseUnitsPerCountUnit: 10,
            countedBaseUnits: 770,
            actorUid: 'cashier-1b',
            actorDisplayName: 'Cashier 1B',
            deviceId: 'dev-c1b',
            watermark: {
              countBusinessAtMs: nowMs,
              localPersistedAtMs: nowMs,
              knownMovementIdsAtCount: [],
              knownMovementCount: 0,
              watermarkDigest: 'd-iso-1',
            },
            createdAt: serverTimestamp(),
          });
          tx.update(doc(cashier1bDb, `${isoPath}/items/med-2`), {
            state: 'COUNTED',
            activeLease: null,
            leaseVersion: 2,
            countRevision: 1,
            updatedAt: serverTimestamp(),
          });
        })
      );

      await assertFails(getDoc(doc(cashier1Db, `${isoPath}/count_events/med-2__r1`)));
      await assertFails(
        getDocs(
          query(
            collection(cashier1Db, `${isoPath}/count_events`),
            where('branchId', '==', 'khalid-1'),
            where('sessionId', '==', isoSess)
          )
        )
      );
      await assertFails(
        getDocs(
          query(
            collection(cashier1Db, `${isoPath}/count_events`),
            where('branchId', '==', 'khalid-1'),
            where('sessionId', '==', isoSess),
            where('medicineId', '==', 'med-2')
          )
        )
      );
      await assertFails(
        getDocs(
          query(
            collection(cashier1Db, `${isoPath}/count_events`),
            where('branchId', '==', 'khalid-1'),
            where('sessionId', '==', isoSess),
            where('actorUid', '==', 'cashier-1b')
          )
        )
      );
      await assertFails(getDocs(collectionGroup(cashier1Db, 'count_events')));
      await assertFails(
        getDocs(
          query(
            collection(cashier1Db, `${isoPath}/operational_audit`),
            where('branchId', '==', 'khalid-1'),
            where('sessionId', '==', isoSess)
          )
        )
      );
    });

    await runCase('ST-21', 'Fix A (OD-4): Shared item doc has ZERO count quantity/actor fields; smuggling latestCountedQuantity/ByUid DENIED', async () => {
      const isoPath = 'branches/khalid-1/stocktake_sessions_v2/sess-iso-fix-a';
      const sharedItem = await assertSucceeds(getDoc(doc(cashier1Db, `${isoPath}/items/med-2`)));
      const data = sharedItem.data()!;
      const forbiddenKeys = [
        'latestCountEventId',
        'latestCountedQuantity',
        'latestCountUnit',
        'latestCountBaseUnits',
        'latestCountedByUid',
        'latestCountedByName',
        'latestCountedAt',
        'latestDeviceId',
        'systemStock',
        'buyPrice',
        'costPerUnit',
        'variance',
      ];
      for (const k of forbiddenKeys) {
        assert.equal(k in data, false, `Forbidden field '${k}' must NOT exist on shared item doc`);
      }

      const nowMs = Date.now();
      await assertSucceeds(
        updateDoc(doc(cashier1Db, `${isoPath}/items/med-1`), {
          state: 'RESERVED',
          leaseVersion: 1,
          activeLease: {
            leaseId: 'lease-c1-smug',
            ownerUid: 'cashier-1',
            ownerDisplayName: 'Cashier 1',
            deviceId: 'dev-c1',
            createdAt: serverTimestamp(),
            expiresAt: Timestamp.fromMillis(nowMs + 120_000),
            leaseVersion: 1,
            renewalCount: 0,
          },
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        runTransaction(cashier1Db, async (tx) => {
          tx.set(doc(cashier1Db, `${isoPath}/count_events/med-1__r1`), {
            eventId: 'med-1__r1',
            idempotencyKey: 'idem-smug-med1-r1',
            sessionId: 'sess-iso-fix-a',
            branchId: 'khalid-1',
            medicineId: 'med-1',
            countRevision: 1,
            leaseId: 'lease-c1-smug',
            leaseVersion: 1,
            countedQuantity: 12,
            countUnit: 'pack',
            baseUnitsPerCountUnit: 10,
            countedBaseUnits: 120,
            actorUid: 'cashier-1',
            deviceId: 'dev-c1',
            watermark: {
              countBusinessAtMs: nowMs,
              localPersistedAtMs: nowMs,
              knownMovementIdsAtCount: [],
              knownMovementCount: 0,
              watermarkDigest: 'd-smug',
            },
            createdAt: serverTimestamp(),
          });
          tx.update(doc(cashier1Db, `${isoPath}/items/med-1`), {
            state: 'COUNTED',
            activeLease: null,
            leaseVersion: 2,
            countRevision: 1,
            latestCountedQuantity: 12,
            latestCountedByUid: 'cashier-1',
            updatedAt: serverTimestamp(),
          });
        })
      );
    });

    await runCase('ST-22', 'Fix A (OD-4): Branch Admin reads ALL branch count_events; Other-Branch Admin DENIED', async () => {
      const isoPath = 'branches/khalid-1/stocktake_sessions_v2/sess-iso-fix-a';
      const admGet = await assertSucceeds(getDoc(doc(admin1Db, `${isoPath}/count_events/med-2__r1`)));
      assert.equal(admGet.data()?.countedQuantity, 77);
      const admList = await assertSucceeds(
        getDocs(
          query(
            collection(admin1Db, `${isoPath}/count_events`),
            where('branchId', '==', 'khalid-1'),
            where('sessionId', '==', 'sess-iso-fix-a')
          )
        )
      );
      assert.equal(admList.size, 1);

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'users/admin-2'), {
          uid: 'admin-2',
          email: 'admin-2@khalid.test',
          displayName: 'Admin Branch 2',
          role: 'admin',
          branchIds: ['khalid-2'],
          activeBranchId: 'khalid-2',
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });
      const admin2Db = authedDb(testEnv, 'admin-2');
      await assertFails(getDoc(doc(admin2Db, `${isoPath}/count_events/med-2__r1`)));
      await assertFails(
        getDocs(
          query(
            collection(admin2Db, `${isoPath}/count_events`),
            where('branchId', '==', 'khalid-1'),
            where('sessionId', '==', 'sess-iso-fix-a')
          )
        )
      );
      await assertFails(getDoc(doc(admin2Db, `${isoPath}/items/med-2`)));
    });

    await runCase('ST-23', 'Fix A (OD-4): Super Admin authorized on active branch; inactive super_admin & inactive branch DENIED', async () => {
      const isoPath = 'branches/khalid-1/stocktake_sessions_v2/sess-iso-fix-a';
      const supGet = await assertSucceeds(getDoc(doc(superDb, `${isoPath}/count_events/med-2__r1`)));
      assert.equal(supGet.data()?.countedQuantity, 77);
      const supList = await assertSucceeds(
        getDocs(
          query(
            collection(superDb, `${isoPath}/count_events`),
            where('branchId', '==', 'khalid-1'),
            where('sessionId', '==', 'sess-iso-fix-a')
          )
        )
      );
      assert.equal(supList.size, 1);

      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, 'branches/khalid-inactive'), {
          id: 'khalid-inactive',
          name: 'Inactive Branch',
          active: false,
          adminUids: ['super-1'],
          memberUids: ['super-1'],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        await setDoc(doc(db, 'branches/khalid-inactive/stocktake_sessions_v2/s-inact/count_events/med-1__r1'), {
          eventId: 'med-1__r1',
          branchId: 'khalid-inactive',
          sessionId: 's-inact',
          actorUid: 'cashier-1',
          countedQuantity: 5,
        });
        await setDoc(doc(db, 'users/super-inactive'), {
          uid: 'super-inactive',
          email: 'super-inactive@khalid.test',
          displayName: 'Inactive Super',
          role: 'super_admin',
          branchIds: ['khalid-1'],
          active: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });
      await assertFails(getDoc(doc(superDb, 'branches/khalid-inactive/stocktake_sessions_v2/s-inact/count_events/med-1__r1')));
      const inactiveSuperDb = authedDb(testEnv, 'super-inactive');
      await assertFails(getDoc(doc(inactiveSuperDb, `${isoPath}/count_events/med-2__r1`)));
    });

    await runCase('ST-24', 'Fix D: Stale-owner count/renew DENIED after expiry takeover; non-canonical eventId create DENIED', async () => {
      const isoPath = 'branches/khalid-1/stocktake_sessions_v2/sess-iso-fix-a';
      await assertSucceeds(
        updateDoc(doc(cashier1Db, `${isoPath}/items/med-1`), {
          state: 'AVAILABLE',
          activeLease: null,
          leaseVersion: 2,
          updatedAt: serverTimestamp(),
        })
      );
      const tNow = Date.now();
      await assertSucceeds(
        updateDoc(doc(cashier1Db, `${isoPath}/items/med-1`), {
          state: 'RESERVED',
          leaseVersion: 3,
          activeLease: {
            leaseId: 'lease-c1-short',
            ownerUid: 'cashier-1',
            ownerDisplayName: 'Cashier 1',
            deviceId: 'dev-c1',
            createdAt: serverTimestamp(),
            expiresAt: Timestamp.fromMillis(tNow + 1200),
            leaseVersion: 3,
            renewalCount: 0,
          },
          updatedAt: serverTimestamp(),
        })
      );
      await new Promise((r) => setTimeout(r, 1700));
      const tAfter = Date.now();
      await assertSucceeds(
        updateDoc(doc(cashier1bDb, `${isoPath}/items/med-1`), {
          state: 'RESERVED',
          leaseVersion: 4,
          activeLease: {
            leaseId: 'lease-c1b-takeover',
            ownerUid: 'cashier-1b',
            ownerDisplayName: 'Cashier 1B',
            deviceId: 'dev-c1b',
            createdAt: serverTimestamp(),
            expiresAt: Timestamp.fromMillis(tAfter + 120_000),
            leaseVersion: 4,
            renewalCount: 0,
          },
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(cashier1Db, `${isoPath}/items/med-1`), {
          state: 'RESERVED',
          leaseVersion: 4,
          activeLease: {
            leaseId: 'lease-c1-short',
            ownerUid: 'cashier-1',
            deviceId: 'dev-c1',
            createdAt: Timestamp.fromMillis(tNow),
            expiresAt: Timestamp.fromMillis(Date.now() + 120_000),
            leaseVersion: 4,
            renewalCount: 1,
          },
          updatedAt: serverTimestamp(),
        })
      );
      // Stale-owner (cashier-1) count submission after expiry takeover -> DENIED
      await assertFails(
        runTransaction(cashier1Db, async (tx) => {
          tx.set(doc(cashier1Db, `${isoPath}/count_events/med-1__r1`), {
            eventId: 'med-1__r1',
            idempotencyKey: 'idem-stale-c1-1',
            sessionId: 'sess-iso-fix-a',
            branchId: 'khalid-1',
            medicineId: 'med-1',
            countRevision: 1,
            leaseId: 'lease-c1-short',
            leaseVersion: 3,
            countedQuantity: 99,
            countUnit: 'pack',
            baseUnitsPerCountUnit: 10,
            countedBaseUnits: 990,
            actorUid: 'cashier-1',
            deviceId: 'dev-c1',
            watermark: {
              countBusinessAtMs: tNow,
              localPersistedAtMs: tNow,
              knownMovementIdsAtCount: [],
              knownMovementCount: 0,
              watermarkDigest: 'd-stale',
            },
            createdAt: serverTimestamp(),
          });
          tx.update(doc(cashier1Db, `${isoPath}/items/med-1`), {
            state: 'COUNTED',
            activeLease: null,
            leaseVersion: 5,
            countRevision: 1,
            updatedAt: serverTimestamp(),
          });
        })
      );
      await assertFails(
        setDoc(doc(cashier1bDb, `${isoPath}/count_events/custom-noncanonical-id`), {
          eventId: 'custom-noncanonical-id',
          idempotencyKey: 'idem-noncanon-1',
          sessionId: 'sess-iso-fix-a',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          countRevision: 1,
          leaseId: 'lease-c1b-takeover',
          leaseVersion: 4,
          countedQuantity: 4,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 10,
          countedBaseUnits: 40,
          actorUid: 'cashier-1b',
          deviceId: 'dev-c1b',
          watermark: {
            countBusinessAtMs: tAfter,
            localPersistedAtMs: tAfter,
            knownMovementIdsAtCount: [],
            knownMovementCount: 0,
            watermarkDigest: 'd-nc',
          },
          createdAt: serverTimestamp(),
        })
      );
    });

    await runCase('ST-25', 'F-01: Cashier financial archive & client data-loading isolation (zero buyPrice/suppliers/invoices/legacy stocktake archive)', async () => {
      const rawMedWithBuyPrice = {
        id: 'med-1',
        name: 'Panadol Extra',
        price: 1500,
        buyPrice: 950,
        buyPriceExact: { num: 950, den: 1 },
        stock: 20,
      };
      const sanitizedMed = sanitizeMedicineForCashier(rawMedWithBuyPrice);
      assert.equal('buyPrice' in sanitizedMed, false);
      assert.equal('buyPriceExact' in sanitizedMed, false);
      assertNoCashierForbiddenFields(sanitizedMed, 'ST-25:sanitizedMed');

      const cashierSnap = sanitizeOperationalSnapshotForRole({
        role: 'cashier',
        hasOnlineVerifiedAdmin: false,
        medicines: [rawMedWithBuyPrice],
        suppliers: [{ id: 'sup-1', balance: 50000 }],
        purchaseInvoices: [{ id: 'pinv-1', totalAmount: 25000 }],
        supplierPayments: [{ id: 'sp-1', amount: 10000 }],
        activeStocktakingSession: { id: 'leg-1', netVarianceSDG: -4500 },
        stocktakingSessionsList: [{ id: 'leg-0', netVarianceSDG: -1200 }],
      });
      assert.equal('buyPrice' in cashierSnap.medicines[0], false);
      assert.equal(cashierSnap.suppliers.length, 0);
      assert.equal(cashierSnap.purchaseInvoices.length, 0);
      assert.equal(cashierSnap.supplierPayments.length, 0);
      assert.equal(cashierSnap.activeStocktakingSession, null);
      assert.equal(cashierSnap.stocktakingSessionsList.length, 0);

      // Verify index.html enforces role-scoped isolation & v-if="hasOnlineVerifiedAdminAccess()" on financial archive
      const indexHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
      assert.equal(indexHtml.includes('v-if="hasOnlineVerifiedAdminAccess() && stocktakingSessionsList.length > 0"'), true);
      assert.equal(indexHtml.includes('v-if="hasOnlineVerifiedAdminAccess()" class="font-bold text-indigo-700 block font-mono">{{ currency(med.buyPrice) }}'), true);
    });

    await runCase('ST-26', 'F-02: Strict schema validation on stocktake_financials/lines, approvals, postings, financial_audit & count_events math', async () => {
      const f2Sess = 'sess-f02-schema';
      const f2SessPath = `branches/khalid-1/stocktake_sessions_v2/${f2Sess}`;
      const f2FinPath = `branches/khalid-1/stocktake_financials/${f2Sess}`;
      const b = writeBatch(admin1Db);
      b.set(doc(admin1Db, f2SessPath), {
        id: f2Sess,
        branchId: 'khalid-1',
        sessionNumber: 'ST-F02',
        schemaVersion: 2,
        scopeMode: 'PARTIAL',
        status: 'DRAFT',
        totalTargetItems: 1,
        createdByUid: 'admin-1',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      b.set(doc(admin1Db, `${f2SessPath}/items/med-1`), {
        id: 'med-1',
        branchId: 'khalid-1',
        sessionId: f2Sess,
        medicineId: 'med-1',
        medicineName: 'Panadol med-1',
        state: 'AVAILABLE',
        syncStatus: 'CONFIRMED',
        activeLease: null,
        leaseVersion: 0,
        countRevision: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await assertSucceeds(b.commit());
      await assertSucceeds(updateDoc(doc(admin1Db, f2SessPath), { status: 'IN_PROGRESS', updatedAt: serverTimestamp() }));

      // 1) Lease item and attempt count_event with forged countedBaseUnits != countedQuantity * baseUnitsPerCountUnit -> DENIED
      const nowMs = Date.now();
      await assertSucceeds(updateDoc(doc(cashier1Db, `${f2SessPath}/items/med-1`), {
        state: 'RESERVED',
        leaseVersion: 1,
        activeLease: {
          leaseId: 'lease-f02-1',
          ownerUid: 'cashier-1',
          deviceId: 'dev-c1',
          leaseVersion: 1,
          renewalCount: 0,
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(nowMs + 120_000),
        },
        updatedAt: serverTimestamp(),
      }));
      await assertFails(
        runTransaction(cashier1Db, async (tx) => {
          tx.set(doc(cashier1Db, `${f2SessPath}/count_events/med-1__r1`), {
            eventId: 'med-1__r1',
            idempotencyKey: 'idem-f02-bad-math',
            sessionId: f2Sess,
            branchId: 'khalid-1',
            medicineId: 'med-1',
            countRevision: 1,
            leaseId: 'lease-f02-1',
            leaseVersion: 1,
            countedQuantity: 5,
            countUnit: 'pack',
            baseUnitsPerCountUnit: 20,
            countedBaseUnits: 999, // Forged! 5 * 20 = 100 != 999
            actorUid: 'cashier-1',
            deviceId: 'dev-c1',
            watermark: {
              countBusinessAtMs: nowMs,
              localPersistedAtMs: nowMs,
              knownMovementIdsAtCount: [],
              knownMovementCount: 0,
              watermarkDigest: 'd-f02',
            },
            createdAt: serverTimestamp(),
          });
          tx.update(doc(cashier1Db, `${f2SessPath}/items/med-1`), {
            state: 'COUNTED',
            activeLease: null,
            leaseVersion: 2,
            countRevision: 1,
            updatedAt: serverTimestamp(),
          });
        })
      );

      // 2) Domain B lines/approvals/postings/financial_audit reject unknown fields, invalid types, or missing required fields
      await assertSucceeds(setDoc(doc(admin1Db, f2FinPath), {
        id: f2Sess,
        branchId: 'khalid-1',
        sessionId: f2Sess,
        reconciliationStatus: 'RECONCILING',
        updatedByUid: 'admin-1',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }));

      // Unknown field in lines -> DENIED
      await assertFails(setDoc(doc(admin1Db, `${f2FinPath}/lines/med-1`), {
        id: 'med-1',
        branchId: 'khalid-1',
        sessionId: f2Sess,
        medicineId: 'med-1',
        varianceBaseUnits: -10,
        arbitraryInjectedField: 'hack',
        updatedByUid: 'admin-1',
        updatedAt: serverTimestamp(),
      }));

      // Non-integer varianceBaseUnits in lines -> DENIED
      await assertFails(setDoc(doc(admin1Db, `${f2FinPath}/lines/med-1`), {
        id: 'med-1',
        branchId: 'khalid-1',
        sessionId: f2Sess,
        medicineId: 'med-1',
        varianceBaseUnits: 'not-an-int',
        updatedByUid: 'admin-1',
        updatedAt: serverTimestamp(),
      }));

      // Invalid discrepancyStatus in lines -> DENIED
      await assertFails(setDoc(doc(admin1Db, `${f2FinPath}/lines/med-1`), {
        id: 'med-1',
        branchId: 'khalid-1',
        sessionId: f2Sess,
        medicineId: 'med-1',
        varianceBaseUnits: -10,
        discrepancyStatus: 'FAKE_STATUS',
        updatedByUid: 'admin-1',
        updatedAt: serverTimestamp(),
      }));

      // Unknown field in approvals, postings, financial_audit -> DENIED
      await assertFails(setDoc(doc(admin1Db, `${f2FinPath}/approvals/apr-bad`), {
        id: 'apr-bad',
        branchId: 'khalid-1',
        sessionId: f2Sess,
        approvedByUid: 'admin-1',
        extraHack: 123,
        createdAt: serverTimestamp(),
      }));
      await assertFails(setDoc(doc(admin1Db, `${f2FinPath}/postings/post-bad`), {
        id: 'post-bad',
        branchId: 'khalid-1',
        sessionId: f2Sess,
        postedByUid: 'admin-1',
        extraHack: 123,
        createdAt: serverTimestamp(),
      }));
      await assertFails(setDoc(doc(admin1Db, `${f2FinPath}/financial_audit/faud-bad`), {
        id: 'faud-bad',
        branchId: 'khalid-1',
        sessionId: f2Sess,
        actorUid: 'admin-1',
        actorRole: 'admin',
        action: 'TEST',
        extraHack: 123,
        createdAt: serverTimestamp(),
      }));

      // Valid line creation SUCCEEDS
      await assertSucceeds(setDoc(doc(admin1Db, `${f2FinPath}/lines/med-1`), {
        id: 'med-1',
        branchId: 'khalid-1',
        sessionId: f2Sess,
        medicineId: 'med-1',
        expectedCurrentBaseUnits: 90,
        systemCurrentBaseUnits: 100,
        varianceBaseUnits: -10,
        discrepancyStatus: 'EXACT_DEFICIT',
        financialVarianceExact: { num: -40, den: 1 },
        updatedByUid: 'admin-1',
        updatedAt: serverTimestamp(),
      }));
    });

    await runCase('ST-27', 'F-03: Lease version CAS increment enforced on COUNTED -> VERIFIED (stale leaseVersion rejected)', async () => {
      const f2Sess = 'sess-f02-schema';
      const f2SessPath = `branches/khalid-1/stocktake_sessions_v2/${f2Sess}`;
      const nowMs = Date.now();

      // Submit valid count on med-1 (transitions RESERVED(v1) -> COUNTED(v2, rev1))
      await assertSucceeds(
        runTransaction(cashier1Db, async (tx) => {
          tx.set(doc(cashier1Db, `${f2SessPath}/count_events/med-1__r1`), {
            eventId: 'med-1__r1',
            idempotencyKey: 'idem-f03-ok',
            sessionId: f2Sess,
            branchId: 'khalid-1',
            medicineId: 'med-1',
            countRevision: 1,
            leaseId: 'lease-f02-1',
            leaseVersion: 1,
            countedQuantity: 5,
            countUnit: 'pack',
            baseUnitsPerCountUnit: 20,
            countedBaseUnits: 100,
            actorUid: 'cashier-1',
            deviceId: 'dev-c1',
            watermark: {
              countBusinessAtMs: nowMs,
              localPersistedAtMs: nowMs,
              knownMovementIdsAtCount: [],
              knownMovementCount: 0,
              watermarkDigest: 'd-f03',
            },
            createdAt: serverTimestamp(),
          });
          tx.update(doc(cashier1Db, `${f2SessPath}/items/med-1`), {
            state: 'COUNTED',
            activeLease: null,
            leaseVersion: 2,
            countRevision: 1,
            updatedAt: serverTimestamp(),
          });
        })
      );

      // Admin trying COUNTED(v2) -> VERIFIED with stale leaseVersion (2 instead of 3) -> DENIED
      await assertFails(updateDoc(doc(admin1Db, `${f2SessPath}/items/med-1`), {
        state: 'VERIFIED',
        activeLease: null,
        leaseVersion: 2,
        updatedAt: serverTimestamp(),
      }));

      // Admin trying COUNTED(v2) -> VERIFIED with leaseVersion: 3 (e.leaseVersion + 1) -> SUCCEEDS
      await assertSucceeds(updateDoc(doc(admin1Db, `${f2SessPath}/items/med-1`), {
        state: 'VERIFIED',
        activeLease: null,
        leaseVersion: 3,
        updatedAt: serverTimestamp(),
      }));
    });

    await runCase('ST-28', 'F-04: Lease release state-corruption attacks blocked (countRevision==0 -> AVAILABLE only; countRevision>=1 -> NEEDS_RECOUNT only)', async () => {
      const f4Sess = 'sess-f04-release';
      const f4SessPath = `branches/khalid-1/stocktake_sessions_v2/${f4Sess}`;
      const b = writeBatch(admin1Db);
      b.set(doc(admin1Db, f4SessPath), {
        id: f4Sess,
        branchId: 'khalid-1',
        sessionNumber: 'ST-F04',
        schemaVersion: 2,
        scopeMode: 'PARTIAL',
        status: 'DRAFT',
        totalTargetItems: 1,
        createdByUid: 'admin-1',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      b.set(doc(admin1Db, `${f4SessPath}/items/med-1`), {
        id: 'med-1',
        branchId: 'khalid-1',
        sessionId: f4Sess,
        medicineId: 'med-1',
        medicineName: 'Panadol med-1',
        state: 'AVAILABLE',
        syncStatus: 'CONFIRMED',
        activeLease: null,
        leaseVersion: 0,
        countRevision: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await assertSucceeds(b.commit());
      await assertSucceeds(updateDoc(doc(admin1Db, f4SessPath), { status: 'IN_PROGRESS', updatedAt: serverTimestamp() }));

      const itemRef = doc(cashier1Db, `${f4SessPath}/items/med-1`);
      const nowMs = Date.now();
      await assertSucceeds(updateDoc(itemRef, {
        state: 'RESERVED',
        leaseVersion: 1,
        activeLease: {
          leaseId: 'lease-f04-1',
          ownerUid: 'cashier-1',
          deviceId: 'dev-c1',
          leaseVersion: 1,
          renewalCount: 0,
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(nowMs + 120_000),
        },
        updatedAt: serverTimestamp(),
      }));

      // Attack 1: Releasing an uncounted item (countRevision == 0) into NEEDS_RECOUNT -> DENIED
      await assertFails(updateDoc(itemRef, {
        state: 'NEEDS_RECOUNT',
        activeLease: null,
        leaseVersion: 2,
        updatedAt: serverTimestamp(),
      }));

      // Valid release of uncounted item (countRevision == 0) into AVAILABLE -> SUCCEEDS
      await assertSucceeds(updateDoc(itemRef, {
        state: 'AVAILABLE',
        activeLease: null,
        leaseVersion: 2,
        updatedAt: serverTimestamp(),
      }));

      // Now lease, count (countRevision becomes 1), Admin marks NEEDS_RECOUNT, lease again
      await assertSucceeds(updateDoc(itemRef, {
        state: 'RESERVED',
        leaseVersion: 3,
        activeLease: {
          leaseId: 'lease-f04-2',
          ownerUid: 'cashier-1',
          deviceId: 'dev-c1',
          leaseVersion: 3,
          renewalCount: 0,
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(nowMs + 120_000),
        },
        updatedAt: serverTimestamp(),
      }));
      await assertSucceeds(
        runTransaction(cashier1Db, async (tx) => {
          tx.set(doc(cashier1Db, `${f4SessPath}/count_events/med-1__r1`), {
            eventId: 'med-1__r1',
            idempotencyKey: 'idem-f04-r1',
            sessionId: f4Sess,
            branchId: 'khalid-1',
            medicineId: 'med-1',
            countRevision: 1,
            leaseId: 'lease-f04-2',
            leaseVersion: 3,
            countedQuantity: 4,
            countUnit: 'pack',
            baseUnitsPerCountUnit: 20,
            countedBaseUnits: 80,
            actorUid: 'cashier-1',
            deviceId: 'dev-c1',
            watermark: {
              countBusinessAtMs: nowMs,
              localPersistedAtMs: nowMs,
              knownMovementIdsAtCount: [],
              knownMovementCount: 0,
              watermarkDigest: 'd-f04',
            },
            createdAt: serverTimestamp(),
          });
          tx.update(itemRef, {
            state: 'COUNTED',
            activeLease: null,
            leaseVersion: 4,
            countRevision: 1,
            updatedAt: serverTimestamp(),
          });
        })
      );
      await assertSucceeds(updateDoc(doc(admin1Db, `${f4SessPath}/items/med-1`), {
        state: 'NEEDS_RECOUNT',
        activeLease: null,
        leaseVersion: 5,
        recountReason: 'Recount shelf B1',
        updatedAt: serverTimestamp(),
      }));
      await assertSucceeds(updateDoc(itemRef, {
        state: 'RESERVED',
        leaseVersion: 6,
        activeLease: {
          leaseId: 'lease-f04-3',
          ownerUid: 'cashier-1',
          deviceId: 'dev-c1',
          leaseVersion: 6,
          renewalCount: 0,
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(nowMs + 120_000),
        },
        updatedAt: serverTimestamp(),
      }));

      // Attack 2: Releasing a recount-reserved item (countRevision == 1) back to AVAILABLE -> DENIED
      await assertFails(updateDoc(itemRef, {
        state: 'AVAILABLE',
        activeLease: null,
        leaseVersion: 7,
        updatedAt: serverTimestamp(),
      }));

      // Valid release of recount-reserved item (countRevision == 1) back to NEEDS_RECOUNT -> SUCCEEDS
      await assertSucceeds(updateDoc(itemRef, {
        state: 'NEEDS_RECOUNT',
        activeLease: null,
        leaseVersion: 7,
        updatedAt: serverTimestamp(),
      }));
    });

    await runCase('ST-29', 'F-05: Session state-transition bypasses & post-POSTED financial/line mutation blocked', async () => {
      const f5Sess = 'sess-f02-schema';
      const f5SessPath = `branches/khalid-1/stocktake_sessions_v2/${f5Sess}`;
      const f5FinPath = `branches/khalid-1/stocktake_financials/${f5Sess}`;

      // Illegal direct jumps from IN_PROGRESS -> PENDING_APPROVAL / APPROVED / POSTED / CLOSED -> DENIED
      for (const illegalTarget of ['PENDING_APPROVAL', 'APPROVED', 'POSTED', 'CLOSED']) {
        await assertFails(updateDoc(doc(admin1Db, f5SessPath), {
          status: illegalTarget,
          updatedAt: serverTimestamp(),
        }));
      }

      await assertSucceeds(updateDoc(doc(admin1Db, f5SessPath), {
        status: 'RECONCILING',
        updatedAt: serverTimestamp(),
      }));

      // Cannot mark stocktake_financials PENDING_APPROVAL when unresolvedItemsCount > 0 or valuations are null -> DENIED
      await assertFails(updateDoc(doc(admin1Db, f5FinPath), {
        reconciliationStatus: 'PENDING_APPROVAL',
        unresolvedItemsCount: 1,
        totalExpectedValuationExact: { num: 360, den: 1 },
        totalSystemValuationExact: { num: 400, den: 1 },
        netVarianceValuationExact: { num: -40, den: 1 },
        updatedByUid: 'admin-1',
        updatedAt: serverTimestamp(),
      }));
      await assertFails(updateDoc(doc(admin1Db, f5FinPath), {
        reconciliationStatus: 'PENDING_APPROVAL',
        unresolvedItemsCount: 0,
        totalExpectedValuationExact: null,
        totalSystemValuationExact: { num: 400, den: 1 },
        netVarianceValuationExact: { num: -40, den: 1 },
        updatedByUid: 'admin-1',
        updatedAt: serverTimestamp(),
      }));

      // Valid PENDING_APPROVAL financial summary -> SUCCEEDS
      await assertSucceeds(updateDoc(doc(admin1Db, f5FinPath), {
        reconciliationStatus: 'PENDING_APPROVAL',
        unresolvedItemsCount: 0,
        totalExpectedValuationExact: { num: 360, den: 1 },
        totalSystemValuationExact: { num: 400, den: 1 },
        netVarianceValuationExact: { num: -40, den: 1 },
        updatedByUid: 'admin-1',
        updatedAt: serverTimestamp(),
      }));
      await assertSucceeds(updateDoc(doc(admin1Db, f5SessPath), {
        status: 'PENDING_APPROVAL',
        updatedAt: serverTimestamp(),
      }));
      await assertSucceeds(updateDoc(doc(admin1Db, f5SessPath), {
        status: 'APPROVED',
        updatedAt: serverTimestamp(),
      }));

      // Transition to POSTED atomically with stocktake_financials POSTED
      await assertSucceeds(updateDoc(doc(admin1Db, f5FinPath), {
        reconciliationStatus: 'POSTED',
        approvedByUid: 'admin-1',
        approvedAt: serverTimestamp(),
        postedByUid: 'admin-1',
        postedAt: serverTimestamp(),
        updatedByUid: 'admin-1',
        updatedAt: serverTimestamp(),
      }));
      await assertSucceeds(updateDoc(doc(admin1Db, f5SessPath), {
        status: 'POSTED',
        updatedAt: serverTimestamp(),
      }));

      // Once POSTED, mutating stocktake_financials summary or lines is HARD DENIED
      await assertFails(updateDoc(doc(admin1Db, f5FinPath), {
        netVarianceValuationExact: { num: 0, den: 1 },
        updatedByUid: 'admin-1',
        updatedAt: serverTimestamp(),
      }));
      await assertFails(updateDoc(doc(admin1Db, `${f5FinPath}/lines/med-1`), {
        varianceBaseUnits: 0,
        updatedByUid: 'admin-1',
        updatedAt: serverTimestamp(),
      }));
    });

    await runCase('ST-30', 'F-06: Forged EXACT_RECONCILED / EXACT_HISTORICAL / movementHistoryVerified attacks blocked in Rules & service', async () => {
      // 1) Forged inventory_financials with costStatus: EXACT_RECONCILED but unresolvedBaseUnits > 0 -> DENIED
      await assertFails(setDoc(doc(admin1Db, 'branches/khalid-1/inventory_financials/mov-forged-1'), {
        id: 'mov-forged-1',
        branchId: 'khalid-1',
        movementId: 'mov-forged-1',
        medicineId: 'med-1',
        movementType: 'ADJUSTMENT',
        costStatus: 'EXACT_RECONCILED',
        costProvenanceType: 'STOCKTAKE_V2_APPROVED_EXACT',
        costPerBaseUnitExact: { num: 4, den: 1 },
        totalCostExact: { num: -40, den: 1 },
        sourceReferenceId: 'post-1',
        unresolvedBaseUnits: 5, // Forged unresolved units with EXACT_RECONCILED!
        reconciledByUid: 'admin-1',
        createdAt: serverTimestamp(),
      }));

      // 2) Forged inventory_financials with costStatus: EXACT_RECONCILED but null totalCostExact -> DENIED
      await assertFails(setDoc(doc(admin1Db, 'branches/khalid-1/inventory_financials/mov-forged-2'), {
        id: 'mov-forged-2',
        branchId: 'khalid-1',
        movementId: 'mov-forged-2',
        medicineId: 'med-1',
        movementType: 'SALE',
        costStatus: 'EXACT_RECONCILED',
        costProvenanceType: 'SALE_FIFO_EXACT',
        costPerBaseUnitExact: { num: 4, den: 1 },
        totalCostExact: null,
        unresolvedBaseUnits: 0,
        reconciledByUid: 'admin-1',
        createdAt: serverTimestamp(),
      }));

      // 3) Forged stocktake ADJUSTMENT claiming STOCKTAKE_V2_APPROVED_EXACT without sourceReferenceId -> DENIED
      await assertFails(setDoc(doc(admin1Db, 'branches/khalid-1/inventory_financials/mov-forged-3'), {
        id: 'mov-forged-3',
        branchId: 'khalid-1',
        movementId: 'mov-forged-3',
        medicineId: 'med-1',
        movementType: 'ADJUSTMENT',
        costStatus: 'EXACT_RECONCILED',
        costProvenanceType: 'STOCKTAKE_V2_APPROVED_EXACT',
        costPerBaseUnitExact: { num: 4, den: 1 },
        totalCostExact: { num: -40, den: 1 },
        unresolvedBaseUnits: 0,
        reconciledByUid: 'admin-1',
        createdAt: serverTimestamp(),
      }));

      // 4) Service-level verifyHistoricalCostProvenanceAndEligibility rejects forged flags
      const unverifiedHist = verifyHistoricalCostProvenanceAndEligibility({
        movementId: 'mov-1',
        medicineId: 'med-1',
        movementType: 'ADJUSTMENT',
        baseUnitsDelta: -10,
        costStatus: 'EXACT_HISTORICAL',
        costProvenanceType: 'STOCKTAKE_V2_APPROVED_EXACT',
        costPerBaseUnitExact: { num: 4, den: 1 },
        totalCostExact: { num: -40, den: 1 },
        unresolvedBaseUnits: 0,
        movementHistoryVerified: false,
        sourceReferenceId: 'post-1',
      });
      assert.equal(unverifiedHist.eligibleForExactReconciliation, false);
      assert.equal(unverifiedHist.resolvedStatus, 'NEEDS_REVIEW');
      assert.equal(unverifiedHist.rejectionReason, 'MOVEMENT_HISTORY_UNVERIFIED');

      const badMath = verifyHistoricalCostProvenanceAndEligibility({
        movementId: 'mov-1',
        medicineId: 'med-1',
        movementType: 'ADJUSTMENT',
        baseUnitsDelta: -10,
        costStatus: 'EXACT_RECONCILED',
        costProvenanceType: 'STOCKTAKE_V2_APPROVED_EXACT',
        costPerBaseUnitExact: { num: 4, den: 1 },
        totalCostExact: { num: -999, den: 1 }, // Mismatched total cost!
        unresolvedBaseUnits: 0,
        movementHistoryVerified: true,
        sourceReferenceId: 'post-1',
      });
      assert.equal(badMath.eligibleForExactReconciliation, false);
      assert.equal(badMath.resolvedStatus, 'NEEDS_REVIEW');
      assert.equal(badMath.rejectionReason, 'COST_VALUATION_RATIONAL_MISMATCH');

      const validCheck = verifyHistoricalCostProvenanceAndEligibility({
        movementId: 'mov-1',
        medicineId: 'med-1',
        movementType: 'ADJUSTMENT',
        baseUnitsDelta: -10,
        costStatus: 'EXACT_RECONCILED',
        costProvenanceType: 'STOCKTAKE_V2_APPROVED_EXACT',
        costPerBaseUnitExact: { num: 4, den: 1 },
        totalCostExact: { num: -40, den: 1 },
        unresolvedBaseUnits: 0,
        movementHistoryVerified: true,
        sourceReferenceId: 'post-1',
      });
      assert.equal(validCheck.eligibleForExactReconciliation, true);
      assert.equal(validCheck.resolvedStatus, 'EXACT_RECONCILED');
    });

    console.log('\n============================================================');
    console.log(`R3.2 + Phase 2F REAL FIRESTORE EMULATOR SUMMARY:`);
    console.log(`  CASES PASSED:  ${passed}`);
    console.log(`  CASES FAILED:  ${failed}`);
    console.log(`  NON-EMULATOR BOUNDARY RECORDED: ${skippedNonEmulator} (M-30)`);
    console.log(`  POSITIVE ASSERTIONS (assertSucceeds): ${positiveAssertions}`);
    console.log(`  NEGATIVE ASSERTIONS (assertFails):    ${negativeAssertions}`);
    console.log('============================================================');

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((err) => {
  console.error('FATAL EMULATOR TEST RUNNER ERROR:', err);
  process.exit(1);
});
