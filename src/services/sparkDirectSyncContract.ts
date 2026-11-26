/**
 * Phase 2D — Workstream D: Firebase Spark Direct Firestore Sync Contract
 * - Medicine V2 DTO (DIRECT_PACK with absent solid-only mirrors + SOLID_TWO_LEVEL with exact mirror parity)
 * - Explicit Multi-Device Conflict Policy (never silent overwrite on packingLocked / stale version divergence)
 * - Sale + Ledger Consistency Model (syncState: 'pending_ledger' | 'complete', expectedLedgerCount, syncOperationId)
 * - Strictly Zero-Cost (Spark Direct Client SDK -> Firestore Rules only; zero Cloud Functions).
 */

export type MedicineV2Mode = 'DIRECT_PACK' | 'SOLID_TWO_LEVEL';

export interface MedicineV2UnitDefinitionDTO {
  readonly mode: MedicineV2Mode;
  readonly dosageForm: string;
  readonly baseUnitLabel: string;
  readonly baseUnitsPerPack: number;
  readonly stripsPerPack?: number;
  readonly pillsPerStrip?: number;
  readonly verificationState: 'VERIFIED';
}

export interface MedicineV2OpeningStockEvidenceDTO {
  readonly mode: 'OMITTED' | 'EXPLICIT_ZERO' | 'POSITIVE';
  readonly intendedInitialStock: number;
  readonly intendedBaseUnits: number;
  readonly initialLedgerMovementId?: string | null;
  readonly recordedAt?: string;
}

export type MedicineV2SyncDeferReason =
  | 'MEDICINE_SYNC_DEFERRED_UNKNOWN_PACKING'
  | 'MEDICINE_SYNC_REJECTED_INVALID_PACKING'
  | 'MEDICINE_SYNC_DEFERRED_UNVERIFIED_PACKING'
  | 'MEDICINE_SYNC_DEFERRED_QUARANTINED_PACKING';

export type MedicineV2PayloadResolution =
  | {
      readonly ok: true;
      readonly mode: MedicineV2Mode;
      readonly mutableFields: Record<string, unknown>;
      readonly openingStockEvidence?: MedicineV2OpeningStockEvidenceDTO;
    }
  | {
      readonly ok: false;
      readonly reasonCode: MedicineV2SyncDeferReason;
      readonly error: string;
    };

export type MedicineConflictType =
  | 'PACKING_LOCK_VIOLATION'
  | 'STALE_VERSION_CONFLICT'
  | 'UNIT_DEFINITION_DIVERGENCE';

export interface MedicineSyncConflictReport {
  readonly hasConflict: boolean;
  readonly isIdentical: boolean;
  readonly conflictType?: MedicineConflictType;
  readonly requiresManualReview: boolean;
  readonly reason?: string;
  readonly localSnapshot: Readonly<Record<string, unknown>>;
  readonly remoteSnapshot: Readonly<Record<string, unknown>>;
}

export const SPARK_DIRECT_COMPLETE_MAX_LEDGERS = 6;
export const SPARK_DIRECT_COMPLETE_MAX_DOC_ACCESS_BUDGET = 12;
export const SPARK_LEDGER_VERIFICATION_SLICE_SIZE = 6;

const VALID_FIRESTORE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidFirestoreIdFormat(v: unknown): v is string {
  return typeof v === 'string' && VALID_FIRESTORE_ID_RE.test(v);
}

/**
 * H-45-1: Canonical timestamp representation helper.
 * Normalizes Firestore Timestamp objects (both SDK instances with toMillis/toDate and plain
 * { seconds, nanoseconds } / { _seconds, _nanoseconds } objects), Date instances, and ISO strings
 * so equivalent instants never produce false PACKING_LOCK_VIOLATION conflicts while genuine
 * mutations to packingLockedAt are still detected and rejected.
 */
export function extractCanonicalTimestampMillis(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.toMillis === 'function') {
      const ms = (obj.toMillis as () => unknown)();
      if (typeof ms === 'number' && Number.isFinite(ms)) return ms;
    }
    if (typeof obj.toDate === 'function') {
      const d = (obj.toDate as () => unknown)();
      if (d instanceof Date && Number.isFinite(d.getTime())) return d.getTime();
    }
    const sec =
      typeof obj.seconds === 'number'
        ? obj.seconds
        : typeof obj._seconds === 'number'
          ? obj._seconds
          : null;
    const nano =
      typeof obj.nanoseconds === 'number'
        ? obj.nanoseconds
        : typeof obj._nanoseconds === 'number'
          ? obj._nanoseconds
          : 0;
    if (sec !== null && Number.isFinite(sec) && Number.isFinite(nano)) {
      return sec * 1000 + Math.trunc(nano / 1_000_000);
    }
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function serializePackingLockedAt(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const ms = extractCanonicalTimestampMillis(value);
  if (ms !== null) {
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().slice(0, 64);
    return trimmed || undefined;
  }
  return undefined;
}

