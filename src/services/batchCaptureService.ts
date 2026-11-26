/**
 * Phase 3.6-A + Batch Capture 2.0:
 * Dual-Mode Multi-Medicine Batch Capture Service (Sequential Queue + Unified Multi-Box)
 *
 * Capabilities:
 * - Mode A (Sequential Capture): Non-blocking FIFO capture queue, independent OCR + Barcode-First
 *   per item, partial failure isolation, zero image loss on retry.
 * - Mode B (Unified Multi-Object Image): Stores source original photo + per-region bounding box crops
 *   + independent Barcode-First + OCR results inside the same Batch Session.
 * - Persistence: Serializes/hydrates active session cleanly to active branch IndexedDB metadata store
 *   ('batch_capture_session_v2') without bumping DB_VERSION.
 * - Safety Invariants:
 *   * OCR/Barcode matches NEVER auto-select a medicine (`selectedMedicine: null`) until explicit
 *     pharmacist confirmation/selection.
 *   * `confirmAllEligibleItems()` remains strictly 0 (no bulk auto-confirm).
 *   * This service NEVER directly mutates POS cart, sales, stock, or inventory_ledger.
 */

import { medicineTextRecognitionService } from './medicineTextRecognitionService.ts';
import {
  parseMedicineText,
  matchMedicineText,
  mapMatchClassificationToUiTier,
  type MedicineMatch,
  type MedicineCatalogueEntry,
  type MedicineTextProfile,
  type UiConfidenceTier
} from './medicineTextParser.ts';
import { staticImageBarcodeService } from './staticImageBarcodeService.ts';
import {
  saveBatchCaptureSessionState,
  loadBatchCaptureSessionState,
  clearBatchCaptureSessionState,
  getActiveBranchId,
  type PersistedBatchCaptureSessionRecord
} from './pharmacyDb.ts';

export type BatchCaptureMode = 'SEQUENTIAL' | 'UNIFIED_IMAGE';

export type BatchItemClassification =
  | 'VERIFIED MATCH'
  | 'POSSIBLE MATCH'
  | 'NEEDS REVIEW'
  | 'UNKNOWN MEDICINE'
  | 'CONFLICT';

export type BatchItemStatus = 'pending' | 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled';

export type BatchItemActionStatus = 'idle' | 'added';

export interface BatchOriginalImageRecord {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: string;
}

export interface BatchMedicineItem {
  id: string;
  sequenceNumber: number;
  capturedAt: string;
  captureId?: string;
  captureMode?: BatchCaptureMode;
  thumbnailUrl?: string;
  sourceImageBlob?: Blob;
  imageBase64?: string;
  originalThumbnailUrl?: string;
  originalSourceBlob?: Blob;
  originalImageBase64?: string;
  originalImageId?: string;
  sourceRegionBox?: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    label?: string;
  };
  status: BatchItemStatus;
  ocrText: string;
  barcodeDetected?: string;
  barcodeFormat?: string;
  parsedProfile?: MedicineTextProfile;
  candidates: MedicineMatch[];
  selectedMedicine: MedicineCatalogueEntry | null;
  classification: BatchItemClassification;
  confidenceTier?: UiConfidenceTier;
  reasons: string[];
  conflicts: string[];
  isDuplicateInSession: boolean;
  duplicateCount: number;
  duplicateItemIds: string[];
  errorMessage?: string;
  suggestionStatus?: 'suggested' | 'under_review' | 'saved' | 'linked' | 'failed';
  suggestedMedicineId?: string;
  suggestedMedicineName?: string;
  suggestedMedicineBarcode?: string;
  isConfirmed: boolean;
  isManuallyReviewed?: boolean;
  isIgnored?: boolean;
  cartActionStatus?: BatchItemActionStatus;
  cartAddedQty?: number;
  lastCartAddedAt?: string;
  inventoryActionStatus?: BatchItemActionStatus;
  inventoryAddedQty?: number;
  inventoryAddedUnit?: 'pack' | 'strip' | 'pill';
  inventoryLedgerMovementId?: string;
  lastInventoryAddedAt?: string;
  processingDurationMs?: number;
}

export interface BatchSessionSummary {
  sessionId: string;
  mode: BatchCaptureMode;
  createdAt: string;
  totalItems: number;
  queuedItems: number;
  readyItems: number;
  failedItems: number;
  processingItems: number;
  verifiedCount: number;
  possibleCount: number;
  needsReviewCount: number;
  conflictCount: number;
  unknownCount: number;
  ignoredCount: number;
  duplicateAlertCount: number;
  confirmedCount: number;
  cartAddedCount: number;
  inventoryAddedCount: number;
}

interface QueuedCaptureJob {
  item: BatchMedicineItem;
  sessionId: string;
  generation: number;
  catalogueProvider: () => MedicineCatalogueEntry[];
  onUpdate?: () => void;
  resolve: (item: BatchMedicineItem) => void;
}

