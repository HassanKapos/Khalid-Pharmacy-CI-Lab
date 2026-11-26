import { Timestamp, serverTimestamp as firestoreServerTimestamp } from 'firebase/firestore';
import {
  buildCanonicalFirestoreDocumentPath,
  buildOutboxDependencyIndex,
  deriveSupplierPaymentReversalId,
  getCanonicalOutboxOperationId,
  isValidFirebaseActorUid,
  type OutboxDependencyIndex,
  type OutboxEntityType,
  type OutboxEntry,
} from './pharmacyDb';

const FIRESTORE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

const RESERVED_LEDGER_USER_PLACEHOLDERS = new Set([
  'admin',
  'super_admin',
  'superadmin',
  'cashier',
  'system',
  'unknown',
  'guest',
  'owner',
  'user',
  'root',
  'none',
  'null',
  'undefined',
  'anonymous',
  'المسؤول',
  'كاشير',
  'النظام',
  'صيدلي مسؤول',
]);

const VALID_MOVEMENT_TYPES = new Set([
  'INITIAL',
  'SALE',
  'PURCHASE',
  'RETURN',
  'DAMAGE',
  'ADJUSTMENT',
]);

const VALID_UNIT_KINDS = new Set(['pack', 'strip', 'pill']);
const VALID_PAYMENT_METHODS = new Set(['Cash', 'Card', 'Bankak']);
const VALID_SUPPLIER_STATUSES = new Set(['active', 'inactive', 'archived']);
const VALID_SUPPLIER_TX_TYPES = new Set([
  'PURCHASE_INVOICE',
  'PAYMENT',
  'RETURN',
  'OPENING_BALANCE',
  'ADJUSTMENT',
]);
const VALID_SUPPLIER_TX_PAYMENT_METHODS = new Set(['Cash', 'Bankak', 'Check', 'Transfer']);
const VALID_PURCHASE_PAYMENT_TYPES = new Set(['Cash', 'Credit', 'Bankak', 'Partial']);
const VALID_PURCHASE_PAYMENT_STATUSES = new Set(['Paid', 'Partial', 'Unpaid']);
const DEFAULT_CATEGORIES_LOWER = new Set(['antibiotics', 'analgesics', 'chronic', 'vitamins']);
const VALID_STOCKTAKING_CREATE_STATUSES = new Set(['active', 'in_progress', 'reviewing']);
const VALID_STOCKTAKING_OPEN_UPDATE_STATUSES = new Set([
  'active',
  'in_progress',
  'reviewing',
  'syncing_adjustments',
]);
const VALID_STOCKTAKING_UPDATE_TARGET_STATUSES = new Set([
  'active',
  'in_progress',
  'reviewing',
  'syncing_adjustments',
  'sync_completed_unverified',
  'cancelled',
]);
const FORBIDDEN_STOCKTAKING_STATUSES = new Set([
  'committed',
  'COMMITTED',
  'server_verified',
  'accounting_committed',
]);
const VALID_CLIENT_ACCOUNTING_STATUSES = new Set([
  'open',
  'unverified_client_sync',
  'cancelled',
]);

export interface FirestoreTimestampFactory {
  serverTimestamp: () => unknown;
  fromIsoDate?: (isoString: string) => unknown;
}

export interface NormalizeOutboxEntryContext {
  actorUid: string;
  branchId?: string;
  allOutboxEntries?: OutboxEntry[];
  timestampFactory?: FirestoreTimestampFactory;
  resolveSaleForLedger?: (entry: OutboxEntry) => { saleId: string; invoiceNumber?: string } | null;
  /** Optional Medicine Firestore DTO schema version. Defaults to 1 (V1 compatibility); set to 2 for Spark V2 DIRECT_PACK + SOLID_TWO_LEVEL DTO. */
  medicineSchemaVersion?: 1 | 2;
}

export type NormalizationFailureCode =
  | 'INVALID_OUTBOX_ENTRY'
  | 'INVALID_FIRESTORE_ID'
  | 'BRANCH_ID_MISMATCH'
  | 'ACTOR_UID_MISSING_OR_MISMATCH'
  | 'IMMUTABLE_ENTITY_OPERATION'
  | 'DEFERRED_TO_3B2B3_STOCKTAKING'
  | 'DEFERRED_TO_BANKAK_SCHEMA_HARMONIZATION'
  | 'MEDICINE_SYNC_DEFERRED_QUARANTINED_PACKING'
  | 'MEDICINE_SYNC_DEFERRED_DIRECT_PACK_REQUIRES_V2_SCHEMA'
  | 'MEDICINE_SYNC_DEFERRED_UNVERIFIED_PACKING'
  | 'MEDICINE_SYNC_DEFERRED_UNKNOWN_PACKING'
  | 'MISSING_SALE_PARENT_FOR_LEDGER'
  | 'REVERSAL_ID_MISMATCH'
  | 'INVALID_SECONDARY_BARCODES'
  | 'SCHEMA_VALIDATION_ERROR';

export interface NormalizedFirestoreWritePlan {
  ok: true;
  op: 'set' | 'update' | 'delete';
  entityType: OutboxEntityType;
  entityId: string;
  branchId: string;
  documentPath: string;
  data: Record<string, unknown>;
}

export interface NormalizedFirestoreFailure {
  ok: false;
  code: NormalizationFailureCode;
  retryable: false;
  deferred?: boolean;
  message: string;
}

export type NormalizeOutboxEntryResult =
  | NormalizedFirestoreWritePlan
  | NormalizedFirestoreFailure;

export function isValidFirestoreDocumentId(val: unknown): val is string {
  return typeof val === 'string' && FIRESTORE_ID_REGEX.test(val);
}

function fail(
  code: NormalizationFailureCode,
  message: string,
  extra?: { deferred?: boolean }
): NormalizedFirestoreFailure {
  return {
    ok: false,
    code,
    retryable: false,
    ...(extra?.deferred ? { deferred: true } : {}),
    message,
  };
}

function getTimestampFactory(factory?: FirestoreTimestampFactory): Required<FirestoreTimestampFactory> {
  return {
    serverTimestamp: factory?.serverTimestamp ?? firestoreServerTimestamp,
    fromIsoDate:
      factory?.fromIsoDate ??
      ((iso: string) => Timestamp.fromDate(new Date(iso))),
  };
}

function parseTimestampValue(
  raw: unknown,
  tsFactory: Required<FirestoreTimestampFactory>
): { valid: boolean; present: boolean; value: unknown } {
  if (raw === undefined) {
    return { valid: true, present: false, value: undefined };
  }
  if (raw === null) {
    return { valid: true, present: true, value: null };
  }
  if (raw instanceof Date) {
    if (!Number.isFinite(raw.getTime())) {
      return { valid: false, present: true, value: null };
    }
    return { valid: true, present: true, value: tsFactory.fromIsoDate(raw.toISOString()) };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { valid: true, present: true, value: null };
    }
    const parsedMs = Date.parse(trimmed);
    if (!Number.isFinite(parsedMs)) {
      return { valid: false, present: true, value: null };
    }
    return { valid: true, present: true, value: tsFactory.fromIsoDate(trimmed) };
  }
  if (typeof raw === 'object') {
    const candidate = raw as { seconds?: unknown; nanoseconds?: unknown; toDate?: unknown };
    if (
      typeof candidate.toDate === 'function' ||
      (typeof candidate.seconds === 'number' && typeof candidate.nanoseconds === 'number')
    ) {
      return { valid: true, present: true, value: raw };
    }
  }
  return { valid: false, present: true, value: null };
}

function stripUndefinedDeep(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || value instanceof Timestamp) return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => stripUndefinedDeep(item))
      .filter((item) => item !== undefined);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    // Preserve custom sentinel / Timestamp objects returned by factories
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const cleaned = stripUndefinedDeep(v);
    if (cleaned !== undefined) {
      out[k] = cleaned;
    }
  }
  return out;
}

function parseStrictFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function validateBoundedString(
  raw: unknown,
  fieldName: string,
  minLen: number,
  maxLen: number,
  options?: { trim?: boolean }
): { ok: true; value: string } | { ok: false; failure: NormalizedFirestoreFailure } {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      failure: fail('SCHEMA_VALIDATION_ERROR', `${fieldName} must be a string.`),
    };
  }
  if (raw.length > maxLen) {
    return {
      ok: false,
      failure: fail(
        'SCHEMA_VALIDATION_ERROR',
        `${fieldName} exceeds maximum length of ${maxLen} characters (got ${raw.length}).`
      ),
    };
  }
  const value = options?.trim ? raw.trim() : raw;
  if (value.length < minLen) {
    return {
      ok: false,
      failure: fail(
        'SCHEMA_VALIDATION_ERROR',
        `${fieldName} must be at least ${minLen} characters (got ${value.length}).`
      ),
    };
  }
  if (value.length > maxLen) {
    return {
      ok: false,
      failure: fail(
        'SCHEMA_VALIDATION_ERROR',
        `${fieldName} exceeds maximum length of ${maxLen} characters (got ${value.length}).`
      ),
    };
  }
  return { ok: true, value };
}

function validateSecondaryBarcodesForRules(
  raw: unknown
): { ok: true; value: string[] } | { ok: false; failure: NormalizedFirestoreFailure } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      failure: fail('INVALID_SECONDARY_BARCODES', 'Medicine secondaryBarcodes must be an array.'),
    };
  }
  if (raw.length > 20) {
    return {
      ok: false,
      failure: fail(
        'INVALID_SECONDARY_BARCODES',
        `Medicine secondaryBarcodes exceeds maximum of 20 items (got ${raw.length}).`
      ),
    };
  }
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'string') {
      return {
        ok: false,
        failure: fail(
          'INVALID_SECONDARY_BARCODES',
          `Medicine secondaryBarcodes[${i}] must be a non-empty string.`
        ),
      };
    }
    if (item.length < 1 || item.trim().length < 1 || item !== item.trim()) {
      return {
        ok: false,
        failure: fail(
          'INVALID_SECONDARY_BARCODES',
          `Medicine secondaryBarcodes[${i}] cannot be empty or contain leading/trailing whitespace.`
        ),
      };
    }
    if (item.length > 64) {
      return {
        ok: false,
        failure: fail(
          'INVALID_SECONDARY_BARCODES',
          `Medicine secondaryBarcodes[${i}] exceeds maximum length of 64 characters (got ${item.length}).`
        ),
      };
    }
  }
  return { ok: true, value: [...raw] };
}

function isValidCategoryNameForRules(val: unknown): val is string {
  if (typeof val !== 'string') return false;
  if (val.length < 1 || val.length > 80) return false;
  if (val.trim() !== val) return false;
  if (/[/\r\n\t]/.test(val)) return false;
  if (val === '.' || val === '..') return false;
  if (/^__.*__$/.test(val)) return false;
  return true;
}

