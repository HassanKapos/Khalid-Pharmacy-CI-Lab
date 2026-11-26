import {
  SupplierInvoiceDraft,
  OcrPageImage,
  OcrInvoiceItem,
  OcrInvoiceHeader,
  OcrInvoiceAudit,
  OcrDraftApprovalEvidence,
  ConfidenceLevel,
  MatchCategory
} from '../types/supplierInvoiceOcr';
import {
  Medicine,
  Supplier,
  PurchaseInvoice,
  approveOcrPurchaseDraft,
  postOcrPurchaseInvoice,
  saveSupplierInvoiceDraft,
  getSupplierInvoiceDraft,
  getAllSupplierInvoiceDrafts,
  deleteSupplierInvoiceDraft,
  checkSupplierInvoiceDuplicate,
  findDraftByImageHash,
  getTrustedActorSessionState,
  isTrustedSessionExpired,
  isValidFirebaseActorUid,
  UnitKind,
  getAllMedicines,
  getAllSuppliers,
  type TrustedActorSessionState
} from './pharmacyDb';
import {
  validateOcrItemMedicineIdentity,
  type OcrPurchasePaymentType
} from './ocrPurchaseCanonical';
import {
  addRational,
  compareRational,
  createRational,
  formatRationalForDisplay,
  multiplyRational,
  subtractRational,
  type Rational
} from './exactFinance';
import { parseExactDecimal } from './exactInventoryCosting';
import { matchItemWithMedicines, matchSupplier } from './supplierInvoiceMatcher';
import { apiClient } from './apiClient';
import { reverifyCurrentPharmacySession } from './firebaseAuthService';
import { getFirebaseServices, isBrowserOffline, isFirebaseConfigured } from './firebaseClient';

const OCR_POSTING_GUARD_PREFIX = 'OCR_POSTING_REQUIRES_RECONCILIATION:';

const OCR_APPROVAL_ERROR_MESSAGES_AR: Record<string, string> = {
  OCR_AUTH_OFFLINE_FORBIDDEN:
    'يتطلب اعتماد أو ترحيل فاتورة المشتريات اتصالاً نشطاً بالإنترنت وجلسة مسؤول موثقة.',
  OCR_AUTH_NOT_AUTHENTICATED:
    'يرجى تسجيل الدخول بحساب مسؤول موثق (Admin أو Super Admin) قبل الاعتماد أو الترحيل.',
  OCR_AUTH_UNTRUSTED_SESSION:
    'جلسة المستخدم الحالية غير موثقة أو تحتوي على معرّف مستخدم غير صالح.',
  OCR_AUTH_EMAIL_NOT_VERIFIED:
    'يجب تأكيد البريد الإلكتروني لحساب المسؤول قبل اعتماد أو ترحيل فواتير OCR.',
  OCR_AUTH_SESSION_EXPIRED:
    'انتهت صلاحية جلسة المسؤول؛ يرجى إعادة تسجيل الدخول والمحاولة مجدداً.',
  OCR_AUTH_OFFLINE_FALLBACK_FORBIDDEN:
    'لا يُسمح باعتماد أو ترحيل فواتير OCR في وضع عدم الاتصال.',
  OCR_AUTH_BRANCH_UNAUTHORIZED:
    'حسابك غير مصرح له باعتماد أو ترحيل الفواتير على الفرع النشط حالياً.',
  OCR_APPROVAL_CASHIER_FORBIDDEN:
    'لا يملك الكاشير صلاحية اعتماد أو ترحيل فواتير مشتريات OCR؛ يقتصر ذلك على Admin أو Super Admin.',
  OCR_APPROVAL_UNAUTHORIZED_ROLE:
    'يقتصر اعتماد وترحيل فواتير OCR على دوري Admin أو Super Admin الموثقين فقط.',
  OCR_DRAFT_NOT_VERIFIED:
    'يجب اعتماد الفاتورة صراحةً (VERIFIED) أولاً قبل ترحيلها إلى المخزون وحساب المورد.',
  OCR_APPROVAL_EVIDENCE_MISSING:
    'وثيقة الاعتماد مفقودة على المسودة؛ يرجى الضغط على "اعتماد الفاتورة" أولاً.',
  OCR_APPROVAL_EVIDENCE_TAMPERED:
    'تم رصد تعارض في بيانات الاعتماد المحفوظة؛ يرجى إعادة المراجعة والاعتماد.',
  OCR_APPROVAL_STATUS_NOT_APPROVED:
    'حالة الموافقة غير مكتملة؛ يرجى إعادة اعتماد الفاتورة.',
  OCR_APPROVAL_VERSION_UNSUPPORTED:
    'إصدار وثيقة الاعتماد قديم أو غير مدعوم؛ يرجى إعادة اعتماد الفاتورة.',
  OCR_APPROVAL_INVALID_ACTOR_UID:
    'معرّف المسؤول الذي اعتمد الفاتورة غير صالح.',
  OCR_APPROVAL_ACTOR_MISMATCH:
    'المستخدم الذي اعتمد الفاتورة يختلف عن المستخدم النشط حالياً؛ يجب إعادة الاعتماد قبل الترحيل.',
  OCR_APPROVAL_ROLE_MISMATCH:
    'تغيرت صلاحية المستخدم منذ الاعتماد؛ يرجى إعادة اعتماد الفاتورة.',
  OCR_APPROVAL_BRANCH_MISMATCH:
    'تم اعتماد الفاتورة على فرع مختلف عن الفرع النشط حالياً.',
  OCR_APPROVAL_INVALIDATED_BY_EDIT:
    'تم تعديل بيانات الفاتورة بعد الاعتماد، مما أبطل الموافقة السابقة. يرجى إعادة الاعتماد ثم الترحيل.',
  OCR_APPROVAL_HASH_MISMATCH_INVALIDATED:
    'تغير محتوى الفاتورة أو بيانات الأصناف بعد الاعتماد ولم تعد البصمة المعتمدة مطابقة. يرجى إعادة الاعتماد.',
  OCR_APPROVAL_UNIT_CONFIG_CHANGED:
    'تغير تعريف وحدات أحد الأصناف بعد اعتماد الفاتورة؛ أُبطل الاعتماد السابق ويجب إعادة المراجعة والاعتماد.',
  OCR_APPROVAL_PAYMENT_INTENT_MISMATCH:
    'طريقة الدفع أو المبلغ المدفوع المطلوب للترحيل لا يطابق ما تم اعتماده؛ يرجى إعادة الاعتماد.',
  OCR_APPROVAL_STALE_DRAFT_CONFLICT:
    'تم تعديل المسودة في تبويب أو جلسة أخرى. تم تحديث البيانات؛ يرجى المراجعة وإعادة الاعتماد.',
  OCR_CALLER_APPROVAL_PARAMS_FORBIDDEN:
    'تم رفض الطلب لمحاولته تمرير بيانات اعتماد غير موثقة خارج مسار الاعتماد الرسمي.',
  OCR_POSTING_ACTOR_UID_MISMATCH:
    'معرّف منفذ الترحيل لا يطابق الجلسة الموثقة النشطة.',
  OCR_DIRECT_APPROVAL_WRITE_FORBIDDEN:
    'لا يُسمح بكتابة حالة الاعتماد مباشرة؛ يجب استخدام إجراء الاعتماد الرسمي.',
  OCR_MISSING_OR_ZERO_SUBTOTAL:
    'الإجمالي الفرعي للفاتورة مفقود أو صفري؛ يرجى مراجعته وإدخاله صراحةً قبل الاعتماد.',
  OCR_MISSING_OR_ZERO_FINAL_TOTAL:
    'صافي الفاتورة المطبوع مفقود أو صفري؛ يرجى مراجعته وإدخاله صراحةً قبل الاعتماد.',
  OCR_RECONCILIATION_OVERRIDE_FORBIDDEN:
    'لا يُسمح بالتجاوز المالي عند وجود فارق حسابي؛ يجب مطابقة مجموع الأصناف والإجمالي بدقة.',
  HEADER_TOTAL_MISMATCH:
    'صافي الفاتورة المطبوع لا يساوي (الإجمالي الفرعي − خصم الفاتورة).',
  SUBTOTAL_LINE_SUM_MISMATCH:
    'مجموع إجماليات البنود لا يطابق الإجمالي الفرعي للفاتورة.',
  LINE_TOTAL_MISMATCH:
    'إجمالي أحد البنود لا يطابق (الكمية × سعر الشراء − خصم البند).',
  INVALID_QUANTITY:
    'الكمية غير صالحة أو مفقودة؛ يجب إدخال كمية صحيحة أكبر من الصفر لكل بند.',
  INVALID_BUY_PRICE:
    'سعر الشراء مفقود أو غير صالح؛ يجب إدخال سعر شراء أكبر من الصفر لكل بند.',
  INVALID_LINE_TOTAL:
    'إجمالي البند مفقود أو غير صالح؛ يجب التحقق منه وإدخاله بدقة.',
  INVALID_ITEM_DISCOUNT:
    'قيمة خصم البند غير صالحة أو تتجاوز إجمالي البند.',
  UNSUPPORTED_ITEM_UNIT:
    'وحدة الشراء مفقودة أو غير معتمدة؛ يرجى اختيار وحدة صالحة (Pack / Strip / Pill).',
  OCR_MISSING_MEDICINE_IDENTITY:
    'هوية الدواء غير مكتملة (التركيز أو الشكل الصيدلاني مفقود)؛ يجب استكمالها والتحقق منها قبل الاعتماد.',
  OCR_MEDICINE_STRENGTH_MISMATCH:
    'تعارض في تركيز الدواء (Strength) بين الفاتورة والدواء المربوط في الدليل؛ يرجى تصحيح الربط.',
  OCR_MEDICINE_CONCENTRATION_MISMATCH:
    'تعارض في تركيز المحلول/الشراب بين الفاتورة والدواء المربوط في الدليل؛ يرجى تصحيح الربط.',
  OCR_MEDICINE_DOSAGE_FORM_MISMATCH:
    'تعارض في الشكل الصيدلاني (مثل شراب مقابل أقراص) بين الفاتورة والدواء المربوط في الدليل.',
  OCR_MEDICINE_RELEASE_TYPE_MISMATCH:
    'تعارض في نمط الإطلاق الدوائي (مثل XR / SR مقابل عادي) بين الفاتورة والدواء المربوط في الدليل.',
  OCR_MEDICINE_VARIANT_MISMATCH:
    'تعارض في صيغة الدواء (مثل Forte / Plus / Pediatric) بين الفاتورة والدواء المربوط في الدليل.',
  OCR_MEDICINE_PACKAGE_SIZE_MISMATCH:
    'تعارض في حجم أو عدد وحدات العبوة بين الفاتورة والدواء المربوط في الدليل.',
  OCR_MEDICINE_MATCH_UNCONFIRMED:
    'يجب تأكيد ربط جميع الأصناف مع دليل الأدوية يدوياً قبل الاعتماد أو الترحيل؛ المطابقة التلقائية غير كافية.',
  OCR_MISSING_VERIFIED_UNIT_DEFINITION:
    'أحد الأصناف لا يملك تعريف وحدات موثق ومعتمد (VERIFIED)؛ يرجى اعتماد تكوين وحدات الدواء أولاً.',
  OCR_UNVERIFIED_UNIT_DEFINITION:
    'تعريف وحدات أحد الأصناف غير معتمد (VERIFIED).'
};