export function areCanonicalTimestampsEqual(localVal: unknown, remoteVal: unknown): boolean {
  const localEmpty = localVal === undefined || localVal === null || localVal === '';
  const remoteEmpty = remoteVal === undefined || remoteVal === null || remoteVal === '';
  if (localEmpty && remoteEmpty) return true;
  if (localEmpty || remoteEmpty) return false;

  const localMs = extractCanonicalTimestampMillis(localVal);
  const remoteMs = extractCanonicalTimestampMillis(remoteVal);
  if (localMs !== null && remoteMs !== null) {
    return localMs === remoteMs;
  }
  if (typeof localVal === 'string' && typeof remoteVal === 'string') {
    return localVal.trim() === remoteVal.trim();
  }
  return false;
}

function isPositiveSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 100_000;
}

function isAbsentValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function sanitizeSecondaryBarcodesLocal(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, 64);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 20) break;
  }
  return out;
}

function normalizeOpeningStockEvidence(
  raw: unknown,
  baseUnitsPerPack?: number
): MedicineV2OpeningStockEvidenceDTO | undefined | 'INVALID' {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') return 'INVALID';
  const ev = raw as Record<string, unknown>;
  const mode = ev.mode;
  if (mode !== 'OMITTED' && mode !== 'EXPLICIT_ZERO' && mode !== 'POSITIVE') return 'INVALID';
  const intendedInitialStock = Number(ev.intendedInitialStock);
  const intendedBaseUnits = Number(ev.intendedBaseUnits);
  if (!Number.isFinite(intendedInitialStock) || !Number.isSafeInteger(intendedBaseUnits)) return 'INVALID';

  const recordedAt =
    typeof ev.recordedAt === 'string' && ev.recordedAt.trim().length >= 10
      ? ev.recordedAt.trim().slice(0, 64)
      : serializePackingLockedAt(ev.recordedAt) ?? new Date().toISOString();

  if (mode === 'OMITTED' || mode === 'EXPLICIT_ZERO') {
    if (intendedInitialStock !== 0 || intendedBaseUnits !== 0) return 'INVALID';
    if (ev.initialLedgerMovementId !== undefined && ev.initialLedgerMovementId !== null) return 'INVALID';
    return Object.freeze({
      mode,
      intendedInitialStock: 0,
      intendedBaseUnits: 0,
      initialLedgerMovementId: null,
      recordedAt,
    });
  }

  // POSITIVE
  if (intendedInitialStock <= 0 || intendedBaseUnits <= 0) return 'INVALID';
  if (baseUnitsPerPack !== undefined && intendedBaseUnits !== intendedInitialStock * baseUnitsPerPack) {
    return 'INVALID';
  }
  if (typeof ev.initialLedgerMovementId !== 'string' || !isValidFirestoreIdFormat(ev.initialLedgerMovementId.trim())) {
    return 'INVALID';
  }
  return Object.freeze({
    mode: 'POSITIVE',
    intendedInitialStock,
    intendedBaseUnits,
    initialLedgerMovementId: ev.initialLedgerMovementId.trim(),
    recordedAt,
  });
}

/**
 * Builds a strict Medicine V2 Firestore DTO supporting both DIRECT_PACK and SOLID_TWO_LEVEL.
 * - DIRECT_PACK: omits solid-only mirrors (stripsPerPack, pillsPerStrip) and forces sellStrip=false, sellPill=false.
 * - SOLID_TWO_LEVEL: enforces positive integer mirrors with exact stripsPerPack * pillsPerStrip === baseUnitsPerPack.
 * - Rejects/defers unverified, quarantined, conflicted, unknown, zero/negative, or contradictory packing.
 */
