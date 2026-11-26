/**
 * Phase 2-A.5 Financial Integrity Regression Suite.
 * Covers exact fractional costs, safe numeric bounds, conversion validation,
 * manual override authorization, divisibility, and profit invariants.
 */

import {
  calculateUnitPrice,
  computeFinalPriceBigInt,
  normalizeDivisor,
  normalizeProfitPercentage,
  normalizeCost,
  validateConversionUnits,
  VALID_DIVISORS,
  getCashRoundingStep,
  roundToCashFriendly,
  calculateMedicinePricing
} from '../src/services/smartPricingService.ts';

let passed = 0;
let total = 0;

function assert(condition: boolean, message: string): void {
  total++;
  if (!condition) {
    console.error(`✗ [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passed++;
  console.log(`✓ [PASS] ${message}`);
}

function expectThrow(fn: () => unknown, message: string): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, message);
}

function approx(actual: number, expected: number, epsilon = 1e-9): boolean {
  return Math.abs(actual - expected) <= epsilon;
}

async function runPricingTestSuite(): Promise<void> {
  console.log('=== PHASE 2-A.5: FINANCIAL INTEGRITY TESTS ===');

  // 1. Required numerical examples.
  const examples = [
    [20500, 0, 3, 20502],
    [20501, 0, 2, 20502],
    [20501, 0, 5, 20505],
    [10000, 20, 100, 12000],
    [4320, 15, 25, 4975],
    [1750, 25, 10, 2190]
  ] as const;
  for (const [cost, profit, divisor, expected] of examples) {
    const result = calculateUnitPrice(cost, 'pack', 2, 10, profit, divisor);
    assert(result.finalSellingPrice === expected, `Reference example ${expected} is preserved`);
    assert(result.finalSellingPrice % divisor === 0, `Reference example ${expected} respects divisor ${divisor}`);
    assert(result.actualProfitAmount >= 0, `Reference example ${expected} does not create a loss`);
  }

  // 2. All supported divisors and invariants.
  for (const divisor of VALID_DIVISORS) {
    const result = calculateUnitPrice(15430, 'pack', 2, 10, 18.5, divisor);
    assert(result.finalSellingPrice % divisor === 0, `Divisor ${divisor}: exact divisibility`);
    assert(result.finalSellingPrice >= result.calculatedPriceBeforeRounding, `Divisor ${divisor}: upward ceiling`);
    assert(result.realizedProfitPercentage + 1e-9 >= 18.5, `Divisor ${divisor}: requested margin protected`);
  }

  // 3. Pack / strip / pill calculations.
  const pack = calculateUnitPrice(12000, 'pack', 3, 10, 20, 10);
  const strip = calculateUnitPrice(12000, 'strip', 3, 10, 25, 3);
  const pill = calculateUnitPrice(12000, 'pill', 3, 10, 30, 5);
  assert(pack.unit === 'pack', 'Pack unit preserved');
  assert(pack.exactUnitCost === 12000, 'Pack exact unit cost');
  assert(strip.unit === 'strip', 'Strip unit preserved');
  assert(approx(strip.exactUnitCost, 4000), 'Strip exact unit cost');
  assert(approx(strip.purchaseCost, 4000), 'Strip purchase cost');
  assert(pill.unit === 'pill', 'Pill unit preserved');
  assert(approx(pill.exactUnitCost, 400), 'Pill exact unit cost');
  assert(approx(pill.purchaseCost, 400), 'Pill purchase cost');
  assert(pill.finalSellingPrice % 5 === 0, 'Pill selling price respects divisor');

  // 4. Exact fractional cost is not rounded to cents before calculation.
  const fractional = calculateUnitPrice(1000 / 3, 'pack', 2, 10, 0, 1);
  assert(approx(fractional.exactUnitCost, 1000 / 3), 'Repeating decimal cost retained');
  assert(fractional.finalSellingPrice === 334, 'Fractional cost rounds upward to whole currency');
  assert(approx(fractional.actualProfitAmount, 334 - 1000 / 3), 'Actual profit uses exact fractional cost');
  const highPrecision = calculateUnitPrice(1.234567, 'pack', 2, 10, 0, 1);
  assert(approx(highPrecision.exactUnitCost, 1.234567), 'More-than-two-decimal cost retained');
  assert(highPrecision.finalSellingPrice === 2, 'High-precision cost rounds upward');
  assert(approx(highPrecision.actualProfitAmount, 2 - 1.234567), 'High-precision profit remains accurate');

  // 5. Input validation.
  expectThrow(() => normalizeCost(-1), 'Negative cost rejected');
  expectThrow(() => normalizeCost(NaN), 'NaN cost rejected');
  expectThrow(() => normalizeCost(Infinity), 'Infinite cost rejected');
  expectThrow(() => normalizeProfitPercentage(-1), 'Negative profit rejected');
  expectThrow(() => normalizeProfitPercentage(NaN), 'NaN profit rejected');
  expectThrow(() => normalizeProfitPercentage(Infinity), 'Infinite profit rejected');
  assert(normalizeDivisor(0) === 1, 'Zero divisor falls back to 1');
  assert(normalizeDivisor('abc') === 1, 'Invalid divisor falls back to 1');
  assert(normalizeDivisor(Infinity) === 1, 'Infinite divisor falls back to 1');
  assert(normalizeDivisor(3.4) === 3, 'Finite decimal divisor is normalized to integer');
  expectThrow(() => validateConversionUnits(0, 10), 'Zero strips rejected');
  expectThrow(() => validateConversionUnits(2, 0), 'Zero pills rejected');
  expectThrow(() => validateConversionUnits(-2, 10), 'Negative strips rejected');
  expectThrow(() => validateConversionUnits(2, -10), 'Negative pills rejected');
  expectThrow(() => validateConversionUnits(2.5, 10), 'Fractional strips rejected rather than rounded');
  expectThrow(() => validateConversionUnits(2, 10.5), 'Fractional pills rejected rather than rounded');
  expectThrow(() => validateConversionUnits(NaN, 10), 'NaN conversion rejected');
  expectThrow(() => validateConversionUnits(2, Infinity), 'Infinite conversion rejected');
  expectThrow(() => validateConversionUnits(Number.MAX_SAFE_INTEGER + 1, 10), 'Unsafe conversion count rejected');

  // 6. Manual override: valid, invalid, below-cost and zero-cost cases.
  const validOverride = calculateUnitPrice(10000, 'pack', 2, 10, 20, 10, 13500);
  assert(validOverride.finalSellingPrice === 13500, 'Manual override above cost applied');
  assert(validOverride.isOverridden, 'Manual override flag set');
  assert(typeof validOverride.overrideTimestamp === 'string', 'Override timestamp generated');
  assert(validOverride.calculatedPriceBeforeRounding === 12000, 'Pre-rounding calculated price retained');
  assert(validOverride.actualProfitAmount === 3500, 'Manual override profit is calculated from actual price');
  expectThrow(() => calculateUnitPrice(10000, 'pack', 2, 10, 20, 10, 9000), 'Below-cost manual price rejected without approval');
  expectThrow(() => calculateUnitPrice(10000, 'pack', 2, 10, 20, 10, NaN), 'NaN manual price rejected');
  expectThrow(() => calculateUnitPrice(10000, 'pack', 2, 10, 20, 10, Infinity), 'Infinite manual price rejected');
  expectThrow(() => calculateUnitPrice(10000, 'pack', 2, 10, 20, 10, -1), 'Negative manual price rejected');
  expectThrow(() => calculateUnitPrice(10000, 'pack', 2, 10, 20, 10, Number.MAX_SAFE_INTEGER + 1), 'Unsafe manual price rejected');
  expectThrow(
    () => calculateUnitPrice(10000, 'pack', 2, 10, 20, 10, 9000, { approved: true, approvedBy: '', reason: 'clearance' }),
    'Below-cost override rejects missing manager identity'
  );
  expectThrow(
    () => calculateUnitPrice(10000, 'pack', 2, 10, 20, 10, 9000, { approved: true, approvedBy: 'Manager', reason: '  ' }),
    'Below-cost override rejects missing reason'
  );
  const approvedLoss = calculateUnitPrice(
    10000, 'pack', 2, 10, 20, 10, 9000,
    { approved: true, approvedBy: 'Manager A', reason: 'Documented damaged stock clearance' }
  );
  assert(approvedLoss.finalSellingPrice === 9000, 'Explicitly authorized below-cost override applied');
  assert(approvedLoss.actualProfitAmount === -1000, 'Authorized loss is represented accurately');
  assert(approvedLoss.overrideApprovedBy === 'Manager A', 'Manager identity recorded in result');
  assert(approvedLoss.overrideReason === 'Documented damaged stock clearance', 'Override reason recorded in result');

  const zeroCost = calculateUnitPrice(0, 'pack', 2, 10, 20, 5);
  assert(zeroCost.finalSellingPrice === 0, 'Zero cost without override returns zero');
  assert(zeroCost.actualProfitAmount === 0, 'Zero cost profit remains zero');
  const zeroCostOverride = calculateUnitPrice(0, 'pack', 2, 10, 20, 5, 500);
  assert(zeroCostOverride.finalSellingPrice === 500, 'Zero-cost manual override is not skipped');
  assert(zeroCostOverride.isOverridden, 'Zero-cost override flag is set');

  // 7. BigInt and safe-number boundary protections.
  expectThrow(
    () => computeFinalPriceBigInt(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1n, 0, 1),
    'BigInt result beyond safe integer range rejected'
  );
  expectThrow(
    () => calculateUnitPrice(Number.MAX_SAFE_INTEGER, 'pack', 1, 1, 100, 100),
    'Final price overflow is rejected before unsafe Number conversion'
  );
  const safeLarge = calculateUnitPrice(9_999_999, 'pack', 2, 10, 25, 50);
  assert(safeLarge.finalSellingPrice > 0, 'Large safe price calculated');
  assert(safeLarge.finalSellingPrice % 50 === 0, 'Large safe price remains divisible');

  // 8. Unit and accounting invariants.
  expectThrow(() => calculateUnitPrice(1000, 'carton' as any), 'Unknown sellable unit rejected');
  const accounting = calculateUnitPrice(1000, 'strip', 3, 10, 20, 1);
  assert(approx(accounting.actualProfitAmount, accounting.finalSellingPrice - accounting.exactUnitCost), 'Profit amount equals sale price minus exact unit cost');
  assert(approx(accounting.realizedProfitPercentage, accounting.actualProfitAmount / accounting.exactUnitCost * 100), 'Realized margin matches exact accounting formula');
  assert(accounting.actualProfitAmount >= 0, 'Default engine does not produce a loss');
  assert(accounting.finalSellingPrice >= accounting.exactUnitCost, 'Default selling price covers exact cost');

  // ========================================================
  // 9. PHASE 2-A.6: CASH-FRIENDLY ROUNDING TESTS
  // ========================================================
  console.log('\n--- PHASE 2-A.6: CASH-FRIENDLY ROUNDING TESTS ---');

  // 9.1 Step selection per price tier
  assert(getCashRoundingStep(50) === 1, 'Tier < 100 SDG uses step 1');
  assert(getCashRoundingStep(99) === 1, 'Tier boundary 99 SDG uses step 1');
  assert(getCashRoundingStep(100) === 5, 'Tier boundary 100 SDG uses step 5');
  assert(getCashRoundingStep(350) === 5, 'Tier [100, 500) uses step 5');
  assert(getCashRoundingStep(499) === 5, 'Tier boundary 499 SDG uses step 5');
  assert(getCashRoundingStep(500) === 10, 'Tier boundary 500 SDG uses step 10');
  assert(getCashRoundingStep(750) === 10, 'Tier [500, 1000) uses step 10');
  assert(getCashRoundingStep(999) === 10, 'Tier boundary 999 SDG uses step 10');
  assert(getCashRoundingStep(1000) === 100, 'Tier boundary 1000 SDG uses step 100');
  assert(getCashRoundingStep(2500) === 100, 'Tier [1000, 5000) uses step 100');
  assert(getCashRoundingStep(4999) === 100, 'Tier boundary 4999 SDG uses step 100');
  assert(getCashRoundingStep(5000) === 1000, 'Tier 5,000–9,999 SDG uses step 1,000');
  assert(getCashRoundingStep(9999) === 1000, 'Tier boundary 9,999 SDG uses step 1,000');
  assert(getCashRoundingStep(10000) === 1, 'Tier 10,000 SDG and above disables cash rounding');
  assert(getCashRoundingStep(14000, 5) === 1, 'High-value tier ignores cash divisor and preserves integer price');

  // 9.2 Mandatory prompt examples for cash-friendly rounding
  assert(roundToCashFriendly(1950) === 2000, 'Mandatory example 1950 -> 2000 (step 100)');
  assert(roundToCashFriendly(337) === 340, 'Mandatory example 337 -> 340 (step 5)');
  assert(roundToCashFriendly(332) === 335, 'Mandatory example 332 -> 335 (step 5)');
  assert(roundToCashFriendly(101) === 105, 'Mandatory example 101 -> 105 (step 5)');
  assert(roundToCashFriendly(500) === 500, 'Mandatory example 500 -> 500 (step 10, exact multiple remains exact)');
  assert(roundToCashFriendly(501) === 510, 'Mandatory example 501 -> 510 (step 10)');
  assert(roundToCashFriendly(999) === 1000, 'Mandatory example 999 -> 1000 (step 10)');
  assert(roundToCashFriendly(1001) === 1100, 'Mandatory example 1001 -> 1100 (step 100)');
  assert(roundToCashFriendly(5500) === 6000, 'Approved example 5,500 -> 6,000 below 10,000');
  assert(roundToCashFriendly(8500) === 9000, 'Approved high sub-threshold example 8,500 -> 9,000');
  assert(roundToCashFriendly(9999) === 10000, 'Approved sub-threshold 9,999 -> 10,000');
  assert(roundToCashFriendly(10000) === 10000, 'Approved threshold 10,000 remains unchanged');
  assert(roundToCashFriendly(25000) === 25000, 'Approved high-value 25,000 remains unchanged');
  assert(roundToCashFriendly(55000) === 55000, 'Approved high-value example 55,000 remains unchanged');

  // 9.3 Targeted 3900 correction & 4000 preservation (Phase 2-A.6-R1)
  assert(roundToCashFriendly(3500) === 4000, 'Approved example: 3500 SDG rounds upward to 4000 SDG');
  assert(roundToCashFriendly(3900) === 4000, 'Targeted correction: 3900 SDG rounds upward to 4000 SDG');
  assert(roundToCashFriendly(4000) === 4000, 'Targeted rule: 4000 SDG remains 4000 SDG (no jump to 4100)');
  assert(roundToCashFriendly(4001) === 4100, 'Raw 4001 under step 100 rounds upward to 4100');
  assert(roundToCashFriendly(3901) === 4000, 'Raw 3901 under step 100 rounds upward to 4000');
  assert(roundToCashFriendly(3950) === 4000, 'Raw 3950 under step 100 rounds upward to 4000');
  assert(roundToCashFriendly(3999) === 4000, 'Raw 3999 under step 100 rounds upward to 4000');

  // 9.4 Boundary values for all tiers
  assert(roundToCashFriendly(0) === 0, 'Zero raw price returns 0');
  assert(roundToCashFriendly(99) === 99, 'Boundary 99 stays 99');
  assert(roundToCashFriendly(99.1) === 100, 'Fractional 99.1 rounds upward to 100');
  assert(roundToCashFriendly(100) === 100, 'Boundary 100 stays 100');
  assert(roundToCashFriendly(499) === 500, 'Boundary 499 rounds upward to 500');
  assert(roundToCashFriendly(500) === 500, 'Boundary 500 stays 500');
  assert(roundToCashFriendly(1000) === 1000, 'Boundary 1000 stays 1000');
  assert(roundToCashFriendly(4999) === 5000, 'Boundary 4999 rounds upward to 5000');
  assert(roundToCashFriendly(5000, 100) === 5000, 'Boundary 5000 stays 5000 with step 100');
  assert(roundToCashFriendly(5001, 100) === 6000, 'Boundary 5001 rounds to 6000 with approved step 1,000');

  // 9.5 Medicine Pricing Engine (Pack, Strip, Pill) with cash-friendly rounding
  const medA = calculateMedicinePricing(3000, 2, 10, 30);
  if (!medA) throw new Error('Expected medA pricing result');
  assert(Number.isInteger(medA.pack.finalSellingPrice), 'Pack price is whole integer (no decimals)');
  assert(Number.isInteger(medA.strip.finalSellingPrice), 'Strip price is whole integer (no decimals)');
  assert(Number.isInteger(medA.pill.finalSellingPrice), 'Pill price is whole integer (no decimals)');
  assert(medA.pack.finalSellingPrice === 4000, 'MedA Pack price: 3000 cost * 1.3 = 3900 -> corrected to 4000 (Phase 2-A.6-R1)');
  assert(medA.strip.finalSellingPrice === 2000, 'MedA Strip price: 1500 cost * 1.3 = 1950 -> rounded to 2000 (step 100)');
  assert(medA.pill.finalSellingPrice === 200, 'MedA Pill price is derived as 2000 / 10 to preserve exact divisibility');
  assert(medA.pill.finalSellingPrice * 10 === medA.strip.finalSellingPrice, 'MedA pill × 10 equals strip exactly');
  assert(medA.strip.finalSellingPrice * 2 === medA.pack.finalSellingPrice, 'MedA strip × 2 equals pack exactly');
  assert(medA.pack.realizedProfitPercentage >= 30, 'MedA Pack profit % (33.33%) covers requested 30%');
  assert(medA.pack.roundingDivisor === 100, 'MedA Pack divisor recorded as 100');
  assert(medA.strip.roundingDivisor === 100, 'MedA Strip divisor recorded as 100');
  assert(medA.pill.roundingDivisor === 5, 'MedA Pill divisor recorded as 5');

  // Verify that an exact 4000 price does not jump
  const unit4000 = calculateUnitPrice(4000, 'pack', 2, 10, 0, 'cash-friendly');
  assert(unit4000.finalSellingPrice === 4000, 'Price 4000 SDG remains 4000 SDG without jumping to 4100');

  // 9.6 Fractional-cost medicine (1000 cost / 3 strips / 10 pills, 25% margin)
  const medB = calculateMedicinePricing(1000, 3, 10, 25);
  if (!medB) throw new Error('Expected medB pricing result');
  // Strip is the pricing anchor; pack must be exactly 3 × 420 = 1260.
  assert(medB.pack.finalSellingPrice === 1260, 'MedB Pack price is derived exactly from 3 strips');
  // Strip: (1000/3) * 1.25 = 416.666... -> step 5 -> 420
  assert(medB.strip.finalSellingPrice === 420, 'MedB Strip price rounded to 420 (step 5)');
  // Pill: (1000/30) * 1.25 = 41.666... -> step 1 -> 42
  assert(medB.pill.finalSellingPrice === 42, 'MedB Pill price rounded to 42 (step 1)');


  assert(medB.pill.finalSellingPrice * 10 === medB.strip.finalSellingPrice, 'MedB pill × pills per strip equals strip exactly');
  assert(medB.strip.finalSellingPrice * 3 === medB.pack.finalSellingPrice, 'MedB strip × strips per pack equals pack exactly');
  const threeStripExample = calculateMedicinePricing(8076.92307692, 3, 10, 30, 100); // exact decimal within PR-2C 8-place bound
  if (!threeStripExample) throw new Error('Expected three-strip example pricing');
  assert(threeStripExample.strip.finalSellingPrice === 4000, 'Approved 3500 SDG strip example rounds upward to 4000 SDG');
  assert(threeStripExample.pack.finalSellingPrice === 12000, 'Three-strip example pack price is 12000 SDG');
  assert(threeStripExample.strip.finalSellingPrice % 10 === 0, 'Three-strip example strip price is divisible by 10 pills');
  assert(threeStripExample.pill.finalSellingPrice * 10 === threeStripExample.strip.finalSellingPrice, 'Three-strip example pill/strip exact relation');
  assert(threeStripExample.strip.finalSellingPrice * 3 === threeStripExample.pack.finalSellingPrice, 'Three-strip example strip/pack exact relation');
  const special3900AllForms = calculateMedicinePricing(3900 * 2, 2, 10, 0);
  if (!special3900AllForms) throw new Error('Expected special 3900 pricing');
  assert(special3900AllForms.strip.finalSellingPrice === 4000, 'PR-2E ALL dosage forms: 3,900 SDG strip price becomes 4,000');
  assert(special3900AllForms.pack.finalSellingPrice === 8000, 'PR-2E DIRECT_PACK PARITY: pack price equals strip × strips-per-pack');
  assert(special3900AllForms.pack.finalSellingPrice === special3900AllForms.strip.finalSellingPrice * 2, 'PR-2E DIRECT_PACK has no discount');
  assert(Number.isSafeInteger(special3900AllForms.pill.finalSellingPrice), 'PR-2E HALF_UP_INT_SDG produces whole-SDG unit prices');
  const highValueExample = calculateMedicinePricing(100000, 3, 10, 5, 100);
  if (!highValueExample) throw new Error('Expected high-value three-strip pricing');
  assert(highValueExample.strip.finalSellingPrice === 35000, '35000 SDG strip price remains unchanged');
  assert(highValueExample.pack.finalSellingPrice === 105000, '35000 × 3 produces 105000 SDG pack price');
  assert(highValueExample.pill.finalSellingPrice === 3500, '35000 / 10 produces 3500 SDG pill price');
  const lowThresholdPack = calculateMedicinePricing(12692.30769230, 3, 10, 30, 100);
  if (!lowThresholdPack) throw new Error('Expected low-threshold three-strip pricing');
  assert(lowThresholdPack.strip.finalSellingPrice === 6000, '5,500 SDG strip price rounds upward to 6,000 below threshold');
  assert(lowThresholdPack.pack.finalSellingPrice === 18000, 'Low-threshold pack price follows rounded strip × 3');
  const highThresholdPack = calculateMedicinePricing(126923.07692307, 3, 10, 30, 100);
  if (!highThresholdPack) throw new Error('Expected high-threshold three-strip pricing');
  assert(highThresholdPack.strip.finalSellingPrice === 55000, '55,000 SDG strip price remains unchanged at/above threshold');
  assert(highThresholdPack.pack.finalSellingPrice === 165000, 'High-threshold pack price remains 165,000');

  const oddPillCount = calculateMedicinePricing(10000, 3, 6, 20, 100);
  if (!oddPillCount) throw new Error('Expected six-pill conversion pricing');
  assert(Number.isSafeInteger(oddPillCount.pill.finalSellingPrice), 'Six-pill case produces whole-currency pill price');
  assert(oddPillCount.pill.finalSellingPrice * 6 === oddPillCount.strip.finalSellingPrice, 'Six-pill case maintains exact divisibility');
  assert(oddPillCount.strip.finalSellingPrice * 3 === oddPillCount.pack.finalSellingPrice, 'Six-pill case maintains exact pack price');

  // 9.7 Exact cost preservation invariant
  assert(approx(medB.strip.exactUnitCost, 1000 / 3), 'Strip exact unit cost preserved with full fractional precision');
  assert(approx(medB.pill.exactUnitCost, 1000 / 30), 'Pill exact unit cost preserved with full fractional precision');

  // 9.8 Profit margin non-degradation invariant
  assert(medB.pack.realizedProfitPercentage >= 25, 'Pack realized profit % covers requested 25%');
  assert(medB.strip.realizedProfitPercentage >= 25, 'Strip realized profit % covers requested 25%');
  assert(medB.pill.realizedProfitPercentage >= 25, 'Pill realized profit % covers requested 25%');

  // 9.9 No decimal points in formatted selling price outputs
  assert(!String(medB.pack.finalSellingPrice).includes('.'), 'Pack final price has no decimal dot');
  assert(!String(medB.strip.finalSellingPrice).includes('.'), 'Strip final price has no decimal dot');
  assert(!String(medB.pill.finalSellingPrice).includes('.'), 'Pill final price has no decimal dot');

  console.log(`\nSUMMARY: ${passed}/${total} assertions passed (${Math.round(passed / total * 100)}%)`);
  if (passed !== total) throw new Error('Pricing test suite failed');
}

runPricingTestSuite().catch((error) => {
  console.error('Pricing test suite failed:', error);
  throw error;
});
