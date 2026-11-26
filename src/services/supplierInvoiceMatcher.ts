import { Medicine, Supplier } from './pharmacyDb';
import { MatchCategory, OcrInvoiceItem, ExtractedField } from '../types/supplierInvoiceOcr';

/**
 * Normalize text for resilient multilingual Arabic/English comparison
 */
export function normalizeText(text?: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .trim()
    // Arabic normalization: unify alefs and yahs
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    // Remove diacritics
    .replace(/[\u064B-\u065F\u0670]/g, '')
    // Remove punctuation & special characters
    .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect dosage form category from text
 */
export function extractDosageForm(text?: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/tab|قرص|أقراص|حبوب|tablet/i.test(lower)) return 'Tablet';
  if (/cap|كبسول|capsule/i.test(lower)) return 'Capsule';
  if (/syr|شراب|syrup|susp|معلق|suspension/i.test(lower)) return 'Syrup';
  if (/inj|حقن|vial|amp|ampoule|امبول|injection/i.test(lower)) return 'Injection';
  if (/drop|قطرة|نقط/i.test(lower)) return 'Drops';
  if (/cream|كريم|مرهم|ointment/i.test(lower)) return 'Cream';
  if (/inhaler|بخاخ/i.test(lower)) return 'Inhaler';
  return null;
}

/**
 * Extract normalized strength (e.g., "500mg", "1g", "250mg/5ml", "1000mg")
 */
export function extractStrength(text?: string): string | null {
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(mg|g|mcg|ml|iu|gm|%)(?:\/\d+ml)?/i);
  if (match) {
    let num = parseFloat(match[1]);
    let unit = match[2].toLowerCase();
    // Normalize 1g to 1000mg
    if (unit === 'g' || unit === 'gm') {
      num = num * 1000;
      unit = 'mg';
    }
    return `${num}${unit}`;
  }
  return null;
}

/**
 * Compute Bigram / Dice Token Similarity (0.0 to 1.0)
 */
export function computeSimilarity(str1: string, str2: string): number {
  const s1 = normalizeText(str1);
  const s2 = normalizeText(str2);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1.0;

  // Exact word containment check
  if (s1.includes(s2) || s2.includes(s1)) {
    const ratio = Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
    if (ratio >= 0.6) return 0.85 + ratio * 0.15;
  }

  // Word token overlap (Jaccard on words)
  const words1 = new Set(s1.split(' ').filter(w => w.length > 1));
  const words2 = new Set(s2.split(' ').filter(w => w.length > 1));
  if (words1.size === 0 || words2.size === 0) return 0;

  let intersection = 0;
  for (const w of words1) {
    if (words2.has(w)) intersection++;
  }
  const union = new Set([...words1, ...words2]).size;
  return union > 0 ? intersection / union : 0;
}

export interface MatchResult {
  matchStatus: MatchCategory;
  matchedMedicineId?: string;
  matchedMedicineName?: string;
  matchScore: number; // 0 - 100
  reason: string;
}

/**
 * Smart matching algorithm:
 * Matches an extracted item against the pharmacy medicines catalog.
 * ENFORCES strict rules:
 * - If dosage form is recognized and differs from DB medicine form -> FORBID auto-match!
 * - If strength is recognized and differs from DB medicine strength -> FORBID auto-match!
 */
