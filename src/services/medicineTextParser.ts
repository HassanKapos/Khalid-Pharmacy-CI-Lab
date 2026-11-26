/**
 * Phase 3 — Offline medicine text parsing and conservative catalogue matching.
 *
 * This module is intentionally pure: it does not access IndexedDB, POS/cart,
 * inventory ledger, pricing, suppliers, or sales. It can only return candidates.
 */

export type MedicineDosageForm =
  | 'tablet' | 'capsule' | 'syrup' | 'suspension' | 'injection'
  | 'cream' | 'ointment' | 'drops' | 'inhaler' | 'suppository'
  | 'sachet' | 'unknown';

export type UiConfidenceTier = 'VERIFIED' | 'PROBABLE' | 'UNRECOGNIZED';

export interface MedicineTextProfile {
  rawText: string;
  normalizedText: string;
  strengths: string[];
  dosageForms: MedicineDosageForm[];
  releaseTypes: string[];
  packageSizes: string[];
  manufacturers: string[];
  nameTokens: string[];
}

export interface MedicineCatalogueEntry {
  id: string;
  name: string;
  barcode?: string;
  secondaryBarcodes?: string[];
}

export type MedicineMatchStatus = 'verified' | 'candidate' | 'rejected';

export interface MedicineMatch {
  medicine: MedicineCatalogueEntry;
  status: MedicineMatchStatus;
  confidence: number;
  reasons: string[];
  conflicts: string[];
  safeToAutoSelect: boolean;
}

const FORM_PATTERNS: Array<[MedicineDosageForm, RegExp]> = [
  ['tablet', /\b(tablet|tablets|tab|tabs)\b/i],
  ['capsule', /\b(capsule|capsules|cap|caps)\b/i],
  ['syrup', /\b(syrup|oral solution)\b/i],
  ['suspension', /\b(suspension|susp)\b/i],
  ['injection', /\b(injection|injectable|ampoule|amp|vial)\b/i],
  ['cream', /\b(cream)\b/i],
  ['ointment', /\b(ointment|oint)\b/i],
  ['drops', /\b(drops|drop|ophthalmic|otic)\b/i],
  ['inhaler', /\b(inhaler|inhalation)\b/i],
  ['suppository', /\b(suppository|suppositories)\b/i],
  ['sachet', /\b(sachet|sachets|powder)\b/i]
];

const RELEASE_PATTERNS = [
  ['XR', /\b(XR|ER|XL)\b/i],
  ['SR', /\b(SR|CR)\b/i],
  ['MR', /\b(MR|M\/R)\b/i],
  ['DR', /\b(DR|delayed release)\b/i],
  ['EC', /\b(EC|enteric coated)\b/i],
  ['RETARD', /\b(retard)\b/i]
] as const;

const KNOWN_MANUFACTURERS: string[] = [
  'sanofi', 'gsk', 'glaxosmithkline', 'pfizer', 'novartis', 'astrazeneca',
  'roche', 'bayer', 'servier', 'merck', 'msd', 'boehringer', 'sandoz', 'teva',
  'abbott', 'lilly', 'takeda', 'menarini', 'ferring', 'mundipharma', 'rekordati',
  'hikma', 'tabuk', 'spimaco', 'julphar', 'jamjoom', 'mspharma', 'dar al dawa',
  'sedico', 'amoun', 'eipico', 'pharco', 'evapharma', 'sigmatec', 'global napi',
  'rameda', 'marcyrl', 'mup', 'multipharma', 'cipla', 'sun pharma', 'dr reddy',
  'krka', 'zentiva', 'stada', 'actavis', 'mylan', 'viatris', 'aspen', 'organon',
  'bilim', 'abdi ibrahim', 'deva', 'drogsan', 'amipharma', 'azarga', 'pharmalife'
];

function normalizeStrength(value: string): string {
  const compact = value.toLowerCase().replace(/,/g, '.').replace(/\s+/g, '');
  return compact
    .replace(/μg|µg|mcg/g, 'mcg')
    .replace(/grams?|gm/g, 'g')
    .replace(/milligrams?/g, 'mg')
    .replace(/millilit(er|re)s?/g, 'ml')
    .replace(/percent|per\s*cent/g, '%');
}

