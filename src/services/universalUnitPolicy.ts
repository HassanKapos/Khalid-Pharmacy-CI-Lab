/**
 * PR-1 Universal Pharmaceutical Unit Policy Kernel (Pure, Side-Effect-Free)
 *
 * - Separates physical counting dimension (`baseDimensionKey`) from immutable packaging
 *   configuration (`unitDefinitionKey`).
 * - Supports tablet/capsule two-level hierarchy (`pill * pillsPerStrip = strip`,
 *   `strip * stripsPerPack = pack`) plus sealed non-solid and discrete containers.
 * - Forbids encoding non-solids using fake strips/pills or mL/gram/drop fractions.
 * - Fails closed on Unknown or unsupported dosage forms, with zero silent fallback defaults.
 */

import { bigIntToSafeInteger, createRational, type Rational } from './exactFinance.ts';

export type DosageFormKind =
  | 'Tablet'
  | 'Capsule'
  | 'Syrup'
  | 'Suspension'
  | 'InjectionVial'
  | 'Ampoule'
  | 'Cream'
  | 'Ointment'
  | 'Gel'
  | 'Drops'
  | 'Inhaler'
  | 'Suppository'
  | 'Sachet'
  | 'Unknown';

export type PhysicalCountingDimension =
  | 'tablet'
  | 'capsule'
  | 'bottle'
  | 'vial'
  | 'ampoule'
  | 'tube'
  | 'inhaler'
  | 'suppository'
  | 'sachet';

export type BaseUnitKind =
  | 'pill'
  | 'capsule'
  | 'bottle'
  | 'vial'
  | 'ampoule'
  | 'tube'
  | 'inhaler'
  | 'suppository'
  | 'sachet';

export type PackUnitKind = 'pack' | 'box' | 'carton';

export type IntermediateUnitKind = 'strip' | null;

export type SupportedUnitKind = BaseUnitKind | PackUnitKind | 'strip';

export type UnitConfigurationStatus =
  | 'VERIFIED'
  | 'LEGACY_ASSUMED'
  | 'UNVERIFIED_UNKNOWN'
  | 'RECONCILIATION_REQUIRED'
  | 'QUARANTINED';

export type UnitPolicyErrorCode =
  | 'UNKNOWN_DOSAGE_FORM'
  | 'UNSUPPORTED_DOSAGE_FORM'
  | 'MISSING_BASE_UNIT'
  | 'INCOMPATIBLE_BASE_UNIT'
  | 'MISSING_PACK_UNIT'
  | 'UNSUPPORTED_PACK_UNIT'
  | 'FRACTIONAL_CONTAINER_UNIT_UNSUPPORTED'
  | 'SOLID_HIERARCHY_FORBIDDEN_FOR_NON_SOLID'
  | 'MISSING_CONVERSION_FACTOR'
  | 'INVALID_CONVERSION_FACTOR'
  | 'NON_SAFE_INTEGER_FACTOR'
  | 'INCONSISTENT_PACK_HIERARCHY'
  | 'FACTOR_OVERFLOW'
  | 'EMPTY_SELLABLE_UNITS'
  | 'UNSUPPORTED_SELLABLE_UNIT'
  | 'UNVERIFIED_UNIT_DEFINITION'
  | 'INVALID_UNIT_DEFINITION_KEYS'
  | 'UNIT_NOT_SELLABLE'
  | 'UNSUPPORTED_CONVERSION_UNIT'
  | 'NON_INTEGER_QUANTITY_FORBIDDEN'
  | 'NON_POSITIVE_QUANTITY_FORBIDDEN'
  | 'UNSAFE_QUANTITY_INPUT'
  | 'QUANTITY_OVERFLOW'
  | 'INVALID_DEFINITION_VERSION'
  | 'SMART_PRICING_HIERARCHY_MISMATCH';

export class UnitPolicyError extends Error {
  readonly code: UnitPolicyErrorCode;

  constructor(code: UnitPolicyErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'UnitPolicyError';
    this.code = code;
  }
}

export interface SolidStripHierarchy {
  readonly kind: 'SOLID_TWO_LEVEL';
  readonly intermediateUnit: 'strip';
  readonly stripsPerPack: number;
  readonly pillsPerStrip: number;
  readonly baseUnitsPerPack: number;
}

export interface SealedPackHierarchy {
  readonly kind: 'DIRECT_PACK';
  readonly intermediateUnit: null;
  readonly baseUnitsPerPack: number;
  readonly stripsPerPack?: never;
  readonly pillsPerStrip?: never;
}

export type UnitHierarchy = SolidStripHierarchy | SealedPackHierarchy;

export interface ImmutableSellableUnits {
  readonly size: number;
  has(unit: SupportedUnitKind): boolean;
  values(): IterableIterator<SupportedUnitKind>;
  toArray(): ReadonlyArray<SupportedUnitKind>;
  [Symbol.iterator](): IterableIterator<SupportedUnitKind>;
}

