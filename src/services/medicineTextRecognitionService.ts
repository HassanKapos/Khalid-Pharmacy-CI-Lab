/**
 * Medicine Text Recognition & Intelligent Internal Suggestions Engine
 * Khalid Pharmacy — Intelligent Computer Vision & Pharmacy Data Safety Module
 * 
 * STRICT MANDATE:
 * - 100% INTERNAL PHARMACY CATALOGUE ONLY (`pharmacyDb.ts`).
 * - ZERO external APIs (No openFDA, No RxNorm, No network dependency).
 * 
 * Capabilities:
 * - OCR text recognition on cropped medicine package images.
 * - OCR character confusion matrix normalization (O <-> 0, I <-> 1, S <-> 5, misread units).
 * - Field parsing: Brand name, generic name, active ingredient, strength, dosage form, EAN/UPC barcode.
 * - Multi-candidate fuzzy search & ranking against internal pharmacy catalog (`pharmacyDb.ts`).
 * - Hard safety rules: Mismatched active ingredients or conflicting strengths prevent auto-verification!
 * - Multi-candidate ranking (top 3-5 matches with score %, reason, and safety status).
 * - UI Match Statuses: 'VERIFIED_MATCH' | 'POSSIBLE_MATCH' | 'MULTIPLE_CANDIDATES' | 'UNKNOWN_MEDICINE' | 'NEEDS_REVIEW'.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';
import { Medicine, getAllMedicines } from './pharmacyDb';
import {
  parseMedicineText,
  matchMedicineText,
  MedicineMatch,
  MedicineTextProfile
} from './medicineTextParser';
import {
  webMedicineTextRecognitionService,
  scoreOcrTextReadability,
  extractCleanMedicineNameSuggestion
} from './webMedicineTextRecognitionService';

export interface NativeMedicineOcrResult {
  text: string;
  lines: string[];
  blocks: Array<{ text: string; lines: string[] }>;
  imageBase64?: string;
  captureId?: string;
  mimeType?: string;
  cancelled?: boolean;
}

interface MedicineTextRecognitionPlugin {
  recognize(options: { imageBase64: string; rotation: 0 | 90 | 180 | 270 }): Promise<NativeMedicineOcrResult>;
  captureAndRecognize(): Promise<NativeMedicineOcrResult>;
}

const NativeMedicineTextRecognition = registerPlugin<MedicineTextRecognitionPlugin>(
  'MedicineTextRecognition'
);

export type CandidateMatchStatus =
  | 'VERIFIED_MATCH'
  | 'POSSIBLE_MATCH'
  | 'MULTIPLE_CANDIDATES'
  | 'UNKNOWN_MEDICINE'
  | 'NEEDS_REVIEW';

export interface ExtractedMedicineDetails {
  rawOcrText: string;
  brandName?: string;
  genericName?: string;
  activeIngredient?: string;
  strength?: string;
  dosageForm?: string;
  barcode?: string;
  confidence: number;
  parsedProfile?: MedicineTextProfile;
}

export interface RankedMedicineCandidate {
  medicineId?: string;
  medicineName: string;
  brandName?: string;
  genericName?: string;
  activeIngredient?: string;
  strength?: string;
  dosageForm?: string;
  category?: string;
  barcode?: string;
  matchScore: number; // 0 to 100
  reason: string;
  hasConflict?: boolean;
  conflictDetails?: string;
  safeToAutoSelect?: boolean;
}

export interface RecognitionResult {
  extracted: ExtractedMedicineDetails;
  status: CandidateMatchStatus;
  primaryMatch: RankedMedicineCandidate | null;
  rankedCandidates: RankedMedicineCandidate[];
  requiresPharmacistReview: boolean;
  reviewReason: string;
}

/**
 * Handle OCR character confusion matrix (e.g. O vs 0, I vs 1, S vs 5 in numbers & units)
 */
