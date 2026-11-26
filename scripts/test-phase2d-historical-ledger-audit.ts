import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import {
  auditHistoricalLedger,
  validateOpeningStockEvidenceAuthoritative,
  type LedgerAuditRecordInput,
  type MedicineAuditRecordInput,
} from '../src/services/historicalLedgerAudit.ts';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

const solidVerifiedMed: MedicineAuditRecordInput = {
  id: 'med-valid-1',
  name: 'Amoxicillin 500mg',
  initialStock: 2,
  stock: 2,
  batchNumber: 'B-100',
  stripsPerPack: 2,
  pillsPerStrip: 10,
  unitDefinition: {
    configStatus: 'VERIFIED',
    hierarchy: { kind: 'SOLID_TWO_LEVEL', stripsPerPack: 2, pillsPerStrip: 10, baseUnitsPerPack: 20 },
  },
  openingStockEvidence: {
    schemaVersion: 1,
    medicineId: 'med-valid-1',
    createOperationId: 'op-med-1',
    intent: 'POSITIVE',
    intendedInitialStock: 2,
    intendedBaseUnits: 40,
    initialLedgerMovementId: 'led-init-1',
    batchNumber: 'B-100',
  },
};

const validInitMov: LedgerAuditRecordInput = {
  id: 'led-init-1',
  medicineId: 'med-valid-1',
  type: 'INITIAL',
  unit: 'pack',
  quantityDelta: 2,
  baseUnitsDelta: 40,
  batchNumber: 'B-100',
  userId: 'admin-1',
  timestamp: '2026-11-23T10:00:00.000Z',
};

check('A1-01: Accepts valid POSITIVE openingStockEvidence matching INITIAL ledger movement', () => {
  const res = validateOpeningStockEvidenceAuthoritative(solidVerifiedMed, validInitMov);
  assert.equal(res.ok, true);
  assert.equal(res.reasonCode, 'VALID_POSITIVE');
});

check('A1-02: Rejects absent and null openingStockEvidence', () => {
  const r1 = validateOpeningStockEvidenceAuthoritative({ ...solidVerifiedMed, openingStockEvidence: undefined }, validInitMov);
  const r2 = validateOpeningStockEvidenceAuthoritative({ ...solidVerifiedMed, openingStockEvidence: null }, validInitMov);
  assert.equal(r1.ok, false);
  assert.equal(r1.reasonCode, 'EVIDENCE_ABSENT');
  assert.equal(r2.ok, false);
  assert.equal(r2.reasonCode, 'EVIDENCE_ABSENT');
});

check('A1-03: Rejects empty or malformed openingStockEvidence', () => {
  const r1 = validateOpeningStockEvidenceAuthoritative({ ...solidVerifiedMed, openingStockEvidence: {} }, validInitMov);
  const r2 = validateOpeningStockEvidenceAuthoritative({ ...solidVerifiedMed, openingStockEvidence: { intent: 'UNKNOWN' } }, validInitMov);
  assert.equal(r1.ok, false);
  assert.equal(r1.reasonCode, 'EVIDENCE_MALFORMED');
  assert.equal(r2.ok, false);
  assert.equal(r2.reasonCode, 'EVIDENCE_MALFORMED');
});

check('A1-04: Rejects forged INITIAL movement (baseUnitsDelta=40) when medicine has OMITTED or EXPLICIT_ZERO openingStockEvidence (Case 11f)', () => {
  const omittedMed: MedicineAuditRecordInput = {
    ...solidVerifiedMed,
    id: 'med-forged-11f',
    initialStock: 0,
    openingStockEvidence: {
      schemaVersion: 1,
      medicineId: 'med-forged-11f',
      intent: 'OMITTED',
      intendedInitialStock: 0,
      intendedBaseUnits: 0,
    },
  };
  const forgedMov: LedgerAuditRecordInput = {
    ...validInitMov,
    id: 'led-forged-11f',
    medicineId: 'med-forged-11f',
    quantityDelta: 2,
    baseUnitsDelta: 40,
  };
  const r = validateOpeningStockEvidenceAuthoritative(omittedMed, forgedMov);
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'EVIDENCE_FORBIDS_INITIAL_MOVEMENT');
});

