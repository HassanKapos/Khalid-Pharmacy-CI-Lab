/**
 * PR-2C exact inventory costing adapter.
 * Pure arithmetic only: no IndexedDB, Firebase, UI, or legacy-number promotion.
 */
import {
  addRational, createRational, divideRational, multiplyRational,
  subtractRational, compareRational, equalsRational, isNegativeRational, isZeroRational, normalizeRational,
  formatRationalForDisplay, sumRationals, type Rational,
} from './exactFinance.ts';

export type ExactDecimalInput = string;
export interface ExactCostMovement {
  /** Signed smallest-unit quantity; positive receipt, negative issue. */
  readonly baseUnitsDelta: string;
  /** Exact cost per smallest unit, as a decimal string. */
  readonly costPerBaseUnit: ExactDecimalInput;
}
export interface ExactWeightedCostResult {
  readonly netBaseUnits: string;
  readonly totalCarryingCost: Rational;
  readonly costPerBaseUnit: Rational;
}
export interface ExactDiscountAllocation {
  readonly subtotal: Rational;
  readonly discount: Rational;
  readonly netTotal: Rational;
  readonly shares: readonly Rational[];
  readonly netLineCosts: readonly Rational[];
}

const DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/;
const INTEGER_RE = /^-?(?:0|[1-9][0-9]*)$/;

