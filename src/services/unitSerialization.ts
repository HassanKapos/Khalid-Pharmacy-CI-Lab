/**
 * PR-2A Universal Unit Serialization, Strict Rehydration & Legacy Compatibility Adapter
 *
 * Pure, side-effect-free boundary adapter over PR-1 `universalUnitPolicy.ts`.
 * - ZERO IndexedDB, Firebase, DOM, localStorage, network, or Outbox calls.
 * - Solves PR-1 LOW-1 (validates structural integrity even when configStatus !== 'VERIFIED').
 * - Solves PR-1 LOW-2 (strict plain-JSON DTO projection & rehydration; rejects fake Set-like
 *   objects, custom prototypes, accessors, unknown fields, duplicate sellableUnits, and
 *   DIRECT_PACK strip/pill keys even when null/undefined).
 * - Never auto-promotes LEGACY_ASSUMED / UNVERIFIED_UNKNOWN / RECONCILIATION_REQUIRED /
 *   QUARANTINED records to VERIFIED, and never fabricates 2x10 or baseUnitsPerPack = 1 defaults.
 *
 * NOTE: `legacyOriginSnapshot` is intentionally omitted from `SerializedUnitDefinitionDTOV2`
 * to eliminate any untyped persistence backdoor and is rejected as an unknown property.
 */

import {
  UnitPolicyError,
  assertUnitDefinitionIntegrity,
  computeBaseDimensionKey,
  computeUnitDefinitionKey,
  createValidatedUnitDefinition,
  inspectLegacyMedicineUnitConfig,
  type BaseUnitKind,
  type DosageFormKind,
  type IntermediateUnitKind,
  type LegacyInspectionResult,
  type PackUnitKind,
  type PhysicalCountingDimension,
  type SupportedUnitKind,
  type UnitConfigurationStatus,
  type UnitDefinition,
  type UnitHierarchy,
} from './universalUnitPolicy.ts';

export const UNIT_DEFINITION_SCHEMA_EPOCH = 2 as const;

export type KnownDosageFormKind = Exclude<DosageFormKind, 'Unknown'>;

export interface SerializedSolidHierarchyDTOV2 {
  readonly kind: 'SOLID_TWO_LEVEL';
  readonly intermediateUnit: 'strip';
  readonly stripsPerPack: number;
  readonly pillsPerStrip: number;
  readonly baseUnitsPerPack: number;
}

export interface SerializedDirectPackHierarchyDTOV2 {
  readonly kind: 'DIRECT_PACK';
  readonly intermediateUnit: null;
  readonly baseUnitsPerPack: number;
}

export type SerializedHierarchyDTOV2 =
  | SerializedSolidHierarchyDTOV2
  | SerializedDirectPackHierarchyDTOV2;

export interface SerializedUnitDefinitionDTOV2 {
  readonly schemaEpoch: typeof UNIT_DEFINITION_SCHEMA_EPOCH;
  readonly dosageForm: KnownDosageFormKind;
  readonly physicalDimension: PhysicalCountingDimension;
  readonly baseDimensionKey: string;
  readonly unitDefinitionKey: string;
  readonly definitionVersion: number;
  readonly baseUnit: BaseUnitKind;
  readonly packUnit: PackUnitKind;
  readonly intermediateUnit: IntermediateUnitKind;
  readonly hierarchy: SerializedHierarchyDTOV2;
  readonly baseUnitsPerPack: number;
  readonly configStatus: UnitConfigurationStatus;
  readonly packingLocked: boolean;
  readonly sellableUnits: ReadonlyArray<SupportedUnitKind>;
}

export type UnitSerializationErrorCode =
  | 'INVALID_DTO_TYPE'
  | 'CUSTOM_PROTOTYPE_FORBIDDEN'
  | 'ACCESSOR_PROPERTY_FORBIDDEN'
  | 'SYMBOL_PROPERTY_FORBIDDEN'
  | 'UNKNOWN_PROPERTY_FORBIDDEN'
  | 'MISSING_REQUIRED_PROPERTY'
  | 'UNSUPPORTED_SCHEMA_EPOCH'
  | 'INVALID_CONFIG_STATUS'
  | 'INVALID_SELLABLE_UNITS'
  | 'DUPLICATE_SELLABLE_UNIT'
  | 'FORBIDDEN_DIRECT_PACK_SOLID_KEY'
  | 'TOP_LEVEL_HIERARCHY_MISMATCH'
  | 'UNIT_DEFINITION_KEY_MISMATCH'
  | 'BASE_DIMENSION_KEY_MISMATCH'
  | 'PHYSICAL_DIMENSION_MISMATCH'
  | 'INVALID_PACKING_LOCKED'
  | 'LEGACY_V2_CONTRADICTION'
  | 'LEGACY_CONTRADICTORY_DATA'
  | 'UNVERIFIED_LEGACY_CLAIM'
  | 'QUARANTINE_CANNOT_BE_LIFTED'
  | 'PR1_POLICY_VIOLATION';

export class UnitSerializationError extends Error {
  readonly code: UnitSerializationErrorCode;
  readonly policyCode?: string;

  constructor(code: UnitSerializationErrorCode, message: string, policyCode?: string) {
    super(`${code}: ${message}`);
    this.name = 'UnitSerializationError';
    this.code = code;
    if (policyCode !== undefined) {
      this.policyCode = policyCode;
    }
  }
}

export type OperationalAuthorizationStatus =
  | 'UNESTABLISHED_NO_INDEPENDENT_AUTHORITY'
  | 'NOT_VERIFIED_CLAIM';

export type EffectiveRehydratedTrustStatus = Exclude<UnitConfigurationStatus, 'VERIFIED'>;

export interface RehydrateUnitDefinitionSuccess {
  readonly ok: true;
  readonly structuralValid: true;
  /** Status claimed inside the untrusted serialized DTO (must NOT be treated as operational proof). */
  readonly claimedConfigStatus: UnitConfigurationStatus;
  /** Conservative runtime trust status: unattested 'VERIFIED' DTO claims clamp to 'UNVERIFIED_UNKNOWN'. */
  readonly trustStatus: EffectiveRehydratedTrustStatus;
  /** Always false in PR-2A because no independent operational authority exists in this pure layer. */
  readonly hasIndependentOperationalAuthorization: false;
  readonly operationalAuthorization: OperationalAuthorizationStatus;
  /** Always false on untrusted DTO rehydration; independent workflow approval is required before operations. */
  readonly isVerifiedForOperations: false;
  /** True iff QUARANTINED status was safely established and preserved. */
  readonly quarantinePreserved: boolean;
  readonly definition: UnitDefinition;
}

export interface RehydrateUnitDefinitionFailure {
  readonly ok: false;
  readonly structuralValid: false;
  readonly claimedConfigStatus?: UnitConfigurationStatus;
  readonly trustStatus: 'UNTRUSTED' | 'QUARANTINED';
  readonly hasIndependentOperationalAuthorization: false;
  readonly operationalAuthorization: 'NOT_VERIFIED_CLAIM';
  readonly isVerifiedForOperations: false;
  readonly quarantinePreserved: boolean;
  readonly errorCode: UnitSerializationErrorCode;
  readonly policyCode?: string;
  readonly message: string;
}

export type RehydrateUnitDefinitionResult =
  | RehydrateUnitDefinitionSuccess
  | RehydrateUnitDefinitionFailure;

export interface LegacyOrV2V2SuccessResult {
  readonly kind: 'V2_REHYDRATED';
  readonly ok: true;
  readonly structuralValid: true;
  readonly claimedConfigStatus: UnitConfigurationStatus;
  readonly trustStatus: EffectiveRehydratedTrustStatus;
  readonly hasIndependentOperationalAuthorization: false;
  readonly operationalAuthorization: OperationalAuthorizationStatus;
  readonly isVerifiedForOperations: false;
  readonly definition: UnitDefinition;
}

export interface LegacyOrV2LegacyResult {
  readonly kind: 'LEGACY_INSPECTED';
  readonly ok: true;
  readonly structuralValid: false;
  readonly claimedConfigStatus?: UnitConfigurationStatus;
  readonly trustStatus: LegacyInspectionResult['configStatus'] | 'QUARANTINED';
  readonly hasIndependentOperationalAuthorization: false;
  readonly operationalAuthorization: 'NOT_VERIFIED_CLAIM';
  readonly isVerifiedForOperations: false;
  readonly quarantinePreserved: boolean;
  readonly inspection: LegacyInspectionResult;
}

