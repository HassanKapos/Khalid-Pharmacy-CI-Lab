/**
 * Phase 2F — Intelligent Continuous Stocktake
 * Temporary Lease & Collaborative Concurrency State Machine (Firestore Spark Compatible)
 *
 * Design Guarantees:
 * - Zero preassignment (no `stocktake_assignments`). Any authorized branch participant
 *   acquires an ephemeral, server-time-bounded lease directly on `stocktake_sessions_v2/{s}/items/{medicineId}`.
 * - All lease TTL comparisons use `serverNowMs` (Firestore `request.time` in Security Rules
 *   and server-synced timestamp inside `runTransaction`), NEVER raw device clocks alone.
 * - IMPORTANT PURE-FUNCTION BOUNDARY (Stage D Review — PR-F1):
 *   This module is a pure deterministic transition engine; `serverNowMs` is an injected
 *   clock parameter for deterministic unit verification and does NOT by itself enforce
 *   Firestore distributed concurrency or server timestamps. True authoritative server-time
 *   (`request.time`) and cross-device CAS atomicity are enforced by Firestore Security Rules
 *   (`firestore.rules` R3.2 + Phase 2F) and Firestore `runTransaction` in PR-F2
 *   (`src/services/stocktakeFirestoreService.ts`).
 * - Saved counts (`COUNTED` / `VERIFIED`) are NEVER overwritten by lease expiry or stale cleanup.
 * - Local-only reservations or `LOCAL_PENDING` / `SYNC_PENDING` counts NEVER mark an item
 *   as globally counted or remove it from the shared remaining list until shared persistence is `CONFIRMED`.
 * - Recount requests NEVER destroy prior `OperationalCountSubmissionEvent` records and NEVER
 *   clobber an active non-expired lease held by another employee.
 */

import {
  assertOperationalStocktakePayloadSafe,
  assertSharedOperationalItemSafe,
  buildStocktakeCountEventId,
  buildStocktakeCountIdempotencyKey,
  computeMovementWatermarkDigest,
  type OperationalCountSubmissionEvent,
  type OperationalStocktakeItem,
  type OperationalStocktakeLease,
  type StocktakeCountUnit,
  type StocktakeCountWatermark,
  type StocktakeRole,
} from './stocktakeContract.ts';

export const DEFAULT_STOCKTAKE_LEASE_TTL_MS = 90_000; // 90 seconds
export const MIN_STOCKTAKE_LEASE_TTL_MS = 30_000; // 30 seconds
export const MAX_STOCKTAKE_LEASE_TTL_MS = 300_000; // 5 minutes (<= 10m Firestore Rules ceiling)
export const MAX_STOCKTAKE_LEASE_CUMULATIVE_LIFETIME_MS = 1_800_000; // 30 minutes (matches firestore.rules)
export const MAX_STOCKTAKE_LEASE_RENEWALS = 5;

export type LeaseTransitionFailureCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED_ROLE'
  | 'CROSS_BRANCH_DENIED'
  | 'ITEM_ALREADY_COUNTED'
  | 'ITEM_ALREADY_VERIFIED'
  | 'LEASE_CONFLICT_ACTIVE'
  | 'LEASE_VERSION_MISMATCH'
  | 'LEASE_NOT_HELD'
  | 'LEASE_OWNED_BY_OTHER'
  | 'LEASE_EXPIRED'
  | 'LEASE_MAX_RENEWALS_EXCEEDED'
  | 'LEASE_LIFETIME_CAP_REACHED'
  | 'COUNT_ALREADY_CONFIRMED_PROTECTED'
  | 'ACTIVE_LEASE_MUST_EXPIRE_OR_BE_RELEASED'
  | 'ITEM_NOT_COUNTED_FOR_RECOUNT'
  | 'ITEM_NOT_COUNTED_FOR_VERIFY'
  | 'RECOUNT_REASON_REQUIRED'
  | 'INVALID_COUNT_UNIT'
  | 'INVALID_COUNT_QUANTITY'
  | 'INVALID_UNIT_CONVERSION'
  | 'INVALID_WATERMARK'
  | 'OFFLINE_SHARED_RESERVATION_FORBIDDEN'
  | 'FINANCIAL_FIELD_INJECTION_BLOCKED'
  | 'SHARED_ITEM_COUNT_LEAK_BLOCKED';

