/**
 * Phase 2F — PR #54 (PR-F2) Level 3 Integration Suite
 *
 * LEVEL 3 CLASSIFICATION (HONESTY LABEL):
 *   Contract + Strict `firestore.rules` Rules-Mirror + In-Memory Transactional Firestore Harness.
 *   NOTE: This is NOT the live Java/Firebase Firestore Emulator (Level 4).
 *   Real Emulator verification is in `scripts/test-phase2f-firestore-integration-emulator.ts` (CI / Java required).
 *
 * Uses `scripts/helpers/firestore-mock-loader.mjs` so `src/services/stocktakeFirestoreService.ts`
 * runs unmodified with zero production test hooks.
 */
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { Timestamp, type Firestore } from 'firebase/firestore';

const LOADER_SYM = Symbol.for('khalid.phase2fFirestoreMockLoaderRegistered');
if (!(globalThis as Record<symbol, unknown>)[LOADER_SYM]) {
  register('./helpers/firestore-mock-loader.mjs', import.meta.url);
  (globalThis as Record<symbol, unknown>)[LOADER_SYM] = true;
}

import { createRational } from '../src/services/exactFinance.ts';
import {
  FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS,
  FORBIDDEN_SHARED_ITEM_COUNT_FIELDS,
  assertOperationalStocktakePayloadSafe,
  scanForForbiddenKeys,
} from '../src/services/stocktakeContract.ts';

// ---------------------------------------------------------------------------
// In-Memory Firestore Store + Strict `firestore.rules` Rules-Mirror Engine
// ---------------------------------------------------------------------------
const SERVER_TS_SENTINEL = Symbol.for('khalid.serverTimestampSentinel');

interface AuthCtx {
  uid: string;
  emailVerified: boolean;
}

interface StoredDoc {
  data: Record<string, unknown>;
  version: number;
}

class InMemoryFirestoreEngine {
  public serverNowMs = Date.now();
  private docs = new Map<string, StoredDoc>();
  private commitLock: Promise<void> = Promise.resolve();

  clear(): void {
    this.docs.clear();
  }

  seedRaw(path: string, data: Record<string, unknown>): void {
    this.docs.set(path, { data: cloneFirestoreValue(data, this.serverNowMs) as Record<string, unknown>, version: 1 });
  }

  getRaw(path: string): Record<string, unknown> | null {
    const entry = this.docs.get(path);
    return entry ? (cloneFirestoreValue(entry.data, this.serverNowMs) as Record<string, unknown>) : null;
  }

  createDbForActor(actor: AuthCtx): Firestore {
    return { __actor: actor, __engine: this } as unknown as Firestore;
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.commitLock;
    let release!: () => void;
    this.commitLock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  snapshotDocsMap(): Map<string, Record<string, unknown>> {
    const m = new Map<string, Record<string, unknown>>();
    for (const [k, v] of this.docs.entries()) {
      m.set(k, cloneFirestoreValue(v.data, this.serverNowMs) as Record<string, unknown>);
    }
    return m;
  }

  getDocVersion(path: string): number {
    return this.docs.get(path)?.version ?? 0;
  }

  applyRawCommit(writes: Array<{ path: string; data: Record<string, unknown> }>): void {
    for (const w of writes) {
      const prevVer = this.docs.get(w.path)?.version ?? 0;
      this.docs.set(w.path, {
        data: cloneFirestoreValue(w.data, this.serverNowMs) as Record<string, unknown>,
        version: prevVer + 1,
      });
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !(v instanceof Timestamp) &&
    !(v instanceof Date)
  );
}

function cloneFirestoreValue(val: unknown, serverNowMs: number): unknown {
  if (val === SERVER_TS_SENTINEL) {
    return Timestamp.fromMillis(serverNowMs);
  }
  if (val instanceof Timestamp) {
    return Timestamp.fromMillis(val.toMillis());
  }
  if (Array.isArray(val)) {
    return val.map((x) => cloneFirestoreValue(x, serverNowMs));
  }
  if (isPlainObject(val)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) {
        out[k] = cloneFirestoreValue(v, serverNowMs);
      }
    }
    return out;
  }
  return val;
}

function permissionDenied(reason: string): Error {
  return Object.assign(new Error(`7 PERMISSION_DENIED: ${reason}`), { code: 'permission-denied' });
}

function abortedError(reason: string): Error {
  return Object.assign(new Error(`10 ABORTED: ${reason}`), { code: 'aborted' });
}

function isValidIdRule(v: unknown): v is string {
  return typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
}

function isValidStrRule(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

function isValidRationalRule(r: unknown, allowNegative: boolean): boolean {
  if (!isPlainObject(r)) return false;
  if (typeof r.num !== 'string' || typeof r.den !== 'string') return false;
  if (!/^-?\d+$/.test(r.num) || !/^[1-9]\d*$/.test(r.den)) return false;
  if (!allowNegative && BigInt(r.num) < 0n) return false;
  return true;
}

function tsMs(v: unknown): number {
  return v instanceof Timestamp ? v.toMillis() : -1;
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(obj).every((k) => set.has(k));
}

function hasAllKeys(obj: Record<string, unknown>, required: string[]): boolean {
  return required.every((k) => k in obj);
}

function affectedKeys(prev: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const diff: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) {
      diff.push(k);
    }
  }
  return diff;
}

function getUserDoc(docs: Map<string, Record<string, unknown>>, uid: string): Record<string, unknown> | null {
  return docs.get(`users/${uid}`) ?? null;
}

function isBranchActiveRule(docs: Map<string, Record<string, unknown>>, branchId: string): boolean {
  const b = docs.get(`branches/${branchId}`);
  return Boolean(b && b.active === true);
}

function isAssignedUserRule(docs: Map<string, Record<string, unknown>>, uid: string, branchId: string): boolean {
  const u = getUserDoc(docs, uid);
  const b = docs.get(`branches/${branchId}`);
  if (!u || !b || u.active !== true) return false;
  const branchIds = Array.isArray(u.branchIds) ? (u.branchIds as string[]) : [];
  const memberUids = Array.isArray(b.memberUids) ? (b.memberUids as string[]) : [];
  return branchIds.includes(branchId) && (memberUids.includes(uid) || u.role === 'super_admin');
}

function isBranchAdminRule(docs: Map<string, Record<string, unknown>>, uid: string, branchId: string): boolean {
  const u = getUserDoc(docs, uid);
  if (!u || u.active !== true) return false;
  if (u.role === 'super_admin') return true;
  if (u.role !== 'admin') return false;
  const b = docs.get(`branches/${branchId}`);
  const branchIds = Array.isArray(u.branchIds) ? (u.branchIds as string[]) : [];
  const adminUids = Array.isArray(b?.adminUids) ? (b!.adminUids as string[]) : [];
  return branchIds.includes(branchId) && adminUids.includes(uid);
}

function evaluateReadRule(
  docs: Map<string, Record<string, unknown>>,
  auth: AuthCtx,
  path: string,
  isListQuery: boolean,
  whereFilters: Array<{ field: string; op: string; value: unknown }>
): boolean {
  if (!auth.uid || !auth.emailVerified) return false;
  const segs = path.split('/');
  if (segs[0] !== 'branches' || !isValidIdRule(segs[1])) return false;
  const branchId = segs[1];
  if (!isBranchActiveRule(docs, branchId)) return false;

  // branches/{branchId}/stocktake_sessions_v2/{sessionId}...
  if (segs[2] === 'stocktake_sessions_v2') {
    if (segs.length === 4) {
      return isValidIdRule(segs[3]) && isAssignedUserRule(docs, auth.uid, branchId);
    }
    if (segs.length === 6 && segs[4] === 'items') {
      return isAssignedUserRule(docs, auth.uid, branchId);
    }
    if (segs.length === 6 && segs[4] === 'count_events') {
      if (isBranchAdminRule(docs, auth.uid, branchId)) return true;
      if (!isAssignedUserRule(docs, auth.uid, branchId)) return false;
      if (isListQuery) {
        return whereFilters.some((w) => w.field === 'actorUid' && w.op === '==' && w.value === auth.uid);
      }
      const docData = docs.get(path);
      return Boolean(docData && docData.actorUid === auth.uid);
    }
    if (segs.length === 6 && segs[4] === 'operational_audit') {
      return isBranchAdminRule(docs, auth.uid, branchId);
    }
  }

  // branches/{branchId}/stocktake_financials/{sessionId}...
  if (segs[2] === 'stocktake_financials') {
    return isBranchAdminRule(docs, auth.uid, branchId);
  }

  if (segs[2] === 'medicines' || segs[2] === 'inventory_ledger') {
    return isAssignedUserRule(docs, auth.uid, branchId);
  }

  if (segs[2] === 'inventory_financials') {
    return isBranchAdminRule(docs, auth.uid, branchId);
  }

  return false;
}

