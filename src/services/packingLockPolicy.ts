/**
 * PR-1 Packing Lock Policy Kernel (Pure, Side-Effect-Free)
 *
 * Evaluates whether a proposed medicine unit-definition or descriptive update is permitted.
 * - Validates both current and proposed UnitDefinitions structurally (`assertUnitDefinitionIntegrity`).
 * - Fails closed on missing/malformed evidence, null/malformed requests, or disallowed metadata fields.
 * - Prohibits dimensional/conversion changes once inventory movements, ledger history,
 *   pending V1/V2 sync operations, backup review, open reconciliation, or permanent locks exist.
 * - Allows safe descriptive metadata updates ONLY from an explicit allowlist when dimensions and
 *   conversion meaning stay strictly unchanged.
 * - Never provides an automatic unlock mechanism.
 *
 * TRUST BOUNDARY NOTE:
 * A pure client-side function CANNOT independently prove that caller-supplied `evidence` booleans
 * or counts reflect actual database state. Caller-supplied fabricated clean evidence lies outside
 * this pure function's trust boundary. Therefore:
 * 1. PR-2 local callers MUST collect `PackingLockEvidence` inside authoritative IndexedDB transactions.
 * 2. Cloud/multi-branch authoritative enforcement MUST be duplicated in Firestore Security Rules / server checks.
 */

import {
  assertUnitDefinitionIntegrity,
  type ImmutableSellableUnits,
  type SupportedUnitKind,
  type UnitDefinition,
} from './universalUnitPolicy.ts';

export type PackingLockReasonCode =
  | 'ALLOWED_DESCRIPTIVE_METADATA_ONLY'
  | 'ALLOWED_DIMENSIONAL_UPDATE_UNLOCKED'
  | 'INVALID_LOCK_REQUEST'
  | 'MISSING_LOCK_EVIDENCE'
  | 'INVALID_LOCK_EVIDENCE'
  | 'INVALID_CURRENT_UNIT_DEFINITION'
  | 'INVALID_PROPOSED_UNIT_DEFINITION'
  | 'INVALID_METADATA_FIELDS'
  | 'DISALLOWED_METADATA_FIELD'
  | 'AMBIGUOUS_METADATA_UPDATE'
  | 'PACKING_PERMANENTLY_LOCKED'
  | 'CANNOT_UNLOCK_PACKING'
  | 'LOCKED_BY_FIRST_MOVEMENT'
  | 'LOCKED_BY_HISTORICAL_LEDGER'
  | 'LOCKED_BY_PENDING_V1_SYNC'
  | 'LOCKED_BY_PENDING_V2_SYNC'
  | 'LOCKED_BY_BACKUP_REVIEW'
  | 'LOCKED_BY_OPEN_RECONCILIATION'
  | 'VERSION_DOWNGRADE_FORBIDDEN';

export const DESCRIPTIVE_METADATA_ALLOWLIST = Object.freeze([
  'commercialName',
  'genericName',
  'scientificName',
  'manufacturer',
  'barcode',
  'category',
  'shelfLocation',
  'notes',
  'minStockAlert',
  'supplierName',
  'description',
] as const);

const ALLOWLIST_SET = new Set<string>(DESCRIPTIVE_METADATA_ALLOWLIST);

export interface PackingLockEvidence {
  readonly hasFirstInventoryMovement: boolean;
  readonly historicalLedgerCount: number;
  readonly pendingOutboxV1Count: number;
  readonly pendingOutboxV2Count: number;
  readonly unresolvedBackupReview: boolean;
  readonly openReconciliation: boolean;
  readonly existingPermanentPackingLock: boolean;
}

export interface PackingChangeRequest {
  readonly currentDefinition: UnitDefinition;
  readonly proposedDefinition?: UnitDefinition;
  readonly requestedPackingLocked?: boolean;
  readonly descriptiveMetadataFieldsChanged?: ReadonlyArray<string>;
}

