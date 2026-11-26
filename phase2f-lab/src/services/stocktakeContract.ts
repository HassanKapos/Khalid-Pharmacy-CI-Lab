/**
 * Phase 2F — Intelligent Continuous Stocktake
 * Pure Operational / Financial Contract, Schema Validators & Lifecycle Guards
 *
 * Security Invariants (Reconciled with Phase 2E-B.2-R3.2):
 * 1. Absolute Cashier Financial Exclusion: Operational stocktake documents
 *    NEVER contain buyPrice, costPerUnit, costPerBaseUnit, costOfGoods,
 *    grossProfit, netProfit, varianceCost, varianceSDG, inventory valuation,
 *    or financial reconciliation snapshots.
 * 2. Zero Preassignment: Never creates or supports `stocktake_assignments`.
 *    All authorized branch participants collaborate on one shared item list.
 * 3. Remaining List Privacy: Public remaining-medicines view exposes ONLY
 *    medicine identity metadata (name, strength, dosageForm, barcodes, units,
 *    countStatus) — zero quantities, zero prices, zero financial fields.
 * 4. Immutable Count & Audit History: Recounts increment countRevision and
 *    append a new OperationalCountSubmissionEvent; prior counts are never
 *    silently overwritten or deleted.
 */

import { isValidRational, type Rational } from './exactFinance.ts';

export const STOCKTAKE_CONTRACT_VERSION = 2 as const;

export const VALID_FIRESTORE_DOC_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

export type StocktakeScopeMode = 'FULL' | 'PARTIAL';

export type StocktakeCountUnit = 'pack' | 'strip' | 'pill';

export type StocktakeSessionLifecycleStatus =
  | 'DRAFT'
  | 'IN_PROGRESS'
  | 'RECONCILING'
  | 'NEEDS_REVIEW'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'POSTED'
  | 'CLOSED'
  | 'CANCELLED';

export type StocktakeItemState =
  | 'AVAILABLE'
  | 'RESERVED'
  | 'COUNTED'
  | 'NEEDS_RECOUNT'
  | 'VERIFIED';

export type StocktakeLocalSyncStatus =
  | 'LOCAL_PENDING'
  | 'SYNC_PENDING'
  | 'CONFIRMED'
  | 'CONFLICT'
  | 'FAILED';

export type StocktakeDiscrepancyStatus =
  | 'MATCHED'
  | 'UNEXPLAINED'
  | 'NEEDS_RECOUNT'
  | 'NEEDS_REVIEW'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'POSTED';

export type StocktakeCostProvenanceStatus =
  | 'EXACT_HISTORICAL'
  | 'NEEDS_REVIEW'
  | 'NOT_APPLICABLE_ZERO_VARIANCE';

export type StocktakeRole = 'super_admin' | 'admin' | 'cashier';

/**
 * Exhaustive denylist of financial, cost, valuation, profit, and sensitive
 * reconciliation keys strictly forbidden anywhere inside Operational Stocktake
 * documents or payloads (including nested objects/arrays).
 */
export const FORBIDDEN_OPERATIONAL_STOCKTAKE_FIELDS: ReadonlySet<string> = new Set([
  'buyPrice',
  'buyPriceExact',
  'costPerUnit',
  'costPerUnitExact',
  'costPerBaseUnit',
  'costPerBaseUnitExact',
  'costOfGoods',
  'costOfGoodsExact',
  'grossProfit',
  'grossProfitExact',
  'netProfit',
  'netProfitExact',
  'varianceCost',
  'varianceCostExact',
  'varianceSDG',
  'netVarianceSDG',
  'totalVarianceCost',
  'expectedInventoryValuation',
  'expectedInventoryValuationExact',
  'financialVariance',
  'financialVarianceExact',
  'approvedAcquisitionCost',
  'approvedAcquisitionCostExact',
  'adjustmentValuation',
  'adjustmentValuationExact',
  'unexplainedVarianceCost',
  'unexplainedVarianceCostExact',
  'financialReconciliationSnapshot',
  'batchCostLayers',
  'sellPrice',
  'sellPriceStrip',
  'sellPricePill',
]);

