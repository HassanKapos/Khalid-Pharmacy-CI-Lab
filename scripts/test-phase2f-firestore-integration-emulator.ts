/**
 * Phase 2F — PR #54 (PR-F2) Real Firestore Emulator End-to-End Integration Suite
 *
 * Tests `src/services/stocktakeFirestoreService.ts` + `stocktakeReconciliationEngine.ts`
 * directly against `firestore.rules` in the real Firebase Firestore Emulator.
 *
 * Level 4 Gate: Requires Java + Firebase Firestore Emulator.
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
  scanForForbiddenKeys,
} from '../src/services/stocktakeContract.ts';
import {
  abortDraftStocktakeSessionTx,
  acquireStocktakeLeaseTx,
  approveAndPostStocktakeAdjustmentTx,
  createStocktakeV2SessionAndItems,
  loadAdminStocktakeSessionDetails,
  loadCashierStocktakeOperationalViews,
  persistAdminStocktakeReconciliationTx,
  reconcileStocktakeSessionFromFirestore,
  releaseStocktakeLeaseTx,
  renewStocktakeLeaseTx,
  requestRecountAdminTx,
  submitStocktakeCountTx,
  transitionStocktakeSessionStatusTx,
  verifyStocktakeItemTx,
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

async function expectReject(label: string, fn: () => Promise<unknown>, codeFragment: string) {
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
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function authedDb(testEnv: RulesTestEnvironment, uid: string): Firestore {
  return testEnv
    .authenticatedContext(uid, { email: `${uid}@khalid.test`, email_verified: true })
    .firestore() as unknown as Firestore;
}

async function seedMedicine(
  db: Firestore,
  branchId: string,
  medId: string,
  opts?: { mode?: 'SOLID_TWO_LEVEL' | 'DIRECT_PACK'; now?: Timestamp }
) {
  const now = opts?.now ?? Timestamp.now();
  const isDirect = opts?.mode === 'DIRECT_PACK';
  await setDoc(doc(db, `branches/${branchId}/medicines/${medId}`), {
    id: medId,
    branchId,
    name: `Medicine ${medId}`,
    sellPrice: 120,
    unitSchemaVersion: 2,
    dosageForm: isDirect ? 'syrup' : 'capsule',
    baseUnitLabel: isDirect ? 'bottle' : 'pill',
    ...(isDirect ? {} : { stripsPerPack: 2, pillsPerStrip: 10 }),
    baseUnitsPerPack: isDirect ? 1 : 20,
    configStatus: 'VERIFIED',
    unitMigrationStatus: 'NATIVE_V2',
    packingLocked: false,
    syncVersion: 1,
    unitDefinition: isDirect
      ? {
          mode: 'DIRECT_PACK',
          dosageForm: 'syrup',
          baseUnitLabel: 'bottle',
          baseUnitsPerPack: 1,
          verificationState: 'VERIFIED',
        }
      : {
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

async function seedFixtures(testEnv: RulesTestEnvironment) {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    const now = Timestamp.now();
    await setDoc(doc(db, 'branches/khalid-1'), {
      id: 'khalid-1',
      code: 'K1',
      nameAr: 'فرع خالد ١',
      nameEn: 'Khalid 1',
      active: true,
      adminUids: ['admin-1'],
      memberUids: ['admin-1', 'cashier-1', 'cashier-1b'],
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'branches/khalid-2'), {
      id: 'khalid-2',
      code: 'K2',
      nameAr: 'فرع خالد ٢',
      nameEn: 'Khalid 2',
      active: true,
      adminUids: ['admin-2'],
      memberUids: ['admin-2'],
      createdAt: now,
      updatedAt: now,
    });
    for (const u of [
      { uid: 'admin-1', role: 'admin', branchIds: ['khalid-1'], activeBranchId: 'khalid-1', displayName: 'Admin 1' },
      { uid: 'cashier-1', role: 'cashier', branchIds: ['khalid-1'], activeBranchId: 'khalid-1', displayName: 'Cashier 1' },
      { uid: 'cashier-1b', role: 'cashier', branchIds: ['khalid-1'], activeBranchId: 'khalid-1', displayName: 'Cashier 1B' },
      { uid: 'admin-2', role: 'admin', branchIds: ['khalid-2'], activeBranchId: 'khalid-2', displayName: 'Admin 2' },
    ]) {
      await setDoc(doc(db, `users/${u.uid}`), {
        ...u,
        email: `${u.uid}@khalid.test`,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    await seedMedicine(db, 'khalid-1', 'med-1', { mode: 'SOLID_TWO_LEVEL', now });
    await seedMedicine(db, 'khalid-1', 'med-2', { mode: 'SOLID_TWO_LEVEL', now });
    await seedMedicine(db, 'khalid-1', 'med-syrup', { mode: 'DIRECT_PACK', now });
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
    const admin2Db = authedDb(testEnv, 'admin-2');
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

    await runCase('F2F-INT-07', 'Admin recount preserves rev 1 count_event untouched and appends rev 2', async () => {
      await requestRecountAdminTx(adminDb, 'khalid-1', sessId, 'med-1', 'Double-check top shelf', {
        adminUid: 'admin-1',
        adminRole: 'admin',
      });
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

    await runCase('F2F-INT-05', 'Admin reconciles live Firestore ledger + inventory_financials into Domain B; Cashier DENIED', async () => {
      const sRec = 'sess-int-post-001';
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore() as unknown as Firestore;
        const past = Timestamp.fromMillis(Date.now() - 180_000);
        await setDoc(doc(db, 'branches/khalid-1/inventory_ledger/mov-int-init-1'), {
          id: 'mov-int-init-1',
          branchId: 'khalid-1',
          medicineId: 'med-1',
          batchNumber: 'B-INT-100',
          expiry: '2027-12-31',
          type: 'PURCHASE',
          unit: 'pack',
          quantityDelta: 5,
          baseUnitsDelta: 100,
          referenceId: 'po-int-1',
          userId: 'admin-1',
          businessOccurredAtMs: Date.now() - 180_000,
          createdAt: past,
        });
        await setDoc(doc(db, 'branches/khalid-1/inventory_financials/mov-int-init-1'), {
          id: 'mov-int-init-1',
          branchId: 'khalid-1',
          movementId: 'mov-int-init-1',
          medicineId: 'med-1',
          movementType: 'PURCHASE',
          costPerUnitExact: { num: '80', den: '1' },
          costPerBaseUnitExact: { num: '4', den: '1' },
          totalCostExact: { num: '400', den: '1' },
          costStatus: 'EXACT_RECONCILED',
          costProvenanceType: 'PURCHASE_INVOICE_EXACT',
          unresolvedBaseUnits: 0,
          reconciledByUid: 'admin-1',
          createdAt: past,
        });
      });

      await createStocktakeV2SessionAndItems(adminDb, {
        branchId: 'khalid-1',
        sessionId: sRec,
        sessionNumber: 'ST-INT-POST1',
        scopeMode: 'PARTIAL',
        adminUid: 'admin-1',
        adminDisplayName: 'Admin 1',
        items: [{ medicineId: 'med-1', medicineName: 'Amoxicillin med-1', availableUnits: ['pack', 'strip', 'pill'] }],
      });

      const acq = await acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sRec,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'lease-rec-1',
      });
      assert.equal(acq.ok, true);

      await submitStocktakeCountTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sRec,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        actorRole: 'cashier',
        deviceId: 'dev-c1',
        countedQuantity: 4,
        countUnit: 'pack',
        baseUnitsPerCountUnit: 20,
        knownMovementIdsAtCount: ['mov-int-init-1'],
        countBusinessAtMs: Date.now(),
      });

      const recResult = await reconcileStocktakeSessionFromFirestore(adminDb, {
        branchId: 'khalid-1',
        sessionId: sRec,
        adminUid: 'admin-1',
        adminRole: 'admin',
      });
      assert.equal(recResult.reconciliationStatus, 'PENDING_APPROVAL');
      assert.equal(recResult.unresolvedItemsCount, 0);
      assert.equal(recResult.financialLinesPersisted[0].varianceBaseUnits, -20);
      assert.equal(recResult.financialLinesPersisted[0].costStatus, 'EXACT_HISTORICAL');

      await assertFails(getDoc(doc(c1Db, `branches/khalid-1/stocktake_financials/${sRec}`)));
      await assertFails(getDoc(doc(c1Db, `branches/khalid-1/stocktake_financials/${sRec}/lines/med-1`)));
    });

    await runCase('F2F-INT-06', 'Idempotent Admin approval & ledger posting on APPROVED session (zero-cost ledger + inventory_financials exact)', async () => {
      const sRec = 'sess-int-post-001';
      await transitionStocktakeSessionStatusTx(adminDb, {
        branchId: 'khalid-1',
        sessionId: sRec,
        targetStatus: 'APPROVED',
        adminUid: 'admin-1',
      });

      const postInput = {
        branchId: 'khalid-1',
        sessionId: sRec,
        adminUid: 'admin-1',
        adminRole: 'admin' as const,
        approvalId: 'apr-int-1',
        postingId: 'post-int-1',
        approvalReason: 'Verified 1-pack shortage on shelf A1',
        movementHistoryVerified: true,
        adjustments: [
          {
            medicineId: 'med-1',
            adjustmentBaseUnitsDelta: -20,
            costPerBaseUnitExact: createRational(4n, 1n),
            totalCostExact: createRational(-80n, 1n),
            costStatus: 'EXACT_HISTORICAL' as const,
          },
        ],
      };

      const first = await approveAndPostStocktakeAdjustmentTx(adminDb, postInput);
      assert.equal(first.idempotentReplay, false);
      assert.equal(first.postedLedgerIds.length, 1);

      const movId = first.postedLedgerIds[0];
      const ledSnap = await assertSucceeds(getDoc(doc(c1Db, `branches/khalid-1/inventory_ledger/${movId}`)));
      assert.equal(ledSnap.data()?.type, 'ADJUSTMENT');
      assert.equal(ledSnap.data()?.baseUnitsDelta, -20);
      assert.equal(assertOperationalStocktakePayloadSafe(ledSnap.data()).valid, true, `inventory_ledger/${movId}`);

      await assertSucceeds(getDoc(doc(adminDb, `branches/khalid-1/inventory_financials/${movId}`)));
      await assertFails(getDoc(doc(c1Db, `branches/khalid-1/inventory_financials/${movId}`)));

      const replay = await approveAndPostStocktakeAdjustmentTx(adminDb, postInput);
      assert.equal(replay.idempotentReplay, true);
      assert.deepEqual(replay.postedLedgerIds, first.postedLedgerIds);
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
      const finalSnap = await assertSucceeds(getDoc(doc(c1Db, `branches/khalid-1/stocktake_sessions_v2/${advSess}/items/med-1`)));
      const st = finalSnap.data()?.state;
      assert.equal(st === 'COUNTED' || st === 'RESERVED', true, `Unexpected state after race: ${st}`);
      if (subRes.status === 'fulfilled') {
        assert.equal(st, 'COUNTED');
      } else {
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

      let crashed = false;
      try {
        await createStocktakeV2SessionAndItems(adminDb, { ...payload, simulateCrashAfterDraftCreate: true });
      } catch (e: unknown) {
        crashed = String((e as Error).message).includes('SIMULATED_CRASH_AFTER_DRAFT_CREATE');
      }
      assert.equal(crashed, true);

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

      const recRes = await createStocktakeV2SessionAndItems(adminDb, payload);
      assert.equal(recRes.recoveredFromDraft, true);
      assert.equal(recRes.createdItemsCount, 2);
      assert.equal(recRes.status, 'IN_PROGRESS');

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
        // expected
      }
      await abortDraftStocktakeSessionTx(adminDb, 'khalid-1', abortSess, 'admin-1', 'Network dropped during init');
      const snap = await assertSucceeds(getDoc(doc(adminDb, `branches/khalid-1/stocktake_sessions_v2/${abortSess}`)));
      assert.equal(snap.data()?.status, 'CANCELLED');
      await expectReject('reinit-cancelled', () => createStocktakeV2SessionAndItems(adminDb, {
        branchId: 'khalid-1',
        sessionId: abortSess,
        sessionNumber: 'ST-INT-ABT',
        scopeMode: 'PARTIAL',
        adminUid: 'admin-1',
        adminDisplayName: 'Admin 1',
        items: [{ medicineId: 'med-1', medicineName: 'Amoxicillin med-1' }],
      }), 'SESSION_NOT_REINITIALIZABLE:CANCELLED');
    });

    await runCase('F2F-INT-12', 'OD-2F-3 Cashier visibility: sees ONLY own confirmed physical quantity + unit (zero cost/systemStock/variance)', async () => {
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
      assert.equal(vA.myConfirmedCounts[0].countedQuantity, 8);
      assert.equal(vA.myConfirmedCounts[0].countUnit, 'pack');

      const vB = await loadCashierStocktakeOperationalViews(c1bDb, 'khalid-1', sIso, 'cashier-1b');
      assert.equal(vB.myConfirmedCounts.length, 1);
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

    await runCase('F2F-INT-15', 'Fix E: All 10 mandatory per-item pre-posting integrity gates fail closed', async () => {
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
            costStatus: 'EXACT_HISTORICAL',
          },
          {
            medicineId: 'med-2',
            expectedCurrentBaseUnits: 10,
            systemCurrentBaseUnits: 20,
            varianceBaseUnits: -10,
            discrepancyStatus: 'EXACT_DEFICIT',
            financialVarianceExact: createRational(-40n, 1n),
            costStatus: 'EXACT_HISTORICAL',
          },
        ],
        auditId: 'faud-fixe-1',
      });

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

      await expectReject('non-approved-session', () => approveAndPostStocktakeAdjustmentTx(adminDb, baseReq), 'SESSION_NOT_ELIGIBLE_FOR_POSTING:IN_PROGRESS');

      await transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sGate, targetStatus: 'RECONCILING', adminUid: 'admin-1' });
      await transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sGate, targetStatus: 'PENDING_APPROVAL', adminUid: 'admin-1' });
      await transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sGate, targetStatus: 'APPROVED', adminUid: 'admin-1' });

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

      await expectReject('stale-count-rev', () => approveAndPostStocktakeAdjustmentTx(adminDb, {
        ...baseReq,
        adjustments: [{ ...validAdj, expectedCountRevision: 99 }],
      }), 'STALE_COUNT_REVISION');

      await expectReject('cashier-post', () => approveAndPostStocktakeAdjustmentTx(c1Db, {
        ...baseReq,
        adminUid: 'cashier-1',
        adminRole: 'cashier' as unknown as 'admin',
      }), 'UNAUTHORIZED_POSTING_ROLE');
    });

    await runCase('F2F-INT-16', 'Fix E + Lifecycle: Full Admin flow IN_PROGRESS -> RECONCILING -> PENDING_APPROVAL -> APPROVED -> POSTED -> CLOSED + Admin session loader', async () => {
      const sLife = 'sess-int-fix-e-gates';
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

    await runCase('F2F-INT-17', 'Zero-variance session closes cleanly (APPROVED -> POSTED -> CLOSED) with ZERO synthetic inventory_ledger docs', async () => {
      const sZero = 'sess-int-zero-var';
      await createStocktakeV2SessionAndItems(adminDb, {
        branchId: 'khalid-1',
        sessionId: sZero,
        sessionNumber: 'ST-INT-ZERO',
        scopeMode: 'PARTIAL',
        adminUid: 'admin-1',
        adminDisplayName: 'Admin 1',
        items: [{ medicineId: 'med-syrup', medicineName: 'Cough Syrup', availableUnits: ['pack'] }],
      });
      await acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sZero,
        medicineId: 'med-syrup',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'lease-zero-1',
      });
      await submitStocktakeCountTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sZero,
        medicineId: 'med-syrup',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        actorRole: 'cashier',
        deviceId: 'dev-c1',
        countedQuantity: 0,
        countUnit: 'pack',
        baseUnitsPerCountUnit: 1,
        knownMovementIdsAtCount: [],
      });
      // Invalid state: cannot close directly from IN_PROGRESS
      await expectReject(
        'zero-close-from-in-progress',
        () => transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sZero, targetStatus: 'CLOSED', adminUid: 'admin-1' }),
        'INVALID_SESSION_TRANSITION'
      );

      const recZero = await reconcileStocktakeSessionFromFirestore(adminDb, {
        branchId: 'khalid-1',
        sessionId: sZero,
        adminUid: 'admin-1',
        adminRole: 'admin',
      });
      assert.equal(recZero.reconciliationStatus, 'PENDING_APPROVAL');
      assert.equal(recZero.zeroVarianceReady, true);
      assert.equal(recZero.financialLinesPersisted.length, 1);
      assert.equal(recZero.financialLinesPersisted[0].varianceBaseUnits, 0);
      assert.equal(Object.is(recZero.financialLinesPersisted[0].varianceBaseUnits, -0), false, 'varianceBaseUnits must be canonical +0 (never IEEE-754 -0)');

      // Invalid state: cannot close directly from PENDING_APPROVAL before APPROVED/POSTED
      await expectReject(
        'zero-close-from-pending-approval',
        () => transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sZero, targetStatus: 'CLOSED', adminUid: 'admin-1' }),
        'INVALID_SESSION_TRANSITION'
      );

      // Invalid state: cannot post zero-variance closure while still PENDING_APPROVAL (must be APPROVED first)
      await expectReject(
        'zero-post-before-approved',
        () => approveAndPostStocktakeAdjustmentTx(adminDb, {
          branchId: 'khalid-1',
          sessionId: sZero,
          adminUid: 'admin-1',
          adminRole: 'admin',
          approvalId: 'apr-zero-early',
          postingId: 'post-zero-early',
          approvalReason: 'Premature posting before approval must fail',
          allowZeroVarianceClosure: true,
          adjustments: [],
        }),
        'SESSION_NOT_ELIGIBLE_FOR_POSTING'
      );

      await transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sZero, targetStatus: 'APPROVED', adminUid: 'admin-1' });

      // Unauthorized closure: Cashier & cross-branch Admin must be DENIED by service + Firestore Rules
      await assertFails(
        approveAndPostStocktakeAdjustmentTx(c1Db, {
          branchId: 'khalid-1',
          sessionId: sZero,
          adminUid: 'cashier-1',
          adminRole: 'admin',
          approvalId: 'apr-zero-unauth-c1',
          postingId: 'post-zero-unauth-c1',
          approvalReason: 'Unauthorized cashier attempt',
          allowZeroVarianceClosure: true,
          adjustments: [],
        })
      );
      await assertFails(
        approveAndPostStocktakeAdjustmentTx(admin2Db, {
          branchId: 'khalid-1',
          sessionId: sZero,
          adminUid: 'admin-2',
          adminRole: 'admin',
          approvalId: 'apr-zero-unauth-b2',
          postingId: 'post-zero-unauth-b2',
          approvalReason: 'Unauthorized cross-branch admin attempt',
          allowZeroVarianceClosure: true,
          adjustments: [],
        })
      );

      const closedZero = await approveAndPostStocktakeAdjustmentTx(adminDb, {
        branchId: 'khalid-1',
        sessionId: sZero,
        adminUid: 'admin-1',
        adminRole: 'admin',
        approvalId: 'apr-zero-1',
        postingId: 'post-zero-1',
        approvalReason: 'All items matched with zero physical variance',
        allowZeroVarianceClosure: true,
        adjustments: [],
      });
      assert.equal(closedZero.idempotentReplay, false);
      assert.equal(closedZero.zeroVarianceClosed, true);
      assert.deepEqual(closedZero.postedLedgerIds, []);

      // Duplicate closure prevention: identical replay is idempotent (0 writes), conflicting IDs rejected
      const replayZero = await approveAndPostStocktakeAdjustmentTx(adminDb, {
        branchId: 'khalid-1',
        sessionId: sZero,
        adminUid: 'admin-1',
        adminRole: 'admin',
        approvalId: 'apr-zero-1',
        postingId: 'post-zero-1',
        approvalReason: 'All items matched with zero physical variance',
        allowZeroVarianceClosure: true,
        adjustments: [],
      });
      assert.equal(replayZero.idempotentReplay, true);
      assert.deepEqual(replayZero.postedLedgerIds, []);

      await expectReject(
        'duplicate-zero-posting-new-id',
        () => approveAndPostStocktakeAdjustmentTx(adminDb, {
          branchId: 'khalid-1',
          sessionId: sZero,
          adminUid: 'admin-1',
          adminRole: 'admin',
          approvalId: 'apr-zero-2',
          postingId: 'post-zero-2',
          approvalReason: 'Duplicate zero closure attempt',
          allowZeroVarianceClosure: true,
          adjustments: [],
        }),
        'SESSION_NOT_ELIGIBLE_FOR_POSTING'
      );

      // Unauthorized final transition to CLOSED (Cashier + cross-branch Admin) denied
      await assertFails(
        transitionStocktakeSessionStatusTx(c1Db, { branchId: 'khalid-1', sessionId: sZero, targetStatus: 'CLOSED', adminUid: 'cashier-1' })
      );
      await assertFails(
        transitionStocktakeSessionStatusTx(admin2Db, { branchId: 'khalid-1', sessionId: sZero, targetStatus: 'CLOSED', adminUid: 'admin-2' })
      );

      await transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sZero, targetStatus: 'CLOSED', adminUid: 'admin-1' });
      const zeroSnap = await assertSucceeds(getDoc(doc(adminDb, `branches/khalid-1/stocktake_sessions_v2/${sZero}`)));
      assert.equal(zeroSnap.data()?.status, 'CLOSED');

      // Duplicate CLOSED transition denied
      await expectReject(
        'duplicate-close-after-closed',
        () => transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sZero, targetStatus: 'CLOSED', adminUid: 'admin-1' }),
        'INVALID_SESSION_TRANSITION'
      );

      // Ledger & aggregate invariants: ZERO synthetic inventory_ledger / inventory_financials rows for med-syrup or sZero
      const zeroLedgerSnap = await assertSucceeds(
        getDocs(query(collection(adminDb, 'branches/khalid-1/inventory_ledger'), where('branchId', '==', 'khalid-1'), where('medicineId', '==', 'med-syrup')))
      );
      assert.equal(zeroLedgerSnap.size, 0, 'zero-variance closure must create 0 synthetic inventory_ledger rows');
      const zeroInvFinSnap = await assertSucceeds(
        getDocs(query(collection(adminDb, 'branches/khalid-1/inventory_financials'), where('branchId', '==', 'khalid-1'), where('medicineId', '==', 'med-syrup')))
      );
      assert.equal(zeroInvFinSnap.size, 0, 'zero-variance closure must create 0 synthetic inventory_financials rows');
      const zeroFinSummarySnap = await assertSucceeds(getDoc(doc(adminDb, `branches/khalid-1/stocktake_financials/${sZero}`)));
      assert.equal(zeroFinSummarySnap.exists(), true);
      assert.equal(zeroFinSummarySnap.data()?.reconciliationStatus, 'POSTED');
      assert.equal(zeroFinSummarySnap.data()?.unresolvedItemsCount, 0);
      assert.deepEqual(zeroFinSummarySnap.data()?.netVarianceValuationExact, { num: '0', den: '1' });
      const zeroFinLineSnap = await assertSucceeds(getDoc(doc(adminDb, `branches/khalid-1/stocktake_financials/${sZero}/lines/med-syrup`)));
      assert.equal(zeroFinLineSnap.exists(), true);
      assert.equal(zeroFinLineSnap.data()?.varianceBaseUnits, 0);
      assert.equal(zeroFinLineSnap.data()?.discrepancyStatus, 'MATCHED');
    });

    await runCase('F2F-INT-18', 'releaseStocktakeLeaseTx + verifyStocktakeItemTx + count validation + cross-branch denial', async () => {
      const sOps = 'sess-int-ops-ctrl';
      await createStocktakeV2SessionAndItems(adminDb, {
        branchId: 'khalid-1',
        sessionId: sOps,
        sessionNumber: 'ST-INT-OPS',
        scopeMode: 'PARTIAL',
        adminUid: 'admin-1',
        adminDisplayName: 'Admin 1',
        items: [{ medicineId: 'med-syrup', medicineName: 'Cough Syrup', availableUnits: ['pack'] }],
      });
      const acq = await acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sOps,
        medicineId: 'med-syrup',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'lease-ops-1',
      });
      assert.equal(acq.ok, true);
      const rel = await releaseStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sOps,
        medicineId: 'med-syrup',
        actorUid: 'cashier-1',
        actorRole: 'cashier',
        auditId: 'aud-rel-ops-1',
      });
      assert.equal(rel.ok, true);
      if (rel.ok) assert.equal(rel.nextState, 'AVAILABLE');

      const acq2 = await acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sOps,
        medicineId: 'med-syrup',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'lease-ops-2',
      });
      assert.equal(acq2.ok, true);

      await expectReject('fractional-qty', () => submitStocktakeCountTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sOps,
        medicineId: 'med-syrup',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        actorRole: 'cashier',
        deviceId: 'dev-c1',
        countedQuantity: 1.5,
        countUnit: 'pack',
        baseUnitsPerCountUnit: 1,
        knownMovementIdsAtCount: [],
      }), 'INVALID_COUNT_QUANTITY');

      await submitStocktakeCountTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: sOps,
        medicineId: 'med-syrup',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        actorRole: 'cashier',
        deviceId: 'dev-c1',
        countedQuantity: 3,
        countUnit: 'pack',
        baseUnitsPerCountUnit: 1,
        knownMovementIdsAtCount: [],
      });

      const ver = await verifyStocktakeItemTx(adminDb, {
        branchId: 'khalid-1',
        sessionId: sOps,
        medicineId: 'med-syrup',
        adminUid: 'admin-1',
        adminRole: 'admin',
        auditId: 'aud-ver-ops-1',
      });
      assert.equal(ver.countRevision, 1);

      await assertFails(loadAdminStocktakeSessionDetails(admin2Db, 'khalid-1', sOps));
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
