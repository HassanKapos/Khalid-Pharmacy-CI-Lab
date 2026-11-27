/**
 * Phase 2F — Intelligent Continuous Stocktake
 * Pure Count-Time Watermark, Movement Reconciliation, Exact Cost Provenance,
 * Per-Item Sale-to-Ledger Verifier & Posting Safety Pre-Flight Engine
 *
 * Non-Negotiable Accounting & Security Invariants:
 * 1. Single Ledger Source of Truth: Reconciles directly against existing
 *    `inventory_ledger` movements (never creates a parallel inventory ledger).
 * 2. Exact Taxonomy Alignment: Uses canonical repo movement types
 *    (`INITIAL`, `PURCHASE`, `SALE`, `RETURN`, `DAMAGE`, `ADJUSTMENT`) plus
 *    R3.2-reserved types (`PURCHASE_RETURN`, `TRANSFER_IN`, `TRANSFER_OUT`).
 * 3. Tri-Timestamp + Watermark Ordering: Distinguishes business occurrence time,
 *    local IndexedDB persistence time, server sync time, and count-time known
 *    movement IDs (plus optional monotonic ledger sequences).
 *    - Pre-count movement synced late -> EXCLUDED (not double-counted).
 *    - Post-count movement synced late -> INCLUDED exactly once.
 *    - Duplicate movement ID -> hard integrity blocker (`NEEDS_REVIEW`).
 *    - Ambiguous offline clock-skew causality -> fail-closed `NEEDS_REVIEW`.
 * 4. Exact Sign Convention (Section 10.2):
 *      ExpectedCurrentQuantity = CountedQuantityAtReference + NetMovementsAfterReference
 *      QuantityVariance        = SystemCurrentQuantity - ExpectedCurrentQuantity
 *      RequiredLedgerAdjDelta  = ExpectedCurrentQuantity - SystemCurrentQuantity = -QuantityVariance
 * 5. Exact Rational Historical Cost Provenance:
 *    - Uses BigInt `Rational` from `exactFinance.ts` (zero early rounding).
 *    - NEVER substitutes mutable catalog `buyPrice` for historical acquisition cost.
 *    - Missing/legacy/unprovable batch cost -> fail-closed `costStatus: 'NEEDS_REVIEW'`,
 *      `financialVarianceExact: null`.
 *    - Unexplained surplus variance NEVER receives an invented financial cost.
 * 6. Per-Item Sale-to-Ledger Integrity (Section 13 / R3.2 Gap 1):
 *    - Validates EVERY `branches/{b}/sales/{s}/items/{s}-item-{i}` individually
 *      against its linked `SALE` ledger movements (medicineId, branchId, saleId,
 *      itemId, itemIndex, unit conversion, exact per-item baseUnits).
 *    - Rejects sales where aggregate totals match but per-item totals diverge.
 * 7. Unexplained-Variance Exception & Posting Pre-Flight Safety (Section 12):
 *    - Admin/Super Admin exception approval CANNOT bypass hard integrity blockers.
 *    - Posting pre-flight verifies all 8 safety preconditions before writing a
 *      single traceable authorized `ADJUSTMENT` ledger movement.
 */

import {
  addRational,
  createRational,
  isValidRational,
  multiplyRational,
  negateRational,
  type Rational,
} from './exactFinance.ts';
import {
  buildStocktakeAdjustmentLedgerId,
  buildStocktakePostingIdempotencyKey,
  computeMovementWatermarkDigest,
  isValidFirestoreDocId,
  validateFinancialLineExactInvariants,
  type FinancialApprovalRecord,
  type FinancialStocktakeLine,
  type OperationalCountSubmissionEvent,
  type StocktakeCostProvenanceStatus,
  type StocktakeCountUnit,
  type StocktakeDiscrepancyStatus,
  type StocktakePostingRecord,
  type StocktakeRole,
} from './stocktakeContract.ts';

/**
 * Complete movement taxonomy reconciled with `pharmacyDb.ts`, `firestore.rules`, and R3.2 Section D.2.
 */
export type CanonicalLedgerMovementType =
  | 'INITIAL'
  | 'PURCHASE'
  | 'SALE'
  | 'RETURN'          // Customer return (positive stock inflow, linked to sourceSaleId)
  | 'PURCHASE_RETURN' // Supplier return (negative stock outflow, R3.2 PR-4 addition)
  | 'DAMAGE'          // Damage / expiry write-off (negative stock outflow)
  | 'ADJUSTMENT'      // Signed manual or stocktake adjustment
  | 'TRANSFER_IN'     // Future branch transfer inflow (reserved; blocked until transfer PR)
  | 'TRANSFER_OUT';   // Future branch transfer outflow (reserved; blocked until transfer PR)

export const ACTIVE_BASELINE_MOVEMENT_TYPES: ReadonlySet<CanonicalLedgerMovementType> = new Set([
  'INITIAL',
  'PURCHASE',
  'SALE',
  'RETURN',
  'DAMAGE',
  'ADJUSTMENT',
]);

export interface ReconcilableLedgerMovement {
  id: string;
  branchId: string;
  medicineId: string;
  batchNumber: string;
  expiry?: string;
  type: CanonicalLedgerMovementType;
  unit: StocktakeCountUnit;
  quantityDelta: number;
  baseUnitsDelta: number;
  /** Exact historical cost per base unit (from `inventory_financials`), null/undefined if unprovable */
  costPerBaseUnitExact?: Rational | null;
  referenceId: string;
  /** Optional explicit link to normalized sale item ID (`${saleId}-item-${itemIndex}`) */
  saleItemId?: string;
  /** Business occurrence time (ms epoch) when stock physically moved */
  businessOccurredAtMs: number;
  /** Local IndexedDB write time (ms epoch) */
  localPersistedAtMs: number;
  /** Firestore server confirmation time (ms epoch), null if still pending offline */
  serverSyncedAtMs: number | null;
  /** Optional monotonic per-medicine ledger sequence when available */
  medicineLedgerSeq?: number | null;
  /** Whether movement is confirmed synced in shared Firestore or still pending locally */
  synced: boolean;
  /** Whether movement is a stocktake correction posted by another session */
  isStocktakeAdjustment?: boolean;
}

export interface BatchHistoricalCostLayer {
  batchNumber: string;
  expiry: string;
  remainingBaseUnits: number;
  /** Provable exact acquisition cost per base unit; null means legacy/unprovable -> NEEDS_REVIEW */
  costPerBaseUnitExact: Rational | null;
  sourceReceiptMovementId: string | null;
}

export interface MedicineUnitConversionSpec {
  medicineId: string;
  unitOperationalAllowed: boolean;
  unitMode: 'DIRECT_PACK' | 'SOLID_TWO_LEVEL';
  stripsPerPack: number;
  pillsPerStrip: number;
  baseUnitsPerPack: number;
}

export type MovementRelativeClassification =
  | 'PRE_COUNT_ALREADY_IN_PHYSICAL_COUNT'
  | 'POST_COUNT_INCLUDED'
  | 'AMBIGUOUS_ORDERING_NEEDS_REVIEW';

