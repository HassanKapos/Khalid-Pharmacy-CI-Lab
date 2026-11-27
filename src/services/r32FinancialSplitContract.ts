/**
 * Phase 2E-B.3 (R3.2) — Operational vs Financial Split Contract & Exact Rational Costing Kernel
 *
 * Security Invariants (OD-3, Zero-Cost Spark):
 * - Operational documents (`medicines`, `inventory_ledger`, `sales`, `sales/{saleId}/items`) MUST NEVER
 *   contain `buyPrice`, `costPerUnit`, `costPerBaseUnit`, `costOfGoods`, `grossProfit`, `netProfit`,
 *   or any valuation/margin keys.
 * - All financial calculations use exact rational numbers `{ num: number; den: number }` (`den > 0`)
 *   matching `isValidRationalMap(...)` in `firestore.rules`.
 * - Missing historical cost provenance MUST fail closed to `NEEDS_REVIEW` (never silently fabricate
 *   cost from current `buyPrice` for historical `SALE` movements).
 */

export interface ExactRational {
  num: number;
  den: number;
}

export const CASHIER_FORBIDDEN_FIELD_KEYS: ReadonlySet<string> = new Set([
  'buyPrice',
  'buyPriceExact',
  'costPerUnit',
  'costPerBaseUnit',
  'costOfGoods',
  'grossProfit',
  'netProfit',
  'costPerUnitExact',
  'costPerBaseUnitExact',
  'totalCostExact',
  'costOfGoodsExact',
  'grossProfitExact',
  'netProfitExact',
  'lastPurchaseCostExact',
  'purchaseReturnVarianceExact',
  'inventoryValuation',
  'financialVariance',
  'financialVarianceExact',
  'varianceValuation',
  'netVarianceSDG',
  'totalVarianceCost',
  'varianceSDG',
  'totalExpectedValuationExact',
  'totalSystemValuationExact',
  'netVarianceValuationExact',
  'profitMargin',
  'unitCost',
  'totalCost',
]);

function gcdInt(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0 ? 1 : x;
}

export function normalizeRational(num: number, den: number): ExactRational {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den === 0) {
    throw new Error(`INVALID_RATIONAL:${num}/${den}`);
  }
  const sign = den < 0 ? -1 : 1;
  const n = num * sign;
  const d = Math.abs(den);
  const g = gcdInt(n, d);
  return { num: n / g, den: d / g };
}

export function rationalFromNumber(value: number, scale = 10000): ExactRational {
  if (!Number.isFinite(value)) {
    throw new Error(`INVALID_RATIONAL_NUMBER:${value}`);
  }
  return normalizeRational(Math.round(value * scale), scale);
}