export function formatOcrApprovalError(err: unknown): { code: string; message: string } {
  const rawMessage = err instanceof Error ? err.message : String(err || 'OCR_UNKNOWN_ERROR');
  const codeMatch = rawMessage.match(/^([A-Z][A-Z0-9_]+)/);
  const code = codeMatch ? codeMatch[1] : 'OCR_OPERATION_FAILED';
  const mappedMessage = OCR_APPROVAL_ERROR_MESSAGES_AR[code];
  if (mappedMessage) {
    return { code, message: mappedMessage };
  }
  return { code, message: rawMessage };
}

/**
 * Clears any persisted human approval evidence from an in-memory draft and
 * downgrades VERIFIED drafts back to NEEDS_REVIEW when content changes.
 */
export function invalidateOcrDraftApproval<T extends object>(draft: T): T {
  if (!draft || typeof draft !== 'object') return draft;
  const mutableDraft = draft as {
    status?: string;
    approval?: unknown;
    approvedBy?: unknown;
    approvedByRole?: unknown;
    approvedAt?: unknown;
    approvedCanonicalHash?: unknown;
    approvedBranchId?: unknown;
    approvalStatus?: unknown;
    approvalVersion?: unknown;
  };
  if (mutableDraft.status === 'VERIFIED') {
    mutableDraft.status = 'NEEDS_REVIEW';
  }
  delete mutableDraft.approval;
  delete mutableDraft.approvedBy;
  delete mutableDraft.approvedByRole;
  delete mutableDraft.approvedAt;
  delete mutableDraft.approvedCanonicalHash;
  delete mutableDraft.approvedBranchId;
  delete mutableDraft.approvalStatus;
  delete mutableDraft.approvalVersion;
  return draft;
}

/**
 * Performs live Firebase session re-verification when a Firebase Auth user is active
 * in the browser, then validates the resulting trusted Admin/Super Admin session in pharmacyDb.
 */
async function ensureLiveTrustedAdminSessionForOcr(): Promise<TrustedActorSessionState> {
  if (isBrowserOffline()) {
    throw new Error(
      'OCR_AUTH_OFFLINE_FORBIDDEN: يتطلب اعتماد وترحيل فواتير OCR اتصالاً نشطاً بالإنترنت.'
    );
  }

  if (typeof window !== 'undefined' && isFirebaseConfigured()) {
    let hasFirebaseUser = false;
    try {
      const { auth } = getFirebaseServices();
      hasFirebaseUser = Boolean(auth?.currentUser);
    } catch {
      hasFirebaseUser = false;
    }

    if (hasFirebaseUser) {
      const reverified = await reverifyCurrentPharmacySession();
      if (!reverified) {
        throw new Error(
          'OCR_AUTH_NOT_AUTHENTICATED: تعذر التحقق من جلسة المسؤول الحالية؛ يرجى إعادة تسجيل الدخول.'
        );
      }
    }
  }

  const session = getTrustedActorSessionState();
  if (!session) {
    throw new Error(
      'OCR_AUTH_NOT_AUTHENTICATED: لا توجد جلسة مستخدم موثقة من Firebase Authentication.'
    );
  }
  if (!isValidFirebaseActorUid(session.uid)) {
    throw new Error('OCR_AUTH_UNTRUSTED_SESSION: معرّف المستخدم الموثق غير صالح.');
  }
  if (session.emailVerified !== true) {
    throw new Error('OCR_AUTH_EMAIL_NOT_VERIFIED: البريد الإلكتروني للحساب غير موثق.');
  }
  if (isTrustedSessionExpired(session)) {
    throw new Error('OCR_AUTH_SESSION_EXPIRED: انتهت صلاحية الجلسة؛ يرجى إعادة تسجيل الدخول.');
  }
  if (session.offlineFallback === true) {
    throw new Error(
      'OCR_AUTH_OFFLINE_FALLBACK_FORBIDDEN: لا يُسمح باعتماد أو ترحيل فواتير OCR عبر جلسة غير متصلة.'
    );
  }
  if (session.role === 'cashier') {
    throw new Error(
      'OCR_APPROVAL_CASHIER_FORBIDDEN: لا يملك الكاشير صلاحية اعتماد أو ترحيل فواتير مشتريات OCR.'
    );
  }
  if (session.role !== 'admin' && session.role !== 'super_admin') {
    throw new Error(
      'OCR_APPROVAL_UNAUTHORIZED_ROLE: يقتصر اعتماد وترحيل فواتير OCR على دوري Admin أو Super Admin الموثقين فقط.'
    );
  }
  return session;
}

export type ApproveOcrDraftServiceResult =
  | {
      readonly success: true;
      readonly draft: SupplierInvoiceDraft;
      readonly approval: OcrDraftApprovalEvidence;
      readonly canonicalHash: string;
    }
  | {
      readonly success: false;
      readonly errorCode: string;
      readonly errorMessage: string;
    };

/**
 * R13-D.1: Independent human approval service action.
 * Re-verifies live Firebase Admin/Super Admin session, computes the canonical snapshot
 * including unitSnapshots inside an atomic DB transaction, persists VERIFIED status
 * and approval evidence on the draft WITHOUT posting to inventory or supplier balances.
 */
