/**
 * PR-2A Exact Finance Display & Rational DTO Adapter
 *
 * Pure, side-effect-free boundary adapter over PR-1 `exactFinance.ts`.
 * - ZERO IndexedDB, Firebase, DOM, localStorage, network, or Outbox calls.
 * - Uses PR-1 `BigInt` formatting strictly; never computes display values using `Number`.
 * - Solves PR-1 LOW-3: explicitly exposes BigInt `formatted` (`authoritativeFormatted`) and
 *   string-grouped `groupedFormatted` as authoritative even when `displayNumber` is omitted
 *   (`undefined`) and `displayNumberPrecisionLost` is `true`.
 * - Preserves PR-1 `HALF_UP` symmetric round-half-away-from-zero policy with ZERO SDG-specific
 *   rounding overrides, ZERO 3500/3900 -> 4000 rules, and ZERO DIRECT_PACK pricing rules.
 */

import {
  ExactFinanceError,
  createRational,
  formatRationalForDisplay,
  isValidRational,
  normalizeRational,
  type DisplayRationalValue,
  type DisplayRoundingMode,
  type Rational,
} from './exactFinance.ts';

export interface SerializedRationalDTO {
  readonly num: string;
  readonly den: string;
}

export interface ExactDisplayFormatOptions {
  readonly decimals?: number;
  readonly roundingMode?: DisplayRoundingMode;
  readonly groupThousands?: boolean;
}

export interface ExactDisplayResult extends DisplayRationalValue {
  /** Authoritative exact-policy BigInt decimal string (identical to `formatted`). */
  readonly authoritativeFormatted: string;
  /** Thousands-grouped decimal string computed solely via string manipulation of BigInt digits. */
  readonly groupedFormatted: string;
  /** Alias for PR-1 `isExact`: true iff `formatted` represents `sourceRational` with zero decimal truncation at `decimals`. */
  readonly formattedRepresentsExactSource: boolean;
  /** True iff `displayNumber` is finite and within IEEE-754 safe integer precision (`!displayNumberPrecisionLost`). */
  readonly isDisplayNumberSafe: boolean;
}

export type RationalSerializationErrorCode =
  | 'RATIONAL_DTO_INVALID_TYPE'
  | 'RATIONAL_DTO_CUSTOM_PROTOTYPE'
  | 'RATIONAL_DTO_ACCESSOR_FORBIDDEN'
  | 'RATIONAL_DTO_SYMBOL_FORBIDDEN'
  | 'RATIONAL_DTO_UNKNOWN_PROPERTY'
  | 'RATIONAL_DTO_MISSING_PROPERTY'
  | 'RATIONAL_DTO_FLOAT_OR_NUMBER_FORBIDDEN'
  | 'RATIONAL_DTO_NON_POSITIVE_DENOMINATOR'
  | 'RATIONAL_DTO_PR1_ERROR'
  | 'INVALID_DISPLAY_OPTIONS';

export class RationalSerializationError extends Error {
  readonly code: RationalSerializationErrorCode;
  readonly financeCode?: string;

  constructor(code: RationalSerializationErrorCode, message: string, financeCode?: string) {
    super(`${code}: ${message}`);
    this.name = 'RationalSerializationError';
    this.code = code;
    if (financeCode !== undefined) {
      this.financeCode = financeCode;
    }
  }
}

export type RehydrateRationalResult =
  | {
      readonly ok: true;
      readonly rational: Rational;
    }
  | {
      readonly ok: false;
      readonly errorCode: RationalSerializationErrorCode;
      readonly financeCode?: string;
      readonly message: string;
    };

const RATIONAL_KEYS = ['num', 'den'] as const;
const RATIONAL_KEY_SET = new Set<string>(RATIONAL_KEYS);
const CANONICAL_INT_STRING_RE = /^-?(0|[1-9][0-9]*)$/;
const POSITIVE_CANONICAL_INT_STRING_RE = /^[1-9][0-9]*$/;

