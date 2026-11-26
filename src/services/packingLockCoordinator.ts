/**
 * PR-2D Packing Lock Coordinator.
 *
 * Pure decision layer shared by the IndexedDB mutation boundary and migration
 * audit. It treats incomplete evidence as locked and never unlocks a medicine.
 */
export interface PackingLockEvidenceSnapshot {
  firstInventoryMovement: boolean;
  historicalLedgerCount: number;
  pendingV1SyncCount: number;
  pendingV2SyncCount: number;
  unresolvedBackupReview: boolean;
  openReconciliation: boolean;
  openStocktaking: boolean;
  unpostedOcrDraft: boolean;
  quarantineOrUnverified: boolean;
  permanentLock: boolean;
  evidenceAvailable: boolean;
  unknownReasons?: readonly string[];
}

export interface PackingMutationShape {
  stripsPerPack?: unknown;
  pillsPerStrip?: unknown;
  baseUnitsPerPack?: unknown;
  dosageForm?: unknown;
  unitDefinitionKey?: unknown;
  baseDimensionKey?: unknown;
  unitDefinition?: unknown;
}

export interface PackingLockDecision {
  locked: boolean;
  failClosed: boolean;
  reasons: readonly string[];
  unknownReasons: readonly string[];
}

const DIMENSIONAL_FIELDS = [
  'stripsPerPack',
  'pillsPerStrip',
  'baseUnitsPerPack',
  'dosageForm',
  'unitDefinitionKey',
  'baseDimensionKey',
  'unitDefinition',
] as const;

function stableValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return '[' + value.map(stableValue).join(',') + ']';
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error('NON_PLAIN_PACKING_VALUE');
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableValue((value as Record<string, unknown>)[key])).join(',') + '}';
}

export function evaluatePackingLockSnapshot(
  evidence: PackingLockEvidenceSnapshot | null | undefined
): PackingLockDecision {
  if (!evidence || typeof evidence !== 'object' || evidence.evidenceAvailable !== true) {
    return Object.freeze({
      locked: true,
      failClosed: true,
      reasons: Object.freeze(['EVIDENCE_UNAVAILABLE']),
      unknownReasons: Object.freeze([...(evidence?.unknownReasons ?? []), 'PACKING_LOCK_EVIDENCE_UNAVAILABLE']),
    });
  }
  const unknownReasons = [...(evidence.unknownReasons ?? [])];
  const validCount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!validCount(evidence.historicalLedgerCount) ||
      !validCount(evidence.pendingV1SyncCount) ||
      !validCount(evidence.pendingV2SyncCount)) {
    unknownReasons.push('INVALID_PACKING_EVIDENCE_COUNT');
  }
  const reasons: string[] = [];
  if (evidence.permanentLock) reasons.push('PERMANENT_LOCK');
  if (evidence.firstInventoryMovement) reasons.push('FIRST_INVENTORY_MOVEMENT');
  if (validCount(evidence.historicalLedgerCount) && evidence.historicalLedgerCount > 0) reasons.push('HISTORICAL_LEDGER');
  if (validCount(evidence.pendingV1SyncCount) && evidence.pendingV1SyncCount > 0) reasons.push('PENDING_V1_SYNC');
  if (validCount(evidence.pendingV2SyncCount) && evidence.pendingV2SyncCount > 0) reasons.push('PENDING_V2_SYNC');
  if (evidence.unresolvedBackupReview) reasons.push('UNRESOLVED_BACKUP_REVIEW');
  if (evidence.openReconciliation) reasons.push('OPEN_RECONCILIATION');
  if (evidence.openStocktaking) reasons.push('OPEN_STOCKTAKING');
  if (evidence.unpostedOcrDraft) reasons.push('UNPOSTED_OCR_DRAFT');
  if (evidence.quarantineOrUnverified) reasons.push('QUARANTINE_OR_UNVERIFIED');
  const failClosed = unknownReasons.length > 0;
  return Object.freeze({
    locked: failClosed || reasons.length > 0,
    failClosed,
    reasons: Object.freeze(Array.from(new Set(reasons)).sort()),
    unknownReasons: Object.freeze(Array.from(new Set(unknownReasons)).sort()),
  });
}

export function hasPackingDimensionChange(
  current: PackingMutationShape,
  proposed: PackingMutationShape
): boolean {
  for (const field of DIMENSIONAL_FIELDS) {
    if (stableValue(current?.[field]) !== stableValue(proposed?.[field])) return true;
  }
  return false;
}

export function assertPackingMutationAllowed(
  current: PackingMutationShape,
  proposed: PackingMutationShape,
  decision: PackingLockDecision
): void {
  if (hasPackingDimensionChange(current, proposed) && decision.locked) {
    const detail = decision.failClosed
      ? decision.unknownReasons.join(', ')
      : decision.reasons.join(', ');
    throw new Error(`PACKING_LOCKED: Dimensional packing changes are blocked (${detail || 'unknown evidence'}).`);
  }
}

export function applyStickyPackingLock<T extends { packingLocked?: boolean; unitDefinition?: any }>(
  medicine: T,
  decision: PackingLockDecision
): T {
  if (!decision.locked || decision.failClosed) return medicine;
  const unitDefinition = medicine.unitDefinition && typeof medicine.unitDefinition === 'object'
    ? { ...medicine.unitDefinition, packingLocked: true }
    : medicine.unitDefinition;
  return { ...medicine, packingLocked: true, ...(unitDefinition ? { unitDefinition } : {}) };
}