/**
 * Extra fields forbidden in the employee-facing Remaining Medicines window
 * (Section 15: names-only + safe identity/search metadata; ZERO quantities,
 * ZERO prices, ZERO financial values).
 */
export const FORBIDDEN_REMAINING_LIST_FIELDS: ReadonlySet<string> = new Set([
  ...FORBIDDEN_OPERATIONAL_STOCKTAKE_FIELDS,
  'systemStock',
  'systemQuantity',
  'systemCurrentQuantity',
  'expectedCurrentQuantity',
  'quantityVariance',
  'actualCount',
  'countedQuantity',
  'countedBaseUnits',
  'variance',
  'variancePacks',
  'minStock',
  'initialStock',
]);

/**
 * OD-4 / Fix A: Count & counter identity fields FORBIDDEN on shared operational
 * `stocktake_sessions_v2/{sessionId}/items/{medicineId}` documents.
 * Physical counts live exclusively in actor-protected `count_events/{medicineId}__r{rev}`.
 */
export const FORBIDDEN_SHARED_ITEM_COUNT_FIELDS: ReadonlySet<string> = new Set([
  'latestCountEventId',
  'latestCountedQuantity',
  'latestCountUnit',
  'latestCountBaseUnits',
  'latestCountedByUid',
  'latestCountedByName',
  'latestCountedAtServerMs',
  'latestCountedAt',
  'latestDeviceId',
  'countedQuantity',
  'countUnit',
  'countedBaseUnits',
  'systemStock',
  'systemQuantity',
  'variance',
]);

/**
 * Canonical Firestore Collection Paths (Phase 2F reconciled with R3.2).
 * Separated into:
 *   - Operational domain: readable/countable by active assigned branch staff
 *     (cashier, admin, super_admin) under strict field allowlists.
 *   - Financial/Administrative domain: strictly Admin & Super Admin only.
 */
export const STOCKTAKE_FIRESTORE_PATHS = Object.freeze({
  // Operational domain (cashier + admin + super_admin within branch; zero financial fields)
  operationalSession: (branchId: string, sessionId: string) =>
    `branches/${branchId}/stocktake_sessions_v2/${sessionId}`,
  operationalItem: (branchId: string, sessionId: string, medicineId: string) =>
    `branches/${branchId}/stocktake_sessions_v2/${sessionId}/items/${medicineId}`,
  operationalCountEvent: (branchId: string, sessionId: string, eventId: string) =>
    `branches/${branchId}/stocktake_sessions_v2/${sessionId}/count_events/${eventId}`,
  operationalAuditEvent: (branchId: string, sessionId: string, auditId: string) =>
    `branches/${branchId}/stocktake_sessions_v2/${sessionId}/operational_audit/${auditId}`,

  // Financial & Administrative domain (admin + super_admin ONLY; cashier DENY)
  financialSession: (branchId: string, sessionId: string) =>
    `branches/${branchId}/stocktake_financials/${sessionId}`,
  financialLine: (branchId: string, sessionId: string, medicineId: string) =>
    `branches/${branchId}/stocktake_financials/${sessionId}/lines/${medicineId}`,
  financialApproval: (branchId: string, sessionId: string, approvalId: string) =>
    `branches/${branchId}/stocktake_financials/${sessionId}/approvals/${approvalId}`,
  financialPosting: (branchId: string, sessionId: string, postingId: string) =>
    `branches/${branchId}/stocktake_financials/${sessionId}/postings/${postingId}`,
  financialAuditEvent: (branchId: string, sessionId: string, auditId: string) =>
    `branches/${branchId}/stocktake_financials/${sessionId}/financial_audit/${auditId}`,
});

