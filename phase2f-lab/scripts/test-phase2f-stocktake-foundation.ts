/**
 * Phase 2F — Intelligent Continuous Stocktake Foundation Verification Suite
 *
 * Tests all pure, isolated Phase 2F foundation components without touching
 * protected files (`pharmacyDb.ts`, `outboxFeatureFlags.ts`, `outboxV2Worker.ts`,
 * `firebase.json`, `data/bankak-server.lock`) or live Firebase production data.
 */

import assert from 'node:assert/strict';
import { createRational, equalsRational } from '../src/services/exactFinance.ts';
import {
  assertOperationalStocktakePayloadSafe,
  assertSharedOperationalItemSafe,
  buildStocktakeCountEventId,
  FORBIDDEN_SHARED_ITEM_COUNT_FIELDS,
  buildRemainingMedicinesPublicView,
  buildCashierOwnConfirmedCountsView,
  canDeleteStocktakeSession,
  canTransitionStocktakeSessionState,
  computeMovementWatermarkDigest,
  FORBIDDEN_OPERATIONAL_STOCKTAKE_FIELDS,
  FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS,
  FORBIDDEN_REMAINING_LIST_FIELDS,
  scanForForbiddenKeys,
  validateFinancialLineExactInvariants,
  type OperationalCountSubmissionEvent,
  type OperationalStocktakeItem,
  type StocktakeCountWatermark,
} from '../src/services/stocktakeContract.ts';
import {
  acquireStocktakeItemLease,
  expireStaleStocktakeLease,
  isItemGloballyConfirmedCounted,
  releaseStocktakeItemLease,
  renewStocktakeItemLease,
  requestStocktakeRecount,
  submitCountUnderLease,
  verifyStocktakeItemCount,
} from '../src/services/stocktakeLeaseStateMachine.ts';
import {
  evaluateStocktakeApprovalEligibility,
  evaluateStocktakePostingPreFlight,
  classifyMovementRelativeToCountReference,
  reconcileMedicineAtCountReference,
  resolveExactBaseUnitsPerUnit,
  valuateStocktakeVarianceExact,
  verifySaleItemsAgainstLedgerMovements,
  type BatchHistoricalCostLayer,
  type MedicineUnitConversionSpec,
  type ReconcilableLedgerMovement,
} from '../src/services/stocktakeReconciliationEngine.ts';

let passed = 0;
let failed = 0;