export interface PackingLockEvaluation {
  readonly allowed: boolean;
  readonly effectiveLocked: boolean;
  /** Authoritative sticky lock flag callers must persist when applying allowed metadata updates. */
  readonly persistedPackingLocked: boolean;
  readonly isDimensionalChange: boolean;
  readonly reasonCode: PackingLockReasonCode;
  readonly activeLockReasons: ReadonlyArray<PackingLockReasonCode>;
  /** Normalized frozen proposed definition with persistedPackingLocked enforced when allowed & supplied. */
  readonly normalizedProposedDefinition?: UnitDefinition;
  readonly message: string;
}

const REQUIRED_BOOLEAN_EVIDENCE_FIELDS = [
  'hasFirstInventoryMovement',
  'unresolvedBackupReview',
  'openReconciliation',
  'existingPermanentPackingLock',
] as const;

const REQUIRED_COUNT_EVIDENCE_FIELDS = [
  'historicalLedgerCount',
  'pendingOutboxV1Count',
  'pendingOutboxV2Count',
] as const;

function validateEvidence(
  evidence: PackingLockEvidence | null | undefined
):
  | { ok: true; activeReasons: PackingLockReasonCode[] }
  | { ok: false; reasonCode: 'MISSING_LOCK_EVIDENCE' | 'INVALID_LOCK_EVIDENCE'; message: string } {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return {
      ok: false,
      reasonCode: 'MISSING_LOCK_EVIDENCE',
      message: 'Packing lock evidence object is missing; failing closed.',
    };
  }

  for (const field of REQUIRED_BOOLEAN_EVIDENCE_FIELDS) {
    const val = (evidence as unknown as Record<string, unknown>)[field];
    if (val === undefined || val === null) {
      return {
        ok: false,
        reasonCode: 'MISSING_LOCK_EVIDENCE',
        message: `Required lock evidence boolean '${field}' is missing.`,
      };
    }
    if (typeof val !== 'boolean') {
      return {
        ok: false,
        reasonCode: 'INVALID_LOCK_EVIDENCE',
        message: `Lock evidence field '${field}' must be boolean.`,
      };
    }
  }

  for (const field of REQUIRED_COUNT_EVIDENCE_FIELDS) {
    const val = (evidence as unknown as Record<string, unknown>)[field];
    if (val === undefined || val === null) {
      return {
        ok: false,
        reasonCode: 'MISSING_LOCK_EVIDENCE',
        message: `Required lock evidence count '${field}' is missing.`,
      };
    }
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) {
      return {
        ok: false,
        reasonCode: 'INVALID_LOCK_EVIDENCE',
        message: `Lock evidence count '${field}' must be a non-negative safe integer.`,
      };
    }
  }

  const activeReasons: PackingLockReasonCode[] = [];
  if (evidence.existingPermanentPackingLock) activeReasons.push('PACKING_PERMANENTLY_LOCKED');
  if (evidence.hasFirstInventoryMovement) activeReasons.push('LOCKED_BY_FIRST_MOVEMENT');
  if (evidence.historicalLedgerCount > 0) activeReasons.push('LOCKED_BY_HISTORICAL_LEDGER');
  if (evidence.pendingOutboxV1Count > 0) activeReasons.push('LOCKED_BY_PENDING_V1_SYNC');
  if (evidence.pendingOutboxV2Count > 0) activeReasons.push('LOCKED_BY_PENDING_V2_SYNC');
  if (evidence.unresolvedBackupReview) activeReasons.push('LOCKED_BY_BACKUP_REVIEW');
  if (evidence.openReconciliation) activeReasons.push('LOCKED_BY_OPEN_RECONCILIATION');

  return { ok: true, activeReasons };
}

function sellableUnitsEqual(a: ImmutableSellableUnits, b: ImmutableSellableUnits): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item as SupportedUnitKind)) return false;
  }
  return true;
}

