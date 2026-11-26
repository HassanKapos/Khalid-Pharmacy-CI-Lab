/**
 * Phase 2D — Workstream A (R4E)
 * Read-Only Historical Inventory Ledger Review & Opening-Stock Evidence Audit.
 *
 * STRICT INVARIANT:
 * This module is strictly READ-ONLY and NON-DESTRUCTIVE.
 * It MUST NEVER rewrite, delete, normalize, migrate, silently repair, invent
 * missing evidence, upgrade any uncertain record to VERIFIED, or alter stock
 * balances. Suspicious records are classified for manual review while preserving
 * all original data untouched.
 */

export type HistoricalLedgerClassification =
  | 'VALID_LEGACY'
  | 'MISSING_EVIDENCE'
  | 'INCONSISTENT'
  | 'SUSPICIOUS_OR_FORGED'
  | 'REQUIRES_MANUAL_REVIEW';

export interface OpeningStockEvidenceLike {
  readonly schemaVersion?: number;
  readonly medicineId?: string;
  readonly createOperationId?: string;
  readonly intent?: 'OMITTED' | 'EXPLICIT_ZERO' | 'POSITIVE' | string;
  readonly intendedInitialStock?: number;
  readonly intendedBaseUnits?: number;
  readonly initialLedgerMovementId?: string;
  readonly batchNumber?: string;
}

export interface LedgerAuditRecordInput {
  readonly id?: string;
  readonly medicineId?: string;
  readonly type?: string;
  readonly unit?: string;
  readonly quantityDelta?: number;
  readonly baseUnitsDelta?: number;
  readonly batchNumber?: string;
  readonly referenceId?: string;
  readonly timestamp?: string;
  readonly userId?: string;
}

export interface MedicineAuditRecordInput {
  readonly id?: string;
  readonly name?: string;
  readonly initialStock?: number;
  readonly stock?: number;
  readonly batchNumber?: string;
  readonly stripsPerPack?: number;
  readonly pillsPerStrip?: number;
  readonly baseUnitsPerPack?: number;
  readonly unitDefinition?: {
    readonly configStatus?: string;
    readonly hierarchy?: {
      readonly kind?: string;
      readonly baseUnitsPerPack?: number;
      readonly stripsPerPack?: number;
      readonly pillsPerStrip?: number;
    };
  };
  readonly openingStockEvidence?: OpeningStockEvidenceLike | null;
}

export interface OpeningStockEvidenceValidationResult {
  readonly ok: boolean;
  readonly reasonCode:
    | 'VALID_POSITIVE'
    | 'VALID_ZERO_OR_OMITTED'
    | 'EVIDENCE_ABSENT'
    | 'EVIDENCE_MALFORMED'
    | 'EVIDENCE_CONTRADICTS_INITIAL_STOCK'
    | 'EVIDENCE_FORBIDS_INITIAL_MOVEMENT'
    | 'MOVEMENT_QUANTITY_MISMATCH'
    | 'MOVEMENT_UNIT_INVALID'
    | 'MOVEMENT_BATCH_MISMATCH'
    | 'MOVEMENT_ID_MISMATCH';
  readonly reason: string;
}

export interface HistoricalLedgerFinding {
  readonly movementId: string;
  readonly medicineId: string;
  readonly type: string;
  readonly classification: HistoricalLedgerClassification;
  readonly reasons: readonly string[];
  readonly manualReviewRequired: boolean;
}

export interface HistoricalLedgerAuditReport {
  readonly readOnly: true;
  readonly mutatedRecordCount: 0;
  readonly totalMovementsInspected: number;
  readonly counts: Readonly<Record<HistoricalLedgerClassification, number>>;
  readonly findings: readonly HistoricalLedgerFinding[];
}