export function prepareMedicineFirestoreV2Payload(medicine: Record<string, any>): MedicineV2PayloadResolution {
  if (!medicine || typeof medicine !== 'object') {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
      error: 'Medicine payload must be a valid object.',
    };
  }

  // 1. Quarantine / conflict check (fail closed)
  const migrationStatus = String(medicine.unitMigrationStatus || '').trim();
  const configStatus = String(medicine.configStatus || '').trim();
  const nestedConfigStatus = String(medicine.unitDefinition?.configStatus || medicine.unitDefinition?.verificationState || '').trim();

  if (
    migrationStatus === 'QUARANTINED' ||
    migrationStatus === 'CONFLICTED' ||
    configStatus === 'QUARANTINED' ||
    configStatus === 'CONFLICTED' ||
    nestedConfigStatus === 'QUARANTINED' ||
    nestedConfigStatus === 'CONFLICTED'
  ) {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_DEFERRED_QUARANTINED_PACKING',
      error: 'Medicine V2 sync deferred: quarantined or conflicted medicine cannot be written to cloud.',
    };
  }

  // 2. Verification gate (fail closed)
  if (
    medicine.unitOperationalAllowed === false ||
    (configStatus !== '' && configStatus !== 'VERIFIED') ||
    (nestedConfigStatus !== '' && nestedConfigStatus !== 'VERIFIED')
  ) {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_DEFERRED_UNVERIFIED_PACKING',
      error: 'Medicine V2 sync deferred: unit configuration is not operationally VERIFIED.',
    };
  }

  // 3. Determine mode (DIRECT_PACK vs SOLID_TWO_LEVEL)
  const unitDef = medicine.unitDefinition && typeof medicine.unitDefinition === 'object' ? medicine.unitDefinition : null;
  const hierarchy = unitDef?.hierarchy && typeof unitDef.hierarchy === 'object' ? unitDef.hierarchy : null;
  const declaredMode = unitDef?.mode || hierarchy?.kind;

  // Validate optional openingStockEvidence (preliminary structural check; baseUnitsPerPack parity checked per mode below)
  const rawOpeningStockEvidence = medicine.openingStockEvidence;
  const normalizedEvidencePrelim = normalizeOpeningStockEvidence(rawOpeningStockEvidence);
  if (normalizedEvidencePrelim === 'INVALID') {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
      error: 'Medicine V2 sync rejected: malformed openingStockEvidence.',
    };
  }

  const dosageFormRaw = String(medicine.dosageForm || unitDef?.dosageForm || '').trim();
  if (dosageFormRaw === 'Unknown') {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
      error: 'Medicine V2 sync rejected: dosageForm cannot be Unknown.',
    };
  }

  const syncVersion =
    typeof medicine.syncVersion === 'number' && Number.isSafeInteger(medicine.syncVersion) && medicine.syncVersion >= 1
      ? medicine.syncVersion
      : 1;

  const canonicalLockedAt = serializePackingLockedAt(medicine.packingLockedAt);

  const baseCommon: Record<string, unknown> = {
    barcode: String(medicine.barcode || '').slice(0, 64),
    name: String(medicine.name || 'Unnamed').slice(0, 200),
    category: String(medicine.category || 'General').slice(0, 80),
    minStock: Math.max(0, Number(medicine.minStock) || 0),
    buyPrice: Math.max(0, Number(medicine.buyPrice) || 0),
    sellPrice: Math.max(0, Number(medicine.sellPrice) || 0),
    sellPriceStrip:
      medicine.sellPriceStrip !== undefined && medicine.sellPriceStrip !== null
        ? Math.max(0, Number(medicine.sellPriceStrip) || 0)
        : null,
    sellPricePill:
      medicine.sellPricePill !== undefined && medicine.sellPricePill !== null
        ? Math.max(0, Number(medicine.sellPricePill) || 0)
        : null,
    sellPack: medicine.sellPack !== false,
    expiry: String(medicine.expiry || '').slice(0, 32),
    unitType: 'pack',
    ...(medicine.batchNumber ? { batchNumber: String(medicine.batchNumber).slice(0, 64) } : {}),
    secondaryBarcodes: sanitizeSecondaryBarcodesLocal(medicine.secondaryBarcodes),
    archived: Boolean(medicine.archived),
    packingLocked: Boolean(medicine.packingLocked),
    ...(canonicalLockedAt !== undefined ? { packingLockedAt: canonicalLockedAt } : {}),
    ...(medicine.packingLockReason ? { packingLockReason: String(medicine.packingLockReason).slice(0, 120) } : {}),
    unitMigrationStatus: migrationStatus === 'NATIVE_V2' ? 'NATIVE_V2' : 'VERIFIED',
    configStatus: 'VERIFIED',
    unitSchemaVersion: 2,
    syncVersion,
  };

  // --- DIRECT_PACK path ---
  if (declaredMode === 'DIRECT_PACK') {
    // Reject solid-only fields or strip/pill sale flags on DIRECT_PACK
    if (!isAbsentValue(medicine.stripsPerPack) || !isAbsentValue(medicine.pillsPerStrip)) {
      return {
        ok: false,
        reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
        error: 'Medicine V2 sync rejected: DIRECT_PACK must NOT carry solid-only stripsPerPack/pillsPerStrip mirrors.',
      };
    }
    if (medicine.sellStrip === true || medicine.sellPill === true) {
      return {
        ok: false,
        reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
        error: 'Medicine V2 sync rejected: DIRECT_PACK cannot enable sellStrip or sellPill.',
      };
    }
    const baseUnitsPerPack = Number(
      unitDef?.baseUnitsPerPack ?? hierarchy?.baseUnitsPerPack ?? medicine.baseUnitsPerPack ?? 1,
    );
    if (!isPositiveSafeInt(baseUnitsPerPack)) {
      return {
        ok: false,
        reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
        error: 'Medicine V2 sync rejected: DIRECT_PACK requires positive integer baseUnitsPerPack >= 1.',
      };
    }
    if (
      medicine.baseUnitsPerPack !== undefined &&
      medicine.baseUnitsPerPack !== null &&
      Number(medicine.baseUnitsPerPack) !== baseUnitsPerPack
    ) {
      return {
        ok: false,
        reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
        error: 'Medicine V2 sync rejected: top-level baseUnitsPerPack disagrees with unitDefinition.',
      };
    }
    const dosageForm = (dosageFormRaw || 'Liquid').slice(0, 48);
    const baseUnitLabel = String(medicine.baseUnitLabel || unitDef?.baseUnitLabel || 'unit').trim().slice(0, 32) || 'unit';

    const dtoUnitDef: MedicineV2UnitDefinitionDTO = {
      mode: 'DIRECT_PACK',
      dosageForm,
      baseUnitLabel,
      baseUnitsPerPack,
      verificationState: 'VERIFIED',
    };

    const mutableFields: Record<string, unknown> = {
      ...baseCommon,
      sellStrip: false,
      sellPill: false,
      sellPriceStrip: null,
      sellPricePill: null,
      dosageForm,
      baseUnitLabel,
      baseUnitsPerPack,
      unitDefinition: dtoUnitDef,
    };
    // Explicitly guarantee absence of solid-only mirrors
    delete mutableFields.stripsPerPack;
    delete mutableFields.pillsPerStrip;

    const validatedEvidence = normalizeOpeningStockEvidence(rawOpeningStockEvidence, baseUnitsPerPack);
    if (validatedEvidence === 'INVALID') {
      return {
        ok: false,
        reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
        error: 'Medicine V2 sync rejected: openingStockEvidence intendedBaseUnits does not match intendedInitialStock * baseUnitsPerPack.',
      };
    }

    return {
      ok: true,
      mode: 'DIRECT_PACK',
      mutableFields,
      ...(validatedEvidence ? { openingStockEvidence: validatedEvidence } : {}),
    };
  }

  // --- SOLID_TWO_LEVEL path ---
  const stripsAbsent = isAbsentValue(medicine.stripsPerPack) && isAbsentValue(unitDef?.stripsPerPack ?? hierarchy?.stripsPerPack);
  const pillsAbsent = isAbsentValue(medicine.pillsPerStrip) && isAbsentValue(unitDef?.pillsPerStrip ?? hierarchy?.pillsPerStrip);
  if (stripsAbsent && pillsAbsent) {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_DEFERRED_UNKNOWN_PACKING',
      error: 'Medicine V2 sync deferred: packing dimensions are unknown (never fabricates 2x10).',
    };
  }

  const rawStrips = medicine.stripsPerPack ?? unitDef?.stripsPerPack ?? hierarchy?.stripsPerPack;
  const rawPills = medicine.pillsPerStrip ?? unitDef?.pillsPerStrip ?? hierarchy?.pillsPerStrip;
  if (!isPositiveSafeInt(rawStrips) || !isPositiveSafeInt(rawPills)) {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
      error: 'Medicine V2 sync rejected: SOLID_TWO_LEVEL requires positive integer stripsPerPack and pillsPerStrip.',
    };
  }

  // Check mirror parity against nested unitDefinition / hierarchy if supplied
  const nestedStrips = unitDef?.stripsPerPack ?? hierarchy?.stripsPerPack;
  const nestedPills = unitDef?.pillsPerStrip ?? hierarchy?.pillsPerStrip;
  if (
    (nestedStrips !== undefined && Number(nestedStrips) !== rawStrips) ||
    (nestedPills !== undefined && Number(nestedPills) !== rawPills)
  ) {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
      error: 'Medicine V2 sync rejected: top-level stripsPerPack/pillsPerStrip disagree with unitDefinition.',
    };
  }

  const expectedBaseUnits = rawStrips * rawPills;
  const declaredBaseUnits = medicine.baseUnitsPerPack ?? unitDef?.baseUnitsPerPack ?? hierarchy?.baseUnitsPerPack;
  if (declaredBaseUnits !== undefined && declaredBaseUnits !== null && Number(declaredBaseUnits) !== expectedBaseUnits) {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
      error: `Medicine V2 sync rejected: baseUnitsPerPack (${declaredBaseUnits}) !== stripsPerPack * pillsPerStrip (${expectedBaseUnits}).`,
    };
  }

  const dosageForm = (dosageFormRaw || 'Tablet').slice(0, 48);
  const baseUnitLabel = String(medicine.baseUnitLabel || unitDef?.baseUnitLabel || 'pill').trim().slice(0, 32) || 'pill';

  const dtoUnitDef: MedicineV2UnitDefinitionDTO = {
    mode: 'SOLID_TWO_LEVEL',
    dosageForm,
    baseUnitLabel,
    baseUnitsPerPack: expectedBaseUnits,
    stripsPerPack: rawStrips,
    pillsPerStrip: rawPills,
    verificationState: 'VERIFIED',
  };

  const validatedEvidence = normalizeOpeningStockEvidence(rawOpeningStockEvidence, expectedBaseUnits);
  if (validatedEvidence === 'INVALID') {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
      error: 'Medicine V2 sync rejected: openingStockEvidence intendedBaseUnits does not match intendedInitialStock * baseUnitsPerPack.',
    };
  }

  return {
    ok: true,
    mode: 'SOLID_TWO_LEVEL',
    mutableFields: {
      ...baseCommon,
      sellStrip: Boolean(medicine.sellStrip),
      sellPill: Boolean(medicine.sellPill),
      dosageForm,
      baseUnitLabel,
      baseUnitsPerPack: expectedBaseUnits,
      stripsPerPack: rawStrips,
      pillsPerStrip: rawPills,
      unitDefinition: dtoUnitDef,
    },
    ...(validatedEvidence ? { openingStockEvidence: validatedEvidence } : {}),
  };
}

