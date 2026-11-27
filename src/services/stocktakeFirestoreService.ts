/**
 * Phase 2F — PR #54 (PR-F2): Real Firestore & Inventory Ledger Integration Adapter (Spark Zero-Cost)
 *
 * Bridges the pure Phase 2F foundation (`stocktakeContract.ts`, `stocktakeLeaseStateMachine.ts`,
 * `stocktakeReconciliationEngine.ts`, `r32FinancialSplitContract.ts`) to Firestore `runTransaction` calls:
 * - True Firestore `request.time` server-time CAS lease concurrency (never trusts client clock as authority).
 * - Strict Domain A (operational blind) vs Domain B (`stocktake_financials`, `inventory_financials` Admin-only) separation.
 * - Atomic count submission (`count_events` + `items` + `operational_audit`) with exact medicine-master unit verification.
 * - Live Firestore-to-Inventory-Ledger reconciliation (`reconcileStocktakeSessionFromFirestore`) using verified
 *   `inventory_financials` provenance only (zero `buyPrice` fallback).
 * - Idempotent Admin approval & ledger posting (`approvals` + `postings` + `inventory_ledger` + `inventory_financials`)
 *   including safe zero-variance session closure (`POSTED -> CLOSED` without synthetic zero-delta ledger rows).
 * - Zero modifications to protected files (`pharmacyDb.ts`, `outboxFeatureFlags.ts`, `outboxV2Worker.ts`, etc.).
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import {
  addRational,
  createRational,
  isValidRational,
  multiplyRational,
  normalizeRational,
  subtractRational,
  type Rational,
} from './exactFinance.ts';
import {
  assertOperationalStocktakePayloadSafe,
  assertSharedOperationalItemSafe,
  buildCashierOwnConfirmedCountsView,
  buildRemainingMedicinesPublicView,
  buildStocktakeAdjustmentLedgerId,
  buildStocktakeCountEventId,
  buildStocktakeCountIdempotencyKey,
  canTransitionStocktakeSessionState,
  computeMovementWatermarkDigest,
  isValidFirestoreDocId,
  type CashierOwnConfirmedCountView,
  type FinancialStocktakeLine,
  type OperationalCountSubmissionEvent,
  type OperationalStocktakeItem,
  type RemainingMedicinePublicView,
  type StocktakeCountUnit,
  type StocktakeRole,
  type StocktakeSessionLifecycleStatus,
} from './stocktakeContract.ts';
import {
  reconcileMedicineAtCountReference,
  resolveExactBaseUnitsPerUnit,
  type BatchHistoricalCostLayer,
  type CanonicalLedgerMovementType,
  type MedicineUnitConversionSpec,
  type ReconcilableLedgerMovement,
  type ReconcileMedicineOutput,
} from './stocktakeReconciliationEngine.ts';
import { verifyHistoricalCostProvenanceAndEligibility } from './r32FinancialSplitContract.ts';

/** Canonicalizes IEEE-754 -0 to +0 so Firestore Web SDK always encodes integerValue (never doubleValue -0.0). */
function normalizeSafeInt(value: number): number {
  return value === 0 ? 0 : value;
}

function serializeRational(r: Rational | null | undefined): { num: string; den: string } | null {
  if (!r) return null;
  const norm = normalizeRational(r);
  return { num: norm.num, den: norm.den };
}

function parseFirestoreRational(raw: unknown): Rational | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as { num?: unknown; den?: unknown };
  try {
    if (
      (typeof rec.num === 'string' || typeof rec.num === 'number' || typeof rec.num === 'bigint') &&
      (typeof rec.den === 'string' || typeof rec.den === 'number' || typeof rec.den === 'bigint')
    ) {
      return createRational(rec.num, rec.den);
    }
  } catch {
    return null;
  }
  return null;
}

function assertValidId(value: unknown, label: string): string {
  if (!isValidFirestoreDocId(value)) {
    throw new Error(`INVALID_FIRESTORE_DOC_ID:${label}`);
  }
  return value;
}

function requireOperationalPayloadSafe(payload: unknown, label: string): void {
  const res = assertOperationalStocktakePayloadSafe(payload);
  if (!res.valid) {
    throw new Error(
      `FORBIDDEN_OPERATIONAL_PAYLOAD (${label}): ${res.forbiddenFieldsFound.join(', ') || res.errors.join('; ') || 'invalid payload'}`
    );
  }
}

function requireSharedOperationalItemSafe(payload: unknown, label: string): void {
  const res = assertSharedOperationalItemSafe(payload);
  if (!res.valid) {
    throw new Error(
      `SHARED_ITEM_SAFETY_VIOLATION (${label}): ${res.forbiddenFieldsFound.join(', ') || res.errors.join('; ') || 'invalid item payload'}`
    );
  }
}

function isValidUnit(u: unknown): u is StocktakeCountUnit {
  return u === 'pack' || u === 'strip' || u === 'pill';
}

function extractMedicineUnitSpec(
  medicineId: string,
  medData: Record<string, unknown>
): MedicineUnitConversionSpec {
  const unitDef = (medData.unitDefinition ?? null) as Record<string, unknown> | null;
  const configStatus = String(medData.configStatus ?? '');
  const schemaVersion = Number(medData.unitSchemaVersion ?? 0);
  const verificationState = String(unitDef?.verificationState ?? '');
  const unitOperationalAllowed =
    configStatus === 'VERIFIED' &&
    schemaVersion >= 2 &&
    (verificationState === '' || verificationState === 'VERIFIED');

  const rawMode = String(unitDef?.mode ?? '');
  const unitMode: 'DIRECT_PACK' | 'SOLID_TWO_LEVEL' =
    rawMode === 'DIRECT_PACK'
      ? 'DIRECT_PACK'
      : rawMode === 'SOLID_TWO_LEVEL'
        ? 'SOLID_TWO_LEVEL'
        : Number(medData.stripsPerPack ?? 0) > 0 && Number(medData.pillsPerStrip ?? 0) > 0
          ? 'SOLID_TWO_LEVEL'
          : 'DIRECT_PACK';

  const stripsPerPack = Number(unitDef?.stripsPerPack ?? medData.stripsPerPack ?? 1);
  const pillsPerStrip = Number(unitDef?.pillsPerStrip ?? medData.pillsPerStrip ?? 1);
  const baseUnitsPerPack = Number(unitDef?.baseUnitsPerPack ?? medData.baseUnitsPerPack ?? 1);

  return {
    medicineId,
    unitOperationalAllowed,
    unitMode,
    stripsPerPack,
    pillsPerStrip,
    baseUnitsPerPack,
  };
}

function timestampToMs(val: unknown): number {
  if (val && typeof val === 'object' && typeof (val as Timestamp).toMillis === 'function') {
    return (val as Timestamp).toMillis();
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val;
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export const MAX_ATOMIC_SESSION_INIT_ITEMS = 400 as const;
export const MAX_LEASE_TTL_MS = 540_000 as const; // 9 min (< 10 min Firestore Rules ceiling)
export const MAX_CUMULATIVE_LEASE_LIFETIME_MS = 1_800_000 as const; // 30 min (matches Firestore Rules ceiling)
export const MAX_LEASE_RENEWALS = 12 as const;

export interface CreateStocktakeSessionInput {
  branchId: string;
  sessionId: string;
  sessionNumber: string;
  scopeMode: 'FULL' | 'PARTIAL';
  adminUid: string;
  adminDisplayName: string;
  items: Array<{
    medicineId: string;
    medicineName: string;
    strength?: string;
    dosageForm?: string;
    primaryBarcode?: string;
    secondaryBarcodes?: string[];
    availableUnits?: StocktakeCountUnit[];
  }>;
  /** Test-only fault-injection flag simulating crash right after DRAFT creation before items are written. */
  simulateCrashAfterDraftCreate?: boolean;
}

export interface CreateStocktakeSessionResult {
  sessionId: string;
  status: 'IN_PROGRESS';
  createdItemsCount: number;
  totalItemsCount: number;
  idempotentReplay: boolean;
  recoveredFromDraft: boolean;
  atomicSingleBatch: boolean;
}

function buildOperationalItemDraftDoc(
  input: CreateStocktakeSessionInput,
  item: CreateStocktakeSessionInput['items'][number]
): Record<string, unknown> {
  assertValidId(item.medicineId, 'item.medicineId');
  const medName = String(item.medicineName ?? '').trim();
  if (medName.length < 1 || medName.length > 200) {
    throw new Error(`INVALID_ITEM_MEDICINE_NAME:${item.medicineId}`);
  }
  if (item.availableUnits !== undefined) {
    if (
      !Array.isArray(item.availableUnits) ||
      item.availableUnits.length < 1 ||
      item.availableUnits.length > 3 ||
      !item.availableUnits.every(isValidUnit)
    ) {
      throw new Error(`INVALID_ITEM_AVAILABLE_UNITS:${item.medicineId}`);
    }
  }
  if (item.secondaryBarcodes !== undefined) {
    if (!Array.isArray(item.secondaryBarcodes) || item.secondaryBarcodes.length > 20) {
      throw new Error(`INVALID_ITEM_SECONDARY_BARCODES:${item.medicineId}`);
    }
  }

  const itemDoc: Record<string, unknown> = {
    id: item.medicineId,
    sessionId: input.sessionId,
    branchId: input.branchId,
    medicineId: item.medicineId,
    medicineName: medName,
    ...(item.strength ? { strength: item.strength.slice(0, 64) } : {}),
    ...(item.dosageForm ? { dosageForm: item.dosageForm.slice(0, 48) } : {}),
    ...(item.primaryBarcode ? { primaryBarcode: item.primaryBarcode.slice(0, 64) } : {}),
    ...(item.secondaryBarcodes ? { secondaryBarcodes: [...item.secondaryBarcodes] } : {}),
    ...(item.availableUnits ? { availableUnits: [...new Set(item.availableUnits)] } : {}),
    state: 'AVAILABLE',
    syncStatus: 'CONFIRMED',
    activeLease: null,
    leaseVersion: 0,
    countRevision: 0,
    recountReason: null,
    operationalDiscrepancyFlag: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  requireSharedOperationalItemSafe(itemDoc, `createStocktakeV2Item:${item.medicineId}`);
  return itemDoc;
}

/**
 * Atomic & Crash-Recoverable Phase 2F Session Initialization (Blocker C):
 * - Sessions are ALWAYS created in `DRAFT` (never directly `IN_PROGRESS`), so a partially
 *   initialized session can NEVER be leased or counted by Cashiers (enforced in firestore.rules).
 * - For sessions with <= 400 items, the `DRAFT` session + ALL items are committed in a single
 *   all-or-nothing Firestore `writeBatch`, then activated `DRAFT -> IN_PROGRESS`.
 * - For larger sessions (> 400 items) or recovery after a crash mid-initialization, re-invoking
 *   with the same `sessionId` inspects existing items, writes ONLY missing items in deterministic
 *   `writeBatch` chunks, verifies 100% completeness, and then activates `DRAFT -> IN_PROGRESS`.
 * - Re-invoking on an already-`IN_PROGRESS` session returns `{ idempotentReplay: true }` with zero writes.
 */
export async function createStocktakeV2SessionAndItems(
  db: Firestore,
  input: CreateStocktakeSessionInput
): Promise<CreateStocktakeSessionResult> {
  assertValidId(input.branchId, 'branchId');
  assertValidId(input.sessionId, 'sessionId');
  assertValidId(input.adminUid, 'adminUid');
  if (typeof input.sessionNumber !== 'string' || input.sessionNumber.trim().length < 1 || input.sessionNumber.length > 64) {
    throw new Error('INVALID_SESSION_NUMBER');
  }
  if (input.scopeMode !== 'FULL' && input.scopeMode !== 'PARTIAL') {
    throw new Error('INVALID_SCOPE_MODE');
  }
  if (!input.items || input.items.length === 0) {
    throw new Error('EMPTY_STOCKTAKE_SESSION_ITEMS');
  }
  const seenIds = new Set<string>();
  for (const item of input.items) {
    assertValidId(item.medicineId, 'item.medicineId');
    if (seenIds.has(item.medicineId)) {
      throw new Error(`DUPLICATE_MEDICINE_ID_IN_SESSION:${item.medicineId}`);
    }
    seenIds.add(item.medicineId);
  }

  const sessRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId);
  const existingSess = await getDoc(sessRef);

  if (existingSess.exists()) {
    const existingData = existingSess.data() as Record<string, unknown>;
    if (String(existingData.branchId ?? '') !== input.branchId) {
      throw new Error('CROSS_BRANCH_SESSION_MISMATCH');
    }
    const existingStatus = String(existingData.status ?? '');
    if (existingStatus === 'IN_PROGRESS') {
      const existingScope = String(existingData.scopeMode ?? '');
      const existingNum = String(existingData.sessionNumber ?? '');
      const existingTotal = Number(existingData.totalTargetItems ?? -1);
      if (
        existingScope !== input.scopeMode ||
        existingNum !== input.sessionNumber.trim() ||
        existingTotal !== input.items.length
      ) {
        throw new Error(`SESSION_ID_CONFLICT:${input.sessionId}`);
      }
      return {
        sessionId: input.sessionId,
        status: 'IN_PROGRESS',
        createdItemsCount: 0,
        totalItemsCount: input.items.length,
        idempotentReplay: true,
        recoveredFromDraft: false,
        atomicSingleBatch: false,
      };
    }
    if (existingStatus !== 'DRAFT') {
      throw new Error(`SESSION_NOT_REINITIALIZABLE:${existingStatus}`);
    }

    const itemsCol = collection(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId, 'items');
    const existingItemsSnap = await getDocs(
      query(itemsCol, where('branchId', '==', input.branchId), where('sessionId', '==', input.sessionId))
    );
    const presentIds = new Set<string>();
    existingItemsSnap.forEach((d) => presentIds.add(d.id));

    const missingItems = input.items.filter((it) => !presentIds.has(it.medicineId));
    for (let i = 0; i < missingItems.length; i += MAX_ATOMIC_SESSION_INIT_ITEMS) {
      const chunk = missingItems.slice(i, i + MAX_ATOMIC_SESSION_INIT_ITEMS);
      const batch = writeBatch(db);
      for (const item of chunk) {
        const itemRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId, 'items', item.medicineId);
        batch.set(itemRef, buildOperationalItemDraftDoc(input, item));
      }
      await batch.commit();
    }

    const verifySnap = await getDocs(
      query(itemsCol, where('branchId', '==', input.branchId), where('sessionId', '==', input.sessionId))
    );
    const verifiedIds = new Set<string>();
    verifySnap.forEach((d) => verifiedIds.add(d.id));
    const stillMissing = input.items.filter((it) => !verifiedIds.has(it.medicineId));
    if (stillMissing.length > 0 || verifySnap.size < input.items.length) {
      throw new Error(`INCOMPLETE_SESSION_RECOVERY:${verifiedIds.size}/${input.items.length}`);
    }

    await updateDoc(sessRef, {
      status: 'IN_PROGRESS',
      updatedAt: serverTimestamp(),
    });
    return {
      sessionId: input.sessionId,
      status: 'IN_PROGRESS',
      createdItemsCount: missingItems.length,
      totalItemsCount: input.items.length,
      idempotentReplay: false,
      recoveredFromDraft: true,
      atomicSingleBatch: false,
    };
  }

  const sessionDoc = {
    id: input.sessionId,
    branchId: input.branchId,
    sessionNumber: input.sessionNumber.trim(),
    schemaVersion: 2,
    scopeMode: input.scopeMode,
    status: 'DRAFT',
    totalTargetItems: input.items.length,
    confirmedCountedItems: 0,
    remainingItemsCount: input.items.length,
    recountRequestedItemsCount: 0,
    verifiedItemsCount: 0,
    createdByUid: input.adminUid,
    createdByName: (input.adminDisplayName || input.adminUid).slice(0, 120),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  requireOperationalPayloadSafe(sessionDoc, 'createStocktakeV2Session');

  if (input.simulateCrashAfterDraftCreate) {
    await setDoc(sessRef, sessionDoc);
    throw new Error('SIMULATED_CRASH_AFTER_DRAFT_CREATE');
  }

  if (input.items.length <= MAX_ATOMIC_SESSION_INIT_ITEMS) {
    const batch = writeBatch(db);
    batch.set(sessRef, sessionDoc);
    for (const item of input.items) {
      const itemRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId, 'items', item.medicineId);
      batch.set(itemRef, buildOperationalItemDraftDoc(input, item));
    }
    await batch.commit();

    await updateDoc(sessRef, {
      status: 'IN_PROGRESS',
      updatedAt: serverTimestamp(),
    });
    return {
      sessionId: input.sessionId,
      status: 'IN_PROGRESS',
      createdItemsCount: input.items.length,
      totalItemsCount: input.items.length,
      idempotentReplay: false,
      recoveredFromDraft: false,
      atomicSingleBatch: true,
    };
  }

  await setDoc(sessRef, sessionDoc);
  for (let i = 0; i < input.items.length; i += MAX_ATOMIC_SESSION_INIT_ITEMS) {
    const chunk = input.items.slice(i, i + MAX_ATOMIC_SESSION_INIT_ITEMS);
    const batch = writeBatch(db);
    for (const item of chunk) {
      const itemRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId, 'items', item.medicineId);
      batch.set(itemRef, buildOperationalItemDraftDoc(input, item));
    }
    await batch.commit();
  }

  await updateDoc(sessRef, {
    status: 'IN_PROGRESS',
    updatedAt: serverTimestamp(),
  });
  return {
    sessionId: input.sessionId,
    status: 'IN_PROGRESS',
    createdItemsCount: input.items.length,
    totalItemsCount: input.items.length,
    idempotentReplay: false,
    recoveredFromDraft: false,
    atomicSingleBatch: false,
  };
}