export interface UnitDefinition {
  readonly dosageForm: Exclude<DosageFormKind, 'Unknown'>;
  readonly physicalDimension: PhysicalCountingDimension;
  readonly baseDimensionKey: string;
  readonly unitDefinitionKey: string;
  readonly definitionVersion: number;
  readonly baseUnit: BaseUnitKind;
  readonly packUnit: PackUnitKind;
  readonly intermediateUnit: IntermediateUnitKind;
  readonly hierarchy: UnitHierarchy;
  /** Compatibility mirror of hierarchy.baseUnitsPerPack; strictly validated equal before conversions. */
  readonly baseUnitsPerPack: number;
  readonly configStatus: UnitConfigurationStatus;
  readonly packingLocked: boolean;
  readonly sellableUnits: ImmutableSellableUnits;
}

export interface CreateUnitDefinitionInput {
  readonly dosageForm: unknown;
  readonly baseUnit: unknown;
  readonly packUnit: unknown;
  readonly intermediateUnit?: unknown;
  readonly stripsPerPack?: unknown;
  readonly pillsPerStrip?: unknown;
  readonly baseUnitsPerPack?: unknown;
  readonly requestedSellableUnits: ReadonlyArray<unknown>;
  readonly definitionVersion?: unknown;
  readonly configStatus?: UnitConfigurationStatus;
  readonly packingLocked?: boolean;
}

export interface UniversalConversionRequest {
  readonly definition: UnitDefinition;
  readonly enteredQuantity: unknown;
  readonly enteredUnit: unknown;
  readonly operationMode: 'SALE' | 'PURCHASE' | 'ADJUSTMENT' | 'STOCKTAKING' | 'OPENING';
}

export interface UniversalConversionResult {
  readonly baseUnits: bigint;
  readonly baseUnitsRational: Rational;
  readonly factorPerEnteredUnit: bigint;
  readonly baseUnit: BaseUnitKind;
  readonly enteredUnit: SupportedUnitKind;
  readonly baseDimensionKey: string;
  readonly unitDefinitionKey: string;
  readonly definitionVersion: number;
}

export interface LegacyInspectionResult {
  readonly configStatus: 'LEGACY_ASSUMED' | 'UNVERIFIED_UNKNOWN' | 'RECONCILIATION_REQUIRED';
  readonly dosageForm: DosageFormKind;
  readonly reasonCode: string;
  readonly legacyStripsPerPack?: number;
  readonly legacyPillsPerStrip?: number;
}

interface DosageFormSpec {
  readonly physicalDimension: PhysicalCountingDimension;
  readonly allowedBaseUnit: BaseUnitKind;
  readonly supportsStrip: boolean;
}

const DOSAGE_FORM_SPECS: Record<Exclude<DosageFormKind, 'Unknown'>, DosageFormSpec> = {
  Tablet: { physicalDimension: 'tablet', allowedBaseUnit: 'pill', supportsStrip: true },
  Capsule: { physicalDimension: 'capsule', allowedBaseUnit: 'capsule', supportsStrip: true },
  Syrup: { physicalDimension: 'bottle', allowedBaseUnit: 'bottle', supportsStrip: false },
  Suspension: { physicalDimension: 'bottle', allowedBaseUnit: 'bottle', supportsStrip: false },
  Drops: { physicalDimension: 'bottle', allowedBaseUnit: 'bottle', supportsStrip: false },
  InjectionVial: { physicalDimension: 'vial', allowedBaseUnit: 'vial', supportsStrip: false },
  Ampoule: { physicalDimension: 'ampoule', allowedBaseUnit: 'ampoule', supportsStrip: false },
  Cream: { physicalDimension: 'tube', allowedBaseUnit: 'tube', supportsStrip: false },
  Ointment: { physicalDimension: 'tube', allowedBaseUnit: 'tube', supportsStrip: false },
  Gel: { physicalDimension: 'tube', allowedBaseUnit: 'tube', supportsStrip: false },
  Inhaler: { physicalDimension: 'inhaler', allowedBaseUnit: 'inhaler', supportsStrip: false },
  Suppository: { physicalDimension: 'suppository', allowedBaseUnit: 'suppository', supportsStrip: false },
  Sachet: { physicalDimension: 'sachet', allowedBaseUnit: 'sachet', supportsStrip: false },
};

const VALID_PACK_UNITS = new Set<string>(['pack', 'box', 'carton']);
const FORBIDDEN_FRACTIONAL_UNITS = new Set<string>([
  'ml',
  'milliliter',
  'milliliters',
  'l',
  'liter',
  'g',
  'gram',
  'grams',
  'mg',
  'drop',
  'drops',
  'puff',
  'puffs',
  'dose',
  'doses',
]);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Pure synchronous SHA-256 hex digest (RFC 6234) without Node/DOM dependencies.
 */