function evaluateWriteRule(
  beforeDocs: Map<string, Record<string, unknown>>,
  afterDocs: Map<string, Record<string, unknown>>,
  auth: AuthCtx,
  nowMs: number,
  path: string,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | null
): string | null {
  if (!auth.uid || !auth.emailVerified) return 'UNVERIFIED_OR_UNAUTHENTICATED';
  const segs = path.split('/');
  if (segs[0] !== 'branches' || !isValidIdRule(segs[1])) return 'INVALID_BRANCH_PATH';
  const branchId = segs[1];
  if (!isBranchActiveRule(beforeDocs, branchId)) return 'BRANCH_INACTIVE';

  // 1) stocktake_sessions_v2/{sessionId}
  if (segs.length === 4 && segs[2] === 'stocktake_sessions_v2') {
    const sessionId = segs[3];
    if (!isValidIdRule(sessionId)) return 'INVALID_SESSION_ID';
    if (!isBranchAdminRule(beforeDocs, auth.uid, branchId)) return 'SESSION_WRITE_REQUIRES_ADMIN';
    if (!hasAllKeys(incoming, ['id', 'branchId', 'sessionNumber', 'schemaVersion', 'scopeMode', 'status', 'totalTargetItems', 'createdByUid', 'createdAt', 'updatedAt'])) {
      return 'SESSION_MISSING_REQUIRED_KEYS';
    }
    if (incoming.id !== sessionId || incoming.branchId !== branchId || incoming.schemaVersion !== 2) {
      return 'SESSION_IDENTITY_MISMATCH';
    }
    if (!existing) {
      if (incoming.status !== 'DRAFT') return 'SESSION_CREATE_MUST_BE_DRAFT';
      if (incoming.createdByUid !== auth.uid) return 'SESSION_CREATED_BY_MISMATCH';
      if (tsMs(incoming.createdAt) !== nowMs || tsMs(incoming.updatedAt) !== nowMs) return 'SESSION_CREATE_TIME_MISMATCH';
      return null;
    }
    if (tsMs(incoming.updatedAt) !== nowMs || tsMs(incoming.createdAt) !== tsMs(existing.createdAt)) {
      return 'SESSION_UPDATE_TIME_MISMATCH';
    }
    const s = String(existing.status ?? '');
    const t = String(incoming.status ?? '');
    const finPath = `branches/${branchId}/stocktake_financials/${sessionId}`;
    const finAfter = afterDocs.get(finPath);
    const finBefore = beforeDocs.get(finPath);
    const finReadyForApproval =
      finAfter != null &&
      ['PENDING_APPROVAL', 'APPROVED', 'POSTED'].includes(String(finAfter.reconciliationStatus ?? '')) &&
      Number(finAfter.unresolvedItemsCount ?? 0) === 0;
    const finPosted =
      finAfter != null &&
      finAfter.reconciliationStatus === 'POSTED' &&
      Number(finAfter.unresolvedItemsCount ?? 0) === 0 &&
      finAfter.approvedByUid != null &&
      finAfter.postedByUid === auth.uid;
    const finReadyForClose =
      finBefore != null &&
      ['POSTED', 'CLOSED'].includes(String(finBefore.reconciliationStatus ?? '')) &&
      tsMs(incoming.closedAt) === nowMs;
    const cancelOk =
      t === 'CANCELLED' &&
      ['DRAFT', 'IN_PROGRESS', 'RECONCILING', 'NEEDS_REVIEW', 'PENDING_APPROVAL', 'APPROVED'].includes(s) &&
      isValidStrRule(incoming.cancellationReason, 3, 500) &&
      incoming.cancelledByUid === auth.uid;
    const ok =
      cancelOk ||
      (s === 'DRAFT' && ['DRAFT', 'IN_PROGRESS'].includes(t)) ||
      (s === 'IN_PROGRESS' && ['IN_PROGRESS', 'RECONCILING'].includes(t)) ||
      (s === 'RECONCILING' && (['RECONCILING', 'NEEDS_REVIEW', 'IN_PROGRESS'].includes(t) || (t === 'PENDING_APPROVAL' && finReadyForApproval))) ||
      (s === 'NEEDS_REVIEW' && (['NEEDS_REVIEW', 'RECONCILING', 'IN_PROGRESS'].includes(t) || (t === 'PENDING_APPROVAL' && finReadyForApproval))) ||
      (s === 'PENDING_APPROVAL' && (['NEEDS_REVIEW', 'IN_PROGRESS'].includes(t) || (['PENDING_APPROVAL', 'APPROVED'].includes(t) && finReadyForApproval))) ||
      (s === 'APPROVED' && ((t === 'APPROVED' && finReadyForApproval) || (t === 'POSTED' && finPosted))) ||
      (s === 'POSTED' && t === 'CLOSED' && finReadyForClose);
    return ok ? null : `INVALID_SESSION_STATUS_TRANSITION:${s}->${t}`;
  }

  // 2) stocktake_sessions_v2/{sessionId}/items/{medicineId}
  if (segs.length === 6 && segs[2] === 'stocktake_sessions_v2' && segs[4] === 'items') {
    const sessionId = segs[3];
    const medId = segs[5];
    if (!isValidIdRule(sessionId) || !isValidIdRule(medId)) return 'INVALID_ITEM_ID';
    const sessPath = `branches/${branchId}/stocktake_sessions_v2/${sessionId}`;
    const medPath = `branches/${branchId}/medicines/${medId}`;
    const allowedItemKeys = [
      'id', 'sessionId', 'branchId', 'medicineId', 'medicineName',
      'strength', 'dosageForm', 'primaryBarcode', 'secondaryBarcodes', 'availableUnits',
      'state', 'syncStatus', 'activeLease', 'leaseVersion', 'countRevision',
      'recountReason', 'operationalDiscrepancyFlag', 'createdAt', 'updatedAt',
    ];
    if (!hasOnlyKeys(incoming, allowedItemKeys)) return 'FORBIDDEN_SHARED_ITEM_KEYS';
    if (incoming.id !== medId || incoming.sessionId !== sessionId || incoming.branchId !== branchId || incoming.medicineId !== medId) {
      return 'ITEM_IDENTITY_MISMATCH';
    }
    if (incoming.syncStatus !== 'CONFIRMED') return 'ITEM_SYNC_STATUS_MUST_BE_CONFIRMED';

    if (!existing) {
      if (!isBranchAdminRule(beforeDocs, auth.uid, branchId)) return 'ITEM_CREATE_REQUIRES_ADMIN';
      const sessAfter = afterDocs.get(sessPath);
      if (!sessAfter || sessAfter.status !== 'DRAFT') return 'ITEM_CREATE_REQUIRES_DRAFT_SESSION';
      if (!beforeDocs.has(medPath)) return 'ITEM_CREATE_REQUIRES_MEDICINE';
      if (incoming.state !== 'AVAILABLE' || incoming.activeLease != null || incoming.leaseVersion !== 0 || incoming.countRevision !== 0) {
        return 'ITEM_CREATE_BAD_INITIAL_STATE';
      }
      if (tsMs(incoming.createdAt) !== nowMs || tsMs(incoming.updatedAt) !== nowMs) return 'ITEM_CREATE_TIME_MISMATCH';
      return null;
    }

    if (!isAssignedUserRule(beforeDocs, auth.uid, branchId)) return 'ITEM_UPDATE_UNASSIGNED';
    if (tsMs(incoming.updatedAt) !== nowMs || tsMs(incoming.createdAt) !== tsMs(existing.createdAt)) {
      return 'ITEM_UPDATE_TIME_MISMATCH';
    }
    const sessBefore = beforeDocs.get(sessPath);
    const sessStatus = String(sessBefore?.status ?? '');
    const prevLease = (existing.activeLease ?? null) as Record<string, unknown> | null;
    const nextLease = (incoming.activeLease ?? null) as Record<string, unknown> | null;
    const diff = affectedKeys(existing, incoming);

    if (incoming.state === 'RESERVED') {
      if (Number(incoming.leaseVersion) === Number(existing.leaseVersion) + 1) {
        // Acquire
        const prevExpired = prevLease ? nowMs > tsMs(prevLease.expiresAt) : false;
        if (sessStatus !== 'IN_PROGRESS') return 'ACQUIRE_SESSION_NOT_IN_PROGRESS';
        if (!(['AVAILABLE', 'NEEDS_RECOUNT'].includes(String(existing.state)) || (existing.state === 'RESERVED' && prevExpired))) {
          return 'ACQUIRE_LEASE_CONFLICT_OR_STATE';
        }
        if (!nextLease || nextLease.ownerUid !== auth.uid || nextLease.leaseVersion !== incoming.leaseVersion || nextLease.renewalCount !== 0) {
          return 'ACQUIRE_BAD_LEASE_MAP';
        }
        if (tsMs(nextLease.createdAt) !== nowMs || tsMs(nextLease.expiresAt) <= nowMs || tsMs(nextLease.expiresAt) > nowMs + 600_000) {
          return 'ACQUIRE_CLOCK_SKEW_VIOLATION';
        }
        if (!diff.every((k) => ['state', 'activeLease', 'leaseVersion', 'updatedAt'].includes(k))) {
          return 'ACQUIRE_BAD_AFFECTED_KEYS';
        }
        return null;
      }
      // Renew
      if (sessStatus !== 'IN_PROGRESS' || existing.state !== 'RESERVED' || !prevLease || prevLease.ownerUid !== auth.uid) {
        return 'RENEW_NOT_OWNER_OR_BAD_STATE';
      }
      if (nowMs > tsMs(prevLease.expiresAt)) return 'RENEW_EXPIRED_LEASE';
      if (
        !nextLease ||
        nextLease.leaseId !== prevLease.leaseId ||
        nextLease.ownerUid !== auth.uid ||
        tsMs(nextLease.createdAt) !== tsMs(prevLease.createdAt) ||
        Number(nextLease.renewalCount) !== Number(prevLease.renewalCount) + 1 ||
        Number(nextLease.renewalCount) > 12 ||
        tsMs(nextLease.expiresAt) <= nowMs ||
        tsMs(nextLease.expiresAt) > nowMs + 600_000 ||
        tsMs(nextLease.expiresAt) > tsMs(prevLease.createdAt) + 1_800_000
      ) {
        return 'RENEW_POLICY_OR_CEILING_VIOLATION';
      }
      if (!diff.every((k) => ['activeLease', 'updatedAt'].includes(k))) return 'RENEW_BAD_AFFECTED_KEYS';
      return null;
    }

    if (incoming.state === 'COUNTED') {
      if (sessStatus !== 'IN_PROGRESS' || existing.state !== 'RESERVED' || !prevLease || prevLease.ownerUid !== auth.uid) {
        return 'SUBMIT_REQUIRES_ACTIVE_OWNED_LEASE';
      }
      if (nowMs > tsMs(prevLease.expiresAt) || nextLease != null) return 'SUBMIT_EXPIRED_OR_NON_NULL_LEASE';
      if (Number(incoming.countRevision) !== Number(existing.countRevision) + 1) return 'SUBMIT_BAD_COUNT_REVISION';
      const evId = `${incoming.medicineId}__r${incoming.countRevision}`;
      const evAfter = afterDocs.get(`branches/${branchId}/stocktake_sessions_v2/${sessionId}/count_events/${evId}`);
      if (!evAfter || evAfter.actorUid !== auth.uid || evAfter.leaseId !== prevLease.leaseId) {
        return 'SUBMIT_MISSING_AFTER_COUNT_EVENT';
      }
      if (!diff.every((k) => ['state', 'activeLease', 'leaseVersion', 'countRevision', 'updatedAt'].includes(k))) {
        return 'SUBMIT_BAD_AFFECTED_KEYS';
      }
      return null;
    }

    if (existing.state === 'RESERVED') {
      // Release
      if (sessStatus !== 'IN_PROGRESS' || !prevLease || nextLease != null) return 'RELEASE_BAD_STATE';
      if (!(prevLease.ownerUid === auth.uid || nowMs > tsMs(prevLease.expiresAt) || isBranchAdminRule(beforeDocs, auth.uid, branchId))) {
        return 'RELEASE_UNAUTHORIZED';
      }
      const okState =
        (Number(existing.countRevision) === 0 && incoming.state === 'AVAILABLE') ||
        (Number(existing.countRevision) >= 1 && incoming.state === 'NEEDS_RECOUNT');
      if (!okState || Number(incoming.leaseVersion) !== Number(existing.leaseVersion) + 1) return 'RELEASE_BAD_TRANSITION';
      if (!diff.every((k) => ['state', 'activeLease', 'leaseVersion', 'updatedAt'].includes(k))) return 'RELEASE_BAD_AFFECTED_KEYS';
      return null;
    }

    // Admin recount or verify
    if (!isBranchAdminRule(beforeDocs, auth.uid, branchId)) return 'RECOUNT_VERIFY_REQUIRES_ADMIN';
    if (!['IN_PROGRESS', 'RECONCILING', 'NEEDS_REVIEW', 'PENDING_APPROVAL'].includes(sessStatus)) {
      return 'RECOUNT_VERIFY_BAD_SESSION_STATUS';
    }
    if (existing.state !== 'COUNTED' || nextLease != null || Number(incoming.countRevision) !== Number(existing.countRevision)) {
      return 'RECOUNT_VERIFY_BAD_ITEM_STATE';
    }
    const recountOk = incoming.state === 'NEEDS_RECOUNT' && Number(incoming.leaseVersion) === Number(existing.leaseVersion) + 1 && isValidStrRule(incoming.recountReason, 3, 500);
    const verifyOk = incoming.state === 'VERIFIED' && Number(incoming.leaseVersion) === Number(existing.leaseVersion) + 1 && (incoming.recountReason ?? null) === null;
    if (!recountOk && !verifyOk) return 'RECOUNT_VERIFY_FAILED';
    if (!diff.every((k) => ['state', 'activeLease', 'leaseVersion', 'recountReason', 'operationalDiscrepancyFlag', 'updatedAt'].includes(k))) {
      return 'RECOUNT_VERIFY_BAD_KEYS';
    }
    return null;
  }

  // 3) count_events/{eventId}
  if (segs.length === 6 && segs[2] === 'stocktake_sessions_v2' && segs[4] === 'count_events') {
    if (existing) return 'COUNT_EVENT_IMMUTABLE';
    const sessionId = segs[3];
    const eventId = segs[5];
    if (!isAssignedUserRule(beforeDocs, auth.uid, branchId)) return 'COUNT_EVENT_UNASSIGNED';
    if (eventId !== `${incoming.medicineId}__r${incoming.countRevision}`) return 'COUNT_EVENT_ID_MISMATCH';
    if (incoming.actorUid !== auth.uid || tsMs(incoming.createdAt) !== nowMs) return 'COUNT_EVENT_ACTOR_OR_TIME_MISMATCH';
    if (Number(incoming.countedBaseUnits) !== Number(incoming.countedQuantity) * Number(incoming.baseUnitsPerCountUnit)) {
      return 'COUNT_EVENT_MATH_MISMATCH';
    }
    const itemBefore = beforeDocs.get(`branches/${branchId}/stocktake_sessions_v2/${sessionId}/items/${incoming.medicineId}`);
    const sessBefore = beforeDocs.get(`branches/${branchId}/stocktake_sessions_v2/${sessionId}`);
    if (!sessBefore || sessBefore.status !== 'IN_PROGRESS' || !itemBefore || itemBefore.state !== 'RESERVED') {
      return 'COUNT_EVENT_REQUIRES_RESERVED_ITEM';
    }
    const lease = itemBefore.activeLease as Record<string, unknown> | null;
    if (!lease || lease.ownerUid !== auth.uid || lease.leaseId !== incoming.leaseId || nowMs > tsMs(lease.expiresAt)) {
      return 'COUNT_EVENT_LEASE_MISMATCH';
    }
    return null;
  }

  // 4) operational_audit/{auditId}
  if (segs.length === 6 && segs[2] === 'stocktake_sessions_v2' && segs[4] === 'operational_audit') {
    if (existing) return 'OPERATIONAL_AUDIT_IMMUTABLE';
    if (!isAssignedUserRule(beforeDocs, auth.uid, branchId)) return 'OPERATIONAL_AUDIT_UNASSIGNED';
    if (incoming.actorUid !== auth.uid || tsMs(incoming.createdAt) !== nowMs) return 'OPERATIONAL_AUDIT_BAD_ACTOR_OR_TIME';
    return null;
  }

  // 5) stocktake_financials/{sessionId}
  if (segs.length === 4 && segs[2] === 'stocktake_financials') {
    const sessionId = segs[3];
    if (!isBranchAdminRule(beforeDocs, auth.uid, branchId)) return 'FINANCIAL_SUMMARY_REQUIRES_ADMIN';
    if (existing && ['POSTED', 'CLOSED'].includes(String(existing.reconciliationStatus ?? ''))) {
      return 'FINANCIAL_SUMMARY_IMMUTABLE';
    }
    if (incoming.updatedByUid !== auth.uid || tsMs(incoming.updatedAt) !== nowMs) return 'FINANCIAL_SUMMARY_TIME_OR_ACTOR_MISMATCH';
    if (['PENDING_APPROVAL', 'APPROVED', 'POSTED', 'CLOSED'].includes(String(incoming.reconciliationStatus ?? ''))) {
      if (
        Number(incoming.unresolvedItemsCount ?? 0) !== 0 ||
        !isValidRationalRule(incoming.totalExpectedValuationExact, false) ||
        !isValidRationalRule(incoming.totalSystemValuationExact, false) ||
        !isValidRationalRule(incoming.netVarianceValuationExact, true)
      ) {
        return 'FINANCIAL_SUMMARY_INVALID_TOTALS';
      }
    }
    return null;
  }

  // 6) stocktake_financials/{sessionId}/lines/{medicineId}
  if (segs.length === 6 && segs[2] === 'stocktake_financials' && segs[4] === 'lines') {
    const sessionId = segs[3];
    if (
      typeof incoming.varianceBaseUnits !== 'number' ||
      !Number.isSafeInteger(incoming.varianceBaseUnits) ||
      Object.is(incoming.varianceBaseUnits, -0)
    ) {
      return 'FINANCIAL_LINE_VARIANCE_NOT_FIRESTORE_INT';
    }
    if (!isBranchAdminRule(beforeDocs, auth.uid, branchId)) return 'FINANCIAL_LINE_REQUIRES_ADMIN';
    const sessBefore = beforeDocs.get(`branches/${branchId}/stocktake_sessions_v2/${sessionId}`);
    const finBefore = beforeDocs.get(`branches/${branchId}/stocktake_financials/${sessionId}`);
    if (!sessBefore || ['POSTED', 'CLOSED', 'CANCELLED'].includes(String(sessBefore.status ?? ''))) {
      return 'FINANCIAL_LINE_SESSION_IMMUTABLE';
    }
    if (finBefore && ['POSTED', 'CLOSED'].includes(String(finBefore.reconciliationStatus ?? ''))) {
      return 'FINANCIAL_LINE_SUMMARY_IMMUTABLE';
    }
    if (
      (incoming.costStatus === 'NEEDS_REVIEW' ||
        ['NEEDS_REVIEW', 'AMBIGUOUS_MOVEMENT', 'INTEGRITY_BLOCKED'].includes(String(incoming.discrepancyStatus ?? ''))) &&
      incoming.costProvenanceType === 'STOCKTAKE_V2_APPROVED_EXACT'
    ) {
      return 'FINANCIAL_LINE_FORBIDDEN_PROVENANCE';
    }
    return null;
  }

  // 7) approvals / postings / financial_audit
  if (segs.length === 6 && segs[2] === 'stocktake_financials' && ['approvals', 'postings', 'financial_audit'].includes(segs[4])) {
    if (existing) return `${segs[4]}_IMMUTABLE`;
    if (!isBranchAdminRule(beforeDocs, auth.uid, branchId)) return `${segs[4]}_REQUIRES_ADMIN`;
    if (tsMs(incoming.createdAt) !== nowMs) return `${segs[4]}_TIME_MISMATCH`;
    return null;
  }

  // 8) inventory_ledger/{movId}
  if (segs.length === 4 && segs[2] === 'inventory_ledger') {
    if (existing) return 'LEDGER_IMMUTABLE';
    if (!isAssignedUserRule(beforeDocs, auth.uid, branchId)) return 'LEDGER_UNASSIGNED';
    if (incoming.type === 'ADJUSTMENT' && (!isBranchAdminRule(beforeDocs, auth.uid, branchId) || Number(incoming.baseUnitsDelta) === 0)) {
      return 'LEDGER_BAD_ADJUSTMENT';
    }
    if (tsMs(incoming.createdAt) !== nowMs) return 'LEDGER_TIME_MISMATCH';
    return null;
  }

  // 9) inventory_financials/{movId}
  if (segs.length === 4 && segs[2] === 'inventory_financials') {
    const movId = segs[3];
    if (existing) return 'INV_FIN_IMMUTABLE';
    if (!isBranchAdminRule(beforeDocs, auth.uid, branchId)) return 'INV_FIN_REQUIRES_ADMIN';
    if (!afterDocs.has(`branches/${branchId}/inventory_ledger/${movId}`)) return 'INV_FIN_REQUIRES_LEDGER_ROW';
    if (
      incoming.costStatus === 'EXACT_RECONCILED' &&
      (!isValidRationalRule(incoming.costPerBaseUnitExact, false) || !isValidRationalRule(incoming.totalCostExact, true))
    ) {
      return 'INV_FIN_INVALID_EXACT_COST';
    }
    return null;
  }

  return `UNHANDLED_WRITE_PATH:${path}`;
}

