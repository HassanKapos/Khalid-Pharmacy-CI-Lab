/**
 * R13-B — deterministic OCR purchase intent snapshot.
 *
 * Pure boundary module: no IndexedDB, inventory, supplier balance, Outbox,
 * Firebase or network calls.
 *
 * IMPORTANT:
 * - This module snapshots the OCR intent only; it does not post purchases.
 * - Unit conversion definitions are deliberately not fabricated here. The
 *   atomic DB posting layer must add its transaction-time conversion snapshot.
 * - Numeric values are serialized as decimal strings to avoid introducing
 *   additional floating-point rounding during canonicalization.
 */
import type { SupplierInvoiceDraft } from '../types/supplierInvoiceOcr';

export const OCR_PURCHASE_CANONICAL_VERSION = 1 as const;

export type OcrPurchasePaymentType = 'Cash' | 'Credit' | 'Partial';

export interface OcrPurchasePaymentIntent {
  readonly paymentType: OcrPurchasePaymentType;
  readonly paidAmount: number | string;
  readonly currency: string;
}

export interface OcrPurchaseCanonicalPayload {
  readonly canonicalVersion: typeof OCR_PURCHASE_CANONICAL_VERSION;
  readonly source: 'OCR';
  readonly ocrDraftId: string;
  readonly supplier: {
    readonly id: string;
    readonly extractedName: string;
  };
  readonly invoice: {
    readonly number: string;
    readonly date: string;
    readonly currency: string;
    readonly subtotal: string;
    readonly discount: string;
    /** Tax is strictly excluded from R13-D canonical calculations and is always serialized as '0'. */
    readonly tax: '0';
    readonly finalTotal: string;
    readonly reconciliation: {
      readonly isReconciled: boolean;
      readonly difference: string;
      readonly overrideReason: null;
      readonly overrideBy: null;
      readonly overrideAt: null;
    };
  };
  /** Invoice line order is meaningful and is intentionally preserved. */
  readonly items: ReadonlyArray<{
    readonly lineIndex: number;
    readonly sourceItemId: string;
    readonly medicineId: string;
    readonly medicineName: string;
    readonly tradeName: string;
    readonly genericName: string | null;
    readonly strength: string;
    readonly dosageForm: string;
    readonly releaseType: string | null;
    readonly concentration: string | null;
    readonly packageSize: string | null;
    readonly barcode: string | null;
    readonly batchNumber: string;
    readonly expiryDate: string;
    readonly quantity: string;
    readonly unit: string;
    readonly unitBuyPrice: string;
    readonly itemDiscount: string;
    readonly lineTotal: string;
    readonly suggestedSellPrice: string | null;
    readonly isUserConfirmed: boolean;
  }>;
  readonly paymentIntent: {
    readonly paymentType: OcrPurchasePaymentType;
    readonly paidAmount: string;
    readonly currency: string;
  };
  readonly postingActor: string;
  readonly approvedBranchId: string | null;
}

export interface OcrPurchaseCanonicalSnapshot {
  readonly payload: OcrPurchaseCanonicalPayload;
  readonly canonicalJson: string;
  readonly sha256: string;
}

export class OcrPurchaseCanonicalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OcrPurchaseCanonicalError';
    this.code = code;
  }
}

function requiredText(value: unknown, field: string, errorCode = 'INVALID_REQUIRED_TEXT'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OcrPurchaseCanonicalError(errorCode, field + ' is required.');
  }
  return value.trim();
}

/**
 * Convert a finite JS number or decimal string to a stable base-10 string.
 * This does not claim to recover precision already lost before this boundary.
 */
function canonicalDecimal(value: unknown, field: string): string {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new OcrPurchaseCanonicalError('INVALID_DECIMAL', field + ' must be a number or decimal string.');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new OcrPurchaseCanonicalError('INVALID_DECIMAL', field + ' must be finite.');
  }
  const raw = String(value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
    throw new OcrPurchaseCanonicalError('INVALID_DECIMAL', field + ' is not a valid base-10 decimal.');
  }
  const sign = raw.startsWith('-') ? '-' : '';
  const unsigned = raw.replace(/^[+-]/, '');
  const parts = unsigned.toLowerCase().split('e');
  const mantissa = parts[0];
  const exponent = parts.length === 2 ? Number(parts[1]) : 0;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    throw new OcrPurchaseCanonicalError('DECIMAL_EXPONENT_LIMIT', field + ' exponent is outside the supported range.');
  }
  const dot = mantissa.indexOf('.');
  const integerPart = dot < 0 ? mantissa : mantissa.slice(0, dot);
  const fractionPart = dot < 0 ? '' : mantissa.slice(dot + 1);
  const digits = (integerPart || '0') + fractionPart;
  const decimalPosition = (integerPart || '0').length + exponent;
  let expanded: string;
  if (decimalPosition <= 0) {
    expanded = '0.' + '0'.repeat(-decimalPosition) + digits;
  } else if (decimalPosition >= digits.length) {
    expanded = digits + '0'.repeat(decimalPosition - digits.length);
  } else {
    expanded = digits.slice(0, decimalPosition) + '.' + digits.slice(decimalPosition);
  }
  const normalized = expanded.includes('.')
    ? expanded.replace(/0+$/, '').replace(/\.$/, '')
    : expanded;
  const unsignedNormalized = normalized.replace(/^0+(?=\d)/, '');
  const isZero = /^0(?:\.0*)?$/.test(unsignedNormalized);
  return isZero ? '0' : sign + unsignedNormalized;
}

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return String(value);
    throw new OcrPurchaseCanonicalError('UNSAFE_JSON_NUMBER', 'Canonical payload may contain only safe non-negative integer structural numbers.');
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableSerialize).join(',') + ']';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return '{' + keys.map(key => JSON.stringify(key) + ':' + stableSerialize(record[key])).join(',') + '}';
  }
  throw new OcrPurchaseCanonicalError('UNSUPPORTED_CANONICAL_VALUE', 'Canonical payload contains an unsupported value.');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function fieldValue<T>(field: { value: T } | undefined, fallback: T): T {
  return field && field.value !== undefined && field.value !== null ? field.value : fallback;
}