export interface StocktakeCountWatermark {
  /** Authoritative business occurrence timestamp (ms epoch) when physical shelf count completed */
  countBusinessAtMs: number;
  /** Local IndexedDB persistence timestamp (ms epoch) */
  localPersistedAtMs: number;
  /** Firestore server confirmation timestamp (ms epoch), null until CONFIRMED */
  serverConfirmedAtMs: number | null;
  /** Optional monotonic per-branch ledger sequence (populated when ledger seq extension is active) */
  branchLedgerSeq?: number | null;
  /** Optional monotonic per-medicine ledger sequence */
  medicineLedgerSeq?: number | null;
  /** Immutable snapshot of verified ledger movement IDs for this medicine already reflected in physical shelf state */
  knownMovementIdsAtCount: ReadonlyArray<string>;
  /** Count of known ledger movements at snapshot time */
  knownMovementCount: number;
  /** Hash/fingerprint of sorted knownMovementIdsAtCount for tamper/completeness verification */
  watermarkDigest: string;
}

export interface OperationalStocktakeSession {
  id: string;
  branchId: string;
  sessionNumber: string;
  schemaVersion: typeof STOCKTAKE_CONTRACT_VERSION;
  scopeMode: StocktakeScopeMode;
  status: StocktakeSessionLifecycleStatus;
  totalTargetItems: number;
  confirmedCountedItems: number;
  remainingItemsCount: number;
  recountRequestedItemsCount: number;
  verifiedItemsCount: number;
  createdByUid: string;
  createdByName: string;
  cancelledByUid?: string;
  cancellationReason?: string;
  createdAtMs: number;
  updatedAtMs: number;
  closedAtMs?: number;
}

export interface OperationalStocktakeLease {
  leaseId: string;
  sessionId: string;
  branchId: string;
  medicineId: string;
  ownerUid: string;
  ownerDisplayName: string;
  deviceId: string;
  createdAtServerMs: number;
  expiresAtServerMs: number;
  leaseVersion: number;
  renewalCount: number;
}

export interface OperationalStocktakeItem {
  id: string; // == medicineId (deterministic 1 doc per medicine per session, no preassignment)
  sessionId: string;
  branchId: string;
  medicineId: string;
  medicineName: string; // English trade name preserved
  strength: string;
  dosageForm: string;
  primaryBarcode: string;
  secondaryBarcodes: ReadonlyArray<string>;
  availableUnits: ReadonlyArray<StocktakeCountUnit>;
  state: StocktakeItemState;
  syncStatus: StocktakeLocalSyncStatus;
  activeLease: OperationalStocktakeLease | null;
  /** Monotonic version incremented on every lease acquisition/renewal/release/count/recount */
  leaseVersion: number;
  /** Monotonic revision of confirmed counts (0 = uncounted, 1 = initial count, 2+ = recount) */
  countRevision: number;
  /**
   * OD-4 / Fix A: Shared operational item documents MUST NOT store count quantities,
   * count units, counter UIDs/names, device IDs, or count event IDs.
   * All physical counts live strictly in actor-protected `count_events/{medicineId}__r{countRevision}`.
   */
  recountReason: string | null;
  operationalDiscrepancyFlag: 'NONE' | 'RECOUNT_REQUIRED' | 'CONFLICT_DETECTED' | 'UNDER_REVIEW';
  updatedAtMs: number;
}

/**
 * Append-only operational count submission record.
 * Every count & recount creates a NEW immutable event — previous counts are NEVER overwritten.
 */
export interface OperationalCountSubmissionEvent {
  eventId: string;
  idempotencyKey: string;
  sessionId: string;
  branchId: string;
  medicineId: string;
  countRevision: number;
  leaseId: string;
  leaseVersion: number;
  countedQuantity: number;
  countUnit: StocktakeCountUnit;
  baseUnitsPerCountUnit: number;
  countedBaseUnits: number;
  actorUid: string;
  actorDisplayName: string;
  deviceId: string;
  watermark: StocktakeCountWatermark;
  syncStatus: StocktakeLocalSyncStatus;
  recountOfEventId: string | null;
  notes: string;
}

/**
 * Strict projection for the employee-facing Remaining Medicines window (Section 15).
 * Contains ZERO quantities, ZERO prices, ZERO financial values.
 */