function extractStrengths(text: string): string[] {
  const normalized = text
    .replace(/(\d)\s*\/\s*(\d)/g, '$1/$2')
    .replace(/\b(\d{1,3}(?:,\d{3})+)\b/g, (group) => group.replace(/,/g, ''))
    .replace(/(\d)\s*,\s*(\d)/g, '$1.$2');
  const found = new Set<string>();

  // Handle combined dual strengths sharing a trailing unit (e.g. "875/125 mg", "500/125mg")
  const comboPattern = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(mcg|μg|µg|mg|g|ml|mL|%|iu)(?![a-z])/gi;
  let comboMatch: RegExpExecArray | null;
  while ((comboMatch = comboPattern.exec(normalized)) !== null) {
    found.add(normalizeStrength(`${comboMatch[1]}${comboMatch[3]}`));
    found.add(normalizeStrength(`${comboMatch[2]}${comboMatch[3]}`));
  }

  const pattern = /(\d+(?:\.\d+)?)\s*(mcg|μg|µg|mg|g|ml|mL|%|iu|unit(?:s)?)(?![a-z])/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    found.add(normalizeStrength(`${match[1]}${match[2]}`));
  }
  return [...found].sort();
}

function extractPackageSizes(text: string): string[] {
  const sizes = new Set<string>();
  const countUnitPattern = /\b(\d{1,4})\s*(tablet|tablets|tab|tabs|capsule|capsules|cap|caps|strip|strips|blister|blisters|sachet|sachets|ampoule|ampoules|vial|vials|ml|mL)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = countUnitPattern.exec(text)) !== null) {
    sizes.add(`${match[1]} ${match[2].toLowerCase()}`);
  }
  const matrixPattern = /\b(\d{1,2}\s*[x×]\s*\d{1,3})\b/gi;
  while ((match = matrixPattern.exec(text)) !== null) {
    sizes.add(match[1].replace(/\s+/g, '').toLowerCase());
  }
  return [...sizes];
}

function extractManufacturers(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const mfg of KNOWN_MANUFACTURERS) {
    const escaped = mfg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(lower)) {
      found.push(mfg);
    }
  }
  return found;
}

function tokenizeName(text: string): string[] {
  const stop = new Set([
    'mg', 'mcg', 'g', 'ml', 'iu', 'unit', 'units', 'tablet', 'tablets',
    'tab', 'tabs', 'capsule', 'capsules', 'cap', 'caps', 'syrup',
    'suspension', 'injection', 'cream', 'ointment', 'drops', 'drop',
    'sachet', 'powder', 'oral', 'for', 'and'
  ]);
  return [...new Set(
    text.toLowerCase()
      .replace(/[®™]/g, '')
      .replace(/\b\d+(?:[.,]\d+)?\s*(?:mcg|μg|µg|mg|g|ml|iu|units?|%)\b/gi, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 1 && !stop.has(token))
  )];
}

function normalizeOcrGlyphs(token: string): string {
  if (token.length < 4) return token;
  return token
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/5/g, 's');
}

export function parseMedicineText(rawText: string): MedicineTextProfile {
  const safeText = String(rawText || '').replace(/\u00a0/g, ' ').trim();
  const dosageForms = FORM_PATTERNS
    .filter(([, pattern]) => pattern.test(safeText))
    .map(([form]) => form);
  const releaseTypes = RELEASE_PATTERNS
    .filter(([, pattern]) => pattern.test(safeText))
    .map(([type]) => type);

  return {
    rawText: safeText,
    normalizedText: safeText.toLowerCase().replace(/\s+/g, ' ').trim(),
    strengths: extractStrengths(safeText),
    dosageForms: dosageForms.length ? dosageForms : ['unknown'],
    releaseTypes,
    packageSizes: extractPackageSizes(safeText),
    manufacturers: extractManufacturers(safeText),
    nameTokens: tokenizeName(safeText)
  };
}

export function mapMatchClassificationToUiTier(
  classification: 'VERIFIED MATCH' | 'POSSIBLE MATCH' | 'NEEDS REVIEW' | 'UNKNOWN MEDICINE' | 'CONFLICT'
): UiConfidenceTier {
  if (classification === 'VERIFIED MATCH') return 'VERIFIED';
  if (classification === 'POSSIBLE MATCH' || classification === 'NEEDS REVIEW') return 'PROBABLE';
  return 'UNRECOGNIZED';
}

function tokenSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  const intersection = [...aSet].filter((token) => bSet.has(token)).length;
  const union = new Set([...aSet, ...bSet]).size;
  return union ? intersection / union : 0;
}

function computeCatalogueCoverage(observed: string[], catalogue: string[]): {
  coverage: number;
  exactHits: number;
  fuzzyHits: number;
} {
  if (!observed.length || !catalogue.length) {
    return { coverage: 0, exactHits: 0, fuzzyHits: 0 };
  }
  const observedSet = new Set(observed);
  const observedGlyphs = new Set(observed.map(normalizeOcrGlyphs));
  let exactHits = 0;
  let fuzzyHits = 0;
  for (const token of catalogue) {
    if (observedSet.has(token)) {
      exactHits++;
    } else if (token.length >= 4 && observedGlyphs.has(normalizeOcrGlyphs(token))) {
      fuzzyHits++;
    }
  }
  const weighted = exactHits + fuzzyHits * 0.85;
  return {
    coverage: Math.min(1, weighted / catalogue.length),
    exactHits,
    fuzzyHits
  };
}

function hasConflict<T>(observed: T[], catalogue: T[]): boolean {
  return observed.length > 0 && catalogue.length > 0 &&
    (observed.length !== catalogue.length || observed.some((item) => !catalogue.includes(item)));
}

/**
 * Match against the existing catalogue without mutating it.
 * Text-only auto-selection requires name + exact strength + dosage form + release
 * agreement. If the current medicine record does not encode those attributes
 * in its name, the result remains a candidate and requires pharmacist review.
 */