export function addRational(a: ExactRational, b: ExactRational): ExactRational {
  return normalizeRational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function subRational(a: ExactRational, b: ExactRational): ExactRational {
  return normalizeRational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mulRational(a: ExactRational, b: ExactRational): ExactRational {
  return normalizeRational(a.num * b.num, a.den * b.den);
}

export function divRational(a: ExactRational, b: ExactRational): ExactRational {
  if (b.num === 0) {
    throw new Error('RATIONAL_DIVISION_BY_ZERO');
  }
  return normalizeRational(a.num * b.den, a.den * b.num);
}

export function compareRational(a: ExactRational, b: ExactRational): number {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function rationalToNumber(r: ExactRational): number {
  return r.num / r.den;
}

export function findForbiddenCashierKeys(
  payload: unknown,
  pathPrefix = ''
): string[] {
  const found: string[] = [];
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return found;
  }
  if (Array.isArray(payload)) {
    for (let i = 0; i < payload.length; i++) {
      found.push(...findForbiddenCashierKeys(payload[i], `${pathPrefix}[${i}]`));
    }
    return found;
  }
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    const fullPath = pathPrefix ? `${pathPrefix}.${k}` : k;
    if (CASHIER_FORBIDDEN_FIELD_KEYS.has(k)) {
      found.push(fullPath);
    }
    if (v !== null && typeof v === 'object') {
      found.push(...findForbiddenCashierKeys(v, fullPath));
    }
  }
  return found;
}

export function assertNoCashierForbiddenFields(
  payload: unknown,
  contextLabel: string
): void {
  const violations = findForbiddenCashierKeys(payload);
  if (violations.length > 0) {
    throw new Error(
      `CASHIER_FINANCIAL_LEAK_BLOCKED:${contextLabel}:${violations.join(',')}`
    );
  }
}

export function buildDeterministicSaleItemId(
  saleId: string,
  itemIndex: number
): string {
  if (!saleId || !/^[a-zA-Z0-9_-]{1,128}$/.test(saleId)) {
    throw new Error(`INVALID_SALE_ID:${saleId}`);
  }
  if (!Number.isInteger(itemIndex) || itemIndex < 0) {
    throw new Error(`INVALID_SALE_ITEM_INDEX:${itemIndex}`);
  }
  return `${saleId}-item-${itemIndex}`;
}

export interface OperationalSaleLineInput {
  medicineId: string;
  medicineName: string;
  unit: 'pack' | 'strip' | 'pill';
  quantity: number;
  baseUnits: number;
  unitPrice: number;
  expectedLedgerCount?: number;
}

export interface OperationalSaleItemPayload {
  id: string;
  branchId: string;
  saleId: string;
  itemIndex: number;
  medicineId: string;
  medicineName: string;
  unit: 'pack' | 'strip' | 'pill';
  quantity: number;
  baseUnits: number;
  unitPrice: number;
  lineSubtotal: number;
  expectedLedgerCount: number;
}

export function buildOperationalSaleItems(
  branchId: string,
  saleId: string,
  lines: OperationalSaleLineInput[]
): OperationalSaleItemPayload[] {
  if (lines.length === 0) {
    throw new Error('SALE_MUST_CONTAIN_AT_LEAST_ONE_ITEM');
  }
  return lines.map((line, itemIndex) => {
    const lineSubtotal = Number((line.quantity * line.unitPrice).toFixed(2));
    const item: OperationalSaleItemPayload = {
      id: buildDeterministicSaleItemId(saleId, itemIndex),
      branchId,
      saleId,
      itemIndex,
      medicineId: line.medicineId,
      medicineName: line.medicineName,
      unit: line.unit,
      quantity: line.quantity,
      baseUnits: line.baseUnits,
      unitPrice: line.unitPrice,
      lineSubtotal,
      expectedLedgerCount: line.expectedLedgerCount ?? 1,
    };
    assertNoCashierForbiddenFields(item, `sales/${saleId}/items/${item.id}`);
    return item;
  });
}

export function splitMedicineOperationalAndFinancial(
  medicine: Record<string, unknown>,
  branchId: string,
  medicineId: string,
  actorUid: string
): {
  operational: Record<string, unknown>;
  financial: {
    id: string;
    branchId: string;
    medicineId: string;
    buyPrice: number;
    costPerBaseUnitExact?: ExactRational;
    updatedByUid: string;
  };
} {
  const operational: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(medicine)) {
    if (!CASHIER_FORBIDDEN_FIELD_KEYS.has(k)) {
      operational[k] = v;
    }
  }
  assertNoCashierForbiddenFields(operational, `medicines/${medicineId}`);

  const rawBuyPrice = Number(medicine.buyPrice ?? 0);
  if (!Number.isFinite(rawBuyPrice) || rawBuyPrice < 0) {
    throw new Error(`INVALID_BUY_PRICE:${medicine.buyPrice}`);
  }
  const baseUnitsPerPack = Number(medicine.baseUnitsPerPack ?? 1);
  const costPerBaseUnitExact =
    Number.isInteger(baseUnitsPerPack) && baseUnitsPerPack > 0
      ? divRational(rationalFromNumber(rawBuyPrice), normalizeRational(baseUnitsPerPack, 1))
      : undefined;

  return {
    operational,
    financial: {
      id: medicineId,
      branchId,
      medicineId,
      buyPrice: rawBuyPrice,
      ...(costPerBaseUnitExact ? { costPerBaseUnitExact } : {}),
      updatedByUid: actorUid,
    },
  };
}