export interface ClassifiedMovementResult {
  movement: ReconcilableLedgerMovement;
  classification: MovementRelativeClassification;
  reason: string;
}

export const DEFAULT_CLOCK_SKEW_GUARD_MS = 30_000; // 30s guard band when monotonic seq is absent

/**
 * Exact unit conversion validator matching `medicineUnitPolicy.ts` / `universalUnitPolicy.ts`.
 */
export function resolveExactBaseUnitsPerUnit(
  spec: MedicineUnitConversionSpec,
  unit: StocktakeCountUnit
): { ok: true; baseUnitsPerUnit: number } | { ok: false; error: string } {
  if (!spec.unitOperationalAllowed) {
    return {
      ok: false,
      error: `UNVERIFIED_MEDICINE_UNIT_CONFIG: Medicine ${spec.medicineId} is quarantined or not operationally verified.`,
    };
  }
  if (!Number.isSafeInteger(spec.baseUnitsPerPack) || spec.baseUnitsPerPack <= 0) {
    return { ok: false, error: `INVALID_UNIT_CONVERSION: Invalid baseUnitsPerPack (${spec.baseUnitsPerPack}).` };
  }
  if (spec.unitMode === 'DIRECT_PACK') {
    if (unit !== 'pack') {
      return {
        ok: false,
        error: `INVALID_UNIT_CONVERSION: DIRECT_PACK medicine ${spec.medicineId} only allows unit "pack", got "${unit}".`,
      };
    }
    if (spec.baseUnitsPerPack !== 1) {
      return {
        ok: false,
        error: `INVALID_UNIT_CONVERSION: DIRECT_PACK medicine ${spec.medicineId} must have baseUnitsPerPack === 1.`,
      };
    }
    return { ok: true, baseUnitsPerUnit: 1 };
  }

  // SOLID_TWO_LEVEL
  if (
    !Number.isSafeInteger(spec.stripsPerPack) ||
    spec.stripsPerPack <= 0 ||
    !Number.isSafeInteger(spec.pillsPerStrip) ||
    spec.pillsPerStrip <= 0 ||
    spec.stripsPerPack * spec.pillsPerStrip !== spec.baseUnitsPerPack
  ) {
    return {
      ok: false,
      error: `INVALID_UNIT_CONVERSION: Inconsistent SOLID_TWO_LEVEL packing (${spec.stripsPerPack}x${spec.pillsPerStrip} != ${spec.baseUnitsPerPack}).`,
    };
  }

  if (unit === 'pack') return { ok: true, baseUnitsPerUnit: spec.baseUnitsPerPack };
  if (unit === 'strip') return { ok: true, baseUnitsPerUnit: spec.pillsPerStrip };
  if (unit === 'pill') return { ok: true, baseUnitsPerUnit: 1 };
  return { ok: false, error: `INVALID_UNIT_CONVERSION: Unsupported unit "${String(unit)}".` };
}

/**
 * Classifies a ledger movement relative to a specific medicine's immutable count reference.
 *
 * Ordering Hierarchy (Defensible & Fail-Closed):
 * 1. Explicit Watermark Membership: If `movement.id` is in `countEvent.watermark.knownMovementIdsAtCount`,
 *    it was ALREADY reflected in the shelf/system snapshot at count time -> PRE_COUNT (even if synced late!).
 * 2. Monotonic Per-Medicine Sequence (when both watermark & movement carry `medicineLedgerSeq`):
 *    - `movement.medicineLedgerSeq <= watermark.medicineLedgerSeq` -> PRE_COUNT
 *    - `movement.medicineLedgerSeq > watermark.medicineLedgerSeq` -> POST_COUNT (even if synced late!)
 * 3. Business Occurrence Time (`businessOccurredAtMs` vs `countBusinessAtMs`) with Clock-Skew Guard:
 *    - Clearly before count (`businessOccurredAtMs <= countBusinessAtMs - skewGuardMs`) ->
 *      Wait: if it happened clearly BEFORE the count AND was NOT in knownMovementIdsAtCount,
 *      that means an offline pre-count movement synced AFTER the count was taken!
 *      Per Section 10.1: "A movement created before the count but synchronized afterward
 *      must not be treated as a post-count movement merely because it arrived later." -> PRE_COUNT!
 *    - Clearly after count (`businessOccurredAtMs >= countBusinessAtMs + skewGuardMs`) ->
 *      Per Section 10.1: "A movement created after the count must not be omitted because it
 *      synchronized late." -> POST_COUNT!
 *    - Strictly within the `±skewGuardMs` ambiguity band AND not in `knownMovementIdsAtCount`
 *      AND lacking a monotonic sequence -> AMBIGUOUS_ORDERING_NEEDS_REVIEW (fail-closed!).
 */
export function classifyMovementRelativeToCountReference(params: {
  movement: ReconcilableLedgerMovement;
  countEvent: OperationalCountSubmissionEvent;
  clockSkewGuardMs?: number;
}): ClassifiedMovementResult {
  const { movement, countEvent } = params;
  // OD-2F-1: Fail-closed +/-30s clock-skew guard cannot be weakened below DEFAULT_CLOCK_SKEW_GUARD_MS (30_000ms).
  const skewGuardMs = Math.max(
    DEFAULT_CLOCK_SKEW_GUARD_MS,
    typeof params.clockSkewGuardMs === 'number' && Number.isFinite(params.clockSkewGuardMs)
      ? Math.trunc(params.clockSkewGuardMs)
      : DEFAULT_CLOCK_SKEW_GUARD_MS
  );
  const wm = countEvent.watermark;
  const hasSeqPair =
    typeof wm.medicineLedgerSeq === 'number' &&
    Number.isSafeInteger(wm.medicineLedgerSeq) &&
    typeof movement.medicineLedgerSeq === 'number' &&
    Number.isSafeInteger(movement.medicineLedgerSeq);

  if (wm.knownMovementIdsAtCount.includes(movement.id)) {
    if (hasSeqPair && (movement.medicineLedgerSeq as number) > (wm.medicineLedgerSeq as number)) {
      return {
        movement,
        classification: 'AMBIGUOUS_ORDERING_NEEDS_REVIEW',
        reason: `Contradictory provenance: movement ${movement.id} is in knownMovementIdsAtCount yet has medicineLedgerSeq (${movement.medicineLedgerSeq}) > watermark (${wm.medicineLedgerSeq}).`,
      };
    }
    return {
      movement,
      classification: 'PRE_COUNT_ALREADY_IN_PHYSICAL_COUNT',
      reason: 'Movement ID present in immutable count-time watermark snapshot.',
    };
  }

  if (hasSeqPair) {
    if ((movement.medicineLedgerSeq as number) <= (wm.medicineLedgerSeq as number)) {
      return {
        movement,
        classification: 'PRE_COUNT_ALREADY_IN_PHYSICAL_COUNT',
        reason: `Monotonic medicineLedgerSeq (${movement.medicineLedgerSeq}) <= count watermark (${wm.medicineLedgerSeq}).`,
      };
    }
    return {
      movement,
      classification: 'POST_COUNT_INCLUDED',
      reason: `Monotonic medicineLedgerSeq (${movement.medicineLedgerSeq}) > count watermark (${wm.medicineLedgerSeq}).`,
    };
  }

  if (
    !Number.isFinite(movement.businessOccurredAtMs) ||
    movement.businessOccurredAtMs <= 0 ||
    !Number.isFinite(wm.countBusinessAtMs) ||
    wm.countBusinessAtMs <= 0
  ) {
    return {
      movement,
      classification: 'AMBIGUOUS_ORDERING_NEEDS_REVIEW',
      reason: `Movement ${movement.id} or count watermark lacks valid business timestamp and monotonic sequence.`,
    };
  }

  const deltaMs = movement.businessOccurredAtMs - wm.countBusinessAtMs;
  if (deltaMs <= -skewGuardMs) {
    return {
      movement,
      classification: 'PRE_COUNT_ALREADY_IN_PHYSICAL_COUNT',
      reason: `Late-synced pre-count movement (businessOccurredAtMs precedes countBusinessAtMs by ${-deltaMs}ms).`,
    };
  }
  if (deltaMs >= skewGuardMs) {
    return {
      movement,
      classification: 'POST_COUNT_INCLUDED',
      reason: `Post-count movement (businessOccurredAtMs follows countBusinessAtMs by ${deltaMs}ms).`,
    };
  }

  return {
    movement,
    classification: 'AMBIGUOUS_ORDERING_NEEDS_REVIEW',
    reason: `Movement ${movement.id} occurred within ±${skewGuardMs}ms clock-skew window (${deltaMs}ms) without monotonic sequence or count-time watermark membership.`,
  };
}