export interface LegacyOrV2InvalidResult {
  readonly kind: 'INVALID';
  readonly ok: false;
  readonly structuralValid: false;
  readonly claimedConfigStatus?: UnitConfigurationStatus;
  readonly trustStatus: 'UNTRUSTED' | 'QUARANTINED';
  readonly hasIndependentOperationalAuthorization: false;
  readonly operationalAuthorization: 'NOT_VERIFIED_CLAIM';
  readonly isVerifiedForOperations: false;
  readonly quarantinePreserved: boolean;
  readonly errorCode: UnitSerializationErrorCode;
  readonly policyCode?: string;
  readonly message: string;
}

export type LegacyOrV2RehydrationResult =
  | LegacyOrV2V2SuccessResult
  | LegacyOrV2LegacyResult
  | LegacyOrV2InvalidResult;

const DTO_TOP_LEVEL_KEYS = [
  'schemaEpoch',
  'dosageForm',
  'physicalDimension',
  'baseDimensionKey',
  'unitDefinitionKey',
  'definitionVersion',
  'baseUnit',
  'packUnit',
  'intermediateUnit',
  'hierarchy',
  'baseUnitsPerPack',
  'configStatus',
  'packingLocked',
  'sellableUnits',
] as const;

const DTO_TOP_LEVEL_KEY_SET = new Set<string>(DTO_TOP_LEVEL_KEYS);

const UNIT_DEF_OBJECT_KEYS = [
  'dosageForm',
  'physicalDimension',
  'baseDimensionKey',
  'unitDefinitionKey',
  'definitionVersion',
  'baseUnit',
  'packUnit',
  'intermediateUnit',
  'hierarchy',
  'baseUnitsPerPack',
  'configStatus',
  'packingLocked',
  'sellableUnits',
] as const;

const UNIT_DEF_OBJECT_KEY_SET = new Set<string>(UNIT_DEF_OBJECT_KEYS);

const SOLID_HIERARCHY_KEYS = [
  'kind',
  'intermediateUnit',
  'stripsPerPack',
  'pillsPerStrip',
  'baseUnitsPerPack',
] as const;

const SOLID_HIERARCHY_KEY_SET = new Set<string>(SOLID_HIERARCHY_KEYS);

const DIRECT_PACK_HIERARCHY_KEYS = [
  'kind',
  'intermediateUnit',
  'baseUnitsPerPack',
] as const;

const DIRECT_PACK_HIERARCHY_KEY_SET = new Set<string>(DIRECT_PACK_HIERARCHY_KEYS);

const VALID_CONFIG_STATUS_SET = new Set<string>([
  'VERIFIED',
  'LEGACY_ASSUMED',
  'UNVERIFIED_UNKNOWN',
  'RECONCILIATION_REQUIRED',
  'QUARANTINED',
]);

const KNOWN_DOSAGE_FORMS = new Set<string>([
  'Tablet',
  'Capsule',
  'Syrup',
  'Suspension',
  'InjectionVial',
  'Ampoule',
  'Cream',
  'Ointment',
  'Gel',
  'Drops',
  'Inhaler',
  'Suppository',
  'Sachet',
]);

const EXPECTED_PHYSICAL_DIMENSION: Record<KnownDosageFormKind, PhysicalCountingDimension> = {
  Tablet: 'tablet',
  Capsule: 'capsule',
  Syrup: 'bottle',
  Suspension: 'bottle',
  Drops: 'bottle',
  InjectionVial: 'vial',
  Ampoule: 'ampoule',
  Cream: 'tube',
  Ointment: 'tube',
  Gel: 'tube',
  Inhaler: 'inhaler',
  Suppository: 'suppository',
  Sachet: 'sachet',
};

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function safeDescribeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return `[${typeof value}]`;
}

/**
 * Extracts QUARANTINED evidence strictly via `Object.getOwnPropertyDescriptor` on own data
 * properties only:
 * - Never invokes getters or setters.
 * - Never trusts prototype-inherited `configStatus`.
 * - Never uses `JSON.stringify` or direct property reads (`record.configStatus`).
 */
function isSafeOwnDataConfigStatusQuarantined(candidate: unknown): boolean {
  try {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return false;
    }
    const desc = Object.getOwnPropertyDescriptor(candidate, 'configStatus');
    return (
      desc !== undefined &&
      'value' in desc &&
      desc.get === undefined &&
      desc.set === undefined &&
      desc.value === 'QUARANTINED'
    );
  } catch {
    return false;
  }
}

function extractSafeQuarantineEvidence(raw: unknown): boolean {
  try {
    if (isSafeOwnDataConfigStatusQuarantined(raw)) {
      return true;
    }
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const unitDefDesc = Object.getOwnPropertyDescriptor(raw, 'unitDefinition');
      if (
        unitDefDesc !== undefined &&
        'value' in unitDefDesc &&
        unitDefDesc.get === undefined &&
        unitDefDesc.set === undefined &&
        isSafeOwnDataConfigStatusQuarantined(unitDefDesc.value)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function assertPlainObjectWithClosedAllowlist(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: ReadonlyArray<string>,
  label: string
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnitSerializationError('INVALID_DTO_TYPE', `${label} must be a non-null plain object.`);
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new UnitSerializationError(
      'CUSTOM_PROTOTYPE_FORBIDDEN',
      `${label} must have Object.prototype or null prototype.`
    );
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new UnitSerializationError(
      'SYMBOL_PROPERTY_FORBIDDEN',
      `${label} must not contain symbol own properties.`
    );
  }

  const ownNames = Object.getOwnPropertyNames(value);
  for (const key of ownNames) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
      throw new UnitSerializationError(
        'ACCESSOR_PROPERTY_FORBIDDEN',
        `${label}.${key} must be a plain data property (getters/setters forbidden).`
      );
    }
    if (!allowedKeys.has(key)) {
      throw new UnitSerializationError(
        'UNKNOWN_PROPERTY_FORBIDDEN',
        `${label}.${key} is not in the strict allowlist.`
      );
    }
  }

  for (const required of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, required)) {
      throw new UnitSerializationError(
        'MISSING_REQUIRED_PROPERTY',
        `${label}.${required} is required.`
      );
    }
  }

  return value as Record<string, unknown>;
}

function assertValidConfigStatus(value: unknown, label = 'configStatus'): UnitConfigurationStatus {
  if (typeof value !== 'string' || !VALID_CONFIG_STATUS_SET.has(value)) {
    throw new UnitSerializationError(
      'INVALID_CONFIG_STATUS',
      `${label} '${safeDescribeValue(value)}' is not a valid UnitConfigurationStatus.`
    );
  }
  return value as UnitConfigurationStatus;
}