function extractDimensions(doc: Record<string, any>) {
  return {
    mode: doc?.unitDefinition?.mode ?? (doc?.stripsPerPack ? 'SOLID_TWO_LEVEL' : 'UNKNOWN'),
    dosageForm: doc?.dosageForm ?? doc?.unitDefinition?.dosageForm ?? null,
    baseUnitLabel: doc?.baseUnitLabel ?? doc?.unitDefinition?.baseUnitLabel ?? null,
    baseUnitsPerPack: doc?.baseUnitsPerPack ?? doc?.unitDefinition?.baseUnitsPerPack ?? null,
    stripsPerPack: doc?.stripsPerPack ?? doc?.unitDefinition?.stripsPerPack ?? null,
    pillsPerStrip: doc?.pillsPerStrip ?? doc?.unitDefinition?.pillsPerStrip ?? null,
  };
}

function dimensionsEqual(a: ReturnType<typeof extractDimensions>, b: ReturnType<typeof extractDimensions>): boolean {
  return (
    a.mode === b.mode &&
    a.dosageForm === b.dosageForm &&
    a.baseUnitLabel === b.baseUnitLabel &&
    a.baseUnitsPerPack === b.baseUnitsPerPack &&
    a.stripsPerPack === b.stripsPerPack &&
    a.pillsPerStrip === b.pillsPerStrip
  );
}