export function parseExactDecimal(value: ExactDecimalInput, field = 'value'): Rational {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value) || value === '-0') {
    throw new Error(`${field} must be a canonical decimal string with at most 8 fractional digits.`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const digits = `${whole}${fraction}`;
  const numerator = BigInt(`${negative ? '-' : ''}${digits}`);
  return createRational(numerator, 10n ** BigInt(fraction.length));
}

function parseSignedInteger(value: string, field: string): bigint {
  if (typeof value !== 'string' || !INTEGER_RE.test(value) || value === '-0') {
    throw new Error(`${field} must be a canonical integer string.`);
  }
  return BigInt(value);
}

export function calculateExactWeightedBatchCost(
  movements: readonly ExactCostMovement[],
): ExactWeightedCostResult {
  if (!Array.isArray(movements) || movements.length === 0) {
    throw new Error('At least one exact cost movement is required.');
  }
  let units = 0n;
  let carryingCost = createRational(0n);
  for (const [index, movement] of movements.entries()) {
    if (!movement || typeof movement !== 'object') throw new Error(`Movement ${index} is invalid.`);
    const delta = parseSignedInteger(movement.baseUnitsDelta, `movements[${index}].baseUnitsDelta`);
    if (delta === 0n) continue;
    const unitCost = parseExactDecimal(movement.costPerBaseUnit, `movements[${index}].costPerBaseUnit`);
    if (isNegativeRational(unitCost)) throw new Error('Movement cost cannot be negative.');
    units += delta;
    const signedCost = multiplyRational(createRational(delta), unitCost);
    carryingCost = addRational(carryingCost, signedCost);
  }
  if (units <= 0n) throw new Error('Net base-unit quantity must be positive; fallback estimates are not accepted.');
  if (isNegativeRational(carryingCost)) throw new Error('Net carrying cost cannot be negative.');
  return Object.freeze({
    netBaseUnits: units.toString(),
    totalCarryingCost: carryingCost,
    costPerBaseUnit: divideRational(carryingCost, createRational(units)),
  });
}

/** Allocate a discount exactly in proportion to line gross costs; no currency rounding occurs here. */
export function allocateExactProportionalDiscount(
  lineGrossCosts: readonly ExactDecimalInput[],
  requestedDiscount: ExactDecimalInput,
): ExactDiscountAllocation {
  if (!Array.isArray(lineGrossCosts) || lineGrossCosts.length === 0) {
    throw new Error('At least one invoice line is required.');
  }
  const costs = lineGrossCosts.map((value, index) => {
    const parsed = parseExactDecimal(value, `lineGrossCosts[${index}]`);
    if (isNegativeRational(parsed)) throw new Error('Invoice line costs cannot be negative.');
    return parsed;
  });
  const subtotal = costs.reduce((sum, value) => addRational(sum, value), createRational(0n));
  const requested = parseExactDecimal(requestedDiscount, 'requestedDiscount');
  if (isNegativeRational(requested)) throw new Error('Discount cannot be negative.');
  if (compareRational(requested, subtotal) > 0) throw new Error('Discount cannot exceed invoice subtotal.');
  const discount = requested;
  const shares = isZeroRational(subtotal)
    ? costs.map(() => createRational(0n))
    : costs.map(cost => divideRational(multiplyRational(cost, discount), subtotal));
  const netLineCosts = costs.map((cost, index) => subtractRational(cost, shares[index]));
  const netTotal = netLineCosts.reduce((sum, value) => addRational(sum, value), createRational(0n));
  const allocated = shares.reduce((sum, value) => addRational(sum, value), createRational(0n));
  if (compareRational(allocated, discount) !== 0) throw new Error('Exact discount allocation conservation failed.');
  return Object.freeze({
    subtotal, discount, netTotal,
    shares: Object.freeze(shares),
    netLineCosts: Object.freeze(netLineCosts),
  });
}

/** Exact weighted average from rational per-base-unit receipt costs. Negative/outgoing movements are intentionally excluded: issuing stock at the batch's current carrying cost does not change the remaining average. */
export interface ExactRationalWeightedReceiptCostResult {
  readonly receiptBaseUnits: string;
  readonly totalCarryingCost: Rational;
  readonly costPerBaseUnit: Rational;
}

export interface ExactRationalCostMovement {
  readonly baseUnitsDelta: string;
  readonly costPerBaseUnit: Rational;
}

export function calculateExactWeightedBatchCostRational(
  movements: readonly ExactRationalCostMovement[],
): ExactRationalWeightedReceiptCostResult {
  if (!Array.isArray(movements) || movements.length === 0) {
    throw new Error('At least one exact rational receipt cost movement is required.');
  }
  let units = 0n;
  let carryingCost = createRational(0n);
  for (const [index, movement] of movements.entries()) {
    if (!movement || typeof movement !== 'object') throw new Error(`Movement ${index} is invalid.`);
    const delta = parseSignedInteger(movement.baseUnitsDelta, `movements[${index}].baseUnitsDelta`);
    if (delta <= 0n) continue;
    const unitCost = normalizeRational(movement.costPerBaseUnit);
    if (isNegativeRational(unitCost)) throw new Error('Exact batch unit costs cannot be negative.');
    units += delta;
    carryingCost = addRational(carryingCost, multiplyRational(createRational(delta), unitCost));
  }
  if (units <= 0n) throw new Error('Exact batch costing requires positive receipt units.');
  return Object.freeze({
    receiptBaseUnits: units.toString(),
    totalCarryingCost: carryingCost,
    costPerBaseUnit: divideRational(carryingCost, createRational(units)),
  });
}

/** Proportional discount allocation that accepts Rational inputs without decimal-string projection. */
export function allocateExactProportionalDiscountRational(
  lineGrossCosts: readonly Rational[],
  requestedDiscount: Rational,
): ExactDiscountAllocation {
  if (!Array.isArray(lineGrossCosts) || lineGrossCosts.length === 0) {
    throw new Error('At least one invoice line is required.');
  }
  const costs = lineGrossCosts.map((value, index) => {
    const parsed = normalizeRational(value);
    if (isNegativeRational(parsed)) throw new Error(`Invoice line costs cannot be negative (line ${index}).`);
    return parsed;
  });
  const subtotal = costs.reduce((sum, value) => addRational(sum, value), createRational(0n));
  const discount = normalizeRational(requestedDiscount);
  if (isNegativeRational(discount)) throw new Error('Discount cannot be negative.');
  if (compareRational(discount, subtotal) > 0) throw new Error('Discount cannot exceed invoice subtotal.');
  const shares = isZeroRational(subtotal)
    ? costs.map(() => createRational(0n))
    : costs.map((cost) => divideRational(multiplyRational(cost, discount), subtotal));
  const netLineCosts = costs.map((cost, index) => subtractRational(cost, shares[index]));
  const netTotal = netLineCosts.reduce((sum, value) => addRational(sum, value), createRational(0n));
  const allocated = shares.reduce((sum, value) => addRational(sum, value), createRational(0n));
  if (compareRational(allocated, discount) !== 0) throw new Error('Exact discount allocation conservation failed.');
  return Object.freeze({
    subtotal,
    discount,
    netTotal,
    shares: Object.freeze(shares),
    netLineCosts: Object.freeze(netLineCosts),
  });
}

/** Explicitly classify legacy JS-number values; never silently convert them to exact money. */
export function classifyLegacyCost(value: unknown): 'APPROXIMATE_LEGACY' | 'UNPROVABLE' {
  return typeof value === 'number' && Number.isFinite(value) ? 'APPROXIMATE_LEGACY' : 'UNPROVABLE';
}


export interface ExactPurchaseInvoiceLineInput {
  readonly lineId: string;
  readonly grossLineTotal: ExactDecimalInput;
  readonly lineDiscount?: ExactDecimalInput;
}

export interface ExactPurchaseInvoiceReconciliationInput {
  readonly lines: readonly ExactPurchaseInvoiceLineInput[];
  readonly invoiceDiscount?: ExactDecimalInput;
  readonly printedFinalTotal?: ExactDecimalInput;
  readonly displayDecimals?: number;
}

export interface ExactPurchaseInvoiceLineAllocation {
  readonly lineId: string;
  readonly grossLineTotal: Rational;
  readonly lineDiscount: Rational;
  readonly invoiceDiscountShare: Rational;
  readonly netInventoryLineCost: Rational;
}

export interface ExactPurchaseInvoiceReconciliationResult {
  readonly status: 'RECONCILED' | 'NEEDS_REVIEW';
  readonly requiresAdminReapproval: boolean;
  readonly syntheticBalancingLineCreated: false;
  readonly originalLineCount: number;
  readonly inventoryCostReference: Rational;
  readonly payableReference: Rational;
  readonly discrepancy: Rational;
  readonly discrepancyDisplay: string;
  readonly totalInvoiceDiscount: Rational;
  readonly lines: readonly ExactPurchaseInvoiceLineAllocation[];
}

/**
 * Phase 2D Workstream C2: Exact purchase invoice reconciliation.
 * - Line totals after line & invoice discounts define inventoryCostReference.
 * - Printed final total defines payableReference (if supplied).
 * - If they disagree, marks NEEDS_REVIEW with requiresAdminReapproval=true and NEVER creates a synthetic balancing item.
 */
export function reconcilePurchaseInvoiceTotalExact(
  input: ExactPurchaseInvoiceReconciliationInput,
): ExactPurchaseInvoiceReconciliationResult {
  if (!input || !Array.isArray(input.lines) || input.lines.length === 0) {
    throw new Error('At least one purchase invoice line is required for exact reconciliation.');
  }
  const decimals = input.displayDecimals ?? 2;
  const lineAfterLineDiscount: Rational[] = [];
  const parsedLines: Array<{ lineId: string; gross: Rational; lineDiscount: Rational }> = [];

  for (const [idx, line] of input.lines.entries()) {
    if (!line || typeof line.lineId !== 'string' || line.lineId.trim().length === 0) {
      throw new Error(`lines[${idx}].lineId must be a non-empty string.`);
    }
    const gross = parseExactDecimal(line.grossLineTotal, `lines[${idx}].grossLineTotal`);
    if (isNegativeRational(gross)) {
      throw new Error(`lines[${idx}].grossLineTotal cannot be negative.`);
    }
    const lineDisc = line.lineDiscount !== undefined
      ? parseExactDecimal(line.lineDiscount, `lines[${idx}].lineDiscount`)
      : createRational(0n);
    if (isNegativeRational(lineDisc) || compareRational(lineDisc, gross) > 0) {
      throw new Error(`lines[${idx}].lineDiscount must be between 0 and grossLineTotal.`);
    }
    parsedLines.push({ lineId: line.lineId.trim(), gross, lineDiscount: lineDisc });
    lineAfterLineDiscount.push(subtractRational(gross, lineDisc));
  }

  const invoiceDisc = input.invoiceDiscount !== undefined
    ? parseExactDecimal(input.invoiceDiscount, 'invoiceDiscount')
    : createRational(0n);

  const alloc = allocateExactProportionalDiscountRational(lineAfterLineDiscount, invoiceDisc);
  const inventoryCostReference = alloc.netTotal;

  const payableReference = input.printedFinalTotal !== undefined
    ? parseExactDecimal(input.printedFinalTotal, 'printedFinalTotal')
    : inventoryCostReference;
  if (isNegativeRational(payableReference)) {
    throw new Error('printedFinalTotal cannot be negative.');
  }

  const discrepancy = subtractRational(payableReference, inventoryCostReference);
  const needsReview = !isZeroRational(discrepancy);

  const allocations: ExactPurchaseInvoiceLineAllocation[] = parsedLines.map((line, idx) =>
    Object.freeze({
      lineId: line.lineId,
      grossLineTotal: line.gross,
      lineDiscount: line.lineDiscount,
      invoiceDiscountShare: alloc.shares[idx],
      netInventoryLineCost: alloc.netLineCosts[idx],
    }),
  );

  // Conservation invariant: exact sum of netInventoryLineCost MUST equal inventoryCostReference
  const summedLines = sumRationals(allocations.map((a) => a.netInventoryLineCost));
  if (!equalsRational(summedLines, inventoryCostReference)) {
    throw new Error('Exact purchase invoice line cost conservation failed.');
  }

  return Object.freeze({
    status: needsReview ? 'NEEDS_REVIEW' : 'RECONCILED',
    requiresAdminReapproval: needsReview,
    syntheticBalancingLineCreated: false as const,
    originalLineCount: parsedLines.length,
    inventoryCostReference,
    payableReference,
    discrepancy,
    discrepancyDisplay: formatRationalForDisplay(discrepancy, { decimals, roundingMode: 'HALF_UP' }).formatted,
    totalInvoiceDiscount: invoiceDisc,
    lines: Object.freeze(allocations),
  });
}

export interface ExactBatchReceiptEntry {
  readonly batchId: string;
  readonly receiptBaseUnits: string;
  readonly costPerBaseUnit: Rational;
}

export interface ExactSaleConsumptionEntry {
  readonly batchId: string;
  readonly consumedBaseUnits: string;
}

export interface ExactCogsValuationIdentityResult {
  readonly totalReceiptsCarryingCost: Rational;
  readonly totalSaleCogs: Rational;
  readonly remainingInventoryValuation: Rational;
  readonly drift: Rational;
  readonly exactIdentityHolds: boolean;
  readonly remainingUnitsByBatch: Readonly<Record<string, string>>;
}

/**
 * Phase 2D Workstream C3/C4: Verifies exact carrying-cost conservation across multi-batch receipts & consumptions:
 * Receipts Carrying Cost === Sale COGS + Remaining Valuation (zero drift).
 */
export function verifyExactCogsAndValuationIdentity(input: {
  readonly receipts: readonly ExactBatchReceiptEntry[];
  readonly consumptions: readonly ExactSaleConsumptionEntry[];
}): ExactCogsValuationIdentityResult {
  if (!input || !Array.isArray(input.receipts) || input.receipts.length === 0) {
    throw new Error('At least one receipt batch is required.');
  }

  const batchUnits = new Map<string, bigint>();
  const batchUnitCost = new Map<string, Rational>();
  const batchCarrying = new Map<string, Rational>();

  for (const [idx, rec] of input.receipts.entries()) {
    const units = parseSignedInteger(rec.receiptBaseUnits, `receipts[${idx}].receiptBaseUnits`);
    if (units <= 0n) throw new Error(`receipts[${idx}].receiptBaseUnits must be positive.`);
    const cost = normalizeRational(rec.costPerBaseUnit);
    if (isNegativeRational(cost)) throw new Error(`receipts[${idx}].costPerBaseUnit cannot be negative.`);

    const prevUnits = batchUnits.get(rec.batchId) ?? 0n;
    const prevCarry = batchCarrying.get(rec.batchId) ?? createRational(0n);
    const addedCarry = multiplyRational(createRational(units), cost);
    const nextUnits = prevUnits + units;
    const nextCarry = addRational(prevCarry, addedCarry);

    batchUnits.set(rec.batchId, nextUnits);
    batchCarrying.set(rec.batchId, nextCarry);
    batchUnitCost.set(rec.batchId, divideRational(nextCarry, createRational(nextUnits)));
  }

  let totalReceiptsCarryingCost = createRational(0n);
  for (const carry of batchCarrying.values()) {
    totalReceiptsCarryingCost = addRational(totalReceiptsCarryingCost, carry);
  }

  let totalSaleCogs = createRational(0n);
  for (const [idx, cons] of (input.consumptions ?? []).entries()) {
    const qty = parseSignedInteger(cons.consumedBaseUnits, `consumptions[${idx}].consumedBaseUnits`);
    if (qty <= 0n) throw new Error(`consumptions[${idx}].consumedBaseUnits must be positive.`);
    const available = batchUnits.get(cons.batchId) ?? 0n;
    if (qty > available) {
      throw new Error(`Batch ${cons.batchId} over-consumed: requested ${qty.toString()}, available ${available.toString()}.`);
    }
    const unitCost = batchUnitCost.get(cons.batchId)!;
    const cogs = multiplyRational(createRational(qty), unitCost);
    totalSaleCogs = addRational(totalSaleCogs, cogs);
    batchUnits.set(cons.batchId, available - qty);
  }

  let remainingInventoryValuation = createRational(0n);
  const remainingUnitsByBatch: Record<string, string> = {};
  for (const [batchId, remUnits] of batchUnits.entries()) {
    remainingUnitsByBatch[batchId] = remUnits.toString();
    if (remUnits > 0n) {
      const unitCost = batchUnitCost.get(batchId)!;
      remainingInventoryValuation = addRational(
        remainingInventoryValuation,
        multiplyRational(createRational(remUnits), unitCost),
      );
    }
  }

  const accounted = addRational(totalSaleCogs, remainingInventoryValuation);
  const drift = subtractRational(totalReceiptsCarryingCost, accounted);

  return Object.freeze({
    totalReceiptsCarryingCost,
    totalSaleCogs,
    remainingInventoryValuation,
    drift,
    exactIdentityHolds: isZeroRational(drift),
    remainingUnitsByBatch: Object.freeze(remainingUnitsByBatch),
  });
}
