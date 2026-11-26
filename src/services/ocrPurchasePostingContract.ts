/**
 * R13-C — OCR purchase posting contracts.
 *
 * This file defines the immutable evidence expected by the atomic IndexedDB
 * posting boundary. It performs no database, inventory, supplier, Outbox,
 * Firebase, network, or payment operations.
 */
import type {
  OcrPurchaseCanonicalPayload,
  OcrPurchasePaymentIntent,
} from './ocrPurchaseCanonical';
import type { SerializedUnitDefinitionDTOV2 } from './unitSerialization';

export const OCR_PURCHASE_IDEMPOTENCY_PREFIX = 'ocr_purchase_idempotency:' as const;
export const OCR_PURCHASE_POSTING_SCHEMA_VERSION = 1 as const;

export type OcrPurchaseIdempotencyStatus = 'RESERVED' | 'COMMITTED';

/**
 * Captured from the medicine record read inside the same readwrite transaction
 * that posts the purchase. Never construct this from a preflight read.
 */
export interface OcrPurchaseUnitSnapshot {
  readonly medicineId: string;
  readonly sourceUnit: string;
  readonly unitDefinitionKey: string;
  readonly baseDimensionKey: string;
  readonly definitionVersion: number;
  readonly unitDefinition: SerializedUnitDefinitionDTOV2;
}

/**
 * The canonical payload used for the final digest must include these unit
 * snapshots in invoice line order. The transaction must validate the current
 * medicine's VERIFIED/operational state before accepting each snapshot.
 */
export interface OcrPurchaseCanonicalPostingPayload extends OcrPurchaseCanonicalPayload {
  readonly unitSnapshots: ReadonlyArray<OcrPurchaseUnitSnapshot>;
}

/**
 * Metadata store uses keyPath "key". A RESERVED record may exist only inside
 * the active transaction; the only durable successful record is COMMITTED.
 */
export interface OcrPurchaseIdempotencyRecord {
  readonly key: string;
  readonly schemaVersion: typeof OCR_PURCHASE_POSTING_SCHEMA_VERSION;
  readonly source: 'OCR';
  readonly ocrDraftId: string;
  readonly status: 'COMMITTED';
  readonly canonicalVersion: number;
  readonly canonicalHash: string;
  readonly canonicalJson: string;
  readonly canonicalPayloadSnapshot: OcrPurchaseCanonicalPostingPayload;
  readonly purchaseInvoiceId: string;
  readonly supplierId: string;
  readonly supplierInvoiceNumber: string;
  readonly initialPaymentIntent: OcrPurchasePaymentIntent;
  readonly committedAt: string;
}

/** Transaction-local reservation; do not persist a standalone RESERVED lock. */
export interface OcrPurchaseTransactionReservation {
  readonly key: string;
  readonly schemaVersion: typeof OCR_PURCHASE_POSTING_SCHEMA_VERSION;
  readonly source: 'OCR';
  readonly ocrDraftId: string;
  readonly status: 'RESERVED';
  readonly canonicalHash: string;
  readonly supplierId: string;
  readonly purchaseInvoiceId: string;
}

export function getOcrPurchaseIdempotencyKey(ocrDraftId: string): string {
  const normalized = typeof ocrDraftId === 'string' ? ocrDraftId.trim() : '';
  if (!normalized) {
    throw new Error('OCR_DRAFT_ID_REQUIRED');
  }
  return OCR_PURCHASE_IDEMPOTENCY_PREFIX + normalized;
}

/**
 * Exact match is intentionally strict. Existing invoices with an OCR-looking
 * ID but no provenance must never be treated as successful idempotent replays.
 */
export function isMatchingOcrPurchaseIdempotencyRecord(
  record: unknown,
  expected: {
    readonly ocrDraftId: string;
    readonly supplierId: string;
    readonly canonicalHash: string;
    readonly purchaseInvoiceId: string;
  }
): record is OcrPurchaseIdempotencyRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const candidate = record as Partial<OcrPurchaseIdempotencyRecord>;
  return (
    candidate.key === getOcrPurchaseIdempotencyKey(expected.ocrDraftId) &&
    candidate.schemaVersion === OCR_PURCHASE_POSTING_SCHEMA_VERSION &&
    candidate.source === 'OCR' &&
    candidate.ocrDraftId === expected.ocrDraftId &&
    candidate.status === 'COMMITTED' &&
    candidate.supplierId === expected.supplierId &&
    candidate.canonicalHash === expected.canonicalHash &&
    candidate.purchaseInvoiceId === expected.purchaseInvoiceId &&
    candidate.canonicalPayloadSnapshot?.source === 'OCR' &&
    candidate.canonicalPayloadSnapshot?.ocrDraftId === expected.ocrDraftId
  );
}

export function assertOcrPurchaseInvoiceProvenance(
  invoice: unknown,
  expected: {
    readonly ocrDraftId: string;
    readonly supplierId: string;
    readonly canonicalHash: string;
    readonly invoiceId: string;
  }
): void {
  if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) {
    throw new Error('OCR_IDEMPOTENCY_INVOICE_MISSING');
  }
  const candidate = invoice as Record<string, unknown>;
  if (
    candidate.source !== 'OCR' ||
    candidate.ocrDraftId !== expected.ocrDraftId ||
    candidate.supplierId !== expected.supplierId ||
    candidate.ocrCanonicalHash !== expected.canonicalHash ||
    candidate.id !== expected.invoiceId
  ) {
    throw new Error('OCR_IDEMPOTENCY_PROVENANCE_MISMATCH_REQUIRES_RECONCILIATION');
  }
}