/**
 * Immutable locked fields enforced by PR #43 firestore.rules (canUpdateMedicine).
 */
export const LOCKED_MEDICINE_IMMUTABLE_FIELDS = Object.freeze([
  'packingLocked',
  'packingLockedAt',
  'packingLockReason',
  'stripsPerPack',
  'pillsPerStrip',
  'baseUnitsPerPack',
  'baseUnitLabel',
  'dosageForm',
  'unitType',
  'unitDefinition',
  'unitSchemaVersion',
  'configStatus',
  'unitMigrationStatus',
  'sellPack',
  'sellStrip',
  'sellPill',
] as const);

/**
 * H-45-1: Detects any attempted mutation to locked packing fields while performing
 * canonical Timestamp comparison on packingLockedAt (Firestore Timestamp vs Date vs ISO string).
 */
export function detectLockedPackingViolations(
  localPayload: Record<string, any>,
  remoteDoc: Record<string, any>
): string[] {
  if (remoteDoc?.packingLocked !== true) return [];
  const violations: string[] = [];

  if (localPayload?.packingLocked === false) {
    violations.push('packingLocked');
  }

  const localDims = extractDimensions(localPayload);
  const remoteDims = extractDimensions(remoteDoc);
  if (localDims.mode !== remoteDims.mode) violations.push('unitDefinition.mode');
  if (localDims.dosageForm !== remoteDims.dosageForm) violations.push('dosageForm');
  if (localDims.baseUnitLabel !== remoteDims.baseUnitLabel) violations.push('baseUnitLabel');
  if (localDims.baseUnitsPerPack !== remoteDims.baseUnitsPerPack) violations.push('baseUnitsPerPack');
  if (localDims.stripsPerPack !== remoteDims.stripsPerPack) violations.push('stripsPerPack');
  if (localDims.pillsPerStrip !== remoteDims.pillsPerStrip) violations.push('pillsPerStrip');

  // Selling-unit toggle immutability
  for (const flag of ['sellPack', 'sellStrip', 'sellPill'] as const) {
    if (flag in localPayload && flag in remoteDoc && Boolean(localPayload[flag]) !== Boolean(remoteDoc[flag])) {
      violations.push(flag);
    }
  }

  // Schema & migration metadata immutability
  for (const metaField of ['unitType', 'unitSchemaVersion', 'configStatus', 'unitMigrationStatus'] as const) {
    if (
      localPayload[metaField] !== undefined &&
      remoteDoc[metaField] !== undefined &&
      localPayload[metaField] !== remoteDoc[metaField]
    ) {
      violations.push(metaField);
    }
  }

  // packingLockReason immutability (only if local supplies a conflicting reason)
  if (
    localPayload.packingLockReason !== undefined &&
    localPayload.packingLockReason !== null &&
    remoteDoc.packingLockReason !== undefined &&
    remoteDoc.packingLockReason !== null &&
    String(localPayload.packingLockReason).trim() !== String(remoteDoc.packingLockReason).trim()
  ) {
    violations.push('packingLockReason');
  }

  // H-45-1: Canonical Timestamp comparison for packingLockedAt
  const localHasLockedAt =
    localPayload.packingLockedAt !== undefined &&
    localPayload.packingLockedAt !== null &&
    localPayload.packingLockedAt !== '';
  const remoteHasLockedAt =
    remoteDoc.packingLockedAt !== undefined &&
    remoteDoc.packingLockedAt !== null &&
    remoteDoc.packingLockedAt !== '';
  if (localHasLockedAt && remoteHasLockedAt) {
    if (!areCanonicalTimestampsEqual(localPayload.packingLockedAt, remoteDoc.packingLockedAt)) {
      violations.push('packingLockedAt');
    }
  } else if (localHasLockedAt && !remoteHasLockedAt) {
    violations.push('packingLockedAt');
  }

  return violations;
}

function stringArraysEqual(a: unknown, b: unknown): boolean {
  const arrA = Array.isArray(a) ? a.map(String) : [];
  const arrB = Array.isArray(b) ? b.map(String) : [];
  if (arrA.length !== arrB.length) return false;
  return arrA.every((v, idx) => v === arrB[idx]);
}

/**
 * Phase 2D Workstream D5: Explicit Multi-Device Conflict Policy.
 * Never silently overwrites remote locked dimensions or higher-version remote mutations.
 * Preserves full local and remote evidence snapshots for manual reconciliation.
 */