// ============================================================================
// R3.2 Gap 2: Exact Historical Costing Semantics (10 Movement Categories)
// ============================================================================

export type R32MovementType =
  | 'INITIAL'
  | 'PURCHASE'
  | 'SALE'
  | 'RETURN'
  | 'PURCHASE_RETURN'
  | 'DAMAGE'
  | 'ADJUSTMENT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT';

export interface FifoCostLayer {
  layerId: string;
  remainingBaseUnits: number;
  costPerBaseUnitExact: ExactRational;
}

export interface MovementCostInput {
  movementId: string;
  medicineId: string;
  movementType: R32MovementType;
  baseUnitsDelta: number; // positive inbound, negative outbound
  quantityDelta: number;
  baseUnitsPerMovementUnit: number;
  explicitUnitCostExact?: ExactRational | null;
  supplierCreditPerBaseUnitExact?: ExactRational | null;
  originalSaleCostPerBaseUnitExact?: ExactRational | null;
  sourceReferenceId?: string;
}

export interface MovementCostResult {
  movementId: string;
  medicineId: string;
  movementType: Exclude<R32MovementType, 'TRANSFER_IN' | 'TRANSFER_OUT'>;
  costStatus: 'EXACT_RECONCILED' | 'NEEDS_REVIEW';
  costProvenanceType: string;
  costPerBaseUnitExact: ExactRational | null;
  costPerUnitExact: ExactRational | null;
  totalCostExact: ExactRational | null;
  purchaseReturnVarianceExact?: ExactRational | null;
  unresolvedBaseUnits: number;
  sourceReferenceId?: string;
  notes?: string;
  updatedLayers: FifoCostLayer[];
}

function cloneLayers(layers: readonly FifoCostLayer[]): FifoCostLayer[] {
  return layers.map((l) => ({
    layerId: l.layerId,
    remainingBaseUnits: l.remainingBaseUnits,
    costPerBaseUnitExact: { ...l.costPerBaseUnitExact },
  }));
}

function depleteFifo(
  layers: FifoCostLayer[],
  unitsNeeded: number
): {
  totalCost: ExactRational;
  consumedUnits: number;
  unresolvedUnits: number;
} {
  let remaining = unitsNeeded;
  let totalCost: ExactRational = { num: 0, den: 1 };
  let consumed = 0;

  for (const layer of layers) {
    if (remaining <= 0) break;
    if (layer.remainingBaseUnits <= 0) continue;
    const take = Math.min(layer.remainingBaseUnits, remaining);
    const layerCost = mulRational(
      layer.costPerBaseUnitExact,
      normalizeRational(take, 1)
    );
    totalCost = addRational(totalCost, layerCost);
    layer.remainingBaseUnits -= take;
    remaining -= take;
    consumed += take;
  }

  return {
    totalCost,
    consumedUnits: consumed,
    unresolvedUnits: remaining,
  };
}

/**
 * Deterministic exact rational historical costing resolver covering all 10 R3.2 categories:
 * 1. INITIAL (positive inbound, requires explicit opening cost or NEEDS_REVIEW)
 * 2. PURCHASE (positive inbound, exact invoice line cost per base unit)
 * 3. SALE (negative outbound, strict FIFO layer depletion — NEVER silently falls back to buyPrice)
 * 4. RETURN (positive customer return, exact original sale cost provenance or NEEDS_REVIEW)
 * 5. PURCHASE_RETURN (negative supplier return, FIFO cost vs supplier credit -> explicit purchaseReturnVarianceExact)
 * 6. DAMAGE (negative outbound, strict FIFO layer depletion)
 * 7. ADJUSTMENT (negative shortage -> FIFO depletion)
 * 8. ADJUSTMENT (positive overage -> explicit provenance cost or latest FIFO layer, else NEEDS_REVIEW)
 * 9. Missing/insufficient cost layers -> fail-closed NEEDS_REVIEW with unresolvedBaseUnits > 0
 * 10. TRANSFER_IN / TRANSFER_OUT -> hard-rejected (blocked until inter-branch transfer phase)
 */