export async function approveOcrDraftForPosting(
  draftId: string,
  options?: {
    readonly paymentType?: OcrPurchasePaymentType;
    readonly paidAmount?: number | string;
    readonly expectedUpdatedAt?: string;
  }
): Promise<ApproveOcrDraftServiceResult> {
  try {
    await ensureLiveTrustedAdminSessionForOcr();
    const storedDraft: any = await getSupplierInvoiceDraft(draftId);
    if (storedDraft && typeof storedDraft === 'object') {
      const rawHeaderDiscount =
        storedDraft.extractedDiscount !== undefined
          ? storedDraft.extractedDiscount
          : storedDraft.header?.discount;
      if (
        !isAbsentOrEmptyMonetaryInput(rawHeaderDiscount) &&
        parseStrictNonNegativeDecimalOrNull(rawHeaderDiscount) === null
      ) {
        throw new Error('OCR_INVALID_SUBTOTAL_OR_DISCOUNT: قيمة خصم الفاتورة غير صالحة.');
      }
      if (Array.isArray(storedDraft.items)) {
        for (let i = 0; i < storedDraft.items.length; i += 1) {
          const it = storedDraft.items[i];
          const rawItemDisc =
            it?.itemDiscount !== undefined ? it.itemDiscount : (it?.lineDiscount ?? it?.discount);
          if (
            !isAbsentOrEmptyMonetaryInput(rawItemDisc) &&
            parseStrictNonNegativeDecimalOrNull(rawItemDisc) === null
          ) {
            throw new Error(`INVALID_ITEM_DISCOUNT: items[${i}] قيمة خصم الصنف غير صالحة.`);
          }
          const rawSell = it?.suggestedSellPrice;
          if (
            !isAbsentOrEmptyMonetaryInput(rawSell) &&
            parseStrictPositiveDecimalOrNull(rawSell) === null
          ) {
            throw new Error(`INVALID_SUGGESTED_SELL_PRICE: items[${i}] سعر البيع المقترح غير صالح.`);
          }
        }
      }
    }
    const approved = await approveOcrPurchaseDraft({
      ocrDraftId: draftId,
      paymentType: options?.paymentType,
      paidAmount: options?.paidAmount,
      expectedUpdatedAt: options?.expectedUpdatedAt
    });
    return {
      success: true,
      draft: approved.draft,
      approval: approved.approval,
      canonicalHash: approved.canonicalHash
    };
  } catch (err) {
    const formatted = formatOcrApprovalError(err);
    return {
      success: false,
      errorCode: formatted.code,
      errorMessage: formatted.message
    };
  }
}

/**
 * Generate SHA-256 hash in browser using crypto.subtle
 */
export async function computeImageSha256(dataUrlOrBuffer: string | ArrayBuffer): Promise<string> {
  let buffer: ArrayBuffer;
  if (typeof dataUrlOrBuffer === 'string') {
    const base64Part = dataUrlOrBuffer.split(',')[1] || dataUrlOrBuffer;
    const binary = atob(base64Part);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    buffer = bytes.buffer;
  } else {
    buffer = dataUrlOrBuffer;
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Rotate image by 90, 180, 270 degrees using client-side canvas
 */
export function rotateImageCanvas(dataUrl: string, degrees: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }

      const rads = (degrees * Math.PI) / 180;
      const isOrthogonal = Math.abs(degrees % 180) === 90;

      canvas.width = isOrthogonal ? img.height : img.width;
      canvas.height = isOrthogonal ? img.width : img.height;

      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(rads);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);

      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * Read and optimize image for OCR & local storage
 * Caps dimension at 2048px for sharp text without bloated storage
 */
export function processInputImageFile(file: File): Promise<{
  dataUrl: string;
  imageHash: string;
  width: number;
  height: number;
  fileName: string;
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const originalDataUrl = e.target?.result as string;
      const img = new Image();
      img.onload = async () => {
        const MAX_DIM = 2048;
        let width = img.width;
        let height = img.height;

        if (width > MAX_DIM || height > MAX_DIM) {
          if (width > height) {
            height = Math.round((height * MAX_DIM) / width);
            width = MAX_DIM;
          } else {
            width = Math.round((width * MAX_DIM) / height);
            height = MAX_DIM;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          const hash = await computeImageSha256(originalDataUrl);
          resolve({
            dataUrl: originalDataUrl,
            imageHash: hash,
            width: img.width,
            height: img.height,
            fileName: file.name
          });
          return;
        }

        // Draw image with smooth bilinear scaling
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        const optimizedDataUrl = canvas.toDataURL('image/jpeg', 0.9);
        const imageHash = await computeImageSha256(optimizedDataUrl);

        resolve({
          dataUrl: optimizedDataUrl,
          imageHash,
          width,
          height,
          fileName: file.name
        });
      };
      img.onerror = reject;
      img.src = originalDataUrl;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function unwrapField(field: unknown): unknown {
  if (field && typeof field === 'object' && 'value' in (field as Record<string, unknown>)) {
    return (field as { value: unknown }).value;
  }
  return field;
}

function isAbsentOrEmptyMonetaryInput(raw: unknown): boolean {
  const val = unwrapField(raw);
  return val === undefined || val === null || (typeof val === 'string' && val.trim() === '');
}

function normalizeUnsignedBase10DecimalString(raw: string): {
  readonly negative: boolean;
  readonly normalized: string;
  readonly isZero: boolean;
} | null {
  const trimmed = raw.trim();
  if (!trimmed || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
    return null;
  }
  const negative = trimmed.startsWith('-');
  let unsigned = trimmed.replace(/^[+-]/, '');
  if (unsigned.startsWith('.')) {
    unsigned = `0${unsigned}`;
  }
  if (unsigned.endsWith('.')) {
    unsigned = unsigned.slice(0, -1);
  }
  const dotIdx = unsigned.indexOf('.');
  const rawWhole = dotIdx >= 0 ? unsigned.slice(0, dotIdx) : unsigned;
  const fracPart = dotIdx >= 0 ? unsigned.slice(dotIdx + 1) : '';
  if (fracPart.length > 8) {
    return null;
  }
  const wholePart = rawWhole.replace(/^0+(?=\d)/, '') || '0';
  const normalized = fracPart.length > 0 ? `${wholePart}.${fracPart}` : wholePart;
  const isZero = /^0(?:\.0*)?$/.test(normalized);
  return { negative, normalized, isZero };
}

function parseStrictPositiveDecimalOrNull(raw: unknown): number | string | null {
  const val = unwrapField(raw);
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return null;
    const parsedNum = normalizeUnsignedBase10DecimalString(String(val));
    if (!parsedNum || parsedNum.negative || parsedNum.isZero) return null;
    return val;
  }
  if (typeof val !== 'string') return null;
  const parsed = normalizeUnsignedBase10DecimalString(val);
  if (!parsed || parsed.negative || parsed.isZero) return null;
  return parsed.normalized;
}

function parseStrictPositiveIntOrNull(raw: unknown): number | null {
  const val = unwrapField(raw);
  if (val === undefined || val === null || val === '') return null;
  const num = typeof val === 'number' ? val : Number(String(val).trim());
  if (!Number.isSafeInteger(num) || num <= 0) return null;
  return num;
}

function parseStrictNonNegativeNumberOrNull(raw: unknown): number | null {
  const val = unwrapField(raw);
  if (val === undefined || val === null || val === '') return null;
  const num = typeof val === 'number' ? val : Number(String(val).trim());
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

function parseStrictNonNegativeDecimalOrNull(raw: unknown): number | string | null {
  const val = unwrapField(raw);
  if (val === undefined || val === null || val === '') return null;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val < 0) return null;
    const parsedNum = normalizeUnsignedBase10DecimalString(String(val));
    if (!parsedNum || parsedNum.negative) return null;
    return Object.is(val, -0) ? 0 : val;
  }
  if (typeof val !== 'string') return null;
  const parsed = normalizeUnsignedBase10DecimalString(val);
  if (!parsed) return null;
  if (parsed.negative) return null;
  if (parsed.isZero) return '0';
  return parsed.normalized;
}

function parseOrPreserveNonNegativeDecimalOrZeroDefault(raw: unknown): number | string {
  if (isAbsentOrEmptyMonetaryInput(raw)) {
    return '0';
  }
  const parsed = parseStrictNonNegativeDecimalOrNull(raw);
  if (parsed !== null) {
    return parsed;
  }
  const val = unwrapField(raw);
  return typeof val === 'string' ? val.trim() : String(val);
}

function parseOrPreserveOptionalPositiveDecimal(raw: unknown): number | string | null {
  if (isAbsentOrEmptyMonetaryInput(raw)) {
    return null;
  }
  const parsed = parseStrictPositiveDecimalOrNull(raw);
  if (parsed !== null) {
    return parsed;
  }
  const val = unwrapField(raw);
  return typeof val === 'string' ? val.trim() : String(val);
}

function tryParseExactRational(raw: unknown, fieldName: string): Rational | null {
  const val = unwrapField(raw);
  if (val === undefined || val === null || val === '') return null;
  try {
    const str =
      typeof val === 'number'
        ? Number.isFinite(val)
          ? String(val)
          : ''
        : String(val).trim();
    if (!str) return null;
    return parseExactDecimal(str, fieldName);
  } catch {
    return null;
  }
}

function rationalToDisplayNumberSafe(value: Rational): number {
  const formatted = formatRationalForDisplay(value, { decimals: 2, roundingMode: 'HALF_UP' });
  return formatted.displayNumber ?? Number(formatted.formatted);
}

/**
 * Pure exact rational helper for UI row entry: computes (quantity * unitBuyPrice - itemDiscount)
 * without premature float rounding. Preserves exact decimal strings for high-precision/high-magnitude values.
 */
export function computeExactOcrLineTotal(
  quantity: unknown,
  unitBuyPrice: unknown,
  itemDiscount?: unknown
): number | string | null {
  const qtyExact = tryParseExactRational(quantity, 'quantity');
  const priceExact = tryParseExactRational(unitBuyPrice, 'unitBuyPrice');
  if (!qtyExact || !priceExact) return null;
  const zero = createRational(0n);
  if (compareRational(qtyExact, zero) <= 0 || compareRational(priceExact, zero) <= 0) return null;
  const discExact =
    itemDiscount === undefined || itemDiscount === null || itemDiscount === ''
      ? zero
      : tryParseExactRational(itemDiscount, 'itemDiscount');
  if (!discExact || compareRational(discExact, zero) < 0) return null;
  const gross = multiplyRational(qtyExact, priceExact);
  if (compareRational(discExact, gross) > 0) return null;
  const net = subtractRational(gross, discExact);
  const display = formatRationalForDisplay(net, { decimals: 8, roundingMode: 'HALF_UP' });
  const trimmed = display.formatted.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed) && String(parsed) === trimmed) {
    return parsed;
  }
  return trimmed;
}