function installFirestoreMock(engine: InMemoryFirestoreEngine) {
  (globalThis as Record<string, unknown>).__khalidPhase2fTimestampClass = Timestamp;

  const makeDocRef = (db: unknown, segments: string[]) => ({
    __kind: 'docRef',
    db,
    path: segments.join('/'),
    id: segments[segments.length - 1],
  });

  const makeColRef = (db: unknown, segments: string[]) => ({
    __kind: 'colRef',
    db,
    path: segments.join('/'),
  });

  const getActor = (db: unknown): AuthCtx => {
    const rec = db as { __actor?: AuthCtx };
    if (!rec?.__actor) throw permissionDenied('MISSING_AUTH_CONTEXT');
    return rec.__actor;
  };

  const buildSnap = (path: string, data: Record<string, unknown> | null) => ({
    id: path.split('/').pop()!,
    exists: () => data !== null,
    data: () => (data ? (cloneFirestoreValue(data, engine.serverNowMs) as Record<string, unknown>) : undefined),
  });

  const applyPatchMerge = (existing: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
    return {
      ...existing,
      ...(cloneFirestoreValue(patch, engine.serverNowMs) as Record<string, unknown>),
    };
  };

  const commitWithRules = async (
    actor: AuthCtx,
    writes: Array<{ type: 'set' | 'update'; path: string; data: Record<string, unknown> }>,
    readVersions?: Map<string, number>
  ) => {
    await engine.withLock(async () => {
      if (readVersions) {
        for (const [p, expectedVer] of readVersions.entries()) {
          if (engine.getDocVersion(p) !== expectedVer) {
            throw abortedError(`Concurrent modification on ${p}`);
          }
        }
      }
      const beforeDocs = engine.snapshotDocsMap();
      const afterDocs = new Map(beforeDocs);
      const resolvedWrites: Array<{ path: string; incoming: Record<string, unknown>; existing: Record<string, unknown> | null }> = [];

      for (const w of writes) {
        const existing = afterDocs.get(w.path) ?? null;
        let incoming: Record<string, unknown>;
        if (w.type === 'update') {
          if (!existing) throw abortedError(`Document not found for update: ${w.path}`);
          incoming = applyPatchMerge(existing, w.data);
        } else {
          incoming = cloneFirestoreValue(w.data, engine.serverNowMs) as Record<string, unknown>;
        }
        afterDocs.set(w.path, incoming);
        resolvedWrites.push({ path: w.path, incoming, existing });
      }

      for (const rw of resolvedWrites) {
        const err = evaluateWriteRule(beforeDocs, afterDocs, actor, engine.serverNowMs, rw.path, rw.incoming, rw.existing);
        if (err) {
          throw permissionDenied(`${err} @ ${rw.path}`);
        }
      }

      engine.applyRawCommit(resolvedWrites.map((rw) => ({ path: rw.path, data: rw.incoming })));
    });
  };

  (globalThis as Record<string, unknown>).__khalidPhase2fFirestoreMock = {
    collection: (db: unknown, ...segs: string[]) => makeColRef(db, segs.join('/').split('/').filter(Boolean)),
    doc: (db: unknown, ...segs: string[]) => makeDocRef(db, segs.join('/').split('/').filter(Boolean)),
    serverTimestamp: () => SERVER_TS_SENTINEL,
    where: (field: string, op: string, value: unknown) => ({ field, op, value }),
    query: (colRef: { db: unknown; path: string }, ...constraints: Array<{ field: string; op: string; value: unknown }>) => ({
      __kind: 'query',
      db: colRef.db,
      path: colRef.path,
      constraints,
    }),
    getDoc: async (ref: { db: unknown; path: string }) => {
      const actor = getActor(ref.db);
      const docs = engine.snapshotDocsMap();
      if (!evaluateReadRule(docs, actor, ref.path, false, [])) {
        throw permissionDenied(`READ_DENIED @ ${ref.path}`);
      }
      return buildSnap(ref.path, docs.get(ref.path) ?? null);
    },
    getDocs: async (q: { db: unknown; path: string; constraints?: Array<{ field: string; op: string; value: unknown }> }) => {
      const actor = getActor(q.db);
      const docs = engine.snapshotDocsMap();
      const filters = q.constraints ?? [];
      if (!evaluateReadRule(docs, actor, `${q.path}/_list`, true, filters)) {
        throw permissionDenied(`LIST_DENIED @ ${q.path}`);
      }
      const prefix = `${q.path}/`;
      const matched: Array<{ id: string; data: () => Record<string, unknown> }> = [];
      for (const [k, v] of docs.entries()) {
        if (!k.startsWith(prefix)) continue;
        const rel = k.slice(prefix.length);
        if (rel.includes('/')) continue;
        const passes = filters.every((f) => f.op === '==' && v[f.field] === f.value);
        if (passes) {
          matched.push({
            id: rel,
            data: () => cloneFirestoreValue(v, engine.serverNowMs) as Record<string, unknown>,
          });
        }
      }
      return {
        empty: matched.length === 0,
        size: matched.length,
        docs: matched,
        forEach: (cb: (d: { id: string; data: () => Record<string, unknown> }) => void) => matched.forEach(cb),
      };
    },
    setDoc: async (ref: { db: unknown; path: string }, data: Record<string, unknown>) => {
      await commitWithRules(getActor(ref.db), [{ type: 'set', path: ref.path, data }]);
    },
    updateDoc: async (ref: { db: unknown; path: string }, data: Record<string, unknown>) => {
      await commitWithRules(getActor(ref.db), [{ type: 'update', path: ref.path, data }]);
    },
    writeBatch: (db: unknown) => {
      const writes: Array<{ type: 'set' | 'update'; path: string; data: Record<string, unknown> }> = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>) => writes.push({ type: 'set', path: ref.path, data }),
        update: (ref: { path: string }, data: Record<string, unknown>) => writes.push({ type: 'update', path: ref.path, data }),
        commit: async () => commitWithRules(getActor(db), writes),
      };
    },
    runTransaction: async <T>(db: unknown, updateFn: (tx: unknown) => Promise<T>): Promise<T> => {
      const actor = getActor(db);
      for (let attempt = 0; attempt < 5; attempt++) {
        const readVersions = new Map<string, number>();
        const writes: Array<{ type: 'set' | 'update'; path: string; data: Record<string, unknown> }> = [];
        const snapshotAtStart = engine.snapshotDocsMap();

        const tx = {
          get: async (ref: { path: string }) => {
            if (!readVersions.has(ref.path)) {
              readVersions.set(ref.path, engine.getDocVersion(ref.path));
            }
            if (!evaluateReadRule(snapshotAtStart, actor, ref.path, false, [])) {
              throw permissionDenied(`TX_READ_DENIED @ ${ref.path}`);
            }
            return buildSnap(ref.path, snapshotAtStart.get(ref.path) ?? null);
          },
          set: (ref: { path: string }, data: Record<string, unknown>) => {
            writes.push({ type: 'set', path: ref.path, data });
          },
          update: (ref: { path: string }, data: Record<string, unknown>) => {
            writes.push({ type: 'update', path: ref.path, data });
          },
        };

        const result = await updateFn(tx);
        if (writes.length === 0) return result;

        try {
          await commitWithRules(actor, writes, readVersions);
          return result;
        } catch (err: unknown) {
          if ((err as { code?: string })?.code === 'aborted' && attempt < 4) {
            continue;
          }
          throw err;
        }
      }
      throw abortedError('Max transaction retries exceeded');
    },
  };
}