/**
 * Safe cleanup for an abandoned partial DRAFT session: transitions DRAFT -> CANCELLED
 * with mandatory audit reason (5..500 chars) & cancelledByUid so it can never become usable.
 */
export async function abortDraftStocktakeSessionTx(
  db: Firestore,
  branchId: string,
  sessionId: string,
  adminUid: string,
  reason: string
): Promise<void> {
  assertValidId(branchId, 'branchId');
  assertValidId(sessionId, 'sessionId');
  assertValidId(adminUid, 'adminUid');
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed.length < 5 || trimmed.length > 500) {
    throw new Error('CANCELLATION_REASON_REQUIRED');
  }
  const sessRef = doc(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(sessRef);
    if (!snap.exists()) throw new Error('SESSION_NOT_FOUND');
    const data = snap.data() as Record<string, unknown>;
    if (String(data.branchId ?? '') !== branchId) {
      throw new Error('CROSS_BRANCH_SESSION_MISMATCH');
    }
    const st = String(data.status ?? '');
    if (st !== 'DRAFT') {
      throw new Error(`CANNOT_ABORT_NON_DRAFT_SESSION:${st}`);
    }
    const patch = {
      status: 'CANCELLED',
      cancelledByUid: adminUid,
      cancellationReason: trimmed,
      updatedAt: serverTimestamp(),
    };
    requireOperationalPayloadSafe(patch, 'abortDraftStocktakeSessionTx');
    tx.update(sessRef, patch);
  });
}

export interface AcquireLeaseTxInput {
  branchId: string;
  sessionId: string;
  medicineId: string;
  actorUid: string;
  actorDisplayName: string;
  deviceId: string;
  leaseId: string;
  ttlMs?: number;
  expectedLeaseVersion?: number;
  /**
   * Optional simulated or measured client clock offset (ms) for skew testing / drift compensation.
   * SECURITY NOTE (Fix D): Client clock values are NEVER trusted as authority; Firestore Security
   * Rules `request.time` is the sole non-spoofable authority enforcing `createdAt == request.time`,
   * `expiresAt > request.time`, and `expiresAt <= request.time + 10m`.
   */
  clientClockOffsetMs?: number;
}

/**
 * OD-4 / Fix A: Strictly generic error codes — NEVER leaks holderUid, counter identity,
 * count quantities, or count event IDs in conflict or error responses.
 */
export type AcquireLeaseTxResult =
  | { ok: true; leaseVersion: number; leaseId: string; idempotentReplay?: boolean }
  | {
      ok: false;
      code:
        | 'ITEM_NOT_FOUND'
        | 'ALREADY_COUNTED'
        | 'LEASE_CONFLICT_ACTIVE'
        | 'SESSION_NOT_IN_PROGRESS'
        | 'LEASE_VERSION_MISMATCH';
    };

