/**
 * Smart Pricing & Divisibility Rounding Engine (Phase 2-A.5)
 *
 * Financial-integrity rules:
 * - Decimal inputs are converted to exact BigInt fractions (no early cent rounding).
 * - Strip prices below 10,000 SDG use the approved upward cash-rounding tiers.
 * - Strip prices at or above 10,000 SDG are not cash-rounded; exact unit divisibility remains mandatory.
 * - Unsafe numeric conversions are rejected.
 * - Manual prices below exact unit cost require explicit manager authorization.
 */

import { calculateExactDirectPackPrice, calculateExactMedicinePrice } from './exactSmartPricing.ts';

export type SellableUnit = 'pack' | 'strip' | 'pill';
export type RoundingDivisor = 1 | 2 | 3 | 4 | 5 | 10 | 25 | 50 | 100 | 'cash-friendly' | number;

export interface ManualOverrideAuthorization {
  approved: true;
  approvedBy: string;
  reason: string;
}

/**
 * Phase 2-A.6 Cash-Friendly Rounding Step Selection:
 * - rawPrice < 100 SDG: step = 1
 * - 100 to < 500 SDG: step = 5
 * - 500 to < 1000 SDG: step = 10
 * - 1000 to < 5000 SDG: step = 100
 * - 5000 to < 10000 SDG: step = 1000
 * - 10000 SDG or more: no cash rounding (step = 1); unit divisibility remains mandatory
 */
export function getCashRoundingStep(rawPrice: number, fallbackDivisor: number = 100): number {
  const p = Number(rawPrice);
  if (!Number.isFinite(p) || p <= 0) return 1;
  if (p < 100) return 1;
  if (p < 500) return 5;
  if (p < 1000) return 10;
  if (p < 5000) return 100;
  // Approved SDG policy: 5,000–9,999 rounds upward by 1,000;
  // 10,000 and above is not cash-rounded (exact unit divisibility still applies).
  if (p < 10000) return 1000;
  return 1;
}

/**
 * Rounds a raw selling price upward to the cash-friendly currency step:
 * roundedPrice = Math.ceil(rawPrice / step) * step
 *
 * Targeted rule (Phase 2-A.6-R1):
 * - Price 3900 SDG rounds upward to 4000 SDG (approved retail threshold).
 * - Price 4000 SDG remains 4000 SDG (no upward elevation to 4100).
 */
export function roundToCashFriendly(rawPrice: number, fallbackDivisor: number = 100): number {
  const p = Number(rawPrice);
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (p === 3500 || p === 3900) {
    return 4000;
  }
  const step = getCashRoundingStep(p, fallbackDivisor);
  return Math.ceil(p / step) * step;
}

export interface PricingResult {
  unit: SellableUnit;
  purchaseCost: number;
  exactUnitCost: number;
  profitPercentage: number;
  calculatedPriceBeforeRounding: number;
  roundingDivisor: number;
  finalSellingPrice: number;
  actualProfitAmount: number;
  realizedProfitPercentage: number;
  isOverridden: boolean;
  overrideTimestamp?: string;
  overrideApprovedBy?: string;
  overrideReason?: string;
}

type Fraction = { numerator: bigint; denominator: bigint };

export const VALID_DIVISORS = [1, 2, 3, 4, 5, 10, 25, 50, 100] as const;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** Convert a finite JS number to an exact fraction matching its decimal string. */
function decimalFraction(value: number, fieldName: string): Fraction {
  if (!Number.isFinite(value)) {
    throw new Error(`${fieldName} يجب أن تكون قيمة رقمية محدودة وصالحة`);
  }

  const raw = value.toString().toLowerCase();
  const [coefficient, exponentText] = raw.split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const sign = coefficient.startsWith('-') ? -1n : 1n;
  const unsigned = coefficient.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = `${whole || '0'}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  let numerator = sign * BigInt(digits);
  const scale = fraction.length - exponent;

  if (scale <= 0) {
    numerator *= 10n ** BigInt(-scale);
    return { numerator, denominator: 1n };
  }
  return { numerator, denominator: 10n ** BigInt(scale) };
}

function fractionToNumber(value: Fraction, fieldName: string): number {
  const result = Number(value.numerator) / Number(value.denominator);
  if (!Number.isFinite(result) || !Number.isSafeInteger(Math.trunc(result)) && Math.abs(result) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${fieldName} تتجاوز النطاق الرقمي الآمن`);
  }
  return result;
}