export function detectMedicineSyncConflict(params: {
  localPayload: Record<string, any>;
  remoteDoc: Record<string, any>;
  expectedRemoteSyncVersion?: number;
}): MedicineSyncConflictReport {
  const { localPayload, remoteDoc, expectedRemoteSyncVersion } = params;
  const localDims = extractDimensions(localPayload);
  const remoteDims = extractDimensions(remoteDoc);
  const dimsMatch = dimensionsEqual(localDims, remoteDims);

  const localSnap = Object.freeze({ ...localPayload });
  const remoteSnap = Object.freeze({ ...remoteDoc });

  // 1. Sticky packingLocked protection: remote locked + local attempts ANY immutable locked-field change -> CONFLICT
  const lockedViolations = detectLockedPackingViolations(localPayload, remoteDoc);
  if (lockedViolations.length > 0) {
    return Object.freeze({
      hasConflict: true,
      isIdentical: false,
      conflictType: 'PACKING_LOCK_VIOLATION',
      requiresManualReview: true,
      reason: `Remote medicine packing is permanently locked; immutable field(s) cannot change: ${lockedViolations.join(', ')}.`,
      localSnapshot: localSnap,
      remoteSnapshot: remoteSnap,
    });
  }

  // 2. Unit-mode / dimensional divergence without explicit version superiority
  const remoteVersion = typeof remoteDoc?.syncVersion === 'number' ? remoteDoc.syncVersion : 0;
  const localExpected =
    expectedRemoteSyncVersion !== undefined
      ? expectedRemoteSyncVersion
      : typeof localPayload?.syncVersion === 'number'
        ? localPayload.syncVersion
        : 0;

  if (
    remoteDoc?.unitDefinition?.mode &&
    localPayload?.unitDefinition?.mode &&
    remoteDoc.unitDefinition.mode !== localPayload.unitDefinition.mode &&
    remoteVersion >= localExpected
  ) {
    return Object.freeze({
      hasConflict: true,
      isIdentical: false,
      conflictType: 'UNIT_DEFINITION_DIVERGENCE',
      requiresManualReview: true,
      reason: `Unit mode conflict: remote=${remoteDoc.unitDefinition.mode} vs local=${localPayload.unitDefinition.mode}.`,
      localSnapshot: localSnap,
      remoteSnapshot: remoteSnap,
    });
  }

  // 3. Stale version conflict: remote version is strictly ahead of expected base version and substantive fields differ
  const fieldsDiffer =
    !dimsMatch ||
    String(remoteDoc?.name ?? '') !== String(localPayload?.name ?? '') ||
    String(remoteDoc?.barcode ?? '') !== String(localPayload?.barcode ?? '') ||
    String(remoteDoc?.category ?? '') !== String(localPayload?.category ?? '') ||
    Number(remoteDoc?.minStock ?? 0) !== Number(localPayload?.minStock ?? 0) ||
    Number(remoteDoc?.buyPrice ?? 0) !== Number(localPayload?.buyPrice ?? 0) ||
    Number(remoteDoc?.sellPrice ?? 0) !== Number(localPayload?.sellPrice ?? 0) ||
    (remoteDoc?.sellPriceStrip ?? null) !== (localPayload?.sellPriceStrip ?? null) ||
    (remoteDoc?.sellPricePill ?? null) !== (localPayload?.sellPricePill ?? null) ||
    String(remoteDoc?.expiry ?? '') !== String(localPayload?.expiry ?? '') ||
    String(remoteDoc?.batchNumber ?? '') !== String(localPayload?.batchNumber ?? '') ||
    !stringArraysEqual(remoteDoc?.secondaryBarcodes, localPayload?.secondaryBarcodes) ||
    Boolean(remoteDoc?.archived) !== Boolean(localPayload?.archived);

  if (remoteVersion > 0 && localExpected > 0 && remoteVersion > localExpected && fieldsDiffer) {
    return Object.freeze({
      hasConflict: true,
      isIdentical: false,
      conflictType: 'STALE_VERSION_CONFLICT',
      requiresManualReview: true,
      reason: `Remote syncVersion (${remoteVersion}) is ahead of local base version (${localExpected}) with diverging fields.`,
      localSnapshot: localSnap,
      remoteSnapshot: remoteSnap,
    });
  }

  return Object.freeze({
    hasConflict: false,
    isIdentical: !fieldsDiffer,
    requiresManualReview: false,
    localSnapshot: localSnap,
    remoteSnapshot: remoteSnap,
  });
}

export interface SaleRecoveryExpectedLedgerCheck {
  readonly ok: boolean;
  readonly remoteExpectedIds: readonly string[];
  readonly verifiedLedgerCount: number;
  readonly error?: string;
}

/**
 * H-45-2: Reconciles remote sale metadata & expectedLedgerIds against local expected movement IDs.
 * Rejects missing, malformed, duplicated, mismatched, or unexpected ID sets.
 */