export async function acquireStocktakeLeaseTx(
  db: Firestore,
  input: AcquireLeaseTxInput
): Promise<AcquireLeaseTxResult> {
  assertValidId(input.branchId, 'branchId');
  assertValidId(input.sessionId, 'sessionId');
  assertValidId(input.medicineId, 'medicineId');
  assertValidId(input.actorUid, 'actorUid');
  assertValidId(input.leaseId, 'leaseId');
  if (!input.deviceId || input.deviceId.trim().length < 1 || input.deviceId.length > 128) {
    throw new Error('INVALID_DEVICE_ID');
  }
  const ttlMs = input.ttlMs ?? 90_000;
  if (!Number.isFinite(ttlMs) || ttlMs < 500 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new Error(`INVALID_LEASE_TTL_MS:${ttlMs}`);
  }
  const sessRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId);
  const itemRef = doc(
    db,
    'branches',
    input.branchId,
    'stocktake_sessions_v2',
    input.sessionId,
    'items',
    input.medicineId
  );

  try {
    return await runTransaction(db, async (tx) => {
      const [sessSnap, snap] = await Promise.all([tx.get(sessRef), tx.get(itemRef)]);
      if (!sessSnap.exists() || String(sessSnap.data().status ?? '') !== 'IN_PROGRESS') {
        return { ok: false, code: 'SESSION_NOT_IN_PROGRESS' };
      }
      if (!snap.exists()) {
        return { ok: false, code: 'ITEM_NOT_FOUND' };
      }
      const data = snap.data() as Record<string, unknown>;
      if (String(data.branchId ?? '') !== input.branchId || String(data.sessionId ?? '') !== input.sessionId) {
        return { ok: false, code: 'ITEM_NOT_FOUND' };
      }
      if (String(data.syncStatus ?? 'CONFIRMED') !== 'CONFIRMED') {
        return { ok: false, code: 'LEASE_CONFLICT_ACTIVE' };
      }
      const state = String(data.state ?? '');
      if (state === 'COUNTED' || state === 'VERIFIED') {
        return { ok: false, code: 'ALREADY_COUNTED' };
      }
      const currentLeaseVer = Number(data.leaseVersion ?? 0);
      const prevLease = (data.activeLease ?? null) as
        | { leaseId?: string; ownerUid: string; deviceId?: string; expiresAt: Timestamp }
        | null;
      const proposedClientNowMs = Date.now() + (input.clientClockOffsetMs ?? 0);
      const serverDocFloorMs = timestampToMs(data.updatedAt);
      const effectiveNowMs =
        input.clientClockOffsetMs !== undefined
          ? proposedClientNowMs
          : Math.max(proposedClientNowMs, serverDocFloorMs);

      if (
        state === 'RESERVED' &&
        prevLease &&
        prevLease.expiresAt &&
        effectiveNowMs <= prevLease.expiresAt.toMillis()
      ) {
        // Idempotent network-retry replay by same owner + device + leaseId while active (without spoofed skew)
        if (
          input.clientClockOffsetMs === undefined &&
          prevLease.leaseId === input.leaseId &&
          prevLease.ownerUid === input.actorUid &&
          prevLease.deviceId === input.deviceId &&
          (input.expectedLeaseVersion === undefined ||
            input.expectedLeaseVersion === currentLeaseVer ||
            input.expectedLeaseVersion === currentLeaseVer - 1)
        ) {
          return { ok: true, leaseVersion: currentLeaseVer, leaseId: input.leaseId, idempotentReplay: true };
        }
        return {
          ok: false,
          code: 'LEASE_CONFLICT_ACTIVE',
        };
      }

      if (input.expectedLeaseVersion !== undefined && currentLeaseVer !== input.expectedLeaseVersion) {
        return { ok: false, code: 'LEASE_VERSION_MISMATCH' };
      }

      const nextVersion = currentLeaseVer + 1;
      const patch = {
        state: 'RESERVED',
        leaseVersion: nextVersion,
        activeLease: {
          leaseId: input.leaseId,
          ownerUid: input.actorUid,
          ownerDisplayName: (input.actorDisplayName || input.actorUid).slice(0, 120),
          deviceId: input.deviceId,
          leaseVersion: nextVersion,
          renewalCount: 0,
          createdAt: serverTimestamp(),
          expiresAt: Timestamp.fromMillis(effectiveNowMs + ttlMs),
        },
        updatedAt: serverTimestamp(),
      };
      requireSharedOperationalItemSafe(patch, 'acquireStocktakeLeaseTx');
      tx.update(itemRef, patch);
      return { ok: true, leaseVersion: nextVersion, leaseId: input.leaseId, idempotentReplay: false };
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? '';
    if (code === 'permission-denied' || code === 'aborted' || code === 'failed-precondition') {
      const latestSnap = await getDoc(itemRef);
      if (latestSnap.exists()) {
        const latest = latestSnap.data() as Record<string, unknown>;
        const latestState = String(latest.state ?? '');
        if (latestState === 'COUNTED' || latestState === 'VERIFIED') {
          return { ok: false, code: 'ALREADY_COUNTED' };
        }
        const activeLease = (latest.activeLease ?? null) as { ownerUid?: string } | null;
        if (latestState === 'RESERVED' && activeLease?.ownerUid && activeLease.ownerUid !== input.actorUid) {
          return {
            ok: false,
            code: 'LEASE_CONFLICT_ACTIVE',
          };
        }
      }
    }
    throw err;
  }
}

export async function renewStocktakeLeaseTx(
  db: Firestore,
  branchId: string,
  sessionId: string,
  medicineId: string,
  actorUid: string,
  ttlMs = 120_000,
  clientClockOffsetMs?: number,
  options?: { leaseId?: string; expectedLeaseVersion?: number }
): Promise<{ ok: true; renewalCount: number } | { ok: false; code: string }> {
  assertValidId(branchId, 'branchId');
  assertValidId(sessionId, 'sessionId');
  assertValidId(medicineId, 'medicineId');
  assertValidId(actorUid, 'actorUid');
  if (!Number.isFinite(ttlMs) || ttlMs < 500 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new Error(`INVALID_LEASE_TTL_MS:${ttlMs}`);
  }
  const sessRef = doc(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId);
  const itemRef = doc(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId, 'items', medicineId);
  try {
    return await runTransaction(db, async (tx) => {
      const [sessSnap, snap] = await Promise.all([tx.get(sessRef), tx.get(itemRef)]);
      if (!sessSnap.exists() || String(sessSnap.data().status ?? '') !== 'IN_PROGRESS') {
        return { ok: false, code: 'SESSION_NOT_IN_PROGRESS' };
      }
      if (!snap.exists()) return { ok: false, code: 'ITEM_NOT_FOUND' };
      const data = snap.data() as Record<string, unknown>;
      if (String(data.syncStatus ?? 'CONFIRMED') !== 'CONFIRMED') {
        return { ok: false, code: 'OFFLINE_ITEM_CANNOT_RENEW' };
      }
      const lease = data.activeLease as
        | {
            leaseId: string;
            ownerUid: string;
            createdAt: Timestamp;
            expiresAt: Timestamp;
            renewalCount: number;
            leaseVersion?: number;
            [k: string]: unknown;
          }
        | null;
      if (data.state !== 'RESERVED' || !lease || lease.ownerUid !== actorUid) {
        return { ok: false, code: 'NOT_LEASE_OWNER' };
      }
      if (options?.leaseId && lease.leaseId !== options.leaseId) {
        return { ok: false, code: 'LEASE_ID_MISMATCH' };
      }
      if (options?.expectedLeaseVersion !== undefined && Number(data.leaseVersion ?? 0) !== options.expectedLeaseVersion) {
        return { ok: false, code: 'LEASE_VERSION_MISMATCH' };
      }
      const nextRenewal = Number(lease.renewalCount ?? 0) + 1;
      if (nextRenewal > MAX_LEASE_RENEWALS) {
        return { ok: false, code: 'LEASE_RENEWAL_LIMIT_REACHED' };
      }
      const createdAtMs = timestampToMs(lease.createdAt) || Date.now();
      const maxAllowedExpiresMs = createdAtMs + MAX_CUMULATIVE_LEASE_LIFETIME_MS;
      const proposedClientNowMs = Date.now() + (clientClockOffsetMs ?? 0);
      const serverAnchorFloorMs =
        clientClockOffsetMs !== undefined
          ? proposedClientNowMs
          : Math.max(proposedClientNowMs, timestampToMs(data.updatedAt));
      if (clientClockOffsetMs === undefined && serverAnchorFloorMs > lease.expiresAt.toMillis()) {
        return { ok: false, code: 'LEASE_EXPIRED' };
      }
      const proposedExpiresMs =
        clientClockOffsetMs !== undefined
          ? serverAnchorFloorMs + ttlMs
          : Math.min(serverAnchorFloorMs + ttlMs, maxAllowedExpiresMs);
      if (proposedExpiresMs <= serverAnchorFloorMs) {
        return { ok: false, code: 'LEASE_LIFETIME_CAP_REACHED' };
      }
      const patch = {
        activeLease: {
          ...lease,
          renewalCount: nextRenewal,
          expiresAt: Timestamp.fromMillis(proposedExpiresMs),
        },
        updatedAt: serverTimestamp(),
      };
      requireSharedOperationalItemSafe(patch, 'renewStocktakeLeaseTx');
      tx.update(itemRef, patch);
      return { ok: true, renewalCount: nextRenewal };
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? '';
    if (code === 'permission-denied' || code === 'aborted' || code === 'failed-precondition') {
      return { ok: false, code: 'LEASE_EXPIRED_OR_CONFLICT' };
    }
    throw err;
  }
}

export interface ReleaseLeaseTxInput {
  branchId: string;
  sessionId: string;
  medicineId: string;
  actorUid: string;
  actorRole: StocktakeRole;
  deviceId?: string;
  expectedLeaseVersion?: number;
  auditId?: string;
}

/**
 * Releases an active/expired lease cleanly (`AVAILABLE` when countRevision === 0,
 * `NEEDS_RECOUNT` when countRevision >= 1) aligned strictly with `canReleaseStocktakeV2Lease`
 * in `firestore.rules`. NEVER overwrites a saved `COUNTED` or `VERIFIED` item.
 */
export async function releaseStocktakeLeaseTx(
  db: Firestore,
  input: ReleaseLeaseTxInput
): Promise<{ ok: true; nextState: 'AVAILABLE' | 'NEEDS_RECOUNT'; leaseVersion: number; idempotentReplay: boolean } | { ok: false; code: string }> {
  assertValidId(input.branchId, 'branchId');
  assertValidId(input.sessionId, 'sessionId');
  assertValidId(input.medicineId, 'medicineId');
  assertValidId(input.actorUid, 'actorUid');
  if (input.auditId !== undefined) assertValidId(input.auditId, 'auditId');

  const sessRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId);
  const itemRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId, 'items', input.medicineId);

  return runTransaction(db, async (tx) => {
    const [sessSnap, itemSnap] = await Promise.all([tx.get(sessRef), tx.get(itemRef)]);
    if (!sessSnap.exists() || String(sessSnap.data().status ?? '') !== 'IN_PROGRESS') {
      return { ok: false, code: 'SESSION_NOT_IN_PROGRESS' };
    }
    if (!itemSnap.exists()) {
      return { ok: false, code: 'ITEM_NOT_FOUND' };
    }
    const item = itemSnap.data() as Record<string, unknown>;
    const state = String(item.state ?? '');
    if (state === 'COUNTED' || state === 'VERIFIED') {
      return { ok: false, code: 'COUNT_ALREADY_CONFIRMED_PROTECTED' };
    }
    const currentLeaseVer = Number(item.leaseVersion ?? 0);
    const countRev = Number(item.countRevision ?? 0);
    const lease = (item.activeLease ?? null) as { ownerUid?: string; expiresAt?: Timestamp } | null;

    if (state !== 'RESERVED' || !lease) {
      const returnState = countRev >= 1 ? 'NEEDS_RECOUNT' : 'AVAILABLE';
      return { ok: true, nextState: returnState, leaseVersion: currentLeaseVer, idempotentReplay: true };
    }

    if (input.expectedLeaseVersion !== undefined && currentLeaseVer !== input.expectedLeaseVersion) {
      return { ok: false, code: 'LEASE_VERSION_MISMATCH' };
    }

    const nowFloorMs = Math.max(Date.now(), timestampToMs(item.updatedAt));
    const isOwner = lease.ownerUid === input.actorUid;
    const isExpired = lease.expiresAt ? nowFloorMs > lease.expiresAt.toMillis() : false;
    const isAdmin = input.actorRole === 'admin' || input.actorRole === 'super_admin';
    if (!isOwner && !isExpired && !isAdmin) {
      return { ok: false, code: 'LEASE_OWNED_BY_OTHER' };
    }

    const nextState: 'AVAILABLE' | 'NEEDS_RECOUNT' = countRev >= 1 ? 'NEEDS_RECOUNT' : 'AVAILABLE';
    const nextVersion = currentLeaseVer + 1;
    const patch = {
      state: nextState,
      activeLease: null,
      leaseVersion: nextVersion,
      updatedAt: serverTimestamp(),
    };
    requireSharedOperationalItemSafe(patch, 'releaseStocktakeLeaseTx');
    tx.update(itemRef, patch);

    if (input.auditId) {
      const auditRef = doc(
        db,
        'branches',
        input.branchId,
        'stocktake_sessions_v2',
        input.sessionId,
        'operational_audit',
        input.auditId
      );
      const auditPayload = {
        id: input.auditId,
        branchId: input.branchId,
        sessionId: input.sessionId,
        medicineId: input.medicineId,
        action: 'LEASE_RELEASED',
        actorUid: input.actorUid,
        actorRole: input.actorRole,
        deviceId: (input.deviceId || 'admin-release').slice(0, 128),
        summary: `Released stocktake lease to ${nextState} (leaseVersion=${nextVersion})`,
        createdAt: serverTimestamp(),
      };
      requireOperationalPayloadSafe(auditPayload, `operational_audit/${input.auditId}`);
      tx.set(auditRef, auditPayload);
    }

    return { ok: true, nextState, leaseVersion: nextVersion, idempotentReplay: false };
  });
}

/**
 * Admin / Super Admin verification transition (`COUNTED -> VERIFIED`) aligned strictly
 * with `canAdminRecountOrVerifyStocktakeV2` in `firestore.rules`.
 */
export async function verifyStocktakeItemTx(
  db: Firestore,
  params: {
    branchId: string;
    sessionId: string;
    medicineId: string;
    adminUid: string;
    adminRole: 'admin' | 'super_admin';
    deviceId?: string;
    auditId?: string;
  }
): Promise<{ leaseVersion: number; countRevision: number; idempotentReplay: boolean }> {
  assertValidId(params.branchId, 'branchId');
  assertValidId(params.sessionId, 'sessionId');
  assertValidId(params.medicineId, 'medicineId');
  assertValidId(params.adminUid, 'adminUid');
  if (params.adminRole !== 'admin' && params.adminRole !== 'super_admin') {
    throw new Error('UNAUTHORIZED_VERIFY_ROLE');
  }
  if (params.auditId !== undefined) assertValidId(params.auditId, 'auditId');

  const sessRef = doc(db, 'branches', params.branchId, 'stocktake_sessions_v2', params.sessionId);
  const itemRef = doc(db, 'branches', params.branchId, 'stocktake_sessions_v2', params.sessionId, 'items', params.medicineId);

  return runTransaction(db, async (tx) => {
    const [sessSnap, itemSnap] = await Promise.all([tx.get(sessRef), tx.get(itemRef)]);
    if (!sessSnap.exists()) throw new Error('STOCKTAKE_SESSION_NOT_FOUND');
    const sessData = sessSnap.data() as Record<string, unknown>;
    if (String(sessData.branchId ?? '') !== params.branchId) {
      throw new Error('CROSS_BRANCH_SESSION_MISMATCH');
    }
    const sessStatus = String(sessData.status ?? '');
    if (!['IN_PROGRESS', 'RECONCILING', 'NEEDS_REVIEW', 'PENDING_APPROVAL'].includes(sessStatus)) {
      throw new Error(`SESSION_NOT_ELIGIBLE_FOR_VERIFY:${sessStatus}`);
    }
    if (!itemSnap.exists()) throw new Error('ITEM_NOT_FOUND');
    const item = itemSnap.data() as Record<string, unknown>;
    if (String(item.branchId ?? '') !== params.branchId || String(item.sessionId ?? '') !== params.sessionId) {
      throw new Error('CROSS_BRANCH_ITEM_MISMATCH');
    }
    const currentLeaseVer = Number(item.leaseVersion ?? 0);
    const countRev = Number(item.countRevision ?? 0);
    if (item.state === 'VERIFIED' && countRev >= 1 && item.activeLease == null) {
      return { leaseVersion: currentLeaseVer, countRevision: countRev, idempotentReplay: true };
    }
    if (
      item.state !== 'COUNTED' ||
      String(item.syncStatus ?? '') !== 'CONFIRMED' ||
      countRev < 1 ||
      item.activeLease != null
    ) {
      throw new Error(`ITEM_NOT_ELIGIBLE_FOR_VERIFY:${String(item.state ?? '')}`);
    }

    const nextLeaseVer = currentLeaseVer + 1;
    const patch = {
      state: 'VERIFIED',
      activeLease: null,
      leaseVersion: nextLeaseVer,
      recountReason: null,
      operationalDiscrepancyFlag: false,
      updatedAt: serverTimestamp(),
    };
    requireSharedOperationalItemSafe(patch, 'verifyStocktakeItemTx');
    tx.update(itemRef, patch);

    if (params.auditId) {
      const auditRef = doc(
        db,
        'branches',
        params.branchId,
        'stocktake_sessions_v2',
        params.sessionId,
        'operational_audit',
        params.auditId
      );
      const auditPayload = {
        id: params.auditId,
        branchId: params.branchId,
        sessionId: params.sessionId,
        medicineId: params.medicineId,
        action: 'COUNT_VERIFIED',
        actorUid: params.adminUid,
        actorRole: params.adminRole,
        deviceId: (params.deviceId || 'admin-console').slice(0, 128),
        summary: `Verified stocktake count rev ${countRev}`,
        createdAt: serverTimestamp(),
      };
      requireOperationalPayloadSafe(auditPayload, `operational_audit/${params.auditId}`);
      tx.set(auditRef, auditPayload);
    }

    return { leaseVersion: nextLeaseVer, countRevision: countRev, idempotentReplay: false };
  });
}

/**
 * OD-2F-3 Binding Cashier Operational View Loader:
 * Reads operational items and projects ONLY:
 * 1) `remainingItems`: blind uncounted/recount-eligible list (zero quantities/costs/prices)
 * 2) `myConfirmedCounts`: strictly this cashier's OWN confirmed physical quantity + countUnit
 *    (zero system stock, zero variance, zero purchase prices/costs/valuation/profit/margin).
 */
export async function loadCashierStocktakeOperationalViews(
  db: Firestore,
  branchId: string,
  sessionId: string,
  cashierUid: string
): Promise<{
  remainingItems: RemainingMedicinePublicView[];
  myConfirmedCounts: CashierOwnConfirmedCountView[];
}> {
  assertValidId(branchId, 'branchId');
  assertValidId(sessionId, 'sessionId');
  assertValidId(cashierUid, 'cashierUid');

  const itemsCol = collection(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId, 'items');
  const eventsCol = collection(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId, 'count_events');
  const [itemsSnap, ownEventsSnap] = await Promise.all([
    getDocs(query(itemsCol, where('branchId', '==', branchId), where('sessionId', '==', sessionId))),
    // OD-4 / Fix A: Actor-scoped Firestore query enforced by Firestore Security Rules.
    getDocs(
      query(
        eventsCol,
        where('branchId', '==', branchId),
        where('sessionId', '==', sessionId),
        where('actorUid', '==', cashierUid)
      )
    ),
  ]);

  const rawItems: OperationalStocktakeItem[] = [];
  const medicineNameById: Record<string, string> = {};
  itemsSnap.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    requireSharedOperationalItemSafe(data, `loadCashierView:${d.id}`);
    const lease = (data.activeLease ?? null) as
      | {
          leaseId: string;
          ownerUid: string;
          ownerDisplayName?: string;
          deviceId: string;
          createdAt?: Timestamp;
          expiresAt?: Timestamp;
          leaseVersion: number;
          renewalCount: number;
        }
      | null;
    const medId = String(data.medicineId ?? d.id);
    const medName = String(data.medicineName ?? medId);
    medicineNameById[medId] = medName;
    rawItems.push({
      id: String(data.id ?? d.id),
      sessionId: String(data.sessionId ?? sessionId),
      branchId: String(data.branchId ?? branchId),
      medicineId: medId,
      medicineName: medName,
      strength: typeof data.strength === 'string' ? data.strength : '',
      dosageForm: typeof data.dosageForm === 'string' ? data.dosageForm : '',
      primaryBarcode: typeof data.primaryBarcode === 'string' ? data.primaryBarcode : '',
      secondaryBarcodes: Array.isArray(data.secondaryBarcodes) ? (data.secondaryBarcodes as string[]) : [],
      availableUnits: Array.isArray(data.availableUnits)
        ? (data.availableUnits as StocktakeCountUnit[])
        : ['pack'],
      state: data.state as OperationalStocktakeItem['state'],
      syncStatus: (data.syncStatus as OperationalStocktakeItem['syncStatus']) ?? 'CONFIRMED',
      activeLease: lease
        ? {
            leaseId: lease.leaseId,
            sessionId: String(data.sessionId ?? sessionId),
            branchId: String(data.branchId ?? branchId),
            medicineId: medId,
            ownerUid: lease.ownerUid,
            ownerDisplayName: lease.ownerDisplayName ?? '',
            deviceId: lease.deviceId,
            createdAtServerMs: timestampToMs(lease.createdAt),
            expiresAtServerMs: timestampToMs(lease.expiresAt),
            leaseVersion: Number(lease.leaseVersion ?? 1),
            renewalCount: Number(lease.renewalCount ?? 0),
          }
        : null,
      leaseVersion: Number(data.leaseVersion ?? 0),
      countRevision: Number(data.countRevision ?? 0),
      recountReason: typeof data.recountReason === 'string' ? data.recountReason : null,
      operationalDiscrepancyFlag: Boolean(data.operationalDiscrepancyFlag ?? false),
      updatedAtMs: timestampToMs(data.updatedAt),
    });
  });

  const ownEvents: OperationalCountSubmissionEvent[] = [];
  ownEventsSnap.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    requireOperationalPayloadSafe(data, `loadCashierOwnCountEvent:${d.id}`);
    const wm = (data.watermark ?? {}) as Record<string, unknown>;
    ownEvents.push({
      eventId: String(data.eventId ?? d.id),
      idempotencyKey: String(data.idempotencyKey ?? ''),
      sessionId: String(data.sessionId ?? sessionId),
      branchId: String(data.branchId ?? branchId),
      medicineId: String(data.medicineId ?? ''),
      countRevision: Number(data.countRevision ?? 1),
      leaseId: String(data.leaseId ?? ''),
      leaseVersion: Number(data.leaseVersion ?? 1),
      countedQuantity: Number(data.countedQuantity ?? 0),
      countUnit: (data.countUnit as StocktakeCountUnit) ?? 'pack',
      baseUnitsPerCountUnit: Number(data.baseUnitsPerCountUnit ?? 1),
      countedBaseUnits: Number(data.countedBaseUnits ?? 0),
      actorUid: String(data.actorUid ?? ''),
      actorDisplayName: String(data.actorDisplayName ?? ''),
      deviceId: String(data.deviceId ?? ''),
      watermark: {
        countBusinessAtMs: Number(wm.countBusinessAtMs ?? 0),
        localPersistedAtMs: Number(wm.localPersistedAtMs ?? 0),
        serverConfirmedAtMs: timestampToMs(data.createdAt) || null,
        ...(typeof wm.branchLedgerSeq === 'number' ? { branchLedgerSeq: wm.branchLedgerSeq } : {}),
        ...(typeof wm.medicineLedgerSeq === 'number' ? { medicineLedgerSeq: wm.medicineLedgerSeq } : {}),
        knownMovementIdsAtCount: Array.isArray(wm.knownMovementIdsAtCount)
          ? (wm.knownMovementIdsAtCount as string[])
          : [],
        knownMovementCount: Number(wm.knownMovementCount ?? 0),
        watermarkDigest: String(wm.watermarkDigest ?? ''),
      },
      syncStatus: 'CONFIRMED',
      recountOfEventId: typeof data.recountOfEventId === 'string' ? data.recountOfEventId : null,
      notes: typeof data.notes === 'string' ? data.notes : '',
    });
  });

  const itemByMedId = new Map(rawItems.map((it) => [it.medicineId, it]));
  const activeOwnConfirmedEvents = ownEvents.filter((ev) => {
    const it = itemByMedId.get(ev.medicineId);
    if (!it) return false;
    return (
      it.syncStatus === 'CONFIRMED' &&
      (it.state === 'COUNTED' || it.state === 'VERIFIED') &&
      ev.countRevision === it.countRevision
    );
  });

  return {
    remainingItems: buildRemainingMedicinesPublicView(rawItems, cashierUid),
    myConfirmedCounts: buildCashierOwnConfirmedCountsView(activeOwnConfirmedEvents, cashierUid, medicineNameById),
  };
}

export interface SubmitCountTxInput {
  branchId: string;
  sessionId: string;
  medicineId: string;
  actorUid: string;
  actorDisplayName: string;
  actorRole: StocktakeRole;
  deviceId: string;
  countedQuantity: number;
  countUnit: StocktakeCountUnit;
  baseUnitsPerCountUnit: number;
  knownMovementIdsAtCount: string[];
  leaseId?: string;
  expectedLeaseVersion?: number;
  countBusinessAtMs?: number;
  localPersistedAtMs?: number;
  medicineLedgerSeq?: number | null;
  branchLedgerSeq?: number | null;
  notes?: string;
}

