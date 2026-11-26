/** Exact unit-cost normalization helpers for the append-only inventory ledger. */
import { compareRational, createRational, formatRationalForDisplay, subtractRational } from './exactFinance.ts';
import { parseExactDecimal } from './exactInventoryCosting.ts';
export type CostUnit = 'pack' | 'strip' | 'pill';

export interface CostMovementLike {
  type: string;
  unit?: CostUnit;
  quantityDelta?: number;
  baseUnitsDelta?: number;
  costPerUnit?: number;
  costPerBaseUnit?: number;
}

export function getBaseUnitsPerCostUnit(
  unit: CostUnit,
  stripsPerPack: number,
  pillsPerStrip: number,
  baseUnitsPerPack?: number,
  directPack = false
): number {
  if (directPack) {
    const units = Number(baseUnitsPerPack);
    if (unit !== 'pack' || !Number.isSafeInteger(units) || units <= 0) {
      throw new Error('DIRECT_PACK_COST_REQUIRES_VERIFIED_PACK_CONVERSION');
    }
    return units;
  }
  const strips = Number(stripsPerPack);
  const pills = Number(pillsPerStrip);
  if (!Number.isSafeInteger(strips) || strips <= 0 || !Number.isSafeInteger(pills) || pills <= 0) {
    throw new Error('بيانات تحويل العبوة أو الشريط غير صالحة لحساب تكلفة المخزون');
  }
  if (unit === 'pill') return 1;
  if (unit === 'strip') return pills;
  return strips * pills;
}

/** Convert a cost entered for one invoice unit into cost per smallest stock unit (pill). */
export function normalizeCostToBaseUnit(
  costPerEnteredUnit: number,
  unit: CostUnit,
  stripsPerPack: number,
  pillsPerStrip: number,
  baseUnitsPerPack?: number,
  directPack = false
): number {
  const cost = Number(costPerEnteredUnit);
  if (!Number.isFinite(cost) || cost < 0) throw new Error('تكلفة الشراء المدخلة غير صالحة');
  return cost / getBaseUnitsPerCostUnit(unit, stripsPerPack, pillsPerStrip, baseUnitsPerPack, directPack);
}

/**
 * Resolve a historical movement cost without allowing SALE/DAMAGE movements
 * to overwrite the incoming batch cost. Older ledger records are normalized
 * according to the unit convention used by their movement type.
 */