function isBasicCurrentDefinitionShapeValid(def: unknown): def is UnitDefinition {
  if (!def || typeof def !== 'object' || Array.isArray(def)) return false;
  const candidate = def as UnitDefinition;
  if (typeof candidate.packingLocked !== 'boolean') return false;
  if (typeof candidate.definitionVersion !== 'number' || !Number.isSafeInteger(candidate.definitionVersion) || candidate.definitionVersion < 1) {
    return false;
  }
  if (!candidate.hierarchy || typeof candidate.hierarchy !== 'object' || Array.isArray(candidate.hierarchy)) {
    return false;
  }
  const sellable = candidate.sellableUnits as unknown as {
    size?: unknown;
    has?: unknown;
    [Symbol.iterator]?: unknown;
  };
  if (
    !sellable ||
    typeof sellable !== 'object' ||
    typeof sellable.has !== 'function' ||
    typeof sellable[Symbol.iterator] !== 'function' ||
    typeof sellable.size !== 'number'
  ) {
    return false;
  }
  return true;
}

export function isDimensionalOrConversionChange(
  current: UnitDefinition,
  proposed?: UnitDefinition
): boolean {
  if (!proposed) return false;
  if (!isBasicCurrentDefinitionShapeValid(current) || !isBasicCurrentDefinitionShapeValid(proposed)) {
    return true;
  }
  if (current.dosageForm !== proposed.dosageForm) return true;
  if (current.physicalDimension !== proposed.physicalDimension) return true;
  if (current.baseDimensionKey !== proposed.baseDimensionKey) return true;
  if (current.unitDefinitionKey !== proposed.unitDefinitionKey) return true;
  if (current.baseUnit !== proposed.baseUnit) return true;
  if (current.packUnit !== proposed.packUnit) return true;
  if (current.intermediateUnit !== proposed.intermediateUnit) return true;
  if (current.baseUnitsPerPack !== proposed.baseUnitsPerPack) return true;
  if (current.hierarchy.kind !== proposed.hierarchy.kind) return true;
  if (current.hierarchy.intermediateUnit !== proposed.hierarchy.intermediateUnit) return true;
  if (current.hierarchy.baseUnitsPerPack !== proposed.hierarchy.baseUnitsPerPack) return true;
  if (current.hierarchy.kind === 'SOLID_TWO_LEVEL' && proposed.hierarchy.kind === 'SOLID_TWO_LEVEL') {
    if (
      current.hierarchy.stripsPerPack !== proposed.hierarchy.stripsPerPack ||
      current.hierarchy.pillsPerStrip !== proposed.hierarchy.pillsPerStrip
    ) {
      return true;
    }
  }
  if (!sellableUnitsEqual(current.sellableUnits, proposed.sellableUnits)) return true;
  return false;
}

function buildBlockedResult(params: {
  reasonCode: PackingLockReasonCode;
  activeLockReasons: ReadonlyArray<PackingLockReasonCode>;
  isDimensionalChange: boolean;
  effectiveLocked?: boolean;
  message: string;
}): PackingLockEvaluation {
  const effectiveLocked = params.effectiveLocked ?? true;
  return Object.freeze({
    allowed: false,
    effectiveLocked,
    persistedPackingLocked: effectiveLocked,
    isDimensionalChange: params.isDimensionalChange,
    reasonCode: params.reasonCode,
    activeLockReasons: Object.freeze([...params.activeLockReasons]),
    message: params.message,
  });
}