function normalizeMedicineEntry(
  entry: OutboxEntry,
  branchId: string,
  actorUid: string,
  documentPath: string,
  tsFactory: Required<FirestoreTimestampFactory>,
  medicineSchemaVersion: 1 | 2 = 1
): NormalizeOutboxEntryResult {
  if (entry.action === 'DELETE') {
    return fail(
      'IMMUTABLE_ENTITY_OPERATION',
      'Deleting medicine documents is prohibited by firestore.rules; use archived update instead.'
    );
  }
  if (entry.action !== 'CREATE' && entry.action !== 'UPDATE') {
    return fail('INVALID_OUTBOX_ENTRY', `Unsupported medicine action "${String(entry.action)}"`);
  }

  const p = entry.payload && typeof entry.payload === 'object' ? (entry.payload as Record<string, any>) : null;
  if (!p) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Medicine payload must be a non-null object.');
  }
  if (p.id !== undefined && String(p.id).trim() !== entry.entityId) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Medicine payload.id (${String(p.id)}) mismatches entityId (${entry.entityId}).`
    );
  }

  if (p.unitMigrationStatus === 'QUARANTINED' || p.unitMigrationStatus === 'CONFLICTED') {
    return fail(
      'MEDICINE_SYNC_DEFERRED_QUARANTINED_PACKING',
      `Medicine sync deferred: unitMigrationStatus is ${String(p.unitMigrationStatus)}.`,
      { deferred: true }
    );
  }

  const isDirectPackDosageForm =
    typeof p.dosageForm === 'string' &&
    [
      'Syrup',
      'Suspension',
      'Drops',
      'InjectionVial',
      'Ampoule',
      'Cream',
      'Ointment',
      'Gel',
      'Inhaler',
      'Suppository',
      'Sachet',
    ].includes(p.dosageForm.trim());

  const isDirectPack =
    p.unitDefinition?.mode === 'DIRECT_PACK' ||
    p.unitDefinition?.hierarchy?.kind === 'DIRECT_PACK' ||
    isDirectPackDosageForm;

  if (isDirectPack && medicineSchemaVersion !== 2) {
    return fail(
      'MEDICINE_SYNC_DEFERRED_DIRECT_PACK_REQUIRES_V2_SCHEMA',
      'Medicine sync deferred: DIRECT_PACK medicines require V2 Firestore schema and cannot be synced via V1 strips/pills fields.',
      { deferred: true }
    );
  }

  if (medicineSchemaVersion === 2) {
    if (
      p.unitOperationalAllowed === false ||
      (typeof p.configStatus === 'string' && p.configStatus.trim() !== '' && p.configStatus !== 'VERIFIED') ||
      (typeof p.unitDefinition?.configStatus === 'string' &&
        p.unitDefinition.configStatus.trim() !== '' &&
        p.unitDefinition.configStatus !== 'VERIFIED') ||
      (typeof p.unitDefinition?.verificationState === 'string' &&
        p.unitDefinition.verificationState.trim() !== '' &&
        p.unitDefinition.verificationState !== 'VERIFIED')
    ) {
      return fail(
        'MEDICINE_SYNC_DEFERRED_UNVERIFIED_PACKING',
        'Medicine V2 sync deferred: packing configuration is not verified for operational sync.',
        { deferred: true }
      );
    }

    const nameResV2 = validateBoundedString(p.name, 'medicine.name', 1, 200, { trim: true });
    if (!nameResV2.ok) return nameResV2.failure;
    const buyPriceV2 = parseStrictFiniteNumber(p.buyPrice);
    const sellPriceV2 = parseStrictFiniteNumber(p.sellPrice);
    if (buyPriceV2 === null || buyPriceV2 < 0) return fail('SCHEMA_VALIDATION_ERROR', 'Medicine buyPrice must be finite >= 0.');
    if (sellPriceV2 === null || sellPriceV2 < 0) return fail('SCHEMA_VALIDATION_ERROR', 'Medicine sellPrice must be finite >= 0.');

    const dosageFormV2 = String(p.dosageForm || p.unitDefinition?.dosageForm || '').trim();
    if (dosageFormV2 === 'Unknown') {
      return fail('SCHEMA_VALIDATION_ERROR', 'Medicine V2 dosageForm cannot be Unknown.');
    }

    const v2Data: Record<string, unknown> = {
      name: nameResV2.value,
      buyPrice: buyPriceV2,
      sellPrice: sellPriceV2,
      barcode: typeof p.barcode === 'string' ? p.barcode.slice(0, 64) : '',
      category: typeof p.category === 'string' ? p.category.slice(0, 80) : 'General',
      minStock: typeof p.minStock === 'number' && Number.isFinite(p.minStock) && p.minStock >= 0 ? p.minStock : 0,
      sellPack: p.sellPack !== false,
      unitType: 'pack',
      archived: Boolean(p.archived),
      packingLocked: Boolean(p.packingLocked),
      unitMigrationStatus: p.unitMigrationStatus === 'NATIVE_V2' ? 'NATIVE_V2' : 'VERIFIED',
      configStatus: 'VERIFIED',
      unitSchemaVersion: 2,
      syncVersion: typeof p.syncVersion === 'number' && Number.isSafeInteger(p.syncVersion) && p.syncVersion >= 1 ? p.syncVersion : 1,
      updatedAt: tsFactory.serverTimestamp(),
    };

    if (isDirectPack) {
      if (p.stripsPerPack !== undefined && p.stripsPerPack !== null && p.stripsPerPack !== '') {
        return fail('SCHEMA_VALIDATION_ERROR', 'DIRECT_PACK V2 medicine must omit stripsPerPack.');
      }
      if (p.pillsPerStrip !== undefined && p.pillsPerStrip !== null && p.pillsPerStrip !== '') {
        return fail('SCHEMA_VALIDATION_ERROR', 'DIRECT_PACK V2 medicine must omit pillsPerStrip.');
      }
      if (p.sellStrip === true || p.sellPill === true) {
        return fail('SCHEMA_VALIDATION_ERROR', 'DIRECT_PACK V2 medicine cannot enable sellStrip or sellPill.');
      }
      const bupp = Number(p.unitDefinition?.baseUnitsPerPack ?? p.unitDefinition?.hierarchy?.baseUnitsPerPack ?? p.baseUnitsPerPack ?? 1);
      if (!Number.isSafeInteger(bupp) || bupp < 1 || bupp > 100000) {
        return fail('SCHEMA_VALIDATION_ERROR', 'DIRECT_PACK V2 medicine requires positive integer baseUnitsPerPack.');
      }
      const df = (dosageFormV2 || 'Liquid').slice(0, 48);
      const label = String(p.baseUnitLabel || p.unitDefinition?.baseUnitLabel || 'unit').trim().slice(0, 32) || 'unit';
      v2Data.sellStrip = false;
      v2Data.sellPill = false;
      v2Data.dosageForm = df;
      v2Data.baseUnitLabel = label;
      v2Data.baseUnitsPerPack = bupp;
      v2Data.unitDefinition = {
        mode: 'DIRECT_PACK',
        dosageForm: df,
        baseUnitLabel: label,
        baseUnitsPerPack: bupp,
        verificationState: 'VERIFIED',
      };
    } else {
      if (p.stripsPerPack === 0 && p.pillsPerStrip === 0) {
        return fail('MEDICINE_SYNC_DEFERRED_UNKNOWN_PACKING', 'Medicine V2 sync deferred: 0/0 unknown packing.', { deferred: true });
      }
      const sp = Number(p.stripsPerPack ?? p.unitDefinition?.stripsPerPack ?? p.unitDefinition?.hierarchy?.stripsPerPack);
      const pp = Number(p.pillsPerStrip ?? p.unitDefinition?.pillsPerStrip ?? p.unitDefinition?.hierarchy?.pillsPerStrip);
      if (!Number.isSafeInteger(sp) || sp < 1 || !Number.isSafeInteger(pp) || pp < 1) {
        return fail('SCHEMA_VALIDATION_ERROR', 'SOLID_TWO_LEVEL V2 medicine requires positive integer stripsPerPack and pillsPerStrip.');
      }
      const bupp = sp * pp;
      if (p.baseUnitsPerPack !== undefined && p.baseUnitsPerPack !== null && Number(p.baseUnitsPerPack) !== bupp) {
        return fail('SCHEMA_VALIDATION_ERROR', 'SOLID_TWO_LEVEL V2 baseUnitsPerPack parity mismatch.');
      }
      const df = (dosageFormV2 || 'Tablet').slice(0, 48);
      const label = String(p.baseUnitLabel || p.unitDefinition?.baseUnitLabel || 'pill').trim().slice(0, 32) || 'pill';
      v2Data.sellStrip = Boolean(p.sellStrip);
      v2Data.sellPill = Boolean(p.sellPill);
      v2Data.dosageForm = df;
      v2Data.baseUnitLabel = label;
      v2Data.baseUnitsPerPack = bupp;
      v2Data.stripsPerPack = sp;
      v2Data.pillsPerStrip = pp;
      v2Data.unitDefinition = {
        mode: 'SOLID_TWO_LEVEL',
        dosageForm: df,
        baseUnitLabel: label,
        baseUnitsPerPack: bupp,
        stripsPerPack: sp,
        pillsPerStrip: pp,
        verificationState: 'VERIFIED',
      };
    }

    if (entry.action === 'CREATE') {
      v2Data.id = entry.entityId;
      v2Data.branchId = branchId;
      v2Data.createdAt = tsFactory.serverTimestamp();
      if (p.openingStockEvidence && typeof p.openingStockEvidence === 'object') {
        v2Data.openingStockEvidence = p.openingStockEvidence;
      }
      return {
        ok: true,
        op: 'set',
        entityType: 'medicine',
        entityId: entry.entityId,
        branchId,
        documentPath,
        data: v2Data,
      };
    }

    return {
      ok: true,
      op: 'update',
      entityType: 'medicine',
      entityId: entry.entityId,
      branchId,
      documentPath,
      data: v2Data,
    };
  }

  if (
    p.unitOperationalAllowed === false ||
    (typeof p.configStatus === 'string' && p.configStatus.trim() !== '' && p.configStatus !== 'VERIFIED') ||
    (typeof p.unitDefinition?.configStatus === 'string' &&
      p.unitDefinition.configStatus.trim() !== '' &&
      p.unitDefinition.configStatus !== 'VERIFIED')
  ) {
    return fail(
      'MEDICINE_SYNC_DEFERRED_UNVERIFIED_PACKING',
      'Medicine sync deferred: packing configuration is not verified for operational sync.',
      { deferred: true }
    );
  }

  if (p.stripsPerPack === 0 && p.pillsPerStrip === 0) {
    return fail(
      'MEDICINE_SYNC_DEFERRED_UNKNOWN_PACKING',
      'Medicine sync deferred: stripsPerPack and pillsPerStrip are unknown (0/0); sync requires verified positive integers (>= 1).',
      { deferred: true }
    );
  }

  const nameRes = validateBoundedString(p.name, 'medicine.name', 1, 200, { trim: true });
  if (!nameRes.ok) return nameRes.failure;

  const buyPrice = parseStrictFiniteNumber(p.buyPrice);
  const sellPrice = parseStrictFiniteNumber(p.sellPrice);
  if (buyPrice === null || buyPrice < 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Medicine buyPrice must be a finite number >= 0.');
  }
  if (sellPrice === null || sellPrice < 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Medicine sellPrice must be a finite number >= 0.');
  }

  const mutable: Record<string, unknown> = {
    name: nameRes.value,
    buyPrice,
    sellPrice,
  };

  if (p.barcode !== undefined) {
    const barcodeRes = validateBoundedString(p.barcode, 'medicine.barcode', 0, 64);
    if (!barcodeRes.ok) return barcodeRes.failure;
    mutable.barcode = barcodeRes.value;
  } else if (entry.action === 'CREATE') {
    mutable.barcode = '';
  }

  if (p.category !== undefined) {
    const categoryRes = validateBoundedString(p.category, 'medicine.category', 0, 80);
    if (!categoryRes.ok) return categoryRes.failure;
    mutable.category = categoryRes.value;
  }

  if (p.minStock !== undefined) {
    const minStock = parseStrictFiniteNumber(p.minStock);
    if (minStock === null || minStock < 0) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Medicine minStock must be a finite number >= 0.');
    }
    mutable.minStock = minStock;
  }

  if (p.sellPriceStrip !== undefined) {
    if (p.sellPriceStrip === null) {
      mutable.sellPriceStrip = null;
    } else {
      const stripPrice = parseStrictFiniteNumber(p.sellPriceStrip);
      if (stripPrice === null || stripPrice < 0) {
        return fail('SCHEMA_VALIDATION_ERROR', 'Medicine sellPriceStrip must be null or finite >= 0.');
      }
      mutable.sellPriceStrip = stripPrice;
    }
  }

  if (p.sellPricePill !== undefined) {
    if (p.sellPricePill === null) {
      mutable.sellPricePill = null;
    } else {
      const pillPrice = parseStrictFiniteNumber(p.sellPricePill);
      if (pillPrice === null || pillPrice < 0) {
        return fail('SCHEMA_VALIDATION_ERROR', 'Medicine sellPricePill must be null or finite >= 0.');
      }
      mutable.sellPricePill = pillPrice;
    }
  }

  if (p.sellPack !== undefined) {
    if (typeof p.sellPack !== 'boolean') {
      return fail('SCHEMA_VALIDATION_ERROR', 'Medicine sellPack must be a boolean.');
    }
    mutable.sellPack = p.sellPack;
  }
  if (p.sellStrip !== undefined) {
    if (typeof p.sellStrip !== 'boolean') {
      return fail('SCHEMA_VALIDATION_ERROR', 'Medicine sellStrip must be a boolean.');
    }
    mutable.sellStrip = p.sellStrip;
  }
  if (p.sellPill !== undefined) {
    if (typeof p.sellPill !== 'boolean') {
      return fail('SCHEMA_VALIDATION_ERROR', 'Medicine sellPill must be a boolean.');
    }
    mutable.sellPill = p.sellPill;
  }

  if (p.expiry !== undefined) {
    const expiryRes = validateBoundedString(p.expiry, 'medicine.expiry', 0, 32);
    if (!expiryRes.ok) return expiryRes.failure;
    mutable.expiry = expiryRes.value;
  }

  if (p.unitType !== undefined) {
    const unitTypeRes = validateBoundedString(p.unitType, 'medicine.unitType', 1, 16, { trim: true });
    if (!unitTypeRes.ok) return unitTypeRes.failure;
    mutable.unitType = unitTypeRes.value;
  } else if (entry.action === 'CREATE') {
    mutable.unitType = 'pack';
  }

  if (p.stripsPerPack !== undefined) {
    const strips = parseStrictFiniteNumber(p.stripsPerPack);
    if (strips === null || strips < 1) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Medicine stripsPerPack must be >= 1.');
    }
    mutable.stripsPerPack = strips;
  }

  if (p.pillsPerStrip !== undefined) {
    const pills = parseStrictFiniteNumber(p.pillsPerStrip);
    if (pills === null || pills < 1) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Medicine pillsPerStrip must be >= 1.');
    }
    mutable.pillsPerStrip = pills;
  }

  if (p.batchNumber !== undefined) {
    const batchRes = validateBoundedString(p.batchNumber, 'medicine.batchNumber', 0, 64);
    if (!batchRes.ok) return batchRes.failure;
    mutable.batchNumber = batchRes.value;
  }

  if (p.secondaryBarcodes !== undefined) {
    const barcodesRes = validateSecondaryBarcodesForRules(p.secondaryBarcodes);
    if (!barcodesRes.ok) return barcodesRes.failure;
    mutable.secondaryBarcodes = barcodesRes.value;
  }

  let archived: boolean | undefined;
  if (p.archived !== undefined) {
    if (typeof p.archived !== 'boolean') {
      return fail('SCHEMA_VALIDATION_ERROR', 'Medicine archived must be a boolean.');
    }
    archived = p.archived;
    mutable.archived = archived;
  }

  if (archived === true) {
    if (p.archivedByUid !== undefined && p.archivedByUid !== null) {
      if (!isValidFirestoreDocumentId(p.archivedByUid)) {
        return fail('INVALID_FIRESTORE_ID', 'Medicine archivedByUid is not a valid Firestore ID.');
      }
      if (isValidFirebaseActorUid(p.archivedByUid) && p.archivedByUid !== actorUid) {
        return fail(
          'ACTOR_UID_MISSING_OR_MISMATCH',
          `Medicine archivedByUid (${p.archivedByUid}) does not match actorUid (${actorUid}).`
        );
      }
      mutable.archivedByUid = p.archivedByUid;
    } else {
      mutable.archivedByUid = actorUid;
    }

    const parsedArchivedAt = parseTimestampValue(p.archivedAt, tsFactory);
    if (!parsedArchivedAt.valid) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Medicine archivedAt is not a valid timestamp.');
    }
    mutable.archivedAt = parsedArchivedAt.present && parsedArchivedAt.value !== null
      ? parsedArchivedAt.value
      : tsFactory.serverTimestamp();
  } else {
    if (p.archivedAt === null) {
      mutable.archivedAt = null;
    }
    if (p.archivedByUid === null) {
      mutable.archivedByUid = null;
    }
  }

  mutable.updatedAt = tsFactory.serverTimestamp();

  if (entry.action === 'CREATE') {
    return {
      ok: true,
      op: 'set',
      entityType: 'medicine',
      entityId: entry.entityId,
      branchId,
      documentPath,
      data: {
        id: entry.entityId,
        branchId,
        ...mutable,
        createdAt: tsFactory.serverTimestamp(),
      },
    };
  }

  return {
    ok: true,
    op: 'update',
    entityType: 'medicine',
    entityId: entry.entityId,
    branchId,
    documentPath,
    data: mutable,
  };
}

const ALLOWED_SALE_UPDATE_PAYLOAD_KEYS = new Set([
  'id',
  'branchId',
  'customer',
  'bankakTransactionId',
  'updatedAt',
]);

function normalizeSaleEntry(
  entry: OutboxEntry,
  branchId: string,
  actorUid: string,
  documentPath: string,
  tsFactory: Required<FirestoreTimestampFactory>
): NormalizeOutboxEntryResult {
  if (entry.action === 'DELETE') {
    return fail('IMMUTABLE_ENTITY_OPERATION', 'Deleting sales documents is prohibited by firestore.rules.');
  }

  const p = entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
    ? (entry.payload as Record<string, any>)
    : null;
  if (!p) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Sale payload must be a non-null object.');
  }
  if (p.id !== undefined && String(p.id).trim() !== entry.entityId) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Sale payload.id (${String(p.id)}) mismatches entityId (${entry.entityId}).`
    );
  }

  if (entry.action === 'UPDATE') {
    // firestore.rules allows UPDATE only on ['customer', 'bankakTransactionId', 'updatedAt']
    // Fail closed if payload attempts to mutate/include any accounting, item, or immutable field.
    for (const key of Object.keys(p)) {
      if (p[key] !== undefined && !ALLOWED_SALE_UPDATE_PAYLOAD_KEYS.has(key)) {
        return fail(
          'SCHEMA_VALIDATION_ERROR',
          `Sale UPDATE contains disallowed/immutable field "${key}"; firestore.rules allows updating only customer and bankakTransactionId.`
        );
      }
    }

    const patch: Record<string, unknown> = {
      updatedAt: tsFactory.serverTimestamp(),
    };
    let hasMutableField = false;
    if (p.customer !== undefined) {
      const custRes = validateBoundedString(p.customer, 'sale.customer', 0, 160);
      if (!custRes.ok) return custRes.failure;
      patch.customer = custRes.value;
      hasMutableField = true;
    }
    if (p.bankakTransactionId !== undefined) {
      const txRes = validateBoundedString(p.bankakTransactionId, 'sale.bankakTransactionId', 0, 128);
      if (!txRes.ok) return txRes.failure;
      patch.bankakTransactionId = txRes.value;
      hasMutableField = true;
    }
    if (!hasMutableField) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        'Sale UPDATE payload must include at least one mutable field (customer or bankakTransactionId).'
      );
    }
    return {
      ok: true,
      op: 'update',
      entityType: 'sale',
      entityId: entry.entityId,
      branchId,
      documentPath,
      data: patch,
    };
  }

  if (entry.action !== 'CREATE') {
    return fail('INVALID_OUTBOX_ENTRY', `Unsupported sale action "${String(entry.action)}"`);
  }

  const invRes = validateBoundedString(p.invoiceNumber, 'sale.invoiceNumber', 1, 64, { trim: true });
  if (!invRes.ok) return invRes.failure;
  const invoiceNumber = invRes.value;

  if (!Array.isArray(p.items) || p.items.length < 1 || p.items.length > 100) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Sale items must contain between 1 and 100 items.');
  }

  const itemsCount = parseStrictFiniteNumber(p.itemsCount);
  if (itemsCount === null || !Number.isInteger(itemsCount) || itemsCount !== p.items.length) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Sale itemsCount (${String(p.itemsCount)}) must equal items.length (${p.items.length}).`
    );
  }

  const cleanItems: Record<string, unknown>[] = [];
  let sumItemSubtotals = 0;

  for (let i = 0; i < p.items.length; i += 1) {
    const rawItem = p.items[i];
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      return fail('SCHEMA_VALIDATION_ERROR', `Sale item[${i}] must be a non-null object.`);
    }
    const item = rawItem as Record<string, any>;
    const itemMedId = typeof item.medicineId === 'string' ? item.medicineId.trim() : '';
    if (!isValidFirestoreDocumentId(itemMedId)) {
      return fail('SCHEMA_VALIDATION_ERROR', `Sale item[${i}].medicineId is invalid.`);
    }
    const qty = parseStrictFiniteNumber(item.qty);
    if (qty === null || qty <= 0) {
      return fail('SCHEMA_VALIDATION_ERROR', `Sale item[${i}].qty must be a finite number > 0.`);
    }
    if (item.unit !== undefined && (typeof item.unit !== 'string' || !VALID_UNIT_KINDS.has(item.unit))) {
      return fail('SCHEMA_VALIDATION_ERROR', `Sale item[${i}].unit "${String(item.unit)}" is invalid.`);
    }
    const sellPriceVal = item.sellPrice !== undefined ? parseStrictFiniteNumber(item.sellPrice) : undefined;
    const unitPriceVal = item.unitPrice !== undefined ? parseStrictFiniteNumber(item.unitPrice) : undefined;
    if (sellPriceVal !== undefined && (sellPriceVal === null || sellPriceVal < 0)) {
      return fail('SCHEMA_VALIDATION_ERROR', `Sale item[${i}].sellPrice must be a finite number >= 0.`);
    }
    if (unitPriceVal !== undefined && (unitPriceVal === null || unitPriceVal < 0)) {
      return fail('SCHEMA_VALIDATION_ERROR', `Sale item[${i}].unitPrice must be a finite number >= 0.`);
    }
    if (sellPriceVal === undefined && unitPriceVal === undefined) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `Sale item[${i}] must provide a valid sellPrice or unitPrice.`
      );
    }
    if (
      typeof sellPriceVal === 'number' &&
      typeof unitPriceVal === 'number' &&
      Math.abs(sellPriceVal - unitPriceVal) > 0.01
    ) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `Sale item[${i}] sellPrice (${sellPriceVal}) disagrees with unitPrice (${unitPriceVal}).`
      );
    }
    const effectiveUnitPrice = (unitPriceVal ?? sellPriceVal) as number;
    const itemSubtotal = parseStrictFiniteNumber(item.subtotal);
    if (itemSubtotal === null || itemSubtotal < 0) {
      return fail('SCHEMA_VALIDATION_ERROR', `Sale item[${i}].subtotal must be a finite number >= 0.`);
    }
    if (Math.abs(effectiveUnitPrice * qty - itemSubtotal) > 0.02) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `Sale item[${i}].subtotal (${itemSubtotal}) mismatches qty (${qty}) * price (${effectiveUnitPrice}).`
      );
    }
    if (item.baseUnits !== undefined) {
      const baseUnits = parseStrictFiniteNumber(item.baseUnits);
      if (baseUnits === null || baseUnits <= 0) {
        return fail('SCHEMA_VALIDATION_ERROR', `Sale item[${i}].baseUnits must be finite > 0.`);
      }
    }
    let itemCogs: number | undefined;
    if (item.costOfGoods !== undefined) {
      const parsedCogs = parseStrictFiniteNumber(item.costOfGoods);
      if (parsedCogs === null || parsedCogs < 0) {
        return fail('SCHEMA_VALIDATION_ERROR', `Sale item[${i}].costOfGoods must be finite >= 0.`);
      }
      itemCogs = parsedCogs;
    }
    if (item.grossProfit !== undefined) {
      const itemGp = parseStrictFiniteNumber(item.grossProfit);
      if (itemGp === null) {
        return fail('SCHEMA_VALIDATION_ERROR', `Sale item[${i}].grossProfit must be finite.`);
      }
      if (itemCogs !== undefined && Math.abs(itemGp - (itemSubtotal - itemCogs)) > 0.02) {
        return fail(
          'SCHEMA_VALIDATION_ERROR',
          `Sale item[${i}].grossProfit (${itemGp}) mismatches subtotal - costOfGoods.`
        );
      }
    }

    sumItemSubtotals += itemSubtotal;
    cleanItems.push(stripUndefinedDeep(item) as Record<string, unknown>);
  }

  const subtotal = parseStrictFiniteNumber(p.subtotal);
  const discount = parseStrictFiniteNumber(p.discount);
  const total = parseStrictFiniteNumber(p.total);

  if (subtotal === null || subtotal < 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Sale subtotal must be finite >= 0.');
  }
  if (Math.abs(subtotal - sumItemSubtotals) > 0.02) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Sale subtotal (${subtotal}) disagrees with sum of item subtotals (${sumItemSubtotals}).`
    );
  }
  if (discount === null || discount < 0 || discount > subtotal) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Sale discount must be a finite number satisfying 0 <= discount <= subtotal.');
  }
  if (total === null || total < 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Sale total must be finite >= 0.');
  }
  if (Math.abs(total - (subtotal - discount)) > 0.01) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Sale financial equation mismatch: total (${total}) != subtotal (${subtotal}) - discount (${discount}).`
    );
  }

  if (typeof p.paymentMethod !== 'string' || !VALID_PAYMENT_METHODS.has(p.paymentMethod)) {
    return fail('SCHEMA_VALIDATION_ERROR', `Invalid sale paymentMethod "${String(p.paymentMethod)}".`);
  }

  if (p.cashierUid !== undefined && p.cashierUid !== null) {
    const rawCashierUid = String(p.cashierUid).trim();
    if (rawCashierUid && rawCashierUid !== actorUid) {
      return fail(
        'ACTOR_UID_MISSING_OR_MISMATCH',
        `Sale cashierUid (${rawCashierUid}) mismatches outbox actorUid (${actorUid}).`
      );
    }
  }

  const saleDoc: Record<string, unknown> = {
    id: entry.entityId,
    branchId,
    invoiceNumber,
    items: cleanItems,
    itemsCount,
    subtotal,
    discount,
    total,
    paymentMethod: p.paymentMethod,
    cashierUid: actorUid,
    createdAt: tsFactory.serverTimestamp(),
  };

  if (p.customer !== undefined) {
    const res = validateBoundedString(p.customer, 'sale.customer', 0, 160);
    if (!res.ok) return res.failure;
    saleDoc.customer = res.value;
  }
  if (p.time !== undefined) {
    const res = validateBoundedString(p.time, 'sale.time', 0, 32);
    if (!res.ok) return res.failure;
    saleDoc.time = res.value;
  }
  if (p.timestamp !== undefined) {
    const res = validateBoundedString(p.timestamp, 'sale.timestamp', 0, 64);
    if (!res.ok) return res.failure;
    saleDoc.timestamp = res.value;
  }
  if (p.syncState !== undefined) {
    if (p.syncState !== 'pending_ledger' && p.syncState !== 'complete') {
      return fail('SCHEMA_VALIDATION_ERROR', `Invalid sale syncState "${String(p.syncState)}".`);
    }
    saleDoc.syncState = p.syncState;
  }
  if (p.expectedLedgerCount !== undefined) {
    const cnt = parseStrictFiniteNumber(p.expectedLedgerCount);
    if (cnt === null || !Number.isInteger(cnt) || cnt < 1 || cnt > 500) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Sale expectedLedgerCount must be integer 1..500.');
    }
    saleDoc.expectedLedgerCount = cnt;
  }
  if (p.syncOperationId !== undefined) {
    const opRes = validateBoundedString(p.syncOperationId, 'sale.syncOperationId', 1, 128, { trim: true });
    if (!opRes.ok) return opRes.failure;
    saleDoc.syncOperationId = opRes.value;
  }

  let parsedCostOfGoods: number | undefined;
  if (p.costOfGoods !== undefined) {
    const cogs = parseStrictFiniteNumber(p.costOfGoods);
    if (cogs === null || cogs < 0) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Sale costOfGoods must be finite >= 0.');
    }
    parsedCostOfGoods = cogs;
    saleDoc.costOfGoods = cogs;
  }

  let parsedGrossProfit: number | undefined;
  if (p.grossProfit !== undefined) {
    const gp = parseStrictFiniteNumber(p.grossProfit);
    if (gp === null) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Sale grossProfit must be finite.');
    }
    if (parsedCostOfGoods !== undefined && Math.abs(gp - (subtotal - parsedCostOfGoods)) > 0.02) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `Sale grossProfit (${gp}) mismatches subtotal (${subtotal}) - costOfGoods (${parsedCostOfGoods}).`
      );
    }
    parsedGrossProfit = gp;
    saleDoc.grossProfit = gp;
  }

  if (p.netProfit !== undefined) {
    const np = parseStrictFiniteNumber(p.netProfit);
    if (np === null) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Sale netProfit must be finite.');
    }
    if (parsedCostOfGoods !== undefined && Math.abs(np - (total - parsedCostOfGoods)) > 0.02) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `Sale netProfit (${np}) mismatches total (${total}) - costOfGoods (${parsedCostOfGoods}).`
      );
    }
    if (parsedGrossProfit !== undefined && Math.abs(np - (parsedGrossProfit - discount)) > 0.02) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `Sale netProfit (${np}) mismatches grossProfit (${parsedGrossProfit}) - discount (${discount}).`
      );
    }
    saleDoc.netProfit = np;
  }

  if (p.bankakTransactionId !== undefined) {
    const res = validateBoundedString(p.bankakTransactionId, 'sale.bankakTransactionId', 0, 128);
    if (!res.ok) return res.failure;
    saleDoc.bankakTransactionId = res.value;
  }
  if (p.cashierName !== undefined) {
    const res = validateBoundedString(p.cashierName, 'sale.cashierName', 0, 120);
    if (!res.ok) return res.failure;
    saleDoc.cashierName = res.value;
  }
  if (p.deviceId !== undefined) {
    const res = validateBoundedString(p.deviceId, 'sale.deviceId', 0, 128);
    if (!res.ok) return res.failure;
    saleDoc.deviceId = res.value;
  }

  return {
    ok: true,
    op: 'set',
    entityType: 'sale',
    entityId: entry.entityId,
    branchId,
    documentPath,
    data: saleDoc,
  };
}

export function resolveOutboxDependencyRefs(
  rawDependsOn: unknown,
  depIndex?: OutboxDependencyIndex
): string[] {
  if (!Array.isArray(rawDependsOn)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawRef of rawDependsOn) {
    if (typeof rawRef !== 'string') continue;
    const trimmed = rawRef.trim();
    if (!trimmed) continue;
    const mapped =
      depIndex && !depIndex.ambiguousLegacyIds.has(trimmed) && !depIndex.byOperationId.has(trimmed)
        ? depIndex.legacyIdToOperationId.get(trimmed) || trimmed
        : trimmed;
    if (!seen.has(mapped)) {
      seen.add(mapped);
      out.push(mapped);
    }
  }
  return out;
}

function resolveSaleParentForLedgerEntry(
  entry: OutboxEntry,
  context: NormalizeOutboxEntryContext
): { saleId: string; invoiceNumber?: string } | null {
  if (context.resolveSaleForLedger) {
    const provided = context.resolveSaleForLedger(entry);
    if (provided && isValidFirestoreDocumentId(provided.saleId)) {
      return provided;
    }
  }

  const allEntries = context.allOutboxEntries;
  if (Array.isArray(allEntries) && allEntries.length > 0 && Array.isArray(entry.dependsOn)) {
    const depIndex = buildOutboxDependencyIndex(allEntries);
    const normalizedDeps = resolveOutboxDependencyRefs(entry.dependsOn, depIndex);
    for (const opId of normalizedDeps) {
      const parentMatches = depIndex.byOperationId.get(opId) ?? depIndex.byRecordId.get(opId);
      const parent = parentMatches && parentMatches.length === 1 ? parentMatches[0] : undefined;
      if (
        parent &&
        parent.entityType === 'sale' &&
        isValidFirestoreDocumentId(parent.entityId) &&
        (!parent.branchId || !entry.branchId || parent.branchId.trim() === entry.branchId.trim())
      ) {
        const rawParentInv =
          parent.payload && typeof parent.payload.invoiceNumber === 'string'
            ? parent.payload.invoiceNumber.trim()
            : undefined;
        if (rawParentInv && rawParentInv.length > 64) {
          return null;
        }
        return {
          saleId: parent.entityId.trim(),
          ...(rawParentInv ? { invoiceNumber: rawParentInv } : {}),
        };
      }
    }
  }

  const p = entry.payload && typeof entry.payload === 'object' ? (entry.payload as Record<string, any>) : null;
  if (p) {
    // Only accept explicit p.saleId (never guess from p.referenceId or p.invoiceNumber).
    if (typeof p.saleId === 'string') {
      const explicitSaleId = p.saleId.trim();
      const rawInv = typeof p.invoiceNumber === 'string' ? p.invoiceNumber.trim() : undefined;
      const rawRef = typeof p.referenceId === 'string' ? p.referenceId.trim() : undefined;
      if (
        isValidFirestoreDocumentId(explicitSaleId) &&
        (!rawInv || explicitSaleId !== rawInv)
      ) {
        if ((rawInv && rawInv.length > 64) || (!rawInv && rawRef && rawRef.length > 64)) {
          return null;
        }
        return {
          saleId: explicitSaleId,
          ...(rawInv
            ? { invoiceNumber: rawInv }
            : rawRef && rawRef !== explicitSaleId
            ? { invoiceNumber: rawRef }
            : {}),
        };
      }
    }
  }

  return null;
}

function normalizeInventoryLedgerEntry(
  entry: OutboxEntry,
  branchId: string,
  actorUid: string,
  documentPath: string,
  context: NormalizeOutboxEntryContext,
  tsFactory: Required<FirestoreTimestampFactory>
): NormalizeOutboxEntryResult {
  if (entry.action !== 'CREATE') {
    return fail(
      'IMMUTABLE_ENTITY_OPERATION',
      `Inventory ledger is append-only; action "${String(entry.action)}" is forbidden by firestore.rules.`
    );
  }

  const p = entry.payload && typeof entry.payload === 'object' ? (entry.payload as Record<string, any>) : null;
  if (!p) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Inventory ledger payload must be a non-null object.');
  }
  if (p.id !== undefined && String(p.id).trim() !== entry.entityId) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Inventory ledger payload.id (${String(p.id)}) mismatches entityId (${entry.entityId}).`
    );
  }

  const medicineId = typeof p.medicineId === 'string' ? p.medicineId.trim() : '';
  if (!isValidFirestoreDocumentId(medicineId)) {
    return fail('INVALID_FIRESTORE_ID', `Inventory ledger medicineId "${medicineId}" is invalid.`);
  }

  if (typeof p.type !== 'string' || !VALID_MOVEMENT_TYPES.has(p.type)) {
    return fail('SCHEMA_VALIDATION_ERROR', `Invalid inventory ledger type "${String(p.type)}".`);
  }
  if (typeof p.unit !== 'string' || !VALID_UNIT_KINDS.has(p.unit)) {
    return fail('SCHEMA_VALIDATION_ERROR', `Invalid inventory ledger unit "${String(p.unit)}".`);
  }

  const quantityDelta = parseStrictFiniteNumber(p.quantityDelta);
  const baseUnitsDelta = parseStrictFiniteNumber(p.baseUnitsDelta);
  if (quantityDelta === null || quantityDelta === 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Inventory ledger quantityDelta must be finite and non-zero.');
  }
  if (baseUnitsDelta === null || baseUnitsDelta === 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Inventory ledger baseUnitsDelta must be finite and non-zero.');
  }

  if (p.type === 'SALE' || p.type === 'DAMAGE') {
    if (quantityDelta >= 0 || baseUnitsDelta >= 0) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `${p.type} ledger movement must have strictly negative quantityDelta and baseUnitsDelta.`
      );
    }
  } else if (p.type === 'INITIAL' || p.type === 'PURCHASE' || p.type === 'RETURN') {
    if (quantityDelta <= 0 || baseUnitsDelta <= 0) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `${p.type} ledger movement must have strictly positive quantityDelta and baseUnitsDelta.`
      );
    }
  }

  // Actor attribution consistency check against payload.userId
  if (p.userId !== undefined && p.userId !== null) {
    const rawUserId = String(p.userId).trim();
    if (
      rawUserId.length > 0 &&
      !RESERVED_LEDGER_USER_PLACEHOLDERS.has(rawUserId.toLowerCase()) &&
      isValidFirebaseActorUid(rawUserId) &&
      rawUserId !== actorUid
    ) {
      return fail(
        'ACTOR_UID_MISSING_OR_MISMATCH',
        `Inventory ledger userId (${rawUserId}) mismatches outbox actorUid (${actorUid}).`
      );
    }
  }

  let resolvedReferenceId: string | undefined;
  if (p.referenceId !== undefined) {
    const refRes = validateBoundedString(p.referenceId, 'inventory_ledger.referenceId', 0, 128, { trim: true });
    if (!refRes.ok) return refRes.failure;
    resolvedReferenceId = refRes.value;
  }

  let resolvedInvoiceNumber: string | undefined;
  if (p.invoiceNumber !== undefined) {
    const invRes = validateBoundedString(p.invoiceNumber, 'inventory_ledger.invoiceNumber', 0, 64, { trim: true });
    if (!invRes.ok) return invRes.failure;
    resolvedInvoiceNumber = invRes.value;
  }

  if (p.type === 'SALE') {
    const saleRef = resolveSaleParentForLedgerEntry(entry, context);
    if (!saleRef) {
      return fail(
        'MISSING_SALE_PARENT_FOR_LEDGER',
        `Cannot resolve canonical sale document ID for SALE inventory_ledger "${entry.entityId}" (canLinkSaleLedger requires proven saleId).`
      );
    }
    const rawRef = resolvedReferenceId ?? '';
    if (rawRef && rawRef.length > 64 && !resolvedInvoiceNumber && !saleRef.invoiceNumber) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `inventory_ledger.invoiceNumber derived from referenceId exceeds maximum length of 64 characters.`
      );
    }
    resolvedReferenceId = saleRef.saleId;
    if (!resolvedInvoiceNumber) {
      resolvedInvoiceNumber =
        saleRef.invoiceNumber || (rawRef && rawRef !== saleRef.saleId ? rawRef : undefined);
    }
  }

  const ledgerDoc: Record<string, unknown> = {
    id: entry.entityId,
    branchId,
    medicineId,
    type: p.type,
    unit: p.unit,
    quantityDelta,
    baseUnitsDelta,
    userId: actorUid,
    createdAt: tsFactory.serverTimestamp(),
  };

  if (p.batchNumber !== undefined) {
    const res = validateBoundedString(p.batchNumber, 'inventory_ledger.batchNumber', 0, 64);
    if (!res.ok) return res.failure;
    ledgerDoc.batchNumber = res.value;
  }
  if (p.expiry !== undefined) {
    const res = validateBoundedString(p.expiry, 'inventory_ledger.expiry', 0, 32);
    if (!res.ok) return res.failure;
    ledgerDoc.expiry = res.value;
  }
  if (p.costPerUnit !== undefined) {
    const cpu = parseStrictFiniteNumber(p.costPerUnit);
    if (cpu === null || cpu < 0) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Inventory ledger costPerUnit must be finite >= 0.');
    }
    ledgerDoc.costPerUnit = cpu;
  }
  if (p.costPerBaseUnit !== undefined) {
    const cpbu = parseStrictFiniteNumber(p.costPerBaseUnit);
    if (cpbu === null || cpbu < 0) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Inventory ledger costPerBaseUnit must be finite >= 0.');
    }
    ledgerDoc.costPerBaseUnit = cpbu;
  }
  if (resolvedReferenceId !== undefined) {
    if (resolvedReferenceId.length > 128) {
      return fail('SCHEMA_VALIDATION_ERROR', 'inventory_ledger.referenceId exceeds maximum length of 128 characters.');
    }
    ledgerDoc.referenceId = resolvedReferenceId;
  }
  if (resolvedInvoiceNumber !== undefined) {
    if (resolvedInvoiceNumber.length > 64) {
      return fail('SCHEMA_VALIDATION_ERROR', 'inventory_ledger.invoiceNumber exceeds maximum length of 64 characters.');
    }
    ledgerDoc.invoiceNumber = resolvedInvoiceNumber;
  }
  if (p.deviceId !== undefined) {
    const res = validateBoundedString(p.deviceId, 'inventory_ledger.deviceId', 0, 128);
    if (!res.ok) return res.failure;
    ledgerDoc.deviceId = res.value;
  }
  if (p.employeeName !== undefined) {
    const res = validateBoundedString(p.employeeName, 'inventory_ledger.employeeName', 0, 120);
    if (!res.ok) return res.failure;
    ledgerDoc.employeeName = res.value;
  }
  if (p.notes !== undefined) {
    const res = validateBoundedString(p.notes, 'inventory_ledger.notes', 0, 500);
    if (!res.ok) return res.failure;
    ledgerDoc.notes = res.value;
  }
  if (p.timestamp !== undefined) {
    const res = validateBoundedString(p.timestamp, 'inventory_ledger.timestamp', 0, 64);
    if (!res.ok) return res.failure;
    ledgerDoc.timestamp = res.value;
  }

  return {
    ok: true,
    op: 'set',
    entityType: 'inventory_ledger',
    entityId: entry.entityId,
    branchId,
    documentPath,
    data: ledgerDoc,
  };
}