export type LeaseTransitionResult<T = OperationalStocktakeItem> =
  | {
      ok: true;
      item: T;
      idempotentReplay?: boolean;
      countEvent?: OperationalCountSubmissionEvent;
    }
  | {
      ok: false;
      code: LeaseTransitionFailureCode;
      message: string;
    };

function assertValidServerTime(serverNowMs: number): boolean {
  return Number.isFinite(serverNowMs) && serverNowMs > 0;
}

function clampLeaseTtl(ttlMs?: number): number {
  const raw = ttlMs ?? DEFAULT_STOCKTAKE_LEASE_TTL_MS;
  if (!Number.isFinite(raw)) return DEFAULT_STOCKTAKE_LEASE_TTL_MS;
  return Math.min(MAX_STOCKTAKE_LEASE_TTL_MS, Math.max(MIN_STOCKTAKE_LEASE_TTL_MS, Math.trunc(raw)));
}

export function isLeaseActiveAtServerTime(
  lease: OperationalStocktakeLease | null,
  serverNowMs: number
): boolean {
  if (!lease) return false;
  return serverNowMs <= lease.expiresAtServerMs;
}

export function isItemGloballyConfirmedCounted(item: OperationalStocktakeItem): boolean {
  return item.syncStatus === 'CONFIRMED' && (item.state === 'COUNTED' || item.state === 'VERIFIED');
}

function validateAndReturnOk(
  item: OperationalStocktakeItem,
  extra?: { idempotentReplay?: boolean; countEvent?: OperationalCountSubmissionEvent }
): LeaseTransitionResult {
  const itemCheck = assertSharedOperationalItemSafe(item);
  if (!itemCheck.valid) {
    return {
      ok: false,
      code: itemCheck.errors[0]?.startsWith('SHARED_ITEM_COUNT_LEAK_BLOCKED')
        ? 'SHARED_ITEM_COUNT_LEAK_BLOCKED'
        : 'FINANCIAL_FIELD_INJECTION_BLOCKED',
      message: itemCheck.errors.join('; '),
    };
  }
  if (extra?.countEvent) {
    const evtCheck = assertOperationalStocktakePayloadSafe(extra.countEvent);
    if (!evtCheck.valid) {
      return {
        ok: false,
        code: 'FINANCIAL_FIELD_INJECTION_BLOCKED',
        message: evtCheck.errors.join('; '),
      };
    }
  }
  return {
    ok: true,
    item,
    ...(extra?.idempotentReplay ? { idempotentReplay: true } : {}),
    ...(extra?.countEvent ? { countEvent: extra.countEvent } : {}),
  };
}

/**
 * Acquires (or idempotently re-reads) a temporary shared lease inside a Firestore
 * `runTransaction` on `stocktake_sessions_v2/{sessionId}/items/{medicineId}`.
 *
 * Rules/Transaction Preconditions:
 * - Requires online shared transaction (`isSharedOnlineTransaction === true`).
 *   A local-only reservation MUST NOT be treated as a confirmed shared reservation.
 * - Allowed only from `AVAILABLE`, `NEEDS_RECOUNT`, or `RESERVED` with an EXPIRED lease
 *   (or idempotent retry by the SAME owner with matching `leaseId`).
 * - Strictly increments `leaseVersion` on every new lease acquisition to defeat ABA races.
 */
