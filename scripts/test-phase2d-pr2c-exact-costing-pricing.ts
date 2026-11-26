import assert from 'node:assert/strict';
import { createRational, compareRational } from '../src/services/exactFinance.ts';
import { allocateExactProportionalDiscount, calculateExactWeightedBatchCost, classifyLegacyCost } from '../src/services/exactInventoryCosting.ts';
import { calculateExactMedicinePrice } from '../src/services/exactSmartPricing.ts';

const weighted = calculateExactWeightedBatchCost([
  { baseUnitsDelta: '10', costPerBaseUnit: '1.25' },
  { baseUnitsDelta: '10', costPerBaseUnit: '2.75' },
]);
assert.equal(weighted.netBaseUnits, '20');
assert.deepEqual(weighted.costPerBaseUnit, createRational(2n));

const withIssue = calculateExactWeightedBatchCost([
  { baseUnitsDelta: '20', costPerBaseUnit: '2.50' },
  { baseUnitsDelta: '-5', costPerBaseUnit: '2.50' },
]);
assert.deepEqual(withIssue.costPerBaseUnit, createRational(5n, 2n));

const allocation = allocateExactProportionalDiscount(['100.00', '300.00', '0'], '40');
assert.deepEqual(allocation.discount, createRational(40n));
assert.deepEqual(allocation.shares[0], createRational(10n));
assert.deepEqual(allocation.shares[1], createRational(30n));
assert.deepEqual(allocation.netTotal, createRational(360n));
const zeroDiscount = allocateExactProportionalDiscount(['0', '0'], '0');
assert.deepEqual(zeroDiscount.netTotal, createRational(0n));
assert.throws(() => allocateExactProportionalDiscount(['0', '0'], '1'));
assert.throws(() => calculateExactWeightedBatchCost([{ baseUnitsDelta: '0', costPerBaseUnit: '2' }]));
assert.throws(() => calculateExactWeightedBatchCost([{ baseUnitsDelta: '2', costPerBaseUnit: '1.000000001' }]));
assert.throws(() => calculateExactWeightedBatchCost([
  { baseUnitsDelta: '10', costPerBaseUnit: '1' },
  { baseUnitsDelta: '-5', costPerBaseUnit: '3' },
]));
assert.throws(() => allocateExactProportionalDiscount(['-1'], '0'));
assert.throws(() => allocateExactProportionalDiscount(['10'], '11'));
assert.equal(classifyLegacyCost(1.25), 'APPROXIMATE_LEGACY');
assert.equal(classifyLegacyCost(Number.NaN), 'UNPROVABLE');

const price = calculateExactMedicinePrice('1000.00', 2, 10, '20', 1);
assert.equal(price.pill, 60n);
assert.equal(price.strip, 600n);
assert.equal(price.pack, 1200n);
assert.equal(price.strip, price.pill * 10n);
assert.equal(price.pack, price.strip * 2n);
assert.equal(compareRational(price.actualProfitPerPill, createRational(10n)), 0);
const rounded = calculateExactMedicinePrice('1000', 2, 10, '20', 5);
assert.equal(rounded.pill % 5n, 0n);
assert.equal(rounded.pack, rounded.strip * 2n);
assert.throws(() => calculateExactMedicinePrice('1000', 2, 10, '-1'));
assert.throws(() => calculateExactMedicinePrice('1000', 2, 10, '20', 0));

// Live SDG cash thresholds and the special strip-price rule are applied exactly.
const special3500 = calculateExactMedicinePrice('7000', 2, 10, '0');
assert.equal(special3500.strip, 4000n);
assert.equal(special3500.pill, 400n);
const special3900 = calculateExactMedicinePrice('7800', 2, 10, '0');
assert.equal(special3900.strip, 4000n);
const highPrice = calculateExactMedicinePrice('20000', 2, 10, '0');
assert.equal(highPrice.strip, 10000n); // >= 10,000: no cash rounding.
assert.equal(highPrice.pack, 20000n);
assert.throws(() => calculateExactMedicinePrice('1000', 2, 10, '20', Number.MAX_SAFE_INTEGER + 1));

console.log('PR-2C exact costing/pricing: all assertions passed.');
