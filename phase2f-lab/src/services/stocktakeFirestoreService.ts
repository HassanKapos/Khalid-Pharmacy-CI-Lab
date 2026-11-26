/**
 * Phase 2F — PR-F2: Real Firestore & Inventory Ledger Integration Adapter (Spark Zero-Cost)
 *
 * Bridges the pure Phase 2F foundation (`stocktakeContract.ts`, `stocktakeReconciliationEngine.ts`)
 * to live Firestore `runTransaction` calls enforcing:
 * - True Firestore `request.time` server-time CAS lease concurrency (no client-clock trust).
 * - Strict Domain A (operational blind) vs Domain B (`stocktake_financials` Admin-only) separation.
 * - Atomic count submission (`count_events` + `items` + `operational_audit`).
 * - Idempotent Admin approval & ledger posting (`approvals` + `postings` + `inventory_ledger` + `inventory_financials`).
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
  assertOperationalStocktakePayloadSafe,
  assertSharedOperationalItemSafe,
  type OperationalCountSubmissionEvent,
  buildCashierOwnConfirmedCountsView,
  buildRemainingMedicinesPublicView,
  buildStocktakeAdjustmentLedgerId,
  buildStocktakeCountEventId,
  buildStocktakeCountIdempotencyKey,
  computeMovementWatermarkDigest,
  type CashierOwnConfirmedCountView,
  type OperationalStocktakeItem,
  type RemainingMedicinePublicView,
  type StocktakeCountUnit,
  type StocktakeRole,
} from './stocktakeContract.ts';
import type { Rational } from './exactFinance.ts';

function serializeRational(r: Rational | null | undefined): { num: string; den: string } | null {
  if (!r) return null;
  return { num: r.num.toString(), den: r.den.toString() };
}

function requireOperationalPayloadSafe(payload: unknown, label: string): void {
  const res = assertOperationalStocktakePayloadSafe(payload);
  if (!res.valid) {
    throw new Error(
      `FORBIDDEN_OPERATIONAL_PAYLOAD (${label}): ${res.forbiddenFieldsFound.join(", ") || res.errors.join("; ") || "invalid payload"}`
    );
  }
}

function requireSharedOperationalItemSafe(payload: unknown, label: string): void {
  const res = assertSharedOperationalItemSafe(payload);
  if (!res.valid) {
    throw new Error(
      `SHARED_ITEM_SAFETY_VIOLATION (${label}): ${res.forbiddenFieldsFound.join(", ") || res.errors.join("; ") || "invalid item payload"}`
    );
  }
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
    primaryBarcode?: string;
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
  const itemDoc: Record<string, unknown> = {
    id: item.medicineId,
    sessionId: input.sessionId,
    branchId: input.branchId,
    medicineId: item.medicineId,
    medicineName: item.medicineName,
    ...(item.primaryBarcode ? { primaryBarcode: item.primaryBarcode } : {}),
    ...(item.availableUnits ? { availableUnits: item.availableUnits } : {}),
    state: 'AVAILABLE',
    syncStatus: 'CONFIRMED',
    activeLease: null,
    leaseVersion: 0,
    countRevision: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  requireOperationalPayloadSafe(itemDoc, `createStocktakeV2Item:${item.medicineId}`);
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
  if (!input.items || input.items.length === 0) {
    throw new Error('EMPTY_STOCKTAKE_SESSION_ITEMS');
  }
  const seenIds = new Set<string>();
  for (const item of input.items) {
    if (seenIds.has(item.medicineId)) {
      throw new Error(`DUPLICATE_MEDICINE_ID_IN_SESSION:${item.medicineId}`);
    }
    seenIds.add(item.medicineId);
  }

  const sessRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId);
  const existingSess = await getDoc(sessRef);

  if (existingSess.exists()) {
    const existingData = existingSess.data() as Record<string, unknown>;
    const existingStatus = String(existingData.status ?? '');
    if (existingStatus === 'IN_PROGRESS') {
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

    // Recover incomplete DRAFT session idempotently: write ONLY missing items in bounded batches.
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

    // Verify 100% completeness before activating DRAFT -> IN_PROGRESS
    const verifySnap = await getDocs(
      query(itemsCol, where('branchId', '==', input.branchId), where('sessionId', '==', input.sessionId))
    );
    if (verifySnap.size < input.items.length) {
      throw new Error(`INCOMPLETE_SESSION_RECOVERY:${verifySnap.size}/${input.items.length}`);
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
    sessionNumber: input.sessionNumber,
    schemaVersion: 2,
    scopeMode: input.scopeMode,
    status: 'DRAFT',
    totalTargetItems: input.items.length,
    confirmedCountedItems: 0,
    remainingItemsCount: input.items.length,
    recountRequestedItemsCount: 0,
    verifiedItemsCount: 0,
    createdByUid: input.adminUid,
    createdByName: input.adminDisplayName,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  requireOperationalPayloadSafe(sessionDoc, 'createStocktakeV2Session');

  if (input.simulateCrashAfterDraftCreate) {
    // Write ONLY DRAFT session and abort before creating items (tests crash safety!)
    await setDoc(sessRef, sessionDoc);
    throw new Error('SIMULATED_CRASH_AFTER_DRAFT_CREATE');
  }

  if (input.items.length <= MAX_ATOMIC_SESSION_INIT_ITEMS) {
    // Single atomic all-or-nothing batch for session (DRAFT) + ALL items!
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

  // Large session (> 400 items): create DRAFT first, populate in recoverable atomic chunks, then activate.
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
 * with mandatory audit reason & cancelledByUid so it can never become usable.
 */