export function acquireStocktakeItemLease(params: {
  item: OperationalStocktakeItem;
  actorUid: string;
  actorDisplayName: string;
  actorBranchId: string;
  deviceId: string;
  leaseId: string;
  expectedLeaseVersion: number;
  serverNowMs: number;
  isSharedOnlineTransaction: boolean;
  ttlMs?: number;
}): LeaseTransitionResult {
  const {
    item,
    actorUid,
    actorDisplayName,
    actorBranchId,
    deviceId,
    leaseId,
    expectedLeaseVersion,
    serverNowMs,
    isSharedOnlineTransaction,
  } = params;

  if (!isSharedOnlineTransaction) {
    return {
      ok: false,
      code: 'OFFLINE_SHARED_RESERVATION_FORBIDDEN',
      message: 'Cannot treat an offline/local reservation as a confirmed shared lease.',
    };
  }
  if (!actorUid.trim() || !leaseId.trim() || !deviceId.trim() || !assertValidServerTime(serverNowMs)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Invalid lease acquisition arguments.' };
  }
  if (actorBranchId !== item.branchId) {
    return { ok: false, code: 'CROSS_BRANCH_DENIED', message: 'Cross-branch lease acquisition denied.' };
  }
  if (item.syncStatus !== 'CONFIRMED') {
    return {
      ok: false,
      code: 'OFFLINE_SHARED_RESERVATION_FORBIDDEN',
      message: 'Shared lease requires globally CONFIRMED item state.',
    };
  }
  if (item.state === 'COUNTED') {
    return { ok: false, code: 'ITEM_ALREADY_COUNTED', message: 'Medicine is already counted in this session.' };
  }
  if (item.state === 'VERIFIED') {
    return { ok: false, code: 'ITEM_ALREADY_VERIFIED', message: 'Medicine count is already verified.' };
  }

  // Idempotent network-retry replay by same owner + device + leaseId while still active
  if (
    item.state === 'RESERVED' &&
    item.activeLease &&
    item.activeLease.leaseId === leaseId &&
    item.activeLease.ownerUid === actorUid &&
    item.activeLease.deviceId === deviceId &&
    (expectedLeaseVersion === item.leaseVersion || expectedLeaseVersion === item.leaseVersion - 1) &&
    isLeaseActiveAtServerTime(item.activeLease, serverNowMs)
  ) {
    return validateAndReturnOk(item, { idempotentReplay: true });
  }

  // Optimistic concurrency compare-and-swap on leaseVersion
  if (item.leaseVersion !== expectedLeaseVersion) {
    return {
      ok: false,
      code: 'LEASE_VERSION_MISMATCH',
      message: `Stale leaseVersion ${expectedLeaseVersion}; current server leaseVersion is ${item.leaseVersion}.`,
    };
  }

  // Active non-expired lease held by another participant (or another leaseId)
  if (item.state === 'RESERVED' && isLeaseActiveAtServerTime(item.activeLease, serverNowMs)) {
    return {
      ok: false,
      code: 'LEASE_CONFLICT_ACTIVE',
      message: 'Item is currently reserved by another active count lease.',
    };
  }

  const ttlMs = clampLeaseTtl(params.ttlMs);
  const nextLeaseVersion = item.leaseVersion + 1;
  const newLease: OperationalStocktakeLease = {
    leaseId,
    sessionId: item.sessionId,
    branchId: item.branchId,
    medicineId: item.medicineId,
    ownerUid: actorUid,
    ownerDisplayName: actorDisplayName || actorUid,
    deviceId,
    createdAtServerMs: serverNowMs,
    expiresAtServerMs: serverNowMs + ttlMs,
    leaseVersion: nextLeaseVersion,
    renewalCount: 0,
  };

  const nextItem: OperationalStocktakeItem = {
    ...item,
    state: 'RESERVED',
    activeLease: newLease,
    leaseVersion: nextLeaseVersion,
    updatedAtMs: serverNowMs,
  };

  return validateAndReturnOk(nextItem);
}

/**
 * Renews an active lease owned by the same actor before it expires.
 */