export interface RemainingMedicinePublicView {
  medicineId: string;
  medicineName: string;
  strength: string;
  dosageForm: string;
  primaryBarcode: string;
  secondaryBarcodes: ReadonlyArray<string>;
  availableUnits: ReadonlyArray<StocktakeCountUnit>;
  countStatus: Extract<StocktakeItemState, 'AVAILABLE' | 'RESERVED' | 'NEEDS_RECOUNT'>;
  reservedByCurrentUser: boolean;
}

/**
 * Financial & Administrative Domain — strictly Admin / Super Admin only.
 */
export interface FinancialStocktakeLine {
  id: string; // == medicineId
  sessionId: string;
  branchId: string;
  medicineId: string;
  reconciliationVersion: number;
  sourceCountEventId: string;
  sourceCountRevision: number;
  countedBaseUnitsAtReference: number;
  netPostCountBaseUnitsDelta: number;
  expectedCurrentBaseUnits: number;
  systemCurrentBaseUnits: number;
  /**
   * Authoritative Section 10.2 sign convention:
   * QuantityVariance = SystemCurrentQuantity - ExpectedCurrentQuantity
   *   > 0 => physical DEFICIT (ledger adjustment delta = -QuantityVariance < 0)
   *   < 0 => physical SURPLUS (ledger adjustment delta = -QuantityVariance > 0)
   *   = 0 => MATCHED
   */
  quantityVarianceBaseUnits: number;
  /** Exact ledger adjustment required to align system to expected physical = -quantityVarianceBaseUnits */
  requiredLedgerAdjustmentBaseUnits: number;
  discrepancyStatus: StocktakeDiscrepancyStatus;
  costStatus: StocktakeCostProvenanceStatus;
  /** Exact Rational financial valuation impact (SDG), null whenever costStatus === 'NEEDS_REVIEW' */
  financialVarianceExact: Rational | null;
  expectedInventoryValuationExact: Rational | null;
  approvedAcquisitionCostExact: Rational | null;
  /** Hard integrity blockers that CANNOT be bypassed by unexplained-variance approval */
  integrityBlockers: ReadonlyArray<string>;
  investigationReason: string | null;
  investigatedByUid: string | null;
  investigatedAtMs: number | null;
  approvalId: string | null;
  approvedByUid: string | null;
  approvedAtMs: number | null;
  postingId: string | null;
  postedLedgerMovementId: string | null;
  postedAtMs: number | null;
  reconciledAtMs: number;
}

export interface FinancialApprovalRecord {
  approvalId: string;
  sessionId: string;
  branchId: string;
  medicineId: string;
  reconciliationVersion: number;
  decision: 'APPROVED' | 'REJECTED';
  isUnexplainedVarianceException: boolean;
  reason: string;
  investigationRecordId: string;
  approverUid: string;
  approverRole: 'admin' | 'super_admin';
  approvedAtServerMs: number;
}

export interface StocktakePostingRecord {
  postingId: string;
  idempotencyKey: string;
  sessionId: string;
  branchId: string;
  medicineId: string;
  reconciliationVersion: number;
  countRevision: number;
  approvalId: string;
  ledgerMovementId: string;
  adjustmentBaseUnitsDelta: number;
  costStatus: StocktakeCostProvenanceStatus;
  adjustmentValuationExact: Rational | null;
  postedByUid: string;
  postedAtServerMs: number;
}

export interface PayloadSafetyValidationResult {
  valid: boolean;
  forbiddenFieldsFound: string[];
  errors: string[];
}

export function isValidFirestoreDocId(value: unknown): value is string {
  return typeof value === 'string' && VALID_FIRESTORE_DOC_ID_REGEX.test(value);
}

/**
 * Recursively scans any object/array for forbidden financial/sensitive keys.
 * Fail-closed: rejects forbidden keys at any nesting depth.
 */