/**
 * Create a blank new draft instance (zero unsafe numeric defaults)
 */
export function createEmptySupplierInvoiceDraft(): SupplierInvoiceDraft {
  const now = new Date().toISOString();
  return {
    id: 'DRAFT-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 7),
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
    pages: [],
    header: {
      supplierName: { value: '', confidence: 'HIGH' },
      invoiceNumber: { value: '', confidence: 'HIGH' },
      invoiceDate: { value: now.split('T')[0], confidence: 'HIGH' },
      subtotal: { value: null, confidence: 'UNREADABLE' },
      discount: { value: 0, confidence: 'HIGH' },
      tax: { value: 0, confidence: 'HIGH' },
      finalTotal: { value: null, confidence: 'UNREADABLE' },
      currency: { value: 'SDG', confidence: 'HIGH' }
    },
    items: [],
    audit: {
      calculatedItemsTotal: 0,
      calculatedItemsTotalExact: '0.00',
      difference: 0,
      differenceExact: '0.00',
      subtotalDifference: 0,
      subtotalDifferenceExact: '0.00',
      isReconciled: false,
      hasIncompleteFields: true,
      excludedTaxAmount: 0
    }
  };
}

/**
 * Recalculate invoice reconciliation totals using strict Exact Rational Arithmetic.
 * R13-D.2 & R13-D.3 guarantees:
 * - Zero Tax participation (legacy/OCR tax is excluded from math and NEVER rejects an invoice).
 * - Zero 0.05 tolerance and zero financial override bypasses.
 * - Zero silent subtotal or lineTotal derivation.
 * - Per-item discount + proportional invoice discount validated without double discounting.
 */
export function reconcileInvoiceTotals(draft: SupplierInvoiceDraft): OcrInvoiceAudit {
  const recon = calculateReconciliation(draft);

  draft.audit = {
    calculatedItemsTotal: recon.calculatedTotal,
    calculatedItemsTotalExact: recon.calculatedTotalExact,
    difference: recon.difference,
    differenceExact: recon.differenceExact,
    subtotalDifference: recon.subtotalDifference,
    subtotalDifferenceExact: recon.subtotalDifferenceExact,
    isReconciled: recon.isBalanced,
    hasIncompleteFields: recon.hasIncompleteFields,
    excludedTaxAmount: recon.excludedTaxAmount
  };

  return draft.audit;
}

/**
 * Submit draft pages to Gemini OCR Vision API endpoint
 */