function assertStrictlyValidHierarchyObject(
  rawHierarchy: unknown,
  label: string
): SerializedHierarchyDTOV2 {
  if (rawHierarchy === null || typeof rawHierarchy !== 'object' || Array.isArray(rawHierarchy)) {
    throw new UnitSerializationError('INVALID_DTO_TYPE', `${label} must be a non-null plain object.`);
  }

  const proto = Object.getPrototypeOf(rawHierarchy);
  if (proto !== Object.prototype && proto !== null) {
    throw new UnitSerializationError(
      'CUSTOM_PROTOTYPE_FORBIDDEN',
      `${label} must have Object.prototype or null prototype.`
    );
  }

  if (Object.getOwnPropertySymbols(rawHierarchy).length > 0) {
    throw new UnitSerializationError(
      'SYMBOL_PROPERTY_FORBIDDEN',
      `${label} must not contain symbol own properties.`
    );
  }

  const rec = rawHierarchy as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(rec)) {
    const desc = Object.getOwnPropertyDescriptor(rec, key);
    if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
      throw new UnitSerializationError(
        'ACCESSOR_PROPERTY_FORBIDDEN',
        `${label}.${key} must be a plain data property.`
      );
    }
  }

  const kind = rec.kind;
  if (kind === 'SOLID_TWO_LEVEL') {
    const checked = assertPlainObjectWithClosedAllowlist(
      rec,
      SOLID_HIERARCHY_KEY_SET,
      SOLID_HIERARCHY_KEYS,
      label
    );
    if (checked.intermediateUnit !== 'strip') {
      throw new UnitSerializationError(
        'TOP_LEVEL_HIERARCHY_MISMATCH',
        `${label}.intermediateUnit must be 'strip' for SOLID_TWO_LEVEL.`
      );
    }
    const stripsPerPack = checked.stripsPerPack;
    const pillsPerStrip = checked.pillsPerStrip;
    const baseUnitsPerPack = checked.baseUnitsPerPack;
    if (
      typeof stripsPerPack !== 'number' ||
      !Number.isSafeInteger(stripsPerPack) ||
      stripsPerPack < 1 ||
      typeof pillsPerStrip !== 'number' ||
      !Number.isSafeInteger(pillsPerStrip) ||
      pillsPerStrip < 1 ||
      typeof baseUnitsPerPack !== 'number' ||
      !Number.isSafeInteger(baseUnitsPerPack) ||
      baseUnitsPerPack < 1
    ) {
      throw new UnitSerializationError(
        'PR1_POLICY_VIOLATION',
        `${label} conversion factors must be positive safe integers >= 1.`,
        'INVALID_CONVERSION_FACTOR'
      );
    }
    if (BigInt(stripsPerPack) * BigInt(pillsPerStrip) !== BigInt(baseUnitsPerPack)) {
      throw new UnitSerializationError(
        'TOP_LEVEL_HIERARCHY_MISMATCH',
        `${label}.baseUnitsPerPack (${baseUnitsPerPack}) must equal stripsPerPack * pillsPerStrip (${stripsPerPack * pillsPerStrip}).`
      );
    }
    return {
      kind: 'SOLID_TWO_LEVEL',
      intermediateUnit: 'strip',
      stripsPerPack,
      pillsPerStrip,
      baseUnitsPerPack,
    };
  }

  if (kind === 'DIRECT_PACK') {
    // Reject solid strip/pill keys on DIRECT_PACK explicitly even when null or undefined.
    if (
      Object.prototype.hasOwnProperty.call(rec, 'stripsPerPack') ||
      Object.prototype.hasOwnProperty.call(rec, 'pillsPerStrip')
    ) {
      throw new UnitSerializationError(
        'FORBIDDEN_DIRECT_PACK_SOLID_KEY',
        `${label} of kind DIRECT_PACK must not define stripsPerPack or pillsPerStrip keys (even as null or undefined).`
      );
    }
    const checked = assertPlainObjectWithClosedAllowlist(
      rec,
      DIRECT_PACK_HIERARCHY_KEY_SET,
      DIRECT_PACK_HIERARCHY_KEYS,
      label
    );
    if (checked.intermediateUnit !== null) {
      throw new UnitSerializationError(
        'TOP_LEVEL_HIERARCHY_MISMATCH',
        `${label}.intermediateUnit must be null for DIRECT_PACK.`
      );
    }
    const baseUnitsPerPack = checked.baseUnitsPerPack;
    if (
      typeof baseUnitsPerPack !== 'number' ||
      !Number.isSafeInteger(baseUnitsPerPack) ||
      baseUnitsPerPack < 1
    ) {
      throw new UnitSerializationError(
        'PR1_POLICY_VIOLATION',
        `${label}.baseUnitsPerPack must be a positive safe integer >= 1.`,
        'INVALID_CONVERSION_FACTOR'
      );
    }
    return {
      kind: 'DIRECT_PACK',
      intermediateUnit: null,
      baseUnitsPerPack,
    };
  }

  throw new UnitSerializationError(
    'PR1_POLICY_VIOLATION',
    `${label}.kind '${safeDescribeValue(kind)}' is unsupported.`,
    'INCONSISTENT_PACK_HIERARCHY'
  );
}

function assertStrictArrayOfUniqueUnitStrings(rawSellable: unknown): SupportedUnitKind[] {
  if (!Array.isArray(rawSellable)) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      'DTO sellableUnits must strictly be a plain JSON Array of strings (Set or Set-like objects are rejected).'
    );
  }
  if (Object.getPrototypeOf(rawSellable) !== Array.prototype) {
    throw new UnitSerializationError(
      'CUSTOM_PROTOTYPE_FORBIDDEN',
      'sellableUnits array must have Array.prototype.'
    );
  }
  if (Object.getOwnPropertySymbols(rawSellable).length > 0) {
    throw new UnitSerializationError(
      'SYMBOL_PROPERTY_FORBIDDEN',
      'sellableUnits array must not contain symbol properties.'
    );
  }
  // Reject non-index own properties attached onto the Array (e.g. fake .has / .toArray methods)
  const expectedIndexSet = new Set<string>();
  for (let i = 0; i < rawSellable.length; i += 1) {
    expectedIndexSet.add(String(i));
  }
  for (const prop of Object.getOwnPropertyNames(rawSellable)) {
    if (prop === 'length') continue;
    if (!expectedIndexSet.has(prop)) {
      throw new UnitSerializationError(
        'INVALID_SELLABLE_UNITS',
        `sellableUnits array contains disallowed own property '${prop}'.`
      );
    }
    const desc = Object.getOwnPropertyDescriptor(rawSellable, prop);
    if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
      throw new UnitSerializationError(
        'ACCESSOR_PROPERTY_FORBIDDEN',
        `sellableUnits[${prop}] must be a plain data entry.`
      );
    }
  }

  if (rawSellable.length === 0) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      'sellableUnits must not be empty.'
    );
  }
  if (rawSellable.length > 3) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      'sellableUnits exceeds maximum possible unique unit count (3).'
    );
  }

  const seen = new Set<string>();
  const out: SupportedUnitKind[] = [];
  for (let i = 0; i < rawSellable.length; i += 1) {
    const entry = rawSellable[i];
    if (typeof entry !== 'string' || entry.length === 0 || entry.trim() !== entry) {
      throw new UnitSerializationError(
        'INVALID_SELLABLE_UNITS',
        `sellableUnits[${i}] must be a non-empty trimmed unit string.`
      );
    }
    if (seen.has(entry)) {
      throw new UnitSerializationError(
        'DUPLICATE_SELLABLE_UNIT',
        `Duplicate unit '${entry}' in sellableUnits is forbidden.`
      );
    }
    seen.add(entry);
    out.push(entry as SupportedUnitKind);
  }
  return out;
}

const IMMUTABLE_FACADE_STRING_KEYS = ['size', 'has', 'values', 'toArray'] as const;
const IMMUTABLE_FACADE_STRING_KEY_SET = new Set<string>(IMMUTABLE_FACADE_STRING_KEYS);

const UNIT_HAS_PROBE_CANDIDATES: ReadonlyArray<string> = [
  'pill',
  'capsule',
  'bottle',
  'vial',
  'ampoule',
  'tube',
  'inhaler',
  'suppository',
  'sachet',
  'pack',
  'box',
  'carton',
  'strip',
  'ml',
  'g',
  'drop',
  '',
  '__invalid__',
  'constructor',
  '__proto__',
];

function collectBoundedIteratorItems(
  iteratorCandidate: unknown,
  channelLabel: string
): SupportedUnitKind[] {
  if (
    iteratorCandidate === null ||
    typeof iteratorCandidate !== 'object' ||
    typeof (iteratorCandidate as { next?: unknown }).next !== 'function'
  ) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      `UnitDefinition.sellableUnits ${channelLabel} did not return a valid iterator.`
    );
  }
  const iter = iteratorCandidate as Iterator<unknown>;
  const out: SupportedUnitKind[] = [];
  const seen = new Set<string>();

  for (let step = 0; step < 4; step += 1) {
    const nextResult = iter.next();
    if (!nextResult || typeof nextResult !== 'object' || typeof nextResult.done !== 'boolean') {
      throw new UnitSerializationError(
        'INVALID_SELLABLE_UNITS',
        `UnitDefinition.sellableUnits ${channelLabel} returned malformed IteratorResult.`
      );
    }
    if (nextResult.done) {
      return out;
    }
    if (out.length >= 3) {
      throw new UnitSerializationError(
        'INVALID_SELLABLE_UNITS',
        `UnitDefinition.sellableUnits ${channelLabel} yielded more than 3 entries.`
      );
    }
    const entry = nextResult.value;
    if (typeof entry !== 'string' || entry.length === 0 || entry.trim() !== entry) {
      throw new UnitSerializationError(
        'INVALID_SELLABLE_UNITS',
        `UnitDefinition.sellableUnits ${channelLabel} entries must be non-empty trimmed strings.`
      );
    }
    if (seen.has(entry)) {
      throw new UnitSerializationError(
        'DUPLICATE_SELLABLE_UNIT',
        `UnitDefinition.sellableUnits ${channelLabel} yielded duplicate unit '${entry}'.`
      );
    }
    seen.add(entry);
    out.push(entry as SupportedUnitKind);
  }

  throw new UnitSerializationError(
    'INVALID_SELLABLE_UNITS',
    `UnitDefinition.sellableUnits ${channelLabel} did not terminate within bounded size.`
  );
}