function extractRawFieldValue(field: unknown): unknown {
  if (field && typeof field === 'object' && 'value' in (field as Record<string, unknown>)) {
    return (field as { value: unknown }).value;
  }
  return field;
}

// ============================================================================
// R13-D.3: STRICT MEDICINE IDENTITY EXTRACTION & COMPATIBILITY VALIDATION
// Single pure source of truth shared by OCR matching, approval, and posting.
// ============================================================================

export type CanonicalMedicineDosageForm =
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
  | 'Sachet';

export interface MedicineIdentityProfile {
  readonly dosageForm: CanonicalMedicineDosageForm | null;
  readonly strengths: ReadonlyArray<string>;
  readonly concentrations: ReadonlyArray<string>;
  readonly releaseTypes: ReadonlyArray<string>;
  readonly variants: ReadonlyArray<string>;
  readonly packageVolumeOrWeight: string | null;
  readonly packageCount: number | null;
}

function gcdBigIntLocal(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

function decimalToScaledBigInt(raw: string): { num: bigint; den: bigint } | null {
  const cleaned = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const dot = cleaned.indexOf('.');
  if (dot < 0) {
    return { num: BigInt(cleaned), den: 1n };
  }
  const intPart = cleaned.slice(0, dot);
  const fracPart = cleaned.slice(dot + 1);
  const den = 10n ** BigInt(fracPart.length);
  const num = BigInt(intPart + fracPart);
  const g = gcdBigIntLocal(num, den);
  return { num: num / g, den: den / g };
}

function formatRatioKey(num: bigint, den: bigint, unit: string): string {
  const g = gcdBigIntLocal(num, den);
  const rNum = num / g;
  const rDen = den / g;
  return rDen === 1n ? `${rNum.toString()}${unit}` : `${rNum.toString()}/${rDen.toString()}${unit}`;
}

function convertMassToMgRatio(valStr: string, rawUnit: string): { num: bigint; den: bigint; unit: string } | null {
  const parsed = decimalToScaledBigInt(valStr);
  if (!parsed) return null;
  const unit = rawUnit.toLowerCase();
  if (unit === 'g' || unit === 'gm' || unit === 'gram' || unit === 'grams') {
    return { num: parsed.num * 1000n, den: parsed.den, unit: 'mg' };
  }
  if (unit === 'mg') {
    return { num: parsed.num, den: parsed.den, unit: 'mg' };
  }
  if (unit === 'mcg' || unit === 'ug' || unit === 'µg') {
    return { num: parsed.num, den: parsed.den * 1000n, unit: 'mg' };
  }
  if (unit === 'iu' || unit === 'u' || unit === 'units') {
    return { num: parsed.num, den: parsed.den, unit: 'iu' };
  }
  if (unit === 'meq') {
    return { num: parsed.num, den: parsed.den, unit: 'meq' };
  }
  if (unit === 'mmol') {
    return { num: parsed.num, den: parsed.den, unit: 'mmol' };
  }
  return null;
}

function convertVolumeToMlRatio(valStr: string, rawUnit: string): { num: bigint; den: bigint; unit: string } | null {
  const parsed = decimalToScaledBigInt(valStr);
  if (!parsed) return null;
  const unit = rawUnit.toLowerCase();
  if (unit === 'l' || unit === 'liter' || unit === 'litre') {
    return { num: parsed.num * 1000n, den: parsed.den, unit: 'ml' };
  }
  if (unit === 'ml') {
    return { num: parsed.num, den: parsed.den, unit: 'ml' };
  }
  if (unit === 'g' || unit === 'gm') {
    return { num: parsed.num, den: parsed.den, unit: 'g' };
  }
  return null;
}

export function canonicalizeMedicineDosageForm(raw: string | null | undefined): CanonicalMedicineDosageForm | null {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.toLowerCase().trim();
  if (!t) return null;

  // Check exact UniversalUnitPolicy enum values first
  if (t === 'tablet') return 'Tablet';
  if (t === 'capsule') return 'Capsule';
  if (t === 'syrup') return 'Syrup';
  if (t === 'suspension') return 'Suspension';
  if (t === 'injectionvial') return 'InjectionVial';
  if (t === 'ampoule') return 'Ampoule';
  if (t === 'cream') return 'Cream';
  if (t === 'ointment') return 'Ointment';
  if (t === 'gel') return 'Gel';
  if (t === 'drops') return 'Drops';
  if (t === 'inhaler') return 'Inhaler';
  if (t === 'suppository') return 'Suppository';
  if (t === 'sachet') return 'Sachet';

  // Pattern matching across English & Arabic aliases
  if (/\b(susp|suspension|dry\s*susp)\b|معلق/.test(t)) return 'Suspension';
  if (/\b(syr|syrup|elixir|oral\s*solution|solution)\b|شراب|محلول/.test(t)) return 'Syrup';
  if (/\b(amp|ampoule|ampoules)\b|أمبول|امبول/.test(t)) return 'Ampoule';
  if (/\b(vial|inj|injection|injectable|infusion|iv|im)\b|حقن|حقنة|فيال/.test(t)) return 'InjectionVial';
  if (/\b(cap|caps|capsule|capsules|softgel|hardgel)\b|كبسول|كبسولة|كبسولات/.test(t)) return 'Capsule';
  if (/\b(tab|tabs|tablet|tablets|caplet|caplets|pill|pills|lozenge|lozenges)\b|أقراص|اقراص|قرص|حبوب|حبة/.test(t)) return 'Tablet';
  if (/\b(drop|drops|eye\s*drops|ear\s*drops|nasal\s*drops|ophthalmic)\b|قطرة|نقط/.test(t)) return 'Drops';
  if (/\b(cream|lotion)\b|كريم/.test(t)) return 'Cream';
  if (/\b(oint|ointment)\b|مرهم/.test(t)) return 'Ointment';
  if (/\b(gel)\b|جل/.test(t)) return 'Gel';
  if (/\b(inhaler|spray|nebule|aerosol|mdi|dpi|puffer)\b|بخاخ|استنشاق/.test(t)) return 'Inhaler';
  if (/\b(supp|suppository|suppositories|pessary)\b|تحاميل|لبوس/.test(t)) return 'Suppository';
  if (/\b(sachet|sachets|powder|granules)\b|أكياس|اكياس|كيس|بودرة/.test(t)) return 'Sachet';

  return null;
}

function normalizeReleaseTypeTokens(text: string): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();

  if (/\b(extended[\s-]*release|xr|xl)\b|ممتد\s*المفعول/.test(lower)) found.add('XR');
  if (/\b(sustained[\s-]*release|sr)\b|مستمر\s*المفعول/.test(lower)) found.add('SR');
  if (/\b(er)\b/.test(lower)) found.add('ER');
  if (/\b(controlled[\s-]*release|cr)\b/.test(lower)) found.add('CR');
  if (/\b(modified[\s-]*release|mr)\b|معدل\s*الإطلاق/.test(lower)) found.add('MR');
  if (/\b(delayed[\s-]*release|dr)\b/.test(lower)) found.add('DR');
  if (/\b(prolonged[\s-]*release|pr)\b/.test(lower)) found.add('PR');
  if (/\b(long[\s-]*acting|la)\b|طويل\s*المفعول/.test(lower)) found.add('LA');
  if (/\b(retard)\b/.test(lower)) found.add('RETARD');
  if (/\b(enteric[\s-]*coated|ec)\b|مغلف\s*معوياً/.test(lower)) found.add('EC');
  if (/\b(odt|orally\s*disintegrating|melt)\b/.test(lower)) found.add('ODT');
  if (/\b(dispersible)\b/.test(lower)) found.add('DISPERSIBLE');
  if (/\b(chewable)\b|للمضغ/.test(lower)) found.add('CHEWABLE');
  if (/\b(effervescent)\b|فوار/.test(lower)) found.add('EFFERVESCENT');

  return Array.from(found).sort();
}