export function scanForForbiddenKeys(
  payload: unknown,
  forbiddenSet: ReadonlySet<string>,
  prefix = '',
  seen = new WeakSet<object>()
): string[] {
  const hits: string[] = [];
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return hits;
  }
  if (seen.has(payload as object)) {
    return hits;
  }
  seen.add(payload as object);

  if (Array.isArray(payload)) {
    for (let i = 0; i < payload.length; i++) {
      hits.push(...scanForForbiddenKeys(payload[i], forbiddenSet, `${prefix}[${i}]`, seen));
    }
    return hits;
  }

  for (const key of Object.keys(payload as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (forbiddenSet.has(key)) {
      hits.push(path);
    }
    const val = (payload as Record<string, unknown>)[key];
    if (val !== null && typeof val === 'object') {
      hits.push(...scanForForbiddenKeys(val, forbiddenSet, path, seen));
    }
  }
  return hits;
}

/**
 * Validates that an operational stocktake payload contains ZERO financial fields
 * anywhere in its object graph.
 */
export function assertOperationalStocktakePayloadSafe(
  payload: unknown
): PayloadSafetyValidationResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      forbiddenFieldsFound: [],
      errors: ['Operational stocktake payload must be a plain object.'],
    };
  }
  const forbiddenFieldsFound = scanForForbiddenKeys(payload, FORBIDDEN_OPERATIONAL_STOCKTAKE_FIELDS);
  if (forbiddenFieldsFound.length > 0) {
    return {
      valid: false,
      forbiddenFieldsFound,
      errors: [
        `FINANCIAL_FIELD_INJECTION_BLOCKED: Operational stocktake payload contains forbidden financial fields: ${forbiddenFieldsFound.join(', ')}`,
      ],
    };
  }
  return { valid: true, forbiddenFieldsFound: [], errors: [] };
}

/**
 * OD-4 / Fix A: Validates that a shared `OperationalStocktakeItem` document contains
 * ZERO financial fields AND ZERO count quantity / counter identity fields.
 */
export function assertSharedOperationalItemSafe(
  payload: unknown
): PayloadSafetyValidationResult {
  const baseCheck = assertOperationalStocktakePayloadSafe(payload);
  if (!baseCheck.valid) {
    return baseCheck;
  }
  const countLeaks = scanForForbiddenKeys(payload, FORBIDDEN_SHARED_ITEM_COUNT_FIELDS);
  if (countLeaks.length > 0) {
    return {
      valid: false,
      forbiddenFieldsFound: countLeaks,
      errors: [
        `SHARED_ITEM_COUNT_LEAK_BLOCKED: Shared OperationalStocktakeItem contains forbidden count/counter fields: ${countLeaks.join(', ')}`,
      ],
    };
  }
  return { valid: true, forbiddenFieldsFound: [], errors: [] };
}

/**
 * Builds the strict employee-facing Remaining Medicines projection.
 * Guaranteed to expose ONLY uncounted/recount-eligible items and ZERO quantities,
 * ZERO prices, and ZERO financial fields.
 */
export function buildRemainingMedicinesPublicView(
  items: ReadonlyArray<OperationalStocktakeItem>,
  currentActorUid: string
): RemainingMedicinePublicView[] {
  const result: RemainingMedicinePublicView[] = [];
  for (const item of items) {
    // Confirmed COUNTED or VERIFIED items are removed from the shared remaining list.
    // LOCAL_PENDING / SYNC_PENDING items remain visible until shared persistence is CONFIRMED!
    const isGloballyDone =
      item.syncStatus === 'CONFIRMED' && (item.state === 'COUNTED' || item.state === 'VERIFIED');
    if (isGloballyDone) {
      continue;
    }

    const effectiveStatus: RemainingMedicinePublicView['countStatus'] =
      item.state === 'RESERVED'
        ? 'RESERVED'
        : item.state === 'NEEDS_RECOUNT'
          ? 'NEEDS_RECOUNT'
          : 'AVAILABLE';

    const view: RemainingMedicinePublicView = {
      medicineId: item.medicineId,
      medicineName: item.medicineName,
      strength: item.strength,
      dosageForm: item.dosageForm,
      primaryBarcode: item.primaryBarcode,
      secondaryBarcodes: [...item.secondaryBarcodes],
      availableUnits: [...item.availableUnits],
      countStatus: effectiveStatus,
      reservedByCurrentUser:
        effectiveStatus === 'RESERVED' && item.activeLease?.ownerUid === currentActorUid,
    };

    const leaks = scanForForbiddenKeys(view, FORBIDDEN_REMAINING_LIST_FIELDS);
    if (leaks.length > 0) {
      throw new Error(`REMAINING_VIEW_PRIVACY_VIOLATION: ${leaks.join(', ')}`);
    }
    result.push(view);
  }
  return result;
}