function assertStrictRationalObjectShape(
  raw: unknown,
  label: string
): { num: string; den: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RationalSerializationError(
      'RATIONAL_DTO_INVALID_TYPE',
      `${label} must be a non-null plain object.`
    );
  }

  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    throw new RationalSerializationError(
      'RATIONAL_DTO_CUSTOM_PROTOTYPE',
      `${label} must have Object.prototype or null prototype.`
    );
  }

  if (Object.getOwnPropertySymbols(raw).length > 0) {
    throw new RationalSerializationError(
      'RATIONAL_DTO_SYMBOL_FORBIDDEN',
      `${label} must not contain symbol properties.`
    );
  }

  for (const key of Object.getOwnPropertyNames(raw)) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
      throw new RationalSerializationError(
        'RATIONAL_DTO_ACCESSOR_FORBIDDEN',
        `${label}.${key} must be a plain data property.`
      );
    }
    if (!RATIONAL_KEY_SET.has(key)) {
      throw new RationalSerializationError(
        'RATIONAL_DTO_UNKNOWN_PROPERTY',
        `${label}.${key} is not allowed; only 'num' and 'den' are permitted.`
      );
    }
  }

  for (const req of RATIONAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, req)) {
      throw new RationalSerializationError(
        'RATIONAL_DTO_MISSING_PROPERTY',
        `${label}.${req} is required.`
      );
    }
  }

  const rec = raw as Record<string, unknown>;
  if (typeof rec.num !== 'string' || typeof rec.den !== 'string') {
    throw new RationalSerializationError(
      'RATIONAL_DTO_FLOAT_OR_NUMBER_FORBIDDEN',
      `${label}.num and ${label}.den must strictly be canonical integer strings (numbers/floats/bigints forbidden).`
    );
  }

  if (rec.num === '-0' || !CANONICAL_INT_STRING_RE.test(rec.num)) {
    throw new RationalSerializationError(
      'RATIONAL_DTO_FLOAT_OR_NUMBER_FORBIDDEN',
      `${label}.num '${rec.num}' must be a canonical integer decimal string.`
    );
  }

  if (rec.den === '0' || !POSITIVE_CANONICAL_INT_STRING_RE.test(rec.den)) {
    throw new RationalSerializationError(
      'RATIONAL_DTO_NON_POSITIVE_DENOMINATOR',
      `${label}.den '${rec.den}' must be a positive non-zero canonical integer string.`
    );
  }

  return { num: rec.num, den: rec.den };
}

/**
 * Pure O(n) thousands grouping on a formatted BigInt decimal string without touching `Number`.
 */
function groupIntegerPartPureString(formatted: string): string {
  const negative = formatted.startsWith('-');
  const unsigned = negative ? formatted.slice(1) : formatted;
  const dotIndex = unsigned.indexOf('.');
  const intDigits = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fracSuffix = dotIndex === -1 ? '' : unsigned.slice(dotIndex);

  if (intDigits.length <= 3) {
    return formatted;
  }

  const chunks: string[] = [];
  for (let end = intDigits.length; end > 0; end -= 3) {
    const start = Math.max(0, end - 3);
    chunks.push(intDigits.slice(start, end));
  }
  chunks.reverse();
  return `${negative ? '-' : ''}${chunks.join(',')}${fracSuffix}`;
}

/**
 * Serializes a `Rational` into a strict plain DTO `{ num, den }`.
 * Validates allowlist, canonical strings, positive non-zero denominator, and normalizes via PR-1.
 */