export function resolveMovementHistoricalCost(
  input: MovementCostInput,
  currentLayers: readonly FifoCostLayer[]
): MovementCostResult {
  if (
    input.movementType === 'TRANSFER_IN' ||
    input.movementType === 'TRANSFER_OUT'
  ) {
    throw new Error(`BLOCKED_MOVEMENT_TYPE:${input.movementType}`);
  }

  const layers = cloneLayers(currentLayers);
  const absBase = Math.abs(input.baseUnitsDelta);
  const perUnitMul = normalizeRational(input.baseUnitsPerMovementUnit, 1);

  if (input.movementType === 'INITIAL' || input.movementType === 'PURCHASE') {
    if (input.baseUnitsDelta <= 0) {
      throw new Error(`INBOUND_MOVEMENT_MUST_BE_POSITIVE:${input.movementType}`);
    }
    if (!input.explicitUnitCostExact || input.explicitUnitCostExact.num < 0) {
      return {
        movementId: input.movementId,
        medicineId: input.medicineId,
        movementType: input.movementType,
        costStatus: 'NEEDS_REVIEW',
        costProvenanceType:
          input.movementType === 'INITIAL'
            ? 'INITIAL_MISSING_OPENING_COST'
            : 'PURCHASE_MISSING_INVOICE_COST',
        costPerBaseUnitExact: null,
        costPerUnitExact: null,
        totalCostExact: null,
        unresolvedBaseUnits: absBase,
        sourceReferenceId: input.sourceReferenceId,
        notes: 'Missing explicit inbound cost provenance; fail-closed NEEDS_REVIEW.',
        updatedLayers: layers,
      };
    }

    const costPerBase = divRational(input.explicitUnitCostExact, perUnitMul);
    const totalCost = mulRational(costPerBase, normalizeRational(absBase, 1));
    layers.push({
      layerId: input.movementId,
      remainingBaseUnits: absBase,
      costPerBaseUnitExact: costPerBase,
    });
    return {
      movementId: input.movementId,
      medicineId: input.medicineId,
      movementType: input.movementType,
      costStatus: 'EXACT_RECONCILED',
      costProvenanceType:
        input.movementType === 'INITIAL'
          ? 'OPENING_EXACT_COST'
          : 'PURCHASE_INVOICE_EXACT',
      costPerBaseUnitExact: costPerBase,
      costPerUnitExact: input.explicitUnitCostExact,
      totalCostExact: totalCost,
      unresolvedBaseUnits: 0,
      sourceReferenceId: input.sourceReferenceId,
      updatedLayers: layers,
    };
  }

  if (input.movementType === 'RETURN') {
    if (input.baseUnitsDelta <= 0) {
      throw new Error('CUSTOMER_RETURN_MUST_BE_POSITIVE');
    }
    if (!input.originalSaleCostPerBaseUnitExact) {
      return {
        movementId: input.movementId,
        medicineId: input.medicineId,
        movementType: 'RETURN',
        costStatus: 'NEEDS_REVIEW',
        costProvenanceType: 'CUSTOMER_RETURN_MISSING_SALE_COST',
        costPerBaseUnitExact: null,
        costPerUnitExact: null,
        totalCostExact: null,
        unresolvedBaseUnits: absBase,
        sourceReferenceId: input.sourceReferenceId,
        notes: 'Customer return lacks original sale historical cost provenance.',
        updatedLayers: layers,
      };
    }
    const costPerBase = normalizeRational(
      input.originalSaleCostPerBaseUnitExact.num,
      input.originalSaleCostPerBaseUnitExact.den
    );
    const costPerUnit = mulRational(costPerBase, perUnitMul);
    const totalCost = mulRational(costPerBase, normalizeRational(absBase, 1));
    layers.push({
      layerId: input.movementId,
      remainingBaseUnits: absBase,
      costPerBaseUnitExact: costPerBase,
    });
    return {
      movementId: input.movementId,
      medicineId: input.medicineId,
      movementType: 'RETURN',
      costStatus: 'EXACT_RECONCILED',
      costProvenanceType: 'CUSTOMER_RETURN_ORIGINAL_SALE_EXACT',
      costPerBaseUnitExact: costPerBase,
      costPerUnitExact: costPerUnit,
      totalCostExact: totalCost,
      unresolvedBaseUnits: 0,
      sourceReferenceId: input.sourceReferenceId,
      updatedLayers: layers,
    };
  }

  if (input.movementType === 'PURCHASE_RETURN') {
    if (input.baseUnitsDelta >= 0) {
      throw new Error('PURCHASE_RETURN_MUST_BE_NEGATIVE');
    }
    const depleted = depleteFifo(layers, absBase);
    if (depleted.unresolvedUnits > 0) {
      return {
        movementId: input.movementId,
        medicineId: input.medicineId,
        movementType: 'PURCHASE_RETURN',
        costStatus: 'NEEDS_REVIEW',
        costProvenanceType: 'PURCHASE_RETURN_INSUFFICIENT_FIFO_LAYERS',
        costPerBaseUnitExact: null,
        costPerUnitExact: null,
        totalCostExact: null,
        purchaseReturnVarianceExact: null,
        unresolvedBaseUnits: depleted.unresolvedUnits,
        sourceReferenceId: input.sourceReferenceId,
        notes: 'Insufficient FIFO inventory layers for supplier purchase return.',
        updatedLayers: layers,
      };
    }
    const avgCostPerBase = divRational(
      depleted.totalCost,
      normalizeRational(absBase, 1)
    );
    const avgCostPerUnit = mulRational(avgCostPerBase, perUnitMul);
    let variance: ExactRational = { num: 0, den: 1 };
    if (input.supplierCreditPerBaseUnitExact) {
      const creditTotal = mulRational(
        input.supplierCreditPerBaseUnitExact,
        normalizeRational(absBase, 1)
      );
      variance = subRational(creditTotal, depleted.totalCost);
    }
    return {
      movementId: input.movementId,
      medicineId: input.medicineId,
      movementType: 'PURCHASE_RETURN',
      costStatus: 'EXACT_RECONCILED',
      costProvenanceType: 'PURCHASE_RETURN_FIFO_WITH_VARIANCE',
      costPerBaseUnitExact: avgCostPerBase,
      costPerUnitExact: avgCostPerUnit,
      totalCostExact: depleted.totalCost,
      purchaseReturnVarianceExact: variance,
      unresolvedBaseUnits: 0,
      sourceReferenceId: input.sourceReferenceId,
      updatedLayers: layers,
    };
  }

  if (
    input.movementType === 'SALE' ||
    input.movementType === 'DAMAGE' ||
    (input.movementType === 'ADJUSTMENT' && input.baseUnitsDelta < 0)
  ) {
    if (input.baseUnitsDelta >= 0) {
      throw new Error(`OUTBOUND_MOVEMENT_MUST_BE_NEGATIVE:${input.movementType}`);
    }
    const depleted = depleteFifo(layers, absBase);
    if (depleted.unresolvedUnits > 0) {
      return {
        movementId: input.movementId,
        medicineId: input.medicineId,
        movementType: input.movementType,
        costStatus: 'NEEDS_REVIEW',
        costProvenanceType: `${input.movementType}_INSUFFICIENT_COST_LAYERS`,
        costPerBaseUnitExact: null,
        costPerUnitExact: null,
        totalCostExact: null,
        unresolvedBaseUnits: depleted.unresolvedUnits,
        sourceReferenceId: input.sourceReferenceId,
        notes: 'Insufficient FIFO historical cost layers; no silent buyPrice fallback permitted.',
        updatedLayers: layers,
      };
    }
    const avgCostPerBase = divRational(
      depleted.totalCost,
      normalizeRational(absBase, 1)
    );
    const avgCostPerUnit = mulRational(avgCostPerBase, perUnitMul);
    return {
      movementId: input.movementId,
      medicineId: input.medicineId,
      movementType: input.movementType,
      costStatus: 'EXACT_RECONCILED',
      costProvenanceType: `${input.movementType}_FIFO_EXACT`,
      costPerBaseUnitExact: avgCostPerBase,
      costPerUnitExact: avgCostPerUnit,
      totalCostExact: depleted.totalCost,
      unresolvedBaseUnits: 0,
      sourceReferenceId: input.sourceReferenceId,
      updatedLayers: layers,
    };
  }

  // Positive ADJUSTMENT (e.g., verified stocktake overage)
  if (input.movementType === 'ADJUSTMENT' && input.baseUnitsDelta > 0) {
    let costPerBase: ExactRational | null = null;
    let provenance = 'ADJUSTMENT_OVERAGE_EXPLICIT_PROVENANCE';
    if (input.explicitUnitCostExact) {
      costPerBase = divRational(input.explicitUnitCostExact, perUnitMul);
    } else {
      const latestActiveLayer = [...layers]
        .reverse()
        .find((l) => l.remainingBaseUnits > 0);
      if (latestActiveLayer) {
        costPerBase = { ...latestActiveLayer.costPerBaseUnitExact };
        provenance = 'ADJUSTMENT_OVERAGE_LATEST_LAYER_EXACT';
      }
    }
    if (!costPerBase) {
      return {
        movementId: input.movementId,
        medicineId: input.medicineId,
        movementType: 'ADJUSTMENT',
        costStatus: 'NEEDS_REVIEW',
        costProvenanceType: 'ADJUSTMENT_OVERAGE_NO_COST_PROVENANCE',
        costPerBaseUnitExact: null,
        costPerUnitExact: null,
        totalCostExact: null,
        unresolvedBaseUnits: absBase,
        sourceReferenceId: input.sourceReferenceId,
        notes: 'Positive adjustment has no explicit or active layer cost provenance.',
        updatedLayers: layers,
      };
    }
    const costPerUnit = mulRational(costPerBase, perUnitMul);
    const totalCost = mulRational(costPerBase, normalizeRational(absBase, 1));
    layers.push({
      layerId: input.movementId,
      remainingBaseUnits: absBase,
      costPerBaseUnitExact: costPerBase,
    });
    return {
      movementId: input.movementId,
      medicineId: input.medicineId,
      movementType: 'ADJUSTMENT',
      costStatus: 'EXACT_RECONCILED',
      costProvenanceType: provenance,
      costPerBaseUnitExact: costPerBase,
      costPerUnitExact: costPerUnit,
      totalCostExact: totalCost,
      unresolvedBaseUnits: 0,
      sourceReferenceId: input.sourceReferenceId,
      updatedLayers: layers,
    };
  }

  throw new Error(`UNHANDLED_MOVEMENT_COST_CASE:${input.movementType}:${input.baseUnitsDelta}`);
}