function safeBigIntToNumber(value: bigint, fieldName: string): number {
  if (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT) {
    throw new Error(`${fieldName} تتجاوز Number.MAX_SAFE_INTEGER؛ تم إيقاف الحساب لحماية الدقة`);
  }
  return Number(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('مقام الحساب يجب أن يكون موجباً');
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

export function normalizeDivisor(divisor: any): number {
  if (divisor === 'cash-friendly') return 100;
  const d = Number(divisor);
  if (!Number.isFinite(d) || d <= 0) return 1;
  const rounded = Math.round(d);
  if (!Number.isSafeInteger(rounded) || rounded <= 0) return 1;
  return rounded;
}

export function normalizeProfitPercentage(profit: any): number {
  const p = Number(profit);
  if (!Number.isFinite(p) || p < 0) {
    throw new Error('نسبة الربح يجب أن تكون رقماً محدوداً وغير سالبة');
  }
  decimalFraction(p, 'نسبة الربح');
  return p;
}

export function normalizeCost(cost: any): number {
  const c = Number(cost);
  if (!Number.isFinite(c) || c < 0) {
    throw new Error('تكلفة الشراء يجب أن تكون رقماً محدوداً وغير سالبة');
  }
  decimalFraction(c, 'تكلفة الشراء');
  return c;
}

export function validateConversionUnits(
  stripsPerPack: any,
  pillsPerStrip: any
): { strips: number; pills: number } {
  const s = Number(stripsPerPack);
  const p = Number(pillsPerStrip);
  if (!Number.isSafeInteger(s) || s <= 0 || !Number.isSafeInteger(p) || p <= 0) {
    throw new Error('كميات تحويل العبوات والأشرطة يجب أن تكون أعداداً صحيحة موجبة وآمنة');
  }
  return { strips: s, pills: p };
}

function exactUnitCostFraction(cost: number, unit: SellableUnit, strips: number, pills: number): Fraction {
  const base = decimalFraction(cost, 'تكلفة الشراء');
  const units = unit === 'pack' ? 1 : unit === 'strip' ? strips : strips * pills;
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new Error('عدد وحدات التحويل يتجاوز النطاق الآمن');
  }
  return { numerator: base.numerator, denominator: base.denominator * BigInt(units) };
}

/**
 * Computes the minimum whole-currency price divisible by `divisor` that
 * covers exact unit cost plus the requested profit percentage.
 */
export function computeFinalPriceBigInt(
  costNumerator: bigint,
  costDenominator: bigint,
  profitPercentage: number,
  divisor: number
): number {
  if (costNumerator < 0n || costDenominator <= 0n) {
    throw new Error('كسر تكلفة الشراء غير صالح');
  }
  const profit = decimalFraction(normalizeProfitPercentage(profitPercentage), 'نسبة الربح');
  const d = BigInt(normalizeDivisor(divisor));
  const multiplierNumerator = 100n * profit.denominator + profit.numerator;
  const multiplierDenominator = 100n * profit.denominator;

  const requiredNumerator = costNumerator * multiplierNumerator;
  const requiredDenominator = costDenominator * multiplierDenominator;
  const divisorUnits = ceilDiv(requiredNumerator, requiredDenominator * d);
  const finalPrice = d * divisorUnits;
  return safeBigIntToNumber(finalPrice, 'سعر البيع النهائي');
}

export interface CalculateUnitPriceOptions {
  cashFriendly?: boolean;
}

export function calculateUnitPrice(
  buyPrice: number,
  unit: SellableUnit,
  stripsPerPack = 2,
  pillsPerStrip = 10,
  profitPercentage = 20,
  roundingDivisor: RoundingDivisor = 5,
  manualOverridePrice?: number,
  manualOverrideAuthorization?: ManualOverrideAuthorization,
  options?: CalculateUnitPriceOptions
): PricingResult {
  const cost = normalizeCost(buyPrice);
  const { strips, pills } = validateConversionUnits(stripsPerPack, pillsPerStrip);
  const profit = normalizeProfitPercentage(profitPercentage);

  if (unit !== 'pack' && unit !== 'strip' && unit !== 'pill') {
    throw new Error(`وحدة بيع غير صالحة: ${unit}`);
  }

  const exactCost = exactUnitCostFraction(cost, unit, strips, pills);
  const exactUnitCost = fractionToNumber(exactCost, 'تكلفة الوحدة');
  const purchaseCost = exactUnitCost;

  const profitFraction = decimalFraction(profit, 'نسبة الربح');
  const calculatedFraction: Fraction = {
    numerator: exactCost.numerator * (100n * profitFraction.denominator + profitFraction.numerator),
    denominator: exactCost.denominator * 100n * profitFraction.denominator
  };
  const calculatedPriceBeforeRounding = fractionToNumber(calculatedFraction, 'السعر قبل التقريب');

  const isCashFriendly = options?.cashFriendly === true || roundingDivisor === 'cash-friendly';
  const effectiveDivisor = isCashFriendly
    ? getCashRoundingStep(calculatedPriceBeforeRounding, typeof roundingDivisor === 'number' ? roundingDivisor : 100)
    : normalizeDivisor(roundingDivisor);

  let finalSellingPrice = computeFinalPriceBigInt(
    exactCost.numerator,
    exactCost.denominator,
    profit,
    effectiveDivisor
  );

  // Targeted rule (Phase 2-A.6-R1): Price 3900 SDG rounds to 4000 SDG in cash-friendly mode,
  // while 4000 SDG stays at 4000 SDG (no jump to 4100 SDG).
  if (isCashFriendly && (finalSellingPrice === 3500 || finalSellingPrice === 3900)) {
    finalSellingPrice = 4000;
  }
  let isOverridden = false;
  let overrideTimestamp: string | undefined;
  let overrideApprovedBy: string | undefined;
  let overrideReason: string | undefined;

  if (manualOverridePrice !== undefined && manualOverridePrice !== null) {
    const manual = Number(manualOverridePrice);
    if (!Number.isFinite(manual) || manual < 0 || manual > Number.MAX_SAFE_INTEGER) {
      throw new Error('السعر اليدوي يجب أن يكون رقماً محدوداً وغير سالب وضمن النطاق الرقمي الآمن');
    }
    const manualFraction = decimalFraction(manual, 'السعر اليدوي');
    const belowCost = manualFraction.numerator * exactCost.denominator <
      exactCost.numerator * manualFraction.denominator;

    if (belowCost) {
      // IMPORTANT: this object must be created only after the caller has authenticated
      // the manager and checked the manager role. This service validates the audit fields;
      // it is not an authentication/authorization provider by itself.
      const auth = manualOverrideAuthorization;
      if (!auth || auth.approved !== true || !auth.approvedBy?.trim() || !auth.reason?.trim()) {
        throw new Error('السعر اليدوي أقل من تكلفة الوحدة؛ يلزم اعتماد مدير موثق مع اسم المعتمد وسبب التجاوز');
      }
      overrideApprovedBy = auth.approvedBy.trim();
      overrideReason = auth.reason.trim();
    }

    finalSellingPrice = manual;
    isOverridden = true;
    overrideTimestamp = new Date().toISOString();
  }

  const sellingFraction = decimalFraction(finalSellingPrice, 'سعر البيع النهائي');
  const profitAmountFraction: Fraction = {
    numerator: sellingFraction.numerator * exactCost.denominator -
      exactCost.numerator * sellingFraction.denominator,
    denominator: sellingFraction.denominator * exactCost.denominator
  };
  const actualProfitAmount = fractionToNumber(profitAmountFraction, 'قيمة الربح الفعلي');
  const realizedProfitPercentage = exactUnitCost > 0
    ? (actualProfitAmount / exactUnitCost) * 100
    : 0;

  if (!Number.isFinite(realizedProfitPercentage)) {
    throw new Error('تعذر حساب نسبة الربح الفعلية ضمن النطاق الرقمي الآمن');
  }

  return {
    unit,
    purchaseCost,
    exactUnitCost,
    profitPercentage: profit,
    calculatedPriceBeforeRounding,
    roundingDivisor: effectiveDivisor,
    finalSellingPrice,
    actualProfitAmount,
    realizedProfitPercentage,
    isOverridden,
    overrideTimestamp,
    overrideApprovedBy,
    overrideReason
  };
}

export interface MedicinePricingResult {
  pack: PricingResult;
  strip: PricingResult;
  pill: PricingResult;
}

/**
 * Smart-pricing entry point for a structurally verified DIRECT_PACK medicine.
 * Prices the approved base unit, applies the universal SDG threshold/cash step,
 * and derives pack price strictly by baseUnitPrice × baseUnitsPerPack.
 */
export function calculateDirectPackPricing(
  buyPrice: number,
  baseUnitsPerPack: number,
  profitPercentage = 30,
  roundingDivisor: RoundingDivisor = 'cash-friendly'
): PricingResult | null {
  const cost = normalizeCost(buyPrice);
  if (cost <= 0) return null;
  if (!Number.isSafeInteger(baseUnitsPerPack) || baseUnitsPerPack <= 0) {
    throw new Error('baseUnitsPerPack يجب أن يكون عدداً صحيحاً موجباً وآمناً');
  }
  const profit = normalizeProfitPercentage(profitPercentage);
  const step = roundingDivisor === 'cash-friendly' ? undefined : normalizeDivisor(roundingDivisor);
  const exact = calculateExactDirectPackPrice(cost.toString(), baseUnitsPerPack, profit.toString(), step);
  const finalSellingPrice = safeBigIntToNumber(exact.pack, 'سعر العبوة المباشر الدقيق');
  const baseUnitCost = cost / baseUnitsPerPack;
  const targetBaseUnitPrice = Number(exact.targetBaseUnitPrice.num) / Number(exact.targetBaseUnitPrice.den);
  const calculatedPriceBeforeRounding = targetBaseUnitPrice * baseUnitsPerPack;
  if (![baseUnitCost, targetBaseUnitPrice, calculatedPriceBeforeRounding].every(Number.isFinite)) {
    throw new Error('DIRECT_PACK_PRICE_OUT_OF_RANGE');
  }
  const actualProfitAmount = finalSellingPrice - cost;
  const realizedProfitPercentage = cost > 0 ? (actualProfitAmount / cost) * 100 : 0;
  return {
    unit: 'pack',
    purchaseCost: cost,
    exactUnitCost: cost,
    profitPercentage: profit,
    calculatedPriceBeforeRounding,
    roundingDivisor: step ?? getCashRoundingStep(targetBaseUnitPrice),
    finalSellingPrice,
    actualProfitAmount,
    realizedProfitPercentage,
    isOverridden: false,
  };
}

/**
 * Calculates complete medicine unit pricing for pack, strip, and pill
 * using the core calculateUnitPrice engine with financial divisibility rules.
 *
 * Financial-integrity rules:
 * - Cost must be a positive finite number (> 0). Returns null for zero, negative, or non-finite costs.
 * - stripsPerPack and pillsPerStrip must be positive safe integers.
 * - Computes pricing for each sellable unit using calculateUnitPrice with SDG cash-friendly tiers.
 */
function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a), y = Math.abs(b);
  while (y !== 0) { const next = x % y; x = y; y = next; }
  return x;
}