function normalizeVariantTokens(text: string): string[] {
  const found = new Set<string>();
  const lower = text.toLowerCase();
  if (/\b(forte)\b/.test(lower)) found.add('FORTE');
  if (/\b(plus)\b/.test(lower)) found.add('PLUS');
  if (/\b(duo)\b/.test(lower)) found.add('DUO');
  if (/\b(extra)\b/.test(lower)) found.add('EXTRA');
  if (/\b(junior|jnr)\b/.test(lower)) found.add('JUNIOR');
  if (/\b(pediatric|paediatric|ped)\b|أطفال|اطفال/.test(lower)) found.add('PEDIATRIC');
  if (/\b(infant|infants)\b|رضع/.test(lower)) found.add('INFANT');
  if (/\b(ds)\b/.test(lower)) found.add('DS');
  return Array.from(found).sort();
}

function extractStrengthsAndConcentrations(rawText: string): {
  strengths: string[];
  concentrations: string[];
} {
  const strengths = new Set<string>();
  const concentrations = new Set<string>();
  if (!rawText) return { strengths: [], concentrations: [] };

  let remaining = rawText.toLowerCase();

  // 1. Ratio concentrations first: e.g., "250mg/5ml", "125 mg / 5 ml", "400mg/5ml", "100mg/ml"
  const ratioRegex = /(\d+(?:\.\d+)?)\s*(mg|g|gm|mcg|ug|µg|iu)\s*\/\s*(\d*(?:\.\d+)?)?\s*(ml|l|g|gm)\b/gi;
  remaining = remaining.replace(ratioRegex, (_full, numVal: string, numUnit: string, denVal: string, denUnit: string) => {
    const mass = convertMassToMgRatio(numVal, numUnit);
    const vol = convertVolumeToMlRatio(denVal || '1', denUnit);
    if (mass && vol && vol.num > 0n) {
      const ratioNum = mass.num * vol.den;
      const ratioDen = mass.den * vol.num;
      concentrations.add(formatRatioKey(ratioNum, ratioDen, `${mass.unit}/${vol.unit}`));
    }
    return ' ';
  });

  // 2. Percentage concentrations: e.g., "0.5%", "2% w/v", "1%"
  const percentRegex = /(\d+(?:\.\d+)?)\s*%/g;
  remaining = remaining.replace(percentRegex, (_full, pctVal: string) => {
    const parsed = decimalToScaledBigInt(pctVal);
    if (parsed) {
      concentrations.add(formatRatioKey(parsed.num, parsed.den, '%'));
    }
    return ' ';
  });

  // 3. Compound solid strengths: e.g., "500/125mg", "875mg/125mg", "500+125mg", "20/12.5mg"
  const compoundRegex = /(\d+(?:\.\d+)?)\s*(mg|g|gm|mcg|ug|µg|iu)?\s*[\/+]\s*(\d+(?:\.\d+)?)\s*(mg|g|gm|mcg|ug|µg|iu)\b/gi;
  remaining = remaining.replace(compoundRegex, (_full, v1: string, u1: string | undefined, v2: string, u2: string) => {
    const m1 = convertMassToMgRatio(v1, u1 || u2);
    const m2 = convertMassToMgRatio(v2, u2);
    if (m1 && m2) {
      strengths.add(`${formatRatioKey(m1.num, m1.den, m1.unit)}+${formatRatioKey(m2.num, m2.den, m2.unit)}`);
    }
    return ' ';
  });

  // 4. Single strengths: e.g., "1g", "1000mg", "625mg", "500 mg", "50mcg", "500iu"
  const singleRegex = /(\d+(?:\.\d+)?)\s*(mg|g|gm|gram|grams|mcg|ug|µg|iu|meq|mmol)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = singleRegex.exec(remaining)) !== null) {
    const m = convertMassToMgRatio(match[1], match[2]);
    if (m) {
      strengths.add(formatRatioKey(m.num, m.den, m.unit));
    }
  }

  return {
    strengths: Array.from(strengths).sort(),
    concentrations: Array.from(concentrations).sort()
  };
}

