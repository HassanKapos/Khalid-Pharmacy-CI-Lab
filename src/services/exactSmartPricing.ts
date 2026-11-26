/**
 * PR-2C exact Smart Pricing adapter.
 * Preserves the live strip-led pricing policy: the strip is rounded upward to a
 * multiple of both the approved cash step and pills-per-strip; pill and pack
 * prices are then derived by exact integer division/multiplication.
 */
import {
  createRational, divideRational, multiplyRational, subtractRational,
  isNegativeRational, type Rational,
} from './exactFinance.ts';
import { parseExactDecimal } from './exactInventoryCosting.ts';

export interface ExactMedicinePrice {
  readonly pill: bigint;
  readonly strip: bigint;
  readonly pack: bigint;
  readonly exactCostPerPill: Rational;
  readonly exactCostPerStrip: Rational;
  readonly exactCostPerPack: Rational;
  readonly targetStripPrice: Rational;
  readonly actualProfitPerPill: Rational;
}

export interface ExactDirectPackPrice {
  readonly baseUnit: bigint;
  readonly pack: bigint;
  readonly exactCostPerBaseUnit: Rational;
  readonly targetBaseUnitPrice: Rational;
  readonly actualProfitPerBaseUnit: Rational;
}

/**
 * PR-2E DIRECT_PACK policy for non-solid dosage forms.
 * Price the verified base unit first, apply the universal 3,500/3,900 threshold
 * to that unit price, then derive the pack strictly by parity (baseUnit × N).
 */
export function calculateExactDirectPackPrice(
  packPurchaseCost: string,
  baseUnitsPerPack: number,
  profitPercent: string,
  roundingStep?: number,
): ExactDirectPackPrice {
  const units = positiveSafeInteger(baseUnitsPerPack, 'baseUnitsPerPack');
  const step = roundingStep === undefined ? undefined : positiveSafeInteger(roundingStep, 'roundingStep');
  const packCost = parseExactDecimal(packPurchaseCost, 'packPurchaseCost');
  const profit = parseExactDecimal(profitPercent, 'profitPercent');
  if (isNegativeRational(packCost) || isNegativeRational(profit)) {
    throw new Error('Cost and profit percentage must be non-negative.');
  }
  const exactCostPerBaseUnit = divideRational(packCost, createRational(units));
  const multiplier = createRational(
    100n * BigInt(profit.den) + BigInt(profit.num),
    100n * BigInt(profit.den),
  );
  const targetBaseUnitPrice = multiplyRational(exactCostPerBaseUnit, multiplier);
  const selectedStep = step ?? getExactCashRoundingStep(targetBaseUnitPrice);
  const cashRounded = ceilRationalToStep(targetBaseUnitPrice, selectedStep);
  const approvedBaseUnitPrice = cashRounded === 3500n || cashRounded === 3900n
    ? 4000n
    : cashRounded;
  const baseUnitPrice = ceilRationalToStep(createRational(approvedBaseUnitPrice), 1n);
  const packPrice = baseUnitPrice * units;
  const actualProfitPerBaseUnit = subtractRational(createRational(baseUnitPrice), exactCostPerBaseUnit);
  return Object.freeze({
    baseUnit: baseUnitPrice,
    pack: packPrice,
    exactCostPerBaseUnit,
    targetBaseUnitPrice,
    actualProfitPerBaseUnit,
  });
}

function positiveSafeInteger(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive safe integer.`);
  return BigInt(value);
}
function ceilPositive(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('Ceiling division requires non-negative numerator and positive denominator.');
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}
function ceilRationalToStep(value: Rational, step: bigint): bigint {
  if (isNegativeRational(value)) throw new Error('Target selling price cannot be negative.');
  return ceilPositive(BigInt(value.num), BigInt(value.den) * step) * step;
}
function getExactCashRoundingStep(rawStripPrice: Rational): bigint {
  const thresholds: readonly [bigint, bigint][] = [
    [100n, 1n], [500n, 5n], [1000n, 10n], [5000n, 100n], [10000n, 1000n],
  ];
  for (const [limit, step] of thresholds) {
    if (BigInt(rawStripPrice.num) < limit * BigInt(rawStripPrice.den)) return step;
  }
  return 1n;
}
function gcd(a: bigint, b: bigint): bigint {
  let x = a, y = b;
  while (y !== 0n) { const next = x % y; x = y; y = next; }
  return x;
}

/**
 * profitPercent is a markup on cost ("20" means 20%).
 * If roundingStep is omitted, apply live SDG cash tiers and the 3,500/3,900 -> 4,000 rule.
 * The effective strip increment is lcm(roundingStep, pillsPerStrip).
 */
export function calculateExactMedicinePrice(
  packPurchaseCost: string,
  stripsPerPack: number,
  pillsPerStrip: number,
  profitPercent: string,
  roundingStep?: number,
): ExactMedicinePrice {
  const strips = positiveSafeInteger(stripsPerPack, 'stripsPerPack');
  const pills = positiveSafeInteger(pillsPerStrip, 'pillsPerStrip');
  const step = roundingStep === undefined ? undefined : positiveSafeInteger(roundingStep, 'roundingStep');
  const packCost = parseExactDecimal(packPurchaseCost, 'packPurchaseCost');
  const profit = parseExactDecimal(profitPercent, 'profitPercent');
  if (isNegativeRational(packCost) || isNegativeRational(profit)) throw new Error('Cost and profit percentage must be non-negative.');
  const profitMultiplier = createRational(
    100n * BigInt(profit.den) + BigInt(profit.num),
    100n * BigInt(profit.den),
  );
  const exactCostPerStrip = divideRational(packCost, createRational(strips));
  const exactCostPerPill = divideRational(exactCostPerStrip, createRational(pills));
  const targetStripPrice = multiplyRational(exactCostPerStrip, profitMultiplier);
  const selectedStep = step ?? getExactCashRoundingStep(targetStripPrice);
  const initialCashRounded = ceilRationalToStep(targetStripPrice, selectedStep);
  const adjustedCashPrice = initialCashRounded === 3500n || initialCashRounded === 3900n
    ? 4000n
    : initialCashRounded;
  const increment = (selectedStep / gcd(selectedStep, pills)) * pills;
  const stripPrice = ceilRationalToStep(createRational(adjustedCashPrice), increment);
  const pillPrice = stripPrice / pills;
  const packPrice = stripPrice * strips;
  const actualProfitPerPill = subtractRational(createRational(pillPrice), exactCostPerPill);
  return Object.freeze({
    pill: pillPrice,
    strip: stripPrice,
    pack: packPrice,
    exactCostPerPill,
    exactCostPerStrip,
    exactCostPerPack: packCost,
    targetStripPrice,
    actualProfitPerPill,
  });
}
