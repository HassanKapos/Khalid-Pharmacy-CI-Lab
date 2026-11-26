/** Pure unit-sale and operational trust policy shared by POS and IndexedDB transactions. */
export type MedicineUnitKind = 'pack' | 'strip' | 'pill';
export interface MedicineUnitPriceSource {
  sellPrice?: number;
  sellPriceStrip?: number;
  sellPricePill?: number;
  sellPack?: boolean;
  sellStrip?: boolean;
  sellPill?: boolean;
  stripsPerPack?: number;
  pillsPerStrip?: number;
  configStatus?: string;
  unitMigrationStatus?: string;
  unitOperationalAllowed?: boolean;
  baseUnitsPerPack?: number;
  unitDefinition?: {
    configStatus?: string;
    baseUnitsPerPack?: number;
    baseUnit?: string;
    hierarchy?: { kind?: string; baseUnitsPerPack?: number };
  };
}

/**
 * PR-2E fail-closed operational gate.
 * A medicine may participate in stock/sales/purchase mutations only after an
 * explicit VERIFIED decision is persisted at both the medicine and definition
 * levels. Legacy assumed factors and quarantine states are never operational.
 */
export function getMedicineOperationalBlockReason(medicine: MedicineUnitPriceSource): string | null {
  if (!medicine || typeof medicine !== 'object') return 'MEDICINE_OPERATIONAL_STATE_MISSING';
  if (medicine.unitOperationalAllowed !== true) return 'MEDICINE_NOT_OPERATIONALLY_VERIFIED';
  if (medicine.configStatus !== 'VERIFIED') return 'MEDICINE_CONFIGURATION_NOT_VERIFIED';
  if (!medicine.unitDefinition || medicine.unitDefinition.configStatus !== 'VERIFIED') {
    return 'MEDICINE_UNIT_DEFINITION_NOT_VERIFIED';
  }
  if (medicine.unitMigrationStatus === 'QUARANTINED' || medicine.unitMigrationStatus === 'CONFLICTED') {
    return 'MEDICINE_QUARANTINED';
  }
  return null;
}


/** Resolve the only supported stock conversion from a structurally verified unit definition. */
export function getMedicineBaseUnitsPerPack(medicine: MedicineUnitPriceSource): number {
  const hierarchy = medicine.unitDefinition?.hierarchy;
  if (hierarchy?.kind === 'DIRECT_PACK') {
    const nested = Number(hierarchy.baseUnitsPerPack);
    const definition = Number(medicine.unitDefinition?.baseUnitsPerPack);
    const topLevel = Number(medicine.baseUnitsPerPack);
    if (medicine.configStatus !== 'VERIFIED' || medicine.unitOperationalAllowed !== true ||
        medicine.unitDefinition?.configStatus !== 'VERIFIED' ||
        !Number.isSafeInteger(nested) || nested <= 0 || definition !== nested || topLevel !== nested) {
      throw new Error('DIRECT_PACK_DEFINITION_MISMATCH: verified baseUnitsPerPack is required');
    }
    return nested;
  }
  const strips = Number(medicine.stripsPerPack);
  const pills = Number(medicine.pillsPerStrip);
  if (!Number.isSafeInteger(strips) || strips <= 0 || !Number.isSafeInteger(pills) || pills <= 0) {
    throw new Error('بيانات تحويل العبوة أو الشريط غير موثقة؛ يمنع افتراض 2×10');
  }
  const total = strips * pills;
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('PACK_CONVERSION_OUT_OF_RANGE');
  return total;
}

export function isDirectPackMedicine(medicine: MedicineUnitPriceSource): boolean {
  return medicine.unitDefinition?.hierarchy?.kind === 'DIRECT_PACK';
}

/** DIRECT_PACK medicines sell as whole packs only; partial sale needs a future explicit base-unit SKU. */
export function convertMedicineQuantityToBaseUnits(
  quantity: number,
  unit: MedicineUnitKind,
  medicine: MedicineUnitPriceSource
): number {
  if (!Number.isSafeInteger(quantity) || quantity === 0) throw new Error('INVALID_MEDICINE_QUANTITY');
  const perPack = getMedicineBaseUnitsPerPack(medicine);
  if (isDirectPackMedicine(medicine)) {
    if (unit !== 'pack') throw new Error('DIRECT_PACK_PARTIAL_SALE_UNSUPPORTED');
    const result = quantity * perPack;
    if (!Number.isSafeInteger(result)) throw new Error('DIRECT_PACK_QUANTITY_OUT_OF_RANGE');
    return result;
  }
  const result = unit === 'pack' ? quantity * perPack : unit === 'strip' ? quantity * Number(medicine.pillsPerStrip) : quantity;
  if (!Number.isSafeInteger(result)) throw new Error('MEDICINE_QUANTITY_OUT_OF_RANGE');
  return result;
}