export function resolveIncomingCostPerBaseUnit(
  movement: CostMovementLike,
  stripsPerPack: number,
  pillsPerStrip: number,
  fallbackPackCost: number,
  baseUnitsPerPack?: number,
  directPack = false
): number | null {
  const delta = Number(movement.baseUnitsDelta ?? 0);
  if (delta <= 0 || ['SALE', 'DAMAGE'].includes(movement.type)) return null;

  const explicit = Number(movement.costPerBaseUnit);
  if (movement.costPerBaseUnit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;

  const cost = Number(movement.costPerUnit);
  if (Number.isFinite(cost) && cost >= 0) {
    // PURCHASE costs were recorded in the entered unit; legacy INITIAL,
    // RETURN and ADJUSTMENT movements stored the medicine's pack cost.
    const unit = movement.type === 'PURCHASE' ? (movement.unit || 'pack') : 'pack';
    return normalizeCostToBaseUnit(cost, unit, stripsPerPack, pillsPerStrip, baseUnitsPerPack, directPack);
  }

  const fallback = Number(fallbackPackCost);
  if (Number.isFinite(fallback) && fallback >= 0) {
    return normalizeCostToBaseUnit(fallback, 'pack', stripsPerPack, pillsPerStrip, baseUnitsPerPack, directPack);
  }
  return null;
}

/** Resolve a movement's per-pill carrying cost, including historical outflows. */
export function resolveMovementCostPerBaseUnit(
  movement: CostMovementLike,
  stripsPerPack: number,
  pillsPerStrip: number,
  fallbackPackCost: number,
  baseUnitsPerPack?: number,
  directPack = false
): number | null {
  const explicit = Number(movement.costPerBaseUnit);
  if (movement.costPerBaseUnit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;

  const cost = Number(movement.costPerUnit);
  if (Number.isFinite(cost) && cost >= 0) {
    // Only positive PURCHASE rows used their entered unit. Historical SALE,
    // DAMAGE, RETURN, INITIAL and ADJUSTMENT rows stored pack-equivalent cost.
    const isPositivePurchase = movement.type === 'PURCHASE' && Number(movement.baseUnitsDelta ?? 0) > 0;
    const unit = isPositivePurchase ? (movement.unit || 'pack') : 'pack';
    return normalizeCostToBaseUnit(cost, unit, stripsPerPack, pillsPerStrip, baseUnitsPerPack, directPack);
  }

  const fallback = Number(fallbackPackCost);
  if (Number.isFinite(fallback) && fallback >= 0) {
    return normalizeCostToBaseUnit(fallback, 'pack', stripsPerPack, pillsPerStrip, baseUnitsPerPack, directPack);
  }
  return null;
}

export function calculateWeightedBatchCost(
  movements: CostMovementLike[],
  stripsPerPack: number,
  pillsPerStrip: number,
  fallbackPackCost: number,
  baseUnitsPerPack?: number,
  directPack = false
): { costPerBaseUnit: number; isEstimated: boolean } {
  let netCostValue = 0;
  let netUnits = 0;
  let isEstimated = false;
  for (const movement of movements) {
    const baseUnits = Number(movement.baseUnitsDelta ?? 0);
    if (!Number.isFinite(baseUnits) || baseUnits === 0) continue;
    netUnits += baseUnits;
    const explicitBaseCost = Number(movement.costPerBaseUnit);
    const recordedUnitCost = Number(movement.costPerUnit);
    const hasRecordedCost =
      (movement.costPerBaseUnit !== undefined && Number.isFinite(explicitBaseCost) && explicitBaseCost >= 0) ||
      (Number.isFinite(recordedUnitCost) && recordedUnitCost >= 0);
    if (!hasRecordedCost) isEstimated = true;
    const unitCost = resolveMovementCostPerBaseUnit(movement, stripsPerPack, pillsPerStrip, fallbackPackCost, baseUnitsPerPack, directPack);
    if (unitCost === null) {
      isEstimated = true;
      continue;
    }
    netCostValue += baseUnits * unitCost;
  }
  if (netUnits > 0 && Number.isFinite(netCostValue) && netCostValue >= 0) {
    return { costPerBaseUnit: netCostValue / netUnits, isEstimated };
  }
  return {
    costPerBaseUnit: normalizeCostToBaseUnit(fallbackPackCost, 'pack', stripsPerPack, pillsPerStrip, baseUnitsPerPack, directPack),
    isEstimated: true
  };
}


/** Allocate a supplier invoice discount across lines in proportion to gross line cost. */
export function allocateProportionalDiscount(lineCosts: number[], requestedDiscount: number): {
  discount: number;
  discountShares: number[];
  netLineCosts: number[];
} {
  const costs = lineCosts.map(Number);
  if (costs.some((cost) => !Number.isFinite(cost) || cost < 0)) {
    throw new Error('تكاليف بنود الفاتورة يجب أن تكون أرقاماً غير سالبة');
  }
  const subtotal = costs.reduce((sum, cost) => sum + cost, 0);
  const rawDiscount = Number(requestedDiscount);
  if (!Number.isFinite(rawDiscount) || rawDiscount < 0) {
    throw new Error('خصم فاتورة المورد غير صالح');
  }
  const discount = Math.min(subtotal, rawDiscount);
  const discountShares = costs.map(() => 0);
  if (subtotal > 0 && costs.length > 0 && discount > 0) {
    let allocated = 0;
    costs.forEach((cost, index) => {
      const share = index === costs.length - 1
        ? discount - allocated
        : discount * (cost / subtotal);
      discountShares[index] = share;
      allocated += share;
    });
  }
  return {
    discount,
    discountShares,
    netLineCosts: costs.map((cost, index) => cost - discountShares[index])
  };
}


/**
 * Settle a sale in whole SDG using exact HALF_UP arithmetic and distribute the
 * resulting integer discount with a largest-remainder allocation. This keeps
 * the persisted invoice total, discount, and per-line profit shares consistent.
 */
export function allocateWholeSdgSaleSettlement(
  lineSubtotals: number[],
  requestedDiscount: number,
): { subtotal: number; discount: number; total: number; discountShares: number[]; netLineTotals: number[] } {
  const values = lineSubtotals.map(Number);
  if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('SALE_SETTLEMENT_INVALID_LINE_SUBTOTAL');
  }
  const subtotalBig = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (subtotalBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SALE_SETTLEMENT_SUBTOTAL_UNSAFE');
  const rawDiscount = Number(requestedDiscount);
  if (!Number.isFinite(rawDiscount) || rawDiscount < 0) throw new Error('SALE_SETTLEMENT_INVALID_DISCOUNT');
  const subtotal = Number(subtotalBig);
  const requested = parseExactDecimal(String(rawDiscount), 'sale discount');
  const subtotalRational = createRational(subtotalBig);
  const clampedDiscount = compareRational(requested, subtotalRational) > 0 ? subtotalRational : requested;
  const rawTotal = subtractRational(subtotalRational, clampedDiscount);
  const rounded = formatRationalForDisplay(rawTotal, { decimals: 0, roundingMode: 'HALF_UP' });
  const total = Number(rounded.formatted);
  if (!Number.isSafeInteger(total) || total < 0 || total > subtotal) throw new Error('SALE_SETTLEMENT_INVALID_ROUNDED_TOTAL');
  const discount = subtotal - total;
  const discountBig = BigInt(discount);
  const shares = values.map(() => 0);
  if (subtotalBig > 0n && discountBig > 0n) {
    const remainders: { index: number; remainder: bigint }[] = [];
    let allocated = 0n;
    values.forEach((line, index) => {
      const numerator = discountBig * BigInt(line);
      const quotient = numerator / subtotalBig;
      const remainder = numerator % subtotalBig;
      shares[index] = Number(quotient);
      allocated += quotient;
      remainders.push({ index, remainder });
    });
    let remaining = discountBig - allocated;
    remainders.sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
    for (let i = 0; remaining > 0n; i += 1) {
      if (i >= remainders.length) throw new Error('SALE_SETTLEMENT_DISCOUNT_ALLOCATION_FAILED');
      shares[remainders[i].index] += 1;
      remaining -= 1n;
    }
  }
  if (shares.reduce((sum, share) => sum + BigInt(share), 0n) !== discountBig) {
    throw new Error('SALE_SETTLEMENT_DISCOUNT_NOT_CONSERVED');
  }
  return { subtotal, discount, total, discountShares: shares, netLineTotals: values.map((line, index) => line - shares[index]) };
}