/**
 * OD-2F-3 Binding Cashier Visibility Projection (Approved Option A):
 * Cashiers may see ONLY their own server-confirmed physical quantity and unit of measurement.
 * Strictly prohibits systemStock, variance, buyPrice, cost*, valuation, profit, or margin.
 */
export const FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS: ReadonlySet<string> = new Set<string>([
  ...FORBIDDEN_OPERATIONAL_STOCKTAKE_FIELDS,
  'systemStock',
  'systemQuantity',
  'systemCurrentQuantity',
  'expectedCurrentQuantity',
  'quantityVariance',
  'variance',
  'varianceBaseUnits',
  'discrepancy',
  'sellPrice',
  'sellPricePack',
  'sellPriceStrip',
  'sellPricePill',
]);

export interface CashierOwnConfirmedCountView {
  readonly medicineId: string;
  readonly medicineName: string;
  readonly countRevision: number;
  readonly countedQuantity: number;
  readonly countUnit: StocktakeCountUnit;
  readonly confirmedAtServerMs: number | null;
}

export function buildCashierOwnConfirmedCountsView(
  events: ReadonlyArray<OperationalCountSubmissionEvent>,
  currentActorUid: string,
  medicineNameById: Readonly<Record<string, string>> = {}
): CashierOwnConfirmedCountView[] {
  if (!currentActorUid || currentActorUid.trim().length === 0) {
    return [];
  }
  // Keep latest confirmed revision per medicine strictly for currentActorUid.
  // Fails closed if any foreign actorUid event is passed into this cashier projection.
  const latestByMedicine = new Map<string, OperationalCountSubmissionEvent>();
  for (const ev of events) {
    if (ev.actorUid !== currentActorUid) {
      throw new Error(
        `CASHIER_CONFIRMED_VIEW_CROSS_ACTOR_VIOLATION: Foreign actor event must never enter cashier view.`
      );
    }
    if (ev.syncStatus !== 'CONFIRMED') continue;
    if (
      typeof ev.countedQuantity !== 'number' ||
      !Number.isFinite(ev.countedQuantity) ||
      ev.countedQuantity < 0 ||
      !ev.countUnit
    ) {
      continue;
    }
    const prev = latestByMedicine.get(ev.medicineId);
    if (!prev || ev.countRevision > prev.countRevision) {
      latestByMedicine.set(ev.medicineId, ev);
    }
  }

  const result: CashierOwnConfirmedCountView[] = [];
  for (const ev of latestByMedicine.values()) {
    const row: CashierOwnConfirmedCountView = {
      medicineId: ev.medicineId,
      medicineName: medicineNameById[ev.medicineId] || ev.medicineId,
      countRevision: ev.countRevision,
      countedQuantity: ev.countedQuantity,
      countUnit: ev.countUnit,
      confirmedAtServerMs: ev.watermark?.serverConfirmedAtMs ?? null,
    };

    const leaks = scanForForbiddenKeys(row, FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS);
    if (leaks.length > 0) {
      throw new Error(`CASHIER_CONFIRMED_VIEW_PRIVACY_VIOLATION: ${leaks.join(', ')}`);
    }
    result.push(row);
  }
  return result;
}