export type AppSecurityRole = 'super_admin' | 'admin' | 'cashier' | string;

export function isAdminSecurityRole(role: AppSecurityRole | null | undefined): boolean {
  return role === 'super_admin' || role === 'admin';
}

/**
 * F-01: Recursively strips all CASHIER_FORBIDDEN_FIELD_KEYS from operational records
 * before delivery to a cashier or unverified session.
 */
export function sanitizeMedicineForCashier<T extends Record<string, unknown>>(medicine: T): Omit<T, 'buyPrice' | 'buyPriceExact'> {
  if (!medicine || typeof medicine !== 'object') return medicine;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(medicine)) {
    if (CASHIER_FORBIDDEN_FIELD_KEYS.has(k)) continue;
    if (Array.isArray(v)) {
      cleaned[k] = v.map((item) =>
        item && typeof item === 'object' ? sanitizeMedicineForCashier(item as Record<string, unknown>) : item
      );
    } else if (v && typeof v === 'object') {
      cleaned[k] = sanitizeMedicineForCashier(v as Record<string, unknown>);
    } else {
      cleaned[k] = v;
    }
  }
  assertNoCashierForbiddenFields(cleaned, 'sanitizeMedicineForCashier');
  return cleaned as Omit<T, 'buyPrice' | 'buyPriceExact'>;
}