async function blobToDataUrlSafe(blob: Blob): Promise<string | undefined> {
  if (!blob || blob.size <= 0) return undefined;
  if (typeof FileReader !== 'undefined') {
    return await new Promise<string | undefined>((resolve) => {
      try {
        const reader = new FileReader();
        reader.onload = () => {
          const res = String(reader.result || '');
          resolve(res.startsWith('data:image/') ? res : undefined);
        };
        reader.onerror = () => resolve(undefined);
        reader.readAsDataURL(blob);
      } catch {
        resolve(undefined);
      }
    });
  }
  return undefined;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class BatchCaptureService {
  private sessionId: string = '';
  private captureMode: BatchCaptureMode = 'SEQUENTIAL';
  private sessionCreatedAt: string = new Date().toISOString();
  private branchId: string = 'default';
  private items: BatchMedicineItem[] = [];
  private originalImages: BatchOriginalImageRecord[] = [];
  private isCameraLocked: boolean = false;
  private cameraMutexOwner: string | null = null;
  private sequenceCounter: number = 0;
  private cameraLockSequence: number = 0;
  private sessionGeneration: number = 0;
  private sessionActive: boolean = false;

  // Mode A non-blocking background FIFO queue
  private captureQueue: QueuedCaptureJob[] = [];
  private isQueueWorkerRunning: boolean = false;
  private autoPersistEnabled: boolean = false;

  private isCurrentSessionItem(sessionId: string, generation: number, item: BatchMedicineItem): boolean {
    return this.sessionId === sessionId && this.sessionGeneration === generation && this.items.includes(item);
  }

  constructor() {
    this.startNewSession();
  }

  public setAutoPersist(enabled: boolean): void {
    this.autoPersistEnabled = enabled;
  }

  public setCaptureMode(mode: BatchCaptureMode): void {
    this.captureMode = mode;
    void this.persistIfEnabled();
  }

  public getCaptureMode(): BatchCaptureMode {
    return this.captureMode;
  }

  public getBranchId(): string {
    return this.branchId;
  }

  public setBranchId(branchId: string): void {
    this.branchId = branchId || 'default';
  }

  public registerOriginalImage(info: {
    id?: string;
    dataUrl: string;
    width: number;
    height: number;
  }): BatchOriginalImageRecord {
    const id = info.id || `orig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const existing = this.originalImages.find((img) => img.id === id);
    if (existing) return existing;
    const record: BatchOriginalImageRecord = {
      id,
      dataUrl: info.dataUrl,
      width: info.width,
      height: info.height,
      capturedAt: new Date().toISOString()
    };
    this.originalImages.push(record);
    return record;
  }

  public getOriginalImages(): BatchOriginalImageRecord[] {
    return [...this.originalImages];
  }

  /**
   * Starts a fresh batch session.
   * Cancels any ongoing session state without touching catalogue or inventory records.
   */
  public startNewSession(mode?: string): string {
    for (const item of this.items) {
      if (item.thumbnailUrl && item.thumbnailUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(item.thumbnailUrl); } catch { /* cleanup is best-effort */ }
      }
      if (item.originalThumbnailUrl && item.originalThumbnailUrl !== item.thumbnailUrl && item.originalThumbnailUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(item.originalThumbnailUrl); } catch { /* cleanup is best-effort */ }
      }
    }
    // Cancel pending queued jobs from prior session cleanly
    while (this.captureQueue.length > 0) {
      const pending = this.captureQueue.shift();
      if (pending) {
        pending.item.status = 'cancelled';
        pending.resolve(pending.item);
      }
    }
    this.sessionGeneration++;
    this.sessionId = 'batch-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    this.sessionCreatedAt = new Date().toISOString();
    this.branchId = getActiveBranchId() || 'default';
    this.captureMode = mode === 'SINGLE_IMAGE_MULTI' || mode === 'UNIFIED_IMAGE' ? 'UNIFIED_IMAGE' : 'SEQUENTIAL';
    this.items = [];
    this.originalImages = [];
    this.sessionActive = true;
    this.sequenceCounter = 0;
    // An in-flight camera lock is released only by its original owner.
    return this.sessionId;
  }

  public startBatchSession(mode?: string): { sessionId: string } {
    const id = this.startNewSession(mode);
    return { sessionId: id };
  }

  public getCurrentSession(): { sessionId: string; mode: BatchCaptureMode; items: BatchMedicineItem[] } | null {
    if (!this.sessionActive || !this.sessionId) return null;
    return { sessionId: this.sessionId, mode: this.captureMode, items: [...this.items] };
  }

  public clearCurrentSession(): void {
    this.cancelSession();
  }

  public addItemToSession(sessionId: string, options: {
    imageDataUrl: string;
    ocrResult: any;
    parsedResult: any;
    candidates?: MedicineMatch[];
    detectedBoundingBox?: any;
    barcodeDetected?: string;
    barcodeFormat?: string;
    originalImageId?: string;
    captureMode?: BatchCaptureMode;
    processingDurationMs?: number;
  }): BatchMedicineItem {
    if (sessionId !== this.sessionId) {
      throw new Error('انتهت جلسة الالتقاط؛ تم رفض إضافة نتيجة من جلسة قديمة');
    }
    const itemId = 'batch-item-' + (++this.sequenceCounter);
    const ocrText = String(options.ocrResult?.extractedText || options.ocrResult?.text || '').trim();
    const barcodeDetected = String(
      options.barcodeDetected || options.ocrResult?.barcodeDetected || ''
    ).trim() || undefined;
    const barcodeFormat = String(
      options.barcodeFormat || options.ocrResult?.barcodeFormat || ''
    ).trim() || undefined;

    const candidates: MedicineMatch[] = Array.isArray(options.candidates)
      ? options.candidates.map((c) => ({ ...c, safeToAutoSelect: false }))
      : options.parsedResult?.matchedProduct
      ? [{
          medicine: {
            id: options.parsedResult.matchedProduct.id,
            name: options.parsedResult.matchedProduct.name,
            barcode: options.parsedResult.matchedProduct.barcode
          },
          confidence: options.parsedResult.confidence || 0,
          status: options.parsedResult.classification === 'CONFLICT'
            ? 'rejected'
            : options.parsedResult.classification === 'VERIFIED MATCH'
            ? 'verified'
            : 'candidate',
          reasons: options.parsedResult.matchReason ? [options.parsedResult.matchReason] : ['مطابقة الضوئية'],
          conflicts: options.parsedResult.classification === 'CONFLICT' ? [options.parsedResult.matchReason] : [],
          safeToAutoSelect: false
        }]
      : [];

    const evaluated = this.classifyMatch(candidates, ocrText, barcodeDetected);
    const isOk = Boolean(options.ocrResult && options.ocrResult.success);
    const classification: BatchItemClassification = !isOk
      ? 'UNKNOWN MEDICINE'
      : options.parsedResult?.classification === 'CONFLICT'
      ? 'CONFLICT'
      : evaluated.classification;

    const parsedProfile = ocrText ? parseMedicineText(ocrText) : undefined;

    const item: BatchMedicineItem = {
      id: itemId,
      captureId: itemId,
      captureMode: options.captureMode || this.captureMode,
      sequenceNumber: this.sequenceCounter,
      capturedAt: new Date().toISOString(),
      thumbnailUrl: options.imageDataUrl,
      // Keep the exact cropped data URL available for the per-item OCR retry & reload persistence.
      imageBase64: typeof options.imageDataUrl === 'string' && options.imageDataUrl.startsWith('data:image/')
        ? options.imageDataUrl
        : undefined,
      originalImageId: options.originalImageId,
      sourceRegionBox: options.detectedBoundingBox ? { ...options.detectedBoundingBox } : undefined,
      status: isOk ? 'ready' : 'failed',
      ocrText,
      barcodeDetected,
      barcodeFormat,
      parsedProfile,
      candidates,
      // OCR/Barcode matches are suggestions only. The pharmacist must select/confirm explicitly.
      selectedMedicine: null,
      classification,
      confidenceTier: mapMatchClassificationToUiTier(classification),
      reasons: evaluated.reasons.length
        ? evaluated.reasons
        : options.parsedResult?.matchReason
        ? [options.parsedResult.matchReason]
        : [],
      conflicts: !isOk
        ? [options.ocrResult?.errorMessage || 'فشل التعرف الضوئي على النص']
        : options.parsedResult?.classification === 'CONFLICT'
        ? [options.parsedResult.matchReason || 'تعارض في خصائص الدواء']
        : evaluated.conflicts,
      isDuplicateInSession: false,
      duplicateCount: 1,
      duplicateItemIds: [],
      errorMessage: options.ocrResult?.errorMessage,
      isConfirmed: false,
      isManuallyReviewed: false,
      isIgnored: false,
      cartActionStatus: 'idle',
      cartAddedQty: 0,
      inventoryActionStatus: 'idle',
      inventoryAddedQty: 0,
      processingDurationMs: options.processingDurationMs
    };

    this.items.push(item);
    this.recalculateSessionDuplicates();
    void this.persistIfEnabled();
    return item;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getItems(): BatchMedicineItem[] {
    return [...this.items];
  }

  public getItem(itemId: string): BatchMedicineItem | undefined {
    return this.items.find((item) => item.id === itemId);
  }

  public isBusy(): boolean {
    return this.isCameraLocked || this.items.some((item) => item.status === 'processing' || item.status === 'queued');
  }

  public getQueueLength(): number {
    return this.items.filter((item) => item.status === 'queued' || item.status === 'processing').length;
  }

  /**
   * Camera Mutex Guard: ensures only one capture operation can use the camera at a time.
   */
  public acquireCameraLock(ownerId: string): boolean {
    if (this.isCameraLocked && this.cameraMutexOwner !== ownerId) {
      return false;
    }
    this.isCameraLocked = true;
    this.cameraMutexOwner = ownerId;
    return true;
  }

  public releaseCameraLock(ownerId: string): void {
    if (this.cameraMutexOwner === ownerId || ownerId === 'force') {
      this.isCameraLocked = false;
      this.cameraMutexOwner = null;
    }
  }

  /**
   * Evaluates classification based on OCR/Barcode candidates and conflicts.
   */
  public classifyMatch(
    candidates: MedicineMatch[],
    ocrText: string,
    scannedBarcode?: string
  ): {
    classification: BatchItemClassification;
    reasons: string[];
    conflicts: string[];
    selected: MedicineCatalogueEntry | null;
  } {
    const trimmed = String(ocrText || '').trim();
    const barcode = String(scannedBarcode || '').trim();
    if (!trimmed && !barcode) {
      return {
        classification: 'UNKNOWN MEDICINE',
        reasons: [],
        conflicts: ['لم يتم استخراج أي نص أو باركود من الصورة'],
        selected: null
      };
    }

    if (!candidates || candidates.length === 0) {
      return {
        classification: 'UNKNOWN MEDICINE',
        reasons: barcode ? [`تم رصد الباركود (${barcode}) لكنه غير مسجل في دليل الصيدلية`] : [],
        conflicts: ['لم يتم العثور على أدوية مطابقة في دليل الصيدلية'],
        selected: null
      };
    }

    const top = candidates[0];

    // Rejected candidates and explicit attribute conflicts are never selectable.
    if (top.status === 'rejected' || (top.conflicts && top.conflicts.length > 0)) {
      return {
        classification: 'CONFLICT',
        reasons: top.reasons && top.reasons.length ? top.reasons : ['تم رفض المرشح بسبب تعارض أو حالة مطابقة غير صالحة'],
        conflicts: top.conflicts && top.conflicts.length ? top.conflicts : ['يلزم تدخل الصيدلي للتحقق من تعارض بيانات الدواء'],
        selected: null
      };
    }

    // Only an explicit strict parser verification may receive this classification.
    // Confidence alone is never sufficient to verify a medicine.
    if (top.status === 'verified') {
      return {
        classification: 'VERIFIED MATCH',
        reasons: top.reasons && top.reasons.length ? top.reasons : ['تطابق دقيق في الاسم والتركيز والشكل الصيدلاني'],
        conflicts: [],
        selected: top.medicine
      };
    }

    // Plausible candidate
    if (top.confidence >= 0.5) {
      return {
        classification: 'POSSIBLE MATCH',
        reasons: top.reasons && top.reasons.length ? top.reasons : ['تشابه في اسم الدواء يتطلب مراجعة الصيدلي'],
        conflicts: [],
        selected: top.medicine
      };
    }

    // Needs review
    return {
      classification: 'NEEDS REVIEW',
      reasons: top.reasons || ['درجة مطابقة منخفضة أو بيانات غير كافية'],
      conflicts: top.conflicts || [],
      selected: null
    };
  }

  /**
   * Recalculates duplicate detections across non-ignored items in the current session.
   * If two items resolve to the same selected medicine id, flag both as duplicates.
   */
  public recalculateSessionDuplicates(): void {
    const medicineOccurrences = new Map<string, string[]>();

    for (const item of this.items) {
      item.isDuplicateInSession = false;
      item.duplicateCount = 1;
      item.duplicateItemIds = [];

      if (item.isIgnored) continue;
      const medId = item.selectedMedicine?.id;
      if (medId) {
        const existing = medicineOccurrences.get(medId) || [];
        existing.push(item.id);
        medicineOccurrences.set(medId, existing);
      }
    }

    for (const item of this.items) {
      if (item.isIgnored) continue;
      const medId = item.selectedMedicine?.id;
      if (medId) {
        const itemIds = medicineOccurrences.get(medId) || [];
        if (itemIds.length > 1) {
          item.isDuplicateInSession = true;
          item.duplicateCount = itemIds.length;
          item.duplicateItemIds = itemIds.filter((id) => id !== item.id);
        }
      }
    }
  }

  /**
   * Applies recognition pipeline (Barcode -> Parsed Profile -> Catalogue Match) onto an item.
   */
  private applyRecognitionOutcome(
    item: BatchMedicineItem,
    text: string,
    catalogue: MedicineCatalogueEntry[],
    detectedBarcode?: string,
    detectedBarcodeFormat?: string
  ): void {
    item.ocrText = text;
    if (detectedBarcode) {
      item.barcodeDetected = detectedBarcode;
      item.barcodeFormat = detectedBarcodeFormat;
    }

    // Fallback check for valid numeric barcode inside OCR text if visual decoder didn't detect bars
    let effectiveBarcode = item.barcodeDetected;
    if (!effectiveBarcode && text) {
      const textBarcodeMatch = text.match(/\b(621\d{10}|\d{13}|\d{12}|\d{8})\b/);
      if (textBarcodeMatch) {
        effectiveBarcode = textBarcodeMatch[1];
      }
    }

    const profile = parseMedicineText(text);
    item.parsedProfile = profile;

    if (!text && !effectiveBarcode) {
      item.status = 'ready';
      item.candidates = [];
      item.classification = 'UNKNOWN MEDICINE';
      item.confidenceTier = 'UNRECOGNIZED';
      item.conflicts = ['لم يتم العثور على نص واضح أو باركود على العبوة'];
      item.selectedMedicine = null;
      return;
    }

    const candidates = matchMedicineText(profile, catalogue, effectiveBarcode)
      .slice(0, 6)
      .map((c) => ({ ...c, safeToAutoSelect: false }));
    item.candidates = candidates;

    const evalResult = this.classifyMatch(candidates, text, effectiveBarcode);
    item.classification = evalResult.classification;
    item.confidenceTier = mapMatchClassificationToUiTier(evalResult.classification);
    item.reasons = evalResult.reasons;
    item.conflicts = evalResult.conflicts;
    // Keep ranked matches as suggestions; never auto-select before pharmacist review.
    item.selectedMedicine = null;
    item.status = 'ready';
  }

  /**
   * Adds an item from a Web Blob capture and runs Barcode-First + independent OCR.
   */
  public async addWebCapture(
    image: Blob | File,
    catalogue: MedicineCatalogueEntry[]
  ): Promise<BatchMedicineItem> {
    const itemId = 'batch-item-' + (++this.sequenceCounter);
    const thumbUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(image)
      : '';
    const item: BatchMedicineItem = {
      id: itemId,
      captureId: itemId,
      captureMode: 'SEQUENTIAL',
      sequenceNumber: this.sequenceCounter,
      capturedAt: new Date().toISOString(),
      thumbnailUrl: thumbUrl,
      sourceImageBlob: image,
      status: 'processing',
      ocrText: '',
      candidates: [],
      selectedMedicine: null,
      classification: 'NEEDS REVIEW',
      confidenceTier: 'PROBABLE',
      reasons: [],
      conflicts: [],
      isDuplicateInSession: false,
      duplicateCount: 1,
      duplicateItemIds: [],
      isConfirmed: false,
      isManuallyReviewed: false,
      isIgnored: false,
      cartActionStatus: 'idle',
      cartAddedQty: 0,
      inventoryActionStatus: 'idle',
      inventoryAddedQty: 0
    };

    const sessionId = this.sessionId;
    const generation = this.sessionGeneration;
    const t0 = nowMs();
    this.items.push(item);

    try {
      if (!image || image.size <= 0) {
        throw new Error('الصورة الملتقطة فارغة أو غير صالحة');
      }

      // Initiate OCR synchronously before awaiting helpers (preserves sync promise test hooks)
      const ocrPromise = medicineTextRecognitionService.recognizeWebImage(image);
      const barcodePromise = staticImageBarcodeService.decodeFromImage(image).catch(() => null);
      const dataUrlPromise = blobToDataUrlSafe(image).catch(() => undefined);

      const [ocrResult, barcodeResult, dataUrl] = await Promise.all([ocrPromise, barcodePromise, dataUrlPromise]);
      if (!this.isCurrentSessionItem(sessionId, generation, item)) {
        item.status = 'cancelled';
        return item;
      }

      if (dataUrl) {
        item.imageBase64 = dataUrl;
      }

      const text = String(ocrResult?.text || '').trim();
      item.processingDurationMs = Math.round(nowMs() - t0);
      this.applyRecognitionOutcome(
        item,
        text,
        catalogue,
        barcodeResult?.barcode,
        barcodeResult?.format
      );
    } catch (err: any) {
      if (!this.isCurrentSessionItem(sessionId, generation, item)) {
        item.status = 'cancelled';
        return item;
      }
      item.status = 'failed';
      item.processingDurationMs = Math.round(nowMs() - t0);
      item.errorMessage = err?.message || 'فشل في قراءة صورة العبوة';
      item.classification = 'UNKNOWN MEDICINE';
      item.confidenceTier = 'UNRECOGNIZED';
      item.conflicts = [item.errorMessage || 'خطأ غير محدد'];
    } finally {
      if (this.isCurrentSessionItem(sessionId, generation, item)) {
        this.recalculateSessionDuplicates();
        void this.persistIfEnabled();
      }
    }

    return item;
  }

  /**
   * Mode A Non-Blocking Queue Capture:
   * Immediately inserts the captured item into the session as 'queued' (with preview thumbnail)
   * and returns/resolves when processed in a sequential background FIFO worker so the user can
   * keep adding new photos without waiting for previous OCR jobs to finish.
   */
  public enqueueWebCapture(
    image: Blob | File,
    catalogueOrProvider: MedicineCatalogueEntry[] | (() => MedicineCatalogueEntry[]),
    onUpdate?: () => void
  ): { item: BatchMedicineItem; completion: Promise<BatchMedicineItem> } {
    const catalogueProvider = typeof catalogueOrProvider === 'function'
      ? catalogueOrProvider
      : () => catalogueOrProvider;

    const itemId = 'batch-item-' + (++this.sequenceCounter);
    const thumbUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(image)
      : '';

    const item: BatchMedicineItem = {
      id: itemId,
      captureId: itemId,
      captureMode: 'SEQUENTIAL',
      sequenceNumber: this.sequenceCounter,
      capturedAt: new Date().toISOString(),
      thumbnailUrl: thumbUrl,
      sourceImageBlob: image,
      status: 'queued',
      ocrText: '',
      candidates: [],
      selectedMedicine: null,
      classification: 'NEEDS REVIEW',
      confidenceTier: 'PROBABLE',
      reasons: [],
      conflicts: [],
      isDuplicateInSession: false,
      duplicateCount: 1,
      duplicateItemIds: [],
      isConfirmed: false,
      isManuallyReviewed: false,
      isIgnored: false,
      cartActionStatus: 'idle',
      cartAddedQty: 0,
      inventoryActionStatus: 'idle',
      inventoryAddedQty: 0
    };

    const sessionId = this.sessionId;
    const generation = this.sessionGeneration;
    this.items.push(item);

    // Pre-encode base64 in background so session survives immediate reload even while queued
    void blobToDataUrlSafe(image).then((dataUrl) => {
      if (dataUrl && this.isCurrentSessionItem(sessionId, generation, item)) {
        item.imageBase64 = dataUrl;
        void this.persistIfEnabled();
      }
    });

    if (onUpdate) {
      try { onUpdate(); } catch { /* ignore */ }
    }

    const completion = new Promise<BatchMedicineItem>((resolve) => {
      this.captureQueue.push({
        item,
        sessionId,
        generation,
        catalogueProvider,
        onUpdate,
        resolve
      });
      void this.drainCaptureQueue();
    });

    return { item, completion };
  }

  private async drainCaptureQueue(): Promise<void> {
    if (this.isQueueWorkerRunning) return;
    this.isQueueWorkerRunning = true;

    try {
      while (this.captureQueue.length > 0) {
        const job = this.captureQueue.shift();
        if (!job) continue;

        const { item, sessionId, generation, catalogueProvider, onUpdate, resolve } = job;
        if (!this.isCurrentSessionItem(sessionId, generation, item) || item.status === 'cancelled') {
          item.status = 'cancelled';
          resolve(item);
          continue;
        }

        const t0 = nowMs();
        item.status = 'processing';
        if (onUpdate) {
          try { onUpdate(); } catch { /* ignore */ }
        }

        try {
          if (!item.sourceImageBlob || item.sourceImageBlob.size <= 0) {
            throw new Error('الصورة الملتقطة فارغة أو غير صالحة');
          }

          const barcodeResult = await staticImageBarcodeService.decodeFromImage(item.sourceImageBlob).catch(() => null);
          const ocrResult = await medicineTextRecognitionService.recognizeWebImage(item.sourceImageBlob);

          if (!this.isCurrentSessionItem(sessionId, generation, item)) {
            item.status = 'cancelled';
            resolve(item);
            continue;
          }

          if (!item.imageBase64) {
            item.imageBase64 = await blobToDataUrlSafe(item.sourceImageBlob);
          }

          const text = String(ocrResult?.text || '').trim();
          const catalogue = catalogueProvider();
          item.processingDurationMs = Math.round(nowMs() - t0);
          this.applyRecognitionOutcome(
            item,
            text,
            catalogue,
            barcodeResult?.barcode,
            barcodeResult?.format
          );
        } catch (err: any) {
          if (!this.isCurrentSessionItem(sessionId, generation, item)) {
            item.status = 'cancelled';
            resolve(item);
            continue;
          }
          item.status = 'failed';
          item.processingDurationMs = Math.round(nowMs() - t0);
          item.errorMessage = err?.message || 'فشل في قراءة صورة العبوة';
          item.classification = 'UNKNOWN MEDICINE';
          item.confidenceTier = 'UNRECOGNIZED';
          item.conflicts = [item.errorMessage || 'خطأ غير محدد'];
        } finally {
          if (this.isCurrentSessionItem(sessionId, generation, item)) {
            this.recalculateSessionDuplicates();
            void this.persistIfEnabled();
          }
          if (onUpdate) {
            try { onUpdate(); } catch { /* ignore */ }
          }
          resolve(item);
        }
      }
    } finally {
      this.isQueueWorkerRunning = false;
    }
  }

  /**
   * Captures an item using Android native camera and runs Barcode-First + independent ML Kit OCR.
   * Enforces camera mutex lock to avoid CameraX collisions.
   */
  public async addNativeCapture(
    catalogue: MedicineCatalogueEntry[]
  ): Promise<BatchMedicineItem | null> {
    const lockId = 'native-batch-cap-' + (++this.cameraLockSequence);
    if (!this.acquireCameraLock(lockId)) {
      throw new Error('الكاميرا قيد الاستخدام في عملية أخرى. يرجى الانتظار.');
    }

    const itemId = 'batch-item-' + (++this.sequenceCounter);
    const item: BatchMedicineItem = {
      id: itemId,
      captureMode: 'SEQUENTIAL',
      sequenceNumber: this.sequenceCounter,
      capturedAt: new Date().toISOString(),
      status: 'processing',
      ocrText: '',
      candidates: [],
      selectedMedicine: null,
      classification: 'NEEDS REVIEW',
      confidenceTier: 'PROBABLE',
      reasons: [],
      conflicts: [],
      isDuplicateInSession: false,
      duplicateCount: 1,
      duplicateItemIds: [],
      isConfirmed: false,
      isManuallyReviewed: false,
      isIgnored: false,
      cartActionStatus: 'idle',
      cartAddedQty: 0,
      inventoryActionStatus: 'idle',
      inventoryAddedQty: 0
    };

    const sessionId = this.sessionId;
    const generation = this.sessionGeneration;
    const t0 = nowMs();
    this.items.push(item);

    try {
      const result = await medicineTextRecognitionService.captureAndRecognize();
      if (!this.isCurrentSessionItem(sessionId, generation, item)) {
        item.status = 'cancelled';
        return item;
      }
      if (result.cancelled) {
        this.removeItem(itemId);
        return null;
      }
      if (!result.imageBase64 || !result.imageBase64.startsWith('data:image/')) {
        throw new Error('لم يتم استلام الصورة الأصلية؛ تم رفض نتيجة OCR لحماية تطابق الصورة والبيانات');
      }
      item.captureId = result.captureId || itemId;
      item.imageBase64 = result.imageBase64;
      item.thumbnailUrl = result.imageBase64;

      // Barcode-First check on the captured native still image
      const barcodeResult = await staticImageBarcodeService.decodeFromImage(result.imageBase64).catch(() => null);
      if (!this.isCurrentSessionItem(sessionId, generation, item)) {
        item.status = 'cancelled';
        return item;
      }

      const text = String(result.text || '').trim();
      item.processingDurationMs = Math.round(nowMs() - t0);
      this.applyRecognitionOutcome(
        item,
        text,
        catalogue,
        barcodeResult?.barcode,
        barcodeResult?.format
      );
    } catch (err: any) {
      if (!this.isCurrentSessionItem(sessionId, generation, item)) {
        item.status = 'cancelled';
        return item;
      }
      item.status = 'failed';
      item.processingDurationMs = Math.round(nowMs() - t0);
      item.errorMessage = err?.message || 'فشل في تشغيل الكاميرا أو التعرف على الصورة';
      item.classification = 'UNKNOWN MEDICINE';
      item.confidenceTier = 'UNRECOGNIZED';
      item.conflicts = [item.errorMessage || 'خطأ غير محدد'];
    } finally {
      this.releaseCameraLock(lockId);
      if (this.isCurrentSessionItem(sessionId, generation, item)) {
        this.recalculateSessionDuplicates();
        void this.persistIfEnabled();
      }
    }

    return item;
  }

  /**
   * Retries Barcode-First + OCR for a specific item (re-processes same image).
   */
  public async reprocessItem(
    itemId: string,
    catalogue: MedicineCatalogueEntry[]
  ): Promise<BatchMedicineItem> {
    const item = this.getItem(itemId);
    if (!item) throw new Error(`العنصر غير موجود: ${itemId}`);
    if (!item.sourceImageBlob && !item.imageBase64) {
      throw new Error('لا توجد بيانات صورة لإعادة المعالجة');
    }

    const sessionId = this.sessionId;
    const generation = this.sessionGeneration;
    const t0 = nowMs();
    item.status = 'processing';
    item.errorMessage = undefined;
    item.isManuallyReviewed = false;
    item.isConfirmed = false;

    try {
      const imageInput = item.sourceImageBlob || item.imageBase64;
      const barcodePromise = staticImageBarcodeService.decodeFromImage(imageInput).catch(() => null);
      const ocrPromise = item.sourceImageBlob
        ? medicineTextRecognitionService.recognizeWebImage(item.sourceImageBlob)
        : medicineTextRecognitionService.recognizeStillImage(item.imageBase64!);

      const [ocr, barcodeResult] = await Promise.all([ocrPromise, barcodePromise]);
      const text = String(ocr?.text || '').trim();

      if (!this.isCurrentSessionItem(sessionId, generation, item)) {
        item.status = 'cancelled';
        return item;
      }

      item.processingDurationMs = Math.round(nowMs() - t0);
      this.applyRecognitionOutcome(
        item,
        text,
        catalogue,
        barcodeResult?.barcode,
        barcodeResult?.format
      );
    } catch (err: any) {
      if (!this.isCurrentSessionItem(sessionId, generation, item)) {
        item.status = 'cancelled';
        return item;
      }
      item.status = 'failed';
      item.processingDurationMs = Math.round(nowMs() - t0);
      item.errorMessage = err?.message || 'فشلت إعادة المعالجة';
      item.confidenceTier = 'UNRECOGNIZED';
    } finally {
      if (this.isCurrentSessionItem(sessionId, generation, item)) {
        this.recalculateSessionDuplicates();
        void this.persistIfEnabled();
      }
    }

    return item;
  }

  /**
   * Re-parses and re-matches an item after manual pharmacist text or barcode edit
   * without losing the image or resetting action history if still same medicine.
   */
  public reparseEditedItemText(
    itemId: string,
    editedText: string,
    catalogue: MedicineCatalogueEntry[],
    editedBarcode?: string
  ): BatchMedicineItem | null {
    const item = this.getItem(itemId);
    if (!item || item.status === 'processing' || item.status === 'queued') return null;

    const cleanBarcode = editedBarcode !== undefined
      ? String(editedBarcode || '').trim() || undefined
      : item.barcodeDetected;

    item.barcodeDetected = cleanBarcode;
    item.selectedMedicine = null;
    item.isManuallyReviewed = false;
    item.isConfirmed = false;
    item.errorMessage = undefined;
    this.applyRecognitionOutcome(item, String(editedText || '').trim(), catalogue, cleanBarcode, item.barcodeFormat);
    this.recalculateSessionDuplicates();
    void this.persistIfEnabled();
    return item;
  }

  /**
   * Updates a batch item's active cropped image and re-runs Barcode-First + OCR in-place
   * while preserving the session and the uncropped original photo for re-cropping.
   */
  public async updateItemCroppedImage(
    itemId: string,
    croppedImageDataUrl: string,
    catalogue: MedicineCatalogueEntry[],
    croppedBlob?: Blob
  ): Promise<BatchMedicineItem> {
    const item = this.getItem(itemId);
    if (!item) throw new Error(`العنصر غير موجود: ${itemId}`);
    if (item.status === 'processing' || item.status === 'queued') {
      throw new Error('العنصر قيد المعالجة حالياً. يرجى الانتظار قليلاً.');
    }
    if (typeof croppedImageDataUrl !== 'string' || !croppedImageDataUrl.startsWith('data:image/')) {
      throw new Error('صورة القص غير صالحة');
    }

    if (!item.originalSourceBlob && item.sourceImageBlob) {
      item.originalSourceBlob = item.sourceImageBlob;
    }
    if (!item.originalImageBase64 && item.imageBase64) {
      item.originalImageBase64 = item.imageBase64;
    }
    if (!item.originalThumbnailUrl && item.thumbnailUrl) {
      item.originalThumbnailUrl = item.thumbnailUrl;
    } else if (
      item.thumbnailUrl &&
      item.thumbnailUrl !== item.originalThumbnailUrl &&
      item.thumbnailUrl.startsWith('blob:')
    ) {
      try { URL.revokeObjectURL(item.thumbnailUrl); } catch { /* ignore */ }
    }

    let resolvedBlob = croppedBlob;
    if (!resolvedBlob && typeof atob === 'function') {
      const parts = croppedImageDataUrl.split(',');
      const mime = parts[0]?.match(/:(.*?);/)?.[1] || 'image/jpeg';
      const raw = atob(parts[1] || '');
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i);
      }
      resolvedBlob = new Blob([bytes], { type: mime });
    }

    item.thumbnailUrl = croppedImageDataUrl;
    item.imageBase64 = croppedImageDataUrl;
    if (resolvedBlob) {
      item.sourceImageBlob = resolvedBlob;
    }

    return this.reprocessItem(itemId, catalogue);
  }

  /**
   * Manually selects a clean candidate from this item's reviewed candidate list.
   * Preserves strict clinical safety invariants: only candidates in item.candidates
   * with zero conflicts and candidate/verified status are allowed.
   */
  public manuallySelectMedicine(itemId: string, medicine: MedicineCatalogueEntry): boolean {
    const item = this.getItem(itemId);
    if (
      !item || item.status !== 'ready' ||
      typeof medicine?.id !== 'string' || medicine.id.trim().length === 0
    ) return false;

    const candidate = Array.isArray(item.candidates)
      ? item.candidates.find((entry) =>
          typeof entry?.medicine?.id === 'string' &&
          entry.medicine.id === medicine.id &&
          typeof entry.medicine.name === 'string' && entry.medicine.name.trim().length > 0 &&
          (entry.status === 'candidate' || entry.status === 'verified') &&
          Array.isArray(entry.conflicts) &&
          entry.conflicts.length === 0
        )
      : undefined;
    if (!candidate) return false;

    item.selectedMedicine = candidate.medicine;
    item.classification = 'VERIFIED MATCH';
    item.confidenceTier = 'VERIFIED';
    item.conflicts = [];
    item.isManuallyReviewed = true;
    item.isConfirmed = false;
    item.isIgnored = false;
    item.reasons = ['تم اختيار الصنف ومراجعته يدوياً بواسطة الصيدلي'];
    this.recalculateSessionDuplicates();
    void this.persistIfEnabled();
    return true;
  }

  /**
   * Explicit pharmacist assignment from active-branch full catalogue search
   * (used when OCR failed to rank the right candidate or the user searches directly in the branch catalogue).
   */
  public manuallyAssignCatalogueMedicine(itemId: string, medicine: MedicineCatalogueEntry): boolean {
    const item = this.getItem(itemId);
    if (
      !item ||
      item.status === 'processing' ||
      item.status === 'queued' ||
      item.status === 'cancelled' ||
      typeof medicine?.id !== 'string' || !medicine.id.trim() ||
      typeof medicine?.name !== 'string' || !medicine.name.trim()
    ) return false;

    const cleanEntry: MedicineCatalogueEntry = {
      id: String(medicine.id),
      name: String(medicine.name).trim(),
      barcode: typeof medicine.barcode === 'string' ? medicine.barcode : undefined,
      secondaryBarcodes: Array.isArray(medicine.secondaryBarcodes) ? [...medicine.secondaryBarcodes] : undefined
    };

    item.status = 'ready';
    item.errorMessage = undefined;
    item.selectedMedicine = cleanEntry;
    item.classification = 'VERIFIED MATCH';
    item.confidenceTier = 'VERIFIED';
    item.conflicts = [];
    item.isManuallyReviewed = true;
    item.isConfirmed = false;
    item.isIgnored = false;
    item.reasons = ['تم اختيار الدواء يدوياً من كتالوج الفرع بواسطة الصيدلي'];
    this.recalculateSessionDuplicates();
    void this.persistIfEnabled();
    return true;
  }

  /**
   * Links a newly saved catalogue medicine strictly back to its reviewed capture item.
   */
  public linkSavedMedicine(itemId: string, medicine: MedicineCatalogueEntry): boolean {
    const item = this.getItem(itemId);
    if (
      !item || item.status !== 'ready' ||
      (item.suggestionStatus !== 'under_review' && item.suggestionStatus !== 'saved') ||
      !item.thumbnailUrl || !item.captureId ||
      typeof medicine?.id !== 'string' || !medicine.id.trim() ||
      typeof medicine?.name !== 'string' || !medicine.name.trim()
    ) return false;

    item.selectedMedicine = {
      id: medicine.id,
      name: medicine.name,
      barcode: typeof medicine.barcode === 'string' ? medicine.barcode : undefined
    };
    item.classification = 'VERIFIED MATCH';
    item.confidenceTier = 'VERIFIED';
    item.conflicts = [];
    item.isManuallyReviewed = true;
    item.isConfirmed = false;
    item.isIgnored = false;
    item.suggestionStatus = 'linked';
    item.suggestedMedicineId = medicine.id;
    item.reasons = ['تم حفظ الدواء وربطه بعنصر الالتقاط الأصلي'];
    this.recalculateSessionDuplicates();
    void this.persistIfEnabled();
    return true;
  }

  public setItemConfirmation(itemId: string, isConfirmed: boolean): void {
    const item = this.getItem(itemId);
    if (!item) return;
    if (!isConfirmed) {
      item.isConfirmed = false;
      void this.persistIfEnabled();
      return;
    }
    if (
      item.status === 'ready' &&
      item.selectedMedicine &&
      item.classification === 'VERIFIED MATCH' &&
      item.isManuallyReviewed === true &&
      item.conflicts.length === 0
    ) {
      item.isConfirmed = true;
      void this.persistIfEnabled();
    }
  }

  public setItemIgnored(itemId: string, ignored: boolean): void {
    const item = this.getItem(itemId);
    if (!item) return;
    item.isIgnored = ignored;
    if (ignored) {
      item.isConfirmed = false;
    }
    this.recalculateSessionDuplicates();
    void this.persistIfEnabled();
  }

  public markAddedToCart(itemId: string, qtyDelta: number = 1): void {
    const item = this.getItem(itemId);
    if (!item || !item.selectedMedicine) return;
    item.cartActionStatus = 'added';
    item.cartAddedQty = (item.cartAddedQty || 0) + Math.max(1, qtyDelta);
    item.lastCartAddedAt = new Date().toISOString();
    item.isConfirmed = true;
    void this.persistIfEnabled();
  }

  public markAddedToInventory(
    itemId: string,
    qtyAdded: number,
    unit: 'pack' | 'strip' | 'pill',
    ledgerMovementId: string
  ): void {
    const item = this.getItem(itemId);
    if (!item || !item.selectedMedicine) return;
    item.inventoryActionStatus = 'added';
    item.inventoryAddedQty = (item.inventoryAddedQty || 0) + Math.max(0, qtyAdded);
    item.inventoryAddedUnit = unit;
    item.inventoryLedgerMovementId = ledgerMovementId;
    item.lastInventoryAddedAt = new Date().toISOString();
    item.isConfirmed = true;
    void this.persistIfEnabled();
  }

  /**
   * Bulk confirmation is intentionally disabled by clinical safety policy.
   * Each medicine requires an independent, explicit pharmacist review.
   */
  public confirmAllEligibleItems(): number {
    return 0;
  }

  /**
   * Removes an individual item from the session and cleans up object URLs.
   */
  public removeItem(itemId: string): boolean {
    const idx = this.items.findIndex((item) => item.id === itemId);
    if (idx === -1) return false;

    const [removed] = this.items.splice(idx, 1);
    removed.status = 'cancelled';
    if (removed.thumbnailUrl && removed.thumbnailUrl.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(removed.thumbnailUrl);
      } catch {
        // ignore
      }
    }
    if (removed.originalThumbnailUrl && removed.originalThumbnailUrl !== removed.thumbnailUrl && removed.originalThumbnailUrl.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(removed.originalThumbnailUrl);
      } catch {
        // ignore
      }
    }
    this.recalculateSessionDuplicates();
    void this.persistIfEnabled();
    return true;
  }

  /**
   * Cancels and destroys the entire batch session.
   * Frees all object URLs and clears persisted IndexedDB metadata snapshot.
   */
  public cancelSession(): void {
    for (const item of this.items) {
      if (item.thumbnailUrl && item.thumbnailUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(item.thumbnailUrl); } catch { /* cleanup is best-effort */ }
      }
      if (item.originalThumbnailUrl && item.originalThumbnailUrl !== item.thumbnailUrl && item.originalThumbnailUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(item.originalThumbnailUrl); } catch { /* cleanup is best-effort */ }
      }
    }
    while (this.captureQueue.length > 0) {
      const pending = this.captureQueue.shift();
      if (pending) {
        pending.item.status = 'cancelled';
        pending.resolve(pending.item);
      }
    }
    this.sessionGeneration++;
    this.items = [];
    this.originalImages = [];
    this.sequenceCounter = 0;
    this.sessionId = '';
    this.sessionActive = false;
    if (this.autoPersistEnabled) {
      void clearBatchCaptureSessionState();
    }
  }

  /**
   * Exports a clean, JSON-serializable snapshot for IndexedDB persistence without non-cloneable Blobs.
   */
  public exportPersistableSession(branchIdOverride?: string): PersistedBatchCaptureSessionRecord | null {
    if (!this.sessionActive || !this.sessionId) return null;
    const persistableItems = this.items.map((item) => {
      const {
        sourceImageBlob: _dropBlob,
        originalSourceBlob: _dropOrigBlob,
        ...rest
      } = item;
      const safeThumb = rest.thumbnailUrl && !rest.thumbnailUrl.startsWith('blob:')
        ? rest.thumbnailUrl
        : rest.imageBase64;
      const safeOrigThumb = rest.originalThumbnailUrl && !rest.originalThumbnailUrl.startsWith('blob:')
        ? rest.originalThumbnailUrl
        : rest.originalImageBase64;
      return {
        ...rest,
        thumbnailUrl: safeThumb,
        originalThumbnailUrl: safeOrigThumb
      };
    });

    return {
      version: 2,
      sessionId: this.sessionId,
      mode: this.captureMode,
      branchId: branchIdOverride || this.branchId || getActiveBranchId() || 'default',
      sequenceCounter: this.sequenceCounter,
      createdAt: this.sessionCreatedAt,
      updatedAt: new Date().toISOString(),
      originalImages: this.originalImages.map((img) => ({ ...img })),
      items: persistableItems
    };
  }

  /**
   * Restores a persisted session into memory cleanly after page reload or offline restart.
   * Any item that was interrupted mid-OCR (`queued`/`processing`) is marked recoverable (`failed`)
   * with its preserved image data so the user can retry without losing photos.
   */
  public hydrateFromPersistedSession(record: PersistedBatchCaptureSessionRecord | null): boolean {
    if (!record || !record.sessionId || !Array.isArray(record.items)) return false;

    this.cancelSession();
    this.sessionGeneration++;
    this.sessionId = record.sessionId;
    this.captureMode = record.mode === 'UNIFIED_IMAGE' ? 'UNIFIED_IMAGE' : 'SEQUENTIAL';
    this.branchId = record.branchId || getActiveBranchId() || 'default';
    this.sessionCreatedAt = record.createdAt || new Date().toISOString();
    this.sequenceCounter = Number(record.sequenceCounter) || record.items.length;
    this.originalImages = Array.isArray(record.originalImages) ? record.originalImages.map((img) => ({ ...img })) : [];
    this.sessionActive = true;

    this.items = record.items.map((raw) => {
      const interrupted = raw.status === 'processing' || raw.status === 'queued';
      const restoredImage = raw.imageBase64 || (raw.thumbnailUrl && !String(raw.thumbnailUrl).startsWith('blob:') ? raw.thumbnailUrl : undefined);
      const restoredOrigImage = raw.originalImageBase64 || (raw.originalThumbnailUrl && !String(raw.originalThumbnailUrl).startsWith('blob:') ? raw.originalThumbnailUrl : undefined);
      return {
        ...raw,
        thumbnailUrl: restoredImage,
        imageBase64: restoredImage,
        originalThumbnailUrl: restoredOrigImage,
        originalImageBase64: restoredOrigImage,
        status: interrupted ? 'failed' : raw.status,
        errorMessage: interrupted
          ? 'انقطعت المعالجة عند إغلاق الصفحة — اضغط «إعادة القراءة» لاستئناف تحليل الصورة المحفوظة'
          : raw.errorMessage,
        confidenceTier: raw.confidenceTier || mapMatchClassificationToUiTier(raw.classification || 'UNKNOWN MEDICINE')
      };
    });

    this.recalculateSessionDuplicates();
    return true;
  }

  public async persistNow(branchIdOverride?: string): Promise<boolean> {
    const snap = this.exportPersistableSession(branchIdOverride);
    if (!snap || snap.items.length === 0) {
      return clearBatchCaptureSessionState();
    }
    return saveBatchCaptureSessionState(snap);
  }

  public async restoreFromPersistence(): Promise<boolean> {
    const record = await loadBatchCaptureSessionState();
    if (!record || record.items.length === 0) return false;
    return this.hydrateFromPersistedSession(record);
  }

  private async persistIfEnabled(): Promise<void> {
    if (!this.autoPersistEnabled) return;
    try {
      await this.persistNow();
    } catch {
      // Best-effort persistence; never break capture flows
    }
  }

  public getSessionSummary(): BatchSessionSummary {
    let queuedCount = 0;
    let readyCount = 0;
    let failedCount = 0;
    let processingCount = 0;
    let verifiedCount = 0;
    let possibleCount = 0;
    let needsReviewCount = 0;
    let conflictCount = 0;
    let unknownCount = 0;
    let ignoredCount = 0;
    let duplicateAlertCount = 0;
    let confirmedCount = 0;
    let cartAddedCount = 0;
    let inventoryAddedCount = 0;

    for (const item of this.items) {
      if (item.status === 'queued') queuedCount++;
      if (item.status === 'ready') readyCount++;
      if (item.status === 'failed') failedCount++;
      if (item.status === 'processing') processingCount++;
      if (item.isIgnored) ignoredCount++;
      if (item.isConfirmed) confirmedCount++;
      if (item.isDuplicateInSession) duplicateAlertCount++;
      if (item.cartActionStatus === 'added') cartAddedCount++;
      if (item.inventoryActionStatus === 'added') inventoryAddedCount++;

      switch (item.classification) {
        case 'VERIFIED MATCH':
          verifiedCount++;
          break;
        case 'POSSIBLE MATCH':
          possibleCount++;
          break;
        case 'NEEDS REVIEW':
          needsReviewCount++;
          break;
        case 'CONFLICT':
          conflictCount++;
          break;
        case 'UNKNOWN MEDICINE':
          unknownCount++;
          break;
      }
    }

    return {
      sessionId: this.sessionId,
      mode: this.captureMode,
      createdAt: this.sessionCreatedAt,
      totalItems: this.items.length,
      queuedItems: queuedCount,
      readyItems: readyCount,
      failedItems: failedCount,
      processingItems: processingCount,
      verifiedCount,
      possibleCount,
      needsReviewCount,
      conflictCount,
      unknownCount,
      ignoredCount,
      duplicateAlertCount,
      confirmedCount,
      cartAddedCount,
      inventoryAddedCount
    };
  }
}

export const batchCaptureService = new BatchCaptureService();