/**
 * Enforces the genuine PR-1 `createImmutableSellableUnits` contract strictly without inventing
 * any PR-1 API: frozen plain object, exact own keys (`size` getter, `has`, `values`, `toArray`,
 * `[Symbol.iterator]`), frozen `toArray()` array, cross-verified repeat iteration, and full
 * `has()` truth-table check across supported and unsupported unit candidates.
 */
function extractSellableUnitsArrayFromUnitDefinition(
  sellable: unknown
): SupportedUnitKind[] {
  if (
    sellable === null ||
    typeof sellable !== 'object' ||
    Array.isArray(sellable) ||
    sellable instanceof Set ||
    sellable instanceof Map
  ) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      'UnitDefinition.sellableUnits must be a genuine PR-1 ImmutableSellableUnits facade object.'
    );
  }

  if (Object.getPrototypeOf(sellable) !== Object.prototype) {
    throw new UnitSerializationError(
      'CUSTOM_PROTOTYPE_FORBIDDEN',
      'UnitDefinition.sellableUnits must have Object.prototype.'
    );
  }

  if (!Object.isFrozen(sellable)) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      'UnitDefinition.sellableUnits must be frozen (Object.freeze) per PR-1 ImmutableSellableUnits contract.'
    );
  }

  const ownSymbols = Object.getOwnPropertySymbols(sellable);
  if (ownSymbols.length !== 1 || ownSymbols[0] !== Symbol.iterator) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      'UnitDefinition.sellableUnits must expose strictly Symbol.iterator as its sole symbol key.'
    );
  }

  const ownNames = Object.getOwnPropertyNames(sellable);
  if (ownNames.length !== IMMUTABLE_FACADE_STRING_KEYS.length) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      'UnitDefinition.sellableUnits own property set does not match PR-1 ImmutableSellableUnits contract.'
    );
  }
  for (const key of ownNames) {
    if (!IMMUTABLE_FACADE_STRING_KEY_SET.has(key)) {
      throw new UnitSerializationError(
        'UNKNOWN_PROPERTY_FORBIDDEN',
        `UnitDefinition.sellableUnits contains disallowed own property '${key}'.`
      );
    }
  }
  for (const requiredKey of IMMUTABLE_FACADE_STRING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(sellable, requiredKey)) {
      throw new UnitSerializationError(
        'MISSING_REQUIRED_PROPERTY',
        `UnitDefinition.sellableUnits.${requiredKey} is required by PR-1 ImmutableSellableUnits contract.`
      );
    }
  }

  // PR-1 defines `size` strictly as a getter and `has/values/toArray/[Symbol.iterator]` as frozen data methods.
  const sizeDesc = Object.getOwnPropertyDescriptor(sellable, 'size');
  if (
    !sizeDesc ||
    typeof sizeDesc.get !== 'function' ||
    sizeDesc.set !== undefined
  ) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      'UnitDefinition.sellableUnits.size must be a read-only getter per PR-1 contract.'
    );
  }

  for (const methodKey of ['has', 'values', 'toArray', Symbol.iterator] as const) {
    const desc = Object.getOwnPropertyDescriptor(sellable, methodKey);
    if (
      !desc ||
      !('value' in desc) ||
      typeof desc.value !== 'function' ||
      desc.get !== undefined ||
      desc.set !== undefined
    ) {
      throw new UnitSerializationError(
        'INVALID_SELLABLE_UNITS',
        `UnitDefinition.sellableUnits.${String(methodKey)} must be a plain frozen method.`
      );
    }
  }

  const facade = sellable as {
    readonly size: number;
    has(unit: unknown): boolean;
    values(): IterableIterator<unknown>;
    toArray(): ReadonlyArray<unknown>;
    [Symbol.iterator](): IterableIterator<unknown>;
  };

  const sizeFirst = facade.size;
  const sizeSecond = facade.size;
  if (
    typeof sizeFirst !== 'number' ||
    !Number.isSafeInteger(sizeFirst) ||
    sizeFirst < 1 ||
    sizeFirst > 3 ||
    sizeSecond !== sizeFirst
  ) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      'UnitDefinition.sellableUnits.size must deterministically return an integer in [1, 3].'
    );
  }

  const rawToArray = facade.toArray();
  if (!Array.isArray(rawToArray) || Object.getPrototypeOf(rawToArray) !== Array.prototype || !Object.isFrozen(rawToArray)) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      'UnitDefinition.sellableUnits.toArray() must return a frozen plain Array.'
    );
  }
  const backingArray = assertStrictArrayOfUniqueUnitStrings(rawToArray);
  if (backingArray.length !== sizeFirst) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      `UnitDefinition.sellableUnits.toArray().length (${backingArray.length}) disagrees with size (${sizeFirst}).`
    );
  }

  const iterPass1 = collectBoundedIteratorItems(facade[Symbol.iterator](), '[Symbol.iterator]()');
  const iterPass2 = collectBoundedIteratorItems(facade[Symbol.iterator](), '[Symbol.iterator]() repeat');
  const valuesPass = collectBoundedIteratorItems(facade.values(), 'values()');

  if (
    iterPass1.length !== backingArray.length ||
    iterPass2.length !== backingArray.length ||
    valuesPass.length !== backingArray.length
  ) {
    throw new UnitSerializationError(
      'INVALID_SELLABLE_UNITS',
      'UnitDefinition.sellableUnits enumeration channels disagree in length.'
    );
  }

  for (let i = 0; i < backingArray.length; i += 1) {
    if (
      iterPass1[i] !== backingArray[i] ||
      iterPass2[i] !== backingArray[i] ||
      valuesPass[i] !== backingArray[i]
    ) {
      throw new UnitSerializationError(
        'INVALID_SELLABLE_UNITS',
        'UnitDefinition.sellableUnits iterator, values(), and toArray() disagree.'
      );
    }
  }

  // Truth-table verification of `has()` across backing entries and disallowed unit probes
  const backingSet = new Set<string>(backingArray);
  for (const unit of backingArray) {
    if (facade.has(unit) !== true) {
      throw new UnitSerializationError(
        'INVALID_SELLABLE_UNITS',
        `UnitDefinition.sellableUnits.has('${unit}') must strictly return true.`
      );
    }
  }
  for (const probe of UNIT_HAS_PROBE_CANDIDATES) {
    if (!backingSet.has(probe) && facade.has(probe) !== false) {
      throw new UnitSerializationError(
        'INVALID_SELLABLE_UNITS',
        `UnitDefinition.sellableUnits.has('${probe}') returned non-false for an absent/unsupported unit.`
      );
    }
  }

  return [...backingArray];
}

/**
 * Validates full PR-1 + boundary structural invariants EVEN WHEN `configStatus !== 'VERIFIED'`
 * (solving PR-1 LOW-1 without ever modifying PR-1 files or promoting trust status).
 */