function resolvePackBaseUnits(med: MedicineAuditRecordInput | undefined): number | null {
  if (!med || typeof med !== 'object') return null;
  const h = med.unitDefinition?.hierarchy;
  if (h?.kind === 'DIRECT_PACK') {
    const b = h.baseUnitsPerPack;
    return typeof b === 'number' && Number.isSafeInteger(b) && b >= 1 ? b : null;
  }
  if (h?.kind === 'SOLID_TWO_LEVEL') {
    const s = h.stripsPerPack;
    const p = h.pillsPerStrip;
    if (typeof s === 'number' && Number.isSafeInteger(s) && s >= 1 && typeof p === 'number' && Number.isSafeInteger(p) && p >= 1) {
      return s * p;
    }
    return null;
  }
  if (typeof med.baseUnitsPerPack === 'number' && Number.isSafeInteger(med.baseUnitsPerPack) && med.baseUnitsPerPack >= 1) {
    return med.baseUnitsPerPack;
  }
  if (
    typeof med.stripsPerPack === 'number' &&
    Number.isSafeInteger(med.stripsPerPack) &&
    med.stripsPerPack >= 1 &&
    typeof med.pillsPerStrip === 'number' &&
    Number.isSafeInteger(med.pillsPerStrip) &&
    med.pillsPerStrip >= 1
  ) {
    return med.stripsPerPack * med.pillsPerStrip;
  }
  return null;
}

/**
 * Authoritative validation of openingStockEvidence against a medicine and an
 * optional INITIAL inventory ledger movement. Never mutates inputs.
 */