export function reconcileRemoteSaleExpectedLedgerIds(params: {
  branchId: string;
  saleId: string;
  remoteSaleData: Record<string, unknown> | null | undefined;
  localExpectedLedgerIds: readonly string[];
}): SaleRecoveryExpectedLedgerCheck {
  const { branchId, saleId, remoteSaleData, localExpectedLedgerIds } = params;
  if (!remoteSaleData || typeof remoteSaleData !== 'object') {
    return {
      ok: false,
      remoteExpectedIds: [],
      verifiedLedgerCount: 0,
      error: 'Remote sale document data is missing or malformed.',
    };
  }
  if (remoteSaleData.id !== saleId || remoteSaleData.branchId !== branchId) {
    return {
      ok: false,
      remoteExpectedIds: [],
      verifiedLedgerCount: 0,
      error: `Remote sale identity mismatch: expected (${branchId}/${saleId}), got (${String(remoteSaleData.branchId)}/${String(remoteSaleData.id)}).`,
    };
  }
  if (localExpectedLedgerIds.length === 0 || new Set(localExpectedLedgerIds).size !== localExpectedLedgerIds.length) {
    return {
      ok: false,
      remoteExpectedIds: [],
      verifiedLedgerCount: 0,
      error: 'Local expectedLedgerIds must be non-empty and duplicate-free.',
    };
  }

  const hasSyncMeta =
    'syncState' in remoteSaleData ||
    'expectedLedgerCount' in remoteSaleData ||
    'expectedLedgerIds' in remoteSaleData ||
    'verifiedLedgerCount' in remoteSaleData;

  if (!hasSyncMeta) {
    // Legacy V1 sale without Phase 2D sync metadata
    return {
      ok: true,
      remoteExpectedIds: localExpectedLedgerIds,
      verifiedLedgerCount: localExpectedLedgerIds.length,
    };
  }

  const rawIds = remoteSaleData.expectedLedgerIds;
  const rawCount = remoteSaleData.expectedLedgerCount;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return {
      ok: false,
      remoteExpectedIds: [],
      verifiedLedgerCount: 0,
      error: 'Remote Phase 2D sale is missing a valid expectedLedgerIds array.',
    };
  }
  if (typeof rawCount !== 'number' || !Number.isSafeInteger(rawCount) || rawCount !== rawIds.length) {
    return {
      ok: false,
      remoteExpectedIds: [],
      verifiedLedgerCount: 0,
      error: `Remote expectedLedgerCount (${String(rawCount)}) does not match expectedLedgerIds.length (${rawIds.length}).`,
    };
  }

  const seen = new Set<string>();
  const remoteIds: string[] = [];
  for (const item of rawIds) {
    if (!isValidFirestoreIdFormat(item) || seen.has(item)) {
      return {
        ok: false,
        remoteExpectedIds: [],
        verifiedLedgerCount: 0,
        error: `Remote expectedLedgerIds contains malformed or duplicate ID: ${String(item)}.`,
      };
    }
    seen.add(item);
    remoteIds.push(item);
  }

  if (
    remoteIds.length !== localExpectedLedgerIds.length ||
    !remoteIds.every((id, idx) => id === localExpectedLedgerIds[idx])
  ) {
    return {
      ok: false,
      remoteExpectedIds: remoteIds,
      verifiedLedgerCount: 0,
      error: `Remote expectedLedgerIds [${remoteIds.join(', ')}] do not match local expectedLedgerIds [${localExpectedLedgerIds.join(', ')}].`,
    };
  }

  const rawVerified = remoteSaleData.verifiedLedgerCount;
  const verifiedLedgerCount =
    rawVerified === undefined
      ? remoteSaleData.syncState === 'complete'
        ? rawCount
        : 0
      : typeof rawVerified === 'number' && Number.isSafeInteger(rawVerified) && rawVerified >= 0 && rawVerified <= rawCount
        ? rawVerified
        : -1;
  if (verifiedLedgerCount < 0) {
    return {
      ok: false,
      remoteExpectedIds: remoteIds,
      verifiedLedgerCount: 0,
      error: `Remote verifiedLedgerCount is malformed: ${String(rawVerified)}.`,
    };
  }

  return {
    ok: true,
    remoteExpectedIds: remoteIds,
    verifiedLedgerCount,
  };
}