export function matchItemWithMedicines(
  item: {
    tradeName?: string;
    genericName?: string;
    strength?: string;
    dosageForm?: string;
    barcode?: string;
  },
  allMedicines: Medicine[]
): MatchResult {
  const trade = item.tradeName?.trim() || '';
  const barcode = item.barcode?.trim() || '';
  const itemForm = item.dosageForm ? extractDosageForm(item.dosageForm) : extractDosageForm(trade);
  const itemStrength = item.strength ? extractStrength(item.strength) : extractStrength(trade);

  // 1. Direct Barcode Match (Highest Confidence)
  if (barcode && barcode.length > 3) {
    const medByBarcode = allMedicines.find(m => m.barcode && m.barcode.trim() === barcode);
    if (medByBarcode) {
      return {
        matchStatus: 'STRONG',
        matchedMedicineId: medByBarcode.id,
        matchedMedicineName: medByBarcode.name,
        matchScore: 100,
        reason: 'تطابق كامل برقم الباركود الدولي'
      };
    }
  }

  if (!trade) {
    return {
      matchStatus: 'NEW',
      matchScore: 0,
      reason: 'اسم الصنف غير متوفر'
    };
  }

  // 2. Score against all medicines
  let bestMedicine: Medicine | null = null;
  let highestScore = 0;
  let matchReason = '';

  for (const med of allMedicines) {
    const medForm = extractDosageForm(med.name) || extractDosageForm(med.category);
    const medStrength = extractStrength(med.name);

    // RULE 1: If forms conflict (e.g. Syrup vs Tablet), reject candidate
    if (itemForm && medForm && itemForm !== medForm) {
      continue;
    }

    // RULE 2: If strengths conflict (e.g. 500mg vs 250mg), reject candidate
    if (itemStrength && medStrength && itemStrength !== medStrength) {
      continue;
    }

    // Calculate name similarity with bilingual support
    let score = computeSimilarity(trade, med.name);

    // If trade contains Arabic and English, also test the English substring directly
    const englishSub = trade.replace(/[\u0600-\u06FF]/g, ' ').replace(/\s+/g, ' ').trim();
    if (englishSub.length >= 3) {
      const enScore = computeSimilarity(englishSub, med.name);
      score = Math.max(score, enScore);
    }

    // Bonus if strength matches explicitly
    if (itemStrength && medStrength && itemStrength === medStrength) {
      score = Math.min(1.0, score + 0.15);
    }

    // Bonus if form matches explicitly
    if (itemForm && medForm && itemForm === medForm) {
      score = Math.min(1.0, score + 0.1);
    }

    if (score > highestScore) {
      highestScore = score;
      bestMedicine = med;
    }
  }

  const scorePct = Math.round(highestScore * 100);

  if (bestMedicine && scorePct >= 80) {
    return {
      matchStatus: 'STRONG',
      matchedMedicineId: bestMedicine.id,
      matchedMedicineName: bestMedicine.name,
      matchScore: scorePct,
      reason: `تطابق قوي مع ${bestMedicine.name} (${scorePct}%)`
    };
  }

  if (bestMedicine && scorePct >= 55) {
    return {
      matchStatus: 'PROBABLE',
      matchedMedicineId: bestMedicine.id,
      matchedMedicineName: bestMedicine.name,
      matchScore: scorePct,
      reason: `تطابق محتمل مع ${bestMedicine.name} (${scorePct}%) - يتطلب تأكيد الصيدلي`
    };
  }

  return {
    matchStatus: 'NEW',
    matchScore: scorePct,
    reason: 'صنف غير مسجل في قاعدة بيانات الأدوية (يمكن إضافته كدواء جديد)'
  };
}

/**
 * Match supplier name against existing suppliers catalog
 */
export function matchSupplier(
  extractedSupplierName: string,
  suppliers: Supplier[]
): { matchedSupplierId?: string; matchedSupplierName?: string; score: number } {
  const normExtracted = normalizeText(extractedSupplierName);
  if (!normExtracted || suppliers.length === 0) {
    return { score: 0 };
  }

  let bestSup: Supplier | null = null;
  let highestScore = 0;

  for (const sup of suppliers) {
    const arScore = computeSimilarity(normExtracted, sup.name?.ar || '');
    const enScore = computeSimilarity(normExtracted, sup.name?.en || '');
    const maxScore = Math.max(arScore, enScore);

    if (maxScore > highestScore) {
      highestScore = maxScore;
      bestSup = sup;
    }
  }

  if (bestSup && highestScore >= 0.5) {
    return {
      matchedSupplierId: bestSup.id,
      matchedSupplierName: bestSup.name?.ar || bestSup.name?.en || bestSup.id,
      score: Math.round(highestScore * 100)
    };
  }

  return { score: 0 };
}