export async function executeOcrExtraction(
  draft: SupplierInvoiceDraft,
  allMedicines: Medicine[],
  allSuppliers: Supplier[],
  options?: {
    onProgress?: (msg: string) => void;
  }
): Promise<SupplierInvoiceDraft> {
  if (draft.status === 'PROCESSING' && draft.errorMessage?.startsWith(OCR_POSTING_GUARD_PREFIX)) {
    throw new Error('هذه المسودة في حالة ترحيل غير محسومة. لا يمكن إعادة تشغيل OCR أو تغيير حالتها قبل مطابقتها مع سجل فواتير الشراء.');
  }

  if (draft.status === 'POSTED' || draft.postedInvoiceId) {
    throw new Error('هذه المسودة مرتبطة بفاتورة مرحّلة بالفعل. لا يمكن إعادة تشغيل OCR عليها.');
  }

  if (!draft.pages || draft.pages.length === 0) {
    throw new Error('يرجى تصوير أو إضافة صفحة واحدة على الأقل للفاتورة قبل بدء المعالجة');
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('خدمة الذكاء الاصطناعي (OCR) تتطلب اتصالاً بالإنترنت. تم حفظ المسودة والصور محلياً، ويمكنك إعادة المحاولة عند عودة الاتصال.');
  }

  if (options?.onProgress) {
    options.onProgress(`جاري إرسال ${draft.pages.length} صفحة لخدمة الذكاء الاصطناعي...`);
  }

  // Check duplicate image hash before sending (Layer 1)
  for (const page of draft.pages) {
    const existingDraft = await findDraftByImageHash(page.imageHash, draft.id);
    if (existingDraft) {
      draft.duplicateWarning = {
        type: 'IMAGE_HASH',
        message: `تم العثور على صورة مطابقة تماماً في المسودة/الفاتورة (${existingDraft.id.slice(0, 8)}).`,
        existingId: existingDraft.id
      };
      break;
    }
  }

  // Format payload for backend proxy
  const payloadPages = draft.pages.map(p => ({
    pageNumber: p.pageNumber,
    imageBase64: p.dataUrl,
    rotation: p.rotation || 0
  }));

  // Compact medicine catalog context for enhanced grounding
  const compactCatalog = allMedicines.slice(0, 300).map(m => ({
    name: m.name,
    category: m.category,
    barcode: m.barcode,
    buyPrice: m.buyPrice
  }));

  const result = await apiClient.post<{ success: boolean; data: any; error?: string }>(
    '/api/supplier-invoice/ocr',
    {
      draftId: draft.id,
      pages: payloadPages,
      medicinesCatalog: compactCatalog
    },
    {
      timeoutMs: 90000 // Invoices with multiple pages can require extended OCR processing time
    }
  );

  const rawData = result?.data || {};

  if (options?.onProgress) {
    options.onProgress('جاري مطابقة الأصناف والمورد مع قاعدة بيانات الصيدلية...');
  }

  // 1. Process Header (strict: zero silent defaults for subtotal/finalTotal; tax retained as non-participating metadata only)
  const rawH = rawData.header || {};
  const parsedSubtotal = parseStrictPositiveDecimalOrNull(rawH.subtotal);
  const parsedDiscount = parseStrictNonNegativeDecimalOrNull(rawH.discount);
  const parsedRawTax = parseStrictNonNegativeNumberOrNull(rawH.tax);
  const parsedFinalTotal = parseStrictPositiveDecimalOrNull(rawH.finalTotal);

  draft.header = {
    supplierName: {
      value: String(unwrapField(rawH.supplierName) || '').trim(),
      confidence: (rawH.supplierName?.confidence as ConfidenceLevel) || 'MEDIUM',
      rawText: rawH.supplierName?.rawText
    },
    invoiceNumber: {
      value: String(unwrapField(rawH.invoiceNumber) || '').trim(),
      confidence: (rawH.invoiceNumber?.confidence as ConfidenceLevel) || 'MEDIUM',
      rawText: rawH.invoiceNumber?.rawText
    },
    invoiceDate: {
      value: String(unwrapField(rawH.invoiceDate) || '').trim(),
      confidence: unwrapField(rawH.invoiceDate)
        ? ((rawH.invoiceDate?.confidence as ConfidenceLevel) || 'MEDIUM')
        : 'UNREADABLE',
      rawText: rawH.invoiceDate?.rawText
    },
    taxNumber: {
      value: String(unwrapField(rawH.taxNumber) || '').trim(),
      confidence: (rawH.taxNumber?.confidence as ConfidenceLevel) || 'LOW',
      rawText: rawH.taxNumber?.rawText
    },
    subtotal: {
      value: parsedSubtotal,
      confidence: parsedSubtotal !== null
        ? ((rawH.subtotal?.confidence as ConfidenceLevel) || 'MEDIUM')
        : 'UNREADABLE'
    },
    discount: {
      value: parsedDiscount ?? 0,
      confidence: (rawH.discount?.confidence as ConfidenceLevel) || 'HIGH'
    },
    tax: {
      value: parsedRawTax ?? 0,
      confidence: (rawH.tax?.confidence as ConfidenceLevel) || 'HIGH'
    },
    finalTotal: {
      value: parsedFinalTotal,
      confidence: parsedFinalTotal !== null
        ? ((rawH.finalTotal?.confidence as ConfidenceLevel) || 'HIGH')
        : 'UNREADABLE'
    },
    currency: {
      value: String(unwrapField(rawH.currency) || 'SDG').trim() || 'SDG',
      confidence: 'HIGH'
    }
  };

  // Match supplier if found in existing catalog
  if (draft.header.supplierName.value) {
    const matchedSup = matchSupplier(draft.header.supplierName.value, allSuppliers);
    if (matchedSup.matchedSupplierId) {
      draft.header.matchedSupplierId = matchedSup.matchedSupplierId;
    }
  }

  // 2. Process Items with Strict Medicine Identity & Zero Unsafe Defaults (R13-D.3)
  const rawItems = Array.isArray(rawData.items) ? rawData.items : [];
  const processedItems: OcrInvoiceItem[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const ri = rawItems[i] || {};
    const tradeNameVal = String(unwrapField(ri.tradeName) || '').trim();
    const genericNameVal = String(unwrapField(ri.genericName) || '').trim();
    const strengthVal = String(unwrapField(ri.strength) || '').trim();
    const dosageFormVal = String(unwrapField(ri.dosageForm) || '').trim();
    const releaseTypeVal = String(unwrapField(ri.releaseType) || '').trim();
    const concentrationVal = String(unwrapField(ri.concentration) || '').trim();
    const packageSizeVal = String(unwrapField(ri.packageSize) || '').trim();
    const barcodeVal = String(unwrapField(ri.barcode) || '').trim();
    const quantityVal = parseStrictPositiveIntOrNull(ri.quantity);
    const normalizedUnit = normalizeCanonicalUnitInput(ri.unit);
    const unitVal: UnitKind | '' =
      normalizedUnit === 'pack' || normalizedUnit === 'strip' || normalizedUnit === 'pill'
        ? normalizedUnit
        : '';
    const unitBuyPriceVal = parseStrictPositiveDecimalOrNull(ri.unitBuyPrice);
    const itemDiscountVal = parseStrictNonNegativeDecimalOrNull(
      ri.itemDiscount ?? ri.lineDiscount ?? ri.discount
    );
    const lineTotalVal = parseStrictPositiveDecimalOrNull(ri.lineTotal);
    const suggestedSellPriceVal = parseStrictPositiveDecimalOrNull(ri.suggestedSellPrice);
    const batchNumberVal = String(unwrapField(ri.batchNumber) || '').trim();
    const expiryDateVal = String(unwrapField(ri.expiryDate) || '').trim();

    // Run catalog match, then enforce R13-D.3 strict medicine identity compatibility gate
    const rawMatch = matchItemWithMedicines(
      {
        tradeName: tradeNameVal,
        genericName: genericNameVal,
        strength: strengthVal,
        dosageForm: dosageFormVal,
        barcode: barcodeVal
      },
      allMedicines
    );

    let finalMatchStatus: MatchCategory = rawMatch.matchStatus;
    let finalMatchedMedicineId = rawMatch.matchedMedicineId;
    let finalMatchedMedicineName = rawMatch.matchedMedicineName;
    let finalMatchScore = rawMatch.matchScore;
    let identityMismatchReason: string | undefined;

    if (finalMatchedMedicineId) {
      const matchedMed = allMedicines.find((m) => m.id === finalMatchedMedicineId);
      if (matchedMed) {
        const identityCheck = validateOcrItemMedicineIdentity(
          {
            tradeName: tradeNameVal,
            strength: strengthVal,
            dosageForm: dosageFormVal,
            releaseType: releaseTypeVal,
            concentration: concentrationVal,
            packageSize: packageSizeVal
          },
          matchedMed,
          { requireExplicitOcrIdentity: false }
        );
        if (!identityCheck.ok) {
          finalMatchStatus = 'NEW';
          finalMatchedMedicineId = undefined;
          finalMatchedMedicineName = undefined;
          finalMatchScore = 0;
          identityMismatchReason = identityCheck.message;
        }
      }
    }

    const itemObj: OcrInvoiceItem = {
      id: 'ITEM-' + (i + 1) + '-' + Math.random().toString(36).substring(2, 6),
      pageNumber: Number(ri.pageNumber) || 1,
      tradeName: {
        value: tradeNameVal,
        confidence: tradeNameVal
          ? ((ri.tradeName?.confidence as ConfidenceLevel) || 'MEDIUM')
          : 'UNREADABLE',
        rawText: ri.tradeName?.rawText
      },
      genericName: genericNameVal
        ? {
            value: genericNameVal,
            confidence: (ri.genericName?.confidence as ConfidenceLevel) || 'MEDIUM'
          }
        : undefined,
      strength: {
        value: strengthVal,
        confidence: strengthVal
          ? ((ri.strength?.confidence as ConfidenceLevel) || 'MEDIUM')
          : 'UNREADABLE'
      },
      dosageForm: {
        value: dosageFormVal,
        confidence: dosageFormVal
          ? ((ri.dosageForm?.confidence as ConfidenceLevel) || 'MEDIUM')
          : 'UNREADABLE'
      },
      releaseType: releaseTypeVal
        ? {
            value: releaseTypeVal,
            confidence: (ri.releaseType?.confidence as ConfidenceLevel) || 'MEDIUM'
          }
        : undefined,
      concentration: concentrationVal
        ? {
            value: concentrationVal,
            confidence: (ri.concentration?.confidence as ConfidenceLevel) || 'MEDIUM'
          }
        : undefined,
      packageSize: packageSizeVal
        ? {
            value: packageSizeVal,
            confidence: (ri.packageSize?.confidence as ConfidenceLevel) || 'MEDIUM'
          }
        : undefined,
      manufacturer: ri.manufacturer?.value
        ? {
            value: ri.manufacturer.value,
            confidence: (ri.manufacturer.confidence as ConfidenceLevel) || 'MEDIUM'
          }
        : undefined,
      barcode: barcodeVal
        ? {
            value: barcodeVal,
            confidence: (ri.barcode?.confidence as ConfidenceLevel) || 'HIGH'
          }
        : undefined,
      quantity: {
        value: quantityVal,
        confidence: quantityVal !== null
          ? ((ri.quantity?.confidence as ConfidenceLevel) || 'HIGH')
          : 'UNREADABLE'
      },
      unit: {
        value: unitVal,
        confidence: unitVal ? ((ri.unit?.confidence as ConfidenceLevel) || 'HIGH') : 'UNREADABLE'
      },
      unitBuyPrice: {
        value: unitBuyPriceVal,
        confidence: unitBuyPriceVal !== null
          ? ((ri.unitBuyPrice?.confidence as ConfidenceLevel) || 'HIGH')
          : 'UNREADABLE'
      },
      itemDiscount: {
        value: itemDiscountVal ?? 0,
        confidence: 'HIGH'
      },
      lineTotal: {
        value: lineTotalVal,
        confidence: lineTotalVal !== null
          ? ((ri.lineTotal?.confidence as ConfidenceLevel) || 'HIGH')
          : 'UNREADABLE'
      },
      suggestedSellPrice: suggestedSellPriceVal !== null
        ? {
            value: suggestedSellPriceVal,
            confidence: (ri.suggestedSellPrice?.confidence as ConfidenceLevel) || 'MEDIUM'
          }
        : undefined,
      batchNumber: {
        value: batchNumberVal,
        confidence: batchNumberVal ? ((ri.batchNumber?.confidence as ConfidenceLevel) || 'MEDIUM') : 'UNREADABLE'
      },
      expiryDate: {
        value: expiryDateVal,
        confidence: expiryDateVal ? ((ri.expiryDate?.confidence as ConfidenceLevel) || 'MEDIUM') : 'UNREADABLE'
      },
      matchStatus: finalMatchStatus,
      matchedMedicineId: finalMatchedMedicineId,
      matchedMedicineName: finalMatchedMedicineName,
      matchScore: finalMatchScore,
      // R13-D.1 B2 & R13-D.3 D4: Automatic catalog matching is NEVER human confirmation.
      isUserConfirmed: false,
      ...(identityMismatchReason ? { identityMismatchReason } : {})
    };

    processedItems.push(itemObj);
  }

  draft.items = processedItems;
  draft.rawOcrText = rawData.rawOcrText || '';

  // 3. Clear any prior approval evidence & reconcile totals
  invalidateOcrDraftApproval(draft);
  reconcileInvoiceTotals(draft);

  // 4. Check Duplicate Invoice Number (Layer 2)
  if (draft.header.matchedSupplierId && draft.header.invoiceNumber.value) {
    const dupCheck = await checkSupplierInvoiceDuplicate(
      draft.header.matchedSupplierId,
      draft.header.invoiceNumber.value,
      draft.id
    );
    if (dupCheck.isDuplicate) {
      draft.duplicateWarning = {
        type: 'INVOICE_NUMBER',
        message: dupCheck.message || `رقم الفاتورة "${draft.header.invoiceNumber.value}" مكرر لهذا المورد.`,
        existingId: dupCheck.existingId || ''
      };
      draft.status = 'DUPLICATE';
    } else {
      draft.status = 'NEEDS_REVIEW';
    }
  } else {
    draft.status = 'NEEDS_REVIEW';
  }

  // 5. Persist to local IndexedDB
  await saveSupplierInvoiceDraft(draft);

  return draft;
}