export interface ExistingLedgerValidationResult {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

/**
 * H-45-2: Strictly validates an existing Firestore SALE inventory_ledger document during retry/recovery.
 * Never accepts a document merely because snap.exists() is true.
 */
export function validateExistingSaleLedgerMovement(params: {
  expectedId: string;
  branchId: string;
  saleId: string;
  expectedData: Record<string, unknown>;
  actualDoc: Record<string, unknown> | null | undefined;
}): ExistingLedgerValidationResult {
  const { expectedId, branchId, saleId, expectedData, actualDoc } = params;
  if (!actualDoc || typeof actualDoc !== 'object') {
    return { ok: false, mismatches: ['document data missing or non-object'] };
  }

  const mismatches: string[] = [];
  if (actualDoc.id !== expectedId) {
    mismatches.push(`id mismatch (expected=${expectedId}, actual=${String(actualDoc.id)})`);
  }
  if (actualDoc.branchId !== branchId) {
    mismatches.push(`branchId mismatch (expected=${branchId}, actual=${String(actualDoc.branchId)})`);
  }
  if (actualDoc.referenceId !== saleId) {
    mismatches.push(`referenceId mismatch (expected=${saleId}, actual=${String(actualDoc.referenceId)})`);
  }
  if (actualDoc.type !== 'SALE') {
    mismatches.push(`type mismatch (expected=SALE, actual=${String(actualDoc.type)})`);
  }
  if (actualDoc.medicineId !== expectedData.medicineId) {
    mismatches.push(`medicineId mismatch (expected=${String(expectedData.medicineId)}, actual=${String(actualDoc.medicineId)})`);
  }
  const validUnits = new Set(['pack', 'strip', 'pill']);
  if (!validUnits.has(String(actualDoc.unit)) || actualDoc.unit !== expectedData.unit) {
    mismatches.push(`unit mismatch (expected=${String(expectedData.unit)}, actual=${String(actualDoc.unit)})`);
  }

  const expectedQty = Number(expectedData.quantityDelta);
  const actualQty = actualDoc.quantityDelta;
  if (typeof actualQty !== 'number' || !Number.isFinite(actualQty) || actualQty >= 0) {
    mismatches.push(`quantityDelta must be a finite negative number (actual=${String(actualQty)})`);
  } else if (Math.abs(actualQty - expectedQty) > 1e-6) {
    mismatches.push(`quantityDelta mismatch (expected=${expectedQty}, actual=${actualQty})`);
  }

  const expectedBase = Number(expectedData.baseUnitsDelta);
  const actualBase = actualDoc.baseUnitsDelta;
  if (typeof actualBase !== 'number' || !Number.isFinite(actualBase) || actualBase >= 0) {
    mismatches.push(`baseUnitsDelta must be a finite negative number (actual=${String(actualBase)})`);
  } else if (Math.abs(actualBase - expectedBase) > 1e-6) {
    mismatches.push(`baseUnitsDelta mismatch (expected=${expectedBase}, actual=${actualBase})`);
  }

  if (!isValidFirestoreIdFormat(actualDoc.userId) || actualDoc.userId !== expectedData.userId) {
    mismatches.push(`userId mismatch (expected=${String(expectedData.userId)}, actual=${String(actualDoc.userId)})`);
  }
  if (
    expectedData.batchNumber !== undefined &&
    String(actualDoc.batchNumber ?? '') !== String(expectedData.batchNumber ?? '')
  ) {
    mismatches.push(`batchNumber mismatch (expected=${String(expectedData.batchNumber)}, actual=${String(actualDoc.batchNumber)})`);
  }
  if (
    expectedData.expiry !== undefined &&
    String(actualDoc.expiry ?? '') !== String(expectedData.expiry ?? '')
  ) {
    mismatches.push(`expiry mismatch (expected=${String(expectedData.expiry)}, actual=${String(actualDoc.expiry)})`);
  }
  if (
    expectedData.invoiceNumber !== undefined &&
    String(actualDoc.invoiceNumber ?? '') !== String(expectedData.invoiceNumber ?? '')
  ) {
    mismatches.push(`invoiceNumber mismatch (expected=${String(expectedData.invoiceNumber)}, actual=${String(actualDoc.invoiceNumber)})`);
  }
  if (typeof expectedData.costPerUnit === 'number') {
    if (typeof actualDoc.costPerUnit !== 'number' || Math.abs(actualDoc.costPerUnit - expectedData.costPerUnit) > 0.01) {
      mismatches.push(`costPerUnit mismatch (expected=${expectedData.costPerUnit}, actual=${String(actualDoc.costPerUnit)})`);
    }
  }
  if (typeof expectedData.costPerBaseUnit === 'number') {
    if (
      typeof actualDoc.costPerBaseUnit !== 'number' ||
      Math.abs(actualDoc.costPerBaseUnit - expectedData.costPerBaseUnit) > 0.01
    ) {
      mismatches.push(`costPerBaseUnit mismatch (expected=${expectedData.costPerBaseUnit}, actual=${String(actualDoc.costPerBaseUnit)})`);
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Phase 2D Workstream D3: Sale + Ledger Explicit Consistency Helper.
 * Multi-batch sales are written with syncState='pending_ledger' until ALL ledger chunks are verified on cloud.
 * Only fully reconciled 'complete' Phase 2D sales (or clean legacy docs without sync metadata) return true.
 */
export function isCloudSaleReconciled(saleDoc: Record<string, unknown> | null | undefined): boolean {
  if (!saleDoc || typeof saleDoc !== 'object') return false;
  const hasSyncMeta =
    'syncState' in saleDoc ||
    'expectedLedgerCount' in saleDoc ||
    'expectedLedgerIds' in saleDoc ||
    'verifiedLedgerCount' in saleDoc;
  if (!hasSyncMeta) return true;
  if (saleDoc.syncState !== 'complete') return false;
  const elc = saleDoc.expectedLedgerCount;
  if (typeof elc !== 'number' || !Number.isSafeInteger(elc) || elc < 1 || elc > 500) return false;
  if ('expectedLedgerIds' in saleDoc && saleDoc.expectedLedgerIds !== undefined) {
    if (!Array.isArray(saleDoc.expectedLedgerIds) || saleDoc.expectedLedgerIds.length !== elc) return false;
    if (new Set(saleDoc.expectedLedgerIds).size !== elc) return false;
  }
  if ('verifiedLedgerCount' in saleDoc && saleDoc.verifiedLedgerCount !== undefined) {
    if (saleDoc.verifiedLedgerCount !== elc) return false;
  }
  return true;
}