function normalizeReceiptEntry(): NormalizeOutboxEntryResult {
  return fail(
    'DEFERRED_TO_BANKAK_SCHEMA_HARMONIZATION',
    'Receipt outbox normalization is deferred pending Bankak local/Firestore schema harmonization.',
    { deferred: true }
  );
}

function normalizeSupplierEntry(
  entry: OutboxEntry,
  branchId: string,
  actorUid: string,
  documentPath: string,
  tsFactory: Required<FirestoreTimestampFactory>
): NormalizeOutboxEntryResult {
  if (entry.action === 'DELETE') {
    return fail('IMMUTABLE_ENTITY_OPERATION', 'Deleting suppliers is prohibited by firestore.rules.');
  }
  if (entry.action !== 'CREATE' && entry.action !== 'UPDATE') {
    return fail('INVALID_OUTBOX_ENTRY', `Unsupported supplier action "${String(entry.action)}"`);
  }

  const p = entry.payload && typeof entry.payload === 'object' ? (entry.payload as Record<string, any>) : null;
  if (!p) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Supplier payload must be a non-null object.');
  }
  if (p.id !== undefined && String(p.id).trim() !== entry.entityId) {
    return fail('SCHEMA_VALIDATION_ERROR', `Supplier payload.id (${String(p.id)}) mismatches entityId (${entry.entityId}).`);
  }

  const balance = parseStrictFiniteNumber(p.balance);
  if (balance === null) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Supplier balance must be a finite number.');
  }

  const mutable: Record<string, unknown> = {
    balance,
    updatedAt: tsFactory.serverTimestamp(),
  };

  if (p.name !== undefined) {
    if (typeof p.name === 'string') {
      const res = validateBoundedString(p.name, 'supplier.name', 0, 160);
      if (!res.ok) return res.failure;
      mutable.name = res.value;
    } else if (p.name && typeof p.name === 'object' && !Array.isArray(p.name)) {
      const arRes = validateBoundedString(p.name.ar ?? '', 'supplier.name.ar', 0, 160);
      if (!arRes.ok) return arRes.failure;
      const enRes = validateBoundedString(p.name.en ?? '', 'supplier.name.en', 0, 160);
      if (!enRes.ok) return enRes.failure;
      mutable.name = { ar: arRes.value, en: enRes.value };
    } else {
      return fail('SCHEMA_VALIDATION_ERROR', 'Supplier name must be a string or { ar, en } map.');
    }
  }
  if (p.nameAr !== undefined) {
    const res = validateBoundedString(p.nameAr, 'supplier.nameAr', 0, 160);
    if (!res.ok) return res.failure;
    mutable.nameAr = res.value;
  }
  if (p.nameEn !== undefined) {
    const res = validateBoundedString(p.nameEn, 'supplier.nameEn', 0, 160);
    if (!res.ok) return res.failure;
    mutable.nameEn = res.value;
  }
  if (p.contactPerson !== undefined) {
    const res = validateBoundedString(p.contactPerson, 'supplier.contactPerson', 0, 120);
    if (!res.ok) return res.failure;
    mutable.contactPerson = res.value;
  }
  if (p.phone !== undefined) {
    const res = validateBoundedString(p.phone, 'supplier.phone', 0, 40);
    if (!res.ok) return res.failure;
    mutable.phone = res.value;
  }
  if (p.city !== undefined) {
    const res = validateBoundedString(p.city, 'supplier.city', 0, 120);
    if (!res.ok) return res.failure;
    mutable.city = res.value;
  }
  if (p.terms !== undefined) {
    const res = validateBoundedString(p.terms, 'supplier.terms', 0, 120);
    if (!res.ok) return res.failure;
    mutable.terms = res.value;
  }
  if (p.status !== undefined) {
    if (typeof p.status !== 'string' || !VALID_SUPPLIER_STATUSES.has(p.status)) {
      return fail('SCHEMA_VALIDATION_ERROR', `Invalid supplier status "${String(p.status)}".`);
    }
    mutable.status = p.status;
  }
  if (p.email !== undefined) {
    const res = validateBoundedString(p.email, 'supplier.email', 0, 254);
    if (!res.ok) return res.failure;
    mutable.email = res.value;
  }
  if (p.address !== undefined) {
    const res = validateBoundedString(p.address, 'supplier.address', 0, 250);
    if (!res.ok) return res.failure;
    mutable.address = res.value;
  }
  if (p.taxNumber !== undefined) {
    const res = validateBoundedString(p.taxNumber, 'supplier.taxNumber', 0, 64);
    if (!res.ok) return res.failure;
    mutable.taxNumber = res.value;
  }
  if (p.notes !== undefined) {
    const res = validateBoundedString(p.notes, 'supplier.notes', 0, 500);
    if (!res.ok) return res.failure;
    mutable.notes = res.value;
  }
  if (p.legacyBalance !== undefined) {
    const lb = parseStrictFiniteNumber(p.legacyBalance);
    if (lb === null) return fail('SCHEMA_VALIDATION_ERROR', 'Supplier legacyBalance must be finite.');
    mutable.legacyBalance = lb;
  }
  if (p.openingBalanceReviewed !== undefined) {
    if (typeof p.openingBalanceReviewed !== 'boolean') {
      return fail('SCHEMA_VALIDATION_ERROR', 'Supplier openingBalanceReviewed must be boolean.');
    }
    mutable.openingBalanceReviewed = p.openingBalanceReviewed;
  }
  if (p.archived !== undefined) {
    if (typeof p.archived !== 'boolean') {
      return fail('SCHEMA_VALIDATION_ERROR', 'Supplier archived must be boolean.');
    }
    mutable.archived = p.archived;
  }
  if (p.archived === true || p.status === 'archived') {
    if (p.archivedByUid !== undefined && p.archivedByUid !== null) {
      if (!isValidFirestoreDocumentId(p.archivedByUid)) {
        return fail('INVALID_FIRESTORE_ID', 'Supplier archivedByUid is invalid.');
      }
      if (isValidFirebaseActorUid(p.archivedByUid) && p.archivedByUid !== actorUid) {
        return fail('ACTOR_UID_MISSING_OR_MISMATCH', 'Supplier archivedByUid mismatches actorUid.');
      }
      mutable.archivedByUid = p.archivedByUid;
    } else {
      mutable.archivedByUid = actorUid;
    }
    const parsedArchivedAt = parseTimestampValue(p.archivedAt, tsFactory);
    if (!parsedArchivedAt.valid) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Supplier archivedAt is invalid.');
    }
    mutable.archivedAt =
      parsedArchivedAt.present && parsedArchivedAt.value !== null
        ? parsedArchivedAt.value
        : tsFactory.serverTimestamp();
  } else {
    if (p.archivedAt === null) mutable.archivedAt = null;
    if (p.archivedByUid === null) mutable.archivedByUid = null;
  }

  if (entry.action === 'CREATE') {
    return {
      ok: true,
      op: 'set',
      entityType: 'supplier',
      entityId: entry.entityId,
      branchId,
      documentPath,
      data: {
        id: entry.entityId,
        branchId,
        ...mutable,
        createdAt: tsFactory.serverTimestamp(),
      },
    };
  }

  return {
    ok: true,
    op: 'update',
    entityType: 'supplier',
    entityId: entry.entityId,
    branchId,
    documentPath,
    data: mutable,
  };
}