export interface RoleScopedOperationalSnapshotInput<TMed extends Record<string, unknown> = Record<string, unknown>> {
  role: AppSecurityRole | null | undefined;
  hasOnlineVerifiedAdmin: boolean;
  medicines: TMed[];
  suppliers?: unknown[];
  purchaseInvoices?: unknown[];
  supplierPayments?: unknown[];
  activeStocktakingSession?: unknown | null;
  stocktakingSessionsList?: unknown[];
}

export interface RoleScopedOperationalSnapshotResult<TMed extends Record<string, unknown> = Record<string, unknown>> {
  medicines: Array<Omit<TMed, 'buyPrice' | 'buyPriceExact'>>;
  suppliers: unknown[];
  purchaseInvoices: unknown[];
  supplierPayments: unknown[];
  activeStocktakingSession: unknown | null;
  stocktakingSessionsList: unknown[];
}

/**
 * F-01: Enforces role-scoped data loading boundary so cashiers never receive
 * medicine buyPrice, suppliers, purchaseInvoices, supplierPayments, or legacy
 * stocktaking financial archives in client application state.
 */
export function sanitizeOperationalSnapshotForRole<TMed extends Record<string, unknown> = Record<string, unknown>>(
  input: RoleScopedOperationalSnapshotInput<TMed>
): RoleScopedOperationalSnapshotResult<TMed> {
  const isVerifiedAdmin = isAdminSecurityRole(input.role) && input.hasOnlineVerifiedAdmin === true;
  if (isVerifiedAdmin) {
    return {
      medicines: Array.isArray(input.medicines) ? input.medicines : [],
      suppliers: Array.isArray(input.suppliers) ? input.suppliers : [],
      purchaseInvoices: Array.isArray(input.purchaseInvoices) ? input.purchaseInvoices : [],
      supplierPayments: Array.isArray(input.supplierPayments) ? input.supplierPayments : [],
      activeStocktakingSession: input.activeStocktakingSession ?? null,
      stocktakingSessionsList: Array.isArray(input.stocktakingSessionsList) ? input.stocktakingSessionsList : [],
    };
  }
  const sanitizedMeds = (Array.isArray(input.medicines) ? input.medicines : []).map((m) =>
    sanitizeMedicineForCashier(m)
  );
  for (const med of sanitizedMeds) {
    assertNoCashierForbiddenFields(med, 'cashierSnapshot.medicines');
  }
  return {
    medicines: sanitizedMeds,
    suppliers: [],
    purchaseInvoices: [],
    supplierPayments: [],
    activeStocktakingSession: null,
    stocktakingSessionsList: [],
  };
}

