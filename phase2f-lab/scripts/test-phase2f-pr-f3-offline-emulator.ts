/**
 * Phase 2F — PR-F3 REAL Firestore Emulator Offline Sidecar Queue & Reconnect Tests
 * Covers:
 * - OD-2F-1 / OD-2: Isolated sidecar store (zero pharmacyDb.ts or Outbox V2 coupling),
 *   preserved knownMovementIdsAtCount, ±30s fail-closed guard.
 * - OD-2F-2 / OD-3: Offline LOCAL_PENDING capture (non-lease, non-confirmed, non-posting),
 *   reconnect sync, cloud conflicts, crash-after-commit idempotency.
 * - Fix A: Actor-scoped count_events deduplication & ZERO holderUid/other-cashier leak.
 * - Fix B (12 mandatory cases): Explicit VerifiedMovementHistorySnapshot fail-closed checks
 *   + live fetchVerifiedBranchMovementHistorySnapshot against real Firestore Emulator.
 * - Fix C (9 mandatory cases): FIPS 180-4 SHA-256 + canonical 5-field length-prefixed
 *   deterministic offline record ID collision & adversarial tests.
 * - Fix F (4 lifecycle cases): Restart persistence, interrupted RECONCILIATION_PENDING recovery,
 *   concurrent 2-device non-overwrite, closed session & zero auto ledger posting, Outbox V2 disabled.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import {
  FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS,
  scanForForbiddenKeys,
} from '../src/services/stocktakeContract.ts';
import {
  acquireStocktakeLeaseTx,
  createStocktakeV2SessionAndItems,
  submitStocktakeCountTx,
  transitionStocktakeSessionStatusTx,
} from '../src/services/stocktakeFirestoreService.ts';
import {
  InMemoryStocktakeSidecarStore,
  buildCashierCombinedOfflineAndConfirmedView,
  buildDeterministicOfflineRecordId,
  evaluateOfflineCountWatermarkAmbiguity,
  fetchVerifiedBranchMovementHistorySnapshot,
  reconcileAndSyncOfflinePendingCounts,
  recordOfflinePhysicalCountLocalPending,
  sha256Utf8Hex,
  verifyMovementHistorySnapshotForRecord,
  type VerifiedMovementHistorySnapshot,
} from '../src/services/stocktakeLocalSidecarQueue.ts';
import { isOutboxV2WorkerEnabled } from '../src/services/outboxFeatureFlags.ts';
import type { ReconcilableLedgerMovement } from '../src/services/stocktakeReconciliationEngine.ts';

let passed = 0;
let failed = 0;

async function runCase(id: string, title: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`PASS [${id}] ${title}`);
  } catch (err: unknown) {
    failed++;
    console.error(`FAIL [${id}] ${title}`);
    console.error('   ->', err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

function makeVerifiedSnapshot(params: {
  branchId?: string;
  coversAllBranchMedicines?: boolean;
  coveredMedicineIds?: string[];
  intervalStartMs: number;
  intervalEndMs: number;
  watermarkAtMs: number;
  completenessStatus?: 'VERIFIED_COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';
  paginationComplete?: boolean;
  movements?: ReconcilableLedgerMovement[];
  snapshotId?: string;
  authoritativeSource?: 'FIRESTORE_INVENTORY_LEDGER';
}): VerifiedMovementHistorySnapshot {
  return {
    snapshotId: params.snapshotId ?? `snap-verified-${Date.now()}`,
    branchId: params.branchId ?? 'khalid-1',
    coversAllBranchMedicines: params.coversAllBranchMedicines ?? true,
    coveredMedicineIds: params.coveredMedicineIds,
    intervalStartMs: params.intervalStartMs,
    intervalEndMs: params.intervalEndMs,
    authoritativeSource: params.authoritativeSource ?? 'FIRESTORE_INVENTORY_LEDGER',
    watermarkAtMs: params.watermarkAtMs,
    completenessStatus: params.completenessStatus ?? 'VERIFIED_COMPLETE',
    paginationComplete: params.paginationComplete ?? true,
    movements: params.movements ?? [],
  };
}

async function seedTestContext(testEnv: RulesTestEnvironment): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'branches/khalid-1'), {
      id: 'khalid-1',
      name: 'Khalid Pharmacy Main',
      active: true,
      adminUids: ['admin-1'],
      memberUids: ['admin-1', 'cashier-1', 'cashier-2'],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    for (const u of [
      { uid: 'admin-1', role: 'admin', displayName: 'Branch Admin 1' },
      { uid: 'cashier-1', role: 'cashier', displayName: 'Cashier 1' },
      { uid: 'cashier-2', role: 'cashier', displayName: 'Cashier 2' },
    ]) {
      await setDoc(doc(db, `users/${u.uid}`), {
        ...u,
        email: `${u.uid}@khalid.test`,
        branchIds: ['khalid-1'],
        activeBranchId: 'khalid-1',
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    for (const [medId, medName] of [
      ['med-clean', 'Paracetamol 500mg'],
      ['med-already', 'Amoxicillin 500mg'],
      ['med-leased', 'Ibuprofen 400mg'],
      ['med-ambig', 'Omeprazole 20mg'],
      ['med-fixb-empty', 'Cetirizine 10mg'],
      ['med-fixb-known', 'Loratadine 10mg'],
      ['med-fixb-live', 'Azithromycin 250mg'],
      ['med-restart', 'Metformin 500mg'],
      ['med-concurrent', 'Losartan 50mg'],
      ['med-closed', 'Atorvastatin 20mg'],
    ]) {
      await setDoc(doc(db, `branches/khalid-1/medicines/${medId}`), {
        id: medId,
        branchId: 'khalid-1',
        name: medName,
        sellPrice: 100,
        unitSchemaVersion: 2,
        dosageForm: 'tablet',
        baseUnitLabel: 'pill',
        stripsPerPack: 2,
        pillsPerStrip: 10,
        baseUnitsPerPack: 20,
        configStatus: 'VERIFIED',
        unitMigrationStatus: 'NATIVE_V2',
        packingLocked: false,
        syncVersion: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  });
}

async function main(): Promise<void> {
  const rules = fs.readFileSync(path.resolve('firestore.rules'), 'utf8');
  const testEnv = await initializeTestEnvironment({
    projectId: 'khalid-pharmacy-phase2f-prf3-test',
    firestore: {
      rules,
      host: '127.0.0.1',
      port: 8080,
    },
  });

  try {
    await testEnv.clearFirestore();
    await seedTestContext(testEnv);

    const adminDb = testEnv
      .authenticatedContext('admin-1', { email: 'admin-1@khalid.test', email_verified: true })
      .firestore() as unknown as Firestore;
    const c1Db = testEnv
      .authenticatedContext('cashier-1', { email: 'cashier-1@khalid.test', email_verified: true })
      .firestore() as unknown as Firestore;
    const c2Db = testEnv
      .authenticatedContext('cashier-2', { email: 'cashier-2@khalid.test', email_verified: true })
      .firestore() as unknown as Firestore;

    const sessId = 'sess-prf3-offline-01';
    const sidecarC1 = new InMemoryStocktakeSidecarStore();
    const sidecarC2 = new InMemoryStocktakeSidecarStore();

    // Initialize an IN_PROGRESS Phase 2F session with 10 medicines for thorough testing
    await createStocktakeV2SessionAndItems(adminDb, {
      branchId: 'khalid-1',
      sessionId: sessId,
      sessionNumber: 'ST-2026-PRF3-01',
      scopeMode: 'FULL',
      adminUid: 'admin-1',
      adminDisplayName: 'Branch Admin 1',
      items: [
        { medicineId: 'med-clean', medicineName: 'Paracetamol 500mg' },
        { medicineId: 'med-already', medicineName: 'Amoxicillin 500mg' },
        { medicineId: 'med-leased', medicineName: 'Ibuprofen 400mg' },
        { medicineId: 'med-ambig', medicineName: 'Omeprazole 20mg' },
        { medicineId: 'med-fixb-empty', medicineName: 'Cetirizine 10mg' },
        { medicineId: 'med-fixb-known', medicineName: 'Loratadine 10mg' },
        { medicineId: 'med-fixb-live', medicineName: 'Azithromycin 250mg' },
        { medicineId: 'med-restart', medicineName: 'Metformin 500mg' },
        { medicineId: 'med-concurrent', medicineName: 'Losartan 50mg' },
        { medicineId: 'med-closed', medicineName: 'Atorvastatin 20mg' },
      ],
    });

    // =========================================================================
    // PART 1: ORIGINAL PR-F3 OFFLINE & RECONCILIATION SUITE (F2F-OFF-01..08)
    // =========================================================================

    await runCase(
      'F2F-OFF-01',
      'OD-3 / OD-2F-2 Offline capture writes LOCAL_PENDING to isolated sidecar with non-authority invariants',
      async () => {
        const tCount = Date.now() - 90_000;
        const rec = await recordOfflinePhysicalCountLocalPending(sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-clean',
          medicineName: 'Paracetamol 500mg',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1-offline',
          clientCountNonce: 'nonce-clean-01',
          countedQuantity: 14,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 10,
          knownMovementIdsAtCount: ['mv-002', 'mv-001', 'mv-002'],
          countBusinessAtMs: tCount,
          localPersistedAtMs: tCount + 50,
          notes: 'Shelf A offline count',
        });

        assert.equal(rec.status, 'LOCAL_PENDING');
        assert.equal(rec.isCloudLease, false);
        assert.equal(rec.isSharedConfirmedCount, false);
        assert.equal(rec.canPostInventoryAdjustment, false);
        assert.equal(rec.confirmedEventId, null);
        assert.deepEqual(rec.knownMovementIdsAtCount, ['mv-001', 'mv-002']);
        assert.match(rec.localRecordId, /^off2_[0-9a-f]{64}$/);
        assert.equal(rec.localRecordId.length, 69);

        // Cloud item MUST remain untouched (AVAILABLE) while offline
        const cloudItem = await assertSucceeds(
          getDoc(doc(c1Db, `branches/khalid-1/stocktake_sessions_v2/${sessId}/items/med-clean`))
        );
        assert.equal(cloudItem.data()?.state, 'AVAILABLE');
        assert.equal(cloudItem.data()?.activeLease, null);
      }
    );

    await runCase(
      'F2F-OFF-02',
      'OD-3 + Fix B Reconnect with positively verified snapshot syncs clean LOCAL_PENDING -> CONFIRMED',
      async () => {
        const now = Date.now();
        const verifiedSnap = makeVerifiedSnapshot({
          intervalStartMs: now - 600_000,
          intervalEndMs: now,
          watermarkAtMs: now,
          movements: [],
        });
        const outcomes = await reconcileAndSyncOfflinePendingCounts(c1Db, sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: verifiedSnap,
          nowMs: now,
        });

        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].outcome, 'SYNCED_CONFIRMED');
        assert.equal(outcomes[0].confirmedEventId, 'med-clean__r1');
        assert.equal(outcomes[0].confirmedCountRevision, 1);

        const cloudItem = await assertSucceeds(
          getDoc(doc(c1Db, `branches/khalid-1/stocktake_sessions_v2/${sessId}/items/med-clean`))
        );
        assert.equal(cloudItem.data()?.state, 'COUNTED');
        assert.equal(cloudItem.data()?.countRevision, 1);
        // Fix A: shared item MUST NOT contain any count/counter fields
        assert.equal('latestCountedQuantity' in (cloudItem.data() ?? {}), false);
        assert.equal('latestCountedByUid' in (cloudItem.data() ?? {}), false);
      }
    );

    await runCase(
      'F2F-OFF-03',
      'Conflict ALREADY_COUNTED: Cashier 2 counted online first -> Cashier 1 offline stays unresolved, zero overwrite',
      async () => {
        const lease2 = await acquireStocktakeLeaseTx(c2Db, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-already',
          actorUid: 'cashier-2',
          actorDisplayName: 'Cashier 2',
          deviceId: 'dev-c2',
          leaseId: 'lease-c2-already',
        });
        assert.equal(lease2.ok, true);
        await submitStocktakeCountTx(c2Db, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-already',
          actorUid: 'cashier-2',
          actorDisplayName: 'Cashier 2',
          actorRole: 'cashier',
          deviceId: 'dev-c2',
          countedQuantity: 25,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 12,
          knownMovementIdsAtCount: [],
        });

        const tCount = Date.now() - 90_000;
        const rec = await recordOfflinePhysicalCountLocalPending(sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-already',
          medicineName: 'Amoxicillin 500mg',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1-offline',
          clientCountNonce: 'nonce-already-01',
          countedQuantity: 21,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 12,
          knownMovementIdsAtCount: [],
          countBusinessAtMs: tCount,
          localPersistedAtMs: tCount + 10,
        });

        const now = Date.now();
        const outcomes = await reconcileAndSyncOfflinePendingCounts(c1Db, sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: makeVerifiedSnapshot({
            intervalStartMs: now - 600_000,
            intervalEndMs: now,
            watermarkAtMs: now,
          }),
          nowMs: now,
        });

        const out = outcomes.find((o) => o.localRecordId === rec.localRecordId);
        assert.equal(out?.outcome, 'CONFLICT_ALREADY_COUNTED');
        assert.equal(out?.conflictCode, 'CLOUD_ITEM_ALREADY_COUNTED');
        // Fix A: conflict detail MUST NOT leak cashier-2's UID or count (25)
        assert.equal(out?.conflictDetail?.includes('cashier-2'), false);
        assert.equal(out?.conflictDetail?.includes('25'), false);

        // Verify Cashier 2's cloud event was NOT overwritten (Admin check)
        const evSnap = await assertSucceeds(
          getDoc(
            doc(
              adminDb,
              `branches/khalid-1/stocktake_sessions_v2/${sessId}/count_events/med-already__r1`
            )
          )
        );
        assert.equal(evSnap.data()?.actorUid, 'cashier-2');
        assert.equal(evSnap.data()?.countedQuantity, 25);
      }
    );

    await runCase(
      'F2F-OFF-04',
      'Conflict ACTIVE_LEASE_HELD_BY_OTHER: Cashier 2 holds active lease -> generic conflict with ZERO holderUid leak',
      async () => {
        const lease2 = await acquireStocktakeLeaseTx(c2Db, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-leased',
          actorUid: 'cashier-2',
          actorDisplayName: 'Cashier 2',
          deviceId: 'dev-c2',
          leaseId: 'lease-c2-active',
        });
        assert.equal(lease2.ok, true);

        const tCount = Date.now() - 90_000;
        const rec = await recordOfflinePhysicalCountLocalPending(sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-leased',
          medicineName: 'Ibuprofen 400mg',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1-offline',
          clientCountNonce: 'nonce-leased-01',
          countedQuantity: 9,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 20,
          knownMovementIdsAtCount: [],
          countBusinessAtMs: tCount,
          localPersistedAtMs: tCount + 10,
        });

        const now = Date.now();
        const outcomes = await reconcileAndSyncOfflinePendingCounts(c1Db, sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: makeVerifiedSnapshot({
            intervalStartMs: now - 600_000,
            intervalEndMs: now,
            watermarkAtMs: now,
          }),
          nowMs: now,
        });

        const out = outcomes.find((o) => o.localRecordId === rec.localRecordId);
        assert.equal(out?.outcome, 'CONFLICT_ACTIVE_LEASE_HELD_BY_OTHER');
        assert.equal(out?.conflictCode, 'ACTIVE_LEASE_HELD_BY_OTHER');
        assert.equal(out?.conflictDetail?.includes('cashier-2'), false);
        assert.equal(out?.conflictDetail?.includes('Cashier 2'), false);
      }
    );

    await runCase(
      'F2F-OFF-05',
      'Conflict ITEM_MISSING: Offline count for medicine not in cloud session -> CONFLICT_ITEM_MISSING',
      async () => {
        const tCount = Date.now() - 90_000;
        const rec = await recordOfflinePhysicalCountLocalPending(sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-nonexistent-999',
          medicineName: 'Ghost Med',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1-offline',
          clientCountNonce: 'nonce-missing-01',
          countedQuantity: 3,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 10,
          knownMovementIdsAtCount: [],
          countBusinessAtMs: tCount,
          localPersistedAtMs: tCount + 10,
        });

        const now = Date.now();
        const outcomes = await reconcileAndSyncOfflinePendingCounts(c1Db, sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: makeVerifiedSnapshot({
            intervalStartMs: now - 600_000,
            intervalEndMs: now,
            watermarkAtMs: now,
          }),
          nowMs: now,
        });

        const out = outcomes.find((o) => o.localRecordId === rec.localRecordId);
        assert.equal(out?.outcome, 'CONFLICT_ITEM_MISSING');
      }
    );

    await runCase(
      'F2F-OFF-06',
      'Fix A + Fix F Idempotency: Crash-after-commit replay deduplicates via actor-scoped count_events (ZERO duplicates)',
      async () => {
        const ownEventsBefore = await assertSucceeds(
          getDocs(
            query(
              collection(c1Db, `branches/khalid-1/stocktake_sessions_v2/${sessId}/count_events`),
              where('branchId', '==', 'khalid-1'),
              where('sessionId', '==', sessId),
              where('actorUid', '==', 'cashier-1')
            )
          )
        );
        const countBefore = ownEventsBefore.size;
        assert.equal(countBefore, 1);

        const now = Date.now();
        const snap = makeVerifiedSnapshot({
          intervalStartMs: now - 600_000,
          intervalEndMs: now,
          watermarkAtMs: now,
        });

        // 1. Repeat sync on already-CONFIRMED record
        const repeat1 = await reconcileAndSyncOfflinePendingCounts(c1Db, sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: snap,
          nowMs: now,
        });
        const cleanRepeat = repeat1.find((o) => o.medicineId === 'med-clean');
        assert.equal(cleanRepeat?.outcome, 'IDEMPOTENT_ALREADY_CONFIRMED');

        // 2. Simulate crash right after cloud commit BEFORE local sidecar status updated:
        const recClean = await sidecarC1.get(cleanRepeat!.localRecordId);
        assert.ok(recClean);
        await sidecarC1.put({
          ...recClean!,
          status: 'LOCAL_PENDING',
          isSharedConfirmedCount: false,
          confirmedEventId: null,
          confirmedCountRevision: null,
          confirmedAtMs: null,
        });

        const repeat2 = await reconcileAndSyncOfflinePendingCounts(c1Db, sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: snap,
          nowMs: now,
        });
        const recovered = repeat2.find((o) => o.localRecordId === recClean!.localRecordId);
        assert.equal(recovered?.outcome, 'IDEMPOTENT_ALREADY_CONFIRMED');
        assert.equal(recovered?.confirmedEventId, 'med-clean__r1');

        const ownEventsAfter = await assertSucceeds(
          getDocs(
            query(
              collection(c1Db, `branches/khalid-1/stocktake_sessions_v2/${sessId}/count_events`),
              where('branchId', '==', 'khalid-1'),
              where('sessionId', '==', sessId),
              where('actorUid', '==', 'cashier-1')
            )
          )
        );
        assert.equal(ownEventsAfter.size, countBefore, 'Zero duplicate count_events created!');
      }
    );

    await runCase(
      'F2F-OFF-07',
      'OD-2F-1 ±30s fail-closed guard on ambiguous unlisted movement -> NEEDS_REVIEW (blocks auto-sync)',
      async () => {
        const tCount = Date.now() - 90_000;
        const ambigRec = await recordOfflinePhysicalCountLocalPending(sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-ambig',
          medicineName: 'Omeprazole 20mg',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1-offline',
          clientCountNonce: 'nonce-ambig-01',
          countedQuantity: 8,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 14,
          knownMovementIdsAtCount: ['mv-known-old'],
          countBusinessAtMs: tCount,
          localPersistedAtMs: tCount + 50,
        });

        const movements: ReconcilableLedgerMovement[] = [
          {
            id: 'mv-known-old',
            branchId: 'khalid-1',
            medicineId: 'med-ambig',
            batchNumber: 'B-OMEP-01',
            type: 'SALE',
            unit: 'pack',
            quantityDelta: -1,
            baseUnitsDelta: -14,
            referenceId: 'sale-known-01',
            businessOccurredAtMs: tCount - 90_000,
            localPersistedAtMs: tCount - 90_000,
            serverSyncedAtMs: tCount - 89_000,
            synced: true,
          },
          {
            id: 'mv-unlisted-within-30s',
            branchId: 'khalid-1',
            medicineId: 'med-ambig',
            batchNumber: 'B-OMEP-01',
            type: 'SALE',
            unit: 'pack',
            quantityDelta: -1,
            baseUnitsDelta: -14,
            referenceId: 'sale-ambig-02',
            businessOccurredAtMs: tCount + 12_000,
            localPersistedAtMs: tCount + 12_000,
            serverSyncedAtMs: tCount + 13_000,
            synced: true,
          },
        ];

        const evalRes = evaluateOfflineCountWatermarkAmbiguity({
          record: ambigRec,
          movements,
        });
        assert.equal(evalRes.requiresReview, true);
        assert.equal(evalRes.status, 'NEEDS_REVIEW');
        assert.deepEqual(evalRes.ambiguousMovementIds, ['mv-unlisted-within-30s']);

        const now = Date.now();
        const outcomes = await reconcileAndSyncOfflinePendingCounts(c1Db, sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: makeVerifiedSnapshot({
            intervalStartMs: now - 600_000,
            intervalEndMs: now,
            watermarkAtMs: now,
            movements,
          }),
          nowMs: now,
        });
        const ambigOut = outcomes.find((o) => o.localRecordId === ambigRec.localRecordId);
        assert.equal(ambigOut?.outcome, 'NEEDS_REVIEW');
        assert.equal(ambigOut?.conflictCode, 'AMBIGUOUS_MOVEMENT_WITHIN_30S_GUARD');

        const cloudSnap = await assertSucceeds(
          getDoc(doc(c1Db, `branches/khalid-1/stocktake_sessions_v2/${sessId}/items/med-ambig`))
        );
        assert.equal(cloudSnap.data()?.state, 'AVAILABLE');
      }
    );

    await runCase(
      'F2F-OFF-08',
      'OD-4 / OD-2F-3 Cashier combined view strictly strips financial/systemStock/other-cashier data & rejects forbidden inputs',
      async () => {
        await recordOfflinePhysicalCountLocalPending(sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-ambig',
          medicineName: 'Omeprazole 20mg',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1-offline',
          clientCountNonce: 'nonce-still-pending-02',
          countedQuantity: 7,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 14,
          knownMovementIdsAtCount: [],
        });

        const view = await buildCashierCombinedOfflineAndConfirmedView(c1Db, sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          cashierUid: 'cashier-1',
        });

        assert.equal(view.myConfirmedCounts.length, 1);
        assert.equal(view.myConfirmedCounts[0].medicineId, 'med-clean');
        assert.equal(view.myConfirmedCounts[0].countedQuantity, 14);
        assert.equal(view.myConfirmedCounts[0].countUnit, 'pack');
        // MUST NOT contain cashier-2's confirmed count (med-already = 25)
        assert.equal(
          view.myConfirmedCounts.some((c) => c.medicineId === 'med-already'),
          false
        );
        assert.equal(view.myLocalPendingCounts.length, 1);
        assert.equal(view.myLocalPendingCounts[0].isCloudLease, false);
        assert.equal(view.myLocalPendingCounts[0].isSharedConfirmedCount, false);
        assert.equal(view.myLocalPendingCounts[0].canPostInventoryAdjustment, false);
        assert.equal(view.myUnresolvedConflicts.length, 4); // already + leased + missing + needs_review
        assert.deepEqual(scanForForbiddenKeys(view, FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS), []);
        assert.equal(JSON.stringify(view).includes('cashier-2'), false);

        // Fail-closed guard: attempting to inject buyPrice into sidecar throws immediately!
        let rejectedForbidden = false;
        try {
          await recordOfflinePhysicalCountLocalPending(sidecarC1, {
            branchId: 'khalid-1',
            sessionId: sessId,
            medicineId: 'med-clean',
            medicineName: 'Paracetamol',
            actorUid: 'cashier-1',
            actorDisplayName: 'Cashier 1',
            actorRole: 'cashier',
            deviceId: 'dev-c1',
            clientCountNonce: 'nonce-bad-01',
            countedQuantity: 5,
            countUnit: 'pack',
            baseUnitsPerCountUnit: 10,
            knownMovementIdsAtCount: [],
            ...({ buyPrice: 42 } as Record<string, unknown>),
          } as never);
        } catch (err: unknown) {
          rejectedForbidden = String((err as Error).message).includes('OD_2F_3_SIDECAR_FORBIDDEN_FIELDS');
        }
        assert.equal(rejectedForbidden, true);
      }
    );

    // =========================================================================
    // PART 2: FIX B — ALL 12 MANDATORY FAIL-CLOSED MOVEMENT HISTORY TESTS
    // =========================================================================

    const fixBNow = Date.now();
    const fixBCountAt = fixBNow - 120_000;
    const fixBStore = new InMemoryStocktakeSidecarStore();
    const sampleFixBRec = await recordOfflinePhysicalCountLocalPending(fixBStore, {
      branchId: 'khalid-1',
      sessionId: sessId,
      medicineId: 'med-fixb-empty',
      medicineName: 'Cetirizine 10mg',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      actorRole: 'cashier',
      deviceId: 'dev-c1',
      clientCountNonce: 'nonce-fixb-unit',
      countedQuantity: 11,
      countUnit: 'pack',
      baseUnitsPerCountUnit: 10,
      knownMovementIdsAtCount: ['mv-known-in-30s'],
      countBusinessAtMs: fixBCountAt,
      localPersistedAtMs: fixBCountAt + 10,
    });

    await runCase('F2F-FIXB-01', 'Fix B (1/12): Missing/undefined movementHistorySnapshot -> NEEDS_REVIEW (fail-closed)', async () => {
      const check = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: undefined,
        nowMs: fixBNow,
      });
      assert.equal(check.verified, false);
      assert.equal(check.code, 'MOVEMENT_HISTORY_MISSING');

      // Live emulator check: calling reconcileAndSyncOfflinePendingCounts without snapshot MUST mark NEEDS_REVIEW & leave cloud AVAILABLE!
      const s = new InMemoryStocktakeSidecarStore();
      await recordOfflinePhysicalCountLocalPending(s, {
        branchId: 'khalid-1',
        sessionId: sessId,
        medicineId: 'med-fixb-empty',
        medicineName: 'Cetirizine 10mg',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        actorRole: 'cashier',
        deviceId: 'dev-c1',
        clientCountNonce: 'nonce-fixb-01-live',
        countedQuantity: 11,
        countUnit: 'pack',
        baseUnitsPerCountUnit: 10,
        knownMovementIdsAtCount: [],
        countBusinessAtMs: fixBCountAt,
      });
      const outs = await reconcileAndSyncOfflinePendingCounts(c1Db, s, {
        branchId: 'khalid-1',
        sessionId: sessId,
        actorUid: 'cashier-1',
        // movementHistorySnapshot omitted!
      });
      assert.equal(outs[0].outcome, 'NEEDS_REVIEW');
      assert.equal(outs[0].conflictCode, 'MOVEMENT_HISTORY_MISSING');
      const cloudSnap = await assertSucceeds(
        getDoc(doc(c1Db, `branches/khalid-1/stocktake_sessions_v2/${sessId}/items/med-fixb-empty`))
      );
      assert.equal(cloudSnap.data()?.state, 'AVAILABLE');
    });

    await runCase('F2F-FIXB-02', 'Fix B (2/12): Empty-unverified snapshot (completenessStatus: UNKNOWN) -> NEEDS_REVIEW', async () => {
      const check = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: makeVerifiedSnapshot({
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBNow,
          watermarkAtMs: fixBNow,
          completenessStatus: 'UNKNOWN',
          movements: [],
        }),
        nowMs: fixBNow,
      });
      assert.equal(check.verified, false);
      assert.equal(check.code, 'MOVEMENT_HISTORY_INCOMPLETE');
    });

    await runCase('F2F-FIXB-03', 'Fix B (3/12): completenessStatus: INCOMPLETE -> NEEDS_REVIEW', async () => {
      const check = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: makeVerifiedSnapshot({
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBNow,
          watermarkAtMs: fixBNow,
          completenessStatus: 'INCOMPLETE',
          movements: [],
        }),
        nowMs: fixBNow,
      });
      assert.equal(check.verified, false);
      assert.equal(check.code, 'MOVEMENT_HISTORY_INCOMPLETE');
    });

    await runCase('F2F-FIXB-04', 'Fix B (4/12): Stale watermark or interval gap -> NEEDS_REVIEW', async () => {
      // Stale watermark (10 min old > 5 min default maxAge)
      const staleCheck = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: makeVerifiedSnapshot({
          intervalStartMs: fixBNow - 1_200_000,
          intervalEndMs: fixBNow,
          watermarkAtMs: fixBNow - 600_000,
        }),
        nowMs: fixBNow,
      });
      assert.equal(staleCheck.verified, false);
      assert.equal(staleCheck.code, 'MOVEMENT_HISTORY_STALE_OR_INTERVAL_GAP');

      // Interval end gap (ends before countBusinessAtMs + 30s)
      const gapCheck = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: makeVerifiedSnapshot({
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBCountAt + 10_000,
          watermarkAtMs: fixBNow,
        }),
        nowMs: fixBNow,
      });
      assert.equal(gapCheck.verified, false);
      assert.equal(gapCheck.code, 'MOVEMENT_HISTORY_STALE_OR_INTERVAL_GAP');
    });

    await runCase('F2F-FIXB-05', 'Fix B (5/12): Wrong branchId in snapshot -> NEEDS_REVIEW', async () => {
      const check = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: makeVerifiedSnapshot({
          branchId: 'other-branch-99',
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBNow,
          watermarkAtMs: fixBNow,
        }),
        nowMs: fixBNow,
      });
      assert.equal(check.verified, false);
      assert.equal(check.code, 'MOVEMENT_HISTORY_WRONG_BRANCH');
    });

    await runCase('F2F-FIXB-06', 'Fix B (6/12): Snapshot does not cover record medicineId -> NEEDS_REVIEW', async () => {
      const check = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: makeVerifiedSnapshot({
          coversAllBranchMedicines: false,
          coveredMedicineIds: ['med-other-1', 'med-other-2'],
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBNow,
          watermarkAtMs: fixBNow,
        }),
        nowMs: fixBNow,
      });
      assert.equal(check.verified, false);
      assert.equal(check.code, 'MOVEMENT_HISTORY_WRONG_MEDICINE');
    });

    await runCase('F2F-FIXB-07', 'Fix B (7/12): paginationComplete: false -> NEEDS_REVIEW', async () => {
      const check = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: makeVerifiedSnapshot({
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBNow,
          watermarkAtMs: fixBNow,
          paginationComplete: false,
        }),
        nowMs: fixBNow,
      });
      assert.equal(check.verified, false);
      assert.equal(check.code, 'MOVEMENT_HISTORY_PAGINATION_INCOMPLETE');
    });

    await runCase('F2F-FIXB-08', 'Fix B (8/12): Unlisted movement within ±30s -> NEEDS_REVIEW', async () => {
      const check = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: makeVerifiedSnapshot({
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBNow,
          watermarkAtMs: fixBNow,
          movements: [
            {
              id: 'mv-sneaky-sale',
              branchId: 'khalid-1',
              medicineId: 'med-fixb-empty',
              batchNumber: '',
              type: 'SALE',
              unit: 'pack',
              quantityDelta: -1,
              baseUnitsDelta: -10,
              referenceId: 'sale-sneaky',
              businessOccurredAtMs: fixBCountAt - 15_000,
              localPersistedAtMs: fixBCountAt - 15_000,
              serverSyncedAtMs: fixBCountAt - 14_000,
              synced: true,
            },
          ],
        }),
        nowMs: fixBNow,
      });
      assert.equal(check.verified, false);
      assert.equal(check.code, 'AMBIGUOUS_MOVEMENT_WITHIN_30S_GUARD');
      assert.deepEqual(check.ambiguousMovementIds, ['mv-sneaky-sale']);
    });

    await runCase('F2F-FIXB-09', 'Fix B (9/12): Ambiguous/invalid movement timestamp (<= 0 or NaN) -> NEEDS_REVIEW', async () => {
      const check = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: makeVerifiedSnapshot({
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBNow,
          watermarkAtMs: fixBNow,
          movements: [
            {
              id: 'mv-bad-ts',
              branchId: 'khalid-1',
              medicineId: 'med-fixb-empty',
              batchNumber: '',
              type: 'SALE',
              unit: 'pack',
              quantityDelta: -1,
              baseUnitsDelta: -10,
              referenceId: 'sale-bad-ts',
              businessOccurredAtMs: 0,
              localPersistedAtMs: 0,
              serverSyncedAtMs: null,
              synced: true,
            },
          ],
        }),
        nowMs: fixBNow,
      });
      assert.equal(check.verified, false);
      assert.equal(check.code, 'MOVEMENT_HISTORY_AMBIGUOUS_OR_MISSING_PROVENANCE');
    });

    await runCase('F2F-FIXB-10', 'Fix B (10/12): Missing movement provenance (empty referenceId or synced: false) -> NEEDS_REVIEW', async () => {
      const noRefCheck = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: makeVerifiedSnapshot({
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBNow,
          watermarkAtMs: fixBNow,
          movements: [
            {
              id: 'mv-no-ref',
              branchId: 'khalid-1',
              medicineId: 'med-fixb-empty',
              batchNumber: '',
              type: 'SALE',
              unit: 'pack',
              quantityDelta: -1,
              baseUnitsDelta: -10,
              referenceId: '',
              businessOccurredAtMs: fixBCountAt - 100_000,
              localPersistedAtMs: fixBCountAt - 100_000,
              serverSyncedAtMs: fixBCountAt - 99_000,
              synced: true,
            },
          ],
        }),
        nowMs: fixBNow,
      });
      assert.equal(noRefCheck.verified, false);
      assert.equal(noRefCheck.code, 'MOVEMENT_HISTORY_AMBIGUOUS_OR_MISSING_PROVENANCE');

      const unsyncedCheck = verifyMovementHistorySnapshotForRecord({
        record: sampleFixBRec,
        snapshot: makeVerifiedSnapshot({
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBNow,
          watermarkAtMs: fixBNow,
          movements: [
            {
              id: 'mv-unsynced',
              branchId: 'khalid-1',
              medicineId: 'med-fixb-empty',
              batchNumber: '',
              type: 'SALE',
              unit: 'pack',
              quantityDelta: -1,
              baseUnitsDelta: -10,
              referenceId: 'sale-unsynced',
              businessOccurredAtMs: fixBCountAt - 100_000,
              localPersistedAtMs: fixBCountAt - 100_000,
              serverSyncedAtMs: null,
              synced: false,
            },
          ],
        }),
        nowMs: fixBNow,
      });
      assert.equal(unsyncedCheck.verified, false);
      assert.equal(unsyncedCheck.code, 'MOVEMENT_HISTORY_AMBIGUOUS_OR_MISSING_PROVENANCE');
    });

    await runCase('F2F-FIXB-11', 'Fix B (11/12): Positively verified complete-empty snapshot -> SYNCED_CONFIRMED on live emulator', async () => {
      const s = new InMemoryStocktakeSidecarStore();
      await recordOfflinePhysicalCountLocalPending(s, {
        branchId: 'khalid-1',
        sessionId: sessId,
        medicineId: 'med-fixb-empty',
        medicineName: 'Cetirizine 10mg',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        actorRole: 'cashier',
        deviceId: 'dev-c1',
        clientCountNonce: 'nonce-fixb-11',
        countedQuantity: 18,
        countUnit: 'pack',
        baseUnitsPerCountUnit: 10,
        knownMovementIdsAtCount: [],
        countBusinessAtMs: fixBCountAt,
      });
      const outs = await reconcileAndSyncOfflinePendingCounts(c1Db, s, {
        branchId: 'khalid-1',
        sessionId: sessId,
        actorUid: 'cashier-1',
        movementHistorySnapshot: makeVerifiedSnapshot({
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBNow,
          watermarkAtMs: fixBNow,
          movements: [],
        }),
        nowMs: fixBNow,
      });
      assert.equal(outs[0].outcome, 'SYNCED_CONFIRMED');
      assert.equal(outs[0].confirmedEventId, 'med-fixb-empty__r1');
    });

    await runCase(
      'F2F-FIXB-12',
      'Fix B (12/12): Verified complete snapshot with movements outside ±30s & known inside ±30s -> SYNCED_CONFIRMED + live Firestore fetchVerifiedBranchMovementHistorySnapshot',
      async () => {
        // Part A: Explicit verified snapshot with known movement inside ±30s + unrelated movement outside ±30s
        const s = new InMemoryStocktakeSidecarStore();
        await recordOfflinePhysicalCountLocalPending(s, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-fixb-known',
          medicineName: 'Loratadine 10mg',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1',
          clientCountNonce: 'nonce-fixb-12a',
          countedQuantity: 22,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 10,
          knownMovementIdsAtCount: ['mv-known-in-30s'],
          countBusinessAtMs: fixBCountAt,
        });
        const outs = await reconcileAndSyncOfflinePendingCounts(c1Db, s, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: makeVerifiedSnapshot({
            intervalStartMs: fixBNow - 600_000,
            intervalEndMs: fixBNow,
            watermarkAtMs: fixBNow,
            movements: [
              {
                id: 'mv-old-outside-30s',
                branchId: 'khalid-1',
                medicineId: 'med-fixb-known',
                batchNumber: 'B1',
                type: 'SALE',
                unit: 'pack',
                quantityDelta: -2,
                baseUnitsDelta: -20,
                referenceId: 'sale-old-1',
                businessOccurredAtMs: fixBCountAt - 180_000,
                localPersistedAtMs: fixBCountAt - 180_000,
                serverSyncedAtMs: fixBCountAt - 179_000,
                synced: true,
              },
              {
                id: 'mv-known-in-30s',
                branchId: 'khalid-1',
                medicineId: 'med-fixb-known',
                batchNumber: 'B1',
                type: 'SALE',
                unit: 'pack',
                quantityDelta: -1,
                baseUnitsDelta: -10,
                referenceId: 'sale-known-2',
                businessOccurredAtMs: fixBCountAt - 5_000,
                localPersistedAtMs: fixBCountAt - 5_000,
                serverSyncedAtMs: fixBCountAt - 4_000,
                synced: true,
              },
              {
                id: 'mv-later-outside-30s',
                branchId: 'khalid-1',
                medicineId: 'med-fixb-known',
                batchNumber: 'B1',
                type: 'SALE',
                unit: 'pack',
                quantityDelta: -1,
                baseUnitsDelta: -10,
                referenceId: 'sale-later-3',
                businessOccurredAtMs: fixBCountAt + 60_000,
                localPersistedAtMs: fixBCountAt + 60_000,
                serverSyncedAtMs: fixBCountAt + 61_000,
                synced: true,
              },
            ],
          }),
          nowMs: fixBNow,
        });
        assert.equal(outs[0].outcome, 'SYNCED_CONFIRMED');

        // Part B: Live Firestore fetchVerifiedBranchMovementHistorySnapshot (complete + truncated fail-closed!)
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          const db = ctx.firestore();
          await setDoc(doc(db, 'branches/khalid-1/inventory_ledger/mv-live-01'), {
            id: 'mv-live-01',
            branchId: 'khalid-1',
            medicineId: 'med-fixb-live',
            type: 'SALE',
            unit: 'pack',
            quantityDelta: -1,
            baseUnitsDelta: -6,
            referenceId: 'sale-live-01',
            businessOccurredAtMs: fixBCountAt - 180_000,
            localPersistedAtMs: fixBCountAt - 180_000,
            createdAt: serverTimestamp(),
          });
          await setDoc(doc(db, 'branches/khalid-1/inventory_ledger/mv-live-02'), {
            id: 'mv-live-02',
            branchId: 'khalid-1',
            medicineId: 'med-fixb-live',
            type: 'SALE',
            unit: 'pack',
            quantityDelta: -1,
            baseUnitsDelta: -6,
            referenceId: 'sale-live-02',
            businessOccurredAtMs: fixBCountAt + 60_000,
            localPersistedAtMs: fixBCountAt + 60_000,
            createdAt: serverTimestamp(),
          });
        });

        // Truncated fetch (maxDocs = 1 when 2 exist) -> MUST mark paginationComplete=false & INCOMPLETE -> NEEDS_REVIEW!
        const truncatedSnap = await fetchVerifiedBranchMovementHistorySnapshot(c1Db, {
          branchId: 'khalid-1',
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: fixBNow,
          maxDocs: 1,
        });
        assert.equal(truncatedSnap.paginationComplete, false);
        assert.equal(truncatedSnap.completenessStatus, 'INCOMPLETE');

        // Full fetch (maxDocs = 50) -> VERIFIED_COMPLETE & paginationComplete = true -> SYNCED_CONFIRMED!
        const liveFullSnap = await fetchVerifiedBranchMovementHistorySnapshot(c1Db, {
          branchId: 'khalid-1',
          intervalStartMs: fixBNow - 600_000,
          intervalEndMs: Date.now(),
          maxDocs: 50,
        });
        assert.equal(liveFullSnap.paginationComplete, true);
        assert.equal(liveFullSnap.completenessStatus, 'VERIFIED_COMPLETE');
        assert.equal(liveFullSnap.movements.length, 2);

        const sLive = new InMemoryStocktakeSidecarStore();
        await recordOfflinePhysicalCountLocalPending(sLive, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-fixb-live',
          medicineName: 'Azithromycin 250mg',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1',
          clientCountNonce: 'nonce-fixb-12b',
          countedQuantity: 30,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 6,
          knownMovementIdsAtCount: ['mv-live-01'],
          countBusinessAtMs: fixBCountAt,
        });
        const liveOuts = await reconcileAndSyncOfflinePendingCounts(c1Db, sLive, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: liveFullSnap,
        });
        assert.equal(liveOuts[0].outcome, 'SYNCED_CONFIRMED');
      }
    );

    // =========================================================================
    // PART 3: FIX C — ALL 9 MANDATORY COLLISION & ADVERSARIAL ID TESTS
    // =========================================================================

    const baseTuple = {
      branchId: 'khalid-1',
      sessionId: 'sess-001',
      medicineId: 'med-001',
      actorUid: 'cashier-1',
      clientCountNonce: 'nonce-001',
    };

    await runCase('F2F-FIXC-01', 'Fix C (1/9): FIPS 180-4 SHA-256 NIST test vector + deterministic 69-char off2_<64hex>', async () => {
      assert.equal(
        sha256Utf8Hex('abc'),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      );
      assert.equal(
        sha256Utf8Hex(''),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
      const id1 = buildDeterministicOfflineRecordId(baseTuple);
      const id2 = buildDeterministicOfflineRecordId({ ...baseTuple });
      assert.equal(id1, id2);
      assert.match(id1, /^off2_[0-9a-f]{64}$/);
      assert.equal(id1.length, 69);
    });

    await runCase('F2F-FIXC-02', 'Fix C (2/9): Distinct branchId produces distinct ID', async () => {
      const a = buildDeterministicOfflineRecordId(baseTuple);
      const b = buildDeterministicOfflineRecordId({ ...baseTuple, branchId: 'khalid-2' });
      assert.notEqual(a, b);
    });

    await runCase('F2F-FIXC-03', 'Fix C (3/9): Distinct sessionId produces distinct ID', async () => {
      const a = buildDeterministicOfflineRecordId(baseTuple);
      const b = buildDeterministicOfflineRecordId({ ...baseTuple, sessionId: 'sess-002' });
      assert.notEqual(a, b);
    });

    await runCase('F2F-FIXC-04', 'Fix C (4/9): Distinct medicineId produces distinct ID', async () => {
      const a = buildDeterministicOfflineRecordId(baseTuple);
      const b = buildDeterministicOfflineRecordId({ ...baseTuple, medicineId: 'med-002' });
      assert.notEqual(a, b);
    });

    await runCase('F2F-FIXC-05', 'Fix C (5/9): Distinct actorUid produces distinct ID', async () => {
      const a = buildDeterministicOfflineRecordId(baseTuple);
      const b = buildDeterministicOfflineRecordId({ ...baseTuple, actorUid: 'cashier-2' });
      assert.notEqual(a, b);
    });

    await runCase('F2F-FIXC-06', 'Fix C (6/9): Distinct clientCountNonce produces distinct ID', async () => {
      const a = buildDeterministicOfflineRecordId(baseTuple);
      const b = buildDeterministicOfflineRecordId({ ...baseTuple, clientCountNonce: 'nonce-002' });
      assert.notEqual(a, b);
    });

    await runCase('F2F-FIXC-07', 'Fix C (7/9): Delimiter collision resistance (med_a+b vs med+a_b and embedded pipes/colons)', async () => {
      const a = buildDeterministicOfflineRecordId({
        ...baseTuple,
        medicineId: 'med_a',
        actorUid: 'b',
      });
      const b = buildDeterministicOfflineRecordId({
        ...baseTuple,
        medicineId: 'med',
        actorUid: 'a_b',
      });
      assert.notEqual(a, b);

      const pipeA = buildDeterministicOfflineRecordId({
        ...baseTuple,
        medicineId: 'm|1:x',
        actorUid: 'u',
      });
      const pipeB = buildDeterministicOfflineRecordId({
        ...baseTuple,
        medicineId: 'm',
        actorUid: '1:x|u',
      });
      assert.notEqual(pipeA, pipeB);
    });

    await runCase('F2F-FIXC-08', 'Fix C (8/9): Punctuation & Unicode lossy-normalization resistance', async () => {
      const dot = buildDeterministicOfflineRecordId({ ...baseTuple, medicineId: 'med-1.2' });
      const under = buildDeterministicOfflineRecordId({ ...baseTuple, medicineId: 'med-1_2' });
      const slash = buildDeterministicOfflineRecordId({ ...baseTuple, medicineId: 'med/a' });
      const colon = buildDeterministicOfflineRecordId({ ...baseTuple, medicineId: 'med:a' });
      const ar1 = buildDeterministicOfflineRecordId({ ...baseTuple, medicineId: 'دواء-١' });
      const ar2 = buildDeterministicOfflineRecordId({ ...baseTuple, medicineId: 'دواء-٢' });
      assert.equal(new Set([dot, under, slash, colon, ar1, ar2]).size, 6);
    });

    await runCase('F2F-FIXC-09', 'Fix C (9/9): >120-char shared-prefix truncation resistance & invalid empty/whitespace input rejection', async () => {
      const prefix = 'x'.repeat(150);
      const longA = buildDeterministicOfflineRecordId({
        ...baseTuple,
        medicineId: `${prefix}A`,
      });
      const longB = buildDeterministicOfflineRecordId({
        ...baseTuple,
        medicineId: `${prefix}B`,
      });
      assert.notEqual(longA, longB);
      assert.equal(longA.length, 69);
      assert.equal(longB.length, 69);

      assert.throws(() =>
        buildDeterministicOfflineRecordId({ ...baseTuple, branchId: '' })
      );
      assert.throws(() =>
        buildDeterministicOfflineRecordId({ ...baseTuple, medicineId: '   ' })
      );
      assert.throws(() =>
        buildDeterministicOfflineRecordId({ ...baseTuple, actorUid: ' cashier-1 ' })
      );
    });

    // =========================================================================
    // PART 4: FIX F — COMPLETE LIFECYCLE, RESTART, CONCURRENCY, NON-POSTING
    // =========================================================================

    await runCase(
      'F2F-FIXF-01',
      'Fix F (1/4): Restart persistence (exportSnapshot -> fromSnapshot) + interrupted RECONCILIATION_PENDING recovery',
      async () => {
        const preRestartStore = new InMemoryStocktakeSidecarStore();
        const tCount = Date.now() - 90_000;
        const rec = await recordOfflinePhysicalCountLocalPending(preRestartStore, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-restart',
          medicineName: 'Metformin 500mg',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1',
          clientCountNonce: 'nonce-restart-01',
          countedQuantity: 40,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 30,
          knownMovementIdsAtCount: [],
          countBusinessAtMs: tCount,
        });

        // Simulate app/browser crash mid-reconciliation while status was RECONCILIATION_PENDING
        await preRestartStore.put({
          ...rec,
          status: 'RECONCILIATION_PENDING',
          lastReconcileAttemptAtMs: Date.now() - 10_000,
        });
        const persistedJson = preRestartStore.exportSnapshot();

        // Simulate fresh app boot restoring from persisted sidecar storage
        const postRestartStore = InMemoryStocktakeSidecarStore.fromSnapshot(persistedJson);
        const restored = await postRestartStore.get(rec.localRecordId);
        assert.equal(restored?.status, 'RECONCILIATION_PENDING');

        const now = Date.now();
        const outs = await reconcileAndSyncOfflinePendingCounts(c1Db, postRestartStore, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: makeVerifiedSnapshot({
            intervalStartMs: now - 600_000,
            intervalEndMs: now,
            watermarkAtMs: now,
          }),
          nowMs: now,
        });
        assert.equal(outs[0].outcome, 'SYNCED_CONFIRMED');
        assert.equal(outs[0].confirmedEventId, 'med-restart__r1');
      }
    );

    await runCase(
      'F2F-FIXF-02',
      'Fix F (2/4): Concurrent 2-device offline capture -> first confirms, second stays CONFLICT_ALREADY_COUNTED (zero overwrite, zero leak)',
      async () => {
        const tCount = Date.now() - 90_000;
        const recC1 = await recordOfflinePhysicalCountLocalPending(sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-concurrent',
          medicineName: 'Losartan 50mg',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1',
          clientCountNonce: 'nonce-conc-c1',
          countedQuantity: 15,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 28,
          knownMovementIdsAtCount: [],
          countBusinessAtMs: tCount,
        });
        const recC2 = await recordOfflinePhysicalCountLocalPending(sidecarC2, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-concurrent',
          medicineName: 'Losartan 50mg',
          actorUid: 'cashier-2',
          actorDisplayName: 'Cashier 2',
          actorRole: 'cashier',
          deviceId: 'dev-c2',
          clientCountNonce: 'nonce-conc-c2',
          countedQuantity: 19,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 28,
          knownMovementIdsAtCount: [],
          countBusinessAtMs: tCount,
        });

        const now = Date.now();
        const snap = makeVerifiedSnapshot({
          intervalStartMs: now - 600_000,
          intervalEndMs: now,
          watermarkAtMs: now,
        });

        const outs1 = await reconcileAndSyncOfflinePendingCounts(c1Db, sidecarC1, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: snap,
          nowMs: now,
        });
        const outs2 = await reconcileAndSyncOfflinePendingCounts(c2Db, sidecarC2, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-2',
          movementHistorySnapshot: snap,
          nowMs: now,
        });

        assert.equal(
          outs1.find((o) => o.localRecordId === recC1.localRecordId)?.outcome,
          'SYNCED_CONFIRMED'
        );
        const outC2 = outs2.find((o) => o.localRecordId === recC2.localRecordId);
        assert.equal(outC2?.outcome, 'CONFLICT_ALREADY_COUNTED');
        assert.equal(outC2?.conflictDetail?.includes('cashier-1'), false);
        assert.equal(outC2?.conflictDetail?.includes('15'), false);
      }
    );

    await runCase(
      'F2F-FIXF-03',
      'Fix F (3/4): Closed session rejects offline sync cleanly & ZERO automatic ADJUSTMENT ledger entries created',
      async () => {
        const sClosed = new InMemoryStocktakeSidecarStore();
        const tCount = Date.now() - 90_000;
        await recordOfflinePhysicalCountLocalPending(sClosed, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-closed',
          medicineName: 'Atorvastatin 20mg',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1',
          clientCountNonce: 'nonce-closed-01',
          countedQuantity: 5,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 30,
          knownMovementIdsAtCount: [],
          countBusinessAtMs: tCount,
        });

        // Transition session IN_PROGRESS -> REVIEWING
        await transitionStocktakeSessionStatusTx(adminDb, {
          branchId: 'khalid-1',
          sessionId: sessId,
          targetStatus: 'RECONCILING',
          adminUid: 'admin-1',
        });

        const now = Date.now();
        const outs = await reconcileAndSyncOfflinePendingCounts(c1Db, sClosed, {
          branchId: 'khalid-1',
          sessionId: sessId,
          actorUid: 'cashier-1',
          movementHistorySnapshot: makeVerifiedSnapshot({
            intervalStartMs: now - 600_000,
            intervalEndMs: now,
            watermarkAtMs: now,
          }),
          nowMs: now,
        });
        assert.equal(outs[0].outcome, 'CONFLICT_SESSION_NOT_IN_PROGRESS');
        assert.equal(outs[0].conflictCode, 'SESSION_STATUS_RECONCILING');

        // Verify ZERO ADJUSTMENT entries were auto-posted into inventory_ledger by offline sync!
        const adjSnap = await assertSucceeds(
          getDocs(
            query(
              collection(adminDb, 'branches/khalid-1/inventory_ledger'),
              where('branchId', '==', 'khalid-1'),
              where('type', '==', 'ADJUSTMENT')
            )
          )
        );
        assert.equal(adjSnap.size, 0, 'Offline sync MUST NEVER auto-post Inventory Ledger adjustments!');
      }
    );

    await runCase(
      'F2F-FIXF-04',
      'Fix F (4/4): Outbox V2 remains disabled and stocktakeLocalSidecarQueue.ts has ZERO pharmacyDb.ts or outbox imports',
      async () => {
        assert.equal(isOutboxV2WorkerEnabled(), false);
        const sidecarSrc = fs.readFileSync(
          path.resolve('src/services/stocktakeLocalSidecarQueue.ts'),
          'utf8'
        );
        assert.equal(/^\s*import\b.*pharmacyDb/m.test(sidecarSrc), false);
        assert.equal(/^\s*import\b.*outboxV2/m.test(sidecarSrc), false);
        assert.equal(/^\s*import\b.*outboxFeatureFlags/m.test(sidecarSrc), false);
      }
    );

    console.log('\n============================================================');
    console.log(
      `PHASE 2F PR-F3 REAL EMULATOR OFFLINE SUITE: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`
    );
    console.log('============================================================');
    if (failed > 0) process.exitCode = 1;
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((err) => {
  console.error('FATAL PR-F3 EMULATOR ERROR:', err);
  process.exit(1);
});