export function renewStocktakeItemLease(params: {
  item: OperationalStocktakeItem;
  actorUid: string;
  actorBranchId?: string;
  leaseId: string;
  expectedLeaseVersion: number;
  serverNowMs: number;
  ttlMs?: number;
}): LeaseTransitionResult {
  const { item, actorUid, actorBranchId, leaseId, expectedLeaseVersion, serverNowMs } = params;
  if (!assertValidServerTime(serverNowMs)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Invalid server timestamp.' };
  }
  if (actorBranchId !== undefined && actorBranchId !== item.branchId) {
    return { ok: false, code: 'CROSS_BRANCH_DENIED', message: 'Cross-branch lease renewal denied.' };
  }
  if (item.syncStatus !== 'CONFIRMED') {
    return {
      ok: false,
      code: 'OFFLINE_SHARED_RESERVATION_FORBIDDEN',
      message: 'Cannot renew a non-confirmed offline lease.',
    };
  }
  if (item.state !== 'RESERVED' || !item.activeLease) {
    return { ok: false, code: 'LEASE_NOT_HELD', message: 'No active lease exists to renew.' };
  }
  if (item.activeLease.ownerUid !== actorUid || item.activeLease.leaseId !== leaseId) {
    return { ok: false, code: 'LEASE_OWNED_BY_OTHER', message: 'Cannot renew a lease owned by another user/session.' };
  }
  if (item.leaseVersion !== expectedLeaseVersion || item.activeLease.leaseVersion !== item.leaseVersion) {
    return { ok: false, code: 'LEASE_VERSION_MISMATCH', message: 'Lease version changed concurrently.' };
  }
  if (!isLeaseActiveAtServerTime(item.activeLease, serverNowMs)) {
    return { ok: false, code: 'LEASE_EXPIRED', message: 'Lease has already expired at server time; re-acquire required.' };
  }
  if (item.activeLease.renewalCount >= MAX_STOCKTAKE_LEASE_RENEWALS) {
    return {
      ok: false,
      code: 'LEASE_MAX_RENEWALS_EXCEEDED',
      message: `Maximum renewals (${MAX_STOCKTAKE_LEASE_RENEWALS}) reached.`,
    };
  }

  const ttlMs = clampLeaseTtl(params.ttlMs);
  const maxCumulativeExpiresMs = item.activeLease.createdAtServerMs + MAX_STOCKTAKE_LEASE_CUMULATIVE_LIFETIME_MS;
  const cappedExpiresAtMs = Math.min(serverNowMs + ttlMs, maxCumulativeExpiresMs);
  if (cappedExpiresAtMs <= serverNowMs) {
    return {
      ok: false,
      code: 'LEASE_LIFETIME_CAP_REACHED',
      message: 'Cumulative 30-minute lease lifetime cap reached; re-acquire required.',
    };
  }

  // Per firestore.rules canRenewStocktakeV2Lease: renewal preserves leaseVersion and updates only activeLease & updatedAt.
  const nextItem: OperationalStocktakeItem = {
    ...item,
    activeLease: {
      ...item.activeLease,
      expiresAtServerMs: cappedExpiresAtMs,
      leaseVersion: item.leaseVersion,
      renewalCount: item.activeLease.renewalCount + 1,
    },
    updatedAtMs: serverNowMs,
  };
  return validateAndReturnOk(nextItem);
}

/**
 * Releases a held lease cleanly (e.g., user cancels counting dialog or Admin forces stale release).
 * NEVER overwrites a COUNTED or VERIFIED item!
 */
export function releaseStocktakeItemLease(params: {
  item: OperationalStocktakeItem;
  actorUid: string;
  actorRole: StocktakeRole;
  actorBranchId?: string;
  expectedLeaseVersion: number;
  serverNowMs: number;
}): LeaseTransitionResult {
  const { item, actorUid, actorRole, actorBranchId, expectedLeaseVersion, serverNowMs } = params;
  if (!assertValidServerTime(serverNowMs)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Invalid server timestamp.' };
  }
  if (actorBranchId !== undefined && actorBranchId !== item.branchId) {
    return { ok: false, code: 'CROSS_BRANCH_DENIED', message: 'Cross-branch lease release denied.' };
  }
  if (item.state === 'COUNTED' || item.state === 'VERIFIED') {
    return {
      ok: false,
      code: 'COUNT_ALREADY_CONFIRMED_PROTECTED',
      message: 'Saved/verified count cannot be released back to AVAILABLE via lease release.',
    };
  }
  if (item.state !== 'RESERVED' || !item.activeLease) {
    return validateAndReturnOk(item, { idempotentReplay: true });
  }
  if (item.leaseVersion !== expectedLeaseVersion) {
    return { ok: false, code: 'LEASE_VERSION_MISMATCH', message: 'Stale leaseVersion during release.' };
  }
  const isOwner = item.activeLease.ownerUid === actorUid;
  const isExpired = !isLeaseActiveAtServerTime(item.activeLease, serverNowMs);
  const isAdmin = actorRole === 'admin' || actorRole === 'super_admin';
  if (!isOwner && !isExpired && !isAdmin) {
    return {
      ok: false,
      code: 'LEASE_OWNED_BY_OTHER',
      message: 'Only lease owner, Branch Admin, or post-expiry cleanup can release this lease.',
    };
  }

  const returnState = item.countRevision > 0 ? 'NEEDS_RECOUNT' : 'AVAILABLE';
  const nextItem: OperationalStocktakeItem = {
    ...item,
    state: returnState,
    activeLease: null,
    leaseVersion: item.leaseVersion + 1,
    updatedAtMs: serverNowMs,
  };
  return validateAndReturnOk(nextItem);
}