/**
 * Authoritative Session Lifecycle State Machine (Section 14).
 * DRAFT -> IN_PROGRESS -> RECONCILING -> NEEDS_REVIEW -> PENDING_APPROVAL -> APPROVED -> POSTED -> CLOSED
 * Cancellation allowed strictly BEFORE POSTED with mandatory audit reason.
 * APPROVED/POSTED/CLOSED sessions can NEVER be deleted; POSTED/CLOSED can NEVER be cancelled.
 */
const ALLOWED_SESSION_TRANSITIONS: Readonly<
  Record<StocktakeSessionLifecycleStatus, ReadonlySet<StocktakeSessionLifecycleStatus>>
> = Object.freeze({
  DRAFT: new Set<StocktakeSessionLifecycleStatus>(['IN_PROGRESS', 'CANCELLED']),
  IN_PROGRESS: new Set<StocktakeSessionLifecycleStatus>(['RECONCILING', 'CANCELLED']),
  RECONCILING: new Set<StocktakeSessionLifecycleStatus>([
    'NEEDS_REVIEW',
    'PENDING_APPROVAL',
    'IN_PROGRESS',
    'CANCELLED',
  ]),
  NEEDS_REVIEW: new Set<StocktakeSessionLifecycleStatus>([
    'RECONCILING',
    'PENDING_APPROVAL',
    'IN_PROGRESS',
    'CANCELLED',
  ]),
  PENDING_APPROVAL: new Set<StocktakeSessionLifecycleStatus>([
    'APPROVED',
    'NEEDS_REVIEW',
    'CANCELLED',
  ]),
  APPROVED: new Set<StocktakeSessionLifecycleStatus>(['POSTED', 'NEEDS_REVIEW', 'CANCELLED']),
  POSTED: new Set<StocktakeSessionLifecycleStatus>(['CLOSED']),
  CLOSED: new Set<StocktakeSessionLifecycleStatus>([]),
  CANCELLED: new Set<StocktakeSessionLifecycleStatus>([]),
});

export function canTransitionStocktakeSessionState(params: {
  from: StocktakeSessionLifecycleStatus;
  to: StocktakeSessionLifecycleStatus;
  actorRole: StocktakeRole;
  cancellationReason?: string;
}): { allowed: boolean; reason?: string } {
  const { from, to, actorRole, cancellationReason } = params;
  if (actorRole === 'cashier') {
    return {
      allowed: false,
      reason: 'UNAUTHORIZED_SESSION_TRANSITION: Cashiers cannot transition stocktake session lifecycle state.',
    };
  }
  if (!ALLOWED_SESSION_TRANSITIONS[from]?.has(to)) {
    return {
      allowed: false,
      reason: `INVALID_SESSION_TRANSITION: Transition ${from} -> ${to} is forbidden.`,
    };
  }
  if (to === 'CANCELLED') {
    if (typeof cancellationReason !== 'string' || cancellationReason.trim().length < 5) {
      return {
        allowed: false,
        reason: 'CANCELLATION_REASON_REQUIRED: Cancellation before posting requires a non-empty audit reason (>= 5 chars).',
      };
    }
  }
  return { allowed: true };
}

export function canDeleteStocktakeSession(status: StocktakeSessionLifecycleStatus): boolean {
  // Policy: Approved, posted, closed, and audit-active sessions are NEVER deletable.
  return status === 'DRAFT';
}

/**
 * Deterministic, collision-resistant idempotency keys & Firestore-safe document IDs.
 */