/**
 * PHASE 4 / R13-D.1 INTEGRATION WITH ATOMIC OCR PURCHASE POSTING ENGINE:
 * Posts an already-approved (VERIFIED) OCR draft through the dedicated atomic 8-store
 * postOcrPurchaseInvoice engine. Actor UID and role are derived strictly from the
 * verified Firebase Auth session — never from display names or default labels.
 */
export async function postOcrDraftAsPurchaseInvoice(
  draft: SupplierInvoiceDraft,
  _deprecatedDisplayName?: string,
  paymentOptions?: {
    readonly paymentType?: OcrPurchasePaymentType;
    readonly paidAmount?: number | string;
    readonly expectedSupplierId?: string;
    readonly expectedCanonicalHash?: string;
    readonly expectedUpdatedAt?: string;
  }
): Promise<PurchaseInvoice> {
  if (!draft || typeof draft !== 'object' || !draft.id) {
    throw new Error('OCR_INVALID_DRAFT: المسودة غير صالحة.');
  }

  if (draft.status === 'PROCESSING' && draft.errorMessage?.startsWith(OCR_POSTING_GUARD_PREFIX)) {
    throw new Error('محاولة ترحيل سابقة بدأت ولم تُحسم حالتها. أوقفنا إعادة المحاولة لمنع تكرار المخزون؛ طابق المسودة مع سجل فواتير الشراء قبل أي إجراء.');
  }

  const trustedSession = await ensureLiveTrustedAdminSessionForOcr();

  const createdInvoice = await postOcrPurchaseInvoice({
    ocrDraftId: draft.id,
    paymentType: paymentOptions?.paymentType,
    paidAmount: paymentOptions?.paidAmount,
    postingActor: trustedSession.uid,
    draftSnapshot: draft,
    expectedSupplierId: paymentOptions?.expectedSupplierId,
    expectedCanonicalHash: paymentOptions?.expectedCanonicalHash ?? draft.approval?.approvedCanonicalHash,
    expectedUpdatedAt: paymentOptions?.expectedUpdatedAt ?? draft.updatedAt
  });

  // Synchronize caller's in-memory draft reference with the already-committed IndexedDB state
  draft.status = 'POSTED';
  draft.errorMessage = undefined;
  draft.postedInvoiceId = createdInvoice.id;
  draft.updatedAt = createdInvoice.createdAt || new Date().toISOString();

  return createdInvoice;
}

export {
  saveSupplierInvoiceDraft,
  getSupplierInvoiceDraft,
  getAllSupplierInvoiceDrafts,
  deleteSupplierInvoiceDraft
};

/**
 * UI Service Wrappers & Reactive Helpers for index.html / Vue
 */

export async function createNewDraft(defaultSupplierId?: string): Promise<any> {
  const now = new Date().toISOString();
  const draftId = 'DRAFT-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 7);
  const draft: any = {
    id: draftId,
    supplierId: defaultSupplierId || '',
    extractedSupplierId: defaultSupplierId || '',
    invoiceNumber: '',
    extractedInvoiceNumber: '',
    invoiceDate: now.split('T')[0],
    extractedInvoiceDate: now.split('T')[0],
    extractedSubtotal: null,
    extractedTotalAmount: null,
    extractedDiscount: 0,
    extractedTax: 0,
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
    pages: [],
    items: [],
    header: {
      supplierName: { value: '', confidence: 'HIGH' },
      invoiceNumber: { value: '', confidence: 'HIGH' },
      invoiceDate: { value: now.split('T')[0], confidence: 'HIGH' },
      subtotal: { value: null, confidence: 'UNREADABLE' },
      discount: { value: 0, confidence: 'HIGH' },
      tax: { value: 0, confidence: 'HIGH' },
      finalTotal: { value: null, confidence: 'UNREADABLE' },
      currency: { value: 'SDG', confidence: 'HIGH' }
    },
    audit: {
      calculatedItemsTotal: 0,
      calculatedItemsTotalExact: '0.00',
      difference: 0,
      differenceExact: '0.00',
      subtotalDifference: 0,
      subtotalDifferenceExact: '0.00',
      isReconciled: false,
      hasIncompleteFields: true,
      excludedTaxAmount: 0
    }
  };
  await saveSupplierInvoiceDraft(draft);
  return draft;
}

export async function loadDrafts(): Promise<any[]> {
  return await getAllSupplierInvoiceDrafts();
}

function normalizeCanonicalUnitInput(rawUnit: unknown): string {
  const value = unwrapField(rawUnit);
  const trimmed = String(value ?? '').trim();
  const lowered = trimmed.toLowerCase();
  if (lowered === 'pack') return 'pack';
  if (lowered === 'strip') return 'strip';
  if (lowered === 'pill') return 'pill';
  return '';
}

function syncUiFlatFieldsIntoCanonicalDraft(draft: any): void {
  if (!draft || typeof draft !== 'object') return;
  if (!draft.header || typeof draft.header !== 'object') {
    draft.header = {
      supplierName: { value: '', confidence: 'HIGH' },
      invoiceNumber: { value: '', confidence: 'HIGH' },
      invoiceDate: { value: new Date().toISOString().split('T')[0], confidence: 'HIGH' },
      subtotal: { value: null, confidence: 'UNREADABLE' },
      discount: { value: 0, confidence: 'HIGH' },
      tax: { value: 0, confidence: 'HIGH' },
      finalTotal: { value: null, confidence: 'UNREADABLE' },
      currency: { value: 'SDG', confidence: 'HIGH' }
    };
  }

  // Strip any legacy financialOverrideReason property from drafts
  if ('financialOverrideReason' in draft) {
    delete draft.financialOverrideReason;
  }

  const supplierId = draft.extractedSupplierId || draft.supplierId || draft.header.matchedSupplierId || '';
  if (supplierId) {
    draft.header.matchedSupplierId = supplierId;
    draft.extractedSupplierId = supplierId;
    draft.supplierId = supplierId;
  } else {
    delete draft.header.matchedSupplierId;
  }

  const invoiceNumber = draft.extractedInvoiceNumber ?? draft.invoiceNumber ?? draft.header.invoiceNumber?.value ?? '';
  draft.header.invoiceNumber = {
    ...(draft.header.invoiceNumber || { confidence: 'HIGH' }),
    value: String(invoiceNumber)
  };
  draft.extractedInvoiceNumber = String(invoiceNumber);
  draft.invoiceNumber = String(invoiceNumber);

  const invoiceDate = draft.extractedInvoiceDate || draft.invoiceDate || draft.header.invoiceDate?.value || '';
  draft.header.invoiceDate = {
    ...(draft.header.invoiceDate || { confidence: 'HIGH' }),
    value: String(invoiceDate)
  };
  draft.extractedInvoiceDate = String(invoiceDate);
  draft.invoiceDate = String(invoiceDate);

  const rawSubtotalSource =
    draft.extractedSubtotal !== undefined ? draft.extractedSubtotal : draft.header.subtotal;
  const subtotalVal = parseOrPreserveOptionalPositiveDecimal(rawSubtotalSource);
  const isSubtotalValid = parseStrictPositiveDecimalOrNull(rawSubtotalSource) !== null;
  draft.header.subtotal = {
    ...(draft.header.subtotal || { confidence: 'HIGH' }),
    value: subtotalVal,
    confidence: isSubtotalValid ? (draft.header.subtotal?.confidence || 'HIGH') : 'UNREADABLE'
  };
  draft.extractedSubtotal = subtotalVal;

  const rawDiscountSource =
    draft.extractedDiscount !== undefined ? draft.extractedDiscount : draft.header.discount;
  const discountVal = parseOrPreserveNonNegativeDecimalOrZeroDefault(rawDiscountSource);
  const isDiscountValid =
    isAbsentOrEmptyMonetaryInput(rawDiscountSource) ||
    parseStrictNonNegativeDecimalOrNull(rawDiscountSource) !== null;
  draft.header.discount = {
    ...(draft.header.discount || { confidence: 'HIGH' }),
    value: discountVal,
    confidence: isDiscountValid ? (draft.header.discount?.confidence || 'HIGH') : 'UNREADABLE'
  };
  draft.extractedDiscount = draft.header.discount.value;

  const taxVal =
    draft.extractedTax !== undefined
      ? parseStrictNonNegativeNumberOrNull(draft.extractedTax)
      : parseStrictNonNegativeNumberOrNull(draft.header.tax);
  draft.header.tax = {
    ...(draft.header.tax || { confidence: 'HIGH' }),
    value: taxVal ?? 0
  };
  draft.extractedTax = draft.header.tax.value;

  const rawFinalTotalSource =
    draft.extractedTotalAmount !== undefined ? draft.extractedTotalAmount : draft.header.finalTotal;
  const finalTotalVal = parseOrPreserveOptionalPositiveDecimal(rawFinalTotalSource);
  const isFinalTotalValid = parseStrictPositiveDecimalOrNull(rawFinalTotalSource) !== null;
  draft.header.finalTotal = {
    ...(draft.header.finalTotal || { confidence: 'HIGH' }),
    value: finalTotalVal,
    confidence: isFinalTotalValid ? (draft.header.finalTotal?.confidence || 'HIGH') : 'UNREADABLE'
  };
  draft.extractedTotalAmount = finalTotalVal;

  if (!draft.paymentType) {
    draft.paymentType = 'Credit';
  }

  if (Array.isArray(draft.items)) {
    draft.items.forEach((it: any, idx: number) => {
      if (!it || typeof it !== 'object') return;
      if (!it.id) {
        it.id = 'ITEM-' + (idx + 1) + '-' + Math.random().toString(36).substring(2, 7);
      }
      const normalizedUnit = normalizeCanonicalUnitInput(it.unit ?? it.purchaseUnit);
      if (it.unit && typeof it.unit === 'object' && 'value' in it.unit) {
        it.unit.value = normalizedUnit;
      } else {
        it.unit = normalizedUnit;
      }
      it.purchaseUnit = normalizedUnit;

      const rawItemDiscSource =
        it.itemDiscount !== undefined ? it.itemDiscount : (it.lineDiscount ?? it.discount);
      const itemDiscountVal = parseOrPreserveNonNegativeDecimalOrZeroDefault(rawItemDiscSource);
      if (it.itemDiscount && typeof it.itemDiscount === 'object' && 'value' in it.itemDiscount) {
        it.itemDiscount.value = itemDiscountVal;
      } else {
        it.itemDiscount = itemDiscountVal;
      }

      if (it.suggestedSellPrice !== undefined) {
        const sellPriceVal = parseOrPreserveOptionalPositiveDecimal(it.suggestedSellPrice);
        if (
          it.suggestedSellPrice &&
          typeof it.suggestedSellPrice === 'object' &&
          'value' in it.suggestedSellPrice
        ) {
          if (sellPriceVal === null) {
            delete it.suggestedSellPrice;
          } else {
            it.suggestedSellPrice.value = sellPriceVal;
          }
        } else {
          it.suggestedSellPrice = sellPriceVal;
        }
      }

      it.isUserConfirmed = it.isUserConfirmed === true;
    });
  }

  const recon = calculateReconciliation(draft);
  draft.audit = {
    calculatedItemsTotal: recon.calculatedTotal,
    calculatedItemsTotalExact: recon.calculatedTotalExact,
    difference: recon.difference,
    differenceExact: recon.differenceExact,
    subtotalDifference: recon.subtotalDifference,
    subtotalDifferenceExact: recon.subtotalDifferenceExact,
    isReconciled: recon.isBalanced,
    hasIncompleteFields: recon.hasIncompleteFields,
    excludedTaxAmount: recon.excludedTaxAmount
  };
}