function runTest(id: string, title: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${id}: ${title}`);
  } catch (err) {
    failed += 1;
    console.error(`  [FAIL] ${id}: ${title}`);
    console.error('        ', err instanceof Error ? err.message : String(err));
  }
}

const BASE_TIME = 1_764_000_000_000;

function makeItem(overrides: Partial<OperationalStocktakeItem> = {}): OperationalStocktakeItem {
  return {
    id: 'med-amox-500',
    sessionId: 'sess-2f-001',
    branchId: 'khalid-1',
    medicineId: 'med-amox-500',
    medicineName: 'Amoxicillin 500mg Caps',
    strength: '500mg',
    dosageForm: 'capsule',
    primaryBarcode: '6281000000012',
    secondaryBarcodes: ['6281000000099'],
    availableUnits: ['pack', 'strip', 'pill'],
    state: 'AVAILABLE',
    syncStatus: 'CONFIRMED',
    activeLease: null,
    leaseVersion: 0,
    countRevision: 0,

    recountReason: null,
    operationalDiscrepancyFlag: 'NONE',
    updatedAtMs: BASE_TIME,
    ...overrides,
  };
}

function makeWatermark(
  knownIds: string[],
  countBusinessAtMs = BASE_TIME + 100_000,
  medicineLedgerSeq: number | null = null
): StocktakeCountWatermark {
  return {
    countBusinessAtMs,
    localPersistedAtMs: countBusinessAtMs + 50,
    serverConfirmedAtMs: countBusinessAtMs + 200,
    medicineLedgerSeq,
    knownMovementIdsAtCount: [...knownIds],
    knownMovementCount: knownIds.length,
    watermarkDigest: computeMovementWatermarkDigest(knownIds),
  };
}

const SOLID_SPEC: MedicineUnitConversionSpec = {
  medicineId: 'med-amox-500',
  unitOperationalAllowed: true,
  unitMode: 'SOLID_TWO_LEVEL',
  stripsPerPack: 2,
  pillsPerStrip: 10,
  baseUnitsPerPack: 20,
};

const DIRECT_SPEC: MedicineUnitConversionSpec = {
  medicineId: 'med-syrup-100',
  unitOperationalAllowed: true,
  unitMode: 'DIRECT_PACK',
  stripsPerPack: 1,
  pillsPerStrip: 1,
  baseUnitsPerPack: 1,
};

console.log('========================================================================');
console.log('PHASE 2F — INTELLIGENT CONTINUOUS STOCKTAKE FOUNDATION TEST SUITE');
console.log('========================================================================');

// ---------------------------------------------------------------------------
// 1. COLLABORATIVE COUNTING & LEASE CONCURRENCY
// ---------------------------------------------------------------------------
runTest('F2F-01', 'Two employees reserving the same item simultaneously -> exactly one winner (CAS)', () => {
  const item = makeItem();
  const r1 = acquireStocktakeItemLease({
    item,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-1',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME + 1_000,
    isSharedOnlineTransaction: true,
  });
  assert.equal(r1.ok, true);
  if (!r1.ok) return;

  // Concurrent second employee attempts with stale leaseVersion 0
  const r2Stale = acquireStocktakeItemLease({
    item: r1.item,
    actorUid: 'cashier-2',
    actorDisplayName: 'Sara',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-2',
    leaseId: 'lease-2',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME + 1_050,
    isSharedOnlineTransaction: true,
  });
  assert.equal(r2Stale.ok, false);
  if (!r2Stale.ok) assert.equal(r2Stale.code, 'LEASE_VERSION_MISMATCH');

  // Even after reading fresh version 1, active lease blocks second employee
  const r2Fresh = acquireStocktakeItemLease({
    item: r1.item,
    actorUid: 'cashier-2',
    actorDisplayName: 'Sara',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-2',
    leaseId: 'lease-2',
    expectedLeaseVersion: 1,
    serverNowMs: BASE_TIME + 1_100,
    isSharedOnlineTransaction: true,
  });
  assert.equal(r2Fresh.ok, false);
  if (!r2Fresh.ok) assert.equal(r2Fresh.code, 'LEASE_CONFLICT_ACTIVE');
});

runTest('F2F-02', 'Two employees counting different items simultaneously -> independent zero-contention success', () => {
  const itemA = makeItem({ id: 'med-a', medicineId: 'med-a', medicineName: 'Drug A' });
  const itemB = makeItem({ id: 'med-b', medicineId: 'med-b', medicineName: 'Drug B' });

  const lA = acquireStocktakeItemLease({
    item: itemA,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-a',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME + 1_000,
    isSharedOnlineTransaction: true,
  });
  const lB = acquireStocktakeItemLease({
    item: itemB,
    actorUid: 'cashier-2',
    actorDisplayName: 'Sara',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-2',
    leaseId: 'lease-b',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME + 1_000,
    isSharedOnlineTransaction: true,
  });
  assert.equal(lA.ok, true);
  assert.equal(lB.ok, true);
});

runTest('F2F-03', 'Lease renewal succeeds for owner before server expiry and blocks after expiry', () => {
  const l1 = acquireStocktakeItemLease({
    item: makeItem(),
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-r',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME,
    isSharedOnlineTransaction: true,
    ttlMs: 60_000,
  });
  assert.equal(l1.ok, true);
  if (!l1.ok) return;

  const renewed = renewStocktakeItemLease({
    item: l1.item,
    actorUid: 'cashier-1',
    leaseId: 'lease-r',
    expectedLeaseVersion: 1,
    serverNowMs: BASE_TIME + 45_000,
    ttlMs: 60_000,
  });
  assert.equal(renewed.ok, true);
  if (!renewed.ok) return;
  assert.equal(renewed.item.leaseVersion, 2);
  assert.equal(renewed.item.activeLease?.renewalCount, 1);
  assert.equal(renewed.item.activeLease?.expiresAtServerMs, BASE_TIME + 105_000);

  // Attempting renewal AFTER server expiry fails
  const expiredRenew = renewStocktakeItemLease({
    item: renewed.item,
    actorUid: 'cashier-1',
    leaseId: 'lease-r',
    expectedLeaseVersion: 2,
    serverNowMs: BASE_TIME + 105_001,
  });
  assert.equal(expiredRenew.ok, false);
  if (!expiredRenew.ok) assert.equal(expiredRenew.code, 'LEASE_EXPIRED');
});

runTest('F2F-04', 'Saved count SURVIVES lease expiry and stale cleanup (never overwritten!)', () => {
  const l1 = acquireStocktakeItemLease({
    item: makeItem(),
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-save',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME,
    isSharedOnlineTransaction: true,
    ttlMs: 60_000,
  });
  assert.equal(l1.ok, true);
  if (!l1.ok) return;

  const submitted = submitCountUnderLease({
    item: l1.item,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-save',
    expectedLeaseVersion: 1,
    countedQuantity: 5,
    countUnit: 'pack',
    baseUnitsPerCountUnit: 20,
    watermark: makeWatermark(['mov-init-1'], BASE_TIME + 10_000),
    serverNowMs: BASE_TIME + 10_500,
  });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  assert.equal(submitted.item.state, 'COUNTED');
  assert.equal(submitted.countEvent?.countedBaseUnits, 100);
  assert.equal(submitted.countEvent?.eventId, 'med-amox-500__r1');
  assert.deepEqual(scanForForbiddenKeys(submitted.item, FORBIDDEN_SHARED_ITEM_COUNT_FIELDS), []);
  assert.equal(isItemGloballyConfirmedCounted(submitted.item), true);

  // Much later, stale cleanup / lease expiry runs -> MUST NOT overwrite saved count
  const afterExpiry = expireStaleStocktakeLease({
    item: submitted.item,
    serverNowMs: BASE_TIME + 999_999,
  });
  assert.equal(afterExpiry.ok, false);
  if (!afterExpiry.ok) assert.equal(afterExpiry.code, 'COUNT_ALREADY_CONFIRMED_PROTECTED');
});

runTest('F2F-05', 'Stale lease after owner offline/browser closed expires cleanly and allows next counter', () => {
  const l1 = acquireStocktakeItemLease({
    item: makeItem(),
    actorUid: 'cashier-offline',
    actorDisplayName: 'Offline User',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-dead',
    leaseId: 'lease-dead',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME,
    isSharedOnlineTransaction: true,
    ttlMs: 60_000,
  });
  assert.equal(l1.ok, true);
  if (!l1.ok) return;

  // Before expiry -> cleanup rejected
  const tooEarly = expireStaleStocktakeLease({ item: l1.item, serverNowMs: BASE_TIME + 59_000 });
  assert.equal(tooEarly.ok, false);

  // After expiry -> another employee can directly take over via expired-lease acquisition
  const takeover = acquireStocktakeItemLease({
    item: l1.item,
    actorUid: 'cashier-2',
    actorDisplayName: 'Sara',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-2',
    leaseId: 'lease-2',
    expectedLeaseVersion: 1,
    serverNowMs: BASE_TIME + 61_000,
    isSharedOnlineTransaction: true,
  });
  assert.equal(takeover.ok, true);
  if (!takeover.ok) return;
  assert.equal(takeover.item.activeLease?.ownerUid, 'cashier-2');
  assert.equal(takeover.item.leaseVersion, 2);
});

runTest('F2F-06', 'Recount preserves previous count event reference and blocks while active lease held', () => {
  const l1 = acquireStocktakeItemLease({
    item: makeItem(),
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-1',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME,
    isSharedOnlineTransaction: true,
  });
  assert.equal(l1.ok, true);
  if (!l1.ok) return;

  // Admin cannot recount while cashier-1 holds an active lease
  const blockedWhileLeased = requestStocktakeRecount({
    item: l1.item,
    actorUid: 'admin-1',
    actorRole: 'admin',
    actorBranchId: 'khalid-1',
    reason: 'Premature recount attempt',
    serverNowMs: BASE_TIME + 5_000,
  });
  assert.equal(blockedWhileLeased.ok, false);
  if (!blockedWhileLeased.ok) assert.equal(blockedWhileLeased.code, 'ACTIVE_LEASE_MUST_EXPIRE_OR_BE_RELEASED');

  const sub1 = submitCountUnderLease({
    item: l1.item,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-1',
    expectedLeaseVersion: 1,
    countedQuantity: 4,
    countUnit: 'pack',
    baseUnitsPerCountUnit: 20,
    watermark: makeWatermark(['m1'], BASE_TIME + 10_000),
    serverNowMs: BASE_TIME + 10_500,
  });
  assert.equal(sub1.ok, true);
  if (!sub1.ok || !sub1.countEvent) return;
  const firstEventId = sub1.countEvent.eventId;

  // Cashier cannot request recount
  const cashierRecount = requestStocktakeRecount({
    item: sub1.item,
    actorUid: 'cashier-2',
    actorRole: 'cashier',
    actorBranchId: 'khalid-1',
    reason: 'Trying unauthorized recount',
    serverNowMs: BASE_TIME + 20_000,
  });
  assert.equal(cashierRecount.ok, false);
  if (!cashierRecount.ok) assert.equal(cashierRecount.code, 'UNAUTHORIZED_ROLE');

  // Admin requests recount -> previous latestCountEventId preserved
  const recountReq = requestStocktakeRecount({
    item: sub1.item,
    actorUid: 'admin-1',
    actorRole: 'admin',
    actorBranchId: 'khalid-1',
    reason: 'Large shelf deficit observed',
    serverNowMs: BASE_TIME + 20_000,
  });
  assert.equal(recountReq.ok, true);
  if (!recountReq.ok) return;
  assert.equal(recountReq.item.state, 'NEEDS_RECOUNT');
  assert.equal(recountReq.item.countRevision, 1);
  assert.equal(buildStocktakeCountEventId({ medicineId: recountReq.item.medicineId, countRevision: recountReq.item.countRevision }), firstEventId);

  // Second employee acquires lease and submits recount -> chains recountOfEventId
  const l2 = acquireStocktakeItemLease({
    item: recountReq.item,
    actorUid: 'cashier-2',
    actorDisplayName: 'Sara',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-2',
    leaseId: 'lease-recount-2',
    expectedLeaseVersion: recountReq.item.leaseVersion,
    serverNowMs: BASE_TIME + 25_000,
    isSharedOnlineTransaction: true,
  });
  assert.equal(l2.ok, true);
  if (!l2.ok) return;

  const sub2 = submitCountUnderLease({
    item: l2.item,
    actorUid: 'cashier-2',
    actorDisplayName: 'Sara',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-2',
    leaseId: 'lease-recount-2',
    expectedLeaseVersion: l2.item.leaseVersion,
    countedQuantity: 5,
    countUnit: 'pack',
    baseUnitsPerCountUnit: 20,
    watermark: makeWatermark(['m1'], BASE_TIME + 30_000),
    serverNowMs: BASE_TIME + 30_500,
  });
  assert.equal(sub2.ok, true);
  if (!sub2.ok || !sub2.countEvent) return;
  assert.equal(sub2.countEvent.countRevision, 2);
  assert.equal(sub2.countEvent.recountOfEventId, firstEventId);
  assert.notEqual(sub2.countEvent.eventId, firstEventId);
});

// ---------------------------------------------------------------------------
// 2. OFFLINE & SYNC BOUNDARY + REMAINING LIST PRIVACY
// ---------------------------------------------------------------------------
runTest('F2F-07', 'Offline reservation forbidden as shared lease; LOCAL_PENDING stays visible in remaining list', () => {
  const offlineAttempt = acquireStocktakeItemLease({
    item: makeItem(),
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-offline',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME,
    isSharedOnlineTransaction: false,
  });
  assert.equal(offlineAttempt.ok, false);
  if (!offlineAttempt.ok) assert.equal(offlineAttempt.code, 'OFFLINE_SHARED_RESERVATION_FORBIDDEN');

  // Local pending count MUST NOT disappear from shared remaining list
  const localPendingItem = makeItem({
    id: 'med-local',
    medicineId: 'med-local',
    state: 'COUNTED',
    syncStatus: 'LOCAL_PENDING',
  });
  const confirmedItem = makeItem({
    id: 'med-done',
    medicineId: 'med-done',
    state: 'COUNTED',
    syncStatus: 'CONFIRMED',
  });
  const remaining = buildRemainingMedicinesPublicView([localPendingItem, confirmedItem], 'cashier-2');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].medicineId, 'med-local');

  // Remaining view MUST contain ZERO quantities, prices, or financial fields
  const leaked = scanForForbiddenKeys(remaining, FORBIDDEN_REMAINING_LIST_FIELDS);
  assert.deepEqual(leaked, []);
});

runTest('F2F-08', 'Network retry idempotency: repeating lease acquire and count submit returns idempotentReplay', () => {
  const l1 = acquireStocktakeItemLease({
    item: makeItem(),
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-idem',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME,
    isSharedOnlineTransaction: true,
  });
  assert.equal(l1.ok, true);
  if (!l1.ok) return;

  const l1Retry = acquireStocktakeItemLease({
    item: l1.item,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-idem',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME + 5_000,
    isSharedOnlineTransaction: true,
  });
  assert.equal(l1Retry.ok, true);
  if (l1Retry.ok) assert.equal(l1Retry.idempotentReplay, true);

  const sub = submitCountUnderLease({
    item: l1.item,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-idem',
    expectedLeaseVersion: 1,
    countedQuantity: 3,
    countUnit: 'pack',
    baseUnitsPerCountUnit: 20,
    watermark: makeWatermark(['m1'], BASE_TIME + 6_000),
    serverNowMs: BASE_TIME + 6_500,
  });
  assert.equal(sub.ok, true);
  if (!sub.ok) return;

  const subRetry = submitCountUnderLease({
    item: sub.item,
    existingConfirmedEvent: sub.countEvent,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-idem',
    expectedLeaseVersion: 1,
    countedQuantity: 3,
    countUnit: 'pack',
    baseUnitsPerCountUnit: 20,
    watermark: makeWatermark(['m1'], BASE_TIME + 6_000),
    serverNowMs: BASE_TIME + 7_000,
  });
  assert.equal(subRetry.ok, true);
  if (subRetry.ok) assert.equal(subRetry.idempotentReplay, true);
});

// ---------------------------------------------------------------------------
// 3. SECURITY DOMAIN ISOLATION & FINANCIAL FIELD INJECTION BLOCKING
// ---------------------------------------------------------------------------
runTest('F2F-09', 'Financial field injection blocked recursively on operational stocktake payloads', () => {
  const safeCheck = assertOperationalStocktakePayloadSafe(makeItem());
  assert.equal(safeCheck.valid, true);

  const injectedTop = { ...makeItem(), buyPrice: 1200 };
  const topRes = assertOperationalStocktakePayloadSafe(injectedTop);
  assert.equal(topRes.valid, false);
  assert.ok(topRes.forbiddenFieldsFound.includes('buyPrice'));

  const injectedNested = { ...makeItem(), metadata: { hidden: [{ varianceCost: -5000, netProfit: 800 }] } };
  const nestedRes = assertOperationalStocktakePayloadSafe(injectedNested);
  assert.equal(nestedRes.valid, false);
  assert.equal(nestedRes.forbiddenFieldsFound.length, 2);
});

// ---------------------------------------------------------------------------
// 4. COUNT-TIME WATERMARK & POST-COUNT MOVEMENT RECONCILIATION
// ---------------------------------------------------------------------------
runTest('F2F-10', 'Reconciles post-count SALE, PURCHASE, customer RETURN, PURCHASE_RETURN, DAMAGE, ADJUSTMENT + late-synced pre/post-count movements', () => {
  const countTime = BASE_TIME + 1_000_000;
  const countEvent: OperationalCountSubmissionEvent = {
    eventId: 'cnt_001_r1',
    idempotencyKey: 'key-1',
    sessionId: 'sess-2f-001',
    branchId: 'khalid-1',
    medicineId: 'med-amox-500',
    countRevision: 1,
    leaseId: 'l1',
    leaseVersion: 1,
    countedQuantity: 5, // 5 packs * 20 pills = 100 pills physically on shelf at countTime
    countUnit: 'pack',
    baseUnitsPerCountUnit: 20,
    countedBaseUnits: 100,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    deviceId: 'dev-1',
    watermark: makeWatermark(['mov-init', 'mov-pre-sale'], countTime),
    syncStatus: 'CONFIRMED',
    recountOfEventId: null,
    notes: '',
  };

  const movements: ReconcilableLedgerMovement[] = [
    // Pre-count INITIAL: +140 pills (in watermark)
    {
      id: 'mov-init', branchId: 'khalid-1', medicineId: 'med-amox-500', batchNumber: 'B1', expiry: '2027-01-01',
      type: 'INITIAL', unit: 'pack', quantityDelta: 7, baseUnitsDelta: 140,
      referenceId: 'init-1', businessOccurredAtMs: BASE_TIME, localPersistedAtMs: BASE_TIME, serverSyncedAtMs: BASE_TIME + 100, synced: true,
    },
    // Pre-count SALE: -20 pills (in watermark)
    {
      id: 'mov-pre-sale', branchId: 'khalid-1', medicineId: 'med-amox-500', batchNumber: 'B1', expiry: '2027-01-01',
      type: 'SALE', unit: 'pack', quantityDelta: -1, baseUnitsDelta: -20,
      referenceId: 'sale-1', businessOccurredAtMs: countTime - 200_000, localPersistedAtMs: countTime - 200_000, serverSyncedAtMs: countTime - 199_000, synced: true,
    },
    // Pre-count OFFLINE SALE created BEFORE countTime (-20 pills) but synchronized AFTER countTime -> MUST BE EXCLUDED!
    {
      id: 'mov-pre-offline-late-sync', branchId: 'khalid-1', medicineId: 'med-amox-500', batchNumber: 'B1', expiry: '2027-01-01',
      type: 'SALE', unit: 'pack', quantityDelta: -1, baseUnitsDelta: -20,
      referenceId: 'sale-offline-pre', businessOccurredAtMs: countTime - 120_000, localPersistedAtMs: countTime - 120_000, serverSyncedAtMs: countTime + 500_000, synced: true,
    },
    // Post-count SALE: -10 pills
    {
      id: 'mov-post-sale', branchId: 'khalid-1', medicineId: 'med-amox-500', batchNumber: 'B1', expiry: '2027-01-01',
      type: 'SALE', unit: 'strip', quantityDelta: -1, baseUnitsDelta: -10,
      referenceId: 'sale-2', businessOccurredAtMs: countTime + 60_000, localPersistedAtMs: countTime + 60_000, serverSyncedAtMs: countTime + 61_000, synced: true,
    },
    // Post-count PURCHASE: +40 pills
    {
      id: 'mov-post-purchase', branchId: 'khalid-1', medicineId: 'med-amox-500', batchNumber: 'B2', expiry: '2027-06-01',
      type: 'PURCHASE', unit: 'pack', quantityDelta: 2, baseUnitsDelta: 40,
      referenceId: 'po-1', businessOccurredAtMs: countTime + 120_000, localPersistedAtMs: countTime + 120_000, serverSyncedAtMs: countTime + 121_000, synced: true,
    },
    // Post-count customer RETURN: +5 pills
    {
      id: 'mov-post-cust-ret', branchId: 'khalid-1', medicineId: 'med-amox-500', batchNumber: 'B1', expiry: '2027-01-01',
      type: 'RETURN', unit: 'pill', quantityDelta: 5, baseUnitsDelta: 5,
      referenceId: 'sale-2', businessOccurredAtMs: countTime + 180_000, localPersistedAtMs: countTime + 180_000, serverSyncedAtMs: countTime + 181_000, synced: true,
    },
    // Post-count supplier PURCHASE_RETURN: -20 pills
    {
      id: 'mov-post-sup-ret', branchId: 'khalid-1', medicineId: 'med-amox-500', batchNumber: 'B2', expiry: '2027-06-01',
      type: 'PURCHASE_RETURN', unit: 'pack', quantityDelta: -1, baseUnitsDelta: -20,
      referenceId: 'po-1', businessOccurredAtMs: countTime + 240_000, localPersistedAtMs: countTime + 240_000, serverSyncedAtMs: countTime + 241_000, synced: true,
    },
    // Post-count DAMAGE: -3 pills (synchronized very late!)
    {
      id: 'mov-post-dmg-late', branchId: 'khalid-1', medicineId: 'med-amox-500', batchNumber: 'B1', expiry: '2027-01-01',
      type: 'DAMAGE', unit: 'pill', quantityDelta: -3, baseUnitsDelta: -3,
      referenceId: 'dmg-1', businessOccurredAtMs: countTime + 300_000, localPersistedAtMs: countTime + 300_000, serverSyncedAtMs: countTime + 999_000, synced: true,
    },
    // Post-count positive ADJUSTMENT: +2 pills
    {
      id: 'mov-post-adj', branchId: 'khalid-1', medicineId: 'med-amox-500', batchNumber: 'B1', expiry: '2027-01-01',
      type: 'ADJUSTMENT', unit: 'pill', quantityDelta: 2, baseUnitsDelta: 2,
      referenceId: 'adj-1', businessOccurredAtMs: countTime + 360_000, localPersistedAtMs: countTime + 360_000, serverSyncedAtMs: countTime + 361_000, synced: true,
    },
  ];

  // SystemCurrent = 140 - 20 - 20 - 10 + 40 + 5 - 20 - 3 + 2 = 114
  // NetPostCount  = -10 + 40 + 5 - 20 - 3 + 2 = +14 (mov-pre-offline-late-sync EXCLUDED!)
  // ExpectedCurrent = 100 + 14 = 114 => QuantityVariance = 114 - 114 = 0 (MATCHED!)
  const res = reconcileMedicineAtCountReference({
    sessionId: 'sess-2f-001',
    branchId: 'khalid-1',
    reconciliationVersion: 1,
    countEvent,
    unitSpec: SOLID_SPEC,
    allMedicineLedgerMovements: movements,
    batchLayersFefo: [
      { batchNumber: 'B1', expiry: '2027-01-01', remainingBaseUnits: 94, costPerBaseUnitExact: createRational(100n), sourceReceiptMovementId: 'mov-init' },
      { batchNumber: 'B2', expiry: '2027-06-01', remainingBaseUnits: 20, costPerBaseUnitExact: createRational(150n), sourceReceiptMovementId: 'mov-post-purchase' },
    ],
    reconciledAtMs: countTime + 1_000_000,
  });

  assert.equal(res.financialLine.systemCurrentBaseUnits, 114);
  assert.equal(res.financialLine.netPostCountBaseUnitsDelta, 14);
  assert.equal(res.financialLine.expectedCurrentBaseUnits, 114);
  assert.equal(res.financialLine.quantityVarianceBaseUnits, 0);
  assert.equal(res.financialLine.discrepancyStatus, 'MATCHED');
  assert.equal(res.excludedPreCountMovementIds.includes('mov-pre-offline-late-sync'), true);
  assert.equal(res.includedPostCountMovementIds.includes('mov-post-dmg-late'), true);
  assert.deepEqual(validateFinancialLineExactInvariants(res.financialLine), []);
});

runTest('F2F-11', 'Detects duplicate ledger movement, ambiguous clock-skew movement, invalid unit conversion, and negative inventory -> NEEDS_REVIEW', () => {
  const countTime = BASE_TIME + 1_000_000;
  const countEvent: OperationalCountSubmissionEvent = {
    eventId: 'cnt_002_r1',
    idempotencyKey: 'key-2',
    sessionId: 'sess-2f-001',
    branchId: 'khalid-1',
    medicineId: 'med-syrup-100',
    countRevision: 1,
    leaseId: 'l2',
    leaseVersion: 1,
    countedQuantity: 2,
    countUnit: 'strip', // INVALID for DIRECT_PACK!
    baseUnitsPerCountUnit: 1,
    countedBaseUnits: 2,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    deviceId: 'dev-1',
    watermark: makeWatermark([], countTime),
    syncStatus: 'CONFIRMED',
    recountOfEventId: null,
    notes: '',
  };

  const mov: ReconcilableLedgerMovement = {
    id: 'mov-dup', branchId: 'khalid-1', medicineId: 'med-syrup-100', batchNumber: 'B1',
    type: 'SALE', unit: 'pack', quantityDelta: -5, baseUnitsDelta: -5,
    referenceId: 'sale-neg', businessOccurredAtMs: countTime + 5_000, // inside 30s ambiguity window!
    localPersistedAtMs: countTime + 5_000, serverSyncedAtMs: countTime + 6_000, synced: true,
  };

  const res = reconcileMedicineAtCountReference({
    sessionId: 'sess-2f-001',
    branchId: 'khalid-1',
    reconciliationVersion: 1,
    countEvent,
    unitSpec: DIRECT_SPEC,
    allMedicineLedgerMovements: [mov, mov], // duplicate ID!
    batchLayersFefo: [],
    reconciledAtMs: countTime + 100_000,
  });

  assert.equal(res.financialLine.discrepancyStatus, 'NEEDS_REVIEW');
  assert.ok(res.financialLine.integrityBlockers.some((b) => b.includes('INVALID_UNIT_CONVERSION')));
  assert.ok(res.financialLine.integrityBlockers.some((b) => b.includes('DUPLICATE_LEDGER_MOVEMENT')));
  assert.ok(res.financialLine.integrityBlockers.some((b) => b.includes('AMBIGUOUS_MOVEMENT_ORDERING')));
  assert.ok(res.financialLine.integrityBlockers.some((b) => b.includes('NEGATIVE_SYSTEM_INVENTORY')));
});

// ---------------------------------------------------------------------------
// 5. EXACT RATIONAL MULTI-BATCH COST PROVENANCE (NO CATALOG buyPrice SUBSTITUTION)
// ---------------------------------------------------------------------------
runTest('F2F-12', 'Multi-batch partial consumption deficit uses exact BigInt Rational batch costs (never catalog buyPrice)', () => {
  const layers: BatchHistoricalCostLayer[] = [
    // Batch A: 10 pills @ 100/3 SDG/pill (exact non-terminating decimal 33.333...!)
    { batchNumber: 'B-A', expiry: '2027-01-01', remainingBaseUnits: 10, costPerBaseUnitExact: createRational(100n, 3n), sourceReceiptMovementId: 'rec-A' },
    // Batch B: 15 pills @ 150/1 SDG/pill
    { batchNumber: 'B-B', expiry: '2027-06-01', remainingBaseUnits: 15, costPerBaseUnitExact: createRational(150n, 1n), sourceReceiptMovementId: 'rec-B' },
  ];

  // Deficit of 14 pills => 10 from B-A (1000/3) + 4 from B-B (600 = 1800/3) = 2800/3 SDG loss -> -2800/3
  const val = valuateStocktakeVarianceExact({
    requiredLedgerAdjustmentBaseUnits: -14,
    expectedCurrentBaseUnits: 11,
    batchLayersFefo: layers,
  });

  assert.equal(val.costStatus, 'EXACT_HISTORICAL');
  assert.notEqual(val.financialVarianceExact, null);
  assert.equal(equalsRational(val.financialVarianceExact!, createRational(-2800n, 3n)), true);
  assert.equal(val.allocatedLayers.length, 2);
  assert.equal(val.allocatedLayers[0].baseUnits, 10);
  assert.equal(val.allocatedLayers[1].baseUnits, 4);
});

runTest('F2F-13', 'Legacy unbatched deficit & unexplained surplus fail closed to NEEDS_REVIEW with null financial cost', () => {
  // Missing batch cost provenance on legacy layer -> NEEDS_REVIEW
  const legacyDeficit = valuateStocktakeVarianceExact({
    requiredLedgerAdjustmentBaseUnits: -5,
    expectedCurrentBaseUnits: 10,
    batchLayersFefo: [
      { batchNumber: 'LEGACY', expiry: '2027-01-01', remainingBaseUnits: 15, costPerBaseUnitExact: null, sourceReceiptMovementId: null },
    ],
  });
  assert.equal(legacyDeficit.costStatus, 'NEEDS_REVIEW');
  assert.equal(legacyDeficit.financialVarianceExact, null);

  // Unexplained surplus without verified historical receipt -> NEEDS_REVIEW (no invented cost!)
  const unexplainedSurplus = valuateStocktakeVarianceExact({
    requiredLedgerAdjustmentBaseUnits: +7,
    expectedCurrentBaseUnits: 22,
    batchLayersFefo: [
      { batchNumber: 'B1', expiry: '2027-01-01', remainingBaseUnits: 15, costPerBaseUnitExact: createRational(100n), sourceReceiptMovementId: 'rec-1' },
    ],
  });
  assert.equal(unexplainedSurplus.costStatus, 'NEEDS_REVIEW');
  assert.equal(unexplainedSurplus.financialVarianceExact, null);
});

// ---------------------------------------------------------------------------
// 6. PER-ITEM SALE-TO-LEDGER RECONCILIATION (SECTION 13 / R3.2 GAP 1)
// ---------------------------------------------------------------------------
runTest('F2F-14', 'Per-item sale verification REJECTS 2-medicine sale where aggregate matches (-10) but per-item mismatches (7/3 vs 5/5)', () => {
  const unitMap = new Map<string, MedicineUnitConversionSpec>([
    ['med-a', { medicineId: 'med-a', unitOperationalAllowed: true, unitMode: 'DIRECT_PACK', stripsPerPack: 1, pillsPerStrip: 1, baseUnitsPerPack: 1 }],
    ['med-b', { medicineId: 'med-b', unitOperationalAllowed: true, unitMode: 'DIRECT_PACK', stripsPerPack: 1, pillsPerStrip: 1, baseUnitsPerPack: 1 }],
  ]);

  const saleItems = [
    { id: 'sale-99-item-0', branchId: 'khalid-1', saleId: 'sale-99', itemIndex: 0, medicineId: 'med-a', unit: 'pack' as const, qty: 7, baseUnits: 7, expectedLedgerCount: 1, ledgerRangeStart: 0 },
    { id: 'sale-99-item-1', branchId: 'khalid-1', saleId: 'sale-99', itemIndex: 1, medicineId: 'med-b', unit: 'pack' as const, qty: 3, baseUnits: 3, expectedLedgerCount: 1, ledgerRangeStart: 1 },
  ];

  // Aggregate sum = 10 == 7 + 3, BUT med-a is -5 and med-b is -5 -> MUST FAIL!
  const tamperedLedgers: ReconcilableLedgerMovement[] = [
    {
      id: 'l-a', branchId: 'khalid-1', medicineId: 'med-a', batchNumber: 'B1', type: 'SALE', unit: 'pack',
      quantityDelta: -5, baseUnitsDelta: -5, referenceId: 'sale-99', saleItemId: 'sale-99-item-0',
      businessOccurredAtMs: BASE_TIME, localPersistedAtMs: BASE_TIME, serverSyncedAtMs: BASE_TIME, synced: true,
    },
    {
      id: 'l-b', branchId: 'khalid-1', medicineId: 'med-b', batchNumber: 'B1', type: 'SALE', unit: 'pack',
      quantityDelta: -5, baseUnitsDelta: -5, referenceId: 'sale-99', saleItemId: 'sale-99-item-1',
      businessOccurredAtMs: BASE_TIME, localPersistedAtMs: BASE_TIME, serverSyncedAtMs: BASE_TIME, synced: true,
    },
  ];

  const badRes = verifySaleItemsAgainstLedgerMovements({
    branchId: 'khalid-1',
    saleId: 'sale-99',
    saleItems,
    saleLedgerMovements: tamperedLedgers,
    unitSpecsByMedicineId: unitMap,
  });
  assert.equal(badRes.valid, false);
  assert.ok(badRes.errors.some((e) => e.includes('SALE_ITEM_PER_ITEM_QTY_MISMATCH')));

  // Matching per-item ledgers (-7 and -3) -> PASS!
  const validLedgers: ReconcilableLedgerMovement[] = [
    { ...tamperedLedgers[0], quantityDelta: -7, baseUnitsDelta: -7 },
    { ...tamperedLedgers[1], quantityDelta: -3, baseUnitsDelta: -3 },
  ];
  const goodRes = verifySaleItemsAgainstLedgerMovements({
    branchId: 'khalid-1',
    saleId: 'sale-99',
    saleItems,
    saleLedgerMovements: validLedgers,
    unitSpecsByMedicineId: unitMap,
  });
  assert.equal(goodRes.valid, true);
  assert.equal(goodRes.checkedItems, 2);
});

// ---------------------------------------------------------------------------
// 7. APPROVAL EXCEPTION GATING, SESSION LIFECYCLE & POSTING IDEMPOTENCY
// ---------------------------------------------------------------------------
runTest('F2F-15', 'Admin unexplained-variance approval CANNOT bypass integrity blockers; valid approval + posting is idempotent and rejects stale state', () => {
  const countTime = BASE_TIME + 500_000;
  const countEvent: OperationalCountSubmissionEvent = {
    eventId: 'cnt_post_r1',
    idempotencyKey: 'key-post',
    sessionId: 'sess-2f-001',
    branchId: 'khalid-1',
    medicineId: 'med-amox-500',
    countRevision: 1,
    leaseId: 'l1',
    leaseVersion: 1,
    countedQuantity: 4, // 80 pills counted vs 100 in system => 20 pill deficit (QuantityVariance = +20, Adj = -20)
    countUnit: 'pack',
    baseUnitsPerCountUnit: 20,
    countedBaseUnits: 80,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    deviceId: 'dev-1',
    watermark: makeWatermark(['mov-init'], countTime),
    syncStatus: 'CONFIRMED',
    recountOfEventId: null,
    notes: '',
  };

  const initMov: ReconcilableLedgerMovement = {
    id: 'mov-init', branchId: 'khalid-1', medicineId: 'med-amox-500', batchNumber: 'B1', expiry: '2027-01-01',
    type: 'INITIAL', unit: 'pack', quantityDelta: 5, baseUnitsDelta: 100,
    referenceId: 'init', businessOccurredAtMs: BASE_TIME, localPersistedAtMs: BASE_TIME, serverSyncedAtMs: BASE_TIME, synced: true,
  };

  // A) With a sync conflict blocker -> Admin exception approval MUST BE REJECTED
  const blockedRec = reconcileMedicineAtCountReference({
    sessionId: 'sess-2f-001',
    branchId: 'khalid-1',
    reconciliationVersion: 1,
    countEvent,
    unitSpec: SOLID_SPEC,
    allMedicineLedgerMovements: [initMov],
    batchLayersFefo: [
      { batchNumber: 'B1', expiry: '2027-01-01', remainingBaseUnits: 100, costPerBaseUnitExact: createRational(50n), sourceReceiptMovementId: 'mov-init' },
    ],
    hasSyncConflict: true,
    reconciledAtMs: countTime + 50_000,
  });
  const blockedApproval = evaluateStocktakeApprovalEligibility({
    line: blockedRec.financialLine,
    actorUid: 'admin-1',
    actorRole: 'admin',
    actorBranchId: 'khalid-1',
    decision: 'APPROVED',
    isUnexplainedVarianceException: true,
    reason: 'Trying to override sync conflict',
    investigationRecordId: 'inv-001',
    approvalId: 'appr-bad',
    serverNowMs: countTime + 60_000,
  });
  assert.equal(blockedApproval.ok, false);
  if (!blockedApproval.ok) assert.equal(blockedApproval.code, 'INTEGRITY_BLOCKER_CANNOT_BE_BYPASSED');

  // B) Clean deficit with provable batch cost -> Cashier approval denied, Admin approval succeeds
  const cleanRec = reconcileMedicineAtCountReference({
    sessionId: 'sess-2f-001',
    branchId: 'khalid-1',
    reconciliationVersion: 1,
    countEvent,
    unitSpec: SOLID_SPEC,
    allMedicineLedgerMovements: [initMov],
    batchLayersFefo: [
      { batchNumber: 'B1', expiry: '2027-01-01', remainingBaseUnits: 100, costPerBaseUnitExact: createRational(50n), sourceReceiptMovementId: 'mov-init' },
    ],
    reconciledAtMs: countTime + 50_000,
  });
  assert.equal(cleanRec.financialLine.discrepancyStatus, 'UNEXPLAINED');
  assert.equal(cleanRec.financialLine.quantityVarianceBaseUnits, 20);
  assert.equal(cleanRec.financialLine.requiredLedgerAdjustmentBaseUnits, -20);
  assert.equal(equalsRational(cleanRec.financialLine.financialVarianceExact!, createRational(-1000n)), true);

  const cashierApproval = evaluateStocktakeApprovalEligibility({
    line: cleanRec.financialLine,
    actorUid: 'cashier-1',
    actorRole: 'cashier',
    actorBranchId: 'khalid-1',
    decision: 'APPROVED',
    isUnexplainedVarianceException: true,
    reason: 'Unauthorized cashier approval',
    investigationRecordId: 'inv-001',
    approvalId: 'appr-cashier',
    serverNowMs: countTime + 60_000,
  });
  assert.equal(cashierApproval.ok, false);

  const adminApproval = evaluateStocktakeApprovalEligibility({
    line: cleanRec.financialLine,
    actorUid: 'admin-1',
    actorRole: 'admin',
    actorBranchId: 'khalid-1',
    decision: 'APPROVED',
    isUnexplainedVarianceException: true,
    reason: 'Investigated shrinkage after recount verification',
    investigationRecordId: 'inv-001',
    approvalId: 'appr-001',
    serverNowMs: countTime + 60_000,
  });
  assert.equal(adminApproval.ok, true);
  if (!adminApproval.ok) return;

  // C) Posting pre-flight rejects if a new movement arrived since reconciliation!
  const stalePost = evaluateStocktakePostingPreFlight({
    line: cleanRec.financialLine,
    approval: adminApproval.approval,
    actorUid: 'admin-1',
    actorRole: 'admin',
    actorBranchId: 'khalid-1',
    freshCurrentLedgerMovementIds: ['mov-init', 'mov-new-sale-arrived'],
    reconciledLedgerMovementIds: ['mov-init'],
    freshCountRevision: 1,
    hasPendingLocalOrRemoteSync: false,
    existingPostingRecord: null,
    postingId: 'post-001',
    serverNowMs: countTime + 70_000,
  });
  assert.equal(stalePost.ok, false);
  if (!stalePost.ok) assert.equal(stalePost.code, 'STALE_STOCK_VERSION_NEW_MOVEMENTS');

  // D) Clean posting succeeds and produces deterministic ADJUSTMENT movement
  const validPost = evaluateStocktakePostingPreFlight({
    line: cleanRec.financialLine,
    approval: adminApproval.approval,
    actorUid: 'admin-1',
    actorRole: 'admin',
    actorBranchId: 'khalid-1',
    freshCurrentLedgerMovementIds: ['mov-init'],
    reconciledLedgerMovementIds: ['mov-init'],
    freshCountRevision: 1,
    hasPendingLocalOrRemoteSync: false,
    existingPostingRecord: null,
    postingId: 'post-001',
    serverNowMs: countTime + 70_000,
  });
  assert.equal(validPost.ok, true);
  if (!validPost.ok) return;
  assert.equal(validPost.idempotentAlreadyPosted, false);
  assert.equal(validPost.ledgerAdjustmentToCreate?.baseUnitsDelta, -20);

  // E) Duplicate posting retry with same idempotency key returns idempotentAlreadyPosted with ZERO duplicate ledger writes
  const retryPost = evaluateStocktakePostingPreFlight({
    line: cleanRec.financialLine,
    approval: adminApproval.approval,
    actorUid: 'admin-1',
    actorRole: 'admin',
    actorBranchId: 'khalid-1',
    freshCurrentLedgerMovementIds: ['mov-init'],
    reconciledLedgerMovementIds: ['mov-init'],
    freshCountRevision: 1,
    hasPendingLocalOrRemoteSync: false,
    existingPostingRecord: validPost.postingRecord,
    postingId: 'post-001',
    serverNowMs: countTime + 71_000,
  });
  assert.equal(retryPost.ok, true);
  if (retryPost.ok) {
    assert.equal(retryPost.idempotentAlreadyPosted, true);
    assert.equal(retryPost.ledgerAdjustmentToCreate, null);
  }
});

runTest('F2F-16', 'Session lifecycle transitions, pre-posting cancellation reason, and post-posting immutability', () => {
  assert.equal(canTransitionStocktakeSessionState({ from: 'DRAFT', to: 'IN_PROGRESS', actorRole: 'admin' }).allowed, true);
  assert.equal(canTransitionStocktakeSessionState({ from: 'DRAFT', to: 'IN_PROGRESS', actorRole: 'cashier' }).allowed, false);
  assert.equal(canTransitionStocktakeSessionState({ from: 'IN_PROGRESS', to: 'POSTED', actorRole: 'admin' }).allowed, false);
  assert.equal(canTransitionStocktakeSessionState({ from: 'APPROVED', to: 'CANCELLED', actorRole: 'admin', cancellationReason: '' }).allowed, false);
  assert.equal(canTransitionStocktakeSessionState({ from: 'APPROVED', to: 'CANCELLED', actorRole: 'admin', cancellationReason: 'Duplicate session opened by mistake' }).allowed, true);
  assert.equal(canTransitionStocktakeSessionState({ from: 'POSTED', to: 'CANCELLED', actorRole: 'super_admin', cancellationReason: 'Cannot cancel posted' }).allowed, false);
  assert.equal(canTransitionStocktakeSessionState({ from: 'POSTED', to: 'CLOSED', actorRole: 'admin' }).allowed, true);
  assert.equal(canDeleteStocktakeSession('DRAFT'), true);
  assert.equal(canDeleteStocktakeSession('APPROVED'), false);
  assert.equal(canDeleteStocktakeSession('POSTED'), false);
});

runTest('F2F-17', 'Verify counted item and release lease guards', () => {
  const l1 = acquireStocktakeItemLease({
    item: makeItem(),
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'dev-1',
    leaseId: 'lease-rel',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME,
    isSharedOnlineTransaction: true,
  });
  assert.equal(l1.ok, true);
  if (!l1.ok) return;

  // Another cashier cannot release cashier-1's active lease
  const deniedRel = releaseStocktakeItemLease({
    item: l1.item,
    actorUid: 'cashier-2',
    actorRole: 'cashier',
    expectedLeaseVersion: 1,
    serverNowMs: BASE_TIME + 5_000,
  });
  assert.equal(deniedRel.ok, false);

  // Owner releases cleanly -> back to AVAILABLE
  const okRel = releaseStocktakeItemLease({
    item: l1.item,
    actorUid: 'cashier-1',
    actorRole: 'cashier',
    expectedLeaseVersion: 1,
    serverNowMs: BASE_TIME + 5_000,
  });
  assert.equal(okRel.ok, true);
  if (!okRel.ok) return;
  assert.equal(okRel.item.state, 'AVAILABLE');

  // Verify requires Admin/Super Admin on CONFIRMED COUNTED item
  const counted = makeItem({ state: 'COUNTED', syncStatus: 'CONFIRMED', countRevision: 1 });
  const cashierVerify = verifyStocktakeItemCount({ item: counted, actorRole: 'cashier', actorBranchId: 'khalid-1', serverNowMs: BASE_TIME + 10_000 });
  assert.equal(cashierVerify.ok, false);
  const adminVerify = verifyStocktakeItemCount({ item: counted, actorRole: 'admin', actorBranchId: 'khalid-1', serverNowMs: BASE_TIME + 10_000 });
  assert.equal(adminVerify.ok, true);
  if (adminVerify.ok) assert.equal(adminVerify.item.state, 'VERIFIED');
});


runTest('F2F-18', 'Partial-unit conversions (pack/strip/pill) & DIRECT_PACK / unverified rejection', () => {
  const solid3x10: MedicineUnitConversionSpec = {
    medicineId: 'med-solid',
    unitMode: 'SOLID_TWO_LEVEL',
    baseUnitsPerPack: 30,
    stripsPerPack: 3,
    pillsPerStrip: 10,
    unitOperationalAllowed: true,
  };
  assert.deepEqual(resolveExactBaseUnitsPerUnit(solid3x10, 'pack'), { ok: true, baseUnitsPerUnit: 30 });
  assert.deepEqual(resolveExactBaseUnitsPerUnit(solid3x10, 'strip'), { ok: true, baseUnitsPerUnit: 10 });
  assert.deepEqual(resolveExactBaseUnitsPerUnit(solid3x10, 'pill'), { ok: true, baseUnitsPerUnit: 1 });

  assert.deepEqual(resolveExactBaseUnitsPerUnit(DIRECT_SPEC, 'pack'), { ok: true, baseUnitsPerUnit: 1 });
  assert.equal(resolveExactBaseUnitsPerUnit(DIRECT_SPEC, 'strip').ok, false);
  assert.equal(resolveExactBaseUnitsPerUnit(DIRECT_SPEC, 'pill').ok, false);

  const quarantinedSpec: MedicineUnitConversionSpec = { ...solid3x10, unitOperationalAllowed: false };
  assert.equal(resolveExactBaseUnitsPerUnit(quarantinedSpec, 'pack').ok, false);
});

runTest('F2F-19', 'Duplicate movement replay IDs detected & forced fail-closed to NEEDS_REVIEW', () => {
  const countEv: OperationalCountSubmissionEvent = {
    eventId: 'evt-dup-1',
    idempotencyKey: 'idem-dup-1',
    sessionId: 'sess-1',
    branchId: 'khalid-1',
    medicineId: 'med-amox-500',
    countRevision: 1,
    leaseId: 'lease-1',
    leaseVersion: 1,
    countedQuantity: 5,
    countUnit: 'pack',
    baseUnitsPerCountUnit: 20,
    countedBaseUnits: 100,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    deviceId: 'dev-1',
    watermark: makeWatermark(['mov-init-1'], BASE_TIME),
    syncStatus: 'CONFIRMED',
    recountOfEventId: null,
    notes: '',
  };
  const dupMov: ReconcilableLedgerMovement = {
    id: 'mov-sale-dup',
    branchId: 'khalid-1',
    medicineId: 'med-amox-500',
    type: 'SALE',
    unit: 'pack',
    quantityDelta: -1,
    baseUnitsDelta: -20,
    batchNumber: 'B-001',
    businessOccurredAtMs: BASE_TIME + 60_000,
    localPersistedAtMs: BASE_TIME + 60_000,
    serverSyncedAtMs: BASE_TIME + 60_500,
    synced: true,
    referenceId: 'sale-1',
  };
  const out = reconcileMedicineAtCountReference({
    sessionId: 'sess-1',
    branchId: 'khalid-1',
    reconciliationVersion: 1,
    countEvent: countEv,
    unitSpec: SOLID_SPEC,
    allMedicineLedgerMovements: [
      {
        id: 'mov-init-1',
        branchId: 'khalid-1',
        medicineId: 'med-amox-500',
        type: 'INITIAL',
        unit: 'pack',
        quantityDelta: 5,
        baseUnitsDelta: 100,
        batchNumber: 'B-001',
        businessOccurredAtMs: BASE_TIME - 120_000,
        localPersistedAtMs: BASE_TIME - 120_000,
        serverSyncedAtMs: BASE_TIME - 119_500,
        synced: true,
        referenceId: 'init-1',
      },
      dupMov,
      { ...dupMov },
    ],
    batchLayersFefo: [
      {
        batchNumber: 'B-001',
        expiry: '2027-12-31',
        remainingBaseUnits: 100,
        costPerBaseUnitExact: createRational(4n, 1n),
        sourceReceiptMovementId: 'mov-init-1',
      },
    ],
    reconciledAtMs: BASE_TIME + 120_000,
  });
  assert.equal(out.financialLine.discrepancyStatus, 'NEEDS_REVIEW');
  assert.equal(out.financialLine.integrityBlockers.length > 0, true);
});

runTest('F2F-20', 'Multi-device lease contention & stale expectedLeaseVersion rejection', () => {
  const item0 = makeItem({ leaseVersion: 0 });
  const devA = acquireStocktakeItemLease({
    item: item0,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'tablet-A',
    leaseId: 'lease-A',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME,
    isSharedOnlineTransaction: true,
  });
  assert.equal(devA.ok, true);
  if (!devA.ok) return;

  const devBStale = acquireStocktakeItemLease({
    item: devA.item,
    actorUid: 'cashier-1',
    actorDisplayName: 'Ali',
    actorBranchId: 'khalid-1',
    deviceId: 'phone-B',
    leaseId: 'lease-B',
    expectedLeaseVersion: 0,
    serverNowMs: BASE_TIME + 1_000,
    isSharedOnlineTransaction: true,
  });
  assert.equal(devBStale.ok, false);

  const devBContend = acquireStocktakeItemLease({
    item: devA.item,
    actorUid: 'cashier-2',
    actorDisplayName: 'Sara',
    actorBranchId: 'khalid-1',
    deviceId: 'phone-B',
    leaseId: 'lease-B2',
    expectedLeaseVersion: 1,
    serverNowMs: BASE_TIME + 1_000,
    isSharedOnlineTransaction: true,
  });
  assert.equal(devBContend.ok, false);
  if (!devBContend.ok) {
    assert.equal(devBContend.code, 'LEASE_CONFLICT_ACTIVE');
  }
});

runTest('F2F-21', 'Missing/unproven historical cost layer fails closed to NEEDS_REVIEW (zero silent fallback)', () => {
  const val = valuateStocktakeVarianceExact({
    requiredLedgerAdjustmentBaseUnits: -10,
    expectedCurrentBaseUnits: 50,
    batchLayersFefo: [
      {
        batchNumber: 'B-LEGACY',
        expiry: '2027-06-30',
        remainingBaseUnits: 60,
        costPerBaseUnitExact: null,
        sourceReceiptMovementId: null,
      },
    ],
  });
  assert.equal(val.costStatus, 'NEEDS_REVIEW');
  assert.equal(val.financialVarianceExact, null);
});

runTest('F2F-22', 'Remaining-medicines public projection strictly strips all price/cost/systemQty/variance keys', () => {
  const items: OperationalStocktakeItem[] = [
    makeItem({ id: 'med-avail', medicineId: 'med-avail', state: 'AVAILABLE', syncStatus: 'CONFIRMED' }),
    makeItem({
      id: 'med-done',
      medicineId: 'med-done',
      state: 'COUNTED',
      syncStatus: 'CONFIRMED',
      countRevision: 1,

    }),
    makeItem({
      id: 'med-local-pending',
      medicineId: 'med-local-pending',
      state: 'COUNTED',
      syncStatus: 'LOCAL_PENDING',
      countRevision: 1,
    }),
  ];
  const view = buildRemainingMedicinesPublicView(items, 'cashier-1');
  assert.deepEqual(
    view.map((v) => v.medicineId).sort(),
    ['med-avail', 'med-local-pending']
  );
  for (const row of view) {
    assert.deepEqual(scanForForbiddenKeys(row, FORBIDDEN_REMAINING_LIST_FIELDS), []);
    assert.equal('buyPrice' in row, false);
    assert.equal('sellPrice' in row, false);
    assert.equal('systemQty' in row, false);
    assert.equal('variance' in row, false);
  }
});


runTest('F2F-23', 'OD-2F-3 / Fix A: Cashier confirmed view projects strictly from OWN count_events & rejects foreign actors fail-closed', () => {
  const ownEvents: OperationalCountSubmissionEvent[] = [
    {
      eventId: 'med-own__r1',
      idempotencyKey: 'idem-own-1',
      sessionId: 'sess-1',
      branchId: 'khalid-1',
      medicineId: 'med-own',
      countRevision: 1,
      leaseId: 'lease-own-1',
      leaseVersion: 1,
      countedQuantity: 3,
      countUnit: 'pack',
      baseUnitsPerCountUnit: 20,
      countedBaseUnits: 60,
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      deviceId: 'dev-1',
      watermark: {
        countBusinessAtMs: 1_764_000_090_000,
        localPersistedAtMs: 1_764_000_090_000,
        serverConfirmedAtMs: 1_764_000_100_000,
        knownMovementIdsAtCount: [],
        knownMovementCount: 0,
        watermarkDigest: 'wm_0',
      },
      syncStatus: 'CONFIRMED',
      recountOfEventId: null,
      notes: '',
    },
    {
      eventId: 'med-local-pending__r1',
      idempotencyKey: 'idem-local-1',
      sessionId: 'sess-1',
      branchId: 'khalid-1',
      medicineId: 'med-local-pending',
      countRevision: 1,
      leaseId: 'lease-local-1',
      leaseVersion: 1,
      countedQuantity: 2,
      countUnit: 'pack',
      baseUnitsPerCountUnit: 20,
      countedBaseUnits: 40,
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      deviceId: 'dev-1',
      watermark: {
        countBusinessAtMs: 1_764_000_095_000,
        localPersistedAtMs: 1_764_000_095_000,
        serverConfirmedAtMs: null,
        knownMovementIdsAtCount: [],
        knownMovementCount: 0,
        watermarkDigest: 'wm_0',
      },
      syncStatus: 'LOCAL_PENDING',
      recountOfEventId: null,
      notes: '',
    },
  ];
  const foreignEvent: OperationalCountSubmissionEvent = {
    ...ownEvents[0],
    eventId: 'med-other__r1',
    medicineId: 'med-other',
    countedQuantity: 9,
    countUnit: 'strip',
    countedBaseUnits: 90,
    actorUid: 'cashier-2',
    actorDisplayName: 'Cashier 2',
  };

  const myConfirmed = buildCashierOwnConfirmedCountsView(ownEvents, 'cashier-1', {
    'med-own': 'Amoxicillin 500mg',
  });
  assert.equal(myConfirmed.length, 1);
  assert.equal(myConfirmed[0].medicineId, 'med-own');
  assert.equal(myConfirmed[0].medicineName, 'Amoxicillin 500mg');
  assert.equal(myConfirmed[0].countedQuantity, 3);
  assert.equal(myConfirmed[0].countUnit, 'pack');
  // Strict allowlist of keys — ZERO system stock, variance, price, cost, valuation, profit, or margin
  assert.deepEqual(
    Object.keys(myConfirmed[0]).sort(),
    ['confirmedAtServerMs', 'countRevision', 'countUnit', 'countedQuantity', 'medicineId', 'medicineName']
  );
  assert.deepEqual(scanForForbiddenKeys(myConfirmed[0], FORBIDDEN_OPERATIONAL_STOCKTAKE_FIELDS), []);
  assert.deepEqual(scanForForbiddenKeys(myConfirmed[0], FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS), []);

  // Passing ANY foreign actor event into cashier view MUST throw fail-closed
  assert.throws(
    () => buildCashierOwnConfirmedCountsView([...ownEvents, foreignEvent], 'cashier-1'),
    /CASHIER_CONFIRMED_VIEW_CROSS_ACTOR_VIOLATION/
  );

  // Shared OperationalStocktakeItem MUST reject any smuggled count/counter fields
  const smuggledItem = { ...makeItem(), latestCountedQuantity: 10, latestCountedByUid: 'cashier-2' };
  const safeCheck = assertSharedOperationalItemSafe(smuggledItem);
  assert.equal(safeCheck.valid, false);
  assert.ok(safeCheck.forbiddenFieldsFound.includes('latestCountedQuantity'));
  assert.ok(safeCheck.forbiddenFieldsFound.includes('latestCountedByUid'));
});

runTest('F2F-24', 'OD-2F-1 +/-30s fail-closed guard stops reconciliation on ambiguous movement and allows watermark-known movement', () => {
  const countAt = 1_764_000_500_000;
  const knownMov = {
    id: 'mov-known-within-30s',
    branchId: 'khalid-1',
    medicineId: 'med-1',
    batchNumber: 'B1',
    type: 'SALE' as const,
    unit: 'strip' as const,
    quantityDelta: -1,
    baseUnitsDelta: -10,
    referenceId: 'sale-known-1',
    businessOccurredAtMs: countAt - 5_000,
    localPersistedAtMs: countAt - 5_000,
    serverSyncedAtMs: countAt - 5_000,
    synced: true,
    branchLedgerSeq: null,
    medicineLedgerSeq: null,
  };
  const ambiguousMov = {
    id: 'mov-unlisted-within-30s',
    branchId: 'khalid-1',
    medicineId: 'med-1',
    batchNumber: 'B1',
    type: 'SALE' as const,
    unit: 'pill' as const,
    quantityDelta: -5,
    baseUnitsDelta: -5,
    referenceId: 'sale-ambig-1',
    businessOccurredAtMs: countAt + 12_000, // inside +/-30s window and NOT in knownMovementIdsAtCount!
    localPersistedAtMs: countAt + 12_000,
    serverSyncedAtMs: countAt + 12_000,
    synced: true,
    branchLedgerSeq: null,
    medicineLedgerSeq: null,
  };
  const countEvent = {
    eventId: 'evt-skew-1',
    idempotencyKey: 'key-skew-1',
    sessionId: 'sess-1',
    branchId: 'khalid-1',
    medicineId: 'med-1',
    countRevision: 1,
    leaseId: 'lease-1',
    leaseVersion: 1,
    countedQuantity: 4,
    countUnit: 'pack' as const,
    baseUnitsPerCountUnit: 20,
    countedBaseUnits: 80,
    actorUid: 'cashier-1',
    actorDisplayName: 'Cashier 1',
    deviceId: 'dev-1',
    syncStatus: 'CONFIRMED' as const,
    watermark: {
      countBusinessAtMs: countAt,
      localPersistedAtMs: countAt,
      serverConfirmedAtMs: countAt,
      branchLedgerSeq: null,
      medicineLedgerSeq: null,
      knownMovementIdsAtCount: ['mov-init-1', 'mov-known-within-30s'],
      knownMovementCount: 2,
      watermarkDigest: 'wm_2_abc',
    },
    recountOfEventId: null,
    notes: '',
  };

  const rKnown = classifyMovementRelativeToCountReference({
    movement: knownMov,
    countEvent,
    clockSkewGuardMs: 30_000,
  });
  assert.equal(rKnown.classification, 'PRE_COUNT_ALREADY_IN_PHYSICAL_COUNT');

  const rAmbig = classifyMovementRelativeToCountReference({
    movement: ambiguousMov,
    countEvent,
    clockSkewGuardMs: 30_000,
  });
  assert.equal(rAmbig.classification, 'AMBIGUOUS_ORDERING_NEEDS_REVIEW');
});

console.log('========================================================================');
console.log(`PHASE 2F FOUNDATION RESULTS: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
console.log('========================================================================');

if (failed > 0) {
  process.exit(1);
}