export function evaluatePackingLockPolicy(
  request: PackingChangeRequest,
  evidence: PackingLockEvidence | null | undefined
): PackingLockEvaluation {
  const evidenceCheck = validateEvidence(evidence);
  if (!evidenceCheck.ok) {
    return buildBlockedResult({
      reasonCode: evidenceCheck.reasonCode,
      activeLockReasons: [evidenceCheck.reasonCode],
      isDimensionalChange: Boolean(request && typeof request === 'object' && 'proposedDefinition' in request && request.proposedDefinition),
      effectiveLocked: true,
      message: evidenceCheck.message,
    });
  }

  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return buildBlockedResult({
      reasonCode: 'INVALID_LOCK_REQUEST',
      activeLockReasons: ['INVALID_LOCK_REQUEST'],
      isDimensionalChange: true,
      effectiveLocked: true,
      message: 'PackingChangeRequest must be a non-null object.',
    });
  }

  const { currentDefinition, proposedDefinition, requestedPackingLocked, descriptiveMetadataFieldsChanged } = request;
  if (!currentDefinition || typeof currentDefinition !== 'object' || Array.isArray(currentDefinition)) {
    return buildBlockedResult({
      reasonCode: 'MISSING_LOCK_EVIDENCE',
      activeLockReasons: ['MISSING_LOCK_EVIDENCE'],
      isDimensionalChange: true,
      effectiveLocked: true,
      message: 'currentDefinition is required to evaluate packing lock.',
    });
  }

  if (!isBasicCurrentDefinitionShapeValid(currentDefinition)) {
    return buildBlockedResult({
      reasonCode: 'INVALID_CURRENT_UNIT_DEFINITION',
      activeLockReasons: ['INVALID_CURRENT_UNIT_DEFINITION'],
      isDimensionalChange: true,
      effectiveLocked: true,
      message: 'currentDefinition failed structural validation.',
    });
  }
  if (currentDefinition.configStatus === 'VERIFIED') {
    try {
      assertUnitDefinitionIntegrity(currentDefinition);
    } catch (err) {
      return buildBlockedResult({
        reasonCode: 'INVALID_CURRENT_UNIT_DEFINITION',
        activeLockReasons: ['INVALID_CURRENT_UNIT_DEFINITION'],
        isDimensionalChange: true,
        effectiveLocked: true,
        message: err instanceof Error ? err.message : 'currentDefinition failed integrity verification.',
      });
    }
  }

  const combinedLockReasons = [...evidenceCheck.activeReasons];
  if (currentDefinition.packingLocked && !combinedLockReasons.includes('PACKING_PERMANENTLY_LOCKED')) {
    combinedLockReasons.unshift('PACKING_PERMANENTLY_LOCKED');
  }
  const effectiveLocked = combinedLockReasons.length > 0;
  const hasPermanentLock =
    Boolean(currentDefinition.packingLocked) || Boolean(evidence?.existingPermanentPackingLock);

  // Validate proposedDefinition early when provided (fail closed on null/malformed/tampered)
  if (proposedDefinition !== undefined) {
    if (!proposedDefinition || typeof proposedDefinition !== 'object' || Array.isArray(proposedDefinition)) {
      return buildBlockedResult({
        reasonCode: 'INVALID_PROPOSED_UNIT_DEFINITION',
        activeLockReasons: combinedLockReasons.length > 0 ? combinedLockReasons : ['INVALID_PROPOSED_UNIT_DEFINITION'],
        isDimensionalChange: true,
        effectiveLocked: true,
        message: 'proposedDefinition must be a valid UnitDefinition object.',
      });
    }
    try {
      assertUnitDefinitionIntegrity(proposedDefinition);
    } catch (err) {
      return buildBlockedResult({
        reasonCode: 'INVALID_PROPOSED_UNIT_DEFINITION',
        activeLockReasons: combinedLockReasons.length > 0 ? combinedLockReasons : ['INVALID_PROPOSED_UNIT_DEFINITION'],
        isDimensionalChange: true,
        effectiveLocked: true,
        message: err instanceof Error ? err.message : 'proposedDefinition failed structural integrity verification.',
      });
    }
  }

  // Reject any attempt to explicitly unlock while lock conditions are active, or unset an existing permanent lock
  const requestsUnlock =
    requestedPackingLocked === false ||
    (hasPermanentLock && proposedDefinition !== undefined && proposedDefinition.packingLocked === false);

  if (effectiveLocked && requestsUnlock) {
    return buildBlockedResult({
      reasonCode: 'CANNOT_UNLOCK_PACKING',
      activeLockReasons: combinedLockReasons,
      isDimensionalChange: isDimensionalOrConversionChange(currentDefinition, proposedDefinition),
      effectiveLocked: true,
      message: 'Packing lock cannot be removed once movements, sync backlog, reconciliation, or permanent lock exist.',
    });
  }

  // Validate descriptiveMetadataFieldsChanged against explicit strict allowlist
  if (descriptiveMetadataFieldsChanged !== undefined) {
    if (!Array.isArray(descriptiveMetadataFieldsChanged)) {
      return buildBlockedResult({
        reasonCode: 'INVALID_METADATA_FIELDS',
        activeLockReasons: combinedLockReasons,
        isDimensionalChange: true,
        effectiveLocked,
        message: 'descriptiveMetadataFieldsChanged must be an array of field names.',
      });
    }
    for (const field of descriptiveMetadataFieldsChanged) {
      if (typeof field !== 'string' || field.trim() === '' || field.trim() !== field) {
        return buildBlockedResult({
          reasonCode: 'INVALID_METADATA_FIELDS',
          activeLockReasons: combinedLockReasons,
          isDimensionalChange: true,
          effectiveLocked,
          message: 'descriptiveMetadataFieldsChanged entries must be non-empty trimmed strings.',
        });
      }
      if (!ALLOWLIST_SET.has(field)) {
        return buildBlockedResult({
          reasonCode: 'DISALLOWED_METADATA_FIELD',
          activeLockReasons: combinedLockReasons,
          isDimensionalChange: true,
          effectiveLocked,
          message: `Field '${field}' is not in DESCRIPTIVE_METADATA_ALLOWLIST and cannot bypass dimensional lock rules.`,
        });
      }
    }
  }

  if (proposedDefinition !== undefined) {
    if (proposedDefinition.definitionVersion < currentDefinition.definitionVersion) {
      return buildBlockedResult({
        reasonCode: 'VERSION_DOWNGRADE_FORBIDDEN',
        activeLockReasons: combinedLockReasons,
        isDimensionalChange: isDimensionalOrConversionChange(currentDefinition, proposedDefinition),
        effectiveLocked,
        message: 'definitionVersion cannot be downgraded.',
      });
    }
  } else if (
    requestedPackingLocked === undefined &&
    (descriptiveMetadataFieldsChanged === undefined || descriptiveMetadataFieldsChanged.length === 0)
  ) {
    return buildBlockedResult({
      reasonCode: 'AMBIGUOUS_METADATA_UPDATE',
      activeLockReasons: combinedLockReasons,
      isDimensionalChange: true,
      effectiveLocked,
      message: 'Update request without proposedDefinition must specify at least one allowlisted descriptive metadata field.',
    });
  }

  const dimensionalChange = isDimensionalOrConversionChange(currentDefinition, proposedDefinition);
  const persistedPackingLocked = Boolean(
    effectiveLocked || requestedPackingLocked === true || proposedDefinition?.packingLocked === true
  );

  if (!dimensionalChange) {
    const normalizedProposedDefinition =
      proposedDefinition !== undefined
        ? Object.freeze({
            ...proposedDefinition,
            packingLocked: persistedPackingLocked,
          })
        : undefined;

    return Object.freeze({
      allowed: true,
      effectiveLocked,
      persistedPackingLocked,
      isDimensionalChange: false,
      reasonCode: 'ALLOWED_DESCRIPTIVE_METADATA_ONLY',
      activeLockReasons: Object.freeze(combinedLockReasons),
      ...(normalizedProposedDefinition ? { normalizedProposedDefinition } : {}),
      message: 'Descriptive metadata update preserves physical dimension and conversion meaning.',
    });
  }

  if (effectiveLocked) {
    return buildBlockedResult({
      reasonCode: combinedLockReasons[0],
      activeLockReasons: combinedLockReasons,
      isDimensionalChange: true,
      effectiveLocked: true,
      message: `Dimensional/conversion update blocked (${combinedLockReasons.join(', ')}).`,
    });
  }

  const normalizedProposedDefinition =
    proposedDefinition !== undefined
      ? Object.freeze({
          ...proposedDefinition,
          packingLocked: persistedPackingLocked,
        })
      : undefined;

  return Object.freeze({
    allowed: true,
    effectiveLocked: false,
    persistedPackingLocked,
    isDimensionalChange: true,
    reasonCode: 'ALLOWED_DIMENSIONAL_UPDATE_UNLOCKED',
    activeLockReasons: Object.freeze([] as const),
    ...(normalizedProposedDefinition ? { normalizedProposedDefinition } : {}),
    message: 'No lock triggers active and evidence verified; dimensional update allowed.',
  });
}