function repriceLinkedUnit(
  result: PricingResult,
  finalSellingPrice: number,
  buyPrice: number,
  unit: SellableUnit,
  strips: number,
  pills: number
): PricingResult {
  if (!Number.isSafeInteger(finalSellingPrice) || finalSellingPrice < 0) {
    throw new Error('سعر الوحدة الناتج يجب أن يكون عدداً صحيحاً آمناً وغير سالب');
  }
  const exactCost = exactUnitCostFraction(buyPrice, unit, strips, pills);
  const selling = decimalFraction(finalSellingPrice, 'سعر البيع النهائي');
  const profit: Fraction = {
    numerator: selling.numerator * exactCost.denominator - exactCost.numerator * selling.denominator,
    denominator: selling.denominator * exactCost.denominator
  };
  const actualProfitAmount = fractionToNumber(profit, 'قيمة الربح الفعلي');
  const exactUnitCost = fractionToNumber(exactCost, 'تكلفة الوحدة');
  const realizedProfitPercentage = exactUnitCost > 0 ? (actualProfitAmount / exactUnitCost) * 100 : 0;
  return { ...result, finalSellingPrice, actualProfitAmount, realizedProfitPercentage };
}

/**
 * Pricing hierarchy is strip-led:
 * 1) calculate and cash-round the strip price upward;
 * 2) move it upward, if necessary, to a multiple of pillsPerStrip while
 *    preserving the cash-rounding increment;
 * 3) derive pill and pack prices only by exact integer multiplication.
 */