export async function saveDraft(draft: any): Promise<SupplierInvoiceDraft | null> {
  if (!draft) return null;
  syncUiFlatFieldsIntoCanonicalDraft(draft);
  return await saveSupplierInvoiceDraft(draft);
}

export async function fileToOcrPage(file: File): Promise<any> {
  const processed = await processInputImageFile(file);
  return {
    id: 'PAGE-' + Math.random().toString(36).substring(2, 8),
    pageNumber: 1,
    dataUrl: processed.dataUrl,
    originalImageBase64: processed.dataUrl,
    imageHash: processed.imageHash,
    width: processed.width,
    height: processed.height,
    rotation: 0,
    fileName: processed.fileName
  };
}

export async function rotatePage(page: any, degrees: number = 90): Promise<any> {
  const newRotation = ((page.rotation || 0) + degrees) % 360;
  const rotatedDataUrl = await rotateImageCanvas(page.dataUrl || page.originalImageBase64, degrees);
  const newHash = await computeImageSha256(rotatedDataUrl);
  return {
    ...page,
    dataUrl: rotatedDataUrl,
    originalImageBase64: rotatedDataUrl,
    imageHash: newHash,
    rotation: newRotation
  };
}

/**
 * R13-D.2 & R13-D.3 Exact Rational Reconciliation:
 * - Zero Tax participation (legacy/OCR tax is excluded and never rejects an invoice).
 * - Zero tolerance (exact 0 rational difference only) and zero override bypasses.
 * - Zero silent subtotal or lineTotal derivation.
 * - Validates every line: (quantity * unitBuyPrice - itemDiscount === lineTotal).
 * - Validates invoice: sum(lineTotal) === subtotal AND (subtotal - invoiceDiscount === printedFinalTotal).
 */
export function calculateReconciliation(draft: any): any {
  const zero = createRational(0n);
  const statedExact = tryParseExactRational(
    draft?.extractedTotalAmount !== undefined ? draft.extractedTotalAmount : draft?.header?.finalTotal,
    'finalTotal'
  );
  const subtotalExact = tryParseExactRational(
    draft?.extractedSubtotal !== undefined ? draft.extractedSubtotal : draft?.header?.subtotal,
    'subtotal'
  );
  const rawDiscVal =
    draft?.extractedDiscount !== undefined
      ? unwrapField(draft.extractedDiscount)
      : unwrapField(draft?.header?.discount);
  const parsedDiscountExact = isAbsentOrEmptyMonetaryInput(rawDiscVal)
    ? zero
    : tryParseExactRational(rawDiscVal, 'discount');
  const discountExact =
    parsedDiscountExact && compareRational(parsedDiscountExact, zero) >= 0
      ? parsedDiscountExact
      : null;
  const excludedTaxAmount = parseStrictNonNegativeNumberOrNull(
    draft?.extractedTax ?? draft?.header?.tax
  ) ?? 0;

  const items = Array.isArray(draft?.items) ? draft.items : [];
  let sumLinesExact = zero;
  let hasIncompleteFields = items.length === 0 || !statedExact || !subtotalExact || !discountExact;
  let hasLineTotalMismatch = false;

  if (statedExact && compareRational(statedExact, zero) <= 0) hasIncompleteFields = true;
  if (subtotalExact && compareRational(subtotalExact, zero) <= 0) hasIncompleteFields = true;
  if (discountExact && compareRational(discountExact, zero) < 0) hasIncompleteFields = true;
  if (subtotalExact && discountExact && compareRational(discountExact, subtotalExact) > 0) {
    hasIncompleteFields = true;
  }

  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const qtyExact = tryParseExactRational(it?.quantity, `items[${i}].quantity`);
    const priceExact = tryParseExactRational(it?.unitBuyPrice, `items[${i}].unitBuyPrice`);
    const rawItemDisc = unwrapField(
      it?.itemDiscount !== undefined ? it.itemDiscount : (it?.lineDiscount ?? it?.discount)
    );
    const parsedItemDiscExact = isAbsentOrEmptyMonetaryInput(rawItemDisc)
      ? zero
      : tryParseExactRational(rawItemDisc, `items[${i}].itemDiscount`);
    const itemDiscExact =
      parsedItemDiscExact && compareRational(parsedItemDiscExact, zero) >= 0
        ? parsedItemDiscExact
        : null;
    const lineTotalExact = tryParseExactRational(it?.lineTotal, `items[${i}].lineTotal`);
    const rawSellPrice = unwrapField(it?.suggestedSellPrice);
    const hasPresentSellPrice = !isAbsentOrEmptyMonetaryInput(rawSellPrice);
    const sellPriceExact = hasPresentSellPrice
      ? tryParseExactRational(rawSellPrice, `items[${i}].suggestedSellPrice`)
      : null;
    const isSellPriceValid =
      !hasPresentSellPrice || (sellPriceExact !== null && compareRational(sellPriceExact, zero) > 0);

    if (
      !qtyExact ||
      compareRational(qtyExact, zero) <= 0 ||
      !priceExact ||
      compareRational(priceExact, zero) <= 0 ||
      !itemDiscExact ||
      compareRational(itemDiscExact, zero) < 0 ||
      !lineTotalExact ||
      compareRational(lineTotalExact, zero) <= 0 ||
      !isSellPriceValid
    ) {
      hasIncompleteFields = true;
      if (lineTotalExact && compareRational(lineTotalExact, zero) > 0) {
        sumLinesExact = addRational(sumLinesExact, lineTotalExact);
      }
      continue;
    }

    const grossLineExact = multiplyRational(qtyExact, priceExact);
    if (compareRational(itemDiscExact, grossLineExact) > 0) {
      hasLineTotalMismatch = true;
    } else {
      const expectedLineTotalExact = subtractRational(grossLineExact, itemDiscExact);
      if (compareRational(expectedLineTotalExact, lineTotalExact) !== 0) {
        hasLineTotalMismatch = true;
      }
    }
    sumLinesExact = addRational(sumLinesExact, lineTotalExact);
  }

  const effectiveDiscountExact = discountExact ?? zero;
  const effectiveStatedExact = statedExact ?? zero;
  const effectiveSubtotalExact = subtotalExact ?? zero;

  // Tax is strictly excluded from net calculation and reconciliation!
  const netExact = subtractRational(sumLinesExact, effectiveDiscountExact);
  const diffExact = subtractRational(netExact, effectiveStatedExact);
  const subtotalDiffExact = subtractRational(sumLinesExact, effectiveSubtotalExact);
  const headerNetExact = subtractRational(effectiveSubtotalExact, effectiveDiscountExact);
  const headerNetDiffExact = subtractRational(headerNetExact, effectiveStatedExact);

  const isBalanced =
    !hasIncompleteFields &&
    !hasLineTotalMismatch &&
    compareRational(subtotalDiffExact, zero) === 0 &&
    compareRational(diffExact, zero) === 0 &&
    compareRational(headerNetDiffExact, zero) === 0;

  return {
    statedTotal: statedExact ? rationalToDisplayNumberSafe(statedExact) : 0,
    subtotal: subtotalExact ? rationalToDisplayNumberSafe(subtotalExact) : 0,
    calculatedTotal: rationalToDisplayNumberSafe(sumLinesExact),
    calculatedTotalExact: formatRationalForDisplay(sumLinesExact, { decimals: 2 }).formatted,
    discount: discountExact ? rationalToDisplayNumberSafe(discountExact) : 0,
    tax: 0,
    excludedTaxAmount,
    difference: rationalToDisplayNumberSafe(diffExact),
    differenceExact: formatRationalForDisplay(diffExact, { decimals: 2 }).formatted,
    subtotalDifference: rationalToDisplayNumberSafe(subtotalDiffExact),
    subtotalDifferenceExact: formatRationalForDisplay(subtotalDiffExact, { decimals: 2 }).formatted,
    hasIncompleteFields,
    hasLineTotalMismatch,
    isBalanced
  };
}