/**
 * Stale Lease Cleanup (safe passive expiry sweep or transaction precondition).
 * CRITICAL INVARIANT (Section 8): NEVER overwrites a saved `COUNTED` or `VERIFIED` item
 * even if the original lease timestamp has long passed!
 */
export function expireStaleStocktakeLease(params: {
  item: OperationalStocktakeItem;
  serverNowMs: number;
}): LeaseTransitionResult {
  const { item, serverNowMs } = params;
  if (!assertValidServerTime(serverNowMs)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Invalid server timestamp.' };
  }
  if (item.state === 'COUNTED' || item.state === 'VERIFIED') {
    return {
      ok: false,
      code: 'COUNT_ALREADY_CONFIRMED_PROTECTED',
      message: 'Lease expiry is strictly a no-op once a count has been saved.',
    };
  }
  if (item.state !== 'RESERVED' || !item.activeLease) {
    return validateAndReturnOk(item, { idempotentReplay: true });
  }
  if (isLeaseActiveAtServerTime(item.activeLease, serverNowMs)) {
    return {
      ok: false,
      code: 'LEASE_CONFLICT_ACTIVE',
      message: 'Lease has not expired yet at server time.',
    };
  }

  const returnState = item.countRevision > 0 ? 'NEEDS_RECOUNT' : 'AVAILABLE';
  const nextItem: OperationalStocktakeItem = {
    ...item,
    state: returnState,
    activeLease: null,
    leaseVersion: item.leaseVersion + 1,
    updatedAtMs: serverNowMs,
  };
  return validateAndReturnOk(nextItem);
}

/**
 * Submits a physical count under an active, non-expired shared lease.
 * Produces BOTH the updated OperationalStocktakeItem (`state: 'COUNTED'`, `syncStatus: 'CONFIRMED'`)
 * AND an immutable append-only `OperationalCountSubmissionEvent`.
 */