function sha256Hex(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const k = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const bitLen = utf8.length * 8;
  const padLen = ((utf8.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(padLen);
  padded.set(utf8);
  padded[utf8.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padLen - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + k[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return Array.from(h)
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

function assertPositiveSafeFactor(value: unknown, fieldName: string): number {
  if (value === undefined || value === null || value === '') {
    throw new UnitPolicyError('MISSING_CONVERSION_FACTOR', `${fieldName} is required.`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UnitPolicyError('INVALID_CONVERSION_FACTOR', `${fieldName} must be a finite number.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new UnitPolicyError('NON_SAFE_INTEGER_FACTOR', `${fieldName} must be a safe integer.`);
  }
  if (value <= 0) {
    throw new UnitPolicyError('INVALID_CONVERSION_FACTOR', `${fieldName} must be a positive integer >= 1.`);
  }
  return value;
}

function assertPositiveSafeQuantity(value: unknown, fieldName = 'enteredQuantity'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UnitPolicyError('UNSAFE_QUANTITY_INPUT', `${fieldName} must be a finite number.`);
  }
  if (!Number.isInteger(value)) {
    throw new UnitPolicyError(
      'NON_INTEGER_QUANTITY_FORBIDDEN',
      `${fieldName} must be a discrete integer; fractional quantities are not allowed.`
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new UnitPolicyError('UNSAFE_QUANTITY_INPUT', `${fieldName} exceeds Number.MAX_SAFE_INTEGER.`);
  }
  if (value <= 0) {
    throw new UnitPolicyError('NON_POSITIVE_QUANTITY_FORBIDDEN', `${fieldName} must be positive (>= 1).`);
  }
  return value;
}

export function computeBaseDimensionKey(physicalDimension: PhysicalCountingDimension): string {
  return `bdim:v1:${physicalDimension}`;
}

export function computeUnitDefinitionKey(params: {
  dosageForm: Exclude<DosageFormKind, 'Unknown'>;
  baseUnit: BaseUnitKind;
  packUnit: PackUnitKind;
  hierarchy: UnitHierarchy;
}): string {
  const payload = JSON.stringify({
    schema: 'udef:v1',
    dosageForm: params.dosageForm,
    baseUnit: params.baseUnit,
    packUnit: params.packUnit,
    intermediateUnit: params.hierarchy.intermediateUnit,
    stripsPerPack: params.hierarchy.kind === 'SOLID_TWO_LEVEL' ? params.hierarchy.stripsPerPack : null,
    pillsPerStrip: params.hierarchy.kind === 'SOLID_TWO_LEVEL' ? params.hierarchy.pillsPerStrip : null,
    baseUnitsPerPack: params.hierarchy.baseUnitsPerPack,
  });
  return `udef:v1:${sha256Hex(payload)}`;
}

function createImmutableSellableUnits(units: Iterable<SupportedUnitKind>): ImmutableSellableUnits {
  const backingArray = Object.freeze(Array.from(new Set(units)));
  const backingSet = new Set<SupportedUnitKind>(backingArray);

  return Object.freeze({
    get size(): number {
      return backingArray.length;
    },
    has(unit: SupportedUnitKind): boolean {
      return backingSet.has(unit);
    },
    values(): IterableIterator<SupportedUnitKind> {
      return backingArray.values();
    },
    toArray(): ReadonlyArray<SupportedUnitKind> {
      return backingArray;
    },
    [Symbol.iterator](): IterableIterator<SupportedUnitKind> {
      return backingArray.values();
    },
  });
}

function getAllowedUnitsForHierarchy(
  baseUnit: BaseUnitKind,
  packUnit: PackUnitKind,
  hierarchyKind: UnitHierarchy['kind']
): Set<SupportedUnitKind> {
  const allowed = new Set<SupportedUnitKind>([packUnit, baseUnit]);
  if (hierarchyKind === 'SOLID_TWO_LEVEL') {
    allowed.add('strip');
  }
  return allowed;
}

export function createValidatedUnitDefinition(input: CreateUnitDefinitionInput): UnitDefinition {
  if (input.dosageForm === 'Unknown') {
    throw new UnitPolicyError('UNKNOWN_DOSAGE_FORM', 'Unknown dosage form fails closed and cannot be converted or sold.');
  }
  if (typeof input.dosageForm !== 'string' || !(input.dosageForm in DOSAGE_FORM_SPECS)) {
    throw new UnitPolicyError(
      'UNSUPPORTED_DOSAGE_FORM',
      `Unsupported dosage form: ${String(input.dosageForm)}.`
    );
  }

  const dosageForm = input.dosageForm as Exclude<DosageFormKind, 'Unknown'>;
  const spec = DOSAGE_FORM_SPECS[dosageForm];

  if (typeof input.baseUnit !== 'string' || input.baseUnit.trim() === '') {
    throw new UnitPolicyError('MISSING_BASE_UNIT', `baseUnit is required for dosage form ${dosageForm}.`);
  }
  const rawBaseLower = input.baseUnit.trim().toLowerCase();
  if (FORBIDDEN_FRACTIONAL_UNITS.has(rawBaseLower)) {
    throw new UnitPolicyError(
      'FRACTIONAL_CONTAINER_UNIT_UNSUPPORTED',
      `Fractional container unit '${input.baseUnit}' is unsupported in PR-1.`
    );
  }
  if (input.baseUnit !== spec.allowedBaseUnit) {
    throw new UnitPolicyError(
      'INCOMPATIBLE_BASE_UNIT',
      `Dosage form ${dosageForm} requires baseUnit '${spec.allowedBaseUnit}', got '${input.baseUnit}'.`
    );
  }
  const baseUnit = spec.allowedBaseUnit;

  if (typeof input.packUnit !== 'string' || input.packUnit.trim() === '') {
    throw new UnitPolicyError('MISSING_PACK_UNIT', 'packUnit is required.');
  }
  if (!VALID_PACK_UNITS.has(input.packUnit)) {
    throw new UnitPolicyError('UNSUPPORTED_PACK_UNIT', `Unsupported packUnit: ${input.packUnit}.`);
  }
  const packUnit = input.packUnit as PackUnitKind;

  const definitionVersion = input.definitionVersion === undefined ? 1 : input.definitionVersion;
  if (
    typeof definitionVersion !== 'number' ||
    !Number.isSafeInteger(definitionVersion) ||
    definitionVersion < 1
  ) {
    throw new UnitPolicyError('INVALID_DEFINITION_VERSION', 'definitionVersion must be a positive safe integer >= 1.');
  }

  const hasSolidFactors =
    (input.stripsPerPack !== undefined && input.stripsPerPack !== null) ||
    (input.pillsPerStrip !== undefined && input.pillsPerStrip !== null);
  const requestedIntermediate = input.intermediateUnit ?? null;

  if (!spec.supportsStrip) {
    if (requestedIntermediate !== null || hasSolidFactors) {
      throw new UnitPolicyError(
        'SOLID_HIERARCHY_FORBIDDEN_FOR_NON_SOLID',
        `Dosage form ${dosageForm} cannot define strips, stripsPerPack, or pillsPerStrip.`
      );
    }
  }

  let hierarchy: UnitHierarchy;
  if (spec.supportsStrip && (requestedIntermediate === 'strip' || (requestedIntermediate === null && hasSolidFactors))) {
    if (requestedIntermediate !== null && requestedIntermediate !== 'strip') {
      throw new UnitPolicyError(
        'UNSUPPORTED_CONVERSION_UNIT',
        `Unsupported intermediate unit '${String(requestedIntermediate)}' for ${dosageForm}.`
      );
    }
    const stripsPerPack = assertPositiveSafeFactor(input.stripsPerPack, 'stripsPerPack');
    const pillsPerStrip = assertPositiveSafeFactor(input.pillsPerStrip, 'pillsPerStrip');
    const packTotalBig = BigInt(stripsPerPack) * BigInt(pillsPerStrip);
    if (packTotalBig > MAX_SAFE_BIGINT) {
      throw new UnitPolicyError(
        'FACTOR_OVERFLOW',
        'stripsPerPack * pillsPerStrip exceeds safe integer limit.'
      );
    }
    const computedBaseUnitsPerPack = bigIntToSafeInteger(packTotalBig, 'baseUnitsPerPack');
    if (input.baseUnitsPerPack !== undefined && input.baseUnitsPerPack !== null) {
      const explicitPackUnits = assertPositiveSafeFactor(input.baseUnitsPerPack, 'baseUnitsPerPack');
      if (explicitPackUnits !== computedBaseUnitsPerPack) {
        throw new UnitPolicyError(
          'INCONSISTENT_PACK_HIERARCHY',
          `baseUnitsPerPack (${explicitPackUnits}) must equal stripsPerPack * pillsPerStrip (${computedBaseUnitsPerPack}).`
        );
      }
    }
    hierarchy = Object.freeze({
      kind: 'SOLID_TWO_LEVEL',
      intermediateUnit: 'strip',
      stripsPerPack,
      pillsPerStrip,
      baseUnitsPerPack: computedBaseUnitsPerPack,
    });
  } else {
    if (requestedIntermediate !== null) {
      throw new UnitPolicyError(
        'UNSUPPORTED_CONVERSION_UNIT',
        `Unsupported intermediate unit '${String(requestedIntermediate)}' for ${dosageForm}.`
      );
    }
    if (hasSolidFactors) {
      throw new UnitPolicyError(
        'INCONSISTENT_PACK_HIERARCHY',
        'stripsPerPack/pillsPerStrip cannot be set without strip intermediate hierarchy.'
      );
    }
    const baseUnitsPerPack = assertPositiveSafeFactor(input.baseUnitsPerPack, 'baseUnitsPerPack');
    hierarchy = Object.freeze({
      kind: 'DIRECT_PACK',
      intermediateUnit: null,
      baseUnitsPerPack,
    });
  }

  // Derive validated immutable sellableUnits facade (never exposing a mutable Set)
  if (!Array.isArray(input.requestedSellableUnits) || input.requestedSellableUnits.length === 0) {
    throw new UnitPolicyError('EMPTY_SELLABLE_UNITS', 'At least one supported sellable unit is required.');
  }

  const allowedUnits = getAllowedUnitsForHierarchy(baseUnit, packUnit, hierarchy.kind);

  const derivedSellable = new Set<SupportedUnitKind>();
  for (const candidate of input.requestedSellableUnits) {
    if (typeof candidate !== 'string') {
      throw new UnitPolicyError('UNSUPPORTED_SELLABLE_UNIT', 'Sellable unit entries must be strings.');
    }
    const trimmed = candidate.trim();
    if (FORBIDDEN_FRACTIONAL_UNITS.has(trimmed.toLowerCase())) {
      throw new UnitPolicyError(
        'FRACTIONAL_CONTAINER_UNIT_UNSUPPORTED',
        `Fractional container unit '${trimmed}' cannot be enabled as a sellable unit.`
      );
    }
    if (!allowedUnits.has(trimmed as SupportedUnitKind)) {
      throw new UnitPolicyError(
        'UNSUPPORTED_SELLABLE_UNIT',
        `Unit '${trimmed}' is not supported by ${dosageForm} (${hierarchy.kind}) definition.`
      );
    }
    derivedSellable.add(trimmed as SupportedUnitKind);
  }

  const baseDimensionKey = computeBaseDimensionKey(spec.physicalDimension);
  const unitDefinitionKey = computeUnitDefinitionKey({
    dosageForm,
    baseUnit,
    packUnit,
    hierarchy,
  });

  return Object.freeze({
    dosageForm,
    physicalDimension: spec.physicalDimension,
    baseDimensionKey,
    unitDefinitionKey,
    definitionVersion,
    baseUnit,
    packUnit,
    intermediateUnit: hierarchy.intermediateUnit,
    hierarchy,
    baseUnitsPerPack: hierarchy.baseUnitsPerPack,
    configStatus: input.configStatus ?? 'VERIFIED',
    packingLocked: Boolean(input.packingLocked),
    sellableUnits: createImmutableSellableUnits(derivedSellable),
  });
}

export function assertUnitDefinitionIntegrity(definition: UnitDefinition): void {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new UnitPolicyError('UNVERIFIED_UNIT_DEFINITION', 'UnitDefinition object is required.');
  }
  if (definition.dosageForm === ('Unknown' as unknown)) {
    throw new UnitPolicyError('UNKNOWN_DOSAGE_FORM', 'Unknown dosage form fails closed.');
  }
  const spec =
    typeof definition.dosageForm === 'string' && Object.prototype.hasOwnProperty.call(DOSAGE_FORM_SPECS, definition.dosageForm)
      ? DOSAGE_FORM_SPECS[definition.dosageForm]
      : undefined;
  if (!spec) {
    throw new UnitPolicyError('UNSUPPORTED_DOSAGE_FORM', `Unsupported dosageForm: ${String(definition.dosageForm)}`);
  }

  if (definition.physicalDimension !== spec.physicalDimension) {
    throw new UnitPolicyError(
      'INVALID_UNIT_DEFINITION_KEYS',
      `physicalDimension '${String(definition.physicalDimension)}' does not match ${definition.dosageForm}.`
    );
  }

  if (typeof definition.baseUnit !== 'string' || definition.baseUnit.trim() === '') {
    throw new UnitPolicyError('MISSING_BASE_UNIT', `baseUnit is required for ${definition.dosageForm}.`);
  }
  if (FORBIDDEN_FRACTIONAL_UNITS.has(definition.baseUnit.trim().toLowerCase())) {
    throw new UnitPolicyError(
      'FRACTIONAL_CONTAINER_UNIT_UNSUPPORTED',
      `Fractional container baseUnit '${definition.baseUnit}' is unsupported.`
    );
  }
  if (definition.baseUnit !== spec.allowedBaseUnit) {
    throw new UnitPolicyError(
      'INCOMPATIBLE_BASE_UNIT',
      `Dosage form ${definition.dosageForm} requires baseUnit '${spec.allowedBaseUnit}', got '${definition.baseUnit}'.`
    );
  }

  if (typeof definition.packUnit !== 'string' || definition.packUnit.trim() === '') {
    throw new UnitPolicyError('MISSING_PACK_UNIT', 'packUnit is required.');
  }
  if (!VALID_PACK_UNITS.has(definition.packUnit)) {
    throw new UnitPolicyError('UNSUPPORTED_PACK_UNIT', `Unsupported packUnit: ${definition.packUnit}.`);
  }

  if (
    typeof definition.definitionVersion !== 'number' ||
    !Number.isSafeInteger(definition.definitionVersion) ||
    definition.definitionVersion < 1
  ) {
    throw new UnitPolicyError('INVALID_DEFINITION_VERSION', 'definitionVersion must be a positive safe integer >= 1.');
  }

  if (typeof definition.packingLocked !== 'boolean') {
    throw new UnitPolicyError('UNVERIFIED_UNIT_DEFINITION', 'packingLocked must be a boolean.');
  }

  const hierarchy = definition.hierarchy;
  if (!hierarchy || typeof hierarchy !== 'object' || Array.isArray(hierarchy)) {
    throw new UnitPolicyError('INCONSISTENT_PACK_HIERARCHY', 'UnitDefinition.hierarchy object is required.');
  }

  if (hierarchy.kind === 'SOLID_TWO_LEVEL') {
    if (!spec.supportsStrip) {
      throw new UnitPolicyError(
        'SOLID_HIERARCHY_FORBIDDEN_FOR_NON_SOLID',
        `Dosage form ${definition.dosageForm} forbids SOLID_TWO_LEVEL hierarchy.`
      );
    }
    if (hierarchy.intermediateUnit !== 'strip' || definition.intermediateUnit !== 'strip') {
      throw new UnitPolicyError('INCONSISTENT_PACK_HIERARCHY', 'SOLID_TWO_LEVEL requires intermediateUnit strip.');
    }
    const stripsPerPack = assertPositiveSafeFactor(hierarchy.stripsPerPack, 'hierarchy.stripsPerPack');
    const pillsPerStrip = assertPositiveSafeFactor(hierarchy.pillsPerStrip, 'hierarchy.pillsPerStrip');
    const hierarchyPackUnits = assertPositiveSafeFactor(hierarchy.baseUnitsPerPack, 'hierarchy.baseUnitsPerPack');
    const productBig = BigInt(stripsPerPack) * BigInt(pillsPerStrip);
    if (productBig > MAX_SAFE_BIGINT) {
      throw new UnitPolicyError('FACTOR_OVERFLOW', 'stripsPerPack * pillsPerStrip exceeds safe integer limit.');
    }
    if (productBig !== BigInt(hierarchyPackUnits)) {
      throw new UnitPolicyError(
        'INCONSISTENT_PACK_HIERARCHY',
        `hierarchy.baseUnitsPerPack (${hierarchyPackUnits}) must equal stripsPerPack * pillsPerStrip (${productBig.toString()}).`
      );
    }
  } else if (hierarchy.kind === 'DIRECT_PACK') {
    if (hierarchy.intermediateUnit !== null || definition.intermediateUnit !== null) {
      throw new UnitPolicyError('INCONSISTENT_PACK_HIERARCHY', 'DIRECT_PACK requires intermediateUnit null.');
    }
    assertPositiveSafeFactor(hierarchy.baseUnitsPerPack, 'hierarchy.baseUnitsPerPack');
  } else {
    throw new UnitPolicyError('INCONSISTENT_PACK_HIERARCHY', `Unsupported hierarchy kind: ${String((hierarchy as { kind?: unknown }).kind)}.`);
  }

  const topLevelPackUnits = assertPositiveSafeFactor(definition.baseUnitsPerPack, 'baseUnitsPerPack');
  if (topLevelPackUnits !== hierarchy.baseUnitsPerPack) {
    throw new UnitPolicyError(
      'INCONSISTENT_PACK_HIERARCHY',
      `Top-level baseUnitsPerPack (${topLevelPackUnits}) disagrees with hierarchy.baseUnitsPerPack (${hierarchy.baseUnitsPerPack}).`
    );
  }

  const sellable = definition.sellableUnits as unknown as {
    size?: unknown;
    has?: unknown;
    [Symbol.iterator]?: unknown;
  };
  if (
    !sellable ||
    typeof sellable !== 'object' ||
    typeof sellable.has !== 'function' ||
    typeof sellable[Symbol.iterator] !== 'function' ||
    typeof sellable.size !== 'number' ||
    !Number.isSafeInteger(sellable.size) ||
    sellable.size <= 0
  ) {
    throw new UnitPolicyError('EMPTY_SELLABLE_UNITS', 'Valid non-empty sellableUnits collection is required.');
  }

  const allowedUnits = getAllowedUnitsForHierarchy(definition.baseUnit, definition.packUnit, hierarchy.kind);
  const collected = new Set<SupportedUnitKind>();
  for (const unit of sellable as Iterable<unknown>) {
    if (typeof unit !== 'string') {
      throw new UnitPolicyError('UNSUPPORTED_SELLABLE_UNIT', 'sellableUnits entries must be strings.');
    }
    if (FORBIDDEN_FRACTIONAL_UNITS.has(unit.trim().toLowerCase())) {
      throw new UnitPolicyError(
        'FRACTIONAL_CONTAINER_UNIT_UNSUPPORTED',
        `Fractional container unit '${unit}' cannot exist in sellableUnits.`
      );
    }
    if (!allowedUnits.has(unit as SupportedUnitKind)) {
      throw new UnitPolicyError(
        'UNSUPPORTED_SELLABLE_UNIT',
        `Unit '${unit}' in sellableUnits is unsupported by ${definition.dosageForm}.`
      );
    }
    if (!sellable.has(unit)) {
      throw new UnitPolicyError('UNSUPPORTED_SELLABLE_UNIT', `Inconsistent sellableUnits.has('${unit}') result.`);
    }
    collected.add(unit as SupportedUnitKind);
  }
  if (collected.size === 0 || collected.size !== sellable.size) {
    throw new UnitPolicyError('UNSUPPORTED_SELLABLE_UNIT', 'sellableUnits size disagrees with iterated entries.');
  }

  const expectedBaseDim = computeBaseDimensionKey(spec.physicalDimension);
  const expectedDefKey = computeUnitDefinitionKey({
    dosageForm: definition.dosageForm,
    baseUnit: definition.baseUnit,
    packUnit: definition.packUnit,
    hierarchy: definition.hierarchy,
  });
  if (definition.baseDimensionKey !== expectedBaseDim || definition.unitDefinitionKey !== expectedDefKey) {
    throw new UnitPolicyError(
      'INVALID_UNIT_DEFINITION_KEYS',
      'UnitDefinition keys do not match its physical dimension or packaging hierarchy.'
    );
  }
  if (definition.configStatus !== 'VERIFIED') {
    throw new UnitPolicyError(
      'UNVERIFIED_UNIT_DEFINITION',
      `UnitDefinition status '${definition.configStatus}' cannot execute standard conversions.`
    );
  }
}

/**
 * Converts an entered discrete quantity into a single authoritative BigInt base-unit count.
 */
export function convertEnteredQuantityToBaseUnits(
  request: UniversalConversionRequest
): UniversalConversionResult {
  if (!request || typeof request !== 'object') {
    throw new UnitPolicyError('UNVERIFIED_UNIT_DEFINITION', 'Conversion request object is required.');
  }
  const { definition, enteredQuantity, enteredUnit, operationMode } = request;
  assertUnitDefinitionIntegrity(definition);

  if (typeof enteredUnit !== 'string' || enteredUnit.trim() === '') {
    throw new UnitPolicyError('UNSUPPORTED_CONVERSION_UNIT', 'enteredUnit must be a non-empty unit string.');
  }
  if (FORBIDDEN_FRACTIONAL_UNITS.has(enteredUnit.trim().toLowerCase())) {
    throw new UnitPolicyError(
      'FRACTIONAL_CONTAINER_UNIT_UNSUPPORTED',
      `Fractional container unit '${enteredUnit}' is unsupported in PR-1.`
    );
  }

  let factorBig: bigint;
  if (enteredUnit === definition.baseUnit) {
    factorBig = 1n;
  } else if (enteredUnit === definition.packUnit) {
    factorBig = BigInt(definition.hierarchy.baseUnitsPerPack);
  } else if (enteredUnit === 'strip' && definition.hierarchy.kind === 'SOLID_TWO_LEVEL') {
    factorBig = BigInt(definition.hierarchy.pillsPerStrip);
  } else {
    throw new UnitPolicyError(
      'UNSUPPORTED_CONVERSION_UNIT',
      `Unit '${enteredUnit}' is incompatible with ${definition.dosageForm} (${definition.baseUnit}/${definition.packUnit}).`
    );
  }

  const typedUnit = enteredUnit as SupportedUnitKind;
  if (operationMode === 'SALE' && !definition.sellableUnits.has(typedUnit)) {
    throw new UnitPolicyError(
      'UNIT_NOT_SELLABLE',
      `Unit '${typedUnit}' is not enabled in sellableUnits for this medicine.`
    );
  }

  const qty = assertPositiveSafeQuantity(enteredQuantity, 'enteredQuantity');
  const baseUnits = BigInt(qty) * factorBig;
  if (baseUnits > MAX_SAFE_BIGINT) {
    throw new UnitPolicyError(
      'QUANTITY_OVERFLOW',
      'Converted baseUnits exceed Number.MAX_SAFE_INTEGER safe discrete bound.'
    );
  }

  return Object.freeze({
    baseUnits,
    baseUnitsRational: createRational(baseUnits, 1n),
    factorPerEnteredUnit: factorBig,
    baseUnit: definition.baseUnit,
    enteredUnit: typedUnit,
    baseDimensionKey: definition.baseDimensionKey,
    unitDefinitionKey: definition.unitDefinitionKey,
    definitionVersion: definition.definitionVersion,
  });
}

/**
 * Compatibility contract helper confirming tablet/capsule integer selling prices preserve
 * pill * pillsPerStrip = strip and strip * stripsPerPack = pack without modifying Smart Pricing.
 */
export function verifySolidHierarchyPricingCompatibility(params: {
  definition: UnitDefinition;
  packPrice: number;
  stripPrice: number;
  pillPrice: number;
}): void {
  assertUnitDefinitionIntegrity(params.definition);
  if (params.definition.hierarchy.kind !== 'SOLID_TWO_LEVEL') {
    throw new UnitPolicyError(
      'INCONSISTENT_PACK_HIERARCHY',
      'Strip/pill price ladder validation applies only to SOLID_TWO_LEVEL tablet/capsule definitions.'
    );
  }
  const { stripsPerPack, pillsPerStrip } = params.definition.hierarchy;
  for (const [label, v] of [
    ['packPrice', params.packPrice],
    ['stripPrice', params.stripPrice],
    ['pillPrice', params.pillPrice],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new UnitPolicyError('SMART_PRICING_HIERARCHY_MISMATCH', `${label} must be a non-negative safe integer.`);
    }
  }
  const pillBig = BigInt(params.pillPrice);
  const stripBig = BigInt(params.stripPrice);
  const packBig = BigInt(params.packPrice);
  if (pillBig * BigInt(pillsPerStrip) !== stripBig || stripBig * BigInt(stripsPerPack) !== packBig) {
    throw new UnitPolicyError(
      'SMART_PRICING_HIERARCHY_MISMATCH',
      'Prices violate exact integer hierarchy pill * pillsPerStrip = strip and strip * stripsPerPack = pack.'
    );
  }
}

/**
 * Pure read-only legacy configuration inspector; preserves known valid dosageForm
 * without fabricating 2x10 defaults or auto-upgrading legacy/unknown records to VERIFIED/EXACT.
 */
export function inspectLegacyMedicineUnitConfig(legacyRecord: {
  dosageForm?: unknown;
  stripsPerPack?: unknown;
  pillsPerStrip?: unknown;
}): LegacyInspectionResult {
  const form = legacyRecord?.dosageForm;
  const strips = legacyRecord?.stripsPerPack;
  const pills = legacyRecord?.pillsPerStrip;

  const hasValidLegacySolidFactors =
    typeof strips === 'number' &&
    Number.isSafeInteger(strips) &&
    strips >= 1 &&
    typeof pills === 'number' &&
    Number.isSafeInteger(pills) &&
    pills >= 1;

  const knownForm =
    typeof form === 'string' &&
    form !== 'Unknown' &&
    Object.prototype.hasOwnProperty.call(DOSAGE_FORM_SPECS, form)
      ? (form as Exclude<DosageFormKind, 'Unknown'>)
      : null;

  if (knownForm !== null) {
    const spec = DOSAGE_FORM_SPECS[knownForm];
    if (!spec.supportsStrip) {
      if (strips !== undefined || pills !== undefined) {
        return Object.freeze({
          configStatus: 'RECONCILIATION_REQUIRED',
          dosageForm: knownForm,
          reasonCode: 'LEGACY_SOLID_SPOOF_ON_NON_SOLID',
        });
      }
      return Object.freeze({
        configStatus: 'UNVERIFIED_UNKNOWN',
        dosageForm: knownForm,
        reasonCode: 'LEGACY_MISSING_UNIT_CONFIGURATION',
      });
    }

    if (hasValidLegacySolidFactors) {
      return Object.freeze({
        configStatus: 'LEGACY_ASSUMED',
        dosageForm: knownForm,
        reasonCode: 'LEGACY_FACTORS_UNVERIFIED_WITH_KNOWN_FORM',
        legacyStripsPerPack: strips as number,
        legacyPillsPerStrip: pills as number,
      });
    }

    return Object.freeze({
      configStatus: 'UNVERIFIED_UNKNOWN',
      dosageForm: knownForm,
      reasonCode: 'LEGACY_MISSING_UNIT_CONFIGURATION',
    });
  }

  if (hasValidLegacySolidFactors) {
    return Object.freeze({
      configStatus: 'LEGACY_ASSUMED',
      dosageForm: 'Unknown',
      reasonCode: 'LEGACY_MISSING_DOSAGE_FORM',
      legacyStripsPerPack: strips as number,
      legacyPillsPerStrip: pills as number,
    });
  }

  return Object.freeze({
    configStatus: 'UNVERIFIED_UNKNOWN',
    dosageForm: 'Unknown',
    reasonCode: 'LEGACY_MISSING_UNIT_CONFIGURATION',
  });
}
