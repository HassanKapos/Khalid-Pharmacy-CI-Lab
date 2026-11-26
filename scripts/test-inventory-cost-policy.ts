/** Phase 2-B regression tests: purchase-cost normalization and batch cost snapshots. */
import {
  allocateProportionalDiscount,
  calculateWeightedBatchCost,
  getBaseUnitsPerCostUnit,
  normalizeCostToBaseUnit,
  resolveIncomingCostPerBaseUnit,
  resolveMovementCostPerBaseUnit
} from '../src/services/inventoryCostPolicy.ts';

let passed = 0;
let total = 0;
function assert(condition: boolean, message: string): void {
  total++;
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed++;
  console.log(`✓ ${message}`);
}
function approx(actual: number, expected: number, epsilon = 1e-9): boolean {
  return Math.abs(actual - expected) <= epsilon;
}
function expectThrow(fn: () => unknown, message: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, message);
}

// 2 strips × 10 pills = 20 base units per pack.
assert(getBaseUnitsPerCostUnit('pack', 2, 10) === 20, 'Pack conversion resolves to 20 pills');
assert(getBaseUnitsPerCostUnit('strip', 2, 10) === 10, 'Strip conversion resolves to 10 pills');
assert(getBaseUnitsPerCostUnit('pill', 2, 10) === 1, 'Pill conversion resolves to one base unit');
assert(normalizeCostToBaseUnit(2000, 'pack', 2, 10) === 100, 'Pack purchase cost normalizes to pill cost');
assert(normalizeCostToBaseUnit(1000, 'strip', 2, 10) === 100, 'Strip purchase cost normalizes to pill cost');
assert(normalizeCostToBaseUnit(100, 'pill', 2, 10) === 100, 'Pill purchase cost remains unchanged');
expectThrow(() => normalizeCostToBaseUnit(-1, 'pack', 2, 10), 'Negative acquisition cost rejected');
expectThrow(() => normalizeCostToBaseUnit(100, 'pack', 0, 10), 'Invalid pack conversion rejected');

const oldPackPurchase = resolveIncomingCostPerBaseUnit({ type: 'PURCHASE', unit: 'pack', costPerUnit: 2400, baseUnitsDelta: 20 }, 2, 10, 3000);
assert(oldPackPurchase === 120, 'Legacy pack purchase cost is normalized');
const oldStripPurchase = resolveIncomingCostPerBaseUnit({ type: 'PURCHASE', unit: 'strip', costPerUnit: 1100, baseUnitsDelta: 10 }, 2, 10, 3000);
assert(oldStripPurchase === 110, 'Legacy strip purchase cost is normalized using invoice unit');
const oldPillPurchase = resolveIncomingCostPerBaseUnit({ type: 'PURCHASE', unit: 'pill', costPerUnit: 125, baseUnitsDelta: 1 }, 2, 10, 3000);
assert(oldPillPurchase === 125, 'Legacy pill purchase cost is preserved');
const oldInitial = resolveIncomingCostPerBaseUnit({ type: 'INITIAL', unit: 'pack', costPerUnit: 3000, baseUnitsDelta: 20 }, 2, 10, 3000);
assert(oldInitial === 150, 'Legacy initial stock pack cost is normalized');
assert(resolveIncomingCostPerBaseUnit({ type: 'SALE', unit: 'pill', costPerUnit: 3000, baseUnitsDelta: -1 }, 2, 10, 3000) === null, 'Sale movement never overwrites batch acquisition cost');
assert(resolveIncomingCostPerBaseUnit({ type: 'DAMAGE', unit: 'pack', costPerUnit: 3000, baseUnitsDelta: -20 }, 2, 10, 3000) === null, 'Damage movement never overwrites batch acquisition cost');
assert(resolveIncomingCostPerBaseUnit({ type: 'PURCHASE', unit: 'pill', costPerUnit: 125, costPerBaseUnit: 99, baseUnitsDelta: 1 }, 2, 10, 3000) === 99, 'Explicit immutable base-unit cost takes precedence');

const weighted = calculateWeightedBatchCost([
  { type: 'PURCHASE', unit: 'pack', costPerUnit: 2000, baseUnitsDelta: 20 },
  { type: 'PURCHASE', unit: 'strip', costPerUnit: 1200, baseUnitsDelta: 10 },
  { type: 'SALE', unit: 'pill', costPerUnit: 2000, baseUnitsDelta: -5 }
], 2, 10, 5000);
assert(approx(weighted.costPerBaseUnit, (20 * 100 + 10 * 120 - 5 * 100) / 25), 'Batch cost accounts for weighted receipts and costed stock outflows');
assert(!weighted.isEstimated, 'Known incoming and outgoing batch costs are marked verified');
const afterSellAndRestock = calculateWeightedBatchCost([
  { type: 'PURCHASE', unit: 'pack', costPerUnit: 2000, baseUnitsDelta: 20 },
  { type: 'SALE', unit: 'pack', costPerUnit: 2000, baseUnitsDelta: -20 },
  { type: 'PURCHASE', unit: 'pack', costPerUnit: 4000, baseUnitsDelta: 20 }
], 2, 10, 5000);
assert(afterSellAndRestock.costPerBaseUnit === 200, 'A fully sold batch restocked at a new cost uses the new remaining stock cost');
assert(resolveMovementCostPerBaseUnit({ type: 'SALE', unit: 'pill', costPerUnit: 2000, costPerBaseUnit: 77, baseUnitsDelta: -1 }, 2, 10, 5000) === 77, 'Sale outflow uses its immutable batch cost snapshot');
const estimated = calculateWeightedBatchCost([{ type: 'SALE', unit: 'pack', baseUnitsDelta: -2 }], 2, 10, 4000);
assert(estimated.costPerBaseUnit === 200, 'Legacy batch without movement cost uses current pack-cost fallback');
assert(estimated.isEstimated, 'Fallback batch cost is explicitly marked estimated');

const discountAllocation = allocateProportionalDiscount([1000, 3000, 0], 400);
assert(approx(discountAllocation.discount, 400), 'Invoice discount is capped to requested amount');
assert(approx(discountAllocation.discountShares[0], 100), 'Invoice discount is proportionally assigned to first line');
assert(approx(discountAllocation.discountShares[1], 300), 'Invoice discount is proportionally assigned to second line');
assert(discountAllocation.discountShares[2] === 0, 'Zero-cost line receives no proportional discount');
assert(approx(discountAllocation.netLineCosts.reduce((sum, value) => sum + value, 0), 3600), 'Net acquisition costs reconcile to invoice net amount');
const cappedDiscount = allocateProportionalDiscount([100, 200], 500);
assert(cappedDiscount.discount === 300 && cappedDiscount.netLineCosts.every(value => value === 0), 'Invoice discount cannot reduce acquisition cost below zero');
expectThrow(() => allocateProportionalDiscount([100, -1], 5), 'Negative invoice line cost rejected');
expectThrow(() => allocateProportionalDiscount([100], Number.NaN), 'Invalid invoice discount rejected');

console.log(`\nSUMMARY: ${passed}/${total} assertions passed`);