const engine = new InMemoryFirestoreEngine();
installFirestoreMock(engine);

const svc = await import('../src/services/stocktakeFirestoreService.ts');

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
    const msg = String((err as Error)?.message ?? err);
    matched = msg.includes(codeFragment);
    if (!matched) {
      throw new Error(`${label}: expected '${codeFragment}' but got '${msg}'`);
    }
  }
  assert.equal(matched, true, `${label}: expected rejection with '${codeFragment}'`);
}

function seedMedicine(branchId: string, medId: string, mode: 'SOLID_TWO_LEVEL' | 'DIRECT_PACK' = 'SOLID_TWO_LEVEL') {
  const isDirect = mode === 'DIRECT_PACK';
  engine.seedRaw(`branches/${branchId}/medicines/${medId}`, {
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
      ? { mode: 'DIRECT_PACK', dosageForm: 'syrup', baseUnitLabel: 'bottle', baseUnitsPerPack: 1, verificationState: 'VERIFIED' }
      : { mode: 'SOLID_TWO_LEVEL', dosageForm: 'capsule', baseUnitLabel: 'pill', stripsPerPack: 2, pillsPerStrip: 10, baseUnitsPerPack: 20, verificationState: 'VERIFIED' },
    createdAt: Timestamp.fromMillis(engine.serverNowMs - 1_000_000),
    updatedAt: Timestamp.fromMillis(engine.serverNowMs - 1_000_000),
  });
}