export interface HistoricalCostProvenanceVerificationInput {
  movementId: string;
  medicineId: string;
  movementType: MovementCostInput['movementType'];
  baseUnitsDelta: number;
  costStatus: 'EXACT_RECONCILED' | 'EXACT_HISTORICAL' | 'NEEDS_REVIEW';
  costProvenanceType: string;
  costPerBaseUnitExact: ExactRational | null;
  totalCostExact: ExactRational | null;
  unresolvedBaseUnits: number;
  movementHistoryVerified?: boolean;
  sourceReferenceId?: string;
}

/**
 * F-06: Independent server/service-grade verifier that rejects unverified client
 * claims of EXACT_RECONCILED / EXACT_HISTORICAL or movementHistoryVerified when
 * provenance, rational math, or movement completeness is missing or ambiguous.
 */
export function verifyHistoricalCostProvenanceAndEligibility(
  input: HistoricalCostProvenanceVerificationInput
): {
  eligibleForExactReconciliation: boolean;
  resolvedStatus: 'EXACT_RECONCILED' | 'NEEDS_REVIEW';
  rejectionReason?: string;
} {
  if (input.movementHistoryVerified === false) {
    return {
      eligibleForExactReconciliation: false,
      resolvedStatus: 'NEEDS_REVIEW',
      rejectionReason: 'MOVEMENT_HISTORY_UNVERIFIED',
    };
  }
  if (!Number.isSafeInteger(input.baseUnitsDelta) || input.baseUnitsDelta === 0) {
    return {
      eligibleForExactReconciliation: false,
      resolvedStatus: 'NEEDS_REVIEW',
      rejectionReason: 'INVALID_OR_ZERO_BASE_UNITS_DELTA',
    };
  }
  if (input.costStatus === 'NEEDS_REVIEW') {
    return {
      eligibleForExactReconciliation: false,
      resolvedStatus: 'NEEDS_REVIEW',
      rejectionReason: 'EXPLICIT_NEEDS_REVIEW_STATUS',
    };
  }
  if (!Number.isSafeInteger(input.unresolvedBaseUnits) || input.unresolvedBaseUnits > 0 || input.unresolvedBaseUnits < 0) {
    return {
      eligibleForExactReconciliation: false,
      resolvedStatus: 'NEEDS_REVIEW',
      rejectionReason: 'UNRESOLVED_BASE_UNITS_PRESENT',
    };
  }
  if (!input.costPerBaseUnitExact || !input.totalCostExact) {
    return {
      eligibleForExactReconciliation: false,
      resolvedStatus: 'NEEDS_REVIEW',
      rejectionReason: 'MISSING_RATIONAL_COST_FIELDS',
    };
  }
  let unitCost: ExactRational;
  let totalCost: ExactRational;
  try {
    unitCost = normalizeRational(input.costPerBaseUnitExact.num, input.costPerBaseUnitExact.den);
    totalCost = normalizeRational(input.totalCostExact.num, input.totalCostExact.den);
  } catch {
    return {
      eligibleForExactReconciliation: false,
      resolvedStatus: 'NEEDS_REVIEW',
      rejectionReason: 'INVALID_RATIONAL_COST_MAP',
    };
  }
  if (unitCost.num < 0 || unitCost.den <= 0 || totalCost.den <= 0) {
    return {
      eligibleForExactReconciliation: false,
      resolvedStatus: 'NEEDS_REVIEW',
      rejectionReason: 'NEGATIVE_UNIT_COST_FORBIDDEN',
    };
  }
  const absDelta = Math.abs(input.baseUnitsDelta);
  const expectedAbsTotal = mulRational(unitCost, normalizeRational(absDelta, 1));
  const actualAbsTotal = normalizeRational(Math.abs(totalCost.num), totalCost.den);
  if (compareRational(expectedAbsTotal, actualAbsTotal) !== 0) {
    return {
      eligibleForExactReconciliation: false,
      resolvedStatus: 'NEEDS_REVIEW',
      rejectionReason: 'COST_VALUATION_RATIONAL_MISMATCH',
    };
  }
  if (
    input.movementType === 'ADJUSTMENT' &&
    input.costProvenanceType === 'STOCKTAKE_V2_APPROVED_EXACT' &&
    (!input.sourceReferenceId || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.sourceReferenceId))
  ) {
    return {
      eligibleForExactReconciliation: false,
      resolvedStatus: 'NEEDS_REVIEW',
      rejectionReason: 'MISSING_STOCKTAKE_POSTING_PROVENANCE_REF',
    };
  }
  return {
    eligibleForExactReconciliation: true,
    resolvedStatus: 'EXACT_RECONCILED',
  };
}