export interface MovementSignIntegrityResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates sign & movement-type integrity for every supported/reserved movement type.
 */
export function validateMovementTypeAndSign(
  movement: ReconcilableLedgerMovement,
  allowTransferMovements = false
): MovementSignIntegrityResult {
  if (!Number.isSafeInteger(movement.baseUnitsDelta) || movement.baseUnitsDelta === 0) {
    return { valid: false, error: `INVALID_MOVEMENT_DELTA: Movement ${movement.id} has zero or non-integer baseUnitsDelta.` };
  }

  switch (movement.type) {
    case 'INITIAL':
    case 'PURCHASE':
    case 'RETURN':
      if (movement.baseUnitsDelta <= 0) {
        return { valid: false, error: `INVALID_MOVEMENT_SIGN: ${movement.type} ${movement.id} must have positive baseUnitsDelta.` };
      }
      return { valid: true };
    case 'SALE':
    case 'PURCHASE_RETURN':
    case 'DAMAGE':
      if (movement.baseUnitsDelta >= 0) {
        return { valid: false, error: `INVALID_MOVEMENT_SIGN: ${movement.type} ${movement.id} must have negative baseUnitsDelta.` };
      }
      return { valid: true };
    case 'ADJUSTMENT':
      return { valid: true };
    case 'TRANSFER_IN':
      if (!allowTransferMovements) {
        return { valid: false, error: `UNSUPPORTED_MOVEMENT_TYPE_IN_BASELINE: TRANSFER_IN ${movement.id} requires Transfer PR activation.` };
      }
      if (movement.baseUnitsDelta <= 0) {
        return { valid: false, error: `INVALID_MOVEMENT_SIGN: TRANSFER_IN ${movement.id} must be positive.` };
      }
      return { valid: true };
    case 'TRANSFER_OUT':
      if (!allowTransferMovements) {
        return { valid: false, error: `UNSUPPORTED_MOVEMENT_TYPE_IN_BASELINE: TRANSFER_OUT ${movement.id} requires Transfer PR activation.` };
      }
      if (movement.baseUnitsDelta >= 0) {
        return { valid: false, error: `INVALID_MOVEMENT_SIGN: TRANSFER_OUT ${movement.id} must be negative.` };
      }
      return { valid: true };
    default:
      return { valid: false, error: `UNKNOWN_MOVEMENT_TYPE: ${String(movement.type)}` };
  }
}

export interface ExactVarianceValuationResult {
  costStatus: StocktakeCostProvenanceStatus;
  /** Signed financial variance in SDG (negative = loss from deficit; positive = provable surplus gain), null if NEEDS_REVIEW */
  financialVarianceExact: Rational | null;
  /** Exact valuation of expected remaining inventory (SDG), null if any remaining layer lacks provenance */
  expectedInventoryValuationExact: Rational | null;
  /** Exact weighted acquisition cost per base unit for this variance, null if NEEDS_REVIEW */
  approvedAcquisitionCostExact: Rational | null;
  allocatedLayers: Array<{
    batchNumber: string;
    expiry: string;
    baseUnits: number;
    costPerBaseUnitExact: Rational;
    layerCostExact: Rational;
  }>;
  reviewReason: string | null;
}

/**
 * Exact Rational Historical Cost Provenance Valuation (Section 11 & R3.2 Section D/E).
 *
 * CRITICAL RULES:
 * - NEVER accepts or substitutes catalog `buyPrice`.
 * - Zero variance -> `NOT_APPLICABLE_ZERO_VARIANCE`, `financialVarianceExact = 0`.
 * - Deficit (`requiredLedgerAdjustmentBaseUnits < 0`):
 *     Consumes remaining provable batch cost layers in FEFO order (supporting partial
 *     and multi-batch consumption with exact BigInt Rational math).
 *     If ANY consumed base unit comes from a layer with `costPerBaseUnitExact === null`
 *     OR if remaining provable batch units < deficit units (e.g. legacy unbatched stock),
 *     FAILS CLOSED to `costStatus: 'NEEDS_REVIEW'`, `financialVarianceExact: null`.
 * - Surplus (`requiredLedgerAdjustmentBaseUnits > 0`):
 *     Requires an explicitly verified historical receipt cost (`explicitVerifiedSurplusBatchCostExact`).
 *     Unexplained surplus NEVER gets an invented cost -> `costStatus: 'NEEDS_REVIEW'`,
 *     `financialVarianceExact: null`.
 */