function seedBaseFixtures() {
  engine.clear();
  engine.serverNowMs = Date.now();
  engine.seedRaw('branches/khalid-1', {
    id: 'khalid-1',
    code: 'K1',
    active: true,
    adminUids: ['admin-1'],
    memberUids: ['admin-1', 'cashier-1', 'cashier-1b'],
  });
  engine.seedRaw('branches/khalid-2', {
    id: 'khalid-2',
    code: 'K2',
    active: true,
    adminUids: ['admin-2'],
    memberUids: ['admin-2'],
  });
  for (const u of [
    { uid: 'admin-1', role: 'admin', branchIds: ['khalid-1'] },
    { uid: 'cashier-1', role: 'cashier', branchIds: ['khalid-1'] },
    { uid: 'cashier-1b', role: 'cashier', branchIds: ['khalid-1'] },
    { uid: 'admin-2', role: 'admin', branchIds: ['khalid-2'] },
  ]) {
    engine.seedRaw(`users/${u.uid}`, { ...u, active: true });
  }
  seedMedicine('khalid-1', 'med-1', 'SOLID_TWO_LEVEL');
  seedMedicine('khalid-1', 'med-2', 'SOLID_TWO_LEVEL');
  seedMedicine('khalid-1', 'med-syrup', 'DIRECT_PACK');
  seedMedicine('khalid-1', 'med-fefo', 'SOLID_TWO_LEVEL');
}