function extractPackageSizeInfo(rawText: string): { volumeOrWeight: string | null; count: number | null } {
  if (!rawText) return { volumeOrWeight: null, count: null };
  const lower = rawText.toLowerCase();

  // Standalone volume (not preceded by '/') e.g. "100ml", "60 ml", "15g tube"
  const volMatch = lower.match(/(?:^|[\s(x*])(\d+(?:\.\d+)?)\s*(ml|l)\b/);
  let volumeOrWeight: string | null = null;
  if (volMatch) {
    const vol = convertVolumeToMlRatio(volMatch[1], volMatch[2]);
    if (vol) {
      volumeOrWeight = formatRatioKey(vol.num, vol.den, vol.unit);
    }
  }

  // Count e.g. "30 tabs", "20 caps", "14s", "x30", "30 tablets"
  let count: number | null = null;
  const countMatch =
    lower.match(/\b(\d{1,4})\s*(?:tab|tabs|tablet|tablets|cap|caps|capsule|capsules|pill|pills|sachet|sachets|amp|ampoule|ampoules|vial|vials|supp|suppositories)\b/) ||
    lower.match(/\b(\d{1,4})s\b/) ||
    lower.match(/\bx\s*(\d{1,4})\b/);
  if (countMatch) {
    const n = Number(countMatch[1]);
    if (Number.isSafeInteger(n) && n > 0) {
      count = n;
    }
  }

  return { volumeOrWeight, count };
}

export function extractMedicineIdentityProfile(input: {
  readonly name?: string | null;
  readonly strength?: string | null;
  readonly dosageForm?: string | null;
  readonly releaseType?: string | null;
  readonly concentration?: string | null;
  readonly packageSize?: string | null;
  readonly category?: string | null;
  readonly unitDefinitionDosageForm?: string | null;
  readonly baseUnitsPerPack?: number | null;
}): MedicineIdentityProfile {
  const combinedNameAndIdentity = [
    input.name || '',
    input.strength || '',
    input.concentration || '',
    input.releaseType || ''
  ]
    .filter(Boolean)
    .join(' ');

  const dosageForm =
    canonicalizeMedicineDosageForm(input.dosageForm) ??
    canonicalizeMedicineDosageForm(input.unitDefinitionDosageForm) ??
    canonicalizeMedicineDosageForm(input.name) ??
    canonicalizeMedicineDosageForm(input.category);

  const { strengths, concentrations } = extractStrengthsAndConcentrations(combinedNameAndIdentity);
  const releaseTypes = normalizeReleaseTypeTokens(
    [input.releaseType || '', input.name || '', input.dosageForm || ''].filter(Boolean).join(' ')
  );
  const variants = normalizeVariantTokens(input.name || '');

  const pkgFromExplicit = extractPackageSizeInfo(input.packageSize || '');
  const pkgFromName = extractPackageSizeInfo(input.name || '');
  const packageVolumeOrWeight = pkgFromExplicit.volumeOrWeight ?? pkgFromName.volumeOrWeight;
  const packageCount =
    pkgFromExplicit.count ??
    pkgFromName.count ??
    (typeof input.baseUnitsPerPack === 'number' &&
    Number.isSafeInteger(input.baseUnitsPerPack) &&
    input.baseUnitsPerPack > 1 &&
    (dosageForm === 'Tablet' || dosageForm === 'Capsule' || dosageForm === 'Sachet' || dosageForm === 'Suppository')
      ? input.baseUnitsPerPack
      : null);

  return Object.freeze({
    dosageForm,
    strengths: Object.freeze(strengths),
    concentrations: Object.freeze(concentrations),
    releaseTypes: Object.freeze(releaseTypes),
    variants: Object.freeze(variants),
    packageVolumeOrWeight,
    packageCount
  });
}

export type MedicineIdentityCompatibilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * R13-D.3: Strict medicine identity gate.
 * Rejects mismatches in strength (e.g., 1g vs 625mg), concentration (250mg/5ml vs 125mg/5ml),
 * dosage form (Syrup vs Tablet), release type (XR vs immediate-release or SR), formulation
 * variant (Forte/Plus/Duo), and package size (when both sides declare it).
 */
export function validateOcrItemMedicineIdentity(
  ocrItem: {
    readonly tradeName?: string | null;
    readonly strength?: string | null;
    readonly dosageForm?: string | null;
    readonly releaseType?: string | null;
    readonly concentration?: string | null;
    readonly packageSize?: string | null;
  },
  catalogMedicine: {
    readonly id?: string;
    readonly name: string;
    readonly category?: string;
    readonly dosageForm?: string;
    readonly unitDefinition?: { readonly dosageForm?: string } | null;
    readonly baseUnitsPerPack?: number;
  },
  options?: { readonly requireExplicitOcrIdentity?: boolean }
): MedicineIdentityCompatibilityResult {
  const requireExplicit = options?.requireExplicitOcrIdentity ?? true;

  if (requireExplicit) {
    if (!ocrItem.strength || !ocrItem.strength.trim()) {
      return {
        ok: false,
        code: 'OCR_MISSING_MEDICINE_IDENTITY',
        message: `التركيز (Strength) مفقود للصنف "${ocrItem.tradeName || catalogMedicine.name}"؛ يجب التحقق منه وإدخاله صراحةً قبل الاعتماد.`
      };
    }
    if (!ocrItem.dosageForm || !ocrItem.dosageForm.trim()) {
      return {
        ok: false,
        code: 'OCR_MISSING_MEDICINE_IDENTITY',
        message: `الشكل الصيدلاني (Dosage Form) مفقود للصنف "${ocrItem.tradeName || catalogMedicine.name}"؛ يجب التحقق منه وإدخاله صراحةً قبل الاعتماد.`
      };
    }
  }

  const ocrProfile = extractMedicineIdentityProfile({
    name: ocrItem.tradeName,
    strength: ocrItem.strength,
    dosageForm: ocrItem.dosageForm,
    releaseType: ocrItem.releaseType,
    concentration: ocrItem.concentration,
    packageSize: ocrItem.packageSize
  });

  const catalogProfile = extractMedicineIdentityProfile({
    name: catalogMedicine.name,
    dosageForm: catalogMedicine.dosageForm,
    unitDefinitionDosageForm: catalogMedicine.unitDefinition?.dosageForm,
    category: catalogMedicine.category,
    baseUnitsPerPack: catalogMedicine.baseUnitsPerPack
  });

  // 1. Dosage Form strict check (e.g., Syrup vs Tablet, Capsule vs Tablet, Injection vs Syrup)
  if (requireExplicit && !ocrProfile.dosageForm) {
    return {
      ok: false,
      code: 'OCR_MEDICINE_DOSAGE_FORM_MISMATCH',
      message: `الشكل الصيدلاني "${ocrItem.dosageForm}" غير معروف أو غير معتمد للصنف "${ocrItem.tradeName || catalogMedicine.name}".`
    };
  }
  if (ocrProfile.dosageForm && catalogProfile.dosageForm) {
    const compatibleLiquidForms =
      ocrProfile.dosageForm === catalogProfile.dosageForm;
    if (!compatibleLiquidForms) {
      return {
        ok: false,
        code: 'OCR_MEDICINE_DOSAGE_FORM_MISMATCH',
        message: `تعارض الشكل الصيدلاني: بند الفاتورة "${ocrProfile.dosageForm}" لا يطابق الصنف المسجل "${catalogMedicine.name}" (${catalogProfile.dosageForm}).`
      };
    }
  }

  // 2. Release Type strict check (e.g., XR vs non-XR, SR vs immediate-release, CR vs XR)
  const ocrRelKey = ocrProfile.releaseTypes.join('|');
  const catRelKey = catalogProfile.releaseTypes.join('|');
  if (ocrRelKey !== catRelKey) {
    return {
      ok: false,
      code: 'OCR_MEDICINE_RELEASE_TYPE_MISMATCH',
      message: `تعارض نمط الإطلاق الدوائي (Release Type): بند الفاتورة (${ocrRelKey || 'Immediate/Standard'}) لا يطابق الصنف المسجل "${catalogMedicine.name}" (${catRelKey || 'Immediate/Standard'}).`
    };
  }

  // 3. Variant modifier check (e.g., Forte / Plus / Duo / Pediatric vs standard)
  const ocrVarKey = ocrProfile.variants.join('|');
  const catVarKey = catalogProfile.variants.join('|');
  if (ocrVarKey !== catVarKey) {
    return {
      ok: false,
      code: 'OCR_MEDICINE_VARIANT_MISMATCH',
      message: `تعارض صيغة الدواء (Variant): بند الفاتورة (${ocrVarKey || 'Standard'}) لا يطابق الصنف المسجل "${catalogMedicine.name}" (${catVarKey || 'Standard'}).`
    };
  }

  // 4. Concentration strict check (e.g., 250mg/5ml vs 125mg/5ml, 0.5% vs 1%)
  if (ocrProfile.concentrations.length > 0 && catalogProfile.concentrations.length > 0) {
    if (ocrProfile.concentrations.join('|') !== catalogProfile.concentrations.join('|')) {
      return {
        ok: false,
        code: 'OCR_MEDICINE_CONCENTRATION_MISMATCH',
        message: `تعارض التركيز السائل/الموضعي: بند الفاتورة (${ocrProfile.concentrations.join(', ')}) لا يطابق الصنف المسجل "${catalogMedicine.name}" (${catalogProfile.concentrations.join(', ')}).`
      };
    }
  } else if (
    (ocrProfile.concentrations.length > 0 && catalogProfile.strengths.length > 0) ||
    (catalogProfile.concentrations.length > 0 && ocrProfile.strengths.length > 0)
  ) {
    return {
      ok: false,
      code: 'OCR_MEDICINE_CONCENTRATION_MISMATCH',
      message: `تعارض بين تركيز نسبي (مثل mg/5ml) وتركيز صلب بين بند الفاتورة والصنف المسجل "${catalogMedicine.name}".`
    };
  }

  // 5. Solid/Mass Strength strict check (e.g., Augmentin 1g [1000mg] vs 625mg)
  if (ocrProfile.strengths.length > 0 && catalogProfile.strengths.length > 0) {
    const ocrKey = ocrProfile.strengths.join('|');
    const catKey = catalogProfile.strengths.join('|');
    if (ocrKey !== catKey) {
      return {
        ok: false,
        code: 'OCR_MEDICINE_STRENGTH_MISMATCH',
        message: `تعارض تركيز الدواء (Strength): بند الفاتورة (${ocrProfile.strengths.join(', ')}) لا يطابق الصنف المسجل "${catalogMedicine.name}" (${catalogProfile.strengths.join(', ')}).`
      };
    }
  }

  // 6. Explicit package size check when both sides declare volume/weight or explicit count
  if (
    ocrProfile.packageVolumeOrWeight &&
    catalogProfile.packageVolumeOrWeight &&
    ocrProfile.packageVolumeOrWeight !== catalogProfile.packageVolumeOrWeight
  ) {
    return {
      ok: false,
      code: 'OCR_MEDICINE_PACKAGE_SIZE_MISMATCH',
      message: `تعارض حجم العبوة: بند الفاتورة (${ocrProfile.packageVolumeOrWeight}) لا يطابق الصنف المسجل "${catalogMedicine.name}" (${catalogProfile.packageVolumeOrWeight}).`
    };
  }
  if (
    ocrItem.packageSize &&
    ocrItem.packageSize.trim() &&
    ocrProfile.packageCount !== null &&
    catalogProfile.packageCount !== null &&
    ocrProfile.packageCount !== catalogProfile.packageCount
  ) {
    return {
      ok: false,
      code: 'OCR_MEDICINE_PACKAGE_SIZE_MISMATCH',
      message: `تعارض عدد وحدات العبوة: بند الفاتورة (${ocrProfile.packageCount}) لا يطابق الصنف المسجل "${catalogMedicine.name}" (${catalogProfile.packageCount}).`
    };
  }

  return { ok: true };
}

export function buildOcrPurchaseCanonicalPayload(
  draft: SupplierInvoiceDraft,
  paymentIntent: OcrPurchasePaymentIntent,
  postingActor: string,
  approvedBranchId?: string | null
): OcrPurchaseCanonicalPayload {
  if (!draft || typeof draft !== 'object') {
    throw new OcrPurchaseCanonicalError('INVALID_DRAFT', 'OCR draft is required.');
  }
  if (approvedBranchId !== undefined) {
    if (typeof approvedBranchId !== 'string' || approvedBranchId.trim().length === 0) {
      throw new OcrPurchaseCanonicalError(
        'OCR_APPROVAL_BRANCH_MISMATCH',
        'approvedBranchId must be a non-empty string when branch binding is enforced.'
      );
    }
  }
  const resolvedApprovedBranchId =
    typeof approvedBranchId === 'string' && approvedBranchId.trim().length > 0
      ? approvedBranchId.trim()
      : typeof draft.approval?.approvedBranchId === 'string' && draft.approval.approvedBranchId.trim().length > 0
        ? draft.approval.approvedBranchId.trim()
        : null;
  if (draft.status === 'POSTED' || draft.postedInvoiceId) {
    throw new OcrPurchaseCanonicalError('DRAFT_ALREADY_POSTED', 'A posted OCR draft cannot create a new purchase intent.');
  }
  if (!Array.isArray(draft.items) || draft.items.length === 0) {
    throw new OcrPurchaseCanonicalError('EMPTY_INVOICE', 'At least one invoice item is required.');
  }
  const rawLegacyAudit = draft.audit as unknown as (Record<string, unknown> | undefined);
  if (
    rawLegacyAudit &&
    typeof rawLegacyAudit.overrideReason === 'string' &&
    rawLegacyAudit.overrideReason.trim().length > 0
  ) {
    throw new OcrPurchaseCanonicalError(
      'OCR_RECONCILIATION_OVERRIDE_FORBIDDEN',
      'Financial reconciliation overrides are strictly forbidden in R13-D.'
    );
  }
  const supplierId = requiredText(draft.header?.matchedSupplierId, 'supplierId');
  const invoiceCurrency = requiredText(fieldValue(draft.header?.currency, 'SDG'), 'invoice.currency');
  const paymentCurrency = requiredText(paymentIntent?.currency, 'paymentIntent.currency');
  if (invoiceCurrency !== paymentCurrency) {
    throw new OcrPurchaseCanonicalError('CURRENCY_MISMATCH', 'Payment and invoice currencies must match.');
  }
  if (!['Cash', 'Credit', 'Partial'].includes(paymentIntent.paymentType)) {
    throw new OcrPurchaseCanonicalError('INVALID_PAYMENT_TYPE', 'Unsupported payment intent.');
  }

  const rawSubtotal = extractRawFieldValue(draft.header?.subtotal);
  if (rawSubtotal === undefined || rawSubtotal === null || rawSubtotal === '') {
    throw new OcrPurchaseCanonicalError('OCR_MISSING_OR_ZERO_SUBTOTAL', 'invoice.subtotal is required.');
  }
  const canonicalSubtotal = canonicalDecimal(rawSubtotal, 'invoice.subtotal');
  if (canonicalSubtotal.startsWith('-') || canonicalSubtotal === '0') {
    throw new OcrPurchaseCanonicalError('OCR_MISSING_OR_ZERO_SUBTOTAL', 'invoice.subtotal must be greater than zero.');
  }

  const rawDiscount = extractRawFieldValue(draft.header?.discount);
  const canonicalDiscount =
    rawDiscount === undefined || rawDiscount === null || rawDiscount === ''
      ? '0'
      : canonicalDecimal(rawDiscount, 'invoice.discount');
  if (canonicalDiscount.startsWith('-')) {
    throw new OcrPurchaseCanonicalError('INVALID_DISCOUNT', 'invoice.discount cannot be negative.');
  }

  const rawFinalTotal = extractRawFieldValue(draft.header?.finalTotal);
  if (rawFinalTotal === undefined || rawFinalTotal === null || rawFinalTotal === '') {
    throw new OcrPurchaseCanonicalError('OCR_MISSING_OR_ZERO_FINAL_TOTAL', 'invoice.finalTotal is required.');
  }
  const canonicalFinalTotal = canonicalDecimal(rawFinalTotal, 'invoice.finalTotal');
  if (canonicalFinalTotal.startsWith('-') || canonicalFinalTotal === '0') {
    throw new OcrPurchaseCanonicalError('OCR_MISSING_OR_ZERO_FINAL_TOTAL', 'invoice.finalTotal must be greater than zero.');
  }

  const payload: OcrPurchaseCanonicalPayload = {
    canonicalVersion: OCR_PURCHASE_CANONICAL_VERSION,
    source: 'OCR',
    ocrDraftId: requiredText(draft.id, 'ocrDraftId'),
    supplier: {
      id: supplierId,
      extractedName: String(fieldValue(draft.header?.supplierName, '')).trim()
    },
    invoice: {
      number: requiredText(fieldValue(draft.header?.invoiceNumber, ''), 'invoice.number'),
      date: requiredText(fieldValue(draft.header?.invoiceDate, ''), 'invoice.date'),
      currency: invoiceCurrency,
      subtotal: canonicalSubtotal,
      discount: canonicalDiscount,
      // R13-D.2: Tax is strictly excluded from all calculations; canonical tax is always '0' without rejecting legacy/OCR raw tax values.
      tax: '0',
      finalTotal: canonicalFinalTotal,
      reconciliation: {
        isReconciled: Boolean(draft.audit?.isReconciled),
        difference: canonicalDecimal(draft.audit?.difference ?? 0, 'invoice.reconciliation.difference'),
        overrideReason: null,
        overrideBy: null,
        overrideAt: null
      }
    },
    items: draft.items.map((item, index) => {
      if (!item.matchedMedicineId) {
        throw new OcrPurchaseCanonicalError('UNMATCHED_MEDICINE', 'Every line must resolve to a registered medicine.');
      }
      if (item.isUserConfirmed !== true) {
        throw new OcrPurchaseCanonicalError(
          'OCR_MEDICINE_MATCH_UNCONFIRMED',
          'items[' + index + '] medicine match must be explicitly confirmed by a human operator (isUserConfirmed === true).'
        );
      }
      const anyItem = item as typeof item & Record<string, unknown>;
      const rawQty = extractRawFieldValue(item.quantity);
      const quantity = canonicalDecimal(rawQty, 'items[' + index + '].quantity');
      if (quantity.startsWith('-') || quantity === '0') {
        throw new OcrPurchaseCanonicalError('INVALID_QUANTITY', 'Every line quantity must be greater than zero.');
      }
      const unitValue = requiredText(extractRawFieldValue(item.unit), 'items[' + index + '].unit', 'UNSUPPORTED_ITEM_UNIT');
      if (unitValue !== 'pack' && unitValue !== 'strip' && unitValue !== 'pill') {
        throw new OcrPurchaseCanonicalError('UNSUPPORTED_ITEM_UNIT', 'items[' + index + '].unit must be pack, strip, or pill.');
      }
      const rawBuyPrice = extractRawFieldValue(item.unitBuyPrice);
      const unitBuyPrice = canonicalDecimal(rawBuyPrice, 'items[' + index + '].unitBuyPrice');
      if (unitBuyPrice.startsWith('-') || unitBuyPrice === '0') {
        throw new OcrPurchaseCanonicalError('INVALID_BUY_PRICE', 'Buy price must be greater than zero.');
      }
      const rawItemDiscount = extractRawFieldValue(
        anyItem.itemDiscount ?? anyItem.lineDiscount ?? anyItem.discount
      );
      const itemDiscount =
        rawItemDiscount === undefined || rawItemDiscount === null || rawItemDiscount === ''
          ? '0'
          : canonicalDecimal(rawItemDiscount, 'items[' + index + '].itemDiscount');
      if (itemDiscount.startsWith('-')) {
        throw new OcrPurchaseCanonicalError('INVALID_ITEM_DISCOUNT', 'Item discount cannot be negative.');
      }
      const rawLineTotal = extractRawFieldValue(item.lineTotal);
      const lineTotal = canonicalDecimal(rawLineTotal, 'items[' + index + '].lineTotal');
      if (lineTotal.startsWith('-') || lineTotal === '0') {
        throw new OcrPurchaseCanonicalError('INVALID_LINE_TOTAL', 'Line total must be greater than zero.');
      }
      const strength = requiredText(
        extractRawFieldValue(item.strength),
        'items[' + index + '].strength',
        'OCR_MISSING_MEDICINE_IDENTITY'
      );
      const dosageForm = requiredText(
        extractRawFieldValue(item.dosageForm),
        'items[' + index + '].dosageForm',
        'OCR_MISSING_MEDICINE_IDENTITY'
      );
      const rawReleaseType = extractRawFieldValue(item.releaseType);
      const rawConcentration = extractRawFieldValue(item.concentration);
      const rawPackageSize = extractRawFieldValue(item.packageSize);
      const optionalPrice = extractRawFieldValue(item.suggestedSellPrice);
      return {
        lineIndex: index,
        sourceItemId: requiredText(item.id, 'items[' + index + '].id'),
        medicineId: requiredText(item.matchedMedicineId, 'items[' + index + '].medicineId'),
        medicineName: String(item.matchedMedicineName || extractRawFieldValue(item.tradeName) || '').trim(),
        tradeName: requiredText(extractRawFieldValue(item.tradeName), 'items[' + index + '].tradeName'),
        genericName: typeof extractRawFieldValue(item.genericName) === 'string' && String(extractRawFieldValue(item.genericName)).trim()
          ? String(extractRawFieldValue(item.genericName)).trim()
          : null,
        strength,
        dosageForm,
        releaseType: typeof rawReleaseType === 'string' && rawReleaseType.trim() ? rawReleaseType.trim() : null,
        concentration: typeof rawConcentration === 'string' && rawConcentration.trim() ? rawConcentration.trim() : null,
        packageSize: typeof rawPackageSize === 'string' && rawPackageSize.trim() ? rawPackageSize.trim() : null,
        barcode: typeof extractRawFieldValue(item.barcode) === 'string' && String(extractRawFieldValue(item.barcode)).trim()
          ? String(extractRawFieldValue(item.barcode)).trim()
          : null,
        batchNumber: requiredText(extractRawFieldValue(item.batchNumber), 'items[' + index + '].batchNumber'),
        expiryDate: requiredText(extractRawFieldValue(item.expiryDate), 'items[' + index + '].expiryDate'),
        quantity,
        unit: unitValue,
        unitBuyPrice,
        itemDiscount,
        lineTotal,
        suggestedSellPrice: optionalPrice === undefined || optionalPrice === null || optionalPrice === ''
          ? null
          : canonicalDecimal(optionalPrice, 'items[' + index + '].suggestedSellPrice'),
        isUserConfirmed: true
      };
    }),
    paymentIntent: {
      paymentType: paymentIntent.paymentType,
      paidAmount: canonicalDecimal(paymentIntent.paidAmount, 'paymentIntent.paidAmount'),
      currency: paymentCurrency
    },
    postingActor: requiredText(postingActor, 'postingActor'),
    approvedBranchId: resolvedApprovedBranchId
  };
  if (payload.paymentIntent.paidAmount.startsWith('-')) {
    throw new OcrPurchaseCanonicalError('INVALID_PAID_AMOUNT', 'Paid amount cannot be negative.');
  }
  return deepFreeze(payload);
}

/** Stable synchronous SHA-256 for use inside an active IndexedDB transaction. */
export function sha256OcrPurchaseCanonicalJson(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const k = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
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
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h).map(word => word.toString(16).padStart(8, '0')).join('');
}

export function serializeOcrPurchaseCanonicalPayload(payload: unknown): string {
  return stableSerialize(payload);
}

export function createOcrPurchaseCanonicalSnapshotFromPayload<T extends OcrPurchaseCanonicalPayload>(
  payload: T
): OcrPurchaseCanonicalSnapshot & { readonly payload: T } {
  const frozenPayload = deepFreeze(payload);
  const canonicalJson = stableSerialize(frozenPayload);
  const sha256 = sha256OcrPurchaseCanonicalJson(canonicalJson);
  return Object.freeze({ payload: frozenPayload, canonicalJson, sha256 });
}

export async function createOcrPurchaseCanonicalSnapshot(
  draft: SupplierInvoiceDraft,
  paymentIntent: OcrPurchasePaymentIntent,
  postingActor: string,
  approvedBranchId?: string | null
): Promise<OcrPurchaseCanonicalSnapshot> {
  const payload = buildOcrPurchaseCanonicalPayload(draft, paymentIntent, postingActor, approvedBranchId);
  return createOcrPurchaseCanonicalSnapshotFromPayload(payload);
}