export function validateOpeningStockEvidenceAuthoritative(
  medicine: MedicineAuditRecordInput | null | undefined,
  initialMovement?: LedgerAuditRecordInput | null
): OpeningStockEvidenceValidationResult {
  if (!medicine || typeof medicine !== 'object') {
    return { ok: false, reasonCode: 'EVIDENCE_MALFORMED', reason: 'Medicine record is absent or malformed.' };
  }
  const ev = medicine.openingStockEvidence;
  if (ev === undefined || ev === null) {
    return { ok: false, reasonCode: 'EVIDENCE_ABSENT', reason: 'openingStockEvidence is absent or null.' };
  }
  if (typeof ev !== 'object' || Array.isArray(ev)) {
    return { ok: false, reasonCode: 'EVIDENCE_MALFORMED', reason: 'openingStockEvidence must be a non-null plain object.' };
  }
  const intent = ev.intent;
  if (intent !== 'OMITTED' && intent !== 'EXPLICIT_ZERO' && intent !== 'POSITIVE') {
    return { ok: false, reasonCode: 'EVIDENCE_MALFORMED', reason: `Invalid openingStockEvidence.intent '${String(intent)}'.` };
  }
  if (
    typeof ev.intendedInitialStock !== 'number' ||
    !Number.isFinite(ev.intendedInitialStock) ||
    ev.intendedInitialStock < 0 ||
    typeof ev.intendedBaseUnits !== 'number' ||
    !Number.isFinite(ev.intendedBaseUnits) ||
    ev.intendedBaseUnits < 0
  ) {
    return { ok: false, reasonCode: 'EVIDENCE_MALFORMED', reason: 'openingStockEvidence quantities must be finite non-negative numbers.' };
  }
  if (typeof ev.medicineId === 'string' && medicine.id && ev.medicineId !== medicine.id) {
    return { ok: false, reasonCode: 'EVIDENCE_MALFORMED', reason: 'openingStockEvidence.medicineId disagrees with medicine.id.' };
  }
  if (typeof medicine.initialStock === 'number' && Number.isFinite(medicine.initialStock) && medicine.initialStock !== ev.intendedInitialStock) {
    return {
      ok: false,
      reasonCode: 'EVIDENCE_CONTRADICTS_INITIAL_STOCK',
      reason: `openingStockEvidence.intendedInitialStock (${ev.intendedInitialStock}) contradicts medicine.initialStock (${medicine.initialStock}).`,
    };
  }

  const packUnits = resolvePackBaseUnits(medicine);

  if (intent === 'OMITTED' || intent === 'EXPLICIT_ZERO') {
    if (ev.intendedInitialStock !== 0 || ev.intendedBaseUnits !== 0 || ev.initialLedgerMovementId !== undefined) {
      return {
        ok: false,
        reasonCode: 'EVIDENCE_MALFORMED',
        reason: `${intent} openingStockEvidence cannot carry positive stock or initialLedgerMovementId.`,
      };
    }
    if (initialMovement) {
      return {
        ok: false,
        reasonCode: 'EVIDENCE_FORBIDS_INITIAL_MOVEMENT',
        reason: `${intent} openingStockEvidence forbids INITIAL ledger movement '${String(initialMovement.id || '')}'.`,
      };
    }
    return {
      ok: true,
      reasonCode: 'VALID_ZERO_OR_OMITTED',
      reason: `${intent} openingStockEvidence is consistent with zero opening stock.`,
    };
  }

  // intent === 'POSITIVE'
  if (ev.intendedInitialStock <= 0 || ev.intendedBaseUnits <= 0) {
    return {
      ok: false,
      reasonCode: 'EVIDENCE_MALFORMED',
      reason: 'POSITIVE openingStockEvidence requires strictly positive intendedInitialStock and intendedBaseUnits.',
    };
  }
  const expectedMovId = typeof ev.initialLedgerMovementId === 'string' ? ev.initialLedgerMovementId.trim() : '';
  const expectedBatch = typeof ev.batchNumber === 'string' ? ev.batchNumber.trim() : '';
  if (!expectedMovId || !expectedBatch) {
    return {
      ok: false,
      reasonCode: 'EVIDENCE_MALFORMED',
      reason: 'POSITIVE openingStockEvidence requires non-empty initialLedgerMovementId and batchNumber.',
    };
  }
  if (packUnits !== null && Math.abs(ev.intendedInitialStock * packUnits - ev.intendedBaseUnits) > 1e-4) {
    return {
      ok: false,
      reasonCode: 'MOVEMENT_QUANTITY_MISMATCH',
      reason: `openingStockEvidence.intendedBaseUnits (${ev.intendedBaseUnits}) disagrees with intendedInitialStock (${ev.intendedInitialStock}) * packUnits (${packUnits}).`,
    };
  }
  if (initialMovement) {
    if (initialMovement.unit !== 'pack') {
      return {
        ok: false,
        reasonCode: 'MOVEMENT_UNIT_INVALID',
        reason: `INITIAL ledger movement unit must be 'pack', received '${String(initialMovement.unit)}'.`,
      };
    }
    if (initialMovement.id !== expectedMovId) {
      return {
        ok: false,
        reasonCode: 'MOVEMENT_ID_MISMATCH',
        reason: `INITIAL movement id '${String(initialMovement.id)}' mismatches evidence initialLedgerMovementId '${expectedMovId}'.`,
      };
    }
    if (
      typeof initialMovement.quantityDelta !== 'number' ||
      !Number.isFinite(initialMovement.quantityDelta) ||
      initialMovement.quantityDelta <= 0 ||
      typeof initialMovement.baseUnitsDelta !== 'number' ||
      !Number.isFinite(initialMovement.baseUnitsDelta) ||
      initialMovement.baseUnitsDelta <= 0 ||
      Math.abs(initialMovement.quantityDelta - ev.intendedInitialStock) > 1e-6 ||
      Math.abs(initialMovement.baseUnitsDelta - ev.intendedBaseUnits) > 1e-6
    ) {
      return {
        ok: false,
        reasonCode: 'MOVEMENT_QUANTITY_MISMATCH',
        reason: `INITIAL movement delta (${String(initialMovement.quantityDelta)} / ${String(initialMovement.baseUnitsDelta)}) mismatches openingStockEvidence (${ev.intendedInitialStock} / ${ev.intendedBaseUnits}).`,
      };
    }
    const movBatch = typeof initialMovement.batchNumber === 'string' ? initialMovement.batchNumber.trim() : '';
    if (!movBatch || movBatch !== expectedBatch) {
      return {
        ok: false,
        reasonCode: 'MOVEMENT_BATCH_MISMATCH',
        reason: `INITIAL movement batchNumber '${movBatch}' mismatches evidence batchNumber '${expectedBatch}'.`,
      };
    }
  }
  return {
    ok: true,
    reasonCode: 'VALID_POSITIVE',
    reason: 'POSITIVE openingStockEvidence matches medicine and INITIAL ledger movement.',
  };
}

/**
 * Classifies a single historical inventory ledger record in strict read-only mode.
 */