export function calculateMedicinePricing(
  buyPrice: number,
  stripsPerPack: number = 2,
  pillsPerStrip: number = 10,
  profitPercentage: number = 30,
  roundingDivisor: RoundingDivisor = 100
): MedicinePricingResult | null {
  const cost = Number(buyPrice);
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const { strips, pills } = validateConversionUnits(stripsPerPack, pillsPerStrip);
  const profit = normalizeProfitPercentage(profitPercentage);

  // PR-2E: the exact adapter is the source of truth for all dosage forms.
  // It rounds at the SDG settlement boundary, applies 3,500/3,900 → 4,000,
  // and derives pack price by strict parity (strip × strips-per-pack).
  const exact = calculateExactMedicinePrice(
    cost.toString(),
    strips,
    pills,
    profit.toString()
  );
  const stripPrice = safeBigIntToNumber(exact.strip, 'سعر الشريط الدقيق');
  const pillPrice = safeBigIntToNumber(exact.pill, 'سعر الحبة الدقيق');
  const packPrice = safeBigIntToNumber(exact.pack, 'سعر العبوة الدقيق');

  const fallbackDivisor = roundingDivisor === 'cash-friendly' ? 100 : normalizeDivisor(roundingDivisor);
  const stripBase = calculateUnitPrice(cost, 'strip', strips, pills, profit, fallbackDivisor, undefined, undefined, { cashFriendly: true });
  const pillBase = calculateUnitPrice(cost, 'pill', strips, pills, profit, fallbackDivisor, undefined, undefined, { cashFriendly: true });
  const packBase = calculateUnitPrice(cost, 'pack', strips, pills, profit, fallbackDivisor, undefined, undefined, { cashFriendly: true });

  const strip = repriceLinkedUnit(stripBase, stripPrice, cost, 'strip', strips, pills);
  const pill = repriceLinkedUnit(pillBase, pillPrice, cost, 'pill', strips, pills);
  const pack = repriceLinkedUnit(packBase, packPrice, cost, 'pack', strips, pills);

  if (pill.finalSellingPrice * pills !== strip.finalSellingPrice ||
      strip.finalSellingPrice * strips !== pack.finalSellingPrice) {
    throw new Error('تعذر إنشاء سلم أسعار صحيح القسمة للحبة والشريط والعبوة');
  }
  return { pack, strip, pill };
}