check('A1-05: Rejects Case 11g non-pack unit, batch mismatch, and quantity/ID mismatches', () => {
  const rStrip = validateOpeningStockEvidenceAuthoritative(solidVerifiedMed, { ...validInitMov, unit: 'strip' });
  assert.equal(rStrip.ok, false);
  assert.equal(rStrip.reasonCode, 'MOVEMENT_UNIT_INVALID');

  const rBatch = validateOpeningStockEvidenceAuthoritative(solidVerifiedMed, { ...validInitMov, batchNumber: 'B-WRONG' });
  assert.equal(rBatch.ok, false);
  assert.equal(rBatch.reasonCode, 'MOVEMENT_BATCH_MISMATCH');

  const rQty = validateOpeningStockEvidenceAuthoritative(solidVerifiedMed, { ...validInitMov, baseUnitsDelta: 60 });
  assert.equal(rQty.ok, false);
  assert.equal(rQty.reasonCode, 'MOVEMENT_QUANTITY_MISMATCH');

  const rId = validateOpeningStockEvidenceAuthoritative(solidVerifiedMed, { ...validInitMov, id: 'led-forged-id' });
  assert.equal(rId.ok, false);
  assert.equal(rId.reasonCode, 'MOVEMENT_ID_MISMATCH');
});

check('A6-01: Historical ledger audit classifies all 5 categories without mutating any record or inventing evidence', () => {
  const medicines: MedicineAuditRecordInput[] = [
    solidVerifiedMed,
    {
      id: 'med-legacy-missing-ev',
      name: 'Legacy Syrup',
      initialStock: 3,
      stock: 3,
      baseUnitsPerPack: 1,
    },
    {
      id: 'med-inconsistent',
      name: 'Bad Conversion Med',
      initialStock: 2,
      stock: 2,
      stripsPerPack: 2,
      pillsPerStrip: 10,
    },
    {
      id: 'med-forged-zero',
      name: 'Zero Stock Med',
      initialStock: 0,
      stock: 0,
      stripsPerPack: 2,
      pillsPerStrip: 10,
    },
    {
      id: 'med-ambiguous',
      name: 'Ambiguous Legacy',
      stripsPerPack: 2,
      pillsPerStrip: 10,
    },
  ];

  const movements: LedgerAuditRecordInput[] = [
    validInitMov, // VALID_LEGACY
    {
      id: 'led-legacy-ok',
      medicineId: 'med-legacy-missing-ev',
      type: 'INITIAL',
      unit: 'pack',
      quantityDelta: 3,
      baseUnitsDelta: 3,
      userId: 'legacy-admin',
      timestamp: '2025-12-01T08:00:00.000Z',
    }, // MISSING_EVIDENCE
    {
      id: 'led-bad-qty',
      medicineId: 'med-inconsistent',
      type: 'INITIAL',
      unit: 'pack',
      quantityDelta: 2,
      baseUnitsDelta: 99,
      userId: 'legacy-admin',
      timestamp: '2025-12-02T08:00:00.000Z',
    }, // INCONSISTENT
    {
      id: 'led-forged-11f',
      medicineId: 'med-forged-zero',
      type: 'INITIAL',
      unit: 'pack',
      quantityDelta: 2,
      baseUnitsDelta: 40,
      userId: 'attacker',
      timestamp: '2026-01-01T08:00:00.000Z',
    }, // SUSPICIOUS_OR_FORGED
    {
      id: 'led-orphan-manual',
      medicineId: 'med-nonexistent',
      type: 'INITIAL',
      unit: 'pack',
      quantityDelta: 1,
      baseUnitsDelta: 20,
      userId: 'unknown',
      timestamp: '2026-01-02T08:00:00.000Z',
    }, // REQUIRES_MANUAL_REVIEW
    {
      id: 'led-ambiguous-manual',
      medicineId: 'med-ambiguous',
      type: 'INITIAL',
      unit: 'pack',
      quantityDelta: 1,
      baseUnitsDelta: 20,
      userId: 'legacy',
      timestamp: '2026-01-03T08:00:00.000Z',
    }, // REQUIRES_MANUAL_REVIEW
  ];

  const medSnapshotBefore = JSON.stringify(medicines);
  const movSnapshotBefore = JSON.stringify(movements);

  const report = auditHistoricalLedger(medicines, movements);

  assert.equal(report.readOnly, true);
  assert.equal(report.mutatedRecordCount, 0);
  assert.equal(report.totalMovementsInspected, 6);
  assert.equal(report.counts.VALID_LEGACY, 1);
  assert.equal(report.counts.MISSING_EVIDENCE, 1);
  assert.equal(report.counts.INCONSISTENT, 1);
  assert.equal(report.counts.SUSPICIOUS_OR_FORGED, 1);
  assert.equal(report.counts.REQUIRES_MANUAL_REVIEW, 2);

  // Byte-for-byte immutability proof
  assert.equal(JSON.stringify(medicines), medSnapshotBefore);
  assert.equal(JSON.stringify(movements), movSnapshotBefore);
  assert.equal((medicines[1] as any).openingStockEvidence, undefined, 'Must not fabricate missing evidence');
  assert.equal((medicines[3] as any).stock, 0, 'Must not alter stock balances');
});

console.log(`HISTORICAL LEDGER AUDIT SUMMARY: ${passed}/${passed} PASSED`);