export function fixOcrCharacterConfusion(text: string): string {
  if (!text) return '';
  let fixed = text;

  // Fix strength numbers where 'O' or 'o' was read instead of '0' (e.g., "5Oo mg" -> "500 mg")
  fixed = fixed.replace(/(\d+)[Oo]+(\s*(?:mg|g|mcg|ml|iu|gm|%))/gi, '$100$2');
  fixed = fixed.replace(/(\d+)[Oo](\d+)/g, '$10$2');

  // Fix trailing digits/letters glued after strength units (e.g. "500mg1" -> "500mg")
  fixed = fixed.replace(/(\d+\s*(?:mg|g|mcg|ml|iu|gm|%))[1lI](\s+|$)/gi, '$1$2');

  // Fix 'S' misread as '5' in strength units (e.g. "500 S mg" -> "500 mg")
  fixed = fixed.replace(/(\d+)\s*S\s*(mg|g|ml)/gi, '$1 $2');

  return fixed;
}

export class MedicineTextRecognitionService {
  public isAndroidNative(): boolean {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  }

  public isSupported(): boolean {
    if (Capacitor.isNativePlatform()) return Capacitor.getPlatform() === 'android';
    return typeof window !== 'undefined' && typeof Worker !== 'undefined';
  }

  public async isOfflineReady(): Promise<boolean> {
    if (Capacitor.isNativePlatform()) return Capacitor.getPlatform() === 'android';
    return webMedicineTextRecognitionService.isReady();
  }

  public async ensureOfflineReady(): Promise<boolean> {
    if (Capacitor.isNativePlatform()) return Capacitor.getPlatform() === 'android';
    return webMedicineTextRecognitionService.ensureReady();
  }

  public async disposeWebWorker(): Promise<void> {
    if (Capacitor.isNativePlatform()) return;
    await webMedicineTextRecognitionService.dispose();
  }

  public assessOcrReadability(text: string, confidence: number = 0) {
    return scoreOcrTextReadability(text, confidence);
  }