export function matchMedicineText(
  profile: MedicineTextProfile,
  catalogue: MedicineCatalogueEntry[],
  scannedBarcode?: string
): MedicineMatch[] {
  const barcode = String(scannedBarcode || '').trim();
  const exactBarcodeMatches = barcode
    ? catalogue.filter((item) =>
        item.barcode === barcode || (item.secondaryBarcodes || []).includes(barcode))
    : [];

  if (exactBarcodeMatches.length === 1) {
    const medicine = exactBarcodeMatches[0];
    const catalogueProfile = parseMedicineText(medicine.name);
    const conflicts: string[] = [];

    // A unique exact barcode is strong identity evidence, but it must not
    // override contradictory OCR attributes. Unreadable/missing attributes
    // do not create a conflict; an explicitly observed mismatch does.
    if (hasConflict(profile.strengths, catalogueProfile.strengths)) {
      conflicts.push('الباركود يطابق الصنف لكن النص المقروء يشير إلى تركيز مختلف');
    }
    if (hasConflict(
      profile.dosageForms.filter((x) => x !== 'unknown'),
      catalogueProfile.dosageForms.filter((x) => x !== 'unknown')
    )) {
      conflicts.push('الباركود يطابق الصنف لكن النص المقروء يشير إلى شكل صيدلاني مختلف');
    }
    if (hasConflict(profile.releaseTypes, catalogueProfile.releaseTypes)) {
      conflicts.push('الباركود يطابق الصنف لكن النص المقروء يشير إلى نوع تحرر مختلف');
    }

    if (conflicts.length) {
      return [{
        medicine,
        status: 'rejected',
        confidence: 0,
        reasons: ['تطابق باركود فريد مع وجود تعارض في خصائص النص المقروء'],
        conflicts,
        safeToAutoSelect: false
      }];
    }

    const observedForms = profile.dosageForms.filter((x) => x !== 'unknown');
    const catalogueForms = catalogueProfile.dosageForms.filter((x) => x !== 'unknown');
    const hasCompleteMatchingAttributes =
      tokenSimilarity(profile.nameTokens, catalogueProfile.nameTokens) >= 0.9 &&
      profile.strengths.length > 0 &&
      catalogueProfile.strengths.length > 0 &&
      profile.strengths.join('|') === catalogueProfile.strengths.join('|') &&
      observedForms.length > 0 &&
      catalogueForms.length > 0 &&
      observedForms.join('|') === catalogueForms.join('|') &&
      profile.releaseTypes.join('|') === catalogueProfile.releaseTypes.join('|');

    return [{
      medicine,
      status: hasCompleteMatchingAttributes ? 'verified' : 'candidate',
      confidence: hasCompleteMatchingAttributes ? 0.95 : 0.75,
      reasons: hasCompleteMatchingAttributes
        ? ['تطابق باركود فريد مع تطابق خصائص النص المقروء']
        : ['الباركود فريد، لكن بيانات OCR غير مكتملة لإثبات تطابق التركيز والشكل والتحرر'],
      conflicts: [],
      // Matching evidence is not pharmacist approval; never auto-select.
      safeToAutoSelect: false
    }];
  }

  if (exactBarcodeMatches.length > 1) {
    return exactBarcodeMatches.map((medicine) => ({
      medicine,
      status: 'rejected',
      confidence: 0,
      reasons: [],
      conflicts: ['الباركود نفسه مرتبط بأكثر من صنف؛ يلزم حل تعارض بيانات الكتالوج'],
      safeToAutoSelect: false
    }));
  }

  return catalogue.map((medicine) => {
    const catalogueProfile = parseMedicineText(medicine.name);
    const similarity = tokenSimilarity(profile.nameTokens, catalogueProfile.nameTokens);
    const { coverage, exactHits, fuzzyHits } = computeCatalogueCoverage(
      profile.nameTokens,
      catalogueProfile.nameTokens
    );
    const conflicts: string[] = [];
    const reasons: string[] = [];

    if (hasConflict(profile.strengths, catalogueProfile.strengths)) {
      conflicts.push('اختلاف التركيز أو عدد مكونات التركيز');
    }
    if (hasConflict(
      profile.dosageForms.filter((x) => x !== 'unknown'),
      catalogueProfile.dosageForms.filter((x) => x !== 'unknown')
    )) {
      conflicts.push('اختلاف الشكل الصيدلاني');
    }
    if (hasConflict(profile.releaseTypes, catalogueProfile.releaseTypes)) {
      conflicts.push('اختلاف نوع التحرر الدوائي (XR/SR/MR/DR/EC)');
    }

    if (similarity >= 0.5 || coverage >= 0.75) reasons.push('تشابه في اسم الدواء');
    const strengthMatched = profile.strengths.length > 0 &&
      catalogueProfile.strengths.length > 0 &&
      profile.strengths.join('|') === catalogueProfile.strengths.join('|');
    if (strengthMatched) reasons.push('تطابق التركيز');
    if (profile.dosageForms[0] !== 'unknown' &&
        profile.dosageForms.join('|') === catalogueProfile.dosageForms.join('|')) {
      reasons.push('تطابق الشكل الصيدلاني');
    }
    if (profile.releaseTypes.join('|') === catalogueProfile.releaseTypes.join('|')) {
      reasons.push('تطابق نوع التحرر');
    }

    const hasStrictAttributes =
      strengthMatched &&
      profile.dosageForms[0] !== 'unknown' &&
      catalogueProfile.dosageForms[0] !== 'unknown' &&
      profile.dosageForms.join('|') === catalogueProfile.dosageForms.join('|') &&
      profile.releaseTypes.join('|') === catalogueProfile.releaseTypes.join('|');

    // Attribute mismatches matter only for a sufficiently related medicine.
    // Unrelated catalogue rows must not be surfaced as conflicts.
    const hasRelevantConflict = (similarity >= 0.25 || coverage >= 0.5) && conflicts.length > 0;
    const rejected = hasRelevantConflict || (coverage < 0.5 && similarity < 0.25);
    const verified = !rejected && fuzzyHits === 0 && exactHits > 0 &&
      similarity >= 0.9 && hasStrictAttributes;
    const confidence = verified ? 0.95 : Math.max(0, Math.min(0.84,
      coverage * 0.48 +
      similarity * 0.18 +
      (hasStrictAttributes ? 0.18 : (strengthMatched ? 0.12 : 0)) +
      (reasons.length >= 2 ? 0.04 : 0)
    ));

    const matchStatus: MedicineMatchStatus = rejected ? 'rejected' : verified ? 'verified' : 'candidate';

    return {
      medicine,
      status: matchStatus,
      confidence,
      reasons,
      conflicts: hasRelevantConflict ? conflicts : [],
      // This parser only proposes matches; explicit pharmacist review is required.
      safeToAutoSelect: false
    };
  })
    // Keep relevant conflicts for the batch layer; discard unrelated rows.
    .filter((match) => match.status !== 'rejected' || match.conflicts.length > 0)
    .sort((a, b) => b.confidence - a.confidence);
}