export async function submitStocktakeCountTx(
  db: Firestore,
  input: SubmitCountTxInput
): Promise<{ eventId: string; countRevision: number; countedBaseUnits: number; idempotentReplay: boolean }> {
  assertValidId(input.branchId, 'branchId');
  assertValidId(input.sessionId, 'sessionId');
  assertValidId(input.medicineId, 'medicineId');
  assertValidId(input.actorUid, 'actorUid');
  if (input.leaseId !== undefined) assertValidId(input.leaseId, 'leaseId');
  if (!input.deviceId || input.deviceId.trim().length < 1 || input.deviceId.length > 128) {
    throw new Error('INVALID_DEVICE_ID');
  }
  if (!Number.isSafeInteger(input.countedQuantity) || input.countedQuantity < 0) {
    throw new Error(`INVALID_COUNT_QUANTITY:${String(input.countedQuantity)}`);
  }
  if (!isValidUnit(input.countUnit)) {
    throw new Error(`INVALID_COUNT_UNIT:${String(input.countUnit)}`);
  }
  if (!Number.isSafeInteger(input.baseUnitsPerCountUnit) || input.baseUnitsPerCountUnit <= 0) {
    throw new Error(`INVALID_UNIT_CONVERSION:${String(input.baseUnitsPerCountUnit)}`);
  }
  if (!Array.isArray(input.knownMovementIdsAtCount)) {
    throw new Error('INVALID_WATERMARK_MOVEMENT_IDS');
  }
  const seenWmIds = new Set<string>();
  for (const mId of input.knownMovementIdsAtCount) {
    assertValidId(mId, 'knownMovementIdsAtCount');
    if (seenWmIds.has(mId)) {
      throw new Error(`DUPLICATE_WATERMARK_MOVEMENT_ID:${mId}`);
    }
    seenWmIds.add(mId);
  }
  if (input.notes !== undefined && input.notes.length > 500) {
    throw new Error('INVALID_COUNT_NOTES_LENGTH');
  }

  const sessRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId);
  const itemRef = doc(
    db,
    'branches',
    input.branchId,
    'stocktake_sessions_v2',
    input.sessionId,
    'items',
    input.medicineId
  );
  const medRef = doc(db, 'branches', input.branchId, 'medicines', input.medicineId);

  return runTransaction(db, async (tx) => {
    const [sessSnap, snap, medSnap] = await Promise.all([
      tx.get(sessRef),
      tx.get(itemRef),
      tx.get(medRef),
    ]);
    if (!sessSnap.exists()) throw new Error('STOCKTAKE_SESSION_NOT_FOUND');
    const sessData = sessSnap.data() as Record<string, unknown>;
    if (String(sessData.branchId ?? '') !== input.branchId) {
      throw new Error('CROSS_BRANCH_SESSION_MISMATCH');
    }
    if (String(sessData.status ?? '') !== 'IN_PROGRESS') {
      throw new Error(`SESSION_NOT_IN_PROGRESS:${String(sessData.status ?? '')}`);
    }
    if (!snap.exists()) throw new Error('ITEM_NOT_FOUND');
    const item = snap.data() as Record<string, unknown>;
    if (String(item.branchId ?? '') !== input.branchId || String(item.sessionId ?? '') !== input.sessionId) {
      throw new Error('CROSS_BRANCH_ITEM_MISMATCH');
    }
    if (String(item.syncStatus ?? 'CONFIRMED') !== 'CONFIRMED') {
      throw new Error('ITEM_NOT_CONFIRMED_FOR_COUNT_SUBMISSION');
    }
    if (!medSnap.exists()) {
      throw new Error(`MEDICINE_NOT_FOUND:${input.medicineId}`);
    }
    const medData = medSnap.data() as Record<string, unknown>;
    if (String(medData.branchId ?? '') !== input.branchId) {
      throw new Error(`MEDICINE_BRANCH_MISMATCH:${input.medicineId}`);
    }

    if (Array.isArray(item.availableUnits) && !item.availableUnits.includes(input.countUnit)) {
      throw new Error(`INVALID_COUNT_UNIT:${input.countUnit}`);
    }
    const unitSpec = extractMedicineUnitSpec(input.medicineId, medData);
    const unitConv = resolveExactBaseUnitsPerUnit(unitSpec, input.countUnit);
    if (!unitConv.ok) {
      throw new Error(unitConv.error);
    }
    if (unitConv.baseUnitsPerUnit !== input.baseUnitsPerCountUnit) {
      throw new Error(
        `INVALID_UNIT_CONVERSION:expected=${unitConv.baseUnitsPerUnit}:got=${input.baseUnitsPerCountUnit}`
      );
    }

    const countedBaseUnits = input.countedQuantity * unitConv.baseUnitsPerUnit;
    if (!Number.isSafeInteger(countedBaseUnits) || countedBaseUnits < 0) {
      throw new Error('COUNTED_BASE_UNITS_OVERFLOW');
    }

    // Idempotent retry detection if already COUNTED at current revision by same actor + lease + payload
    const currentCountRev = Number(item.countRevision ?? 0);
    if (item.state === 'COUNTED' && currentCountRev >= 1) {
      const existingEventId = buildStocktakeCountEventId({
        sessionId: input.sessionId,
        medicineId: input.medicineId,
        countRevision: currentCountRev,
      });
      const existingEventRef = doc(
        db,
        'branches',
        input.branchId,
        'stocktake_sessions_v2',
        input.sessionId,
        'count_events',
        existingEventId
      );
      const existingEvSnap = await tx.get(existingEventRef);
      if (existingEvSnap.exists()) {
        const evData = existingEvSnap.data() as Record<string, unknown>;
        const wmData = (evData.watermark ?? {}) as Record<string, unknown>;
        const sameActor = String(evData.actorUid ?? '') === input.actorUid;
        const sameLease = !input.leaseId || String(evData.leaseId ?? '') === input.leaseId;
        const sameQty = Number(evData.countedQuantity) === input.countedQuantity && String(evData.countUnit) === input.countUnit;
        const sameDigest =
          String(wmData.watermarkDigest ?? '') === computeMovementWatermarkDigest(input.knownMovementIdsAtCount);
        if (sameActor && sameLease && sameQty && sameDigest) {
          return {
            eventId: existingEventId,
            countRevision: currentCountRev,
            countedBaseUnits: Number(evData.countedBaseUnits ?? countedBaseUnits),
            idempotentReplay: true,
          };
        }
      }
      throw new Error('ITEM_ALREADY_COUNTED_CONFLICT');
    }

    const lease = item.activeLease as { leaseId: string; ownerUid: string } | null;
    if (item.state !== 'RESERVED' || !lease || lease.ownerUid !== input.actorUid) {
      throw new Error('ACTIVE_LEASE_REQUIRED_FOR_COUNT_SUBMISSION');
    }
    if (input.leaseId && lease.leaseId !== input.leaseId) {
      throw new Error('LEASE_ID_MISMATCH');
    }
    const prevLeaseVer = Number(item.leaseVersion ?? 1);
    if (input.expectedLeaseVersion !== undefined && prevLeaseVer !== input.expectedLeaseVersion) {
      throw new Error('LEASE_VERSION_MISMATCH');
    }

    const nextCountRev = currentCountRev + 1;
    const eventId = buildStocktakeCountEventId({
      sessionId: input.sessionId,
      medicineId: input.medicineId,
      countRevision: nextCountRev,
    });
    const idempotencyKey = buildStocktakeCountIdempotencyKey({
      branchId: input.branchId,
      sessionId: input.sessionId,
      medicineId: input.medicineId,
      countRevision: nextCountRev,
      leaseVersion: prevLeaseVer,
      actorUid: input.actorUid,
    });
    const nowMs = Date.now();
    const countBusinessAtMs =
      typeof input.countBusinessAtMs === 'number' && Number.isFinite(input.countBusinessAtMs) && input.countBusinessAtMs > 0
        ? Math.trunc(input.countBusinessAtMs)
        : nowMs;
    const localPersistedAtMs =
      typeof input.localPersistedAtMs === 'number' && Number.isFinite(input.localPersistedAtMs) && input.localPersistedAtMs > 0
        ? Math.trunc(input.localPersistedAtMs)
        : nowMs;

    const eventRef = doc(
      db,
      'branches',
      input.branchId,
      'stocktake_sessions_v2',
      input.sessionId,
      'count_events',
      eventId
    );
    const auditId = `aud-${eventId}`;
    const auditRef = doc(
      db,
      'branches',
      input.branchId,
      'stocktake_sessions_v2',
      input.sessionId,
      'operational_audit',
      auditId
    );

    const watermarkPayload: Record<string, unknown> = {
      countBusinessAtMs,
      localPersistedAtMs,
      knownMovementIdsAtCount: [...input.knownMovementIdsAtCount],
      knownMovementCount: input.knownMovementIdsAtCount.length,
      watermarkDigest: computeMovementWatermarkDigest(input.knownMovementIdsAtCount),
      ...(typeof input.medicineLedgerSeq === 'number' && Number.isSafeInteger(input.medicineLedgerSeq)
        ? { medicineLedgerSeq: input.medicineLedgerSeq }
        : {}),
      ...(typeof input.branchLedgerSeq === 'number' && Number.isSafeInteger(input.branchLedgerSeq)
        ? { branchLedgerSeq: input.branchLedgerSeq }
        : {}),
    };

    const eventPayload = {
      eventId,
      idempotencyKey,
      sessionId: input.sessionId,
      branchId: input.branchId,
      medicineId: input.medicineId,
      countRevision: nextCountRev,
      leaseId: lease.leaseId,
      leaseVersion: prevLeaseVer,
      countedQuantity: normalizeSafeInt(input.countedQuantity),
      countUnit: input.countUnit,
      baseUnitsPerCountUnit: unitConv.baseUnitsPerUnit,
      countedBaseUnits: normalizeSafeInt(countedBaseUnits),
      actorUid: input.actorUid,
      actorDisplayName: (input.actorDisplayName || input.actorUid).slice(0, 120),
      deviceId: input.deviceId,
      watermark: watermarkPayload,
      ...(currentCountRev > 0
        ? {
            recountOfEventId: buildStocktakeCountEventId({
              sessionId: input.sessionId,
              medicineId: input.medicineId,
              countRevision: currentCountRev,
            }),
          }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      createdAt: serverTimestamp(),
    };
    requireOperationalPayloadSafe(eventPayload, `count_events/${eventId}`);

    // OD-4 / Fix A: Shared item doc holds ONLY workflow & concurrency metadata
    // (ZERO count quantity, count unit, actor UID/name, deviceId, or latestCountEventId).
    const itemPatch = {
      state: 'COUNTED',
      activeLease: null,
      leaseVersion: prevLeaseVer + 1,
      countRevision: nextCountRev,
      updatedAt: serverTimestamp(),
    };
    requireSharedOperationalItemSafe(itemPatch, `items/${input.medicineId}`);

    const auditPayload = {
      id: auditId,
      branchId: input.branchId,
      sessionId: input.sessionId,
      medicineId: input.medicineId,
      action: 'COUNT_SUBMITTED',
      actorUid: input.actorUid,
      actorRole: input.actorRole,
      deviceId: input.deviceId,
      summary: `Submitted physical count rev ${nextCountRev} (${input.countedQuantity} ${input.countUnit})`,
      createdAt: serverTimestamp(),
    };
    requireOperationalPayloadSafe(auditPayload, `operational_audit/${auditId}`);

    tx.set(eventRef, eventPayload);
    tx.update(itemRef, itemPatch);
    tx.set(auditRef, auditPayload);

    return { eventId, countRevision: nextCountRev, countedBaseUnits, idempotentReplay: false };
  });
}

export async function requestRecountAdminTx(
  db: Firestore,
  branchId: string,
  sessionId: string,
  medicineId: string,
  recountReason: string,
  adminAudit?: {
    adminUid: string;
    adminRole: 'admin' | 'super_admin';
    deviceId?: string;
    auditId?: string;
  }
): Promise<void> {
  assertValidId(branchId, 'branchId');
  assertValidId(sessionId, 'sessionId');
  assertValidId(medicineId, 'medicineId');
  const trimmedReason = typeof recountReason === 'string' ? recountReason.trim() : '';
  if (trimmedReason.length < 3 || trimmedReason.length > 500) {
    throw new Error('RECOUNT_REASON_REQUIRED');
  }
  if (adminAudit) {
    assertValidId(adminAudit.adminUid, 'adminUid');
    if (adminAudit.adminRole !== 'admin' && adminAudit.adminRole !== 'super_admin') {
      throw new Error('UNAUTHORIZED_RECOUNT_ROLE');
    }
    if (adminAudit.auditId !== undefined) assertValidId(adminAudit.auditId, 'auditId');
  }

  const sessRef = doc(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId);
  const itemRef = doc(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId, 'items', medicineId);
  await runTransaction(db, async (tx) => {
    const [sessSnap, snap] = await Promise.all([tx.get(sessRef), tx.get(itemRef)]);
    if (!sessSnap.exists()) throw new Error('STOCKTAKE_SESSION_NOT_FOUND');
    const sessData = sessSnap.data() as Record<string, unknown>;
    if (String(sessData.branchId ?? '') !== branchId) {
      throw new Error('CROSS_BRANCH_SESSION_MISMATCH');
    }
    const sessStatus = String(sessData.status ?? '');
    if (!['IN_PROGRESS', 'RECONCILING', 'NEEDS_REVIEW', 'PENDING_APPROVAL'].includes(sessStatus)) {
      throw new Error(`SESSION_NOT_ELIGIBLE_FOR_RECOUNT:${sessStatus}`);
    }
    if (!snap.exists()) throw new Error('ITEM_NOT_FOUND');
    const item = snap.data() as Record<string, unknown>;
    if (String(item.branchId ?? '') !== branchId || String(item.sessionId ?? '') !== sessionId) {
      throw new Error('CROSS_BRANCH_ITEM_MISMATCH');
    }
    if (item.activeLease != null) {
      throw new Error('ACTIVE_LEASE_MUST_EXPIRE_OR_BE_RELEASED');
    }
    if (item.state !== 'COUNTED') throw new Error(`CANNOT_RECOUNT_STATE:${String(item.state ?? '')}`);
    if (Number(item.countRevision ?? 0) < 1) {
      throw new Error('ITEM_MISSING_COUNT_REVISION_FOR_RECOUNT');
    }
    const nextLeaseVer = Number(item.leaseVersion ?? 0) + 1;
    const patch = {
      state: 'NEEDS_RECOUNT',
      activeLease: null,
      leaseVersion: nextLeaseVer,
      recountReason: trimmedReason,
      operationalDiscrepancyFlag: true,
      updatedAt: serverTimestamp(),
    };
    requireSharedOperationalItemSafe(patch, 'requestRecountAdminTx');
    tx.update(itemRef, patch);

    if (adminAudit) {
      const auditId = adminAudit.auditId ?? `aud-recount-${medicineId}-${nextLeaseVer}`;
      assertValidId(auditId, 'auditId');
      const auditRef = doc(
        db,
        'branches',
        branchId,
        'stocktake_sessions_v2',
        sessionId,
        'operational_audit',
        auditId
      );
      const auditPayload = {
        id: auditId,
        branchId,
        sessionId,
        medicineId,
        action: 'ADMIN_RECOUNT_REQUESTED',
        actorUid: adminAudit.adminUid,
        actorRole: adminAudit.adminRole,
        deviceId: (adminAudit.deviceId || 'admin-console').slice(0, 128),
        summary: `Requested recount (rev=${Number(item.countRevision)}): ${trimmedReason}`.slice(0, 500),
        createdAt: serverTimestamp(),
      };
      requireOperationalPayloadSafe(auditPayload, `operational_audit/${auditId}`);
      tx.set(auditRef, auditPayload);
    }
  });
}

export interface PersistFinancialReconciliationLineInput {
  medicineId: string;
  expectedCurrentBaseUnits: number;
  systemCurrentBaseUnits: number;
  varianceBaseUnits: number;
  discrepancyStatus: string;
  financialVarianceExact: Rational | null;
  costStatus?: 'NOT_APPLICABLE_ZERO_VARIANCE' | 'EXACT_HISTORICAL' | 'EXACT_RECONCILED' | 'NEEDS_REVIEW';
  costProvenanceType?: string;
  costPerBaseUnitExact?: Rational | null;
  sourceMovementIds?: string[];
  unresolvedBaseUnits?: number;
  integrityBlockers?: ReadonlyArray<string>;
  notes?: string | null;
}