  public async recognizeWebImage(image: Blob | File | string): Promise<NativeMedicineOcrResult> {
    if (Capacitor.isNativePlatform()) {
      const base64Str = typeof image === 'string' ? image : await this.blobToBase64(image as Blob);
      return this.recognizeStillImage(base64Str);
    }
    const blobOrFile = typeof image === 'string' ? await this.base64ToBlob(image) : image;
    const result = await webMedicineTextRecognitionService.recognize(blobOrFile);
    return { text: result.text, lines: result.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), blocks: [] };
  }

  public async captureAndRecognize(): Promise<NativeMedicineOcrResult> {
    if (!this.isSupported()) {
      throw new Error('التقاط صورة الدواء عبر ML Kit متاح حالياً على تطبيق Android فقط');
    }
    const result = await NativeMedicineTextRecognition.captureAndRecognize();
    return {
      text: String(result?.text || ''),
      lines: Array.isArray(result?.lines) ? result.lines.map(String) : [],
      blocks: Array.isArray(result?.blocks) ? result.blocks : [],
      imageBase64: typeof result?.imageBase64 === 'string' ? result.imageBase64 : undefined,
      captureId: typeof result?.captureId === 'string' ? result.captureId : undefined,
      mimeType: typeof result?.mimeType === 'string' ? result.mimeType : undefined,
      cancelled: Boolean(result?.cancelled)
    };
  }

  public async recognizeStillImage(
    imageBase64: string,
    rotation: 0 | 90 | 180 | 270 = 0
  ): Promise<NativeMedicineOcrResult> {
    if (this.isAndroidNative()) {
      const result = await NativeMedicineTextRecognition.recognize({
        imageBase64,
        rotation
      });
      return {
        text: String(result?.text || ''),
        lines: Array.isArray(result?.lines) ? result.lines.map(String) : [],
        blocks: Array.isArray(result?.blocks) ? result.blocks : []
      };
    }
    // Web fallback: propagate OCR initialization/execution failures so callers can retry without losing the captured image
    const blob = await this.base64ToBlob(imageBase64);
    const result = await webMedicineTextRecognitionService.recognize(blob);
    return { text: result.text, lines: result.text.split(/\r?\n/).map(l => l.trim()).filter(Boolean), blocks: [] };
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  private async base64ToBlob(base64: string): Promise<Blob> {
    const dataUrl = base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;
    const res = await fetch(dataUrl);
    return res.blob();
  }

  /**
   * Parses raw OCR text into structured pharmaceutical fields using pure internal parser
   */
  public parseOcrText(rawText: string): ExtractedMedicineDetails {
    const cleanedText = fixOcrCharacterConfusion(rawText || '').trim();
    if (!cleanedText) {
      return {
        rawOcrText: '',
        confidence: 0
      };
    }

    const profile = parseMedicineText(cleanedText);
    const lines = cleanedText.split('\n').map(l => l.trim()).filter(Boolean);

    // Extract Barcode if present in OCR text (EAN-13, EAN-8, UPC)
    const barcodeMatch = cleanedText.match(/\b(621\d{10}|\d{13}|\d{12}|\d{8})\b/);
    const barcode = barcodeMatch ? barcodeMatch[1] : undefined;

    const brandName = extractCleanMedicineNameSuggestion(cleanedText) || undefined;
    const strength = profile.strengths.length > 0 ? profile.strengths[0] : undefined;
    const dosageForm = profile.dosageForms[0] !== 'unknown' ? profile.dosageForms[0] : undefined;

    return {
      rawOcrText: cleanedText,
      brandName,
      strength,
      dosageForm,
      barcode,
      confidence: brandName ? (cleanedText.length > 5 ? 0.85 : 0.40) : 0.15,
      parsedProfile: profile
    };
  }

  /**
   * Main Recognition & Candidate Ranking Method:
   * Compares extracted OCR details strictly against internal pharmacy catalog (`pharmacyDb.ts`).
   * NO external API calls.
   */
  public async recognizeAndRankCandidates(
    extracted: ExtractedMedicineDetails,
    scannedBarcode?: string
  ): Promise<RecognitionResult> {
    const catalog = await getAllMedicines();
    const barcodeToUse = scannedBarcode || extracted.barcode;
    const profile = extracted.parsedProfile || parseMedicineText(extracted.rawOcrText);

    // Run conservative internal catalogue matcher
    const matches: MedicineMatch[] = matchMedicineText(profile, catalog, barcodeToUse);

    const rankedCandidates: RankedMedicineCandidate[] = matches.map((m) => ({
      medicineId: m.medicine.id,
      medicineName: m.medicine.name,
      barcode: m.medicine.barcode,
      matchScore: Math.round(m.confidence * 100),
      reason: m.reasons.join(' • ') || 'مقترح من الكتالوج الداخلي للصيدلية',
      hasConflict: m.conflicts.length > 0,
      conflictDetails: m.conflicts.join(' • ') || undefined,
      safeToAutoSelect: m.safeToAutoSelect
    }));

    const topCandidates = rankedCandidates.slice(0, 5);

    // 1. Direct Verified Barcode / Exact Attributes Match
    if (topCandidates.length > 0 && matches[0].status === 'verified') {
      const primary = topCandidates[0];
      return {
        extracted,
        status: 'VERIFIED_MATCH',
        primaryMatch: primary,
        rankedCandidates: topCandidates,
        requiresPharmacistReview: false,
        reviewReason: 'تطابق مؤكد في الكتالوج الداخلي للصيدلية'
      };
    }

    // 2. Multiple Candidates Close Score (Requires Pharmacist Selection)
    if (topCandidates.length > 1 && topCandidates[0].matchScore >= 55 && (topCandidates[0].matchScore - topCandidates[1].matchScore) < 15) {
      return {
        extracted,
        status: 'MULTIPLE_CANDIDATES',
        primaryMatch: topCandidates[0],
        rankedCandidates: topCandidates,
        requiresPharmacistReview: true,
        reviewReason: 'توجد عدة مقترحات متقاربة في الكتالوج الداخلي — يلزم اختيار الصيدلي'
      };
    }

    // 3. Possible Match Candidate
    if (topCandidates.length > 0 && topCandidates[0].matchScore >= 45) {
      const primary = topCandidates[0];
      return {
        extracted,
        status: 'POSSIBLE_MATCH',
        primaryMatch: primary,
        rankedCandidates: topCandidates,
        requiresPharmacistReview: true,
        reviewReason: `مقترح محتمل مع ${primary.medicineName} (${primary.matchScore}%) — يلزم تأكيد الصيدلي`
      };
    }

    // 4. Unknown Medicine (No suitable candidate in internal catalog)
    return {
      extracted,
      status: 'UNKNOWN_MEDICINE',
      primaryMatch: null,
      rankedCandidates: topCandidates,
      requiresPharmacistReview: true,
      reviewReason: 'دواء غير مسجل في الكتالوج الداخلي للصيدلية — يتطلب مراجعة أو إضافة دواء جديد'
    };
  }
}

export const medicineTextRecognitionService = new MedicineTextRecognitionService();