async function main() {
  seedBaseFixtures();
  const adminDb = engine.createDbForActor({ uid: 'admin-1', emailVerified: true });
  const c1Db = engine.createDbForActor({ uid: 'cashier-1', emailVerified: true });
  const c1bDb = engine.createDbForActor({ uid: 'cashier-1b', emailVerified: true });
  const admin2Db = engine.createDbForActor({ uid: 'admin-2', emailVerified: true });
  const unverifiedDb = engine.createDbForActor({ uid: 'cashier-1', emailVerified: false });

  await runCase('L3-01', 'Atomic session init (<=400), >400 chunked init, crash-after-DRAFT recovery, and DRAFT abort cleanup', async () => {
    const res1 = await svc.createStocktakeV2SessionAndItems(adminDb, {
      branchId: 'khalid-1',
      sessionId: 'sess-l3-init-1',
      sessionNumber: 'ST-L3-01',
      scopeMode: 'PARTIAL',
      adminUid: 'admin-1',
      adminDisplayName: 'Admin 1',
      items: [
        { medicineId: 'med-1', medicineName: 'Amoxicillin 500mg', availableUnits: ['pack', 'strip', 'pill'] },
        { medicineId: 'med-2', medicineName: 'Paracetamol 500mg', availableUnits: ['pack', 'strip', 'pill'] },
      ],
    });
    assert.equal(res1.atomicSingleBatch, true);
    assert.equal(res1.status, 'IN_PROGRESS');

    await expectReject('crash-after-draft', () => svc.createStocktakeV2SessionAndItems(adminDb, {
      branchId: 'khalid-1',
      sessionId: 'sess-l3-crash',
      sessionNumber: 'ST-L3-CRASH',
      scopeMode: 'PARTIAL',
      adminUid: 'admin-1',
      adminDisplayName: 'Admin 1',
      items: [{ medicineId: 'med-1', medicineName: 'Amoxicillin 500mg', availableUnits: ['pack'] }],
      simulateCrashAfterDraftCreate: true,
    }), 'SIMULATED_CRASH_AFTER_DRAFT_CREATE');

    const draftLease = await svc.acquireStocktakeLeaseTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: 'sess-l3-crash',
      medicineId: 'med-1',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      deviceId: 'dev-c1',
      leaseId: 'lease-draft-denied',
    });
    assert.equal(draftLease.ok, false);
    if (!draftLease.ok) assert.equal(draftLease.code, 'SESSION_NOT_IN_PROGRESS');

    const recovered = await svc.createStocktakeV2SessionAndItems(adminDb, {
      branchId: 'khalid-1',
      sessionId: 'sess-l3-crash',
      sessionNumber: 'ST-L3-CRASH',
      scopeMode: 'PARTIAL',
      adminUid: 'admin-1',
      adminDisplayName: 'Admin 1',
      items: [{ medicineId: 'med-1', medicineName: 'Amoxicillin 500mg', availableUnits: ['pack'] }],
    });
    assert.equal(recovered.recoveredFromDraft, true);
    assert.equal(recovered.createdItemsCount, 1);

    const replay = await svc.createStocktakeV2SessionAndItems(adminDb, {
      branchId: 'khalid-1',
      sessionId: 'sess-l3-crash',
      sessionNumber: 'ST-L3-CRASH',
      scopeMode: 'PARTIAL',
      adminUid: 'admin-1',
      adminDisplayName: 'Admin 1',
      items: [{ medicineId: 'med-1', medicineName: 'Amoxicillin 500mg', availableUnits: ['pack'] }],
    });
    assert.equal(replay.idempotentReplay, true);

    // >400 items chunked init
    const manyItems = [];
    for (let i = 1; i <= 405; i++) {
      const mId = `bulk-med-${i}`;
      seedMedicine('khalid-1', mId, 'DIRECT_PACK');
      manyItems.push({ medicineId: mId, medicineName: `Bulk ${i}`, availableUnits: ['pack' as const] });
    }
    const chunked = await svc.createStocktakeV2SessionAndItems(adminDb, {
      branchId: 'khalid-1',
      sessionId: 'sess-l3-chunked-405',
      sessionNumber: 'ST-L3-CHUNK',
      scopeMode: 'FULL',
      adminUid: 'admin-1',
      adminDisplayName: 'Admin 1',
      items: manyItems,
    });
    assert.equal(chunked.atomicSingleBatch, false);
    assert.equal(chunked.createdItemsCount, 405);

    // Abort DRAFT -> CANCELLED
    await expectReject('abort-prep', () => svc.createStocktakeV2SessionAndItems(adminDb, {
      branchId: 'khalid-1',
      sessionId: 'sess-l3-abort',
      sessionNumber: 'ST-L3-ABT',
      scopeMode: 'PARTIAL',
      adminUid: 'admin-1',
      adminDisplayName: 'Admin 1',
      items: [{ medicineId: 'med-1', medicineName: 'Amoxicillin' }],
      simulateCrashAfterDraftCreate: true,
    }), 'SIMULATED_CRASH_AFTER_DRAFT_CREATE');
    await svc.abortDraftStocktakeSessionTx(adminDb, 'khalid-1', 'sess-l3-abort', 'admin-1', 'Operator cancelled draft');
    assert.equal(engine.getRaw('branches/khalid-1/stocktake_sessions_v2/sess-l3-abort')?.status, 'CANCELLED');
  });

  await runCase('L3-02', 'Concurrent Promise.all CAS lease race -> 1 winner, zero holderUid leak, idempotent retry, expiry takeover & release', async () => {
    const s = 'sess-l3-init-1';
    const [r1, r2] = await Promise.all([
      svc.acquireStocktakeLeaseTx(c1Db, {
        branchId: 'khalid-1',
        sessionId: s,
        medicineId: 'med-1',
        actorUid: 'cashier-1',
        actorDisplayName: 'Cashier 1',
        deviceId: 'dev-c1',
        leaseId: 'lease-c1-1',
        ttlMs: 60_000,
      }),
      svc.acquireStocktakeLeaseTx(c1bDb, {
        branchId: 'khalid-1',
        sessionId: s,
        medicineId: 'med-1',
        actorUid: 'cashier-1b',
        actorDisplayName: 'Cashier 1B',
        deviceId: 'dev-c1b',
        leaseId: 'lease-c1b-1',
        ttlMs: 60_000,
      }),
    ]);
    const winners = [r1.ok ? 'c1' : null, r2.ok ? 'c1b' : null].filter(Boolean);
    assert.equal(winners.length, 1);
    const loser = r1.ok ? r2 : r1;
    assert.equal(loser.ok, false);
    if (!loser.ok) {
      assert.equal(loser.code, 'LEASE_CONFLICT_ACTIVE');
      assert.deepEqual(Object.keys(loser).sort(), ['code', 'ok']);
    }

    const winnerActor = r1.ok ? c1Db : c1bDb;
    const winnerUid = r1.ok ? 'cashier-1' : 'cashier-1b';
    const winnerDev = r1.ok ? 'dev-c1' : 'dev-c1b';
    const winnerLeaseId = r1.ok ? 'lease-c1-1' : 'lease-c1b-1';

    // Idempotent retry by same owner/device/leaseId
    const retry = await svc.acquireStocktakeLeaseTx(winnerActor, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-1',
      actorUid: winnerUid,
      actorDisplayName: winnerUid,
      deviceId: winnerDev,
      leaseId: winnerLeaseId,
      ttlMs: 60_000,
    });
    assert.equal(retry.ok, true);
    if (retry.ok) assert.equal(retry.idempotentReplay, true);

    // Renew once, then simulate 31-minute cumulative cap -> Rules reject
    const ren1 = await svc.renewStocktakeLeaseTx(winnerActor, 'khalid-1', s, 'med-1', winnerUid, 120_000);
    assert.equal(ren1.ok, true);

    // Advance server clock past lease expiry (121s) AND pass offset so local wall clock matches simulated server time
    engine.serverNowMs += 125_000;
    const loserActor = r1.ok ? c1bDb : c1Db;
    const loserUid = r1.ok ? 'cashier-1b' : 'cashier-1';
    const loserDev = r1.ok ? 'dev-c1b' : 'dev-c1';
    const takeover = await svc.acquireStocktakeLeaseTx(loserActor, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-1',
      actorUid: loserUid,
      actorDisplayName: loserUid,
      deviceId: loserDev,
      leaseId: 'lease-takeover-2',
      ttlMs: 90_000,
      clientClockOffsetMs: 125_000,
    });
    assert.equal(takeover.ok, true);
    if (takeover.ok) assert.equal(takeover.leaseVersion, 2);

    // Owner can release back to AVAILABLE at countRevision 0
    const rel = await svc.releaseStocktakeLeaseTx(loserActor, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-1',
      actorUid: loserUid,
      actorRole: 'cashier',
      auditId: 'aud-rel-1',
    });
    assert.equal(rel.ok, true);
    if (rel.ok) assert.equal(rel.nextState, 'AVAILABLE');
  });

  await runCase('L3-03', 'Client clock-skew spoofing (-15m/+15m) rejected by Rules-Mirror request.time', async () => {
    const s = 'sess-l3-init-1';
    await expectReject('neg-skew', () => svc.acquireStocktakeLeaseTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-2',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      deviceId: 'dev-c1',
      leaseId: 'lease-neg-skew',
      ttlMs: 60_000,
      clientClockOffsetMs: -900_000,
    }), 'PERMISSION_DENIED');

    await expectReject('pos-skew', () => svc.acquireStocktakeLeaseTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-2',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      deviceId: 'dev-c1',
      leaseId: 'lease-pos-skew',
      ttlMs: 60_000,
      clientClockOffsetMs: +900_000,
    }), 'PERMISSION_DENIED');
  });

  await runCase('L3-04', 'Count submission unit validation, idempotent replay, shared item zero-leak, Cashier blind view & Recount/Verify', async () => {
    const s = 'sess-l3-init-1';
    await svc.acquireStocktakeLeaseTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-1',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      deviceId: 'dev-c1',
      leaseId: 'lease-cnt-1',
      ttlMs: 120_000,
    });

    await expectReject('fractional-qty', () => svc.submitStocktakeCountTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-1',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      actorRole: 'cashier',
      deviceId: 'dev-c1',
      countedQuantity: 1.5,
      countUnit: 'pack',
      baseUnitsPerCountUnit: 20,
      knownMovementIdsAtCount: [],
    }), 'INVALID_COUNT_QUANTITY');

    await expectReject('wrong-conversion', () => svc.submitStocktakeCountTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-1',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      actorRole: 'cashier',
      deviceId: 'dev-c1',
      countedQuantity: 3,
      countUnit: 'strip',
      baseUnitsPerCountUnit: 99,
      knownMovementIdsAtCount: [],
    }), 'INVALID_UNIT_CONVERSION');

    const sub1 = await svc.submitStocktakeCountTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-1',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      actorRole: 'cashier',
      deviceId: 'dev-c1',
      leaseId: 'lease-cnt-1',
      countedQuantity: 3,
      countUnit: 'strip',
      baseUnitsPerCountUnit: 10,
      knownMovementIdsAtCount: ['mov-a'],
    });
    assert.equal(sub1.countedBaseUnits, 30);
    assert.equal(sub1.countRevision, 1);

    // Idempotent retry
    const sub1Replay = await svc.submitStocktakeCountTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-1',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      actorRole: 'cashier',
      deviceId: 'dev-c1',
      leaseId: 'lease-cnt-1',
      countedQuantity: 3,
      countUnit: 'strip',
      baseUnitsPerCountUnit: 10,
      knownMovementIdsAtCount: ['mov-a'],
    });
    assert.equal(sub1Replay.idempotentReplay, true);

    // Shared item must have zero count fields
    const rawItem = engine.getRaw(`branches/khalid-1/stocktake_sessions_v2/${s}/items/med-1`)!;
    assert.deepEqual(scanForForbiddenKeys(rawItem, FORBIDDEN_SHARED_ITEM_COUNT_FIELDS), []);
    assert.equal(assertOperationalStocktakePayloadSafe(rawItem).valid, true);

    // Cashier blind view isolation
    const vC1 = await svc.loadCashierStocktakeOperationalViews(c1Db, 'khalid-1', s, 'cashier-1');
    assert.equal(vC1.myConfirmedCounts.length, 1);
    assert.equal(vC1.myConfirmedCounts[0].countedQuantity, 3);
    assert.equal(vC1.myConfirmedCounts[0].countUnit, 'strip');
    assert.deepEqual(scanForForbiddenKeys(vC1.myConfirmedCounts[0], FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS), []);
    assert.deepEqual(scanForForbiddenKeys(vC1.remainingItems, FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS), []);

    const vC1b = await svc.loadCashierStocktakeOperationalViews(c1bDb, 'khalid-1', s, 'cashier-1b');
    assert.equal(vC1b.myConfirmedCounts.length, 0);

    // Admin recount -> preserves rev 1 -> cashier submits rev 2 -> admin verifies
    await svc.requestRecountAdminTx(adminDb, 'khalid-1', s, 'med-1', 'Shelf recount requested', {
      adminUid: 'admin-1',
      adminRole: 'admin',
    });
    await svc.acquireStocktakeLeaseTx(c1bDb, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-1',
      actorUid: 'cashier-1b',
      actorDisplayName: 'Cashier 1B',
      deviceId: 'dev-c1b',
      leaseId: 'lease-recount-c1b',
    });
    const sub2 = await svc.submitStocktakeCountTx(c1bDb, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-1',
      actorUid: 'cashier-1b',
      actorDisplayName: 'Cashier 1B',
      actorRole: 'cashier',
      deviceId: 'dev-c1b',
      countedQuantity: 2,
      countUnit: 'pack',
      baseUnitsPerCountUnit: 20,
      knownMovementIdsAtCount: ['mov-a'],
    });
    assert.equal(sub2.countRevision, 2);
    assert.equal(engine.getRaw(`branches/khalid-1/stocktake_sessions_v2/${s}/count_events/${sub1.eventId}`) != null, true);
    assert.equal(engine.getRaw(`branches/khalid-1/stocktake_sessions_v2/${s}/count_events/${sub2.eventId}`)?.recountOfEventId, sub1.eventId);

    const ver = await svc.verifyStocktakeItemTx(adminDb, {
      branchId: 'khalid-1',
      sessionId: s,
      medicineId: 'med-1',
      adminUid: 'admin-1',
      adminRole: 'admin',
      auditId: 'aud-ver-1',
    });
    assert.equal(ver.countRevision, 2);
    assert.equal(engine.getRaw(`branches/khalid-1/stocktake_sessions_v2/${s}/items/med-1`)?.state, 'VERIFIED');
  });

  await runCase('L3-05', 'Live Firestore-to-Ledger reconciliation: late-synced pre-count sale, post-count sale, FEFO exact rational costing, zero buyPrice fallback', async () => {
    seedBaseFixtures();
    const t0 = engine.serverNowMs;
    const countTime = t0 - 120_000;

    // Batch 1: 40 pills @ 3/1 SDG (exp 2027-01-01)
    engine.seedRaw('branches/khalid-1/inventory_ledger/mov-fefo-p1', {
      id: 'mov-fefo-p1',
      branchId: 'khalid-1',
      medicineId: 'med-fefo',
      batchNumber: 'B1',
      expiry: '2027-01-01',
      type: 'PURCHASE',
      unit: 'pack',
      quantityDelta: 2,
      baseUnitsDelta: 40,
      referenceId: 'po-1',
      userId: 'admin-1',
      businessOccurredAtMs: t0 - 300_000,
      createdAt: Timestamp.fromMillis(t0 - 300_000),
    });
    engine.seedRaw('branches/khalid-1/inventory_financials/mov-fefo-p1', {
      id: 'mov-fefo-p1',
      branchId: 'khalid-1',
      movementId: 'mov-fefo-p1',
      medicineId: 'med-fefo',
      movementType: 'PURCHASE',
      costPerBaseUnitExact: { num: '3', den: '1' },
      totalCostExact: { num: '120', den: '1' },
      costStatus: 'EXACT_RECONCILED',
      costProvenanceType: 'PURCHASE_INVOICE_EXACT',
      unresolvedBaseUnits: 0,
      reconciledByUid: 'admin-1',
      createdAt: Timestamp.fromMillis(t0 - 300_000),
    });

    // Batch 2: 40 pills @ 5/1 SDG (exp 2027-06-01)
    engine.seedRaw('branches/khalid-1/inventory_ledger/mov-fefo-p2', {
      id: 'mov-fefo-p2',
      branchId: 'khalid-1',
      medicineId: 'med-fefo',
      batchNumber: 'B2',
      expiry: '2027-06-01',
      type: 'PURCHASE',
      unit: 'pack',
      quantityDelta: 2,
      baseUnitsDelta: 40,
      referenceId: 'po-2',
      userId: 'admin-1',
      businessOccurredAtMs: t0 - 240_000,
      createdAt: Timestamp.fromMillis(t0 - 240_000),
    });
    engine.seedRaw('branches/khalid-1/inventory_financials/mov-fefo-p2', {
      id: 'mov-fefo-p2',
      branchId: 'khalid-1',
      movementId: 'mov-fefo-p2',
      medicineId: 'med-fefo',
      movementType: 'PURCHASE',
      costPerBaseUnitExact: { num: '5', den: '1' },
      totalCostExact: { num: '200', den: '1' },
      costStatus: 'EXACT_RECONCILED',
      costProvenanceType: 'PURCHASE_INVOICE_EXACT',
      unresolvedBaseUnits: 0,
      reconciledByUid: 'admin-1',
      createdAt: Timestamp.fromMillis(t0 - 240_000),
    });

    // Late-synced offline sale that happened 60s BEFORE countTime (-10 pills -> excluded from expected!)
    engine.seedRaw('branches/khalid-1/inventory_ledger/mov-late-pre', {
      id: 'mov-late-pre',
      branchId: 'khalid-1',
      medicineId: 'med-fefo',
      batchNumber: 'B1',
      expiry: '2027-01-01',
      type: 'SALE',
      unit: 'strip',
      quantityDelta: -1,
      baseUnitsDelta: -10,
      referenceId: 'sale-late-1',
      userId: 'cashier-1',
      businessOccurredAtMs: countTime - 60_000,
      createdAt: Timestamp.fromMillis(countTime + 60_000),
    });

    // Post-count sale (-20 pills 60s AFTER countTime -> reduces expectedCurrentBaseUnits!)
    engine.seedRaw('branches/khalid-1/inventory_ledger/mov-post-sale', {
      id: 'mov-post-sale',
      branchId: 'khalid-1',
      medicineId: 'med-fefo',
      batchNumber: 'B1',
      expiry: '2027-01-01',
      type: 'SALE',
      unit: 'pack',
      quantityDelta: -1,
      baseUnitsDelta: -20,
      referenceId: 'sale-post-1',
      userId: 'cashier-1',
      businessOccurredAtMs: countTime + 60_000,
      createdAt: Timestamp.fromMillis(countTime + 60_000),
    });

    // System current stock: 40 + 40 - 10 - 20 = 50 pills (B1: 10 @ 3, B2: 40 @ 5)
    // Cashier counted 2 packs = 40 pills at countTime knowing [mov-fefo-p1, mov-fefo-p2].
    // Post-count sale (-20) -> expectedCurrentBaseUnits = 40 - 20 = 20 pills.
    // System = 50 pills -> variance = 20 - 50 = -30 pills deficit!
    // FEFO deficit cost on remaining B1 (10 @ 3 = 30) + B2 (20 @ 5 = 100) => -130 SDG!
    const sRec = 'sess-l3-fefo';
    await svc.createStocktakeV2SessionAndItems(adminDb, {
      branchId: 'khalid-1',
      sessionId: sRec,
      sessionNumber: 'ST-L3-FEFO',
      scopeMode: 'PARTIAL',
      adminUid: 'admin-1',
      adminDisplayName: 'Admin 1',
      items: [{ medicineId: 'med-fefo', medicineName: 'FEFO Med', availableUnits: ['pack', 'strip', 'pill'] }],
    });
    await svc.acquireStocktakeLeaseTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: sRec,
      medicineId: 'med-fefo',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      deviceId: 'dev-c1',
      leaseId: 'lease-fefo-1',
    });
    await svc.submitStocktakeCountTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: sRec,
      medicineId: 'med-fefo',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      actorRole: 'cashier',
      deviceId: 'dev-c1',
      countedQuantity: 2,
      countUnit: 'pack',
      baseUnitsPerCountUnit: 20,
      knownMovementIdsAtCount: ['mov-fefo-p1', 'mov-fefo-p2'],
      countBusinessAtMs: countTime,
      localPersistedAtMs: countTime,
    });

    const rec = await svc.reconcileStocktakeSessionFromFirestore(adminDb, {
      branchId: 'khalid-1',
      sessionId: sRec,
      adminUid: 'admin-1',
      adminRole: 'admin',
      nowMs: t0,
    });
    assert.equal(rec.reconciliationStatus, 'PENDING_APPROVAL');
    assert.equal(rec.financialLinesPersisted[0].expectedCurrentBaseUnits, 20);
    assert.equal(rec.financialLinesPersisted[0].systemCurrentBaseUnits, 50);
    assert.equal(rec.financialLinesPersisted[0].varianceBaseUnits, -30);
    assert.equal(rec.financialLinesPersisted[0].costStatus, 'EXACT_HISTORICAL');
    // Unit cost = 130 / 30 = 13 / 3
    assert.deepEqual(rec.financialLinesPersisted[0].costPerBaseUnitExact, { num: '13', den: '3' });
    assert.deepEqual(rec.financialLinesPersisted[0].financialVarianceExact, { num: '-130', den: '1' });

    // Cashier cannot read Domain B
    await expectReject('cashier-read-fin', () => svc.loadAdminStocktakeSessionDetails(c1Db, 'khalid-1', sRec), 'PERMISSION_DENIED');

    // Approve & post adjustment
    await svc.transitionStocktakeSessionStatusTx(adminDb, {
      branchId: 'khalid-1',
      sessionId: sRec,
      targetStatus: 'APPROVED',
      adminUid: 'admin-1',
    });
    const postRes = await svc.approveAndPostStocktakeAdjustmentTx(adminDb, {
      branchId: 'khalid-1',
      sessionId: sRec,
      adminUid: 'admin-1',
      adminRole: 'admin',
      approvalId: 'apr-fefo-1',
      postingId: 'post-fefo-1',
      approvalReason: 'Approved FEFO reconciled deficit adjustment',
      movementHistoryVerified: true,
      reconciledLedgerMovementIdsByMedicineId: {
        'med-fefo': ['mov-fefo-p1', 'mov-fefo-p2', 'mov-late-pre', 'mov-post-sale'],
      },
      adjustments: [{
        medicineId: 'med-fefo',
        adjustmentBaseUnitsDelta: -30,
        costPerBaseUnitExact: createRational(13n, 3n),
        totalCostExact: createRational(-130n, 1n),
        costStatus: 'EXACT_HISTORICAL',
        expectedCountRevision: 1,
      }],
    });
    assert.equal(postRes.postedLedgerIds.length, 1);

    const ledRow = engine.getRaw(`branches/khalid-1/inventory_ledger/${postRes.postedLedgerIds[0]}`)!;
    assert.equal(assertOperationalStocktakePayloadSafe(ledRow).valid, true);
    assert.equal(ledRow.baseUnitsDelta, -30);

    const invFinRow = engine.getRaw(`branches/khalid-1/inventory_financials/${postRes.postedLedgerIds[0]}`)!;
    assert.deepEqual(invFinRow.costPerBaseUnitExact, { num: '13', den: '3' });
    assert.deepEqual(invFinRow.totalCostExact, { num: '-130', den: '1' });
    assert.equal(invFinRow.costProvenanceType, 'STOCKTAKE_V2_APPROVED_EXACT');

    // Replay same postingId succeeds idempotently; mismatched postingId throws POSTING_ID_CONFLICT
    const replay = await svc.approveAndPostStocktakeAdjustmentTx(adminDb, {
      branchId: 'khalid-1',
      sessionId: sRec,
      adminUid: 'admin-1',
      adminRole: 'admin',
      approvalId: 'apr-fefo-1',
      postingId: 'post-fefo-1',
      approvalReason: 'Approved FEFO reconciled deficit adjustment',
      adjustments: [{
        medicineId: 'med-fefo',
        adjustmentBaseUnitsDelta: -30,
        costPerBaseUnitExact: createRational(13n, 3n),
        totalCostExact: createRational(-130n, 1n),
        costStatus: 'EXACT_HISTORICAL',
      }],
    });
    assert.equal(replay.idempotentReplay, true);

    await expectReject('posting-conflict', () => svc.approveAndPostStocktakeAdjustmentTx(adminDb, {
      branchId: 'khalid-1',
      sessionId: sRec,
      adminUid: 'admin-1',
      adminRole: 'admin',
      approvalId: 'apr-OTHER',
      postingId: 'post-fefo-1',
      approvalReason: 'Conflicting replay',
      adjustments: [{
        medicineId: 'med-fefo',
        adjustmentBaseUnitsDelta: -30,
        costPerBaseUnitExact: createRational(13n, 3n),
        totalCostExact: createRational(-130n, 1n),
        costStatus: 'EXACT_HISTORICAL',
      }],
    }), 'POSTING_ID_CONFLICT');

    await svc.transitionStocktakeSessionStatusTx(adminDb, {
      branchId: 'khalid-1',
      sessionId: sRec,
      targetStatus: 'CLOSED',
      adminUid: 'admin-1',
    });
    assert.equal(engine.getRaw(`branches/khalid-1/stocktake_sessions_v2/${sRec}`)?.status, 'CLOSED');
  });

  await runCase('L3-06', 'Missing inventory_financials provenance fails closed to NEEDS_REVIEW + all 10 pre-posting gates + zero-variance closure + cross-branch/unverified deny', async () => {
    // 1. Missing provenance on surplus/purchase fails closed -> NEEDS_REVIEW (no buyPrice fallback!)
    engine.seedRaw('branches/khalid-1/inventory_ledger/mov-no-fin', {
      id: 'mov-no-fin',
      branchId: 'khalid-1',
      medicineId: 'med-2',
      batchNumber: 'B-NOFIN',
      expiry: '2027-09-01',
      type: 'PURCHASE',
      unit: 'pack',
      quantityDelta: 1,
      baseUnitsDelta: 20,
      referenceId: 'po-nofin',
      userId: 'admin-1',
      businessOccurredAtMs: engine.serverNowMs - 50_000,
      createdAt: Timestamp.fromMillis(engine.serverNowMs - 50_000),
    });

    const sRev = 'sess-l3-needs-review';
    await svc.createStocktakeV2SessionAndItems(adminDb, {
      branchId: 'khalid-1',
      sessionId: sRev,
      sessionNumber: 'ST-L3-REV',
      scopeMode: 'PARTIAL',
      adminUid: 'admin-1',
      adminDisplayName: 'Admin 1',
      items: [{ medicineId: 'med-2', medicineName: 'Paracetamol', availableUnits: ['pack'] }],
    });
    await svc.acquireStocktakeLeaseTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: sRev,
      medicineId: 'med-2',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      deviceId: 'dev-c1',
      leaseId: 'lease-rev-1',
    });
    await svc.submitStocktakeCountTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: sRev,
      medicineId: 'med-2',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      actorRole: 'cashier',
      deviceId: 'dev-c1',
      countedQuantity: 0,
      countUnit: 'pack',
      baseUnitsPerCountUnit: 20,
      knownMovementIdsAtCount: ['mov-no-fin'],
    });
    const revOut = await svc.reconcileStocktakeSessionFromFirestore(adminDb, {
      branchId: 'khalid-1',
      sessionId: sRev,
      adminUid: 'admin-1',
      adminRole: 'admin',
    });
    assert.equal(revOut.reconciliationStatus, 'NEEDS_REVIEW');
    assert.equal(revOut.unresolvedItemsCount, 1);
    assert.equal(revOut.financialLinesPersisted[0].costStatus, 'NEEDS_REVIEW');

    // Cannot force PENDING_APPROVAL when unresolved > 0
    await expectReject('force-pending', () => svc.transitionStocktakeSessionStatusTx(adminDb, {
      branchId: 'khalid-1',
      sessionId: sRev,
      targetStatus: 'PENDING_APPROVAL',
      adminUid: 'admin-1',
    }), 'FINANCIAL_NOT_READY_FOR_APPROVAL');

    // 2. Stale ledger check rejects concurrent movement added after reconciliation
    await expectReject('stale-ledger-list', () => svc.approveAndPostStocktakeAdjustmentTx(adminDb, {
      branchId: 'khalid-1',
      sessionId: sRev,
      adminUid: 'admin-1',
      adminRole: 'admin',
      approvalId: 'apr-stale',
      postingId: 'post-stale',
      approvalReason: 'Should reject stale ledger',
      reconciledLedgerMovementIdsByMedicineId: { 'med-2': [] },
      adjustments: [{
        medicineId: 'med-2',
        adjustmentBaseUnitsDelta: -20,
        costPerBaseUnitExact: createRational(5n, 1n),
        totalCostExact: createRational(-100n, 1n),
      }],
    }), 'STALE_STOCK_VERSION_NEW_MOVEMENTS');

    // 3. Zero-variance closure writes zero ledger rows
    const sZero = 'sess-l3-zero';
    await svc.createStocktakeV2SessionAndItems(adminDb, {
      branchId: 'khalid-1',
      sessionId: sZero,
      sessionNumber: 'ST-L3-ZERO',
      scopeMode: 'PARTIAL',
      adminUid: 'admin-1',
      adminDisplayName: 'Admin 1',
      items: [{ medicineId: 'med-syrup', medicineName: 'Syrup', availableUnits: ['pack'] }],
    });
    await svc.acquireStocktakeLeaseTx(c1Db, {
      branchId: 'khalid-1',
      sessionId: sZero,
      medicineId: 'med-syrup',
      actorUid: 'cashier-1',
      actorDisplayName: 'Cashier 1',
      deviceId: 'dev-c1',
      leaseId: 'lease-z-1',
    });
    await svc.submitStocktakeCountTx(c1Db, {
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
    const recZero = await svc.reconcileStocktakeSessionFromFirestore(adminDb, {
      branchId: 'khalid-1',
      sessionId: sZero,
      adminUid: 'admin-1',
      adminRole: 'admin',
    });
    assert.equal(recZero.zeroVarianceReady, true);
    await svc.transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sZero, targetStatus: 'APPROVED', adminUid: 'admin-1' });
    const zeroPost = await svc.approveAndPostStocktakeAdjustmentTx(adminDb, {
      branchId: 'khalid-1',
      sessionId: sZero,
      adminUid: 'admin-1',
      adminRole: 'admin',
      approvalId: 'apr-z-1',
      postingId: 'post-z-1',
      approvalReason: 'Zero variance verified cleanly',
      allowZeroVarianceClosure: true,
      adjustments: [],
    });
    assert.equal(zeroPost.zeroVarianceClosed, true);
    assert.deepEqual(zeroPost.postedLedgerIds, []);
    await svc.transitionStocktakeSessionStatusTx(adminDb, { branchId: 'khalid-1', sessionId: sZero, targetStatus: 'CLOSED', adminUid: 'admin-1' });

    // 4. Cross-branch & unverified email denied
    await expectReject('cross-branch-admin2', () => svc.loadAdminStocktakeSessionDetails(admin2Db, 'khalid-1', sZero), 'PERMISSION_DENIED');
    await expectReject('unverified-cashier', () => svc.loadCashierStocktakeOperationalViews(unverifiedDb, 'khalid-1', sZero, 'cashier-1'), 'PERMISSION_DENIED');
  });

  console.log('\n============================================================');
  console.log(`PHASE 2F PR-F2 LEVEL 3 (RULES-MIRROR + MOCK TX): ${passed} PASSED, ${failed} FAILED (TOTAL: ${passed + failed})`);
  console.log('NOTE: Level 3 in-memory Rules-Mirror only. Real Firestore Emulator (Level 4) requires Java + firebase-tools.');
  console.log('============================================================');
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL LEVEL 3 TEST ERROR:', err);
  process.exit(1);
});
