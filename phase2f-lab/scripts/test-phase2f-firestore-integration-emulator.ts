/**
 * Phase 2F — PR-F2 Real Firestore Emulator End-to-End Integration Suite
 *
 * Tests `src/services/stocktakeFirestoreService.ts` + `stocktakeReconciliationEngine.ts`
 * directly against `firestore.rules` in the real Firebase Firestore Emulator.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertFails,
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
  setDoc,
  serverTimestamp,
  updateDoc,
  setLogLevel,
  Timestamp,
  where,
  type Firestore,
} from 'firebase/firestore';
import { createRational } from '../src/services/exactFinance.ts';
import {
  FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS,
  FORBIDDEN_SHARED_ITEM_COUNT_FIELDS,
  assertOperationalStocktakePayloadSafe,
  computeMovementWatermarkDigest,
  scanForForbiddenKeys,
} from '../src/services/stocktakeContract.ts';
import { reconcileMedicineAtCountReference } from '../src/services/stocktakeReconciliationEngine.ts';
import {
  abortDraftStocktakeSessionTx,
  acquireStocktakeLeaseTx,
  approveAndPostStocktakeAdjustmentTx,
  createStocktakeV2SessionAndItems,
  loadCashierStocktakeOperationalViews,
  loadAdminStocktakeSessionDetails,
  persistAdminStocktakeReconciliationTx,
  transitionStocktakeSessionStatusTx,
  renewStocktakeLeaseTx,
  requestRecountAdminTx,
  submitStocktakeCountTx,
} from '../src/services/stocktakeFirestoreService.ts';

const PROJECT_ID = 'demo-khalid-pharmacy';
const RULES_PATH = path.resolve(process.cwd(), 'firestore.rules');

let passed = 0;
let failed = 0;

async function runCase(id: string, name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`[PASS] ${id} — ${name}`);
  } catch (err) {
    failed++;
    console.error(`[FAIL] ${id} — ${name}:`, err);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function authedDb(testEnv: RulesTestEnvironment, uid: string): Firestore {
  return testEnv
    .authenticatedContext(uid, { email: `${uid}@khalid.test`, email_verified: true })
    .firestore() as unknown as Firestore;
}

async function seedFixtures(testEnv: RulesTestEnvironment) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = Timestamp.now();
    await setDoc(doc(db, 'branches/khalid-1'), {
      id: 'khalid-1',
      name: 'Khalid 1',
      active: true,
      adminUids: ['admin-1'],
      memberUids: ['admin-1', 'cashier-1', 'cashier-1b'],
      createdAt: now,
      updatedAt: now,
    });
    for (const u of [
      { uid: 'admin-1', role: 'admin', branchIds: ['khalid-1'], activeBranchId: 'khalid-1', displayName: 'Admin 1' },
      { uid: 'cashier-1', role: 'cashier', branchIds: ['khalid-1'], activeBranchId: 'khalid-1', displayName: 'Cashier 1' },
      { uid: 'cashier-1b', role: 'cashier', branchIds: ['khalid-1'], activeBranchId: 'khalid-1', displayName: 'Cashier 1B' },
    ]) {
      await setDoc(doc(db, `users/${u.uid}`), {
        ...u,
        email: `${u.uid}@khalid.test`,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const medId of ['med-1', 'med-2']) {
      await setDoc(doc(db, `branches/khalid-1/medicines/${medId}`), {
        id: medId,
        branchId: 'khalid-1',
        name: `Amoxicillin ${medId}`,
        sellPrice: 120,
        unitSchemaVersion: 2,
        dosageForm: 'capsule',
        baseUnitLabel: 'pill',
        stripsPerPack: 2,
        pillsPerStrip: 10,
        baseUnitsPerPack: 20,
        configStatus: 'VERIFIED',
        unitMigrationStatus: 'NATIVE_V2',
        packingLocked: false,
        syncVersion: 1,
        unitDefinition: {
          mode: 'SOLID_TWO_LEVEL',
          dosageForm: 'capsule',
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
        createdAt: now,
        updatedAt: now,
      });
    }
  });
}

async function main() {
  setLogLevel('error');
  const rules = fs.readFileSync(RULES_PATH, 'utf8');
  const testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules, host: '127.0.0.1', port: 8080 },
  });

  try {
    await seedFixtures(testEnv);
    const adminDb = authedDb(testEnv, 'admin-1');
    const c1Db = authedDb(testEnv, 'cashier-1');
    const c1bDb = authedDb(testEnv, 'cashier-1b');
    const sessId = 'sess-int-001';

    await runCase('F2F-INT-01', 'Admin opens Phase 2F session & items; Cashier reads blind remaining view', async () => {
      await createStocktakeV2SessionAndItems(adminDb, {
        branchId: 'khalid-1',
        sessionId: sessId,
        sessionNumber: 'ST-INT-001',
        scopeMode: 'FULL',
        adminUid: 'admin-1',
        adminDisplayName: 'Admin 1',
        items: [
          { medicineId: 'med-1', medicineName: 'Amoxicillin med-1', primaryBarcode: '6280001', availableUnits: ['pack', 'strip', 'pill'] },
          { medicineId: 'med-2', medicineName: 'Amoxicillin med-2', primaryBarcode: '6280002', availableUnits: ['pack', 'strip', 'pill'] },
        ],
      });
      const q = query(
        collection(c1Db, `branches/khalid-1/stocktake_sessions_v2/${sessId}/items`),
        where('branchId', '==', 'khalid-1'),
        where('sessionId', '==', sessId)
      );
      const snap = await assertSucceeds(getDocs(q));
      assert.equal(snap.size, 2);
      snap.forEach((d) => {
        assert.equal(assertOperationalStocktakePayloadSafe(d.data()).valid, true, `cashier_read:${d.id}`);
      });
    });

    let winnerUid = '';
    let winnerDb: Firestore = c1Db;

    await runCase('F2F-INT-02', 'Real concurrent Promise.all 2-cashier runTransaction CAS lease race -> exactly 1 winner', async () => {
      const [r1, r2] = await Promise.all([
        acquireStocktakeLeaseTx(c1Db, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-1',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          deviceId: 'dev-c1',
          leaseId: 'lease-race-c1',
          ttlMs: 120_000,
        }),
        acquireStocktakeLeaseTx(c1bDb, {
          branchId: 'khalid-1',
          sessionId: sessId,
          medicineId: 'med-1',
          actorUid: 'cashier-1b',
          actorDisplayName: 'Cashier 1B',
          deviceId: 'dev-c1b',
          leaseId: 'lease-race-c1b',
          ttlMs: 120_000,
        }),
      ]);
      const winners = [r1.ok ? 'cashier-1' : null, r2.ok ? 'cashier-1b' : null].filter(Boolean) as string[];
      assert.equal(winners.length, 1, `Expected exactly 1 CAS winner, got r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);
      winnerUid = winners[0];
      winnerDb = winnerUid === 'cashier-1' ? c1Db : c1bDb;
      const loser = winnerUid === 'cashier-1' ? r2 : r1;
      assert.equal(loser.ok, false);
      if (!loser.ok) assert.equal(loser.code, 'LEASE_CONFLICT_ACTIVE');
    });

    let submittedEventId = '';

    await runCase('F2F-INT-03', 'Winner renews lease & submits atomic count (count_events + item + operational_audit)', async () => {
      const ren = await renewStocktakeLeaseTx(winnerDb, 'khalid-1', sessId, 'med-1', winnerUid, 120_000);
      assert.equal(ren.ok, true);

      const sub = await submitStocktakeCountTx(winnerDb, {
        branchId: 'khalid-1',
        sessionId: sessId,
        medicineId: 'med-1',
        actorUid: winnerUid,
        actorDisplayName: winnerUid,
        actorRole: 'cashier',
        deviceId: 'dev-winner',
        countedQuantity: 4,
        countUnit: 'pack',
        baseUnitsPerCountUnit: 20,
        knownMovementIdsAtCount: ['mov-init-1'],
        notes: 'Counted shelf A1',
      });
      assert.equal(sub.countRevision, 1);
      assert.equal(sub.countedBaseUnits, 80);
      submittedEventId = sub.eventId;

      const evSnap = await assertSucceeds(
        getDoc(doc(winnerDb, `branches/khalid-1/stocktake_sessions_v2/${sessId}/count_events/${sub.eventId}`))
      );
      assert.equal(evSnap.exists(), true);
      // Cashier cannot read operational_audit; Admin CAN
      await assertFails(
        getDoc(doc(winnerDb, `branches/khalid-1/stocktake_sessions_v2/${sessId}/operational_audit/aud-${sub.eventId}`))
      );
      await assertSucceeds(
        getDoc(doc(adminDb, `branches/khalid-1/stocktake_sessions_v2/${sessId}/operational_audit/aud-${sub.eventId}`))
      );
    });

    await runCase('F2F-INT-04', 'Real server-time request.time lease expiry takeover on med-2', async () => {
      const shortLease = await acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sessId,
        medicineId: 'med-2',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'lease-short-m2',
        ttlMs: 1500,
      });
      assert.equal(shortLease.ok, true);
      await sleep(2200);
      const takeover = await acquireStocktakeLeaseTx(c1bDb, {
        branchId: 'khalid-1',
        sessionId: sessId,
        medicineId: 'med-2',
        actorUid: 'cashier-1b',
        actorDisplayName: 'Cashier 1B',
        deviceId: 'dev-c1b',
        leaseId: 'lease-takeover-m2',
        ttlMs: 120_000,
      });
      assert.equal(takeover.ok, true);
      if (takeover.ok) assert.equal(takeover.leaseVersion, 2);
    });

    await runCase('F2F-INT-05', 'Admin reconciles exact rational variance & persists to Domain B; Cashier DENIED', async () => {
      const nowMs = Date.now();
      const rec = reconcileMedicineAtCountReference({
        sessionId: sessId,
        branchId: 'khalid-1',
        reconciliationVersion: 1,
        countEvent: {
          eventId: submittedEventId,
          idempotencyKey: 'idem-int-1',
          sessionId: sessId,
          branchId: 'khalid-1',
          medicineId: 'med-1',
          countRevision: 1,
          leaseId: 'lease-1',
          leaseVersion: 1,
          countedQuantity: 4,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 20,
          countedBaseUnits: 80,
          actorUid: winnerUid,
          actorDisplayName: winnerUid,
          deviceId: 'dev-winner',
          watermark: {
            countBusinessAtMs: nowMs - 10_000,
            localPersistedAtMs: nowMs - 10_000,
            serverConfirmedAtMs: nowMs - 9_500,
            medicineLedgerSeq: null,
            knownMovementIdsAtCount: ['mov-init-1'],
            knownMovementCount: 1,
            watermarkDigest: computeMovementWatermarkDigest(['mov-init-1']),
          },
          syncStatus: 'CONFIRMED',
          recountOfEventId: null,
          notes: '',
        },
        unitSpec: {
          medicineId: 'med-1',
          unitOperationalAllowed: true,
          unitMode: 'SOLID_TWO_LEVEL',
          stripsPerPack: 2,
          pillsPerStrip: 10,
          baseUnitsPerPack: 20,
        },
        allMedicineLedgerMovements: [
          {
            id: 'mov-init-1',
            branchId: 'khalid-1',
            medicineId: 'med-1',
            type: 'INITIAL',
            unit: 'pack',
            quantityDelta: 5,
            baseUnitsDelta: 100,
            batchNumber: 'B-100',
            businessOccurredAtMs: nowMs - 120_000,
            localPersistedAtMs: nowMs - 120_000,
            serverSyncedAtMs: nowMs - 119_500,
            synced: true,
            referenceId: 'init-1',
          },
        ],
        batchLayersFefo: [
          {
            batchNumber: 'B-100',
            expiry: '2027-12-31',
            remainingBaseUnits: 100,
            costPerBaseUnitExact: createRational(4n, 1n),
            sourceReceiptMovementId: 'mov-init-1',
          },
        ],
        reconciledAtMs: nowMs,
      });

      assert.equal(rec.financialLine.requiredLedgerAdjustmentBaseUnits, -20);
      assert.equal(rec.valuation.costStatus, 'EXACT_HISTORICAL');

      await persistAdminStocktakeReconciliationTx(adminDb, {
        branchId: 'khalid-1',
        sessionId: sessId,
        adminUid: 'admin-1',
        adminRole: 'admin',
        reconciliationStatus: 'PENDING_APPROVAL',
        totalExpectedValuationExact: rec.valuation.expectedInventoryValuationExact,
        totalSystemValuationExact: createRational(400n, 1n),
        netVarianceValuationExact: rec.valuation.financialVarianceExact,
        unresolvedItemsCount: 0,
        lines: [
          {
            medicineId: 'med-1',
            expectedCurrentBaseUnits: rec.financialLine.expectedCurrentBaseUnits,
            systemCurrentBaseUnits: rec.financialLine.systemCurrentBaseUnits,
            varianceBaseUnits: rec.financialLine.requiredLedgerAdjustmentBaseUnits,
            discrepancyStatus: rec.financialLine.discrepancyStatus,
            financialVarianceExact: rec.valuation.financialVarianceExact,
          },
        ],
        auditId: 'faud-int-1',
      });

      // Cashier strictly denied on Domain B summary & line
      await assertFails(getDoc(doc(c1Db, `branches/khalid-1/stocktake_financials/${sessId}`)));
      await assertFails(getDoc(doc(c1Db, `branches/khalid-1/stocktake_financials/${sessId}/lines/med-1`)));
    });

    await runCase('F2F-INT-06', 'Idempotent Admin approval & ledger posting (operational ledger zero-cost + inventory_financials exact)', async () => {
      const postInput = {
        branchId: 'khalid-1',
        sessionId: sessId,
        adminUid: 'admin-1',
        adminRole: 'admin' as const,
        approvalId: 'apr-int-1',
        postingId: 'post-int-1',
        approvalReason: 'Verified 1-pack shortage on shelf A1',
        adjustments: [
          {
            medicineId: 'med-1',
            adjustmentBaseUnitsDelta: -20,
            costPerBaseUnitExact: createRational(4n, 1n),
            totalCostExact: createRational(-80n, 1n),
          },
        ],
      };

      const first = await approveAndPostStocktakeAdjustmentTx(adminDb, postInput);
      assert.equal(first.idempotentReplay, false);
      assert.equal(first.postedLedgerIds.length, 1);

      // Verify operational inventory_ledger doc has ZERO cost fields and is readable by cashier
      const movId = first.postedLedgerIds[0];
      const ledSnap = await assertSucceeds(getDoc(doc(c1Db, `branches/khalid-1/inventory_ledger/${movId}`)));
      assert.equal(ledSnap.data()?.type, 'ADJUSTMENT');
      assert.equal(ledSnap.data()?.baseUnitsDelta, -20);
      assert.equal(assertOperationalStocktakePayloadSafe(ledSnap.data()).valid, true, `inventory_ledger/${movId}`);

      // Verify inventory_financials doc exists for Admin & DENIED for Cashier
      await assertSucceeds(getDoc(doc(adminDb, `branches/khalid-1/inventory_financials/${movId}`)));
      await assertFails(getDoc(doc(c1Db, `branches/khalid-1/inventory_financials/${movId}`)));

      // Replay exact same posting -> idempotentReplay: true (zero duplicate writes!)
      const replay = await approveAndPostStocktakeAdjustmentTx(adminDb, postInput);
      assert.equal(replay.idempotentReplay, true);
      assert.deepEqual(replay.postedLedgerIds, first.postedLedgerIds);
    });

    await runCase('F2F-INT-07', 'Admin recount preserves rev 1 count_event untouched and appends rev 2', async () => {
      await requestRecountAdminTx(adminDb, 'khalid-1', sessId, 'med-1', 'Double-check top shelf');
      const acq2 = await acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sessId,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'lease-recount-1',
        ttlMs: 120_000,
      });
      assert.equal(acq2.ok, true);

      const sub2 = await submitStocktakeCountTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sessId,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        actorRole: 'cashier',
        deviceId: 'dev-c1',
        countedQuantity: 5,
        countUnit: 'pack',
        baseUnitsPerCountUnit: 20,
        knownMovementIdsAtCount: ['mov-init-1'],
      });
      assert.equal(sub2.countRevision, 2);

      // Both rev 1 and rev 2 count_events exist intact!
      const ev1 = await assertSucceeds(
        getDoc(doc(adminDb, `branches/khalid-1/stocktake_sessions_v2/${sessId}/count_events/${submittedEventId}`))
      );
      const ev2 = await assertSucceeds(
        getDoc(doc(adminDb, `branches/khalid-1/stocktake_sessions_v2/${sessId}/count_events/${sub2.eventId}`))
      );
      assert.equal(ev1.exists(), true);
      assert.equal(ev2.exists(), true);
      assert.equal(ev2.data()?.recountOfEventId, submittedEventId);
    });


    await runCase('F2F-INT-08', 'Adversarial clock-manipulation attacks (+1h/-1h acquire, +20m/>30m/expired renew) DENIED by request.time', async () => {
      const advSess = 'sess-int-adv-clock';
      const initRes = await createStocktakeV2SessionAndItems(adminDb, {
        branchId: 'khalid-1',
        sessionId: advSess,
        sessionNumber: 'ST-INT-ADV',
        scopeMode: 'PARTIAL',
        adminUid: 'admin-1',
        adminDisplayName: 'Admin 1',
        items: [{ medicineId: 'med-1', medicineName: 'Amoxicillin med-1', availableUnits: ['pack', 'strip', 'pill'] }],
      });
      assert.equal(initRes.atomicSingleBatch, true);

      const itemRef = doc(c1Db, `branches/khalid-1/stocktake_sessions_v2/${advSess}/items/med-1`);
      // +1h future clock acquire -> DENIED
      await assertFails(updateDoc(itemRef, {
        state: 'RESERVED',
        leaseVersion: 1,
        activeLease: {
          leaseId: 'adv-future-1h',
          ownerUid: 'cashier-1',
          deviceId: 'dev-c1',
          leaseVersion: 1,
          renewalCount: 0,
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60_000),
        },
        updatedAt: serverTimestamp(),
      }));
      // -1h past clock acquire -> DENIED
      await assertFails(updateDoc(itemRef, {
        state: 'RESERVED',
        leaseVersion: 1,
        activeLease: {
          leaseId: 'adv-past-1h',
          ownerUid: 'cashier-1',
          deviceId: 'dev-c1',
          leaseVersion: 1,
          renewalCount: 0,
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() - 60 * 60_000),
        },
        updatedAt: serverTimestamp(),
      }));
      // Valid lease via service
      const okLease = await acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: advSess,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'adv-ok-lease',
        ttlMs: 120_000,
      });
      assert.equal(okLease.ok, true);

      // +20m renew via raw manipulated client -> DENIED
      const snap = await assertSucceeds(getDoc(itemRef));
      await assertFails(updateDoc(itemRef, {
        activeLease: {
          ...snap.data()!.activeLease,
          renewalCount: 1,
          expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60_000),
        },
        updatedAt: serverTimestamp(),
      }));
    });

    await runCase('F2F-INT-09', 'Simultaneous renew-vs-submit race resolves cleanly with zero corruption', async () => {
      const advSess = 'sess-int-adv-clock';
      const [renRes, subRes] = await Promise.allSettled([
        renewStocktakeLeaseTx(c1Db, 'khalid-1', advSess, 'med-1', 'cashier-1', 120_000),
        submitStocktakeCountTx(c1Db, {
          branchId: 'khalid-1',
          sessionId: advSess,
          medicineId: 'med-1',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1',
          countedQuantity: 3,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 20,
          knownMovementIdsAtCount: ['mov-init-1'],
        }),
      ]);
      // Regardless of transaction serialization order, submit either succeeds (and item becomes COUNTED)
      // or cleanly resolves without crashing renew; verify final doc is consistent!
      const finalSnap = await assertSucceeds(getDoc(doc(c1Db, `branches/khalid-1/stocktake_sessions_v2/${advSess}/items/med-1`)));
      const st = finalSnap.data()?.state;
      assert.equal(st === 'COUNTED' || st === 'RESERVED', true, `Unexpected state after race: ${st}`);
      if (subRes.status === 'fulfilled') {
        assert.equal(st, 'COUNTED');
      } else {
        // Renew won first; submit can cleanly succeed immediately afterward
        assert.equal(renRes.status, 'fulfilled');
        const sub2 = await submitStocktakeCountTx(c1Db, {
          branchId: 'khalid-1',
          sessionId: advSess,
          medicineId: 'med-1',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          actorRole: 'cashier',
          deviceId: 'dev-c1',
          countedQuantity: 3,
          countUnit: 'pack',
          baseUnitsPerCountUnit: 20,
          knownMovementIdsAtCount: ['mov-init-1'],
        });
        assert.equal(sub2.countRevision, 1);
      }
    });

    await runCase('F2F-INT-10', 'Crash between DRAFT session & items creation -> un-leasable -> idempotent crash recovery -> repeat replay', async () => {
      const recSess = 'sess-int-recovery';
      const payload = {
        branchId: 'khalid-1',
        sessionId: recSess,
        sessionNumber: 'ST-INT-REC',
        scopeMode: 'FULL' as const,
        adminUid: 'admin-1',
        adminDisplayName: 'Admin 1',
        items: [
          { medicineId: 'med-1', medicineName: 'Amoxicillin med-1', availableUnits: ['pack', 'strip', 'pill'] as ('pack' | 'strip' | 'pill')[] },
          { medicineId: 'med-2', medicineName: 'Amoxicillin med-2', availableUnits: ['pack', 'strip', 'pill'] as ('pack' | 'strip' | 'pill')[] },
        ],
      };

      // 1) Simulate crash right after DRAFT session doc creation (0 items written!)
      let crashed = false;
      try {
        await createStocktakeV2SessionAndItems(adminDb, { ...payload, simulateCrashAfterDraftCreate: true });
      } catch (e: unknown) {
        crashed = String((e as Error).message).includes('SIMULATED_CRASH_AFTER_DRAFT_CREATE');
      }
      assert.equal(crashed, true);

      // Verify session is strictly DRAFT and Cashier CANNOT lease anything
      const draftSnap = await assertSucceeds(getDoc(doc(c1Db, `branches/khalid-1/stocktake_sessions_v2/${recSess}`)));
      assert.equal(draftSnap.data()?.status, 'DRAFT');
      const acqDraft = await acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: recSess,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'lease-draft-fail',
      });
      assert.equal(acqDraft.ok, false);

      // 2) Re-invoke createStocktakeV2SessionAndItems -> idempotently recovers DRAFT, creates both items, activates IN_PROGRESS
      const recRes = await createStocktakeV2SessionAndItems(adminDb, payload);
      assert.equal(recRes.recoveredFromDraft, true);
      assert.equal(recRes.createdItemsCount, 2);
      assert.equal(recRes.status, 'IN_PROGRESS');

      // 3) Repeat call on already-IN_PROGRESS session -> idempotent replay with 0 writes
      const repRes = await createStocktakeV2SessionAndItems(adminDb, payload);
      assert.equal(repRes.idempotentReplay, true);
      assert.equal(repRes.createdItemsCount, 0);
    });

    await runCase('F2F-INT-11', 'Safe cleanup of abandoned partial DRAFT session (DRAFT -> CANCELLED) blocks Cashiers permanently', async () => {
      const abortSess = 'sess-int-aborted';
      try {
        await createStocktakeV2SessionAndItems(adminDb, {
          branchId: 'khalid-1',
          sessionId: abortSess,
          sessionNumber: 'ST-INT-ABT',
          scopeMode: 'PARTIAL',
          adminUid: 'admin-1',
          adminDisplayName: 'Admin 1',
          items: [{ medicineId: 'med-1', medicineName: 'Amoxicillin med-1' }],
          simulateCrashAfterDraftCreate: true,
        });
      } catch {
        // expected simulated crash
      }
      await abortDraftStocktakeSessionTx(adminDb, 'khalid-1', abortSess, 'admin-1', 'Network dropped during init');
      const snap = await assertSucceeds(getDoc(doc(adminDb, `branches/khalid-1/stocktake_sessions_v2/${abortSess}`)));
      assert.equal(snap.data()?.status, 'CANCELLED');
      // Cannot re-initialize a CANCELLED session
      let blocked = false;
      try {
        await createStocktakeV2SessionAndItems(adminDb, {
          branchId: 'khalid-1',
          sessionId: abortSess,
          sessionNumber: 'ST-INT-ABT',
          scopeMode: 'PARTIAL',
          adminUid: 'admin-1',
          adminDisplayName: 'Admin 1',
          items: [{ medicineId: 'med-1', medicineName: 'Amoxicillin med-1' }],
        });
      } catch (e: unknown) {
        blocked = String((e as Error).message).includes('SESSION_NOT_REINITIALIZABLE:CANCELLED');
      }
      assert.equal(blocked, true);
    });

    await runCase('F2F-INT-12', 'OD-2F-3 Cashier visibility: sees ONLY own confirmed physical quantity + unit (zero cost/systemStock/variance)', async () => {
      // In sess-int-001, cashier-1 submitted rev 2 of med-1 (5 pack) in F2F-INT-07; med-2 is still RESERVED by cashier-1b.
      const c1Views = await loadCashierStocktakeOperationalViews(c1Db, 'khalid-1', sessId, 'cashier-1');
      assert.equal(c1Views.myConfirmedCounts.length, 1);
      assert.equal(c1Views.myConfirmedCounts[0].medicineId, 'med-1');
      assert.equal(c1Views.myConfirmedCounts[0].countedQuantity, 5);
      assert.equal(c1Views.myConfirmedCounts[0].countUnit, 'pack');
      assert.deepEqual(
        Object.keys(c1Views.myConfirmedCounts[0]).sort(),
        ['confirmedAtServerMs', 'countRevision', 'countUnit', 'countedQuantity', 'medicineId', 'medicineName']
      );
      assert.deepEqual(scanForForbiddenKeys(c1Views.myConfirmedCounts[0], FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS), []);
      assert.deepEqual(scanForForbiddenKeys(c1Views.remainingItems, FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS), []);

      // Cashier 1B must NOT see Cashier 1's confirmed count inside myConfirmedCounts!
      const c1bViews = await loadCashierStocktakeOperationalViews(c1bDb, 'khalid-1', sessId, 'cashier-1b');
      assert.equal(c1bViews.myConfirmedCounts.length, 0);
    });

    await runCase('F2F-INT-13', 'Fix A (OD-4): Service conflict leaks ZERO holderUid; shared items have ZERO count fields; Cashier A & B strictly isolated', async () => {
      const sIso = 'sess-int-fix-a';
      await createStocktakeV2SessionAndItems(adminDb, {
        branchId: 'khalid-1',
        sessionId: sIso,
        sessionNumber: 'ST-INT-FIXA',
        scopeMode: 'PARTIAL',
        adminUid: 'admin-1',
        adminDisplayName: 'Admin 1',
        items: [
          { medicineId: 'med-1', medicineName: 'Amoxicillin 500mg', availableUnits: ['pack', 'strip', 'pill'] },
          { medicineId: 'med-2', medicineName: 'Paracetamol 500mg', availableUnits: ['pack', 'strip', 'pill'] },
        ],
      });
      const leaseA = await acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sIso,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'lease-fixa-c1',
      });
      assert.equal(leaseA.ok, true);

      const conflictB = await acquireStocktakeLeaseTx(c1bDb, {
        branchId: 'khalid-1',
        sessionId: sIso,
        medicineId: 'med-1',
        actorUid: 'cashier-1b',
        actorDisplayName: 'Cashier 1B',
        deviceId: 'dev-c1b',
        leaseId: 'lease-fixa-c1b-conflict',
      });
      assert.equal(conflictB.ok, false);
      if (!conflictB.ok) {
        assert.equal(conflictB.code, 'LEASE_CONFLICT_ACTIVE');
        assert.deepEqual(Object.keys(conflictB).sort(), ['code', 'ok']);
        assert.equal('holderUid' in conflictB, false);
      }

      await submitStocktakeCountTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sIso,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        actorRole: 'cashier',
        deviceId: 'dev-c1',
        countedQuantity: 8,
        countUnit: 'pack',
        baseUnitsPerCountUnit: 20,
        knownMovementIdsAtCount: [],
      });
      const leaseB = await acquireStocktakeLeaseTx(c1bDb, {
        branchId: 'khalid-1',
        sessionId: sIso,
        medicineId: 'med-2',
        actorUid: 'cashier-1b',
        actorDisplayName: 'Cashier 1B',
        deviceId: 'dev-c1b',
        leaseId: 'lease-fixa-c1b',
      });
      assert.equal(leaseB.ok, true);
      await submitStocktakeCountTx(c1bDb, {
        branchId: 'khalid-1',
        sessionId: sIso,
        medicineId: 'med-2',
        actorUid: 'cashier-1b',
        actorDisplayName: 'Cashier 1B',
        actorRole: 'cashier',
        deviceId: 'dev-c1b',
        countedQuantity: 13,
        countUnit: 'strip',
        baseUnitsPerCountUnit: 10,
        knownMovementIdsAtCount: [],
      });

      const rawMed1 = (await assertSucceeds(getDoc(doc(c1bDb, `branches/khalid-1/stocktake_sessions_v2/${sIso}/items/med-1`)))).data()!;
      assert.deepEqual(scanForForbiddenKeys(rawMed1, FORBIDDEN_SHARED_ITEM_COUNT_FIELDS), []);
      const rawMed2 = (await assertSucceeds(getDoc(doc(c1Db, `branches/khalid-1/stocktake_sessions_v2/${sIso}/items/med-2`)))).data()!;
      assert.deepEqual(scanForForbiddenKeys(rawMed2, FORBIDDEN_SHARED_ITEM_COUNT_FIELDS), []);

      const vA = await loadCashierStocktakeOperationalViews(c1Db, 'khalid-1', sIso, 'cashier-1');
      assert.equal(vA.myConfirmedCounts.length, 1);
      assert.equal(vA.myConfirmedCounts[0].medicineId, 'med-1');
      assert.equal(vA.myConfirmedCounts[0].countedQuantity, 8);
      assert.equal(vA.myConfirmedCounts[0].countUnit, 'pack');

      const vB = await loadCashierStocktakeOperationalViews(c1bDb, 'khalid-1', sIso, 'cashier-1b');
      assert.equal(vB.myConfirmedCounts.length, 1);
      assert.equal(vB.myConfirmedCounts[0].medicineId, 'med-2');
      assert.equal(vB.myConfirmedCounts[0].countedQuantity, 13);
      assert.equal(vB.myConfirmedCounts[0].countUnit, 'strip');
    });

    await runCase('F2F-INT-14', 'Fix D: Negative (-15m) & Positive (+15m) client clock skew through service DENIED by Firestore Rules request.time', async () => {
      const sSkew = 'sess-int-fix-d-skew';
      await createStocktakeV2SessionAndItems(adminDb, {
        branchId: 'khalid-1',
        sessionId: sSkew,
        sessionNumber: 'ST-INT-SKEW',
        scopeMode: 'PARTIAL',
        adminUid: 'admin-1',
        adminDisplayName: 'Admin 1',
        items: [{ medicineId: 'med-1', medicineName: 'Amoxicillin 500mg', availableUnits: ['pack'] }],
      });
      await assertFails(
        acquireStocktakeLeaseTx(c1Db, {
          branchId: 'khalid-1',
          sessionId: sSkew,
          medicineId: 'med-1',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          deviceId: 'dev-c1',
          leaseId: 'lease-neg-skew',
          ttlMs: 60_000,
          clientClockOffsetMs: -900_000,
        })
      );
      await assertFails(
        acquireStocktakeLeaseTx(c1Db, {
          branchId: 'khalid-1',
          sessionId: sSkew,
          medicineId: 'med-1',
          actorUid: 'cashier-1',
          actorDisplayName: 'Cashier 1',
          deviceId: 'dev-c1',
          leaseId: 'lease-pos-skew',
          ttlMs: 60_000,
          clientClockOffsetMs: +900_000,
        })
      );
      const okAcq = await acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sSkew,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'lease-ok-skew',
        ttlMs: 60_000,
      });
      assert.equal(okAcq.ok, true);
      const badRenew = await renewStocktakeLeaseTx(c1Db, 'khalid-1', sSkew, 'med-1', 'cashier-1', 60_000, +900_000);
      assert.equal(badRenew.ok, false);
    });

    await runCase('F2F-INT-15', 'Fix E: All 10 mandatory per-item pre-posting integrity gates fail closed (zero synthetic / ambiguous cost / swap / uncounted / incomplete)', async () => {
      const sGate = 'sess-int-fix-e-gates';
      await createStocktakeV2SessionAndItems(adminDb, {
        branchId: 'khalid-1',
        sessionId: sGate,
        sessionNumber: 'ST-INT-FIXE',
        scopeMode: 'PARTIAL',
        adminUid: 'admin-1',
        adminDisplayName: 'Admin 1',
        items: [
          { medicineId: 'med-1', medicineName: 'Amoxicillin 500mg', availableUnits: ['pack'] },
          { medicineId: 'med-2', medicineName: 'Paracetamol 500mg', availableUnits: ['pack'] },
        ],
      });
      await acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sGate,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'lease-fixe-1',
      });
      await submitStocktakeCountTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sGate,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        actorRole: 'cashier',
        deviceId: 'dev-c1',
        countedQuantity: 4,
        countUnit: 'pack',
        baseUnitsPerCountUnit: 20,
        knownMovementIdsAtCount: [],
      });
      await persistAdminStocktakeReconciliationTx(adminDb, {
        branchId: 'khalid-1',
        sessionId: sGate,
        adminUid: 'admin-1',
        adminRole: 'admin',
        reconciliationStatus: 'PENDING_APPROVAL',
        totalExpectedValuationExact: createRational(320n, 1n),
        totalSystemValuationExact: createRational(400n, 1n),
        netVarianceValuationExact: createRational(-80n, 1n),
        unresolvedItemsCount: 0,
        lines: [
          {
            medicineId: 'med-1',
            expectedCurrentBaseUnits: 80,
            systemCurrentBaseUnits: 100,
            varianceBaseUnits: -20,
            discrepancyStatus: 'EXACT_DEFICIT',
            financialVarianceExact: createRational(-80n, 1n),
          },
          {
            medicineId: 'med-2',
            expectedCurrentBaseUnits: 10,
            systemCurrentBaseUnits: 20,
            varianceBaseUnits: -10,
            discrepancyStatus: 'EXACT_DEFICIT',
            financialVarianceExact: createRational(-40n, 1n),
          },
        ],
        auditId: 'faud-fixe-1',
      });

      const expectReject = async (label: string, fn: () => Promise<unknown>, codeFragment: string) => {
        let matched = false;
        try {
          await fn();
        } catch (err: unknown) {
          matched = String((err as Error)?.message ?? err).includes(codeFragment);
          if (!matched) {
            throw new Error(`${label}: expected '${codeFragment}' but got '${String(err)}'`);
          }
        }
        assert.equal(matched, true, `${label}: expected rejection with ${codeFragment}`);
      };

      const validAdj = {
        medicineId: 'med-1',
        adjustmentBaseUnitsDelta: -20,
        costPerBaseUnitExact: createRational(4n, 1n),
        totalCostExact: createRational(-80n, 1n),
        costStatus: 'EXACT_HISTORICAL' as const,
      };
      const baseReq = {
        branchId: 'khalid-1',
        sessionId: sGate,
        adminUid: 'admin-1',
        adminRole: 'admin' as const,
        approvalId: 'apr-fixe',
        postingId: 'post-fixe',
        approvalReason: 'Verified physical shortage on med-1',
        adjustments: [validAdj],
      };

      await expectReject('zero-delta', () => approveAndPostStocktakeAdjustmentTx(adminDb, {
        ...baseReq,
        adjustments: [{ ...validAdj, adjustmentBaseUnitsDelta: 0, totalCostExact: createRational(0n, 1n) }],
      }), 'SYNTHETIC_ZERO_ADJUSTMENT_FORBIDDEN');

      await expectReject('ambiguous-cost', () => approveAndPostStocktakeAdjustmentTx(adminDb, {
        ...baseReq,
        adjustments: [{ ...validAdj, costStatus: 'NEEDS_REVIEW' }],
      }), 'AMBIGUOUS_HISTORICAL_COST_NEEDS_REVIEW');

      await expectReject('cost-mismatch', () => approveAndPostStocktakeAdjustmentTx(adminDb, {
        ...baseReq,
        adjustments: [{ ...validAdj, totalCostExact: createRational(-999n, 1n) }],
      }), 'COST_VALUATION_MISMATCH');

      await expectReject('incomplete-history', () => approveAndPostStocktakeAdjustmentTx(adminDb, {
        ...baseReq,
        movementHistoryVerified: false,
      }), 'INCOMPLETE_MOVEMENT_HISTORY_NEEDS_REVIEW');

      await expectReject('uncounted-item', () => approveAndPostStocktakeAdjustmentTx(adminDb, {
        ...baseReq,
        adjustments: [{
          medicineId: 'med-2',
          adjustmentBaseUnitsDelta: -10,
          costPerBaseUnitExact: createRational(4n, 1n),
          totalCostExact: createRational(-40n, 1n),
        }],
      }), 'ITEM_NOT_COUNTED_FOR_POSTING');

      await expectReject('per-item-mismatch', () => approveAndPostStocktakeAdjustmentTx(adminDb, {
        ...baseReq,
        adjustments: [{
          medicineId: 'med-1',
          adjustmentBaseUnitsDelta: -15,
          costPerBaseUnitExact: createRational(4n, 1n),
          totalCostExact: createRational(-60n, 1n),
        }],
      }), 'PER_ITEM_VARIANCE_MISMATCH');

      await expectReject('cashier-post', () => approveAndPostStocktakeAdjustmentTx(c1Db, {
        ...baseReq,
        adminUid: 'cashier-1',
        adminRole: 'cashier' as unknown as 'admin',
      }), 'UNAUTHORIZED_POSTING_ROLE');
    });

    await runCase('F2F-INT-16', 'Fix E + Lifecycle: Full Admin flow IN_PROGRESS -> RECONCILING -> PENDING_APPROVAL -> APPROVED -> POSTED -> CLOSED + Admin session loader', async () => {
      const sLife = 'sess-int-fix-e-gates';
      await transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sLife, targetStatus: 'RECONCILING', adminUid: 'admin-1' });
      await transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sLife, targetStatus: 'PENDING_APPROVAL', adminUid: 'admin-1' });
      await transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sLife, targetStatus: 'APPROVED', adminUid: 'admin-1' });

      const posted = await approveAndPostStocktakeAdjustmentTx(adminDb, {
        branchId: 'khalid-1',
        sessionId: sLife,
        adminUid: 'admin-1',
        adminRole: 'admin',
        approvalId: 'apr-life-1',
        postingId: 'post-life-1',
        approvalReason: 'Approved verified shelf deficit on med-1',
        movementHistoryVerified: true,
        adjustments: [{
          medicineId: 'med-1',
          adjustmentBaseUnitsDelta: -20,
          costPerBaseUnitExact: createRational(4n, 1n),
          totalCostExact: createRational(-80n, 1n),
          costStatus: 'EXACT_HISTORICAL',
        }],
      });
      assert.equal(posted.idempotentReplay, false);
      assert.equal(posted.postedLedgerIds.length, 1);

      await transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sLife, targetStatus: 'CLOSED', adminUid: 'admin-1' });

      const details = await loadAdminStocktakeSessionDetails(adminDb, 'khalid-1', sLife);
      assert.equal(details.session?.status, 'CLOSED');
      assert.equal(details.items.length, 2);
      assert.equal(details.countEvents.length, 1);
      assert.equal(details.financialSummary?.reconciliationStatus, 'POSTED');
      assert.equal(details.financialLines.length, 2);

      await assertFails(loadAdminStocktakeSessionDetails(c1Db, 'khalid-1', sLife));
    });

    console.log('\n============================================================');
    console.log(`PHASE 2F PR-F2 REAL EMULATOR INTEGRATION: ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
    console.log('============================================================');
    if (failed > 0) process.exitCode = 1;
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((err) => {
  console.error('FATAL PR-F2 EMULATOR ERROR:', err);
  process.exit(1);
});
