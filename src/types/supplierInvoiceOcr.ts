import { UnitKind } from '../services/pharmacyDb';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNREADABLE';

export interface ExtractedField<T> {
  value: T;
  confidence: ConfidenceLevel;
  rawText?: string;
  isManuallyEdited?: boolean;
}

export interface OcrPageImage {
  id: string;
  pageNumber: number;
  originalFileName: string;
  dataUrl: string; // Base64 data URL
  imageHash: string; // SHA-256 hash of image content
  rotation: number; // 0, 90, 180, 270 degrees
  width?: number;
  height?: number;
  createdAt: string;
}

export type MatchCategory = 'STRONG' | 'PROBABLE' | 'NEW';

export interface OcrInvoiceItem {
  id: string; // Client row ID
  pageNumber: number; // Page index from which this item was extracted
  tradeName: ExtractedField<string>;
  genericName?: ExtractedField<string>;
  strength?: ExtractedField<string>; // Required for approval/posting, e.g. "500mg", "1g", "250mg/5ml"
  dosageForm?: ExtractedField<string>; // Required for approval/posting, e.g. "Tablet", "Capsule", "Syrup", "Suspension"
  releaseType?: ExtractedField<string>; // e.g. "XR", "SR", "ER", "CR", "MR", "DR", "EC", "RETARD"
  concentration?: ExtractedField<string>; // e.g. "250mg/5ml", "125mg/5ml", "0.5%"
  packageSize?: ExtractedField<string>; // e.g. "30 tabs", "100ml", "20s"
  manufacturer?: ExtractedField<string>;
  barcode?: ExtractedField<string>;
  quantity: ExtractedField<number | null>;
  unit: ExtractedField<UnitKind | ''>; // 'pack' | 'strip' | 'pill' (empty when unverified/missing)
  unitBuyPrice: ExtractedField<number | string | null>;
  itemDiscount?: ExtractedField<number | string | null>; // Per-item discount (never double-counted with invoice discount)
  lineTotal: ExtractedField<number | string | null>;
  suggestedSellPrice?: ExtractedField<number | string | null>;
  batchNumber: ExtractedField<string>;
  expiryDate: ExtractedField<string>; // ISO YYYY-MM-DD

  // Matching with Pharmacy Medicines Catalog (auto-match is NEVER human confirmation)
  matchStatus: MatchCategory;
  matchedMedicineId?: string;
  matchedMedicineName?: string;
  matchScore?: number; // 0 - 100
  isUserConfirmed?: boolean;
  identityMismatchReason?: string;
}

export interface OcrInvoiceHeader {
  supplierName: ExtractedField<string>;
  matchedSupplierId?: string;
  invoiceNumber: ExtractedField<string>;
  invoiceDate: ExtractedField<string>; // YYYY-MM-DD
  taxNumber?: ExtractedField<string>;
  subtotal: ExtractedField<number | string | null>;
  discount: ExtractedField<number | string | null>;
  /** Raw OCR/legacy tax value retained only as non-participating metadata; NEVER used in calculations or rejection. */
  tax?: ExtractedField<number | null>;
  finalTotal: ExtractedField<number | string | null>;
  currency: ExtractedField<string>; // Default 'SDG'
}

export interface OcrInvoiceAudit {
  calculatedItemsTotal: number;
  calculatedItemsTotalExact?: string;
  difference: number;
  differenceExact?: string;
  subtotalDifference?: number;
  subtotalDifferenceExact?: string;
  isReconciled: boolean;
  hasIncompleteFields?: boolean;
  excludedTaxAmount?: number | null;
}

export type SupplierInvoiceDraftStatus =
  | 'DRAFT'
  | 'PROCESSING'
  | 'NEEDS_REVIEW'
  | 'VERIFIED'
  | 'POSTED'
  | 'DUPLICATE'
  | 'FAILED';

export const OCR_APPROVAL_EVIDENCE_VERSION = 1 as const;

export type OcrTrustedApprovalRole = 'admin' | 'super_admin';

export interface OcrApprovedUnitSnapshotRef {
  readonly medicineId: string;
  readonly sourceUnit: UnitKind;
  readonly unitDefinitionKey: string;
  readonly baseDimensionKey: string;
  readonly definitionVersion: number;
}

export interface OcrApprovedPaymentIntentRef {
  readonly paymentType: 'Cash' | 'Credit' | 'Partial';
  readonly paidAmount: string;
  readonly currency: string;
}

export interface OcrDraftApprovalEvidence {
  readonly approvalStatus: 'APPROVED';
  readonly approvedBy: string;
  readonly approvedByRole: OcrTrustedApprovalRole;
  readonly approvedAt: string;
  readonly approvedCanonicalHash: string;
  readonly approvalVersion: typeof OCR_APPROVAL_EVIDENCE_VERSION;
  readonly approvedUnitSnapshotRefs: ReadonlyArray<OcrApprovedUnitSnapshotRef>;
  readonly approvedPaymentIntent: OcrApprovedPaymentIntentRef;
  readonly approvedBranchId: string;
}

export interface SupplierInvoiceDraft {
  id: string; // UUID v4
  status: SupplierInvoiceDraftStatus;
  createdAt: string;
  updatedAt: string;
  pages: OcrPageImage[];
  header: OcrInvoiceHeader;
  items: OcrInvoiceItem[];
  audit: OcrInvoiceAudit;
  rawOcrText?: string;
  postedInvoiceId?: string;
  errorMessage?: string;
  employeeName?: string;
  paymentType?: 'Cash' | 'Credit' | 'Partial';
  paidAmount?: number | string;
  approval?: OcrDraftApprovalEvidence;
  approvedBy?: string;
  approvedByRole?: OcrTrustedApprovalRole;
  approvedAt?: string;
  approvedCanonicalHash?: string;
  approvedBranchId?: string;
  approvalStatus?: 'APPROVED';
  approvalVersion?: number;
  duplicateWarning?: {
    type: 'IMAGE_HASH' | 'INVOICE_NUMBER';
    message: string;
    existingId: string;
  };
}