export function valuateStocktakeVarianceExact(params: {
  requiredLedgerAdjustmentBaseUnits: number;
  expectedCurrentBaseUnits: number;
  batchLayersFefo: ReadonlyArray<BatchHistoricalCostLayer>;
  explicitVerifiedSurplusBatchCostExact?: Rational | null;
}): ExactVarianceValuationResult {
  const {
    requiredLedgerAdjustmentBaseUnits,
    expectedCurrentBaseUnits,
    batchLayersFefo,
    explicitVerifiedSurplusBatchCostExact,
  } = params;

  // Reject corrupted batch layers (non-integer remaining units or negative acquisition cost)
  for (const layer of batchLayersFefo) {
    if (!Number.isSafeInteger(layer.remainingBaseUnits) || layer.remainingBaseUnits < 0) {
      return {
        costStatus: 'NEEDS_REVIEW',
        financialVarianceExact: null,
        expectedInventoryValuationExact: null,
        approvedAcquisitionCostExact: null,
        allocatedLayers: [],
        reviewReason: `INVALID_BATCH_LAYER_QUANTITY: Batch "${layer.batchNumber}" has invalid remainingBaseUnits (${layer.remainingBaseUnits}).`,
      };
    }
    if (
      layer.costPerBaseUnitExact !== null &&
      (!isValidRational(layer.costPerBaseUnitExact) || BigInt(layer.costPerBaseUnitExact.num) < 0n)
    ) {
      return {
        costStatus: 'NEEDS_REVIEW',
        financialVarianceExact: null,
        expectedInventoryValuationExact: null,
        approvedAcquisitionCostExact: null,
        allocatedLayers: [],
        reviewReason: `INVALID_BATCH_LAYER_COST: Batch "${layer.batchNumber}" has invalid or negative costPerBaseUnitExact.`,
      };
    }
  }

  // Compute expected remaining inventory valuation if all layers are provable and non-negative
  let expectedInvVal: Rational | null = createRational(0n);
  if (expectedCurrentBaseUnits < 0) {
    expectedInvVal = null;
  } else {
    let covered = 0;
    for (const layer of batchLayersFefo) {
      if (layer.remainingBaseUnits <= 0) continue;
      if (!layer.costPerBaseUnitExact || !isValidRational(layer.costPerBaseUnitExact)) {
        expectedInvVal = null;
        break;
      }
      const take = Math.min(layer.remainingBaseUnits, Math.max(0, expectedCurrentBaseUnits - covered));
      if (take > 0) {
        expectedInvVal = addRational(
          expectedInvVal,
          multiplyRational(createRational(BigInt(take)), layer.costPerBaseUnitExact)
        );
        covered += take;
      }
    }
    if (covered < expectedCurrentBaseUnits) {
      expectedInvVal = null;
    }
  }

  if (requiredLedgerAdjustmentBaseUnits === 0) {
    return {
      costStatus: 'NOT_APPLICABLE_ZERO_VARIANCE',
      financialVarianceExact: createRational(0n),
      expectedInventoryValuationExact: expectedInvVal,
      approvedAcquisitionCostExact: createRational(0n),
      allocatedLayers: [],
      reviewReason: null,
    };
  }

  // Physical DEFICIT (ledger adjustment is NEGATIVE)
  if (requiredLedgerAdjustmentBaseUnits < 0) {
    let remainingDeficit = -requiredLedgerAdjustmentBaseUnits;
    let totalDeficitCost = createRational(0n);
    const allocatedLayers: ExactVarianceValuationResult['allocatedLayers'] = [];

    for (const layer of batchLayersFefo) {
      if (remainingDeficit <= 0) break;
      if (layer.remainingBaseUnits <= 0) continue;
      const take = Math.min(layer.remainingBaseUnits, remainingDeficit);
      if (!layer.costPerBaseUnitExact || !isValidRational(layer.costPerBaseUnitExact)) {
        return {
          costStatus: 'NEEDS_REVIEW',
          financialVarianceExact: null,
          expectedInventoryValuationExact: expectedInvVal,
          approvedAcquisitionCostExact: null,
          allocatedLayers: [],
          reviewReason: `MISSING_HISTORICAL_BATCH_COST: Batch "${layer.batchNumber}" lacks provable historical acquisition cost.`,
        };
      }
      const layerCostExact = multiplyRational(createRational(BigInt(take)), layer.costPerBaseUnitExact);
      totalDeficitCost = addRational(totalDeficitCost, layerCostExact);
      allocatedLayers.push({
        batchNumber: layer.batchNumber,
        expiry: layer.expiry,
        baseUnits: take,
        costPerBaseUnitExact: layer.costPerBaseUnitExact,
        layerCostExact,
      });
      remainingDeficit -= take;
    }

    if (remainingDeficit > 0) {
      return {
        costStatus: 'NEEDS_REVIEW',
        financialVarianceExact: null,
        expectedInventoryValuationExact: expectedInvVal,
        approvedAcquisitionCostExact: null,
        allocatedLayers: [],
        reviewReason: `UNPROVABLE_LEGACY_OR_EXCESS_DEFICIT: ${remainingDeficit} base unit(s) of deficit have no provable historical batch layer.`,
      };
    }

    return {
      costStatus: 'EXACT_HISTORICAL',
      financialVarianceExact: negateRational(totalDeficitCost),
      expectedInventoryValuationExact: expectedInvVal,
      approvedAcquisitionCostExact: totalDeficitCost,
      allocatedLayers,
      reviewReason: null,
    };
  }

  // Physical SURPLUS (ledger adjustment is POSITIVE)
  if (
    !explicitVerifiedSurplusBatchCostExact ||
    !isValidRational(explicitVerifiedSurplusBatchCostExact) ||
    BigInt(explicitVerifiedSurplusBatchCostExact.num) < 0n
  ) {
    return {
      costStatus: 'NEEDS_REVIEW',
      financialVarianceExact: null,
      expectedInventoryValuationExact: expectedInvVal,
      approvedAcquisitionCostExact: null,
      allocatedLayers: [],
      reviewReason:
        'UNEXPLAINED_SURPLUS_NO_PROVENANCE: Positive stocktake surplus requires verified historical batch receipt provenance before financial valuation; catalog buyPrice is never substituted.',
    };
  }

  const surplusVal = multiplyRational(
    createRational(BigInt(requiredLedgerAdjustmentBaseUnits)),
    explicitVerifiedSurplusBatchCostExact
  );
  return {
    costStatus: 'EXACT_HISTORICAL',
    financialVarianceExact: surplusVal,
    expectedInventoryValuationExact: expectedInvVal,
    approvedAcquisitionCostExact: surplusVal,
    allocatedLayers: [],
    reviewReason: null,
  };
}

export interface ReconcileMedicineOutput {
  financialLine: FinancialStocktakeLine;
  classifiedMovements: ClassifiedMovementResult[];
  includedPostCountMovementIds: string[];
  excludedPreCountMovementIds: string[];
  ambiguousMovementIds: string[];
  valuation: ExactVarianceValuationResult;
}

/**
 * Full Count-Time Reconciliation Algorithm for one medicine (Sections 10, 11, 12).
 */