function normalizePurchaseInvoiceEntry(
  entry: OutboxEntry,
  branchId: string,
  documentPath: string,
  tsFactory: Required<FirestoreTimestampFactory>
): NormalizeOutboxEntryResult {
  if (entry.action === 'DELETE') {
    return fail('IMMUTABLE_ENTITY_OPERATION', 'Deleting purchase invoices is prohibited by firestore.rules.');
  }
  if (entry.action !== 'CREATE' && entry.action !== 'UPDATE') {
    return fail('INVALID_OUTBOX_ENTRY', `Unsupported purchase_invoice action "${String(entry.action)}"`);
  }

  const p = entry.payload && typeof entry.payload === 'object' ? (entry.payload as Record<string, any>) : null;
  if (!p) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice payload must be a non-null object.');
  }
  if (p.id !== undefined && String(p.id).trim() !== entry.entityId) {
    return fail('SCHEMA_VALIDATION_ERROR', `Purchase invoice payload.id (${String(p.id)}) mismatches entityId (${entry.entityId}).`);
  }

  const paidAmount = parseStrictFiniteNumber(p.paidAmount);
  const remainingAmount = parseStrictFiniteNumber(p.remainingAmount);
  const paymentStatus = p.paymentStatus;

  if (paidAmount === null || paidAmount < 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice paidAmount must be finite >= 0.');
  }
  if (remainingAmount === null || remainingAmount < 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice remainingAmount must be finite >= 0.');
  }
  if (typeof paymentStatus !== 'string' || !VALID_PURCHASE_PAYMENT_STATUSES.has(paymentStatus)) {
    return fail('SCHEMA_VALIDATION_ERROR', `Invalid purchase_invoice paymentStatus "${String(paymentStatus)}".`);
  }

  if (entry.action === 'UPDATE') {
    const netAmount = p.netAmount !== undefined ? parseStrictFiniteNumber(p.netAmount) : paidAmount + remainingAmount;
    if (p.netAmount !== undefined && (netAmount === null || netAmount < 0)) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice netAmount must be finite >= 0.');
    }
    if (netAmount !== null) {
      if (Math.abs(paidAmount + remainingAmount - netAmount) > 0.02) {
        return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice paidAmount + remainingAmount != netAmount.');
      }
      if (paymentStatus === 'Paid' && (remainingAmount > 0.01 || paidAmount < netAmount - 0.01)) {
        return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice Paid status inconsistent with amounts.');
      }
      if (paymentStatus === 'Partial' && (paidAmount <= 0 || remainingAmount <= 0.01)) {
        return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice Partial status inconsistent with amounts.');
      }
      if (paymentStatus === 'Unpaid' && (paidAmount > 0.01 || remainingAmount < netAmount - 0.01)) {
        return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice Unpaid status inconsistent with amounts.');
      }
    }
    const patch: Record<string, unknown> = {
      paidAmount,
      remainingAmount,
      paymentStatus,
      updatedAt: tsFactory.serverTimestamp(),
    };
    if (p.notes !== undefined) {
      const res = validateBoundedString(p.notes, 'purchase_invoice.notes', 0, 500);
      if (!res.ok) return res.failure;
      patch.notes = res.value;
    }
    return {
      ok: true,
      op: 'update',
      entityType: 'purchase_invoice',
      entityId: entry.entityId,
      branchId,
      documentPath,
      data: patch,
    };
  }

  const supplierId = typeof p.supplierId === 'string' ? p.supplierId.trim() : '';
  if (!isValidFirestoreDocumentId(supplierId)) {
    return fail('INVALID_FIRESTORE_ID', `Purchase invoice supplierId "${supplierId}" is invalid.`);
  }
  const invRes = validateBoundedString(p.invoiceNumber, 'purchase_invoice.invoiceNumber', 1, 64, { trim: true });
  if (!invRes.ok) return invRes.failure;
  const invoiceNumber = invRes.value;

  const totalAmount = parseStrictFiniteNumber(p.totalAmount);
  const discount = parseStrictFiniteNumber(p.discount);
  const netAmount = parseStrictFiniteNumber(p.netAmount);
  if (totalAmount === null || totalAmount < 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice totalAmount must be finite >= 0.');
  }
  if (discount === null || discount < 0 || discount > totalAmount) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice discount must satisfy 0 <= discount <= totalAmount.');
  }
  if (netAmount === null || netAmount < 0 || Math.abs(netAmount - (totalAmount - discount)) > 0.02) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice netAmount must match totalAmount - discount.');
  }
  if (Math.abs(paidAmount + remainingAmount - netAmount) > 0.02) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice paidAmount + remainingAmount must match netAmount.');
  }
  if (paymentStatus === 'Paid' && (remainingAmount > 0.01 || paidAmount < netAmount - 0.01)) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice Paid status inconsistent with amounts.');
  }
  if (paymentStatus === 'Partial' && (paidAmount <= 0 || remainingAmount <= 0.01)) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice Partial status inconsistent with amounts.');
  }
  if (paymentStatus === 'Unpaid' && (paidAmount > 0.01 || remainingAmount < netAmount - 0.01)) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice Unpaid status inconsistent with amounts.');
  }

  const docData: Record<string, unknown> = {
    id: entry.entityId,
    branchId,
    supplierId,
    invoiceNumber,
    totalAmount,
    discount,
    netAmount,
    paidAmount,
    remainingAmount,
    paymentStatus,
    createdAt: tsFactory.serverTimestamp(),
  };

  if (p.supplierName !== undefined) {
    const res = validateBoundedString(p.supplierName, 'purchase_invoice.supplierName', 0, 160);
    if (!res.ok) return res.failure;
    docData.supplierName = res.value;
  }
  if (p.date !== undefined) {
    const res = validateBoundedString(p.date, 'purchase_invoice.date', 0, 32);
    if (!res.ok) return res.failure;
    docData.date = res.value;
  }
  if (p.invoiceDate !== undefined) {
    const res = validateBoundedString(p.invoiceDate, 'purchase_invoice.invoiceDate', 0, 32);
    if (!res.ok) return res.failure;
    docData.invoiceDate = res.value;
  }
  if (p.items !== undefined) {
    if (!Array.isArray(p.items) || p.items.length > 100) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice items must be an array with <= 100 entries.');
    }
    if (p.itemsCount !== undefined) {
      const ic = parseStrictFiniteNumber(p.itemsCount);
      if (ic === null || !Number.isInteger(ic) || ic !== p.items.length) {
        return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice itemsCount must equal items.length.');
      }
    }
    docData.items = stripUndefinedDeep(p.items);
    docData.itemsCount = (docData.items as unknown[]).length;
  } else if (p.itemsCount !== undefined) {
    const ic = parseStrictFiniteNumber(p.itemsCount);
    if (ic === null || ic < 0) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice itemsCount must be >= 0.');
    }
    docData.itemsCount = ic;
  }
  if (p.subtotal !== undefined) {
    const sub = parseStrictFiniteNumber(p.subtotal);
    if (sub === null || sub < 0 || Math.abs(sub - totalAmount) > 0.02) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Purchase invoice subtotal must match totalAmount.');
    }
    docData.subtotal = sub;
  }
  if (p.paymentType !== undefined) {
    if (typeof p.paymentType !== 'string' || !VALID_PURCHASE_PAYMENT_TYPES.has(p.paymentType)) {
      return fail('SCHEMA_VALIDATION_ERROR', `Invalid purchase_invoice paymentType "${String(p.paymentType)}".`);
    }
    docData.paymentType = p.paymentType;
  }
  if (p.dueDate !== undefined) {
    const res = validateBoundedString(p.dueDate, 'purchase_invoice.dueDate', 0, 32);
    if (!res.ok) return res.failure;
    docData.dueDate = res.value;
  }
  if (p.notes !== undefined) {
    const res = validateBoundedString(p.notes, 'purchase_invoice.notes', 0, 500);
    if (!res.ok) return res.failure;
    docData.notes = res.value;
  }
  if (p.deviceId !== undefined) {
    const res = validateBoundedString(p.deviceId, 'purchase_invoice.deviceId', 0, 128);
    if (!res.ok) return res.failure;
    docData.deviceId = res.value;
  }
  if (p.employeeName !== undefined) {
    const res = validateBoundedString(p.employeeName, 'purchase_invoice.employeeName', 0, 120);
    if (!res.ok) return res.failure;
    docData.employeeName = res.value;
  }

  return {
    ok: true,
    op: 'set',
    entityType: 'purchase_invoice',
    entityId: entry.entityId,
    branchId,
    documentPath,
    data: docData,
  };
}