export function formatMedicineStockBreakdown(totalBaseUnits: number, medicine: MedicineUnitPriceSource): string {
  if (!Number.isSafeInteger(totalBaseUnits)) throw new Error('INVALID_BASE_STOCK');
  if (totalBaseUnits <= 0) return '0';
  const perPack = getMedicineBaseUnitsPerPack(medicine);
  if (isDirectPackMedicine(medicine)) {
    const packs = Math.floor(totalBaseUnits / perPack);
    const remainder = totalBaseUnits % perPack;
    const baseUnit = String(medicine.unitDefinition?.baseUnit || 'وحدة أساسية');
    return [packs > 0 ? `${packs} عبوة` : '', remainder > 0 ? `${remainder} ${baseUnit}` : '']
      .filter(Boolean).join(' و ') || '0';
  }
  const strips = Number(medicine.stripsPerPack);
  const pills = Number(medicine.pillsPerStrip);
  const packs = Math.floor(totalBaseUnits / perPack);
  const remainder = totalBaseUnits % perPack;
  const stripCount = Math.floor(remainder / pills);
  const pillCount = remainder % pills;
  return [packs > 0 ? `${packs} علبة` : '', stripCount > 0 ? `${stripCount} شريط` : '', pillCount > 0 ? `${pillCount} حبة` : '']
    .filter(Boolean).join(' و ') || '0';
}

/** Throw a stable machine-readable error when the medicine has not passed review. */
export function assertMedicineOperationallyAllowed(medicine: MedicineUnitPriceSource): void {
  const reason = getMedicineOperationalBlockReason(medicine);
  if (reason) throw new Error(`MEDICINE_OPERATION_BLOCKED:${reason}`);
}

/** Partial-unit sales require explicit conversion factors; never assume 2×10. */
export function isMedicineUnitSellable(medicine: MedicineUnitPriceSource, unit: MedicineUnitKind): boolean {
  if (isDirectPackMedicine(medicine)) return unit === 'pack' && medicine.sellPack !== false;
  if (unit === 'pack') return medicine.sellPack !== false;
  if (unit === 'strip') return medicine.sellStrip === true;
  if (unit === 'pill') return medicine.sellPill === true;
  return false;
}

export function getMedicineUnitSellingPrice(medicine: MedicineUnitPriceSource, unit: MedicineUnitKind): number {
  const packPrice = Number(medicine.sellPrice);
  if (!Number.isSafeInteger(packPrice) || packPrice < 0) throw new Error('سعر البيع المسجل يجب أن يكون عدداً صحيحاً آمناً');
  if (unit === 'pack') return packPrice;
  if (isDirectPackMedicine(medicine)) throw new Error('DIRECT_PACK_PARTIAL_SALE_UNSUPPORTED');
  const strips = Number(medicine.stripsPerPack);
  const pills = Number(medicine.pillsPerStrip);
  if (!Number.isSafeInteger(strips) || strips <= 0 || !Number.isSafeInteger(pills) || pills <= 0) {
    throw new Error('بيانات تحويل العبوة أو الشريط غير موثقة؛ يمنع افتراض 2×10');
  }
  const explicit = unit === 'strip' ? medicine.sellPriceStrip : medicine.sellPricePill;
  if (explicit === undefined || explicit === null || !Number.isSafeInteger(Number(explicit)) || Number(explicit) < 0) {
    throw new Error(`سعر وحدة ${unit === 'strip' ? 'الشريط' : 'الحبة'} يجب أن يكون عدداً صحيحاً آمناً`);
  }
  return Number(explicit);
}

/** Validate persisted unit flags and the pill→strip→pack price ladder. */
export function validateMedicineUnitConfiguration(medicine: MedicineUnitPriceSource): void {
  if (!medicine.sellPack && !medicine.sellStrip && !medicine.sellPill) {
    throw new Error('يجب السماح ببيع وحدة واحدة على الأقل لهذا الدواء');
  }
  const hasCompletePriceLadder =
    medicine.sellPrice !== undefined && medicine.sellPrice !== null &&
    medicine.sellPriceStrip !== undefined && medicine.sellPriceStrip !== null &&
    medicine.sellPricePill !== undefined && medicine.sellPricePill !== null;
  if (isDirectPackMedicine(medicine)) {
    getMedicineBaseUnitsPerPack(medicine);
    if (medicine.sellStrip === true || medicine.sellPill === true ||
        medicine.sellPriceStrip != null || medicine.sellPricePill != null) {
      throw new Error('DIRECT_PACK_FORBIDS_STRIP_AND_PILL_SALE');
    }
    const packPrice = Number(medicine.sellPrice);
    if (!Number.isSafeInteger(packPrice) || packPrice < 0) throw new Error('DIRECT_PACK_INVALID_PACK_PRICE');
    return;
  }
  if (!medicine.sellStrip && !medicine.sellPill && !hasCompletePriceLadder) return;
  const strips = Number(medicine.stripsPerPack);
  const pills = Number(medicine.pillsPerStrip);
  if (!Number.isSafeInteger(strips) || strips <= 0 || !Number.isSafeInteger(pills) || pills <= 0) {
    throw new Error('لا يمكن تفعيل البيع الجزئي دون أعداد تحويل موثقة وصحيحة');
  }
  const stripPrice = Number(medicine.sellPriceStrip);
  const pillPrice = Number(medicine.sellPricePill);
  const packPrice = Number(medicine.sellPrice);
  if (![stripPrice, pillPrice, packPrice].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('يجب أن تكون أسعار العبوة والشريط والحبة أعداداً صحيحة آمنة');
  }
  const pillPriceBig = BigInt(pillPrice);
  const stripPriceBig = BigInt(stripPrice);
  const packPriceBig = BigInt(packPrice);
  if (pillPriceBig * BigInt(pills) !== stripPriceBig ||
      stripPriceBig * BigInt(strips) !== packPriceBig) {
    throw new Error('أسعار العبوة والشريط والحبة غير متطابقة بالقسمة الصحيحة؛ أعد اعتماد مقترح التسعير');
  }
}
