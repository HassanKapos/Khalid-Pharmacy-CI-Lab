/**
 * PR-1 Exact Finance Kernel (Pure, Side-Effect-Free)
 *
 * Canonical exact rational arithmetic backed internally by BigInt.
 * - Persisted/transport representation uses reduced integer decimal strings { num, den }.
 * - Denominator is strictly positive and non-zero.
 * - Zero floating-point approximation in exact operations; display formatting is separated.
 */

export const MAX_RATIONAL_DIGITS = 64 as const;
export const MAX_RAW_RATIONAL_INPUT_DIGITS = 256 as const;
export const MAX_RATIONAL_ARRAY_ITEMS = 100_000 as const;

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_RAW_BIGINT_MAGNITUDE = 10n ** BigInt(MAX_RAW_RATIONAL_INPUT_DIGITS);
const CANONICAL_INT_STRING_RE = /^-?(0|[1-9][0-9]*)$/;

export type ExactFinanceErrorCode =
  | 'RATIONAL_ZERO_DENOMINATOR'
  | 'RATIONAL_DIVISION_BY_ZERO'
  | 'RATIONAL_MALFORMED_INPUT'
  | 'RATIONAL_UNSAFE_NUMBER'
  | 'RATIONAL_FLOAT_FORBIDDEN'
  | 'RATIONAL_PRECISION_LIMIT_EXCEEDED'
  | 'RATIONAL_UNSAFE_INTEGER_CONVERSION'
  | 'RATIONAL_NON_INTEGER_CONVERSION'
  | 'RATIONAL_COLLECTION_LIMIT_EXCEEDED'
  | 'INVALID_DISPLAY_PRECISION';

export class ExactFinanceError extends Error {
  readonly code: ExactFinanceErrorCode;

  constructor(code: ExactFinanceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ExactFinanceError';
    this.code = code;
  }
}

/** Canonical reduced rational stored as integer decimal strings. */
export interface Rational {
  readonly num: string;
  readonly den: string;
}

export type ExactNumericInput = bigint | number | string;

export type PrecisionClassification =
  | 'EXACT_SOURCE'
  | 'EXACT_RECONSTRUCTABLE'
  | 'APPROXIMATE_LEGACY'
  | 'UNPROVABLE';

export interface LegacyApproximateValue {
  readonly classification: 'APPROXIMATE_LEGACY' | 'UNPROVABLE';
  readonly legacyFloatValue?: number;
  readonly reason: string;
}

export type DisplayRoundingMode = 'HALF_UP' | 'FLOOR' | 'CEIL' | 'TRUNC';

export interface DisplayRationalValue {
  readonly formatted: string;
  /** Safe JS Number when rounded decimal fits IEEE-754 integer precision without truncation; omitted when lossy or non-finite. */
  readonly displayNumber?: number;
  /** True iff `formatted` represents `sourceRational` with zero decimal truncation at `decimals` (independent of IEEE-754 Number limits). */
  readonly isExact: boolean;
  /** True when `displayNumber` would lose integer/mantissa precision under IEEE-754 double and is therefore omitted. */
  readonly displayNumberPrecisionLost: boolean;
  readonly roundingMode: DisplayRoundingMode;
  readonly decimals: number;
  readonly sourceRational: Rational;
}

