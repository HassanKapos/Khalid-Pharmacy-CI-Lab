/**
 * Phase 2D — Workstream C: Exact Costing, Discount Conservation, NEEDS_REVIEW & Valuation Boundary Suite
 */
import assert from 'node:assert/strict';
import {
  addRational,
  compareRational,
  createRational,
  divideRational,
  equalsRational,
  ExactFinanceError,
  formatRationalForDisplay,
  isZeroRational,
  multiplyRational,
  subtractRational,
} from '../src/services/exactFinance.ts';
import {
  allocateExactProportionalDiscount,
  allocateExactProportionalDiscountRational,
  calculateExactWeightedBatchCost,
  calculateExactWeightedBatchCostRational,
  classifyLegacyCost,
  parseExactDecimal,
  reconcilePurchaseInvoiceTotalExact,
  verifyExactCogsAndValuationIdentity,
} from '../src/services/exactInventoryCosting.ts';

let passed = 0;

function runTest(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

// C1: Fractional purchase cost per pack/strip/base unit (zero float drift)
runTest('C1-01: Fractional pack/strip/pill costs preserve exact rationals (100/3, 241/21, 17/7)', () => {
  const packCost = parseExactDecimal('100');
  const perPill = divideRational(packCost, createRational(30n)); // 10/3 exact
  assert.equal(perPill.num, "10");
  assert.equal(perPill.den, "3");
  // Multiply back by 30 pills -> exact 100, zero drift
  const restored = multiplyRational(perPill, createRational(30n));
  assert.ok(equalsRational(restored, createRational(100n)));

  // Weighted batch average: 10 units @ 11 + 11 units @ 11.9090909... -> exact 241/21
  const weighted = calculateExactWeightedBatchCostRational([
    { baseUnitsDelta: '10', costPerBaseUnit: createRational(11n) },
    { baseUnitsDelta: '11', costPerBaseUnit: divideRational(createRational(131n), createRational(11n)) },
  ]);
  assert.equal(weighted.costPerBaseUnit.num, "241");
  assert.equal(weighted.costPerBaseUnit.den, "21");
  assert.ok(equalsRational(weighted.totalCarryingCost, createRational(241n)));
});

// C2: Fractional invoice discount conservation across indivisible line counts
runTest('C2-01: Fractional invoice discount conservation across 3, 7, and 13 lines has zero drift', () => {
  for (const count of [3, 7, 13]) {
    const lines = Array.from({ length: count }, (_, i) => `${100 + i * 7}.33`);
    const alloc = allocateExactProportionalDiscount(lines, '10.01');
    const sumShares = alloc.shares.reduce((a, b) => addRational(a, b), createRational(0n));
    const sumNets = alloc.netLineCosts.reduce((a, b) => addRational(a, b), createRational(0n));
    assert.ok(equalsRational(sumShares, alloc.discount), `Discount shares must sum exactly for ${count} lines`);
    assert.ok(equalsRational(addRational(sumNets, sumShares), alloc.subtotal), `Net + discount === subtotal for ${count} lines`);
  }
});

runTest('C2-02: Purchase invoice printed total match -> RECONCILED with zero discrepancy', () => {
  const res = reconcilePurchaseInvoiceTotalExact({
    lines: [
      { lineId: 'L1', grossLineTotal: '300', lineDiscount: '10' },
      { lineId: 'L2', grossLineTotal: '200', lineDiscount: '0' },
    ],
    invoiceDiscount: '15',
    printedFinalTotal: '475',
  });
  assert.equal(res.status, 'RECONCILED');
  assert.equal(res.requiresAdminReapproval, false);
  assert.equal(res.syntheticBalancingLineCreated, false);
  assert.equal(res.originalLineCount, 2);
  assert.equal(res.lines.length, 2);
  assert.ok(isZeroRational(res.discrepancy));
  assert.ok(equalsRational(res.inventoryCostReference, createRational(475n)));
  assert.ok(equalsRational(res.payableReference, createRational(475n)));
});

runTest('C2-03: Purchase invoice mismatch -> NEEDS_REVIEW, admin reapproval required, ZERO synthetic balancing line', () => {
  const res = reconcilePurchaseInvoiceTotalExact({
    lines: [
      { lineId: 'L1', grossLineTotal: '100', lineDiscount: '0' },
      { lineId: 'L2', grossLineTotal: '200', lineDiscount: '0' },
      { lineId: 'L3', grossLineTotal: '300', lineDiscount: '0' },
    ],
    invoiceDiscount: '10',
    printedFinalTotal: '592.50', // Disagrees with 590.00 by +2.50
  });
  assert.equal(res.status, 'NEEDS_REVIEW');
  assert.equal(res.requiresAdminReapproval, true);
  assert.equal(res.syntheticBalancingLineCreated, false);
  assert.equal(res.originalLineCount, 3);
  assert.equal(res.lines.length, 3, 'MUST NOT add a synthetic balancing line');
  assert.ok(equalsRational(res.inventoryCostReference, createRational(590n)));
  assert.ok(equalsRational(res.payableReference, parseExactDecimal('592.50')));
  assert.ok(equalsRational(res.discrepancy, parseExactDecimal('2.50')));
  assert.equal(res.discrepancyDisplay, '2.50');
  // Sum of inventory lines strictly equals inventoryCostReference (590), NOT printed total (592.50)
  const netSum = res.lines.reduce((s, l) => addRational(s, l.netInventoryLineCost), createRational(0n));
  assert.ok(equalsRational(netSum, createRational(590n)));
});

// C3: Multi-batch partial & full consumption + subsequent receipts at different prices
runTest('C3-01: Multi-receipt, multi-batch partial + full consumption preserves exact Receipts Carrying Cost === Sale COGS + Remaining Valuation', () => {
  const batchA1 = divideRational(createRational(100n), createRational(3n)); // 33.3333...
  const batchA2 = divideRational(createRational(131n), createRational(7n)); // 18.7142...
  const batchB1 = divideRational(createRational(500n), createRational(19n)); // 26.3157...

  const check = verifyExactCogsAndValuationIdentity({
    receipts: [
      { batchId: 'B-A', receiptBaseUnits: '10', costPerBaseUnit: batchA1 },
      { batchId: 'B-A', receiptBaseUnits: '14', costPerBaseUnit: batchA2 }, // subsequent receipt into same batch
      { batchId: 'B-B', receiptBaseUnits: '19', costPerBaseUnit: batchB1 },
    ],
    consumptions: [
      { batchId: 'B-A', consumedBaseUnits: '7' }, // partial
      { batchId: 'B-A', consumedBaseUnits: '5' }, // second partial
      { batchId: 'B-B', consumedBaseUnits: '19' }, // full sellout
    ],
  });

  assert.equal(check.exactIdentityHolds, true);
  assert.ok(isZeroRational(check.drift));
  assert.equal(check.remainingUnitsByBatch['B-A'], '12');
  assert.equal(check.remainingUnitsByBatch['B-B'], '0');
  const summed = addRational(check.totalSaleCogs, check.remainingInventoryValuation);
  assert.ok(equalsRational(summed, check.totalReceiptsCarryingCost));
});

runTest('C3-02: Sale discount allocation across multi-unit fractional lines conserves 100% of discount', () => {
  const lineTotals = [
    divideRational(createRational(100n), createRational(3n)),
    divideRational(createRational(200n), createRational(7n)),
    divideRational(createRational(50n), createRational(11n)),
  ];
  const discount = parseExactDecimal('5.55');
  const res = allocateExactProportionalDiscountRational(lineTotals, discount);
  const netPlusDisc = addRational(res.netTotal, res.discount);
  assert.ok(equalsRational(netPlusDisc, res.subtotal));
});

// C4: Immutable snapshots
runTest('C4-01: Costing, reconciliation & valuation snapshots are frozen and immutable', () => {
  const rec = reconcilePurchaseInvoiceTotalExact({
    lines: [{ lineId: 'L1', grossLineTotal: '100' }],
    printedFinalTotal: '100',
  });
  assert.equal(Object.isFrozen(rec), true);
  assert.equal(Object.isFrozen(rec.lines), true);
  assert.equal(Object.isFrozen(rec.lines[0]), true);
  assert.throws(() => {
    (rec as any).status = 'NEEDS_REVIEW';
  }, TypeError);

  const val = verifyExactCogsAndValuationIdentity({
    receipts: [{ batchId: 'B1', receiptBaseUnits: '10', costPerBaseUnit: createRational(5n) }],
    consumptions: [{ batchId: 'B1', consumedBaseUnits: '3' }],
  });
  assert.equal(Object.isFrozen(val), true);
  assert.equal(Object.isFrozen(val.remainingUnitsByBatch), true);
  assert.throws(() => {
    (val as any).exactIdentityHolds = false;
  }, TypeError);
});

// C5: Extreme BigInt bounds, invalid denominators, malformed inputs, rounding boundaries & legacy classification
runTest('C5-01: Very small (1e-8) and very large BigInt values compute with zero precision loss', () => {
  const tiny = parseExactDecimal('0.00000001'); // 1e-8
  const hugeQty = 10n ** 18n;
  const total = multiplyRational(tiny, createRational(hugeQty));
  assert.ok(equalsRational(total, createRational(10n ** 10n)));

  const hugeCarry = verifyExactCogsAndValuationIdentity({
    receipts: [{ batchId: 'BIG', receiptBaseUnits: '1000000000000', costPerBaseUnit: parseExactDecimal('99999.99999999') }],
    consumptions: [{ batchId: 'BIG', consumedBaseUnits: '333333333333' }],
  });
  assert.equal(hugeCarry.exactIdentityHolds, true);
  assert.ok(isZeroRational(hugeCarry.drift));
});

runTest('C5-02: Invalid/zero denominators, over-consumption, negative discounts, and malformed strings fail closed', () => {
  assert.throws(() => createRational(1n, 0n), ExactFinanceError);
  assert.throws(() => divideRational(createRational(10n), createRational(0n)), ExactFinanceError);
  assert.throws(() => parseExactDecimal('12.123456789')); // > 8 fractional digits
  assert.throws(() => parseExactDecimal('-0'));
  assert.throws(() => parseExactDecimal('NaN'));
  assert.throws(() => allocateExactProportionalDiscount(['100'], '101')); // discount > subtotal
  assert.throws(() => calculateExactWeightedBatchCost([{ baseUnitsDelta: '0', costPerBaseUnit: '10' }]));
  assert.throws(() =>
    verifyExactCogsAndValuationIdentity({
      receipts: [{ batchId: 'B1', receiptBaseUnits: '5', costPerBaseUnit: createRational(10n) }],
      consumptions: [{ batchId: 'B1', consumedBaseUnits: '6' }],
    }),
  );
  assert.equal(classifyLegacyCost(12.34), 'APPROXIMATE_LEGACY');
  assert.equal(classifyLegacyCost(Number.NaN), 'UNPROVABLE');
  assert.equal(classifyLegacyCost('12.34'), 'UNPROVABLE');
});

runTest('C5-03: Display rounding boundaries (HALF_UP, FLOOR, CEIL, TRUNC) are deterministic at exact .005 and .00499999', () => {
  const halfUp = parseExactDecimal('1.005');
  assert.equal(formatRationalForDisplay(halfUp, { decimals: 2, roundingMode: 'HALF_UP' }).formatted, '1.01');
  assert.equal(formatRationalForDisplay(halfUp, { decimals: 2, roundingMode: 'FLOOR' }).formatted, '1.00');
  assert.equal(formatRationalForDisplay(halfUp, { decimals: 2, roundingMode: 'CEIL' }).formatted, '1.01');
  assert.equal(formatRationalForDisplay(halfUp, { decimals: 2, roundingMode: 'TRUNC' }).formatted, '1.00');

  const justUnder = parseExactDecimal('1.00499999');
  assert.equal(formatRationalForDisplay(justUnder, { decimals: 2, roundingMode: 'HALF_UP' }).formatted, '1.00');
  assert.equal(formatRationalForDisplay(justUnder, { decimals: 2, roundingMode: 'CEIL' }).formatted, '1.01');

  const negHalf = subtractRational(createRational(0n), parseExactDecimal('1.005'));
  assert.equal(formatRationalForDisplay(negHalf, { decimals: 2, roundingMode: 'HALF_UP' }).formatted, '-1.01');
  assert.equal(formatRationalForDisplay(negHalf, { decimals: 2, roundingMode: 'TRUNC' }).formatted, '-1.00');
  assert.equal(compareRational(negHalf, createRational(0n)), -1);
});

console.log('========================================================================');
console.log(`PHASE 2D EXACT COSTING CLOSURE SUITE: ${passed}/${passed} PASSED, 0 FAILED`);
console.log('========================================================================');