function normalizeSupplierTransactionEntry(
  entry: OutboxEntry,
  branchId: string,
  documentPath: string,
  tsFactory: Required<FirestoreTimestampFactory>
): NormalizeOutboxEntryResult {
  if (entry.action !== 'CREATE') {
    return fail(
      'IMMUTABLE_ENTITY_OPERATION',
      `Supplier transaction is append-only; action "${String(entry.action)}" is forbidden by firestore.rules.`
    );
  }

  const p = entry.payload && typeof entry.payload === 'object' ? (entry.payload as Record<string, any>) : null;
  if (!p) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Supplier transaction payload must be a non-null object.');
  }
  if (p.id !== undefined && String(p.id).trim() !== entry.entityId) {
    return fail('SCHEMA_VALIDATION_ERROR', `Supplier transaction payload.id (${String(p.id)}) mismatches entityId (${entry.entityId}).`);
  }

  const supplierId = typeof p.supplierId === 'string' ? p.supplierId.trim() : '';
  if (!isValidFirestoreDocumentId(supplierId)) {
    return fail('INVALID_FIRESTORE_ID', `Supplier transaction supplierId "${supplierId}" is invalid.`);
  }
  if (typeof p.type !== 'string' || !VALID_SUPPLIER_TX_TYPES.has(p.type)) {
    return fail('SCHEMA_VALIDATION_ERROR', `Invalid supplier_transaction type "${String(p.type)}".`);
  }

  const amount = parseStrictFiniteNumber(p.amount);
  if (amount === null || amount <= 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Supplier transaction amount must be > 0.');
  }

  if (p.effect !== 'CREDIT' && p.effect !== 'DEBIT') {
    return fail('SCHEMA_VALIDATION_ERROR', `Invalid supplier_transaction effect "${String(p.effect)}".`);
  }
  if ((p.type === 'PURCHASE_INVOICE' || p.type === 'OPENING_BALANCE') && p.effect !== 'CREDIT') {
    return fail('SCHEMA_VALIDATION_ERROR', `${p.type} must have CREDIT effect.`);
  }
  if ((p.type === 'PAYMENT' || p.type === 'RETURN') && p.effect !== 'DEBIT') {
    return fail('SCHEMA_VALIDATION_ERROR', `${p.type} must have DEBIT effect.`);
  }

  const debit = p.debit !== undefined ? parseStrictFiniteNumber(p.debit) : p.effect === 'DEBIT' ? amount : 0;
  const credit = p.credit !== undefined ? parseStrictFiniteNumber(p.credit) : p.effect === 'CREDIT' ? amount : 0;
  if (debit === null || debit < 0 || credit === null || credit < 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Supplier transaction debit/credit must be finite >= 0.');
  }
  if (p.effect === 'CREDIT' && (debit !== 0 || Math.abs(credit - amount) > 0.01)) {
    return fail('SCHEMA_VALIDATION_ERROR', 'CREDIT supplier_transaction requires debit=0 and credit=amount.');
  }
  if (p.effect === 'DEBIT' && (credit !== 0 || Math.abs(debit - amount) > 0.01)) {
    return fail('SCHEMA_VALIDATION_ERROR', 'DEBIT supplier_transaction requires credit=0 and debit=amount.');
  }

  const balanceAfter = parseStrictFiniteNumber(p.balanceAfter);
  if (balanceAfter === null) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Supplier transaction balanceAfter must be finite.');
  }

  if (p.isReversal !== undefined && typeof p.isReversal !== 'boolean') {
    return fail('SCHEMA_VALIDATION_ERROR', 'Supplier transaction isReversal must be a boolean.');
  }
  const isReversal = p.isReversal === true;
  if (isReversal) {
    const reversedTxId = typeof p.reversedTxId === 'string' ? p.reversedTxId.trim() : '';
    if (!isValidFirestoreDocumentId(reversedTxId) || reversedTxId === entry.entityId) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Reversal supplier_transaction requires valid distinct reversedTxId.');
    }
    const expectedRevId = deriveSupplierPaymentReversalId(reversedTxId);
    if (entry.entityId !== expectedRevId) {
      return fail(
        'REVERSAL_ID_MISMATCH',
        `Reversal supplier_transaction id (${entry.entityId}) != deterministic (${expectedRevId}).`
      );
    }
    if (p.type !== 'ADJUSTMENT' || p.effect !== 'CREDIT' || p.referenceId !== reversedTxId) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        'Reversal supplier_transaction must have type=ADJUSTMENT, effect=CREDIT, referenceId=reversedTxId.'
      );
    }
  } else if (p.reversedTxId !== undefined && p.reversedTxId !== null && p.reversedTxId !== '') {
    return fail('SCHEMA_VALIDATION_ERROR', 'Non-reversal supplier_transaction must not set reversedTxId.');
  }

  const txDoc: Record<string, unknown> = {
    id: entry.entityId,
    branchId,
    supplierId,
    type: p.type,
    amount,
    effect: p.effect,
    debit,
    credit,
    balanceAfter,
    createdAt: tsFactory.serverTimestamp(),
  };

  if (p.referenceId !== undefined) {
    const res = validateBoundedString(p.referenceId, 'supplier_transaction.referenceId', 0, 128);
    if (!res.ok) return res.failure;
    txDoc.referenceId = res.value;
  }
  if (p.invoiceNumber !== undefined) {
    const res = validateBoundedString(p.invoiceNumber, 'supplier_transaction.invoiceNumber', 0, 64);
    if (!res.ok) return res.failure;
    txDoc.invoiceNumber = res.value;
  }
  if (p.voucherNumber !== undefined) {
    const res = validateBoundedString(p.voucherNumber, 'supplier_transaction.voucherNumber', 0, 64);
    if (!res.ok) return res.failure;
    txDoc.voucherNumber = res.value;
  }
  if (p.paymentMethod !== undefined) {
    if (typeof p.paymentMethod !== 'string' || !VALID_SUPPLIER_TX_PAYMENT_METHODS.has(p.paymentMethod)) {
      return fail('SCHEMA_VALIDATION_ERROR', `Invalid paymentMethod "${String(p.paymentMethod)}".`);
    }
    txDoc.paymentMethod = p.paymentMethod;
  }
  if (p.bankakTransactionId !== undefined) {
    const res = validateBoundedString(p.bankakTransactionId, 'supplier_transaction.bankakTransactionId', 0, 128);
    if (!res.ok) return res.failure;
    txDoc.bankakTransactionId = res.value;
  }
  if (p.checkNumber !== undefined) {
    const res = validateBoundedString(p.checkNumber, 'supplier_transaction.checkNumber', 0, 64);
    if (!res.ok) return res.failure;
    txDoc.checkNumber = res.value;
  }
  if (p.checkDueDate !== undefined) {
    const res = validateBoundedString(p.checkDueDate, 'supplier_transaction.checkDueDate', 0, 32);
    if (!res.ok) return res.failure;
    txDoc.checkDueDate = res.value;
  }
  if (p.transferReference !== undefined) {
    const res = validateBoundedString(p.transferReference, 'supplier_transaction.transferReference', 0, 128);
    if (!res.ok) return res.failure;
    txDoc.transferReference = res.value;
  }
  if (p.invoiceAllocations !== undefined && p.invoiceAllocations !== null) {
    if (!Array.isArray(p.invoiceAllocations)) {
      return fail('SCHEMA_VALIDATION_ERROR', 'invoiceAllocations must be an array.');
    }
    if (p.type !== 'PAYMENT') {
      if (p.invoiceAllocations.length > 0) {
        return fail('SCHEMA_VALIDATION_ERROR', 'Only PAYMENT transactions may contain invoiceAllocations.');
      }
      txDoc.invoiceAllocations = [];
    } else {
      if (p.invoiceAllocations.length > 12) {
        return fail('SCHEMA_VALIDATION_ERROR', 'invoiceAllocations supports at most 12 entries.');
      }
      const seenAllocIds = new Set<string>();
      let allocSum = 0;
      const cleanAllocs: Array<Record<string, unknown>> = [];
      for (const a of p.invoiceAllocations) {
        if (!a || typeof a !== 'object' || !isValidFirestoreDocumentId(a.invoiceId)) {
          return fail('SCHEMA_VALIDATION_ERROR', 'Invalid invoiceAllocation entry or invoiceId.');
        }
        if (seenAllocIds.has(a.invoiceId)) {
          return fail('SCHEMA_VALIDATION_ERROR', `Duplicate allocation invoiceId "${a.invoiceId}".`);
        }
        const aAmt = parseStrictFiniteNumber(a.amount);
        if (aAmt === null || aAmt <= 0) {
          return fail('SCHEMA_VALIDATION_ERROR', 'invoiceAllocation amount must be > 0.');
        }
        seenAllocIds.add(a.invoiceId);
        allocSum += aAmt;
        const cleanAlloc: Record<string, unknown> = {
          invoiceId: a.invoiceId,
          amount: aAmt,
        };
        if (a.invoiceNumber !== undefined) {
          const invRes = validateBoundedString(
            a.invoiceNumber,
            'supplier_transaction.invoiceAllocations.invoiceNumber',
            0,
            64
          );
          if (!invRes.ok) return invRes.failure;
          cleanAlloc.invoiceNumber = invRes.value;
        }
        cleanAllocs.push(cleanAlloc);
      }
      if (allocSum > amount + 0.01) {
        return fail('SCHEMA_VALIDATION_ERROR', 'Sum of invoiceAllocations exceeds transaction amount.');
      }
      txDoc.invoiceAllocations = cleanAllocs;
    }
  }
  if (p.date !== undefined) {
    const res = validateBoundedString(p.date, 'supplier_transaction.date', 0, 32);
    if (!res.ok) return res.failure;
    txDoc.date = res.value;
  }
  if (p.timestamp !== undefined) {
    const res = validateBoundedString(p.timestamp, 'supplier_transaction.timestamp', 0, 64);
    if (!res.ok) return res.failure;
    txDoc.timestamp = res.value;
  }
  if (p.notes !== undefined) {
    const res = validateBoundedString(p.notes, 'supplier_transaction.notes', 0, 500);
    if (!res.ok) return res.failure;
    txDoc.notes = res.value;
  }
  if (p.employeeName !== undefined) {
    const res = validateBoundedString(p.employeeName, 'supplier_transaction.employeeName', 0, 120);
    if (!res.ok) return res.failure;
    txDoc.employeeName = res.value;
  }
  if (p.deviceId !== undefined) {
    const res = validateBoundedString(p.deviceId, 'supplier_transaction.deviceId', 0, 128);
    if (!res.ok) return res.failure;
    txDoc.deviceId = res.value;
  }
  if (p.isReversal !== undefined) txDoc.isReversal = p.isReversal;
  if (isReversal) txDoc.reversedTxId = p.reversedTxId;

  return {
    ok: true,
    op: 'set',
    entityType: 'supplier_transaction',
    entityId: entry.entityId,
    branchId,
    documentPath,
    data: txDoc,
  };
}