export function submitCountUnderLease(params: {
  item: OperationalStocktakeItem;
  actorUid: string;
  actorDisplayName: string;
  actorBranchId: string;
  deviceId: string;
  leaseId: string;
  expectedLeaseVersion: number;
  countedQuantity: number;
  countUnit: StocktakeCountUnit;
  baseUnitsPerCountUnit: number;
  watermark: StocktakeCountWatermark;
  serverNowMs: number;
  notes?: string;
  /** Optional caller-owned existing count_event for idempotent retry verification */
  existingConfirmedEvent?: OperationalCountSubmissionEvent | null;
}): LeaseTransitionResult {
  const {
    item,
    actorUid,
    actorDisplayName,
    actorBranchId,
    deviceId,
    leaseId,
    expectedLeaseVersion,
    countedQuantity,
    countUnit,
    baseUnitsPerCountUnit,
    watermark,
    serverNowMs,
  } = params;

  if (!actorUid.trim() || !leaseId.trim() || !deviceId.trim() || !assertValidServerTime(serverNowMs)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Invalid count submission arguments or server timestamp.' };
  }
  if (actorBranchId !== item.branchId) {
    return { ok: false, code: 'CROSS_BRANCH_DENIED', message: 'Cross-branch count submission denied.' };
  }
  if (item.syncStatus !== 'CONFIRMED') {
    return {
      ok: false,
      code: 'OFFLINE_SHARED_RESERVATION_FORBIDDEN',
      message: 'Shared count submission requires globally CONFIRMED item state.',
    };
  }
  if (!Number.isFinite(countedQuantity) || countedQuantity < 0 || !Number.isInteger(countedQuantity)) {
    return {
      ok: false,
      code: 'INVALID_COUNT_QUANTITY',
      message: 'Counted quantity must be a non-negative integer in the selected count unit.',
    };
  }
  if (!item.availableUnits.includes(countUnit)) {
    return {
      ok: false,
      code: 'INVALID_COUNT_UNIT',
      message: `Unit "${countUnit}" is not enabled for medicine ${item.medicineId}.`,
    };
  }
  if (!Number.isSafeInteger(baseUnitsPerCountUnit) || baseUnitsPerCountUnit <= 0) {
    return {
      ok: false,
      code: 'INVALID_UNIT_CONVERSION',
      message: 'baseUnitsPerCountUnit must be a positive safe integer.',
    };
  }

  // Idempotent retry detection: verified strictly via caller's OWN existingConfirmedEvent
  // (shared item doc intentionally holds ZERO counter UID or countEventId per OD-4 / Fix A).
  const expectedNextRevision = item.countRevision + 1;
  const existingEv = params.existingConfirmedEvent ?? null;
  if (
    item.state === 'COUNTED' &&
    item.countRevision >= 1 &&
    item.leaseVersion === expectedLeaseVersion + 1 &&
    existingEv &&
    existingEv.actorUid === actorUid &&
    existingEv.leaseId === leaseId &&
    existingEv.countedQuantity === countedQuantity &&
    existingEv.countUnit === countUnit &&
    existingEv.eventId ===
      buildStocktakeCountEventId({
        sessionId: item.sessionId,
        medicineId: item.medicineId,
        countRevision: item.countRevision,
      })
  ) {
    return validateAndReturnOk(item, { idempotentReplay: true, countEvent: existingEv });
  }

  if (item.state !== 'RESERVED' || !item.activeLease) {
    return { ok: false, code: 'LEASE_NOT_HELD', message: 'Active lease is required before submitting count.' };
  }
  if (item.activeLease.ownerUid !== actorUid || item.activeLease.leaseId !== leaseId) {
    return { ok: false, code: 'LEASE_OWNED_BY_OTHER', message: 'Lease belongs to a different actor or leaseId.' };
  }
  if (item.leaseVersion !== expectedLeaseVersion) {
    return { ok: false, code: 'LEASE_VERSION_MISMATCH', message: 'Stale leaseVersion on submit.' };
  }
  if (!isLeaseActiveAtServerTime(item.activeLease, serverNowMs)) {
    return {
      ok: false,
      code: 'LEASE_EXPIRED',
      message: 'Lease expired before submission; re-acquire lease and verify count.',
    };
  }

  if (
    !watermark ||
    !assertValidServerTime(watermark.countBusinessAtMs) ||
    !assertValidServerTime(watermark.localPersistedAtMs) ||
    !Array.isArray(watermark.knownMovementIdsAtCount) ||
    watermark.knownMovementCount !== watermark.knownMovementIdsAtCount.length ||
    watermark.watermarkDigest !== computeMovementWatermarkDigest(watermark.knownMovementIdsAtCount)
  ) {
    return {
      ok: false,
      code: 'INVALID_WATERMARK',
      message: 'Count watermark failed integrity verification (timestamps, count, or digest mismatch).',
    };
  }

  const countedBaseUnits = countedQuantity * baseUnitsPerCountUnit;
  if (!Number.isSafeInteger(countedBaseUnits) || countedBaseUnits < 0) {
    return { ok: false, code: 'INVALID_COUNT_QUANTITY', message: 'Counted base units overflow safe integer range.' };
  }

  const eventId = buildStocktakeCountEventId({
    sessionId: item.sessionId,
    medicineId: item.medicineId,
    countRevision: expectedNextRevision,
  });
  const idempotencyKey = buildStocktakeCountIdempotencyKey({
    branchId: item.branchId,
    sessionId: item.sessionId,
    medicineId: item.medicineId,
    countRevision: expectedNextRevision,
    leaseVersion: expectedLeaseVersion,
    actorUid,
  });

  const confirmedWatermark: StocktakeCountWatermark = {
    ...watermark,
    serverConfirmedAtMs: serverNowMs,
  };

  const countEvent: OperationalCountSubmissionEvent = {
    eventId,
    idempotencyKey,
    sessionId: item.sessionId,
    branchId: item.branchId,
    medicineId: item.medicineId,
    countRevision: expectedNextRevision,
    leaseId,
    leaseVersion: expectedLeaseVersion,
    countedQuantity,
    countUnit,
    baseUnitsPerCountUnit,
    countedBaseUnits,
    actorUid,
    actorDisplayName: actorDisplayName || actorUid,
    deviceId,
    watermark: confirmedWatermark,
    syncStatus: 'CONFIRMED',
    recountOfEventId:
      item.countRevision > 0
        ? buildStocktakeCountEventId({
            sessionId: item.sessionId,
            medicineId: item.medicineId,
            countRevision: item.countRevision,
          })
        : null,
    notes: (params.notes || '').slice(0, 500),
  };

  const nextItem: OperationalStocktakeItem = {
    ...item,
    state: 'COUNTED',
    syncStatus: 'CONFIRMED',
    activeLease: null,
    leaseVersion: item.leaseVersion + 1,
    countRevision: expectedNextRevision,
    recountReason: null,
    operationalDiscrepancyFlag: false,
    updatedAtMs: serverNowMs,
  };

  return validateAndReturnOk(nextItem, { countEvent });
}