export async function abortDraftStocktakeSessionTx(
  db: Firestore,
  branchId: string,
  sessionId: string,
  adminUid: string,
  reason: string
): Promise<void> {
  if (!reason || reason.trim().length < 3) {
    throw new Error('CANCELLATION_REASON_REQUIRED');
  }
  const sessRef = doc(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(sessRef);
    if (!snap.exists()) throw new Error('SESSION_NOT_FOUND');
    const st = String(snap.data().status ?? '');
    if (st !== 'DRAFT') {
      throw new Error(`CANNOT_ABORT_NON_DRAFT_SESSION:${st}`);
    }
    tx.update(sessRef, {
      status: 'CANCELLED',
      cancelledByUid: adminUid,
      cancellationReason: reason.trim(),
      updatedAt: serverTimestamp(),
    });
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
  | { ok: true; leaseVersion: number; leaseId: string }
  | { ok: false; code: 'ITEM_NOT_FOUND' | 'ALREADY_COUNTED' | 'LEASE_CONFLICT_ACTIVE' };

export async function acquireStocktakeLeaseTx(
  db: Firestore,
  input: AcquireLeaseTxInput
): Promise<AcquireLeaseTxResult> {
  const ttlMs = input.ttlMs ?? 90_000;
  if (ttlMs < 500 || ttlMs > 540_000) {
    throw new Error(`INVALID_LEASE_TTL_MS:${ttlMs}`);
  }
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
      const snap = await tx.get(itemRef);
      if (!snap.exists()) {
        return { ok: false, code: 'ITEM_NOT_FOUND' };
      }
      const data = snap.data() as Record<string, unknown>;
      const state = String(data.state ?? '');
      if (state === 'COUNTED' || state === 'VERIFIED') {
        return { ok: false, code: 'ALREADY_COUNTED' };
      }
      const prevLease = (data.activeLease ?? null) as
        | { ownerUid: string; expiresAt: Timestamp }
        | null;
      const proposedClientNowMs = Date.now() + (input.clientClockOffsetMs ?? 0);
      const serverDocFloorMs = (data.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0;
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
        return {
          ok: false,
          code: 'LEASE_CONFLICT_ACTIVE',
        };
      }

      const nextVersion = Number(data.leaseVersion ?? 0) + 1;
      const patch = {
        state: 'RESERVED',
        leaseVersion: nextVersion,
        activeLease: {
          leaseId: input.leaseId,
          ownerUid: input.actorUid,
          ownerDisplayName: input.actorDisplayName,
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
      return { ok: true, leaseVersion: nextVersion, leaseId: input.leaseId };
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? '';
    if (
      code === 'permission-denied' ||
      code === 'aborted' ||
      code === 'failed-precondition'
    ) {
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
  clientClockOffsetMs?: number
): Promise<{ ok: true; renewalCount: number } | { ok: false; code: string }> {
  if (ttlMs < 500 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new Error(`INVALID_LEASE_TTL_MS:${ttlMs}`);
  }
  const itemRef = doc(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId, 'items', medicineId);
  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(itemRef);
      if (!snap.exists()) return { ok: false, code: 'ITEM_NOT_FOUND' };
      const data = snap.data() as Record<string, unknown>;
      const lease = data.activeLease as
        | {
            leaseId: string;
            ownerUid: string;
            createdAt: Timestamp;
            expiresAt: Timestamp;
            renewalCount: number;
            [k: string]: unknown;
          }
        | null;
      if (data.state !== 'RESERVED' || !lease || lease.ownerUid !== actorUid) {
        return { ok: false, code: 'NOT_LEASE_OWNER' };
      }
      const nextRenewal = Number(lease.renewalCount ?? 0) + 1;
      if (nextRenewal > MAX_LEASE_RENEWALS) {
        return { ok: false, code: 'LEASE_RENEWAL_LIMIT_REACHED' };
      }
      const createdAtMs = lease.createdAt?.toMillis?.() ?? Date.now();
      const maxAllowedExpiresMs = createdAtMs + MAX_CUMULATIVE_LEASE_LIFETIME_MS;
      const proposedClientNowMs = Date.now() + (clientClockOffsetMs ?? 0);
      const serverAnchorFloorMs =
        clientClockOffsetMs !== undefined
          ? proposedClientNowMs
          : Math.max(proposedClientNowMs, (data.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0);
      const proposedExpiresMs =
        clientClockOffsetMs !== undefined
          ? serverAnchorFloorMs + ttlMs
          : Math.min(serverAnchorFloorMs + ttlMs, maxAllowedExpiresMs);
      if (proposedExpiresMs <= serverAnchorFloorMs) {
        return { ok: false, code: 'LEASE_LIFETIME_CAP_REACHED' };
      }
      tx.update(itemRef, {
        activeLease: {
          ...lease,
          renewalCount: nextRenewal,
          expiresAt: Timestamp.fromMillis(proposedExpiresMs),
        },
        updatedAt: serverTimestamp(),
      });
      return { ok: true, renewalCount: nextRenewal };
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code ?? '';
    if (
      code === 'permission-denied' ||
      code === 'aborted' ||
      code === 'failed-precondition'
    ) {
      return { ok: false, code: 'LEASE_EXPIRED_OR_CONFLICT' };
    }
    throw err;
  }
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
            createdAtServerMs: lease.createdAt?.toMillis?.() ?? 0,
            expiresAtServerMs: lease.expiresAt?.toMillis?.() ?? 0,
            leaseVersion: Number(lease.leaseVersion ?? 1),
            renewalCount: Number(lease.renewalCount ?? 0),
          }
        : null,
      leaseVersion: Number(data.leaseVersion ?? 0),
      countRevision: Number(data.countRevision ?? 0),
      recountReason: typeof data.recountReason === 'string' ? data.recountReason : null,
      operationalDiscrepancyFlag:
        (data.operationalDiscrepancyFlag as OperationalStocktakeItem['operationalDiscrepancyFlag']) ?? 'NONE',
      updatedAtMs: (data.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0,
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
        serverConfirmedAtMs: (data.createdAt as Timestamp | undefined)?.toMillis?.() ?? null,
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
  /** Preserved offline physical count timestamp (OD-2F-1 / OD-2F-2); defaults to Date.now() when online */
  countBusinessAtMs?: number;
  /** Preserved offline local persistence timestamp (OD-2F-1 / OD-2F-2); defaults to Date.now() when online */
  localPersistedAtMs?: number;
  notes?: string;
}

export async function submitStocktakeCountTx(
  db: Firestore,
  input: SubmitCountTxInput
): Promise<{ eventId: string; countRevision: number; countedBaseUnits: number }> {
  const itemRef = doc(
    db,
    'branches',
    input.branchId,
    'stocktake_sessions_v2',
    input.sessionId,
    'items',
    input.medicineId
  );

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(itemRef);
    if (!snap.exists()) throw new Error('ITEM_NOT_FOUND');
    const item = snap.data() as Record<string, unknown>;
    const lease = item.activeLease as { leaseId: string; ownerUid: string } | null;
    if (item.state !== 'RESERVED' || !lease || lease.ownerUid !== input.actorUid) {
      throw new Error('ACTIVE_LEASE_REQUIRED_FOR_COUNT_SUBMISSION');
    }

    const nextCountRev = Number(item.countRevision ?? 0) + 1;
    const prevLeaseVer = Number(item.leaseVersion ?? 1);
    const countedBaseUnits = Math.round(input.countedQuantity * input.baseUnitsPerCountUnit);
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

    const eventPayload = {
      eventId,
      idempotencyKey,
      sessionId: input.sessionId,
      branchId: input.branchId,
      medicineId: input.medicineId,
      countRevision: nextCountRev,
      leaseId: lease.leaseId,
      leaseVersion: prevLeaseVer,
      countedQuantity: input.countedQuantity,
      countUnit: input.countUnit,
      baseUnitsPerCountUnit: input.baseUnitsPerCountUnit,
      countedBaseUnits,
      actorUid: input.actorUid,
      actorDisplayName: input.actorDisplayName,
      deviceId: input.deviceId,
      watermark: {
        countBusinessAtMs: input.countBusinessAtMs ?? nowMs,
        localPersistedAtMs: input.localPersistedAtMs ?? nowMs,
        knownMovementIdsAtCount: [...input.knownMovementIdsAtCount],
        knownMovementCount: input.knownMovementIdsAtCount.length,
        watermarkDigest: computeMovementWatermarkDigest(input.knownMovementIdsAtCount),
      },
      ...(Number(item.countRevision ?? 0) > 0
        ? {
            recountOfEventId: buildStocktakeCountEventId({
              sessionId: input.sessionId,
              medicineId: input.medicineId,
              countRevision: Number(item.countRevision ?? 0),
            }),
          }
        : {}),
      ...(input.notes ? { notes: input.notes } : {}),
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

    tx.set(eventRef, eventPayload);
    tx.update(itemRef, itemPatch);
    tx.set(auditRef, {
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
    });

    return { eventId, countRevision: nextCountRev, countedBaseUnits };
  });
}

export async function requestRecountAdminTx(
  db: Firestore,
  branchId: string,
  sessionId: string,
  medicineId: string,
  recountReason: string
): Promise<void> {
  const itemRef = doc(db, 'branches', branchId, 'stocktake_sessions_v2', sessionId, 'items', medicineId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(itemRef);
    if (!snap.exists()) throw new Error('ITEM_NOT_FOUND');
    const item = snap.data() as Record<string, unknown>;
    if (item.state !== 'COUNTED') throw new Error(`CANNOT_RECOUNT_STATE:${item.state}`);
    tx.update(itemRef, {
      state: 'NEEDS_RECOUNT',
      activeLease: null,
      leaseVersion: Number(item.leaseVersion ?? 0) + 1,
      recountReason,
      operationalDiscrepancyFlag: true,
      updatedAt: serverTimestamp(),
    });
  });
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
  lines: Array<{
    medicineId: string;
    expectedCurrentBaseUnits: number;
    systemCurrentBaseUnits: number;
    varianceBaseUnits: number;
    discrepancyStatus: string;
    financialVarianceExact: Rational | null;
  }>;
  auditId: string;
}

export async function persistAdminStocktakeReconciliationTx(
  db: Firestore,
  input: PersistFinancialReconciliationInput
): Promise<void> {
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
    const existing = await tx.get(finRef);
    if (!existing.exists()) {
      tx.set(finRef, {
        id: input.sessionId,
        branchId: input.branchId,
        sessionId: input.sessionId,
        reconciliationStatus: input.reconciliationStatus,
        totalExpectedValuationExact: serializeRational(input.totalExpectedValuationExact),
        totalSystemValuationExact: serializeRational(input.totalSystemValuationExact),
        netVarianceValuationExact: serializeRational(input.netVarianceValuationExact),
        unresolvedItemsCount: input.unresolvedItemsCount,
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
        unresolvedItemsCount: input.unresolvedItemsCount,
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
      tx.set(lineRef, {
        id: line.medicineId,
        branchId: input.branchId,
        sessionId: input.sessionId,
        medicineId: line.medicineId,
        expectedCurrentBaseUnits: line.expectedCurrentBaseUnits,
        systemCurrentBaseUnits: line.systemCurrentBaseUnits,
        varianceBaseUnits: line.varianceBaseUnits,
        discrepancyStatus: line.discrepancyStatus,
        financialVarianceExact: serializeRational(line.financialVarianceExact),
        updatedByUid: input.adminUid,
        updatedAt: serverTimestamp(),
      });
    }

    tx.set(auditRef, {
      id: input.auditId,
      branchId: input.branchId,
      sessionId: input.sessionId,
      actorUid: input.adminUid,
      actorRole: input.adminRole,
      action: 'STOCKTAKE_FINANCIAL_RECONCILED',
      summary: `Reconciled ${input.lines.length} items (status=${input.reconciliationStatus}, unresolved=${input.unresolvedItemsCount})`,
      createdAt: serverTimestamp(),
    });
  });
}

export interface ApproveAndPostAdjustmentInput {
  branchId: string;
  sessionId: string;
  adminUid: string;
  adminRole: 'admin' | 'super_admin';
  approvalId: string;
  postingId: string;
  approvalReason: string;
  /** Optional explicit movement-history verification flag (false fails closed -> NEEDS_REVIEW) */
  movementHistoryVerified?: boolean;
  adjustments: Array<{
    medicineId: string;
    adjustmentBaseUnitsDelta: number; // non-zero signed safe integer
    costPerBaseUnitExact: Rational;
    totalCostExact: Rational;
    /** Fix E: Explicit historical cost provenance status; NEEDS_REVIEW fails closed */
    costStatus?: 'EXACT_HISTORICAL' | 'EXACT_RECONCILED' | 'NEEDS_REVIEW';
  }>;
}

/**
 * Fix E — Atomic Inventory Ledger Posting enforcing ALL 10 Mandatory Pre-Posting Checks:
 *  1. Admin / Super Admin role + mandatory approval reason (>= 5 chars)
 *  2. Session existence, branch match, and eligible status (never DRAFT/CANCELLED/CLOSED/POSTED)
 *  3. Financial summary existence, eligible reconciliationStatus, and unresolvedItemsCount === 0
 *  4. Idempotent posting guard (existing posting -> replay; orphan ledger doc -> fail closed)
 *  5. Per-item operational doc existence, branch/session match, COUNTED/VERIFIED, countRevision >= 1, activeLease === null
 *  6. Per-item medicine master existence & branchId match
 *  7. Per-item financial line existence, non-NEEDS_REVIEW discrepancyStatus, exact per-item variance match
 *  8. Zero synthetic movements (zero-delta / non-integer / duplicate medicineId rejected)
 *  9. Exact historical cost provenance check (NEEDS_REVIEW or delta*unitCost != totalCost fails closed — zero buyPrice fallback)
 * 10. Verified movement-history completeness gate + strict Domain A (zero-cost inventory_ledger) / Domain B separation.
 */
export async function approveAndPostStocktakeAdjustmentTx(
  db: Firestore,
  input: ApproveAndPostAdjustmentInput
): Promise<{ idempotentReplay: boolean; postedLedgerIds: string[] }> {
  if (input.adminRole !== 'admin' && input.adminRole !== 'super_admin') {
    throw new Error('UNAUTHORIZED_POSTING_ROLE');
  }
  if (!input.approvalReason || input.approvalReason.trim().length < 5) {
    throw new Error('APPROVAL_REASON_REQUIRED');
  }
  if (input.movementHistoryVerified === false) {
    throw new Error('INCOMPLETE_MOVEMENT_HISTORY_NEEDS_REVIEW');
  }
  if (!Array.isArray(input.adjustments) || input.adjustments.length === 0) {
    throw new Error('EMPTY_ADJUSTMENT_LIST_FORBIDDEN');
  }

  const seenMeds = new Set<string>();
  for (const adj of input.adjustments) {
    if (!adj.medicineId || seenMeds.has(adj.medicineId)) {
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
  }

  const sessRef = doc(db, 'branches', input.branchId, 'stocktake_sessions_v2', input.sessionId);
  const finRef = doc(db, 'branches', input.branchId, 'stocktake_financials', input.sessionId);
  const aprRef = doc(db, 'branches', input.branchId, 'stocktake_financials', input.sessionId, 'approvals', input.approvalId);
  const postRef = doc(db, 'branches', input.branchId, 'stocktake_financials', input.sessionId, 'postings', input.postingId);
  const auditRef = doc(db, 'branches', input.branchId, 'stocktake_financials', input.sessionId, 'financial_audit', `aud-post-${input.postingId}`);

  return runTransaction(db, async (tx) => {
    const ledgerIds = input.adjustments.map((adj) =>
      buildStocktakeAdjustmentLedgerId({
        branchId: input.branchId,
        sessionId: input.sessionId,
        medicineId: adj.medicineId,
        reconciliationVersion: 1,
      })
    );

    const [sessSnap, finSnap, postSnap] = await Promise.all([
      tx.get(sessRef),
      tx.get(finRef),
      tx.get(postRef),
    ]);

    if (postSnap.exists()) {
      return { idempotentReplay: true, postedLedgerIds: ledgerIds };
    }

    if (!sessSnap.exists()) throw new Error('STOCKTAKE_SESSION_NOT_FOUND');
    const sessData = sessSnap.data() as Record<string, unknown>;
    if (String(sessData.branchId ?? '') !== input.branchId) {
      throw new Error('CROSS_BRANCH_SESSION_MISMATCH');
    }
    const sessStatus = String(sessData.status ?? '');
    if (sessStatus === 'DRAFT' || sessStatus === 'CANCELLED' || sessStatus === 'CLOSED' || sessStatus === 'POSTED') {
      throw new Error(`SESSION_NOT_ELIGIBLE_FOR_POSTING:${sessStatus}`);
    }

    if (!finSnap.exists()) throw new Error('STOCKTAKE_FINANCIAL_SUMMARY_MISSING');
    const finData = finSnap.data() as Record<string, unknown>;
    if (Number(finData.unresolvedItemsCount ?? 0) > 0) {
      throw new Error('CANNOT_POST_WITH_UNRESOLVED_ITEMS');
    }
    const recStatus = String(finData.reconciliationStatus ?? '');
    if (recStatus === 'NEEDS_REVIEW' || recStatus === 'POSTED' || recStatus === 'CLOSED') {
      throw new Error(`FINANCIAL_SUMMARY_NOT_ELIGIBLE_FOR_POSTING:${recStatus}`);
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
        return { adj, movId, itemSnap, medSnap, lineSnap, ledSnap };
      })
    );

    for (const row of perItemReads) {
      const { adj, movId, itemSnap, medSnap, lineSnap, ledSnap } = row;
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
        itemData.activeLease != null
      ) {
        throw new Error(`ITEM_NOT_COUNTED_FOR_POSTING:${adj.medicineId}:${itemState}`);
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
      if (discStatus === 'NEEDS_REVIEW' || discStatus === 'AMBIGUOUS_MOVEMENT' || discStatus === 'INTEGRITY_BLOCKED') {
        throw new Error(`FINANCIAL_LINE_NEEDS_REVIEW:${adj.medicineId}:${discStatus}`);
      }
      const lineVariance = Number(lineData.varianceBaseUnits);
      if (!Number.isSafeInteger(lineVariance) || lineVariance !== adj.adjustmentBaseUnitsDelta) {
        throw new Error(`PER_ITEM_VARIANCE_MISMATCH:${adj.medicineId}:expected=${lineVariance}:got=${adj.adjustmentBaseUnitsDelta}`);
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
        quantityDelta: adj.adjustmentBaseUnitsDelta,
        baseUnitsDelta: adj.adjustmentBaseUnitsDelta,
        referenceId: input.sessionId,
        stocktakeSessionId: input.sessionId,
        stocktakePostingId: input.postingId,
        userId: input.adminUid,
        notes: `Phase 2F stocktake posting ${input.postingId}`,
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

    if (sessStatus === 'APPROVED') {
      tx.update(sessRef, {
        status: 'POSTED',
        updatedAt: serverTimestamp(),
      });
    }

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
    cancellationReason?: string;
  }
): Promise<void> {
  const sessRef = doc(db, 'branches', params.branchId, 'stocktake_sessions_v2', params.sessionId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(sessRef);
    if (!snap.exists()) throw new Error('STOCKTAKE_SESSION_NOT_FOUND');
    const patch: Record<string, unknown> = {
      status: params.targetStatus,
      updatedAt: serverTimestamp(),
    };
    if (params.targetStatus === 'CLOSED') {
      patch.closedAt = serverTimestamp();
    }
    if (params.targetStatus === 'CANCELLED') {
      patch.cancelledByUid = params.adminUid;
      patch.cancellationReason = params.cancellationReason ?? 'Cancelled by Admin';
    }
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