function fnv1aHex(input: string): string {
  // Dual 32-bit FNV-1a with distinct seeds -> 16 hex chars, pure sync JS with zero crypto runtime dependency
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + ((i & 0xff) << 8);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const p1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const p2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${p1}${p2}`;
}

export function computeMovementWatermarkDigest(movementIds: ReadonlyArray<string>): string {
  const sorted = [...new Set(movementIds)].sort();
  return `wm_${sorted.length}_${fnv1aHex(sorted.join('|'))}`;
}

export function buildStocktakeCountIdempotencyKey(params: {
  branchId: string;
  sessionId: string;
  medicineId: string;
  countRevision: number;
  leaseVersion: number;
  actorUid: string;
}): string {
  return `stk_count_v2:${params.branchId}:${params.sessionId}:${params.medicineId}:rev${params.countRevision}:lv${params.leaseVersion}:${params.actorUid}`;
}

export function buildStocktakeCountEventId(params: {
  sessionId?: string;
  medicineId: string;
  countRevision: number;
}): string {
  if (!isValidFirestoreDocId(params.medicineId) || !Number.isSafeInteger(params.countRevision) || params.countRevision < 1) {
    throw new Error(`Invalid count event ID parameters: medicineId=${params.medicineId}, countRevision=${params.countRevision}`);
  }
  // Canonical event ID verified atomically by Firestore Security Rules `canSubmitStocktakeV2Count`
  // without storing latestCountEventId or any counter metadata on shared `items/{medicineId}`.
  const raw = `${params.medicineId}__r${params.countRevision}`;
  if (!isValidFirestoreDocId(raw)) {
    throw new Error(`Invalid generated count event ID: ${raw}`);
  }
  return raw;
}

export function buildStocktakePostingIdempotencyKey(params: {
  branchId: string;
  sessionId: string;
  medicineId: string;
  reconciliationVersion: number;
}): string {
  return `stk_post_v2:${params.branchId}:${params.sessionId}:${params.medicineId}:rv${params.reconciliationVersion}`;
}

export function buildStocktakeAdjustmentLedgerId(params: {
  branchId: string;
  sessionId: string;
  medicineId: string;
  reconciliationVersion: number;
}): string {
  const hash1 = fnv1aHex(`${params.branchId}|${params.sessionId}|${params.medicineId}|${params.reconciliationVersion}`);
  const hash2 = fnv1aHex(`adj|${params.medicineId}|${params.sessionId}|${params.branchId}|v${params.reconciliationVersion}`);
  const id = `stkadj_${hash1}${hash2}`;
  if (!isValidFirestoreDocId(id)) {
    throw new Error(`Invalid generated adjustment ledger ID: ${id}`);
  }
  return id;
}

export function validateFinancialLineExactInvariants(line: FinancialStocktakeLine): string[] {
  const errors: string[] = [];
  if (!isValidFirestoreDocId(line.id) || line.id !== line.medicineId) {
    errors.push('FinancialStocktakeLine.id must equal medicineId and be a valid Firestore ID.');
  }
  if (!Number.isSafeInteger(line.countedBaseUnitsAtReference) || line.countedBaseUnitsAtReference < 0) {
    errors.push('countedBaseUnitsAtReference must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(line.netPostCountBaseUnitsDelta)) {
    errors.push('netPostCountBaseUnitsDelta must be a safe integer.');
  }
  const expectedCalc = line.countedBaseUnitsAtReference + line.netPostCountBaseUnitsDelta;
  if (line.expectedCurrentBaseUnits !== expectedCalc) {
    errors.push(`expectedCurrentBaseUnits (${line.expectedCurrentBaseUnits}) != counted + netPostCount (${expectedCalc}).`);
  }
  const varianceCalc = line.systemCurrentBaseUnits - line.expectedCurrentBaseUnits;
  if (line.quantityVarianceBaseUnits !== varianceCalc) {
    errors.push(`quantityVarianceBaseUnits (${line.quantityVarianceBaseUnits}) != system - expected (${varianceCalc}).`);
  }
  if (line.requiredLedgerAdjustmentBaseUnits !== -line.quantityVarianceBaseUnits) {
    errors.push('requiredLedgerAdjustmentBaseUnits must equal -quantityVarianceBaseUnits.');
  }
  if (line.costStatus === 'NEEDS_REVIEW' && line.financialVarianceExact !== null) {
    errors.push('NEEDS_REVIEW financial line must not invent a non-null financialVarianceExact.');
  }
  if (line.financialVarianceExact !== null && !isValidRational(line.financialVarianceExact)) {
    errors.push('financialVarianceExact must be a valid Rational when present.');
  }
  return errors;
}
