import {
  convertMedicineQuantityToBaseUnits,
  formatMedicineStockBreakdown,
  getMedicineBaseUnitsPerPack,
  getMedicineOperationalBlockReason,
  getMedicineUnitSellingPrice,
  isDirectPackMedicine,
  isMedicineUnitSellable,
  validateMedicineUnitConfiguration
} from '../src/services/medicineUnitPolicy.ts';

let passed = 0;
let total = 0;
function assert(condition: boolean, message: string): void {
  total++;
  if (!condition) throw new Error(`[FAIL] ${message}`);
  passed++;
  console.log(`[PASS] ${message}`);
}
function expectThrow(fn: () => unknown, message: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, message);
}

const valid = {
  sellPrice: 12000, sellPriceStrip: 4000, sellPricePill: 400,
  sellPack: true, sellStrip: true, sellPill: true,
  stripsPerPack: 3, pillsPerStrip: 10
};
validateMedicineUnitConfiguration(valid);
assert(true, 'Valid pill→strip→pack hierarchy accepted');
assert(getMedicineUnitSellingPrice(valid, 'pill') === 400, 'Pill price returned exactly');
assert(getMedicineUnitSellingPrice(valid, 'strip') === 4000, 'Strip price returned exactly');
assert(getMedicineUnitSellingPrice(valid, 'pack') === 12000, 'Pack price returned exactly');
assert(isMedicineUnitSellable(valid, 'pill'), 'Enabled pill sale is sellable');

expectThrow(() => validateMedicineUnitConfiguration({ ...valid, sellPricePill: 401 }), 'Mismatched pill price rejected');
expectThrow(() => validateMedicineUnitConfiguration({ ...valid, sellPrice: 12001 }), 'Mismatched pack price rejected');
expectThrow(() => validateMedicineUnitConfiguration({ ...valid, sellPriceStrip: 4000.5 }), 'Fractional strip price rejected');
expectThrow(() => validateMedicineUnitConfiguration({ ...valid, sellPricePill: 400.5 }), 'Fractional pill price rejected');
expectThrow(() => validateMedicineUnitConfiguration({ ...valid, sellPrice: Number.MAX_SAFE_INTEGER + 1 }), 'Unsafe pack price rejected');
expectThrow(() => validateMedicineUnitConfiguration({ ...valid, stripsPerPack: 3.5 }), 'Fractional strip count rejected');
expectThrow(() => validateMedicineUnitConfiguration({ ...valid, pillsPerStrip: 0 }), 'Zero pill count rejected');

const sixPills = {
  ...valid, sellPrice: 18000, sellPriceStrip: 6000, sellPricePill: 1000,
  stripsPerPack: 3, pillsPerStrip: 6
};
validateMedicineUnitConfiguration(sixPills);
assert(true, 'Six-pill conversion accepted when exactly divisible');
assert(!isMedicineUnitSellable({ ...valid, sellPill: false }, 'pill'), 'Disabled pill sale remains disabled');

const packOnly = { sellPrice: 5000, sellPack: true, sellStrip: false, sellPill: false };
validateMedicineUnitConfiguration(packOnly);
assert(true, 'Legacy pack-only medicine remains valid');
expectThrow(
  () => validateMedicineUnitConfiguration({
    ...packOnly, sellPriceStrip: 2500, sellPricePill: 250, stripsPerPack: 3, pillsPerStrip: 10
  }),
  'Complete proposed price ladder is validated even when partial sales are disabled'
);

const directPackMedicine = {
  sellPrice: 8000, sellPack: true, sellStrip: false, sellPill: false,
  stripsPerPack: 0, pillsPerStrip: 0, baseUnitsPerPack: 2,
  configStatus: 'VERIFIED', unitOperationalAllowed: true,
  unitDefinition: {
    configStatus: 'VERIFIED', baseUnitsPerPack: 2, baseUnit: 'vial',
    hierarchy: { kind: 'DIRECT_PACK', intermediateUnit: null, baseUnitsPerPack: 2 }
  }
};
validateMedicineUnitConfiguration(directPackMedicine);
assert(isDirectPackMedicine(directPackMedicine), 'DIRECT_PACK hierarchy is detected');
assert(getMedicineBaseUnitsPerPack(directPackMedicine) === 2, 'DIRECT_PACK base units are authoritative');
assert(convertMedicineQuantityToBaseUnits(3, 'pack', directPackMedicine) === 6, 'DIRECT_PACK pack quantity converts to base units');
assert(getMedicineUnitSellingPrice(directPackMedicine, 'pack') === 8000, 'DIRECT_PACK pack selling price is accepted');
assert(formatMedicineStockBreakdown(5, directPackMedicine) === '2 عبوة و 1 vial', 'DIRECT_PACK stock display uses base-unit remainder');
expectThrow(() => convertMedicineQuantityToBaseUnits(1, 'strip', directPackMedicine), 'DIRECT_PACK partial sale is blocked');
expectThrow(() => validateMedicineUnitConfiguration({ ...directPackMedicine, sellPill: true }), 'DIRECT_PACK pill sale flags are rejected');
expectThrow(() => getMedicineBaseUnitsPerPack({ ...directPackMedicine, baseUnitsPerPack: 3 }), 'DIRECT_PACK contradictory top-level conversion is rejected');

const verifiedOperationalMedicine = {
  unitOperationalAllowed: true,
  configStatus: 'VERIFIED',
  unitDefinition: { configStatus: 'VERIFIED' }
};
assert(getMedicineOperationalBlockReason(verifiedOperationalMedicine) === null, 'Explicitly VERIFIED medicine is operational');
assert(getMedicineOperationalBlockReason({ configStatus: 'LEGACY_ASSUMED', unitOperationalAllowed: false }) === 'MEDICINE_NOT_OPERATIONALLY_VERIFIED', 'Legacy assumed medicine is blocked');
assert(getMedicineOperationalBlockReason({ configStatus: 'QUARANTINED', unitOperationalAllowed: false }) === 'MEDICINE_NOT_OPERATIONALLY_VERIFIED', 'Quarantined medicine is blocked');
assert(getMedicineOperationalBlockReason({ unitOperationalAllowed: true, configStatus: 'VERIFIED' }) === 'MEDICINE_UNIT_DEFINITION_NOT_VERIFIED', 'Missing verified unit definition is blocked');
expectThrow(() => getMedicineUnitSellingPrice({ sellPrice: 100, sellPriceStrip: 50, sellPricePill: 5 }, 'strip'), 'Missing packing factors never default to 2×10');
expectThrow(() => validateMedicineUnitConfiguration({
  sellPrice: 100, sellPriceStrip: 50, sellPricePill: 5,
  sellPack: true, sellStrip: true, sellPill: true
}), 'Partial-unit configuration without explicit factors is rejected');

console.log(`SUMMARY: ${passed}/${total} assertions passed`);
if (passed !== total) throw new Error('Medicine unit policy tests failed');