export interface PersistFinancialReconciliationInput {
  branchId: string;
  sessionId: string;
  adminUid: string;
  adminRole: 'admin' | 'super_admin';
  reconciliationStatus: 'RECONCILING' | 'NEEDS_REVIEW' | 'PENDING_APPROVAL';
  totalExpectedValuationExact: Rational | null;
  totalSystemValuationExact: Rational | null;
  netVarianceValuationExact: Rational | null;
  unresolvedItemsCount: number;
  lines: PersistFinancialReconciliationLineInput[];
  auditId: string;
}

const LINE_REVIEW_BLOCKING_STATUSES = new Set([
  'NEEDS_REVIEW',
  'AMBIGUOUS_MOVEMENT',
  'INTEGRITY_BLOCKED',
  'NEEDS_RECOUNT',
  'REJECTED',
]);

export async function persistAdminStocktakeReconciliationTx(
  db: Firestore,
  input: PersistFinancialReconciliationInput
): Promise<void> {
  assertValidId(input.branchId, 'branchId');
  assertValidId(input.sessionId, 'sessionId');
  assertValidId(input.adminUid, 'adminUid');
  assertValidId(input.auditId, 'auditId');
  if (input.adminRole !== 'admin' && input.adminRole !== 'super_admin') {
    throw new Error('UNAUTHORIZED_RECONCILIATION_ROLE');
  }
  if (!Number.isSafeInteger(input.unresolvedItemsCount) || input.unresolvedItemsCount < 0) {
    throw new Error('INVALID_UNRESOLVED_ITEMS_COUNT');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new Error('EMPTY_RECONCILIATION_LINES_FORBIDDEN');
  }
  // Firestore runTransaction allows max 500 writes (finRef + auditRef + N lines <= 500)
  if (input.lines.length > 490) {
    throw new Error(`RECONCILIATION_TX_WRITE_LIMIT_EXCEEDED:${input.lines.length}`);
  }

  const seenMedIds = new Set<string>();
  for (const line of input.lines) {
    assertValidId(line.medicineId, 'line.medicineId');
    if (seenMedIds.has(line.medicineId)) {
      throw new Error(`DUPLICATE_RECONCILIATION_LINE:${line.medicineId}`);
    }
    seenMedIds.add(line.medicineId);
    if (!Number.isSafeInteger(line.expectedCurrentBaseUnits) || line.expectedCurrentBaseUnits < 0) {
      throw new Error(`INVALID_EXPECTED_BASE_UNITS:${line.medicineId}`);
    }
    if (!Number.isSafeInteger(line.systemCurrentBaseUnits) || line.systemCurrentBaseUnits < 0) {
      throw new Error(`INVALID_SYSTEM_BASE_UNITS:${line.medicineId}`);
    }
    if (!Number.isSafeInteger(line.varianceBaseUnits)) {
      throw new Error(`INVALID_VARIANCE_BASE_UNITS:${line.medicineId}`);
    }
    if (
      line.costStatus === 'NEEDS_REVIEW' ||
      LINE_REVIEW_BLOCKING_STATUSES.has(line.discrepancyStatus)
    ) {
      if (line.costProvenanceType === 'STOCKTAKE_V2_APPROVED_EXACT') {
        throw new Error(`FORBIDDEN_PROVENANCE_FOR_NEEDS_REVIEW:${line.medicineId}`);
      }
    }
  }

  if (input.reconciliationStatus === 'PENDING_APPROVAL') {
    if (input.unresolvedItemsCount !== 0) {
      throw new Error('PENDING_APPROVAL_REQUIRES_ZERO_UNRESOLVED');
    }
    if (
      !input.totalExpectedValuationExact ||
      !isValidRational(input.totalExpectedValuationExact) ||
      BigInt(input.totalExpectedValuationExact.num) < 0n ||
      !input.totalSystemValuationExact ||
      !isValidRational(input.totalSystemValuationExact) ||
      BigInt(input.totalSystemValuationExact.num) < 0n ||
      !input.netVarianceValuationExact ||
      !isValidRational(input.netVarianceValuationExact)
    ) {
      throw new Error('PENDING_APPROVAL_REQUIRES_EXACT_TOTAL_VALUATIONS');
    }
    for (const line of input.lines) {
      if (
        LINE_REVIEW_BLOCKING_STATUSES.has(line.discrepancyStatus) ||
        line.costStatus === 'NEEDS_REVIEW' ||
        (line.unresolvedBaseUnits ?? 0) > 0 ||
        (line.integrityBlockers?.length ?? 0) > 0
      ) {
        throw new Error(`PENDING_APPROVAL_BLOCKED_BY_UNRESOLVED_LINE:${line.medicineId}`);
      }
    }
  }

  const sessRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId);
  const finRef = doc(db, 'branches', input.branchId, 'stocktake_financials', input.sessionId);
  const auditRef = doc(
    db,
    'branches',
    input.branchId,
    'stocktake_financials',
    input.sessionId,
    'financial_audit',
    input.auditId
  );

  await runTransaction(db, async (tx) => {
    const [sessSnap, existing] = await Promise.all([tx.get(sessRef), tx.get(finRef)]);
    if (!sessSnap.exists()) {
      throw new Error('STOCKTAKE_SESSION_NOT_FOUND');
    }
    const sessData = sessSnap.data() as Record<string, unknown>;
    if (String(sessData.branchId ?? '') !== input.branchId) {
      throw new Error('CROSS_BRANCH_SESSION_MISMATCH');
    }
    const sessStatus = String(sessData.status ?? '');
    if (['DRAFT', 'POSTED', 'CLOSED', 'CANCELLED'].includes(sessStatus)) {
      throw new Error(`SESSION_IMMUTABLE_FOR_RECONCILIATION:${sessStatus}`);
    }
    if (existing.exists()) {
      const finStatus = String(existing.data().reconciliationStatus ?? '');
      if (finStatus === 'POSTED' || finStatus === 'CLOSED') {
        throw new Error(`FINANCIAL_SUMMARY_IMMUTABLE:${finStatus}`);
      }
    }

    if (!existing.exists()) {
      tx.set(finRef, {
        id: input.sessionId,
        branchId: input.branchId,
        sessionId: input.sessionId,
        reconciliationStatus: input.reconciliationStatus,
        totalExpectedValuationExact: serializeRational(input.totalExpectedValuationExact),
        totalSystemValuationExact: serializeRational(input.totalSystemValuationExact),
        netVarianceValuationExact: serializeRational(input.netVarianceValuationExact),
        unresolvedItemsCount: normalizeSafeInt(input.unresolvedItemsCount),
        updatedByUid: input.adminUid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      tx.update(finRef, {
        reconciliationStatus: input.reconciliationStatus,
        totalExpectedValuationExact: serializeRational(input.totalExpectedValuationExact),
        totalSystemValuationExact: serializeRational(input.totalSystemValuationExact),
        netVarianceValuationExact: serializeRational(input.netVarianceValuationExact),
        unresolvedItemsCount: normalizeSafeInt(input.unresolvedItemsCount),
        updatedByUid: input.adminUid,
        updatedAt: serverTimestamp(),
      });
    }

    for (const line of input.lines) {
      const lineRef = doc(
        db,
        'branches',
        input.branchId,
        'stocktake_financials',
        input.sessionId,
        'lines',
        line.medicineId
      );
      const linePayload: Record<string, unknown> = {
        id: line.medicineId,
        branchId: input.branchId,
        sessionId: input.sessionId,
        medicineId: line.medicineId,
        expectedCurrentBaseUnits: normalizeSafeInt(line.expectedCurrentBaseUnits),
        systemCurrentBaseUnits: normalizeSafeInt(line.systemCurrentBaseUnits),
        varianceBaseUnits: normalizeSafeInt(line.varianceBaseUnits),
        discrepancyStatus: line.discrepancyStatus,
        financialVarianceExact: serializeRational(line.financialVarianceExact),
        ...(line.costStatus !== undefined ? { costStatus: line.costStatus } : {}),
        ...(line.costProvenanceType !== undefined ? { costProvenanceType: line.costProvenanceType.slice(0, 64) } : {}),
        ...(line.costPerBaseUnitExact !== undefined
          ? { costPerBaseUnitExact: serializeRational(line.costPerBaseUnitExact) }
          : {}),
        ...(line.sourceMovementIds !== undefined
          ? { sourceMovementIds: line.sourceMovementIds.slice(0, 200) }
          : {}),
        ...(line.unresolvedBaseUnits !== undefined ? { unresolvedBaseUnits: normalizeSafeInt(line.unresolvedBaseUnits) } : {}),
        ...(line.notes !== undefined
          ? { notes: line.notes === null ? null : line.notes.slice(0, 500) }
          : {}),
        updatedByUid: input.adminUid,
        updatedAt: serverTimestamp(),
      };
      tx.set(lineRef, linePayload);
    }

    tx.set(auditRef, {
      id: input.auditId,
      branchId: input.branchId,
      sessionId: input.sessionId,
      actorUid: input.adminUid,
      actorRole: input.adminRole,
      action: 'STOCKTAKE_FINANCIAL_RECONCILED',
      summary: `Reconciled ${input.lines.length} items (status=${input.reconciliationStatus}, unresolved=${input.unresolvedItemsCount})`.slice(0, 500),
      createdAt: serverTimestamp(),
    });
  });
}

function deriveBatchLayersFefoFromLedgerAndFinancials(
  movements: ReadonlyArray<ReconcilableLedgerMovement>,
  financialsByMovementId: ReadonlyMap<string, Record<string, unknown>>
): BatchHistoricalCostLayer[] {
  const ordered = [...movements].sort((a, b) => {
    const dt = a.businessOccurredAtMs - b.businessOccurredAtMs;
    if (dt !== 0) return dt;
    return a.id.localeCompare(b.id);
  });

  const layers: Array<{
    batchNumber: string;
    expiry: string;
    remainingBaseUnits: number;
    costPerBaseUnitExact: Rational | null;
    sourceReceiptMovementId: string | null;
  }> = [];

  for (const mov of ordered) {
    const finDoc = financialsByMovementId.get(mov.id);
    const finStatus = finDoc ? String(finDoc.costStatus ?? '') : '';
    const finUnitCost = finDoc ? parseFirestoreRational(finDoc.costPerBaseUnitExact) : null;
    const provableCost = finStatus === 'EXACT_RECONCILED' ? finUnitCost : null;

    if (mov.baseUnitsDelta > 0) {
      const batchNo = mov.batchNumber || `unbatched-${mov.id}`;
      const exp = mov.expiry || '9999-12-31';
      const existing = layers.find(
        (l) =>
          l.batchNumber === batchNo &&
          l.expiry === exp &&
          ((l.costPerBaseUnitExact === null && provableCost === null) ||
            (l.costPerBaseUnitExact !== null &&
              provableCost !== null &&
              l.costPerBaseUnitExact.num === provableCost.num &&
              l.costPerBaseUnitExact.den === provableCost.den))
      );
      if (existing) {
        existing.remainingBaseUnits += mov.baseUnitsDelta;
      } else {
        layers.push({
          batchNumber: batchNo,
          expiry: exp,
          remainingBaseUnits: mov.baseUnitsDelta,
          costPerBaseUnitExact: provableCost,
          sourceReceiptMovementId: mov.id,
        });
      }
    } else if (mov.baseUnitsDelta < 0) {
      let need = -mov.baseUnitsDelta;
      if (mov.batchNumber) {
        for (const l of layers) {
          if (need <= 0) break;
          if (l.batchNumber === mov.batchNumber && l.remainingBaseUnits > 0) {
            const take = Math.min(l.remainingBaseUnits, need);
            l.remainingBaseUnits -= take;
            need -= take;
          }
        }
      }
      if (need > 0) {
        const sortedForFefo = [...layers].sort((a, b) => a.expiry.localeCompare(b.expiry));
        for (const l of sortedForFefo) {
          if (need <= 0) break;
          if (l.remainingBaseUnits <= 0) continue;
          const take = Math.min(l.remainingBaseUnits, need);
          l.remainingBaseUnits -= take;
          need -= take;
        }
      }
    }
  }

  return layers
    .filter((l) => l.remainingBaseUnits > 0)
    .sort((a, b) => {
      const expCmp = a.expiry.localeCompare(b.expiry);
      if (expCmp !== 0) return expCmp;
      return a.batchNumber.localeCompare(b.batchNumber);
    });
}

export interface ReconcileSessionFromFirestoreInput {
  branchId: string;
  sessionId: string;
  adminUid: string;
  adminRole: 'admin' | 'super_admin';
  reconciliationVersion?: number;
  clockSkewGuardMs?: number;
  auditId?: string;
  explicitSurplusCostByMedicineId?: Readonly<Record<string, Rational>>;
  hasSyncConflictByMedicineId?: Readonly<Record<string, boolean>>;
  nowMs?: number;
}

export interface ReconcileSessionFromFirestoreResult {
  sessionId: string;
  reconciliationStatus: 'NEEDS_REVIEW' | 'PENDING_APPROVAL';
  sessionStatusAfter: 'NEEDS_REVIEW' | 'PENDING_APPROVAL';
  unresolvedItemsCount: number;
  zeroVarianceReady: boolean;
  totalExpectedValuationExact: Rational | null;
  totalSystemValuationExact: Rational | null;
  netVarianceValuationExact: Rational | null;
  lineOutputsByMedicineId: Record<string, ReconcileMedicineOutput>;
  financialLinesPersisted: PersistFinancialReconciliationLineInput[];
}

/**
 * End-to-End Firestore-to-Inventory-Ledger Reconciliation Service (Admin-only):
 * Reads live Firestore Domain A (`stocktake_sessions_v2/{s}`, `items`, `count_events`,
 * `medicines`, `inventory_ledger`) + Domain B (`inventory_financials`), derives FEFO
 * historical batch cost layers exclusively from verified `inventory_financials`
 * provenance (ZERO `buyPrice` substitution), runs `reconcileMedicineAtCountReference`
 * per medicine independently, persists Domain B (`stocktake_financials` + `lines` + `financial_audit`),
 * and transitions session status (`RECONCILING -> NEEDS_REVIEW | PENDING_APPROVAL`).
 */
export async function reconcileStocktakeSessionFromFirestore(
  db: Firestore,
  input: ReconcileSessionFromFirestoreInput
): Promise<ReconcileSessionFromFirestoreResult> {
  assertValidId(input.branchId, 'branchId');
  assertValidId(input.sessionId, 'sessionId');
  assertValidId(input.adminUid, 'adminUid');
  if (input.adminRole !== 'admin' && input.adminRole !== 'super_admin') {
    throw new Error('UNAUTHORIZED_RECONCILIATION_ROLE');
  }
  const reconciliationVersion = input.reconciliationVersion ?? 1;
  if (!Number.isSafeInteger(reconciliationVersion) || reconciliationVersion < 1) {
    throw new Error('INVALID_RECONCILIATION_VERSION');
  }
  const reconciledAtMs = input.nowMs ?? Date.now();
  const auditId = input.auditId ?? `faud-rec-${input.sessionId}-v${reconciliationVersion}`;
  assertValidId(auditId, 'auditId');

  const sessRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId);
  const sessSnap = await getDoc(sessRef);
  if (!sessSnap.exists()) {
    throw new Error('STOCKTAKE_SESSION_NOT_FOUND');
  }
  const sessData = sessSnap.data() as Record<string, unknown>;
  if (String(sessData.branchId ?? '') !== input.branchId) {
    throw new Error('CROSS_BRANCH_SESSION_MISMATCH');
  }
  const initialStatus = String(sessData.status ?? '') as StocktakeSessionLifecycleStatus;
  if (!['IN_PROGRESS', 'RECONCILING', 'NEEDS_REVIEW'].includes(initialStatus)) {
    throw new Error(`SESSION_NOT_ELIGIBLE_FOR_RECONCILIATION:${initialStatus}`);
  }
  if (initialStatus === 'IN_PROGRESS' || initialStatus === 'NEEDS_REVIEW') {
    await transitionStocktakeSessionStatusTx(db, {
      branchId: input.branchId,
      sessionId: input.sessionId,
      targetStatus: 'RECONCILING',
      adminUid: input.adminUid,
      actorRole: input.adminRole,
    });
  }

  const itemsCol = collection(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId, 'items');
  const eventsCol = collection(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId, 'count_events');
  const medsCol = collection(db, 'branches', input.branchId, 'medicines');
  const ledgerCol = collection(db, 'branches', input.branchId, 'inventory_ledger');
  const invFinCol = collection(db, 'branches', input.branchId, 'inventory_financials');

  const [itemsSnap, eventsSnap, medsSnap, ledgerSnap, invFinSnap] = await Promise.all([
    getDocs(query(itemsCol, where('branchId', '==', input.branchId), where('sessionId', '==', input.sessionId))),
    getDocs(query(eventsCol, where('branchId', '==', input.branchId), where('sessionId', '==', input.sessionId))),
    getDocs(query(medsCol, where('branchId', '==', input.branchId))),
    getDocs(query(ledgerCol, where('branchId', '==', input.branchId))),
    getDocs(query(invFinCol, where('branchId', '==', input.branchId))),
  ]);

  if (itemsSnap.empty) {
    throw new Error('EMPTY_STOCKTAKE_SESSION_ITEMS');
  }

  const medsById = new Map<string, Record<string, unknown>>();
  medsSnap.forEach((d) => medsById.set(d.id, d.data() as Record<string, unknown>));

  const eventsById = new Map<string, Record<string, unknown>>();
  eventsSnap.forEach((d) => eventsById.set(d.id, d.data() as Record<string, unknown>));

  const invFinByMovId = new Map<string, Record<string, unknown>>();
  invFinSnap.forEach((d) => invFinByMovId.set(d.id, d.data() as Record<string, unknown>));

  const ledgerByMedId = new Map<string, ReconcilableLedgerMovement[]>();
  ledgerSnap.forEach((d) => {
    const raw = d.data() as Record<string, unknown>;
    const medId = String(raw.medicineId ?? '');
    if (!medId) return;
    const finDoc = invFinByMovId.get(d.id);
    const finCost =
      finDoc && String(finDoc.costStatus ?? '') === 'EXACT_RECONCILED'
        ? parseFirestoreRational(finDoc.costPerBaseUnitExact)
        : null;
    const serverTs = timestampToMs(raw.createdAt);
    const businessTs =
      typeof raw.businessOccurredAtMs === 'number' && Number.isFinite(raw.businessOccurredAtMs) && raw.businessOccurredAtMs > 0
        ? raw.businessOccurredAtMs
        : serverTs;
    const mov: ReconcilableLedgerMovement = {
      id: String(raw.id ?? d.id),
      branchId: String(raw.branchId ?? ''),
      medicineId: medId,
      batchNumber: String(raw.batchNumber ?? ''),
      expiry: typeof raw.expiry === 'string' ? raw.expiry : '',
      type: String(raw.type ?? '') as CanonicalLedgerMovementType,
      unit: (raw.unit as StocktakeCountUnit) ?? 'pill',
      quantityDelta: Number(raw.quantityDelta ?? 0),
      baseUnitsDelta: Number(raw.baseUnitsDelta ?? 0),
      costPerBaseUnitExact: finCost,
      referenceId: String(raw.referenceId ?? ''),
      ...(typeof raw.saleItemId === 'string' ? { saleItemId: raw.saleItemId } : {}),
      businessOccurredAtMs: businessTs,
      localPersistedAtMs:
        typeof raw.localPersistedAtMs === 'number' && Number.isFinite(raw.localPersistedAtMs) && raw.localPersistedAtMs > 0
          ? raw.localPersistedAtMs
          : businessTs,
      serverSyncedAtMs: serverTs > 0 ? serverTs : null,
      ...(typeof raw.medicineLedgerSeq === 'number' && Number.isSafeInteger(raw.medicineLedgerSeq)
        ? { medicineLedgerSeq: raw.medicineLedgerSeq }
        : {}),
      synced: serverTs > 0,
    };
    const arr = ledgerByMedId.get(medId) ?? [];
    arr.push(mov);
    ledgerByMedId.set(medId, arr);
  });

  const lineOutputsByMedicineId: Record<string, ReconcileMedicineOutput> = {};
  const financialLinesPersisted: PersistFinancialReconciliationLineInput[] = [];
  let unresolvedItemsCount = 0;
  let allZeroVariance = true;
  let canSumTotals = true;
  let totalExpectedValuation = createRational(0n, 1n);
  let totalSystemValuation = createRational(0n, 1n);
  let netVarianceValuation = createRational(0n, 1n);

  for (const itemDoc of itemsSnap.docs) {
    const item = itemDoc.data() as Record<string, unknown>;
    const medId = String(item.medicineId ?? itemDoc.id);
    const itemState = String(item.state ?? '');
    const countRev = Number(item.countRevision ?? 0);
    const syncSt = String(item.syncStatus ?? '');
    const activeLease = item.activeLease ?? null;

    if (
      (itemState !== 'COUNTED' && itemState !== 'VERIFIED') ||
      countRev < 1 ||
      syncSt !== 'CONFIRMED' ||
      activeLease != null
    ) {
      unresolvedItemsCount++;
      allZeroVariance = false;
      canSumTotals = false;
      financialLinesPersisted.push({
        medicineId: medId,
        expectedCurrentBaseUnits: 0,
        systemCurrentBaseUnits: 0,
        varianceBaseUnits: 0,
        discrepancyStatus: itemState === 'NEEDS_RECOUNT' ? 'NEEDS_RECOUNT' : 'NEEDS_REVIEW',
        financialVarianceExact: null,
        costStatus: 'NEEDS_REVIEW',
        costProvenanceType: 'ITEM_NOT_COUNTED_OR_ACTIVE_LEASE',
        costPerBaseUnitExact: null,
        sourceMovementIds: [],
        unresolvedBaseUnits: 0,
        integrityBlockers: [`ITEM_NOT_READY:${itemState}`],
        notes: `Item ${medId} state=${itemState}, countRevision=${countRev}`,
      });
      continue;
    }

    const expectedEventId = buildStocktakeCountEventId({
      sessionId: input.sessionId,
      medicineId: medId,
      countRevision: countRev,
    });
    const evRaw = eventsById.get(expectedEventId);
    if (!evRaw) {
      unresolvedItemsCount++;
      allZeroVariance = false;
      canSumTotals = false;
      financialLinesPersisted.push({
        medicineId: medId,
        expectedCurrentBaseUnits: 0,
        systemCurrentBaseUnits: 0,
        varianceBaseUnits: 0,
        discrepancyStatus: 'NEEDS_REVIEW',
        financialVarianceExact: null,
        costStatus: 'NEEDS_REVIEW',
        costProvenanceType: 'MISSING_COUNT_EVENT',
        costPerBaseUnitExact: null,
        sourceMovementIds: [],
        unresolvedBaseUnits: 0,
        integrityBlockers: [`MISSING_COUNT_EVENT:${expectedEventId}`],
        notes: `Missing count event ${expectedEventId}`,
      });
      continue;
    }

    const wmRaw = (evRaw.watermark ?? {}) as Record<string, unknown>;
    const countEvent: OperationalCountSubmissionEvent = {
      eventId: String(evRaw.eventId ?? expectedEventId),
      idempotencyKey: String(evRaw.idempotencyKey ?? ''),
      sessionId: String(evRaw.sessionId ?? input.sessionId),
      branchId: String(evRaw.branchId ?? input.branchId),
      medicineId: medId,
      countRevision: Number(evRaw.countRevision ?? 0),
      leaseId: String(evRaw.leaseId ?? ''),
      leaseVersion: Number(evRaw.leaseVersion ?? 0),
      countedQuantity: Number(evRaw.countedQuantity ?? -1),
      countUnit: (evRaw.countUnit as StocktakeCountUnit) ?? 'pack',
      baseUnitsPerCountUnit: Number(evRaw.baseUnitsPerCountUnit ?? 0),
      countedBaseUnits: Number(evRaw.countedBaseUnits ?? -1),
      actorUid: String(evRaw.actorUid ?? ''),
      actorDisplayName: String(evRaw.actorDisplayName ?? ''),
      deviceId: String(evRaw.deviceId ?? ''),
      watermark: {
        countBusinessAtMs: Number(wmRaw.countBusinessAtMs ?? 0),
        localPersistedAtMs: Number(wmRaw.localPersistedAtMs ?? 0),
        serverConfirmedAtMs: timestampToMs(evRaw.createdAt) || null,
        ...(typeof wmRaw.medicineLedgerSeq === 'number' ? { medicineLedgerSeq: wmRaw.medicineLedgerSeq } : {}),
        ...(typeof wmRaw.branchLedgerSeq === 'number' ? { branchLedgerSeq: wmRaw.branchLedgerSeq } : {}),
        knownMovementIdsAtCount: Array.isArray(wmRaw.knownMovementIdsAtCount)
          ? (wmRaw.knownMovementIdsAtCount as string[])
          : [],
        knownMovementCount: Number(wmRaw.knownMovementCount ?? 0),
        watermarkDigest: String(wmRaw.watermarkDigest ?? ''),
      },
      syncStatus: 'CONFIRMED',
      recountOfEventId: typeof evRaw.recountOfEventId === 'string' ? evRaw.recountOfEventId : null,
      notes: typeof evRaw.notes === 'string' ? evRaw.notes : '',
    };

    const medData = medsById.get(medId);
    const unitSpec: MedicineUnitConversionSpec = medData
      ? extractMedicineUnitSpec(medId, medData)
      : {
          medicineId: medId,
          unitOperationalAllowed: false,
          unitMode: 'DIRECT_PACK',
          stripsPerPack: 1,
          pillsPerStrip: 1,
          baseUnitsPerPack: 1,
        };

    const medMovements = ledgerByMedId.get(medId) ?? [];
    const batchLayersFefo = deriveBatchLayersFefoFromLedgerAndFinancials(medMovements, invFinByMovId);

    const rec = reconcileMedicineAtCountReference({
      sessionId: input.sessionId,
      branchId: input.branchId,
      reconciliationVersion,
      countEvent,
      unitSpec,
      allMedicineLedgerMovements: medMovements,
      batchLayersFefo,
      explicitVerifiedSurplusBatchCostExact: input.explicitSurplusCostByMedicineId?.[medId] ?? null,
      hasSyncConflict: input.hasSyncConflictByMedicineId?.[medId] === true,
      clockSkewGuardMs: input.clockSkewGuardMs,
      reconciledAtMs,
    });

    lineOutputsByMedicineId[medId] = rec;
    const fl = rec.financialLine;
    if (fl.requiredLedgerAdjustmentBaseUnits !== 0) {
      allZeroVariance = false;
    }

    const hasBlocker =
      fl.integrityBlockers.length > 0 ||
      fl.costStatus === 'NEEDS_REVIEW' ||
      fl.discrepancyStatus === 'NEEDS_REVIEW';
    if (hasBlocker) {
      unresolvedItemsCount++;
      canSumTotals = false;
    } else if (
      rec.valuation.expectedInventoryValuationExact &&
      fl.financialVarianceExact
    ) {
      totalExpectedValuation = addRational(totalExpectedValuation, rec.valuation.expectedInventoryValuationExact);
      netVarianceValuation = addRational(netVarianceValuation, fl.financialVarianceExact);
      // SystemValuation = ExpectedValuation - FinancialVariance (since Expected = System + VarianceImpact)
      const lineSysVal = subtractRational(rec.valuation.expectedInventoryValuationExact, fl.financialVarianceExact);
      totalSystemValuation = addRational(totalSystemValuation, lineSysVal);
    } else {
      canSumTotals = false;
    }

    let unitCostExact: Rational | null = null;
    if (
      fl.requiredLedgerAdjustmentBaseUnits !== 0 &&
      fl.approvedAcquisitionCostExact &&
      fl.costStatus === 'EXACT_HISTORICAL'
    ) {
      const absDelta = BigInt(Math.abs(fl.requiredLedgerAdjustmentBaseUnits));
      const absCost = createRational(
        BigInt(fl.approvedAcquisitionCostExact.num) < 0n
          ? -BigInt(fl.approvedAcquisitionCostExact.num)
          : BigInt(fl.approvedAcquisitionCostExact.num),
        BigInt(fl.approvedAcquisitionCostExact.den)
      );
      unitCostExact = multiplyRational(absCost, createRational(1n, absDelta));
    }

    const orderedMovementIds = [...medMovements]
      .sort((a, b) => a.businessOccurredAtMs - b.businessOccurredAtMs || a.id.localeCompare(b.id))
      .map((m) => m.id);
    const boundedMovementIds =
      orderedMovementIds.length > 200 ? orderedMovementIds.slice(-200) : orderedMovementIds;

    financialLinesPersisted.push({
      medicineId: medId,
      expectedCurrentBaseUnits: normalizeSafeInt(Math.max(0, fl.expectedCurrentBaseUnits)),
      systemCurrentBaseUnits: normalizeSafeInt(Math.max(0, fl.systemCurrentBaseUnits)),
      varianceBaseUnits: normalizeSafeInt(fl.requiredLedgerAdjustmentBaseUnits),
      discrepancyStatus: fl.discrepancyStatus,
      financialVarianceExact: fl.financialVarianceExact,
      costStatus: fl.costStatus,
      costProvenanceType:
        fl.costStatus === 'NOT_APPLICABLE_ZERO_VARIANCE'
          ? 'ZERO_VARIANCE_MATCHED'
          : fl.costStatus === 'EXACT_HISTORICAL'
            ? 'INVENTORY_FINANCIALS_HISTORICAL_EXACT'
            : 'MISSING_OR_AMBIGUOUS_PROVENANCE',
      costPerBaseUnitExact: unitCostExact,
      sourceMovementIds: boundedMovementIds,
      unresolvedBaseUnits: normalizeSafeInt(hasBlocker ? Math.abs(fl.requiredLedgerAdjustmentBaseUnits) : 0),
      integrityBlockers: fl.integrityBlockers,
      ...(fl.integrityBlockers.length > 0 ? { notes: fl.integrityBlockers.join(' | ').slice(0, 500) } : {}),
    });
  }

  const reconciliationStatus: 'NEEDS_REVIEW' | 'PENDING_APPROVAL' =
    unresolvedItemsCount > 0 || !canSumTotals ? 'NEEDS_REVIEW' : 'PENDING_APPROVAL';

  await persistAdminStocktakeReconciliationTx(db, {
    branchId: input.branchId,
    sessionId: input.sessionId,
    adminUid: input.adminUid,
    adminRole: input.adminRole,
    reconciliationStatus,
    totalExpectedValuationExact: canSumTotals ? totalExpectedValuation : null,
    totalSystemValuationExact: canSumTotals ? totalSystemValuation : null,
    netVarianceValuationExact: canSumTotals ? netVarianceValuation : null,
    unresolvedItemsCount,
    lines: financialLinesPersisted,
    auditId,
  });

  await transitionStocktakeSessionStatusTx(db, {
    branchId: input.branchId,
    sessionId: input.sessionId,
    targetStatus: reconciliationStatus,
    adminUid: input.adminUid,
    actorRole: input.adminRole,
  });

  return {
    sessionId: input.sessionId,
    reconciliationStatus,
    sessionStatusAfter: reconciliationStatus,
    unresolvedItemsCount,
    zeroVarianceReady: unresolvedItemsCount === 0 && allZeroVariance,
    totalExpectedValuationExact: canSumTotals ? totalExpectedValuation : null,
    totalSystemValuationExact: canSumTotals ? totalSystemValuation : null,
    netVarianceValuationExact: canSumTotals ? netVarianceValuation : null,
    lineOutputsByMedicineId,
    financialLinesPersisted,
  };
}