function normalizeStocktakingSessionEntry(
  entry: OutboxEntry,
  branchId: string,
  actorUid: string,
  documentPath: string,
  tsFactory: Required<FirestoreTimestampFactory>
): NormalizeOutboxEntryResult {
  if (entry.action === 'DELETE') {
    return fail(
      'IMMUTABLE_ENTITY_OPERATION',
      'Deleting stocktaking_sessions is prohibited by firestore.rules.'
    );
  }
  if (entry.action !== 'CREATE' && entry.action !== 'UPDATE') {
    return fail('INVALID_OUTBOX_ENTRY', `Unsupported stocktaking_session action "${String(entry.action)}"`);
  }

  const p =
    entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
      ? (entry.payload as Record<string, any>)
      : null;
  if (!p) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Stocktaking session payload must be a non-null object.');
  }
  if (p.id !== undefined && String(p.id).trim() !== entry.entityId) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Stocktaking session payload.id (${String(p.id)}) mismatches entityId (${entry.entityId}).`
    );
  }

  if ('items' in p) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      'Inline items array is forbidden on stocktaking_sessions by firestore.rules; use items subcollection.'
    );
  }

  const status = typeof p.status === 'string' ? p.status.trim() : '';
  if (!status || FORBIDDEN_STOCKTAKING_STATUSES.has(status)) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Forbidden or invalid stocktaking_session status "${String(p.status)}" for Firestore rules.`
    );
  }

  const accountingStatus =
    typeof p.accountingStatus === 'string' ? p.accountingStatus.trim() : '';
  if (!accountingStatus || !VALID_CLIENT_ACCOUNTING_STATUSES.has(accountingStatus)) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Invalid stocktaking_session accountingStatus "${String(p.accountingStatus)}"; must be open, unverified_client_sync, or cancelled.`
    );
  }

  // Validate shared optional string fields
  const optFields: Record<string, unknown> = {};
  if (p.sessionNumber !== undefined) {
    const res = validateBoundedString(p.sessionNumber, 'stocktaking_session.sessionNumber', 1, 64, { trim: true });
    if (!res.ok) return res.failure;
    optFields.sessionNumber = res.value;
  }
  if (p.syncStatus !== undefined) {
    const res = validateBoundedString(p.syncStatus, 'stocktaking_session.syncStatus', 1, 64, { trim: true });
    if (!res.ok) return res.failure;
    optFields.syncStatus = res.value;
  }
  if (p.startedBy !== undefined) {
    const res = validateBoundedString(p.startedBy, 'stocktaking_session.startedBy', 0, 128);
    if (!res.ok) return res.failure;
    optFields.startedBy = res.value;
  }
  if (p.auditReason !== undefined) {
    const res = validateBoundedString(p.auditReason, 'stocktaking_session.auditReason', 0, 500);
    if (!res.ok) return res.failure;
    optFields.auditReason = res.value;
  }
  if (p.notes !== undefined) {
    const res = validateBoundedString(p.notes, 'stocktaking_session.notes', 0, 500);
    if (!res.ok) return res.failure;
    optFields.notes = res.value;
  }

  // Validate optional numeric summary metrics if present
  const summaryFields: Record<string, number> = {};
  const nonNegativeMetrics = [
    'itemsCount',
    'totalItemsCount',
    'matchedItemsCount',
    'surplusItemsCount',
    'deficitItemsCount',
    'totalScanned',
    'itemsWithVariance',
  ] as const;
  for (const field of nonNegativeMetrics) {
    if (p[field] !== undefined) {
      const val = parseStrictFiniteNumber(p[field]);
      if (val === null || val < 0) {
        return fail('SCHEMA_VALIDATION_ERROR', `stocktaking_session.${field} must be a finite number >= 0.`);
      }
      summaryFields[field] = val;
    }
  }
  for (const signedField of ['netVarianceSDG', 'totalVarianceCost'] as const) {
    if (p[signedField] !== undefined) {
      const val = parseStrictFiniteNumber(p[signedField]);
      if (val === null) {
        return fail('SCHEMA_VALIDATION_ERROR', `stocktaking_session.${signedField} must be finite.`);
      }
      summaryFields[signedField] = val;
    }
  }
  if (
    summaryFields.matchedItemsCount !== undefined &&
    summaryFields.surplusItemsCount !== undefined &&
    summaryFields.deficitItemsCount !== undefined &&
    summaryFields.totalItemsCount !== undefined &&
    summaryFields.matchedItemsCount + summaryFields.surplusItemsCount + summaryFields.deficitItemsCount !==
      summaryFields.totalItemsCount
  ) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      'stocktaking_session matchedItemsCount + surplusItemsCount + deficitItemsCount must equal totalItemsCount.'
    );
  }
  if (
    summaryFields.itemsWithVariance !== undefined &&
    summaryFields.surplusItemsCount !== undefined &&
    summaryFields.deficitItemsCount !== undefined &&
    summaryFields.itemsWithVariance !== summaryFields.surplusItemsCount + summaryFields.deficitItemsCount
  ) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      'stocktaking_session itemsWithVariance must equal surplusItemsCount + deficitItemsCount.'
    );
  }
  if (
    summaryFields.itemsCount !== undefined &&
    summaryFields.totalItemsCount !== undefined &&
    summaryFields.itemsCount !== summaryFields.totalItemsCount
  ) {
    return fail('SCHEMA_VALIDATION_ERROR', 'stocktaking_session itemsCount must equal totalItemsCount.');
  }

  if (entry.action === 'CREATE') {
    if (!VALID_STOCKTAKING_CREATE_STATUSES.has(status) || accountingStatus !== 'open') {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `Stocktaking session CREATE requires open accountingStatus and status in [active, in_progress, reviewing], got "${status}/${accountingStatus}".`
      );
    }
    if (p.committedAt !== undefined && p.committedAt !== null) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Stocktaking session CREATE cannot set committedAt.');
    }
    if (p.adjustmentLedgerIds !== undefined) {
      if (!Array.isArray(p.adjustmentLedgerIds) || p.adjustmentLedgerIds.length > 0) {
        return fail(
          'SCHEMA_VALIDATION_ERROR',
          'Stocktaking session CREATE cannot set non-empty adjustmentLedgerIds.'
        );
      }
    }
    if (p.startedByUid !== undefined && p.startedByUid !== null) {
      if (!isValidFirestoreDocumentId(p.startedByUid)) {
        return fail('INVALID_FIRESTORE_ID', 'stocktaking_session.startedByUid is invalid.');
      }
      if (isValidFirebaseActorUid(p.startedByUid) && p.startedByUid !== actorUid) {
        return fail(
          'ACTOR_UID_MISSING_OR_MISMATCH',
          `stocktaking_session.startedByUid (${String(p.startedByUid)}) mismatches actorUid (${actorUid}).`
        );
      }
    }

    const docData: Record<string, unknown> = {
      id: entry.entityId,
      branchId,
      status,
      accountingStatus: 'open',
      startedByUid: actorUid,
      ...optFields,
      ...summaryFields,
      createdAt: tsFactory.serverTimestamp(),
      updatedAt: tsFactory.serverTimestamp(),
    };
    if (p.startedAt !== undefined) {
      const res = validateBoundedString(p.startedAt, 'stocktaking_session.startedAt', 0, 64);
      if (!res.ok) return res.failure;
      docData.startedAt = res.value;
    }
    if (p.deviceId !== undefined) {
      const res = validateBoundedString(p.deviceId, 'stocktaking_session.deviceId', 0, 128);
      if (!res.ok) return res.failure;
      docData.deviceId = res.value;
    }

    return {
      ok: true,
      op: 'set',
      entityType: 'stocktaking_session',
      entityId: entry.entityId,
      branchId,
      documentPath,
      data: docData,
    };
  }

  // UPDATE path
  if (!VALID_STOCKTAKING_UPDATE_TARGET_STATUSES.has(status)) {
    return fail('SCHEMA_VALIDATION_ERROR', `Invalid stocktaking_session UPDATE status "${status}".`);
  }

  // Strip immutable keys (id, branchId, startedAt, startedByUid, deviceId, createdAt) from patch
  const updateData: Record<string, unknown> = {
    status,
    accountingStatus,
    ...optFields,
    ...summaryFields,
    updatedAt: tsFactory.serverTimestamp(),
  };

  if (VALID_STOCKTAKING_OPEN_UPDATE_STATUSES.has(status)) {
    if (accountingStatus !== 'open') {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `Stocktaking session status "${status}" requires accountingStatus="open", got "${accountingStatus}".`
      );
    }
    if (p.committedAt !== undefined && p.committedAt !== null) {
      return fail('SCHEMA_VALIDATION_ERROR', `Stocktaking session status "${status}" cannot include committedAt.`);
    }
    if (p.adjustmentLedgerIds !== undefined) {
      if (!Array.isArray(p.adjustmentLedgerIds) || p.adjustmentLedgerIds.length > 0) {
        return fail(
          'SCHEMA_VALIDATION_ERROR',
          `Stocktaking session status "${status}" cannot contain non-empty adjustmentLedgerIds.`
        );
      }
    }
  } else if (status === 'cancelled') {
    if (accountingStatus !== 'cancelled') {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `Cancelled stocktaking_session requires accountingStatus="cancelled", got "${accountingStatus}".`
      );
    }
    if (p.committedAt !== undefined && p.committedAt !== null) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Cancelled stocktaking_session cannot include committedAt.');
    }
    if (p.adjustmentLedgerIds !== undefined) {
      if (!Array.isArray(p.adjustmentLedgerIds) || p.adjustmentLedgerIds.length > 0) {
        return fail(
          'SCHEMA_VALIDATION_ERROR',
          'Cancelled stocktaking_session cannot contain adjustmentLedgerIds.'
        );
      }
    }
  } else if (status === 'sync_completed_unverified') {
    if (accountingStatus !== 'unverified_client_sync') {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        `sync_completed_unverified requires accountingStatus="unverified_client_sync", got "${accountingStatus}".`
      );
    }

    const parsedCommittedAt = parseTimestampValue(p.committedAt, tsFactory);
    if (!parsedCommittedAt.valid || !parsedCommittedAt.present || parsedCommittedAt.value === null) {
      return fail(
        'SCHEMA_VALIDATION_ERROR',
        'sync_completed_unverified requires a valid non-null committedAt Timestamp.'
      );
    }
    updateData.committedAt = parsedCommittedAt.value;

    const committedByUid = typeof p.committedByUid === 'string' ? p.committedByUid.trim() : '';
    if (!committedByUid || !isValidFirestoreDocumentId(committedByUid) || committedByUid !== actorUid) {
      return fail(
        'ACTOR_UID_MISSING_OR_MISMATCH',
        `sync_completed_unverified committedByUid (${committedByUid || 'missing'}) must equal actorUid (${actorUid}).`
      );
    }
    updateData.committedByUid = actorUid;

    if (p.committedBy !== undefined) {
      const res = validateBoundedString(p.committedBy, 'stocktaking_session.committedBy', 0, 128);
      if (!res.ok) return res.failure;
      updateData.committedBy = res.value;
    }

    const requiredCompletionMetrics = [
      'totalItemsCount',
      'matchedItemsCount',
      'surplusItemsCount',
      'deficitItemsCount',
      'itemsWithVariance',
      'totalScanned',
      'netVarianceSDG',
    ] as const;
    for (const metricKey of requiredCompletionMetrics) {
      if (summaryFields[metricKey] === undefined) {
        return fail(
          'SCHEMA_VALIDATION_ERROR',
          `sync_completed_unverified requires completion summary metric "${metricKey}".`
        );
      }
    }

    const itemsWithVariance = summaryFields.itemsWithVariance;
    if (itemsWithVariance === 0) {
      if (p.adjustmentLedgerIds !== undefined) {
        if (!Array.isArray(p.adjustmentLedgerIds) || p.adjustmentLedgerIds.length > 0) {
          return fail(
            'SCHEMA_VALIDATION_ERROR',
            'Zero-variance stocktaking completion cannot include non-empty adjustmentLedgerIds.'
          );
        }
        updateData.adjustmentLedgerIds = [];
      }
    } else {
      if (!Array.isArray(p.adjustmentLedgerIds) || p.adjustmentLedgerIds.length === 0) {
        return fail(
          'SCHEMA_VALIDATION_ERROR',
          'Variance stocktaking completion requires non-empty adjustmentLedgerIds.'
        );
      }
      if (p.adjustmentLedgerIds.length > 500 || p.adjustmentLedgerIds.length < itemsWithVariance) {
        return fail(
          'SCHEMA_VALIDATION_ERROR',
          `adjustmentLedgerIds length (${p.adjustmentLedgerIds.length}) must be >= itemsWithVariance (${itemsWithVariance}) and <= 500.`
        );
      }
      const seenLedgerIds = new Set<string>();
      const cleanLedgerIds: string[] = [];
      for (const rawId of p.adjustmentLedgerIds) {
        const lid = typeof rawId === 'string' ? rawId.trim() : '';
        if (!isValidFirestoreDocumentId(lid)) {
          return fail('INVALID_FIRESTORE_ID', `Invalid adjustmentLedgerId "${String(rawId)}".`);
        }
        if (seenLedgerIds.has(lid)) {
          return fail('SCHEMA_VALIDATION_ERROR', `Duplicate adjustmentLedgerId "${lid}".`);
        }
        seenLedgerIds.add(lid);
        cleanLedgerIds.push(lid);
      }
      updateData.adjustmentLedgerIds = cleanLedgerIds;
    }
  }

  return {
    ok: true,
    op: 'update',
    entityType: 'stocktaking_session',
    entityId: entry.entityId,
    branchId,
    documentPath,
    data: updateData,
  };
}

function normalizeStocktakingSessionItemEntry(
  entry: OutboxEntry,
  branchId: string,
  actorUid: string,
  documentPath: string,
  tsFactory: Required<FirestoreTimestampFactory>
): NormalizeOutboxEntryResult {
  if (entry.action !== 'CREATE' && entry.action !== 'UPDATE' && entry.action !== 'DELETE') {
    return fail(
      'INVALID_OUTBOX_ENTRY',
      `Unsupported stocktaking_session_item action "${String(entry.action)}"`
    );
  }

  const p =
    entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
      ? (entry.payload as Record<string, any>)
      : null;
  if (!p) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Stocktaking item payload must be a non-null object.');
  }
  if (p.id !== undefined && String(p.id).trim() !== entry.entityId) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Stocktaking item payload.id (${String(p.id)}) mismatches entityId (${entry.entityId}).`
    );
  }

  const sessionId = typeof p.sessionId === 'string' ? p.sessionId.trim() : '';
  if (!isValidFirestoreDocumentId(sessionId)) {
    return fail('INVALID_FIRESTORE_ID', `Stocktaking item sessionId "${sessionId}" is invalid.`);
  }

  if (entry.action === 'DELETE') {
    return {
      ok: true,
      op: 'delete',
      entityType: 'stocktaking_session_item',
      entityId: entry.entityId,
      branchId,
      documentPath,
      data: {
        id: entry.entityId,
        branchId,
        sessionId,
      },
    };
  }

  const medicineId = typeof p.medicineId === 'string' ? p.medicineId.trim() : '';
  if (!isValidFirestoreDocumentId(medicineId)) {
    return fail('INVALID_FIRESTORE_ID', `Stocktaking item medicineId "${medicineId}" is invalid.`);
  }

  const nameRes = validateBoundedString(p.medicineName, 'stocktaking_item.medicineName', 1, 200, {
    trim: true,
  });
  if (!nameRes.ok) return nameRes.failure;

  const systemStock = parseStrictFiniteNumber(p.systemStock);
  const actualCount = parseStrictFiniteNumber(p.actualCount);
  const buyPrice = parseStrictFiniteNumber(p.buyPrice);
  const variance = parseStrictFiniteNumber(p.variance);
  const varianceSDG = parseStrictFiniteNumber(p.varianceSDG);

  if (systemStock === null || systemStock < 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Stocktaking item systemStock must be finite >= 0.');
  }
  if (actualCount === null || actualCount < 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Stocktaking item actualCount must be finite >= 0.');
  }
  if (buyPrice === null || buyPrice < 0) {
    return fail('SCHEMA_VALIDATION_ERROR', 'Stocktaking item buyPrice must be finite >= 0.');
  }
  if (variance === null || Math.abs(variance - (actualCount - systemStock)) > 0.01) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Stocktaking item variance (${String(p.variance)}) mismatches actualCount - systemStock (${actualCount - systemStock}).`
    );
  }
  if (varianceSDG === null || Math.abs(varianceSDG - variance * buyPrice) > 0.02) {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `Stocktaking item varianceSDG (${String(p.varianceSDG)}) mismatches variance * buyPrice (${variance * buyPrice}).`
    );
  }

  if (p.updatedByUid !== undefined && p.updatedByUid !== null) {
    if (!isValidFirestoreDocumentId(p.updatedByUid)) {
      return fail('INVALID_FIRESTORE_ID', 'stocktaking_item.updatedByUid is invalid.');
    }
    if (isValidFirebaseActorUid(p.updatedByUid) && p.updatedByUid !== actorUid) {
      return fail(
        'ACTOR_UID_MISSING_OR_MISMATCH',
        `stocktaking_item.updatedByUid (${String(p.updatedByUid)}) mismatches actorUid (${actorUid}).`
      );
    }
  }

  // Mutable fields allowed by firestore.rules:1730-1735
  const mutable: Record<string, unknown> = {
    medicineName: nameRes.value,
    systemStock,
    actualCount,
    variance,
    buyPrice,
    varianceSDG,
    updatedByUid: actorUid,
    updatedAt: tsFactory.serverTimestamp(),
  };

  if (p.barcode !== undefined) {
    const res = validateBoundedString(p.barcode, 'stocktaking_item.barcode', 0, 64);
    if (!res.ok) return res.failure;
    mutable.barcode = res.value;
  }
  if (p.secondaryBarcodes !== undefined) {
    const res = validateSecondaryBarcodesForRules(p.secondaryBarcodes);
    if (!res.ok) return res.failure;
    mutable.secondaryBarcodes = res.value;
  }
  if (p.batchNumber !== undefined) {
    const res = validateBoundedString(p.batchNumber, 'stocktaking_item.batchNumber', 0, 64);
    if (!res.ok) return res.failure;
    mutable.batchNumber = res.value;
  }
  if (p.expiry !== undefined) {
    const res = validateBoundedString(p.expiry, 'stocktaking_item.expiry', 0, 32);
    if (!res.ok) return res.failure;
    mutable.expiry = res.value;
  }
  if (p.unit !== undefined) {
    if (typeof p.unit !== 'string' || !VALID_UNIT_KINDS.has(p.unit)) {
      return fail('SCHEMA_VALIDATION_ERROR', `Invalid stocktaking_item unit "${String(p.unit)}".`);
    }
    mutable.unit = p.unit;
  }
  if (p.sellPrice !== undefined) {
    const sp = parseStrictFiniteNumber(p.sellPrice);
    if (sp === null || sp < 0) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Stocktaking item sellPrice must be finite >= 0.');
    }
    mutable.sellPrice = sp;
  }
  if (p.variancePacks !== undefined) {
    const vp = parseStrictFiniteNumber(p.variancePacks);
    if (vp === null || Math.abs(vp - variance) > 0.01) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Stocktaking item variancePacks must match variance.');
    }
    mutable.variancePacks = vp;
  }
  if (p.varianceCost !== undefined) {
    const vc = parseStrictFiniteNumber(p.varianceCost);
    if (vc === null || Math.abs(vc - varianceSDG) > 0.02) {
      return fail('SCHEMA_VALIDATION_ERROR', 'Stocktaking item varianceCost must match varianceSDG.');
    }
    mutable.varianceCost = vc;
  }
  if (p.lastScannedAt !== undefined) {
    const res = validateBoundedString(p.lastScannedAt, 'stocktaking_item.lastScannedAt', 0, 64);
    if (!res.ok) return res.failure;
    mutable.lastScannedAt = res.value;
  }

  if (entry.action === 'CREATE') {
    return {
      ok: true,
      op: 'set',
      entityType: 'stocktaking_session_item',
      entityId: entry.entityId,
      branchId,
      documentPath,
      data: {
        id: entry.entityId,
        branchId,
        sessionId,
        medicineId,
        ...mutable,
        createdAt: tsFactory.serverTimestamp(),
      },
    };
  }

  return {
    ok: true,
    op: 'update',
    entityType: 'stocktaking_session_item',
    entityId: entry.entityId,
    branchId,
    documentPath,
    data: mutable,
  };
}

function normalizeCategoryMetadataEntry(
  entry: OutboxEntry,
  branchId: string,
  actorUid: string,
  documentPath: string,
  tsFactory: Required<FirestoreTimestampFactory>
): NormalizeOutboxEntryResult {
  if (entry.entityId !== 'custom_categories') {
    return fail(
      'SCHEMA_VALIDATION_ERROR',
      `category_metadata entityId must be "custom_categories", got "${entry.entityId}".`
    );
  }
  if (entry.action === 'DELETE') {
    return fail('IMMUTABLE_ENTITY_OPERATION', 'Deleting category_metadata is prohibited by firestore.rules.');
  }
  if (entry.action !== 'CREATE' && entry.action !== 'UPDATE') {
    return fail('INVALID_OUTBOX_ENTRY', `Unsupported category_metadata action "${String(entry.action)}"`);
  }

  const p = entry.payload && typeof entry.payload === 'object' ? (entry.payload as Record<string, any>) : null;
  if (!p || !Array.isArray(p.custom_categories)) {
    return fail('SCHEMA_VALIDATION_ERROR', 'category_metadata payload requires custom_categories array.');
  }
  if (p.custom_categories.length > 12) {
    return fail('SCHEMA_VALIDATION_ERROR', 'category_metadata custom_categories cannot exceed 12 items.');
  }

  const seenLower = new Set<string>();
  const validatedCategories: string[] = [];
  for (const rawCat of p.custom_categories) {
    if (!isValidCategoryNameForRules(rawCat)) {
      return fail('SCHEMA_VALIDATION_ERROR', `Invalid category name "${String(rawCat)}" in custom_categories.`);
    }
    const lower = rawCat.toLowerCase();
    if (DEFAULT_CATEGORIES_LOWER.has(lower)) {
      return fail('SCHEMA_VALIDATION_ERROR', `Default category "${rawCat}" cannot appear in custom_categories.`);
    }
    if (seenLower.has(lower)) {
      return fail('SCHEMA_VALIDATION_ERROR', `Case-insensitive duplicate category "${rawCat}" in custom_categories.`);
    }
    seenLower.add(lower);
    validatedCategories.push(rawCat);
  }

  if (entry.action === 'CREATE') {
    return {
      ok: true,
      op: 'set',
      entityType: 'category_metadata',
      entityId: 'custom_categories',
      branchId,
      documentPath,
      data: {
        id: 'custom_categories',
        branchId,
        custom_categories: validatedCategories,
        updatedByUid: actorUid,
        createdAt: tsFactory.serverTimestamp(),
        updatedAt: tsFactory.serverTimestamp(),
      },
    };
  }

  return {
    ok: true,
    op: 'update',
    entityType: 'category_metadata',
    entityId: 'custom_categories',
    branchId,
    documentPath,
    data: {
      custom_categories: validatedCategories,
      updatedByUid: actorUid,
      updatedAt: tsFactory.serverTimestamp(),
    },
  };
}

/**
 * Pure Firestore Rules-compliant Outbox payload normalizer.
 * Converts local IndexedDB OutboxEntry payloads into allowlisted, CREATE-vs-UPDATE-safe
 * Firestore payloads matching firestore.rules line-by-line, failing closed on any invariant breach.
 */
export function normalizeOutboxEntryForFirestore(
  entry: OutboxEntry,
  context: NormalizeOutboxEntryContext
): NormalizeOutboxEntryResult {
  if (!entry || typeof entry !== 'object') {
    return fail('INVALID_OUTBOX_ENTRY', 'Outbox entry must be a non-null object.');
  }

  const actorUid = typeof context?.actorUid === 'string' ? context.actorUid.trim() : '';
  if (!isValidFirebaseActorUid(actorUid) || !isValidFirestoreDocumentId(actorUid)) {
    return fail('ACTOR_UID_MISSING_OR_MISMATCH', 'Verified actorUid is required for Firestore normalization.');
  }
  const entryActor = typeof entry.actorUid === 'string' ? entry.actorUid.trim() : '';
  if (!entryActor || entryActor !== actorUid) {
    return fail(
      'ACTOR_UID_MISSING_OR_MISMATCH',
      `Outbox entry actorUid (${entryActor || 'missing'}) does not match verified actorUid (${actorUid}).`
    );
  }

  const entryBranchId = typeof entry.branchId === 'string' ? entry.branchId.trim() : '';
  if (!isValidFirestoreDocumentId(entryBranchId)) {
    return fail('INVALID_FIRESTORE_ID', `Outbox entry branchId "${entryBranchId}" is not a valid Firestore ID.`);
  }
  if (context.branchId !== undefined) {
    const contextBranchId = typeof context.branchId === 'string' ? context.branchId.trim() : '';
    if (!isValidFirestoreDocumentId(contextBranchId) || contextBranchId !== entryBranchId) {
      return fail(
        'BRANCH_ID_MISMATCH',
        `Context branchId (${String(context.branchId)}) mismatches outbox entry branchId (${entryBranchId}).`
      );
    }
  }
  if (entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)) {
    const rawPayloadBranchId = (entry.payload as Record<string, unknown>).branchId;
    if (rawPayloadBranchId !== undefined && rawPayloadBranchId !== null) {
      const payloadBranchId = typeof rawPayloadBranchId === 'string' ? rawPayloadBranchId.trim() : '';
      if (!isValidFirestoreDocumentId(payloadBranchId) || payloadBranchId !== entryBranchId) {
        return fail(
          'BRANCH_ID_MISMATCH',
          `Payload branchId (${String(rawPayloadBranchId)}) mismatches outbox entry branchId (${entryBranchId}).`
        );
      }
    }
  }

  const branchId = entryBranchId;
  if (!isValidFirestoreDocumentId(entry.entityId)) {
    return fail('INVALID_FIRESTORE_ID', `Outbox entry entityId "${entry.entityId}" is not a valid Firestore ID.`);
  }

  const rawPayload =
    entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
      ? (entry.payload as Record<string, unknown>)
      : null;
  const parentIds =
    entry.entityType === 'stocktaking_session_item' &&
    rawPayload &&
    typeof rawPayload.sessionId === 'string'
      ? { sessionId: rawPayload.sessionId.trim() }
      : undefined;

  let documentPath: string;
  try {
    documentPath = buildCanonicalFirestoreDocumentPath(branchId, entry.entityType, entry.entityId, parentIds);
  } catch (err: any) {
    return fail(
      'INVALID_FIRESTORE_ID',
      err instanceof Error ? err.message : 'Unable to derive canonical Firestore document path.'
    );
  }

  const tsFactory = getTimestampFactory(context.timestampFactory);

  switch (entry.entityType) {
    case 'medicine':
      return normalizeMedicineEntry(entry, branchId, actorUid, documentPath, tsFactory, context.medicineSchemaVersion ?? 1);
    case 'sale':
      return normalizeSaleEntry(entry, branchId, actorUid, documentPath, tsFactory);
    case 'inventory_ledger':
      return normalizeInventoryLedgerEntry(entry, branchId, actorUid, documentPath, context, tsFactory);
    case 'receipt':
      return normalizeReceiptEntry();
    case 'supplier':
      return normalizeSupplierEntry(entry, branchId, actorUid, documentPath, tsFactory);
    case 'purchase_invoice':
      return normalizePurchaseInvoiceEntry(entry, branchId, documentPath, tsFactory);
    case 'supplier_transaction':
      return normalizeSupplierTransactionEntry(entry, branchId, documentPath, tsFactory);
    case 'stocktaking_session':
      return normalizeStocktakingSessionEntry(entry, branchId, actorUid, documentPath, tsFactory);
    case 'stocktaking_session_item':
      return normalizeStocktakingSessionItemEntry(entry, branchId, actorUid, documentPath, tsFactory);
    case 'category_metadata':
      return normalizeCategoryMetadataEntry(entry, branchId, actorUid, documentPath, tsFactory);
    default:
      return fail('INVALID_OUTBOX_ENTRY', `Unknown outbox entityType "${String(entry.entityType)}".`);
  }
}

export { getCanonicalOutboxOperationId };