/**
 * Admin / Super Admin requests a recount on a COUNTED/VERIFIED item WITHOUT destroying
 * the previous count_event (`countRevision` remains preserved for deterministic
 * `recountOfEventId` chaining when the new count is submitted).
 * Strictly blocks if another employee currently holds an active unexpired lease.
 */
export function requestStocktakeRecount(params: {
  item: OperationalStocktakeItem;
  actorUid: string;
  actorRole: StocktakeRole;
  actorBranchId: string;
  reason: string;
  serverNowMs: number;
}): LeaseTransitionResult {
  const { item, actorRole, actorBranchId, reason, serverNowMs } = params;
  if (!assertValidServerTime(serverNowMs)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Invalid server timestamp.' };
  }
  if (actorRole !== 'admin' && actorRole !== 'super_admin') {
    return {
      ok: false,
      code: 'UNAUTHORIZED_ROLE',
      message: 'Only Branch Admin or Super Admin can request a recount.',
    };
  }
  if (actorBranchId !== item.branchId) {
    return { ok: false, code: 'CROSS_BRANCH_DENIED', message: 'Cross-branch recount request denied.' };
  }
  if (!reason || reason.trim().length < 3) {
    return {
      ok: false,
      code: 'RECOUNT_REASON_REQUIRED',
      message: 'A recount reason (>= 3 chars) is mandatory.',
    };
  }
  if (item.state === 'RESERVED' && isLeaseActiveAtServerTime(item.activeLease, serverNowMs)) {
    return {
      ok: false,
      code: 'ACTIVE_LEASE_MUST_EXPIRE_OR_BE_RELEASED',
      message: 'Cannot start recount while another employee holds an active lease.',
    };
  }
  if (item.state !== 'COUNTED' && item.state !== 'VERIFIED') {
    return {
      ok: false,
      code: 'ITEM_NOT_COUNTED_FOR_RECOUNT',
      message: `Recount requires an existing COUNTED/VERIFIED item (current state: ${item.state}).`,
    };
  }

  // Preserves countRevision & latestCountEventId so next submission links recountOfEventId!
  const nextItem: OperationalStocktakeItem = {
    ...item,
    state: 'NEEDS_RECOUNT',
    activeLease: null,
    leaseVersion: item.leaseVersion + 1,
    recountReason: reason.trim().slice(0, 500),
    operationalDiscrepancyFlag: true,
    updatedAtMs: serverNowMs,
  };
  return validateAndReturnOk(nextItem);
}

/**
 * Admin / Super Admin verifies a COUNTED item after reconciliation passes.
 */
export function verifyStocktakeItemCount(params: {
  item: OperationalStocktakeItem;
  actorRole: StocktakeRole;
  actorBranchId: string;
  serverNowMs: number;
}): LeaseTransitionResult {
  const { item, actorRole, actorBranchId, serverNowMs } = params;
  if (!assertValidServerTime(serverNowMs)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Invalid server timestamp.' };
  }
  if (actorRole !== 'admin' && actorRole !== 'super_admin') {
    return { ok: false, code: 'UNAUTHORIZED_ROLE', message: 'Only Admin/Super Admin can verify counts.' };
  }
  if (actorBranchId !== item.branchId) {
    return { ok: false, code: 'CROSS_BRANCH_DENIED', message: 'Cross-branch verification denied.' };
  }
  if (item.state !== 'COUNTED' || item.syncStatus !== 'CONFIRMED' || item.countRevision < 1 || item.activeLease !== null) {
    return {
      ok: false,
      code: 'ITEM_NOT_COUNTED_FOR_VERIFY',
      message: 'Only CONFIRMED COUNTED items with countRevision >= 1 and no active lease can be marked VERIFIED.',
    };
  }
  const nextItem: OperationalStocktakeItem = {
    ...item,
    state: 'VERIFIED',
    activeLease: null,
    leaseVersion: item.leaseVersion + 1,
    recountReason: null,
    operationalDiscrepancyFlag: false,
    updatedAtMs: serverNowMs,
  };
  return validateAndReturnOk(nextItem);
}