export interface ApproveAndPostAdjustmentInput {
  branchId: string;
  sessionId: string;
  adminUid: string;
  adminRole: 'admin' | 'super_admin';
  approvalId: string;
  postingId: string;
  approvalReason: string;
  reconciliationVersion?: number;
  /** Optional explicit movement-history verification flag (false fails closed -> NEEDS_REVIEW) */
  movementHistoryVerified?: boolean;
  /** Explicit flag permitting zero-variance session closure without synthetic ledger rows */
  allowZeroVarianceClosure?: boolean;
  /** Optional medicine ID list for zero-variance session verification inside runTransaction */
  zeroVarianceMedicineIds?: string[];
  /** Optional pre-flight ledger movement IDs snapshot per medicine to reject stale concurrent ledger changes */
  reconciledLedgerMovementIdsByMedicineId?: Readonly<Record<string, ReadonlyArray<string>>>;
  businessOccurredAtMs?: number;
  adjustments: Array<{
    medicineId: string;
    adjustmentBaseUnitsDelta: number; // non-zero signed safe integer
    costPerBaseUnitExact: Rational;
    totalCostExact: Rational;
    expectedCountRevision?: number;
    /** Fix E: Explicit historical cost provenance status; NEEDS_REVIEW fails closed */
    costStatus?: 'EXACT_HISTORICAL' | 'EXACT_RECONCILED' | 'NEEDS_REVIEW';
  }>;
}