export function classifyHistoricalLedgerRecord(
  movement: LedgerAuditRecordInput,
  medicineById: ReadonlyMap<string, MedicineAuditRecordInput>,
  initialCountByMedicineId: ReadonlyMap<string, number>
): HistoricalLedgerFinding {
  const movementId = typeof movement?.id === 'string' && movement.id.trim() ? movement.id : '(missing-id)';
  const medicineId = typeof movement?.medicineId === 'string' && movement.medicineId.trim() ? movement.medicineId : '(missing-medicine)';
  const type = typeof movement?.type === 'string' && movement.type.trim() ? movement.type : '(missing-type)';
  const med = medicineById.get(medicineId);
  const reasons: string[] = [];

  if (!med) {
    return Object.freeze({
      movementId,
      medicineId,
      type,
      classification: 'REQUIRES_MANUAL_REVIEW',
      reasons: Object.freeze(['Orphan ledger movement: referenced medicine does not exist in inspected snapshot.']),
      manualReviewRequired: true,
    });
  }

  const q = movement.quantityDelta;
  const b = movement.baseUnitsDelta;
  if (typeof q !== 'number' || !Number.isFinite(q) || q === 0 || typeof b !== 'number' || !Number.isFinite(b) || b === 0) {
    return Object.freeze({
      movementId,
      medicineId,
      type,
      classification: 'INCONSISTENT',
      reasons: Object.freeze(['Movement carries zero, non-finite, or missing quantityDelta/baseUnitsDelta.']),
      manualReviewRequired: true,
    });
  }

  if (type === 'INITIAL') {
    const initialCount = initialCountByMedicineId.get(medicineId) ?? 0;
    if (initialCount > 1) {
      reasons.push(`Medicine '${medicineId}' has ${initialCount} INITIAL ledger movements (duplicate INITIAL).`);
      return Object.freeze({
        movementId,
        medicineId,
        type,
        classification: 'SUSPICIOUS_OR_FORGED',
        reasons: Object.freeze(reasons),
        manualReviewRequired: true,
      });
    }

    if (q < 0 || b < 0) {
      return Object.freeze({
        movementId,
        medicineId,
        type,
        classification: 'INCONSISTENT',
        reasons: Object.freeze(['INITIAL movement carries negative quantityDelta or baseUnitsDelta.']),
        manualReviewRequired: true,
      });
    }

    if (movement.unit !== 'pack') {
      return Object.freeze({
        movementId,
        medicineId,
        type,
        classification: 'SUSPICIOUS_OR_FORGED',
        reasons: Object.freeze([`INITIAL movement uses non-pack unit '${String(movement.unit)}'.`]),
        manualReviewRequired: true,
      });
    }

    if (med.openingStockEvidence !== undefined && med.openingStockEvidence !== null) {
      const check = validateOpeningStockEvidenceAuthoritative(med, movement);
      if (check.ok) {
        return Object.freeze({
          movementId,
          medicineId,
          type,
          classification: 'VALID_LEGACY',
          reasons: Object.freeze(['Verified against explicit openingStockEvidence.']),
          manualReviewRequired: false,
        });
      }
      const forgedCodes = new Set([
        'EVIDENCE_FORBIDS_INITIAL_MOVEMENT',
        'MOVEMENT_ID_MISMATCH',
        'MOVEMENT_UNIT_INVALID',
        'EVIDENCE_CONTRADICTS_INITIAL_STOCK',
      ]);
      const classification: HistoricalLedgerClassification = forgedCodes.has(check.reasonCode)
        ? 'SUSPICIOUS_OR_FORGED'
        : 'INCONSISTENT';
      return Object.freeze({
        movementId,
        medicineId,
        type,
        classification,
        reasons: Object.freeze([check.reason]),
        manualReviewRequired: true,
      });
    }

    // Legacy record without openingStockEvidence field: distinguish consistent legacy vs suspicious/missing
    const packUnits = resolvePackBaseUnits(med);
    if (typeof med.initialStock === 'number' && med.initialStock === 0 && b > 0) {
      return Object.freeze({
        movementId,
        medicineId,
        type,
        classification: 'SUSPICIOUS_OR_FORGED',
        reasons: Object.freeze([
          `INITIAL movement adds baseUnitsDelta=${b} while medicine.initialStock=0 and openingStockEvidence is absent.`,
        ]),
        manualReviewRequired: true,
      });
    }
    if (packUnits !== null && Math.abs(q * packUnits - b) > 1e-4) {
      return Object.freeze({
        movementId,
        medicineId,
        type,
        classification: 'INCONSISTENT',
        reasons: Object.freeze([
          `Legacy INITIAL baseUnitsDelta (${b}) disagrees with quantityDelta (${q}) * packUnits (${packUnits}).`,
        ]),
        manualReviewRequired: true,
      });
    }
    if (typeof med.initialStock === 'number' && Number.isFinite(med.initialStock) && med.initialStock > 0) {
      if (Math.abs(med.initialStock - q) > 1e-6) {
        return Object.freeze({
          movementId,
          medicineId,
          type,
          classification: 'INCONSISTENT',
          reasons: Object.freeze([
            `Legacy INITIAL quantityDelta (${q}) disagrees with medicine.initialStock (${med.initialStock}).`,
          ]),
          manualReviewRequired: true,
        });
      }
      return Object.freeze({
        movementId,
        medicineId,
        type,
        classification: 'MISSING_EVIDENCE',
        reasons: Object.freeze([
          'Pre-evidence legacy INITIAL record matches initialStock/packing but lacks openingStockEvidence; preserved without fabrication.',
        ]),
        manualReviewRequired: false,
      });
    }

    return Object.freeze({
      movementId,
      medicineId,
      type,
      classification: 'REQUIRES_MANUAL_REVIEW',
      reasons: Object.freeze([
        'INITIAL record lacks both openingStockEvidence and explicit positive medicine.initialStock; requires manual review.',
      ]),
      manualReviewRequired: true,
    });
  }

  // Non-INITIAL movement sanity checks (read-only)
  if ((type === 'SALE' || type === 'DAMAGE') && (q > 0 || b > 0)) {
    return Object.freeze({
      movementId,
      medicineId,
      type,
      classification: 'INCONSISTENT',
      reasons: Object.freeze([`${type} movement carries positive delta (${q}/${b}).`]),
      manualReviewRequired: true,
    });
  }
  if ((type === 'PURCHASE' || type === 'RETURN') && (q < 0 || b < 0)) {
    return Object.freeze({
      movementId,
      medicineId,
      type,
      classification: 'INCONSISTENT',
      reasons: Object.freeze([`${type} movement carries negative delta (${q}/${b}).`]),
      manualReviewRequired: true,
    });
  }
  if (!movement.userId || !movement.timestamp) {
    return Object.freeze({
      movementId,
      medicineId,
      type,
      classification: 'MISSING_EVIDENCE',
      reasons: Object.freeze(['Legacy movement missing userId or timestamp metadata.']),
      manualReviewRequired: false,
    });
  }

  return Object.freeze({
    movementId,
    medicineId,
    type,
    classification: 'VALID_LEGACY',
    reasons: Object.freeze(['Movement sign, medicine reference, and audit metadata are consistent.']),
    manualReviewRequired: false,
  });
}