export async function processDraftWithOcr(
  draftId: string,
  onProgress?: (msg: string) => void
): Promise<any> {
  const draft = await getSupplierInvoiceDraft(draftId);
  if (!draft) throw new Error('المسودة غير موجودة');

  const allMeds = await getAllMedicines();
  const allSups = await getAllSuppliers();

  if (onProgress) onProgress('جاري فحص الصور وإرسالها للذكاء الاصطناعي...');
  const processed: any = await executeOcrExtraction(draft, allMeds, allSups, { onProgress });

  processed.extractedSupplierId = processed.header?.matchedSupplierId || '';
  processed.supplierId = processed.extractedSupplierId;
  processed.extractedInvoiceNumber = processed.header?.invoiceNumber?.value || '';
  processed.invoiceNumber = processed.extractedInvoiceNumber;
  processed.extractedInvoiceDate = processed.header?.invoiceDate?.value || '';
  processed.invoiceDate = processed.extractedInvoiceDate;
  processed.extractedSubtotal = processed.header?.subtotal?.value ?? null;
  processed.extractedTotalAmount = processed.header?.finalTotal?.value ?? null;
  processed.extractedDiscount = processed.header?.discount?.value ?? 0;
  processed.extractedTax = processed.header?.tax?.value ?? 0;
  processed.paymentType = processed.paymentType || 'Credit';

  processed.items = (processed.items || []).map((it: any) => {
    const tradeName = String(unwrapField(it.tradeName) || '').trim();
    const strength = String(unwrapField(it.strength) || '').trim();
    const dosageForm = String(unwrapField(it.dosageForm) || '').trim();
    const releaseType = String(unwrapField(it.releaseType) || '').trim();
    const concentration = String(unwrapField(it.concentration) || '').trim();
    const packageSize = String(unwrapField(it.packageSize) || '').trim();
    const batchNumber = String(unwrapField(it.batchNumber) || '').trim();
    const expiryDate = String(unwrapField(it.expiryDate) || '').trim();
    const quantity = parseStrictPositiveIntOrNull(it.quantity);
    const unit = normalizeCanonicalUnitInput(it.unit);
    const unitBuyPrice = parseStrictPositiveDecimalOrNull(it.unitBuyPrice);
    const itemDiscount = parseStrictNonNegativeDecimalOrNull(it.itemDiscount) ?? 0;
    const lineTotal = parseStrictPositiveDecimalOrNull(it.lineTotal);
    const suggestedSellPrice = parseStrictPositiveDecimalOrNull(it.suggestedSellPrice);

    return {
      ...it,
      tradeName,
      strength,
      dosageForm,
      releaseType,
      concentration,
      packageSize,
      batchNumber,
      expiryDate,
      quantity,
      unit,
      purchaseUnit: unit,
      unitBuyPrice,
      itemDiscount,
      lineTotal,
      suggestedSellPrice,
      isUserConfirmed: false
    };
  });

  invalidateOcrDraftApproval(processed);
  syncUiFlatFieldsIntoCanonicalDraft(processed);
  await saveSupplierInvoiceDraft(processed);
  return processed;
}

export interface PostDraftToPurchaseInvoiceOptions {
  readonly paymentType?: OcrPurchasePaymentType;
  readonly paidAmount?: number | string;
  readonly expectedSupplierId?: string;
  readonly expectedCanonicalHash?: string;
  readonly expectedUpdatedAt?: string;
}

export async function postDraftToPurchaseInvoice(
  draftId: string,
  optionsOrPaymentType?: OcrPurchasePaymentType | PostDraftToPurchaseInvoiceOptions | string,
  paidAmountOrOptions?: number | string | PostDraftToPurchaseInvoiceOptions
): Promise<PurchaseInvoice & { invoice: PurchaseInvoice; draft: SupplierInvoiceDraft | null }> {
  let paymentType: OcrPurchasePaymentType | undefined;
  let paidAmount: number | string | undefined;
  let expectedSupplierId: string | undefined;
  let expectedCanonicalHash: string | undefined;
  let expectedUpdatedAt: string | undefined;

  if (optionsOrPaymentType && typeof optionsOrPaymentType === 'object') {
    paymentType = optionsOrPaymentType.paymentType;
    paidAmount = optionsOrPaymentType.paidAmount;
    expectedSupplierId = optionsOrPaymentType.expectedSupplierId;
    expectedCanonicalHash = optionsOrPaymentType.expectedCanonicalHash;
    expectedUpdatedAt = optionsOrPaymentType.expectedUpdatedAt;
  } else if (
    optionsOrPaymentType === 'Cash' ||
    optionsOrPaymentType === 'Credit' ||
    optionsOrPaymentType === 'Partial'
  ) {
    paymentType = optionsOrPaymentType;
    if (typeof paidAmountOrOptions === 'number' || typeof paidAmountOrOptions === 'string') {
      paidAmount = paidAmountOrOptions;
    } else if (paidAmountOrOptions && typeof paidAmountOrOptions === 'object') {
      paidAmount = paidAmountOrOptions.paidAmount;
      expectedSupplierId = paidAmountOrOptions.expectedSupplierId;
      expectedCanonicalHash = paidAmountOrOptions.expectedCanonicalHash;
      expectedUpdatedAt = paidAmountOrOptions.expectedUpdatedAt;
    }
  } else if (paidAmountOrOptions && typeof paidAmountOrOptions === 'object') {
    paymentType = paidAmountOrOptions.paymentType;
    paidAmount = paidAmountOrOptions.paidAmount;
    expectedSupplierId = paidAmountOrOptions.expectedSupplierId;
    expectedCanonicalHash = paidAmountOrOptions.expectedCanonicalHash;
    expectedUpdatedAt = paidAmountOrOptions.expectedUpdatedAt;
  }

  // Re-verify live Firebase Admin/Super Admin session before entering the atomic 8-store transaction.
  // Never pass display names or caller-supplied approval fields; pharmacyDb validates persisted
  // approval evidence and trustedAuthSession independently.
  const trustedSession = await ensureLiveTrustedAdminSessionForOcr();

  // Enter the atomic 8-store engine directly without a pre-transaction draft existence guard
  // so committed replays succeed even if the draft was deleted after commit.
  const invoice = await postOcrPurchaseInvoice({
    ocrDraftId: draftId,
    paymentType,
    paidAmount,
    postingActor: trustedSession.uid,
    expectedSupplierId,
    expectedCanonicalHash,
    expectedUpdatedAt
  });

  const draft = await getSupplierInvoiceDraft(draftId);
  const result = Object.assign({}, invoice, {
    invoice,
    draft
  });
  return result;
}
