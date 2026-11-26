import assert from 'node:assert/strict';
import {
  matchMedicineText,
  parseMedicineText,
  type MedicineCatalogueEntry
} from '../src/services/medicineTextParser.ts';

const profile = parseMedicineText('Augmentin 625 mg film coated tablets');
assert.deepEqual(profile.strengths, ['625mg']);
assert.ok(profile.dosageForms.includes('tablet'));

const dual = parseMedicineText('Amoxicillin 875 mg / Clavulanic Acid 125 mg tablets');
assert.deepEqual(dual.strengths, ['125mg', '875mg']);
assert.ok(dual.dosageForms.includes('tablet'));

const xr = parseMedicineText('Metformin 500 mg XR tablets');
assert.deepEqual(xr.releaseTypes, ['XR']);

const catalogue: MedicineCatalogueEntry[] = [
  { id: 'a', name: 'Augmentin 625 mg tablets', barcode: '111' },
  { id: 'b', name: 'Augmentin 1 g tablets', barcode: '222' },
  { id: 'c', name: 'Augmentin 625 mg syrup', barcode: '333' },
  { id: 'd', name: 'Metformin 500 mg SR tablets', barcode: '444' }
];

const scanned = parseMedicineText('Augmentin 625 mg tablets');
const matches = matchMedicineText(scanned, catalogue);
assert.equal(matches[0]?.medicine.id, 'a');
assert.equal(matches[0]?.status, 'verified');
assert.equal(matches[0]?.safeToAutoSelect, false, 'text-only recognition must still require pharmacist confirmation');

const mismatchStrength = matchMedicineText(parseMedicineText('Augmentin 625 mg tablets'), catalogue);
assert.ok(mismatchStrength.some((item) => item.medicine.id === 'b' && item.status === 'rejected' && item.conflicts.length > 0), 'wrong strength must remain visible as an explicit rejected conflict');

const mismatchForm = matchMedicineText(parseMedicineText('Augmentin 625 mg syrup'), catalogue);
assert.ok(mismatchForm.some((item) => item.medicine.id === 'a' && item.status === 'rejected' && item.conflicts.length > 0), 'wrong dosage form must remain visible as an explicit rejected conflict');

const mismatchRelease = matchMedicineText(parseMedicineText('Metformin 500 mg XR tablets'), catalogue);
assert.ok(mismatchRelease.some((item) => item.medicine.id === 'd' && item.status === 'rejected' && item.conflicts.length > 0), 'XR/SR mismatch must remain visible as an explicit rejected conflict');

const exactBarcode = matchMedicineText(parseMedicineText('unreadable'), catalogue, '222');
assert.equal(exactBarcode.length, 1);
assert.equal(exactBarcode[0].medicine.id, 'b');
assert.equal(exactBarcode[0].status, 'candidate', 'barcode-only match without OCR attributes must remain a candidate');
assert.equal(exactBarcode[0].safeToAutoSelect, false, 'barcode matching never replaces pharmacist approval');

const contradictoryBarcode = matchMedicineText(
  parseMedicineText('Augmentin 625 mg tablets'),
  catalogue,
  '222'
);
assert.equal(contradictoryBarcode.length, 1);
assert.equal(contradictoryBarcode[0].medicine.id, 'b');
assert.equal(contradictoryBarcode[0].status, 'rejected');
assert.equal(contradictoryBarcode[0].safeToAutoSelect, false,
  'an exact barcode must not override contradictory strength OCR');

const ambiguousBarcode = matchMedicineText(parseMedicineText('unreadable'), [
  ...catalogue,
  { id: 'e', name: 'Other item', barcode: '222' }
], '222');
assert.equal(ambiguousBarcode[0].status, 'rejected');
assert.equal(ambiguousBarcode[0].safeToAutoSelect, false);

const realWorldCatalogue: MedicineCatalogueEntry[] = [
  { id: 'amaryl-4', name: 'Amaryl 4mg', barcode: '6223003991852' },
  { id: 'lasix-40', name: 'Lasix 40mg', barcode: '6223003990824' },
  { id: 'vit-d3', name: 'Vitamin D3 50,000 IU', barcode: '6285007' }
];

const amarylBoxMatches = matchMedicineText(
  parseMedicineText('Amaryl\nGlimepiride\nOral antidiabetic\n30 Tablets\n4 mg\nsanofi'),
  realWorldCatalogue
);
assert.equal(amarylBoxMatches[0]?.medicine.id, 'amaryl-4');
assert.equal(amarylBoxMatches[0]?.status, 'candidate');
assert.equal(amarylBoxMatches[0]?.safeToAutoSelect, false);

const vitDMatches = matchMedicineText(
  parseMedicineText('Vitamin D3 50000 IU Cholecalciferol 20 Capsules'),
  realWorldCatalogue
);
assert.equal(vitDMatches[0]?.medicine.id, 'vit-d3');
assert.equal(vitDMatches[0]?.safeToAutoSelect, false);

console.log('Phase 3 medicine text parser: all tests passed.');