/**
 * Fix E — Atomic Inventory Ledger Posting enforcing ALL 10 Mandatory Pre-Posting Checks:
 *  1. Admin / Super Admin role + mandatory approval reason (>= 5 chars)
 *  2. Session existence, branch match, and STRICT `APPROVED` lifecycle status (matching firestore.rules `APPROVED -> POSTED`)
 *  3. Financial summary existence, eligible reconciliationStatus, and unresolvedItemsCount === 0
 *  4. Idempotent posting guard (existing posting -> verified replay or conflict fail; orphan ledger doc -> fail closed)
 *  5. Per-item operational doc existence, branch/session match, COUNTED/VERIFIED, countRevision >= 1, activeLease === null
 *  6. Per-item medicine master existence & branchId match
 *  7. Per-item financial line existence, non-NEEDS_REVIEW discrepancyStatus & costStatus, unresolvedBaseUnits === 0, exact variance match
 *  8. Zero synthetic movements (zero-delta / non-integer / duplicate medicineId rejected; zero-variance closure writes ZERO ledger docs)
 *  9. Exact historical cost provenance check via `verifyHistoricalCostProvenanceAndEligibility` (zero buyPrice fallback)
 * 10. Verified movement-history completeness gate + optional fresh ledger movement check + strict Domain A / Domain B separation.
 */
export async function approveAndPostStocktakeAdjustmentTx(
  db: Firestore,
  input: ApproveAndPostAdjustmentInput
): Promise<{ idempotentReplay: boolean; postedLedgerIds: string[]; zeroVarianceClosed?: boolean }> {
  if (input.adminRole !== 'admin' && input.adminRole !== 'super_admin') {
    throw new Error('UNAUTHORIZED_POSTING_ROLE');
  }
  assertValidId(input.branchId, 'branchId');
  assertValidId(input.sessionId, 'sessionId');
  assertValidId(input.adminUid, 'adminUid');
  assertValidId(input.approvalId, 'approvalId');
  assertValidId(input.postingId, 'postingId');

  if (!input.approvalReason || input.approvalReason.trim().length < 5 || input.approvalReason.trim().length > 500) {
    throw new Error('APPROVAL_REASON_REQUIRED');
  }
  if (input.movementHistoryVerified === false) {
    throw new Error('INCOMPLETE_MOVEMENT_HISTORY_NEEDS_REVIEW');
  }
  const reconciliationVersion = input.reconciliationVersion ?? 1;
  if (!Number.isSafeInteger(reconciliationVersion) || reconciliationVersion < 1) {
    throw new Error('INVALID_RECONCILIATION_VERSION');
  }

  const isZeroVarianceClosure =
    Array.isArray(input.adjustments) && input.adjustments.length === 0 && input.allowZeroVarianceClosure === true;

  if (!Array.isArray(input.adjustments) || (input.adjustments.length === 0 && !isZeroVarianceClosure)) {
    throw new Error('EMPTY_ADJUSTMENT_LIST_FORBIDDEN');
  }

  // Optional fresh ledger movement completeness pre-flight check (matches StocktakeReconciliationEngine Pre-Flight)
  if (input.reconciledLedgerMovementIdsByMedicineId) {
    for (const [medId, expectedMovIds] of Object.entries(input.reconciledLedgerMovementIdsByMedicineId)) {
      const freshSnap = await getDocs(
        query(
          collection(db, 'branches', input.branchId, 'inventory_ledger'),
          where('branchId', '==', input.branchId),
          where('medicineId', '==', medId)
        )
      );
      const freshIds = new Set<string>();
      freshSnap.forEach((d) => freshIds.add(d.id));
      const expectedSet = new Set(expectedMovIds);
      const changed =
        freshIds.size !== expectedSet.size || [...freshIds].some((id) => !expectedSet.has(id));
      if (changed) {
        throw new Error(`STALE_STOCK_VERSION_NEW_MOVEMENTS:${medId}`);
      }
    }
  }

  // Zero-variance session path: collect all session item & line IDs upfront to verify inside runTransaction
  let zeroVarMedIds: string[] = [];
  if (isZeroVarianceClosure) {
    if (input.zeroVarianceMedicineIds && input.zeroVarianceMedicineIds.length > 0) {
      zeroVarMedIds = [...new Set(input.zeroVarianceMedicineIds)];
    } else {
      const itemsSnap = await getDocs(
        query(
          collection(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId, 'items'),
          where('branchId', '==', input.branchId),
          where('sessionId', '==', input.sessionId)
        )
      );
      zeroVarMedIds = itemsSnap.docs.map((d) => d.id);
    }
    if (zeroVarMedIds.length === 0) {
      throw new Error('ZERO_VARIANCE_NO_ITEMS_FOUND');
    }
  }

  const seenMeds = new Set<string>();
  for (const adj of input.adjustments) {
    if (!adj.medicineId || !isValidFirestoreDocId(adj.medicineId) || seenMeds.has(adj.medicineId)) {
      throw new Error(`DUPLICATE_OR_INVALID_MEDICINE_ADJUSTMENT:${adj.medicineId}`);
    }
    seenMeds.add(adj.medicineId);
    if (!Number.isSafeInteger(adj.adjustmentBaseUnitsDelta) || adj.adjustmentBaseUnitsDelta === 0) {
      throw new Error(`SYNTHETIC_ZERO_ADJUSTMENT_FORBIDDEN:${adj.medicineId}`);
    }
    if (adj.costStatus === 'NEEDS_REVIEW') {
      throw new Error(`AMBIGUOUS_HISTORICAL_COST_NEEDS_REVIEW:${adj.medicineId}`);
    }
    if (!adj.costPerBaseUnitExact || !adj.totalCostExact) {
      throw new Error(`AMBIGUOUS_HISTORICAL_COST_NEEDS_REVIEW:${adj.medicineId}`);
    }
    let unitNum: bigint;
    let unitDen: bigint;
    let totalNum: bigint;
    let totalDen: bigint;
    try {
      unitNum = BigInt(adj.costPerBaseUnitExact.num);
      unitDen = BigInt(adj.costPerBaseUnitExact.den);
      totalNum = BigInt(adj.totalCostExact.num);
      totalDen = BigInt(adj.totalCostExact.den);
    } catch {
      throw new Error(`AMBIGUOUS_HISTORICAL_COST_NEEDS_REVIEW:${adj.medicineId}`);
    }
    if (unitDen <= 0n || totalDen <= 0n || unitNum < 0n) {
      throw new Error(`AMBIGUOUS_HISTORICAL_COST_NEEDS_REVIEW:${adj.medicineId}`);
    }
    const deltaBig = BigInt(adj.adjustmentBaseUnitsDelta);
    const expectedNum = deltaBig * unitNum;
    if (expectedNum * totalDen !== totalNum * unitDen) {
      throw new Error(`COST_VALUATION_MISMATCH:${adj.medicineId}`);
    }

    // F-06 cross-check with R3.2 independent rational verifier when numbers fit safe integers
    try {
      const unitNumInt = Number(unitNum);
      const unitDenInt = Number(unitDen);
      const totalNumInt = Number(totalNum);
      const totalDenInt = Number(totalDen);
      if (
        Number.isSafeInteger(unitNumInt) &&
        Number.isSafeInteger(unitDenInt) &&
        Number.isSafeInteger(totalNumInt) &&
        Number.isSafeInteger(totalDenInt)
      ) {
        const movId = buildStocktakeAdjustmentLedgerId({
          branchId: input.branchId,
          sessionId: input.sessionId,
          medicineId: adj.medicineId,
          reconciliationVersion,
        });
        const prov = verifyHistoricalCostProvenanceAndEligibility({
          movementId: movId,
          medicineId: adj.medicineId,
          movementType: 'ADJUSTMENT',
          baseUnitsDelta: normalizeSafeInt(adj.adjustmentBaseUnitsDelta),
          costStatus: adj.costStatus ?? 'EXACT_RECONCILED',
          costProvenanceType: 'STOCKTAKE_V2_APPROVED_EXACT',
          costPerBaseUnitExact: { num: unitNumInt, den: unitDenInt },
          totalCostExact: { num: totalNumInt, den: totalDenInt },
          unresolvedBaseUnits: 0,
          movementHistoryVerified: input.movementHistoryVerified,
          sourceReferenceId: input.postingId,
        });
        if (!prov.eligibleForExactReconciliation) {
          throw new Error(`AMBIGUOUS_HISTORICAL_COST_NEEDS_REVIEW:${adj.medicineId}:${prov.rejectionReason}`);
        }
      }
    } catch (e: unknown) {
      if (String((e as Error).message).includes('AMBIGUOUS_HISTORICAL_COST_NEEDS_REVIEW')) {
        throw e;
      }
      throw new Error(`AMBIGUOUS_HISTORICAL_COST_NEEDS_REVIEW:${adj.medicineId}`);
    }
  }

  const sessRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId);
  const finRef = doc(db, 'branches', input.branchId, 'stocktake_financials', input.sessionId);
  const aprRef = doc(db, 'branches', input.branchId, 'stocktake_financials', input.sessionId, 'approvals', input.approvalId);
  const postRef = doc(db, 'branches', input.branchId, 'stocktake_financials', input.sessionId, 'postings', input.postingId);
  const auditRef = doc(
    db,
    'branches',
    input.branchId,
    'stocktake_financials',
    input.sessionId,
    'financial_audit',
    `aud-post-${input.postingId}`
  );

  const businessOccurredAtMs =
    typeof input.businessOccurredAtMs === 'number' && Number.isFinite(input.businessOccurredAtMs) && input.businessOccurredAtMs > 0
      ? Math.trunc(input.businessOccurredAtMs)
      : Date.now();

  return runTransaction(db, async (tx) => {
    const ledgerIds = input.adjustments.map((adj) =>
      buildStocktakeAdjustmentLedgerId({
        branchId: input.branchId,
        sessionId: input.sessionId,
        medicineId: adj.medicineId,
        reconciliationVersion,
      })
    );

    const [sessSnap, finSnap, postSnap] = await Promise.all([
      tx.get(sessRef),
      tx.get(finRef),
      tx.get(postRef),
    ]);

    if (postSnap.exists()) {
      const postData = postSnap.data() as Record<string, unknown>;
      const existingLedgerIds = Array.isArray(postData.postedLedgerIds)
        ? (postData.postedLedgerIds as string[])
        : [];
      const matchesReplay =
        String(postData.branchId ?? '') === input.branchId &&
        String(postData.sessionId ?? '') === input.sessionId &&
        String(postData.approvalId ?? '') === input.approvalId &&
        existingLedgerIds.length === ledgerIds.length &&
        existingLedgerIds.every((id, idx) => id === ledgerIds[idx]);
      if (!matchesReplay) {
        throw new Error(`POSTING_ID_CONFLICT:${input.postingId}`);
      }
      return {
        idempotentReplay: true,
        postedLedgerIds: ledgerIds,
        ...(isZeroVarianceClosure ? { zeroVarianceClosed: true } : {}),
      };
    }

    if (!sessSnap.exists()) throw new Error('STOCKTAKE_SESSION_NOT_FOUND');
    const sessData = sessSnap.data() as Record<string, unknown>;
    if (String(sessData.branchId ?? '') !== input.branchId) {
      throw new Error('CROSS_BRANCH_SESSION_MISMATCH');
    }
    const sessStatus = String(sessData.status ?? '');
    if (sessStatus !== 'APPROVED') {
      throw new Error(`SESSION_NOT_ELIGIBLE_FOR_POSTING:${sessStatus}`);
    }

    if (!finSnap.exists()) throw new Error('STOCKTAKE_FINANCIAL_SUMMARY_MISSING');
    const finData = finSnap.data() as Record<string, unknown>;
    if (Number(finData.unresolvedItemsCount ?? 0) > 0) {
      throw new Error('CANNOT_POST_WITH_UNRESOLVED_ITEMS');
    }
    const recStatus = String(finData.reconciliationStatus ?? '');
    if (recStatus !== 'PENDING_APPROVAL' && recStatus !== 'APPROVED') {
      throw new Error(`FINANCIAL_SUMMARY_NOT_ELIGIBLE_FOR_POSTING:${recStatus}`);
    }

    if (isZeroVarianceClosure) {
      const totalTarget = Number(sessData.totalTargetItems ?? 0);
      if (zeroVarMedIds.length !== totalTarget) {
        throw new Error(`ZERO_VARIANCE_ITEM_COUNT_MISMATCH:${zeroVarMedIds.length}/${totalTarget}`);
      }
      const zeroReads = await Promise.all(
        zeroVarMedIds.map(async (medId) => {
          const itemRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId, 'items', medId);
          const lineRef = doc(db, 'branches', input.branchId, 'stocktake_financials', input.sessionId, 'lines', medId);
          const [itemSnap, lineSnap] = await Promise.all([tx.get(itemRef), tx.get(lineRef)]);
          return { medId, lineRef, itemSnap, lineSnap };
        })
      );
      for (const row of zeroReads) {
        if (!row.itemSnap.exists()) throw new Error(`STOCKTAKE_ITEM_NOT_FOUND:${row.medId}`);
        const itemData = row.itemSnap.data() as Record<string, unknown>;
        const itemState = String(itemData.state ?? '');
        if (
          String(itemData.branchId ?? '') !== input.branchId ||
          String(itemData.sessionId ?? '') !== input.sessionId ||
          (itemState !== 'COUNTED' && itemState !== 'VERIFIED') ||
          Number(itemData.countRevision ?? 0) < 1 ||
          itemData.activeLease != null ||
          String(itemData.syncStatus ?? 'CONFIRMED') !== 'CONFIRMED'
        ) {
          throw new Error(`ITEM_NOT_COUNTED_FOR_POSTING:${row.medId}:${itemState}`);
        }
        if (!row.lineSnap.exists()) throw new Error(`FINANCIAL_LINE_MISSING_FOR_POSTING:${row.medId}`);
        const lineData = row.lineSnap.data() as Record<string, unknown>;
        if (
          Number(lineData.varianceBaseUnits) !== 0 ||
          String(lineData.discrepancyStatus ?? '') !== 'MATCHED' ||
          String(lineData.costStatus ?? 'NOT_APPLICABLE_ZERO_VARIANCE') !== 'NOT_APPLICABLE_ZERO_VARIANCE' ||
          Number(lineData.unresolvedBaseUnits ?? 0) !== 0
        ) {
          throw new Error(`NON_ZERO_VARIANCE_IN_ZERO_CLOSURE:${row.medId}`);
        }
      }

      tx.set(aprRef, {
        id: input.approvalId,
        branchId: input.branchId,
        sessionId: input.sessionId,
        approvedByUid: input.adminUid,
        approvalReason: input.approvalReason.trim(),
        createdAt: serverTimestamp(),
      });
      tx.set(postRef, {
        id: input.postingId,
        branchId: input.branchId,
        sessionId: input.sessionId,
        approvalId: input.approvalId,
        postedByUid: input.adminUid,
        postedLedgerIds: [],
        notes: 'Zero-variance stocktake closure (no adjustment movements created)',
        createdAt: serverTimestamp(),
      });
      tx.update(finRef, {
        reconciliationStatus: 'POSTED',
        approvedByUid: input.adminUid,
        approvedAt: serverTimestamp(),
        postedByUid: input.adminUid,
        postedAt: serverTimestamp(),
        updatedByUid: input.adminUid,
        updatedAt: serverTimestamp(),
      });
      tx.update(sessRef, {
        status: 'POSTED',
        updatedAt: serverTimestamp(),
      });
      tx.set(auditRef, {
        id: `aud-post-${input.postingId}`,
        branchId: input.branchId,
        sessionId: input.sessionId,
        actorUid: input.adminUid,
        actorRole: input.adminRole,
        action: 'STOCKTAKE_ZERO_VARIANCE_POSTED',
        summary: `Zero-variance stocktake approved & posted for ${zeroReads.length} matched items (0 synthetic ledger rows)`,
        createdAt: serverTimestamp(),
      });
      return { idempotentReplay: false, postedLedgerIds: [], zeroVarianceClosed: true };
    }

    const perItemReads = await Promise.all(
      input.adjustments.map(async (adj, idx) => {
        const movId = ledgerIds[idx];
        const itemRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId, 'items', adj.medicineId);
        const medRef = doc(db, 'branches', input.branchId, 'medicines', adj.medicineId);
        const lineRef = doc(db, 'branches', input.branchId, 'stocktake_financials', input.sessionId, 'lines', adj.medicineId);
        const ledRef = doc(db, 'branches', input.branchId, 'inventory_ledger', movId);
        const [itemSnap, medSnap, lineSnap, ledSnap] = await Promise.all([
          tx.get(itemRef),
          tx.get(medRef),
          tx.get(lineRef),
          tx.get(ledRef),
        ]);
        return { adj, movId, lineRef, itemSnap, medSnap, lineSnap, ledSnap };
      })
    );

    for (const row of perItemReads) {
      const { adj, movId, lineRef, itemSnap, medSnap, lineSnap, ledSnap } = row;
      if (ledSnap.exists()) {
        throw new Error(`DUPLICATE_LEDGER_MOVEMENT_DETECTED:${movId}`);
      }
      if (!itemSnap.exists()) {
        throw new Error(`STOCKTAKE_ITEM_NOT_FOUND:${adj.medicineId}`);
      }
      const itemData = itemSnap.data() as Record<string, unknown>;
      const itemState = String(itemData.state ?? '');
      if (
        String(itemData.branchId ?? '') !== input.branchId ||
        String(itemData.sessionId ?? '') !== input.sessionId ||
        (itemState !== 'COUNTED' && itemState !== 'VERIFIED') ||
        Number(itemData.countRevision ?? 0) < 1 ||
        itemData.activeLease != null ||
        String(itemData.syncStatus ?? 'CONFIRMED') !== 'CONFIRMED'
      ) {
        throw new Error(`ITEM_NOT_COUNTED_FOR_POSTING:${adj.medicineId}:${itemState}`);
      }
      if (adj.expectedCountRevision !== undefined && Number(itemData.countRevision) !== adj.expectedCountRevision) {
        throw new Error(`STALE_COUNT_REVISION:${adj.medicineId}`);
      }
      if (!medSnap.exists()) {
        throw new Error(`MEDICINE_NOT_FOUND_FOR_POSTING:${adj.medicineId}`);
      }
      const medData = medSnap.data() as Record<string, unknown>;
      if (String(medData.branchId ?? '') !== input.branchId) {
        throw new Error(`MEDICINE_BRANCH_MISMATCH:${adj.medicineId}`);
      }
      if (!lineSnap.exists()) {
        throw new Error(`FINANCIAL_LINE_MISSING_FOR_POSTING:${adj.medicineId}`);
      }
      const lineData = lineSnap.data() as Record<string, unknown>;
      const discStatus = String(lineData.discrepancyStatus ?? '');
      if (
        discStatus === 'NEEDS_REVIEW' ||
        discStatus === 'AMBIGUOUS_MOVEMENT' ||
        discStatus === 'INTEGRITY_BLOCKED' ||
        discStatus === 'NEEDS_RECOUNT' ||
        discStatus === 'REJECTED' ||
        discStatus === 'POSTED'
      ) {
        throw new Error(`FINANCIAL_LINE_NEEDS_REVIEW:${adj.medicineId}:${discStatus}`);
      }
      if (String(lineData.costStatus ?? '') === 'NEEDS_REVIEW' || Number(lineData.unresolvedBaseUnits ?? 0) > 0) {
        throw new Error(`AMBIGUOUS_HISTORICAL_COST_NEEDS_REVIEW:${adj.medicineId}:FINANCIAL_LINE_UNRESOLVED`);
      }
      const lineVariance = Number(lineData.varianceBaseUnits);
      if (!Number.isSafeInteger(lineVariance) || lineVariance !== adj.adjustmentBaseUnitsDelta) {
        throw new Error(`PER_ITEM_VARIANCE_MISMATCH:${adj.medicineId}:expected=${lineVariance}:got=${adj.adjustmentBaseUnitsDelta}`);
      }
      tx.update(lineRef, {
        discrepancyStatus: 'POSTED',
        updatedByUid: input.adminUid,
        updatedAt: serverTimestamp(),
      });
    }

    tx.set(aprRef, {
      id: input.approvalId,
      branchId: input.branchId,
      sessionId: input.sessionId,
      approvedByUid: input.adminUid,
      approvalReason: input.approvalReason.trim(),
      createdAt: serverTimestamp(),
    });

    tx.set(postRef, {
      id: input.postingId,
      branchId: input.branchId,
      sessionId: input.sessionId,
      approvalId: input.approvalId,
      postedByUid: input.adminUid,
      postedLedgerIds: ledgerIds,
      createdAt: serverTimestamp(),
    });

    for (let i = 0; i < input.adjustments.length; i++) {
      const adj = input.adjustments[i];
      const movId = ledgerIds[i];

      const ledRef = doc(db, 'branches', input.branchId, 'inventory_ledger', movId);
      const ledPayload = {
        id: movId,
        branchId: input.branchId,
        medicineId: adj.medicineId,
        type: 'ADJUSTMENT',
        unit: 'pill',
        quantityDelta: normalizeSafeInt(adj.adjustmentBaseUnitsDelta),
        baseUnitsDelta: adj.adjustmentBaseUnitsDelta,
        referenceId: input.sessionId,
        stocktakeSessionId: input.sessionId,
        stocktakePostingId: input.postingId,
        userId: input.adminUid,
        notes: `Phase 2F stocktake posting ${input.postingId}`,
        businessOccurredAtMs,
        createdAt: serverTimestamp(),
      };
      requireOperationalPayloadSafe(ledPayload, `inventory_ledger/${movId}`);
      tx.set(ledRef, ledPayload);

      const invFinRef = doc(db, 'branches', input.branchId, 'inventory_financials', movId);
      tx.set(invFinRef, {
        id: movId,
        branchId: input.branchId,
        movementId: movId,
        medicineId: adj.medicineId,
        movementType: 'ADJUSTMENT',
        costPerUnitExact: serializeRational(adj.costPerBaseUnitExact),
        costPerBaseUnitExact: serializeRational(adj.costPerBaseUnitExact),
        totalCostExact: serializeRational(adj.totalCostExact),
        costStatus: 'EXACT_RECONCILED',
        costProvenanceType: 'STOCKTAKE_V2_APPROVED_EXACT',
        sourceReferenceId: input.postingId,
        unresolvedBaseUnits: 0,
        reconciledByUid: input.adminUid,
        createdAt: serverTimestamp(),
      });
    }

    tx.update(finRef, {
      reconciliationStatus: 'POSTED',
      approvedByUid: input.adminUid,
      approvedAt: serverTimestamp(),
      postedByUid: input.adminUid,
      postedAt: serverTimestamp(),
      updatedByUid: input.adminUid,
      updatedAt: serverTimestamp(),
    });

    tx.update(sessRef, {
      status: 'POSTED',
      updatedAt: serverTimestamp(),
    });

    tx.set(auditRef, {
      id: `aud-post-${input.postingId}`,
      branchId: input.branchId,
      sessionId: input.sessionId,
      actorUid: input.adminUid,
      actorRole: input.adminRole,
      action: 'STOCKTAKE_LEDGER_POSTED',
      summary: `Posted ${ledgerIds.length} stocktake ledger adjustments idempotently`,
      createdAt: serverTimestamp(),
    });

    return { idempotentReplay: false, postedLedgerIds: ledgerIds };
  });
}