export function gcdBigInt(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

function assertDigitLengthWithinLimit(num: bigint, den: bigint): void {
  const numDigits = (num < 0n ? -num : num).toString().length;
  const denDigits = den.toString().length;
  if (numDigits > MAX_RATIONAL_DIGITS || denDigits > MAX_RATIONAL_DIGITS) {
    throw new ExactFinanceError(
      'RATIONAL_PRECISION_LIMIT_EXCEEDED',
      `Rational exceeds maximum ${MAX_RATIONAL_DIGITS} decimal digits (numDigits=${numDigits}, denDigits=${denDigits}).`
    );
  }
}

export function parseExactBigInt(value: ExactNumericInput, fieldName = 'value'): bigint {
  if (typeof value === 'bigint') {
    const abs = value < 0n ? -value : value;
    if (abs >= MAX_RAW_BIGINT_MAGNITUDE) {
      throw new ExactFinanceError(
        'RATIONAL_PRECISION_LIMIT_EXCEEDED',
        `${fieldName} exceeds maximum raw input digit bound (${MAX_RAW_RATIONAL_INPUT_DIGITS} digits).`
      );
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ExactFinanceError('RATIONAL_UNSAFE_NUMBER', `${fieldName} must be finite.`);
    }
    if (!Number.isInteger(value)) {
      throw new ExactFinanceError(
        'RATIONAL_FLOAT_FORBIDDEN',
        `${fieldName} cannot be a non-integer floating-point number in exact arithmetic.`
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new ExactFinanceError(
        'RATIONAL_UNSAFE_NUMBER',
        `${fieldName} exceeds JavaScript safe integer bounds; pass bigint or integer string.`
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    if (value === '-0' || !CANONICAL_INT_STRING_RE.test(value)) {
      throw new ExactFinanceError(
        'RATIONAL_MALFORMED_INPUT',
        `${fieldName} must be a canonical integer decimal string without whitespace, decimals, or signs like '+'.`
      );
    }
    const digitCount = value.startsWith('-') ? value.length - 1 : value.length;
    if (digitCount > MAX_RAW_RATIONAL_INPUT_DIGITS) {
      throw new ExactFinanceError(
        'RATIONAL_PRECISION_LIMIT_EXCEEDED',
        `${fieldName} exceeds maximum raw input digit bound (${MAX_RAW_RATIONAL_INPUT_DIGITS} digits).`
      );
    }
    return BigInt(value);
  }
  throw new ExactFinanceError(
    'RATIONAL_MALFORMED_INPUT',
    `${fieldName} must be bigint, safe integer number, or canonical integer string.`
  );
}

function buildCanonicalRational(rawNum: bigint, rawDen: bigint): Rational {
  if (rawDen === 0n) {
    throw new ExactFinanceError('RATIONAL_ZERO_DENOMINATOR', 'Rational denominator must not be zero.');
  }

  let num = rawNum;
  let den = rawDen;
  if (den < 0n) {
    num = -num;
    den = -den;
  }

  if (num === 0n) {
    return Object.freeze({ num: '0', den: '1' });
  }

  const divisor = gcdBigInt(num, den);
  num /= divisor;
  den /= divisor;

  assertDigitLengthWithinLimit(num, den);
  return Object.freeze({
    num: num.toString(),
    den: den.toString(),
  });
}

function toInternalParts(value: Rational, fieldName = 'rational'): { num: bigint; den: bigint } {
  if (!value || typeof value !== 'object') {
    throw new ExactFinanceError('RATIONAL_MALFORMED_INPUT', `${fieldName} must be a Rational object.`);
  }
  if (typeof value.num !== 'string' || typeof value.den !== 'string') {
    throw new ExactFinanceError(
      'RATIONAL_MALFORMED_INPUT',
      `${fieldName}.num and ${fieldName}.den must be canonical integer strings.`
    );
  }
  const num = parseExactBigInt(value.num, `${fieldName}.num`);
  const den = parseExactBigInt(value.den, `${fieldName}.den`);
  if (den === 0n) {
    throw new ExactFinanceError('RATIONAL_ZERO_DENOMINATOR', `${fieldName}.den must not be zero.`);
  }
  if (den < 0n) {
    // Normalize if caller passed an unnormalized Rational object directly
    const normalized = buildCanonicalRational(num, den);
    return { num: BigInt(normalized.num), den: BigInt(normalized.den) };
  }
  const divisor = gcdBigInt(num, den);
  const reducedNum = num === 0n ? 0n : num / divisor;
  const reducedDen = num === 0n ? 1n : den / divisor;
  assertDigitLengthWithinLimit(reducedNum, reducedDen);
  return { num: reducedNum, den: reducedDen };
}

export function createRational(
  numerator: ExactNumericInput,
  denominator: ExactNumericInput = 1n
): Rational {
  const num = parseExactBigInt(numerator, 'numerator');
  const den = parseExactBigInt(denominator, 'denominator');
  return buildCanonicalRational(num, den);
}

export function normalizeRational(rational: Rational): Rational {
  const { num, den } = toInternalParts(rational, 'rational');
  return buildCanonicalRational(num, den);
}

export function isValidRational(value: unknown): value is Rational {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Rational;
  try {
    normalizeRational(candidate);
    return true;
  } catch {
    return false;
  }
}

export function addRational(a: Rational, b: Rational): Rational {
  const left = toInternalParts(a, 'left');
  const right = toInternalParts(b, 'right');
  const common = gcdBigInt(left.den, right.den);
  const leftScale = right.den / common;
  const rightScale = left.den / common;
  const num = left.num * leftScale + right.num * rightScale;
  const den = left.den * leftScale;
  return buildCanonicalRational(num, den);
}

export function subtractRational(a: Rational, b: Rational): Rational {
  const left = toInternalParts(a, 'left');
  const right = toInternalParts(b, 'right');
  const common = gcdBigInt(left.den, right.den);
  const leftScale = right.den / common;
  const rightScale = left.den / common;
  const num = left.num * leftScale - right.num * rightScale;
  const den = left.den * leftScale;
  return buildCanonicalRational(num, den);
}

export function multiplyRational(a: Rational, b: Rational): Rational {
  const left = toInternalParts(a, 'left');
  const right = toInternalParts(b, 'right');
  if (left.num === 0n || right.num === 0n) {
    return Object.freeze({ num: '0', den: '1' });
  }
  const g1 = gcdBigInt(left.num, right.den);
  const g2 = gcdBigInt(right.num, left.den);
  const num = (left.num / g1) * (right.num / g2);
  const den = (left.den / g2) * (right.den / g1);
  return buildCanonicalRational(num, den);
}

export function divideRational(a: Rational, b: Rational): Rational {
  const left = toInternalParts(a, 'left');
  const right = toInternalParts(b, 'right');
  if (right.num === 0n) {
    throw new ExactFinanceError('RATIONAL_DIVISION_BY_ZERO', 'Cannot divide rational by zero.');
  }
  if (left.num === 0n) {
    return Object.freeze({ num: '0', den: '1' });
  }
  const g1 = gcdBigInt(left.num, right.num);
  const g2 = gcdBigInt(left.den, right.den);
  const num = (left.num / g1) * (right.den / g2);
  const den = (left.den / g2) * (right.num / g1);
  return buildCanonicalRational(num, den);
}

export function negateRational(a: Rational): Rational {
  const parts = toInternalParts(a, 'rational');
  return buildCanonicalRational(-parts.num, parts.den);
}

export function absRational(a: Rational): Rational {
  const parts = toInternalParts(a, 'rational');
  return buildCanonicalRational(parts.num < 0n ? -parts.num : parts.num, parts.den);
}

export function compareRational(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = toInternalParts(a, 'left');
  const right = toInternalParts(b, 'right');
  const lhs = left.num * right.den;
  const rhs = right.num * left.den;
  if (lhs < rhs) return -1;
  if (lhs > rhs) return 1;
  return 0;
}

export function equalsRational(a: Rational, b: Rational): boolean {
  return compareRational(a, b) === 0;
}

export function isZeroRational(a: Rational): boolean {
  return toInternalParts(a, 'rational').num === 0n;
}

export function isNegativeRational(a: Rational): boolean {
  return toInternalParts(a, 'rational').num < 0n;
}

export function isIntegerRational(a: Rational): boolean {
  return toInternalParts(a, 'rational').den === 1n;
}

export function sumRationals(items: ReadonlyArray<Rational>): Rational {
  if (!Array.isArray(items)) {
    throw new ExactFinanceError('RATIONAL_MALFORMED_INPUT', 'items must be an array of Rationals.');
  }
  if (items.length > MAX_RATIONAL_ARRAY_ITEMS) {
    throw new ExactFinanceError(
      'RATIONAL_COLLECTION_LIMIT_EXCEEDED',
      `Collection size ${items.length} exceeds limit ${MAX_RATIONAL_ARRAY_ITEMS}.`
    );
  }
  let acc = createRational(0n, 1n);
  for (const item of items) {
    acc = addRational(acc, item);
  }
  return acc;
}

export function bigIntToSafeInteger(value: bigint, fieldName = 'value'): number {
  if (typeof value !== 'bigint') {
    throw new ExactFinanceError('RATIONAL_MALFORMED_INPUT', `${fieldName} must be a bigint.`);
  }
  if (value > MAX_SAFE_BIGINT || value < MIN_SAFE_BIGINT) {
    throw new ExactFinanceError(
      'RATIONAL_UNSAFE_INTEGER_CONVERSION',
      `${fieldName} (${value.toString()}) exceeds JavaScript safe integer boundaries.`
    );
  }
  return Number(value);
}

export function rationalToSafeInteger(value: Rational, fieldName = 'rational'): number {
  const parts = toInternalParts(value, fieldName);
  if (parts.den !== 1n) {
    throw new ExactFinanceError(
      'RATIONAL_NON_INTEGER_CONVERSION',
      `${fieldName} (${parts.num}/${parts.den}) is not an exact integer.`
    );
  }
  return bigIntToSafeInteger(parts.num, fieldName);
}

/**
 * Legacy floating-point amounts must never be promoted into exact Rationals.
 * They remain quarantined as APPROXIMATE_LEGACY or UNPROVABLE for accounting review.
 */
export function classifyLegacyFloatForExactBoundary(value: unknown): LegacyApproximateValue {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Object.freeze({
      classification: 'UNPROVABLE',
      reason: 'Legacy value is non-numeric or non-finite.',
    });
  }
  return Object.freeze({
    classification: 'APPROXIMATE_LEGACY',
    legacyFloatValue: value,
    reason: 'Floating-point legacy value cannot be promoted into an exact rational without source inputs.',
  });
}

/**
 * Rounds an exact rational magnitude for display.
 * Policy: `HALF_UP` uses financial symmetric round-half-away-from-zero
 * (e.g., -0.005 at 2 decimals -> -0.01; -2.5 at 0 decimals -> -3).
 */
function roundScaledNumerator(
  absScaledNum: bigint,
  den: bigint,
  negative: boolean,
  mode: DisplayRoundingMode
): bigint {
  const q = absScaledNum / den;
  const rem = absScaledNum % den;
  if (rem === 0n) return q;

  switch (mode) {
    case 'TRUNC':
      return q;
    case 'FLOOR':
      return negative ? q + 1n : q;
    case 'CEIL':
      return negative ? q : q + 1n;
    case 'HALF_UP':
      return rem * 2n >= den ? q + 1n : q;
    default:
      throw new ExactFinanceError('INVALID_DISPLAY_PRECISION', `Unsupported rounding mode: ${String(mode)}`);
  }
}

/**
 * Explicit display-only conversion. Never use display output as input to exact arithmetic.
 * - `isExact` indicates whether `formatted` represents `value` without decimal truncation at `decimals`.
 * - `displayNumber` is omitted (`undefined`) and `displayNumberPrecisionLost` is `true` whenever
 *   the rounded scaled integer exceeds JS IEEE-754 `MAX_SAFE_INTEGER` or `Number(formatted)` is non-finite.
 */
export function formatRationalForDisplay(
  value: Rational,
  options?: { decimals?: number; roundingMode?: DisplayRoundingMode }
): DisplayRationalValue {
  const decimals = options?.decimals ?? 2;
  const roundingMode = options?.roundingMode ?? 'HALF_UP';
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 8) {
    throw new ExactFinanceError(
      'INVALID_DISPLAY_PRECISION',
      'Display decimals must be an integer between 0 and 8.'
    );
  }

  const normalized = normalizeRational(value);
  const num = BigInt(normalized.num);
  const den = BigInt(normalized.den);
  const negative = num < 0n;
  const absNum = negative ? -num : num;
  const scale = 10n ** BigInt(decimals);
  const scaledNum = absNum * scale;
  const isExact = scaledNum % den === 0n;
  const roundedScaled = roundScaledNumerator(scaledNum, den, negative, roundingMode);

  const intPart = roundedScaled / scale;
  const fracPart = roundedScaled % scale;
  const sign = negative && roundedScaled > 0n ? '-' : '';
  const formatted =
    decimals === 0
      ? `${sign}${intPart.toString()}`
      : `${sign}${intPart.toString()}.${fracPart.toString().padStart(decimals, '0')}`;

  const parsedNumber = Number(formatted);
  const precisionLost =
    intPart > MAX_SAFE_BIGINT ||
    roundedScaled > MAX_SAFE_BIGINT ||
    !Number.isFinite(parsedNumber);

  return Object.freeze({
    formatted,
    displayNumber: precisionLost ? undefined : parsedNumber,
    isExact,
    displayNumberPrecisionLost: precisionLost,
    roundingMode,
    decimals,
    sourceRational: normalized,
  });
}