export function serializeRationalToDto(rational: Rational): SerializedRationalDTO {
  const raw = assertStrictRationalObjectShape(rational, 'Rational');
  try {
    const normalized = normalizeRational(raw);
    if (!isValidRational(normalized)) {
      throw new RationalSerializationError(
        'RATIONAL_DTO_PR1_ERROR',
        'Normalized Rational failed PR-1 isValidRational check.'
      );
    }
    return {
      num: normalized.num,
      den: normalized.den,
    };
  } catch (err) {
    if (err instanceof RationalSerializationError) throw err;
    if (err instanceof ExactFinanceError) {
      throw new RationalSerializationError('RATIONAL_DTO_PR1_ERROR', err.message, err.code);
    }
    throw new RationalSerializationError(
      'RATIONAL_DTO_PR1_ERROR',
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Rehydrates an untrusted DTO into a canonical PR-1 `Rational` using `createRational` & `isValidRational`.
 */
export function rehydrateRationalFromDto(raw: unknown): RehydrateRationalResult {
  try {
    const shape = assertStrictRationalObjectShape(raw, 'SerializedRationalDTO');
    const created = createRational(shape.num, shape.den);
    if (!isValidRational(created)) {
      return Object.freeze({
        ok: false,
        errorCode: 'RATIONAL_DTO_PR1_ERROR',
        message: 'Rehydrated Rational failed PR-1 isValidRational check.',
      });
    }
    return Object.freeze({
      ok: true,
      rational: created,
    });
  } catch (err) {
    if (err instanceof RationalSerializationError) {
      return Object.freeze({
        ok: false,
        errorCode: err.code,
        ...(err.financeCode !== undefined ? { financeCode: err.financeCode } : {}),
        message: err.message,
      });
    }
    if (err instanceof ExactFinanceError) {
      return Object.freeze({
        ok: false,
        errorCode: 'RATIONAL_DTO_PR1_ERROR',
        financeCode: err.code,
        message: err.message,
      });
    }
    return Object.freeze({
      ok: false,
      errorCode: 'RATIONAL_DTO_INVALID_TYPE',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function rehydrateRationalFromDtoOrThrow(raw: unknown): Rational {
  const result = rehydrateRationalFromDto(raw);
  if (!result.ok) {
    throw new RationalSerializationError(result.errorCode, result.message, result.financeCode);
  }
  return result.rational;
}

/**
 * Formats a `Rational` for display using PR-1 BigInt arithmetic exclusively.
 * - `authoritativeFormatted` / `formatted` is ALWAYS authoritative regardless of IEEE-754 bounds.
 * - `displayNumber` is strictly `undefined` when `displayNumberPrecisionLost` is `true`.
 * - Preserves PR-1 `HALF_UP` (symmetric round-half-away-from-zero) default policy.
 */
const DISPLAY_OPTION_KEYS = new Set<string>(['decimals', 'roundingMode', 'groupThousands']);
const VALID_ROUNDING_MODES = new Set<string>(['HALF_UP', 'FLOOR', 'CEIL', 'TRUNC']);

export function formatRationalDisplayExact(
  rational: Rational,
  options?: ExactDisplayFormatOptions
): ExactDisplayResult {
  if (options !== undefined) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new RationalSerializationError(
        'INVALID_DISPLAY_OPTIONS',
        'ExactDisplayFormatOptions must be a plain object when supplied.'
      );
    }
    const proto = Object.getPrototypeOf(options);
    if (proto !== Object.prototype && proto !== null) {
      throw new RationalSerializationError(
        'INVALID_DISPLAY_OPTIONS',
        'ExactDisplayFormatOptions must not have a custom prototype.'
      );
    }
    if (Object.getOwnPropertySymbols(options).length > 0) {
      throw new RationalSerializationError(
        'INVALID_DISPLAY_OPTIONS',
        'ExactDisplayFormatOptions must not contain symbol properties.'
      );
    }
    for (const key of Object.getOwnPropertyNames(options)) {
      const desc = Object.getOwnPropertyDescriptor(options, key);
      if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
        throw new RationalSerializationError(
          'INVALID_DISPLAY_OPTIONS',
          `ExactDisplayFormatOptions.${key} must be a plain data property.`
        );
      }
      if (!DISPLAY_OPTION_KEYS.has(key)) {
        throw new RationalSerializationError(
          'INVALID_DISPLAY_OPTIONS',
          `ExactDisplayFormatOptions.${key} is not an allowed option key.`
        );
      }
    }
    if (
      options.decimals !== undefined &&
      (typeof options.decimals !== 'number' ||
        !Number.isSafeInteger(options.decimals) ||
        options.decimals < 0 ||
        options.decimals > 8)
    ) {
      throw new RationalSerializationError(
        'INVALID_DISPLAY_OPTIONS',
        'options.decimals must be a safe integer between 0 and 8.'
      );
    }
    if (
      options.roundingMode !== undefined &&
      (typeof options.roundingMode !== 'string' || !VALID_ROUNDING_MODES.has(options.roundingMode))
    ) {
      throw new RationalSerializationError(
        'INVALID_DISPLAY_OPTIONS',
        `options.roundingMode '${String(options.roundingMode)}' is unsupported.`
      );
    }
    if (
      options.groupThousands !== undefined &&
      typeof options.groupThousands !== 'boolean'
    ) {
      throw new RationalSerializationError(
        'INVALID_DISPLAY_OPTIONS',
        'options.groupThousands must be a boolean.'
      );
    }
  }

  const dto = assertStrictRationalObjectShape(rational, 'Rational');
  let canonical: Rational;
  let core: DisplayRationalValue;
  try {
    canonical = createRational(dto.num, dto.den);
    core = formatRationalForDisplay(canonical, {
      ...(options?.decimals !== undefined ? { decimals: options.decimals } : {}),
      ...(options?.roundingMode !== undefined ? { roundingMode: options.roundingMode } : {}),
    });
  } catch (err) {
    if (err instanceof ExactFinanceError) {
      throw new RationalSerializationError('RATIONAL_DTO_PR1_ERROR', err.message, err.code);
    }
    throw err;
  }

  const groupedFormatted =
    options?.groupThousands === false
      ? core.formatted
      : groupIntegerPartPureString(core.formatted);

  const safeDisplayNumber = core.displayNumberPrecisionLost ? undefined : core.displayNumber;

  return Object.freeze({
    formatted: core.formatted,
    authoritativeFormatted: core.formatted,
    groupedFormatted,
    displayNumber: safeDisplayNumber,
    isExact: core.isExact,
    formattedRepresentsExactSource: core.isExact,
    displayNumberPrecisionLost: core.displayNumberPrecisionLost,
    isDisplayNumberSafe: !core.displayNumberPrecisionLost && safeDisplayNumber !== undefined,
    roundingMode: core.roundingMode,
    decimals: core.decimals,
    sourceRational: core.sourceRational,
  });
}