export async function transitionStocktakeSessionStatusTx(
  db: Firestore,
  params: {
    branchId: string;
    sessionId: string;
    targetStatus:
      | 'IN_PROGRESS'
      | 'RECONCILING'
      | 'NEEDS_REVIEW'
      | 'PENDING_APPROVAL'
      | 'APPROVED'
      | 'POSTED'
      | 'CLOSED'
      | 'CANCELLED';
    adminUid: string;
    actorRole?: StocktakeRole;
    cancellationReason?: string;
  }
): Promise<void> {
  assertValidId(params.branchId, 'branchId');
  assertValidId(params.sessionId, 'sessionId');
  assertValidId(params.adminUid, 'adminUid');
  const actorRole: StocktakeRole = params.actorRole ?? 'admin';

  const sessRef = doc(db, 'branches', params.branchId, 'stocktake_sessions_v2', params.sessionId);
  const finRef = doc(db, 'branches', params.branchId, 'stocktake_financials', params.sessionId);

  await runTransaction(db, async (tx) => {
    const needsFinCheck =
      params.targetStatus === 'PENDING_APPROVAL' ||
      params.targetStatus === 'APPROVED' ||
      params.targetStatus === 'POSTED' ||
      params.targetStatus === 'CLOSED';

    const [snap, finSnap] = await Promise.all([
      tx.get(sessRef),
      needsFinCheck ? tx.get(finRef) : Promise.resolve(null),
    ]);

    if (!snap.exists()) throw new Error('STOCKTAKE_SESSION_NOT_FOUND');
    const sessData = snap.data() as Record<string, unknown>;
    if (String(sessData.branchId ?? '') !== params.branchId) {
      throw new Error('CROSS_BRANCH_SESSION_MISMATCH');
    }
    const currentStatus = String(sessData.status ?? '') as StocktakeSessionLifecycleStatus;

    const gate = canTransitionStocktakeSessionState({
      from: currentStatus,
      to: params.targetStatus,
      actorRole,
      cancellationReason: params.cancellationReason,
    });
    if (!gate.allowed) {
      throw new Error(gate.reason || `INVALID_SESSION_TRANSITION:${currentStatus}->${params.targetStatus}`);
    }

    if (needsFinCheck) {
      if (!finSnap || !finSnap.exists()) {
        throw new Error(`FINANCIAL_SUMMARY_REQUIRED_FOR_TRANSITION:${params.targetStatus}`);
      }
      const finData = finSnap.data() as Record<string, unknown>;
      const finStatus = String(finData.reconciliationStatus ?? '');
      const unresolved = Number(finData.unresolvedItemsCount ?? 0);
      if (params.targetStatus === 'PENDING_APPROVAL' || params.targetStatus === 'APPROVED') {
        if (unresolved !== 0 || !['PENDING_APPROVAL', 'APPROVED', 'POSTED'].includes(finStatus)) {
          throw new Error(`FINANCIAL_NOT_READY_FOR_APPROVAL:${finStatus}:unresolved=${unresolved}`);
        }
      } else if (params.targetStatus === 'POSTED') {
        if (unresolved !== 0 || finStatus !== 'POSTED') {
          throw new Error(`FINANCIAL_MUST_BE_POSTED_FIRST:${finStatus}`);
        }
      } else if (params.targetStatus === 'CLOSED') {
        if (!['POSTED', 'CLOSED'].includes(finStatus)) {
          throw new Error(`FINANCIAL_MUST_BE_POSTED_BEFORE_CLOSE:${finStatus}`);
        }
      }
    }

    const patch: Record<string, unknown> = {
      status: params.targetStatus,
      updatedAt: serverTimestamp(),
    };
    if (params.targetStatus === 'CLOSED') {
      patch.closedAt = serverTimestamp();
    }
    if (params.targetStatus === 'CANCELLED') {
      patch.cancelledByUid = params.adminUid;
      patch.cancellationReason = params.cancellationReason!.trim();
    }
    requireOperationalPayloadSafe(patch, 'transitionStocktakeSessionStatusTx');
    tx.update(sessRef, patch);
  });
}

export async function loadAdminStocktakeSessionDetails(
  db: Firestore,
  branchId: string,
  sessionId: string
): Promise<{
  session: Record<string, unknown> | null;
  items: Array<Record<string, unknown>>;
  countEvents: Array<Record<string, unknown>>;
  financialSummary: Record<string, unknown> | null;
  financialLines: Array<Record<string, unknown>>;
}> {
  assertValidId(branchId, 'branchId');
  assertValidId(sessionId, 'sessionId');

  const sessRef = doc(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId);
  const itemsCol = collection(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId, 'items');
  const eventsCol = collection(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId, 'count_events');
  const finRef = doc(db, 'branches', branchId, 'stocktake_financials', sessionId);
  const linesCol = collection(db, 'branches', branchId, 'stocktake_financials', sessionId, 'lines');

  const [sessSnap, itemsSnap, eventsSnap, finSnap, linesSnap] = await Promise.all([
    getDoc(sessRef),
    getDocs(query(itemsCol, where('branchId', '==', branchId), where('sessionId', '==', sessionId))),
    getDocs(query(eventsCol, where('branchId', '==', branchId), where('sessionId', '==', sessionId))),
    getDoc(finRef),
    getDocs(query(linesCol, where('branchId', '==', branchId), where('sessionId', '==', sessionId))),
  ]);

  return {
    session: sessSnap.exists() ? (sessSnap.data() as Record<string, unknown>) : null,
    items: itemsSnap.docs.map((d) => d.data() as Record<string, unknown>),
    countEvents: eventsSnap.docs.map((d) => d.data() as Record<string, unknown>),
    financialSummary: finSnap.exists() ? (finSnap.data() as Record<string, unknown>) : null,
    financialLines: linesSnap.docs.map((d) => d.data() as Record<string, unknown>),
  };
}