export function reconcileMedicineAtCountReference(params: {
  sessionId: string;
  branchId: string;
  reconciliationVersion: number;
  countEvent: OperationalCountSubmissionEvent;
  unitSpec: MedicineUnitConversionSpec;
  allMedicineLedgerMovements: ReadonlyArray<ReconcilableLedgerMovement>;
  batchLayersFefo: ReadonlyArray<BatchHistoricalCostLayer>;
  explicitVerifiedSurplusBatchCostExact?: Rational | null;
  hasSyncConflict?: boolean;
  hasMissingExpectedLedgerMovement?: boolean;
  allowTransferMovements?: boolean;
  clockSkewGuardMs?: number;
  reconciledAtMs: number;
}): ReconcileMedicineOutput {
  const {
    sessionId,
    branchId,
    reconciliationVersion,
    countEvent,
    unitSpec,
    allMedicineLedgerMovements,
    batchLayersFefo,
    explicitVerifiedSurplusBatchCostExact,
    reconciledAtMs,
  } = params;

  const integrityBlockers: string[] = [];

  if (countEvent.branchId !== branchId || countEvent.sessionId !== sessionId) {
    integrityBlockers.push(
      `CROSS_ENTITY_COUNT_EVENT_MISMATCH: Count event ${countEvent.eventId} does not match (${branchId}, ${sessionId}).`
    );
  }
  if (!Number.isSafeInteger(countEvent.countRevision) || countEvent.countRevision < 1) {
    integrityBlockers.push('INVALID_COUNT_REVISION: countRevision must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(countEvent.countedQuantity) || countEvent.countedQuantity < 0) {
    integrityBlockers.push('INVALID_COUNT_QUANTITY: countedQuantity must be a non-negative safe integer.');
  }
  const wm = countEvent.watermark;
  if (
    !wm ||
    !Number.isFinite(wm.countBusinessAtMs) ||
    wm.countBusinessAtMs <= 0 ||
    !Number.isFinite(wm.localPersistedAtMs) ||
    wm.localPersistedAtMs <= 0 ||
    !Array.isArray(wm.knownMovementIdsAtCount) ||
    wm.knownMovementCount !== wm.knownMovementIdsAtCount.length ||
    wm.watermarkDigest !== computeMovementWatermarkDigest(wm.knownMovementIdsAtCount)
  ) {
    integrityBlockers.push('INVALID_WATERMARK: Count watermark timestamps, count, or digest failed verification.');
  }
  if (countEvent.syncStatus !== 'CONFIRMED') {
    integrityBlockers.push('PENDING_OFFLINE_SYNC: Count event is not globally CONFIRMED.');
  }
  if (params.hasSyncConflict) {
    integrityBlockers.push('SYNC_CONFLICT: Unresolved synchronization conflict on medicine or session.');
  }
  if (params.hasMissingExpectedLedgerMovement) {
    integrityBlockers.push('MISSING_LEDGER_MOVEMENT: Expected ledger movement is missing from verified set.');
  }

  // 1. Validate unit conversion against operationally verified medicine packing
  const unitConv = resolveExactBaseUnitsPerUnit(unitSpec, countEvent.countUnit);
  let countedBaseUnitsAtReference = countEvent.countedBaseUnits;
  if (!unitConv.ok) {
    integrityBlockers.push(unitConv.error);
  } else {
    const recomputedBaseUnits = countEvent.countedQuantity * unitConv.baseUnitsPerUnit;
    if (
      countEvent.baseUnitsPerCountUnit !== unitConv.baseUnitsPerUnit ||
      countEvent.countedBaseUnits !== recomputedBaseUnits
    ) {
      integrityBlockers.push(
        `INVALID_UNIT_CONVERSION: Count event baseUnits (${countEvent.countedBaseUnits}) mismatches verified unit conversion (${recomputedBaseUnits}).`
      );
    }
    countedBaseUnitsAtReference = recomputedBaseUnits;
  }

  // 2. Scan all ledger movements for duplicates, cross-branch tampering, pending sync, sign validity, and system total
  const seenIds = new Set<string>();
  let systemCurrentBaseUnits = 0;
  let netPostCountBaseUnitsDelta = 0;
  const classifiedMovements: ClassifiedMovementResult[] = [];
  const includedPostCountMovementIds: string[] = [];
  const excludedPreCountMovementIds: string[] = [];
  const ambiguousMovementIds: string[] = [];

  for (const mov of allMedicineLedgerMovements) {
    if (mov.branchId !== branchId || mov.medicineId !== countEvent.medicineId) {
      integrityBlockers.push(`CROSS_ENTITY_LEDGER_MISMATCH: Movement ${mov.id} does not match (${branchId}, ${countEvent.medicineId}).`);
      continue;
    }
    if (seenIds.has(mov.id)) {
      integrityBlockers.push(`DUPLICATE_LEDGER_MOVEMENT: Duplicate movement ID "${mov.id}" detected.`);
      continue;
    }
    seenIds.add(mov.id);

    const signCheck = validateMovementTypeAndSign(mov, params.allowTransferMovements === true);
    if (!signCheck.valid && signCheck.error) {
      integrityBlockers.push(signCheck.error);
    }

    if (!mov.synced) {
      integrityBlockers.push(`PENDING_OFFLINE_SYNC: Ledger movement ${mov.id} is not yet synced to Firestore.`);
    } else if (mov.serverSyncedAtMs === null || !Number.isFinite(mov.serverSyncedAtMs) || mov.serverSyncedAtMs <= 0) {
      integrityBlockers.push(`UNCONFIRMED_MOVEMENT_SYNC_TIMESTAMP: Synced movement ${mov.id} lacks serverSyncedAtMs.`);
    }

    systemCurrentBaseUnits += mov.baseUnitsDelta;

    const classified = classifyMovementRelativeToCountReference({
      movement: mov,
      countEvent,
      clockSkewGuardMs: params.clockSkewGuardMs,
    });
    classifiedMovements.push(classified);

    if (classified.classification === 'POST_COUNT_INCLUDED') {
      netPostCountBaseUnitsDelta += mov.baseUnitsDelta;
      includedPostCountMovementIds.push(mov.id);
    } else if (classified.classification === 'PRE_COUNT_ALREADY_IN_PHYSICAL_COUNT') {
      excludedPreCountMovementIds.push(mov.id);
    } else {
      ambiguousMovementIds.push(mov.id);
      integrityBlockers.push(`AMBIGUOUS_MOVEMENT_ORDERING: ${classified.reason}`);
    }
  }

  if (wm && Array.isArray(wm.knownMovementIdsAtCount)) {
    for (const knownId of wm.knownMovementIdsAtCount) {
      if (!seenIds.has(knownId)) {
        integrityBlockers.push(
          `MISSING_LEDGER_MOVEMENT: Count watermark movement "${knownId}" is missing from verified ledger history.`
        );
      }
    }
  }

  if (systemCurrentBaseUnits < 0) {
    integrityBlockers.push(
      `NEGATIVE_SYSTEM_INVENTORY: System ledger balance is negative (${systemCurrentBaseUnits} base units).`
    );
  }

  // 3. Authoritative Section 10.2 Reconciliation Equations
  const expectedCurrentBaseUnits = countedBaseUnitsAtReference + netPostCountBaseUnitsDelta;
  if (expectedCurrentBaseUnits < 0) {
    integrityBlockers.push(
      `NEGATIVE_EXPECTED_INVENTORY: Expected current inventory is negative (${expectedCurrentBaseUnits} base units).`
    );
  }
  const quantityVarianceBaseUnits = systemCurrentBaseUnits - expectedCurrentBaseUnits;
  const requiredLedgerAdjustmentBaseUnits =
    quantityVarianceBaseUnits === 0 ? 0 : -quantityVarianceBaseUnits;

  // 4. Exact Rational Historical Cost Provenance Valuation
  const valuation = valuateStocktakeVarianceExact({
    requiredLedgerAdjustmentBaseUnits,
    expectedCurrentBaseUnits,
    batchLayersFefo,
    explicitVerifiedSurplusBatchCostExact,
  });

  if (valuation.costStatus === 'NEEDS_REVIEW' && valuation.reviewReason) {
    integrityBlockers.push(`INVALID_COST_PROVENANCE: ${valuation.reviewReason}`);
  }

  // 5. Discrepancy Workflow Status Classification
  let discrepancyStatus: StocktakeDiscrepancyStatus;
  if (integrityBlockers.length > 0) {
    discrepancyStatus = 'NEEDS_REVIEW';
  } else if (quantityVarianceBaseUnits === 0) {
    discrepancyStatus = 'MATCHED';
  } else {
    discrepancyStatus = 'UNEXPLAINED';
  }

  const financialLine: FinancialStocktakeLine = {
    id: countEvent.medicineId,
    sessionId,
    branchId,
    medicineId: countEvent.medicineId,
    reconciliationVersion,
    sourceCountEventId: countEvent.eventId,
    sourceCountRevision: countEvent.countRevision,
    countedBaseUnitsAtReference,
    netPostCountBaseUnitsDelta,
    expectedCurrentBaseUnits,
    systemCurrentBaseUnits,
    quantityVarianceBaseUnits,
    requiredLedgerAdjustmentBaseUnits,
    discrepancyStatus,
    costStatus: valuation.costStatus,
    financialVarianceExact: valuation.financialVarianceExact,
    expectedInventoryValuationExact: valuation.expectedInventoryValuationExact,
    approvedAcquisitionCostExact: valuation.approvedAcquisitionCostExact,
    integrityBlockers,
    investigationReason: null,
    investigatedByUid: null,
    investigatedAtMs: null,
    approvalId: null,
    approvedByUid: null,
    approvedAtMs: null,
    postingId: null,
    postedLedgerMovementId: null,
    postedAtMs: null,
    reconciledAtMs,
  };

  return {
    financialLine,
    classifiedMovements,
    includedPostCountMovementIds,
    excludedPreCountMovementIds,
    ambiguousMovementIds,
    valuation,
  };
}

/**
 * Per-Item Sale-to-Ledger Integrity Verifier (Section 13 & R3.2 Gap 1).
 *
 * Explicitly verifies EVERY `branches/{branchId}/sales/{saleId}/items/{saleId}-item-{itemIndex}`
 * against its exact corresponding `SALE` ledger movements — NEVER trusting aggregate equality!
 */
export interface NormalizedSaleItemDoc {
  id: string; // MUST equal `${saleId}-item-${itemIndex}`
  branchId: string;
  saleId: string;
  itemIndex: number;
  medicineId: string;
  unit: StocktakeCountUnit;
  qty: number;
  baseUnits: number;
  expectedLedgerCount: number;
  ledgerRangeStart: number;
}

export interface SalePerItemReconciliationResult {
  valid: boolean;
  checkedItems: number;
  perItemResults: Array<{
    itemId: string;
    medicineId: string;
    expectedBaseUnits: number;
    actualLedgerBaseUnitsAbs: number;
    matchedMovementIds: string[];
    valid: boolean;
    error?: string;
  }>;
  errors: string[];
}

export function verifySaleItemsAgainstLedgerMovements(params: {
  branchId: string;
  saleId: string;
  saleItems: ReadonlyArray<NormalizedSaleItemDoc>;
  saleLedgerMovements: ReadonlyArray<ReconcilableLedgerMovement>;
  unitSpecsByMedicineId: ReadonlyMap<string, MedicineUnitConversionSpec>;
}): SalePerItemReconciliationResult {
  const { branchId, saleId, saleItems, saleLedgerMovements, unitSpecsByMedicineId } = params;
  const errors: string[] = [];
  const perItemResults: SalePerItemReconciliationResult['perItemResults'] = [];

  if (saleItems.length === 0) {
    return { valid: false, checkedItems: 0, perItemResults: [], errors: ['Sale has zero line items.'] };
  }

  // Verify contiguous unique itemIndex 0..N-1 and exact path ID `${saleId}-item-${itemIndex}`
  const seenIndices = new Set<number>();
  const claimedMovementIds = new Set<string>();

  for (const item of saleItems) {
    const expectedItemId = `${saleId}-item-${item.itemIndex}`;
    let itemError: string | undefined;

    if (item.branchId !== branchId || item.saleId !== saleId) {
      itemError = `SALE_ITEM_IDENTITY_MISMATCH: Item ${item.id} branch/sale mismatch.`;
    } else if (item.id !== expectedItemId) {
      itemError = `SALE_ITEM_ID_FORMAT_INVALID: Expected "${expectedItemId}", got "${item.id}".`;
    } else if (seenIndices.has(item.itemIndex)) {
      itemError = `DUPLICATE_SALE_ITEM_INDEX: Duplicate itemIndex ${item.itemIndex}.`;
    } else if (
      !Number.isSafeInteger(item.qty) ||
      item.qty <= 0 ||
      !Number.isSafeInteger(item.baseUnits) ||
      item.baseUnits <= 0 ||
      !Number.isSafeInteger(item.expectedLedgerCount) ||
      item.expectedLedgerCount < 1
    ) {
      itemError = `INVALID_SALE_ITEM_QUANTITY: Item ${item.id} has invalid qty, baseUnits, or expectedLedgerCount.`;
    }
    seenIndices.add(item.itemIndex);

    // Validate exact unit conversion
    const spec = unitSpecsByMedicineId.get(item.medicineId);
    if (!itemError) {
      if (!spec || spec.medicineId !== item.medicineId) {
        itemError = `MISSING_MEDICINE_UNIT_SPEC: Missing or mismatched unit spec for medicine ${item.medicineId}.`;
      } else {
        const conv = resolveExactBaseUnitsPerUnit(spec, item.unit);
        if (!conv.ok) {
          itemError = conv.error;
        } else if (item.qty * conv.baseUnitsPerUnit !== item.baseUnits) {
          itemError = `SALE_ITEM_UNIT_CONVERSION_MISMATCH: ${item.qty} * ${conv.baseUnitsPerUnit} != ${item.baseUnits}.`;
        }
      }
    }

    // Match movements strictly for THIS item (prefer explicit saleItemId; fallback to exact medicineId + saleId if unique)
    const matchingMovs = saleLedgerMovements.filter(
      (m) =>
        m.branchId === branchId &&
        m.type === 'SALE' &&
        m.referenceId === saleId &&
        m.medicineId === item.medicineId &&
        (m.saleItemId ? m.saleItemId === item.id : !claimedMovementIds.has(m.id))
    );

    let sumAbsBaseUnits = 0;
    const matchedIds: string[] = [];
    for (const m of matchingMovs) {
      if (claimedMovementIds.has(m.id)) {
        itemError = itemError || `DUPLICATE_SALE_LEDGER_CLAIM: Movement ${m.id} claimed by multiple items.`;
        continue;
      }
      if (m.baseUnitsDelta >= 0) {
        itemError = itemError || `INVALID_SALE_LEDGER_SIGN: SALE movement ${m.id} must have negative baseUnitsDelta.`;
        continue;
      }
      claimedMovementIds.add(m.id);
      matchedIds.push(m.id);
      sumAbsBaseUnits += -m.baseUnitsDelta;
    }

    if (!itemError && matchedIds.length !== item.expectedLedgerCount) {
      itemError = `SALE_ITEM_LEDGER_COUNT_MISMATCH: Item ${item.id} expected ${item.expectedLedgerCount} SALE ledger movement(s), found ${matchedIds.length}.`;
    }
    if (!itemError && sumAbsBaseUnits !== item.baseUnits) {
      itemError = `SALE_ITEM_PER_ITEM_QTY_MISMATCH: Item ${item.id} (${item.medicineId}) sold ${item.baseUnits} base units, but linked SALE ledger movements sum to ${sumAbsBaseUnits}.`;
    }

    if (itemError) errors.push(itemError);
    perItemResults.push({
      itemId: item.id,
      medicineId: item.medicineId,
      expectedBaseUnits: item.baseUnits,
      actualLedgerBaseUnitsAbs: sumAbsBaseUnits,
      matchedMovementIds: matchedIds,
      valid: !itemError,
      ...(itemError ? { error: itemError } : {}),
    });
  }

  // Ensure every itemIndex 0..saleItems.length-1 is present with zero gaps
  for (let idx = 0; idx < saleItems.length; idx++) {
    if (!seenIndices.has(idx)) {
      errors.push(`MISSING_SALE_ITEM_INDEX: Contiguous itemIndex ${idx} is missing.`);
    }
  }

  // Ensure zero orphan/unclaimed SALE ledger movements remain for this sale
  for (const m of saleLedgerMovements) {
    if (m.referenceId === saleId && !claimedMovementIds.has(m.id)) {
      errors.push(`ORPHAN_SALE_LEDGER_MOVEMENT: Movement ${m.id} (${m.medicineId}) is not matched to any sale item.`);
    }
  }

  return {
    valid: errors.length === 0,
    checkedItems: saleItems.length,
    perItemResults,
    errors,
  };
}

/**
 * Approval Gate (Section 12):
 * Admin/Super Admin may approve unexplained quantity variances ONLY when:
 * - Actor is active `admin` or `super_admin` in the branch.
 * - Mandatory investigation record ID and reason are provided.
 * - ZERO hard integrity blockers exist (unexplained-variance approval NEVER bypasses
 *   sync conflicts, missing/duplicate ledger movements, invalid cost provenance,
 *   stale stock versions, or failed integrity checks!).
 */
export function evaluateStocktakeApprovalEligibility(params: {
  line: FinancialStocktakeLine;
  actorUid: string;
  actorRole: StocktakeRole;
  actorBranchId: string;
  decision: 'APPROVED' | 'REJECTED';
  isUnexplainedVarianceException: boolean;
  reason: string;
  investigationRecordId: string;
  approvalId: string;
  serverNowMs: number;
}): { ok: true; approval: FinancialApprovalRecord } | { ok: false; code: string; message: string } {
  const {
    line,
    actorUid,
    actorRole,
    actorBranchId,
    decision,
    isUnexplainedVarianceException,
    reason,
    investigationRecordId,
    approvalId,
    serverNowMs,
  } = params;

  if (actorRole !== 'admin' && actorRole !== 'super_admin') {
    return { ok: false, code: 'UNAUTHORIZED_APPROVAL', message: 'Cashiers cannot approve or reject stocktake variances.' };
  }
  if (actorBranchId !== line.branchId) {
    return { ok: false, code: 'CROSS_BRANCH_DENIED', message: 'Cross-branch approval denied.' };
  }
  if (!actorUid.trim() || !isValidFirestoreDocId(approvalId) || !Number.isFinite(serverNowMs) || serverNowMs <= 0) {
    return { ok: false, code: 'INVALID_APPROVAL_INPUT', message: 'Valid actorUid, approvalId, and serverNowMs are required.' };
  }
  const lineInvariantErrors = validateFinancialLineExactInvariants(line);
  if (lineInvariantErrors.length > 0) {
    return {
      ok: false,
      code: 'INVALID_FINANCIAL_LINE_INVARIANTS',
      message: `Financial line violates exact accounting invariants: ${lineInvariantErrors.join(' | ')}`,
    };
  }
  if (line.discrepancyStatus === 'POSTED' || line.postingId !== null) {
    return { ok: false, code: 'ALREADY_POSTED_IMMUTABLE', message: 'Posted stocktake lines cannot be mutated or re-approved.' };
  }
  if (!reason || reason.trim().length < 5 || reason.trim().length > 500) {
    return { ok: false, code: 'APPROVAL_REASON_REQUIRED', message: 'Approval/rejection reason (5..500 chars) is mandatory.' };
  }

  if (decision === 'APPROVED') {
    if (line.discrepancyStatus === 'NEEDS_RECOUNT' || line.discrepancyStatus === 'REJECTED') {
      return {
        ok: false,
        code: 'RECOUNT_OR_REJECTED_BLOCKS_APPROVAL',
        message: `Cannot approve line in discrepancyStatus=${line.discrepancyStatus}.`,
      };
    }
    if (line.integrityBlockers.length > 0) {
      return {
        ok: false,
        code: 'INTEGRITY_BLOCKER_CANNOT_BE_BYPASSED',
        message: `Exception approval cannot bypass integrity blockers: ${line.integrityBlockers.join(' | ')}`,
      };
    }
    if (line.costStatus === 'NEEDS_REVIEW') {
      return {
        ok: false,
        code: 'INVALID_COST_PROVENANCE_BLOCKED',
        message: 'Cannot approve posting while cost provenance status is NEEDS_REVIEW.',
      };
    }
    if (isUnexplainedVarianceException && (!investigationRecordId || investigationRecordId.trim().length < 3)) {
      return {
        ok: false,
        code: 'INVESTIGATION_RECORD_REQUIRED',
        message: 'Unexplained variance approval requires a linked investigationRecordId.',
      };
    }
  }

  return {
    ok: true,
    approval: {
      approvalId,
      sessionId: line.sessionId,
      branchId: line.branchId,
      medicineId: line.medicineId,
      reconciliationVersion: line.reconciliationVersion,
      decision,
      isUnexplainedVarianceException,
      reason: reason.trim().slice(0, 500),
      investigationRecordId: investigationRecordId.trim(),
      approverUid: actorUid,
      approverRole: actorRole,
      approvedAtServerMs: serverNowMs,
    },
  };
}

/**
 * Posting Safety Pre-Flight Protocol (Section 12.1).
 * Verifies ALL 8 mandatory safety preconditions before creating a deterministic,
 * idempotent, separately traceable `ADJUSTMENT` ledger movement.
 */
export interface PostingPreFlightInput {
  line: FinancialStocktakeLine;
  approval: FinancialApprovalRecord | null;
  actorUid: string;
  actorRole: StocktakeRole;
  actorBranchId: string;
  freshCurrentLedgerMovementIds: ReadonlyArray<string>;
  reconciledLedgerMovementIds: ReadonlyArray<string>;
  freshCountRevision: number;
  hasPendingLocalOrRemoteSync: boolean;
  existingPostingRecord: StocktakePostingRecord | null;
  postingId: string;
  serverNowMs: number;
}

export type PostingPreFlightResult =
  | {
      ok: true;
      idempotentAlreadyPosted: boolean;
      postingRecord: StocktakePostingRecord;
      ledgerAdjustmentToCreate: {
        id: string;
        branchId: string;
        medicineId: string;
        type: 'ADJUSTMENT';
        baseUnitsDelta: number;
        referenceId: string;
        idempotencyKey: string;
      } | null;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export function evaluateStocktakePostingPreFlight(
  input: PostingPreFlightInput
): PostingPreFlightResult {
  const {
    line,
    approval,
    actorUid,
    actorRole,
    actorBranchId,
    freshCurrentLedgerMovementIds,
    reconciledLedgerMovementIds,
    freshCountRevision,
    hasPendingLocalOrRemoteSync,
    existingPostingRecord,
    postingId,
    serverNowMs,
  } = input;

  if (actorRole !== 'admin' && actorRole !== 'super_admin') {
    return { ok: false, code: 'UNAUTHORIZED_POSTING', message: 'Only Admin/Super Admin can post stocktake adjustments.' };
  }
  if (actorBranchId !== line.branchId) {
    return { ok: false, code: 'CROSS_BRANCH_DENIED', message: 'Cross-branch posting denied.' };
  }
  if (!actorUid.trim() || !isValidFirestoreDocId(postingId) || !Number.isFinite(serverNowMs) || serverNowMs <= 0) {
    return { ok: false, code: 'INVALID_POSTING_INPUT', message: 'Valid actorUid, postingId, and serverNowMs are required.' };
  }

  const expectedIdempotencyKey = buildStocktakePostingIdempotencyKey({
    branchId: line.branchId,
    sessionId: line.sessionId,
    medicineId: line.medicineId,
    reconciliationVersion: line.reconciliationVersion,
  });

  // Check 8: Idempotent retry detection vs duplicate posting prevention
  if (existingPostingRecord) {
    if (
      existingPostingRecord.idempotencyKey === expectedIdempotencyKey &&
      existingPostingRecord.reconciliationVersion === line.reconciliationVersion &&
      existingPostingRecord.branchId === line.branchId &&
      existingPostingRecord.sessionId === line.sessionId &&
      existingPostingRecord.medicineId === line.medicineId &&
      existingPostingRecord.adjustmentBaseUnitsDelta === line.requiredLedgerAdjustmentBaseUnits
    ) {
      return {
        ok: true,
        idempotentAlreadyPosted: true,
        postingRecord: existingPostingRecord,
        ledgerAdjustmentToCreate: null,
      };
    }
    return {
      ok: false,
      code: 'DUPLICATE_POSTING_REJECTED',
      message: `A prior posting (${existingPostingRecord.postingId}) already exists for medicine ${line.medicineId} in session ${line.sessionId}.`,
    };
  }

  const lineInvariantErrors = validateFinancialLineExactInvariants(line);
  if (lineInvariantErrors.length > 0) {
    return {
      ok: false,
      code: 'INVALID_FINANCIAL_LINE_INVARIANTS',
      message: `Financial line violates exact invariants: ${lineInvariantErrors.join(' | ')}`,
    };
  }

  // Check 5: No pending syncs
  if (hasPendingLocalOrRemoteSync) {
    return {
      ok: false,
      code: 'PENDING_SYNC_BLOCKS_POSTING',
      message: 'Cannot post while local or remote sync operations are still pending.',
    };
  }

  // Check 1 & 2 & 4: Fresh ledger set must match reconciled ledger set (no new, missing, or duplicate movements!)
  const reconciledSet = new Set(reconciledLedgerMovementIds);
  const freshSet = new Set(freshCurrentLedgerMovementIds);
  if (
    reconciledSet.size !== reconciledLedgerMovementIds.length ||
    freshSet.size !== freshCurrentLedgerMovementIds.length
  ) {
    return {
      ok: false,
      code: 'DUPLICATE_MOVEMENT_IN_PREFLIGHT',
      message: 'Duplicate movement IDs detected in pre-flight movement list.',
    };
  }
  const hasNewOrMissing =
    reconciledSet.size !== freshSet.size ||
    [...freshSet].some((id) => !reconciledSet.has(id));
  if (hasNewOrMissing) {
    return {
      ok: false,
      code: 'STALE_STOCK_VERSION_NEW_MOVEMENTS',
      message: 'Ledger movements changed after reconciliation; re-reconcile before posting.',
    };
  }

  // Check 3: Count revision must still match and be valid
  if (!Number.isSafeInteger(line.sourceCountRevision) || line.sourceCountRevision < 1 || freshCountRevision !== line.sourceCountRevision) {
    return {
      ok: false,
      code: 'STALE_COUNT_REVISION',
      message: `Count revision changed or invalid (${line.sourceCountRevision} -> ${freshCountRevision}); re-reconcile before posting.`,
    };
  }

  // Hard integrity blockers
  if (line.integrityBlockers.length > 0 || line.costStatus === 'NEEDS_REVIEW') {
    return {
      ok: false,
      code: 'INTEGRITY_OR_COST_BLOCKER',
      message: 'Line has unresolved integrity blockers or NEEDS_REVIEW cost provenance.',
    };
  }

  // Check 6: Valid approval required
  if (!approval || approval.decision !== 'APPROVED') {
    return {
      ok: false,
      code: 'APPROVAL_REQUIRED_FOR_POSTING',
      message: 'Valid APPROVED FinancialApprovalRecord is required before posting.',
    };
  }
  if (
    approval.branchId !== line.branchId ||
    approval.sessionId !== line.sessionId ||
    approval.medicineId !== line.medicineId ||
    approval.reconciliationVersion !== line.reconciliationVersion
  ) {
    return {
      ok: false,
      code: 'APPROVAL_VERSION_MISMATCH',
      message: 'Approval record does not match current reconciliationVersion.',
    };
  }

  const ledgerMovementId = buildStocktakeAdjustmentLedgerId({
    branchId: line.branchId,
    sessionId: line.sessionId,
    medicineId: line.medicineId,
    reconciliationVersion: line.reconciliationVersion,
  });

  const postingRecord: StocktakePostingRecord = {
    postingId,
    idempotencyKey: expectedIdempotencyKey,
    sessionId: line.sessionId,
    branchId: line.branchId,
    medicineId: line.medicineId,
    reconciliationVersion: line.reconciliationVersion,
    countRevision: line.sourceCountRevision,
    approvalId: approval.approvalId,
    ledgerMovementId: line.requiredLedgerAdjustmentBaseUnits === 0 ? '' : ledgerMovementId,
    adjustmentBaseUnitsDelta: line.requiredLedgerAdjustmentBaseUnits,
    costStatus: line.costStatus,
    adjustmentValuationExact: line.financialVarianceExact,
    postedByUid: actorUid,
    postedAtServerMs: serverNowMs,
  };

  return {
    ok: true,
    idempotentAlreadyPosted: false,
    postingRecord,
    ledgerAdjustmentToCreate:
      line.requiredLedgerAdjustmentBaseUnits === 0
        ? null
        : {
            id: ledgerMovementId,
            branchId: line.branchId,
            medicineId: line.medicineId,
            type: 'ADJUSTMENT',
            baseUnitsDelta: line.requiredLedgerAdjustmentBaseUnits,
            referenceId: line.sessionId,
            idempotencyKey: expectedIdempotencyKey,
          },
  };
}