function buildAndVerifyCanonicalUnitDefinition(params: {
  dosageForm: unknown;
  physicalDimension: unknown;
  baseDimensionKey: unknown;
  unitDefinitionKey: unknown;
  definitionVersion: unknown;
  baseUnit: unknown;
  packUnit: unknown;
  intermediateUnit: unknown;
  hierarchy: SerializedHierarchyDTOV2;
  baseUnitsPerPack: unknown;
  configStatus: unknown;
  packingLocked: unknown;
  sellableUnits: ReadonlyArray<SupportedUnitKind>;
}): UnitDefinition {
  const configStatus = assertValidConfigStatus(params.configStatus);

  if (typeof params.packingLocked !== 'boolean') {
    throw new UnitSerializationError(
      'INVALID_PACKING_LOCKED',
      'packingLocked must strictly be a boolean.'
    );
  }

  if (
    typeof params.baseUnitsPerPack !== 'number' ||
    !Number.isSafeInteger(params.baseUnitsPerPack) ||
    params.baseUnitsPerPack < 1 ||
    params.baseUnitsPerPack !== params.hierarchy.baseUnitsPerPack
  ) {
    throw new UnitSerializationError(
      'TOP_LEVEL_HIERARCHY_MISMATCH',
      `Top-level baseUnitsPerPack (${String(params.baseUnitsPerPack)}) disagrees with hierarchy.baseUnitsPerPack (${params.hierarchy.baseUnitsPerPack}).`
    );
  }

  if (params.intermediateUnit !== params.hierarchy.intermediateUnit) {
    throw new UnitSerializationError(
      'TOP_LEVEL_HIERARCHY_MISMATCH',
      `Top-level intermediateUnit (${String(params.intermediateUnit)}) disagrees with hierarchy.intermediateUnit (${String(params.hierarchy.intermediateUnit)}).`
    );
  }

  let validatedDef: UnitDefinition;
  try {
    // Construct via PR-1 factory with the ACTUAL configStatus (never auto-promoted)
    validatedDef = createValidatedUnitDefinition({
      dosageForm: params.dosageForm,
      baseUnit: params.baseUnit,
      packUnit: params.packUnit,
      intermediateUnit: params.hierarchy.intermediateUnit,
      ...(params.hierarchy.kind === 'SOLID_TWO_LEVEL'
        ? {
            stripsPerPack: params.hierarchy.stripsPerPack,
            pillsPerStrip: params.hierarchy.pillsPerStrip,
          }
        : {}),
      baseUnitsPerPack: params.hierarchy.baseUnitsPerPack,
      requestedSellableUnits: [...params.sellableUnits],
      definitionVersion: params.definitionVersion,
      configStatus,
      packingLocked: params.packingLocked,
    });

    // Solves LOW-1: Run PR-1's full `assertUnitDefinitionIntegrity` via an ephemeral internal
    // VERIFIED shadow ONLY for structural checking, leaving `validatedDef.configStatus` untouched.
    const ephemeralIntegrityShadow: UnitDefinition = Object.freeze({
      ...validatedDef,
      configStatus: 'VERIFIED',
    });
    assertUnitDefinitionIntegrity(ephemeralIntegrityShadow);
  } catch (err) {
    if (err instanceof UnitSerializationError) {
      throw err;
    }
    if (err instanceof UnitPolicyError) {
      throw new UnitSerializationError('PR1_POLICY_VIOLATION', err.message, err.code);
    }
    throw new UnitSerializationError(
      'PR1_POLICY_VIOLATION',
      err instanceof Error ? err.message : String(err)
    );
  }

  // Verify caller-supplied derived fields match computed PR-1 keys & dimension exactly
  const expectedDim = EXPECTED_PHYSICAL_DIMENSION[validatedDef.dosageForm];
  if (params.physicalDimension !== expectedDim || validatedDef.physicalDimension !== expectedDim) {
    throw new UnitSerializationError(
      'PHYSICAL_DIMENSION_MISMATCH',
      `physicalDimension '${String(params.physicalDimension)}' does not match expected '${expectedDim}'.`
    );
  }

  const expectedBaseDimKey = computeBaseDimensionKey(validatedDef.physicalDimension);
  if (params.baseDimensionKey !== expectedBaseDimKey || validatedDef.baseDimensionKey !== expectedBaseDimKey) {
    throw new UnitSerializationError(
      'BASE_DIMENSION_KEY_MISMATCH',
      `baseDimensionKey '${String(params.baseDimensionKey)}' does not match computed '${expectedBaseDimKey}'.`
    );
  }

  const expectedDefKey = computeUnitDefinitionKey({
    dosageForm: validatedDef.dosageForm,
    baseUnit: validatedDef.baseUnit,
    packUnit: validatedDef.packUnit,
    hierarchy: validatedDef.hierarchy,
  });
  if (params.unitDefinitionKey !== expectedDefKey || validatedDef.unitDefinitionKey !== expectedDefKey) {
    throw new UnitSerializationError(
      'UNIT_DEFINITION_KEY_MISMATCH',
      `unitDefinitionKey '${String(params.unitDefinitionKey)}' does not match computed '${expectedDefKey}'.`
    );
  }

  return validatedDef;
}

/**
 * Serializes a validated `UnitDefinition` into a strict, plain-data JSON DTO (`schemaEpoch: 2`).
 * - Validates full structural integrity before projecting (for ANY `configStatus`).
 * - Creates brand-new plain objects and a plain string Array; copies zero prototypes/methods/getters.
 * - Never modifies `configStatus`.
 */
export function serializeUnitDefinitionToDto(
  definition: UnitDefinition
): SerializedUnitDefinitionDTOV2 {
  const checkedDef = assertPlainObjectWithClosedAllowlist(
    definition,
    UNIT_DEF_OBJECT_KEY_SET,
    UNIT_DEF_OBJECT_KEYS,
    'UnitDefinition'
  );

  if (!Object.isFrozen(checkedDef) || !Object.isFrozen(checkedDef.hierarchy)) {
    throw new UnitSerializationError(
      'INVALID_DTO_TYPE',
      'UnitDefinition and hierarchy must be frozen per PR-1 immutable contract.'
    );
  }

  const verifiedHierarchy = assertStrictlyValidHierarchyObject(
    checkedDef.hierarchy,
    'UnitDefinition.hierarchy'
  );

  const sellableArray = extractSellableUnitsArrayFromUnitDefinition(checkedDef.sellableUnits);

  const canonical = buildAndVerifyCanonicalUnitDefinition({
    dosageForm: checkedDef.dosageForm,
    physicalDimension: checkedDef.physicalDimension,
    baseDimensionKey: checkedDef.baseDimensionKey,
    unitDefinitionKey: checkedDef.unitDefinitionKey,
    definitionVersion: checkedDef.definitionVersion,
    baseUnit: checkedDef.baseUnit,
    packUnit: checkedDef.packUnit,
    intermediateUnit: checkedDef.intermediateUnit,
    hierarchy: verifiedHierarchy,
    baseUnitsPerPack: checkedDef.baseUnitsPerPack,
    configStatus: checkedDef.configStatus,
    packingLocked: checkedDef.packingLocked,
    sellableUnits: sellableArray,
  });

  // Strict allowlist projection into fresh plain JSON containers (zero shared references)
  const projectedHierarchy: SerializedHierarchyDTOV2 =
    canonical.hierarchy.kind === 'SOLID_TWO_LEVEL'
      ? {
          kind: 'SOLID_TWO_LEVEL',
          intermediateUnit: 'strip',
          stripsPerPack: canonical.hierarchy.stripsPerPack,
          pillsPerStrip: canonical.hierarchy.pillsPerStrip,
          baseUnitsPerPack: canonical.hierarchy.baseUnitsPerPack,
        }
      : {
          kind: 'DIRECT_PACK',
          intermediateUnit: null,
          baseUnitsPerPack: canonical.hierarchy.baseUnitsPerPack,
        };

  return {
    schemaEpoch: UNIT_DEFINITION_SCHEMA_EPOCH,
    dosageForm: canonical.dosageForm,
    physicalDimension: canonical.physicalDimension,
    baseDimensionKey: canonical.baseDimensionKey,
    unitDefinitionKey: canonical.unitDefinitionKey,
    definitionVersion: canonical.definitionVersion,
    baseUnit: canonical.baseUnit,
    packUnit: canonical.packUnit,
    intermediateUnit: canonical.intermediateUnit,
    hierarchy: projectedHierarchy,
    baseUnitsPerPack: canonical.baseUnitsPerPack,
    configStatus: canonical.configStatus,
    packingLocked: canonical.packingLocked,
    sellableUnits: [...canonical.sellableUnits.toArray()],
  };
}