/**
 * Performs a full read-only audit of historical inventory ledger records.
 * Guaranteed zero mutations (`mutatedRecordCount: 0`).
 */
export function auditHistoricalLedger(
  medicines: readonly MedicineAuditRecordInput[],
  movements: readonly LedgerAuditRecordInput[]
): HistoricalLedgerAuditReport {
  const medicineById = new Map<string, MedicineAuditRecordInput>();
  for (const med of medicines) {
    if (med && typeof med.id === 'string' && med.id.trim()) {
      medicineById.set(med.id, med);
    }
  }

  const initialCountByMedicineId = new Map<string, number>();
  for (const mov of movements) {
    if (mov?.type === 'INITIAL' && typeof mov.medicineId === 'string') {
      initialCountByMedicineId.set(mov.medicineId, (initialCountByMedicineId.get(mov.medicineId) ?? 0) + 1);
    }
  }

  const counts: Record<HistoricalLedgerClassification, number> = {
    VALID_LEGACY: 0,
    MISSING_EVIDENCE: 0,
    INCONSISTENT: 0,
    SUSPICIOUS_OR_FORGED: 0,
    REQUIRES_MANUAL_REVIEW: 0,
  };

  const findings: HistoricalLedgerFinding[] = [];
  for (const mov of movements) {
    const finding = classifyHistoricalLedgerRecord(mov, medicineById, initialCountByMedicineId);
    counts[finding.classification] += 1;
    findings.push(finding);
  }

  return Object.freeze({
    readOnly: true as const,
    mutatedRecordCount: 0 as const,
    totalMovementsInspected: movements.length,
    counts: Object.freeze(counts),
    findings: Object.freeze(findings),
  });
}