/**
 * Strictly rehydrates an untrusted `unknown` JSON value into a structurally validated
 * PR-1 `UnitDefinition` WITHOUT trusting a claimed `configStatus === 'VERIFIED'` inside the DTO.
 * - Separates structural validity (`ok / structuralValid`), `claimedConfigStatus`, and
 *   independent operational authorization (`hasIndependentOperationalAuthorization`).
 * - Because PR-2A has no independent operational authority/attestation source, any DTO
 *   claiming `VERIFIED` is clamped at runtime to `trustStatus: 'UNVERIFIED_UNKNOWN'` with
 *   `isVerifiedForOperations: false` and `definition.configStatus: 'UNVERIFIED_UNKNOWN'`.
 * - Non-VERIFIED statuses (`LEGACY_ASSUMED`, `UNVERIFIED_UNKNOWN`, `RECONCILIATION_REQUIRED`,
 *   `QUARANTINED`) remain unchanged and are never promoted.
 * - Never creates a fallback default on failure.
 */
export function rehydrateUnitDefinitionFromDto(raw: unknown): RehydrateUnitDefinitionResult {
  const safeQuarantineEvidence = isSafeOwnDataConfigStatusQuarantined(raw);

  try {
    const dto = assertPlainObjectWithClosedAllowlist(
      raw,
      DTO_TOP_LEVEL_KEY_SET,
      DTO_TOP_LEVEL_KEYS,
      'SerializedUnitDefinitionDTOV2'
    );

    if (dto.schemaEpoch !== UNIT_DEFINITION_SCHEMA_EPOCH) {
      throw new UnitSerializationError(
        'UNSUPPORTED_SCHEMA_EPOCH',
        `schemaEpoch must strictly equal ${UNIT_DEFINITION_SCHEMA_EPOCH}, got '${safeDescribeValue(dto.schemaEpoch)}'.`
      );
    }

    const hierarchy = assertStrictlyValidHierarchyObject(
      dto.hierarchy,
      'SerializedUnitDefinitionDTOV2.hierarchy'
    );
    const sellableArray = assertStrictArrayOfUniqueUnitStrings(dto.sellableUnits);

    const validatedWithClaimed = buildAndVerifyCanonicalUnitDefinition({
      dosageForm: dto.dosageForm,
      physicalDimension: dto.physicalDimension,
      baseDimensionKey: dto.baseDimensionKey,
      unitDefinitionKey: dto.unitDefinitionKey,
      definitionVersion: dto.definitionVersion,
      baseUnit: dto.baseUnit,
      packUnit: dto.packUnit,
      intermediateUnit: dto.intermediateUnit,
      hierarchy,
      baseUnitsPerPack: dto.baseUnitsPerPack,
      configStatus: dto.configStatus,
      packingLocked: dto.packingLocked,
      sellableUnits: sellableArray,
    });

    const claimedConfigStatus = validatedWithClaimed.configStatus;
    const effectiveTrustStatus: EffectiveRehydratedTrustStatus =
      claimedConfigStatus === 'VERIFIED' ? 'UNVERIFIED_UNKNOWN' : claimedConfigStatus;

    // Reconstruct returned UnitDefinition with conservative effectiveTrustStatus so an
    // untrusted DTO claiming 'VERIFIED' can never pass PR-1 operational integrity checks directly.
    const guardedDefinition: UnitDefinition =
      claimedConfigStatus === effectiveTrustStatus
        ? validatedWithClaimed
        : createValidatedUnitDefinition({
            dosageForm: validatedWithClaimed.dosageForm,
            baseUnit: validatedWithClaimed.baseUnit,
            packUnit: validatedWithClaimed.packUnit,
            intermediateUnit: validatedWithClaimed.hierarchy.intermediateUnit,
            ...(validatedWithClaimed.hierarchy.kind === 'SOLID_TWO_LEVEL'
              ? {
                  stripsPerPack: validatedWithClaimed.hierarchy.stripsPerPack,
                  pillsPerStrip: validatedWithClaimed.hierarchy.pillsPerStrip,
                }
              : {}),
            baseUnitsPerPack: validatedWithClaimed.hierarchy.baseUnitsPerPack,
            requestedSellableUnits: [...validatedWithClaimed.sellableUnits.toArray()],
            definitionVersion: validatedWithClaimed.definitionVersion,
            configStatus: effectiveTrustStatus,
            packingLocked: validatedWithClaimed.packingLocked,
          });

    return Object.freeze({
      ok: true,
      structuralValid: true,
      claimedConfigStatus,
      trustStatus: effectiveTrustStatus,
      hasIndependentOperationalAuthorization: false,
      operationalAuthorization:
        claimedConfigStatus === 'VERIFIED'
          ? 'UNESTABLISHED_NO_INDEPENDENT_AUTHORITY'
          : 'NOT_VERIFIED_CLAIM',
      isVerifiedForOperations: false,
      quarantinePreserved: effectiveTrustStatus === 'QUARANTINED',
      definition: guardedDefinition,
    });
  } catch (err) {
    if (err instanceof UnitSerializationError) {
      return Object.freeze({
        ok: false,
        structuralValid: false,
        ...(safeQuarantineEvidence ? { claimedConfigStatus: 'QUARANTINED' as const } : {}),
        trustStatus: safeQuarantineEvidence ? 'QUARANTINED' : 'UNTRUSTED',
        hasIndependentOperationalAuthorization: false,
        operationalAuthorization: 'NOT_VERIFIED_CLAIM',
        isVerifiedForOperations: false,
        quarantinePreserved: safeQuarantineEvidence,
        errorCode: err.code,
        ...(err.policyCode !== undefined ? { policyCode: err.policyCode } : {}),
        message: err.message,
      });
    }
    return Object.freeze({
      ok: false,
      structuralValid: false,
      ...(safeQuarantineEvidence ? { claimedConfigStatus: 'QUARANTINED' as const } : {}),
      trustStatus: safeQuarantineEvidence ? 'QUARANTINED' : 'UNTRUSTED',
      hasIndependentOperationalAuthorization: false,
      operationalAuthorization: 'NOT_VERIFIED_CLAIM',
      isVerifiedForOperations: false,
      quarantinePreserved: safeQuarantineEvidence,
      errorCode: 'INVALID_DTO_TYPE',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function rehydrateUnitDefinitionFromDtoOrThrow(raw: unknown): UnitDefinition {
  const result = rehydrateUnitDefinitionFromDto(raw);
  if (!result.ok) {
    throw new UnitSerializationError(result.errorCode, result.message, result.policyCode);
  }
  return result.definition;
}

function makeLegacyInvalid(
  errorCode: UnitSerializationErrorCode,
  message: string,
  options?: {
    policyCode?: string;
    claimedConfigStatus?: UnitConfigurationStatus;
    quarantinePreserved?: boolean;
  }
): LegacyOrV2InvalidResult {
  const quarantinePreserved = Boolean(options?.quarantinePreserved);
  return Object.freeze({
    kind: 'INVALID',
    ok: false,
    structuralValid: false,
    ...(options?.claimedConfigStatus !== undefined
      ? { claimedConfigStatus: options.claimedConfigStatus }
      : {}),
    trustStatus: quarantinePreserved ? 'QUARANTINED' : 'UNTRUSTED',
    hasIndependentOperationalAuthorization: false,
    operationalAuthorization: 'NOT_VERIFIED_CLAIM',
    isVerifiedForOperations: false,
    quarantinePreserved,
    errorCode,
    ...(options?.policyCode !== undefined ? { policyCode: options.policyCode } : {}),
    message,
  });
}

function validateStrictPositiveSafeInteger(
  value: unknown,
  fieldName: string
): { ok: true; value: number } | { ok: false; message: string } {
  if (typeof value !== 'number') {
    return {
      ok: false,
      message: `${fieldName} must be a positive safe integer number (got ${value === null ? 'null' : typeof value}).`,
    };
  }
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      message: `${fieldName} must be finite (rejected NaN/Infinity).`,
    };
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    return {
      ok: false,
      message: `${fieldName} must be a positive safe integer >= 1 (rejected floats, 0, negative, or unsafe integers).`,
    };
  }
  return { ok: true, value };
}

function checkV2MedicineMirrorContradictions(
  record: Record<string, unknown>,
  definition: UnitDefinition,
  claimedConfigStatus: UnitConfigurationStatus
): LegacyOrV2InvalidResult | null {
  const quarantinePreserved =
    record.configStatus === 'QUARANTINED' || claimedConfigStatus === 'QUARANTINED';

  if (record.configStatus === 'QUARANTINED' && claimedConfigStatus !== 'QUARANTINED') {
    return makeLegacyInvalid(
      'QUARANTINE_CANNOT_BE_LIFTED',
      `Quarantined record cannot be downgraded or restored to '${claimedConfigStatus}' without an explicit review workflow.`,
      { claimedConfigStatus: 'QUARANTINED', quarantinePreserved: true }
    );
  }
  if (record.dosageForm !== undefined && record.dosageForm !== definition.dosageForm) {
    return makeLegacyInvalid(
      'LEGACY_V2_CONTRADICTION',
      `Record dosageForm '${safeDescribeValue(record.dosageForm)}' contradicts unitDefinition.dosageForm '${definition.dosageForm}'.`,
      { claimedConfigStatus, quarantinePreserved }
    );
  }
  if (record.configStatus !== undefined && record.configStatus !== claimedConfigStatus) {
    return makeLegacyInvalid(
      'LEGACY_V2_CONTRADICTION',
      `Record configStatus '${safeDescribeValue(record.configStatus)}' contradicts unitDefinition claimed configStatus '${claimedConfigStatus}'.`,
      { claimedConfigStatus, quarantinePreserved }
    );
  }
  if (record.unitDefinitionKey !== undefined && record.unitDefinitionKey !== definition.unitDefinitionKey) {
    return makeLegacyInvalid(
      'LEGACY_V2_CONTRADICTION',
      'Record unitDefinitionKey contradicts unitDefinition.unitDefinitionKey.',
      { claimedConfigStatus, quarantinePreserved }
    );
  }
  if (record.baseDimensionKey !== undefined && record.baseDimensionKey !== definition.baseDimensionKey) {
    return makeLegacyInvalid(
      'LEGACY_V2_CONTRADICTION',
      'Record baseDimensionKey contradicts unitDefinition.baseDimensionKey.',
      { claimedConfigStatus, quarantinePreserved }
    );
  }
  if (record.baseUnitsPerPack !== undefined && record.baseUnitsPerPack !== definition.baseUnitsPerPack) {
    return makeLegacyInvalid(
      'LEGACY_V2_CONTRADICTION',
      `Record baseUnitsPerPack (${safeDescribeValue(record.baseUnitsPerPack)}) contradicts unitDefinition.baseUnitsPerPack (${definition.baseUnitsPerPack}).`,
      { claimedConfigStatus, quarantinePreserved }
    );
  }

  if (definition.hierarchy.kind === 'DIRECT_PACK') {
    if (
      (record.stripsPerPack !== undefined && record.stripsPerPack !== null) ||
      (record.pillsPerStrip !== undefined && record.pillsPerStrip !== null)
    ) {
      return makeLegacyInvalid(
        'LEGACY_V2_CONTRADICTION',
        'Record specifies stripsPerPack or pillsPerStrip while unitDefinition is DIRECT_PACK.',
        { claimedConfigStatus, quarantinePreserved }
      );
    }
  } else {
    if (
      record.stripsPerPack !== undefined &&
      record.stripsPerPack !== definition.hierarchy.stripsPerPack
    ) {
      return makeLegacyInvalid(
        'LEGACY_V2_CONTRADICTION',
        `Record stripsPerPack (${safeDescribeValue(record.stripsPerPack)}) contradicts unitDefinition.hierarchy.stripsPerPack (${definition.hierarchy.stripsPerPack}).`,
        { claimedConfigStatus, quarantinePreserved }
      );
    }
    if (
      record.pillsPerStrip !== undefined &&
      record.pillsPerStrip !== definition.hierarchy.pillsPerStrip
    ) {
      return makeLegacyInvalid(
        'LEGACY_V2_CONTRADICTION',
        `Record pillsPerStrip (${safeDescribeValue(record.pillsPerStrip)}) contradicts unitDefinition.hierarchy.pillsPerStrip (${definition.hierarchy.pillsPerStrip}).`,
        { claimedConfigStatus, quarantinePreserved }
      );
    }
  }

  return null;
}

/**
 * Safely rehydrates either a V2 DTO/record OR inspects a legacy medicine record using PR-1
 * `inspectLegacyMedicineUnitConfig`.
 * - Extracts QUARANTINED evidence strictly via `Object.getOwnPropertyDescriptor` BEFORE any
 *   structural rejection, prototype/symbol/accessor validation, or property access.
 * - Never invokes getters/setters or prototype-inherited status values.
 * - Never trusts V2 DTO `VERIFIED` claim without independent authorization.
 * - Preserves `QUARANTINED` status on both V2 and legacy records across all failure paths.
 * - Validates all legacy numeric values strictly BEFORE any BigInt call; never throws unhandled
 *   exceptions that would halt a migration batch.
 * - Never guesses dosageForm from name, never fabricates 2x10 or baseUnitsPerPack = 1.
 */
export function rehydrateLegacyOrV2MedicineConfig(raw: unknown): LegacyOrV2RehydrationResult {
  // MUST run first: inspect own data property descriptor safely without executing any getter
  // or trusting any prototype-inherited property.
  const safeQuarantineEvidence = extractSafeQuarantineEvidence(raw);
  let claimedStatusHint: UnitConfigurationStatus | undefined = safeQuarantineEvidence
    ? 'QUARANTINED'
    : undefined;
  let quarantinePreserved = safeQuarantineEvidence;

  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return makeLegacyInvalid(
        'INVALID_DTO_TYPE',
        'Medicine configuration input must be a non-null plain object.',
        {
          ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
          quarantinePreserved,
        }
      );
    }

    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) {
      return makeLegacyInvalid(
        'CUSTOM_PROTOTYPE_FORBIDDEN',
        'Medicine configuration input must not have a custom prototype.',
        {
          ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
          quarantinePreserved,
        }
      );
    }

    if (Object.getOwnPropertySymbols(raw).length > 0) {
      return makeLegacyInvalid(
        'SYMBOL_PROPERTY_FORBIDDEN',
        'Medicine configuration input must not contain symbol own properties.',
        {
          ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
          quarantinePreserved,
        }
      );
    }

    const rec = raw as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(rec)) {
      const desc = Object.getOwnPropertyDescriptor(rec, key);
      if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
        return makeLegacyInvalid(
          'ACCESSOR_PROPERTY_FORBIDDEN',
          `Medicine configuration property '${key}' must be a plain data property.`,
          {
            ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
            quarantinePreserved,
          }
        );
      }
    }

    if (typeof rec.configStatus === 'string' && VALID_CONFIG_STATUS_SET.has(rec.configStatus)) {
      claimedStatusHint = rec.configStatus as UnitConfigurationStatus;
      quarantinePreserved = quarantinePreserved || claimedStatusHint === 'QUARANTINED';
    }

    // Direct V2 DTO path
    if (Object.prototype.hasOwnProperty.call(rec, 'schemaEpoch')) {
      const rehydrated = rehydrateUnitDefinitionFromDto(rec);
      if (!rehydrated.ok) {
        const effectiveQuarantine = quarantinePreserved || rehydrated.quarantinePreserved;
        return makeLegacyInvalid(rehydrated.errorCode, rehydrated.message, {
          ...(rehydrated.policyCode !== undefined ? { policyCode: rehydrated.policyCode } : {}),
          ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
          quarantinePreserved: effectiveQuarantine,
        });
      }
      return Object.freeze({
        kind: 'V2_REHYDRATED',
        ok: true,
        structuralValid: true,
        claimedConfigStatus: rehydrated.claimedConfigStatus,
        trustStatus: rehydrated.trustStatus,
        hasIndependentOperationalAuthorization: false,
        operationalAuthorization: rehydrated.operationalAuthorization,
        isVerifiedForOperations: false,
        definition: rehydrated.definition,
      });
    }

    // Medicine record carrying V2 unitDefinition property (never silently fall back to legacy if invalid)
    if (Object.prototype.hasOwnProperty.call(rec, 'unitDefinition') && rec.unitDefinition !== undefined) {
      const rehydrated = rehydrateUnitDefinitionFromDto(rec.unitDefinition);
      if (!rehydrated.ok) {
        const effectiveQuarantine = quarantinePreserved || rehydrated.quarantinePreserved;
        return makeLegacyInvalid(rehydrated.errorCode, rehydrated.message, {
          ...(rehydrated.policyCode !== undefined ? { policyCode: rehydrated.policyCode } : {}),
          ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
          quarantinePreserved: effectiveQuarantine,
        });
      }
      const contradiction = checkV2MedicineMirrorContradictions(
        rec,
        rehydrated.definition,
        rehydrated.claimedConfigStatus
      );
      if (contradiction) {
        return contradiction;
      }
      return Object.freeze({
        kind: 'V2_REHYDRATED',
        ok: true,
        structuralValid: true,
        claimedConfigStatus: rehydrated.claimedConfigStatus,
        trustStatus: rehydrated.trustStatus,
        hasIndependentOperationalAuthorization: false,
        operationalAuthorization: rehydrated.operationalAuthorization,
        isVerifiedForOperations: false,
        definition: rehydrated.definition,
      });
    }

    // Legacy path (no V2 unitDefinition present)
    if (rec.configStatus === 'VERIFIED') {
      return makeLegacyInvalid(
        'UNVERIFIED_LEGACY_CLAIM',
        'Legacy record cannot claim configStatus VERIFIED without a valid V2 UnitDefinition.',
        { claimedConfigStatus: 'VERIFIED', quarantinePreserved }
      );
    }
    if (
      rec.configStatus !== undefined &&
      (typeof rec.configStatus !== 'string' || !VALID_CONFIG_STATUS_SET.has(rec.configStatus))
    ) {
      return makeLegacyInvalid(
        'INVALID_CONFIG_STATUS',
        `Invalid legacy configStatus '${safeDescribeValue(rec.configStatus)}'.`,
        {
          ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
          quarantinePreserved,
        }
      );
    }

    if (
      rec.dosageForm !== undefined &&
      rec.dosageForm !== null &&
      rec.dosageForm !== 'Unknown' &&
      (typeof rec.dosageForm !== 'string' || !KNOWN_DOSAGE_FORMS.has(rec.dosageForm))
    ) {
      return makeLegacyInvalid(
        'LEGACY_CONTRADICTORY_DATA',
        `Unsupported legacy dosageForm '${safeDescribeValue(rec.dosageForm)}'.`,
        {
          ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
          quarantinePreserved,
        }
      );
    }

    const normalizedDosageForm = rec.dosageForm === null ? undefined : rec.dosageForm;
    const isKnownNonSolid =
      typeof normalizedDosageForm === 'string' &&
      KNOWN_DOSAGE_FORMS.has(normalizedDosageForm) &&
      normalizedDosageForm !== 'Tablet' &&
      normalizedDosageForm !== 'Capsule';

    const hasStripsProp = rec.stripsPerPack !== undefined;
    const hasPillsProp = rec.pillsPerStrip !== undefined;
    const hasBaseUnitsProp = rec.baseUnitsPerPack !== undefined;

    if (hasStripsProp || hasPillsProp) {
      if (isKnownNonSolid) {
        // Validate that any supplied solid spoof numbers are at least valid positive safe integers
        // before delegating to PR-1 LEGACY_SOLID_SPOOF_ON_NON_SOLID; reject NaN/floats/objects safely.
        if (hasStripsProp) {
          const sCheck = validateStrictPositiveSafeInteger(rec.stripsPerPack, 'stripsPerPack');
          if (!sCheck.ok) {
            return makeLegacyInvalid('LEGACY_CONTRADICTORY_DATA', sCheck.message, {
              ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
              quarantinePreserved,
            });
          }
        }
        if (hasPillsProp) {
          const pCheck = validateStrictPositiveSafeInteger(rec.pillsPerStrip, 'pillsPerStrip');
          if (!pCheck.ok) {
            return makeLegacyInvalid('LEGACY_CONTRADICTORY_DATA', pCheck.message, {
              ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
              quarantinePreserved,
            });
          }
        }
      } else {
        if (!hasStripsProp || !hasPillsProp) {
          return makeLegacyInvalid(
            'LEGACY_CONTRADICTORY_DATA',
            'Legacy record supplies only one of stripsPerPack/pillsPerStrip without the matching pair.',
            {
              ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
              quarantinePreserved,
            }
          );
        }
        const stripsCheck = validateStrictPositiveSafeInteger(rec.stripsPerPack, 'stripsPerPack');
        if (!stripsCheck.ok) {
          return makeLegacyInvalid('LEGACY_CONTRADICTORY_DATA', stripsCheck.message, {
            ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
            quarantinePreserved,
          });
        }
        const pillsCheck = validateStrictPositiveSafeInteger(rec.pillsPerStrip, 'pillsPerStrip');
        if (!pillsCheck.ok) {
          return makeLegacyInvalid('LEGACY_CONTRADICTORY_DATA', pillsCheck.message, {
            ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
            quarantinePreserved,
          });
        }

        const product = BigInt(stripsCheck.value) * BigInt(pillsCheck.value);
        if (product > MAX_SAFE_BIGINT) {
          return makeLegacyInvalid(
            'LEGACY_CONTRADICTORY_DATA',
            'Legacy stripsPerPack * pillsPerStrip exceeds safe integer limits.',
            {
              ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
              quarantinePreserved,
            }
          );
        }

        if (hasBaseUnitsProp) {
          const baseUnitsCheck = validateStrictPositiveSafeInteger(
            rec.baseUnitsPerPack,
            'baseUnitsPerPack'
          );
          if (!baseUnitsCheck.ok) {
            return makeLegacyInvalid('LEGACY_CONTRADICTORY_DATA', baseUnitsCheck.message, {
              ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
              quarantinePreserved,
            });
          }
          if (BigInt(baseUnitsCheck.value) !== product) {
            return makeLegacyInvalid(
              'LEGACY_CONTRADICTORY_DATA',
              `Legacy baseUnitsPerPack (${baseUnitsCheck.value}) disagrees with stripsPerPack * pillsPerStrip (${product.toString()}).`,
              {
                ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
                quarantinePreserved,
              }
            );
          }
        }
      }
    } else if (hasBaseUnitsProp) {
      const baseUnitsCheck = validateStrictPositiveSafeInteger(
        rec.baseUnitsPerPack,
        'baseUnitsPerPack'
      );
      if (!baseUnitsCheck.ok) {
        return makeLegacyInvalid('LEGACY_CONTRADICTORY_DATA', baseUnitsCheck.message, {
          ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
          quarantinePreserved,
        });
      }
    }

    const inspection = inspectLegacyMedicineUnitConfig({
      dosageForm: normalizedDosageForm,
      stripsPerPack: rec.stripsPerPack,
      pillsPerStrip: rec.pillsPerStrip,
    });

    if (
      claimedStatusHint !== undefined &&
      claimedStatusHint !== inspection.configStatus &&
      claimedStatusHint !== 'QUARANTINED'
    ) {
      return makeLegacyInvalid(
        'LEGACY_CONTRADICTORY_DATA',
        `Legacy configStatus '${claimedStatusHint}' contradicts inspected status '${inspection.configStatus}'.`,
        { claimedConfigStatus: claimedStatusHint, quarantinePreserved: false }
      );
    }

    // Preserve QUARANTINED strictly without ever downgrading it to LEGACY_ASSUMED or lesser states.
    const effectiveLegacyTrustStatus: LegacyOrV2LegacyResult['trustStatus'] = quarantinePreserved
      ? 'QUARANTINED'
      : inspection.configStatus;

    return Object.freeze({
      kind: 'LEGACY_INSPECTED',
      ok: true,
      structuralValid: false,
      ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
      trustStatus: effectiveLegacyTrustStatus,
      hasIndependentOperationalAuthorization: false,
      operationalAuthorization: 'NOT_VERIFIED_CLAIM',
      isVerifiedForOperations: false,
      quarantinePreserved,
      inspection,
    });
  } catch (err) {
    return makeLegacyInvalid(
      'LEGACY_CONTRADICTORY_DATA',
      err instanceof Error ? err.message : String(err),
      {
        ...(claimedStatusHint !== undefined ? { claimedConfigStatus: claimedStatusHint } : {}),
        quarantinePreserved,
      }
    );
  }
}
