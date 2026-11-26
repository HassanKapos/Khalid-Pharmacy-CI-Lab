/**
 * Khalid Pharmacy IndexedDB Engine & Append-Only Inventory Ledger
 * Local-First Single Source of Truth for Pharmacy Operations
 */

import {
  OCR_APPROVAL_EVIDENCE_VERSION,
  type ConfidenceLevel,
  type OcrApprovedUnitSnapshotRef,
  type OcrDraftApprovalEvidence,
  type OcrInvoiceHeader,
  type OcrInvoiceItem,
  type OcrTrustedApprovalRole,
  type SupplierInvoiceDraft
} from '../types/supplierInvoiceOcr';
import {
  resolveMedicineOutboxWriteShared,
  resolveSupplierOutboxWriteShared
} from './ocrPurchaseOutboxPolicy';
import {
  OCR_PURCHASE_CANONICAL_VERSION,
  buildOcrPurchaseCanonicalPayload,
  createOcrPurchaseCanonicalSnapshotFromPayload,
  validateOcrItemMedicineIdentity,
  type OcrPurchasePaymentIntent,
  type OcrPurchasePaymentType
} from './ocrPurchaseCanonical';
import {
  OCR_PURCHASE_POSTING_SCHEMA_VERSION,
  assertOcrPurchaseInvoiceProvenance,
  getOcrPurchaseIdempotencyKey,
  isMatchingOcrPurchaseIdempotencyRecord,
  type OcrPurchaseCanonicalPostingPayload,
  type OcrPurchaseIdempotencyRecord,
  type OcrPurchaseTransactionReservation,
  type OcrPurchaseUnitSnapshot
} from './ocrPurchasePostingContract';
import type { StocktakingSession, StocktakingItem } from '../types/barcode';
import { assertMedicineOperationallyAllowed, convertMedicineQuantityToBaseUnits, formatMedicineStockBreakdown, getMedicineBaseUnitsPerPack, getMedicineUnitSellingPrice, isDirectPackMedicine, isMedicineUnitSellable, validateMedicineUnitConfiguration } from './medicineUnitPolicy';
import { allocateWholeSdgSaleSettlement, calculateWeightedBatchCost, normalizeCostToBaseUnit } from './inventoryCostPolicy';
import { allocationsMatch, calculateFefoBatchAllocation } from './inventoryStockPolicy';
import { addRational, compareRational, createRational, divideRational, formatRationalForDisplay, isValidRational, multiplyRational, normalizeRational, subtractRational, type Rational } from './exactFinance.ts';
import { allocateExactProportionalDiscountRational, calculateExactWeightedBatchCostRational, parseExactDecimal } from './exactInventoryCosting.ts';
import {
  rehydrateUnitDefinitionFromDto,
  serializeUnitDefinitionToDto,
  type SerializedUnitDefinitionDTOV2
} from './unitSerialization';
import {
  createValidatedUnitDefinition,
  type BaseUnitKind,
  type DosageFormKind,
  type SupportedUnitKind
} from './universalUnitPolicy';
import { applyStickyPackingLock, assertPackingMutationAllowed, evaluatePackingLockSnapshot } from './packingLockCoordinator';
export { getMedicineUnitSellingPrice, isMedicineUnitSellable, validateMedicineUnitConfiguration } from './medicineUnitPolicy';

export interface OpeningStockCreationEvidence {
  schemaVersion: 1;
  medicineId: string;
  createOperationId: string;
  intent: 'OMITTED' | 'EXPLICIT_ZERO' | 'POSITIVE';
  intendedInitialStock: number;
  intendedBaseUnits: number;
  initialLedgerMovementId?: string;
  batchNumber?: string;
}

export interface Medicine {
  id: string;
  barcode: string;
  name: string; // Trade name strictly in English
  category: string;
  minStock: number; // in packs
  buyPrice: number; // cost per pack in SDG
  buyPriceExact?: Rational;
  sellPrice: number; // retail price per pack in SDG
  sellPriceStrip?: number; // optional approved retail price per strip
  sellPricePill?: number; // optional approved retail price per pill
  sellPack?: boolean;
  sellStrip?: boolean;
  sellPill?: boolean;
  expiry: string; // YYYY-MM-DD
  unitType: 'pack';
  stripsPerPack: number;
  pillsPerStrip: number;
  batchNumber?: string;
  initialStock?: number;
  openingStockEvidence?: OpeningStockCreationEvidence;
  createdAt: string;
  updatedAt: string;
  secondaryBarcodes?: string[]; // Phase 5: Multiple barcodes per medicine
  archived?: boolean;
  archivedAt?: string;
  archivedByUid?: string;
  // PR-2B optional universal unit migration & quarantine metadata (never alters POS/pricing/stock behavior)
  dosageForm?: string;
  baseUnitsPerPack?: number;
  configStatus?: string;
  unitDefinition?: SerializedUnitDefinitionDTOV2;
  unitDefinitionKey?: string;
  baseDimensionKey?: string;
  packingLocked?: boolean;
  unitMigrationStatus?: 'MIGRATED_CONSERVATIVE' | 'QUARANTINED' | 'CONFLICTED';
  unitMigrationRunId?: string;
  unitMigratedAt?: string;
  unitOperationalAllowed?: boolean;
}


/**
 * Fail-closed guard shared by medicine mutation and purchase posting paths.
 * A quarantine record is authoritative only when its identity/schema are intact
 * and its resolution is fully evidenced. Medicine flags remain a second line
 * of defence so deleting a metadata record cannot silently unquarantine a drug.
 */
export function getMedicineQuarantineMutationBlockReason(
  medicine: unknown,
  quarantineRecord: unknown
): string | null {
  const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };
  const own = (value: unknown, key: string): unknown => {
    if (!isPlainRecord(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor && !descriptor.get && !descriptor.set
      ? descriptor.value
      : undefined;
  };
  const quarantineStates = new Set(['QUARANTINED', 'CONFLICTED', 'RECONCILIATION_REQUIRED']);
  const topConfig = own(medicine, 'configStatus');
  const migrationStatus = own(medicine, 'unitMigrationStatus');
  const unitDefinition = own(medicine, 'unitDefinition');
  const nestedConfig = own(unitDefinition, 'configStatus');
  const medicineHasQuarantineState =
    quarantineStates.has(String(topConfig ?? '')) ||
    quarantineStates.has(String(migrationStatus ?? '')) ||
    quarantineStates.has(String(nestedConfig ?? ''));

  if (quarantineRecord !== undefined && quarantineRecord !== null) {
    if (!isPlainRecord(quarantineRecord)) return 'MALFORMED_QUARANTINE_RECORD';
    const record = quarantineRecord;
    const medicineId = own(medicine, 'id');
    if (
      own(record, 'schemaVersion') !== 2 ||
      typeof medicineId !== 'string' ||
      own(record, 'medicineId') !== medicineId ||
      own(record, 'key') !== `unit_migration_v2:quarantine:${medicineId}` ||
      !['QUARANTINED', 'CONFLICTED'].includes(String(own(record, 'classification') ?? '')) ||
      own(record, 'operationalAllowed') !== false ||
      typeof own(record, 'packingLocked') !== 'boolean' ||
      typeof own(record, 'reasonCode') !== 'string' ||
      !String(own(record, 'reasonCode') ?? '').trim() ||
      typeof own(record, 'message') !== 'string' ||
      typeof own(record, 'firstQuarantinedAt') !== 'string' ||
      typeof own(record, 'lastSeenAt') !== 'string' ||
      typeof own(record, 'migrationRunId') !== 'string' ||
      typeof own(record, 'lastSeenRunId') !== 'string' ||
      !Object.prototype.hasOwnProperty.call(record, 'rawSnapshot')
    ) {
      return 'MALFORMED_QUARANTINE_RECORD';
    }
    const reviewStatus = own(record, 'reviewStatus');
    if (reviewStatus === 'PENDING_PHARMACIST_REVIEW') {
      return 'PHARMACIST_REVIEW_PENDING';
    }
    if (reviewStatus !== 'RESOLVED') return 'INVALID_QUARANTINE_REVIEW_STATUS';
    if (
      typeof own(record, 'resolvedAt') !== 'string' ||
      !String(own(record, 'resolvedAt') ?? '').trim() ||
      typeof own(record, 'resolvedByUid') !== 'string' ||
      !String(own(record, 'resolvedByUid') ?? '').trim() ||
      typeof own(record, 'resolutionReason') !== 'string' ||
      String(own(record, 'resolutionReason') ?? '').trim().length < 3
    ) {
      return 'INCOMPLETE_QUARANTINE_RESOLUTION';
    }
    if (medicineHasQuarantineState) return 'MEDICINE_AND_QUARANTINE_METADATA_CONFLICT';
    return null;
  }

  return medicineHasQuarantineState ? 'QUARANTINE_METADATA_MISSING' : null;
}


function stableMedicineFieldFingerprint(value: unknown): string {
  const visit = (node: unknown, seen: WeakSet<object>): unknown => {
    if (node === undefined) return { __type: 'undefined' };
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number') return Number.isFinite(node) ? node : { __type: 'nonfinite', value: String(node) };
    if (typeof node !== 'object') return { __type: typeof node, value: String(node) };
    if (seen.has(node as object)) throw new Error('INVALID_MEDICINE_INPUT: Cyclic unit configuration is not allowed.');
    seen.add(node as object);
    if (Array.isArray(node)) {
      const result = node.map((item) => visit(item, seen));
      seen.delete(node);
      return result;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error('INVALID_MEDICINE_INPUT: Unit configuration must use plain data objects.');
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) {
        throw new Error('INVALID_MEDICINE_INPUT: Accessor properties are not allowed in unit configuration.');
      }
      result[key] = visit(descriptor.value, seen);
    }
    seen.delete(node as object);
    return result;
  };
  return JSON.stringify(visit(value, new WeakSet<object>()));
}

function assertSafeMedicineSaveInput(value: unknown): asserts value is Partial<Medicine> & { initialStock?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_MEDICINE_INPUT: Medicine payload must be a plain object.');
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('INVALID_MEDICINE_INPUT: Custom prototypes are not allowed.');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('INVALID_MEDICINE_INPUT: Symbol properties are not allowed.');
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) {
      throw new Error(`INVALID_MEDICINE_INPUT: Accessor property '${key}' is not allowed.`);
    }
  }
}

export type MovementType = 'INITIAL' | 'SALE' | 'PURCHASE' | 'RETURN' | 'DAMAGE' | 'ADJUSTMENT';
export type UnitKind = 'pack' | 'strip' | 'pill';
function normalizeMedicineCostToBaseUnit(cost: number, unit: UnitKind, medicine: Medicine): number {
  return normalizeCostToBaseUnit(
    cost,
    unit,
    medicine.stripsPerPack,
    medicine.pillsPerStrip,
    getMedicineBaseUnitsPerPack(medicine),
    isDirectPackMedicine(medicine)
  );
}


export interface LedgerMovement {
  id: string; // Deterministic UUIDv4
  medicineId: string;
  batchNumber: string;
  expiry?: string; // YYYY-MM-DD of the batch
  type: MovementType;
  unit: UnitKind;
  quantityDelta: number; // positive or negative
  baseUnitsDelta: number; // normalized to smallest unit (pill)
  costPerUnit: number;
  costPerUnitExact?: Rational;
  costPerBaseUnit?: number; // immutable acquisition cost per pill (base stock unit)
  costPerBaseUnitExact?: Rational;
  referenceId: string; // saleId, invoiceNumber, supplierInvoiceId, or adjustReason
  deviceId: string;
  userId: string;
  employeeName: string;
  notes: string;
  timestamp: string; // ISO String
  synced: 0 | 1;
}

export interface SaleItemAllocation {
  batchNumber: string;
  expiry: string;
  quantity: number;
  unit: UnitKind;
  baseUnits: number;
  ledgerMovementId: string;
  costPerBaseUnit?: number;
  costPerBaseUnitExact?: Rational;
  costOfGoods?: number;
  costOfGoodsExact?: Rational;
  costIsEstimated?: boolean;
}

export interface SaleItem {
  medicineId: string;
  name: string;
  sellPrice: number; // price for this unit
  qty: number;
  unit: UnitKind;
  unitPrice: number;
  baseUnits: number;
  subtotal: number;
  costOfGoods?: number;
  costOfGoodsExact?: Rational;
  grossProfit?: number;
  grossProfitExact?: Rational;
  discountShare?: number;
  netProfit?: number;
  netProfitExact?: Rational;
  ledgerMovementId: string; // primary movement ID for full backward compatibility
  ledgerMovementIds?: string[]; // all movement IDs generated for this line if split
  batchAllocations?: SaleItemAllocation[]; // FEFO allocation breakdown per batch
}

export interface Sale {
  id: string; // UUID v4
  invoiceNumber: string; // e.g. "1085"
  customer: string;
  time: string;
  timestamp: string;
  items: SaleItem[];
  itemsCount: number;
  subtotal: number;
  discount: number;
  total: number;
  costOfGoods?: number;
  costOfGoodsExact?: Rational;
  grossProfit?: number;
  grossProfitExact?: Rational;
  netProfit?: number;
  netProfitExact?: Rational;
  paymentMethod: 'Cash' | 'Card' | 'Bankak';
  bankakTransactionId?: string;
  cashierName: string;
  deviceId: string;
  synced: 0 | 1;
}

export interface Supplier {
  id: string;
  name: { ar: string; en: string };
  contactPerson: string;
  phone: string;
  city: string;
  balance: number;
  balanceExact?: Rational;
  terms: string;
  createdAt: string;
  status?: 'active' | 'inactive' | 'archived';
  email?: string;
  address?: string;
  taxNumber?: string;
  notes?: string;
  legacyBalance?: number;
  openingBalanceReviewed?: boolean;
  updatedAt?: string;
  archived?: boolean;
  archivedAt?: string;
  archivedByUid?: string;
}

export interface PurchaseInvoiceItem {
  id: string; // UUID
  medicineId: string;
  medicineName: string;
  batchNumber: string;
  expiry: string; // YYYY-MM-DD
  expiryDate?: string; // alias
  quantity: number;
  unit: UnitKind;
  stripsPerPack: number;
  pillsPerStrip: number;
  baseUnits: number;
  baseUnitsPerPack: number;
  buyPrice: number; // cost for the invoice line's entered unit
  buyPriceExact?: Rational;
  itemDiscount?: number;
  itemDiscountExact?: Rational;
  grossLineCostExact?: Rational;
  totalCostExact?: Rational;
  discountShareExact?: Rational;
  netCostExact?: Rational;
  netUnitBuyPriceExact?: Rational;
  costPerBaseUnitExact?: Rational;
  normalizedPackBuyPriceExact?: Rational;
  costPerBaseUnit?: number;
  normalizedPackBuyPrice?: number;
  discountShare?: number;
  netCost?: number;
  netUnitBuyPrice?: number;
  unitBuyPrice?: number; // alias
  sellPrice: number;
  suggestedSellPrice?: number; // alias
  totalCost: number;
  total?: number; // alias
  ledgerMovementId?: string;
}

export interface CreatePurchaseInvoiceParams {
  id?: string; // Idempotency key / UUID
  supplierId: string;
  invoiceNumber?: string;
  date?: string; // YYYY-MM-DD
  invoiceDate?: string; // alias
  items: {
    medicineId: string;
    medicineName?: string;
    batchNumber: string;
    expiry?: string; // YYYY-MM-DD
    expiryDate?: string; // alias
    quantity: number;
    unit?: UnitKind;
    buyPrice?: number;
    unitBuyPrice?: number; // alias
    sellPrice?: number;
    suggestedSellPrice?: number; // alias
  }[];
  discount?: number;
  paidAmount?: number;
  paymentType?: 'Cash' | 'Credit' | 'Bankak' | 'Partial';
  dueDate?: string;
  notes?: string;
  employeeName?: string;
}

export interface PurchaseInvoice {
  id: string; // UUID
  supplierId: string;
  supplierName: string;
  invoiceNumber: string;
  date: string; // YYYY-MM-DD
  invoiceDate?: string; // alias
  items: PurchaseInvoiceItem[];
  itemsCount: number;
  totalAmount: number;
  subtotal?: number; // alias
  discount: number;
  netAmount: number;
  subtotalExact?: Rational;
  discountExact?: Rational;
  netAmountExact?: Rational;
  paidAmountExact?: Rational;
  remainingAmountExact?: Rational;
  paidAmount: number;
  remainingAmount: number;
  paymentType: 'Cash' | 'Credit' | 'Bankak' | 'Partial';
  paymentStatus: 'Paid' | 'Partial' | 'Unpaid';
  dueDate?: string;
  notes?: string;
  createdAt: string;
  updatedAt?: string;
  deviceId: string;
  employeeName: string;
  synced: 0 | 1;
  source?: 'OCR' | 'MANUAL';
  ocrDraftId?: string;
  ocrCanonicalHash?: string;
  ocrCanonicalVersion?: number;
  ocrCanonicalPayloadSnapshot?: OcrPurchaseCanonicalPostingPayload;
  initialPaymentIntent?: OcrPurchasePaymentIntent;
}

export type OcrPurchaseApprovalRole = OcrTrustedApprovalRole;

export type OcrDraftHumanApprovalEvidence = OcrDraftApprovalEvidence;

export interface ApproveOcrPurchaseDraftParams {
  readonly ocrDraftId: string;
  readonly paymentType?: OcrPurchasePaymentType;
  readonly paidAmount?: number | string;
  readonly expectedUpdatedAt?: string;
}

export interface OcrDraftApprovalResult {
  readonly draft: SupplierInvoiceDraft;
  readonly approval: OcrDraftApprovalEvidence;
  readonly canonicalHash: string;
}

export interface PostOcrPurchaseInvoiceParams {
  readonly ocrDraftId: string;
  readonly paymentType?: OcrPurchasePaymentType;
  readonly paidAmount?: number | string;
  readonly postingActor?: string;
  readonly employeeName?: string;
  readonly draftSnapshot?: SupplierInvoiceDraft;
  readonly expectedSupplierId?: string;
  readonly expectedCanonicalHash?: string;
  readonly expectedUpdatedAt?: string;
}

export type SupplierTxType = 'PURCHASE_INVOICE' | 'PAYMENT' | 'RETURN' | 'OPENING_BALANCE' | 'ADJUSTMENT';

export interface InvoiceAllocation {
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
}

export interface SupplierTransaction {
  id: string; // UUID
  supplierId: string;
  type: SupplierTxType;
  referenceId: string;
  invoiceNumber?: string;
  voucherNumber?: string;
  amount: number;
  amountExact?: Rational;
  effect: 'CREDIT' | 'DEBIT';
  debit?: number;
  credit?: number;
  balanceAfter: number;
  balanceAfterExact?: Rational;
  paymentMethod?: 'Cash' | 'Bankak' | 'Check' | 'Transfer';
  bankakTransactionId?: string;
  checkNumber?: string;
  checkDueDate?: string;
  transferReference?: string;
  invoiceAllocations?: InvoiceAllocation[];
  date: string;
  timestamp: string;
  notes?: string;
  employeeName: string;
  deviceId: string;
  synced: 0 | 1;
  isReversal?: boolean;
  reversedTxId?: string;
}

export type OutboxEntityType =
  | 'sale'
  | 'inventory_ledger'
  | 'medicine'
  | 'supplier'
  | 'receipt'
  | 'supplier_transaction'
  | 'purchase_invoice'
  | 'stocktaking_session'
  | 'stocktaking_session_item'
  | 'category_metadata';

export type OutboxStatus =
  | 'pending'
  | 'syncing' // retained for historical backward compatibility
  | 'processing'
  | 'retry'
  | 'blocked'
  | 'failed'
  | 'dead-letter'
  | 'synced';

export type RemoteWriteEvidenceKind =
  | 'firestore_batch_commit'
  | 'firestore_doc_write'
  | 'firestore_server_get';

/**
 * Internal module-private WeakSet tracking sealed RemoteWriteCompletionEvidence instances.
 * NOTE: Client-side WeakSet sealing blocks plain JSON literals and DevTools object literals from
 * being accepted as internal sync evidence, but does NOT defend against same-origin XSS or
 * debugger tampering. firestore.rules remains the final server-side security authority.
 */
const sealedRemoteWriteEvidenceRegistry = new WeakSet<object>();

export interface RemoteWriteCompletionEvidence {
  evidenceKind: RemoteWriteEvidenceKind;
  projectId: string;
  firestoreDatabaseId: string;
  branchId: string;
  entityType: OutboxEntityType;
  entityId: string;
  documentPath: string;
  completedAt: string; // ISO-8601
  actorUid: string;
  /** Explicit local attempt correlation identifier (NOT a server cryptographic receipt) */
  clientAttemptId: string;
}

/**
 * Mints a frozen, WeakSet-sealed RemoteWriteCompletionEvidence instance for internal sync workers.
 * NEVER exposed on window.PharmacyDB.
 */
export function sealInternalRemoteWriteCompletionEvidence(
  evidence: RemoteWriteCompletionEvidence
): RemoteWriteCompletionEvidence {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('INVALID_REMOTE_ACK_EVIDENCE: Evidence payload must be a non-null object');
  }
  const sealed = Object.freeze({ ...evidence });
  sealedRemoteWriteEvidenceRegistry.add(sealed);
  return sealed;
}

export interface RemoteAckTarget {
  evidenceKind: RemoteWriteEvidenceKind;
  projectId: string;
  firestoreDatabaseId: string;
  branchId: string;
  entityType: OutboxEntityType;
  entityId: string;
  documentPath: string;
  completedAt: string;
  actorUid: string;
  clientAttemptId: string;
}

export interface RemoteParentAckRecord {
  key: string;
  cache_hint: true;
  projectId: string;
  firestoreDatabaseId: string;
  branchId: string;
  entityType: OutboxEntityType;
  entityId: string;
  documentPath: string;
  action: 'CREATE' | 'UPDATE';
  verifiedAt: string;
  verifiedByUid: string;
  proofSource: RemoteWriteEvidenceKind;
  clientAttemptId?: string;
}

/**
 * Caller-supplied snapshot metadata from a Firestore getDocFromServer() verification check.
 * SECURITY NOTE (Trust Boundary): Plain JS input object; NOT cryptographic proof.
 * Enforces structural & freshness invariants locally; real server attestation requires Phase 2D-3B SDK wiring.
 */
export interface ServerDocVerificationResult {
  projectId: string;
  firestoreDatabaseId: string;
  branchId: string;
  entityType: OutboxEntityType;
  entityId: string;
  documentPath: string;
  verifiedAt: string;
  source: 'firestore_getDocFromServer';
  exists: boolean;
  offline?: boolean;
  errorCode?: string;
  docData?: Record<string, any> | null;
}

export interface VerificationTargetSpec {
  projectId: string;
  firestoreDatabaseId: string;
  branchId: string;
  entityType: OutboxEntityType;
  entityId: string;
  documentPath: string;
  reason: 'REMOTE_PARENT_EXISTENCE' | 'PARENT_CURRENT_STATE' | 'PARENT_NOT_ARCHIVED';
  requiredForOperationId?: string;
}

export interface OutboxEntry {
  id: string;
  entityType: OutboxEntityType;
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  payload: any;
  timestamp: string;
  retryCount: number;
  status: OutboxStatus;
  operationId?: string;
  idempotencyKey?: string;
  branchId?: string;
  actorUid?: string;
  schemaVersion?: number;
  sequence?: number;
  dependsOn?: string[];
  attempts?: number;
  maxAttempts?: number;
  nextRetryAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  blockReason?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  ackedAt?: string;
  quarantinedAt?: string;
  remoteAckTarget?: RemoteAckTarget;
}

export interface AcquireOutboxLeaseParams {
  outboxId: string;
  leaseOwner: string;
  leaseDurationMs?: number;
  nowMs?: number;
  expectedBranchId?: string;
  expectedProjectId?: string;
  expectedFirestoreDatabaseId?: string;
  serverVerificationResults?:
    | Record<string, ServerDocVerificationResult>
    | ServerDocVerificationResult[];
  db?: IDBDatabase;
}

export interface AcquireOutboxLeaseResult {
  acquired: boolean;
  reason?:
    | 'INVALID_INPUT'
    | 'NOT_FOUND'
    | 'ALREADY_SYNCED'
    | 'DEAD_LETTER'
    | 'BLOCKED'
    | 'RETRY_NOT_DUE'
    | 'ACTIVE_LEASE_HELD'
    | 'STATUS_NOT_ELIGIBLE'
    | 'DEPENDENCY_NOT_READY'
    | 'DEPENDENCY_MISSING'
    | 'DEPENDENCY_AMBIGUOUS'
    | 'DEPENDENCY_CYCLE'
    | 'SELF_DEPENDENCY'
    | 'DEPENDENCY_BLOCKED'
    | 'DEPENDENCY_DEAD_LETTER'
    | 'DEPENDENCY_FAILED'
    | 'DUPLICATE_OPERATION_ID'
    | 'LEGACY_REVALIDATION_REQUIRED'
    | 'ACTOR_UID_REQUIRED'
    | 'BRANCH_MISMATCH'
    | 'REMOTE_PARENT_EXISTENCE_UNPROVEN'
    | 'REMOTE_PARENT_BRANCH_UNPROVEN'
    | 'REMOTE_ACK_TARGET_MISMATCH'
    | 'SERVER_VERIFICATION_REQUIRED'
    | 'REMOTE_PARENT_MISSING_ON_SERVER'
    | 'REMOTE_PARENT_STATE_INCOMPATIBLE'
    | 'COMMERCIAL_TARGET_ARCHIVED';
  entry: OutboxEntry | null;
  recoveredExpiredLease?: boolean;
  blockReason?: string;
  dependencyFailureReason?: string;
  blockingDependencies?: string[];
  verificationTargets?: VerificationTargetSpec[];
}

export interface MarkOutboxSyncedParams {
  outboxId: string;
  ackedAt?: string;
  nowMs?: number;
  expectedLeaseOwner: string;
  ledgerMovementIds?: string[];
  /** @deprecated Unsafe automatic linked ledger completion was removed in F4-HARDENING. */
  syncLinkedLedgerOutbox?: boolean;
  remoteWriteEvidence?: RemoteWriteCompletionEvidence;
  expectedProjectId?: string;
  expectedFirestoreDatabaseId?: string;
  db?: IDBDatabase;
}

export interface MarkOutboxRetryParams {
  outboxId: string;
  errorCode: string;
  errorMessage?: string;
  nextRetryAt?: string;
  retryDelayMs?: number;
  expectedLeaseOwner?: string;
  nowMs?: number;
  db?: IDBDatabase;
}

export interface MarkOutboxBlockedParams {
  outboxId: string;
  blockReason: string;
  errorCode?: string;
  errorMessage?: string;
  expectedLeaseOwner?: string;
  db?: IDBDatabase;
}

export interface MarkOutboxFailedParams {
  outboxId: string;
  errorCode: string;
  errorMessage?: string;
  incrementAttempt?: boolean;
  expectedLeaseOwner?: string;
  db?: IDBDatabase;
}

export interface MarkOutboxDeadLetterParams {
  outboxId: string;
  errorCode: string;
  errorMessage?: string;
  blockReason?: string;
  expectedLeaseOwner?: string;
  nowMs?: number;
  db?: IDBDatabase;
}

export interface OutboxTransitionResult {
  updated: boolean;
  reason?:
    | 'INVALID_INPUT'
    | 'NOT_FOUND'
    | 'ALREADY_SYNCED'
    | 'LEASE_MISMATCH'
    | 'LEASE_EXPIRED'
    | 'STATUS_NOT_ELIGIBLE'
    | 'ACTOR_UID_REQUIRED'
    | 'DEPENDENCY_NOT_READY'
    | 'DEPENDENCY_INVALID'
    | 'DEAD_LETTER_PROTECTED'
    | 'REMOTE_COMMIT_EVIDENCE_REQUIRED'
    | 'INVALID_REMOTE_ACK_EVIDENCE';
  entry: OutboxEntry | null;
  blockReason?: string;
  updatedSaleId?: string;
  updatedLedgerIds?: string[];
  updatedLinkedOutboxIds?: string[];
}

export interface RevalidateOutboxParams {
  outboxId: string;
  verifiedBranchId: string;
  verifiedActorUid: string;
  userHasBranchMembership: boolean;
  userHasEntityWritePermission: boolean;
  serverVerificationResults?:
    | Record<string, ServerDocVerificationResult>
    | ServerDocVerificationResult[];
  expectedProjectId?: string;
  expectedFirestoreDatabaseId?: string;
  db?: IDBDatabase;
}

export interface RevalidateOutboxResult {
  revalidated: boolean;
  reason?:
    | 'INVALID_INPUT'
    | 'NOT_FOUND'
    | 'ALREADY_SYNCED'
    | 'DEAD_LETTER'
    | 'MEMBERSHIP_REQUIRED'
    | 'PERMISSION_DENIED'
    | 'BRANCH_MISMATCH'
    | 'INVALID_ACTOR_UID'
    | 'ACTOR_UID_MISMATCH'
    | 'LEGACY_ACTOR_ATTRIBUTION_DISABLED_IN_3B1'
    | 'INVALID_V2_STRUCTURE'
    | 'BUSINESS_RULE_VIOLATION'
    | 'DEPENDENCY_INVALID';
  entry: OutboxEntry | null;
}

export interface StockCalculation {
  medicineId: string;
  totalPills: number;
  unexpiredPills: number;
  expiredPills: number;
  packs: number;
  remainingStrips: number;
  remainingPills: number;
  remainingBaseUnits?: number;
  baseUnitLabel?: string;
  displayQuantity: string;
  unexpiredDisplayQuantity: string;
}

export interface BatchStockSummary {
  batchNumber: string;
  expiry: string; // YYYY-MM-DD
  isExpired: boolean;
  totalPills: number; // available pills in this batch
  packs: number;
  remainingStrips: number;
  remainingPills: number;
  remainingBaseUnits?: number;
  baseUnitLabel?: string;
  displayQuantity: string;
  costPerUnit: number; // normalized pack-equivalent cost for legacy display
  costPerBaseUnit?: number;
  costPerBaseUnitExact?: Rational;
  costPerUnitExact?: Rational;
  carryingCostExact?: Rational;
  costIsEstimated?: boolean;
}

export interface MedicineInventoryValuationSummary {
  medicineId: string;
  name: string;
  totalBaseUnits: number;
  carryingCost: number;
  carryingCostExact?: Rational;
  exactCoverageComplete: boolean;
  batches: BatchStockSummary[];
}

export interface InventoryValuationReport {
  totalCarryingCost: number;
  totalCarryingCostExact?: Rational;
  exactCoverageComplete: boolean;
  medicines: MedicineInventoryValuationSummary[];
}

export interface ExecuteSaleParams {
  id?: string; // Deterministic UUIDv4 or client idempotency key
  invoiceNumber?: string;
  customer?: string;
  items: {
    medicineId: string;
    qty: number;
    unit?: UnitKind;
  }[];
  discount?: number;
  paymentMethod: 'Cash' | 'Card' | 'Bankak';
  bankakTransactionId?: string;
  cashierName?: string;
  notes?: string;
}

export const DEFAULT_FIREBASE_PROJECT_ID = 'khalid-pharmacy-c5e49';
export const DEFAULT_FIRESTORE_DATABASE_ID = '(default)';

const RESERVED_ACTOR_PLACEHOLDERS = new Set([
  'admin',
  'super_admin',
  'superadmin',
  'cashier',
  'system',
  'unknown',
  'guest',
  'owner',
  'user',
  'root',
  'none',
  'null',
  'undefined',
  'anonymous',
  'المسؤول',
  'كاشير',
  'النظام',
  'صيدلي مسؤول'
]);

export function normalizeFirestoreDatabaseId(dbId?: string | null): string {
  const trimmed = typeof dbId === 'string' ? dbId.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_FIRESTORE_DATABASE_ID;
}

export function getCanonicalOutboxCollectionSegment(entityType: OutboxEntityType): string | null {
  switch (entityType) {
    case 'medicine':
      return 'medicines';
    case 'supplier':
      return 'suppliers';
    case 'purchase_invoice':
      return 'purchase_invoices';
    case 'sale':
      return 'sales';
    case 'stocktaking_session':
      return 'stocktaking_sessions';
    case 'stocktaking_session_item':
      return 'items';
    case 'supplier_transaction':
      return 'supplier_transactions';
    case 'inventory_ledger':
      return 'inventory_ledger';
    case 'receipt':
      return 'receipts';
    case 'category_metadata':
      return 'metadata';
    default:
      return null;
  }
}

export function buildCanonicalFirestoreDocumentPath(
  branchId: string,
  entityType: OutboxEntityType,
  entityId: string,
  parentIds?: { sessionId?: string }
): string {
  const cleanBranch = typeof branchId === 'string' ? branchId.trim() : '';
  const cleanEntityId = typeof entityId === 'string' ? entityId.trim() : '';
  const segment = getCanonicalOutboxCollectionSegment(entityType);
  if (
    !cleanBranch ||
    cleanBranch.includes('/') ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(cleanBranch) ||
    !cleanEntityId ||
    cleanEntityId.includes('/') ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(cleanEntityId) ||
    !segment
  ) {
    throw new Error(
      `INVALID_FIRESTORE_TARGET: Cannot build canonical path for (${branchId}, ${entityType}, ${entityId})`
    );
  }
  if (entityType === 'stocktaking_session_item') {
    const cleanSessionId = typeof parentIds?.sessionId === 'string' ? parentIds.sessionId.trim() : '';
    if (
      !cleanSessionId ||
      cleanSessionId.includes('/') ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(cleanSessionId)
    ) {
      throw new Error(
        `INVALID_FIRESTORE_TARGET: stocktaking_session_item requires valid sessionId (got "${String(parentIds?.sessionId)}")`
      );
    }
    return `branches/${cleanBranch}/stocktaking_sessions/${cleanSessionId}/items/${cleanEntityId}`;
  }
  return `branches/${cleanBranch}/${segment}/${cleanEntityId}`;
}

export function getRemoteParentAckMetadataKey(
  branchId: string,
  entityType: OutboxEntityType,
  entityId: string,
  parentIds?: { sessionId?: string }
): string {
  if (entityType === 'stocktaking_session_item') {
    const cleanSessionId = typeof parentIds?.sessionId === 'string' ? parentIds.sessionId.trim() : '';
    return `remote_ack:${branchId.trim()}:${entityType}:${cleanSessionId}:${entityId.trim()}`;
  }
  return `remote_ack:${branchId.trim()}:${entityType}:${entityId.trim()}`;
}

export function isValidFirebaseActorUid(uid: unknown): uid is string {
  if (typeof uid !== 'string') return false;
  if (uid.length === 0 || uid.length > 128) return false;
  if (uid !== uid.trim()) return false;
  if (/\s/.test(uid)) return false;
  if (uid.includes('@') || uid.includes('/')) return false;
  if (/[\u0600-\u06FF]/.test(uid)) return false;
  if (RESERVED_ACTOR_PLACEHOLDERS.has(uid.toLowerCase())) return false;
  return true;
}

/**
 * Dependency-free synchronous SHA-256 (FIPS 180-4) for browser + Node deterministic ID derivation
 * inside synchronous IndexedDB transactions.
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export function sha256HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const withOneLen = bytes.length + 1;
  const padLen = (64 - ((withOneLen + 8) % 64)) % 64;
  const totalLen = withOneLen + padLen + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const hiBits = Math.floor(bitLen / 0x100000000);
  const loBits = bitLen >>> 0;
  view.setUint32(totalLen - 8, hiBits, false);
  view.setUint32(totalLen - 4, loBits, false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += H[i].toString(16).padStart(8, '0');
  }
  return hex;
}

export function deriveSupplierPaymentReversalId(originalTxId: string): string {
  const clean = typeof originalTxId === 'string' ? originalTxId.trim() : '';
  if (!clean) {
    throw new Error('INVALID_REVERSAL_TARGET: originalTxId is required');
  }
  const digest = sha256HexSync(`khalid-pharmacy:supplier_payment_reversal:v1:${clean}`);
  return `rev-${digest.slice(0, 32)}`;
}

export function deriveStocktakingItemId(
  branchId: string,
  sessionId: string,
  medicineId: string
): string {
  const cleanBranch = typeof branchId === 'string' ? branchId.trim() : '';
  const cleanSession = typeof sessionId === 'string' ? sessionId.trim() : '';
  const cleanMedicine = typeof medicineId === 'string' ? medicineId.trim() : '';
  if (!cleanBranch || !cleanSession || !cleanMedicine) {
    throw new Error('INVALID_STOCKTAKING_ITEM_ID_INPUT: branchId, sessionId, and medicineId are required');
  }
  const digest = sha256HexSync(
    `khalid-pharmacy:stocktaking_item:v1:${cleanBranch}:${cleanSession}:${cleanMedicine}`
  );
  return `stki-${digest.slice(0, 28)}`;
}

export function deriveStocktakingAdjustmentLedgerId(
  branchId: string,
  sessionId: string,
  itemId: string,
  adjustmentType: string = 'ADJUSTMENT'
): string {
  const cleanBranch = typeof branchId === 'string' ? branchId.trim() : '';
  const cleanSession = typeof sessionId === 'string' ? sessionId.trim() : '';
  const cleanItem = typeof itemId === 'string' ? itemId.trim() : '';
  const cleanType = typeof adjustmentType === 'string' ? adjustmentType.trim() : 'ADJUSTMENT';
  if (!cleanBranch || !cleanSession || !cleanItem || !cleanType) {
    throw new Error('INVALID_STOCKTAKING_LEDGER_ID_INPUT: branchId, sessionId, itemId, and adjustmentType are required');
  }
  const digest = sha256HexSync(
    `khalid-pharmacy:stocktaking_adjustment:v1:${cleanBranch}:${cleanSession}:${cleanItem}:${cleanType}`
  );
  return `stkad-${digest.slice(0, 32)}`;
}

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const DB_NAME = 'KhalidPharmacyDB';
export const DB_VERSION: number = 6;
export const DEFAULT_DB_OPEN_BLOCKED_TIMEOUT_MS = 10_000;

export interface BankakTombstone {
  id: string; // receipt ID
  transactionId?: string;
  deletedAt: string; // ISO timestamp
  syncStatus: 'pending_server_delete' | 'synced';
  deletedBy?: string;
  reason?: string;
}

export type TrustedActorRole = 'super_admin' | 'admin' | 'cashier';

export interface TrustedActorSessionState {
  uid: string;
  role: TrustedActorRole;
  branchIds: string[];
  activeBranchId: string | null;
  emailVerified: boolean;
  offlineFallback: boolean;
  expiresAtMs?: number;
}

let dbInstance: IDBDatabase | null = null;
let openDbPromise: Promise<IDBDatabase> | null = null;
let openDbPromiseName: string | null = null;
let openDbEpoch = 0;
const closedDbHandles = new WeakSet<IDBDatabase>();
let currentDeviceId = '';
let activeBranchId: string | null = null;
let activeBranchName: string | null = null;
let activeActorUid: string | null = null;
let activeDbName: string = DB_NAME;
let authAuthorityEnforced = false;
let trustedAuthSession: TrustedActorSessionState | null = null;
const branchContextListeners = new Set<(branchId: string | null) => void>();

function markDbHandleClosed(conn: IDBDatabase | null | undefined): void {
  if (!conn) return;
  closedDbHandles.add(conn);
  try {
    conn.close();
  } catch {
    // ignore close errors
  }
}

function isOpenDbInstanceHealthy(conn: IDBDatabase | null, expectedDbName: string): conn is IDBDatabase {
  if (!conn || closedDbHandles.has(conn)) return false;
  try {
    if (conn.name !== expectedDbName) return false;
    return conn.objectStoreNames.contains('medicines');
  } catch {
    return false;
  }
}

export function isTrustedSessionExpired(
  session: TrustedActorSessionState | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (!session) return true;
  if (session.expiresAtMs === undefined) return false;
  return typeof session.expiresAtMs !== 'number' || !Number.isFinite(session.expiresAtMs) || nowMs >= session.expiresAtMs;
}

function normalizeTrustedBranchIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && isValidOutboxBranchId(item)) {
      const trimmed = item.trim();
      if (!unique.includes(trimmed)) {
        unique.push(trimmed);
      }
    }
  }
  return unique;
}

function isBranchAuthorizedForSession(
  session: TrustedActorSessionState | null,
  branchId: string | null
): branchId is string {
  if (!session || !branchId || !isValidOutboxBranchId(branchId)) return false;
  if (!isValidFirebaseActorUid(session.uid) || session.emailVerified !== true) return false;
  if (isTrustedSessionExpired(session)) return false;
  if (session.offlineFallback && session.role !== 'cashier') return false;

  if (session.role === 'cashier') {
    return session.branchIds.length === 1 && session.branchIds[0] === branchId;
  }
  if (session.role === 'admin') {
    return !session.offlineFallback && session.branchIds.includes(branchId);
  }
  if (session.role === 'super_admin') {
    return !session.offlineFallback;
  }
  return false;
}

function applyBranchContextInternal(
  normalizedBranchId: string | null,
  branchName?: string | null
): string {
  const nextDbName = getBranchDbName(normalizedBranchId);
  const dbChanged = nextDbName !== activeDbName || normalizedBranchId !== activeBranchId;

  activeBranchId = normalizedBranchId;
  activeBranchName = typeof branchName === 'string' && branchName.trim() ? branchName.trim() : null;

  if (nextDbName !== activeDbName) {
    openDbEpoch += 1;
    openDbPromise = null;
    openDbPromiseName = null;
    if (dbInstance) {
      markDbHandleClosed(dbInstance);
      dbInstance = null;
    }
    activeDbName = nextDbName;
  }

  if (dbChanged) {
    branchContextListeners.forEach((listener) => {
      try {
        listener(activeBranchId);
      } catch {
        // never interrupt branch switching
      }
    });
  }

  return activeDbName;
}

/**
 * Enables strict FirebaseAuthService authority over actor & branch context.
 * Idempotent: safe across repeated auth module reloads in tests.
 * NEVER exposed on window.PharmacyDB.
 */
export function activateTrustedAuthAuthority(): void {
  authAuthorityEnforced = true;
  if (!trustedAuthSession) {
    activeActorUid = null;
  }
}

export function isTrustedAuthAuthorityEnforced(): boolean {
  return authAuthorityEnforced;
}

export function getTrustedActorSessionState(): TrustedActorSessionState | null {
  return trustedAuthSession
    ? {
        uid: trustedAuthSession.uid,
        role: trustedAuthSession.role,
        branchIds: [...trustedAuthSession.branchIds],
        activeBranchId: trustedAuthSession.activeBranchId,
        emailVerified: trustedAuthSession.emailVerified,
        offlineFallback: trustedAuthSession.offlineFallback,
        ...(trustedAuthSession.expiresAtMs !== undefined
          ? { expiresAtMs: trustedAuthSession.expiresAtMs }
          : {}),
      }
    : null;
}

/**
 * Binds or clears the active runtime actor & verified session authorization strictly from
 * firebaseAuthService.ts. Clears active actor + closes branch DB handle on null/logout/revocation.
 * NEVER exposed on window.PharmacyDB.
 */
export function applyTrustedActorSessionFromAuth(
  session: TrustedActorSessionState | null
): string | null {
  authAuthorityEnforced = true;

  if (session === null) {
    trustedAuthSession = null;
    activeActorUid = null;
    applyBranchContextInternal(null, null);
    return null;
  }

  if (!session || typeof session !== 'object') {
    trustedAuthSession = null;
    activeActorUid = null;
    applyBranchContextInternal(null, null);
    throw new Error('INVALID_ACTOR_SESSION: Trusted actor session object is required');
  }

  if (!isValidFirebaseActorUid(session.uid)) {
    trustedAuthSession = null;
    activeActorUid = null;
    applyBranchContextInternal(null, null);
    throw new Error(`INVALID_ACTOR_UID: Rejected non-UID or placeholder actor identifier "${String(session.uid)}"`);
  }

  if (session.emailVerified !== true) {
    trustedAuthSession = null;
    activeActorUid = null;
    applyBranchContextInternal(null, null);
    throw new Error('EMAIL_NOT_VERIFIED: Verified email is required for runtime actor context');
  }

  if (session.role !== 'super_admin' && session.role !== 'admin' && session.role !== 'cashier') {
    trustedAuthSession = null;
    activeActorUid = null;
    applyBranchContextInternal(null, null);
    throw new Error(`INVALID_ACTOR_ROLE: Unsupported role "${String(session.role)}"`);
  }

  if (session.expiresAtMs !== undefined && isTrustedSessionExpired(session)) {
    trustedAuthSession = null;
    activeActorUid = null;
    applyBranchContextInternal(null, null);
    throw new Error('SESSION_EXPIRED: Trusted actor session has expired');
  }

  const offlineFallback = Boolean(session.offlineFallback);
  if (offlineFallback && session.role !== 'cashier') {
    trustedAuthSession = null;
    activeActorUid = null;
    applyBranchContextInternal(null, null);
    throw new Error('OFFLINE_ROLE_FORBIDDEN: Admin and super_admin privileges are not available offline');
  }

  const cleanBranchIds = normalizeTrustedBranchIds(session.branchIds);
  if (session.role === 'cashier' && cleanBranchIds.length !== 1) {
    trustedAuthSession = null;
    activeActorUid = null;
    applyBranchContextInternal(null, null);
    throw new Error('INVALID_BRANCH_CONFIG: Cashier session must bind to exactly one branch');
  }
  if (session.role === 'admin' && cleanBranchIds.length === 0) {
    trustedAuthSession = null;
    activeActorUid = null;
    applyBranchContextInternal(null, null);
    throw new Error('INVALID_BRANCH_CONFIG: Admin session requires at least one assigned branch');
  }

  const candidateBranch =
    typeof session.activeBranchId === 'string' && isValidOutboxBranchId(session.activeBranchId)
      ? session.activeBranchId.trim()
      : null;
  const resolvedActiveBranch =
    session.role === 'super_admin'
      ? candidateBranch || cleanBranchIds[0] || 'khalid-1'
      : candidateBranch && cleanBranchIds.includes(candidateBranch)
        ? candidateBranch
        : cleanBranchIds[0] || null;

  const frozenSession: TrustedActorSessionState = Object.freeze({
    uid: session.uid,
    role: session.role,
    branchIds: Object.freeze([...cleanBranchIds]) as string[],
    activeBranchId: resolvedActiveBranch,
    emailVerified: true,
    offlineFallback,
    ...(session.expiresAtMs !== undefined ? { expiresAtMs: session.expiresAtMs } : {}),
  });

  trustedAuthSession = frozenSession;
  activeActorUid = frozenSession.uid;

  if (!activeBranchId || !isBranchAuthorizedForSession(frozenSession, activeBranchId)) {
    applyBranchContextInternal(resolvedActiveBranch, null);
  }

  return activeActorUid;
}

/**
 * Sets module-scoped active actor UID.
 * Blocked whenever FirebaseAuthService authority is active so public/UI callers cannot spoof UID.
 * Retained only for isolated non-auth Phase F4 Node unit tests that do not import firebaseAuthService.ts.
 */
export function setActiveActorContext(uid: string | null): string | null {
  if (authAuthorityEnforced) {
    throw new Error(
      'UNTRUSTED_ACTOR_CONTEXT_CALL: Active actor UID is controlled exclusively by verified FirebaseAuthService sessions'
    );
  }
  if (uid === null || uid === undefined || (typeof uid === 'string' && uid.trim() === '')) {
    activeActorUid = null;
    return null;
  }
  if (!isValidFirebaseActorUid(uid)) {
    throw new Error(`INVALID_ACTOR_UID: Rejected non-UID or placeholder actor identifier "${String(uid)}"`);
  }
  activeActorUid = uid;
  return activeActorUid;
}

export function getKnownActiveActorId(): string | undefined {
  if (authAuthorityEnforced) {
    if (
      !trustedAuthSession ||
      !isValidFirebaseActorUid(trustedAuthSession.uid) ||
      trustedAuthSession.emailVerified !== true ||
      isTrustedSessionExpired(trustedAuthSession) ||
      (trustedAuthSession.offlineFallback && trustedAuthSession.role !== 'cashier')
    ) {
      return undefined;
    }
    return trustedAuthSession.uid;
  }
  return activeActorUid && isValidFirebaseActorUid(activeActorUid) ? activeActorUid : undefined;
}

export function getBranchDbName(branchId?: string | null): string {
  const clean = typeof branchId === 'string' ? branchId.trim() : '';
  if (!clean || clean === 'khalid-1') {
    return DB_NAME;
  }
  return `${DB_NAME}__branch__${clean.replace(/[^a-zA-Z0-9_\-]/g, '_')}`;
}

export function getActiveBranchId(): string | null {
  return activeBranchId;
}

export function getActiveBranchName(): string | null {
  return activeBranchName;
}

export function getActiveDbName(): string {
  return activeDbName;
}

export function onBranchContextChange(listener: (branchId: string | null) => void): () => void {
  branchContextListeners.add(listener);
  return () => {
    branchContextListeners.delete(listener);
  };
}

export function setActiveBranchContext(branchId: string | null, branchName?: string | null): string {
  const normalizedBranchId = typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null;

  if (authAuthorityEnforced) {
    if (
      !trustedAuthSession ||
      !isValidFirebaseActorUid(trustedAuthSession.uid) ||
      trustedAuthSession.emailVerified !== true
    ) {
      throw new Error(
        'BRANCH_AUTH_REQUIRED: Cannot switch branch context without a verified authenticated session'
      );
    }
    if (isTrustedSessionExpired(trustedAuthSession)) {
      throw new Error(
        'SESSION_EXPIRED: Cannot switch branch context with an expired authenticated session'
      );
    }
    if (trustedAuthSession.offlineFallback && trustedAuthSession.role !== 'cashier') {
      throw new Error(
        'OFFLINE_ROLE_FORBIDDEN: Admin and super_admin branch operations are not permitted offline'
      );
    }
    if (!normalizedBranchId || !isValidOutboxBranchId(normalizedBranchId)) {
      throw new Error('INVALID_BRANCH_ID: A valid branch identifier is required');
    }
    if (!isBranchAuthorizedForSession(trustedAuthSession, normalizedBranchId)) {
      throw new Error(
        `BRANCH_ACCESS_DENIED: User (${trustedAuthSession.role}) is not authorized for branch "${normalizedBranchId}"`
      );
    }
  }

  return applyBranchContextInternal(normalizedBranchId, branchName);
}

export function getIDBFactory(): IDBFactory | null {
  if (typeof indexedDB !== 'undefined') return indexedDB;
  if (typeof window !== 'undefined' && window.indexedDB) return window.indexedDB;
  if (typeof globalThis !== 'undefined' && (globalThis as any).indexedDB) return (globalThis as any).indexedDB;
  return null;
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // fallback
  }
  return null;
}

export function getDeviceId(): string {
  if (currentDeviceId) return currentDeviceId;
  try {
    const storage = getLocalStorage();
    const saved = storage ? storage.getItem('khalid_device_id') : null;
    if (saved) {
      currentDeviceId = saved;
      return saved;
    }
    const newId = 'dev-' + generateUUID().substring(0, 8);
    if (storage) storage.setItem('khalid_device_id', newId);
    currentDeviceId = newId;
    return newId;
  } catch {
    return 'dev-browser-session';
  }
}

export function openPharmacyDB(options?: { blockedTimeoutMs?: number }): Promise<IDBDatabase> {
  const targetDbName = activeDbName;
  if (dbInstance) {
    if (isOpenDbInstanceHealthy(dbInstance, targetDbName)) {
      return Promise.resolve(dbInstance);
    }
    markDbHandleClosed(dbInstance);
    dbInstance = null;
  }

  if (openDbPromise && openDbPromiseName === targetDbName) {
    return openDbPromise;
  }

  const idb = getIDBFactory();
  if (!idb) {
    return Promise.reject(new Error('IndexedDB is not supported in this environment'));
  }

  const blockedTimeoutMs =
    typeof options?.blockedTimeoutMs === 'number' &&
    Number.isFinite(options.blockedTimeoutMs) &&
    options.blockedTimeoutMs > 0
      ? Math.min(options.blockedTimeoutMs, 60_000)
      : DEFAULT_DB_OPEN_BLOCKED_TIMEOUT_MS;

  const callEpoch = openDbEpoch;
  let settled = false;
  let pendingPromise!: Promise<IDBDatabase>;
  const clearPendingIfCurrent = () => {
    if (openDbPromise === pendingPromise) {
      openDbPromise = null;
      openDbPromiseName = null;
    }
  };

  pendingPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let timedOut = false;
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;
    const clearBlockedTimer = () => {
      if (blockedTimer !== null) {
        clearTimeout(blockedTimer);
        blockedTimer = null;
      }
    };

    const rejectPending = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearBlockedTimer();
      clearPendingIfCurrent();
      reject(err instanceof Error ? err : new Error(String(err || 'Failed to open IndexedDB')));
    };

    let request: IDBOpenDBRequest;
    try {
      request = idb.open(targetDbName, DB_VERSION);
    } catch (syncErr) {
      rejectPending(syncErr);
      return;
    }

    request.onupgradeneeded = (event) => {
      clearBlockedTimer();
      const db = (event.target as IDBOpenDBRequest).result;
      const tx = (event.target as IDBOpenDBRequest).transaction;
      if (settled || timedOut || callEpoch !== openDbEpoch || targetDbName !== activeDbName) {
        if (tx) {
          try {
            tx.abort();
          } catch {
            // ignore abort error
          }
        }
        return;
      }
      if (tx) {
        tx.onabort = () => {
          clearBlockedTimer();
          clearPendingIfCurrent();
        };
      }

      // 1. Medicines
      if (!db.objectStoreNames.contains('medicines')) {
        const medStore = db.createObjectStore('medicines', { keyPath: 'id' });
        medStore.createIndex('barcode', 'barcode', { unique: false });
        medStore.createIndex('category', 'category', { unique: false });
      }

      // 2. Append-Only Inventory Ledger
      if (!db.objectStoreNames.contains('inventory_ledger')) {
        const ledgerStore = db.createObjectStore('inventory_ledger', { keyPath: 'id' });
        ledgerStore.createIndex('medicineId', 'medicineId', { unique: false });
        ledgerStore.createIndex('timestamp', 'timestamp', { unique: false });
        ledgerStore.createIndex('referenceId', 'referenceId', { unique: false });
        ledgerStore.createIndex('type', 'type', { unique: false });
        ledgerStore.createIndex('synced', 'synced', { unique: false });
      }

      // 3. Sales & Invoices
      if (!db.objectStoreNames.contains('sales')) {
        const salesStore = db.createObjectStore('sales', { keyPath: 'id' });
        salesStore.createIndex('invoiceNumber', 'invoiceNumber', { unique: false });
        salesStore.createIndex('timestamp', 'timestamp', { unique: false });
        salesStore.createIndex('synced', 'synced', { unique: false });
      }

      // 4. Suppliers
      if (!db.objectStoreNames.contains('suppliers')) {
        const supStore = db.createObjectStore('suppliers', { keyPath: 'id' });
        supStore.createIndex('status', 'status', { unique: false });
        supStore.createIndex('phone', 'phone', { unique: false });
      } else if (tx) {
        const supStore = tx.objectStore('suppliers');
        if (!supStore.indexNames.contains('status')) {
          supStore.createIndex('status', 'status', { unique: false });
        }
        if (!supStore.indexNames.contains('phone')) {
          supStore.createIndex('phone', 'phone', { unique: false });
        }
      }

      // 5. Receipts (Preserving Bankak receipts schema)
      if (!db.objectStoreNames.contains('receipts')) {
        const receiptsStore = db.createObjectStore('receipts', { keyPath: 'id' });
        receiptsStore.createIndex('transactionId', 'transactionId', { unique: false });
        receiptsStore.createIndex('status', 'status', { unique: false });
      }

      // 6. Outbox for Offline Sync & Idempotency
      if (!db.objectStoreNames.contains('outbox')) {
        const outboxStore = db.createObjectStore('outbox', { keyPath: 'id' });
        outboxStore.createIndex('status', 'status', { unique: false });
        outboxStore.createIndex('timestamp', 'timestamp', { unique: false });
      }

      // 7. System metadata
      if (!db.objectStoreNames.contains('metadata')) {
        db.createObjectStore('metadata', { keyPath: 'key' });
      }

      // 8. Phase 1 Upgrade: Purchase Invoices Store
      if (!db.objectStoreNames.contains('purchase_invoices')) {
        const invoiceStore = db.createObjectStore('purchase_invoices', { keyPath: 'id' });
        invoiceStore.createIndex('supplierId', 'supplierId', { unique: false });
        invoiceStore.createIndex('invoiceNumber', 'invoiceNumber', { unique: false });
        invoiceStore.createIndex('date', 'date', { unique: false });
        invoiceStore.createIndex('paymentType', 'paymentType', { unique: false });
        invoiceStore.createIndex('paymentStatus', 'paymentStatus', { unique: false });
        invoiceStore.createIndex('synced', 'synced', { unique: false });
        invoiceStore.createIndex('supplier_invoice', ['supplierId', 'invoiceNumber'], { unique: false });
      }

      // 9. Phase 1 Upgrade: Supplier Financial Transactions Store
      if (!db.objectStoreNames.contains('supplier_transactions')) {
        const txStore = db.createObjectStore('supplier_transactions', { keyPath: 'id' });
        txStore.createIndex('supplierId', 'supplierId', { unique: false });
        txStore.createIndex('type', 'type', { unique: false });
        txStore.createIndex('date', 'date', { unique: false });
        txStore.createIndex('timestamp', 'timestamp', { unique: false });
        txStore.createIndex('referenceId', 'referenceId', { unique: false });
        txStore.createIndex('synced', 'synced', { unique: false });
      }

      // 10. Phase 4: Supplier Invoice OCR Drafts Store
      if (!db.objectStoreNames.contains('supplier_invoice_drafts')) {
        const draftStore = db.createObjectStore('supplier_invoice_drafts', { keyPath: 'id' });
        draftStore.createIndex('status', 'status', { unique: false });
        draftStore.createIndex('createdAt', 'createdAt', { unique: false });
        draftStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      // 11. Phase 5: Stocktaking Sessions Store
      if (!db.objectStoreNames.contains('stocktaking_sessions')) {
        const stStore = db.createObjectStore('stocktaking_sessions', { keyPath: 'id' });
        stStore.createIndex('status', 'status', { unique: false });
        stStore.createIndex('startedAt', 'startedAt', { unique: false });
        stStore.createIndex('committedAt', 'committedAt', { unique: false });
      }

      // 12. Phase A Upgrade: Bankak Persistent Tombstones Store
      if (!db.objectStoreNames.contains('bankak_tombstones')) {
        const tombstoneStore = db.createObjectStore('bankak_tombstones', { keyPath: 'id' });
        tombstoneStore.createIndex('transactionId', 'transactionId', { unique: false });
        tombstoneStore.createIndex('deletedAt', 'deletedAt', { unique: false });
        tombstoneStore.createIndex('syncStatus', 'syncStatus', { unique: false });
      }

      // 13. Phase 2D-3B-2b.3 Upgrade (DB_VERSION 6): Stocktaking Items Subcollection Store
      if (!db.objectStoreNames.contains('stocktaking_items')) {
        const stItemsStore = db.createObjectStore('stocktaking_items', { keyPath: 'id' });
        stItemsStore.createIndex('sessionId', 'sessionId', { unique: false });
        stItemsStore.createIndex('branchId', 'branchId', { unique: false });
        stItemsStore.createIndex('medicineId', 'medicineId', { unique: false });
        stItemsStore.createIndex('session_medicine', ['sessionId', 'medicineId'], { unique: false });
      }
    };

    request.onblocked = (_event) => {
      console.warn('KhalidPharmacyDB version upgrade blocked by active connection in another tab or context');
      if (settled || blockedTimer !== null) return;
      blockedTimer = setTimeout(() => {
        blockedTimer = null;
        if (settled) return;
        timedOut = true;
        if (callEpoch !== openDbEpoch || targetDbName !== activeDbName) {
          rejectPending(
            new Error(`DB_CONTEXT_CHANGED: Active database context switched from "${targetDbName}" while blocked`)
          );
          return;
        }
        rejectPending(
          new Error(
            `DB_OPEN_BLOCKED_TIMEOUT: Opening database "${targetDbName}" remained blocked for over ${blockedTimeoutMs}ms`
          )
        );
      }, blockedTimeoutMs);
    };

    request.onsuccess = (event) => {
      clearBlockedTimer();
      const opened = (event.target as IDBOpenDBRequest).result;
      if (settled || timedOut) {
        markDbHandleClosed(opened);
        clearPendingIfCurrent();
        return;
      }

      opened.onversionchange = () => {
        markDbHandleClosed(opened);
        if (dbInstance === opened) dbInstance = null;
        clearPendingIfCurrent();
      };
      opened.onclose = () => {
        closedDbHandles.add(opened);
        if (dbInstance === opened) dbInstance = null;
        clearPendingIfCurrent();
      };

      if (callEpoch !== openDbEpoch || targetDbName !== activeDbName) {
        markDbHandleClosed(opened);
        rejectPending(new Error(`DB_CONTEXT_CHANGED: Active database context switched from "${targetDbName}" during open`));
        return;
      }

      if (!isOpenDbInstanceHealthy(opened, targetDbName)) {
        markDbHandleClosed(opened);
        rejectPending(new Error(`DB_HANDLE_INVALID: Opened database handle "${targetDbName}" is closed or missing required stores`));
        return;
      }

      dbInstance = opened;
      settled = true;
      clearPendingIfCurrent();
      resolve(opened);
    };

    request.onerror = (event) => {
      clearBlockedTimer();
      rejectPending((event.target as IDBOpenDBRequest).error || new Error(`Failed to open database "${targetDbName}"`));
    };
  });

  if (!settled && callEpoch === openDbEpoch && targetDbName === activeDbName && !dbInstance) {
    openDbPromise = pendingPromise;
    openDbPromiseName = targetDbName;
  }

  return pendingPromise;
}

// Convert a quantity in a specific unit to base pills
export function convertToBasePills(qty: number, unit: UnitKind, stripsPerPack: number, pillsPerStrip: number): number {
  if (!Number.isSafeInteger(qty)) throw new Error('الكمية يجب أن تكون عدداً صحيحاً آمناً');
  if (unit === 'pill') return qty;
  if (!Number.isSafeInteger(stripsPerPack) || stripsPerPack <= 0 ||
      !Number.isSafeInteger(pillsPerStrip) || pillsPerStrip <= 0) {
    throw new Error('بيانات تحويل العبوة أو الشريط غير موثقة؛ يمنع افتراض 2×10');
  }
  if (unit === 'strip') return qty * pillsPerStrip;
  return qty * stripsPerPack * pillsPerStrip;
}

// Convert base pills to packs
export function convertPillsToPacks(pills: number, stripsPerPack: number, pillsPerStrip: number): number {
  if (!Number.isSafeInteger(stripsPerPack) || stripsPerPack <= 0 ||
      !Number.isSafeInteger(pillsPerStrip) || pillsPerStrip <= 0) {
    throw new Error('بيانات تحويل العبوة غير موثقة؛ يمنع افتراض 2×10');
  }
  const pillsPerPack = stripsPerPack * pillsPerStrip;
  return Number((pills / pillsPerPack).toFixed(2));
}

// Format detailed unit breakdown
export function formatStockBreakdown(totalPills: number, stripsPerPack: number, pillsPerStrip: number): string {
  if (totalPills <= 0) return '0';
  if (!Number.isSafeInteger(stripsPerPack) || stripsPerPack <= 0 ||
      !Number.isSafeInteger(pillsPerStrip) || pillsPerStrip <= 0) {
    throw new Error('بيانات تحويل العبوة غير موثقة؛ يمنع افتراض 2×10');
  }
  const pillsPerPack = stripsPerPack * pillsPerStrip;
  const packs = Math.floor(totalPills / pillsPerPack);
  const remainingPillsAfterPacks = totalPills % pillsPerPack;
  const strips = Math.floor(remainingPillsAfterPacks / pillsPerStrip);
  const pills = remainingPillsAfterPacks % pillsPerStrip;

  const parts: string[] = [];
  if (packs > 0) parts.push(`${packs} علبة`);
  if (strips > 0) parts.push(`${strips} شريط`);
  if (pills > 0) parts.push(`${pills} حبة`);

  return parts.length > 0 ? parts.join(' و ') : '0';
}

/**
 * Migration & Initial Seeding Engine
 * Safely preserves old receipts from KhalidPharmacyBankakDB and seeds default data on fresh installs.
 */

export interface StocktakingItemRecord extends StocktakingItem {
  id: string;
  sessionId: string;
  branchId: string;
  createdAt: string;
  updatedAt: string;
  updatedByUid?: string;
  syncStatus?: 'pending_sync' | 'synced';
}

export interface MigrateLegacyStocktakingResult {
  migrated: boolean;
  migratedSessions: number;
  migratedItems: number;
  skippedItems: number;
  quarantinedCount: number;
  existingCountBefore: number;
  finalCountAfter: number;
  error?: string;
}

const VALID_STOCKTAKING_DOC_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

function isValidStocktakingDocId(val: unknown): val is string {
  return typeof val === 'string' && VALID_STOCKTAKING_DOC_ID_REGEX.test(val.trim());
}

/**
 * Non-destructive, idempotent DB_VERSION 6 migration moving inline legacy
 * stocktaking_sessions[].items into the dedicated `stocktaking_items` object store
 * while preserving original `session.items` for UI compatibility and quarantining
 * malformed entries in `metadata` without generating Outbox or Ledger side effects.
 */
export async function migrateLegacyStocktakingItems(
  targetDb?: IDBDatabase
): Promise<MigrateLegacyStocktakingResult> {
  const idb = getIDBFactory();
  if (!idb && !targetDb) {
    return {
      migrated: false,
      migratedSessions: 0,
      migratedItems: 0,
      skippedItems: 0,
      quarantinedCount: 0,
      existingCountBefore: 0,
      finalCountAfter: 0,
      error: 'No IDB available'
    };
  }

  const db = targetDb || (await openPharmacyDB());
  for (const storeName of ['stocktaking_sessions', 'stocktaking_items', 'metadata']) {
    if (!db.objectStoreNames.contains(storeName)) {
      return {
        migrated: false,
        migratedSessions: 0,
        migratedItems: 0,
        skippedItems: 0,
        quarantinedCount: 0,
        existingCountBefore: 0,
        finalCountAfter: 0,
        error: `Target store not found: ${storeName}`
      };
    }
  }

  const nowIso = new Date().toISOString();
  const fallbackBranch = getKnownActiveBranchId() || 'khalid-1';

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['stocktaking_sessions', 'stocktaking_items', 'metadata'], 'readwrite');
    const sessStore = tx.objectStore('stocktaking_sessions');
    const itemStore = tx.objectStore('stocktaking_items');
    const metaStore = tx.objectStore('metadata');

    let sessions: any[] = [];
    let existingItems: StocktakingItemRecord[] = [];
    let sessLoaded = false;
    let itemsLoaded = false;
    let finalized = false;
    let result: MigrateLegacyStocktakingResult = {
      migrated: true,
      migratedSessions: 0,
      migratedItems: 0,
      skippedItems: 0,
      quarantinedCount: 0,
      existingCountBefore: 0,
      finalCountAfter: 0
    };

    const runMigration = () => {
      if (finalized || !sessLoaded || !itemsLoaded) return;
      finalized = true;

      const existingIds = new Set<string>();
      const existingPairs = new Set<string>();
      for (const it of existingItems) {
        if (!it) continue;
        if (typeof it.id === 'string' && it.id) existingIds.add(it.id);
        if (typeof it.sessionId === 'string' && typeof it.medicineId === 'string') {
          existingPairs.add(`${it.sessionId}::${it.medicineId}`);
        }
      }

      let migratedSessions = 0;
      let migratedItems = 0;
      let skippedItems = 0;
      const quarantinedRecords: Array<{ sessionId: string; index: number; medicineId?: string; reason: string }> = [];
      let totalLegacyItemsSeen = 0;

      for (const rawSess of sessions) {
        if (!rawSess || typeof rawSess !== 'object') {
          quarantinedRecords.push({
            sessionId: 'unknown',
            index: -1,
            reason: 'Malformed session object in stocktaking_sessions'
          });
          continue;
        }
        const sessId = typeof rawSess.id === 'string' ? rawSess.id.trim() : '';
        if (!isValidStocktakingDocId(sessId)) {
          quarantinedRecords.push({
            sessionId: String(rawSess.id || 'missing'),
            index: -1,
            reason: 'Invalid Firestore sessionId; legacy record preserved untouched'
          });
          continue;
        }

        const rawItems = Array.isArray(rawSess.items) ? rawSess.items : [];
        if (rawItems.length === 0) continue;

        const sessBranch =
          typeof rawSess.branchId === 'string' && isValidOutboxBranchId(rawSess.branchId)
            ? rawSess.branchId.trim()
            : fallbackBranch;

        let sessionHadMigrated = false;

        for (let idx = 0; idx < rawItems.length; idx += 1) {
          totalLegacyItemsSeen += 1;
          const rawItem = rawItems[idx];
          if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
            quarantinedRecords.push({
              sessionId: sessId,
              index: idx,
              reason: 'Malformed item entry (non-object)'
            });
            continue;
          }

          const medId = typeof rawItem.medicineId === 'string' ? rawItem.medicineId.trim() : '';
          if (!isValidStocktakingDocId(medId)) {
            quarantinedRecords.push({
              sessionId: sessId,
              index: idx,
              medicineId: String(rawItem.medicineId || ''),
              reason: 'Invalid or missing medicineId'
            });
            continue;
          }

          const sysStock = Number(rawItem.systemStock ?? 0);
          const actualCount = Number(rawItem.actualCount ?? 0);
          const buyPrice = Number(rawItem.buyPrice ?? 0);
          if (
            !Number.isFinite(sysStock) ||
            sysStock < 0 ||
            !Number.isFinite(actualCount) ||
            actualCount < 0 ||
            !Number.isFinite(buyPrice) ||
            buyPrice < 0
          ) {
            quarantinedRecords.push({
              sessionId: sessId,
              index: idx,
              medicineId: medId,
              reason: 'Negative or non-finite numeric quantity/price'
            });
            continue;
          }

          const itemBranch =
            typeof rawItem.branchId === 'string' && isValidOutboxBranchId(rawItem.branchId)
              ? rawItem.branchId.trim()
              : sessBranch;

          const itemId = isValidStocktakingDocId(rawItem.id)
            ? rawItem.id.trim()
            : deriveStocktakingItemId(itemBranch, sessId, medId);

          const pairKey = `${sessId}::${medId}`;
          if (existingIds.has(itemId) || existingPairs.has(pairKey)) {
            skippedItems += 1;
            continue;
          }

          const variance = Number.isFinite(Number(rawItem.variance))
            ? Number(rawItem.variance)
            : Number((actualCount - sysStock).toFixed(2));
          const varianceSDG = Number.isFinite(Number(rawItem.varianceSDG))
            ? Number(rawItem.varianceSDG)
            : Number((variance * buyPrice).toFixed(2));
          const createdAt =
            typeof rawItem.createdAt === 'string' && rawItem.createdAt.trim()
              ? rawItem.createdAt.trim()
              : typeof rawSess.startedAt === 'string' && rawSess.startedAt.trim()
                ? rawSess.startedAt.trim()
                : nowIso;
          const updatedAt =
            typeof rawItem.updatedAt === 'string' && rawItem.updatedAt.trim()
              ? rawItem.updatedAt.trim()
              : typeof rawItem.lastScannedAt === 'string' && rawItem.lastScannedAt.trim()
                ? rawItem.lastScannedAt.trim()
                : createdAt;

          const medNameRaw =
            typeof rawItem.medicineName === 'string' && rawItem.medicineName.trim()
              ? rawItem.medicineName.trim().slice(0, 200)
              : medId;

          const migratedRecord: StocktakingItemRecord = {
            id: itemId,
            sessionId: sessId,
            branchId: itemBranch,
            medicineId: medId,
            medicineName: medNameRaw,
            barcode: typeof rawItem.barcode === 'string' ? rawItem.barcode.slice(0, 64) : '',
            ...(Array.isArray(rawItem.secondaryBarcodes) ? { secondaryBarcodes: rawItem.secondaryBarcodes } : {}),
            ...(typeof rawItem.batchNumber === 'string' ? { batchNumber: rawItem.batchNumber.slice(0, 64) } : {}),
            ...(typeof rawItem.expiry === 'string' ? { expiry: rawItem.expiry.slice(0, 32) } : {}),
            unit: rawItem.unit === 'strip' || rawItem.unit === 'pill' ? rawItem.unit : 'pack',
            systemStock: sysStock,
            actualCount,
            variance,
            variancePacks: Number.isFinite(Number(rawItem.variancePacks)) ? Number(rawItem.variancePacks) : variance,
            buyPrice,
            ...(rawItem.sellPrice !== undefined && Number.isFinite(Number(rawItem.sellPrice)) && Number(rawItem.sellPrice) >= 0
              ? { sellPrice: Number(rawItem.sellPrice) }
              : {}),
            varianceSDG,
            varianceCost: Number.isFinite(Number(rawItem.varianceCost)) ? Number(rawItem.varianceCost) : varianceSDG,
            lastScannedAt:
              typeof rawItem.lastScannedAt === 'string' && rawItem.lastScannedAt.trim()
                ? rawItem.lastScannedAt.trim()
                : updatedAt,
            createdAt,
            updatedAt,
            syncStatus:
              rawSess.status === 'committed' || rawSess.status === 'COMMITTED' || rawSess.status === 'sync_completed_unverified'
                ? 'synced'
                : 'pending_sync'
          };

          itemStore.put(migratedRecord);
          existingIds.add(itemId);
          existingPairs.add(pairKey);
          migratedItems += 1;
          sessionHadMigrated = true;
        }

        if (sessionHadMigrated) {
          migratedSessions += 1;
        }
      }

      const finalCountAfter = existingItems.length + migratedItems;
      metaStore.put({
        key: 'stocktaking_items_v6_migrated',
        value: true,
        version: 6,
        totalLegacyItemsSeen,
        migratedSessions,
        migratedItems,
        skippedItems,
        quarantinedCount: quarantinedRecords.length,
        quarantinedRecords: quarantinedRecords.slice(0, 100),
        existingCountBefore: existingItems.length,
        finalCountAfter,
        migratedAt: nowIso
      });

      result = {
        migrated: true,
        migratedSessions,
        migratedItems,
        skippedItems,
        quarantinedCount: quarantinedRecords.length,
        existingCountBefore: existingItems.length,
        finalCountAfter
      };
    };

    const sReq = sessStore.getAll();
    sReq.onsuccess = () => {
      sessions = sReq.result || [];
      sessLoaded = true;
      runMigration();
    };
    sReq.onerror = () => reject(sReq.error || new Error('Failed reading stocktaking_sessions for v6 migration'));

    const iReq = itemStore.getAll();
    iReq.onsuccess = () => {
      existingItems = (iReq.result as StocktakingItemRecord[]) || [];
      itemsLoaded = true;
      runMigration();
    };
    iReq.onerror = () => reject(iReq.error || new Error('Failed reading stocktaking_items for v6 migration'));

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Stocktaking v6 migration transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Stocktaking v6 migration transaction aborted'));
  });
}

/**
 * Fully awaited, atomic legacy Bankak migration from KhalidPharmacyBankakDB into KhalidPharmacyDB.
 * Returns migration result and writes an audit record into 'metadata'.
 */
export async function migrateLegacyBankakDB(targetDb?: IDBDatabase): Promise<{
  migrated: boolean;
  count: number;
  error?: string;
  nonexistent?: boolean;
}> {
  const idb = getIDBFactory();
  if (!idb) return { migrated: false, count: 0, error: 'No IDB available' };

  const db = targetDb || (await openPharmacyDB());
  for (const storeName of ['receipts', 'metadata', 'bankak_tombstones']) {
    if (!db.objectStoreNames.contains(storeName)) {
      return { migrated: false, count: 0, error: 'Target store not found: ' + storeName };
    }
  }

  const writeMigrationMarker = async (extra: Record<string, unknown> = {}) => {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('metadata', 'readwrite');
      tx.objectStore('metadata').put({
        key: 'legacy_bankak_migrated',
        value: true,
        count: 0,
        timestamp: new Date().toISOString(),
        ...extra
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to save Bankak migration metadata'));
      tx.onabort = () => reject(tx.error || new Error('Bankak migration metadata transaction aborted'));
    });
  };

  try {
    const alreadyMigrated = await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction('metadata', 'readonly');
      const request = tx.objectStore('metadata').get('legacy_bankak_migrated');
      let migrated = false;
      request.onsuccess = () => {
        migrated = !!request.result &&
          (request.result.value === true || request.result.migrated === true);
      };
      request.onerror = () => reject(request.error || new Error('Could not read Bankak migration metadata'));
      tx.oncomplete = () => resolve(migrated);
      tx.onerror = () => reject(tx.error || new Error('Could not read Bankak migration metadata'));
      tx.onabort = () => reject(tx.error || new Error('Bankak migration metadata read aborted'));
    });

    if (alreadyMigrated) return { migrated: true, count: 0 };

    // Abort the implicit version-1 upgrade when the legacy database is absent;
    // never create an empty legacy database just by checking for it.
    const oldDb = await new Promise<IDBDatabase | null>((resolve, reject) => {
      const request = idb.open('KhalidPharmacyBankakDB');
      let absent = false;
      let settled = false;
      request.onupgradeneeded = (event) => {
        if ((event as IDBVersionChangeEvent).oldVersion === 0) {
          absent = true;
          try { request.transaction?.abort(); } catch { /* expected for an absent legacy database */ }
        }
      };
      request.onblocked = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Legacy Bankak database open is blocked by another connection'));
        }
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        if (absent) resolve(null);
        else reject(request.error || new Error('Could not open legacy Bankak database'));
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        resolve(request.result);
      };
    });

    if (!oldDb) {
      await writeMigrationMarker({ nonexistent: true });
      return { migrated: true, count: 0, nonexistent: true };
    }

    try {
      if (!oldDb.objectStoreNames.contains('receipts')) {
        await writeMigrationMarker({ nonexistent: true });
        return { migrated: true, count: 0, nonexistent: true };
      }

      const legacyReceipts = await new Promise<any[]>((resolve, reject) => {
        const tx = oldDb.transaction('receipts', 'readonly');
        const request = tx.objectStore('receipts').getAll();
        let records: any[] = [];
        request.onsuccess = () => { records = request.result || []; };
        request.onerror = () => reject(request.error || new Error('Could not read legacy Bankak receipts'));
        tx.oncomplete = () => resolve(records);
        tx.onerror = () => reject(tx.error || new Error('Legacy Bankak read transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('Legacy Bankak read transaction aborted'));
      });

      const counts = await new Promise<{ imported: number; skippedExisting: number; skippedDeleted: number }>((resolve, reject) => {
        const tx = db.transaction(['receipts', 'metadata', 'bankak_tombstones'], 'readwrite');
        const receipts = tx.objectStore('receipts');
        const tombstones = tx.objectStore('bankak_tombstones');
        const metadata = tx.objectStore('metadata');
        let imported = 0;
        let skippedExisting = 0;
        let skippedDeleted = 0;
        let pending = legacyReceipts.length;

        const persistResult = () => {
          metadata.put({
            key: 'legacy_bankak_migrated',
            value: true,
            count: imported,
            imported,
            skippedExisting,
            skippedDeleted,
            timestamp: new Date().toISOString()
          });
        };

        if (pending === 0) persistResult();

        const abortOnRequestError = (error: DOMException | null, fallback: string) => {
          try { tx.abort(); } catch { /* transaction may already be inactive */ }
          reject(error || tx.error || new Error(fallback));
        };

        const recordFinished = () => {
          pending -= 1;
          if (pending === 0) persistResult();
        };

        for (const record of legacyReceipts) {
          if (!record || record.id === undefined || record.id === null) {
            recordFinished();
            continue;
          }

          // The current v5 schema is keyed by "id". Keep that established keyPath;
          // do not adopt the older Phase A branch's incompatible "receiptId" schema.
          const tombstoneRequest = tombstones.get(record.id);
          tombstoneRequest.onerror = () => abortOnRequestError(
            tombstoneRequest.error,
            'Could not check Bankak deletion tombstone'
          );
          tombstoneRequest.onsuccess = () => {
            if (tombstoneRequest.result) {
              skippedDeleted += 1;
              recordFinished();
              return;
            }

            const existingRequest = receipts.get(record.id);
            existingRequest.onerror = () => abortOnRequestError(
              existingRequest.error,
              'Could not check existing primary Bankak receipt'
            );
            existingRequest.onsuccess = () => {
              if (existingRequest.result) {
                skippedExisting += 1;
              } else {
                receipts.put(record);
                imported += 1;
              }
              recordFinished();
            };
          };
        }

        tx.oncomplete = () => resolve({ imported, skippedExisting, skippedDeleted });
        tx.onerror = () => reject(tx.error || new Error('Bankak legacy migration transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('Bankak legacy migration transaction aborted'));
      });

      return { migrated: true, count: counts.imported };
    } finally {
      oldDb.close();
    }
  } catch (err: any) {
    console.error('Error during Bankak legacy migration:', err);
    return { migrated: false, count: 0, error: err?.message || String(err) };
  }
}
/**
 * Migration & Initial Seeding Engine
 * Safely preserves old receipts from KhalidPharmacyBankakDB and seeds default data on fresh installs.
 */

export const LOCAL_FIRST_MUTATION_MUTEX_KEY = 'khalid_pharmacy:local_first_mutation_lock_v1';
const LOCAL_FIRST_MUTATION_WEB_LOCK_NAME = 'khalid-pharmacy-local-first-mutation-v1';

export interface LocalFirstMutationMutexLease {
  readonly key: typeof LOCAL_FIRST_MUTATION_MUTEX_KEY;
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly kind: string;
  readonly fencingToken: number;
  readonly acquiredAtMs: number;
}

/**
 * Cross-tab mutual exclusion for migration and legacy V1 cloud writers.
 * Production browser contexts require the Web Locks API; Node test contexts use
 * a process-local queue only, which is not treated as browser concurrency proof.
 * The short IndexedDB lease is durable evidence/fencing metadata; no IDB
 * transaction is held while awaiting network operations.
 */
let nodeMutationMutexTail: Promise<void> = Promise.resolve();

async function acquireLocalFirstMutationMutexLease(kind: string): Promise<LocalFirstMutationMutexLease> {
  const db = await openPharmacyDB();
  if (!db.objectStoreNames.contains('metadata')) {
    throw new Error('LOCAL_FIRST_MUTEX_METADATA_UNAVAILABLE');
  }
  const ownerId = `lfm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const acquiredAtMs = Date.now();
  return new Promise((resolve, reject) => {
    let lease: LocalFirstMutationMutexLease | null = null;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(['metadata'], 'readwrite');
    } catch (error) {
      reject(error);
      return;
    }
    const store = tx.objectStore('metadata');
    const req = store.get(LOCAL_FIRST_MUTATION_MUTEX_KEY);
    req.onsuccess = () => {
      try {
        const previous = req.result as Record<string, unknown> | undefined;
        let previousToken = 0;
        if (previous !== undefined) {
          if (
            !previous ||
            typeof previous !== 'object' ||
            previous.schemaVersion !== 1 ||
            !Number.isSafeInteger(previous.fencingToken) ||
            Number(previous.fencingToken) < 0
          ) {
            throw new Error('LOCAL_FIRST_MUTEX_METADATA_CORRUPT');
          }
          previousToken = Number(previous.fencingToken);
        }
        if (previousToken >= Number.MAX_SAFE_INTEGER) {
          throw new Error('LOCAL_FIRST_MUTEX_FENCE_EXHAUSTED');
        }
        lease = {
          key: LOCAL_FIRST_MUTATION_MUTEX_KEY,
          schemaVersion: 1,
          ownerId,
          kind: String(kind || 'UNSPECIFIED').slice(0, 80),
          fencingToken: previousToken + 1,
          acquiredAtMs,
        };
        store.put({
          ...lease,
          heartbeatAtMs: acquiredAtMs,
        });
      } catch (error) {
        try { tx.abort(); } catch { /* ignore */ }
        reject(error);
      }
    };
    req.onerror = () => {
      try { tx.abort(); } catch { /* ignore */ }
      reject(req.error || new Error('LOCAL_FIRST_MUTEX_READ_FAILED'));
    };
    tx.oncomplete = () => {
      if (lease) resolve(lease);
      else reject(new Error('LOCAL_FIRST_MUTEX_ACQUIRE_INCOMPLETE'));
    };
    tx.onerror = () => reject(tx.error || new Error('LOCAL_FIRST_MUTEX_ACQUIRE_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('LOCAL_FIRST_MUTEX_ACQUIRE_ABORTED'));
  });
}

export async function assertLocalFirstMutationMutexLeaseCurrent(
  lease: LocalFirstMutationMutexLease
): Promise<void> {
  const db = await openPharmacyDB();
  const current = await new Promise<Record<string, unknown> | null>((resolve, reject) => {
    const tx = db.transaction(['metadata'], 'readonly');
    const req = tx.objectStore('metadata').get(LOCAL_FIRST_MUTATION_MUTEX_KEY);
    req.onsuccess = () => resolve((req.result as Record<string, unknown> | undefined) ?? null);
    req.onerror = () => reject(req.error || new Error('LOCAL_FIRST_MUTEX_FENCE_READ_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('LOCAL_FIRST_MUTEX_FENCE_READ_ABORTED'));
  });
  if (
    !current ||
    current.schemaVersion !== 1 ||
    current.ownerId !== lease.ownerId ||
    current.fencingToken !== lease.fencingToken
  ) {
    throw new Error('LOCAL_FIRST_MUTEX_FENCE_LOST: refusing further cloud mutation.');
  }
}

async function refreshLocalFirstMutationMutexLease(
  lease: LocalFirstMutationMutexLease
): Promise<void> {
  const db = await openPharmacyDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['metadata'], 'readwrite');
    const store = tx.objectStore('metadata');
    const req = store.get(LOCAL_FIRST_MUTATION_MUTEX_KEY);
    req.onsuccess = () => {
      const current = req.result as Record<string, unknown> | undefined;
      if (
        current &&
        current.ownerId === lease.ownerId &&
        current.fencingToken === lease.fencingToken
      ) {
        store.put({ ...current, heartbeatAtMs: Date.now() });
      }
    };
    req.onerror = () => reject(req.error || new Error('LOCAL_FIRST_MUTEX_HEARTBEAT_READ_FAILED'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('LOCAL_FIRST_MUTEX_HEARTBEAT_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('LOCAL_FIRST_MUTEX_HEARTBEAT_ABORTED'));
  });
}

async function releaseLocalFirstMutationMutexLease(lease: LocalFirstMutationMutexLease): Promise<void> {
  const db = await openPharmacyDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['metadata'], 'readwrite');
    const store = tx.objectStore('metadata');
    const req = store.get(LOCAL_FIRST_MUTATION_MUTEX_KEY);
    req.onsuccess = () => {
      const current = req.result as Record<string, unknown> | undefined;
      if (
        current &&
        current.ownerId === lease.ownerId &&
        current.fencingToken === lease.fencingToken
      ) {
        // Retain the last fence counter after release so the next tab must
        // advance it; deleting the record would reset every acquisition to 1.
        store.put({
          ...current,
          ownerId: '',
          kind: 'RELEASED',
          heartbeatAtMs: Date.now(),
          releasedAtMs: Date.now(),
        });
      }
    };
    req.onerror = () => reject(req.error || new Error('LOCAL_FIRST_MUTEX_RELEASE_READ_FAILED'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('LOCAL_FIRST_MUTEX_RELEASE_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('LOCAL_FIRST_MUTEX_RELEASE_ABORTED'));
  });
}

export async function withLocalFirstMutationMutex<T>(
  kind: string,
  work: (lease: LocalFirstMutationMutexLease) => Promise<T>
): Promise<T> {
  const runWithLease = async (): Promise<T> => {
    const lease = await acquireLocalFirstMutationMutexLease(kind);
    const heartbeat = setInterval(() => {
      void refreshLocalFirstMutationMutexLease(lease).catch(() => {
        // A subsequent fencing check fails closed if durable ownership was lost.
      });
    }, 30_000);
    (heartbeat as { unref?: () => void }).unref?.();
    try {
      await assertLocalFirstMutationMutexLeaseCurrent(lease);
      return await work(lease);
    } finally {
      clearInterval(heartbeat);
      try {
        await releaseLocalFirstMutationMutexLease(lease);
      } catch {
        // The Web Lock is still released by its callback; the next owner advances the fence.
      }
    }
  };

  const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (lockManager && typeof lockManager.request === 'function') {
    return lockManager.request(
      LOCAL_FIRST_MUTATION_WEB_LOCK_NAME,
      { mode: 'exclusive' },
      () => runWithLease()
    );
  }

  if (typeof window !== 'undefined') {
    throw new Error('LOCAL_FIRST_CROSS_TAB_LOCK_UNAVAILABLE: Web Locks are required in browser contexts.');
  }

  // Node-only deterministic test serialization. This is deliberately not used in browsers.
  const previous = nodeMutationMutexTail;
  let release!: () => void;
  nodeMutationMutexTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await runWithLease();
  } finally {
    release();
  }
}

export async function initializeAndMigrate(options?: { seedDemo?: boolean }): Promise<void> {
  // Reject demo seeding before opening IndexedDB or acquiring any lock in production bundles.
  if (options?.seedDemo) {
    let isProdBuild = false;
    try {
      isProdBuild = Boolean(import.meta.env.PROD);
    } catch {
      isProdBuild = false;
    }
    if (isProdBuild) {
      throw new Error('SECURITY_VIOLATION: Demo seeding ({ seedDemo: true }) is strictly prohibited in production builds.');
    }
  }
  await withLocalFirstMutationMutex('DATABASE_INITIALIZATION', async () => {
    await initializeAndMigrateLocked(options);
  });
}

const INITIALIZATION_METADATA_SYSTEM_KEYS = new Set<string>([
  'is_initialized',
  'schema_version',
  'pharmacy_name',
  'is_v2_migrated',
  'branch_id',
  'legacy_bankak_migrated',
  'stocktaking_items_v6_migrated',
  LOCAL_FIRST_MUTATION_MUTEX_KEY,
]);

const INITIALIZATION_CENSUS_STORES = Object.freeze([
  'medicines',
  'inventory_ledger',
  'sales',
  'suppliers',
  'receipts',
  'outbox',
  'metadata',
  'purchase_invoices',
  'supplier_transactions',
  'supplier_invoice_drafts',
  'stocktaking_sessions',
  'stocktaking_items',
  'bankak_tombstones',
] as const);

interface InitializationSnapshot {
  readonly isInitialized: boolean;
  readonly hasOperationalRecords: boolean;
  readonly storeCounts: Readonly<Record<string, number>>;
  readonly metadataKeys: ReadonlyArray<IDBValidKey>;
}

async function readInitializationSnapshot(db: IDBDatabase): Promise<InitializationSnapshot> {
  if (!db.objectStoreNames.contains('metadata')) {
    throw new Error('INITIALIZATION_CENSUS_METADATA_STORE_MISSING');
  }

  const existingStoreNames = Array.from(db.objectStoreNames);
  const missingRequiredStores = INITIALIZATION_CENSUS_STORES.filter(
    (name) => !existingStoreNames.includes(name)
  );
  if (missingRequiredStores.length > 0) {
    throw new Error(`INITIALIZATION_CENSUS_STORES_MISSING:${missingRequiredStores.join(',')}`);
  }
  // Count every store currently present, not only today's known list, so future or
  // extension stores containing real data also block demo seeding.
  const activeStores = existingStoreNames;
  if (!activeStores.includes('metadata')) {
    throw new Error('INITIALIZATION_CENSUS_METADATA_STORE_MISSING');
  }

  return new Promise<InitializationSnapshot>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([...activeStores], 'readonly');
    } catch (error) {
      reject(error instanceof Error ? error : new Error('INITIALIZATION_CENSUS_TRANSACTION_START_FAILED'));
      return;
    }

    let settled = false;
    let initializedRecord: unknown;
    let metadataKeys: IDBValidKey[] = [];
    const storeCounts: Record<string, number> = {};

    const fail = (error: unknown, fallback: string) => {
      if (settled) return;
      settled = true;
      try { tx.abort(); } catch { /* transaction may already be inactive */ }
      reject(error instanceof Error ? error : new Error(fallback));
    };

    for (const name of activeStores) {
      try {
        const request = tx.objectStore(name).count();
        request.onsuccess = () => {
          storeCounts[name] = request.result;
        };
        request.onerror = () => fail(request.error, `INITIALIZATION_CENSUS_COUNT_FAILED:${name}`);
      } catch (error) {
        fail(error, `INITIALIZATION_CENSUS_COUNT_FAILED:${name}`);
        return;
      }
    }

    try {
      const metadataStore = tx.objectStore('metadata');
      const initializedRequest = metadataStore.get('is_initialized');
      initializedRequest.onsuccess = () => {
        initializedRecord = initializedRequest.result;
      };
      initializedRequest.onerror = () => fail(initializedRequest.error, 'INITIALIZATION_METADATA_READ_FAILED');

      const keysRequest = metadataStore.getAllKeys();
      keysRequest.onsuccess = () => {
        metadataKeys = keysRequest.result || [];
      };
      keysRequest.onerror = () => fail(keysRequest.error, 'INITIALIZATION_METADATA_KEYS_READ_FAILED');
    } catch (error) {
      fail(error, 'INITIALIZATION_METADATA_READ_FAILED');
      return;
    }

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      const isInitialized =
        Boolean(initializedRecord) &&
        typeof initializedRecord === 'object' &&
        (initializedRecord as Record<string, unknown>).value === true;
      const hasStoreRecords = activeStores.some(
        (name) => name !== 'metadata' && (storeCounts[name] || 0) > 0
      );
      const hasUnknownMetadata = metadataKeys.some(
        (key) => typeof key !== 'string' || !INITIALIZATION_METADATA_SYSTEM_KEYS.has(key)
      );
      resolve({
        isInitialized,
        hasOperationalRecords: hasStoreRecords || hasUnknownMetadata,
        storeCounts,
        metadataKeys,
      });
    };
    tx.onerror = () => fail(tx.error, 'INITIALIZATION_CENSUS_TRANSACTION_FAILED');
    tx.onabort = () => fail(tx.error, 'INITIALIZATION_CENSUS_TRANSACTION_ABORTED');
  });
}

async function runRequiredStocktakingMigration(db: IDBDatabase): Promise<void> {
  const result = await migrateLegacyStocktakingItems(db);
  if (!result.migrated || result.error) {
    throw new Error(result.error || 'REQUIRED_STOCKTAKING_MIGRATION_FAILED');
  }
}

async function initializeAndMigrateLocked(options?: { seedDemo?: boolean }): Promise<void> {
  const db = await openPharmacyDB();



  const isSecondaryBranch = Boolean(activeBranchId && activeBranchId !== 'khalid-1');

  // Step 1: Migrate old Bankak receipts from KhalidPharmacyBankakDB only on the primary branch
  if (!isSecondaryBranch) {
    const migrationRes = await migrateLegacyBankakDB(db);
    if (!migrationRes.migrated && migrationRes.error) {
      console.error('Bankak legacy DB migration error:', migrationRes.error);
      throw new Error('فشل ترحيل قاعدة بيانات بنكك القديمة: ' + migrationRes.error);
    }
  }

  // Read metadata and every existing operational store in one completed readonly transaction.
  // Unknown metadata keys are treated as existing data; only known engine markers are ignored.
  const initializationSnapshot = await readInitializationSnapshot(db);
  const isSeeded = initializationSnapshot.isInitialized;
  const hasOperationalRecords = initializationSnapshot.hasOperationalRecords;

  if (isSeeded) {
    // A database already marked initialized still must finish any pending required migration before schema metadata updates.
    await runRequiredStocktakingMigration(db);
    // Step 1.5: Safely ensure schema_version and suppliers v2 normalization are updated (propagates errors)
    const metaTx = db.transaction(['metadata', 'suppliers'], 'readwrite');
    const metaStore = metaTx.objectStore('metadata');
    metaStore.put({ key: 'schema_version', value: DB_VERSION, updatedAt: new Date().toISOString() });
    const isV2MigratedReq = metaStore.get('is_v2_migrated');
    isV2MigratedReq.onsuccess = () => {
      if (!isV2MigratedReq.result) {
        const supStore = metaTx.objectStore('suppliers');
        const getAllReq = supStore.getAll();
        getAllReq.onsuccess = () => {
          const list: Supplier[] = getAllReq.result || [];
          list.forEach((s) => {
            let changed = false;
            if (!s.status) {
              s.status = 'active';
              changed = true;
            }
            if (s.legacyBalance === undefined) {
              s.legacyBalance = s.balance ?? 0;
              changed = true;
            }
            if (s.openingBalanceReviewed === undefined) {
              s.openingBalanceReviewed = false;
              changed = true;
            }
            if (changed) {
              supStore.put(s);
            }
          });
          metaStore.put({ key: 'is_v2_migrated', value: true, timestamp: new Date().toISOString() });
        };
      }
    };
    await new Promise<void>((resolveTx, rejectTx) => {
      metaTx.oncomplete = () => resolveTx();
      metaTx.onerror = () => rejectTx(metaTx.error || new Error('V2 supplier normalization transaction failed'));
      metaTx.onabort = () => rejectTx(metaTx.error || new Error('V2 supplier normalization transaction aborted'));
    });
    return; // Already initialized
  }

  if (hasOperationalRecords) {
    // A legacy database is never seeded. Complete required migrations before writing is_initialized.
    await runRequiredStocktakingMigration(db);
    const metaTx = db.transaction(['metadata', 'suppliers'], 'readwrite');
    const metaStore = metaTx.objectStore('metadata');
    metaStore.put({ key: 'is_initialized', value: true, initializedAt: new Date().toISOString() });
    metaStore.put({ key: 'schema_version', value: DB_VERSION });
    if (isSecondaryBranch && activeBranchId) {
      metaStore.put({ key: 'branch_id', value: activeBranchId });
      metaStore.put({ key: 'pharmacy_name', value: activeBranchName || `صيدلية خالد (${activeBranchId})` });
    }

    const supStore = metaTx.objectStore('suppliers');
    const getAllReq = supStore.getAll();
    getAllReq.onsuccess = () => {
      const list: Supplier[] = getAllReq.result || [];
      list.forEach((s) => {
        let changed = false;
        if (!s.status) {
          s.status = 'active';
          changed = true;
        }
        if (s.legacyBalance === undefined) {
          s.legacyBalance = s.balance ?? 0;
          changed = true;
        }
        if (s.openingBalanceReviewed === undefined) {
          s.openingBalanceReviewed = false;
          changed = true;
        }
        if (changed) {
          supStore.put(s);
        }
      });
      metaStore.put({ key: 'is_v2_migrated', value: true, timestamp: new Date().toISOString() });
    };

    await new Promise<void>((resolve, reject) => {
      metaTx.oncomplete = () => resolve();
      metaTx.onerror = () => reject(metaTx.error || new Error('Legacy normalization transaction failed'));
      metaTx.onabort = () => reject(metaTx.error || new Error('Legacy normalization transaction aborted'));
    });
    return;
  }

  // Secondary branches are always isolated and never receive demo fixtures.
  if (isSecondaryBranch) {
    await runRequiredStocktakingMigration(db);
    const nowIso = new Date().toISOString();
    const branchMetaTx = db.transaction(['metadata'], 'readwrite');
    const metaStore = branchMetaTx.objectStore('metadata');
    metaStore.put({ key: 'is_initialized', value: true, initializedAt: nowIso });
    metaStore.put({ key: 'schema_version', value: DB_VERSION });
    metaStore.put({ key: 'is_v2_migrated', value: true, timestamp: nowIso });
    metaStore.put({ key: 'branch_id', value: activeBranchId });
    metaStore.put({ key: 'pharmacy_name', value: activeBranchName || `صيدلية خالد (${activeBranchId})` });
    await new Promise<void>((resolve, reject) => {
      branchMetaTx.oncomplete = () => resolve();
      branchMetaTx.onerror = () => reject(branchMetaTx.error || new Error('Secondary branch metadata transaction failed'));
      branchMetaTx.onabort = () => reject(branchMetaTx.error || new Error('Secondary branch metadata transaction aborted'));
    });
    return;
  }

  // Database is completely empty. If seedDemo option is true, seed demo data. Otherwise, initialize empty and mark initialized.
  const nowIso = new Date().toISOString();

  if (!options?.seedDemo) {
    await runRequiredStocktakingMigration(db);
    const metaTx = db.transaction(['metadata', 'suppliers'], 'readwrite');
    const metaStore = metaTx.objectStore('metadata');
    metaStore.put({ key: 'is_initialized', value: true, initializedAt: nowIso });
    metaStore.put({ key: 'schema_version', value: DB_VERSION });
    metaStore.put({ key: 'pharmacy_name', value: 'صيدلية خالد' });
    metaStore.put({ key: 'is_v2_migrated', value: true, timestamp: nowIso });

    await new Promise<void>((resolve, reject) => {
      metaTx.oncomplete = () => resolve();
      metaTx.onerror = () => reject(metaTx.error || new Error('Fresh init metadata transaction failed'));
      metaTx.onabort = () => reject(metaTx.error || new Error('Fresh init metadata transaction aborted'));
    });
    return;
  }

  // Step 2: Seed default medicines and their initial ledger movements (explicit demo mode)
  const defaultMedicines: Omit<Medicine, 'createdAt' | 'updatedAt'>[] = [
    { id: 'p1', barcode: '6285001', name: 'Panadol Extra 500mg', category: 'Analgesics', minStock: 10, buyPrice: 2800, sellPrice: 4000, expiry: getRelativeDateStr(420), unitType: 'pack', stripsPerPack: 2, pillsPerStrip: 12, batchNumber: 'B-PAN-01' },
    { id: 'p2', barcode: '6285002', name: 'Amoxicillin 500mg Capsules', category: 'Antibiotics', minStock: 15, buyPrice: 4500, sellPrice: 6500, expiry: getRelativeDateStr(25), unitType: 'pack', stripsPerPack: 2, pillsPerStrip: 10, batchNumber: 'B-AMX-02' },
    { id: 'p3', barcode: '6285003', name: 'Augmentin 1g Tablets', category: 'Antibiotics', minStock: 8, buyPrice: 14000, sellPrice: 19500, expiry: getRelativeDateStr(38), unitType: 'pack', stripsPerPack: 2, pillsPerStrip: 7, batchNumber: 'B-AUG-03' },
    { id: 'p4', barcode: '6285004', name: 'Concor 5mg Tablets', category: 'Chronic', minStock: 10, buyPrice: 8200, sellPrice: 12000, expiry: getRelativeDateStr(510), unitType: 'pack', stripsPerPack: 3, pillsPerStrip: 10, batchNumber: 'B-CNC-04' },
    { id: 'p5', barcode: '6285005', name: 'Vitamin D3 50,000 IU', category: 'Vitamins', minStock: 5, buyPrice: 9000, sellPrice: 13500, expiry: getRelativeDateStr(365), unitType: 'pack', stripsPerPack: 1, pillsPerStrip: 10, batchNumber: 'B-VTD-05' },
    { id: 'p6', barcode: '6285006', name: 'Omeprazole 20mg Capsules', category: 'Chronic', minStock: 8, buyPrice: 3500, sellPrice: 5200, expiry: getRelativeDateStr(30), unitType: 'pack', stripsPerPack: 2, pillsPerStrip: 7, batchNumber: 'B-OMP-06' },
    { id: 'p7', barcode: '6285007', name: 'Cefixime 400mg Tablets', category: 'Antibiotics', minStock: 5, buyPrice: 11000, sellPrice: 16000, expiry: getRelativeDateStr(240), unitType: 'pack', stripsPerPack: 1, pillsPerStrip: 5, batchNumber: 'B-CFX-07' },
    { id: 'p8', barcode: '6285008', name: 'Paracetamol Syrup 120mg/5ml', category: 'Analgesics', minStock: 8, buyPrice: 2200, sellPrice: 3200, expiry: getRelativeDateStr(480), unitType: 'pack', stripsPerPack: 1, pillsPerStrip: 1, batchNumber: 'B-PCM-08' }
  ];

  const defaultStockPacks = [45, 6, 12, 3, 28, 4, 18, 32];

  const defaultSuppliers: Supplier[] = [
    { id: 's1', name: { ar: 'شركة الفارس للأدوية', en: 'Al-Fares Pharma Dist' }, contactPerson: 'أحمد الريح', phone: '+249 912345678', city: 'الخرطوم / بحري', balance: 1850000, legacyBalance: 1850000, terms: 'Net 30', status: 'active', openingBalanceReviewed: true, createdAt: nowIso },
    { id: 's2', name: { ar: 'مستودع الشفاء الطبي', en: 'Al-Shifa Medical Depot' }, contactPerson: 'عثمان خليل', phone: '+249 918765432', city: 'أم درمان', balance: 640000, legacyBalance: 640000, terms: 'Cash', status: 'active', openingBalanceReviewed: true, createdAt: nowIso },
    { id: 's3', name: { ar: 'الشركة العربية للمستلزمات الطبية', en: 'Arab Medical Supplies' }, contactPerson: 'سارة عبد الله', phone: '+249 123456789', city: 'الخرطوم', balance: 0, legacyBalance: 0, terms: 'Net 15', status: 'active', openingBalanceReviewed: true, createdAt: nowIso }
  ];

  const defaultRecentSales: Sale[] = [
    {
      id: generateUUID(),
      invoiceNumber: '1084',
      customer: 'Walk-in Patient',
      time: '10:45 AM',
      timestamp: new Date(Date.now() - 3600000).toISOString(),
      items: [
        { medicineId: 'p1', name: 'Panadol Extra 500mg', sellPrice: 4000, qty: 2, unit: 'pack', unitPrice: 4000, baseUnits: 48, subtotal: 8000, ledgerMovementId: generateUUID() },
        { medicineId: 'p7', name: 'Cefixime 400mg Tablets', sellPrice: 16000, qty: 1, unit: 'pack', unitPrice: 16000, baseUnits: 5, subtotal: 16000, ledgerMovementId: generateUUID() },
        { medicineId: 'p5', name: 'Vitamin D3 50,000 IU', sellPrice: 13500, qty: 1, unit: 'pack', unitPrice: 13500, baseUnits: 10, subtotal: 13500, ledgerMovementId: generateUUID() }
      ],
      itemsCount: 3,
      subtotal: 37500,
      discount: 3000,
      total: 34500,
      paymentMethod: 'Cash',
      cashierName: 'د. خالد (مدير)',
      deviceId: getDeviceId(),
      synced: 1
    },
    {
      id: generateUUID(),
      invoiceNumber: '1083',
      customer: 'د. طارق - حساب خاص',
      time: '10:12 AM',
      timestamp: new Date(Date.now() - 7200000).toISOString(),
      items: [
        { medicineId: 'p3', name: 'Augmentin 1g Tablets', sellPrice: 19500, qty: 1, unit: 'pack', unitPrice: 19500, baseUnits: 14, subtotal: 19500, ledgerMovementId: generateUUID() }
      ],
      itemsCount: 1,
      subtotal: 19500,
      discount: 0,
      total: 19500,
      paymentMethod: 'Card',
      cashierName: 'د. خالد (مدير)',
      deviceId: getDeviceId(),
      synced: 1
    },
    {
      id: generateUUID(),
      invoiceNumber: '1082',
      customer: 'Walk-in Patient',
      time: '09:30 AM',
      timestamp: new Date(Date.now() - 10800000).toISOString(),
      items: [
        { medicineId: 'p1', name: 'Panadol Extra 500mg', sellPrice: 4000, qty: 3, unit: 'pack', unitPrice: 4000, baseUnits: 72, subtotal: 12000, ledgerMovementId: generateUUID() },
        { medicineId: 'p4', name: 'Concor 5mg Tablets', sellPrice: 12000, qty: 2, unit: 'pack', unitPrice: 12000, baseUnits: 60, subtotal: 24000, ledgerMovementId: generateUUID() },
        { medicineId: 'p8', name: 'Paracetamol Syrup 120mg/5ml', sellPrice: 3200, qty: 3, unit: 'pack', unitPrice: 3200, baseUnits: 3, subtotal: 9600, ledgerMovementId: generateUUID() },
        { medicineId: 'p2', name: 'Amoxicillin 500mg Capsules', sellPrice: 6500, qty: 1, unit: 'pack', unitPrice: 6500, baseUnits: 20, subtotal: 6500, ledgerMovementId: generateUUID() }
      ],
      itemsCount: 4,
      subtotal: 52100,
      discount: 4900,
      total: 47200,
      paymentMethod: 'Cash',
      cashierName: 'د. خالد (مدير)',
      deviceId: getDeviceId(),
      synced: 1
    }
  ];

  // Complete required migrations before inserting any demo fixtures.
  await runRequiredStocktakingMigration(db);

  // Perform seeding transaction
  const tx = db.transaction(['medicines', 'inventory_ledger', 'suppliers', 'sales', 'metadata'], 'readwrite');

  const medStore = tx.objectStore('medicines');
  const ledgerStore = tx.objectStore('inventory_ledger');
  const supStore = tx.objectStore('suppliers');
  const salesStore = tx.objectStore('sales');
  const metaStore = tx.objectStore('metadata');

  defaultMedicines.forEach((med, idx) => {
    const fullMed: Medicine = {
      ...med,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    medStore.put(fullMed);

    const packQty = defaultStockPacks[idx] || 10;
    const basePills = convertMedicineQuantityToBaseUnits(packQty, 'pack', med);

    const initMovement: LedgerMovement = {
      id: generateUUID(),
      medicineId: med.id,
      batchNumber: med.batchNumber || '',
      expiry: med.expiry,
      type: 'INITIAL',
      unit: 'pack',
      quantityDelta: packQty,
      baseUnitsDelta: basePills,
      costPerUnit: med.buyPrice,
      costPerBaseUnit: normalizeMedicineCostToBaseUnit(fullMed.buyPrice, 'pack', fullMed),
      referenceId: 'INIT-SETUP-2026',
      deviceId: getDeviceId(),
      userId: 'admin-01',
      employeeName: 'د. خالد (مدير)',
      notes: 'الرصيد الافتتاحي لمستودع الصيدلية',
      timestamp: new Date(Date.now() - 86400000).toISOString(),
      synced: 1
    };
    ledgerStore.put(initMovement);
  });

  defaultSuppliers.forEach((sup) => supStore.put(sup));
  defaultRecentSales.forEach((sale) => salesStore.put(sale));

  metaStore.put({ key: 'is_initialized', value: true, initializedAt: nowIso });
  metaStore.put({ key: 'schema_version', value: DB_VERSION });
  metaStore.put({ key: 'pharmacy_name', value: 'صيدلية خالد' });
  metaStore.put({ key: 'is_v2_migrated', value: true, timestamp: nowIso });

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Demo seeding transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Demo seeding transaction aborted'));
  });
}

function getRelativeDateStr(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

/**
 * INVENTORY LEDGER CORE CALCULATIONS & FEFO BATCH TRACKING
 */

/**
 * Retrieve all stock batches for a given medicine, grouped and sorted by FEFO (First Expiry, First Out)
 */
export async function getBatchesForMedicine(medicineId: string): Promise<BatchStockSummary[]> {
  const db = await openPharmacyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['inventory_ledger', 'medicines'], 'readonly');
    const ledgerStore = tx.objectStore('inventory_ledger');
    const medStore = tx.objectStore('medicines');

    const medReq = medStore.get(medicineId);
    const index = ledgerStore.index('medicineId');
    const movementsReq = index.getAll(medicineId);

    tx.oncomplete = () => {
      const med: Medicine | undefined = medReq.result;
      const movements: LedgerMovement[] = movementsReq.result || [];
      if (!med) {
        resolve([]);
        return;
      }

      // Unknown historical lots must never be merged into a synthetic DEFAULT batch.
      // Check identity before unit factors so legacy stock remains explicitly quarantined,
      // even when its medicine has an incomplete packing configuration.
      // Preserve ledger rows; never expose unidentified movements as FEFO stock.
      const unidentifiedMovement = movements.find((movement) =>
        typeof movement.batchNumber !== 'string' || !movement.batchNumber.trim()
      );
      if (unidentifiedMovement) {
        reject(new Error(`LEGACY_BATCH_IDENTITY_UNKNOWN:${medicineId}:${unidentifiedMovement.id}`));
        return;
      }

      const directPack = isDirectPackMedicine(med);
      let pillsPerPack: number;
      try {
        pillsPerPack = getMedicineBaseUnitsPerPack(med);
      } catch {
        reject(new Error(`MEDICINE_OPERATION_BLOCKED:INVALID_PACKING_FACTORS:${medicineId}`));
        return;
      }
      const stripsPerPack = directPack ? 0 : Number(med.stripsPerPack);
      const pillsPerStrip = directPack ? 0 : Number(med.pillsPerStrip);

      // Group stock and acquisition cost by explicit batch identity only.
      // Outgoing SALE/DAMAGE movements never replace the incoming cost basis.
      const batchMap = new Map<string, { movements: LedgerMovement[]; totalPills: number; expiry: string; firstTimestamp: string }>();
      movements.forEach((m) => {
        const batchNum = m.batchNumber.trim();
        const cur = batchMap.get(batchNum) || {
          movements: [],
          totalPills: 0,
          expiry: m.expiry || med.expiry || '2099-12-31',
          firstTimestamp: m.timestamp
        };
        cur.movements.push(m);
        cur.totalPills += Number(m.baseUnitsDelta) || 0;
        if (m.expiry) cur.expiry = m.expiry;
        batchMap.set(batchNum, cur);
      });

      const todayStr = new Date().toISOString().split('T')[0];
      const batchList: BatchStockSummary[] = [];

      batchMap.forEach((val, batchNum) => {
        const totalPills = val.totalPills;
        const isExpired = val.expiry < todayStr;
        const packs = Math.floor(Math.max(0, totalPills) / pillsPerPack);
        const remPillsAfterPacks = Math.max(0, totalPills) % pillsPerPack;
        const strips = directPack ? 0 : Math.floor(remPillsAfterPacks / pillsPerStrip);
        const pills = directPack ? remPillsAfterPacks : remPillsAfterPacks % pillsPerStrip;

        const resolvedCost = resolveBatchWeightedCostSnapshot(
          val.movements,
          med,
          stripsPerPack,
          pillsPerStrip,
          pillsPerPack,
          directPack
        );
        const exactCarryingCost =
          resolvedCost.costPerBaseUnitExact && totalPills >= 0
            ? multiplyRational(createRational(BigInt(totalPills)), resolvedCost.costPerBaseUnitExact)
            : undefined;
        batchList.push({
          batchNumber: batchNum,
          expiry: val.expiry,
          isExpired,
          totalPills,
          packs,
          remainingStrips: strips,
          remainingPills: directPack ? 0 : pills,
          ...(directPack ? { remainingBaseUnits: pills, baseUnitLabel: med.unitDefinition?.baseUnit || 'وحدة أساسية' } : {}),
          displayQuantity: formatMedicineStockBreakdown(Math.max(0, totalPills), med),
          costPerUnit: resolvedCost.costPerPack,
          costPerBaseUnit: resolvedCost.costPerBaseUnit,
          ...(resolvedCost.costPerBaseUnitExact ? { costPerBaseUnitExact: resolvedCost.costPerBaseUnitExact } : {}),
          ...(resolvedCost.costPerPackExact ? { costPerUnitExact: resolvedCost.costPerPackExact } : {}),
          ...(exactCarryingCost ? { carryingCostExact: exactCarryingCost } : {}),
          costIsEstimated: resolvedCost.isEstimated
        });
      });

      // Sort according to FEFO:
      // Valid unexpired batches first sorted by earliest expiry (ascending).
      // Expired batches at the end.
      batchList.sort((a, b) => {
        if (a.isExpired !== b.isExpired) {
          return a.isExpired ? 1 : -1;
        }
        if (a.expiry < b.expiry) return -1;
        if (a.expiry > b.expiry) return 1;
        return a.batchNumber.localeCompare(b.batchNumber);
      });

      resolve(batchList);
    };

    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Add or receive a specific batch into the Ledger (PURCHASE or INITIAL)
 */
export async function addBatchStock(params: {
  medicineId: string;
  batchNumber: string;
  expiry: string; // YYYY-MM-DD
  quantity: number;
  unit: UnitKind;
  costPerUnit?: number;
  referenceId?: string;
  notes?: string;
  employeeName?: string;
}): Promise<LedgerMovement> {
  if (!params || !params.medicineId || !Number.isSafeInteger(params.quantity) || params.quantity <= 0) {
    throw new Error('بيانات إضافة الدفعة المخزنية غير صالحة');
  }
  const batchNumber = typeof params.batchNumber === 'string' ? params.batchNumber.trim() : '';
  if (!batchNumber) {
    throw new Error('رقم التشغيلة مطلوب لاستلام المخزون؛ لا يمكن دمج دفعات مجهولة في دفعة افتراضية');
  }
  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['medicines', 'inventory_ledger', 'outbox']);
  const knownBranchId = getKnownActiveBranchId();
  const knownActorUid = getKnownActiveActorId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['medicines', 'inventory_ledger', 'outbox'], 'readwrite');
    const medStore = tx.objectStore('medicines');
    const ledgerStore = tx.objectStore('inventory_ledger');
    const outboxStore = tx.objectStore('outbox');

    let medLoaded = false;
    let outboxLoaded = false;
    let med: Medicine | undefined;
    let existingOutboxEntries: OutboxEntry[] = [];
    let persistedMovement: LedgerMovement | null = null;
    let abortReason: Error | null = null;
    let finalized = false;

    const failTx = (err: unknown, fallback: string) => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(err ? String(err) : fallback);
      }
      try {
        tx.abort();
      } catch {
        // ignore abort error
      }
    };

    const tryFinalize = () => {
      if (finalized || !medLoaded || !outboxLoaded) return;
      finalized = true;
      try {
        if (!med) {
          failTx(new Error(`الصنف غير موجود: ${params.medicineId}`), 'الصنف غير موجود');
          return;
        }
        if (med.archived) {
          failTx(
            new Error(`COMMERCIAL_TARGET_ARCHIVED: الصنف "${med.name || med.id}" مؤرشف ولا يمكن إضافة مخزون له`),
            'الصنف مؤرشف'
          );
          return;
        }
        try {
          assertMedicineOperationallyAllowed(med);
        } catch (error) {
          failTx(error, 'الدواء غير معتمد تشغيلياً');
          return;
        }

        const depIndex = buildOutboxDependencyIndex(existingOutboxEntries);
        const unsyncedMedCreates = existingOutboxEntries.filter(
          (e) =>
            e &&
            e.entityType === 'medicine' &&
            e.entityId === med!.id &&
            e.action === 'CREATE' &&
            e.status !== 'synced'
        );
        const dependsOnOpIds: string[] = [];
        for (const createEntry of unsyncedMedCreates) {
          validateOutboxRecordDependencies(createEntry, depIndex);
          const opId = getCanonicalOutboxOperationId(createEntry);
          if (opId && !dependsOnOpIds.includes(opId)) {
            dependsOnOpIds.push(opId);
          }
        }

        const baseUnitsDelta = convertMedicineQuantityToBaseUnits(params.quantity, params.unit, med);
        if (!Number.isFinite(baseUnitsDelta) || baseUnitsDelta <= 0) {
          failTx(new Error('كمية الدفعة الأساسية يجب أن تكون موجبة'), 'كمية الدفعة غير صالحة');
          return;
        }
        const nowIso = new Date().toISOString();
        const movementId = generateUUID();
        const effectiveCostUnit: UnitKind = params.costPerUnit !== undefined ? params.unit : 'pack';
        const effectiveCostValue = params.costPerUnit ?? med.buyPrice;
        const exactReceiptCost = computeExactMedicineCostPerUnitAndBaseUnit(
          effectiveCostValue,
          effectiveCostUnit,
          med
        );

        const movement: LedgerMovement = {
          id: movementId,
          medicineId: params.medicineId,
          batchNumber,
          expiry: params.expiry,
          type: 'PURCHASE',
          unit: params.unit,
          quantityDelta: params.quantity,
          baseUnitsDelta,
          costPerUnit: effectiveCostValue,
          ...(exactReceiptCost ? { costPerUnitExact: exactReceiptCost.costPerUnitExact } : {}),
          costPerBaseUnit: exactReceiptCost
            ? exactReceiptCost.costPerBaseUnitNumber
            : normalizeMedicineCostToBaseUnit(effectiveCostValue, effectiveCostUnit, med),
          ...(exactReceiptCost ? { costPerBaseUnitExact: exactReceiptCost.costPerBaseUnitExact } : {}),
          referenceId: params.referenceId || `BATCH-IN-${Date.now()}`,
          deviceId: getDeviceId(),
          userId: knownActorUid || params.employeeName || 'admin',
          employeeName: params.employeeName || 'المسؤول',
          notes: params.notes || `توريد تشغيلة جديدة (${batchNumber}) صلاحية ${params.expiry}`,
          timestamp: nowIso,
          synced: 0
        };

        const outboxId = generateUUID();
        const outboxEntry: OutboxEntry = {
          id: outboxId,
          operationId: outboxId,
          idempotencyKey: `inventory_ledger:CREATE:${movement.id}`,
          ...(knownBranchId ? { branchId: knownBranchId } : {}),
          ...(knownActorUid ? { actorUid: knownActorUid } : {}),
          schemaVersion: 1,
          ...(dependsOnOpIds.length > 0 ? { dependsOn: dependsOnOpIds } : {}),
          entityType: 'inventory_ledger',
          entityId: movement.id,
          action: 'CREATE',
          payload: movement,
          timestamp: nowIso,
          retryCount: 0,
          attempts: 0,
          status: 'pending'
        };

        ledgerStore.put(movement);
        outboxStore.put(outboxEntry);
        persistedMovement = movement;
      } catch (err) {
        failTx(err, 'فشل إضافة الدفعة المخزنية');
      }
    };

    const medReq = medStore.get(params.medicineId);
    medReq.onsuccess = () => {
      med = medReq.result as Medicine | undefined;
      medLoaded = true;
      tryFinalize();
    };
    medReq.onerror = () => failTx(medReq.error, 'تعذر قراءة بيانات الدواء داخل المعاملة');

    const outboxReq = outboxStore.getAll();
    outboxReq.onsuccess = () => {
      existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryFinalize();
    };
    outboxReq.onerror = () => failTx(outboxReq.error, 'تعذر قراءة طابور Outbox داخل المعاملة');

    tx.oncomplete = () => {
      if (persistedMovement) resolve(persistedMovement);
      else reject(abortReason || new Error('فشلت معاملة إضافة الدفعة'));
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشلت معاملة إضافة الدفعة'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة إضافة الدفعة'));
  });
}

export async function calculateMedicineStock(medicineId: string): Promise<StockCalculation> {
  const batches = await getBatchesForMedicine(medicineId);
  const med = await getMedicineById(medicineId);

  if (!med) throw new Error(`MEDICINE_NOT_FOUND:${medicineId}`);
  const directPack = isDirectPackMedicine(med);
  let pillsPerPack: number;
  try {
    pillsPerPack = getMedicineBaseUnitsPerPack(med);
  } catch {
    throw new Error(`MEDICINE_OPERATION_BLOCKED:INVALID_PACKING_FACTORS:${medicineId}`);
  }
  const stripsPerPack = directPack ? 0 : Number(med.stripsPerPack);
  const pillsPerStrip = directPack ? 0 : Number(med.pillsPerStrip);

  let totalPills = 0;
  let unexpiredPills = 0;
  let expiredPills = 0;

  batches.forEach((b) => {
    totalPills += b.totalPills;
    if (b.isExpired) {
      expiredPills += Math.max(0, b.totalPills);
    } else {
      unexpiredPills += Math.max(0, b.totalPills);
    }
  });

  const packs = Math.floor(Math.max(0, totalPills) / pillsPerPack);
  const remainderAfterPacks = Math.max(0, totalPills) % pillsPerPack;
  const strips = directPack ? 0 : Math.floor(remainderAfterPacks / pillsPerStrip);
  const pills = directPack ? remainderAfterPacks : remainderAfterPacks % pillsPerStrip;

  return {
    medicineId,
    totalPills,
    unexpiredPills,
    expiredPills,
    packs: Math.max(0, packs),
    remainingStrips: Math.max(0, strips),
    remainingPills: directPack ? 0 : Math.max(0, pills),
    ...(directPack ? { remainingBaseUnits: Math.max(0, pills), baseUnitLabel: med.unitDefinition?.baseUnit || 'وحدة أساسية' } : {}),
    displayQuantity: formatMedicineStockBreakdown(Math.max(0, totalPills), med),
    unexpiredDisplayQuantity: formatMedicineStockBreakdown(unexpiredPills, med)
  };
}

/**
 * Get all medicines paired with their live ledger-calculated stock
 */
export async function getAllMedicinesWithLiveStock(): Promise<(Medicine & { stock: number; detailedStock: string; totalBasePills: number })[]> {
  const db = await openPharmacyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['medicines', 'inventory_ledger'], 'readonly');
    const medStore = tx.objectStore('medicines');
    const ledgerStore = tx.objectStore('inventory_ledger');

    const medReq = medStore.getAll();
    const ledgerReq = ledgerStore.getAll();

    tx.oncomplete = () => {
      const medicines: Medicine[] = medReq.result || [];
      const movements: LedgerMovement[] = ledgerReq.result || [];

      // Group movements by medicineId
      const movementMap = new Map<string, number>();
      movements.forEach((m) => {
        const cur = movementMap.get(m.medicineId) || 0;
        movementMap.set(m.medicineId, cur + (Number(m.baseUnitsDelta) || 0));
      });

      const result = medicines.map((med) => {
        const totalBasePills = movementMap.get(med.id) || 0;
        let packs = 0;
        let detailedStock = totalBasePills > 0 ? 'عوامل التعبئة غير موثقة' : '0';
        try {
          const perPack = getMedicineBaseUnitsPerPack(med);
          packs = totalBasePills / perPack;
          detailedStock = formatMedicineStockBreakdown(totalBasePills, med);
        } catch {
          // Preserve the base-unit ledger balance but never estimate packs from missing factors.
        }
        return {
          ...med,
          stock: Math.max(0, Math.floor(packs)), // no pack estimate when packing factors are unknown
          detailedStock,
          totalBasePills
        };
      });

      resolve(result);
    };

    tx.onerror = () => reject(tx.error);
  });
}

function computeExactMedicineCostPerUnitAndBaseUnit(
  cost: number,
  costUnit: UnitKind,
  medicine: Medicine
): { costPerUnitExact: Rational; costPerBaseUnitExact: Rational; costPerBaseUnitNumber: number } | null {
  try {
    const baseUnitsPerCostUnit = convertMedicineQuantityToBaseUnits(1, costUnit, medicine);
    if (!Number.isSafeInteger(baseUnitsPerCostUnit) || baseUnitsPerCostUnit <= 0) {
      return null;
    }
    const costPerUnitExact = parseExactDecimal(
      toExactDecimalInputFromNumber(cost, 'تكلفة الوحدة'),
      'تكلفة الوحدة'
    );
    const costPerBaseUnitExact = divideRational(
      costPerUnitExact,
      createRational(BigInt(baseUnitsPerCostUnit))
    );
    const costPerBaseUnitNumber = rationalToCompatibilityNumber(
      costPerBaseUnitExact,
      'تكلفة الوحدة الأساسية'
    );
    return { costPerUnitExact, costPerBaseUnitExact, costPerBaseUnitNumber };
  } catch {
    return null;
  }
}

function resolveBatchWeightedCostSnapshot(
  batchMovements: LedgerMovement[],
  med: Medicine,
  stripsPerPack: number,
  pillsPerStrip: number,
  baseUnitsPerPack: number,
  directPack: boolean
): {
  costPerBaseUnit: number;
  costPerPack: number;
  costPerBaseUnitExact?: Rational;
  costPerPackExact?: Rational;
  isEstimated: boolean;
} {
  let batchCost = calculateWeightedBatchCost(
    batchMovements,
    stripsPerPack,
    pillsPerStrip,
    med.buyPrice,
    baseUnitsPerPack,
    directPack
  );
  let exactBatchCostPerBaseUnit: Rational | undefined;
  let exactBatchCostPerPack: Rational | undefined;
  const exactReceiptMovements = batchMovements.filter((movement) => Number(movement.baseUnitsDelta) > 0);
  if (
    exactReceiptMovements.length > 0 &&
    exactReceiptMovements.every(
      (movement) => movement.costPerBaseUnitExact !== undefined && isValidRational(movement.costPerBaseUnitExact)
    )
  ) {
    try {
      const exactResult = calculateExactWeightedBatchCostRational(
        exactReceiptMovements.map((movement) => ({
          baseUnitsDelta: String(movement.baseUnitsDelta),
          costPerBaseUnit: movement.costPerBaseUnitExact!,
        }))
      );
      exactBatchCostPerBaseUnit = exactResult.costPerBaseUnit;
      exactBatchCostPerPack = multiplyRational(
        exactResult.costPerBaseUnit,
        createRational(BigInt(baseUnitsPerPack))
      );
      batchCost = {
        costPerBaseUnit: rationalToCompatibilityNumber(exactBatchCostPerBaseUnit, 'تكلفة الدفعة الدقيقة'),
        isEstimated: false,
      };
    } catch {
      batchCost = { ...batchCost, isEstimated: true };
      exactBatchCostPerBaseUnit = undefined;
      exactBatchCostPerPack = undefined;
    }
  }
  const costPerPack = exactBatchCostPerPack
    ? rationalToCompatibilityNumber(exactBatchCostPerPack, 'تكلفة العبوة الدقيقة')
    : batchCost.costPerBaseUnit * baseUnitsPerPack;
  return {
    costPerBaseUnit: batchCost.costPerBaseUnit,
    costPerPack,
    ...(exactBatchCostPerBaseUnit ? { costPerBaseUnitExact: exactBatchCostPerBaseUnit } : {}),
    ...(exactBatchCostPerPack ? { costPerPackExact: exactBatchCostPerPack } : {}),
    isEstimated: batchCost.isEstimated,
  };
}

/**
 * Exact rational inventory valuation across live batches (single medicine or entire active branch).
 * Preserves exact Rational carrying costs without intermediate floating-point rounding.
 */
export async function calculateInventoryValuation(medicineId?: string): Promise<InventoryValuationReport> {
  const targetMedicines = medicineId
    ? (() => getMedicineById(medicineId).then((m) => (m ? [m] : [])))()
    : getAllMedicines();
  const meds = await targetMedicines;
  const summaries: MedicineInventoryValuationSummary[] = [];
  let grandTotalExact: Rational = createRational(0n);
  let grandTotalCompatibility = 0;
  let allExact = true;

  for (const med of meds) {
    let batches: BatchStockSummary[];
    try {
      batches = await getBatchesForMedicine(med.id);
    } catch {
      if (medicineId) throw new Error(`INVENTORY_VALUATION_BLOCKED:${med.id}`);
      continue;
    }
    const positiveBatches = batches.filter((b) => b.totalPills > 0);
    if (positiveBatches.length === 0 && !medicineId) continue;

    let medExact: Rational = createRational(0n);
    let medCompatibility = 0;
    let medAllExact = true;
    let totalBaseUnits = 0;

    for (const batch of positiveBatches) {
      totalBaseUnits += batch.totalPills;
      if (batch.carryingCostExact && isValidRational(batch.carryingCostExact)) {
        medExact = addRational(medExact, batch.carryingCostExact);
      } else {
        medAllExact = false;
      }
      medCompatibility += batch.totalPills * (batch.costPerBaseUnit ?? 0);
    }

    const carryingCost = medAllExact
      ? rationalToCompatibilityNumber(medExact, 'قيمة مخزون الصنف الدقيقة')
      : medCompatibility;
    if (medAllExact) {
      grandTotalExact = addRational(grandTotalExact, medExact);
    } else {
      allExact = false;
    }
    grandTotalCompatibility += carryingCost;

    summaries.push({
      medicineId: med.id,
      name: med.name,
      totalBaseUnits,
      carryingCost,
      ...(medAllExact ? { carryingCostExact: medExact } : {}),
      exactCoverageComplete: medAllExact,
      batches: positiveBatches,
    });
  }

  return {
    totalCarryingCost: allExact
      ? rationalToCompatibilityNumber(grandTotalExact, 'إجمالي تقييم المخزون الدقيق')
      : grandTotalCompatibility,
    ...(allExact ? { totalCarryingCostExact: grandTotalExact } : {}),
    exactCoverageComplete: allExact,
    medicines: summaries,
  };
}

/**
 * ATOMIC OFFLINE-SAFE SALE TRANSACTION WITH FEFO AUTO-SPLIT & IDEMPOTENCY GUARD
 * 1. Checks available unexpired stock using FEFO (First Expiry, First Out)
 * 2. Rejects if available valid stock < requested, strictly excluding expired batches
 * 3. Auto-splits sale quantity across batches with distinct Append-Only ledger entries
 * 4. Checks idempotency inside the atomic transaction (no duplicate invoices or double deduction on retry)
 * 5. Atomically saves Sale, all Ledger movements, and Outbox entries in a single IndexedDB transaction
 */
export async function executeSale(saleData: ExecuteSaleParams): Promise<Sale> {
  const db = await openPharmacyDB();
  if (!Array.isArray(saleData.items) || saleData.items.length === 0) {
    throw new Error('أضف صنفاً واحداً على الأقل قبل إتمام البيع');
  }
  if (saleData.discount !== undefined && (!Number.isFinite(Number(saleData.discount)) || Number(saleData.discount) < 0)) {
    throw new Error('خصم فاتورة البيع غير صالح');
  }
  for (const item of saleData.items) {
    if (!item.medicineId || !Number.isSafeInteger(item.qty) || item.qty <= 0) {
      throw new Error('كمية البيع يجب أن تكون عدداً صحيحاً موجباً لكل صنف');
    }
    if (item.unit !== undefined && !['pack', 'strip', 'pill'].includes(item.unit)) {
      throw new Error('وحدة البيع المحددة غير معروفة');
    }
  }

  // Step 1: Pre-validation & FEFO Allocation Plan
  const allocationPlan = await Promise.all(
    saleData.items.map(async (item) => {
      const med = await getMedicineById(item.medicineId);
      if (!med) throw new Error(`الصنف غير موجود بالمخزون: ${item.medicineId}`);
      if (med.archived) {
        throw new Error(`COMMERCIAL_TARGET_ARCHIVED: الصنف "${med.name || med.id}" مؤرشف ولا يمكن بيعه`);
      }
      assertMedicineOperationallyAllowed(med);
      validateMedicineUnitConfiguration(med);

      const unit = item.unit || 'pack';
      if (!isMedicineUnitSellable(med, unit)) {
        const unitLabel = unit === 'pack' ? 'العلبة' : unit === 'strip' ? 'الشريط' : 'الحبة';
        throw new Error(`بيع ${unitLabel} غير مسموح لهذا الدواء: ${med.name}. راجع إعدادات وحدات البيع.`);
      }
      const requestedBasePills = convertMedicineQuantityToBaseUnits(item.qty, unit, med);
      if (!Number.isSafeInteger(requestedBasePills) || requestedBasePills <= 0) {
        throw new Error(`تعذر تحويل كمية البيع إلى وحدات مخزون صحيحة للصنف: ${med.name}`);
      }
      const batches = await getBatchesForMedicine(item.medicineId);

      // Filter unexpired batches that have positive stock
      const unexpiredBatches = batches.filter((b) => !b.isExpired && b.totalPills > 0);
      const expiredBatches = batches.filter((b) => b.isExpired && b.totalPills > 0);

      const totalUnexpiredPills = unexpiredBatches.reduce((acc, b) => acc + b.totalPills, 0);
      const totalExpiredPills = expiredBatches.reduce((acc, b) => acc + b.totalPills, 0);

      const unitLabel = unit === 'pack' ? 'علبة' : unit === 'strip' ? 'شريط' : 'حبة';

      if (totalUnexpiredPills < requestedBasePills) {
        if (totalExpiredPills > 0) {
          throw new Error(
            `الرصيد الصالح غير كافٍ للصنف "${med.name}". المطلوب: ${item.qty} ${unitLabel}، بينما الرصيد المتاح غير المنتهي هو: ${formatMedicineStockBreakdown(totalUnexpiredPills, med)} (تم استبعاد الدفعات المنتهية الصلاحية لحماية المرضى).`
          );
        } else {
          throw new Error(
            `الرصيد المحلي غير كافٍ للصنف "${med.name}". المطلوب: ${item.qty} ${unitLabel}، بينما الرصيد المتاح هو: ${formatMedicineStockBreakdown(totalUnexpiredPills, med)}`
          );
        }
      }

      // Perform FEFO allocation across unexpired batches
      let remainingToAllocate = requestedBasePills;
      const allocations: SaleItemAllocation[] = [];
      const directPack = isDirectPackMedicine(med);
      const baseUnitsPerPack = getMedicineBaseUnitsPerPack(med);
      const stripsPerPack = directPack ? 0 : Number(med.stripsPerPack);
      const pillsPerStrip = directPack ? 0 : Number(med.pillsPerStrip);
      if (directPack && unit !== 'pack') throw new Error('DIRECT_PACK_PARTIAL_SALE_UNSUPPORTED');
      const pillsPerUnit = unit === 'pack' ? baseUnitsPerPack : unit === 'strip' ? pillsPerStrip : 1;

      for (const batch of unexpiredBatches) {
        if (remainingToAllocate <= 0) break;
        if (batch.totalPills <= 0) continue;

        const takePills = Math.min(batch.totalPills, remainingToAllocate);
        // Keep the exact base-unit allocation authoritative; never truncate a split pack to 2 decimals.
        const takeQty = takePills / pillsPerUnit;
        const movementId = generateUUID();

        const allocCostPerBaseUnitExact = batch.costPerBaseUnitExact;
        const allocCostOfGoodsExact = allocCostPerBaseUnitExact
          ? multiplyRational(createRational(BigInt(takePills)), allocCostPerBaseUnitExact)
          : undefined;
        const allocCostPerBaseUnit = batch.costPerBaseUnit ?? normalizeMedicineCostToBaseUnit(med.buyPrice, 'pack', med);
        allocations.push({
          batchNumber: batch.batchNumber,
          expiry: batch.expiry,
          quantity: takeQty,
          unit,
          baseUnits: takePills,
          ledgerMovementId: movementId,
          costPerBaseUnit: allocCostPerBaseUnit,
          ...(allocCostPerBaseUnitExact ? { costPerBaseUnitExact: allocCostPerBaseUnitExact } : {}),
          costOfGoods: allocCostOfGoodsExact
            ? rationalToCompatibilityNumber(allocCostOfGoodsExact, 'تكلفة البضاعة المباعة')
            : takePills * allocCostPerBaseUnit,
          ...(allocCostOfGoodsExact ? { costOfGoodsExact: allocCostOfGoodsExact } : {}),
        });

        remainingToAllocate -= takePills;
      }

      return {
        med,
        item,
        unit,
        requestedBasePills,
        allocations
      };
    })
  );

  // Step 2: Build deterministic records
  const saleId = saleData.id || generateUUID();
  const invoiceNumber = saleData.invoiceNumber || String(Math.floor(1000 + Math.random() * 9000));
  const nowIso = new Date().toISOString();
  const deviceId = getDeviceId();
  const knownBranchId = getKnownActiveBranchId();
  const knownActorUid = getKnownActiveActorId();

  const saleItems: SaleItem[] = [];
  const ledgerEntries: LedgerMovement[] = [];
  let subtotal = 0;

  allocationPlan.forEach(({ med, item, unit, requestedBasePills, allocations }) => {
    const unitPrice = getMedicineUnitSellingPrice(med, unit);

    const itemSubtotal = unitPrice * item.qty;
    if (!Number.isFinite(itemSubtotal) || !Number.isFinite(subtotal + itemSubtotal)) {
      throw new Error(`قيمة البيع تتجاوز النطاق الرقمي الآمن للصنف: ${med.name}`);
    }
    subtotal += itemSubtotal;

    // Create a distinct ledger movement for each allocated batch
    allocations.forEach((alloc, allocIdx) => {
      const isSplit = allocations.length > 1;
      ledgerEntries.push({
        id: alloc.ledgerMovementId,
        medicineId: med.id,
        batchNumber: alloc.batchNumber,
        expiry: alloc.expiry,
        type: 'SALE',
        unit: alloc.unit,
        quantityDelta: -alloc.quantity,
        baseUnitsDelta: -alloc.baseUnits,
        costPerUnit: med.buyPrice,
        costPerBaseUnit: alloc.costPerBaseUnit,
        ...(alloc.costPerBaseUnitExact ? { costPerBaseUnitExact: alloc.costPerBaseUnitExact } : {}),
        referenceId: invoiceNumber,
        deviceId,
        userId: knownActorUid || saleData.cashierName || 'كاشير',
        employeeName: saleData.cashierName || 'كاشير',
        notes: isSplit
          ? `فاتورة بيع #${invoiceNumber} [FEFO دفعة ${alloc.batchNumber} - انتهاء ${alloc.expiry} - جزء ${allocIdx + 1}/${allocations.length}]`
          : `فاتورة بيع نقدي/إلكتروني #${invoiceNumber} [دفعة ${alloc.batchNumber}]`,
        timestamp: nowIso,
        synced: 0
      });
    });

    const lineHasExactCogs = allocations.length > 0 && allocations.every((a) => a.costOfGoodsExact !== undefined);
    const lineCostOfGoodsExact = lineHasExactCogs
      ? allocations.reduce((sum, allocation) => addRational(sum, allocation.costOfGoodsExact!), createRational(0n))
      : undefined;
    const lineCostOfGoods = lineCostOfGoodsExact
      ? rationalToCompatibilityNumber(lineCostOfGoodsExact, 'تكلفة بند البيع')
      : allocations.reduce((sum, allocation) => sum + (allocation.costOfGoods || 0), 0);
    const lineGrossProfitExact = lineCostOfGoodsExact
      ? subtractRational(createRational(BigInt(itemSubtotal)), lineCostOfGoodsExact)
      : undefined;

    saleItems.push({
      medicineId: med.id,
      name: med.name,
      sellPrice: unitPrice,
      qty: item.qty,
      unit,
      unitPrice,
      baseUnits: requestedBasePills,
      subtotal: itemSubtotal,
      costOfGoods: lineCostOfGoods,
      ...(lineCostOfGoodsExact ? { costOfGoodsExact: lineCostOfGoodsExact } : {}),
      grossProfit: lineGrossProfitExact
        ? rationalToCompatibilityNumber(lineGrossProfitExact, 'مجمل ربح البند')
        : itemSubtotal - lineCostOfGoods,
      ...(lineGrossProfitExact ? { grossProfitExact: lineGrossProfitExact } : {}),
      ledgerMovementId: allocations[0].ledgerMovementId,
      ledgerMovementIds: allocations.map((a) => a.ledgerMovementId),
      batchAllocations: allocations
    });
  });

  const saleSettlement = allocateWholeSdgSaleSettlement(
    saleItems.map((item) => item.subtotal),
    Number(saleData.discount) || 0
  );
  const settledSubtotal = saleSettlement.subtotal;
  const discount = saleSettlement.discount;
  const total = saleSettlement.total;
  const saleHasExactCogs = saleItems.length > 0 && saleItems.every((item) => item.costOfGoodsExact !== undefined);
  const costOfGoodsExact = saleHasExactCogs
    ? saleItems.reduce((sum, item) => addRational(sum, item.costOfGoodsExact!), createRational(0n))
    : undefined;
  const costOfGoods = costOfGoodsExact
    ? rationalToCompatibilityNumber(costOfGoodsExact, 'تكلفة البضاعة المباعة للفاتورة')
    : saleItems.reduce((sum, item) => sum + (item.costOfGoods || 0), 0);
  saleItems.forEach((item, index) => {
    item.discountShare = saleSettlement.discountShares[index];
    if (item.costOfGoodsExact) {
      item.netProfitExact = subtractRational(
        createRational(BigInt(item.subtotal - item.discountShare)),
        item.costOfGoodsExact
      );
      item.netProfit = rationalToCompatibilityNumber(item.netProfitExact, 'صافي ربح البند');
    } else {
      item.netProfit = item.subtotal - item.discountShare - (item.costOfGoods || 0);
    }
  });
  const grossProfitExact = costOfGoodsExact
    ? subtractRational(createRational(BigInt(settledSubtotal)), costOfGoodsExact)
    : undefined;
  const netProfitExact = costOfGoodsExact
    ? subtractRational(createRational(BigInt(total)), costOfGoodsExact)
    : undefined;
  const grossProfit = grossProfitExact
    ? rationalToCompatibilityNumber(grossProfitExact, 'مجمل ربح الفاتورة')
    : settledSubtotal - costOfGoods;
  const netProfit = netProfitExact
    ? rationalToCompatibilityNumber(netProfitExact, 'صافي ربح الفاتورة')
    : total - costOfGoods;

  const saleRecord: Sale = {
    id: saleId,
    invoiceNumber,
    customer: saleData.customer || 'Walk-in Patient',
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    timestamp: nowIso,
    items: saleItems,
    itemsCount: saleItems.length,
    subtotal: settledSubtotal,
    discount,
    total,
    costOfGoods,
    ...(costOfGoodsExact ? { costOfGoodsExact } : {}),
    grossProfit,
    ...(grossProfitExact ? { grossProfitExact } : {}),
    netProfit,
    ...(netProfitExact ? { netProfitExact } : {}),
    paymentMethod: saleData.paymentMethod,
    bankakTransactionId: saleData.bankakTransactionId,
    cashierName: saleData.cashierName || 'كاشير',
    deviceId,
    synced: 0
  };

  const saleOutboxId = generateUUID();
  const outboxEntry: OutboxEntry = {
    id: saleOutboxId,
    operationId: saleOutboxId,
    idempotencyKey: `sale:CREATE:${saleId}`,
    ...(knownBranchId ? { branchId: knownBranchId } : {}),
    ...(knownActorUid ? { actorUid: knownActorUid } : {}),
    schemaVersion: 1,
    entityType: 'sale',
    entityId: saleId,
    action: 'CREATE',
    payload: saleRecord,
    timestamp: nowIso,
    retryCount: 0,
    attempts: 0,
    status: 'pending'
  };

  // Step 3: Atomic IndexedDB Transaction with Idempotency Guard
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['sales', 'inventory_ledger', 'outbox', 'medicines'], 'readwrite');
    const salesStore = tx.objectStore('sales');
    const ledgerStore = tx.objectStore('inventory_ledger');
    const outboxStore = tx.objectStore('outbox');
    const medicineStore = tx.objectStore('medicines');

    let wasIdempotentHit = false;
    let existingSaleResult: Sale | null = null;
    let abortReason: Error | null = null;

    // Check 1: Does this saleId (UUID) already exist?
    const checkByIdReq = salesStore.get(saleId);
    checkByIdReq.onsuccess = () => {
      if (checkByIdReq.result) {
        wasIdempotentHit = true;
        existingSaleResult = checkByIdReq.result;
        return; // Skip writing, do not deduct again!
      }

      // Check 2: Does this invoiceNumber already exist?
      const invIndex = salesStore.index('invoiceNumber');
      const checkByInvReq = invIndex.get(invoiceNumber);
      checkByInvReq.onsuccess = () => {
        if (checkByInvReq.result) {
          wasIdempotentHit = true;
          existingSaleResult = checkByInvReq.result;
          return; // Skip writing, do not deduct again!
        }

        // Revalidate the exact FEFO allocation inside this serialized readwrite
        // transaction. This prevents two tabs/concurrent checkouts from selling
        // the same stock based on stale pre-transaction reads.
        const plannedByMedicine = new Map<string, Map<string, number>>();
        allocationPlan.forEach(({ med, allocations }) => {
          const byBatch = plannedByMedicine.get(med.id) || new Map<string, number>();
          allocations.forEach((allocation) => {
            byBatch.set(allocation.batchNumber, (byBatch.get(allocation.batchNumber) || 0) + allocation.baseUnits);
          });
          plannedByMedicine.set(med.id, byBatch);
        });

        const medicineIds = Array.from(plannedByMedicine.keys());
        let pendingValidations = medicineIds.length;
        let outboxLoaded = false;
        let existingOutboxEntries: OutboxEntry[] = [];
        let validationFailed = false;
        let saleCommitted = false;

        const maybeCommitSale = () => {
          if (saleCommitted || validationFailed || pendingValidations > 0 || !outboxLoaded) return;
          saleCommitted = true;

          try {
            const medicineIdSet = new Set(medicineIds);
            const depIndex = buildOutboxDependencyIndex(existingOutboxEntries);
            const unsyncedMedCreateOpIdsByMed = new Map<string, string[]>();
            for (const e of existingOutboxEntries) {
              if (
                e &&
                e.entityType === 'medicine' &&
                medicineIdSet.has(e.entityId) &&
                e.action === 'CREATE' &&
                e.status !== 'synced'
              ) {
                validateOutboxRecordDependencies(e, depIndex);
                const opId = getCanonicalOutboxOperationId(e);
                if (opId) {
                  const list = unsyncedMedCreateOpIdsByMed.get(e.entityId) || [];
                  if (!list.includes(opId)) list.push(opId);
                  unsyncedMedCreateOpIdsByMed.set(e.entityId, list);
                }
              }
            }

            // Rebuild all immutable financial snapshots from the exact medicine,
            // price and batch-cost state read inside this transaction.
            const saleSettlement = allocateWholeSdgSaleSettlement(
              saleItems.map((item) => item.subtotal),
              Number(saleData.discount) || 0
            );
            const refreshedSubtotal = saleSettlement.subtotal;
            const refreshedDiscount = saleSettlement.discount;
            const refreshedTotal = saleSettlement.total;
            const refreshedHasExactCogs =
              saleItems.length > 0 && saleItems.every((item) => item.costOfGoodsExact !== undefined);
            const refreshedCostExact = refreshedHasExactCogs
              ? saleItems.reduce((sum, item) => addRational(sum, item.costOfGoodsExact!), createRational(0n))
              : undefined;
            const refreshedCost = refreshedCostExact
              ? rationalToCompatibilityNumber(refreshedCostExact, 'تكلفة البضاعة المباعة للفاتورة')
              : saleItems.reduce((sum, item) => sum + (item.costOfGoods || 0), 0);
            saleItems.forEach((item, index) => {
              item.discountShare = saleSettlement.discountShares[index];
              if (item.costOfGoodsExact) {
                item.grossProfitExact = subtractRational(
                  createRational(BigInt(item.subtotal)),
                  item.costOfGoodsExact
                );
                item.grossProfit = rationalToCompatibilityNumber(item.grossProfitExact, 'مجمل ربح البند');
                item.netProfitExact = subtractRational(
                  createRational(BigInt(item.subtotal - item.discountShare)),
                  item.costOfGoodsExact
                );
                item.netProfit = rationalToCompatibilityNumber(item.netProfitExact, 'صافي ربح البند');
              } else {
                delete item.grossProfitExact;
                delete item.netProfitExact;
                item.grossProfit = item.subtotal - (item.costOfGoods || 0);
                item.netProfit = item.subtotal - item.discountShare - (item.costOfGoods || 0);
              }
            });
            saleRecord.subtotal = refreshedSubtotal;
            saleRecord.discount = refreshedDiscount;
            saleRecord.total = refreshedTotal;
            saleRecord.costOfGoods = refreshedCost;
            if (refreshedCostExact) {
              saleRecord.costOfGoodsExact = refreshedCostExact;
              saleRecord.grossProfitExact = subtractRational(
                createRational(BigInt(refreshedSubtotal)),
                refreshedCostExact
              );
              saleRecord.netProfitExact = subtractRational(
                createRational(BigInt(refreshedTotal)),
                refreshedCostExact
              );
              saleRecord.grossProfit = rationalToCompatibilityNumber(
                saleRecord.grossProfitExact,
                'مجمل ربح الفاتورة'
              );
              saleRecord.netProfit = rationalToCompatibilityNumber(
                saleRecord.netProfitExact,
                'صافي ربح الفاتورة'
              );
            } else {
              delete saleRecord.costOfGoodsExact;
              delete saleRecord.grossProfitExact;
              delete saleRecord.netProfitExact;
              saleRecord.grossProfit = refreshedSubtotal - refreshedCost;
              saleRecord.netProfit = refreshedTotal - refreshedCost;
            }
            salesStore.put(saleRecord);

            ledgerEntries.forEach((entry) => {
              ledgerStore.put(entry);
              const ledgerOutboxId = generateUUID();
              const medDeps = unsyncedMedCreateOpIdsByMed.get(entry.medicineId) || [];
              const ledgerDependsOn = Array.from(new Set([saleOutboxId, ...medDeps]));
              outboxStore.put({
                id: ledgerOutboxId,
                operationId: ledgerOutboxId,
                idempotencyKey: `inventory_ledger:CREATE:${entry.id}`,
                ...(knownBranchId ? { branchId: knownBranchId } : {}),
                ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                schemaVersion: 1,
                dependsOn: ledgerDependsOn,
                entityType: 'inventory_ledger',
                entityId: entry.id,
                action: 'CREATE',
                payload: entry,
                timestamp: nowIso,
                retryCount: 0,
                attempts: 0,
                status: 'pending'
              });
            });
            outboxEntry.payload = saleRecord;
            outboxStore.put(outboxEntry);
          } catch (err) {
            validationFailed = true;
            abortReason = err instanceof Error ? err : new Error(String(err || 'فشل تجهيز سجل المزامنة للبيع'));
            try {
              tx.abort();
            } catch {
              // ignore abort error
            }
          }
        };

        const outboxReq = outboxStore.getAll();
        outboxReq.onerror = () => {
          if (validationFailed) return;
          validationFailed = true;
          abortReason = outboxReq.error || new Error('تعذر قراءة طابور Outbox داخل معاملة البيع');
          try {
            tx.abort();
          } catch {
            // ignore
          }
        };
        outboxReq.onsuccess = () => {
          existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
          outboxLoaded = true;
          maybeCommitSale();
        };

        if (pendingValidations === 0) {
          maybeCommitSale();
          return;
        }

        medicineIds.forEach((medicineId) => {
          const movementsReq = ledgerStore.index('medicineId').getAll(medicineId);
          const medicineReq = medicineStore.get(medicineId);
          let currentMovements: LedgerMovement[] | null = null;
          let currentMedicine: Medicine | null = null;
          let checked = false;

          const validateWhenReady = () => {
            if (checked || validationFailed || !currentMovements || !currentMedicine) return;
            checked = true;
            if (currentMedicine.archived) {
              validationFailed = true;
              abortReason = new Error(`COMMERCIAL_TARGET_ARCHIVED: الصنف "${currentMedicine.name || currentMedicine.id}" مؤرشف ولا يمكن بيعه`);
              tx.abort();
              return;
            }
            try {
              assertMedicineOperationallyAllowed(currentMedicine);
              validateMedicineUnitConfiguration(currentMedicine);
            } catch (error) {
              validationFailed = true;
              abortReason = error instanceof Error ? error : new Error('MEDICINE_OPERATION_BLOCKED');
              tx.abort();
              return;
            }
            const originalMedicine = allocationPlan.find((plan) => plan.med.id === medicineId)?.med;
            if (!originalMedicine) {
              validationFailed = true;
              abortReason = new Error('تعذر مطابقة بيانات الدواء داخل معاملة البيع');
              tx.abort();
              return;
            }
            const oldDirectPack = isDirectPackMedicine(originalMedicine);
            const currentDirectPack = isDirectPackMedicine(currentMedicine);
            let oldBaseUnitsPerPack = 0;
            let currentBaseUnitsPerPack = 0;
            try {
              oldBaseUnitsPerPack = getMedicineBaseUnitsPerPack(originalMedicine);
              currentBaseUnitsPerPack = getMedicineBaseUnitsPerPack(currentMedicine);
            } catch {
              validationFailed = true;
              abortReason = new Error('MEDICINE_OPERATION_BLOCKED:INVALID_PACKING_FACTORS');
              tx.abort();
              return;
            }
            const currentStrips = currentDirectPack ? 0 : Number(currentMedicine.stripsPerPack);
            const currentPills = currentDirectPack ? 0 : Number(currentMedicine.pillsPerStrip);
            if (oldDirectPack !== currentDirectPack || oldBaseUnitsPerPack !== currentBaseUnitsPerPack ||
                (!currentDirectPack && (![currentStrips, currentPills].every(value => Number.isSafeInteger(value) && value > 0)))) {
              validationFailed = true;
              abortReason = new Error('تغير تعريف وحدات الدواء أثناء البيع. حدّث السلة ثم أعد المحاولة.');
              tx.abort();
              return;
            }

            const medicinePlan = plannedByMedicine.get(medicineId)!;
            const requestedBaseUnits = Array.from(medicinePlan.values()).reduce((sum, value) => sum + value, 0);
            const today = new Date().toISOString().slice(0, 10);
            const expected = calculateFefoBatchAllocation(currentMovements, requestedBaseUnits, today);
            if (expected.remaining > 0) {
              validationFailed = true;
              abortReason = new Error('تغير رصيد المخزون أثناء البيع أو لم يعد كافياً. حدّث السلة ثم أعد المحاولة.');
              tx.abort();
              return;
            }
            if (!allocationsMatch(medicinePlan, expected.allocations)) {
              validationFailed = true;
              abortReason = new Error('تغير ترتيب الدفعات أو رصيدها أثناء البيع. أعد المحاولة لضمان تطبيق FEFO ومنع تجاوز المخزون.');
              tx.abort();
              return;
            }

            const unidentifiedMovement = currentMovements.find((movement) =>
              typeof movement.batchNumber !== 'string' || !movement.batchNumber.trim()
            );
            if (unidentifiedMovement) {
              validationFailed = true;
              abortReason = new Error(`LEGACY_BATCH_IDENTITY_UNKNOWN:${medicineId}:${unidentifiedMovement.id}`);
              tx.abort();
              return;
            }
            const movementsByBatch = new Map<string, LedgerMovement[]>();
            currentMovements.forEach((movement) => {
              const batch = movement.batchNumber.trim();
              const list = movementsByBatch.get(batch) || [];
              list.push(movement);
              movementsByBatch.set(batch, list);
            });

            allocationPlan.forEach((plan, planIndex) => {
              if (validationFailed || plan.med.id !== medicineId) return;
              if (!isMedicineUnitSellable(currentMedicine!, plan.unit)) {
                validationFailed = true;
                abortReason = new Error('تم إيقاف وحدة البيع لهذا الدواء أثناء العملية. حدّث السلة قبل إتمام البيع.');
                tx.abort();
                return;
              }
              let currentUnitPrice: number;
              try {
                currentUnitPrice = getMedicineUnitSellingPrice(currentMedicine!, plan.unit);
              } catch (error) {
                validationFailed = true;
                abortReason = error instanceof Error ? error : new Error('تعذر التحقق من سعر البيع الحالي');
                tx.abort();
                return;
              }
              if (currentUnitPrice !== saleItems[planIndex].unitPrice) {
                validationFailed = true;
                abortReason = new Error('تغير سعر البيع أثناء تجهيز الفاتورة. راجع السعر الظاهر في السلة ثم أعد المحاولة.');
                tx.abort();
                return;
              }

              const line = saleItems[planIndex];
              line.sellPrice = currentUnitPrice;
              line.unitPrice = currentUnitPrice;
              line.subtotal = currentUnitPrice * plan.item.qty;
              plan.med = currentMedicine!;
              plan.allocations.forEach((allocation) => {
                const batchMovements = movementsByBatch.get(allocation.batchNumber) || [];
                const currentDirectPack = isDirectPackMedicine(currentMedicine!);
                const currentBaseUnitsPerPack = getMedicineBaseUnitsPerPack(currentMedicine!);
                const resolvedBatchCost = resolveBatchWeightedCostSnapshot(
                  batchMovements,
                  currentMedicine!,
                  currentDirectPack ? 0 : currentStrips,
                  currentDirectPack ? 0 : currentPills,
                  currentBaseUnitsPerPack,
                  currentDirectPack
                );
                allocation.costPerBaseUnit = resolvedBatchCost.costPerBaseUnit;
                allocation.costIsEstimated = resolvedBatchCost.isEstimated;
                if (resolvedBatchCost.costPerBaseUnitExact) {
                  allocation.costPerBaseUnitExact = resolvedBatchCost.costPerBaseUnitExact;
                  allocation.costOfGoodsExact = multiplyRational(
                    createRational(BigInt(allocation.baseUnits)),
                    resolvedBatchCost.costPerBaseUnitExact
                  );
                  allocation.costOfGoods = rationalToCompatibilityNumber(
                    allocation.costOfGoodsExact,
                    'تكلفة البضاعة المباعة للدفعة'
                  );
                } else {
                  delete allocation.costPerBaseUnitExact;
                  delete allocation.costOfGoodsExact;
                  allocation.costOfGoods = allocation.baseUnits * resolvedBatchCost.costPerBaseUnit;
                }
                const ledgerEntry = ledgerEntries.find((entry) => entry.id === allocation.ledgerMovementId);
                if (ledgerEntry) {
                  ledgerEntry.costPerUnit = resolvedBatchCost.costPerPack;
                  ledgerEntry.costPerBaseUnit = resolvedBatchCost.costPerBaseUnit;
                  if (resolvedBatchCost.costPerBaseUnitExact) {
                    ledgerEntry.costPerBaseUnitExact = resolvedBatchCost.costPerBaseUnitExact;
                  } else {
                    delete ledgerEntry.costPerBaseUnitExact;
                  }
                  if (resolvedBatchCost.costPerPackExact) {
                    ledgerEntry.costPerUnitExact = resolvedBatchCost.costPerPackExact;
                  } else {
                    delete ledgerEntry.costPerUnitExact;
                  }
                }
              });
              const lineAllExact =
                plan.allocations.length > 0 &&
                plan.allocations.every((allocation) => allocation.costOfGoodsExact !== undefined);
              if (lineAllExact) {
                line.costOfGoodsExact = plan.allocations.reduce(
                  (sum, allocation) => addRational(sum, allocation.costOfGoodsExact!),
                  createRational(0n)
                );
                line.costOfGoods = rationalToCompatibilityNumber(
                  line.costOfGoodsExact,
                  'تكلفة بند البيع'
                );
              } else {
                delete line.costOfGoodsExact;
                line.costOfGoods = plan.allocations.reduce(
                  (sum, allocation) => sum + (allocation.costOfGoods || 0),
                  0
                );
              }
            });
            if (validationFailed) return;

            pendingValidations -= 1;
            if (pendingValidations === 0) maybeCommitSale();
          };

          movementsReq.onerror = () => {
            if (validationFailed) return;
            validationFailed = true;
            abortReason = new Error('تعذر التحقق من رصيد المخزون داخل معاملة البيع');
            tx.abort();
          };
          movementsReq.onsuccess = () => {
            currentMovements = movementsReq.result || [];
            validateWhenReady();
          };
          medicineReq.onerror = () => {
            if (validationFailed) return;
            validationFailed = true;
            abortReason = new Error('تعذر قراءة بيانات الدواء الحالية داخل معاملة البيع');
            tx.abort();
          };
          medicineReq.onsuccess = () => {
            currentMedicine = medicineReq.result || null;
            if (!currentMedicine) {
              validationFailed = true;
              abortReason = new Error('الدواء لم يعد موجوداً أثناء إتمام البيع');
              tx.abort();
              return;
            }
            validateWhenReady();
          };
        });
      };
      checkByInvReq.onerror = () => {
        abortReason = checkByInvReq.error || new Error('تعذر التحقق من رقم فاتورة البيع');
        try { tx.abort(); } catch { /* ignore */ }
      };
    };
    checkByIdReq.onerror = () => {
      abortReason = checkByIdReq.error || new Error('تعذر التحقق من معرف فاتورة البيع');
      try { tx.abort(); } catch { /* ignore */ }
    };

    tx.oncomplete = () => {
      if (wasIdempotentHit && existingSaleResult) {
        resolve(existingSaleResult);
      } else {
        resolve(saleRecord);
      }
    };

    tx.onerror = () => {
      reject(abortReason || tx.error);
    };
    tx.onabort = () => {
      reject(abortReason || tx.error || new Error('أُلغيت معاملة البيع لحماية رصيد المخزون'));
    };
  });
}

/**
 * Add or Edit Medicine with Ledger Initial/Adjustment movement
 */
/**
 * Safe Medicine Outbox Coalescing Policy (Phase 1 — DB_VERSION = 5):
 * Inside saveMedicine()'s single atomic readwrite transaction on ['medicines', 'inventory_ledger', 'outbox']:
 * 1. Existence & CREATE vs UPDATE detection is determined strictly from in-transaction IndexedDB
 *    state ('medicines' store), never from '!medicineData.id' or a stale pre-transaction read.
 *    A brand-new medicine with a caller-supplied ID creates 'CREATE' (and INITIAL ledger +
 *    inventory_ledger outbox when initialStock > 0).
 * 2. Protected entries NEVER deleted or mutated:
 *    - 'synced', 'dead-letter', 'blocked'
 *    - 'processing', historical 'syncing', or any entry carrying a leaseOwner
 *    - Any entry whose timestamp / payload.updatedAt is strictly newer than incoming operation freshness
 * 3. Safe coalescing:
 *    - When an unleased 'pending' | 'retry' | 'failed' medicine entry exists after any in-flight/leased
 *      entries and is not newer than incoming operation freshness, update that entry in-place with
 *      the latest full Medicine payload, keeping its id/operationId and preserving 'CREATE' action if
 *      it was originally a 'CREATE' (so initialStock dependsOn links stay intact), and setting status='pending'.
 *    - Otherwise keep operations separate by inserting a new pending entry so zero edits are lost.
 */
export function resolveMedicineOutboxWrite(params: {
  existingEntries: OutboxEntry[];
  med: Medicine;
  actuallyNew: boolean;
  knownBranchId?: string;
  knownActorUid?: string;
  nowIso: string;
  incomingFreshnessMs?: number;
}): {
  targetEntry: OutboxEntry;
  coalesced: boolean;
} {
  const { med, ...sharedParams } = params;
  return resolveMedicineOutboxWriteShared(
    {
      ...sharedParams,
      medicine: med
    },
    {
      normalizeEntry: (entry) => normalizeOutboxEntry(entry),
      isValidActorUid: (uid) => isValidFirebaseActorUid(uid),
      generateId: () => generateUUID()
    }
  );
}

function findBarcodeCollisionInCatalog(
  allMeds: Medicine[],
  barcode: string,
  excludeMedicineId: string
): Medicine | undefined {
  const target = barcode.trim();
  if (!target) return undefined;
  return allMeds.find((m) => {
    if (!m || m.id === excludeMedicineId) return false;
    if (m.barcode && String(m.barcode).trim() === target) return true;
    if (Array.isArray(m.secondaryBarcodes)) {
      return m.secondaryBarcodes.some((b) => b && String(b).trim() === target);
    }
    return false;
  });
}

function generateUniqueAutoBarcodeInCatalog(allMeds: Medicine[], excludeMedicineId: string): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = String(Math.floor(628500000000 + Math.random() * 99999999));
    if (!findBarcodeCollisionInCatalog(allMeds, candidate, excludeMedicineId)) {
      return candidate;
    }
  }
  throw new Error('تعذر توليد باركود فريد للدواء الجديد داخل قاعدة البيانات');
}

/**
 * Create or update a Medicine record atomically within a single IndexedDB readwrite transaction.
 *
 * Omitted vs Explicitly Supplied Field Semantics:
 * - Omitted (`!(key in medicineData)` or `medicineData[key] === undefined`):
 *   - On UPDATE (in-transaction record exists): preserves the latest committed field value from IndexedDB.
 *   - On CREATE (no in-transaction record): applies the schema creation default (and auto-generates a
 *     unique primary barcode validated against the in-transaction catalog).
 * - Explicitly supplied (`null`, `0`, `false`, `""`, `[]`, or any defined value):
 *   - NEVER treated as omitted on UPDATE or CREATE (`0`, `false`, `""`, and `[]` override existing values;
 *     `null` clears optional numeric pricing fields to `undefined` or resets string/array fields to `""`/`[]`
 *     and boolean unit flags to `false`).
 *   - Exception for existing UI quick-add compatibility on CREATE only: when creating a brand-new medicine
 *     with a blank/null `barcode` (`""` or `null`), existing normalization auto-generates a unique `'6285...'`
 *     barcode validated in-transaction; on UPDATE, explicit `""` or `null` clears `barcode` to `""`.
 */
export interface MedicineUnitVerificationInput {
  dosageForm: Exclude<DosageFormKind, 'Unknown'>;
  stripsPerPack?: number;
  pillsPerStrip?: number;
  baseUnitsPerPack?: number;
  sellPack?: boolean;
  sellStrip?: boolean;
  sellPill?: boolean;
  sellPriceStrip?: number;
  sellPricePill?: number;
  idempotencyKey?: string;
}

export interface CreateVerifiedMedicineOptions {
  idempotencyKey?: string;
}

export interface VerifyMedicineUnitConfigurationParams extends MedicineUnitVerificationInput {
  medicineId: string;
}

interface VerifiedMedicineUnitState {
  dosageForm: Exclude<DosageFormKind, 'Unknown'>;
  stripsPerPack: number;
  pillsPerStrip: number;
  baseUnitsPerPack: number;
  sellPack: boolean;
  sellStrip: boolean;
  sellPill: boolean;
  sellPriceStrip?: number;
  sellPricePill?: number;
  configStatus: 'VERIFIED';
  unitDefinition: SerializedUnitDefinitionDTOV2;
  unitDefinitionKey: string;
  baseDimensionKey: string;
  unitOperationalAllowed: true;
}

export interface VerifiedMedicineCreateIdempotencyRecord {
  key: string;
  schemaVersion: 1;
  branchId: string;
  idempotencyKey: string;
  requestHash: string;
  medicineId: string;
  createdByUid: string;
  createdAt: string;
}

interface TrustedVerificationExecutionContext {
  readonly uid: string;
  readonly role: 'admin' | 'super_admin';
  readonly branchId: string;
  readonly expectedDbName: string;
}

export const VERIFIED_MEDICINE_CREATE_IDEMPOTENCY_PREFIX = 'verified_medicine_create_idempotency_v1:';

function normalizeVerifiedCreateIdempotencyKey(
  rawKey: unknown
): string | null {
  if (rawKey === undefined || rawKey === null) return null;
  if (typeof rawKey !== 'string') {
    throw new Error('INVALID_IDEMPOTENCY_KEY: مفتاح عدم التكرار (idempotencyKey) يجب أن يكون نصاً صالحاً.');
  }
  const trimmed = rawKey.trim();
  if (!trimmed) {
    throw new Error('INVALID_IDEMPOTENCY_KEY: مفتاح عدم التكرار (idempotencyKey) لا يمكن أن يكون فارغاً.');
  }
  if (trimmed.length > 160 || /[\r\n\0]/.test(trimmed)) {
    throw new Error('INVALID_IDEMPOTENCY_KEY: مفتاح عدم التكرار (idempotencyKey) يتجاوز الطول المسموح أو يحتوي محارف غير صالحة.');
  }
  return trimmed;
}

function computeVerifiedMedicineCreateRequestHash(
  branchId: string,
  medicineData: Partial<Medicine> & { initialStock?: number; idempotencyKey?: string },
  verifiedState: VerifiedMedicineUnitState
): string {
  const hasField = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(medicineData, key) && (medicineData as any)[key] !== undefined;
  const rawSec = hasField('secondaryBarcodes') && Array.isArray(medicineData.secondaryBarcodes)
    ? medicineData.secondaryBarcodes
    : [];
  const cleanBarcode = hasField('barcode') && medicineData.barcode !== null
    ? String(medicineData.barcode).trim()
    : '';
  const cleanSec = Array.from(
    new Set(
      rawSec
        .map((b) => String(b ?? '').trim())
        .filter((b) => b.length > 0 && b !== cleanBarcode)
    )
  ).sort();
  const canonicalPayload = {
    branchId,
    suppliedId: typeof medicineData.id === 'string' ? medicineData.id.trim() : '',
    barcode: cleanBarcode,
    secondaryBarcodes: cleanSec,
    name: hasField('name') && medicineData.name !== null ? String(medicineData.name).trim() : 'Unknown Medication',
    category: hasField('category') && medicineData.category !== null ? String(medicineData.category).trim() : 'Analgesics',
    minStock: hasField('minStock') && medicineData.minStock !== null ? Number(medicineData.minStock) : 5,
    buyPrice: hasField('buyPrice') && medicineData.buyPrice !== null ? Number(medicineData.buyPrice) : 0,
    sellPrice: hasField('sellPrice') && medicineData.sellPrice !== null ? Number(medicineData.sellPrice) : 0,
    expiry: hasField('expiry') && medicineData.expiry !== null ? String(medicineData.expiry).trim() : null,
    batchNumber: hasField('batchNumber') && medicineData.batchNumber !== null ? String(medicineData.batchNumber).trim() : '',
    initialStock: hasField('initialStock') && medicineData.initialStock !== null ? Number(medicineData.initialStock) : 0,
    dosageForm: verifiedState.dosageForm,
    stripsPerPack: verifiedState.stripsPerPack,
    pillsPerStrip: verifiedState.pillsPerStrip,
    baseUnitsPerPack: verifiedState.baseUnitsPerPack,
    sellPack: verifiedState.sellPack,
    sellStrip: verifiedState.sellStrip,
    sellPill: verifiedState.sellPill,
    sellPriceStrip: verifiedState.sellPriceStrip ?? null,
    sellPricePill: verifiedState.sellPricePill ?? null,
    unitDefinitionKey: verifiedState.unitDefinitionKey,
    baseDimensionKey: verifiedState.baseDimensionKey,
  };
  return sha256HexSync(`khalid-pharmacy:verified_medicine_create:v1:${stableMedicineFieldFingerprint(canonicalPayload)}`);
}

const VERIFIED_DOSAGE_FORM_BASE_UNIT: Record<
  Exclude<DosageFormKind, 'Unknown'>,
  { baseUnit: BaseUnitKind; supportsStrip: boolean }
> = {
  Tablet: { baseUnit: 'pill', supportsStrip: true },
  Capsule: { baseUnit: 'capsule', supportsStrip: true },
  Syrup: { baseUnit: 'bottle', supportsStrip: false },
  Suspension: { baseUnit: 'bottle', supportsStrip: false },
  Drops: { baseUnit: 'bottle', supportsStrip: false },
  InjectionVial: { baseUnit: 'vial', supportsStrip: false },
  Ampoule: { baseUnit: 'ampoule', supportsStrip: false },
  Cream: { baseUnit: 'tube', supportsStrip: false },
  Ointment: { baseUnit: 'tube', supportsStrip: false },
  Gel: { baseUnit: 'tube', supportsStrip: false },
  Inhaler: { baseUnit: 'inhaler', supportsStrip: false },
  Suppository: { baseUnit: 'suppository', supportsStrip: false },
  Sachet: { baseUnit: 'sachet', supportsStrip: false }
};

/**
 * Enforces strict online Admin/Super Admin authorization and exact branch/database identity
 * for operational medicine unit verification. Always fails closed when auth authority is inactive,
 * session is missing/expired/unverified/offline, role is not admin/super_admin, or branch/DB
 * identity does not match the captured context.
 */
function assertMedicineUnitVerificationAuthorized(
  expectedContext?: TrustedVerificationExecutionContext,
  dbHandle?: IDBDatabase | null,
  txHandle?: IDBTransaction | null
): TrustedVerificationExecutionContext {
  if (!authAuthorityEnforced) {
    throw new Error(
      'MEDICINE_VERIFICATION_AUTH_AUTHORITY_INACTIVE: سلطة المصادقة الموثوقة غير مفعّلة؛ يُرفض اعتماد وحدات الدواء في وضع عدم التفعيل.'
    );
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(
      'MEDICINE_VERIFICATION_OFFLINE_FORBIDDEN: يتطلب اعتماد وحدات الدواء اتصالاً نشطاً بالإنترنت وجلسة مسؤول موثقة.'
    );
  }
  if (
    !trustedAuthSession ||
    !isValidFirebaseActorUid(trustedAuthSession.uid) ||
    trustedAuthSession.emailVerified !== true ||
    isTrustedSessionExpired(trustedAuthSession)
  ) {
    throw new Error(
      'MEDICINE_VERIFICATION_AUTH_REQUIRED: تتطلب عملية اعتماد وحدات الدواء جلسة مسؤول موثقة ومفعّلة.'
    );
  }
  if (
    trustedAuthSession.offlineFallback === true ||
    (trustedAuthSession.role !== 'admin' && trustedAuthSession.role !== 'super_admin')
  ) {
    throw new Error(
      'MEDICINE_VERIFICATION_ROLE_DENIED: يقتصر اعتماد وحدات الدواء على دوري Admin أو Super Admin المتصلين بالإنترنت فقط.'
    );
  }
  const activeActor = getKnownActiveActorId();
  if (!activeActor || activeActor !== trustedAuthSession.uid) {
    throw new Error(
      'MEDICINE_VERIFICATION_ACTOR_MISMATCH: معرّف الفاعل النشط لا يطابق جلسة المسؤول الموثقة.'
    );
  }
  const currentBranchId = getKnownActiveBranchId();
  if (!currentBranchId || !isValidOutboxBranchId(currentBranchId)) {
    throw new Error(
      'MEDICINE_VERIFICATION_BRANCH_REQUIRED: يجب تحديد فرع نشط صالح ومصرح به قبل اعتماد وحدات الدواء.'
    );
  }
  if (!isBranchAuthorizedForSession(trustedAuthSession, currentBranchId)) {
    throw new Error(
      `MEDICINE_VERIFICATION_BRANCH_DENIED: المستخدم غير مصرح له باعتماد وحدات الدواء على الفرع "${currentBranchId}".`
    );
  }
  const expectedDbName = getBranchDbName(currentBranchId);
  if (getActiveDbName() !== expectedDbName) {
    throw new Error(
      `MEDICINE_VERIFICATION_DB_MISMATCH: اسم قاعدة البيانات النشطة (${getActiveDbName()}) لا يطابق قاعدة بيانات الفرع المصرح به (${expectedDbName}).`
    );
  }
  if (expectedContext) {
    if (
      expectedContext.uid !== trustedAuthSession.uid ||
      expectedContext.role !== trustedAuthSession.role ||
      expectedContext.branchId !== currentBranchId ||
      expectedContext.expectedDbName !== expectedDbName
    ) {
      throw new Error(
        'MEDICINE_VERIFICATION_CONTEXT_CHANGED: تغيّرت جلسة المستخدم أو الدور أو الفرع أثناء تنفيذ عملية الاعتماد؛ أُلغيت العملية لمنع التداخل.'
      );
    }
  }
  if (dbHandle) {
    if (closedDbHandles.has(dbHandle) || dbHandle.name !== expectedDbName) {
      throw new Error(
        `MEDICINE_VERIFICATION_DB_HANDLE_MISMATCH: مقبض قاعدة البيانات المفتوحة (${dbHandle.name}) لا يطابق الفرع المصرح به (${expectedDbName}).`
      );
    }
  }
  if (txHandle) {
    const txDbName = (txHandle as { db?: { name?: string } })?.db?.name;
    if (typeof txDbName === 'string' && txDbName !== expectedDbName) {
      throw new Error(
        `MEDICINE_VERIFICATION_TX_DB_MISMATCH: معاملة قاعدة البيانات (${txDbName}) لا تطابق الفرع المصرح به (${expectedDbName}).`
      );
    }
  }
  return Object.freeze({
    uid: trustedAuthSession.uid,
    role: trustedAuthSession.role,
    branchId: currentBranchId,
    expectedDbName,
  });
}

function collectV1LocalStoragePackingEvidence(): {
  v1RetryMedicineIds: Set<string>;
  v1LocalInFlightPresent: boolean;
  v1StorageEvidenceUnknown: boolean;
} {
  const v1RetryMedicineIds = new Set<string>();
  let v1LocalInFlightPresent = false;
  let v1StorageEvidenceUnknown = false;
  try {
    const storage = typeof globalThis !== 'undefined' ? globalThis.localStorage : undefined;
    if (!storage) v1StorageEvidenceUnknown = true;
    if (storage) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (typeof key !== 'string') {
          v1StorageEvidenceUnknown = true;
          continue;
        }
        if (key.startsWith('khalid_v1_inflight_lease_v1:')) {
          v1LocalInFlightPresent = true;
          continue;
        }
        if (!key.startsWith('khalid_cloud_sync_retry_queue_v1')) continue;
        const raw = storage.getItem(key);
        if (raw === null || raw === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          v1StorageEvidenceUnknown = true;
          continue;
        }
        if (!Array.isArray(parsed)) {
          v1StorageEvidenceUnknown = true;
          continue;
        }
        const visit = (value: unknown, depth: number): void => {
          if (depth > 10) {
            v1StorageEvidenceUnknown = true;
            return;
          }
          if (!value || typeof value !== 'object') return;
          if (Array.isArray(value)) {
            for (const child of value) visit(child, depth + 1);
            return;
          }
          const row = value as Record<string, unknown>;
          if (typeof row.medicineId === 'string' && row.medicineId.trim()) {
            v1RetryMedicineIds.add(row.medicineId.trim());
          }
          if (
            (row.kind === 'medicine' || row.kind === 'archive_medicine') &&
            typeof row.entityId === 'string' &&
            row.entityId.trim()
          ) {
            v1RetryMedicineIds.add(row.entityId.trim());
          }
          for (const child of Object.values(row)) visit(child, depth + 1);
        };
        for (const entry of parsed) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            v1StorageEvidenceUnknown = true;
            continue;
          }
          visit(entry, 0);
        }
      }
    }
  } catch {
    v1StorageEvidenceUnknown = true;
  }
  return { v1RetryMedicineIds, v1LocalInFlightPresent, v1StorageEvidenceUnknown };
}

/**
 * Builds a canonical VERIFIED unit state using universalUnitPolicy + unitSerialization.
 * Never fabricates 2×10 defaults or infers unknown dosage forms.
 */
function buildVerifiedMedicineUnitState(
  input: MedicineUnitVerificationInput,
  options?: { packingLocked?: boolean; definitionVersion?: number }
): VerifiedMedicineUnitState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MEDICINE_VERIFICATION_INPUT_REQUIRED: بيانات اعتماد وحدات الدواء مطلوبة.');
  }
  const dosageForm = input.dosageForm;
  if (
    typeof dosageForm !== 'string' ||
    !Object.prototype.hasOwnProperty.call(VERIFIED_DOSAGE_FORM_BASE_UNIT, dosageForm)
  ) {
    throw new Error(
      `UNSUPPORTED_DOSAGE_FORM: الشكل الصيدلاني "${String(dosageForm)}" غير صالح أو غير معتمد.`
    );
  }
  const spec = VERIFIED_DOSAGE_FORM_BASE_UNIT[dosageForm];
  const sellPack = input.sellPack !== false;
  const sellStrip = spec.supportsStrip && input.sellStrip === true;
  const sellPill = spec.supportsStrip && input.sellPill === true;

  if (!spec.supportsStrip && (input.sellStrip === true || input.sellPill === true)) {
    throw new Error('DIRECT_PACK_FORBIDS_STRIP_AND_PILL_SALE');
  }

  let stripsPerPack = 0;
  let pillsPerStrip = 0;
  let baseUnitsPerPack = 0;
  const requestedSellableUnits: SupportedUnitKind[] = [];

  if (spec.supportsStrip) {
    const strips = Number(input.stripsPerPack);
    const pills = Number(input.pillsPerStrip);
    if (!Number.isSafeInteger(strips) || strips <= 0 || !Number.isSafeInteger(pills) || pills <= 0) {
      throw new Error('بيانات تحويل العبوة أو الشريط غير موثقة؛ يمنع افتراض 2×10');
    }
    stripsPerPack = strips;
    pillsPerStrip = pills;
    baseUnitsPerPack = strips * pills;
    if (!Number.isSafeInteger(baseUnitsPerPack) || baseUnitsPerPack <= 0) {
      throw new Error('PACK_CONVERSION_OUT_OF_RANGE');
    }
    if (sellPack) requestedSellableUnits.push('pack');
    if (sellStrip) requestedSellableUnits.push('strip');
    if (sellPill) requestedSellableUnits.push(spec.baseUnit);
  } else {
    if (
      (input.stripsPerPack !== undefined && input.stripsPerPack !== 0) ||
      (input.pillsPerStrip !== undefined && input.pillsPerStrip !== 0)
    ) {
      throw new Error('SOLID_HIERARCHY_FORBIDDEN_FOR_NON_SOLID');
    }
    const perPack = Number(input.baseUnitsPerPack);
    if (!Number.isSafeInteger(perPack) || perPack <= 0) {
      throw new Error('DIRECT_PACK_DEFINITION_MISMATCH: verified baseUnitsPerPack is required');
    }
    baseUnitsPerPack = perPack;
    if (sellPack) requestedSellableUnits.push('pack');
  }

  if (requestedSellableUnits.length === 0) {
    throw new Error('يجب السماح ببيع وحدة واحدة على الأقل لهذا الدواء');
  }

  const canonicalDef = createValidatedUnitDefinition({
    dosageForm,
    baseUnit: spec.baseUnit,
    packUnit: 'pack',
    intermediateUnit: spec.supportsStrip ? 'strip' : null,
    ...(spec.supportsStrip ? { stripsPerPack, pillsPerStrip } : {}),
    baseUnitsPerPack,
    requestedSellableUnits,
    definitionVersion: options?.definitionVersion ?? 1,
    configStatus: 'VERIFIED',
    packingLocked: Boolean(options?.packingLocked)
  });
  const dto = serializeUnitDefinitionToDto(canonicalDef);

  return {
    dosageForm,
    stripsPerPack,
    pillsPerStrip,
    baseUnitsPerPack,
    sellPack,
    sellStrip,
    sellPill,
    ...(input.sellPriceStrip !== undefined ? { sellPriceStrip: Number(input.sellPriceStrip) } : {}),
    ...(input.sellPricePill !== undefined ? { sellPricePill: Number(input.sellPricePill) } : {}),
    configStatus: 'VERIFIED',
    unitDefinition: dto,
    unitDefinitionKey: dto.unitDefinitionKey,
    baseDimensionKey: dto.baseDimensionKey,
    unitOperationalAllowed: true
  };
}

async function saveMedicineWithPackingEvidence(
  medicineData: Partial<Medicine> & { initialStock?: number; idempotencyKey?: string },
  verifiedCreateState?: VerifiedMedicineUnitState,
  verifiedExecutionContext?: TrustedVerificationExecutionContext,
  verifiedIdempotencyKey?: string | null
): Promise<Medicine> {
  assertSafeMedicineSaveInput(medicineData);
  if (verifiedCreateState) {
    if (!verifiedExecutionContext) {
      throw new Error('MEDICINE_VERIFICATION_AUTH_REQUIRED: سياق الاعتماد الموثق مفقود.');
    }
    assertMedicineUnitVerificationAuthorized(verifiedExecutionContext);
  }
  const db = await openPharmacyDB();
  if (verifiedCreateState && verifiedExecutionContext) {
    assertMedicineUnitVerificationAuthorized(verifiedExecutionContext, db);
  }
  const suppliedId = typeof medicineData.id === 'string' ? medicineData.id.trim() : '';
  const medId = suppliedId || generateUUID();

  const hasSuppliedField = (key: keyof (Medicine & { initialStock?: number; idempotencyKey?: string })): boolean =>
    Object.prototype.hasOwnProperty.call(medicineData, key) && (medicineData as any)[key] !== undefined;

  assertRequiredObjectStores(db, ['medicines', 'inventory_ledger', 'outbox', 'metadata']);
  const knownBranchId = verifiedExecutionContext ? verifiedExecutionContext.branchId : getKnownActiveBranchId();
  const knownActorUid = verifiedExecutionContext ? verifiedExecutionContext.uid : getKnownActiveActorId();
  const optionalEvidenceStores = ['sales', 'purchase_invoices', 'stocktaking_sessions', 'stocktaking_items', 'supplier_invoice_drafts']
    .filter((name) => db.objectStoreNames.contains(name));
  const transactionStores = Array.from(new Set(['medicines', 'inventory_ledger', 'outbox', 'metadata', ...optionalEvidenceStores]));
  const { v1RetryMedicineIds, v1LocalInFlightPresent, v1StorageEvidenceUnknown } =
    collectV1LocalStoragePackingEvidence();
  const idempotencyMetadataKey =
    verifiedCreateState && verifiedExecutionContext && verifiedIdempotencyKey
      ? `${VERIFIED_MEDICINE_CREATE_IDEMPOTENCY_PREFIX}${verifiedExecutionContext.branchId}:${verifiedIdempotencyKey}`
      : null;
  const expectedRequestHash =
    verifiedCreateState && verifiedExecutionContext && verifiedIdempotencyKey
      ? computeVerifiedMedicineCreateRequestHash(
          verifiedExecutionContext.branchId,
          medicineData,
          verifiedCreateState
        )
      : null;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(transactionStores, 'readwrite');
    const medStore = tx.objectStore('medicines');
    const ledgerStore = tx.objectStore('inventory_ledger');
    const outboxStore = tx.objectStore('outbox');
    const metadataStore = tx.objectStore('metadata');
    const optionalEvidenceData = new Map<string, unknown[]>();

    let persistedMed: Medicine | null = null;
    let allMedsLoaded = false;
    let allMeds: Medicine[] = [];
    let existingOutboxLoaded = false;
    let existingOutboxEntries: OutboxEntry[] = [];
    let existingMovementsLoaded = false;
    let existingMovements: LedgerMovement[] = [];
    let quarantineLoaded = false;
    let metadataAllLoaded = false;
    let metadataRows: any[] = [];
    let optionalEvidenceLoaded = 0;
    let quarantineRecord: unknown = null;
    let existingIdempotencyLoaded = !idempotencyMetadataKey;
    let existingIdempotencyRecord: VerifiedMedicineCreateIdempotencyRecord | null = null;
    let finalized = false;
    let abortReason: Error | null = null;

    const failTx = (err: unknown, fallbackMsg: string) => {
      const normalizedErr = err instanceof Error ? err : new Error(fallbackMsg);
      abortReason = normalizedErr;
      try {
        tx.abort();
      } catch {
        // ignore abort error
      }
      reject(normalizedErr);
    };

    const tryFinalize = () => {
      if (
        finalized ||
        !allMedsLoaded ||
        !existingOutboxLoaded ||
        !existingMovementsLoaded ||
        !quarantineLoaded ||
        !metadataAllLoaded ||
        !existingIdempotencyLoaded ||
        optionalEvidenceLoaded !== optionalEvidenceStores.length
      ) {
        return;
      }
      finalized = true;

      try {
        if (verifiedCreateState && verifiedExecutionContext) {
          assertMedicineUnitVerificationAuthorized(verifiedExecutionContext, db, tx);
        }

        if (verifiedCreateState && verifiedExecutionContext && idempotencyMetadataKey && expectedRequestHash) {
          if (existingIdempotencyRecord) {
            if (
              existingIdempotencyRecord.branchId !== verifiedExecutionContext.branchId ||
              existingIdempotencyRecord.requestHash !== expectedRequestHash
            ) {
              failTx(
                new Error(
                  `MEDICINE_CREATE_IDEMPOTENCY_CONFLICT: مفتاح عدم التكرار "${verifiedIdempotencyKey}" مستخدم مسبقاً مع بيانات دواء مختلفة.`
                ),
                'MEDICINE_CREATE_IDEMPOTENCY_CONFLICT'
              );
              return;
            }
            const idempotentExistingMed = allMeds.find(
              (m) => m && m.id === existingIdempotencyRecord!.medicineId
            );
            if (!idempotentExistingMed) {
              failTx(
                new Error(
                  `MEDICINE_CREATE_IDEMPOTENCY_CORRUPTED: سجل عدم التكرار "${verifiedIdempotencyKey}" يشير إلى دواء غير موجود (${existingIdempotencyRecord.medicineId}).`
                ),
                'MEDICINE_CREATE_IDEMPOTENCY_CORRUPTED'
              );
              return;
            }
            persistedMed = idempotentExistingMed;
            return;
          }
        }

        const inTxExistingMed = allMeds.find((m) => m && m.id === medId);
        const actuallyNew = !inTxExistingMed;

        const initialStockSupplied = hasSuppliedField('initialStock') && medicineData.initialStock !== null;
        if (initialStockSupplied) {
          if (
            typeof medicineData.initialStock !== 'number' ||
            !Number.isFinite(medicineData.initialStock) ||
            medicineData.initialStock < 0
          ) {
            failTx(
              new Error(`INVALID_INITIAL_STOCK: initialStock must be a non-negative finite number (got ${String(medicineData.initialStock)}).`),
              'INVALID_INITIAL_STOCK'
            );
            return;
          }
        }
        const intendedInitialStock = initialStockSupplied ? Number(medicineData.initialStock) : 0;

        const privilegedCreateFields = [
          'configStatus',
          'unitDefinition',
          'unitDefinitionKey',
          'baseDimensionKey',
          'packingLocked',
          'unitMigrationStatus',
          'unitMigrationRunId',
          'unitMigratedAt',
          'unitOperationalAllowed',
          'openingStockEvidence',
        ];
        if (actuallyNew) {
          const forgedField = privilegedCreateFields.find((field) =>
            Object.prototype.hasOwnProperty.call(medicineData, field)
          );
          if (forgedField) {
            failTx(
              new Error(`UNAUTHORIZED_MEDICINE_CREATE_STATE: Cannot set '${forgedField}' during ordinary medicine creation.`),
              'UNAUTHORIZED_MEDICINE_CREATE_STATE'
            );
            return;
          }
          if (quarantineRecord !== undefined && quarantineRecord !== null) {
            failTx(new Error('ORPHAN_QUARANTINE_RECORD: Refusing to create a medicine over existing quarantine metadata.'), 'ORPHAN_QUARANTINE_RECORD');
            return;
          }
        } else {
          if (verifiedCreateState) {
            failTx(
              new Error(`MEDICINE_ALREADY_EXISTS: الدواء "${medId}" موجود مسبقاً؛ استخدم verifyMedicineUnitConfiguration لاعتماد وحداته.`),
              'MEDICINE_ALREADY_EXISTS'
            );
            return;
          }
          const quarantineReason = getMedicineQuarantineMutationBlockReason(inTxExistingMed, quarantineRecord);
          if (quarantineReason) {
            failTx(
              new Error(`MEDICINE_QUARANTINED: saveMedicine is blocked for '${medId}' (${quarantineReason}). Use the authorized pharmacist recovery flow.`),
              'MEDICINE_QUARANTINED'
            );
            return;
          }
          const protectedUnitFields = [
            'dosageForm',
            'baseUnitsPerPack',
            'configStatus',
            'unitDefinition',
            'unitDefinitionKey',
            'baseDimensionKey',
            'packingLocked',
            'unitMigrationStatus',
            'unitMigrationRunId',
            'unitMigratedAt',
            'unitOperationalAllowed',
          ] as const;
          for (const field of protectedUnitFields) {
            if (
              Object.prototype.hasOwnProperty.call(medicineData, field) &&
              (medicineData as any)[field] !== undefined &&
              stableMedicineFieldFingerprint((medicineData as any)[field]) !==
                stableMedicineFieldFingerprint((inTxExistingMed as any)[field])
            ) {
              failTx(
                new Error(`UNIT_MIGRATION_STATE_PROTECTED: saveMedicine cannot modify '${field}'. Use the dedicated migration or recovery service.`),
                'UNIT_MIGRATION_STATE_PROTECTED'
              );
              return;
            }
          }
          for (const creationField of ['initialStock', 'openingStockEvidence'] as const) {
            if (
              Object.prototype.hasOwnProperty.call(medicineData, creationField) &&
              (medicineData as any)[creationField] !== undefined &&
              stableMedicineFieldFingerprint((medicineData as any)[creationField]) !==
                stableMedicineFieldFingerprint((inTxExistingMed as any)[creationField])
            ) {
              failTx(
                new Error(`INITIAL_STOCK_IMMUTABLE: saveMedicine cannot modify '${creationField}' after medicine creation.`),
                'INITIAL_STOCK_IMMUTABLE'
              );
              return;
            }
          }
        }

        const currentMedForEvidence = inTxExistingMed ?? null;
        const getItemMedicineIds = (rows: unknown[]): Set<string> => {
          const ids = new Set<string>();
          for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const items = (row as any).items;
            if (!Array.isArray(items)) continue;
            for (const item of items) {
              if (!item || typeof item !== 'object') continue;
              const id = typeof (item as any).medicineId === 'string' ? (item as any).medicineId : (item as any).matchedMedicineId;
              if (typeof id === 'string' && id.trim()) ids.add(id.trim());
            }
          }
          return ids;
        };
        const salesRows = optionalEvidenceData.get('sales') ?? [];
        const purchaseRows = optionalEvidenceData.get('purchase_invoices') ?? [];
        const sessions = optionalEvidenceData.get('stocktaking_sessions') ?? [];
        const stockItems = optionalEvidenceData.get('stocktaking_items') ?? [];
        const ocrDrafts = optionalEvidenceData.get('supplier_invoice_drafts') ?? [];
        const hasReference = (rows: unknown[]) => getItemMedicineIds(rows).has(medId);
        const openSessionIds = new Set<string>();
        for (const session of sessions) {
          if (!session || typeof session !== 'object') continue;
          const row = session as any;
          const status = String(row.status ?? '').toLowerCase();
          if (!['completed', 'closed', 'posted', 'cancelled', 'archived'].includes(status) && typeof row.id === 'string') openSessionIds.add(row.id);
        }
        const openStocktaking = stockItems.some((item: any) => item && typeof item === 'object' &&
          item.medicineId === medId && typeof item.sessionId === 'string' && openSessionIds.has(item.sessionId)) ||
          sessions.some((session: any) => session && typeof session === 'object' &&
            typeof session.id === 'string' && openSessionIds.has(session.id) &&
            Array.isArray(session.items) && session.items.some((item: any) => item && item.medicineId === medId));
        const unpostedOcrDraft = ocrDrafts.some((draft: any) => draft && typeof draft === 'object' &&
          !['POSTED', 'FAILED', 'DUPLICATE'].includes(String(draft.status)) &&
          Array.isArray(draft.items) && draft.items.some((item: any) => item && item.matchedMedicineId === medId));
        const unresolvedBackupReview = metadataRows.some((row: any) => row && typeof row === 'object' &&
          typeof row.key === 'string' && row.key.startsWith('unit_migration_v2:stocktaking_review:') &&
          row.reviewRequired === true && typeof row.sessionId === 'string' &&
          sessions.some((session: any) => session && session.id === row.sessionId &&
            ((Array.isArray(session.items) && session.items.some((item: any) => item && item.medicineId === medId)) ||
              stockItems.some((item: any) => item && item.sessionId === row.sessionId && item.medicineId === medId))));
        const hasSalesOrPurchase = hasReference(salesRows) || hasReference(purchaseRows);
        const hasNonZeroStock = Boolean(currentMedForEvidence &&
          [currentMedForEvidence as any].some((med: any) =>
            ['stock', 'currentStock', 'initialStock', 'quantity', 'totalBasePills', 'baseStock'].some((field) =>
              typeof med[field] === 'number' && Number.isFinite(med[field]) && med[field] !== 0
            )));
        const pendingOutboxCount = existingOutboxEntries.filter((entry: any) =>
          entry && entry.status !== 'synced' &&
          (entry.entityId === medId || entry.payload?.medicineId === medId ||
            entry.payload?.id === medId || (entry.entityType === 'medicine' && entry.entityId === medId))
        ).length;
        const v1LeaseCount = metadataRows.filter((row: any) => row && typeof row.key === 'string' &&
          row.key.startsWith('v1_inflight_lease_v1:') &&
          (row.medicineId === medId || !row.medicineId)).length;
        const decision = evaluatePackingLockSnapshot({
          firstInventoryMovement: existingMovements.length > 0 || hasSalesOrPurchase || hasNonZeroStock ||
            (actuallyNew && Number(medicineData.initialStock ?? 0) > 0),
          historicalLedgerCount: existingMovements.length,
          pendingV1SyncCount: (v1RetryMedicineIds.has(medId) ? 1 : 0) + (v1LocalInFlightPresent ? 1 : 0) + v1LeaseCount,
          pendingV2SyncCount: pendingOutboxCount,
          unresolvedBackupReview,
          openReconciliation: Boolean(quarantineRecord),
          openStocktaking,
          unpostedOcrDraft,
          quarantineOrUnverified: Boolean(quarantineRecord) || currentMedForEvidence?.unitMigrationStatus === 'QUARANTINED',
          permanentLock: Boolean(currentMedForEvidence?.packingLocked || currentMedForEvidence?.unitDefinition?.packingLocked),
          evidenceAvailable: !v1StorageEvidenceUnknown,
          unknownReasons: v1StorageEvidenceUnknown ? ['V1_LOCALSTORAGE_EVIDENCE_UNAVAILABLE'] : [],
        });
        const currentPackingShape = currentMedForEvidence ?? {};
        const proposedPackingShape = { ...currentPackingShape, ...medicineData };
        try {
          if (!actuallyNew) assertPackingMutationAllowed(currentPackingShape, proposedPackingShape, decision);
        } catch (error) {
          failTx(error, 'PACKING_LOCKED');
          return;
        }
        const mustPersistPackingLock = decision.locked || (actuallyNew && Number(medicineData.initialStock ?? 0) > 0);

        if (!actuallyNew && inTxExistingMed!.archived === true) {
          failTx(
            new Error(
              `COMMERCIAL_TARGET_ARCHIVED: الدواء "${inTxExistingMed!.name || medId}" مؤرشف ولا يمكن تعديله أو إلغاء أرشفته`
            ),
            'COMMERCIAL_TARGET_ARCHIVED'
          );
          return;
        }
        if (
          hasSuppliedField('archived') &&
          ((actuallyNew && medicineData.archived === true) ||
            (!actuallyNew && Boolean(medicineData.archived) !== Boolean(inTxExistingMed!.archived)))
        ) {
          failTx(
            new Error(
              'COMMERCIAL_TARGET_ARCHIVED: لا يسمح بتغيير حالة الأرشفة عبر saveMedicine'
            ),
            'تغيير الأرشفة غير مسموح'
          );
          return;
        }

        if (!actuallyNew && inTxExistingMed) {
          const existingPackingLocked =
            inTxExistingMed.packingLocked === true ||
            inTxExistingMed.unitDefinition?.packingLocked === true;
          if (existingPackingLocked) {
            if (
              (hasSuppliedField('packingLocked') && medicineData.packingLocked !== true) ||
              (hasSuppliedField('unitDefinition') &&
                (!medicineData.unitDefinition ||
                  medicineData.unitDefinition.packingLocked !== true))
            ) {
              failTx(
                new Error(
                  'PACKING_LOCKED: لا يمكن إزالة قفل عوامل التعبئة (packingLocked) بعد تثبيته'
                ),
                'PACKING_LOCKED'
              );
              return;
            }
            if (
              hasSuppliedField('stripsPerPack') &&
              Number(medicineData.stripsPerPack) !== Number(inTxExistingMed.stripsPerPack)
            ) {
              failTx(
                new Error(
                  'PACKING_LOCKED: لا يمكن تعديل stripsPerPack بعد تثبيت packingLocked'
                ),
                'PACKING_LOCKED'
              );
              return;
            }
            if (
              hasSuppliedField('pillsPerStrip') &&
              Number(medicineData.pillsPerStrip) !== Number(inTxExistingMed.pillsPerStrip)
            ) {
              failTx(
                new Error(
                  'PACKING_LOCKED: لا يمكن تعديل pillsPerStrip بعد تثبيت packingLocked'
                ),
                'PACKING_LOCKED'
              );
              return;
            }
            for (const sellableField of ['sellPack', 'sellStrip', 'sellPill'] as const) {
              if (
                hasSuppliedField(sellableField) &&
                Boolean(medicineData[sellableField]) !== Boolean(inTxExistingMed[sellableField])
              ) {
                failTx(
                  new Error(`PACKING_LOCKED: Cannot change '${sellableField}' after packing is locked.`),
                  'PACKING_LOCKED'
                );
                return;
              }
            }
            if (
              hasSuppliedField('baseUnitsPerPack') &&
              inTxExistingMed.baseUnitsPerPack !== undefined &&
              Number(medicineData.baseUnitsPerPack) !== Number(inTxExistingMed.baseUnitsPerPack)
            ) {
              failTx(
                new Error(
                  'PACKING_LOCKED: لا يمكن تعديل baseUnitsPerPack بعد تثبيت packingLocked'
                ),
                'PACKING_LOCKED'
              );
              return;
            }
            if (
              hasSuppliedField('dosageForm') &&
              inTxExistingMed.dosageForm &&
              medicineData.dosageForm !== inTxExistingMed.dosageForm
            ) {
              failTx(
                new Error(
                  'PACKING_LOCKED: لا يمكن تغيير الشكل الصيدلاني (dosageForm) بعد تثبيت packingLocked'
                ),
                'PACKING_LOCKED'
              );
              return;
            }
            if (
              hasSuppliedField('unitDefinition') &&
              inTxExistingMed.unitDefinition &&
              medicineData.unitDefinition &&
              (medicineData.unitDefinition.unitDefinitionKey !==
                inTxExistingMed.unitDefinition.unitDefinitionKey ||
                medicineData.unitDefinition.baseUnitsPerPack !==
                  inTxExistingMed.unitDefinition.baseUnitsPerPack ||
                medicineData.unitDefinition.dosageForm !==
                  inTxExistingMed.unitDefinition.dosageForm)
            ) {
              failTx(
                new Error(
                  'PACKING_LOCKED: لا يمكن تعديل بنية وحدات التعبئة (unitDefinition) بعد تثبيت packingLocked'
                ),
                'PACKING_LOCKED'
              );
              return;
            }
          }
        }

        // Compute monotonic commit timestamp inside serialized transaction
        const txWallMs = Date.now();
        const txWallIso = new Date(txWallMs).toISOString();
        const suppliedUpdatedAtMs =
          hasSuppliedField('updatedAt') && medicineData.updatedAt
            ? Date.parse(String(medicineData.updatedAt))
            : NaN;
        const incomingFreshnessMs = Number.isFinite(suppliedUpdatedAtMs) ? suppliedUpdatedAtMs : txWallMs;

        const existingMedUpdatedAtMs = inTxExistingMed?.updatedAt
          ? Date.parse(inTxExistingMed.updatedAt)
          : NaN;
        let maxMedOutboxMs = 0;
        for (const entry of existingOutboxEntries) {
          if (!entry || entry.entityType !== 'medicine' || entry.entityId !== medId) continue;
          const payloadMs = Date.parse(entry.payload?.updatedAt || '');
          const tsMs = Date.parse(entry.timestamp || '');
          maxMedOutboxMs = Math.max(
            maxMedOutboxMs,
            Number.isFinite(payloadMs) ? payloadMs : 0,
            Number.isFinite(tsMs) ? tsMs : 0
          );
        }

        const persistedUpdatedAtMs = Math.max(
          txWallMs,
          Number.isFinite(suppliedUpdatedAtMs) ? suppliedUpdatedAtMs : 0,
          Number.isFinite(existingMedUpdatedAtMs) ? existingMedUpdatedAtMs : 0,
          maxMedOutboxMs
        );
        const commitUpdatedAtIso = new Date(persistedUpdatedAtMs).toISOString();

        // 1. Primary barcode merge & normalization (in-tx authoritative)
        let cleanBarcode = '';
        if (hasSuppliedField('barcode')) {
          cleanBarcode = medicineData.barcode === null ? '' : String(medicineData.barcode).trim();
        } else if (!actuallyNew) {
          cleanBarcode = String(inTxExistingMed!.barcode || '').trim();
        }

        if (actuallyNew && !cleanBarcode) {
          cleanBarcode = generateUniqueAutoBarcodeInCatalog(allMeds, medId);
        }

        // 2. Secondary barcodes merge & normalization (in-tx authoritative)
        const rawSecondary = hasSuppliedField('secondaryBarcodes')
          ? Array.isArray(medicineData.secondaryBarcodes)
            ? medicineData.secondaryBarcodes
            : []
          : actuallyNew
          ? []
          : Array.isArray(inTxExistingMed!.secondaryBarcodes)
          ? inTxExistingMed!.secondaryBarcodes
          : [];

        const cleanSecondary = Array.from(
          new Set(
            rawSecondary
              .map((b) => String(b ?? '').trim())
              .filter((b) => b.length > 0 && b !== cleanBarcode)
          )
        );

        // 3. Authoritative in-transaction barcode uniqueness check across primary & secondary barcodes
        if (cleanBarcode) {
          const primaryCollision = findBarcodeCollisionInCatalog(allMeds, cleanBarcode, medId);
          if (primaryCollision) {
            failTx(
              new Error(`الباركود "${cleanBarcode}" مستخدم مسبقاً مع الدواء: ${primaryCollision.name}`),
              'تكرار الباركود الرئيسي'
            );
            return;
          }
        }

        for (const sec of cleanSecondary) {
          const secCollision = findBarcodeCollisionInCatalog(allMeds, sec, medId);
          if (secCollision) {
            failTx(
              new Error(`الباركود الفرعي "${sec}" مستخدم مسبقاً مع الدواء: ${secCollision.name}`),
              'تكرار الباركود الفرعي'
            );
            return;
          }
        }

        // 4. Merge explicitly supplied fields onto the latest in-transaction record
        const mergedMed: Medicine = {
          id: medId,
          barcode: cleanBarcode,
          name: hasSuppliedField('name')
            ? medicineData.name === null
              ? ''
              : String(medicineData.name).trim()
            : actuallyNew
            ? 'Unknown Medication'
            : inTxExistingMed!.name,
          category: hasSuppliedField('category')
            ? medicineData.category === null
              ? ''
              : String(medicineData.category).trim()
            : actuallyNew
            ? 'Analgesics'
            : inTxExistingMed!.category,
          minStock: hasSuppliedField('minStock')
            ? medicineData.minStock === null
              ? 0
              : Number(medicineData.minStock)
            : actuallyNew
            ? 5
            : inTxExistingMed!.minStock,
          buyPrice: hasSuppliedField('buyPrice')
            ? medicineData.buyPrice === null
              ? 0
              : Number(medicineData.buyPrice)
            : actuallyNew
            ? 0
            : inTxExistingMed!.buyPrice,
          sellPrice: hasSuppliedField('sellPrice')
            ? medicineData.sellPrice === null
              ? 0
              : Number(medicineData.sellPrice)
            : actuallyNew
            ? 0
            : inTxExistingMed!.sellPrice,
          sellPriceStrip: hasSuppliedField('sellPriceStrip')
            ? medicineData.sellPriceStrip === null
              ? undefined
              : Number(medicineData.sellPriceStrip)
            : actuallyNew
            ? undefined
            : inTxExistingMed!.sellPriceStrip,
          sellPricePill: hasSuppliedField('sellPricePill')
            ? medicineData.sellPricePill === null
              ? undefined
              : Number(medicineData.sellPricePill)
            : actuallyNew
            ? undefined
            : inTxExistingMed!.sellPricePill,
          sellPack: hasSuppliedField('sellPack')
            ? medicineData.sellPack === true
            : actuallyNew
            ? true
            : inTxExistingMed!.sellPack !== false,
          sellStrip: hasSuppliedField('sellStrip')
            ? medicineData.sellStrip === true
            : actuallyNew
            ? false
            : inTxExistingMed!.sellStrip === true,
          sellPill: hasSuppliedField('sellPill')
            ? medicineData.sellPill === true
            : actuallyNew
            ? false
            : inTxExistingMed!.sellPill === true,
          expiry: hasSuppliedField('expiry')
            ? medicineData.expiry === null
              ? ''
              : String(medicineData.expiry).trim()
            : actuallyNew
            ? getRelativeDateStr(365)
            : inTxExistingMed!.expiry,
          unitType: hasSuppliedField('unitType')
            ? ((medicineData.unitType || 'pack') as 'pack')
            : actuallyNew
            ? 'pack'
            : inTxExistingMed!.unitType,
          stripsPerPack: hasSuppliedField('stripsPerPack')
            ? medicineData.stripsPerPack === null
              ? 0
              : Number(medicineData.stripsPerPack)
            : actuallyNew
            ? 0
            : inTxExistingMed!.stripsPerPack,
          pillsPerStrip: hasSuppliedField('pillsPerStrip')
            ? medicineData.pillsPerStrip === null
              ? 0
              : Number(medicineData.pillsPerStrip)
            : actuallyNew
            ? 0
            : inTxExistingMed!.pillsPerStrip,
          ...(hasSuppliedField('batchNumber')
            ? (medicineData.batchNumber === null || !String(medicineData.batchNumber).trim()
              ? {}
              : { batchNumber: String(medicineData.batchNumber).trim() })
            : actuallyNew
              ? {}
              : (inTxExistingMed!.batchNumber ? { batchNumber: inTxExistingMed!.batchNumber } : {})),
          createdAt: actuallyNew
            ? hasSuppliedField('createdAt') && medicineData.createdAt
              ? String(medicineData.createdAt)
              : commitUpdatedAtIso
            : inTxExistingMed!.createdAt ||
              (hasSuppliedField('createdAt') && medicineData.createdAt
                ? String(medicineData.createdAt)
                : commitUpdatedAtIso),
          updatedAt: commitUpdatedAtIso,
          secondaryBarcodes: cleanSecondary,
          ...(actuallyNew
            ? { initialStock: intendedInitialStock }
            : inTxExistingMed!.initialStock !== undefined
              ? { initialStock: inTxExistingMed!.initialStock }
              : {}),
          ...(!actuallyNew && inTxExistingMed!.openingStockEvidence !== undefined
            ? { openingStockEvidence: inTxExistingMed!.openingStockEvidence }
            : {}),
          ...(!actuallyNew && inTxExistingMed!.archived !== undefined
            ? { archived: inTxExistingMed!.archived }
            : {}),
          ...(!actuallyNew && inTxExistingMed!.archivedAt !== undefined
            ? { archivedAt: inTxExistingMed!.archivedAt }
            : {}),
          ...(!actuallyNew && inTxExistingMed!.archivedByUid !== undefined
            ? { archivedByUid: inTxExistingMed!.archivedByUid }
            : {}),
          ...(hasSuppliedField('dosageForm')
            ? { dosageForm: medicineData.dosageForm }
            : !actuallyNew && inTxExistingMed!.dosageForm !== undefined
              ? { dosageForm: inTxExistingMed!.dosageForm }
              : {}),
          ...(hasSuppliedField('baseUnitsPerPack')
            ? { baseUnitsPerPack: medicineData.baseUnitsPerPack }
            : !actuallyNew && inTxExistingMed!.baseUnitsPerPack !== undefined
              ? { baseUnitsPerPack: inTxExistingMed!.baseUnitsPerPack }
              : {}),
          ...(hasSuppliedField('configStatus')
            ? { configStatus: medicineData.configStatus }
            : !actuallyNew && inTxExistingMed!.configStatus !== undefined
              ? { configStatus: inTxExistingMed!.configStatus }
              : {}),
          ...(hasSuppliedField('unitDefinition')
            ? { unitDefinition: medicineData.unitDefinition }
            : !actuallyNew && inTxExistingMed!.unitDefinition !== undefined
              ? { unitDefinition: inTxExistingMed!.unitDefinition }
              : {}),
          ...(hasSuppliedField('unitDefinitionKey')
            ? { unitDefinitionKey: medicineData.unitDefinitionKey }
            : !actuallyNew && inTxExistingMed!.unitDefinitionKey !== undefined
              ? { unitDefinitionKey: inTxExistingMed!.unitDefinitionKey }
              : {}),
          ...(hasSuppliedField('baseDimensionKey')
            ? { baseDimensionKey: medicineData.baseDimensionKey }
            : !actuallyNew && inTxExistingMed!.baseDimensionKey !== undefined
              ? { baseDimensionKey: inTxExistingMed!.baseDimensionKey }
              : {}),
          ...(hasSuppliedField('packingLocked')
            ? { packingLocked: medicineData.packingLocked }
            : !actuallyNew && inTxExistingMed!.packingLocked !== undefined
              ? { packingLocked: inTxExistingMed!.packingLocked }
              : {}),
          ...(hasSuppliedField('unitMigrationStatus')
            ? { unitMigrationStatus: medicineData.unitMigrationStatus }
            : !actuallyNew && inTxExistingMed!.unitMigrationStatus !== undefined
              ? { unitMigrationStatus: inTxExistingMed!.unitMigrationStatus }
              : {}),
          ...(hasSuppliedField('unitMigrationRunId')
            ? { unitMigrationRunId: medicineData.unitMigrationRunId }
            : !actuallyNew && inTxExistingMed!.unitMigrationRunId !== undefined
              ? { unitMigrationRunId: inTxExistingMed!.unitMigrationRunId }
              : {}),
          ...(hasSuppliedField('unitMigratedAt')
            ? { unitMigratedAt: medicineData.unitMigratedAt }
            : !actuallyNew && inTxExistingMed!.unitMigratedAt !== undefined
              ? { unitMigratedAt: inTxExistingMed!.unitMigratedAt }
              : {}),
          ...(hasSuppliedField('unitOperationalAllowed')
            ? { unitOperationalAllowed: medicineData.unitOperationalAllowed }
            : !actuallyNew && inTxExistingMed!.unitOperationalAllowed !== undefined
              ? { unitOperationalAllowed: inTxExistingMed!.unitOperationalAllowed }
              : {})
        };
        if (actuallyNew && verifiedCreateState) {
          mergedMed.dosageForm = verifiedCreateState.dosageForm;
          mergedMed.stripsPerPack = verifiedCreateState.stripsPerPack;
          mergedMed.pillsPerStrip = verifiedCreateState.pillsPerStrip;
          mergedMed.baseUnitsPerPack = verifiedCreateState.baseUnitsPerPack;
          mergedMed.sellPack = verifiedCreateState.sellPack;
          mergedMed.sellStrip = verifiedCreateState.sellStrip;
          mergedMed.sellPill = verifiedCreateState.sellPill;
          if (verifiedCreateState.sellPriceStrip !== undefined) {
            mergedMed.sellPriceStrip = verifiedCreateState.sellPriceStrip;
          }
          if (verifiedCreateState.sellPricePill !== undefined) {
            mergedMed.sellPricePill = verifiedCreateState.sellPricePill;
          }
          mergedMed.configStatus = verifiedCreateState.configStatus;
          mergedMed.unitDefinition = verifiedCreateState.unitDefinition;
          mergedMed.unitDefinitionKey = verifiedCreateState.unitDefinitionKey;
          mergedMed.baseDimensionKey = verifiedCreateState.baseDimensionKey;
          mergedMed.unitOperationalAllowed = verifiedCreateState.unitOperationalAllowed;
        }
        if (mustPersistPackingLock) Object.assign(mergedMed, applyStickyPackingLock(mergedMed, decision));

        validateMedicineUnitConfiguration(mergedMed);
        persistedMed = mergedMed;

        const { targetEntry: medOutboxEntry } = resolveMedicineOutboxWrite({
          existingEntries: existingOutboxEntries,
          med: persistedMed,
          actuallyNew,
          knownBranchId,
          knownActorUid,
          nowIso: txWallIso,
          incomingFreshnessMs
        });
        if (medOutboxEntry.action === 'UPDATE') {
          const depIndex = buildOutboxDependencyIndex(existingOutboxEntries);
          const unsyncedMedCreates = existingOutboxEntries.filter(
            (e) =>
              e &&
              e.entityType === 'medicine' &&
              e.entityId === persistedMed!.id &&
              e.action === 'CREATE' &&
              e.status !== 'synced' &&
              e.id !== medOutboxEntry.id
          );
          const depOpIds: string[] = [];
          for (const createEntry of unsyncedMedCreates) {
            validateOutboxRecordDependencies(createEntry, depIndex);
            const opId = getCanonicalOutboxOperationId(createEntry);
            if (opId && opId !== getCanonicalOutboxOperationId(medOutboxEntry) && !depOpIds.includes(opId)) {
              depOpIds.push(opId);
            }
          }
          if (depOpIds.length > 0) {
            const existingDeps = Array.isArray(medOutboxEntry.dependsOn) ? medOutboxEntry.dependsOn : [];
            medOutboxEntry.dependsOn = Array.from(new Set([...existingDeps, ...depOpIds]));
          }
        }

        if (actuallyNew) {
          let initMovement: LedgerMovement | null = null;
          let initLedgerOutboxEntry: OutboxEntry | null = null;
          if (intendedInitialStock > 0) {
            const hasInitialAlready = existingMovements.some(
              (m) => m.type === 'INITIAL' && m.referenceId === 'MANUAL-ADD'
            );
            if (!hasInitialAlready) {
              try {
                assertMedicineOperationallyAllowed(persistedMed);
              } catch (error) {
                failTx(error, 'لا يمكن تسجيل الرصيد الافتتاحي قبل اعتماد وحدات الدواء');
                return;
              }
              if (!persistedMed.batchNumber || !persistedMed.batchNumber.trim()) {
                failTx(
                  new Error('OPENING_STOCK_BATCH_REQUIRED: رقم التشغيلة مطلوب لتسجيل الرصيد الافتتاحي.'),
                  'OPENING_STOCK_BATCH_REQUIRED'
                );
                return;
              }
              const baseUnits = convertMedicineQuantityToBaseUnits(intendedInitialStock, 'pack', persistedMed);
              if (verifiedCreateState && !knownActorUid) {
                failTx(
                  new Error('MEDICINE_VERIFICATION_AUTH_REQUIRED: معرّف المسؤول الموثق مطلوب لتسجيل حركة الرصيد الافتتاحي.'),
                  'MEDICINE_VERIFICATION_AUTH_REQUIRED'
                );
                return;
              }
              const explicitExpirySupplied =
                hasSuppliedField('expiry') &&
                medicineData.expiry !== null &&
                String(medicineData.expiry).trim().length > 0;
              const exactOpeningCost = computeExactMedicineCostPerUnitAndBaseUnit(
                persistedMed.buyPrice,
                'pack',
                persistedMed
              );
              initMovement = {
                id: generateUUID(),
                medicineId: persistedMed.id,
                batchNumber: persistedMed.batchNumber || '',
                ...(explicitExpirySupplied && persistedMed.expiry
                  ? { expiry: persistedMed.expiry }
                  : {}),
                type: 'INITIAL',
                unit: 'pack',
                quantityDelta: intendedInitialStock,
                baseUnitsDelta: baseUnits,
                costPerUnit: persistedMed.buyPrice,
                ...(exactOpeningCost ? { costPerUnitExact: exactOpeningCost.costPerUnitExact } : {}),
                costPerBaseUnit: exactOpeningCost
                  ? exactOpeningCost.costPerBaseUnitNumber
                  : normalizeMedicineCostToBaseUnit(persistedMed.buyPrice, 'pack', persistedMed),
                ...(exactOpeningCost ? { costPerBaseUnitExact: exactOpeningCost.costPerBaseUnitExact } : {}),
                referenceId: 'MANUAL-ADD',
                deviceId: getDeviceId(),
                userId: verifiedExecutionContext
                  ? verifiedExecutionContext.uid
                  : (knownActorUid || 'admin'),
                employeeName: 'المسؤول',
                notes: 'إضافة دواء جديد مع رصيد ابتدائي',
                timestamp: txWallIso,
                synced: 0
              };
              const initLedgerOutboxId = generateUUID();
              initLedgerOutboxEntry = {
                id: initLedgerOutboxId,
                operationId: initLedgerOutboxId,
                idempotencyKey: `inventory_ledger:CREATE:${initMovement.id}`,
                ...(knownBranchId ? { branchId: knownBranchId } : {}),
                ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                schemaVersion: 1,
                dependsOn: [getCanonicalOutboxOperationId(medOutboxEntry)],
                entityType: 'inventory_ledger',
                entityId: initMovement.id,
                action: 'CREATE',
                payload: initMovement,
                timestamp: txWallIso,
                retryCount: 0,
                attempts: 0,
                status: 'pending'
              };
            }
          }
          const medCreateOpId = getCanonicalOutboxOperationId(medOutboxEntry);
          persistedMed.openingStockEvidence = {
            schemaVersion: 1,
            medicineId: persistedMed.id,
            createOperationId: medCreateOpId,
            intent:
              intendedInitialStock > 0
                ? 'POSITIVE'
                : initialStockSupplied
                  ? 'EXPLICIT_ZERO'
                  : 'OMITTED',
            intendedInitialStock,
            intendedBaseUnits: initMovement ? initMovement.baseUnitsDelta : 0,
            ...(initMovement
              ? {
                  initialLedgerMovementId: initMovement.id,
                  batchNumber: persistedMed.batchNumber,
                }
              : {}),
          };
          medOutboxEntry.payload = { ...persistedMed };
          medStore.put(persistedMed);
          outboxStore.put(medOutboxEntry);
          if (initMovement && initLedgerOutboxEntry) {
            ledgerStore.put(initMovement);
            outboxStore.put(initLedgerOutboxEntry);
          }
          if (
            verifiedCreateState &&
            verifiedExecutionContext &&
            verifiedIdempotencyKey &&
            idempotencyMetadataKey &&
            expectedRequestHash
          ) {
            const idempotencyRecord: VerifiedMedicineCreateIdempotencyRecord = {
              key: idempotencyMetadataKey,
              schemaVersion: 1,
              branchId: verifiedExecutionContext.branchId,
              idempotencyKey: verifiedIdempotencyKey,
              requestHash: expectedRequestHash,
              medicineId: persistedMed.id,
              createdByUid: verifiedExecutionContext.uid,
              createdAt: txWallIso,
            };
            metadataStore.put(idempotencyRecord);
          }
        } else {
          medStore.put(persistedMed);
          outboxStore.put(medOutboxEntry);
        }
      } catch (err) {
        failTx(err, 'فشل التحقق من صحة بيانات الدواء داخل المعاملة');
      }
    };

    const medAllReq = medStore.getAll();
    medAllReq.onsuccess = () => {
      allMeds = (medAllReq.result as Medicine[]) || [];
      allMedsLoaded = true;
      tryFinalize();
    };
    medAllReq.onerror = () => failTx(medAllReq.error, 'تعذر قراءة سجل الأدوية داخل المعاملة');

    const quarantineReq = metadataStore.get(`unit_migration_v2:quarantine:${medId}`);
    quarantineReq.onsuccess = () => {
      quarantineRecord = quarantineReq.result ?? null;
      quarantineLoaded = true;
      tryFinalize();
    };
    quarantineReq.onerror = () =>
      failTx(quarantineReq.error, 'تعذر قراءة سجل حجر الدواء داخل المعاملة');

    if (idempotencyMetadataKey) {
      const idempReq = metadataStore.get(idempotencyMetadataKey);
      idempReq.onsuccess = () => {
        existingIdempotencyRecord =
          (idempReq.result as VerifiedMedicineCreateIdempotencyRecord | undefined) ?? null;
        existingIdempotencyLoaded = true;
        tryFinalize();
      };
      idempReq.onerror = () =>
        failTx(idempReq.error, 'تعذر قراءة سجل عدم التكرار (idempotency) داخل المعاملة');
    }

    const metadataAllReq = metadataStore.getAll();
    metadataAllReq.onsuccess = () => {
      metadataRows = Array.isArray(metadataAllReq.result) ? metadataAllReq.result : [];
      metadataAllLoaded = true;
      tryFinalize();
    };
    metadataAllReq.onerror = () => failTx(metadataAllReq.error, 'تعذر قراءة أدلة القفل من metadata');

    for (const storeName of optionalEvidenceStores) {
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => {
        optionalEvidenceData.set(storeName, Array.isArray(req.result) ? req.result : []);
        optionalEvidenceLoaded += 1;
        tryFinalize();
      };
      req.onerror = () => failTx(req.error, `تعذر قراءة أدلة القفل من ${storeName}`);
    }

    const outboxAllReq = outboxStore.getAll();
    outboxAllReq.onsuccess = () => {
      existingOutboxEntries = (outboxAllReq.result as OutboxEntry[]) || [];
      existingOutboxLoaded = true;
      tryFinalize();
    };
    outboxAllReq.onerror = () => failTx(outboxAllReq.error, 'تعذر فحص طابور Outbox داخل المعاملة');

    const existingMovementsReq = ledgerStore.indexNames.contains('medicineId')
      ? ledgerStore.index('medicineId').getAll(medId)
      : ledgerStore.getAll();
    existingMovementsReq.onsuccess = () => {
      const rows = (existingMovementsReq.result as LedgerMovement[]) || [];
      existingMovements = ledgerStore.indexNames.contains('medicineId')
        ? rows
        : rows.filter((movement) => movement && movement.medicineId === medId);
      existingMovementsLoaded = true;
      tryFinalize();
    };
    existingMovementsReq.onerror = () =>
      failTx(existingMovementsReq.error, 'تعذر فحص حركات المخزون الابتدائية داخل المعاملة');

    tx.oncomplete = () => {
      if (persistedMed) {
        resolve(persistedMed);
      } else {
        reject(abortReason || new Error('فشل حفظ بيانات الدواء'));
      }
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل حفظ بيانات الدواء'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة حفظ الدواء'));
  });
}


export async function saveMedicine(medicineData: Partial<Medicine> & { initialStock?: number }): Promise<Medicine> {
  return withLocalFirstMutationMutex('medicine-packing-save', async () =>
    saveMedicineWithPackingEvidence(medicineData)
  );
}

/**
 * Dedicated authorized creation path for a new medicine with an explicitly verified
 * canonical UnitDefinition (and optional opening stock with explicit batchNumber).
 * Ordinary `saveMedicine()` remains fail-closed and never accepts privileged unit states.
 */
export async function createVerifiedMedicine(
  medicineData: Partial<Medicine> & { initialStock?: number; idempotencyKey?: string },
  verification: MedicineUnitVerificationInput,
  options?: CreateVerifiedMedicineOptions
): Promise<Medicine> {
  const capturedContext = assertMedicineUnitVerificationAuthorized();
  const rawIdempotencyKey =
    options?.idempotencyKey !== undefined
      ? options.idempotencyKey
      : verification?.idempotencyKey !== undefined
        ? verification.idempotencyKey
        : (medicineData as { idempotencyKey?: string } | undefined)?.idempotencyKey;
  const normalizedIdempotencyKey = normalizeVerifiedCreateIdempotencyKey(rawIdempotencyKey);
  const verifiedState = buildVerifiedMedicineUnitState(verification, {
    packingLocked: Number(medicineData?.initialStock ?? 0) > 0,
    definitionVersion: 1
  });
  let cleanMedicineData: Partial<Medicine> & { initialStock?: number } = medicineData;
  if (
    medicineData &&
    typeof medicineData === 'object' &&
    Object.prototype.hasOwnProperty.call(medicineData, 'idempotencyKey')
  ) {
    const { idempotencyKey: _ignoredKey, ...rest } = medicineData as Partial<Medicine> & {
      initialStock?: number;
      idempotencyKey?: string;
    };
    cleanMedicineData = rest;
  }
  return withLocalFirstMutationMutex('medicine-verified-create', async () => {
    assertMedicineUnitVerificationAuthorized(capturedContext);
    return saveMedicineWithPackingEvidence(
      cleanMedicineData,
      verifiedState,
      capturedContext,
      normalizedIdempotencyKey
    );
  });
}

/**
 * Dedicated authorized operational verification service for an existing medicine.
 * Enforces online Admin/Super Admin authorization (failing closed when auth authority is inactive),
 * revalidates context across mutex and transaction boundaries, rejects archived or quarantined/conflicted
 * records, evaluates complete packing-lock evidence across ledger/stock/sales/purchases/stocktaking/OCR/V1/V2,
 * builds a canonical VERIFIED SerializedUnitDefinitionDTOV2 without fabricating 2×10,
 * and persists atomically with an outbox entry.
 */
export async function verifyMedicineUnitConfiguration(
  params: VerifyMedicineUnitConfigurationParams
): Promise<Medicine> {
  const capturedContext = assertMedicineUnitVerificationAuthorized();
  if (!params || typeof params !== 'object' || typeof params.medicineId !== 'string' || !params.medicineId.trim()) {
    throw new Error('MEDICINE_ID_REQUIRED: معرف الدواء مطلوب لاعتماد وحداته.');
  }
  const medId = params.medicineId.trim();

  return withLocalFirstMutationMutex('medicine-unit-verify', async () => {
    assertMedicineUnitVerificationAuthorized(capturedContext);
    const db = await openPharmacyDB();
    assertMedicineUnitVerificationAuthorized(capturedContext, db);
    assertRequiredObjectStores(db, ['medicines', 'inventory_ledger', 'outbox', 'metadata']);
    const knownBranchId = capturedContext.branchId;
    const knownActorUid = capturedContext.uid;
    const optionalEvidenceStores = [
      'sales',
      'purchase_invoices',
      'stocktaking_sessions',
      'stocktaking_items',
      'supplier_invoice_drafts'
    ].filter((name) => db.objectStoreNames.contains(name));
    const transactionStores = Array.from(
      new Set(['medicines', 'inventory_ledger', 'outbox', 'metadata', ...optionalEvidenceStores])
    );
    const { v1RetryMedicineIds, v1LocalInFlightPresent, v1StorageEvidenceUnknown } =
      collectV1LocalStoragePackingEvidence();

    return new Promise<Medicine>((resolve, reject) => {
      const tx = db.transaction(transactionStores, 'readwrite');
      const medStore = tx.objectStore('medicines');
      const ledgerStore = tx.objectStore('inventory_ledger');
      const outboxStore = tx.objectStore('outbox');
      const metadataStore = tx.objectStore('metadata');
      const optionalEvidenceData = new Map<string, unknown[]>();

      let persistedMed: Medicine | null = null;
      let existingMed: Medicine | undefined;
      let medLoaded = false;
      let existingOutboxLoaded = false;
      let existingOutboxEntries: OutboxEntry[] = [];
      let existingMovementsLoaded = false;
      let existingMovements: LedgerMovement[] = [];
      let quarantineLoaded = false;
      let quarantineRecord: unknown = null;
      let metadataLoaded = false;
      let metadataRows: unknown[] = [];
      let optionalLoaded = 0;
      let finalized = false;
      let abortReason: Error | null = null;

      const failTx = (err: unknown, fallbackMsg: string) => {
        const normalizedErr = err instanceof Error ? err : new Error(fallbackMsg);
        abortReason = normalizedErr;
        try {
          tx.abort();
        } catch {
          // ignore abort error
        }
        reject(normalizedErr);
      };

      const tryFinalize = () => {
        if (
          finalized ||
          !medLoaded ||
          !existingOutboxLoaded ||
          !existingMovementsLoaded ||
          !quarantineLoaded ||
          !metadataLoaded ||
          optionalLoaded !== optionalEvidenceStores.length
        ) {
          return;
        }
        finalized = true;

        try {
          assertMedicineUnitVerificationAuthorized(capturedContext, db, tx);

          if (!existingMed) {
            failTx(new Error(`MEDICINE_NOT_FOUND:${medId}`), 'الدواء غير موجود');
            return;
          }
          if (existingMed.archived === true) {
            failTx(
              new Error(`COMMERCIAL_TARGET_ARCHIVED: الدواء "${existingMed.name || medId}" مؤرشف ولا يمكن اعتماده`),
              'COMMERCIAL_TARGET_ARCHIVED'
            );
            return;
          }
          const quarantineReason = getMedicineQuarantineMutationBlockReason(existingMed, quarantineRecord);
          if (quarantineReason) {
            failTx(
              new Error(`MEDICINE_QUARANTINED: verifyMedicineUnitConfiguration blocked for '${medId}' (${quarantineReason}).`),
              'MEDICINE_QUARANTINED'
            );
            return;
          }

          const getItemMedicineIds = (rows: unknown[]): Set<string> => {
            const ids = new Set<string>();
            for (const row of rows) {
              if (!row || typeof row !== 'object') continue;
              const items = (row as { items?: unknown }).items;
              if (!Array.isArray(items)) continue;
              for (const item of items) {
                if (!item || typeof item !== 'object') continue;
                const rec = item as { medicineId?: unknown; matchedMedicineId?: unknown };
                const id =
                  typeof rec.medicineId === 'string'
                    ? rec.medicineId
                    : typeof rec.matchedMedicineId === 'string'
                      ? rec.matchedMedicineId
                      : '';
                if (id.trim()) ids.add(id.trim());
              }
            }
            return ids;
          };

          const salesRows = optionalEvidenceData.get('sales') ?? [];
          const purchaseRows = optionalEvidenceData.get('purchase_invoices') ?? [];
          const sessions = optionalEvidenceData.get('stocktaking_sessions') ?? [];
          const stockItems = optionalEvidenceData.get('stocktaking_items') ?? [];
          const ocrDrafts = optionalEvidenceData.get('supplier_invoice_drafts') ?? [];
          const hasReference = (rows: unknown[]) => getItemMedicineIds(rows).has(medId);

          const openSessionIds = new Set<string>();
          for (const session of sessions) {
            if (!session || typeof session !== 'object') continue;
            const row = session as { id?: unknown; status?: unknown };
            const status = String(row.status ?? '').toLowerCase();
            if (
              !['completed', 'closed', 'posted', 'cancelled', 'archived'].includes(status) &&
              typeof row.id === 'string'
            ) {
              openSessionIds.add(row.id);
            }
          }

          const openStocktaking =
            stockItems.some(
              (item: any) =>
                item &&
                typeof item === 'object' &&
                item.medicineId === medId &&
                typeof item.sessionId === 'string' &&
                openSessionIds.has(item.sessionId)
            ) ||
            sessions.some(
              (session: any) =>
                session &&
                typeof session === 'object' &&
                typeof session.id === 'string' &&
                openSessionIds.has(session.id) &&
                Array.isArray(session.items) &&
                session.items.some((item: any) => item && item.medicineId === medId)
            );

          const unpostedOcrDraft = ocrDrafts.some(
            (draft: any) =>
              draft &&
              typeof draft === 'object' &&
              !['POSTED', 'FAILED', 'DUPLICATE'].includes(String(draft.status)) &&
              Array.isArray(draft.items) &&
              draft.items.some(
                (item: any) =>
                  item &&
                  (item.matchedMedicineId === medId || item.medicineId === medId)
              )
          );

          const unresolvedBackupReview = metadataRows.some((row: any) => {
            if (!row || typeof row !== 'object' || typeof row.key !== 'string') return false;
            if (!row.key.startsWith('unit_migration_v2:stocktaking_review:')) return false;
            const payload =
              row.value && typeof row.value === 'object' ? row.value : row;
            if (payload.reviewRequired !== true) return false;
            if (
              Array.isArray(payload.items) &&
              payload.items.some((item: any) => item && item.medicineId === medId)
            ) {
              return true;
            }
            const sessId =
              typeof payload.sessionId === 'string' && payload.sessionId.trim()
                ? payload.sessionId.trim()
                : row.key.slice('unit_migration_v2:stocktaking_review:'.length).trim();
            if (!sessId) return false;
            return (
              sessions.some(
                (session: any) =>
                  session &&
                  session.id === sessId &&
                  Array.isArray(session.items) &&
                  session.items.some((item: any) => item && item.medicineId === medId)
              ) ||
              stockItems.some(
                (item: any) =>
                  item && item.sessionId === sessId && item.medicineId === medId
              )
            );
          });

          const hasSalesOrPurchase = hasReference(salesRows) || hasReference(purchaseRows);
          const hasNonZeroStock = ['stock', 'currentStock', 'initialStock', 'quantity', 'totalBasePills', 'baseStock'].some(
            (field) => {
              const value = (existingMed as unknown as Record<string, unknown>)[field];
              return typeof value === 'number' && Number.isFinite(value) && value !== 0;
            }
          );

          const isPreviouslyVerified =
            existingMed.configStatus === 'VERIFIED' ||
            existingMed.unitOperationalAllowed === true ||
            existingMed.unitDefinition?.configStatus === 'VERIFIED';

          const relevantUnsyncedOutbox = existingOutboxEntries.filter(
            (entry) =>
              entry &&
              entry.status !== 'synced' &&
              (entry.entityId === medId ||
                (entry.payload as Record<string, unknown> | undefined)?.medicineId === medId ||
                (entry.payload as Record<string, unknown> | undefined)?.id === medId ||
                (entry.entityType === 'medicine' && entry.entityId === medId))
          );

          const isSelfCoalescableUnverifiedDraftOutbox = (entry: OutboxEntry): boolean => {
            if (isPreviouslyVerified) return false;
            if (entry.entityType !== 'medicine' || entry.entityId !== medId) return false;
            if (entry.action !== 'CREATE' && entry.action !== 'UPDATE') return false;
            if (entry.status !== 'pending' && entry.status !== 'retry' && entry.status !== 'failed') {
              return false;
            }
            if (typeof entry.leaseOwner === 'string' && entry.leaseOwner.trim().length > 0) {
              return false;
            }
            return true;
          };

          const blockingOutboxCount = relevantUnsyncedOutbox.filter(
            (entry) => !isSelfCoalescableUnverifiedDraftOutbox(entry)
          ).length;

          const v1LeaseCount = metadataRows.filter(
            (row: any) =>
              row &&
              typeof row === 'object' &&
              typeof row.key === 'string' &&
              row.key.startsWith('v1_inflight_lease_v1:') &&
              (row.medicineId === medId || !row.medicineId)
          ).length;

          const permanentLock = Boolean(existingMed.packingLocked || existingMed.unitDefinition?.packingLocked);
          const hasHistoricalMovements = existingMovements.length > 0;
          const decision = evaluatePackingLockSnapshot({
            firstInventoryMovement: hasHistoricalMovements || hasSalesOrPurchase || hasNonZeroStock,
            historicalLedgerCount: existingMovements.length,
            pendingV1SyncCount:
              (v1RetryMedicineIds.has(medId) ? 1 : 0) +
              (v1LocalInFlightPresent ? 1 : 0) +
              v1LeaseCount,
            pendingV2SyncCount: blockingOutboxCount,
            unresolvedBackupReview,
            openReconciliation: Boolean(quarantineRecord),
            openStocktaking,
            unpostedOcrDraft,
            quarantineOrUnverified:
              Boolean(quarantineRecord) || existingMed.unitMigrationStatus === 'QUARANTINED',
            permanentLock,
            evidenceAvailable: !v1StorageEvidenceUnknown,
            unknownReasons: v1StorageEvidenceUnknown ? ['V1_LOCALSTORAGE_EVIDENCE_UNAVAILABLE'] : []
          });

          if (decision.failClosed) {
            const detail = decision.unknownReasons.join(', ') || 'PACKING_LOCK_EVIDENCE_UNAVAILABLE';
            failTx(
              new Error(`PACKING_LOCKED: لا يمكن اعتماد تعديل عوامل التعبئة بسبب عدم توفر أدلة القفل (${detail}).`),
              'PACKING_LOCKED'
            );
            return;
          }

          const verifiedState = buildVerifiedMedicineUnitState(params, {
            packingLocked: Boolean(permanentLock || decision.locked),
            definitionVersion: existingMed.unitDefinition?.definitionVersion ?? 1
          });

          if (permanentLock || decision.locked || hasHistoricalMovements || hasNonZeroStock || hasSalesOrPurchase) {
            const lockReasonsText = decision.reasons.length > 0
              ? decision.reasons.join(', ')
              : 'PACKING_LOCKED';
            const existingDosageForm = existingMed.dosageForm ?? existingMed.unitDefinition?.dosageForm;
            if (existingDosageForm && existingDosageForm !== verifiedState.dosageForm) {
              failTx(
                new Error(`PACKING_LOCKED: لا يمكن تغيير الشكل الصيدلاني (dosageForm) لدواء مقفول (${lockReasonsText})`),
                'PACKING_LOCKED'
              );
              return;
            }
            if (Number(existingMed.stripsPerPack ?? 0) !== verifiedState.stripsPerPack) {
              failTx(
                new Error(`PACKING_LOCKED: لا يمكن تعديل stripsPerPack لدواء مقفول (${lockReasonsText})`),
                'PACKING_LOCKED'
              );
              return;
            }
            if (Number(existingMed.pillsPerStrip ?? 0) !== verifiedState.pillsPerStrip) {
              failTx(
                new Error(`PACKING_LOCKED: لا يمكن تعديل pillsPerStrip لدواء مقفول (${lockReasonsText})`),
                'PACKING_LOCKED'
              );
              return;
            }
            const existingBaseUnits =
              existingMed.baseUnitsPerPack !== undefined && existingMed.baseUnitsPerPack > 0
                ? Number(existingMed.baseUnitsPerPack)
                : Number(existingMed.stripsPerPack ?? 0) > 0 && Number(existingMed.pillsPerStrip ?? 0) > 0
                  ? Number(existingMed.stripsPerPack) * Number(existingMed.pillsPerStrip)
                  : undefined;
            if (
              existingBaseUnits !== undefined &&
              verifiedState.baseUnitsPerPack !== existingBaseUnits
            ) {
              failTx(
                new Error(`PACKING_LOCKED: لا يمكن تعديل baseUnitsPerPack لدواء مقفول (${lockReasonsText})`),
                'PACKING_LOCKED'
              );
              return;
            }
            if (
              existingMed.unitDefinitionKey &&
              existingMed.unitDefinitionKey !== verifiedState.unitDefinitionKey
            ) {
              failTx(
                new Error(`PACKING_LOCKED: لا يمكن تعديل unitDefinitionKey لدواء مقفول (${lockReasonsText})`),
                'PACKING_LOCKED'
              );
              return;
            }
            if (
              existingMed.baseDimensionKey &&
              existingMed.baseDimensionKey !== verifiedState.baseDimensionKey
            ) {
              failTx(
                new Error(`PACKING_LOCKED: لا يمكن تعديل baseDimensionKey لدواء مقفول (${lockReasonsText})`),
                'PACKING_LOCKED'
              );
              return;
            }
          }

          const txWallMs = Date.now();
          const txWallIso = new Date(txWallMs).toISOString();
          const existingUpdatedMs = existingMed.updatedAt ? Date.parse(existingMed.updatedAt) : NaN;
          const commitUpdatedAtIso = new Date(
            Math.max(txWallMs, Number.isFinite(existingUpdatedMs) ? existingUpdatedMs : 0)
          ).toISOString();

          const updatedMed: Medicine = {
            ...existingMed,
            dosageForm: verifiedState.dosageForm,
            stripsPerPack: verifiedState.stripsPerPack,
            pillsPerStrip: verifiedState.pillsPerStrip,
            baseUnitsPerPack: verifiedState.baseUnitsPerPack,
            sellPack: verifiedState.sellPack,
            sellStrip: verifiedState.sellStrip,
            sellPill: verifiedState.sellPill,
            ...(verifiedState.sellPriceStrip !== undefined ? { sellPriceStrip: verifiedState.sellPriceStrip } : {}),
            ...(verifiedState.sellPricePill !== undefined ? { sellPricePill: verifiedState.sellPricePill } : {}),
            configStatus: verifiedState.configStatus,
            unitDefinition: verifiedState.unitDefinition,
            unitDefinitionKey: verifiedState.unitDefinitionKey,
            baseDimensionKey: verifiedState.baseDimensionKey,
            unitOperationalAllowed: verifiedState.unitOperationalAllowed,
            ...(permanentLock || decision.locked ? { packingLocked: true } : {}),
            updatedAt: commitUpdatedAtIso
          };

          validateMedicineUnitConfiguration(updatedMed);
          assertMedicineOperationallyAllowed(updatedMed);

          const { targetEntry: medOutboxEntry } = resolveMedicineOutboxWrite({
            existingEntries: existingOutboxEntries,
            med: updatedMed,
            actuallyNew: false,
            knownBranchId,
            knownActorUid,
            nowIso: txWallIso,
            incomingFreshnessMs: txWallMs
          });

          persistedMed = updatedMed;
          medStore.put(updatedMed);
          outboxStore.put(medOutboxEntry);
        } catch (err) {
          failTx(err, 'فشل اعتماد تكوين وحدات الدواء');
        }
      };

      const medReq = medStore.get(medId);
      medReq.onsuccess = () => {
        existingMed = medReq.result as Medicine | undefined;
        medLoaded = true;
        tryFinalize();
      };
      medReq.onerror = () => failTx(medReq.error, 'تعذر قراءة سجل الدواء');

      const outboxReq = outboxStore.getAll();
      outboxReq.onsuccess = () => {
        existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
        existingOutboxLoaded = true;
        tryFinalize();
      };
      outboxReq.onerror = () => failTx(outboxReq.error, 'تعذر قراءة سجل Outbox');

      const movReq = ledgerStore.indexNames.contains('medicineId')
        ? ledgerStore.index('medicineId').getAll(medId)
        : ledgerStore.getAll();
      movReq.onsuccess = () => {
        const rows = (movReq.result as LedgerMovement[]) || [];
        existingMovements = ledgerStore.indexNames.contains('medicineId')
          ? rows
          : rows.filter((m) => m && m.medicineId === medId);
        existingMovementsLoaded = true;
        tryFinalize();
      };
      movReq.onerror = () => failTx(movReq.error, 'تعذر قراءة حركات المخزون');

      const quarantineReq = metadataStore.get(`unit_migration_v2:quarantine:${medId}`);
      quarantineReq.onsuccess = () => {
        quarantineRecord = quarantineReq.result ?? null;
        quarantineLoaded = true;
        tryFinalize();
      };
      quarantineReq.onerror = () => failTx(quarantineReq.error, 'تعذر قراءة حالة الحجر للدواء');

      const metaAllReq = metadataStore.getAll();
      metaAllReq.onsuccess = () => {
        metadataRows = (metaAllReq.result as unknown[]) || [];
        metadataLoaded = true;
        tryFinalize();
      };
      metaAllReq.onerror = () => failTx(metaAllReq.error, 'تعذر قراءة metadata');

      if (optionalEvidenceStores.length === 0) {
        tryFinalize();
      } else {
        for (const storeName of optionalEvidenceStores) {
          const req = tx.objectStore(storeName).getAll();
          req.onsuccess = () => {
            optionalEvidenceData.set(storeName, (req.result as unknown[]) || []);
            optionalLoaded += 1;
            tryFinalize();
          };
          req.onerror = () => failTx(req.error, `تعذر قراءة ${storeName}`);
        }
      }

      tx.oncomplete = () => {
        if (persistedMed) resolve(persistedMed);
        else reject(abortReason || new Error('فشل اعتماد وحدات الدواء'));
      };
      tx.onerror = () => reject(abortReason || tx.error || new Error('فشل اعتماد وحدات الدواء'));
      tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة اعتماد وحدات الدواء'));
    });
  });
}

/**
 * Record Stock Adjustment, Damage or Return
 */
export async function recordStockAdjustment(params: {
  medicineId: string;
  type: 'ADJUSTMENT' | 'DAMAGE' | 'RETURN' | 'PURCHASE';
  quantityDelta: number;
  unit: UnitKind;
  notes: string;
  employeeName: string;
}): Promise<LedgerMovement> {
  if (!params || !params.medicineId) {
    throw new Error('معرف الدواء مطلوب لتسجيل حركة التسوية');
  }
  if (!['ADJUSTMENT', 'DAMAGE', 'RETURN', 'PURCHASE'].includes(params.type)) {
    throw new Error(`نوع حركة المخزون غير مدعوم: ${params.type}`);
  }
  if (!['pack', 'strip', 'pill'].includes(params.unit)) {
    throw new Error(`وحدة المخزون غير معروفة: ${params.unit}`);
  }
  if (!Number.isFinite(params.quantityDelta) || params.quantityDelta === 0) {
    throw new Error('كمية التسوية يجب أن تكون رقماً غير صفري');
  }
  if (params.type === 'DAMAGE' && params.quantityDelta >= 0) {
    throw new Error('حركة التلف (DAMAGE) يجب أن تكون كميتها سالبة');
  }
  if ((params.type === 'PURCHASE' || params.type === 'RETURN') && params.quantityDelta <= 0) {
    throw new Error(`حركة (${params.type}) يجب أن تكون كميتها موجبة`);
  }

  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['medicines', 'inventory_ledger', 'outbox']);
  const knownBranchId = getKnownActiveBranchId();
  const knownActorUid = getKnownActiveActorId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['medicines', 'inventory_ledger', 'outbox'], 'readwrite');
    const medStore = tx.objectStore('medicines');
    const ledgerStore = tx.objectStore('inventory_ledger');
    const outboxStore = tx.objectStore('outbox');

    let medLoaded = false;
    let outboxLoaded = false;
    let med: Medicine | undefined;
    let existingOutboxEntries: OutboxEntry[] = [];
    let persistedMovement: LedgerMovement | null = null;
    let abortReason: Error | null = null;
    let finalized = false;

    const failTx = (err: unknown, fallback: string) => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(err ? String(err) : fallback);
      }
      try {
        tx.abort();
      } catch {
        // ignore abort error
      }
    };

    const tryFinalize = () => {
      if (finalized || !medLoaded || !outboxLoaded) return;
      finalized = true;
      try {
        if (!med) {
          failTx(new Error('الدواء غير موجود'), 'الدواء غير موجود');
          return;
        }
        if (med.archived) {
          failTx(
            new Error(`COMMERCIAL_TARGET_ARCHIVED: الصنف "${med.name || med.id}" مؤرشف ولا يمكن تسجيل تسوية مخزون له`),
            'الصنف مؤرشف'
          );
          return;
        }
        try {
          assertMedicineOperationallyAllowed(med);
        } catch (error) {
          failTx(error, 'الدواء غير معتمد تشغيلياً');
          return;
        }

        const depIndex = buildOutboxDependencyIndex(existingOutboxEntries);
        const unsyncedMedCreates = existingOutboxEntries.filter(
          (e) =>
            e &&
            e.entityType === 'medicine' &&
            e.entityId === med!.id &&
            e.action === 'CREATE' &&
            e.status !== 'synced'
        );
        const dependsOnOpIds: string[] = [];
        for (const createEntry of unsyncedMedCreates) {
          validateOutboxRecordDependencies(createEntry, depIndex);
          const opId = getCanonicalOutboxOperationId(createEntry);
          if (opId && !dependsOnOpIds.includes(opId)) {
            dependsOnOpIds.push(opId);
          }
        }

        const baseUnitsDelta = convertMedicineQuantityToBaseUnits(params.quantityDelta, params.unit, med);
        if (!Number.isFinite(baseUnitsDelta) || baseUnitsDelta === 0) {
          failTx(new Error('قيمة التسوية الأساسية لا يمكن أن تساوي صفراً'), 'قيمة التسوية غير صالحة');
          return;
        }

        const nowIso = new Date().toISOString();
        const movement: LedgerMovement = {
          id: generateUUID(),
          medicineId: params.medicineId,
          batchNumber: med.batchNumber || '',
          type: params.type,
          unit: params.unit,
          quantityDelta: params.quantityDelta,
          baseUnitsDelta,
          costPerUnit: med.buyPrice,
          costPerBaseUnit: normalizeMedicineCostToBaseUnit(med.buyPrice, 'pack', med),
          referenceId: 'ADJUST-' + Date.now(),
          deviceId: getDeviceId(),
          userId: knownActorUid || params.employeeName || 'admin',
          employeeName: params.employeeName,
          notes: params.notes,
          timestamp: nowIso,
          synced: 0
        };

        const outboxId = generateUUID();
        const outboxEntry: OutboxEntry = {
          id: outboxId,
          operationId: outboxId,
          idempotencyKey: `inventory_ledger:CREATE:${movement.id}`,
          ...(knownBranchId ? { branchId: knownBranchId } : {}),
          ...(knownActorUid ? { actorUid: knownActorUid } : {}),
          schemaVersion: 1,
          ...(dependsOnOpIds.length > 0 ? { dependsOn: dependsOnOpIds } : {}),
          entityType: 'inventory_ledger',
          entityId: movement.id,
          action: 'CREATE',
          payload: movement,
          timestamp: nowIso,
          retryCount: 0,
          attempts: 0,
          status: 'pending'
        };

        ledgerStore.put(movement);
        outboxStore.put(outboxEntry);
        persistedMovement = movement;
      } catch (err) {
        failTx(err, 'فشل حفظ حركة التسوية');
      }
    };

    const medReq = medStore.get(params.medicineId);
    medReq.onsuccess = () => {
      med = medReq.result as Medicine | undefined;
      medLoaded = true;
      tryFinalize();
    };
    medReq.onerror = () => failTx(medReq.error, 'تعذر قراءة بيانات الدواء داخل المعاملة');

    const outboxReq = outboxStore.getAll();
    outboxReq.onsuccess = () => {
      existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryFinalize();
    };
    outboxReq.onerror = () => failTx(outboxReq.error, 'تعذر قراءة طابور Outbox داخل المعاملة');

    tx.oncomplete = () => {
      if (persistedMovement) resolve(persistedMovement);
      else reject(abortReason || new Error('فشل حفظ حركة التسوية'));
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل حفظ حركة التسوية'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة تسوية المخزون'));
  });
}

export async function getMedicineById(id: string): Promise<Medicine | null> {
  const db = await openPharmacyDB();
  return new Promise((resolve) => {
    const tx = db.transaction('medicines', 'readonly');
    const req = tx.objectStore('medicines').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

export async function getAllMedicines(): Promise<Medicine[]> {
  const db = await openPharmacyDB();
  return new Promise((resolve) => {
    const tx = db.transaction('medicines', 'readonly');
    const req = tx.objectStore('medicines').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

export async function getAllSales(): Promise<Sale[]> {
  const db = await openPharmacyDB();
  return new Promise((resolve) => {
    const tx = db.transaction('sales', 'readonly');
    const req = tx.objectStore('sales').getAll();
    req.onsuccess = () => {
      const list: Sale[] = req.result || [];
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      resolve(list);
    };
    req.onerror = () => resolve([]);
  });
}

export async function getAllSuppliers(includeArchived: boolean = false): Promise<Supplier[]> {
  const db = await openPharmacyDB();
  return new Promise((resolve) => {
    const tx = db.transaction('suppliers', 'readonly');
    const req = tx.objectStore('suppliers').getAll();
    req.onsuccess = () => {
      const list: Supplier[] = (req.result || []).filter((s: Supplier) => {
        if (includeArchived) return true;
        return !s.archived && s.status !== 'archived';
      });
      // Normalize any older records
      list.forEach((s) => {
        if (!s.status) s.status = 'active';
        if (s.legacyBalance === undefined) s.legacyBalance = s.balance ?? 0;
      });
      list.sort((a, b) => (a.name?.ar || '').localeCompare(b.name?.ar || ''));
      resolve(list);
    };
    req.onerror = () => resolve([]);
  });
}

export async function getSupplierById(id: string): Promise<Supplier | null> {
  const db = await openPharmacyDB();
  return new Promise((resolve) => {
    const tx = db.transaction('suppliers', 'readonly');
    const req = tx.objectStore('suppliers').get(id);
    req.onsuccess = () => {
      const sup: Supplier | undefined = req.result;
      if (sup) {
        if (!sup.status) sup.status = 'active';
        if (sup.legacyBalance === undefined) sup.legacyBalance = sup.balance ?? 0;
      }
      resolve(sup || null);
    };
    req.onerror = () => resolve(null);
  });
}

export function resolveSupplierOutboxWrite(params: {
  existingEntries: OutboxEntry[];
  supplier: Supplier;
  actuallyNew: boolean;
  allowCoalesceCreate?: boolean;
  knownBranchId?: string;
  knownActorUid?: string;
  nowIso: string;
  incomingFreshnessMs?: number;
}): {
  targetEntry: OutboxEntry;
  coalesced: boolean;
} {
  return resolveSupplierOutboxWriteShared(
    params,
    {
      normalizeEntry: (entry) => normalizeOutboxEntry(entry),
      isValidActorUid: (uid) => isValidFirebaseActorUid(uid),
      generateId: () => generateUUID()
    }
  );
}

export async function saveSupplier(supData: Partial<Supplier>): Promise<Supplier> {
  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['suppliers', 'outbox']);
  const knownBranchId = getKnownActiveBranchId();
  const knownActorUid = getKnownActiveActorId();
  const id = (typeof supData.id === 'string' && supData.id.trim()) ? supData.id.trim() : generateUUID();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['suppliers', 'outbox'], 'readwrite');
    const supStore = tx.objectStore('suppliers');
    const outboxStore = tx.objectStore('outbox');

    let supLoaded = false;
    let outboxLoaded = false;
    let inTxExisting: Supplier | undefined;
    let existingOutboxEntries: OutboxEntry[] = [];
    let persistedSupplier: Supplier | null = null;
    let abortReason: Error | null = null;
    let finalized = false;

    const failTx = (err: unknown, fallback: string) => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(err ? String(err) : fallback);
      }
      try {
        tx.abort();
      } catch {
        // ignore abort error
      }
    };

    const tryFinalize = () => {
      if (finalized || !supLoaded || !outboxLoaded) return;
      finalized = true;
      try {
        if (inTxExisting && (inTxExisting.archived || inTxExisting.status === 'archived')) {
          failTx(
            new Error(`COMMERCIAL_TARGET_ARCHIVED: المورد "${inTxExisting.name?.ar || inTxExisting.id}" مؤرشف ولا يمكن تعديله`),
            'المورد مؤرشف'
          );
          return;
        }

        const actuallyNew = !inTxExisting;
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const initialBalance =
          supData.balance !== undefined
            ? Number(supData.balance) || 0
            : inTxExisting
            ? inTxExisting.balance
            : 0;

        const fullSupplier: Supplier = {
          ...(inTxExisting || {}),
          id,
          name: supData.name || inTxExisting?.name || { ar: 'مورد جديد', en: 'New Supplier' },
          contactPerson: supData.contactPerson !== undefined ? supData.contactPerson : (inTxExisting?.contactPerson || ''),
          phone: supData.phone !== undefined ? supData.phone : (inTxExisting?.phone || ''),
          city: supData.city !== undefined ? supData.city : (inTxExisting?.city || 'الخرطوم'),
          balance: initialBalance,
          terms: supData.terms !== undefined ? supData.terms : (inTxExisting?.terms || 'Net 30'),
          status: supData.status || inTxExisting?.status || 'active',
          email: supData.email !== undefined ? supData.email : (inTxExisting?.email || ''),
          address: supData.address !== undefined ? supData.address : (inTxExisting?.address || ''),
          taxNumber: supData.taxNumber !== undefined ? supData.taxNumber : (inTxExisting?.taxNumber || ''),
          notes: supData.notes !== undefined ? supData.notes : (inTxExisting?.notes || ''),
          legacyBalance:
            supData.legacyBalance !== undefined
              ? supData.legacyBalance
              : inTxExisting?.legacyBalance !== undefined
              ? inTxExisting.legacyBalance
              : initialBalance,
          openingBalanceReviewed:
            supData.openingBalanceReviewed !== undefined
              ? supData.openingBalanceReviewed
              : (inTxExisting?.openingBalanceReviewed ?? false),
          createdAt: inTxExisting?.createdAt || supData.createdAt || nowIso,
          updatedAt: nowIso
        };

        const { targetEntry: supOutboxEntry } = resolveSupplierOutboxWrite({
          existingEntries: existingOutboxEntries,
          supplier: fullSupplier,
          actuallyNew,
          knownBranchId,
          knownActorUid,
          nowIso,
          incomingFreshnessMs: nowMs
        });

        if (supOutboxEntry.action === 'UPDATE') {
          const depIndex = buildOutboxDependencyIndex(existingOutboxEntries);
          const unsyncedCreates = existingOutboxEntries.filter(
            (e) =>
              e &&
              e.entityType === 'supplier' &&
              e.entityId === fullSupplier.id &&
              e.action === 'CREATE' &&
              e.status !== 'synced' &&
              e.id !== supOutboxEntry.id
          );
          const depOpIds: string[] = [];
          for (const createEntry of unsyncedCreates) {
            validateOutboxRecordDependencies(createEntry, depIndex);
            const opId = getCanonicalOutboxOperationId(createEntry);
            if (opId && opId !== getCanonicalOutboxOperationId(supOutboxEntry) && !depOpIds.includes(opId)) {
              depOpIds.push(opId);
            }
          }
          if (depOpIds.length > 0) {
            const existingDeps = Array.isArray(supOutboxEntry.dependsOn) ? supOutboxEntry.dependsOn : [];
            supOutboxEntry.dependsOn = Array.from(new Set([...existingDeps, ...depOpIds]));
          }
        }

        supStore.put(fullSupplier);
        outboxStore.put(supOutboxEntry);
        persistedSupplier = fullSupplier;
      } catch (err) {
        failTx(err, 'فشل حفظ بيانات المورد');
      }
    };

    const supReq = supStore.get(id);
    supReq.onsuccess = () => {
      inTxExisting = supReq.result as Supplier | undefined;
      supLoaded = true;
      tryFinalize();
    };
    supReq.onerror = () => failTx(supReq.error, 'تعذر قراءة بيانات المورد داخل المعاملة');

    const outboxReq = outboxStore.getAll();
    outboxReq.onsuccess = () => {
      existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryFinalize();
    };
    outboxReq.onerror = () => failTx(outboxReq.error, 'تعذر قراءة طابور Outbox داخل المعاملة');

    tx.oncomplete = () => {
      if (persistedSupplier) resolve(persistedSupplier);
      else reject(abortReason || new Error('فشل حفظ بيانات المورد'));
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل حفظ بيانات المورد'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة حفظ المورد'));
  });
}

export async function updateSupplier(supData: Partial<Supplier> & { id: string }): Promise<Supplier> {
  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['suppliers', 'outbox']);
  const knownBranchId = getKnownActiveBranchId();
  const knownActorUid = getKnownActiveActorId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['suppliers', 'outbox'], 'readwrite');
    const supStore = tx.objectStore('suppliers');
    const outboxStore = tx.objectStore('outbox');

    let supLoaded = false;
    let outboxLoaded = false;
    let existing: Supplier | undefined;
    let existingOutboxEntries: OutboxEntry[] = [];
    let persistedSupplier: Supplier | null = null;
    let abortReason: Error | null = null;
    let finalized = false;

    const failTx = (err: unknown, fallback: string) => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(err ? String(err) : fallback);
      }
      try {
        tx.abort();
      } catch {
        // ignore abort error
      }
    };

    const tryFinalize = () => {
      if (finalized || !supLoaded || !outboxLoaded) return;
      finalized = true;
      try {
        if (!existing) {
          failTx(new Error('المورد المطلوب غير موجود'), 'المورد المطلوب غير موجود');
          return;
        }
        if (existing.archived || existing.status === 'archived') {
          failTx(
            new Error(`COMMERCIAL_TARGET_ARCHIVED: المورد "${existing.name?.ar || existing.id}" مؤرشف ولا يمكن تعديله`),
            'المورد مؤرشف'
          );
          return;
        }

        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const updated: Supplier = {
          ...existing,
          name: supData.name || existing.name,
          contactPerson: supData.contactPerson !== undefined ? supData.contactPerson : existing.contactPerson,
          phone: supData.phone !== undefined ? supData.phone : existing.phone,
          city: supData.city !== undefined ? supData.city : existing.city,
          terms: supData.terms !== undefined ? supData.terms : existing.terms,
          email: supData.email !== undefined ? supData.email : existing.email,
          address: supData.address !== undefined ? supData.address : existing.address,
          taxNumber: supData.taxNumber !== undefined ? supData.taxNumber : existing.taxNumber,
          notes: supData.notes !== undefined ? supData.notes : existing.notes,
          status: supData.status || existing.status || 'active',
          balance: supData.balance !== undefined ? supData.balance : existing.balance,
          legacyBalance: existing.legacyBalance ?? existing.balance ?? 0,
          openingBalanceReviewed:
            supData.openingBalanceReviewed !== undefined
              ? supData.openingBalanceReviewed
              : existing.openingBalanceReviewed,
          updatedAt: nowIso
        };

        const { targetEntry: supOutboxEntry } = resolveSupplierOutboxWrite({
          existingEntries: existingOutboxEntries,
          supplier: updated,
          actuallyNew: false,
          knownBranchId,
          knownActorUid,
          nowIso,
          incomingFreshnessMs: nowMs
        });

        if (supOutboxEntry.action === 'UPDATE') {
          const depIndex = buildOutboxDependencyIndex(existingOutboxEntries);
          const unsyncedCreates = existingOutboxEntries.filter(
            (e) =>
              e &&
              e.entityType === 'supplier' &&
              e.entityId === updated.id &&
              e.action === 'CREATE' &&
              e.status !== 'synced' &&
              e.id !== supOutboxEntry.id
          );
          const depOpIds: string[] = [];
          for (const createEntry of unsyncedCreates) {
            validateOutboxRecordDependencies(createEntry, depIndex);
            const opId = getCanonicalOutboxOperationId(createEntry);
            if (opId && opId !== getCanonicalOutboxOperationId(supOutboxEntry) && !depOpIds.includes(opId)) {
              depOpIds.push(opId);
            }
          }
          if (depOpIds.length > 0) {
            const existingDeps = Array.isArray(supOutboxEntry.dependsOn) ? supOutboxEntry.dependsOn : [];
            supOutboxEntry.dependsOn = Array.from(new Set([...existingDeps, ...depOpIds]));
          }
        }

        supStore.put(updated);
        outboxStore.put(supOutboxEntry);
        persistedSupplier = updated;
      } catch (err) {
        failTx(err, 'فشل تحديث بيانات المورد');
      }
    };

    const supReq = supStore.get(supData.id);
    supReq.onsuccess = () => {
      existing = supReq.result as Supplier | undefined;
      supLoaded = true;
      tryFinalize();
    };
    supReq.onerror = () => failTx(supReq.error, 'تعذر قراءة بيانات المورد داخل المعاملة');

    const outboxReq = outboxStore.getAll();
    outboxReq.onsuccess = () => {
      existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryFinalize();
    };
    outboxReq.onerror = () => failTx(outboxReq.error, 'تعذر قراءة طابور Outbox داخل المعاملة');

    tx.oncomplete = () => {
      if (persistedSupplier) resolve(persistedSupplier);
      else reject(abortReason || new Error('فشل تحديث بيانات المورد'));
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل تحديث بيانات المورد'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة تحديث المورد'));
  });
}

export async function toggleSupplierStatus(id: string): Promise<Supplier> {
  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['suppliers', 'outbox']);
  const knownBranchId = getKnownActiveBranchId();
  const knownActorUid = getKnownActiveActorId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['suppliers', 'outbox'], 'readwrite');
    const supStore = tx.objectStore('suppliers');
    const outboxStore = tx.objectStore('outbox');

    let supLoaded = false;
    let outboxLoaded = false;
    let existing: Supplier | undefined;
    let existingOutboxEntries: OutboxEntry[] = [];
    let persistedSupplier: Supplier | null = null;
    let abortReason: Error | null = null;
    let finalized = false;

    const failTx = (err: unknown, fallback: string) => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(err ? String(err) : fallback);
      }
      try {
        tx.abort();
      } catch {
        // ignore abort error
      }
    };

    const tryFinalize = () => {
      if (finalized || !supLoaded || !outboxLoaded) return;
      finalized = true;
      try {
        if (!existing) {
          failTx(new Error('المورد غير موجود'), 'المورد غير موجود');
          return;
        }
        if (existing.archived || existing.status === 'archived') {
          failTx(
            new Error(`COMMERCIAL_TARGET_ARCHIVED: المورد "${existing.name?.ar || existing.id}" مؤرشف ولا يمكن تغيير حالته`),
            'المورد مؤرشف'
          );
          return;
        }

        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const newStatus: 'active' | 'inactive' = existing.status === 'inactive' ? 'active' : 'inactive';
        const updated: Supplier = {
          ...existing,
          status: newStatus,
          legacyBalance: existing.legacyBalance ?? existing.balance ?? 0,
          updatedAt: nowIso
        };

        const { targetEntry: supOutboxEntry } = resolveSupplierOutboxWrite({
          existingEntries: existingOutboxEntries,
          supplier: updated,
          actuallyNew: false,
          knownBranchId,
          knownActorUid,
          nowIso,
          incomingFreshnessMs: nowMs
        });

        if (supOutboxEntry.action === 'UPDATE') {
          const depIndex = buildOutboxDependencyIndex(existingOutboxEntries);
          const unsyncedCreates = existingOutboxEntries.filter(
            (e) =>
              e &&
              e.entityType === 'supplier' &&
              e.entityId === updated.id &&
              e.action === 'CREATE' &&
              e.status !== 'synced' &&
              e.id !== supOutboxEntry.id
          );
          const depOpIds: string[] = [];
          for (const createEntry of unsyncedCreates) {
            validateOutboxRecordDependencies(createEntry, depIndex);
            const opId = getCanonicalOutboxOperationId(createEntry);
            if (opId && opId !== getCanonicalOutboxOperationId(supOutboxEntry) && !depOpIds.includes(opId)) {
              depOpIds.push(opId);
            }
          }
          if (depOpIds.length > 0) {
            const existingDeps = Array.isArray(supOutboxEntry.dependsOn) ? supOutboxEntry.dependsOn : [];
            supOutboxEntry.dependsOn = Array.from(new Set([...existingDeps, ...depOpIds]));
          }
        }

        supStore.put(updated);
        outboxStore.put(supOutboxEntry);
        persistedSupplier = updated;
      } catch (err) {
        failTx(err, 'فشل تبديل حالة المورد');
      }
    };

    const supReq = supStore.get(id);
    supReq.onsuccess = () => {
      existing = supReq.result as Supplier | undefined;
      supLoaded = true;
      tryFinalize();
    };
    supReq.onerror = () => failTx(supReq.error, 'تعذر قراءة بيانات المورد');

    const outboxReq = outboxStore.getAll();
    outboxReq.onsuccess = () => {
      existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryFinalize();
    };
    outboxReq.onerror = () => failTx(outboxReq.error, 'تعذر قراءة طابور Outbox');

    tx.oncomplete = () => {
      if (persistedSupplier) resolve(persistedSupplier);
      else reject(abortReason || new Error('فشل تبديل حالة المورد'));
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل تبديل حالة المورد'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة تبديل حالة المورد'));
  });
}

export async function deactivateSupplier(id: string): Promise<Supplier> {
  return updateSupplier({ id, status: 'inactive' });
}

export async function activateSupplier(id: string): Promise<Supplier> {
  return updateSupplier({ id, status: 'active' });
}

export async function canDeleteSupplier(id: string): Promise<{
  canDelete: boolean;
  reason?: string;
  invoicesCount: number;
  transactionsCount: number;
  balance: number;
}> {
  const db = await openPharmacyDB();
  const supplier = await getSupplierById(id);
  if (!supplier) {
    return { canDelete: false, reason: 'المورد غير موجود', invoicesCount: 0, transactionsCount: 0, balance: 0 };
  }
  if (supplier.archived || supplier.status === 'archived') {
    return {
      canDelete: false,
      reason: 'المورد مؤرشف مسبقاً',
      invoicesCount: 0,
      transactionsCount: 0,
      balance: supplier.balance || 0
    };
  }

  return new Promise((resolve) => {
    const tx = db.transaction(['purchase_invoices', 'supplier_transactions'], 'readonly');
    const invoiceStore = tx.objectStore('purchase_invoices');
    const txStore = tx.objectStore('supplier_transactions');

    const invIndex = invoiceStore.index('supplierId');
    const txIndex = txStore.index('supplierId');

    const invReq = invIndex.count(id);
    const txReq = txIndex.count(id);

    let invoicesCount = 0;
    let transactionsCount = 0;

    invReq.onsuccess = () => {
      invoicesCount = invReq.result || 0;
    };

    txReq.onsuccess = () => {
      transactionsCount = txReq.result || 0;
    };

    tx.oncomplete = () => {
      const balance = supplier.balance || 0;
      if (invoicesCount > 0) {
        resolve({
          canDelete: false,
          reason: `لا يمكن حذف المورد لوجود فواتير شراء مرتبطة به (${invoicesCount} فاتورة). يمكنك تعطيل المورد للحفاظ على السجلات المحاسبية والضريبية.`,
          invoicesCount,
          transactionsCount,
          balance
        });
        return;
      }

      if (transactionsCount > 0) {
        resolve({
          canDelete: false,
          reason: `لا يمكن حذف المورد لوجود حركات مالية مسجلة في كشف حسابه (${transactionsCount} حركة). يرجى تعطيل حساب المورد بدلاً من الحذف.`,
          invoicesCount,
          transactionsCount,
          balance
        });
        return;
      }

      if (Math.abs(balance) > 0.01) {
        resolve({
          canDelete: false,
          reason: `لا يمكن حذف مورد لديه رصيد مالي غير مصفّر (${balance.toLocaleString()} ج.س). يرجى تصفية الحساب أولاً أو تعطيل المورد.`,
          invoicesCount,
          transactionsCount,
          balance
        });
        return;
      }

      resolve({
        canDelete: true,
        invoicesCount: 0,
        transactionsCount: 0,
        balance
      });
    };

    tx.onerror = () => {
      resolve({
        canDelete: false,
        reason: 'حدث خطأ أثناء فحص ارتباطات المورد',
        invoicesCount: 0,
        transactionsCount: 0,
        balance: supplier.balance || 0
      });
    };
  });
}

export async function deleteSupplier(id: string): Promise<void> {
  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['suppliers', 'purchase_invoices', 'supplier_transactions', 'outbox']);
  const knownBranchId = getKnownActiveBranchId();
  const knownActorUid = getKnownActiveActorId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ['suppliers', 'purchase_invoices', 'supplier_transactions', 'outbox'],
      'readwrite'
    );
    const supStore = tx.objectStore('suppliers');
    const invoiceStore = tx.objectStore('purchase_invoices');
    const stStore = tx.objectStore('supplier_transactions');
    const outboxStore = tx.objectStore('outbox');

    let supLoaded = false;
    let invCountLoaded = false;
    let txCountLoaded = false;
    let outboxLoaded = false;

    let supplier: Supplier | undefined;
    let invoicesCount = 0;
    let transactionsCount = 0;
    let existingOutboxEntries: OutboxEntry[] = [];
    let abortReason: Error | null = null;
    let finalized = false;

    const failTx = (err: unknown, fallback: string) => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(err ? String(err) : fallback);
      }
      try {
        tx.abort();
      } catch {
        // ignore abort error
      }
    };

    const tryFinalize = () => {
      if (finalized || !supLoaded || !invCountLoaded || !txCountLoaded || !outboxLoaded) return;
      finalized = true;
      try {
        if (!supplier) {
          failTx(new Error('المورد غير موجود'), 'المورد غير موجود');
          return;
        }
        if (supplier.archived || supplier.status === 'archived') {
          failTx(new Error('المورد مؤرشف مسبقاً'), 'المورد مؤرشف مسبقاً');
          return;
        }
        if (invoicesCount > 0) {
          failTx(
            new Error(`لا يمكن حذف المورد لوجود فواتير شراء مرتبطة به (${invoicesCount} فاتورة). يمكنك تعطيل المورد للحفاظ على السجلات المحاسبية والضريبية.`),
            'المورد مرتبط بفواتير'
          );
          return;
        }
        if (transactionsCount > 0) {
          failTx(
            new Error(`لا يمكن حذف المورد لوجود حركات مالية مسجلة في كشف حسابه (${transactionsCount} حركة). يرجى تعطيل حساب المورد بدلاً من الحذف.`),
            'المورد مرتبط بحركات مالية'
          );
          return;
        }
        const balance = supplier.balance || 0;
        if (Math.abs(balance) > 0.01) {
          failTx(
            new Error(`لا يمكن حذف مورد لديه رصيد مالي غير مصفّر (${balance.toLocaleString()} ج.س). يرجى تصفية الحساب أولاً أو تعطيل المورد.`),
            'رصيد المورد غير مصفّر'
          );
          return;
        }

        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const archivedSupplier: Supplier = {
          ...supplier,
          status: 'archived',
          archived: true,
          archivedAt: nowIso,
          ...(knownActorUid ? { archivedByUid: knownActorUid } : {}),
          updatedAt: nowIso
        };

        const { targetEntry: archiveOutboxEntry } = resolveSupplierOutboxWrite({
          existingEntries: existingOutboxEntries,
          supplier: archivedSupplier,
          actuallyNew: false,
          allowCoalesceCreate: false,
          knownBranchId,
          knownActorUid,
          nowIso,
          incomingFreshnessMs: nowMs
        });

        const depIndex = buildOutboxDependencyIndex(existingOutboxEntries);
        const unsyncedCreates = existingOutboxEntries.filter(
          (e) =>
            e &&
            e.entityType === 'supplier' &&
            e.entityId === archivedSupplier.id &&
            e.action === 'CREATE' &&
            e.status !== 'synced' &&
            e.id !== archiveOutboxEntry.id
        );
        const depOpIds: string[] = [];
        for (const createEntry of unsyncedCreates) {
          validateOutboxRecordDependencies(createEntry, depIndex);
          const opId = getCanonicalOutboxOperationId(createEntry);
          if (opId && opId !== getCanonicalOutboxOperationId(archiveOutboxEntry) && !depOpIds.includes(opId)) {
            depOpIds.push(opId);
          }
        }
        if (depOpIds.length > 0) {
          const existingDeps = Array.isArray(archiveOutboxEntry.dependsOn) ? archiveOutboxEntry.dependsOn : [];
          archiveOutboxEntry.dependsOn = Array.from(new Set([...existingDeps, ...depOpIds]));
        }

        supStore.put(archivedSupplier);
        outboxStore.put(archiveOutboxEntry);
      } catch (err) {
        failTx(err, 'فشل أرشفة المورد');
      }
    };

    const supReq = supStore.get(id);
    supReq.onsuccess = () => {
      supplier = supReq.result as Supplier | undefined;
      supLoaded = true;
      tryFinalize();
    };
    supReq.onerror = () => failTx(supReq.error, 'تعذر قراءة بيانات المورد');

    const invCountReq = invoiceStore.index('supplierId').count(id);
    invCountReq.onsuccess = () => {
      invoicesCount = invCountReq.result || 0;
      invCountLoaded = true;
      tryFinalize();
    };
    invCountReq.onerror = () => failTx(invCountReq.error, 'تعذر فحص فواتير المورد');

    const stCountReq = stStore.index('supplierId').count(id);
    stCountReq.onsuccess = () => {
      transactionsCount = stCountReq.result || 0;
      txCountLoaded = true;
      tryFinalize();
    };
    stCountReq.onerror = () => failTx(stCountReq.error, 'تعذر فحص حركات المورد');

    const outboxReq = outboxStore.getAll();
    outboxReq.onsuccess = () => {
      existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryFinalize();
    };
    outboxReq.onerror = () => failTx(outboxReq.error, 'تعذر قراءة طابور Outbox');

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشلت معاملة أرشفة المورد'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة أرشفة المورد'));
  });
}

export async function getSupplierTransactions(supplierId: string): Promise<SupplierTransaction[]> {
  const db = await openPharmacyDB();
  return new Promise((resolve) => {
    const tx = db.transaction('supplier_transactions', 'readonly');
    const store = tx.objectStore('supplier_transactions');
    const idx = store.index('supplierId');
    const req = idx.getAll(supplierId);
    req.onsuccess = () => {
      const list: SupplierTransaction[] = req.result || [];
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      resolve(list);
    };
    req.onerror = () => resolve([]);
  });
}

export async function getSupplierInvoices(supplierId: string): Promise<PurchaseInvoice[]> {
  const db = await openPharmacyDB();
  return new Promise((resolve) => {
    const tx = db.transaction('purchase_invoices', 'readonly');
    const store = tx.objectStore('purchase_invoices');
    const idx = store.index('supplierId');
    const req = idx.getAll(supplierId);
    req.onsuccess = () => {
      const list: PurchaseInvoice[] = req.result || [];
      list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      resolve(list);
    };
    req.onerror = () => resolve([]);
  });
}

export async function getSupplierFinancialSummary(supplierId: string): Promise<{
  currentBalance: number;
  legacyBalance: number;
  invoicesCount: number;
  transactionsCount: number;
  status: 'active' | 'inactive' | 'archived';
}> {
  const supplier = await getSupplierById(supplierId);
  const transactions = await getSupplierTransactions(supplierId);
  const invoices = await getSupplierInvoices(supplierId);

  return {
    currentBalance: supplier ? supplier.balance : 0,
    legacyBalance: supplier ? (supplier.legacyBalance ?? supplier.balance ?? 0) : 0,
    invoicesCount: invoices.length,
    transactionsCount: transactions.length,
    status: supplier?.archived ? 'archived' : (supplier?.status || 'active')
  };
}

/**
 * Check if a purchase invoice number is already recorded for a specific supplier
 */
export async function isDuplicateSupplierInvoice(supplierId: string, invoiceNumber: string): Promise<boolean> {
  if (!supplierId || !invoiceNumber || !invoiceNumber.trim()) return false;
  const db = await openPharmacyDB();
  const trimmed = invoiceNumber.trim().toLowerCase();

  return new Promise((resolve) => {
    const tx = db.transaction('purchase_invoices', 'readonly');
    const store = tx.objectStore('purchase_invoices');
    const idx = store.index('supplierId');
    const req = idx.getAll(supplierId);
    req.onsuccess = () => {
      const invoices: PurchaseInvoice[] = req.result || [];
      const dup = invoices.some(inv => inv.invoiceNumber && inv.invoiceNumber.trim().toLowerCase() === trimmed);
      resolve(dup);
    };
    req.onerror = () => resolve(false);
  });
}

/**
 * Retrieve all purchase invoices across all suppliers, sorted by date/createdAt descending
 */
export async function getAllPurchaseInvoices(): Promise<PurchaseInvoice[]> {
  const db = await openPharmacyDB();
  return new Promise((resolve) => {
    const tx = db.transaction('purchase_invoices', 'readonly');
    const req = tx.objectStore('purchase_invoices').getAll();
    req.onsuccess = () => {
      const list: PurchaseInvoice[] = req.result || [];
      list.sort((a, b) => new Date(b.createdAt || b.date).getTime() - new Date(a.createdAt || a.date).getTime());
      resolve(list);
    };
    req.onerror = () => resolve([]);
  });
}

/**
 * Retrieve a single purchase invoice by ID
 */
export async function getPurchaseInvoiceById(id: string): Promise<PurchaseInvoice | null> {
  const db = await openPharmacyDB();
  return new Promise((resolve) => {
    const tx = db.transaction('purchase_invoices', 'readonly');
    const req = tx.objectStore('purchase_invoices').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

/**
 * Convert a validated JS numeric form value to its shortest plain decimal representation.
 * This is an input-boundary normalization only; all subsequent arithmetic stays rational.
 */
function toExactDecimalInputFromNumber(value: number, field: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
      Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${field} must be a finite non-negative safe-range decimal.`);
  }
  if (Object.is(value, -0) || value === 0) return '0';
  let decimal = value.toString();
  const scientific = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(decimal);
  if (scientific) {
    const sign = scientific[1];
    const whole = scientific[2];
    const fraction = scientific[3] || '';
    const exponent = Number(scientific[4]);
    const digits = whole + fraction;
    const point = whole.length + exponent;
    if (point <= 0) decimal = `${sign}0.${'0'.repeat(-point)}${digits}`;
    else if (point >= digits.length) decimal = `${sign}${digits}${'0'.repeat(point - digits.length)}`;
    else decimal = `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(decimal);
  if (!match || (match[3]?.length || 0) > 8) {
    throw new Error(`${field} must have no more than 8 decimal places for exact inventory costing.`);
  }
  return decimal;
}

function rationalToCompatibilityNumber(value: Rational, field: string): number {
  const display = formatRationalForDisplay(value, { decimals: 8, roundingMode: 'HALF_UP' });
  if (display.displayNumber === undefined || !Number.isFinite(display.displayNumber)) {
    throw new Error(`${field} exceeds the safe numeric compatibility range.`);
  }
  return display.displayNumber;
}

/**
 * PHASE 2: ATOMIC PURCHASE INVOICE POSTING ENGINE
 * Executes all 6 essential actions inside a SINGLE atomic IndexedDB readwrite transaction:
 * 1. Validates that supplier exists and is active.
 * 2. Checks duplicate invoice for this supplier (same invoiceNumber).
 * 3. Saves PurchaseInvoice record with all item details, units, batches, and expiries.
 * 4. Creates an independent 'PURCHASE' LedgerMovement in 'inventory_ledger' for each item.
 * 5. Updates medicine latest buyPrice, sellPrice, default batch/expiry, and updatedAt in 'medicines'.
 * 6. Records liability and payment entries in 'supplier_transactions' and updates 'supplier.balance'.
 * 7. Records corresponding events in 'outbox' for resilient local-first sync.
 * All succeed together or fail together without leaving partial state!
 */
export async function postPurchaseInvoice(params: CreatePurchaseInvoiceParams): Promise<PurchaseInvoice> {
  const db = await openPharmacyDB();
  const nowIso = new Date().toISOString();
  const todayStr = nowIso.split('T')[0];

  // 1. Synchronous validation
  if (!params.supplierId) {
    throw new Error('يجب تحديد المورد');
  }
  if (!params.items || params.items.length === 0) {
    throw new Error('يجب إضافة صنف واحد على الأقل في فاتورة الشراء');
  }
  if (params.discount !== undefined && (!Number.isFinite(Number(params.discount)) || Number(params.discount) < 0)) {
    throw new Error('خصم فاتورة الشراء غير صالح');
  }
  if (params.paidAmount !== undefined && (!Number.isFinite(Number(params.paidAmount)) || Number(params.paidAmount) < 0)) {
    throw new Error('المبلغ المدفوع في فاتورة الشراء غير صالح');
  }

  // Handle invoice number: if empty, assign safe internal unique number
  let invoiceNumber = (params.invoiceNumber || '').trim();
  if (!invoiceNumber) {
    invoiceNumber = 'PINV-AUTO-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(100 + Math.random() * 900);
  }

  const invoiceId = params.id || generateUUID();
  const deviceId = getDeviceId();
  const employeeName = params.employeeName || 'المسؤول';

  // 2. Validate items
  for (const item of params.items) {
    if (!item.medicineId) {
      throw new Error('معرف الدواء غير صالح');
    }
    if (typeof item.quantity !== 'number' || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(`الكمية يجب أن تكون عدداً صحيحاً موجباً للصنف "${item.medicineName || item.medicineId}"`);
    }
    if (item.unit !== undefined && !['pack', 'strip', 'pill'].includes(item.unit)) {
      throw new Error(`وحدة الشراء غير معروفة للصنف "${item.medicineName || item.medicineId}"`);
    }
    if (!item.batchNumber || !item.batchNumber.trim()) {
      throw new Error(`يجب إدخال رقم التشغيلة للصنف "${item.medicineName || item.medicineId}"`);
    }
    const itemExpiry = (item.expiry || item.expiryDate || '').trim();
    if (!itemExpiry) {
      throw new Error(`يجب إدخال تاريخ الصلاحية للصنف "${item.medicineName || item.medicineId}"`);
    }
    // Reject expired batches on receipt
    if (itemExpiry < todayStr) {
      throw new Error(`لا يمكن استلام دفعة منتهية الصلاحية للصنف "${item.medicineName || item.medicineId}" (تاريخ الانتهاء: ${itemExpiry})`);
    }
    const itemBuyPrice = item.buyPrice !== undefined ? item.buyPrice : (item.unitBuyPrice !== undefined ? item.unitBuyPrice : 0);
    if (typeof itemBuyPrice !== 'number' || !Number.isFinite(itemBuyPrice) || itemBuyPrice < 0) {
      throw new Error(`سعر الشراء يجب أن يكون رقماً صالحاً غير سالب للصنف "${item.medicineName || item.medicineId}"`);
    }
  }

  // 3. ATOMIC TRANSACTION across 6 stores
  return new Promise((resolve, reject) => {
    let settled = false;
    let abortReason: Error | null = null;
    let idempotentInvoice: PurchaseInvoice | null = null;
    let pendingInvoiceRecord: PurchaseInvoice | null = null;

    const resolveOnce = (value: PurchaseInvoice) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const rejectOnce = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err || 'فشل ترحيل فاتورة الشراء')));
    };

    const tx = db.transaction(
      ['purchase_invoices', 'inventory_ledger', 'supplier_transactions', 'suppliers', 'medicines', 'outbox', 'metadata'],
      'readwrite'
    );

    const abortWith = (err: unknown, fallbackMessage: string) => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(err ? String(err) : fallbackMessage);
      }
      try {
        tx.abort();
      } catch {
        rejectOnce(abortReason);
      }
    };

    tx.oncomplete = () => {
      if (idempotentInvoice) {
        (idempotentInvoice as any).invoice = idempotentInvoice;
        resolveOnce(idempotentInvoice);
        return;
      }
      if (pendingInvoiceRecord) {
        (pendingInvoiceRecord as any).invoice = pendingInvoiceRecord;
        resolveOnce(pendingInvoiceRecord);
        return;
      }
      rejectOnce(abortReason || new Error('اكتملت معاملة فاتورة الشراء دون نتيجة'));
    };

    tx.onerror = () => {
      rejectOnce(abortReason || tx.error || new Error('فشلت معاملة ترحيل فاتورة الشراء'));
    };

    tx.onabort = () => {
      rejectOnce(abortReason || tx.error || new Error('تم إلغاء ترحيل فاتورة الشراء لضمان سلامة البيانات'));
    };

    const invoiceStore = tx.objectStore('purchase_invoices');
    const ledgerStore = tx.objectStore('inventory_ledger');
    const stStore = tx.objectStore('supplier_transactions');
    const supStore = tx.objectStore('suppliers');
    const medStore = tx.objectStore('medicines');
    const outboxStore = tx.objectStore('outbox');
    const metadataStore = tx.objectStore('metadata');

    // Step A: Check if supplier exists and is active
    const supReq = supStore.get(params.supplierId);
    supReq.onerror = (event) => {
      event?.preventDefault?.();
      abortWith(supReq.error, 'تعذر قراءة بيانات المورد داخل المعاملة');
    };
    supReq.onsuccess = () => {
      const supplier: Supplier | undefined = supReq.result;
      if (!supplier) {
        abortWith(new Error(`المورد غير موجود: ${params.supplierId}`), 'المورد غير موجود');
        return;
      }
      if (supplier.archived || supplier.status === 'archived') {
        abortWith(
          new Error(`COMMERCIAL_TARGET_ARCHIVED: المورد "${supplier.name?.ar || supplier.id}" مؤرشف ولا يمكن تسجيل فواتير شراء له`),
          'المورد مؤرشف'
        );
        return;
      }
      if (supplier.status === 'inactive') {
        abortWith(
          new Error(`المورد "${supplier.name?.ar || supplier.id}" معطل حالياً. لا يمكن تسجيل فواتير شراء لمورد معطل.`),
          'المورد معطل حالياً'
        );
        return;
      }

      // Step B: Check duplicate invoice for this supplier
      // 1. Check by ID (Idempotency Key)
      const idCheckReq = invoiceStore.get(invoiceId);
      idCheckReq.onerror = (event) => {
        event?.preventDefault?.();
        abortWith(idCheckReq.error, 'تعذر التحقق من تكرار معرف الفاتورة');
      };
      idCheckReq.onsuccess = () => {
        if (idCheckReq.result) {
          // Idempotent hit: resolve existing invoice once transaction completes cleanly
          idempotentInvoice = idCheckReq.result as PurchaseInvoice;
          return;
        }

        // 2. Check by [supplierId, invoiceNumber]
        const supIndex = invoiceStore.index('supplierId');
        const existingInvoicesReq = supIndex.getAll(params.supplierId);
        existingInvoicesReq.onerror = (event) => {
          event?.preventDefault?.();
          abortWith(existingInvoicesReq.error, 'تعذر التحقق من فواتير المورد السابقة');
        };
        existingInvoicesReq.onsuccess = () => {
          const supplierInvoices: PurchaseInvoice[] = existingInvoicesReq.result || [];
          const isDup = supplierInvoices.some(
            inv => inv.supplierId === params.supplierId && inv.invoiceNumber && inv.invoiceNumber.trim().toLowerCase() === invoiceNumber.toLowerCase()
          );
          if (isDup) {
            abortWith(
              new Error(`رقم الفاتورة "${invoiceNumber}" مسجل مسبقاً للمورد "${supplier.name?.ar || supplier.id}". تم منع التكرار لحماية السجلات المالية.`),
              'رقم الفاتورة مكرر'
            );
            return;
          }

          // Step C: Retrieve medicines and outbox entries to get unit conversion details & V2 outbox coalescing
          let allMeds: Medicine[] = [];
          let existingOutboxEntries: OutboxEntry[] = [];
          let medsLoaded = false;
          let outboxLoaded = false;
          let quarantineReadsStarted = false;
          let quarantineReadsDone = false;
          const quarantineRecordsByMedicineId = new Map<string, unknown>();
          let proceeded = false;

          const tryProceedAfterLoad = () => {
            if (proceeded || settled || !medsLoaded || !outboxLoaded) return;
            if (!quarantineReadsStarted) {
              quarantineReadsStarted = true;
              const medicineIds = Array.from(new Set(params.items.map((item) => item.medicineId)));
              let remainingQuarantineReads = medicineIds.length;
              if (remainingQuarantineReads === 0) {
                quarantineReadsDone = true;
                tryProceedAfterLoad();
                return;
              }
              for (const medicineId of medicineIds) {
                const quarantineReq = metadataStore.get(`unit_migration_v2:quarantine:${medicineId}`);
                quarantineReq.onsuccess = () => {
                  quarantineRecordsByMedicineId.set(medicineId, quarantineReq.result ?? null);
                  remainingQuarantineReads -= 1;
                  if (remainingQuarantineReads === 0) {
                    quarantineReadsDone = true;
                    tryProceedAfterLoad();
                  }
                };
                quarantineReq.onerror = () => {
                  abortWith(
                    quarantineReq.error || new Error(`QUARANTINE_READ_FAILED:${medicineId}`),
                    'تعذر قراءة حالة الحجر للصنف داخل معاملة فاتورة الشراء'
                  );
                };
              }
              return;
            }
            if (!quarantineReadsDone) return;
            proceeded = true;
            try {
              const medMap = new Map<string, Medicine>();
              allMeds.forEach(m => medMap.set(m.id, m));
              const knownBranchId = getKnownActiveBranchId();
              const knownActorUid = getKnownActiveActorId();

              // Validate all medicines exist and are not archived
              for (const item of params.items) {
                const targetMed = medMap.get(item.medicineId);
                if (!targetMed) {
                  abortWith(new Error(`الصنف غير مسجل في قائمة الأدوية: ${item.medicineId}`), 'الصنف غير مسجل');
                  return;
                }
                if (targetMed.archived) {
                  abortWith(
                    new Error(`COMMERCIAL_TARGET_ARCHIVED: الصنف "${targetMed.name || targetMed.id}" مؤرشف ولا يمكن شراؤه`),
                    'الصنف مؤرشف'
                  );
                  return;
                }
                const quarantineReason = getMedicineQuarantineMutationBlockReason(
                  targetMed,
                  quarantineRecordsByMedicineId.get(item.medicineId)
                );
                if (quarantineReason) {
                  abortWith(
                    new Error(`MEDICINE_QUARANTINED: Purchase invoice blocked for '${item.medicineId}' (${quarantineReason}).`),
                    'لا يمكن شراء صنف محجور أو غير محسوم المراجعة'
                  );
                  return;
                }
                try {
                  assertMedicineOperationallyAllowed(targetMed);
                } catch (error) {
                  abortWith(error, 'لا يمكن شراء دواء لم يجتز التحقق التشغيلي');
                  return;
                }
              }

              // F4-A R3 Hardening: Fail-closed dependency validation before any store writes
              const outboxDepIndex = buildOutboxDependencyIndex(existingOutboxEntries);
              const invoiceMedicineIds = new Set(params.items.map((i) => i.medicineId));
              const relevantOutboxEntries = existingOutboxEntries.filter(
                (e) =>
                  e &&
                  ((e.entityType === 'medicine' && invoiceMedicineIds.has(e.entityId)) ||
                    (e.entityType === 'supplier' && e.entityId === supplier.id))
              );
              for (const entry of relevantOutboxEntries) {
                validateOutboxRecordDependencies(entry, outboxDepIndex);
              }
              const unsyncedSupplierCreateOpIds: string[] = [];
              for (const supCreate of existingOutboxEntries) {
                if (
                  supCreate &&
                  supCreate.entityType === 'supplier' &&
                  supCreate.entityId === supplier.id &&
                  supCreate.action === 'CREATE' &&
                  supCreate.status !== 'synced'
                ) {
                  validateOutboxRecordDependencies(supCreate, outboxDepIndex);
                  const supCreateOpId = getCanonicalOutboxOperationId(supCreate);
                  if (supCreateOpId && !unsyncedSupplierCreateOpIds.includes(supCreateOpId)) {
                    unsyncedSupplierCreateOpIds.push(supCreateOpId);
                  }
                }
              }

              // Step D: Build invoice items with exact decimal source values.
              const fullItems: PurchaseInvoiceItem[] = [];
              const ledgerEntries: LedgerMovement[] = [];
              const updatedMedicineMap = new Map<string, Medicine>();

              for (const item of params.items) {
                const baseMed = updatedMedicineMap.get(item.medicineId) || medMap.get(item.medicineId)!;
                const unit = item.unit || 'pack';
                const directPack = isDirectPackMedicine(baseMed);
                const baseUnitsPerPack = getMedicineBaseUnitsPerPack(baseMed);
                if (directPack && unit !== 'pack') {
                  abortWith(new Error('DIRECT_PACK_PARTIAL_PURCHASE_UNSUPPORTED'), 'لا يمكن استلام وحدة جزئية لدواء DIRECT_PACK');
                  return;
                }
                const stripsPerPack = directPack ? 0 : Number(baseMed.stripsPerPack);
                const pillsPerStrip = directPack ? 0 : Number(baseMed.pillsPerStrip);
                const baseUnits = convertMedicineQuantityToBaseUnits(item.quantity, unit, baseMed);
                const itemExpiry = (item.expiry || item.expiryDate || '').trim();
                const itemBuyPrice = item.buyPrice !== undefined ? item.buyPrice : (item.unitBuyPrice !== undefined ? item.unitBuyPrice : 0);
                const itemSellPrice = item.sellPrice !== undefined ? item.sellPrice : (item.suggestedSellPrice !== undefined ? item.suggestedSellPrice : 0);
                let buyPriceExact: Rational;
                let grossLineCostExact: Rational;
                let costPerBaseUnitExact: Rational;
                let normalizedPackBuyPriceExact: Rational;
                let lineCost: number;
                let costPerBaseUnit: number;
                let normalizedPackBuyPrice: number;
                try {
                  buyPriceExact = parseExactDecimal(toExactDecimalInputFromNumber(itemBuyPrice, 'سعر شراء الوحدة'));
                  grossLineCostExact = multiplyRational(createRational(BigInt(item.quantity)), buyPriceExact);
                  costPerBaseUnitExact = divideRational(grossLineCostExact, createRational(BigInt(baseUnits)));
                  normalizedPackBuyPriceExact = multiplyRational(costPerBaseUnitExact, createRational(BigInt(baseUnitsPerPack)));
                  lineCost = rationalToCompatibilityNumber(grossLineCostExact, 'إجمالي بند الشراء');
                  costPerBaseUnit = rationalToCompatibilityNumber(costPerBaseUnitExact, 'تكلفة الوحدة الأساسية');
                  normalizedPackBuyPrice = rationalToCompatibilityNumber(normalizedPackBuyPriceExact, 'تكلفة العبوة المطَبّعة');
                } catch (error) {
                  abortWith(error, 'تعذر حساب تكلفة الشراء بدقة');
                  return;
                }
                if (![lineCost, costPerBaseUnit, normalizedPackBuyPrice].every(Number.isFinite) || lineCost < 0) {
                  abortWith(new Error(`تعذر تطبيع تكلفة الشراء للصنف: ${baseMed.name}`), 'تعذر تطبيع تكلفة الشراء');
                  return;
                }
                const movementId = generateUUID();
                const itemId = generateUUID();
                fullItems.push({
                  id: itemId, medicineId: item.medicineId, medicineName: baseMed.name,
                  batchNumber: item.batchNumber.trim(), expiry: itemExpiry, expiryDate: itemExpiry,
                  quantity: item.quantity, unit, stripsPerPack, pillsPerStrip, baseUnits, baseUnitsPerPack,
                  buyPrice: itemBuyPrice, buyPriceExact, grossLineCostExact, totalCostExact: grossLineCostExact,
                  costPerBaseUnitExact, normalizedPackBuyPriceExact, costPerBaseUnit, normalizedPackBuyPrice,
                  unitBuyPrice: itemBuyPrice, sellPrice: itemSellPrice || baseMed.sellPrice,
                  suggestedSellPrice: itemSellPrice || baseMed.sellPrice, totalCost: lineCost, total: lineCost,
                  ledgerMovementId: movementId
                });
                ledgerEntries.push({
                  id: movementId, medicineId: item.medicineId, batchNumber: item.batchNumber.trim(), expiry: itemExpiry,
                  type: 'PURCHASE', unit, quantityDelta: item.quantity, baseUnitsDelta: baseUnits,
                  costPerUnit: itemBuyPrice, costPerUnitExact: buyPriceExact,
                  costPerBaseUnit, costPerBaseUnitExact, referenceId: invoiceNumber,
                  deviceId, userId: employeeName, employeeName,
                  notes: `فاتورة شراء #${invoiceNumber} من المورد ${supplier.name?.ar || supplier.id}`,
                  timestamp: nowIso, synced: 0
                });
                updatedMedicineMap.set(item.medicineId, {
                  ...baseMed, buyPrice: normalizedPackBuyPrice, sellPrice: baseMed.sellPrice,
                  batchNumber: item.batchNumber.trim(), expiry: itemExpiry, updatedAt: nowIso
                });
              }

              // Step E: Allocate invoice discount with exact Rational values; no decimal projection enters the allocation.
              const grossSubtotalExact = fullItems.reduce((sum, item) => addRational(sum, item.grossLineCostExact!), createRational(0n));
              const requestedDiscountExact = parseExactDecimal(toExactDecimalInputFromNumber(Number(params.discount) || 0, 'خصم فاتورة المورد'));
              const boundedDiscountExact = compareRational(requestedDiscountExact, grossSubtotalExact) > 0 ? grossSubtotalExact : requestedDiscountExact;
              const discountAllocation = allocateExactProportionalDiscountRational(fullItems.map((item) => item.grossLineCostExact!), boundedDiscountExact);
              fullItems.forEach((invoiceItem, index) => {
                const netLineCostExact = discountAllocation.netLineCosts[index];
                const discountShareExact = discountAllocation.shares[index];
                const netUnitBuyPriceExact = divideRational(netLineCostExact, createRational(BigInt(invoiceItem.quantity)));
                const netCostPerBaseUnitExact = divideRational(netLineCostExact, createRational(BigInt(invoiceItem.baseUnits)));
                const normalizedPackBuyPriceExact = multiplyRational(netCostPerBaseUnitExact, createRational(BigInt(invoiceItem.baseUnitsPerPack)));
                const netLineCost = rationalToCompatibilityNumber(netLineCostExact, 'صافي تكلفة بند الشراء');
                const discountShare = rationalToCompatibilityNumber(discountShareExact, 'حصة خصم بند الشراء');
                const netUnitBuyPrice = rationalToCompatibilityNumber(netUnitBuyPriceExact, 'تكلفة وحدة الشراء بعد الخصم');
                const netCostPerBaseUnit = rationalToCompatibilityNumber(netCostPerBaseUnitExact, 'تكلفة الوحدة الأساسية بعد الخصم');
                const normalizedPackBuyPrice = rationalToCompatibilityNumber(normalizedPackBuyPriceExact, 'تكلفة العبوة بعد الخصم');
                invoiceItem.discountShareExact = discountShareExact;
                invoiceItem.netCostExact = netLineCostExact;
                invoiceItem.netUnitBuyPriceExact = netUnitBuyPriceExact;
                invoiceItem.costPerBaseUnitExact = netCostPerBaseUnitExact;
                invoiceItem.normalizedPackBuyPriceExact = normalizedPackBuyPriceExact;
                invoiceItem.discountShare = discountShare; invoiceItem.netCost = netLineCost;
                invoiceItem.netUnitBuyPrice = netUnitBuyPrice; invoiceItem.costPerBaseUnit = netCostPerBaseUnit;
                invoiceItem.normalizedPackBuyPrice = normalizedPackBuyPrice;
                if (ledgerEntries[index]) {
                  ledgerEntries[index].costPerUnit = netUnitBuyPrice;
                  ledgerEntries[index].costPerUnitExact = netUnitBuyPriceExact;
                  ledgerEntries[index].costPerBaseUnit = netCostPerBaseUnit;
                  ledgerEntries[index].costPerBaseUnitExact = netCostPerBaseUnitExact;
                }
                const currentMedicine = updatedMedicineMap.get(invoiceItem.medicineId);
                if (currentMedicine) currentMedicine.buyPrice = normalizedPackBuyPrice;
              });

              // Supplier-facing numeric fields are compatibility projections; exact snapshots remain alongside them.
              const totalAmount = rationalToCompatibilityNumber(discountAllocation.subtotal, 'إجمالي فاتورة الشراء');
              const discount = rationalToCompatibilityNumber(discountAllocation.discount, 'خصم فاتورة الشراء');
              const netAmount = rationalToCompatibilityNumber(discountAllocation.netTotal, 'صافي فاتورة الشراء');
              let paidAmount = Math.max(0, Number(params.paidAmount) || 0);
              if (paidAmount > netAmount) {
                paidAmount = netAmount;
              }
              const remainingAmount = Math.max(0, netAmount - paidAmount);

              let paymentStatus: 'Paid' | 'Partial' | 'Unpaid' = 'Unpaid';
              if (remainingAmount <= 0.01) {
                paymentStatus = 'Paid';
              } else if (paidAmount > 0) {
                paymentStatus = 'Partial';
              }

              let paymentType = params.paymentType || 'Credit';
              if (paymentStatus === 'Paid' && paymentType !== 'Bankak') {
                paymentType = 'Cash';
              }

              const invoiceDate = (params.date || params.invoiceDate || todayStr).trim();

              const invoiceRecord: PurchaseInvoice = {
                id: invoiceId,
                supplierId: supplier.id,
                supplierName: supplier.name?.ar || supplier.id,
                invoiceNumber,
                date: invoiceDate,
                invoiceDate,
                items: fullItems,
                itemsCount: fullItems.length,
                totalAmount,
                subtotal: totalAmount,
                discount,
                netAmount,
                subtotalExact: discountAllocation.subtotal,
                discountExact: discountAllocation.discount,
                netAmountExact: discountAllocation.netTotal,
                paidAmount,
                remainingAmount,
                paymentType,
                paymentStatus,
                dueDate: params.dueDate || undefined,
                notes: params.notes || undefined,
                createdAt: nowIso,
                deviceId,
                employeeName,
                synced: 0
              };

              // Outbox V2 entries with dependency on canonical invoice operationId
              const invoiceOutboxId = generateUUID();
              const invoiceOutboxOpId = invoiceOutboxId;
              const invoiceOutboxEntry: OutboxEntry = {
                id: invoiceOutboxId,
                operationId: invoiceOutboxOpId,
                idempotencyKey: `purchase_invoice:CREATE:${invoiceRecord.id}`,
                ...(knownBranchId ? { branchId: knownBranchId } : {}),
                ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                schemaVersion: 1,
                ...(unsyncedSupplierCreateOpIds.length > 0 ? { dependsOn: [...unsyncedSupplierCreateOpIds] } : {}),
                entityType: 'purchase_invoice',
                entityId: invoiceRecord.id,
                action: 'CREATE',
                payload: invoiceRecord,
                timestamp: nowIso,
                retryCount: 0,
                attempts: 0,
                status: 'pending'
              };
              invoiceStore.put(invoiceRecord);
              outboxStore.put(invoiceOutboxEntry);

              // Put unique updated medicines first so any coalesced medicine:CREATE opId is known for ledger dependsOn
              const medCreateOpIdsByMed = new Map<string, string[]>();
              updatedMedicineMap.forEach((med) => {
                medStore.put(med);
                const { targetEntry: medOutboxEntry } = resolveMedicineOutboxWrite({
                  existingEntries: existingOutboxEntries,
                  med,
                  actuallyNew: false,
                  knownBranchId,
                  knownActorUid,
                  nowIso
                });
                validateOutboxRecordDependencies(medOutboxEntry, outboxDepIndex);
                const medOutboxOpId = getCanonicalOutboxOperationId(medOutboxEntry);

                const unsyncedCreateEntries = existingOutboxEntries.filter(
                  (e) =>
                    e &&
                    e.entityType === 'medicine' &&
                    e.entityId === med.id &&
                    e.action === 'CREATE' &&
                    e.status !== 'synced' &&
                    e.id !== medOutboxEntry.id
                );
                const unsyncedCreateDepOpIds: string[] = [];
                for (const createEntry of unsyncedCreateEntries) {
                  validateOutboxRecordDependencies(createEntry, outboxDepIndex);
                  const createOpId = getCanonicalOutboxOperationId(createEntry);
                  if (createOpId === medOutboxOpId) {
                    throw new Error(`OUTBOX_DEPENDENCY_CORRUPT: تعارض تكرار operationId (${createOpId}) في سجلات Outbox للدواء "${med.id}"`);
                  }
                  unsyncedCreateDepOpIds.push(createOpId);
                }
                if (medOutboxEntry.dependsOn !== undefined && !Array.isArray(medOutboxEntry.dependsOn)) {
                  throw new Error(
                    `OUTBOX_DEPENDENCY_CORRUPT: حقل dependsOn للسجل "${medOutboxEntry.id}" ليس مصفوفة صالحة`
                  );
                }
                const normalizedExistingDeps = medOutboxEntry.dependsOn !== undefined
                  ? normalizeDependsOnArray(medOutboxEntry.dependsOn, outboxDepIndex)
                  : [];
                medOutboxEntry.dependsOn = Array.from(
                  new Set([...normalizedExistingDeps, invoiceOutboxOpId, ...unsyncedCreateDepOpIds])
                ).filter((depOpId) => depOpId !== medOutboxOpId && depOpId !== medOutboxEntry.id);
                outboxStore.put(medOutboxEntry);

                const allMedCreateDeps = [...unsyncedCreateDepOpIds];
                if (medOutboxEntry.action === 'CREATE' && medOutboxOpId && !allMedCreateDeps.includes(medOutboxOpId)) {
                  allMedCreateDeps.push(medOutboxOpId);
                }
                medCreateOpIdsByMed.set(med.id, allMedCreateDeps);
              });

              // Put ledger movements with dependsOn [invoiceOutboxOpId, ...unsyncedMedCreateOpIds]
              ledgerEntries.forEach((m) => {
                if (knownActorUid) {
                  m.userId = knownActorUid;
                }
                ledgerStore.put(m);
                const ledgerOutboxId = generateUUID();
                const medCreateDeps = medCreateOpIdsByMed.get(m.medicineId) || [];
                const ledgerOutboxEntry: OutboxEntry = {
                  id: ledgerOutboxId,
                  operationId: ledgerOutboxId,
                  idempotencyKey: `inventory_ledger:CREATE:${m.id}`,
                  ...(knownBranchId ? { branchId: knownBranchId } : {}),
                  ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                  schemaVersion: 1,
                  dependsOn: Array.from(new Set([invoiceOutboxOpId, ...medCreateDeps])),
                  entityType: 'inventory_ledger',
                  entityId: m.id,
                  action: 'CREATE',
                  payload: m,
                  timestamp: nowIso,
                  retryCount: 0,
                  attempts: 0,
                  status: 'pending'
                };
                outboxStore.put(ledgerOutboxEntry);
              });

              // Update supplier balance and record supplier_transactions
              const previousBalance = supplier.balance || 0;
              const newBalance = previousBalance + netAmount - paidAmount;

              const updatedSupplier: Supplier = {
                ...supplier,
                balance: newBalance,
                updatedAt: nowIso
              };
              supStore.put(updatedSupplier);
              const { targetEntry: supOutboxEntry } = resolveSupplierOutboxWrite({
                existingEntries: existingOutboxEntries,
                supplier: updatedSupplier,
                actuallyNew: false,
                allowCoalesceCreate: false,
                knownBranchId,
                knownActorUid,
                nowIso
              });
              const supOutboxOpId = getCanonicalOutboxOperationId(supOutboxEntry);
              const existingSupDeps = Array.isArray(supOutboxEntry.dependsOn)
                ? normalizeDependsOnArray(supOutboxEntry.dependsOn, outboxDepIndex)
                : [];
              supOutboxEntry.dependsOn = Array.from(
                new Set([...existingSupDeps, invoiceOutboxOpId, ...unsyncedSupplierCreateOpIds])
              ).filter((d) => d !== supOutboxOpId && d !== supOutboxEntry.id);
              outboxStore.put(supOutboxEntry);

              const txInvoiceId = generateUUID();
              const txInvoice: SupplierTransaction = {
                id: txInvoiceId,
                supplierId: supplier.id,
                type: 'PURCHASE_INVOICE',
                referenceId: invoiceId,
                invoiceNumber,
                voucherNumber: 'PI-' + invoiceNumber,
                amount: netAmount,
                effect: 'CREDIT',
                credit: netAmount,
                debit: 0,
                balanceAfter: Number((previousBalance + netAmount).toFixed(2)),
                date: params.date || todayStr,
                timestamp: nowIso,
                notes: `فاتورة شراء #${invoiceNumber} (${fullItems.length} صنف)`,
                employeeName,
                deviceId,
                synced: 0
              };
              stStore.put(txInvoice);
              const stInvoiceOutboxId = generateUUID();
              outboxStore.put({
                id: stInvoiceOutboxId,
                operationId: stInvoiceOutboxId,
                idempotencyKey: `supplier_transaction:CREATE:${txInvoice.id}`,
                ...(knownBranchId ? { branchId: knownBranchId } : {}),
                ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                schemaVersion: 1,
                dependsOn: Array.from(new Set([invoiceOutboxOpId, ...unsyncedSupplierCreateOpIds])),
                entityType: 'supplier_transaction',
                entityId: txInvoice.id,
                action: 'CREATE',
                payload: txInvoice,
                timestamp: nowIso,
                retryCount: 0,
                attempts: 0,
                status: 'pending'
              });

              if (paidAmount > 0) {
                const paymentTxId = generateUUID();
                const paymentVoucher = 'PV-' + todayStr.replace(/-/g, '') + '-' + paymentTxId.slice(0, 6).toUpperCase();
                const txPayment: SupplierTransaction = {
                  id: paymentTxId,
                  supplierId: supplier.id,
                  type: 'PAYMENT',
                  referenceId: invoiceId,
                  invoiceNumber,
                  voucherNumber: paymentVoucher,
                  amount: paidAmount,
                  effect: 'DEBIT',
                  debit: paidAmount,
                  credit: 0,
                  balanceAfter: newBalance,
                  paymentMethod: paymentType === 'Bankak' ? 'Bankak' : 'Cash',
                  invoiceAllocations: [{
                    invoiceId,
                    invoiceNumber,
                    amount: paidAmount
                  }],
                  date: params.date || todayStr,
                  timestamp: new Date(Date.now() + 10).toISOString(),
                  notes: `سداد فوري لفاتورة الشراء #${invoiceNumber}`,
                  employeeName,
                  deviceId,
                  synced: 0
                };
                stStore.put(txPayment);
                const stPaymentOutboxId = generateUUID();
                outboxStore.put({
                  id: stPaymentOutboxId,
                  operationId: stPaymentOutboxId,
                  idempotencyKey: `supplier_transaction:CREATE:${txPayment.id}`,
                  ...(knownBranchId ? { branchId: knownBranchId } : {}),
                  ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                  schemaVersion: 1,
                  dependsOn: Array.from(new Set([invoiceOutboxOpId, ...unsyncedSupplierCreateOpIds])),
                  entityType: 'supplier_transaction',
                  entityId: txPayment.id,
                  action: 'CREATE',
                  payload: txPayment,
                  timestamp: nowIso,
                  retryCount: 0,
                  attempts: 0,
                  status: 'pending'
                });
              }

              pendingInvoiceRecord = invoiceRecord;
            } catch (err) {
              abortWith(err, 'فشل تنفيذ معاملة ترحيل فاتورة الشراء');
            }
          };

          const medReq = medStore.getAll();
          medReq.onerror = (event) => {
            event?.preventDefault?.();
            abortWith(medReq.error, 'تعذر قراءة قائمة الأدوية داخل معاملة الشراء');
          };
          medReq.onsuccess = () => {
            allMeds = (medReq.result as Medicine[]) || [];
            medsLoaded = true;
            tryProceedAfterLoad();
          };

          const outboxReq = outboxStore.getAll();
          outboxReq.onerror = (event) => {
            event?.preventDefault?.();
            abortWith(outboxReq.error, 'تعذر قراءة طابور Outbox داخل معاملة الشراء');
          };
          outboxReq.onsuccess = () => {
            existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
            outboxLoaded = true;
            tryProceedAfterLoad();
          };
        };
      };
    };
  });
}

export async function getLedgerMovements(medicineId?: string): Promise<LedgerMovement[]> {
  const db = await openPharmacyDB();
  return new Promise((resolve) => {
    const tx = db.transaction('inventory_ledger', 'readonly');
    const store = tx.objectStore('inventory_ledger');
    let req: IDBRequest;
    if (medicineId) {
      const idx = store.index('medicineId');
      req = idx.getAll(medicineId);
    } else {
      req = store.getAll();
    }
    req.onsuccess = () => {
      const list: LedgerMovement[] = req.result || [];
      list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      resolve(list);
    };
    req.onerror = () => resolve([]);
  });
}

function getKnownActiveBranchId(): string | undefined {
  const clean = typeof activeBranchId === 'string' ? activeBranchId.trim() : '';
  return clean.length > 0 ? clean : undefined;
}

function assertRequiredObjectStores(db: IDBDatabase, requiredStores: string[]): void {
  const missing = requiredStores.filter((name) => !db.objectStoreNames.contains(name));
  if (missing.length > 0) {
    throw new Error(`Missing required IndexedDB object store(s): ${missing.join(', ')}`);
  }
}

export function getCanonicalOutboxOperationId(entry: Pick<OutboxEntry, 'id' | 'operationId'>): string {
  if (typeof entry?.operationId === 'string' && entry.operationId.trim().length > 0) {
    return entry.operationId.trim();
  }
  if (typeof entry?.id === 'string' && entry.id.trim().length > 0) {
    return entry.id.trim();
  }
  return '';
}

export interface OutboxDependencyIndex {
  byRecordId: Map<string, OutboxEntry[]>;
  byOperationId: Map<string, OutboxEntry[]>;
  duplicateOperationIds: Set<string>;
  legacyIdToOperationId: Map<string, string>;
  ambiguousLegacyIds: Set<string>;
}

export function buildOutboxDependencyIndex(entries: OutboxEntry[]): OutboxDependencyIndex {
  const byRecordId = new Map<string, OutboxEntry[]>();
  const byOperationId = new Map<string, OutboxEntry[]>();
  const duplicateOperationIds = new Set<string>();
  const legacyIdToOperationId = new Map<string, string>();
  const ambiguousLegacyIds = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const recId = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (recId) {
      const list = byRecordId.get(recId) || [];
      list.push(entry);
      byRecordId.set(recId, list);
    }
    const opId = getCanonicalOutboxOperationId(entry);
    if (opId) {
      const list = byOperationId.get(opId) || [];
      list.push(entry);
      byOperationId.set(opId, list);
    }
  }

  for (const [opId, list] of byOperationId.entries()) {
    if (list.length > 1) {
      duplicateOperationIds.add(opId);
    }
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const recId = typeof entry.id === 'string' ? entry.id.trim() : '';
    const opId = getCanonicalOutboxOperationId(entry);
    if (!recId || !opId || recId === opId) continue;

    // Explicit legacy compatibility mapping only succeeds if unambiguous:
    // 1. recId must identify strictly 1 record
    // 2. recId must not collide with any entry's canonical operationId
    // 3. resolved canonical opId must itself be unique
    const recMatches = byRecordId.get(recId) || [];
    const conflictingOpMatches = byOperationId.get(recId) || [];
    if (recMatches.length === 1 && conflictingOpMatches.length === 0 && !duplicateOperationIds.has(opId)) {
      legacyIdToOperationId.set(recId, opId);
    } else {
      ambiguousLegacyIds.add(recId);
    }
  }

  return {
    byRecordId,
    byOperationId,
    duplicateOperationIds,
    legacyIdToOperationId,
    ambiguousLegacyIds
  };
}

/**
 * F4-A R3 Hardening: Validates outbox entry dependency integrity before purchase invoice processing.
 * Enforces Fail-Closed + Record Preservation:
 * - If dependsOn is undefined, it is valid (legacy entry).
 * - If dependsOn is defined, it MUST be a valid Array.
 * - Every element must be a non-empty string operationId.
 * - No duplicates within dependsOn array.
 * - No self-dependencies.
 * - Every dependency must exist and be unambiguous.
 */
export function validateOutboxRecordDependencies(
  entry: OutboxEntry,
  depIndex: OutboxDependencyIndex
): void {
  const entryOpId = getCanonicalOutboxOperationId(entry);
  if (!entryOpId) {
    throw new Error(`OUTBOX_DEPENDENCY_CORRUPT: سجل Outbox "${entry.id}" يفتقر إلى operationId صالح`);
  }
  if (depIndex.duplicateOperationIds.has(entryOpId)) {
    throw new Error(`OUTBOX_DEPENDENCY_CORRUPT: تعارض تكرار operationId (${entryOpId}) في سجلات Outbox`);
  }

  if (entry.dependsOn === undefined) {
    return;
  }

  if (!Array.isArray(entry.dependsOn)) {
    throw new Error(
      `OUTBOX_DEPENDENCY_CORRUPT: حقل dependsOn للسجل "${entry.id}" ليس مصفوفة صالحة (${typeof entry.dependsOn})`
    );
  }

  const seenInArray = new Set<string>();
  for (const rawDep of entry.dependsOn) {
    if (typeof rawDep !== 'string' || !rawDep.trim()) {
      throw new Error(`OUTBOX_DEPENDENCY_CORRUPT: عنصر اعتمادية غير صالح في سجل Outbox "${entry.id}"`);
    }
    const dep = rawDep.trim();
    if (seenInArray.has(dep)) {
      throw new Error(`OUTBOX_DEPENDENCY_CORRUPT: تكرار معرف اعتمادية (${dep}) داخل dependsOn للسجل "${entry.id}"`);
    }
    seenInArray.add(dep);

    if (dep === entryOpId || dep === entry.id) {
      throw new Error(`OUTBOX_DEPENDENCY_CORRUPT: سجل Outbox "${entry.id}" يحتوي على اعتمادية ذاتية (${dep})`);
    }

    const opMatches = depIndex.byOperationId.get(dep) || [];
    const recMatches = depIndex.byRecordId.get(dep) || [];
    if (opMatches.length === 0 && recMatches.length === 0) {
      throw new Error(`OUTBOX_DEPENDENCY_CORRUPT: مرجع الاعتمادية "${dep}" في سجل Outbox "${entry.id}" غير موجود`);
    }
    if (depIndex.duplicateOperationIds.has(dep) || depIndex.ambiguousLegacyIds.has(dep)) {
      throw new Error(`OUTBOX_DEPENDENCY_CORRUPT: مرجع الاعتمادية "${dep}" في سجل Outbox "${entry.id}" ملتبس أو مكرر`);
    }

    for (const parent of [...opMatches, ...recMatches]) {
      if (parent.dependsOn !== undefined && !Array.isArray(parent.dependsOn)) {
        throw new Error(
          `OUTBOX_DEPENDENCY_CORRUPT: حقل dependsOn للسجل الأب "${parent.id}" ليس مصفوفة صالحة`
        );
      }
    }
  }
}

function normalizeDependsOnArray(rawDependsOn: unknown, depIndex?: OutboxDependencyIndex): string[] {
  if (!Array.isArray(rawDependsOn)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawRef of rawDependsOn) {
    if (typeof rawRef !== 'string') continue;
    const trimmed = rawRef.trim();
    if (!trimmed) continue;
    const mapped =
      depIndex && !depIndex.ambiguousLegacyIds.has(trimmed) && !depIndex.byOperationId.has(trimmed)
        ? depIndex.legacyIdToOperationId.get(trimmed) || trimmed
        : trimmed;
    if (!seen.has(mapped)) {
      seen.add(mapped);
      out.push(mapped);
    }
  }
  return out;
}

export function normalizeOutboxEntry(raw: OutboxEntry, contextEntries?: OutboxEntry[]): OutboxEntry {
  const numericRetry = Number(raw.retryCount);
  const attempts =
    typeof raw.attempts === 'number' && Number.isFinite(raw.attempts) && raw.attempts >= 0
      ? raw.attempts
      : Number.isFinite(numericRetry) && numericRetry >= 0
      ? numericRetry
      : 0;
  const retryCount =
    Number.isFinite(numericRetry) && numericRetry >= 0 ? numericRetry : attempts;

  const canonicalOpId = getCanonicalOutboxOperationId(raw);
  const normalized: OutboxEntry = {
    ...raw,
    operationId: canonicalOpId || raw.id,
    idempotencyKey:
      typeof raw.idempotencyKey === 'string' && raw.idempotencyKey.trim()
        ? raw.idempotencyKey
        : `${raw.entityType}:${raw.action}:${raw.entityId}`,
    schemaVersion:
      typeof raw.schemaVersion === 'number' && Number.isFinite(raw.schemaVersion)
        ? raw.schemaVersion
        : 1,
    attempts,
    retryCount
  };

  if (Array.isArray(raw.dependsOn)) {
    const depIndex = Array.isArray(contextEntries) ? buildOutboxDependencyIndex(contextEntries) : undefined;
    normalized.dependsOn = normalizeDependsOnArray(raw.dependsOn, depIndex);
  }

  if (typeof raw.branchId === 'string' && raw.branchId.trim()) {
    normalized.branchId = raw.branchId.trim();
  } else {
    delete normalized.branchId;
  }

  if (isValidFirebaseActorUid(raw.actorUid)) {
    normalized.actorUid = raw.actorUid;
  } else {
    delete normalized.actorUid;
  }

  return normalized;
}

export interface OutboxDependencyEvaluation {
  eligible: boolean;
  failureKind?:
    | 'DUPLICATE_OPERATION_ID'
    | 'INVALID_DEPENDENCY'
    | 'MISSING_DEPENDENCY'
    | 'AMBIGUOUS_DEPENDENCY'
    | 'SELF_DEPENDENCY'
    | 'DEPENDENCY_CYCLE'
    | 'PARENT_DEAD_LETTER'
    | 'PARENT_BLOCKED'
    | 'PARENT_FAILED'
    | 'PARENT_NOT_READY';
  terminalBlock: boolean;
  reasonCode?: AcquireOutboxLeaseResult['reason'];
  message?: string;
  resolvedParentOperationIds: string[];
  blockingDependencies: string[];
  normalizedDependsOn?: string[];
}

export function evaluateOutboxDependencies(
  target: OutboxEntry,
  allEntries: OutboxEntry[]
): OutboxDependencyEvaluation {
  const index = buildOutboxDependencyIndex(allEntries);
  const targetOpId = getCanonicalOutboxOperationId(target);

  if (!targetOpId) {
    return {
      eligible: false,
      failureKind: 'INVALID_DEPENDENCY',
      terminalBlock: true,
      reasonCode: 'INVALID_INPUT',
      message: `BLOCKED_INVALID_OPERATION_ID: Outbox entry "${target.id}" has empty operationId`,
      resolvedParentOperationIds: [],
      blockingDependencies: [target.id]
    };
  }

  if (index.duplicateOperationIds.has(targetOpId)) {
    return {
      eligible: false,
      failureKind: 'DUPLICATE_OPERATION_ID',
      terminalBlock: true,
      reasonCode: 'DUPLICATE_OPERATION_ID',
      message: `BLOCKED_DUPLICATE_OPERATION_ID: Multiple outbox records share canonical operationId "${targetOpId}"`,
      resolvedParentOperationIds: [],
      blockingDependencies: [targetOpId]
    };
  }

  const rawDeps = target.dependsOn;
  if (rawDeps === undefined || (Array.isArray(rawDeps) && rawDeps.length === 0)) {
    return {
      eligible: true,
      terminalBlock: false,
      resolvedParentOperationIds: [],
      blockingDependencies: [],
      ...(Array.isArray(rawDeps) ? { normalizedDependsOn: [] } : {})
    };
  }

  if (!Array.isArray(rawDeps)) {
    return {
      eligible: false,
      failureKind: 'INVALID_DEPENDENCY',
      terminalBlock: true,
      reasonCode: 'DEPENDENCY_AMBIGUOUS',
      message: `BLOCKED_INVALID_DEPENDENCY: dependsOn must be an array on operation "${targetOpId}"`,
      resolvedParentOperationIds: [],
      blockingDependencies: [targetOpId]
    };
  }

  type ResolveResult =
    | { ok: true; parent: OutboxEntry; canonicalOpId: string; rawRef: string }
    | {
        ok: false;
        failureKind: 'INVALID_DEPENDENCY' | 'MISSING_DEPENDENCY' | 'AMBIGUOUS_DEPENDENCY' | 'DUPLICATE_OPERATION_ID';
        reasonCode: AcquireOutboxLeaseResult['reason'];
        message: string;
        ref: string;
      };

  const resolveRef = (rawRef: unknown): ResolveResult => {
    if (typeof rawRef !== 'string' || rawRef.trim().length === 0) {
      return {
        ok: false,
        failureKind: 'INVALID_DEPENDENCY',
        reasonCode: 'DEPENDENCY_AMBIGUOUS',
        message: `BLOCKED_INVALID_DEPENDENCY: Empty or non-string dependency identifier on "${targetOpId}"`,
        ref: String(rawRef)
      };
    }
    const ref = rawRef.trim();
    const opMatches = index.byOperationId.get(ref) || [];
    const legacyMatches = (index.byRecordId.get(ref) || []).filter(
      (e) => getCanonicalOutboxOperationId(e) !== ref
    );

    if (opMatches.length > 1) {
      return {
        ok: false,
        failureKind: 'DUPLICATE_OPERATION_ID',
        reasonCode: 'DUPLICATE_OPERATION_ID',
        message: `BLOCKED_DUPLICATE_OPERATION_ID: Dependency "${ref}" matches ${opMatches.length} records with duplicate operationId`,
        ref
      };
    }
    if (opMatches.length === 1 && legacyMatches.length > 0) {
      return {
        ok: false,
        failureKind: 'AMBIGUOUS_DEPENDENCY',
        reasonCode: 'DEPENDENCY_AMBIGUOUS',
        message: `BLOCKED_AMBIGUOUS_DEPENDENCY: Dependency "${ref}" matches both a canonical operationId and a distinct legacy record id`,
        ref
      };
    }
    if (opMatches.length === 0 && legacyMatches.length > 1) {
      return {
        ok: false,
        failureKind: 'AMBIGUOUS_DEPENDENCY',
        reasonCode: 'DEPENDENCY_AMBIGUOUS',
        message: `BLOCKED_AMBIGUOUS_DEPENDENCY: Legacy dependency "${ref}" matches multiple records`,
        ref
      };
    }
    if (opMatches.length === 0 && legacyMatches.length === 0) {
      return {
        ok: false,
        failureKind: 'MISSING_DEPENDENCY',
        reasonCode: 'DEPENDENCY_MISSING',
        message: `BLOCKED_MISSING_DEPENDENCY: Parent dependency "${ref}" not found in outbox`,
        ref
      };
    }
    if (opMatches.length === 0 && legacyMatches.length === 1) {
      const legacyTarget = legacyMatches[0];
      const canonicalOpId = getCanonicalOutboxOperationId(legacyTarget);
      if (!canonicalOpId || index.duplicateOperationIds.has(canonicalOpId)) {
        return {
          ok: false,
          failureKind: 'DUPLICATE_OPERATION_ID',
          reasonCode: 'DUPLICATE_OPERATION_ID',
          message: `BLOCKED_DUPLICATE_OPERATION_ID: Legacy dependency "${ref}" maps to duplicate/invalid canonical operationId "${canonicalOpId}"`,
          ref
        };
      }
      return { ok: true, parent: legacyTarget, canonicalOpId, rawRef: ref };
    }

    // opMatches.length === 1 && legacyMatches.length === 0
    return { ok: true, parent: opMatches[0], canonicalOpId: ref, rawRef: ref };
  };

  // 1. Validate direct dependencies resolve unambiguously and check self-dependency
  const directParents: Array<{ parent: OutboxEntry; canonicalOpId: string }> = [];
  const normalizedDeps: string[] = [];
  const seenNormalized = new Set<string>();

  for (const rawRef of rawDeps) {
    const res = resolveRef(rawRef);
    if (!res.ok) {
      return {
        eligible: false,
        failureKind: res.failureKind,
        terminalBlock: true,
        reasonCode: res.reasonCode,
        message: res.message,
        resolvedParentOperationIds: [],
        blockingDependencies: [res.ref]
      };
    }
    if (res.parent.id === target.id || res.canonicalOpId === targetOpId) {
      return {
        eligible: false,
        failureKind: 'SELF_DEPENDENCY',
        terminalBlock: true,
        reasonCode: 'SELF_DEPENDENCY',
        message: `BLOCKED_SELF_DEPENDENCY: Operation "${targetOpId}" cannot depend on itself`,
        resolvedParentOperationIds: [],
        blockingDependencies: [res.canonicalOpId]
      };
    }
    if (!seenNormalized.has(res.canonicalOpId)) {
      seenNormalized.add(res.canonicalOpId);
      normalizedDeps.push(res.canonicalOpId);
      directParents.push({ parent: res.parent, canonicalOpId: res.canonicalOpId });
    }
  }

  // 2. Transitive graph validation: detect multi-level cycles and broken transitive mappings
  const visiting = new Set<string>([target.id]);
  const visited = new Set<string>();
  const transitiveAncestors: Array<{ parent: OutboxEntry; canonicalOpId: string }> = [];

  const dfs = (node: OutboxEntry): OutboxDependencyEvaluation | null => {
    if (!Array.isArray(node.dependsOn) || node.dependsOn.length === 0) {
      return null;
    }
    const nodeOpId = getCanonicalOutboxOperationId(node);
    for (const rawRef of node.dependsOn) {
      const res = resolveRef(rawRef);
      if (!res.ok) {
        return {
          eligible: false,
          failureKind: res.failureKind,
          terminalBlock: true,
          reasonCode: res.reasonCode,
          message: res.message,
          resolvedParentOperationIds: normalizedDeps,
          blockingDependencies: [res.ref]
        };
      }
      if (res.parent.id === node.id || res.canonicalOpId === nodeOpId) {
        return {
          eligible: false,
          failureKind: res.parent.id === target.id ? 'SELF_DEPENDENCY' : 'DEPENDENCY_CYCLE',
          terminalBlock: true,
          reasonCode: res.parent.id === target.id ? 'SELF_DEPENDENCY' : 'DEPENDENCY_CYCLE',
          message: `BLOCKED_DEPENDENCY_CYCLE: Self-referential cycle at "${res.canonicalOpId}"`,
          resolvedParentOperationIds: normalizedDeps,
          blockingDependencies: [res.canonicalOpId]
        };
      }
      if (visiting.has(res.parent.id)) {
        return {
          eligible: false,
          failureKind: 'DEPENDENCY_CYCLE',
          terminalBlock: true,
          reasonCode: 'DEPENDENCY_CYCLE',
          message: `BLOCKED_DEPENDENCY_CYCLE: Circular dependency detected involving "${res.canonicalOpId}"`,
          resolvedParentOperationIds: normalizedDeps,
          blockingDependencies: [res.canonicalOpId]
        };
      }
      if (!visited.has(res.parent.id)) {
        visiting.add(res.parent.id);
        transitiveAncestors.push({ parent: res.parent, canonicalOpId: res.canonicalOpId });
        const subErr = dfs(res.parent);
        visiting.delete(res.parent.id);
        visited.add(res.parent.id);
        if (subErr) return subErr;
      }
    }
    return null;
  };

  const graphError = dfs(target);
  if (graphError) {
    return graphError;
  }

  // 3. Evaluate parent statuses: terminal/failure parent states take precedence and preserve failure reason
  const describeParentFailure = (p: OutboxEntry, opId: string): string => {
    const details = [p.blockReason, p.lastErrorCode, p.lastErrorMessage].filter(
      (v): v is string => typeof v === 'string' && v.trim().length > 0
    );
    return details.length > 0 ? `${opId} (${details.join(': ')})` : opId;
  };

  const deadLetterParent = directParents.find((d) => d.parent.status === 'dead-letter');
  if (deadLetterParent) {
    const desc = describeParentFailure(deadLetterParent.parent, deadLetterParent.canonicalOpId);
    return {
      eligible: false,
      failureKind: 'PARENT_DEAD_LETTER',
      terminalBlock: true,
      reasonCode: 'DEPENDENCY_DEAD_LETTER',
      message: `DEPENDENCY_DEAD_LETTER: Parent ${desc}`,
      resolvedParentOperationIds: normalizedDeps,
      blockingDependencies: [deadLetterParent.canonicalOpId],
      normalizedDependsOn: normalizedDeps
    };
  }

  const blockedParent = directParents.find((d) => d.parent.status === 'blocked');
  if (blockedParent) {
    const desc = describeParentFailure(blockedParent.parent, blockedParent.canonicalOpId);
    return {
      eligible: false,
      failureKind: 'PARENT_BLOCKED',
      terminalBlock: true,
      reasonCode: 'DEPENDENCY_BLOCKED',
      message: `DEPENDENCY_BLOCKED: Parent ${desc}`,
      resolvedParentOperationIds: normalizedDeps,
      blockingDependencies: [blockedParent.canonicalOpId],
      normalizedDependsOn: normalizedDeps
    };
  }

  const failedParent = directParents.find((d) => d.parent.status === 'failed');
  if (failedParent) {
    const desc = describeParentFailure(failedParent.parent, failedParent.canonicalOpId);
    return {
      eligible: false,
      failureKind: 'PARENT_FAILED',
      terminalBlock: true,
      reasonCode: 'DEPENDENCY_FAILED',
      message: `DEPENDENCY_FAILED: Parent ${desc}`,
      resolvedParentOperationIds: normalizedDeps,
      blockingDependencies: [failedParent.canonicalOpId],
      normalizedDependsOn: normalizedDeps
    };
  }

  const notSyncedDirect = directParents.filter((d) => d.parent.status !== 'synced');
  if (notSyncedDirect.length > 0) {
    return {
      eligible: false,
      failureKind: 'PARENT_NOT_READY',
      terminalBlock: false,
      reasonCode: 'DEPENDENCY_NOT_READY',
      message: `Waiting on unsynced parent dependencies: ${notSyncedDirect
        .map((d) => `${d.canonicalOpId}[${d.parent.status}]`)
        .join(', ')}`,
      resolvedParentOperationIds: normalizedDeps,
      blockingDependencies: notSyncedDirect.map((d) => d.canonicalOpId),
      normalizedDependsOn: normalizedDeps
    };
  }

  // Transitive safety check in case a direct parent was forced 'synced' while an ancestor failed/un-synced
  const deadAncestor = transitiveAncestors.find((a) => a.parent.status === 'dead-letter');
  if (deadAncestor) {
    return {
      eligible: false,
      failureKind: 'PARENT_DEAD_LETTER',
      terminalBlock: true,
      reasonCode: 'DEPENDENCY_DEAD_LETTER',
      message: `DEPENDENCY_DEAD_LETTER: Ancestor ${describeParentFailure(deadAncestor.parent, deadAncestor.canonicalOpId)}`,
      resolvedParentOperationIds: normalizedDeps,
      blockingDependencies: [deadAncestor.canonicalOpId],
      normalizedDependsOn: normalizedDeps
    };
  }
  const blockedAncestor = transitiveAncestors.find((a) => a.parent.status === 'blocked');
  if (blockedAncestor) {
    return {
      eligible: false,
      failureKind: 'PARENT_BLOCKED',
      terminalBlock: true,
      reasonCode: 'DEPENDENCY_BLOCKED',
      message: `DEPENDENCY_BLOCKED: Ancestor ${describeParentFailure(blockedAncestor.parent, blockedAncestor.canonicalOpId)}`,
      resolvedParentOperationIds: normalizedDeps,
      blockingDependencies: [blockedAncestor.canonicalOpId],
      normalizedDependsOn: normalizedDeps
    };
  }
  const failedAncestor = transitiveAncestors.find((a) => a.parent.status === 'failed');
  if (failedAncestor) {
    return {
      eligible: false,
      failureKind: 'PARENT_FAILED',
      terminalBlock: true,
      reasonCode: 'DEPENDENCY_FAILED',
      message: `DEPENDENCY_FAILED: Ancestor ${describeParentFailure(failedAncestor.parent, failedAncestor.canonicalOpId)}`,
      resolvedParentOperationIds: normalizedDeps,
      blockingDependencies: [failedAncestor.canonicalOpId],
      normalizedDependsOn: normalizedDeps
    };
  }
  const unsyncedAncestors = transitiveAncestors.filter((a) => a.parent.status !== 'synced');
  if (unsyncedAncestors.length > 0) {
    return {
      eligible: false,
      failureKind: 'PARENT_NOT_READY',
      terminalBlock: false,
      reasonCode: 'DEPENDENCY_NOT_READY',
      message: `Waiting on unsynced ancestor dependencies: ${unsyncedAncestors
        .map((a) => `${a.canonicalOpId}[${a.parent.status}]`)
        .join(', ')}`,
      resolvedParentOperationIds: normalizedDeps,
      blockingDependencies: unsyncedAncestors.map((a) => a.canonicalOpId),
      normalizedDependsOn: normalizedDeps
    };
  }

  return {
    eligible: true,
    terminalBlock: false,
    resolvedParentOperationIds: normalizedDeps,
    blockingDependencies: [],
    normalizedDependsOn: normalizedDeps
  };
}


export async function getOutboxQueue(): Promise<OutboxEntry[]> {
  const db = await openPharmacyDB();
  if (!db.objectStoreNames.contains('outbox')) {
    return [];
  }
  return new Promise((resolve) => {
    const tx = db.transaction('outbox', 'readonly');
    const req = tx.objectStore('outbox').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

/**
 * Safe read-only UI counter exposing only the count of unsynced outbox items
 * without exposing raw Outbox records, actor IDs, idempotency keys, or payloads.
 */
export async function getOutboxPendingCount(): Promise<number> {
  const db = await openPharmacyDB();
  if (!db.objectStoreNames.contains('outbox')) {
    return 0;
  }
  return new Promise((resolve) => {
    const tx = db.transaction('outbox', 'readonly');
    const req = tx.objectStore('outbox').getAll();
    req.onsuccess = () => {
      const entries = (req.result as OutboxEntry[]) || [];
      resolve(entries.filter((e) => e && e.status !== 'synced').length);
    };
    req.onerror = () => resolve(0);
  });
}

function isValidOutboxBranchId(branchId: unknown): branchId is string {
  return typeof branchId === 'string' && /^[a-zA-Z0-9_-]+$/.test(branchId.trim());
}

export function validateRemoteWriteCompletionEvidence(
  evidence: RemoteWriteCompletionEvidence | undefined | null,
  entry: OutboxEntry,
  expectedProjectId: string = DEFAULT_FIREBASE_PROJECT_ID,
  expectedFirestoreDatabaseId: string = DEFAULT_FIRESTORE_DATABASE_ID,
  expectedRuntimeActorUid?: string
): {
  valid: boolean;
  reason?: 'REMOTE_COMMIT_EVIDENCE_REQUIRED' | 'INVALID_REMOTE_ACK_EVIDENCE';
  message?: string;
  canonicalTarget?: RemoteAckTarget;
} {
  if (evidence === undefined || evidence === null) {
    return {
      valid: false,
      reason: 'REMOTE_COMMIT_EVIDENCE_REQUIRED',
      message: 'Remote write completion evidence is required before marking an outbox operation synced'
    };
  }
  if (typeof evidence !== 'object' || Array.isArray(evidence)) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: 'Remote write completion evidence must be an explicit evidence object'
    };
  }
  if (!sealedRemoteWriteEvidenceRegistry.has(evidence as object)) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: 'Remote write completion evidence must be issued by an internal sealed sync worker'
    };
  }

  const validKinds = new Set(['firestore_batch_commit', 'firestore_doc_write', 'firestore_server_get']);
  if (!validKinds.has(evidence.evidenceKind)) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: `Unsupported evidenceKind "${String((evidence as any).evidenceKind)}"`
    };
  }
  if (typeof evidence.clientAttemptId !== 'string' || evidence.clientAttemptId.trim().length === 0) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: 'Remote write completion evidence requires a non-empty clientAttemptId'
    };
  }
  if (!isValidFirebaseActorUid(evidence.actorUid)) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: 'Remote write completion evidence contains an invalid or placeholder actorUid'
    };
  }
  if (!isValidFirebaseActorUid(entry.actorUid) || evidence.actorUid !== entry.actorUid) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: 'Remote write completion evidence actorUid does not match a valid outbox entry actorUid'
    };
  }
  if (expectedRuntimeActorUid !== undefined && evidence.actorUid !== expectedRuntimeActorUid) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: 'Remote write completion evidence actorUid does not match active runtime actorUid'
    };
  }

  const entryBranchId = typeof entry.branchId === 'string' ? entry.branchId.trim() : '';
  if (!isValidOutboxBranchId(entryBranchId)) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: 'Outbox entry lacks a valid branchId for remote write verification'
    };
  }

  if (typeof evidence.projectId !== 'string' || evidence.projectId.trim() !== expectedProjectId.trim()) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: `Project mismatch in remote evidence (expected ${expectedProjectId}, got ${String(evidence.projectId)})`
    };
  }
  if (
    normalizeFirestoreDatabaseId(evidence.firestoreDatabaseId) !==
    normalizeFirestoreDatabaseId(expectedFirestoreDatabaseId)
  ) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: 'Firestore databaseId mismatch in remote evidence'
    };
  }
  if (typeof evidence.branchId !== 'string' || evidence.branchId.trim() !== entryBranchId) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: 'Branch mismatch in remote evidence'
    };
  }
  if (evidence.entityType !== entry.entityType || evidence.entityId !== entry.entityId) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: 'Entity type/id mismatch in remote evidence'
    };
  }

  let canonicalPath: string;
  try {
    const parentIds =
      entry.entityType === 'stocktaking_session_item' &&
      typeof entry.payload?.sessionId === 'string'
        ? { sessionId: entry.payload.sessionId }
        : undefined;
    canonicalPath = buildCanonicalFirestoreDocumentPath(entryBranchId, entry.entityType, entry.entityId, parentIds);
  } catch (err: any) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: err instanceof Error ? err.message : 'Invalid canonical Firestore target'
    };
  }

  if (evidence.documentPath !== canonicalPath) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: `Document path mismatch (expected ${canonicalPath}, got ${String(evidence.documentPath)})`
    };
  }

  if (typeof evidence.completedAt !== 'string' || !Number.isFinite(Date.parse(evidence.completedAt))) {
    return {
      valid: false,
      reason: 'INVALID_REMOTE_ACK_EVIDENCE',
      message: 'Remote write completion evidence requires a valid ISO completedAt timestamp'
    };
  }

  const canonicalTarget: RemoteAckTarget = {
    evidenceKind: evidence.evidenceKind,
    projectId: expectedProjectId.trim(),
    firestoreDatabaseId: normalizeFirestoreDatabaseId(expectedFirestoreDatabaseId),
    branchId: entryBranchId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    documentPath: canonicalPath,
    completedAt: evidence.completedAt,
    actorUid: evidence.actorUid,
    clientAttemptId: evidence.clientAttemptId.trim()
  };

  return { valid: true, canonicalTarget };
}

interface RequiredRemoteParentCheck {
  key: string;
  entityType: OutboxEntityType;
  entityId: string;
  sessionId?: string;
  documentPath: string;
  reasons: Set<'REMOTE_PARENT_EXISTENCE' | 'PARENT_NOT_ARCHIVED' | 'PARENT_CURRENT_STATE'>;
  syncedParentOutbox?: OutboxEntry;
}

function extractRequiredRemoteParents(
  entry: OutboxEntry,
  allEntries: OutboxEntry[],
  resolvedParentOpIds: string[],
  entryBranchId: string
): {
  ok: true;
  parents: RequiredRemoteParentCheck[];
} | {
  ok: false;
  reason: 'REMOTE_PARENT_BRANCH_UNPROVEN' | 'REMOTE_PARENT_EXISTENCE_UNPROVEN';
  message: string;
} {
  const byOpId = new Map<string, OutboxEntry>();
  for (const e of allEntries) {
    if (!e || typeof e !== 'object') continue;
    const opId = getCanonicalOutboxOperationId(e);
    if (opId) byOpId.set(opId, e);
  }

  const parentMap = new Map<string, RequiredRemoteParentCheck>();
  const addParent = (
    entityType: OutboxEntityType,
    entityId: string,
    reasons: Array<'REMOTE_PARENT_EXISTENCE' | 'PARENT_NOT_ARCHIVED' | 'PARENT_CURRENT_STATE'>,
    syncedParentOutbox?: OutboxEntry,
    parentIds?: { sessionId?: string }
  ): string | null => {
    try {
      const documentPath = buildCanonicalFirestoreDocumentPath(entryBranchId, entityType, entityId, parentIds);
      const mapKey =
        entityType === 'stocktaking_session_item' && parentIds?.sessionId
          ? `${entityType}:${parentIds.sessionId.trim()}:${entityId.trim()}`
          : `${entityType}:${entityId.trim()}`;
      const existingCheck = parentMap.get(mapKey);
      if (existingCheck) {
        for (const r of reasons) existingCheck.reasons.add(r);
        if (syncedParentOutbox && !existingCheck.syncedParentOutbox) {
          existingCheck.syncedParentOutbox = syncedParentOutbox;
        }
      } else {
        parentMap.set(mapKey, {
          key: mapKey,
          entityType,
          entityId: entityId.trim(),
          ...(parentIds?.sessionId ? { sessionId: parentIds.sessionId.trim() } : {}),
          documentPath,
          reasons: new Set(reasons),
          ...(syncedParentOutbox ? { syncedParentOutbox } : {})
        });
      }
      return null;
    } catch (err: any) {
      return err instanceof Error ? err.message : 'INVALID_PARENT_TARGET';
    }
  };

  const isSupplierArchiveUpdate =
    entry.entityType === 'supplier' &&
    entry.action === 'UPDATE' &&
    (entry.payload?.archived === true || entry.payload?.status === 'archived');

  const deletedDepTargetKeys = new Set<string>();
  for (const opId of resolvedParentOpIds) {
    const parent = byOpId.get(opId);
    if (parent && parent.action === 'DELETE') {
      const pKey =
        parent.entityType === 'stocktaking_session_item' && typeof parent.payload?.sessionId === 'string'
          ? `${parent.entityType}:${parent.payload.sessionId.trim()}:${String(parent.entityId || '').trim()}`
          : `${parent.entityType}:${String(parent.entityId || '').trim()}`;
      deletedDepTargetKeys.add(pKey);
    }
  }

  for (const opId of resolvedParentOpIds) {
    const parent = byOpId.get(opId);
    if (!parent) {
      return {
        ok: false,
        reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN',
        message: `Missing parent operation "${opId}" during remote parent resolution`
      };
    }
    const parentBranch = typeof parent.branchId === 'string' ? parent.branchId.trim() : '';
    if (!isValidOutboxBranchId(parentBranch) || parentBranch !== entryBranchId) {
      return {
        ok: false,
        reason: 'REMOTE_PARENT_BRANCH_UNPROVEN',
        message: `Parent operation "${opId}" lacks matching branch context (${parentBranch || 'missing'} vs ${entryBranchId})`
      };
    }

    const parentTargetKey =
      parent.entityType === 'stocktaking_session_item' && typeof parent.payload?.sessionId === 'string'
        ? `${parent.entityType}:${parent.payload.sessionId.trim()}:${String(parent.entityId || '').trim()}`
        : `${parent.entityType}:${String(parent.entityId || '').trim()}`;
    if (parent.action === 'DELETE' || deletedDepTargetKeys.has(parentTargetKey)) {
      continue;
    }

    const reqReasons: Array<'REMOTE_PARENT_EXISTENCE' | 'PARENT_NOT_ARCHIVED'> = ['REMOTE_PARENT_EXISTENCE'];
    if ((parent.entityType === 'medicine' || parent.entityType === 'supplier') && !isSupplierArchiveUpdate) {
      reqReasons.push('PARENT_NOT_ARCHIVED');
    }
    const parentIds =
      parent.entityType === 'stocktaking_session_item' && typeof parent.payload?.sessionId === 'string'
        ? { sessionId: parent.payload.sessionId }
        : undefined;
    const pathErr = addParent(parent.entityType, parent.entityId, reqReasons, parent, parentIds);
    if (pathErr) {
      return {
        ok: false,
        reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN',
        message: pathErr
      };
    }
  }

  // Structural remote parents independent of dependsOn
  if (entry.entityType === 'inventory_ledger') {
    const medId = typeof entry.payload?.medicineId === 'string' ? entry.payload.medicineId.trim() : '';
    if (!medId) {
      return {
        ok: false,
        reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN',
        message: 'REMOTE_PARENT_EXISTENCE_UNPROVEN: inventory_ledger entry lacks medicineId in payload'
      };
    }
    const err = addParent('medicine', medId, ['REMOTE_PARENT_EXISTENCE', 'PARENT_NOT_ARCHIVED']);
    if (err) {
      return { ok: false, reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN', message: err };
    }
  } else if (entry.entityType === 'purchase_invoice') {
    const supId = typeof entry.payload?.supplierId === 'string' ? entry.payload.supplierId.trim() : '';
    if (!supId) {
      return {
        ok: false,
        reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN',
        message: 'REMOTE_PARENT_EXISTENCE_UNPROVEN: purchase_invoice entry lacks supplierId in payload'
      };
    }
    const err = addParent('supplier', supId, ['REMOTE_PARENT_EXISTENCE', 'PARENT_NOT_ARCHIVED']);
    if (err) {
      return { ok: false, reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN', message: err };
    }
  } else if (entry.entityType === 'supplier_transaction') {
    const supId = typeof entry.payload?.supplierId === 'string' ? entry.payload.supplierId.trim() : '';
    if (!supId) {
      return {
        ok: false,
        reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN',
        message: 'REMOTE_PARENT_EXISTENCE_UNPROVEN: supplier_transaction entry lacks supplierId in payload'
      };
    }
    const err = addParent('supplier', supId, ['REMOTE_PARENT_EXISTENCE', 'PARENT_NOT_ARCHIVED']);
    if (err) {
      return { ok: false, reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN', message: err };
    }
    if (entry.payload?.type === 'PURCHASE_INVOICE' && typeof entry.payload?.referenceId === 'string' && entry.payload.referenceId.trim()) {
      const errInv = addParent('purchase_invoice', entry.payload.referenceId.trim(), ['REMOTE_PARENT_EXISTENCE']);
      if (errInv) {
        return { ok: false, reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN', message: errInv };
      }
    }
  } else if (entry.entityType === 'stocktaking_session_item') {
    const sessId = typeof entry.payload?.sessionId === 'string' ? entry.payload.sessionId.trim() : '';
    if (!sessId) {
      return {
        ok: false,
        reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN',
        message: 'REMOTE_PARENT_EXISTENCE_UNPROVEN: stocktaking_session_item entry lacks sessionId in payload'
      };
    }
    const errSess = addParent('stocktaking_session', sessId, ['REMOTE_PARENT_EXISTENCE', 'PARENT_CURRENT_STATE']);
    if (errSess) {
      return { ok: false, reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN', message: errSess };
    }
    if (entry.action !== 'DELETE') {
      const medId = typeof entry.payload?.medicineId === 'string' ? entry.payload.medicineId.trim() : '';
      if (!medId) {
        return {
          ok: false,
          reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN',
          message: 'REMOTE_PARENT_EXISTENCE_UNPROVEN: stocktaking_session_item entry lacks medicineId in payload'
        };
      }
      const errMed = addParent('medicine', medId, ['REMOTE_PARENT_EXISTENCE', 'PARENT_NOT_ARCHIVED']);
      if (errMed) {
        return { ok: false, reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN', message: errMed };
      }
    }
  } else if (entry.entityType === 'stocktaking_session' && entry.action === 'UPDATE') {
    const err = addParent('stocktaking_session', entry.entityId, ['REMOTE_PARENT_EXISTENCE', 'PARENT_CURRENT_STATE']);
    if (err) {
      return { ok: false, reason: 'REMOTE_PARENT_EXISTENCE_UNPROVEN', message: err };
    }
  }

  return {
    ok: true,
    parents: Array.from(parentMap.values())
  };
}

function indexServerVerificationResults(
  raw: AcquireOutboxLeaseParams['serverVerificationResults']
): ServerDocVerificationResult[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((item): item is ServerDocVerificationResult => Boolean(item && typeof item === 'object'));
  }
  if (typeof raw === 'object') {
    return Object.values(raw).filter(
      (item): item is ServerDocVerificationResult => Boolean(item && typeof item === 'object')
    );
  }
  return [];
}

/**
 * Revalidates a legacy V1 outbox entry before queueing for cloud sync.
 * Under FirebaseAuthService authority, caller-supplied booleans are ignored in favor of
 * trustedAuthSession, existing originator actorUid is never overwritten, and legacy entries
 * lacking actorUid are quarantined without attribution to the current user in Phase 2D-3B-1.
 */
export async function revalidateLegacyOutboxEntry(
  params: RevalidateOutboxParams
): Promise<RevalidateOutboxResult> {
  const outboxId = typeof params?.outboxId === 'string' ? params.outboxId.trim() : '';
  const verifiedBranchId = typeof params?.verifiedBranchId === 'string' ? params.verifiedBranchId.trim() : '';
  const verifiedActorUid = params?.verifiedActorUid;

  if (!outboxId || !isValidOutboxBranchId(verifiedBranchId)) {
    return { revalidated: false, reason: 'INVALID_INPUT', entry: null };
  }
  const runtimeActorUid = getKnownActiveActorId();
  if (authAuthorityEnforced) {
    if (!trustedAuthSession || !isBranchAuthorizedForSession(trustedAuthSession, verifiedBranchId)) {
      return { revalidated: false, reason: 'MEMBERSHIP_REQUIRED', entry: null };
    }
    if (trustedAuthSession.offlineFallback) {
      return { revalidated: false, reason: 'PERMISSION_DENIED', entry: null };
    }
    if (
      !isValidFirebaseActorUid(verifiedActorUid) ||
      !runtimeActorUid ||
      verifiedActorUid !== runtimeActorUid ||
      trustedAuthSession.uid !== runtimeActorUid
    ) {
      return { revalidated: false, reason: 'INVALID_ACTOR_UID', entry: null };
    }
  } else {
    if (!params.userHasBranchMembership) {
      return { revalidated: false, reason: 'MEMBERSHIP_REQUIRED', entry: null };
    }
    if (params.userHasEntityWritePermission !== true) {
      return { revalidated: false, reason: 'PERMISSION_DENIED', entry: null };
    }
    if (!isValidFirebaseActorUid(verifiedActorUid) || !runtimeActorUid || verifiedActorUid !== runtimeActorUid) {
      return { revalidated: false, reason: 'INVALID_ACTOR_UID', entry: null };
    }
  }

  const db = params.db || (await openPharmacyDB());
  assertRequiredObjectStores(db, ['outbox']);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['outbox'], 'readwrite');
    const outboxStore = tx.objectStore('outbox');
    let result: RevalidateOutboxResult = { revalidated: false, reason: 'NOT_FOUND', entry: null };

    const allReq = outboxStore.getAll();
    allReq.onsuccess = () => {
      const allEntries = (allReq.result as OutboxEntry[]) || [];
      const existing = allEntries.find((e) => e && e.id === outboxId);
      if (!existing) {
        result = { revalidated: false, reason: 'NOT_FOUND', entry: null };
        return;
      }

      const normalized = normalizeOutboxEntry(existing, allEntries);

      if (existing.status === 'synced') {
        result = { revalidated: false, reason: 'ALREADY_SYNCED', entry: normalized };
        return;
      }
      if (existing.status === 'dead-letter') {
        result = { revalidated: false, reason: 'DEAD_LETTER', entry: normalized };
        return;
      }
      if (existing.branchId && existing.branchId.trim() !== verifiedBranchId) {
        result = { revalidated: false, reason: 'BRANCH_MISMATCH', entry: normalized };
        return;
      }
      if (typeof existing.actorUid === 'string' && existing.actorUid.trim().length > 0 && existing.actorUid !== verifiedActorUid) {
        result = { revalidated: false, reason: 'ACTOR_UID_MISMATCH', entry: normalized };
        return;
      }
      if (authAuthorityEnforced && !isValidFirebaseActorUid(existing.actorUid)) {
        result = {
          revalidated: false,
          reason: 'LEGACY_ACTOR_ATTRIBUTION_DISABLED_IN_3B1',
          entry: normalized
        };
        return;
      }

      // Validate canonical entity target and basic payload/business integrity
      if (!existing.entityType || typeof existing.entityId !== 'string' || !existing.entityId.trim()) {
        result = { revalidated: false, reason: 'INVALID_V2_STRUCTURE', entry: normalized };
        return;
      }
      try {
        const parentIds =
          existing.entityType === 'stocktaking_session_item' &&
          typeof existing.payload?.sessionId === 'string'
            ? { sessionId: existing.payload.sessionId }
            : undefined;
        buildCanonicalFirestoreDocumentPath(verifiedBranchId, existing.entityType, existing.entityId, parentIds);
      } catch {
        result = { revalidated: false, reason: 'INVALID_V2_STRUCTURE', entry: normalized };
        return;
      }

      if (existing.entityType === 'inventory_ledger') {
        const p = existing.payload || {};
        if (typeof p.medicineId !== 'string' || !p.medicineId.trim()) {
          result = { revalidated: false, reason: 'BUSINESS_RULE_VIOLATION', entry: normalized };
          return;
        }
        const delta = Number(p.baseUnitsDelta);
        if (!Number.isFinite(delta) || delta === 0) {
          result = { revalidated: false, reason: 'BUSINESS_RULE_VIOLATION', entry: normalized };
          return;
        }
      } else if (existing.entityType === 'purchase_invoice') {
        const p = existing.payload || {};
        if (typeof p.supplierId !== 'string' || !p.supplierId.trim()) {
          result = { revalidated: false, reason: 'BUSINESS_RULE_VIOLATION', entry: normalized };
          return;
        }
      } else if (existing.entityType === 'supplier_transaction') {
        const p = existing.payload || {};
        if (typeof p.supplierId !== 'string' || !p.supplierId.trim() || Number(p.amount) <= 0) {
          result = { revalidated: false, reason: 'BUSINESS_RULE_VIOLATION', entry: normalized };
          return;
        }
      }

      const depEval = evaluateOutboxDependencies(normalized, allEntries);
      if (!depEval.eligible && depEval.terminalBlock) {
        result = { revalidated: false, reason: 'DEPENDENCY_INVALID', entry: normalized };
        return;
      }

      const revalidatedEntry: OutboxEntry = {
        ...normalized,
        operationId: getCanonicalOutboxOperationId(existing) || existing.id,
        idempotencyKey:
          typeof existing.idempotencyKey === 'string' && existing.idempotencyKey.trim()
            ? existing.idempotencyKey.trim()
            : `${existing.entityType}:${existing.action}:${existing.entityId}`,
        schemaVersion:
          typeof existing.schemaVersion === 'number' && Number.isFinite(existing.schemaVersion)
            ? existing.schemaVersion
            : 1,
        branchId: verifiedBranchId,
        actorUid: verifiedActorUid
      };

      outboxStore.put(revalidatedEntry);
      result = {
        revalidated: true,
        entry: revalidatedEntry
      };
    };

    allReq.onerror = () => reject(allReq.error || new Error('Failed to load outbox entries for revalidation'));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Failed to revalidate legacy outbox entry'));
    tx.onabort = () => reject(tx.error || new Error('Revalidate legacy outbox transaction aborted'));
  });
}

export async function acquireOutboxLease(
  params: AcquireOutboxLeaseParams
): Promise<AcquireOutboxLeaseResult> {
  const outboxId = typeof params?.outboxId === 'string' ? params.outboxId.trim() : '';
  const leaseOwner = typeof params?.leaseOwner === 'string' ? params.leaseOwner.trim() : '';
  const leaseDurationMs =
    typeof params?.leaseDurationMs === 'number' && Number.isFinite(params.leaseDurationMs) && params.leaseDurationMs > 0
      ? params.leaseDurationMs
      : 30_000;
  const nowMs =
    typeof params?.nowMs === 'number' && Number.isFinite(params.nowMs)
      ? params.nowMs
      : Date.now();
  const expectedProjectId =
    typeof params?.expectedProjectId === 'string' && params.expectedProjectId.trim()
      ? params.expectedProjectId.trim()
      : DEFAULT_FIREBASE_PROJECT_ID;
  const expectedFirestoreDbId = normalizeFirestoreDatabaseId(params?.expectedFirestoreDatabaseId);

  if (!outboxId || !leaseOwner) {
    return { acquired: false, reason: 'INVALID_INPUT', entry: null };
  }

  const db = params.db || (await openPharmacyDB());
  const hasMetadataStore = db.objectStoreNames.contains('metadata');
  assertRequiredObjectStores(db, ['outbox']);

  return new Promise((resolve, reject) => {
    const storeNames = hasMetadataStore ? ['outbox', 'metadata'] : ['outbox'];
    const tx = db.transaction(storeNames, 'readwrite');
    const outboxStore = tx.objectStore('outbox');
    const metaStore = hasMetadataStore ? tx.objectStore('metadata') : null;
    let result: AcquireOutboxLeaseResult = { acquired: false, reason: 'NOT_FOUND', entry: null };

    let outboxLoaded = false;
    let metaLoaded = !metaStore;
    let allEntries: OutboxEntry[] = [];
    let allMetaRecords: any[] = [];
    let evaluated = false;

    const evaluateLease = () => {
      if (evaluated || !outboxLoaded || !metaLoaded) return;
      evaluated = true;

      const existing = allEntries.find((e) => e && e.id === outboxId);
      if (!existing) {
        result = { acquired: false, reason: 'NOT_FOUND', entry: null };
        return;
      }

      const normalized = normalizeOutboxEntry(existing, allEntries);

      if (existing.status === 'synced') {
        result = { acquired: false, reason: 'ALREADY_SYNCED', entry: normalized };
        return;
      }
      if (existing.status === 'dead-letter') {
        result = { acquired: false, reason: 'DEAD_LETTER', entry: normalized };
        return;
      }
      if (existing.status === 'blocked') {
        result = {
          acquired: false,
          reason: 'BLOCKED',
          ...(existing.blockReason
            ? { blockReason: existing.blockReason, dependencyFailureReason: existing.blockReason }
            : {}),
          entry: normalized
        };
        return;
      }

      if (existing.status === 'retry' && existing.nextRetryAt) {
        const nextRetryMs = Date.parse(existing.nextRetryAt);
        if (Number.isFinite(nextRetryMs) && nextRetryMs > nowMs) {
          result = { acquired: false, reason: 'RETRY_NOT_DUE', entry: normalized };
          return;
        }
      }

      const leaseExpiresMs = existing.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : NaN;
      const hasValidExpiry = Number.isFinite(leaseExpiresMs);
      const isInFlightStatus = existing.status === 'processing' || existing.status === 'syncing';
      const hasActiveLease =
        isInFlightStatus &&
        Boolean(existing.leaseOwner) &&
        hasValidExpiry &&
        leaseExpiresMs > nowMs;

      if (hasActiveLease) {
        result = { acquired: false, reason: 'ACTIVE_LEASE_HELD', entry: normalized };
        return;
      }

      const isEligibleStatus =
        existing.status === 'pending' ||
        existing.status === 'retry' ||
        existing.status === 'failed' ||
        existing.status === 'processing' ||
        existing.status === 'syncing';

      if (!isEligibleStatus) {
        result = { acquired: false, reason: 'STATUS_NOT_ELIGIBLE', entry: normalized };
        return;
      }

      // F4 Legacy V1 & Identity Contract Gates (non-destructive; never mutates or fabricates)
      const hasValidBranch = isValidOutboxBranchId(existing.branchId);
      const hasValidV2Shape =
        typeof existing.operationId === 'string' &&
        existing.operationId.trim().length > 0 &&
        typeof existing.idempotencyKey === 'string' &&
        existing.idempotencyKey.trim().length > 0 &&
        typeof existing.schemaVersion === 'number' &&
        Number.isFinite(existing.schemaVersion);

      if (!hasValidBranch || !hasValidV2Shape) {
        result = { acquired: false, reason: 'LEGACY_REVALIDATION_REQUIRED', entry: normalized };
        return;
      }

      const entryBranchId = existing.branchId!.trim();
      if (params.expectedBranchId !== undefined) {
        const expectedBranch =
          typeof params.expectedBranchId === 'string' ? params.expectedBranchId.trim() : '';
        if (!expectedBranch || expectedBranch !== entryBranchId) {
          result = { acquired: false, reason: 'BRANCH_MISMATCH', entry: normalized };
          return;
        }
      }

      const runtimeActorUid = getKnownActiveActorId();
      if (!isValidFirebaseActorUid(normalized.actorUid)) {
        result = {
          acquired: false,
          reason: 'ACTOR_UID_REQUIRED',
          blockReason: 'MISSING_ACTOR_UID_QUARANTINED',
          dependencyFailureReason:
            'Legacy outbox entry lacks a valid originator actorUid; preserved intact without attribution or deletion.',
          entry: normalized
        };
        return;
      }
      if (!runtimeActorUid) {
        result = {
          acquired: false,
          reason: 'ACTOR_UID_REQUIRED',
          blockReason: 'UNAUTHENTICATED_RUNTIME_ACTOR',
          entry: normalized
        };
        return;
      }

      const depEval = evaluateOutboxDependencies(existing, allEntries);
      if (!depEval.eligible) {
        if (depEval.terminalBlock) {
          const failureReason = depEval.message || depEval.reasonCode || 'DEPENDENCY_BLOCKED';
          const blockedChild: OutboxEntry = {
            ...normalized,
            status: 'blocked',
            blockReason: failureReason,
            lastErrorCode: depEval.reasonCode || 'DEPENDENCY_BLOCKED',
            ...(depEval.message ? { lastErrorMessage: depEval.message } : {})
          };
          delete blockedChild.leaseOwner;
          delete blockedChild.leaseExpiresAt;
          delete blockedChild.nextRetryAt;
          outboxStore.put(blockedChild);
          result = {
            acquired: false,
            reason: depEval.reasonCode || 'BLOCKED',
            blockReason: failureReason,
            dependencyFailureReason: failureReason,
            blockingDependencies: depEval.blockingDependencies,
            entry: blockedChild
          };
          return;
        }

        result = {
          acquired: false,
          reason: depEval.reasonCode || 'DEPENDENCY_NOT_READY',
          dependencyFailureReason: depEval.message,
          blockingDependencies: depEval.blockingDependencies,
          entry: normalized
        };
        return;
      }

      // F4 Remote Parent Existence Proof & Mandatory Fresh Server Verification Gate
      const parentCheck = extractRequiredRemoteParents(
        normalized,
        allEntries,
        depEval.resolvedParentOperationIds,
        entryBranchId
      );
      if (!parentCheck.ok) {
        result = {
          acquired: false,
          reason: parentCheck.reason,
          dependencyFailureReason: parentCheck.message,
          entry: normalized
        };
        return;
      }

      if (parentCheck.parents.length > 0) {
        const metaMap = new Map<string, any>();
        for (const rec of allMetaRecords) {
          if (rec && typeof rec.key === 'string') {
            metaMap.set(rec.key, rec);
          }
        }
        const serverVerifications = indexServerVerificationResults(params.serverVerificationResults);

        const verificationTargets: VerificationTargetSpec[] = [];
        for (const p of parentCheck.parents) {
          const primaryReason = p.reasons.has('PARENT_CURRENT_STATE')
            ? 'PARENT_CURRENT_STATE'
            : p.reasons.has('PARENT_NOT_ARCHIVED')
            ? 'PARENT_NOT_ARCHIVED'
            : 'REMOTE_PARENT_EXISTENCE';
          verificationTargets.push({
            projectId: expectedProjectId,
            firestoreDatabaseId: expectedFirestoreDbId,
            branchId: entryBranchId,
            entityType: p.entityType,
            entityId: p.entityId,
            documentPath: p.documentPath,
            reason: primaryReason,
            requiredForOperationId: normalized.operationId
          });
        }

        for (const p of parentCheck.parents) {
          // Validate any local RemoteParentAckRecord cache hint or parent remoteAckTarget integrity
          const metaKey = getRemoteParentAckMetadataKey(
            entryBranchId,
            p.entityType,
            p.entityId,
            p.sessionId ? { sessionId: p.sessionId } : undefined
          );
          const cachedAck = metaMap.get(metaKey) as RemoteParentAckRecord | undefined;

          let hasLocalRemoteProofHint = false;
          if (p.syncedParentOutbox && p.syncedParentOutbox.status === 'synced') {
            const pAck = p.syncedParentOutbox.remoteAckTarget;
            if (pAck) {
              if (
                pAck.projectId !== expectedProjectId ||
                normalizeFirestoreDatabaseId(pAck.firestoreDatabaseId) !== expectedFirestoreDbId ||
                pAck.branchId !== entryBranchId ||
                pAck.entityType !== p.entityType ||
                pAck.entityId !== p.entityId ||
                pAck.documentPath !== p.documentPath
              ) {
                result = {
                  acquired: false,
                  reason: 'REMOTE_ACK_TARGET_MISMATCH',
                  dependencyFailureReason: `Cached parent remoteAckTarget does not match ${p.documentPath}`,
                  verificationTargets,
                  entry: normalized
                };
                return;
              }
            }
            hasLocalRemoteProofHint = true;
          }

          if (cachedAck) {
            if (
              cachedAck.projectId !== expectedProjectId ||
              normalizeFirestoreDatabaseId(cachedAck.firestoreDatabaseId) !== expectedFirestoreDbId ||
              cachedAck.branchId !== entryBranchId ||
              cachedAck.entityType !== p.entityType ||
              cachedAck.entityId !== p.entityId ||
              cachedAck.documentPath !== p.documentPath
            ) {
              result = {
                acquired: false,
                reason: 'REMOTE_ACK_TARGET_MISMATCH',
                dependencyFailureReason: `Cached RemoteParentAckRecord metadata does not match ${p.documentPath}`,
                verificationTargets,
                entry: normalized
              };
              return;
            }
            hasLocalRemoteProofHint = true;
          }

          // Match fresh getDocFromServer verification result strictly against canonical target
          const matchingSv = serverVerifications.find(
            (sv) =>
              sv.documentPath === p.documentPath ||
              (sv.entityType === p.entityType && sv.entityId === p.entityId)
          );

          if (!matchingSv) {
            result = {
              acquired: false,
              reason: hasLocalRemoteProofHint
                ? 'SERVER_VERIFICATION_REQUIRED'
                : 'REMOTE_PARENT_EXISTENCE_UNPROVEN',
              dependencyFailureReason: hasLocalRemoteProofHint
                ? `Fresh getDocFromServer() verification required for ${p.documentPath}`
                : `No authoritative remote proof or fresh getDocFromServer() verification for parent ${p.documentPath}`,
              verificationTargets,
              entry: normalized
            };
            return;
          }

          if (
            matchingSv.source !== 'firestore_getDocFromServer' ||
            matchingSv.projectId !== expectedProjectId ||
            normalizeFirestoreDatabaseId(matchingSv.firestoreDatabaseId) !== expectedFirestoreDbId ||
            matchingSv.branchId !== entryBranchId ||
            matchingSv.entityType !== p.entityType ||
            matchingSv.entityId !== p.entityId ||
            matchingSv.documentPath !== p.documentPath ||
            typeof matchingSv.verifiedAt !== 'string' ||
            !Number.isFinite(Date.parse(matchingSv.verifiedAt))
          ) {
            result = {
              acquired: false,
              reason: 'REMOTE_ACK_TARGET_MISMATCH',
              dependencyFailureReason: `ServerDocVerificationResult metadata/source mismatch for ${p.documentPath}`,
              verificationTargets,
              entry: normalized
            };
            return;
          }

          if (matchingSv.offline === true) {
            result = {
              acquired: false,
              reason: 'SERVER_VERIFICATION_REQUIRED',
              dependencyFailureReason: `Offline during fresh getDocFromServer() check for ${p.documentPath}; preserving pending operation safely`,
              verificationTargets,
              entry: normalized
            };
            return;
          }

          if (matchingSv.exists !== true) {
            result = {
              acquired: false,
              reason: 'REMOTE_PARENT_MISSING_ON_SERVER',
              dependencyFailureReason: `Server getDocFromServer() confirmed missing parent document ${p.documentPath}`,
              verificationTargets,
              entry: normalized
            };
            return;
          }

          if (p.reasons.has('PARENT_NOT_ARCHIVED')) {
            const docData = matchingSv.docData;
            if (docData && (docData.archived === true || docData.status === 'archived')) {
              result = {
                acquired: false,
                reason: 'COMMERCIAL_TARGET_ARCHIVED',
                dependencyFailureReason: `Server document ${p.documentPath} is archived`,
                verificationTargets,
                entry: normalized
              };
              return;
            }
          }

          if (p.reasons.has('PARENT_CURRENT_STATE')) {
            const docStatus = matchingSv.docData?.status;
            const docAccountingStatus = matchingSv.docData?.accountingStatus;
            const targetStatus = normalized.payload?.status;
            if (normalized.entityType === 'stocktaking_session_item') {
              const writableStatus =
                typeof docStatus === 'string' && ['active', 'in_progress', 'reviewing'].includes(docStatus);
              const writableAccounting =
                docAccountingStatus === undefined || docAccountingStatus === 'open';
              if (!writableStatus || !writableAccounting) {
                result = {
                  acquired: false,
                  reason: 'REMOTE_PARENT_STATE_INCOMPATIBLE',
                  dependencyFailureReason: `Server state "${String(docStatus)}/${String(docAccountingStatus)}" on ${p.documentPath} locks stocktaking items`,
                  verificationTargets,
                  entry: normalized
                };
                return;
              }
            } else {
              const isTerminalRemote =
                typeof docStatus === 'string' &&
                ['sync_completed_unverified', 'committed', 'cancelled', 'COMMITTED', 'CANCELLED'].includes(docStatus);
              const isLockedAccounting =
                typeof docAccountingStatus === 'string' && docAccountingStatus !== 'open';
              const isExactTerminalReplayTarget =
                normalized.entityType === 'stocktaking_session' &&
                normalized.action === 'UPDATE' &&
                ((docStatus === 'sync_completed_unverified' && targetStatus === 'sync_completed_unverified') ||
                  (docStatus === 'cancelled' && targetStatus === 'cancelled'));

              if ((isTerminalRemote || isLockedAccounting) && !isExactTerminalReplayTarget) {
                result = {
                  acquired: false,
                  reason: 'REMOTE_PARENT_STATE_INCOMPATIBLE',
                  dependencyFailureReason: `Server state "${String(docStatus)}" on ${p.documentPath} rejects further updates`,
                  verificationTargets,
                  entry: normalized
                };
                return;
              }
            }
          }
        }
      }

      const recoveredExpiredLease = isInFlightStatus;
      const leaseExpiresIso = new Date(nowMs + leaseDurationMs).toISOString();
      const updated: OutboxEntry = {
        ...normalized,
        ...(depEval.normalizedDependsOn !== undefined ? { dependsOn: depEval.normalizedDependsOn } : {}),
        status: 'processing',
        leaseOwner,
        leaseExpiresAt: leaseExpiresIso
      };

      outboxStore.put(updated);
      result = {
        acquired: true,
        entry: updated,
        recoveredExpiredLease
      };
    };

    const allReq = outboxStore.getAll();
    allReq.onsuccess = () => {
      allEntries = (allReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      evaluateLease();
    };
    allReq.onerror = () => reject(allReq.error || new Error('Failed to read outbox entry for lease'));

    if (metaStore) {
      const metaReq = metaStore.getAll();
      metaReq.onsuccess = () => {
        allMetaRecords = (metaReq.result as any[]) || [];
        metaLoaded = true;
        evaluateLease();
      };
      metaReq.onerror = () => reject(metaReq.error || new Error('Failed to read metadata for lease'));
    }

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Failed to acquire outbox lease'));
    tx.onabort = () => reject(tx.error || new Error('Outbox lease transaction aborted'));
  });
}

/**
 * Marks a leased 'processing' outbox entry 'synced' atomically with its target entity record.
 * Requires mandatory matching `expectedLeaseOwner`, `'processing'` state, unexpired lease,
 * active verified `actorUid`, satisfied dependencies, and caller-supplied `RemoteWriteCompletionEvidence`.
 */
export async function markOutboxOperationSynced(
  params: MarkOutboxSyncedParams
): Promise<OutboxTransitionResult> {
  const outboxId = typeof params?.outboxId === 'string' ? params.outboxId.trim() : '';
  if (!outboxId) {
    return { updated: false, reason: 'INVALID_INPUT', entry: null };
  }

  const db = params.db || (await openPharmacyDB());
  assertRequiredObjectStores(db, [
    'outbox',
    'sales',
    'inventory_ledger',
    'purchase_invoices',
    'supplier_transactions',
    'metadata'
  ]);

  const nowMs =
    typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)
      ? params.nowMs
      : Date.now();
  const ackedAtIso = params.ackedAt || new Date(nowMs).toISOString();
  const expectedProjectId =
    typeof params.expectedProjectId === 'string' && params.expectedProjectId.trim()
      ? params.expectedProjectId.trim()
      : DEFAULT_FIREBASE_PROJECT_ID;
  const expectedFirestoreDbId = normalizeFirestoreDatabaseId(params.expectedFirestoreDatabaseId);

  const hasStocktakingStores =
    db.objectStoreNames.contains('stocktaking_sessions') &&
    db.objectStoreNames.contains('stocktaking_items');

  return new Promise((resolve, reject) => {
    const storeList: string[] = [
      'outbox',
      'sales',
      'inventory_ledger',
      'purchase_invoices',
      'supplier_transactions',
      'metadata'
    ];
    if (hasStocktakingStores) {
      storeList.push('stocktaking_sessions', 'stocktaking_items');
    }
    const tx = db.transaction(storeList, 'readwrite');
    const outboxStore = tx.objectStore('outbox');
    const salesStore = tx.objectStore('sales');
    const ledgerStore = tx.objectStore('inventory_ledger');
    const invoiceStore = tx.objectStore('purchase_invoices');
    const stStore = tx.objectStore('supplier_transactions');
    const metaStore = tx.objectStore('metadata');
    const stkSessStore = hasStocktakingStores ? tx.objectStore('stocktaking_sessions') : null;
    const stkItemStore = hasStocktakingStores ? tx.objectStore('stocktaking_items') : null;

    let result: OutboxTransitionResult = {
      updated: false,
      reason: 'NOT_FOUND',
      entry: null
    };
    let successResultPending = false;
    let updatedOutbox: OutboxEntry | null = null;
    let updatedSaleId: string | undefined;
    const updatedLedgerIds: string[] = [];
    const updatedLinkedOutboxIds: string[] = [];

    const allOutboxReq = outboxStore.getAll();
    allOutboxReq.onsuccess = () => {
      const allEntries = (allOutboxReq.result as OutboxEntry[]) || [];
      const existing = allEntries.find((e) => e && e.id === outboxId);
      if (!existing) {
        result = { updated: false, reason: 'NOT_FOUND', entry: null };
        return;
      }

      const normalized = normalizeOutboxEntry(existing, allEntries);

      if (existing.status === 'dead-letter') {
        result = {
          updated: false,
          reason: 'DEAD_LETTER_PROTECTED',
          entry: normalized
        };
        return;
      }

      if (existing.status === 'synced') {
        result = {
          updated: false,
          reason: 'ALREADY_SYNCED',
          entry: normalized
        };
        return;
      }

      // FIX A: Mandatory lease ownership, exact owner match, active 'processing' status, and unexpired lease
      const expectedOwner =
        typeof params.expectedLeaseOwner === 'string' ? params.expectedLeaseOwner : '';
      if (
        !expectedOwner.trim() ||
        expectedOwner !== expectedOwner.trim() ||
        typeof existing.leaseOwner !== 'string' ||
        existing.leaseOwner !== expectedOwner
      ) {
        result = {
          updated: false,
          reason: 'LEASE_MISMATCH',
          entry: normalized
        };
        return;
      }

      if (existing.status !== 'processing') {
        result = {
          updated: false,
          reason: 'STATUS_NOT_ELIGIBLE',
          entry: normalized
        };
        return;
      }

      const leaseExpiresMs = existing.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : NaN;
      if (!Number.isFinite(leaseExpiresMs) || leaseExpiresMs <= nowMs) {
        result = {
          updated: false,
          reason: 'LEASE_EXPIRED',
          entry: normalized
        };
        return;
      }

      // FIX D: Require verified runtime actor context and valid entry actorUid
      const runtimeActorUid = getKnownActiveActorId();
      if (!isValidFirebaseActorUid(normalized.actorUid)) {
        result = {
          updated: false,
          reason: 'ACTOR_UID_REQUIRED',
          blockReason: 'MISSING_ACTOR_UID_QUARANTINED',
          entry: normalized
        };
        return;
      }
      if (!runtimeActorUid) {
        result = {
          updated: false,
          reason: 'ACTOR_UID_REQUIRED',
          blockReason: 'UNAUTHENTICATED_RUNTIME_ACTOR',
          entry: normalized
        };
        return;
      }

      // Enforce dependency readiness at sync acknowledgement time
      const depEval = evaluateOutboxDependencies(normalized, allEntries);
      if (!depEval.eligible) {
        result = {
          updated: false,
          reason: depEval.terminalBlock ? 'DEPENDENCY_INVALID' : 'DEPENDENCY_NOT_READY',
          entry: normalized
        };
        return;
      }

      const evidenceCheck = validateRemoteWriteCompletionEvidence(
        params.remoteWriteEvidence,
        normalized,
        expectedProjectId,
        expectedFirestoreDbId,
        runtimeActorUid
      );
      if (!evidenceCheck.valid || !evidenceCheck.canonicalTarget) {
        result = {
          updated: false,
          reason: evidenceCheck.reason || 'INVALID_REMOTE_ACK_EVIDENCE',
          entry: normalized
        };
        return;
      }

      const ackTarget = evidenceCheck.canonicalTarget;
      const writeParentAckHint = (
        entityType: OutboxEntityType,
        entityId: string,
        action: 'CREATE' | 'UPDATE',
        parentIds?: { sessionId?: string }
      ) => {
        const docPath = buildCanonicalFirestoreDocumentPath(ackTarget.branchId, entityType, entityId, parentIds);
        const ackHint: RemoteParentAckRecord = {
          key: getRemoteParentAckMetadataKey(ackTarget.branchId, entityType, entityId, parentIds),
          cache_hint: true,
          projectId: ackTarget.projectId,
          firestoreDatabaseId: ackTarget.firestoreDatabaseId,
          branchId: ackTarget.branchId,
          entityType,
          entityId,
          documentPath: docPath,
          action,
          verifiedAt: ackTarget.completedAt,
          verifiedByUid: ackTarget.actorUid,
          proofSource: ackTarget.evidenceKind,
          clientAttemptId: ackTarget.clientAttemptId
        };
        metaStore.put(ackHint);
      };

      const nextOutbox: OutboxEntry = {
        ...normalized,
        status: 'synced',
        ackedAt: ackedAtIso,
        remoteAckTarget: ackTarget
      };
      delete nextOutbox.leaseOwner;
      delete nextOutbox.leaseExpiresAt;
      delete nextOutbox.nextRetryAt;
      delete nextOutbox.blockReason;
      delete nextOutbox.lastErrorCode;
      delete nextOutbox.lastErrorMessage;

      updatedOutbox = nextOutbox;
      outboxStore.put(nextOutbox);
      if (nextOutbox.action === 'CREATE' || nextOutbox.action === 'UPDATE') {
        const parentIds =
          nextOutbox.entityType === 'stocktaking_session_item' &&
          typeof nextOutbox.payload?.sessionId === 'string'
            ? { sessionId: nextOutbox.payload.sessionId }
            : undefined;
        writeParentAckHint(nextOutbox.entityType, nextOutbox.entityId, nextOutbox.action, parentIds);
      }
      successResultPending = true;

      // FIX B: Only mark the exact entity targeted by this outbox operation synced.
      // A sale acknowledgment NEVER blindly marks separate inventory_ledger documents or
      // their outbox entries synced; each ledger operation must acquire its own lease and
      // supply its own RemoteWriteCompletionEvidence.
      if (existing.entityType === 'sale' && existing.entityId) {
        const saleReq = salesStore.get(existing.entityId);
        saleReq.onsuccess = () => {
          const sale = saleReq.result as Sale | undefined;
          if (sale) {
            if (sale.synced !== 1) {
              salesStore.put({ ...sale, synced: 1 });
            }
            updatedSaleId = sale.id;
          }
        };
        saleReq.onerror = () => reject(saleReq.error || new Error('Failed to load sale for sync ack'));
      } else if (existing.entityType === 'inventory_ledger' && existing.entityId) {
        const movReq = ledgerStore.get(existing.entityId);
        movReq.onsuccess = () => {
          const mov = movReq.result as LedgerMovement | undefined;
          if (mov) {
            if (mov.synced !== 1) {
              ledgerStore.put({ ...mov, synced: 1 });
            }
            updatedLedgerIds.push(existing.entityId);
          }
        };
        movReq.onerror = () =>
          reject(movReq.error || new Error(`Failed to load ledger movement ${existing.entityId}`));
      } else if (existing.entityType === 'purchase_invoice' && existing.entityId) {
        const invReq = invoiceStore.get(existing.entityId);
        invReq.onsuccess = () => {
          const inv = invReq.result as PurchaseInvoice | undefined;
          if (inv && inv.synced !== 1) {
            invoiceStore.put({ ...inv, synced: 1 });
          }
        };
        invReq.onerror = () => reject(invReq.error || new Error('Failed to load purchase invoice for sync ack'));
      } else if (existing.entityType === 'supplier_transaction' && existing.entityId) {
        const stReq = stStore.get(existing.entityId);
        stReq.onsuccess = () => {
          const st = stReq.result as SupplierTransaction | undefined;
          if (st && st.synced !== 1) {
            stStore.put({ ...st, synced: 1 });
          }
        };
        stReq.onerror = () => reject(stReq.error || new Error('Failed to load supplier transaction for sync ack'));
      } else if (existing.entityType === 'stocktaking_session' && existing.entityId && stkSessStore) {
        const remainingUnsynced = allEntries.some(
          (other) =>
            other &&
            other.id !== existing.id &&
            other.status !== 'synced' &&
            ((other.entityType === 'stocktaking_session' && other.entityId === existing.entityId) ||
              (other.entityType === 'stocktaking_session_item' && other.payload?.sessionId === existing.entityId))
        );
        if (!remainingUnsynced) {
          const stkReq = stkSessStore.get(existing.entityId);
          stkReq.onsuccess = () => {
            const sess = stkReq.result as (StocktakingSession & { syncStatus?: string }) | undefined;
            if (sess && sess.syncStatus !== 'synced') {
              stkSessStore.put({ ...sess, syncStatus: 'synced' });
            }
          };
        }
      } else if (
        existing.entityType === 'stocktaking_session_item' &&
        existing.action !== 'DELETE' &&
        existing.entityId &&
        stkItemStore
      ) {
        const remainingUnsyncedItem = allEntries.some(
          (other) =>
            other &&
            other.id !== existing.id &&
            other.status !== 'synced' &&
            other.entityType === 'stocktaking_session_item' &&
            other.entityId === existing.entityId
        );
        if (!remainingUnsyncedItem) {
          const itemReq = stkItemStore.get(existing.entityId);
          itemReq.onsuccess = () => {
            const itemRec = itemReq.result as StocktakingItemRecord | undefined;
            if (itemRec && itemRec.syncStatus !== 'synced') {
              stkItemStore.put({ ...itemRec, syncStatus: 'synced' });
            }
          };
        }
      }
    };

    allOutboxReq.onerror = () =>
      reject(allOutboxReq.error || new Error('Failed to load outbox entry for synced transition'));
    tx.oncomplete = () => {
      if (successResultPending && updatedOutbox) {
        resolve({
          updated: true,
          entry: updatedOutbox,
          ...(updatedSaleId ? { updatedSaleId } : {}),
          updatedLedgerIds,
          updatedLinkedOutboxIds
        });
      } else {
        resolve(result);
      }
    };
    tx.onerror = () => reject(tx.error || new Error('Failed to mark outbox operation synced'));
    tx.onabort = () => reject(tx.error || new Error('Mark outbox synced transaction aborted'));
  });
}

export async function markOutboxOperationRetry(
  params: MarkOutboxRetryParams
): Promise<OutboxTransitionResult> {
  const outboxId = typeof params?.outboxId === 'string' ? params.outboxId.trim() : '';
  const errorCode = typeof params?.errorCode === 'string' ? params.errorCode.trim() : '';
  if (!outboxId || !errorCode) {
    return { updated: false, reason: 'INVALID_INPUT', entry: null };
  }

  const db = params.db || (await openPharmacyDB());
  assertRequiredObjectStores(db, ['outbox']);

  const nowMs =
    typeof params.nowMs === 'number' && Number.isFinite(params.nowMs)
      ? params.nowMs
      : Date.now();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['outbox'], 'readwrite');
    const outboxStore = tx.objectStore('outbox');
    let result: OutboxTransitionResult = { updated: false, reason: 'NOT_FOUND', entry: null };

    const getReq = outboxStore.get(outboxId);
    getReq.onsuccess = () => {
      const existing = getReq.result as OutboxEntry | undefined;
      if (!existing) {
        result = { updated: false, reason: 'NOT_FOUND', entry: null };
        return;
      }

      const normalized = normalizeOutboxEntry(existing);

      if (existing.status === 'synced') {
        result = { updated: false, reason: 'ALREADY_SYNCED', entry: normalized };
        return;
      }
      if (existing.status === 'dead-letter') {
        result = { updated: false, reason: 'DEAD_LETTER_PROTECTED', entry: normalized };
        return;
      }
      if (params.expectedLeaseOwner !== undefined) {
        const expectedOwner =
          typeof params.expectedLeaseOwner === 'string' ? params.expectedLeaseOwner : '';
        if (!expectedOwner.trim() || existing.leaseOwner !== expectedOwner) {
          result = { updated: false, reason: 'LEASE_MISMATCH', entry: normalized };
          return;
        }
      }

      const nextAttempts = (normalized.attempts || 0) + 1;
      const delayMs =
        typeof params.retryDelayMs === 'number' && Number.isFinite(params.retryDelayMs) && params.retryDelayMs >= 0
          ? params.retryDelayMs
          : Math.min(300_000, 5_000 * Math.pow(2, Math.max(0, nextAttempts - 1)));
      const nextRetryAtIso =
        params.nextRetryAt && Number.isFinite(Date.parse(params.nextRetryAt))
          ? params.nextRetryAt
          : new Date(nowMs + delayMs).toISOString();

      const updated: OutboxEntry = {
        ...normalized,
        status: 'retry',
        attempts: nextAttempts,
        retryCount: nextAttempts,
        nextRetryAt: nextRetryAtIso,
        lastErrorCode: errorCode,
        ...(params.errorMessage ? { lastErrorMessage: params.errorMessage } : {})
      };
      delete updated.leaseOwner;
      delete updated.leaseExpiresAt;

      outboxStore.put(updated);
      result = { updated: true, entry: updated };
    };

    getReq.onerror = () => reject(getReq.error || new Error('Failed to load outbox entry for retry'));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Failed to mark outbox operation retry'));
    tx.onabort = () => reject(tx.error || new Error('Mark outbox retry transaction aborted'));
  });
}

export async function markOutboxOperationBlocked(
  params: MarkOutboxBlockedParams
): Promise<OutboxTransitionResult> {
  const outboxId = typeof params?.outboxId === 'string' ? params.outboxId.trim() : '';
  const blockReason = typeof params?.blockReason === 'string' ? params.blockReason.trim() : '';
  if (!outboxId || !blockReason) {
    return { updated: false, reason: 'INVALID_INPUT', entry: null };
  }

  const db = params.db || (await openPharmacyDB());
  assertRequiredObjectStores(db, ['outbox']);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['outbox'], 'readwrite');
    const outboxStore = tx.objectStore('outbox');
    let result: OutboxTransitionResult = { updated: false, reason: 'NOT_FOUND', entry: null };

    const getReq = outboxStore.get(outboxId);
    getReq.onsuccess = () => {
      const existing = getReq.result as OutboxEntry | undefined;
      if (!existing) {
        result = { updated: false, reason: 'NOT_FOUND', entry: null };
        return;
      }

      const normalized = normalizeOutboxEntry(existing);

      if (existing.status === 'synced') {
        result = { updated: false, reason: 'ALREADY_SYNCED', entry: normalized };
        return;
      }
      if (existing.status === 'dead-letter') {
        result = { updated: false, reason: 'DEAD_LETTER_PROTECTED', entry: normalized };
        return;
      }
      if (params.expectedLeaseOwner !== undefined) {
        const expectedOwner =
          typeof params.expectedLeaseOwner === 'string' ? params.expectedLeaseOwner : '';
        if (!expectedOwner.trim() || existing.leaseOwner !== expectedOwner) {
          result = { updated: false, reason: 'LEASE_MISMATCH', entry: normalized };
          return;
        }
      }

      const updated: OutboxEntry = {
        ...normalized,
        status: 'blocked',
        blockReason,
        ...(params.errorCode ? { lastErrorCode: params.errorCode } : {}),
        ...(params.errorMessage ? { lastErrorMessage: params.errorMessage } : {})
      };
      delete updated.leaseOwner;
      delete updated.leaseExpiresAt;
      delete updated.nextRetryAt;

      outboxStore.put(updated);
      result = { updated: true, entry: updated };
    };

    getReq.onerror = () => reject(getReq.error || new Error('Failed to load outbox entry for blocked'));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Failed to mark outbox operation blocked'));
    tx.onabort = () => reject(tx.error || new Error('Mark outbox blocked transaction aborted'));
  });
}

export async function markOutboxOperationFailed(
  params: MarkOutboxFailedParams
): Promise<OutboxTransitionResult> {
  const outboxId = typeof params?.outboxId === 'string' ? params.outboxId.trim() : '';
  const errorCode = typeof params?.errorCode === 'string' ? params.errorCode.trim() : '';
  if (!outboxId || !errorCode) {
    return { updated: false, reason: 'INVALID_INPUT', entry: null };
  }

  const db = params.db || (await openPharmacyDB());
  assertRequiredObjectStores(db, ['outbox']);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['outbox'], 'readwrite');
    const outboxStore = tx.objectStore('outbox');
    let result: OutboxTransitionResult = { updated: false, reason: 'NOT_FOUND', entry: null };

    const getReq = outboxStore.get(outboxId);
    getReq.onsuccess = () => {
      const existing = getReq.result as OutboxEntry | undefined;
      if (!existing) {
        result = { updated: false, reason: 'NOT_FOUND', entry: null };
        return;
      }

      const normalized = normalizeOutboxEntry(existing);

      if (existing.status === 'synced') {
        result = { updated: false, reason: 'ALREADY_SYNCED', entry: normalized };
        return;
      }
      if (existing.status === 'dead-letter') {
        result = { updated: false, reason: 'DEAD_LETTER_PROTECTED', entry: normalized };
        return;
      }
      if (params.expectedLeaseOwner !== undefined) {
        const expectedOwner =
          typeof params.expectedLeaseOwner === 'string' ? params.expectedLeaseOwner : '';
        if (!expectedOwner.trim() || existing.leaseOwner !== expectedOwner) {
          result = { updated: false, reason: 'LEASE_MISMATCH', entry: normalized };
          return;
        }
      }

      const prevAttempts = normalized.attempts || 0;
      const nextAttempts = params.incrementAttempt === false ? prevAttempts : prevAttempts + 1;

      const updated: OutboxEntry = {
        ...normalized,
        status: 'failed',
        attempts: nextAttempts,
        retryCount: nextAttempts,
        lastErrorCode: errorCode,
        ...(params.errorMessage ? { lastErrorMessage: params.errorMessage } : {})
      };
      delete updated.leaseOwner;
      delete updated.leaseExpiresAt;
      delete updated.nextRetryAt;

      outboxStore.put(updated);
      result = { updated: true, entry: updated };
    };

    getReq.onerror = () => reject(getReq.error || new Error('Failed to load outbox entry for failed'));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Failed to mark outbox operation failed'));
    tx.onabort = () => reject(tx.error || new Error('Mark outbox failed transaction aborted'));
  });
}

export async function markOutboxOperationDeadLetter(
  params: MarkOutboxDeadLetterParams
): Promise<OutboxTransitionResult> {
  const outboxId = typeof params?.outboxId === 'string' ? params.outboxId.trim() : '';
  const errorCode = typeof params?.errorCode === 'string' ? params.errorCode.trim() : '';
  if (!outboxId || !errorCode) {
    return { updated: false, reason: 'INVALID_INPUT', entry: null };
  }

  const db = params.db || (await openPharmacyDB());
  assertRequiredObjectStores(db, ['outbox']);

  const nowIso = new Date(
    typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) ? params.nowMs : Date.now()
  ).toISOString();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['outbox'], 'readwrite');
    const outboxStore = tx.objectStore('outbox');
    let result: OutboxTransitionResult = { updated: false, reason: 'NOT_FOUND', entry: null };

    const getReq = outboxStore.get(outboxId);
    getReq.onsuccess = () => {
      const existing = getReq.result as OutboxEntry | undefined;
      if (!existing) {
        result = { updated: false, reason: 'NOT_FOUND', entry: null };
        return;
      }

      const normalized = normalizeOutboxEntry(existing);

      if (existing.status === 'synced') {
        result = { updated: false, reason: 'ALREADY_SYNCED', entry: normalized };
        return;
      }
      if (existing.status === 'dead-letter') {
        result = { updated: false, reason: 'DEAD_LETTER_PROTECTED', entry: normalized };
        return;
      }
      if (params.expectedLeaseOwner !== undefined) {
        const expectedOwner =
          typeof params.expectedLeaseOwner === 'string' ? params.expectedLeaseOwner : '';
        if (!expectedOwner.trim() || existing.leaseOwner !== expectedOwner) {
          result = { updated: false, reason: 'LEASE_MISMATCH', entry: normalized };
          return;
        }
      }

      const updated: OutboxEntry = {
        ...normalized,
        status: 'dead-letter',
        lastErrorCode: errorCode,
        ...(params.errorMessage ? { lastErrorMessage: params.errorMessage } : {}),
        ...(params.blockReason ? { blockReason: params.blockReason } : {}),
        quarantinedAt: nowIso
      };
      delete updated.leaseOwner;
      delete updated.leaseExpiresAt;
      delete updated.nextRetryAt;

      outboxStore.put(updated);
      result = { updated: true, entry: updated };
    };

    getReq.onerror = () => reject(getReq.error || new Error('Failed to load outbox entry for dead-letter'));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Failed to mark outbox operation dead-letter'));
    tx.onabort = () => reject(tx.error || new Error('Mark outbox dead-letter transaction aborted'));
  });
}

export async function checkOverAllocationWarnings(): Promise<{ medicineId: string; medicineName: string; negativeBalance: number }[]> {
  const allMeds = await getAllMedicinesWithLiveStock();
  const warnings: { medicineId: string; medicineName: string; negativeBalance: number }[] = [];
  allMeds.forEach((m) => {
    if (m.totalBasePills < 0) {
      warnings.push({
        medicineId: m.id,
        medicineName: m.name,
        negativeBalance: m.totalBasePills
      });
    }
  });
  return warnings;
}

// ============================================================================
// PHASE 3: SUPPLIER ACCOUNTS, PAYMENTS & DETAILED STATEMENTS ENGINE
// ============================================================================

export interface RecordSupplierPaymentParams {
  id?: string; // Deterministic UUIDv4 or client idempotency key
  supplierId: string;
  voucherNumber?: string;
  paymentDate?: string;
  amount: number;
  paymentMethod: 'Cash' | 'Bankak' | 'Check' | 'Transfer';
  bankakTransactionId?: string;
  checkNumber?: string;
  checkDueDate?: string;
  transferReference?: string;
  referenceId?: string;
  allocations?: { invoiceId: string; invoiceNumber: string; amount: number }[];
  autoAllocateFifo?: boolean;
  notes?: string;
  employeeName?: string;
}

export interface RecordPaymentResult {
  transaction: SupplierTransaction;
  updatedSupplier: Supplier;
  supplier?: Supplier;
  updatedInvoices: PurchaseInvoice[];
  invoiceUpdates?: PurchaseInvoice[];
}

/**
 * ATOMIC SUPPLIER PAYMENT POSTING ENGINE
 * Settle debts with Cash, Bankak, Cheque, or Transfer.
 * Supports:
 *  - Specific invoice allocation
 *  - FIFO auto-allocation to oldest unpaid invoices
 *  - Unallocated payment on account (سداد على الحساب)
 * Updates:
 *  - supplier_transactions (DEBIT record, reducing amount owed)
 *  - suppliers (reduces balance)
 *  - purchase_invoices (updates paidAmount, remainingAmount, paymentStatus)
 *  - outbox (reliable Local-First sync)
 */
export async function recordSupplierPayment(params: RecordSupplierPaymentParams): Promise<RecordPaymentResult> {
  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['suppliers', 'supplier_transactions', 'purchase_invoices', 'outbox']);
  const nowIso = new Date().toISOString();
  const todayStr = nowIso.split('T')[0];

  // 1. Synchronous validation
  if (!params.supplierId) {
    throw new Error('يجب تحديد المورد');
  }
  const paymentAmount = Number(params.amount);
  if (isNaN(paymentAmount) || paymentAmount <= 0) {
    throw new Error('مبلغ السداد يجب أن يكون رقماً أكبر من الصفر');
  }
  if (!params.paymentMethod) {
    throw new Error('يجب تحديد طريقة الدفع (نقداً، بنكك، شيك، تحويل بنكي)');
  }

  const paymentId = params.id || generateUUID();
  const deviceId = getDeviceId();
  const employeeName = params.employeeName || 'المسؤول';
  const voucherNumber = params.voucherNumber || ('PV-' + todayStr.replace(/-/g, '') + '-' + paymentId.slice(0, 6).toUpperCase());
  const knownBranchId = getKnownActiveBranchId();
  const knownActorUid = getKnownActiveActorId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ['suppliers', 'supplier_transactions', 'purchase_invoices', 'outbox'],
      'readwrite'
    );

    const supStore = tx.objectStore('suppliers');
    const stStore = tx.objectStore('supplier_transactions');
    const invStore = tx.objectStore('purchase_invoices');
    const outboxStore = tx.objectStore('outbox');

    let abortReason: Error | null = null;
    let finalResult: RecordPaymentResult | null = null;

    const abortWith = (err: unknown, fallback: string) => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(fallback);
      }
      try {
        tx.abort();
      } catch {
        // ignore abort error
      }
    };

    // Step A: Idempotency check on paymentId
    const checkPaymentReq = stStore.get(paymentId);
    checkPaymentReq.onerror = () => abortWith(checkPaymentReq.error, 'تعذر التحقق من سجل السداد');
    checkPaymentReq.onsuccess = () => {
      if (checkPaymentReq.result) {
        const existingTx: SupplierTransaction = checkPaymentReq.result;
        const supIdemReq = supStore.get(params.supplierId);
        supIdemReq.onerror = () => abortWith(supIdemReq.error, 'تعذر قراءة بيانات المورد');
        supIdemReq.onsuccess = () => {
          finalResult = {
            transaction: existingTx,
            supplier: supIdemReq.result,
            updatedSupplier: supIdemReq.result,
            updatedInvoices: [],
            invoiceUpdates: []
          };
        };
        return;
      }

      // Step B: Retrieve supplier
      const supReq = supStore.get(params.supplierId);
      supReq.onerror = () => abortWith(supReq.error, 'تعذر قراءة بيانات المورد');
      supReq.onsuccess = () => {
        const supplier: Supplier | undefined = supReq.result;
        if (!supplier) {
          abortWith(new Error(`المورد غير موجود: ${params.supplierId}`), 'المورد غير موجود');
          return;
        }
        if (supplier.archived === true || supplier.status === 'archived') {
          abortWith(
            new Error(`COMMERCIAL_TARGET_ARCHIVED: المورد "${supplier.name?.ar || supplier.id}" مؤرشف ولا يمكن تسجيل سند صرف له`),
            'المورد مؤرشف'
          );
          return;
        }

        // Step C: Retrieve supplier's purchase invoices and outbox entries in-tx
        let invLoaded = false;
        let outboxLoaded = false;
        let finalized = false;
        let allInvoices: PurchaseInvoice[] = [];
        let existingOutboxEntries: OutboxEntry[] = [];

        const tryProceed = () => {
          if (finalized || !invLoaded || !outboxLoaded) return;
          finalized = true;

          try {
            const outboxDepIndex = buildOutboxDependencyIndex(existingOutboxEntries);
            const unsyncedSupplierCreateOpIds: string[] = [];
            for (const e of existingOutboxEntries) {
              if (
                e &&
                e.entityType === 'supplier' &&
                e.entityId === supplier.id &&
                e.action === 'CREATE' &&
                e.status !== 'synced'
              ) {
                validateOutboxRecordDependencies(e, outboxDepIndex);
                const opId = getCanonicalOutboxOperationId(e);
                if (opId && !unsyncedSupplierCreateOpIds.includes(opId)) {
                  unsyncedSupplierCreateOpIds.push(opId);
                }
              }
            }

            const getUnsyncedInvoiceCreateOpIds = (invoiceId: string): string[] => {
              const ids: string[] = [];
              for (const e of existingOutboxEntries) {
                if (
                  e &&
                  e.entityType === 'purchase_invoice' &&
                  e.entityId === invoiceId &&
                  e.action === 'CREATE' &&
                  e.status !== 'synced'
                ) {
                  validateOutboxRecordDependencies(e, outboxDepIndex);
                  const opId = getCanonicalOutboxOperationId(e);
                  if (opId && !ids.includes(opId)) ids.push(opId);
                }
              }
              return ids;
            };

            const updatedInvoicesList: PurchaseInvoice[] = [];
            const actualAllocations: InvoiceAllocation[] = [];
            const allocatedInvCreateDeps: string[] = [];
            let allocatedTotal = 0;

            if (params.allocations && params.allocations.length > 0) {
              for (const alloc of params.allocations) {
                const targetInv = allInvoices.find((i) => i.id === alloc.invoiceId);
                if (!targetInv) {
                  abortWith(
                    new Error(`الفاتورة المخصصة للسداد غير موجودة لهذا المورد: ${alloc.invoiceNumber || alloc.invoiceId}`),
                    'الفاتورة غير موجودة'
                  );
                  return;
                }
                const allocAmount = Number(alloc.amount) || 0;
                if (allocAmount <= 0) continue;

                const remaining =
                  targetInv.remainingAmount !== undefined
                    ? targetInv.remainingAmount
                    : targetInv.netAmount - (targetInv.paidAmount || 0);
                if (allocAmount > remaining + 0.01) {
                  abortWith(
                    new Error(
                      `مبلغ التخصيص (${allocAmount.toLocaleString()} ج.س) يتجاوز الرصيد المتبقي للفاتورة #${targetInv.invoiceNumber} (${remaining.toLocaleString()} ج.س)`
                    ),
                    'مبلغ التخصيص يتجاوز المتبقي'
                  );
                  return;
                }

                allocatedTotal += allocAmount;
                const newPaid = Number(((targetInv.paidAmount || 0) + allocAmount).toFixed(2));
                const newRemaining = Math.max(0, Number((targetInv.netAmount - newPaid).toFixed(2)));
                const newStatus: 'Paid' | 'Partial' | 'Unpaid' = newRemaining <= 0.01 ? 'Paid' : 'Partial';

                targetInv.paidAmount = newPaid;
                targetInv.remainingAmount = newRemaining;
                targetInv.paymentStatus = newStatus;
                targetInv.updatedAt = nowIso;

                invStore.put(targetInv);
                updatedInvoicesList.push(targetInv);

                const invCreateDeps = getUnsyncedInvoiceCreateOpIds(targetInv.id);
                allocatedInvCreateDeps.push(...invCreateDeps);
                const invOutboxId = generateUUID();
                const invDeps = Array.from(new Set([...invCreateDeps, ...unsyncedSupplierCreateOpIds]));
                outboxStore.put({
                  id: invOutboxId,
                  operationId: invOutboxId,
                  idempotencyKey: `purchase_invoice:UPDATE:${targetInv.id}:${invOutboxId}`,
                  ...(knownBranchId ? { branchId: knownBranchId } : {}),
                  ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                  schemaVersion: 1,
                  ...(invDeps.length > 0 ? { dependsOn: invDeps } : {}),
                  entityType: 'purchase_invoice',
                  entityId: targetInv.id,
                  action: 'UPDATE',
                  payload: targetInv,
                  timestamp: nowIso,
                  retryCount: 0,
                  attempts: 0,
                  status: 'pending'
                });

                actualAllocations.push({
                  invoiceId: targetInv.id,
                  invoiceNumber: targetInv.invoiceNumber,
                  amount: allocAmount
                });
              }

              if (allocatedTotal > paymentAmount + 0.01) {
                abortWith(
                  new Error(
                    `إجمالي المبالغ المخصصة للفواتير (${allocatedTotal.toLocaleString()} ج.س) يتجاوز مبلغ السند (${paymentAmount.toLocaleString()} ج.س)`
                  ),
                  'تجاوز مبلغ التخصيص'
                );
                return;
              }
            } else if (params.autoAllocateFifo) {
              const unpaidInvoices = allInvoices
                .filter(
                  (inv) =>
                    inv.paymentStatus !== 'Paid' &&
                    (inv.remainingAmount || inv.netAmount - (inv.paidAmount || 0)) > 0.01
                )
                .sort((a, b) => new Date(a.date || a.createdAt).getTime() - new Date(b.date || b.createdAt).getTime());

              let remainingPaymentToAllocate = paymentAmount;
              for (const inv of unpaidInvoices) {
                if (remainingPaymentToAllocate <= 0.01) break;

                const invRemaining =
                  inv.remainingAmount !== undefined
                    ? inv.remainingAmount
                    : inv.netAmount - (inv.paidAmount || 0);
                const allocAmount = Math.min(remainingPaymentToAllocate, invRemaining);

                const newPaid = Number(((inv.paidAmount || 0) + allocAmount).toFixed(2));
                const newRemaining = Math.max(0, Number((inv.netAmount - newPaid).toFixed(2)));
                const newStatus: 'Paid' | 'Partial' | 'Unpaid' = newRemaining <= 0.01 ? 'Paid' : 'Partial';

                inv.paidAmount = newPaid;
                inv.remainingAmount = newRemaining;
                inv.paymentStatus = newStatus;
                inv.updatedAt = nowIso;

                invStore.put(inv);
                updatedInvoicesList.push(inv);

                const invCreateDeps = getUnsyncedInvoiceCreateOpIds(inv.id);
                allocatedInvCreateDeps.push(...invCreateDeps);
                const invOutboxId = generateUUID();
                const invDeps = Array.from(new Set([...invCreateDeps, ...unsyncedSupplierCreateOpIds]));
                outboxStore.put({
                  id: invOutboxId,
                  operationId: invOutboxId,
                  idempotencyKey: `purchase_invoice:UPDATE:${inv.id}:${invOutboxId}`,
                  ...(knownBranchId ? { branchId: knownBranchId } : {}),
                  ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                  schemaVersion: 1,
                  ...(invDeps.length > 0 ? { dependsOn: invDeps } : {}),
                  entityType: 'purchase_invoice',
                  entityId: inv.id,
                  action: 'UPDATE',
                  payload: inv,
                  timestamp: nowIso,
                  retryCount: 0,
                  attempts: 0,
                  status: 'pending'
                });

                actualAllocations.push({
                  invoiceId: inv.id,
                  invoiceNumber: inv.invoiceNumber,
                  amount: Number(allocAmount.toFixed(2))
                });

                remainingPaymentToAllocate = Number((remainingPaymentToAllocate - allocAmount).toFixed(2));
              }
            }

            // Step D: Update Supplier Balance with Outbox V2
            const previousBalance = supplier.balance || 0;
            const newBalance = Number((previousBalance - paymentAmount).toFixed(2));

            const updatedSupplier: Supplier = {
              ...supplier,
              balance: newBalance,
              updatedAt: nowIso
            };
            supStore.put(updatedSupplier);

            const { targetEntry: supOutboxEntry } = resolveSupplierOutboxWrite({
              existingEntries: existingOutboxEntries,
              supplier: updatedSupplier,
              actuallyNew: false,
              allowCoalesceCreate: false,
              knownBranchId,
              knownActorUid,
              nowIso
            });
            const supOutboxOpId = getCanonicalOutboxOperationId(supOutboxEntry);
            const existingSupDeps = Array.isArray(supOutboxEntry.dependsOn)
              ? normalizeDependsOnArray(supOutboxEntry.dependsOn, outboxDepIndex)
              : [];
            const combinedSupDeps = Array.from(
              new Set([...existingSupDeps, ...unsyncedSupplierCreateOpIds])
            ).filter((d) => d !== supOutboxOpId && d !== supOutboxEntry.id);
            if (combinedSupDeps.length > 0) {
              supOutboxEntry.dependsOn = combinedSupDeps;
            }
            outboxStore.put(supOutboxEntry);

            // Step E: Create Supplier Transaction (DEBIT)
            const primaryRef =
              params.referenceId || params.bankakTransactionId || params.checkNumber || params.transferReference || voucherNumber;
            const defaultNotes =
              actualAllocations.length > 0
                ? `سداد مخصص لـ ${actualAllocations.length} فاتورة شراء (${params.paymentMethod})`
                : `سداد دفعة على الحساب (${params.paymentMethod})`;

            const paymentTx: SupplierTransaction = {
              id: paymentId,
              supplierId: supplier.id,
              type: 'PAYMENT',
              referenceId: primaryRef,
              invoiceNumber: actualAllocations.length === 1 ? actualAllocations[0].invoiceNumber : undefined,
              voucherNumber,
              amount: paymentAmount,
              effect: 'DEBIT',
              debit: paymentAmount,
              credit: 0,
              balanceAfter: newBalance,
              paymentMethod: params.paymentMethod,
              bankakTransactionId: params.bankakTransactionId,
              checkNumber: params.checkNumber,
              checkDueDate: params.checkDueDate,
              transferReference: params.transferReference,
              invoiceAllocations: actualAllocations,
              date: params.paymentDate || todayStr,
              timestamp: nowIso,
              notes: params.notes || defaultNotes,
              employeeName,
              deviceId,
              synced: 0
            };
            stStore.put(paymentTx);

            const stOutboxId = generateUUID();
            const stDeps = Array.from(new Set([...unsyncedSupplierCreateOpIds, ...allocatedInvCreateDeps]));
            outboxStore.put({
              id: stOutboxId,
              operationId: stOutboxId,
              idempotencyKey: `supplier_transaction:CREATE:${paymentTx.id}`,
              ...(knownBranchId ? { branchId: knownBranchId } : {}),
              ...(knownActorUid ? { actorUid: knownActorUid } : {}),
              schemaVersion: 1,
              ...(stDeps.length > 0 ? { dependsOn: stDeps } : {}),
              entityType: 'supplier_transaction',
              entityId: paymentTx.id,
              action: 'CREATE',
              payload: paymentTx,
              timestamp: nowIso,
              retryCount: 0,
              attempts: 0,
              status: 'pending'
            });

            finalResult = {
              transaction: paymentTx,
              supplier: updatedSupplier,
              updatedSupplier,
              updatedInvoices: updatedInvoicesList,
              invoiceUpdates: updatedInvoicesList
            };
          } catch (err) {
            abortWith(err, 'فشلت معاملة تسجيل سند الصرف للمورد');
          }
        };

        const invIndex = invStore.index('supplierId');
        const invReq = invIndex.getAll(params.supplierId);
        invReq.onerror = () => abortWith(invReq.error, 'تعذر قراءة فواتير المورد');
        invReq.onsuccess = () => {
          allInvoices = invReq.result || [];
          invLoaded = true;
          tryProceed();
        };

        const outboxReq = outboxStore.getAll();
        outboxReq.onerror = () => abortWith(outboxReq.error, 'تعذر قراءة طابور Outbox داخل معاملة السداد');
        outboxReq.onsuccess = () => {
          existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
          outboxLoaded = true;
          tryProceed();
        };
      };
    };

    tx.oncomplete = () => {
      if (finalResult) {
        resolve(finalResult);
      } else {
        reject(abortReason || new Error('فشلت معاملة تسجيل سند الصرف للمورد'));
      }
    };
    tx.onerror = () => {
      reject(abortReason || tx.error || new Error('فشلت معاملة تسجيل سند الصرف للمورد'));
    };
    tx.onabort = () => {
      reject(abortReason || new Error('تم إلغاء تسجيل السداد لضمان سلامة وتكامل البيانات'));
    };
  });
}

export interface ReversePaymentParams {
  transactionId: string;
  reason?: string;
  employeeName: string;
}

/**
 * REVERSE SUPPLIER PAYMENT (COMPENSATING ACCOUNTING ADJUSTMENT)
 * Deterministic reversal ID prevents duplicate accounting postings across retries/concurrency.
 * Local `originalTx.isReversal` is updated in IndexedDB ONLY (ZERO supplier_transaction:UPDATE outbox).
 */
export async function reverseSupplierPayment(params: ReversePaymentParams): Promise<{
  reversalTransaction: SupplierTransaction;
  originalTransaction: SupplierTransaction;
  supplier?: Supplier;
  restoredInvoices?: PurchaseInvoice[];
}> {
  const txId = typeof params?.transactionId === 'string' ? params.transactionId.trim() : '';
  if (!txId) {
    throw new Error('معرف سند الصرف مطلوب للإلغاء');
  }

  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['suppliers', 'supplier_transactions', 'purchase_invoices', 'outbox']);
  const nowIso = new Date().toISOString();
  const todayStr = nowIso.split('T')[0];
  const deviceId = getDeviceId();
  const knownBranchId = getKnownActiveBranchId();
  const knownActorUid = getKnownActiveActorId();
  const deterministicReversalId = deriveSupplierPaymentReversalId(txId);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ['suppliers', 'supplier_transactions', 'purchase_invoices', 'outbox'],
      'readwrite'
    );

    const supStore = tx.objectStore('suppliers');
    const stStore = tx.objectStore('supplier_transactions');
    const invStore = tx.objectStore('purchase_invoices');
    const outboxStore = tx.objectStore('outbox');

    let abortReason: Error | null = null;
    let finalResult: {
      reversalTransaction: SupplierTransaction;
      originalTransaction: SupplierTransaction;
      supplier?: Supplier;
      restoredInvoices?: PurchaseInvoice[];
    } | null = null;

    const abortWith = (err: unknown, fallback: string) => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(fallback);
      }
      try {
        tx.abort();
      } catch {
        // ignore abort error
      }
    };

    const originalReq = stStore.get(txId);
    const revByIdReq = stStore.get(deterministicReversalId);
    const refIndex = stStore.index('referenceId');
    const byRefReq = refIndex.getAll(txId);
    const outboxReq = outboxStore.getAll();

    let origLoaded = false;
    let revByIdLoaded = false;
    let byRefLoaded = false;
    let outboxLoaded = false;
    let originalTx: SupplierTransaction | undefined;
    let existingByRevId: SupplierTransaction | undefined;
    let existingByRef: SupplierTransaction[] = [];
    let existingOutboxEntries: OutboxEntry[] = [];
    let proceeded = false;

    const tryProceed = () => {
      if (proceeded || !origLoaded || !revByIdLoaded || !byRefLoaded || !outboxLoaded) return;
      proceeded = true;

      if (!originalTx) {
        abortWith(new Error('سند الصرف المطلوب إلغاؤه غير موجود'), 'السند غير موجود');
        return;
      }
      if (originalTx.type !== 'PAYMENT') {
        abortWith(new Error('يمكن إلغاء سندات الصرف (PAYMENT) فقط عبر هذه الدالة'), 'نوع السند غير صالح');
        return;
      }

      const matchingIndexReversals = existingByRef.filter(
        (t) =>
          t &&
          t.type === 'ADJUSTMENT' &&
          (t.reversedTxId === originalTx!.id || (t.isReversal === true && t.referenceId === originalTx!.id))
      );

      // Collision detection on deterministic reversal ID
      if (existingByRevId) {
        const isExactIdemReversal =
          existingByRevId.type === 'ADJUSTMENT' &&
          existingByRevId.supplierId === originalTx.supplierId &&
          existingByRevId.reversedTxId === originalTx.id &&
          Number(existingByRevId.amount) === Number(originalTx.amount);

        if (!isExactIdemReversal) {
          abortWith(
            new Error(
              `REVERSAL_ID_COLLISION: المعرف الحتمي للقيد العكسي "${deterministicReversalId}" مستخدم لسجل مختلف`
            ),
            'REVERSAL_ID_COLLISION'
          );
          return;
        }
      }

      const nonCanonicalReversal = matchingIndexReversals.find((t) => t.id !== deterministicReversalId);
      if (nonCanonicalReversal) {
        abortWith(
          new Error(
            `REVERSAL_ID_COLLISION: يوجد قيد عكسي سابق بمعرف مختلف (${nonCanonicalReversal.id}) للسند "${originalTx.id}"`
          ),
          'REVERSAL_ID_COLLISION'
        );
        return;
      }

      // True zero-write idempotent return if deterministic reversal already exists
      if (existingByRevId) {
        const supIdemReq = supStore.get(originalTx.supplierId);
        supIdemReq.onerror = () => abortWith(supIdemReq.error, 'تعذر قراءة بيانات المورد');
        supIdemReq.onsuccess = () => {
          finalResult = {
            reversalTransaction: existingByRevId!,
            originalTransaction: originalTx!,
            supplier: supIdemReq.result,
            restoredInvoices: []
          };
        };
        return;
      }

      if (originalTx.isReversal) {
        abortWith(
          new Error('هذا السند ملغي مسبقاً بموجب قيد عكسي ولا يمكن تكرار إلغائه'),
          'السند ملغي مسبقاً'
        );
        return;
      }

      // Load supplier and all allocated invoices before writing
      const supReq = supStore.get(originalTx.supplierId);
      supReq.onerror = () => abortWith(supReq.error, 'تعذر قراءة المورد المرتبط بالسند');
      supReq.onsuccess = () => {
        const supplier: Supplier | undefined = supReq.result;
        if (!supplier) {
          abortWith(new Error('المورد المرتبط بالسند غير موجود'), 'المورد غير موجود');
          return;
        }

        const allocs = Array.isArray(originalTx!.invoiceAllocations) ? originalTx!.invoiceAllocations : [];
        const uniqueInvIds = Array.from(
          new Set(allocs.map((a) => a.invoiceId).filter((id): id is string => Boolean(id)))
        );
        const loadedInvoices = new Map<string, PurchaseInvoice | undefined>();
        let invPending = uniqueInvIds.length;

        const commitReversal = () => {
          try {
            const outboxDepIndex = buildOutboxDependencyIndex(existingOutboxEntries);
            const unsyncedSupplierCreateOpIds: string[] = [];
            const unsyncedPaymentCreateOpIds: string[] = [];
            for (const e of existingOutboxEntries) {
              if (!e || e.status === 'synced' || e.action !== 'CREATE') continue;
              if (e.entityType === 'supplier' && e.entityId === supplier.id) {
                validateOutboxRecordDependencies(e, outboxDepIndex);
                const opId = getCanonicalOutboxOperationId(e);
                if (opId && !unsyncedSupplierCreateOpIds.includes(opId)) {
                  unsyncedSupplierCreateOpIds.push(opId);
                }
              }
              if (e.entityType === 'supplier_transaction' && e.entityId === originalTx!.id) {
                validateOutboxRecordDependencies(e, outboxDepIndex);
                const opId = getCanonicalOutboxOperationId(e);
                if (opId && !unsyncedPaymentCreateOpIds.includes(opId)) {
                  unsyncedPaymentCreateOpIds.push(opId);
                }
              }
            }

            const restoredInvoicesList: PurchaseInvoice[] = [];
            const restoredInvCreateDeps: string[] = [];
            for (const alloc of allocs) {
              const inv = loadedInvoices.get(alloc.invoiceId);
              if (inv) {
                const newPaid = Math.max(0, Number(((inv.paidAmount || 0) - alloc.amount).toFixed(2)));
                const newRemaining = Math.min(inv.netAmount, Number((inv.netAmount - newPaid).toFixed(2)));
                const newStatus: 'Paid' | 'Partial' | 'Unpaid' =
                  newRemaining >= inv.netAmount - 0.01 ? 'Unpaid' : newPaid > 0 ? 'Partial' : 'Unpaid';

                inv.paidAmount = newPaid;
                inv.remainingAmount = newRemaining;
                inv.paymentStatus = newStatus;
                inv.updatedAt = nowIso;

                invStore.put(inv);
                restoredInvoicesList.push(inv);

                const invCreateDeps: string[] = [];
                for (const e of existingOutboxEntries) {
                  if (
                    e &&
                    e.entityType === 'purchase_invoice' &&
                    e.entityId === inv.id &&
                    e.action === 'CREATE' &&
                    e.status !== 'synced'
                  ) {
                    validateOutboxRecordDependencies(e, outboxDepIndex);
                    const opId = getCanonicalOutboxOperationId(e);
                    if (opId && !invCreateDeps.includes(opId)) {
                      invCreateDeps.push(opId);
                    }
                  }
                }
                restoredInvCreateDeps.push(...invCreateDeps);

                const invOutboxId = generateUUID();
                const invDeps = Array.from(new Set([...invCreateDeps, ...unsyncedSupplierCreateOpIds]));
                outboxStore.put({
                  id: invOutboxId,
                  operationId: invOutboxId,
                  idempotencyKey: `purchase_invoice:UPDATE:${inv.id}:${invOutboxId}`,
                  ...(knownBranchId ? { branchId: knownBranchId } : {}),
                  ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                  schemaVersion: 1,
                  ...(invDeps.length > 0 ? { dependsOn: invDeps } : {}),
                  entityType: 'purchase_invoice',
                  entityId: inv.id,
                  action: 'UPDATE',
                  payload: inv,
                  timestamp: nowIso,
                  retryCount: 0,
                  attempts: 0,
                  status: 'pending'
                });
              }
            }

            // Update supplier balance (Increases liability back)
            const previousBalance = supplier.balance || 0;
            const newBalance = Number((previousBalance + originalTx!.amount).toFixed(2));
            const updatedSupplier: Supplier = {
              ...supplier,
              balance: newBalance,
              updatedAt: nowIso
            };
            supStore.put(updatedSupplier);

            const { targetEntry: supOutboxEntry } = resolveSupplierOutboxWrite({
              existingEntries: existingOutboxEntries,
              supplier: updatedSupplier,
              actuallyNew: false,
              allowCoalesceCreate: false,
              knownBranchId,
              knownActorUid,
              nowIso
            });
            const supOpId = getCanonicalOutboxOperationId(supOutboxEntry);
            const existingSupDeps = Array.isArray(supOutboxEntry.dependsOn)
              ? normalizeDependsOnArray(supOutboxEntry.dependsOn, outboxDepIndex)
              : [];
            const combinedSupDeps = Array.from(
              new Set([...existingSupDeps, ...unsyncedSupplierCreateOpIds])
            ).filter((d) => d !== supOpId && d !== supOutboxEntry.id);
            if (combinedSupDeps.length > 0) {
              supOutboxEntry.dependsOn = combinedSupDeps;
            }
            outboxStore.put(supOutboxEntry);

            // Mark original transaction as reversed locally in IndexedDB ONLY (zero supplier_transaction:UPDATE outbox)
            originalTx!.isReversal = true;
            originalTx!.notes = (originalTx!.notes || '') + ` [تم إلغاؤه بقيد عكسي في ${todayStr}]`;
            stStore.put(originalTx!);

            // Create Compensating Adjustment Transaction with deterministic reversal ID
            const reversalTx: SupplierTransaction = {
              id: deterministicReversalId,
              supplierId: supplier.id,
              type: 'ADJUSTMENT',
              referenceId: originalTx!.id,
              voucherNumber: 'REV-' + (originalTx!.voucherNumber || originalTx!.id.slice(0, 8)),
              amount: originalTx!.amount,
              effect: 'CREDIT',
              credit: originalTx!.amount,
              debit: 0,
              balanceAfter: newBalance,
              date: todayStr,
              timestamp: nowIso,
              notes: `إلغاء قيد سند الصرف #${originalTx!.voucherNumber || originalTx!.id}: ${params.reason || 'إلغاء محاسبي معتمد'}`,
              employeeName: params.employeeName || 'المسؤول',
              deviceId,
              synced: 0,
              isReversal: true,
              reversedTxId: originalTx!.id
            };
            stStore.put(reversalTx);

            const revOutboxId = generateUUID();
            const revDeps = Array.from(
              new Set([...unsyncedSupplierCreateOpIds, ...unsyncedPaymentCreateOpIds, ...restoredInvCreateDeps])
            );
            outboxStore.put({
              id: revOutboxId,
              operationId: revOutboxId,
              idempotencyKey: `supplier_transaction:CREATE:${reversalTx.id}`,
              ...(knownBranchId ? { branchId: knownBranchId } : {}),
              ...(knownActorUid ? { actorUid: knownActorUid } : {}),
              schemaVersion: 1,
              ...(revDeps.length > 0 ? { dependsOn: revDeps } : {}),
              entityType: 'supplier_transaction',
              entityId: reversalTx.id,
              action: 'CREATE',
              payload: JSON.parse(JSON.stringify(reversalTx)),
              timestamp: nowIso,
              retryCount: 0,
              attempts: 0,
              status: 'pending'
            });

            finalResult = {
              reversalTransaction: reversalTx,
              originalTransaction: originalTx!,
              supplier: updatedSupplier,
              restoredInvoices: restoredInvoicesList
            };
          } catch (err) {
            abortWith(err, 'فشل إلغاء سند الصرف');
          }
        };

        if (invPending === 0) {
          commitReversal();
        } else {
          for (const invId of uniqueInvIds) {
            const invReq = invStore.get(invId);
            invReq.onerror = () => abortWith(invReq.error, `تعذر قراءة الفاتورة ${invId}`);
            invReq.onsuccess = () => {
              loadedInvoices.set(invId, invReq.result as PurchaseInvoice | undefined);
              invPending--;
              if (invPending === 0) {
                commitReversal();
              }
            };
          }
        }
      };
    };

    originalReq.onerror = () => abortWith(originalReq.error, 'تعذر قراءة سند الصرف الأصلي');
    originalReq.onsuccess = () => {
      originalTx = originalReq.result as SupplierTransaction | undefined;
      origLoaded = true;
      tryProceed();
    };

    revByIdReq.onerror = () => abortWith(revByIdReq.error, 'تعذر التحقق من المعرف الحتمي للقيد العكسي');
    revByIdReq.onsuccess = () => {
      existingByRevId = revByIdReq.result as SupplierTransaction | undefined;
      revByIdLoaded = true;
      tryProceed();
    };

    byRefReq.onerror = () => abortWith(byRefReq.error, 'تعذر فحص القيود العكسية المرتبطة بالسند');
    byRefReq.onsuccess = () => {
      existingByRef = (byRefReq.result as SupplierTransaction[]) || [];
      byRefLoaded = true;
      tryProceed();
    };

    outboxReq.onerror = () => abortWith(outboxReq.error, 'تعذر قراءة طابور Outbox داخل القيد العكسي');
    outboxReq.onsuccess = () => {
      existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryProceed();
    };

    tx.oncomplete = () => {
      if (finalResult) {
        resolve(finalResult);
      } else {
        reject(abortReason || new Error('فشل إلغاء سند الصرف'));
      }
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل إلغاء سند الصرف'));
    tx.onabort = () => reject(abortReason || new Error('تم إلغاء المعاملة'));
  });
}

/**
 * REVIEW & POST OPENING BALANCE MIGRATION
 * Audits and officially posts legacy balance to supplier ledger.
 * Prevents duplicate conversion via openingBalanceReviewed flag.
 */
export async function reviewAndPostOpeningBalance(
  supplierId: string,
  employeeName: string = 'المسؤول',
  notes?: string
): Promise<{ transaction?: SupplierTransaction; supplier: Supplier }> {
  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['suppliers', 'supplier_transactions', 'outbox']);
  const nowIso = new Date().toISOString();
  const todayStr = nowIso.split('T')[0];
  const deviceId = getDeviceId();
  const knownBranchId = getKnownActiveBranchId();
  const knownActorUid = getKnownActiveActorId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['suppliers', 'supplier_transactions', 'outbox'], 'readwrite');
    const supStore = tx.objectStore('suppliers');
    const stStore = tx.objectStore('supplier_transactions');
    const outboxStore = tx.objectStore('outbox');

    let abortReason: Error | null = null;
    let supLoaded = false;
    let outboxLoaded = false;
    let supplier: Supplier | undefined;
    let existingOutboxEntries: OutboxEntry[] = [];
    let finalized = false;
    let finalResult: { transaction?: SupplierTransaction; supplier: Supplier } | null = null;

    const abortWith = (err: unknown, fallback: string) => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(fallback);
      }
      try {
        tx.abort();
      } catch {
        // ignore abort error
      }
    };

    const tryProceed = () => {
      if (finalized || !supLoaded || !outboxLoaded) return;
      finalized = true;

      if (!supplier) {
        abortWith(new Error('المورد غير موجود'), 'المورد غير موجود');
        return;
      }
      if (supplier.archived === true || supplier.status === 'archived') {
        abortWith(
          new Error(`COMMERCIAL_TARGET_ARCHIVED: المورد "${supplier.name?.ar || supplier.id}" مؤرشف ولا يمكن ترحيل رصيد افتتاحي له`),
          'المورد مؤرشف'
        );
        return;
      }
      if (supplier.openingBalanceReviewed) {
        abortWith(new Error('تم اعتماد وترحيل الرصيد الافتتاحي لهذا المورد مسبقاً'), 'تم اعتماد الرصيد مسبقاً');
        return;
      }

      try {
        const outboxDepIndex = buildOutboxDependencyIndex(existingOutboxEntries);
        const unsyncedSupplierCreateOpIds: string[] = [];
        for (const e of existingOutboxEntries) {
          if (
            e &&
            e.entityType === 'supplier' &&
            e.entityId === supplier.id &&
            e.action === 'CREATE' &&
            e.status !== 'synced'
          ) {
            validateOutboxRecordDependencies(e, outboxDepIndex);
            const opId = getCanonicalOutboxOperationId(e);
            if (opId && !unsyncedSupplierCreateOpIds.includes(opId)) {
              unsyncedSupplierCreateOpIds.push(opId);
            }
          }
        }

        const legacyAmount = Number(supplier.legacyBalance ?? supplier.balance ?? 0);

        const updatedSupplier: Supplier = {
          ...supplier,
          openingBalanceReviewed: true,
          updatedAt: nowIso
        };
        supStore.put(updatedSupplier);

        const { targetEntry: supOutboxEntry } = resolveSupplierOutboxWrite({
          existingEntries: existingOutboxEntries,
          supplier: updatedSupplier,
          actuallyNew: false,
          allowCoalesceCreate: false,
          knownBranchId,
          knownActorUid,
          nowIso
        });
        const supOpId = getCanonicalOutboxOperationId(supOutboxEntry);
        const existingSupDeps = Array.isArray(supOutboxEntry.dependsOn)
          ? normalizeDependsOnArray(supOutboxEntry.dependsOn, outboxDepIndex)
          : [];
        const combinedSupDeps = Array.from(
          new Set([...existingSupDeps, ...unsyncedSupplierCreateOpIds])
        ).filter((d) => d !== supOpId && d !== supOutboxEntry.id);
        if (combinedSupDeps.length > 0) {
          supOutboxEntry.dependsOn = combinedSupDeps;
        }
        outboxStore.put(supOutboxEntry);

        let openingTx: SupplierTransaction | undefined;
        if (legacyAmount > 0) {
          const txId = generateUUID();
          openingTx = {
            id: txId,
            supplierId: supplier.id,
            type: 'OPENING_BALANCE',
            referenceId: 'LEGACY-OB-' + supplier.id.slice(0, 6).toUpperCase(),
            voucherNumber: 'OB-' + todayStr.replace(/-/g, '') + '-' + supplier.id.slice(0, 4).toUpperCase(),
            amount: legacyAmount,
            effect: 'CREDIT',
            credit: legacyAmount,
            debit: 0,
            balanceAfter: Number((supplier.balance || 0).toFixed(2)),
            date: todayStr,
            timestamp: nowIso,
            notes: notes || 'اعتماد وترحيل الرصيد الافتتاحي السابق للمورد',
            employeeName,
            deviceId,
            synced: 0
          };
          stStore.put(openingTx);

          const stOutboxId = generateUUID();
          outboxStore.put({
            id: stOutboxId,
            operationId: stOutboxId,
            idempotencyKey: `supplier_transaction:CREATE:${openingTx.id}`,
            ...(knownBranchId ? { branchId: knownBranchId } : {}),
            ...(knownActorUid ? { actorUid: knownActorUid } : {}),
            schemaVersion: 1,
            ...(unsyncedSupplierCreateOpIds.length > 0 ? { dependsOn: [...unsyncedSupplierCreateOpIds] } : {}),
            entityType: 'supplier_transaction',
            entityId: openingTx.id,
            action: 'CREATE',
            payload: openingTx,
            timestamp: nowIso,
            retryCount: 0,
            attempts: 0,
            status: 'pending'
          });
        }

        finalResult = {
          transaction: openingTx,
          supplier: updatedSupplier
        };
      } catch (err) {
        abortWith(err, 'فشل اعتماد الرصيد الافتتاحي');
      }
    };

    const supReq = supStore.get(supplierId);
    supReq.onerror = () => abortWith(supReq.error, 'تعذر قراءة بيانات المورد');
    supReq.onsuccess = () => {
      supplier = supReq.result as Supplier | undefined;
      supLoaded = true;
      tryProceed();
    };

    const outboxReq = outboxStore.getAll();
    outboxReq.onerror = () => abortWith(outboxReq.error, 'تعذر قراءة طابور Outbox للرصيد الافتتاحي');
    outboxReq.onsuccess = () => {
      existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryProceed();
    };

    tx.oncomplete = () => {
      if (finalResult) {
        resolve(finalResult);
      } else {
        reject(abortReason || new Error('فشل اعتماد الرصيد الافتتاحي'));
      }
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل اعتماد الرصيد الافتتاحي'));
    tx.onabort = () => reject(abortReason || new Error('تم إلغاء المعاملة'));
  });
}

export interface SupplierStatementOptions {
  startDate?: string;
  endDate?: string;
  txType?: SupplierTxType | 'ALL';
  searchQuery?: string;
}

export interface StatementRow extends SupplierTransaction {
  runningBalance: number;
  displayDebit: number;
  displayCredit: number;
}

export interface SupplierStatementResult {
  supplier: Supplier;
  startDate?: string;
  endDate?: string;
  openingBalance: number;
  totalPurchases: number;
  totalPayments: number;
  totalReturnsAndAdjustments: number;
  totalDebits: number;
  totalCredits: number;
  netPeriodChange: number;
  closingBalance: number;
  rows: StatementRow[];
  lines: StatementRow[];
  unpaidInvoices: PurchaseInvoice[];
  unpaidInvoicesTotalRemaining: number;
}

/**
 * GENERATE DETAILED SUPPLIER STATEMENT (كشف حساب المورد)
 * Formats every debit and credit with running balance, computes opening & closing balances,
 * and lists outstanding purchase invoices.
 */
export async function getSupplierStatement(
  supplierId: string,
  options: SupplierStatementOptions = {}
): Promise<SupplierStatementResult> {
  const supplier = await getSupplierById(supplierId);
  if (!supplier) {
    throw new Error('المورد غير موجود');
  }

  const allTransactions = await getSupplierTransactions(supplierId);
  const allInvoices = await getSupplierInvoices(supplierId);

  // Chronological sort (oldest to newest)
  const sortedTxs = [...allTransactions].sort((a, b) => {
    const tA = new Date(a.date + ' ' + (a.timestamp ? a.timestamp.split('T')[1] : '00:00:00')).getTime();
    const tB = new Date(b.date + ' ' + (b.timestamp ? b.timestamp.split('T')[1] : '00:00:00')).getTime();
    return tA - tB;
  });

  const { startDate, endDate, txType = 'ALL', searchQuery = '' } = options;
  const q = searchQuery.trim().toLowerCase();

  // Check if an explicit OPENING_BALANCE transaction exists in the ledger
  const hasOpeningTx = sortedTxs.some(t => t.type === 'OPENING_BALANCE');
  
  // Baseline initial balance: If no official OPENING_BALANCE transaction was posted yet,
  // but the supplier has a legacy balance recorded, that legacy balance forms the baseline opening balance.
  // When an OPENING_BALANCE transaction is formally posted, hasOpeningTx is true,
  // so the transaction itself appears as a row in the ledger and unmigratedLegacyBalance is 0 (preventing double counting).
  const unmigratedLegacyBalance = (!hasOpeningTx && supplier.legacyBalance) ? Number(supplier.legacyBalance) : 0;

  // Compute opening balance before startDate
  let calculatedOpeningBalance = unmigratedLegacyBalance;

  if (startDate) {
    sortedTxs.forEach((tx) => {
      if (tx.date < startDate) {
        if (tx.effect === 'CREDIT') {
          calculatedOpeningBalance += tx.amount;
        } else if (tx.effect === 'DEBIT') {
          calculatedOpeningBalance -= tx.amount;
        }
      }
    });
  }

  // Filter transactions within the selected window
  let running = calculatedOpeningBalance;
  let totalPurchases = 0;
  let totalPayments = 0;
  let totalReturnsAndAdjustments = 0;
  let totalDebits = 0;
  let totalCredits = 0;

  const rows: StatementRow[] = [];

  sortedTxs.forEach((tx) => {
    const inDateRange = (!startDate || tx.date >= startDate) && (!endDate || tx.date <= endDate);
    if (!inDateRange) return;

    if (txType !== 'ALL' && tx.type !== txType) return;

    if (q) {
      const matchVoucher = tx.voucherNumber && tx.voucherNumber.toLowerCase().includes(q);
      const matchInv = tx.invoiceNumber && tx.invoiceNumber.toLowerCase().includes(q);
      const matchNotes = tx.notes && tx.notes.toLowerCase().includes(q);
      const matchMethod = tx.paymentMethod && tx.paymentMethod.toLowerCase().includes(q);
      if (!matchVoucher && !matchInv && !matchNotes && !matchMethod) return;
    }

    const displayDebit = tx.effect === 'DEBIT' ? tx.amount : 0;
    const displayCredit = tx.effect === 'CREDIT' ? tx.amount : 0;

    running += (displayCredit - displayDebit);

    totalDebits += displayDebit;
    totalCredits += displayCredit;

    if (tx.type === 'PURCHASE_INVOICE') {
      totalPurchases += tx.amount;
    } else if (tx.type === 'PAYMENT') {
      totalPayments += tx.amount;
    } else {
      totalReturnsAndAdjustments += tx.amount;
    }

    rows.push({
      ...tx,
      runningBalance: Number(running.toFixed(2)),
      displayDebit: Number(displayDebit.toFixed(2)),
      displayCredit: Number(displayCredit.toFixed(2))
    });
  });

  const unpaidInvoices = allInvoices.filter(inv => inv.paymentStatus !== 'Paid' && inv.remainingAmount > 0.01);
  const unpaidInvoicesTotalRemaining = unpaidInvoices.reduce((sum, inv) => sum + (inv.remainingAmount || 0), 0);

  return {
    supplier,
    startDate,
    endDate,
    openingBalance: Number(calculatedOpeningBalance.toFixed(2)),
    totalPurchases: Number(totalPurchases.toFixed(2)),
    totalPayments: Number(totalPayments.toFixed(2)),
    totalReturnsAndAdjustments: Number(totalReturnsAndAdjustments.toFixed(2)),
    totalDebits: Number(totalDebits.toFixed(2)),
    totalCredits: Number(totalCredits.toFixed(2)),
    netPeriodChange: Number((totalCredits - totalDebits).toFixed(2)),
    closingBalance: Number(running.toFixed(2)),
    rows,
    lines: rows,
    unpaidInvoices,
    unpaidInvoicesTotalRemaining: Number(unpaidInvoicesTotalRemaining.toFixed(2))
  };
}

export interface EnrichedSupplierPayment extends SupplierTransaction {
  supplierName?: { ar: string; en: string };
  allocatedInvoicesList?: { invoiceNumber: string; amount: number }[];
}

/**
 * Retrieve all supplier payments across all suppliers
 */
export async function getAllSupplierPayments(): Promise<EnrichedSupplierPayment[]> {
  const db = await openPharmacyDB();
  const suppliers = await getAllSuppliers();
  const supMap = new Map<string, Supplier>();
  suppliers.forEach(s => supMap.set(s.id, s));

  return new Promise((resolve) => {
    const tx = db.transaction('supplier_transactions', 'readonly');
    const store = tx.objectStore('supplier_transactions');
    const req = store.getAll();
    req.onsuccess = () => {
      const list: SupplierTransaction[] = req.result || [];
      const payments = list
        .filter(t => t.type === 'PAYMENT')
        .map(p => {
          const sup = supMap.get(p.supplierId);
          return {
            ...p,
            supplierName: sup ? sup.name : { ar: 'مورد غير معروف', en: 'Unknown Supplier' },
            allocatedInvoicesList: p.invoiceAllocations ? p.invoiceAllocations.map(a => ({ invoiceNumber: a.invoiceNumber, amount: a.amount })) : []
          };
        })
        .sort((a, b) => new Date(b.timestamp || b.date).getTime() - new Date(a.timestamp || a.date).getTime());
      resolve(payments);
    };
    req.onerror = () => resolve([]);
  });
}

/**
 * Retrieve a specific payment voucher by ID
 */
export async function getSupplierPaymentById(id: string): Promise<EnrichedSupplierPayment | null> {
  const db = await openPharmacyDB();
  return new Promise((resolve) => {
    const tx = db.transaction('supplier_transactions', 'readonly');
    const store = tx.objectStore('supplier_transactions');
    const req = store.get(id);
    req.onsuccess = async () => {
      const p: SupplierTransaction | undefined = req.result;
      if (!p) {
        resolve(null);
        return;
      }
      const sup = await getSupplierById(p.supplierId);
      resolve({
        ...p,
        supplierName: sup ? sup.name : { ar: 'مورد غير معروف', en: 'Unknown Supplier' },
        allocatedInvoicesList: p.invoiceAllocations ? p.invoiceAllocations.map(a => ({ invoiceNumber: a.invoiceNumber, amount: a.amount })) : []
      });
    };
    req.onerror = () => resolve(null);
  });
}

export interface SupplierFinancialReport {
  totalLiabilities: number;
  totalSuppliersCount: number;
  activeSuppliersCount: number;
  totalPaymentsInPeriod: number;
  totalPurchasesInPeriod: number;
  unpaidInvoicesCount: number;
  unpaidInvoicesAmount: number;
  partiallyPaidInvoicesCount: number;
  topSuppliersByDebt: { supplierId: string; supplierName: string; balance: number; terms: string }[];
}

/**
 * GENERATE SUPPLIER LIABILITIES & FINANCIAL SUMMARY REPORT
 */
export async function getSupplierFinancialReports(startDate?: string, endDate?: string): Promise<SupplierFinancialReport> {
  const suppliers = await getAllSuppliers();
  const invoices = await getAllPurchaseInvoices();
  const allPayments = await getAllSupplierPayments();

  let totalLiabilities = 0;
  let activeSuppliersCount = 0;

  suppliers.forEach((s) => {
    if (s.balance > 0) totalLiabilities += s.balance;
    if (s.status !== 'inactive') activeSuppliersCount++;
  });

  const filteredInvoices = invoices.filter(inv => {
    if (startDate && inv.date < startDate) return false;
    if (endDate && inv.date > endDate) return false;
    return true;
  });

  const filteredPayments = allPayments.filter(p => {
    if (startDate && p.date < startDate) return false;
    if (endDate && p.date > endDate) return false;
    return true;
  });

  const totalPurchasesInPeriod = filteredInvoices.reduce((sum, inv) => sum + (inv.netAmount || 0), 0);
  const totalPaymentsInPeriod = filteredPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

  const unpaidInvoices = invoices.filter(inv => inv.paymentStatus === 'Unpaid');
  const partiallyPaidInvoices = invoices.filter(inv => inv.paymentStatus === 'Partial');

  const unpaidInvoicesAmount = invoices.reduce((sum, inv) => sum + (inv.remainingAmount || 0), 0);

  const topSuppliersByDebt = [...suppliers]
    .sort((a, b) => (b.balance || 0) - (a.balance || 0))
    .slice(0, 5)
    .map(s => ({
      supplierId: s.id,
      supplierName: s.name?.ar || s.name?.en || s.id,
      balance: s.balance || 0,
      terms: s.terms || 'Net 30'
    }));

  return {
    totalLiabilities: Number(totalLiabilities.toFixed(2)),
    totalSuppliersCount: suppliers.length,
    activeSuppliersCount,
    totalPaymentsInPeriod: Number(totalPaymentsInPeriod.toFixed(2)),
    totalPurchasesInPeriod: Number(totalPurchasesInPeriod.toFixed(2)),
    unpaidInvoicesCount: unpaidInvoices.length,
    unpaidInvoicesAmount: Number(unpaidInvoicesAmount.toFixed(2)),
    partiallyPaidInvoicesCount: partiallyPaidInvoices.length,
    topSuppliersByDebt
  };
}

export { downloadSupplierStatementPdf } from './statementPdf';

// ============================================================================
// PHASE 4: SUPPLIER INVOICE OCR DRAFTS & LOCAL STORAGE ENGINE
// ============================================================================

const OCR_FORBIDDEN_APPROVAL_KEYS = [
  'approval',
  'approvedBy',
  'approvedByRole',
  'approvedAt',
  'approvedCanonicalHash',
  'approvedBranchId',
  'approvalStatus',
  'approvalVersion'
] as const;

function stripOcrDraftApprovalFields<T extends Record<string, unknown>>(draftObj: T): T {
  const cleaned: Record<string, unknown> = { ...draftObj };
  for (const key of OCR_FORBIDDEN_APPROVAL_KEYS) {
    delete cleaned[key];
  }
  return cleaned as T;
}

function hasAnyOcrApprovalField(obj: Record<string, unknown> | null | undefined): boolean {
  if (!obj || typeof obj !== 'object') return false;
  return OCR_FORBIDDEN_APPROVAL_KEYS.some(
    (key) => obj[key] !== undefined && obj[key] !== null && obj[key] !== ''
  );
}

function extractFlatOrWrappedFieldValue(field: unknown): unknown {
  if (field && typeof field === 'object' && 'value' in (field as Record<string, unknown>)) {
    return (field as { value: unknown }).value;
  }
  return field;
}

function extractComparableOcrCanonicalState(rawDraft: SupplierInvoiceDraft): string {
  const anyDraft = rawDraft as SupplierInvoiceDraft & Record<string, unknown>;
  const existingHeader: Partial<OcrInvoiceHeader> =
    rawDraft.header && typeof rawDraft.header === 'object' ? rawDraft.header : {};

  const supplierId = String(
    existingHeader.matchedSupplierId ??
      (typeof anyDraft.extractedSupplierId === 'string' && anyDraft.extractedSupplierId.trim()
        ? anyDraft.extractedSupplierId
        : typeof anyDraft.supplierId === 'string' && anyDraft.supplierId.trim()
          ? anyDraft.supplierId
          : '')
  ).trim();

  const invoiceNumber = String(
    (typeof anyDraft.extractedInvoiceNumber === 'string' && anyDraft.extractedInvoiceNumber.trim()
      ? anyDraft.extractedInvoiceNumber
      : typeof anyDraft.invoiceNumber === 'string' && anyDraft.invoiceNumber.trim()
        ? anyDraft.invoiceNumber
        : existingHeader.invoiceNumber?.value) ?? ''
  ).trim();

  const invoiceDate = String(
    (typeof anyDraft.extractedInvoiceDate === 'string' && anyDraft.extractedInvoiceDate.trim()
      ? anyDraft.extractedInvoiceDate
      : typeof anyDraft.invoiceDate === 'string' && anyDraft.invoiceDate.trim()
        ? anyDraft.invoiceDate
        : existingHeader.invoiceDate?.value) ?? ''
  ).trim();

  const subtotal =
    anyDraft.extractedSubtotal !== undefined && anyDraft.extractedSubtotal !== null && anyDraft.extractedSubtotal !== ''
      ? String(anyDraft.extractedSubtotal).trim()
      : existingHeader.subtotal?.value !== undefined && existingHeader.subtotal?.value !== null
        ? String(existingHeader.subtotal.value).trim()
        : '';

  const discount =
    anyDraft.extractedDiscount !== undefined && anyDraft.extractedDiscount !== null && anyDraft.extractedDiscount !== ''
      ? String(anyDraft.extractedDiscount).trim()
      : existingHeader.discount?.value !== undefined && existingHeader.discount?.value !== null
        ? String(existingHeader.discount.value).trim()
        : '0';

  const finalTotal =
    anyDraft.extractedTotalAmount !== undefined &&
    anyDraft.extractedTotalAmount !== null &&
    anyDraft.extractedTotalAmount !== ''
      ? String(anyDraft.extractedTotalAmount).trim()
      : existingHeader.finalTotal?.value !== undefined && existingHeader.finalTotal?.value !== null
        ? String(existingHeader.finalTotal.value).trim()
        : '';

  const currency = String(existingHeader.currency?.value || 'SDG').trim();
  const paymentType = String(rawDraft.paymentType || 'Credit').trim();
  const paidAmount =
    rawDraft.paidAmount !== undefined && rawDraft.paidAmount !== null && rawDraft.paidAmount !== ''
      ? String(rawDraft.paidAmount).trim()
      : null;

  const pages = Array.isArray(rawDraft.pages)
    ? rawDraft.pages.map((p, idx) => ({
        id: String(p?.id ?? idx),
        pageNumber: Number(p?.pageNumber ?? idx + 1),
        imageHash: String(p?.imageHash ?? ''),
        rotation: Number(p?.rotation ?? 0)
      }))
    : [];

  const items = Array.isArray(rawDraft.items)
    ? rawDraft.items.map((rawItem) => {
        const anyItem = (rawItem || {}) as OcrInvoiceItem & Record<string, unknown>;
        return {
          id: String(anyItem.id ?? ''),
          matchedMedicineId: String(anyItem.matchedMedicineId ?? '').trim(),
          matchedMedicineName: String(anyItem.matchedMedicineName ?? '').trim(),
          isUserConfirmed: anyItem.isUserConfirmed === true,
          tradeName: String(extractFlatOrWrappedFieldValue(anyItem.tradeName) ?? '').trim(),
          genericName: String(extractFlatOrWrappedFieldValue(anyItem.genericName) ?? '').trim(),
          strength: String(extractFlatOrWrappedFieldValue(anyItem.strength) ?? '').trim(),
          dosageForm: String(extractFlatOrWrappedFieldValue(anyItem.dosageForm) ?? '').trim(),
          releaseType: String(extractFlatOrWrappedFieldValue(anyItem.releaseType) ?? '').trim(),
          concentration: String(extractFlatOrWrappedFieldValue(anyItem.concentration) ?? '').trim(),
          packageSize: String(extractFlatOrWrappedFieldValue(anyItem.packageSize) ?? '').trim(),
          barcode: String(extractFlatOrWrappedFieldValue(anyItem.barcode) ?? '').trim(),
          batchNumber: String(extractFlatOrWrappedFieldValue(anyItem.batchNumber) ?? '').trim(),
          expiryDate: String(extractFlatOrWrappedFieldValue(anyItem.expiryDate) ?? '').trim(),
          quantity: String(extractFlatOrWrappedFieldValue(anyItem.quantity) ?? ''),
          unit: String(extractFlatOrWrappedFieldValue(anyItem.unit) ?? '').trim(),
          unitBuyPrice: String(extractFlatOrWrappedFieldValue(anyItem.unitBuyPrice) ?? ''),
          lineTotal: String(extractFlatOrWrappedFieldValue(anyItem.lineTotal) ?? ''),
          suggestedSellPrice: String(
            extractFlatOrWrappedFieldValue(anyItem.suggestedSellPrice) ?? ''
          ),
          lineDiscount: String(
            extractFlatOrWrappedFieldValue(
              anyItem.itemDiscount ?? anyItem.lineDiscount ?? anyItem.discount
            ) ?? ''
          )
        };
      })
    : [];

  return JSON.stringify({
    id: String(rawDraft.id || ''),
    supplierId,
    supplierName: String(existingHeader.supplierName?.value ?? anyDraft.extractedSupplierName ?? '').trim(),
    invoiceNumber,
    invoiceDate,
    currency,
    subtotal,
    discount,
    finalTotal,
    paymentType,
    paidAmount,
    pages,
    items
  });
}

function haveSameOcrCanonicalFields(
  first: SupplierInvoiceDraft,
  second: SupplierInvoiceDraft
): boolean {
  try {
    return (
      extractComparableOcrCanonicalState(first) ===
      extractComparableOcrCanonicalState(second)
    );
  } catch {
    return false;
  }
}

/**
 * Save or update a supplier invoice OCR draft in IndexedDB.
 * Security guarantees (R13-D.1):
 * - Posted drafts are immutable and cannot be overwritten through generic draft saves.
 * - Cannot promote a draft to VERIFIED or POSTED or forge/modify approval evidence.
 * - Any canonical content edit to a VERIFIED draft atomically invalidates prior approval
 *   and transitions status back to NEEDS_REVIEW.
 * - Non-content UI-only saves on an already-VERIFIED draft preserve existing approval
 *   evidence and updatedAt timestamp without weakening approval integrity.
 */
export async function saveSupplierInvoiceDraft(
  draft: SupplierInvoiceDraft
): Promise<SupplierInvoiceDraft> {
  if (!draft || typeof draft !== 'object' || typeof draft.id !== 'string' || !draft.id.trim()) {
    throw new Error('OCR_INVALID_DRAFT: المسودة غير صالحة للحفظ.');
  }

  const db = await openPharmacyDB();
  const nowIso = new Date().toISOString();

  // Deep clone to strip Vue Proxy wrappers and ensure structured clone safety in IndexedDB
  const incomingDraft = JSON.parse(JSON.stringify(draft)) as SupplierInvoiceDraft &
    Record<string, unknown>;

  return new Promise((resolve, reject) => {
    let settled = false;
    let persistedDraft: SupplierInvoiceDraft | null = null;
    let abortReason: Error | null = null;

    const resolveOnce = (result: SupplierInvoiceDraft) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const rejectOnce = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err || 'OCR_DRAFT_SAVE_FAILED')));
    };

    const tx = db.transaction('supplier_invoice_drafts', 'readwrite');
    const store = tx.objectStore('supplier_invoice_drafts');

    const abortWith = (err: unknown) => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(String(err || 'OCR_DRAFT_SAVE_ABORTED'));
      }
      try {
        tx.abort();
      } catch {
        rejectOnce(abortReason);
      }
    };

    tx.oncomplete = () => {
      if (persistedDraft) {
        // Keep caller's object aligned with persisted state
        draft.status = persistedDraft.status;
        draft.updatedAt = persistedDraft.updatedAt;
        draft.createdAt = persistedDraft.createdAt;
        if (persistedDraft.approval) {
          draft.approval = persistedDraft.approval;
          draft.approvedBy = persistedDraft.approvedBy;
          draft.approvedByRole = persistedDraft.approvedByRole;
          draft.approvedAt = persistedDraft.approvedAt;
          draft.approvedCanonicalHash = persistedDraft.approvedCanonicalHash;
          draft.approvedBranchId = persistedDraft.approvedBranchId;
          draft.approvalStatus = persistedDraft.approvalStatus;
          draft.approvalVersion = persistedDraft.approvalVersion;
        } else {
          delete draft.approval;
          delete draft.approvedBy;
          delete draft.approvedByRole;
          delete draft.approvedAt;
          delete draft.approvedCanonicalHash;
          delete draft.approvedBranchId;
          delete draft.approvalStatus;
          delete draft.approvalVersion;
        }
        resolveOnce(persistedDraft);
        return;
      }
      rejectOnce(abortReason || new Error('OCR_DRAFT_SAVE_COMPLETED_WITHOUT_RESULT'));
    };

    tx.onerror = () => rejectOnce(abortReason || tx.error || new Error('OCR_DRAFT_SAVE_ERROR'));
    tx.onabort = () => rejectOnce(abortReason || tx.error || new Error('OCR_DRAFT_SAVE_ABORTED'));

    const existingReq = store.get(incomingDraft.id);
    existingReq.onerror = (event) => {
      event?.preventDefault?.();
      abortWith(existingReq.error || new Error('OCR_DRAFT_READ_FAILED'));
    };
    existingReq.onsuccess = () => {
      try {
        const existingDraft = (existingReq.result as (SupplierInvoiceDraft & Record<string, unknown>) | undefined) ?? null;

        if (
          existingDraft &&
          (existingDraft.status === 'POSTED' ||
            (typeof existingDraft.postedInvoiceId === 'string' &&
              existingDraft.postedInvoiceId.trim().length > 0))
        ) {
          throw new Error(
            'OCR_POSTED_DRAFT_IMMUTABLE: لا يمكن تعديل مسودة فاتورة تم ترحيلها مسبقاً.'
          );
        }

        if (incomingDraft.status === 'POSTED') {
          throw new Error(
            'OCR_DIRECT_POSTED_STATUS_FORBIDDEN: لا يُسمح بتعيين حالة POSTED مباشرة عبر حفظ المسودة.'
          );
        }

        const existingWasVerified = Boolean(
          existingDraft && existingDraft.status === 'VERIFIED' && existingDraft.approval
        );

        let nextDraft: SupplierInvoiceDraft & Record<string, unknown>;

        if (existingWasVerified && existingDraft) {
          const sameCanonical = haveSameOcrCanonicalFields(existingDraft, incomingDraft);
          const callerKeptVerified = incomingDraft.status === 'VERIFIED';

          if (sameCanonical && callerKeptVerified) {
            // Non-content UI-only save: preserve immutable stored approval evidence and updatedAt
            const cleanedIncoming = stripOcrDraftApprovalFields(incomingDraft);
            nextDraft = {
              ...cleanedIncoming,
              status: 'VERIFIED',
              createdAt: existingDraft.createdAt || incomingDraft.createdAt || nowIso,
              updatedAt: existingDraft.updatedAt,
              approval: existingDraft.approval,
              approvedBy: existingDraft.approval!.approvedBy,
              approvedByRole: existingDraft.approval!.approvedByRole,
              approvedAt: existingDraft.approval!.approvedAt,
              approvedCanonicalHash: existingDraft.approval!.approvedCanonicalHash,
              approvedBranchId: existingDraft.approval!.approvedBranchId,
              approvalStatus: 'APPROVED',
              approvalVersion: existingDraft.approval!.approvalVersion
            };
          } else {
            // Canonical content changed or caller explicitly downgraded status -> invalidate approval
            const cleanedIncoming = stripOcrDraftApprovalFields(incomingDraft);
            nextDraft = {
              ...cleanedIncoming,
              status: incomingDraft.status === 'VERIFIED' ? 'NEEDS_REVIEW' : incomingDraft.status,
              createdAt: existingDraft.createdAt || incomingDraft.createdAt || nowIso,
              updatedAt: nowIso
            };
          }
        } else {
          // Stored draft was NOT VERIFIED: forbid direct promotion to VERIFIED or forging approval fields
          if (incomingDraft.status === 'VERIFIED' || hasAnyOcrApprovalField(incomingDraft)) {
            throw new Error(
              'OCR_DIRECT_APPROVAL_WRITE_FORBIDDEN: لا يُسمح باعتماد المسودة أو كتابة بيانات الاعتماد مباشرة عبر حفظ المسودة؛ يجب استخدام مسار الاعتماد الموثق.'
            );
          }

          const cleanedIncoming = stripOcrDraftApprovalFields(incomingDraft);
          nextDraft = {
            ...cleanedIncoming,
            createdAt: existingDraft?.createdAt || incomingDraft.createdAt || nowIso,
            updatedAt: nowIso
          };
        }

        const putReq = store.put(nextDraft);
        putReq.onerror = (event) => {
          event?.preventDefault?.();
          abortWith(putReq.error || new Error('OCR_DRAFT_WRITE_FAILED'));
        };
        putReq.onsuccess = () => {
          persistedDraft = nextDraft;
        };
      } catch (err) {
        abortWith(err);
      }
    };
  });
}

/**
 * Retrieve a supplier invoice OCR draft by ID
 */
export async function getSupplierInvoiceDraft(id: string): Promise<SupplierInvoiceDraft | null> {
  const db = await openPharmacyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('supplier_invoice_drafts', 'readonly');
    const store = tx.objectStore('supplier_invoice_drafts');
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Retrieve all supplier invoice OCR drafts, sorted by updatedAt descending
 */
export async function getAllSupplierInvoiceDrafts(): Promise<SupplierInvoiceDraft[]> {
  const db = await openPharmacyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('supplier_invoice_drafts', 'readonly');
    const store = tx.objectStore('supplier_invoice_drafts');
    const req = store.getAll();
    req.onsuccess = () => {
      const list: SupplierInvoiceDraft[] = req.result || [];
      list.sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete a supplier invoice OCR draft by ID
 */
export async function deleteSupplierInvoiceDraft(id: string): Promise<boolean> {
  const db = await openPharmacyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('supplier_invoice_drafts', 'readwrite');
    const store = tx.objectStore('supplier_invoice_drafts');
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Check if an image hash already exists in any draft or page (Layer 1 Deduplication)
 */
export async function findDraftByImageHash(imageHash: string, excludeDraftId?: string): Promise<SupplierInvoiceDraft | null> {
  if (!imageHash) return null;
  const drafts = await getAllSupplierInvoiceDrafts();
  for (const draft of drafts) {
    if (excludeDraftId && draft.id === excludeDraftId) continue;
    if (draft.pages && draft.pages.some(p => p.imageHash === imageHash)) {
      return draft;
    }
  }
  return null;
}

/**
 * Check if an invoice number already exists for this supplier (Layer 2 Deduplication)
 * Checks both already-posted purchase invoices and other active drafts!
 */
export async function checkSupplierInvoiceDuplicate(
  supplierId: string,
  invoiceNumber: string,
  excludeDraftId?: string
): Promise<{
  isDuplicate: boolean;
  source: 'POSTED_INVOICE' | 'DRAFT' | null;
  existingId?: string;
  message?: string;
}> {
  if (!supplierId || !invoiceNumber || !invoiceNumber.trim()) {
    return { isDuplicate: false, source: null };
  }

  const cleanNum = invoiceNumber.trim().toLowerCase();

  // 1. Check in already posted purchase invoices
  const postedInvoices = await getAllPurchaseInvoices();
  const matchedPosted = postedInvoices.find(
    inv => inv.supplierId === supplierId && inv.invoiceNumber && inv.invoiceNumber.trim().toLowerCase() === cleanNum
  );

  if (matchedPosted) {
    return {
      isDuplicate: true,
      source: 'POSTED_INVOICE',
      existingId: matchedPosted.id,
      message: `الفاتورة رقم "${invoiceNumber}" مسجلة ومرحلة مسبقاً لهذا المورد بتاريخ ${matchedPosted.date || matchedPosted.createdAt} (كود الفاتورة: ${matchedPosted.id.slice(0, 8)}).`
    };
  }

  // 2. Check in existing drafts
  const drafts = await getAllSupplierInvoiceDrafts();
  const matchedDraft = drafts.find(
    d =>
      (!excludeDraftId || d.id !== excludeDraftId) &&
      d.status !== 'POSTED' &&
      d.header?.matchedSupplierId === supplierId &&
      d.header?.invoiceNumber?.value &&
      d.header.invoiceNumber.value.trim().toLowerCase() === cleanNum
  );

  if (matchedDraft) {
    return {
      isDuplicate: true,
      source: 'DRAFT',
      existingId: matchedDraft.id,
      message: `توجد مسودة مسح ضوئي أخرى بنفس رقم الفاتورة "${invoiceNumber}" قيد المراجعة (معرف المسودة: ${matchedDraft.id.slice(0, 8)}).`
    };
  }

  return { isDuplicate: false, source: null };
}

/**
 * Normalizes a SupplierInvoiceDraft (including UI-bound flat wrapper properties when present)
 * into a pure canonical draft structure without altering draft.status, without deriving or
 * overwriting missing/zero subtotals, without allowing tax participation, and without
 * fabricating invalid unit names or fallback values.
 */
function prepareOcrDraftForCanonicalPosting(
  rawDraft: SupplierInvoiceDraft,
  postingActor: string
): SupplierInvoiceDraft {
  const anyDraft = rawDraft as SupplierInvoiceDraft & Record<string, unknown>;
  const existingHeader: Partial<OcrInvoiceHeader> =
    rawDraft.header && typeof rawDraft.header === 'object' ? rawDraft.header : {};

  const matchedSupplierIdRaw =
    existingHeader.matchedSupplierId ??
    (typeof anyDraft.extractedSupplierId === 'string' && anyDraft.extractedSupplierId.trim()
      ? anyDraft.extractedSupplierId
      : typeof anyDraft.supplierId === 'string' && anyDraft.supplierId.trim()
        ? anyDraft.supplierId
        : undefined);

  const invoiceNumberVal =
    (typeof anyDraft.extractedInvoiceNumber === 'string' && anyDraft.extractedInvoiceNumber.trim()
      ? anyDraft.extractedInvoiceNumber
      : typeof anyDraft.invoiceNumber === 'string' && anyDraft.invoiceNumber.trim()
        ? anyDraft.invoiceNumber
        : existingHeader.invoiceNumber?.value) ?? '';

  const invoiceDateVal =
    (typeof anyDraft.extractedInvoiceDate === 'string' && anyDraft.extractedInvoiceDate.trim()
      ? anyDraft.extractedInvoiceDate
      : typeof anyDraft.invoiceDate === 'string' && anyDraft.invoiceDate.trim()
        ? anyDraft.invoiceDate
        : existingHeader.invoiceDate?.value) ?? '';

  const parseAndPreserveExactDecimalCandidate = (
    raw: unknown,
    fieldName: string,
    opts: { readonly allowZero: boolean; readonly errorCode: string; readonly defaultIfEmptyZero?: boolean }
  ): number | string => {
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (opts.defaultIfEmptyZero) return 0;
      throw new Error(opts.errorCode);
    }
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) {
        throw new Error(opts.errorCode);
      }
      const exactStr = toExactDecimalInputFromNumber(raw, fieldName);
      const rat = parseExactDecimal(exactStr, fieldName);
      const cmp = compareRational(rat, createRational(0n));
      if (opts.allowZero ? cmp < 0 : cmp <= 0) {
        throw new Error(opts.errorCode);
      }
      return raw;
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      const rat = parseExactDecimal(trimmed, fieldName);
      const cmp = compareRational(rat, createRational(0n));
      if (opts.allowZero ? cmp < 0 : cmp <= 0) {
        throw new Error(opts.errorCode);
      }
      return trimmed;
    }
    throw new Error(opts.errorCode);
  };

  const rawDiscountCandidate =
    anyDraft.extractedDiscount !== undefined && anyDraft.extractedDiscount !== null && anyDraft.extractedDiscount !== ''
      ? anyDraft.extractedDiscount
      : existingHeader.discount?.value;
  const discountVal = parseAndPreserveExactDecimalCandidate(rawDiscountCandidate, 'discount', {
    allowZero: true,
    defaultIfEmptyZero: true,
    errorCode: 'OCR_INVALID_SUBTOTAL_OR_DISCOUNT: قيمة خصم الفاتورة غير صالحة.'
  });

  // R13-D.2 C1: Tax is completely excluded from canonical totals, inventory cost, payable, and reconciliation.
  // Never reject an invoice merely because raw OCR/legacy draft metadata contains a non-zero tax value.

  const rawFinalTotalCandidate =
    anyDraft.extractedTotalAmount !== undefined &&
    anyDraft.extractedTotalAmount !== null &&
    anyDraft.extractedTotalAmount !== ''
      ? anyDraft.extractedTotalAmount
      : existingHeader.finalTotal?.value;
  const finalTotalVal = parseAndPreserveExactDecimalCandidate(rawFinalTotalCandidate, 'finalTotal', {
    allowZero: false,
    errorCode:
      'OCR_MISSING_OR_ZERO_FINAL_TOTAL: صافي الفاتورة المطبوع مفقود أو صفري؛ يرجى مراجعته وإدخاله صراحةً قبل الاعتماد.'
  });

  const currencyVal = existingHeader.currency?.value || 'SDG';
  const rawItems = Array.isArray(rawDraft.items) ? rawDraft.items : [];

  const normalizedItems: OcrInvoiceItem[] = rawItems.map((rawItem, idx) => {
    const anyItem = rawItem as OcrInvoiceItem & Record<string, unknown>;
    const extractRequiredField = <T>(
      field: unknown,
      fieldName: string,
      defaultConfidence: ConfidenceLevel = 'HIGH',
      errorCode = 'OCR_MISSING_ITEM_FIELD'
    ): { value: T; confidence: ConfidenceLevel; rawText?: string; isManuallyEdited?: boolean } => {
      if (field && typeof field === 'object' && 'value' in (field as Record<string, unknown>)) {
        const typed = field as {
          value: T;
          confidence?: ConfidenceLevel;
          rawText?: string;
          isManuallyEdited?: boolean;
        };
        if (
          typed.value === undefined ||
          typed.value === null ||
          (typeof typed.value === 'string' && typed.value.trim().length === 0)
        ) {
          throw new Error(`${errorCode}: items[${idx}].${fieldName}`);
        }
        return {
          value: typed.value,
          confidence: typed.confidence || defaultConfidence,
          ...(typed.rawText !== undefined ? { rawText: typed.rawText } : {}),
          ...(typed.isManuallyEdited !== undefined ? { isManuallyEdited: typed.isManuallyEdited } : {})
        };
      }
      if (
        field === undefined ||
        field === null ||
        (typeof field === 'string' && field.trim().length === 0)
      ) {
        throw new Error(`${errorCode}: items[${idx}].${fieldName}`);
      }
      return {
        value: field as T,
        confidence: defaultConfidence
      };
    };

    const tradeNameField = extractRequiredField<string>(anyItem.tradeName, 'tradeName');
    const strengthField = extractRequiredField<string>(
      anyItem.strength,
      'strength',
      'HIGH',
      'OCR_MISSING_MEDICINE_IDENTITY'
    );
    const dosageFormField = extractRequiredField<string>(
      anyItem.dosageForm,
      'dosageForm',
      'HIGH',
      'OCR_MISSING_MEDICINE_IDENTITY'
    );
    const batchNumberField = extractRequiredField<string>(anyItem.batchNumber, 'batchNumber');
    const expiryDateField = extractRequiredField<string>(anyItem.expiryDate, 'expiryDate');
    const quantityField = extractRequiredField<number>(anyItem.quantity, 'quantity');
    const unitField = extractRequiredField<UnitKind>(
      anyItem.unit ?? anyItem.purchaseUnit,
      'unit',
      'HIGH',
      'UNSUPPORTED_ITEM_UNIT'
    );
    const unitBuyPriceField = extractRequiredField<number>(anyItem.unitBuyPrice, 'unitBuyPrice');
    const lineTotalField = extractRequiredField<number>(anyItem.lineTotal, 'lineTotal');

    const optionalWrap = <T>(field: unknown, fieldName: string): { value: T; confidence: ConfidenceLevel } | undefined => {
      if (field === undefined || field === null || field === '') return undefined;
      if (typeof field === 'object' && 'value' in (field as Record<string, unknown>)) {
        const inner = (field as { value: unknown }).value;
        if (inner === undefined || inner === null || inner === '') return undefined;
        return extractRequiredField<T>(field, fieldName);
      }
      return extractRequiredField<T>(field, fieldName);
    };

    return {
      ...rawItem,
      tradeName: tradeNameField,
      genericName: optionalWrap<string>(anyItem.genericName, 'genericName'),
      strength: strengthField,
      dosageForm: dosageFormField,
      releaseType: optionalWrap<string>(anyItem.releaseType, 'releaseType'),
      concentration: optionalWrap<string>(anyItem.concentration, 'concentration'),
      packageSize: optionalWrap<string>(anyItem.packageSize, 'packageSize'),
      manufacturer: optionalWrap<string>(anyItem.manufacturer, 'manufacturer'),
      barcode: optionalWrap<string>(anyItem.barcode, 'barcode'),
      quantity: quantityField,
      unit: unitField,
      unitBuyPrice: unitBuyPriceField,
      itemDiscount: optionalWrap<number>(
        anyItem.itemDiscount ?? anyItem.lineDiscount ?? anyItem.discount,
        'itemDiscount'
      ),
      lineTotal: lineTotalField,
      suggestedSellPrice: optionalWrap<number>(anyItem.suggestedSellPrice, 'suggestedSellPrice'),
      batchNumber: batchNumberField,
      expiryDate: expiryDateField,
      isUserConfirmed: anyItem.isUserConfirmed === true
    };
  });

  // Never silently derive or overwrite a missing or zero subtotal.
  const rawSubtotalCandidate =
    anyDraft.extractedSubtotal !== undefined &&
    anyDraft.extractedSubtotal !== null &&
    anyDraft.extractedSubtotal !== ''
      ? anyDraft.extractedSubtotal
      : existingHeader.subtotal?.value;
  const subtotalVal = parseAndPreserveExactDecimalCandidate(rawSubtotalCandidate, 'subtotal', {
    allowZero: false,
    errorCode:
      'OCR_MISSING_OR_ZERO_SUBTOTAL: الإجمالي الفرعي للفاتورة مفقود أو صفري؛ لا يُسمح باشتقاقه تلقائياً دون مراجعة واعتماد.'
  });

  const normalizedHeader: OcrInvoiceHeader = {
    supplierName: existingHeader.supplierName || { value: '', confidence: 'HIGH' },
    ...(matchedSupplierIdRaw ? { matchedSupplierId: String(matchedSupplierIdRaw) } : {}),
    invoiceNumber: {
      value: String(invoiceNumberVal),
      confidence: existingHeader.invoiceNumber?.confidence || 'HIGH'
    },
    invoiceDate: {
      value: String(invoiceDateVal),
      confidence: existingHeader.invoiceDate?.confidence || 'HIGH'
    },
    ...(existingHeader.taxNumber ? { taxNumber: existingHeader.taxNumber } : {}),
    subtotal: {
      value: subtotalVal,
      confidence: existingHeader.subtotal?.confidence || 'HIGH'
    },
    discount: {
      value: discountVal,
      confidence: existingHeader.discount?.confidence || 'HIGH'
    },
    // Canonical tax is always 0; raw extracted tax is ignored in all calculations.
    tax: {
      value: 0,
      confidence: 'HIGH'
    },
    finalTotal: {
      value: finalTotalVal,
      confidence: existingHeader.finalTotal?.confidence || 'HIGH'
    },
    currency: {
      value: currencyVal,
      confidence: existingHeader.currency?.confidence || 'HIGH'
    }
  };

  // Reject any legacy financial override attempt and never allow mismatch override bypasses.
  const rawAuditRecord = (rawDraft.audit || {}) as unknown as Record<string, unknown>;
  if (
    typeof rawAuditRecord.overrideReason === 'string' &&
    rawAuditRecord.overrideReason.trim().length > 0
  ) {
    throw new Error('OCR_RECONCILIATION_OVERRIDE_FORBIDDEN');
  }
  if (
    typeof anyDraft.financialOverrideReason === 'string' &&
    anyDraft.financialOverrideReason.trim().length > 0
  ) {
    throw new Error('OCR_RECONCILIATION_OVERRIDE_FORBIDDEN');
  }

  const existingAudit = rawDraft.audit || {
    calculatedItemsTotal: 0,
    difference: 0,
    isReconciled: false
  };
  const normalizedAudit = {
    calculatedItemsTotal: existingAudit.calculatedItemsTotal,
    ...(existingAudit.calculatedItemsTotalExact !== undefined
      ? { calculatedItemsTotalExact: existingAudit.calculatedItemsTotalExact }
      : {}),
    difference: existingAudit.difference,
    ...(existingAudit.differenceExact !== undefined
      ? { differenceExact: existingAudit.differenceExact }
      : {}),
    ...(existingAudit.subtotalDifference !== undefined
      ? { subtotalDifference: existingAudit.subtotalDifference }
      : {}),
    ...(existingAudit.subtotalDifferenceExact !== undefined
      ? { subtotalDifferenceExact: existingAudit.subtotalDifferenceExact }
      : {}),
    isReconciled: existingAudit.isReconciled
  };

  // Never auto-promote DRAFT or any other status to NEEDS_REVIEW or VERIFIED.
  return {
    ...rawDraft,
    status: rawDraft.status,
    header: normalizedHeader,
    items: normalizedItems,
    audit: normalizedAudit,
    employeeName: rawDraft.employeeName || postingActor
  };
}

interface TrustedOcrAdminContext {
  readonly uid: string;
  readonly role: OcrTrustedApprovalRole;
  readonly activeBranchId: string;
  readonly branchIds: readonly string[];
}

/**
 * Resolves and strictly validates the trusted authenticated Admin/Super Admin session
 * sourced exclusively from Firebase Auth + server-confirmed Firestore profile state
 * (via applyTrustedActorSessionFromAuth in firebaseAuthService.ts).
 * Never accepts caller-supplied actor UID, display name, or role strings.
 */
function requireTrustedOcrAdminSession(): TrustedOcrAdminContext {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(
      'OCR_AUTH_OFFLINE_FORBIDDEN: يتطلب اعتماد وترحيل فواتير OCR اتصالاً نشطاً بالإنترنت وجلسة مسؤول موثقة.'
    );
  }
  const session = getTrustedActorSessionState();
  if (!session) {
    throw new Error(
      'OCR_AUTH_NOT_AUTHENTICATED: لا توجد جلسة مستخدم موثقة من Firebase Authentication.'
    );
  }
  if (!isValidFirebaseActorUid(session.uid)) {
    throw new Error(
      'OCR_AUTH_UNTRUSTED_SESSION: معرّف المستخدم في الجلسة النشطة غير صالح.'
    );
  }
  if (session.emailVerified !== true) {
    throw new Error(
      'OCR_AUTH_EMAIL_NOT_VERIFIED: يجب التحقق من البريد الإلكتروني للمستخدم قبل اعتماد أو ترحيل الفاتورة.'
    );
  }
  if (isTrustedSessionExpired(session)) {
    throw new Error(
      'OCR_AUTH_SESSION_EXPIRED: انتهت صلاحية جلسة المسؤول؛ يرجى إعادة تسجيل الدخول.'
    );
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
  const knownBranchId = getKnownActiveBranchId();
  const resolvedBranchId =
    typeof (knownBranchId ?? session.activeBranchId) === 'string'
      ? String(knownBranchId ?? session.activeBranchId).trim()
      : '';
  if (!resolvedBranchId || !isBranchAuthorizedForSession(session, resolvedBranchId)) {
    throw new Error(
      'OCR_AUTH_BRANCH_UNAUTHORIZED: المستخدم غير مصرح له بتنفيذ هذه العملية على الفرع النشط أو الفرع غير محدد.'
    );
  }
  return {
    uid: session.uid,
    role: session.role,
    activeBranchId: resolvedBranchId,
    branchIds: session.branchIds
  };
}

function assertNoCallerSuppliedApprovalParams(params: unknown): void {
  if (!params || typeof params !== 'object') return;
  const record = params as Record<string, unknown>;
  for (const key of OCR_FORBIDDEN_APPROVAL_KEYS) {
    if (record[key] !== undefined) {
      throw new Error(
        `OCR_CALLER_APPROVAL_PARAMS_FORBIDDEN: لا يُسمح بتمرير بيانات الاعتماد (${key}) من الجهة المستدعية؛ يتم التحقق من الاعتماد المحفوظ والهوية الموثقة فقط.`
      );
    }
  }
}

function ocrRationalToDisplayCompatibilityNumber(value: Rational, field: string): number {
  const display = formatRationalForDisplay(value, { decimals: 8, roundingMode: 'HALF_UP' });
  if (display.displayNumber !== undefined && Number.isFinite(display.displayNumber)) {
    return display.displayNumber;
  }
  const fallbackNum = Number(display.formatted);
  if (!Number.isFinite(fallbackNum)) {
    throw new Error(`${field} exceeds the safe numeric compatibility range.`);
  }
  return fallbackNum;
}

/**
 * Extracts and validates the persisted approval record from a stored IndexedDB draft
 * BEFORE scheduling the transaction-local 'RESERVED' write.
 * Never reads approval attributes from caller parameters.
 */
function assertStoredOcrDraftApprovalPrecheck(
  storedDraft: SupplierInvoiceDraft,
  trustedActor: TrustedOcrAdminContext,
  requestedPaymentType: OcrPurchasePaymentType,
  resolvedPaidInput: number | string,
  nowIso: string
): OcrDraftApprovalEvidence {
  if (storedDraft.status !== 'VERIFIED') {
    throw new Error(
      `OCR_DRAFT_NOT_VERIFIED: لا يمكن ترحيل المسودة لأن حالتها "${String(storedDraft.status)}" وليست معتمدة صراحةً ("VERIFIED").`
    );
  }

  const anyDraft = storedDraft as SupplierInvoiceDraft & Record<string, unknown>;
  const rawApproval = storedDraft.approval;
  if (!rawApproval || typeof rawApproval !== 'object' || Array.isArray(rawApproval)) {
    throw new Error(
      'OCR_APPROVAL_EVIDENCE_MISSING: لا توجد وثيقة اعتماد صالحة محفوظة على المسودة؛ يجب اعتماد الفاتورة أولاً.'
    );
  }

  if (rawApproval.approvalStatus !== 'APPROVED') {
    throw new Error(
      'OCR_APPROVAL_STATUS_NOT_APPROVED: حالة الموافقة غير صالحة؛ يجب أن تكون "APPROVED" صراحةً.'
    );
  }

  if (rawApproval.approvalVersion !== OCR_APPROVAL_EVIDENCE_VERSION) {
    throw new Error(
      'OCR_APPROVAL_VERSION_UNSUPPORTED: إصدار وثيقة الاعتماد غير مدعوم؛ يرجى إعادة الاعتماد.'
    );
  }

  if (!isValidFirebaseActorUid(rawApproval.approvedBy)) {
    throw new Error(
      'OCR_APPROVAL_INVALID_ACTOR_UID: يجب اعتماد الفاتورة بواسطة معرّف مستخدم Firebase فعلي وصالح (approvedBy).'
    );
  }

  if (rawApproval.approvedByRole !== 'admin' && rawApproval.approvedByRole !== 'super_admin') {
    throw new Error(
      'OCR_APPROVAL_UNAUTHORIZED_ROLE: يقتصر اعتماد فواتير OCR على دوري Admin أو Super Admin فقط.'
    );
  }

  if (rawApproval.approvedBy !== trustedActor.uid) {
    throw new Error(
      'OCR_APPROVAL_ACTOR_MISMATCH: معرّف المستخدم الذي اعتمد الفاتورة لا يطابق المستخدم الموثق الذي ينفذ الترحيل؛ يجب إعادة الاعتماد بواسطة المستخدم النشط.'
    );
  }

  if (rawApproval.approvedByRole !== trustedActor.role) {
    throw new Error(
      'OCR_APPROVAL_ROLE_MISMATCH: دور المستخدم الموثق تغير منذ الاعتماد؛ يجب إعادة الاعتماد.'
    );
  }

  const approvedBranchIdRaw =
    typeof rawApproval.approvedBranchId === 'string' ? rawApproval.approvedBranchId.trim() : '';
  if (!approvedBranchIdRaw) {
    throw new Error(
      'OCR_APPROVAL_BRANCH_MISMATCH: وثيقة الاعتماد تفتقر إلى معرّف الفرع المعتمد (approvedBranchId)؛ يجب إعادة الاعتماد على الفرع النشط.'
    );
  }
  if (approvedBranchIdRaw !== trustedActor.activeBranchId) {
    throw new Error(
      'OCR_APPROVAL_BRANCH_MISMATCH: تم اعتماد المسودة على فرع مختلف عن الفرع النشط حالياً.'
    );
  }

  // Enforce strict consistency with any mirrored top-level fields on the stored draft
  if (
    (anyDraft.approvedBy !== undefined && anyDraft.approvedBy !== rawApproval.approvedBy) ||
    (anyDraft.approvedByRole !== undefined &&
      anyDraft.approvedByRole !== rawApproval.approvedByRole) ||
    (anyDraft.approvedAt !== undefined && anyDraft.approvedAt !== rawApproval.approvedAt) ||
    (anyDraft.approvedCanonicalHash !== undefined &&
      anyDraft.approvedCanonicalHash !== rawApproval.approvedCanonicalHash) ||
    (anyDraft.approvedBranchId !== undefined &&
      anyDraft.approvedBranchId !== rawApproval.approvedBranchId) ||
    (anyDraft.approvalStatus !== undefined &&
      anyDraft.approvalStatus !== rawApproval.approvalStatus) ||
    (anyDraft.approvalVersion !== undefined &&
      anyDraft.approvalVersion !== rawApproval.approvalVersion)
  ) {
    throw new Error(
      'OCR_APPROVAL_EVIDENCE_TAMPERED: تعارض في حقول وثيقة الاعتماد المحفوظة؛ يجب إعادة المراجعة والاعتماد.'
    );
  }

  const approvedAtRaw = typeof rawApproval.approvedAt === 'string' ? rawApproval.approvedAt.trim() : '';
  const approvedAtMs = Date.parse(approvedAtRaw);
  const nowMs = Date.parse(nowIso);
  if (!approvedAtRaw || !Number.isFinite(approvedAtMs) || approvedAtMs <= 0) {
    throw new Error('OCR_APPROVAL_INVALID_TIMESTAMP: توقيت الاعتماد (approvedAt) مفقود أو غير صالح.');
  }
  if (Number.isFinite(nowMs) && approvedAtMs > nowMs + 5 * 60 * 1000) {
    throw new Error('OCR_APPROVAL_TIMESTAMP_IN_FUTURE: توقيت الاعتماد غير صالح.');
  }
  if (typeof storedDraft.updatedAt === 'string' && storedDraft.updatedAt.trim()) {
    const updatedAtMs = Date.parse(storedDraft.updatedAt);
    if (Number.isFinite(updatedAtMs) && updatedAtMs > approvedAtMs) {
      throw new Error(
        'OCR_APPROVAL_INVALIDATED_BY_EDIT: تم تعديل المسودة بعد توقيت الاعتماد؛ أُبطلت الموافقة السابقة ويجب إعادة المراجعة والاعتماد.'
      );
    }
  }

  if (
    typeof rawApproval.approvedCanonicalHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(rawApproval.approvedCanonicalHash.trim())
  ) {
    throw new Error(
      'OCR_APPROVAL_MISSING_CANONICAL_HASH: بصمة المحتوى المعتمد (approvedCanonicalHash) مفقودة أو غير صالحة.'
    );
  }

  if (
    !Array.isArray(rawApproval.approvedUnitSnapshotRefs) ||
    rawApproval.approvedUnitSnapshotRefs.length === 0
  ) {
    throw new Error(
      'OCR_APPROVAL_UNIT_SNAPSHOTS_MISSING: وثيقة الاعتماد لا تحتوي على بصمات تعريف وحدات الأصناف؛ يجب إعادة الاعتماد.'
    );
  }

  const approvedPay = rawApproval.approvedPaymentIntent;
  if (!approvedPay || typeof approvedPay !== 'object') {
    throw new Error(
      'OCR_APPROVAL_PAYMENT_INTENT_MISSING: نية الدفع المعتمدة مفقودة؛ يجب إعادة الاعتماد.'
    );
  }
  if (approvedPay.paymentType !== requestedPaymentType) {
    throw new Error(
      'OCR_APPROVAL_PAYMENT_INTENT_MISMATCH: نوع الدفع المطلوب للترحيل لا يطابق نوع الدفع المعتمد؛ يجب إعادة الاعتماد.'
    );
  }
  const requestedPaidDecimal =
    typeof resolvedPaidInput === 'number'
      ? toExactDecimalInputFromNumber(resolvedPaidInput, 'paidAmount')
      : String(resolvedPaidInput).trim();
  const requestedPaidRational = parseExactDecimal(requestedPaidDecimal, 'paidAmount');
  const approvedPaidRational = parseExactDecimal(
    String(approvedPay.paidAmount),
    'approvedPaidAmount'
  );
  if (compareRational(requestedPaidRational, approvedPaidRational) !== 0) {
    throw new Error(
      'OCR_APPROVAL_PAYMENT_INTENT_MISMATCH: المبلغ المدفوع المطلوب للترحيل لا يطابق المبلغ المعتمد؛ يجب إعادة الاعتماد.'
    );
  }

  return rawApproval;
}

/**
 * Validates explicit human approval evidence on a VERIFIED stored OCR draft against
 * the FINAL canonical posting snapshot (including transaction-time unitSnapshots).
 * Any content edit, payment intent change, actor change, or medicine unit configuration
 * change invalidates approval and fails closed.
 */
function assertValidOcrDraftHumanApproval(
  storedDraft: SupplierInvoiceDraft,
  trustedActor: TrustedOcrAdminContext,
  finalPostingSnapshot: {
    readonly payload: OcrPurchaseCanonicalPostingPayload;
    readonly canonicalJson: string;
    readonly sha256: string;
  },
  nowIso: string
): OcrDraftApprovalEvidence {
  const approval = assertStoredOcrDraftApprovalPrecheck(
    storedDraft,
    trustedActor,
    finalPostingSnapshot.payload.paymentIntent.paymentType,
    finalPostingSnapshot.payload.paymentIntent.paidAmount,
    nowIso
  );

  const currentUnitSnapshots = finalPostingSnapshot.payload.unitSnapshots;
  if (approval.approvedUnitSnapshotRefs.length !== currentUnitSnapshots.length) {
    throw new Error(
      'OCR_APPROVAL_UNIT_CONFIG_CHANGED: تغير عدد الأصناف أو تعريف الوحدات منذ الاعتماد؛ أُبطلت الموافقة ويجب إعادة الاعتماد.'
    );
  }

  for (let i = 0; i < currentUnitSnapshots.length; i += 1) {
    const approvedRef = approval.approvedUnitSnapshotRefs[i];
    const currentSnap = currentUnitSnapshots[i];
    if (
      !approvedRef ||
      approvedRef.medicineId !== currentSnap.medicineId ||
      approvedRef.sourceUnit !== currentSnap.sourceUnit ||
      approvedRef.unitDefinitionKey !== currentSnap.unitDefinitionKey ||
      approvedRef.baseDimensionKey !== currentSnap.baseDimensionKey ||
      approvedRef.definitionVersion !== currentSnap.definitionVersion
    ) {
      throw new Error(
        `OCR_APPROVAL_UNIT_CONFIG_CHANGED: تغير تكوين وحدات الصنف "${currentSnap.medicineId}" بعد الاعتماد؛ أُبطلت الموافقة السابقة ويجب إعادة المراجعة والاعتماد.`
      );
    }
  }

  if (approval.approvedCanonicalHash !== finalPostingSnapshot.sha256) {
    throw new Error(
      'OCR_APPROVAL_HASH_MISMATCH_INVALIDATED: بصمة المحتوى النهائي (بما في ذلك تعريفات الوحدات) لا تطابق البصمة المعتمدة؛ أي تعديل يُبطل الموافقة السابقة.'
    );
  }

  return approval;
}

/**
 * Shared exact rational financial & line-item validation helper used identically by
 * both approveOcrPurchaseDraft and postOcrPurchaseInvoice so an invoice that cannot
 * pass posting math/reconciliation rules can never be approved.
 */
function validateOcrCanonicalFinancialsAndLines(
  basePayload: ReturnType<typeof buildOcrPurchaseCanonicalPayload>,
  _sourceDraft: SupplierInvoiceDraft,
  medMap: Map<string, Medicine>,
  requestedPaymentType: OcrPurchasePaymentType,
  todayStr: string
): {
  readonly subtotalExact: Rational;
  readonly discountExact: Rational;
  readonly finalTotalExact: Rational;
  readonly paidAmountExact: Rational;
  readonly grossLineCostsExact: Rational[];
} {
  const subtotalExact = parseExactDecimal(basePayload.invoice.subtotal, 'subtotal');
  const discountExact = parseExactDecimal(basePayload.invoice.discount, 'discount');
  const taxExact = parseExactDecimal(basePayload.invoice.tax, 'tax');
  const finalTotalExact = parseExactDecimal(basePayload.invoice.finalTotal, 'finalTotal');
  const paidAmountExact = parseExactDecimal(
    String(basePayload.paymentIntent.paidAmount),
    'paidAmount'
  );

  // Internal canonical invariant: canonical tax is always excluded ('0').
  if (compareRational(taxExact, createRational(0n)) !== 0) {
    throw new Error('OCR_INTERNAL_CANONICAL_TAX_INVARIANT_VIOLATION');
  }
  if (
    basePayload.invoice.reconciliation.overrideReason !== null ||
    compareRational(
      parseExactDecimal(basePayload.invoice.reconciliation.difference, 'difference'),
      createRational(0n)
    ) !== 0
  ) {
    throw new Error('OCR_RECONCILIATION_OVERRIDE_FORBIDDEN');
  }
  if (
    compareRational(subtotalExact, createRational(0n)) <= 0 ||
    compareRational(discountExact, createRational(0n)) < 0 ||
    compareRational(discountExact, subtotalExact) > 0
  ) {
    throw new Error('OCR_INVALID_SUBTOTAL_OR_DISCOUNT');
  }

  // Exact reconciliation without tax: subtotal - invoiceDiscount === verified printed final total
  const computedFinalTotalExact = subtractRational(subtotalExact, discountExact);
  if (compareRational(computedFinalTotalExact, finalTotalExact) !== 0) {
    throw new Error('HEADER_TOTAL_MISMATCH');
  }
  if (
    compareRational(paidAmountExact, createRational(0n)) < 0 ||
    compareRational(paidAmountExact, finalTotalExact) > 0
  ) {
    throw new Error('INVALID_PAID_AMOUNT');
  }
  if (
    requestedPaymentType === 'Cash' &&
    compareRational(paidAmountExact, finalTotalExact) !== 0
  ) {
    throw new Error('OCR_CASH_PAYMENT_MISMATCH');
  }
  if (
    requestedPaymentType === 'Credit' &&
    compareRational(paidAmountExact, createRational(0n)) !== 0
  ) {
    throw new Error('OCR_CREDIT_PAYMENT_MISMATCH');
  }
  if (
    requestedPaymentType === 'Partial' &&
    (compareRational(paidAmountExact, createRational(0n)) <= 0 ||
      compareRational(paidAmountExact, finalTotalExact) >= 0)
  ) {
    throw new Error('OCR_PARTIAL_PAYMENT_MISMATCH');
  }

  const grossLineCostsExact: Rational[] = [];
  for (let i = 0; i < basePayload.items.length; i += 1) {
    const item = basePayload.items[i];
    const sourceItem = _sourceDraft.items?.[i];
    if (item.isUserConfirmed !== true || (sourceItem && sourceItem.isUserConfirmed !== true)) {
      throw new Error(
        `OCR_MEDICINE_MATCH_UNCONFIRMED: يجب تأكيد ربط الصنف "${item.tradeName || item.medicineName || i}" يدوياً قبل الاعتماد أو الترحيل.`
      );
    }
    const baseMed = medMap.get(item.medicineId)!;

    // R13-D.3: Strict medicine identity gate (strength, concentration, dosageForm, releaseType, variant, packageSize)
    const identityCheck = validateOcrItemMedicineIdentity(
      {
        tradeName: item.tradeName,
        strength: item.strength,
        dosageForm: item.dosageForm,
        releaseType: item.releaseType,
        concentration: item.concentration,
        packageSize: item.packageSize
      },
      baseMed,
      { requireExplicitOcrIdentity: true }
    );
    if (!identityCheck.ok) {
      throw new Error(`${identityCheck.code}: ${identityCheck.message}`);
    }

    if (item.unit !== 'pack' && item.unit !== 'strip' && item.unit !== 'pill') {
      throw new Error(`UNSUPPORTED_ITEM_UNIT: الوحدة "${String(item.unit)}" غير معتمدة.`);
    }
    const unit: UnitKind = item.unit;
    const itemQty = Number(item.quantity);
    if (!Number.isSafeInteger(itemQty) || itemQty <= 0) {
      throw new Error(`INVALID_QUANTITY: الكمية غير صالحة للصنف "${baseMed.name}"`);
    }
    if (isDirectPackMedicine(baseMed) && unit !== 'pack') {
      throw new Error('DIRECT_PACK_PARTIAL_PURCHASE_UNSUPPORTED');
    }
    convertMedicineQuantityToBaseUnits(itemQty, unit, baseMed);

    const itemExpiry = item.expiryDate.trim();
    if (itemExpiry < todayStr) {
      throw new Error(
        `لا يمكن استلام دفعة منتهية الصلاحية للصنف "${baseMed.name}" (تاريخ الانتهاء: ${itemExpiry})`
      );
    }

    const buyPriceExact = parseExactDecimal(item.unitBuyPrice, `items[${i}].unitBuyPrice`);
    if (compareRational(buyPriceExact, createRational(0n)) <= 0) {
      throw new Error(`INVALID_BUY_PRICE: سعر الشراء يجب أن يكون أكبر من الصفر للصنف "${baseMed.name}"`);
    }
    const grossBeforeItemDiscountExact = multiplyRational(
      createRational(BigInt(itemQty)),
      buyPriceExact
    );
    const itemDiscountExact = parseExactDecimal(item.itemDiscount, `items[${i}].itemDiscount`);

    if (
      compareRational(itemDiscountExact, createRational(0n)) < 0 ||
      compareRational(itemDiscountExact, grossBeforeItemDiscountExact) > 0
    ) {
      throw new Error(`INVALID_ITEM_DISCOUNT: items[${i}]`);
    }

    const expectedLineTotalAfterItemDiscountExact = subtractRational(
      grossBeforeItemDiscountExact,
      itemDiscountExact
    );
    const grossLineCostExact = parseExactDecimal(item.lineTotal, `items[${i}].lineTotal`);
    if (compareRational(grossLineCostExact, createRational(0n)) <= 0) {
      throw new Error(`INVALID_LINE_TOTAL: items[${i}]`);
    }
    if (compareRational(expectedLineTotalAfterItemDiscountExact, grossLineCostExact) !== 0) {
      throw new Error(`LINE_TOTAL_MISMATCH: items[${i}]`);
    }
    grossLineCostsExact.push(grossLineCostExact);
  }

  const discountAllocation = allocateExactProportionalDiscountRational(
    grossLineCostsExact,
    discountExact
  );
  if (compareRational(discountAllocation.subtotal, subtotalExact) !== 0) {
    throw new Error('SUBTOTAL_LINE_SUM_MISMATCH');
  }
  // Exact inventory cost invariant: sum(netLineCosts) === subtotal - invoiceDiscount === finalTotal
  let totalAllocatedInventoryCostExact = createRational(0n);
  for (const netLineCost of discountAllocation.netLineCosts) {
    totalAllocatedInventoryCostExact = addRational(totalAllocatedInventoryCostExact, netLineCost);
  }
  if (compareRational(totalAllocatedInventoryCostExact, finalTotalExact) !== 0) {
    throw new Error('HEADER_TOTAL_MISMATCH');
  }

  return {
    subtotalExact,
    discountExact,
    finalTotalExact,
    paidAmountExact,
    grossLineCostsExact
  };
}

/**
 * Validates a target medicine's unit configuration inside the active OCR posting transaction
 * and constructs an immutable OcrPurchaseUnitSnapshot for the invoice line.
 * Missing or unverified unit configuration fails closed without any synthetic legacy fallback.
 */
function buildOcrPurchaseUnitSnapshotForLine(
  targetMed: Medicine,
  sourceUnit: UnitKind
): OcrPurchaseUnitSnapshot {
  // 1. Verify sourceUnit is canonical and operationally supported for this medicine
  if (sourceUnit !== 'pack' && sourceUnit !== 'strip' && sourceUnit !== 'pill') {
    throw new Error(`UNSUPPORTED_ITEM_UNIT: الوحدة "${String(sourceUnit)}" غير معتمدة.`);
  }
  if (isDirectPackMedicine(targetMed) && sourceUnit !== 'pack') {
    throw new Error('DIRECT_PACK_PARTIAL_PURCHASE_UNSUPPORTED');
  }
  // Fails closed if packing factors or conversion are invalid
  convertMedicineQuantityToBaseUnits(1, sourceUnit, targetMed);

  // 2. Persisted SerializedUnitDefinitionDTOV2 is mandatory; never fabricate synthetic LEGACY_ASSUMED definitions
  if (targetMed.unitDefinition === undefined || targetMed.unitDefinition === null) {
    throw new Error(
      `OCR_MISSING_VERIFIED_UNIT_DEFINITION: الصنف "${targetMed.name || targetMed.id}" لا يملك تعريف وحدات موثق ومعتمد (unitDefinition). يجب مراجعة واعتماد تكوين وحدات الصنف أولاً.`
    );
  }
  if (targetMed.configStatus !== 'VERIFIED' || targetMed.unitDefinition.configStatus !== 'VERIFIED') {
    throw new Error(
      `OCR_UNVERIFIED_UNIT_DEFINITION: تعريف وحدات الصنف "${targetMed.name || targetMed.id}" غير معتمد (VERIFIED).`
    );
  }

  const rehydrated = rehydrateUnitDefinitionFromDto(targetMed.unitDefinition);
  if (!rehydrated.ok) {
    throw new Error(
      `OCR_INVALID_MEDICINE_UNIT_DEFINITION: ${rehydrated.errorCode}: ${rehydrated.message}`
    );
  }
  if (rehydrated.claimedConfigStatus !== 'VERIFIED') {
    throw new Error('OCR_UNIT_DEFINITION_NOT_VERIFIED');
  }

  const def = rehydrated.definition;
  if (
    targetMed.unitDefinitionKey !== undefined &&
    targetMed.unitDefinitionKey !== def.unitDefinitionKey
  ) {
    throw new Error('OCR_UNIT_DEFINITION_KEY_MISMATCH');
  }
  if (
    targetMed.baseDimensionKey !== undefined &&
    targetMed.baseDimensionKey !== def.baseDimensionKey
  ) {
    throw new Error('OCR_BASE_DIMENSION_KEY_MISMATCH');
  }
  if (
    targetMed.dosageForm !== undefined &&
    targetMed.dosageForm !== def.dosageForm
  ) {
    throw new Error('OCR_DOSAGE_FORM_MISMATCH');
  }
  if (
    targetMed.baseUnitsPerPack !== undefined &&
    targetMed.baseUnitsPerPack !== def.baseUnitsPerPack
  ) {
    throw new Error('OCR_BASE_UNITS_PER_PACK_MISMATCH');
  }
  if (def.hierarchy.kind === 'SOLID_TWO_LEVEL') {
    if (
      targetMed.stripsPerPack !== def.hierarchy.stripsPerPack ||
      targetMed.pillsPerStrip !== def.hierarchy.pillsPerStrip
    ) {
      throw new Error('OCR_SOLID_HIERARCHY_FACTORS_MISMATCH');
    }
  }

  const canonicalDef = createValidatedUnitDefinition({
    dosageForm: def.dosageForm,
    baseUnit: def.baseUnit,
    packUnit: def.packUnit,
    intermediateUnit: def.hierarchy.intermediateUnit,
    ...(def.hierarchy.kind === 'SOLID_TWO_LEVEL'
      ? {
          stripsPerPack: def.hierarchy.stripsPerPack,
          pillsPerStrip: def.hierarchy.pillsPerStrip
        }
      : {}),
    baseUnitsPerPack: def.baseUnitsPerPack,
    requestedSellableUnits: [...def.sellableUnits.toArray()],
    definitionVersion: def.definitionVersion,
    configStatus: 'VERIFIED',
    packingLocked: Boolean(def.packingLocked || targetMed.packingLocked)
  });
  const dto = serializeUnitDefinitionToDto(canonicalDef);

  return {
    medicineId: targetMed.id,
    sourceUnit,
    unitDefinitionKey: dto.unitDefinitionKey,
    baseDimensionKey: dto.baseDimensionKey,
    definitionVersion: dto.definitionVersion,
    unitDefinition: dto
  };
}

/**
 * R13-D.1: ATOMIC TRUSTED HUMAN APPROVAL FOR OCR PURCHASE DRAFTS
 *
 * Strictly separates human approval from invoice posting:
 * - Resolves actor UID and role exclusively from trustedAuthSession (Admin or Super Admin).
 * - Executes inside ONE readwrite transaction over existing DB_VERSION=6 stores,
 *   writing ONLY to 'supplier_invoice_drafts' (zero writes to inventory, ledger,
 *   suppliers, purchase_invoices, supplier_transactions, outbox, or metadata).
 * - Computes the EXACT same canonical posting payload including transaction-time
 *   unitSnapshots and persists finalApprovalSnapshot.sha256 as approvedCanonicalHash.
 * - Transitions draft status to VERIFIED without posting the invoice.
 */
export async function approveOcrPurchaseDraft(
  params: ApproveOcrPurchaseDraftParams
): Promise<OcrDraftApprovalResult> {
  if (!params || typeof params !== 'object') {
    throw new Error('OCR_INVALID_APPROVAL_PARAMS');
  }
  assertNoCallerSuppliedApprovalParams(params);

  const ocrDraftId = typeof params.ocrDraftId === 'string' ? params.ocrDraftId.trim() : '';
  if (!ocrDraftId) {
    throw new Error('OCR_INVALID_DRAFT_ID: معرف مسودة الفاتورة مطلوب.');
  }

  if (
    params.paymentType !== undefined &&
    params.paymentType !== 'Cash' &&
    params.paymentType !== 'Credit' &&
    params.paymentType !== 'Partial'
  ) {
    throw new Error(
      `OCR_INVALID_PAYMENT_TYPE: نوع الدفع "${String(params.paymentType)}" غير صالح.`
    );
  }

  const trustedActor = requireTrustedOcrAdminSession();
  const deterministicInvoiceId = `inv_ocr_${ocrDraftId}`;
  const idempotencyKey = getOcrPurchaseIdempotencyKey(ocrDraftId);
  const db = await openPharmacyDB();
  const nowIso = new Date().toISOString();
  const todayStr = nowIso.split('T')[0];

  return new Promise((resolve, reject) => {
    let settled = false;
    let abortReason: Error | null = null;
    let approvalResult: OcrDraftApprovalResult | null = null;

    const resolveOnce = (result: OcrDraftApprovalResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const rejectOnce = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err || 'OCR_APPROVAL_FAILED')));
    };

    const tx = db.transaction(
      ['supplier_invoice_drafts', 'medicines', 'suppliers', 'purchase_invoices', 'metadata'],
      'readwrite'
    );

    const abortWith = (err: unknown, fallbackMessage = 'OCR_APPROVAL_TRANSACTION_ABORTED') => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(err ? String(err) : fallbackMessage);
      }
      try {
        tx.abort();
      } catch {
        rejectOnce(abortReason);
      }
    };

    tx.oncomplete = () => {
      if (approvalResult) {
        resolveOnce(approvalResult);
        return;
      }
      rejectOnce(abortReason || new Error('OCR_APPROVAL_TRANSACTION_COMPLETED_WITHOUT_RESULT'));
    };

    tx.onerror = () => {
      rejectOnce(abortReason || tx.error || new Error('OCR_APPROVAL_TRANSACTION_ERROR'));
    };

    tx.onabort = () => {
      rejectOnce(abortReason || tx.error || new Error('OCR_APPROVAL_TRANSACTION_ABORTED'));
    };

    const draftStore = tx.objectStore('supplier_invoice_drafts');
    const medStore = tx.objectStore('medicines');
    const supStore = tx.objectStore('suppliers');
    const invoiceStore = tx.objectStore('purchase_invoices');
    const metadataStore = tx.objectStore('metadata');

    const draftReq = draftStore.get(ocrDraftId);
    const idempotencyReq = metadataStore.get(idempotencyKey);
    const existingInvoiceReq = invoiceStore.get(deterministicInvoiceId);

    let step1Remaining = 3;
    let step1Entered = false;

    const onStep1Done = () => {
      step1Remaining -= 1;
      if (step1Remaining > 0 || step1Entered || settled) return;
      step1Entered = true;

      try {
        const storedDraft = (draftReq.result as SupplierInvoiceDraft | undefined) ?? null;
        const rawIdempotencyRecord = idempotencyReq.result as unknown;
        const existingInvoice = (existingInvoiceReq.result as PurchaseInvoice | undefined) ?? null;

        if (rawIdempotencyRecord !== undefined && rawIdempotencyRecord !== null) {
          throw new Error(
            'OCR_DRAFT_ALREADY_POSTED_OR_RESERVED: هذه المسودة مرتبطة بسجل ترحيل سابق ولا يمكن إعادة اعتمادها.'
          );
        }
        if (existingInvoice !== null) {
          throw new Error('OCR_INVOICE_EXISTS_WITHOUT_IDEMPOTENCY_RECORD');
        }
        if (!storedDraft) {
          throw new Error('OCR_DRAFT_NOT_FOUND: لم يتم العثور على المسودة المطلوبة.');
        }
        if (storedDraft.id !== ocrDraftId) {
          throw new Error('OCR_DRAFT_ID_MISMATCH');
        }
        if (
          storedDraft.status === 'POSTED' ||
          (typeof storedDraft.postedInvoiceId === 'string' &&
            storedDraft.postedInvoiceId.trim().length > 0)
        ) {
          throw new Error('OCR_DRAFT_ALREADY_POSTED: هذه المسودة مرحّلة بالفعل ولا يمكن إعادة اعتمادها.');
        }
        if (
          storedDraft.status === 'PROCESSING' ||
          storedDraft.status === 'DUPLICATE' ||
          storedDraft.status === 'FAILED'
        ) {
          throw new Error(
            `OCR_DRAFT_STATUS_NOT_APPROVABLE: لا يمكن اعتماد المسودة في حالتها الحالية ("${String(storedDraft.status)}").`
          );
        }
        if (
          typeof params.expectedUpdatedAt === 'string' &&
          params.expectedUpdatedAt.trim() &&
          storedDraft.updatedAt !== params.expectedUpdatedAt.trim()
        ) {
          throw new Error(
            'OCR_APPROVAL_STALE_DRAFT_CONFLICT: تم تعديل المسودة في تبويب أو جلسة أخرى؛ يرجى تحديث البيانات ومراجعتها قبل الاعتماد.'
          );
        }

        const effectivePaymentType: OcrPurchasePaymentType =
          params.paymentType ?? storedDraft.paymentType ?? 'Credit';
        if (
          effectivePaymentType !== 'Cash' &&
          effectivePaymentType !== 'Credit' &&
          effectivePaymentType !== 'Partial'
        ) {
          throw new Error(
            `OCR_INVALID_PAYMENT_TYPE: نوع الدفع "${String(effectivePaymentType)}" غير صالح.`
          );
        }

        const normalizedDraft = prepareOcrDraftForCanonicalPosting(storedDraft, trustedActor.uid);
        const resolvedPaidInput: number | string | undefined =
          params.paidAmount !== undefined
            ? params.paidAmount
            : storedDraft.paidAmount !== undefined &&
                storedDraft.paidAmount !== null &&
                storedDraft.paidAmount !== ''
              ? storedDraft.paidAmount
              : effectivePaymentType === 'Cash'
                ? (normalizedDraft.header?.finalTotal?.value ?? 0)
                : effectivePaymentType === 'Credit'
                  ? '0'
                  : undefined;

        if (resolvedPaidInput === undefined) {
          throw new Error('OCR_PARTIAL_PAYMENT_AMOUNT_REQUIRED');
        }

        const basePayload = buildOcrPurchaseCanonicalPayload(
          normalizedDraft,
          {
            paymentType: effectivePaymentType,
            paidAmount: resolvedPaidInput,
            currency: normalizedDraft.header?.currency?.value || 'SDG'
          },
          trustedActor.uid,
          trustedActor.activeBranchId
        );

        const supplierId = basePayload.supplier.id;
        const uniqueMedicineIds = Array.from(
          new Set(basePayload.items.map((item) => item.medicineId))
        );

        let supplierRecord: Supplier | undefined;
        let supplierInvoices: PurchaseInvoice[] = [];
        const medMap = new Map<string, Medicine>();
        const quarantineRecordsByMedicineId = new Map<string, unknown>();

        let step2Remaining = 2 + uniqueMedicineIds.length * 2;
        let step2Entered = false;

        const onStep2Done = () => {
          step2Remaining -= 1;
          if (step2Remaining > 0 || step2Entered || settled) return;
          step2Entered = true;

          try {
            if (!supplierRecord) {
              throw new Error(`المورد غير موجود: ${supplierId}`);
            }
            if (supplierRecord.archived || supplierRecord.status === 'archived') {
              throw new Error(
                `COMMERCIAL_TARGET_ARCHIVED: المورد "${supplierRecord.name?.ar || supplierRecord.id}" مؤرشف ولا يمكن اعتماد فواتير شراء له`
              );
            }
            if (
              supplierRecord.status === 'inactive' ||
              (supplierRecord.status && supplierRecord.status !== 'active')
            ) {
              throw new Error(
                `المورد "${supplierRecord.name?.ar || supplierRecord.id}" معطل حالياً. لا يمكن اعتماد فواتير شراء لمورد معطل.`
              );
            }

            const invoiceNumber = basePayload.invoice.number;
            const cleanInvoiceNumberLower = invoiceNumber.trim().toLowerCase();
            const duplicateSupplierInvoice = supplierInvoices.some(
              (inv) =>
                inv.id !== deterministicInvoiceId &&
                inv.supplierId === supplierRecord!.id &&
                inv.invoiceNumber &&
                inv.invoiceNumber.trim().toLowerCase() === cleanInvoiceNumberLower
            );
            if (duplicateSupplierInvoice) {
              throw new Error(
                `رقم الفاتورة "${invoiceNumber}" مسجل مسبقاً للمورد "${supplierRecord.name?.ar || supplierRecord.id}". تم منع الاعتماد لحماية السجلات المالية.`
              );
            }

            for (const medId of uniqueMedicineIds) {
              const targetMed = medMap.get(medId);
              if (!targetMed) {
                throw new Error(`الصنف غير مسجل في قائمة الأدوية: ${medId}`);
              }
              if (targetMed.archived) {
                throw new Error(
                  `COMMERCIAL_TARGET_ARCHIVED: الصنف "${targetMed.name || targetMed.id}" مؤرشف ولا يمكن اعتماده في فاتورة شراء`
                );
              }
              const quarantineReason = getMedicineQuarantineMutationBlockReason(
                targetMed,
                quarantineRecordsByMedicineId.get(medId)
              );
              if (quarantineReason) {
                throw new Error(
                  `MEDICINE_QUARANTINED: Approval blocked for '${medId}' (${quarantineReason}).`
                );
              }
              assertMedicineOperationallyAllowed(targetMed);
              validateMedicineUnitConfiguration(targetMed);
            }

            // Enforce exact rational math, zero tax, zero override bypass, and expiry checks
            validateOcrCanonicalFinancialsAndLines(
              basePayload,
              storedDraft,
              medMap,
              effectivePaymentType,
              todayStr
            );

            // Build exact transaction-time unitSnapshots identical to postOcrPurchaseInvoice Step 5
            const unitSnapshots: OcrPurchaseUnitSnapshot[] = basePayload.items.map((item) => {
              const targetMed = medMap.get(item.medicineId)!;
              if (item.unit !== 'pack' && item.unit !== 'strip' && item.unit !== 'pill') {
                throw new Error(`UNSUPPORTED_ITEM_UNIT: الوحدة "${String(item.unit)}" غير معتمدة.`);
              }
              return buildOcrPurchaseUnitSnapshotForLine(targetMed, item.unit);
            });

            const finalApprovalPayload: OcrPurchaseCanonicalPostingPayload = {
              ...basePayload,
              unitSnapshots
            };
            const finalApprovalSnapshot = createOcrPurchaseCanonicalSnapshotFromPayload(
              finalApprovalPayload
            );

            const approvedUnitSnapshotRefs: OcrApprovedUnitSnapshotRef[] = unitSnapshots.map(
              (snap) => {
                if (snap.sourceUnit !== 'pack' && snap.sourceUnit !== 'strip' && snap.sourceUnit !== 'pill') {
                  throw new Error(`UNSUPPORTED_ITEM_UNIT: الوحدة "${String(snap.sourceUnit)}" غير معتمدة.`);
                }
                return {
                  medicineId: snap.medicineId,
                  sourceUnit: snap.sourceUnit,
                  unitDefinitionKey: snap.unitDefinitionKey,
                  baseDimensionKey: snap.baseDimensionKey,
                  definitionVersion: snap.definitionVersion
                };
              }
            );

            const approvalEvidence: OcrDraftApprovalEvidence = {
              approvalStatus: 'APPROVED',
              approvedBy: trustedActor.uid,
              approvedByRole: trustedActor.role,
              approvedAt: nowIso,
              approvedCanonicalHash: finalApprovalSnapshot.sha256,
              approvalVersion: OCR_APPROVAL_EVIDENCE_VERSION,
              approvedUnitSnapshotRefs,
              approvedPaymentIntent: {
                paymentType: finalApprovalSnapshot.payload.paymentIntent.paymentType,
                paidAmount: finalApprovalSnapshot.payload.paymentIntent.paidAmount,
                currency: finalApprovalSnapshot.payload.paymentIntent.currency
              },
              approvedBranchId: trustedActor.activeBranchId
            };

            const approvedDraftRecord: SupplierInvoiceDraft = JSON.parse(
              JSON.stringify({
                ...storedDraft,
                header: {
                  ...normalizedDraft.header,
                  ...(storedDraft.header?.tax !== undefined ? { tax: storedDraft.header.tax } : {})
                },
                audit: normalizedDraft.audit,
                status: 'VERIFIED',
                paymentType: finalApprovalSnapshot.payload.paymentIntent.paymentType,
                paidAmount: finalApprovalSnapshot.payload.paymentIntent.paidAmount,
                updatedAt: nowIso,
                approval: approvalEvidence,
                approvedBy: approvalEvidence.approvedBy,
                approvedByRole: approvalEvidence.approvedByRole,
                approvedAt: approvalEvidence.approvedAt,
                approvedCanonicalHash: approvalEvidence.approvedCanonicalHash,
                approvedBranchId: approvalEvidence.approvedBranchId,
                approvalStatus: 'APPROVED',
                approvalVersion: OCR_APPROVAL_EVIDENCE_VERSION
              })
            );

            const putDraftReq = draftStore.put(approvedDraftRecord);
            putDraftReq.onerror = (event) => {
              event?.preventDefault?.();
              abortWith(putDraftReq.error || new Error('OCR_APPROVAL_DRAFT_WRITE_FAILED'));
            };
            putDraftReq.onsuccess = () => {
              approvalResult = {
                draft: approvedDraftRecord,
                approval: approvalEvidence,
                canonicalHash: finalApprovalSnapshot.sha256
              };
            };
          } catch (step2Err) {
            abortWith(step2Err);
          }
        };

        const supReq = supStore.get(supplierId);
        supReq.onerror = (event) => {
          event?.preventDefault?.();
          abortWith(supReq.error || new Error('OCR_SUPPLIER_READ_FAILED'));
        };
        supReq.onsuccess = () => {
          supplierRecord = supReq.result as Supplier | undefined;
          onStep2Done();
        };

        const supInvoicesReq = invoiceStore.index('supplierId').getAll(supplierId);
        supInvoicesReq.onerror = (event) => {
          event?.preventDefault?.();
          abortWith(supInvoicesReq.error || new Error('OCR_SUPPLIER_INVOICES_READ_FAILED'));
        };
        supInvoicesReq.onsuccess = () => {
          supplierInvoices = (supInvoicesReq.result as PurchaseInvoice[]) || [];
          onStep2Done();
        };

        for (const medId of uniqueMedicineIds) {
          const medReq = medStore.get(medId);
          medReq.onerror = (event) => {
            event?.preventDefault?.();
            abortWith(medReq.error || new Error(`OCR_MEDICINE_READ_FAILED:${medId}`));
          };
          medReq.onsuccess = () => {
            if (medReq.result) {
              medMap.set(medId, medReq.result as Medicine);
            }
            onStep2Done();
          };

          const quarantineReq = metadataStore.get(`unit_migration_v2:quarantine:${medId}`);
          quarantineReq.onerror = (event) => {
            event?.preventDefault?.();
            abortWith(
              quarantineReq.error || new Error(`OCR_QUARANTINE_READ_FAILED:${medId}`)
            );
          };
          quarantineReq.onsuccess = () => {
            quarantineRecordsByMedicineId.set(medId, quarantineReq.result ?? null);
            onStep2Done();
          };
        }
      } catch (step1Err) {
        abortWith(step1Err);
      }
    };

    draftReq.onerror = (event) => {
      event?.preventDefault?.();
      abortWith(draftReq.error || new Error('OCR_DRAFT_READ_FAILED'));
    };
    draftReq.onsuccess = onStep1Done;

    idempotencyReq.onerror = (event) => {
      event?.preventDefault?.();
      abortWith(idempotencyReq.error || new Error('OCR_IDEMPOTENCY_READ_FAILED'));
    };
    idempotencyReq.onsuccess = onStep1Done;

    existingInvoiceReq.onerror = (event) => {
      event?.preventDefault?.();
      abortWith(existingInvoiceReq.error || new Error('OCR_EXISTING_INVOICE_READ_FAILED'));
    };
    existingInvoiceReq.onsuccess = onStep1Done;
  });
}

/**
 * R13-D: ATOMIC OCR PURCHASE INVOICE POSTING ENGINE
 * Executes strictly inside a SINGLE atomic 8-store IndexedDB readwrite transaction:
 *   ['purchase_invoices', 'inventory_ledger', 'medicines', 'suppliers',
 *    'supplier_transactions', 'outbox', 'metadata', 'supplier_invoice_drafts']
 *
 * Guarantees:
 * - Zero await / timer / fetch / Web Crypto after opening the IndexedDB transaction.
 * - Independent trusted Admin/Super Admin session verification from Firebase Auth context.
 * - Rejects caller-supplied approval parameters; validates persisted approval evidence
 *   and final canonical SHA-256 hash (including transaction-time unitSnapshots).
 * - Step 0 initial reads (idempotency record, deterministic invoice, stored draft).
 * - Committed replay verifies provenance and payload before any supplier or medicine lookup.
 * - Transaction-local 'RESERVED' idempotency reservation before dependent entity reads.
 * - Preserves existing medicine sellPrice without bypassing Smart Pricing Policy.
 * - Delegates medicine/supplier outbox writes to resolveMedicineOutboxWriteShared / resolveSupplierOutboxWriteShared.
 * - Resolves exclusively from tx.oncomplete.
 */
export async function postOcrPurchaseInvoice(
  params: PostOcrPurchaseInvoiceParams
): Promise<PurchaseInvoice> {
  if (!params || typeof params !== 'object') {
    throw new Error('OCR_INVALID_POSTING_PARAMS');
  }
  assertNoCallerSuppliedApprovalParams(params);

  const ocrDraftId = typeof params.ocrDraftId === 'string' ? params.ocrDraftId.trim() : '';
  if (!ocrDraftId) {
    throw new Error('OCR_INVALID_DRAFT_ID: معرف مسودة الفاتورة مطلوب.');
  }

  if (
    params.paymentType !== undefined &&
    params.paymentType !== 'Cash' &&
    params.paymentType !== 'Credit' &&
    params.paymentType !== 'Partial'
  ) {
    throw new Error(`OCR_INVALID_PAYMENT_TYPE: نوع الدفع "${String(params.paymentType)}" غير صالح.`);
  }

  const trustedActor = requireTrustedOcrAdminSession();

  if (
    typeof params.postingActor === 'string' &&
    params.postingActor.trim().length > 0 &&
    params.postingActor.trim() !== trustedActor.uid
  ) {
    throw new Error(
      'OCR_POSTING_ACTOR_UID_MISMATCH: معرّف منفذ الترحيل الممرر لا يطابق الجلسة الموثقة الحالية.'
    );
  }

  const deterministicInvoiceId = `inv_ocr_${ocrDraftId}`;
  const idempotencyKey = getOcrPurchaseIdempotencyKey(ocrDraftId);
  const db = await openPharmacyDB();
  const nowIso = new Date().toISOString();
  const todayStr = nowIso.split('T')[0];
  const deviceId = getDeviceId();

  return new Promise((resolve, reject) => {
    let settled = false;
    let abortReason: Error | null = null;
    let finalInvoiceRecord: PurchaseInvoice | null = null;

    const resolveOnce = (invoice: PurchaseInvoice) => {
      if (settled) return;
      settled = true;
      (invoice as PurchaseInvoice & { invoice?: PurchaseInvoice }).invoice = invoice;
      resolve(invoice);
    };

    const rejectOnce = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err || 'OCR_POSTING_FAILED')));
    };

    const tx = db.transaction(
      [
        'purchase_invoices',
        'inventory_ledger',
        'medicines',
        'suppliers',
        'supplier_transactions',
        'outbox',
        'metadata',
        'supplier_invoice_drafts'
      ],
      'readwrite'
    );

    const abortWith = (err: unknown, fallbackMessage = 'OCR_POSTING_TRANSACTION_ABORTED') => {
      if (!abortReason) {
        abortReason = err instanceof Error ? err : new Error(err ? String(err) : fallbackMessage);
      }
      try {
        tx.abort();
      } catch {
        rejectOnce(abortReason);
      }
    };

    tx.oncomplete = () => {
      if (finalInvoiceRecord) {
        resolveOnce(finalInvoiceRecord);
        return;
      }
      rejectOnce(abortReason || new Error('OCR_POSTING_TRANSACTION_COMPLETED_WITHOUT_RESULT'));
    };

    tx.onerror = () => {
      rejectOnce(abortReason || tx.error || new Error('OCR_POSTING_TRANSACTION_ERROR'));
    };

    tx.onabort = () => {
      rejectOnce(abortReason || tx.error || new Error('OCR_POSTING_TRANSACTION_ABORTED'));
    };

    const invoiceStore = tx.objectStore('purchase_invoices');
    const ledgerStore = tx.objectStore('inventory_ledger');
    const medStore = tx.objectStore('medicines');
    const supStore = tx.objectStore('suppliers');
    const stStore = tx.objectStore('supplier_transactions');
    const outboxStore = tx.objectStore('outbox');
    const metadataStore = tx.objectStore('metadata');
    const draftStore = tx.objectStore('supplier_invoice_drafts');

    // =========================================================================
    // STEP 1: Schedule initial reads synchronously (idempotency, invoice, draft)
    // =========================================================================
    const idempotencyReq = metadataStore.get(idempotencyKey);
    const existingInvoiceReq = invoiceStore.get(deterministicInvoiceId);
    const draftReq = draftStore.get(ocrDraftId);

    let initialReadsRemaining = 3;
    let initialBarrierEntered = false;

    const onInitialReadDone = () => {
      initialReadsRemaining -= 1;
      if (initialReadsRemaining > 0 || initialBarrierEntered || settled) return;
      initialBarrierEntered = true;

      try {
        const rawIdempotencyRecord = idempotencyReq.result as unknown;
        const existingInvoice = (existingInvoiceReq.result as PurchaseInvoice | undefined) ?? null;
        const storedDraft = (draftReq.result as SupplierInvoiceDraft | undefined) ?? null;

        // =====================================================================
        // STEP 2: Validate initial read results at the validation barrier
        // =====================================================================
        if (rawIdempotencyRecord !== undefined && rawIdempotencyRecord !== null) {
          if (typeof rawIdempotencyRecord !== 'object' || Array.isArray(rawIdempotencyRecord)) {
            throw new Error('OCR_IDEMPOTENCY_RECORD_CORRUPTED');
          }
          const recObj = rawIdempotencyRecord as Record<string, unknown>;
          if (
            recObj.key !== idempotencyKey ||
            recObj.schemaVersion !== OCR_PURCHASE_POSTING_SCHEMA_VERSION ||
            recObj.source !== 'OCR' ||
            recObj.ocrDraftId !== ocrDraftId
          ) {
            throw new Error('OCR_IDEMPOTENCY_RECORD_CORRUPTED');
          }

          if (recObj.status === 'RESERVED') {
            throw new Error('OCR_IDEMPOTENCY_RESERVATION_CONFLICT');
          }
          if (recObj.status !== 'COMMITTED') {
            throw new Error('OCR_IDEMPOTENCY_RECORD_CORRUPTED');
          }

          // COMMITTED REPLAY PATH — Zero supplier lookup, zero medicine lookup
          const committedRecord = rawIdempotencyRecord as OcrPurchaseIdempotencyRecord;
          if (
            committedRecord.purchaseInvoiceId !== deterministicInvoiceId ||
            committedRecord.canonicalVersion !== OCR_PURCHASE_CANONICAL_VERSION ||
            typeof committedRecord.supplierId !== 'string' ||
            !committedRecord.supplierId.trim() ||
            typeof committedRecord.canonicalHash !== 'string' ||
            !committedRecord.canonicalHash.trim() ||
            typeof committedRecord.canonicalJson !== 'string' ||
            !committedRecord.canonicalJson ||
            !committedRecord.canonicalPayloadSnapshot ||
            typeof committedRecord.canonicalPayloadSnapshot !== 'object' ||
            !Array.isArray(committedRecord.canonicalPayloadSnapshot.unitSnapshots)
          ) {
            throw new Error('OCR_IDEMPOTENCY_RECORD_CORRUPTED');
          }

          const recomputedCommittedSnapshot = createOcrPurchaseCanonicalSnapshotFromPayload(
            committedRecord.canonicalPayloadSnapshot
          );
          if (
            recomputedCommittedSnapshot.sha256 !== committedRecord.canonicalHash ||
            recomputedCommittedSnapshot.canonicalJson !== committedRecord.canonicalJson
          ) {
            throw new Error('OCR_IDEMPOTENCY_RECORD_CORRUPTED');
          }

          if (
            !isMatchingOcrPurchaseIdempotencyRecord(committedRecord, {
              ocrDraftId,
              supplierId: committedRecord.supplierId,
              canonicalHash: committedRecord.canonicalHash,
              purchaseInvoiceId: deterministicInvoiceId
            })
          ) {
            throw new Error('OCR_IDEMPOTENCY_RECORD_MISMATCH');
          }

          if (
            typeof params.expectedSupplierId === 'string' &&
            params.expectedSupplierId.trim() &&
            params.expectedSupplierId.trim() !== committedRecord.supplierId
          ) {
            throw new Error('OCR_IDEMPOTENCY_SUPPLIER_MISMATCH');
          }

          if (
            typeof params.expectedCanonicalHash === 'string' &&
            params.expectedCanonicalHash.trim() &&
            params.expectedCanonicalHash.trim() !== committedRecord.canonicalHash
          ) {
            throw new Error('OCR_IDEMPOTENCY_HASH_MISMATCH');
          }

          // Verify persisted invoice provenance
          assertOcrPurchaseInvoiceProvenance(existingInvoice, {
            ocrDraftId,
            supplierId: committedRecord.supplierId,
            canonicalHash: committedRecord.canonicalHash,
            invoiceId: deterministicInvoiceId
          });
          if (
            existingInvoice!.ocrCanonicalVersion !== undefined &&
            existingInvoice!.ocrCanonicalVersion !== committedRecord.canonicalVersion
          ) {
            throw new Error('OCR_IDEMPOTENCY_PROVENANCE_MISMATCH_REQUIRES_RECONCILIATION');
          }

          // Verify caller's payment intent & payload match the committed snapshot
          const replayPaymentType: OcrPurchasePaymentType =
            params.paymentType ?? committedRecord.canonicalPayloadSnapshot.paymentIntent.paymentType;

          const explicitCallerActor =
            typeof params.postingActor === 'string' && params.postingActor.trim()
              ? params.postingActor.trim()
              : '';

          const resolveReplayPaidAmountInput = (): number | string => {
            if (params.paidAmount !== undefined) {
              return params.paidAmount;
            }
            if (
              params.paymentType === undefined ||
              replayPaymentType === committedRecord.canonicalPayloadSnapshot.paymentIntent.paymentType
            ) {
              return committedRecord.canonicalPayloadSnapshot.paymentIntent.paidAmount;
            }
            if (replayPaymentType === 'Cash') {
              return committedRecord.canonicalPayloadSnapshot.invoice.finalTotal;
            }
            if (replayPaymentType === 'Credit') {
              return '0';
            }
            throw new Error('OCR_IDEMPOTENCY_PAYMENT_INTENT_MISMATCH');
          };

          const replayPaidAmountInput = resolveReplayPaidAmountInput();

          const draftCandidatesToVerify: SupplierInvoiceDraft[] = [];
          if (storedDraft) draftCandidatesToVerify.push(storedDraft);
          if (params.draftSnapshot) draftCandidatesToVerify.push(params.draftSnapshot);

          if (draftCandidatesToVerify.length > 0) {
            for (const candidateDraft of draftCandidatesToVerify) {
              if (candidateDraft.id !== ocrDraftId) {
                throw new Error('OCR_IDEMPOTENCY_PAYLOAD_MISMATCH');
              }
              if (
                candidateDraft.status === 'POSTED' &&
                candidateDraft.postedInvoiceId &&
                candidateDraft.postedInvoiceId !== deterministicInvoiceId
              ) {
                throw new Error('OCR_IDEMPOTENCY_PROVENANCE_MISMATCH_REQUIRES_RECONCILIATION');
              }
              const replayActor =
                explicitCallerActor || committedRecord.canonicalPayloadSnapshot.postingActor;

              const normalizedCandidate = prepareOcrDraftForCanonicalPosting(
                candidateDraft,
                replayActor
              );
              const unpostedProjection: SupplierInvoiceDraft =
                normalizedCandidate.status === 'POSTED'
                  ? { ...normalizedCandidate, status: 'VERIFIED', postedInvoiceId: undefined }
                  : { ...normalizedCandidate, postedInvoiceId: undefined };

              const callerBasePayload = buildOcrPurchaseCanonicalPayload(
                unpostedProjection,
                {
                  paymentType: replayPaymentType,
                  paidAmount: replayPaidAmountInput,
                  currency:
                    normalizedCandidate.header?.currency?.value ||
                    committedRecord.canonicalPayloadSnapshot.paymentIntent.currency
                },
                replayActor,
                trustedActor.activeBranchId
              );
              const candidatePostingPayload: OcrPurchaseCanonicalPostingPayload = {
                ...callerBasePayload,
                unitSnapshots: committedRecord.canonicalPayloadSnapshot.unitSnapshots
              };
              const candidateSnapshot = createOcrPurchaseCanonicalSnapshotFromPayload(
                candidatePostingPayload
              );
              if (
                candidateSnapshot.sha256 !== committedRecord.canonicalHash ||
                candidateSnapshot.canonicalJson !== committedRecord.canonicalJson
              ) {
                throw new Error('OCR_IDEMPOTENCY_PAYLOAD_MISMATCH');
              }
            }
          } else {
            // Draft was already deleted after commit: verify payment intent, branch binding & actor against committedRecord
            if (
              committedRecord.canonicalPayloadSnapshot.approvedBranchId &&
              committedRecord.canonicalPayloadSnapshot.approvedBranchId !== trustedActor.activeBranchId
            ) {
              throw new Error('OCR_APPROVAL_BRANCH_MISMATCH');
            }
            if (
              replayPaymentType !== committedRecord.canonicalPayloadSnapshot.paymentIntent.paymentType ||
              replayPaymentType !== committedRecord.initialPaymentIntent.paymentType
            ) {
              throw new Error('OCR_IDEMPOTENCY_PAYMENT_INTENT_MISMATCH');
            }
            const callerPaidDecimal =
              typeof replayPaidAmountInput === 'number'
                ? toExactDecimalInputFromNumber(replayPaidAmountInput, 'paidAmount')
                : String(replayPaidAmountInput).trim();
            const callerPaidRational = parseExactDecimal(callerPaidDecimal, 'paidAmount');
            const committedPaidRational = parseExactDecimal(
              String(committedRecord.canonicalPayloadSnapshot.paymentIntent.paidAmount),
              'committedPaidAmount'
            );
            if (compareRational(callerPaidRational, committedPaidRational) !== 0) {
              throw new Error('OCR_IDEMPOTENCY_PAYMENT_INTENT_MISMATCH');
            }
            if (
              explicitCallerActor &&
              explicitCallerActor !== committedRecord.canonicalPayloadSnapshot.postingActor
            ) {
              throw new Error('OCR_IDEMPOTENCY_PAYLOAD_MISMATCH');
            }
          }

          // Repair stored draft to POSTED if it still exists and is not yet POSTED
          if (
            storedDraft &&
            (storedDraft.status !== 'POSTED' || storedDraft.postedInvoiceId !== deterministicInvoiceId)
          ) {
            const repairedDraft: SupplierInvoiceDraft = {
              ...storedDraft,
              status: 'POSTED',
              errorMessage: undefined,
              postedInvoiceId: deterministicInvoiceId,
              updatedAt: nowIso
            };
            const repairReq = draftStore.put(repairedDraft);
            repairReq.onerror = (event) => {
              event?.preventDefault?.();
              abortWith(repairReq.error || new Error('OCR_DRAFT_REPAIR_WRITE_FAILED'));
            };
          }

          finalInvoiceRecord = existingInvoice!;
          return;
        }

        // NO IDEMPOTENCY RECORD EXISTS — Enforce fail-closed Step 0 guards
        if (existingInvoice !== null) {
          throw new Error('OCR_INVOICE_EXISTS_WITHOUT_IDEMPOTENCY_RECORD');
        }

        if (
          storedDraft &&
          (storedDraft.status === 'POSTED' ||
            (typeof storedDraft.postedInvoiceId === 'string' &&
              storedDraft.postedInvoiceId.trim().length > 0))
        ) {
          throw new Error('OCR_DRAFT_POSTED_WITHOUT_IDEMPOTENCY_RECORD');
        }

        if (
          params.draftSnapshot &&
          (params.draftSnapshot.status === 'POSTED' ||
            (typeof params.draftSnapshot.postedInvoiceId === 'string' &&
              params.draftSnapshot.postedInvoiceId.trim().length > 0))
        ) {
          throw new Error('OCR_DRAFT_POSTED_WITHOUT_IDEMPOTENCY_RECORD');
        }

        // Fresh posting MUST read the persisted storedDraft from IndexedDB; never fall back to caller draftSnapshot
        if (!storedDraft) {
          throw new Error('OCR_DRAFT_NOT_FOUND: لم يتم العثور على المسودة المحفوظة المطلوبة للترحيل.');
        }
        if (storedDraft.id !== ocrDraftId) {
          throw new Error('OCR_DRAFT_ID_MISMATCH');
        }

        if (
          typeof params.expectedUpdatedAt === 'string' &&
          params.expectedUpdatedAt.trim() &&
          storedDraft.updatedAt !== params.expectedUpdatedAt.trim()
        ) {
          throw new Error(
            'OCR_APPROVAL_STALE_DRAFT_CONFLICT: تم تعديل المسودة في تبويب أو جلسة أخرى؛ يرجى تحديث البيانات ومراجعة الاعتماد قبل الترحيل.'
          );
        }

        if (params.draftSnapshot) {
          if (params.draftSnapshot.id !== ocrDraftId) {
            throw new Error('OCR_DRAFT_ID_MISMATCH');
          }
          if (!haveSameOcrCanonicalFields(storedDraft, params.draftSnapshot)) {
            throw new Error(
              'OCR_APPROVAL_STALE_DRAFT_CONFLICT: بيانات المسودة المعروضة لا تطابق النسخة المحفوظة في قاعدة البيانات؛ يرجى التحديث وإعادة المراجعة.'
            );
          }
        }

        const sourceDraft = storedDraft;
        const effectivePostingActor = trustedActor.uid;

        const requestedPaymentType: OcrPurchasePaymentType =
          params.paymentType ??
          sourceDraft.approval?.approvedPaymentIntent?.paymentType ??
          sourceDraft.paymentType ??
          'Credit';
        if (
          requestedPaymentType !== 'Cash' &&
          requestedPaymentType !== 'Credit' &&
          requestedPaymentType !== 'Partial'
        ) {
          throw new Error(
            `OCR_INVALID_PAYMENT_TYPE: نوع الدفع "${String(requestedPaymentType)}" غير صالح.`
          );
        }

        const normalizedDraft = prepareOcrDraftForCanonicalPosting(
          sourceDraft,
          effectivePostingActor
        );

        const resolvedInitialPaidInput: number | string | undefined =
          params.paidAmount !== undefined
            ? params.paidAmount
            : sourceDraft.approval?.approvedPaymentIntent &&
                sourceDraft.approval.approvedPaymentIntent.paymentType === requestedPaymentType
              ? sourceDraft.approval.approvedPaymentIntent.paidAmount
              : requestedPaymentType === 'Cash'
                ? (normalizedDraft.header?.finalTotal?.value ?? 0)
                : requestedPaymentType === 'Credit'
                  ? '0'
                  : undefined;

        if (resolvedInitialPaidInput === undefined) {
          throw new Error('OCR_PARTIAL_PAYMENT_AMOUNT_REQUIRED');
        }

        // Pre-validate persisted approval metadata before writing transaction-local 'RESERVED'
        assertStoredOcrDraftApprovalPrecheck(
          sourceDraft,
          trustedActor,
          requestedPaymentType,
          resolvedInitialPaidInput,
          nowIso
        );

        const basePayload = buildOcrPurchaseCanonicalPayload(
          normalizedDraft,
          {
            paymentType: requestedPaymentType,
            paidAmount: resolvedInitialPaidInput,
            currency: normalizedDraft.header?.currency?.value || 'SDG'
          },
          effectivePostingActor,
          trustedActor.activeBranchId
        );
        const baseCanonicalSnapshot = createOcrPurchaseCanonicalSnapshotFromPayload(basePayload);

        if (
          typeof params.expectedSupplierId === 'string' &&
          params.expectedSupplierId.trim() &&
          params.expectedSupplierId.trim() !== basePayload.supplier.id
        ) {
          throw new Error('OCR_SUPPLIER_ID_MISMATCH');
        }

        // =====================================================================
        // STEP 3: Schedule the idempotency reservation write ('RESERVED')
        // =====================================================================
        const reservationRecord: OcrPurchaseTransactionReservation = {
          key: idempotencyKey,
          schemaVersion: OCR_PURCHASE_POSTING_SCHEMA_VERSION,
          source: 'OCR',
          ocrDraftId,
          status: 'RESERVED',
          canonicalHash: baseCanonicalSnapshot.sha256,
          supplierId: basePayload.supplier.id,
          purchaseInvoiceId: deterministicInvoiceId
        };

        const reservePutReq = metadataStore.put(reservationRecord);
        reservePutReq.onerror = (event) => {
          event?.preventDefault?.();
          abortWith(
            reservePutReq.error || new Error('OCR_IDEMPOTENCY_RESERVATION_WRITE_FAILED')
          );
        };

        // =====================================================================
        // STEP 4: In reservePutReq.onsuccess, schedule supplier, medicine,
        //         outbox, quarantine, and ledger reads synchronously
        // =====================================================================
        reservePutReq.onsuccess = () => {
          if (settled) return;
          try {
            const supplierId = basePayload.supplier.id;
            const uniqueMedicineIds = Array.from(
              new Set(basePayload.items.map((item) => item.medicineId))
            );

            let supplierRecord: Supplier | undefined;
            let supplierInvoices: PurchaseInvoice[] = [];
            let existingOutboxEntries: OutboxEntry[] = [];
            const medMap = new Map<string, Medicine>();
            const quarantineRecordsByMedicineId = new Map<string, unknown>();
            const existingBaseUnitsByMedicineId = new Map<string, number>();

            // 3 base reads (supplier, supplierInvoices, outbox) + 3 reads per unique medicine
            let step4ReadsRemaining = 3 + uniqueMedicineIds.length * 3;
            let step4BarrierEntered = false;

            const onStep4ReadDone = () => {
              step4ReadsRemaining -= 1;
              if (step4ReadsRemaining > 0 || step4BarrierEntered || settled) return;
              step4BarrierEntered = true;

              try {
                // =============================================================
                // STEP 5: Validate dependent reads, build unitSnapshots & final
                //         canonical hash synchronously, and schedule writes
                // =============================================================
                if (!supplierRecord) {
                  throw new Error(`المورد غير موجود: ${supplierId}`);
                }
                if (supplierRecord.archived || supplierRecord.status === 'archived') {
                  throw new Error(
                    `COMMERCIAL_TARGET_ARCHIVED: المورد "${supplierRecord.name?.ar || supplierRecord.id}" مؤرشف ولا يمكن تسجيل فواتير شراء له`
                  );
                }
                if (supplierRecord.status === 'inactive' || (supplierRecord.status && supplierRecord.status !== 'active')) {
                  throw new Error(
                    `المورد "${supplierRecord.name?.ar || supplierRecord.id}" معطل حالياً. لا يمكن تسجيل فواتير شراء لمورد معطل.`
                  );
                }

                const invoiceNumber = basePayload.invoice.number;
                const cleanInvoiceNumberLower = invoiceNumber.trim().toLowerCase();
                const duplicateSupplierInvoice = supplierInvoices.some(
                  (inv) =>
                    inv.id !== deterministicInvoiceId &&
                    inv.supplierId === supplierRecord!.id &&
                    inv.invoiceNumber &&
                    inv.invoiceNumber.trim().toLowerCase() === cleanInvoiceNumberLower
                );
                if (duplicateSupplierInvoice) {
                  throw new Error(
                    `رقم الفاتورة "${invoiceNumber}" مسجل مسبقاً للمورد "${supplierRecord.name?.ar || supplierRecord.id}". تم منع التكرار لحماية السجلات المالية.`
                  );
                }

                for (const medId of uniqueMedicineIds) {
                  const targetMed = medMap.get(medId);
                  if (!targetMed) {
                    throw new Error(`الصنف غير مسجل في قائمة الأدوية: ${medId}`);
                  }
                  if (targetMed.archived) {
                    throw new Error(
                      `COMMERCIAL_TARGET_ARCHIVED: الصنف "${targetMed.name || targetMed.id}" مؤرشف ولا يمكن شراؤه`
                    );
                  }
                  const quarantineReason = getMedicineQuarantineMutationBlockReason(
                    targetMed,
                    quarantineRecordsByMedicineId.get(medId)
                  );
                  if (quarantineReason) {
                    throw new Error(
                      `MEDICINE_QUARANTINED: Purchase invoice blocked for '${medId}' (${quarantineReason}).`
                    );
                  }
                  assertMedicineOperationallyAllowed(targetMed);
                  validateMedicineUnitConfiguration(targetMed);
                }

                // Construct OcrPurchaseUnitSnapshot in exact invoice line order
                const unitSnapshots: OcrPurchaseUnitSnapshot[] = basePayload.items.map((item) => {
                  const targetMed = medMap.get(item.medicineId)!;
                  if (item.unit !== 'pack' && item.unit !== 'strip' && item.unit !== 'pill') {
                    throw new Error(`UNSUPPORTED_ITEM_UNIT: الوحدة "${String(item.unit)}" غير معتمدة.`);
                  }
                  return buildOcrPurchaseUnitSnapshotForLine(targetMed, item.unit);
                });

                const postingPayload: OcrPurchaseCanonicalPostingPayload = {
                  ...basePayload,
                  unitSnapshots
                };
                const finalPostingSnapshot = createOcrPurchaseCanonicalSnapshotFromPayload(
                  postingPayload
                );

                // Validate persisted human approval against the FINAL canonical posting snapshot
                // (including transaction-time unitSnapshots, actor UID, role, and payment intent).
                const validatedApproval = assertValidOcrDraftHumanApproval(
                  sourceDraft,
                  trustedActor,
                  finalPostingSnapshot,
                  nowIso
                );

                if (
                  typeof params.expectedCanonicalHash === 'string' &&
                  params.expectedCanonicalHash.trim() &&
                  params.expectedCanonicalHash.trim() !== finalPostingSnapshot.sha256
                ) {
                  throw new Error('OCR_CANONICAL_HASH_MISMATCH');
                }

                // Validate outbox dependency graph before scheduling writes
                const knownBranchId = getKnownActiveBranchId();
                const knownActorUid = getKnownActiveActorId();
                const outboxDepIndex = buildOutboxDependencyIndex(existingOutboxEntries);
                const invoiceMedicineIdSet = new Set(uniqueMedicineIds);
                const relevantOutboxEntries = existingOutboxEntries.filter(
                  (e) =>
                    e &&
                    ((e.entityType === 'medicine' && invoiceMedicineIdSet.has(e.entityId)) ||
                      (e.entityType === 'supplier' && e.entityId === supplierRecord!.id))
                );
                for (const entry of relevantOutboxEntries) {
                  validateOutboxRecordDependencies(entry, outboxDepIndex);
                }

                const unsyncedSupplierCreateOpIds: string[] = [];
                for (const supCreate of existingOutboxEntries) {
                  if (
                    supCreate &&
                    supCreate.entityType === 'supplier' &&
                    supCreate.entityId === supplierRecord.id &&
                    supCreate.action === 'CREATE' &&
                    supCreate.status !== 'synced'
                  ) {
                    validateOutboxRecordDependencies(supCreate, outboxDepIndex);
                    const supCreateOpId = getCanonicalOutboxOperationId(supCreate);
                    if (supCreateOpId && !unsyncedSupplierCreateOpIds.includes(supCreateOpId)) {
                      unsyncedSupplierCreateOpIds.push(supCreateOpId);
                    }
                  }
                }

                // Exact Rational financial, identity, and inventory costing validation (zero tax participation, zero override bypass)
                const {
                  subtotalExact,
                  discountExact,
                  finalTotalExact,
                  paidAmountExact
                } = validateOcrCanonicalFinancialsAndLines(
                  basePayload,
                  sourceDraft,
                  medMap,
                  requestedPaymentType,
                  todayStr
                );

                const fullItems: PurchaseInvoiceItem[] = [];
                const ledgerEntries: LedgerMovement[] = [];
                const updatedMedicineMap = new Map<string, Medicine>();

                for (let i = 0; i < basePayload.items.length; i += 1) {
                  const item = basePayload.items[i];
                  const baseMed =
                    updatedMedicineMap.get(item.medicineId) || medMap.get(item.medicineId)!;
                  const unit: UnitKind = item.unit as UnitKind;
                  const itemQty = Number(item.quantity);
                  const directPack = isDirectPackMedicine(baseMed);
                  const baseUnitsPerPack = getMedicineBaseUnitsPerPack(baseMed);
                  const stripsPerPack = directPack ? 0 : Number(baseMed.stripsPerPack);
                  const pillsPerStrip = directPack ? 0 : Number(baseMed.pillsPerStrip);
                  const baseUnits = convertMedicineQuantityToBaseUnits(
                    itemQty,
                    unit,
                    baseMed
                  );
                  const itemExpiry = item.expiryDate.trim();

                  const buyPriceExact = parseExactDecimal(
                    item.unitBuyPrice,
                    `items[${i}].unitBuyPrice`
                  );
                  const itemDiscountExact = parseExactDecimal(
                    item.itemDiscount,
                    `items[${i}].itemDiscount`
                  );
                  const grossLineCostExact = parseExactDecimal(
                    item.lineTotal,
                    `items[${i}].lineTotal`
                  );

                  const costPerBaseUnitExact = divideRational(
                    grossLineCostExact,
                    createRational(BigInt(baseUnits))
                  );
                  const normalizedPackBuyPriceExact = multiplyRational(
                    costPerBaseUnitExact,
                    createRational(BigInt(baseUnitsPerPack))
                  );
                  const itemBuyPriceNum = ocrRationalToDisplayCompatibilityNumber(
                    buyPriceExact,
                    'سعر شراء الوحدة'
                  );
                  const itemDiscountNum = ocrRationalToDisplayCompatibilityNumber(
                    itemDiscountExact,
                    'خصم البند'
                  );
                  const lineCostNum = ocrRationalToDisplayCompatibilityNumber(
                    grossLineCostExact,
                    'إجمالي بند الشراء'
                  );
                  const costPerBaseUnitNum = ocrRationalToDisplayCompatibilityNumber(
                    costPerBaseUnitExact,
                    'تكلفة الوحدة الأساسية'
                  );
                  const normalizedPackBuyPriceNum = ocrRationalToDisplayCompatibilityNumber(
                    normalizedPackBuyPriceExact,
                    'تكلفة العبوة المطبعة'
                  );

                  const suggestedSellPriceNum =
                    item.suggestedSellPrice !== null
                      ? ocrRationalToDisplayCompatibilityNumber(
                          parseExactDecimal(
                            item.suggestedSellPrice,
                            `items[${i}].suggestedSellPrice`
                          ),
                          'سعر البيع المقترح'
                        )
                      : undefined;

                  const movementId = generateUUID();
                  const itemId = generateUUID();

                  fullItems.push({
                    id: itemId,
                    medicineId: item.medicineId,
                    medicineName: baseMed.name,
                    batchNumber: item.batchNumber.trim(),
                    expiry: itemExpiry,
                    expiryDate: itemExpiry,
                    quantity: itemQty,
                    unit,
                    stripsPerPack,
                    pillsPerStrip,
                    baseUnits,
                    baseUnitsPerPack,
                    buyPrice: itemBuyPriceNum,
                    buyPriceExact,
                    itemDiscount: itemDiscountNum,
                    itemDiscountExact,
                    grossLineCostExact,
                    totalCostExact: grossLineCostExact,
                    costPerBaseUnitExact,
                    normalizedPackBuyPriceExact,
                    costPerBaseUnit: costPerBaseUnitNum,
                    normalizedPackBuyPrice: normalizedPackBuyPriceNum,
                    unitBuyPrice: itemBuyPriceNum,
                    // Preserve existing medicine selling price; never mutate sellPrice during OCR purchase posting
                    sellPrice: baseMed.sellPrice,
                    ...(suggestedSellPriceNum !== undefined
                      ? { suggestedSellPrice: suggestedSellPriceNum }
                      : {}),
                    totalCost: lineCostNum,
                    total: lineCostNum,
                    ledgerMovementId: movementId
                  });

                  ledgerEntries.push({
                    id: movementId,
                    medicineId: item.medicineId,
                    batchNumber: item.batchNumber.trim(),
                    expiry: itemExpiry,
                    type: 'PURCHASE',
                    unit,
                    quantityDelta: itemQty,
                    baseUnitsDelta: baseUnits,
                    costPerUnit: itemBuyPriceNum,
                    costPerUnitExact: buyPriceExact,
                    costPerBaseUnit: costPerBaseUnitNum,
                    costPerBaseUnitExact,
                    referenceId: invoiceNumber,
                    deviceId,
                    userId: effectivePostingActor,
                    employeeName: effectivePostingActor,
                    notes: `فاتورة شراء OCR #${invoiceNumber} من المورد ${supplierRecord.name?.ar || supplierRecord.id}`,
                    timestamp: nowIso,
                    synced: 0
                  });
                }

                // Allocate invoice-level discount proportionally across post-item-discount lines (zero double discounting)
                const discountAllocation = allocateExactProportionalDiscountRational(
                  fullItems.map((item) => item.grossLineCostExact!),
                  discountExact
                );
                if (compareRational(discountAllocation.subtotal, subtotalExact) !== 0) {
                  throw new Error('SUBTOTAL_LINE_SUM_MISMATCH');
                }
                let allocatedInventorySumExact = createRational(0n);
                for (const netLine of discountAllocation.netLineCosts) {
                  allocatedInventorySumExact = addRational(allocatedInventorySumExact, netLine);
                }
                if (compareRational(allocatedInventorySumExact, finalTotalExact) !== 0) {
                  throw new Error('HEADER_TOTAL_MISMATCH');
                }

                const runningBaseUnitsMap = new Map<string, number>(existingBaseUnitsByMedicineId);

                fullItems.forEach((invoiceItem, index) => {
                  const netLineCostExact = discountAllocation.netLineCosts[index];
                  const discountShareExact = discountAllocation.shares[index];
                  const netUnitBuyPriceExact = divideRational(
                    netLineCostExact,
                    createRational(BigInt(invoiceItem.quantity))
                  );
                  const netCostPerBaseUnitExact = divideRational(
                    netLineCostExact,
                    createRational(BigInt(invoiceItem.baseUnits))
                  );
                  const normalizedPackBuyPriceExact = multiplyRational(
                    netCostPerBaseUnitExact,
                    createRational(BigInt(invoiceItem.baseUnitsPerPack))
                  );

                  const netLineCost = ocrRationalToDisplayCompatibilityNumber(
                    netLineCostExact,
                    'صافي تكلفة بند الشراء'
                  );
                  const discountShare = ocrRationalToDisplayCompatibilityNumber(
                    discountShareExact,
                    'حصة خصم بند الشراء'
                  );
                  const netUnitBuyPrice = ocrRationalToDisplayCompatibilityNumber(
                    netUnitBuyPriceExact,
                    'تكلفة وحدة الشراء بعد الخصم'
                  );
                  const netCostPerBaseUnit = ocrRationalToDisplayCompatibilityNumber(
                    netCostPerBaseUnitExact,
                    'تكلفة الوحدة الأساسية بعد الخصم'
                  );
                  const normalizedPackBuyPrice = ocrRationalToDisplayCompatibilityNumber(
                    normalizedPackBuyPriceExact,
                    'تكلفة العبوة بعد الخصم'
                  );

                  invoiceItem.discountShareExact = discountShareExact;
                  invoiceItem.netCostExact = netLineCostExact;
                  invoiceItem.netUnitBuyPriceExact = netUnitBuyPriceExact;
                  invoiceItem.costPerBaseUnitExact = netCostPerBaseUnitExact;
                  invoiceItem.normalizedPackBuyPriceExact = normalizedPackBuyPriceExact;
                  invoiceItem.discountShare = discountShare;
                  invoiceItem.netCost = netLineCost;
                  invoiceItem.netUnitBuyPrice = netUnitBuyPrice;
                  invoiceItem.costPerBaseUnit = netCostPerBaseUnit;
                  invoiceItem.normalizedPackBuyPrice = normalizedPackBuyPrice;

                  if (ledgerEntries[index]) {
                    ledgerEntries[index].costPerUnit = netUnitBuyPrice;
                    ledgerEntries[index].costPerUnitExact = netUnitBuyPriceExact;
                    ledgerEntries[index].costPerBaseUnit = netCostPerBaseUnit;
                    ledgerEntries[index].costPerBaseUnitExact = netCostPerBaseUnitExact;
                  }

                  const priorMed =
                    updatedMedicineMap.get(invoiceItem.medicineId) ||
                    medMap.get(invoiceItem.medicineId)!;
                  const existingBaseUnits = Math.max(
                    0,
                    runningBaseUnitsMap.get(invoiceItem.medicineId) || 0
                  );
                  const existingPackBuyPriceExact: Rational =
                    priorMed.buyPriceExact ??
                    parseExactDecimal(
                      toExactDecimalInputFromNumber(
                        Math.max(0, Number(priorMed.buyPrice) || 0),
                        'buyPrice'
                      ),
                      'buyPrice'
                    );

                  const costMovements: Array<{ baseUnitsDelta: string; costPerBaseUnit: Rational }> = [];
                  if (existingBaseUnits > 0) {
                    costMovements.push({
                      baseUnitsDelta: String(existingBaseUnits),
                      costPerBaseUnit: divideRational(
                        existingPackBuyPriceExact,
                        createRational(BigInt(invoiceItem.baseUnitsPerPack))
                      )
                    });
                  }
                  costMovements.push({
                    baseUnitsDelta: String(invoiceItem.baseUnits),
                    costPerBaseUnit: netCostPerBaseUnitExact
                  });

                  const weightedCost = calculateExactWeightedBatchCostRational(costMovements);
                  const weightedBuyPricePerPackExact = multiplyRational(
                    weightedCost.costPerBaseUnit,
                    createRational(BigInt(invoiceItem.baseUnitsPerPack))
                  );

                  runningBaseUnitsMap.set(
                    invoiceItem.medicineId,
                    existingBaseUnits + invoiceItem.baseUnits
                  );

                  const weightedPackBuyPrice = ocrRationalToDisplayCompatibilityNumber(
                    weightedBuyPricePerPackExact,
                    'تكلفة العبوة المرجحة'
                  );

                  // Update medicine buyPrice, buyPriceExact, batchNumber, expiry, packingLocked, updatedAt
                  // while strictly preserving existing sellPrice!
                  updatedMedicineMap.set(invoiceItem.medicineId, {
                    ...priorMed,
                    buyPrice: weightedPackBuyPrice,
                    buyPriceExact: weightedBuyPricePerPackExact,
                    sellPrice: priorMed.sellPrice,
                    batchNumber: invoiceItem.batchNumber,
                    expiry: invoiceItem.expiry,
                    packingLocked: true,
                    ...(priorMed.unitDefinition
                      ? {
                          unitDefinition: {
                            ...priorMed.unitDefinition,
                            packingLocked: true
                          }
                        }
                      : {}),
                    updatedAt: nowIso
                  });
                });

                const totalAmount = ocrRationalToDisplayCompatibilityNumber(
                  subtotalExact,
                  'إجمالي فاتورة الشراء'
                );
                const discount = ocrRationalToDisplayCompatibilityNumber(
                  discountExact,
                  'خصم فاتورة الشراء'
                );
                const netAmount = ocrRationalToDisplayCompatibilityNumber(
                  finalTotalExact,
                  'صافي فاتورة الشراء'
                );
                const paidAmount = ocrRationalToDisplayCompatibilityNumber(
                  paidAmountExact,
                  'المبلغ المدفوع'
                );
                const remainingExact = subtractRational(finalTotalExact, paidAmountExact);
                const remainingAmount = ocrRationalToDisplayCompatibilityNumber(
                  remainingExact,
                  'المبلغ المتبقي'
                );

                let paymentStatus: 'Paid' | 'Partial' | 'Unpaid' = 'Unpaid';
                if (compareRational(remainingExact, createRational(0n)) === 0) {
                  paymentStatus = 'Paid';
                } else if (compareRational(paidAmountExact, createRational(0n)) > 0) {
                  paymentStatus = 'Partial';
                }

                const paymentType: OcrPurchasePaymentType =
                  finalPostingSnapshot.payload.paymentIntent.paymentType;
                const invoiceDate = finalPostingSnapshot.payload.invoice.date;
                const notes = `تم الإدخال والاعتماد آلياً عبر نظام المسح الضوئي الذكي (OCR) - مسودة رقم ${ocrDraftId}`;

                const invoiceRecord: PurchaseInvoice = {
                  id: deterministicInvoiceId,
                  supplierId: supplierRecord.id,
                  supplierName: supplierRecord.name?.ar || supplierRecord.id,
                  invoiceNumber,
                  date: invoiceDate,
                  invoiceDate,
                  items: fullItems,
                  itemsCount: fullItems.length,
                  totalAmount,
                  subtotal: totalAmount,
                  discount,
                  netAmount,
                  subtotalExact,
                  discountExact,
                  netAmountExact: finalTotalExact,
                  paidAmountExact,
                  remainingAmountExact: remainingExact,
                  paidAmount,
                  remainingAmount,
                  paymentType,
                  paymentStatus,
                  notes,
                  createdAt: nowIso,
                  deviceId,
                  employeeName: effectivePostingActor,
                  synced: 0,
                  source: 'OCR',
                  ocrDraftId,
                  ocrCanonicalHash: finalPostingSnapshot.sha256,
                  ocrCanonicalVersion: OCR_PURCHASE_CANONICAL_VERSION,
                  ocrCanonicalPayloadSnapshot: finalPostingSnapshot.payload,
                  initialPaymentIntent: finalPostingSnapshot.payload.paymentIntent
                };

                // Write PurchaseInvoice & its Outbox entry
                const invoiceOutboxId = generateUUID();
                const invoiceOutboxOpId = invoiceOutboxId;
                const invoiceOutboxEntry: OutboxEntry = {
                  id: invoiceOutboxId,
                  operationId: invoiceOutboxOpId,
                  idempotencyKey: `purchase_invoice:CREATE:${invoiceRecord.id}`,
                  ...(knownBranchId ? { branchId: knownBranchId } : {}),
                  ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                  schemaVersion: 1,
                  ...(unsyncedSupplierCreateOpIds.length > 0
                    ? { dependsOn: [...unsyncedSupplierCreateOpIds] }
                    : {}),
                  entityType: 'purchase_invoice',
                  entityId: invoiceRecord.id,
                  action: 'CREATE',
                  payload: invoiceRecord,
                  timestamp: nowIso,
                  retryCount: 0,
                  attempts: 0,
                  status: 'pending'
                };
                invoiceStore.put(invoiceRecord);
                outboxStore.put(invoiceOutboxEntry);

                // Write updated medicines & consolidated medicine Outbox entries via resolveMedicineOutboxWriteShared(params, deps)
                const medCreateOpIdsByMed = new Map<string, string[]>();
                updatedMedicineMap.forEach((med) => {
                  medStore.put(med);
                  const { targetEntry: medOutboxEntry } = resolveMedicineOutboxWriteShared<
                    OutboxEntry,
                    Medicine
                  >(
                    {
                      existingEntries: existingOutboxEntries,
                      medicine: med,
                      actuallyNew: false,
                      knownBranchId,
                      knownActorUid,
                      nowIso
                    },
                    {
                      normalizeEntry: (entry) => normalizeOutboxEntry(entry),
                      isValidActorUid: (uid): uid is string => isValidFirebaseActorUid(uid),
                      generateId: () => generateUUID()
                    }
                  );
                  validateOutboxRecordDependencies(medOutboxEntry, outboxDepIndex);
                  const medOutboxOpId = getCanonicalOutboxOperationId(medOutboxEntry);

                  const unsyncedCreateEntries = existingOutboxEntries.filter(
                    (e) =>
                      e &&
                      e.entityType === 'medicine' &&
                      e.entityId === med.id &&
                      e.action === 'CREATE' &&
                      e.status !== 'synced' &&
                      e.id !== medOutboxEntry.id
                  );
                  const unsyncedCreateDepOpIds: string[] = [];
                  for (const createEntry of unsyncedCreateEntries) {
                    validateOutboxRecordDependencies(createEntry, outboxDepIndex);
                    const createOpId = getCanonicalOutboxOperationId(createEntry);
                    if (createOpId === medOutboxOpId) {
                      throw new Error(
                        `OUTBOX_DEPENDENCY_CORRUPT: تعارض تكرار operationId (${createOpId}) في سجلات Outbox للدواء "${med.id}"`
                      );
                    }
                    unsyncedCreateDepOpIds.push(createOpId);
                  }
                  if (
                    medOutboxEntry.dependsOn !== undefined &&
                    !Array.isArray(medOutboxEntry.dependsOn)
                  ) {
                    throw new Error(
                      `OUTBOX_DEPENDENCY_CORRUPT: حقل dependsOn للسجل "${medOutboxEntry.id}" ليس مصفوفة صالحة`
                    );
                  }
                  const normalizedExistingDeps =
                    medOutboxEntry.dependsOn !== undefined
                      ? normalizeDependsOnArray(medOutboxEntry.dependsOn, outboxDepIndex)
                      : [];
                  medOutboxEntry.dependsOn = Array.from(
                    new Set([
                      ...normalizedExistingDeps,
                      invoiceOutboxOpId,
                      ...unsyncedCreateDepOpIds
                    ])
                  ).filter(
                    (depOpId) => depOpId !== medOutboxOpId && depOpId !== medOutboxEntry.id
                  );
                  outboxStore.put(medOutboxEntry);

                  const allMedCreateDeps = [...unsyncedCreateDepOpIds];
                  if (
                    medOutboxEntry.action === 'CREATE' &&
                    medOutboxOpId &&
                    !allMedCreateDeps.includes(medOutboxOpId)
                  ) {
                    allMedCreateDeps.push(medOutboxOpId);
                  }
                  medCreateOpIdsByMed.set(med.id, allMedCreateDeps);
                });

                // Write inventory_ledger movements & outbox entries
                ledgerEntries.forEach((m) => {
                  if (knownActorUid) {
                    m.userId = knownActorUid;
                  }
                  ledgerStore.put(m);
                  const ledgerOutboxId = generateUUID();
                  const medCreateDeps = medCreateOpIdsByMed.get(m.medicineId) || [];
                  const ledgerOutboxEntry: OutboxEntry = {
                    id: ledgerOutboxId,
                    operationId: ledgerOutboxId,
                    idempotencyKey: `inventory_ledger:CREATE:${m.id}`,
                    ...(knownBranchId ? { branchId: knownBranchId } : {}),
                    ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                    schemaVersion: 1,
                    dependsOn: Array.from(new Set([invoiceOutboxOpId, ...medCreateDeps])),
                    entityType: 'inventory_ledger',
                    entityId: m.id,
                    action: 'CREATE',
                    payload: m,
                    timestamp: nowIso,
                    retryCount: 0,
                    attempts: 0,
                    status: 'pending'
                  };
                  outboxStore.put(ledgerOutboxEntry);
                });

                // R13-D.3 D1: Exact Rational supplier balance & transaction accounting (zero JS float math)
                const previousBalanceExact: Rational =
                  supplierRecord.balanceExact && isValidRational(supplierRecord.balanceExact)
                    ? normalizeRational(supplierRecord.balanceExact)
                    : parseExactDecimal(
                        toExactDecimalInputFromNumber(
                          Number.isFinite(Number(supplierRecord.balance))
                            ? Number(supplierRecord.balance)
                            : 0,
                          'supplier.balance'
                        ),
                        'supplier.balance'
                      );
                const balanceAfterInvoiceExact = addRational(previousBalanceExact, finalTotalExact);
                const newBalanceExact = subtractRational(balanceAfterInvoiceExact, paidAmountExact);
                const balanceAfterInvoiceNum = ocrRationalToDisplayCompatibilityNumber(
                  balanceAfterInvoiceExact,
                  'رصيد المورد بعد الفاتورة'
                );
                const newBalanceNum = ocrRationalToDisplayCompatibilityNumber(
                  newBalanceExact,
                  'رصيد المورد النهائي'
                );
                const updatedSupplier: Supplier = {
                  ...supplierRecord,
                  balance: newBalanceNum,
                  balanceExact: newBalanceExact,
                  updatedAt: nowIso
                };
                supStore.put(updatedSupplier);

                const { targetEntry: supOutboxEntry } = resolveSupplierOutboxWriteShared<
                  OutboxEntry,
                  Supplier
                >(
                  {
                    existingEntries: existingOutboxEntries,
                    supplier: updatedSupplier,
                    actuallyNew: false,
                    allowCoalesceCreate: false,
                    knownBranchId,
                    knownActorUid,
                    nowIso
                  },
                  {
                    normalizeEntry: (entry) => normalizeOutboxEntry(entry),
                    isValidActorUid: (uid): uid is string => isValidFirebaseActorUid(uid),
                    generateId: () => generateUUID()
                  }
                );
                const supOutboxOpId = getCanonicalOutboxOperationId(supOutboxEntry);
                const existingSupDeps = Array.isArray(supOutboxEntry.dependsOn)
                  ? normalizeDependsOnArray(supOutboxEntry.dependsOn, outboxDepIndex)
                  : [];
                supOutboxEntry.dependsOn = Array.from(
                  new Set([...existingSupDeps, invoiceOutboxOpId, ...unsyncedSupplierCreateOpIds])
                ).filter((d) => d !== supOutboxOpId && d !== supOutboxEntry.id);
                outboxStore.put(supOutboxEntry);

                // Write supplier_transactions (purchase liability + payment if paidAmount > 0)
                const txInvoiceId = generateUUID();
                const txInvoice: SupplierTransaction = {
                  id: txInvoiceId,
                  supplierId: supplierRecord.id,
                  type: 'PURCHASE_INVOICE',
                  referenceId: deterministicInvoiceId,
                  invoiceNumber,
                  voucherNumber: 'PI-' + invoiceNumber,
                  amount: netAmount,
                  amountExact: finalTotalExact,
                  effect: 'CREDIT',
                  credit: netAmount,
                  debit: 0,
                  balanceAfter: balanceAfterInvoiceNum,
                  balanceAfterExact: balanceAfterInvoiceExact,
                  date: invoiceDate,
                  timestamp: nowIso,
                  notes: `فاتورة شراء OCR #${invoiceNumber} (${fullItems.length} صنف)`,
                  employeeName: effectivePostingActor,
                  deviceId,
                  synced: 0
                };
                stStore.put(txInvoice);
                const stInvoiceOutboxId = generateUUID();
                outboxStore.put({
                  id: stInvoiceOutboxId,
                  operationId: stInvoiceOutboxId,
                  idempotencyKey: `supplier_transaction:CREATE:${txInvoice.id}`,
                  ...(knownBranchId ? { branchId: knownBranchId } : {}),
                  ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                  schemaVersion: 1,
                  dependsOn: Array.from(
                    new Set([invoiceOutboxOpId, ...unsyncedSupplierCreateOpIds])
                  ),
                  entityType: 'supplier_transaction',
                  entityId: txInvoice.id,
                  action: 'CREATE',
                  payload: txInvoice,
                  timestamp: nowIso,
                  retryCount: 0,
                  attempts: 0,
                  status: 'pending'
                });

                if (compareRational(paidAmountExact, createRational(0n)) > 0) {
                  const paymentTxId = generateUUID();
                  const paymentVoucher =
                    'PV-' +
                    todayStr.replace(/-/g, '') +
                    '-' +
                    paymentTxId.slice(0, 6).toUpperCase();
                  const txPayment: SupplierTransaction = {
                    id: paymentTxId,
                    supplierId: supplierRecord.id,
                    type: 'PAYMENT',
                    referenceId: deterministicInvoiceId,
                    invoiceNumber,
                    voucherNumber: paymentVoucher,
                    amount: paidAmount,
                    amountExact: paidAmountExact,
                    effect: 'DEBIT',
                    debit: paidAmount,
                    credit: 0,
                    balanceAfter: newBalanceNum,
                    balanceAfterExact: newBalanceExact,
                    paymentMethod: 'Cash',
                    invoiceAllocations: [
                      {
                        invoiceId: deterministicInvoiceId,
                        invoiceNumber,
                        amount: paidAmount
                      }
                    ],
                    date: invoiceDate,
                    timestamp: new Date(Date.parse(nowIso) + 10).toISOString(),
                    notes: `سداد فوري لفاتورة الشراء OCR #${invoiceNumber}`,
                    employeeName: effectivePostingActor,
                    deviceId,
                    synced: 0
                  };
                  stStore.put(txPayment);
                  const stPaymentOutboxId = generateUUID();
                  outboxStore.put({
                    id: stPaymentOutboxId,
                    operationId: stPaymentOutboxId,
                    idempotencyKey: `supplier_transaction:CREATE:${txPayment.id}`,
                    ...(knownBranchId ? { branchId: knownBranchId } : {}),
                    ...(knownActorUid ? { actorUid: knownActorUid } : {}),
                    schemaVersion: 1,
                    dependsOn: Array.from(
                      new Set([invoiceOutboxOpId, ...unsyncedSupplierCreateOpIds])
                    ),
                    entityType: 'supplier_transaction',
                    entityId: txPayment.id,
                    action: 'CREATE',
                    payload: txPayment,
                    timestamp: nowIso,
                    retryCount: 0,
                    attempts: 0,
                    status: 'pending'
                  });
                }

                // =============================================================
                // STEP 6: Persist the final COMMITTED idempotency record and
                //         POSTED draft within the same atomic 8-store transaction
                // =============================================================
                const committedIdempotencyRecord: OcrPurchaseIdempotencyRecord = {
                  key: idempotencyKey,
                  schemaVersion: OCR_PURCHASE_POSTING_SCHEMA_VERSION,
                  source: 'OCR',
                  ocrDraftId,
                  status: 'COMMITTED',
                  canonicalVersion: OCR_PURCHASE_CANONICAL_VERSION,
                  canonicalHash: finalPostingSnapshot.sha256,
                  canonicalJson: finalPostingSnapshot.canonicalJson,
                  canonicalPayloadSnapshot: finalPostingSnapshot.payload,
                  purchaseInvoiceId: deterministicInvoiceId,
                  supplierId: supplierRecord.id,
                  supplierInvoiceNumber: invoiceNumber,
                  initialPaymentIntent: finalPostingSnapshot.payload.paymentIntent,
                  committedAt: nowIso
                };
                const commitMetaReq = metadataStore.put(committedIdempotencyRecord);
                commitMetaReq.onerror = (event) => {
                  event?.preventDefault?.();
                  abortWith(
                    commitMetaReq.error || new Error('OCR_IDEMPOTENCY_COMMIT_WRITE_FAILED')
                  );
                };

                const postedDraftRecord: SupplierInvoiceDraft = {
                  ...normalizedDraft,
                  header: {
                    ...normalizedDraft.header,
                    ...(sourceDraft.header?.tax !== undefined
                      ? { tax: sourceDraft.header.tax }
                      : {})
                  },
                  status: 'POSTED',
                  errorMessage: undefined,
                  postedInvoiceId: deterministicInvoiceId,
                  approval: validatedApproval,
                  approvedBy: validatedApproval.approvedBy,
                  approvedByRole: validatedApproval.approvedByRole,
                  approvedAt: validatedApproval.approvedAt,
                  approvedCanonicalHash: validatedApproval.approvedCanonicalHash,
                  approvalStatus: 'APPROVED',
                  approvalVersion: validatedApproval.approvalVersion,
                  updatedAt: nowIso
                };
                const postDraftReq = draftStore.put(postedDraftRecord);
                postDraftReq.onerror = (event) => {
                  event?.preventDefault?.();
                  abortWith(postDraftReq.error || new Error('OCR_DRAFT_POSTED_WRITE_FAILED'));
                };

                finalInvoiceRecord = invoiceRecord;
              } catch (step5Err) {
                abortWith(step5Err);
              }
            };

            // Schedule the Step 4 reads synchronously inside reservePutReq.onsuccess
            const supReq = supStore.get(supplierId);
            supReq.onerror = (event) => {
              event?.preventDefault?.();
              abortWith(supReq.error || new Error('OCR_SUPPLIER_READ_FAILED'));
            };
            supReq.onsuccess = () => {
              supplierRecord = supReq.result as Supplier | undefined;
              onStep4ReadDone();
            };

            const supInvoicesReq = invoiceStore.index('supplierId').getAll(supplierId);
            supInvoicesReq.onerror = (event) => {
              event?.preventDefault?.();
              abortWith(supInvoicesReq.error || new Error('OCR_SUPPLIER_INVOICES_READ_FAILED'));
            };
            supInvoicesReq.onsuccess = () => {
              supplierInvoices = (supInvoicesReq.result as PurchaseInvoice[]) || [];
              onStep4ReadDone();
            };

            const outboxReq = outboxStore.getAll();
            outboxReq.onerror = (event) => {
              event?.preventDefault?.();
              abortWith(outboxReq.error || new Error('OCR_OUTBOX_READ_FAILED'));
            };
            outboxReq.onsuccess = () => {
              existingOutboxEntries = (outboxReq.result as OutboxEntry[]) || [];
              onStep4ReadDone();
            };

            for (const medId of uniqueMedicineIds) {
              const medReq = medStore.get(medId);
              medReq.onerror = (event) => {
                event?.preventDefault?.();
                abortWith(medReq.error || new Error(`OCR_MEDICINE_READ_FAILED:${medId}`));
              };
              medReq.onsuccess = () => {
                if (medReq.result) {
                  medMap.set(medId, medReq.result as Medicine);
                }
                onStep4ReadDone();
              };

              const quarantineReq = metadataStore.get(`unit_migration_v2:quarantine:${medId}`);
              quarantineReq.onerror = (event) => {
                event?.preventDefault?.();
                abortWith(
                  quarantineReq.error || new Error(`OCR_QUARANTINE_READ_FAILED:${medId}`)
                );
              };
              quarantineReq.onsuccess = () => {
                quarantineRecordsByMedicineId.set(medId, quarantineReq.result ?? null);
                onStep4ReadDone();
              };

              const medLedgerReq = ledgerStore.index('medicineId').getAll(medId);
              medLedgerReq.onerror = (event) => {
                event?.preventDefault?.();
                abortWith(medLedgerReq.error || new Error(`OCR_LEDGER_READ_FAILED:${medId}`));
              };
              medLedgerReq.onsuccess = () => {
                const movements = (medLedgerReq.result as LedgerMovement[]) || [];
                const totalBaseUnits = movements.reduce(
                  (acc, mov) => acc + (Number(mov.baseUnitsDelta) || 0),
                  0
                );
                existingBaseUnitsByMedicineId.set(medId, Math.max(0, totalBaseUnits));
                onStep4ReadDone();
              };
            }
          } catch (step4Err) {
            abortWith(step4Err);
          }
        };
      } catch (barrierErr) {
        abortWith(barrierErr);
      }
    };

    idempotencyReq.onerror = (event) => {
      event?.preventDefault?.();
      abortWith(idempotencyReq.error || new Error('OCR_IDEMPOTENCY_READ_FAILED'));
    };
    idempotencyReq.onsuccess = onInitialReadDone;

    existingInvoiceReq.onerror = (event) => {
      event?.preventDefault?.();
      abortWith(existingInvoiceReq.error || new Error('OCR_EXISTING_INVOICE_READ_FAILED'));
    };
    existingInvoiceReq.onsuccess = onInitialReadDone;

    draftReq.onerror = (event) => {
      event?.preventDefault?.();
      abortWith(draftReq.error || new Error('OCR_DRAFT_READ_FAILED'));
    };
    draftReq.onsuccess = onInitialReadDone;
  });
}

// ==========================================
// Phase 5: Barcode Management & Lookup Engine
// ==========================================

/**
 * Find medicine by barcode (checks primary barcode and secondary barcodes with live stock)
 */
export async function findMedicineByBarcode(
  barcode: string
): Promise<(Medicine & { stock: number; detailedStock: string; totalBasePills: number }) | null> {
  if (!barcode || !barcode.trim()) return null;
  const rawTarget = barcode.trim();
  const target = rawTarget.toLowerCase();
  const targetWithoutLeadingZeros = target.replace(/^0+/, '');

  const allMeds = await getAllMedicinesWithLiveStock();
  const found = allMeds.find((m) => {
    // 1. Primary barcode match
    if (m.barcode) {
      const mb = m.barcode.trim().toLowerCase();
      if (mb === target) return true;
      if (targetWithoutLeadingZeros.length >= 3 && mb.replace(/^0+/, '') === targetWithoutLeadingZeros) return true;
      if (target.length === 12 && mb === '0' + target) return true;
      if (target.length === 13 && target.startsWith('0') && mb === target.slice(1)) return true;
    }
    // 2. Secondary barcodes match
    if (Array.isArray(m.secondaryBarcodes)) {
      return m.secondaryBarcodes.some((b) => {
        if (!b) return false;
        const sb = b.trim().toLowerCase();
        if (sb === target) return true;
        if (targetWithoutLeadingZeros.length >= 3 && sb.replace(/^0+/, '') === targetWithoutLeadingZeros) return true;
        if (target.length === 12 && sb === '0' + target) return true;
        if (target.length === 13 && target.startsWith('0') && sb === target.slice(1)) return true;
        return false;
      });
    }
    return false;
  });
  return found || null;
}

/**
 * Check if a barcode is already assigned to another medicine
 */
export async function checkBarcodeUnique(
  barcode: string,
  excludeMedicineId?: string
): Promise<{ isUnique: boolean; existingMedicine?: Medicine }> {
  if (!barcode || !barcode.trim()) return { isUnique: true };
  const target = barcode.trim();
  const allMeds = await getAllMedicines();
  const existing = allMeds.find((m) => {
    if (excludeMedicineId && m.id === excludeMedicineId) return false;
    if (m.barcode && m.barcode.trim() === target) return true;
    if (Array.isArray(m.secondaryBarcodes)) {
      return m.secondaryBarcodes.some((b) => b && b.trim() === target);
    }
    return false;
  });
  return {
    isUnique: !existing,
    existingMedicine: existing
  };
}

/**
 * Add a secondary barcode to an existing medicine
 */
export async function addSecondaryBarcode(medicineId: string, barcode: string): Promise<Medicine> {
  const clean = barcode.trim();
  if (!clean) throw new Error('الباركود غير صالح');

  const uniqueCheck = await checkBarcodeUnique(clean, medicineId);
  if (!uniqueCheck.isUnique) {
    throw new Error(`الباركود مستخدم مسبقاً مع الدواء: ${uniqueCheck.existingMedicine?.name}`);
  }

  const med = await getMedicineById(medicineId);
  if (!med) throw new Error('الدواء غير موجود');

  if (med.barcode && med.barcode.trim() === clean) {
    throw new Error('هذا الباركود هو الباركود الرئيسي للدواء بالفعل');
  }

  const sec = Array.isArray(med.secondaryBarcodes) ? [...med.secondaryBarcodes] : [];
  if (sec.includes(clean)) {
    throw new Error('هذا الباركود مضاف بالفعل في قائمة الباركودات الفرعية');
  }
  sec.push(clean);

  const updated = await saveMedicine({
    ...med,
    secondaryBarcodes: sec
  });
  return updated;
}

/**
 * Remove a secondary barcode from a medicine
 */
export async function removeSecondaryBarcode(medicineId: string, barcode: string): Promise<Medicine> {
  const clean = barcode.trim();
  const med = await getMedicineById(medicineId);
  if (!med) throw new Error('الدواء غير موجود');

  const sec = (med.secondaryBarcodes || []).filter((b) => b !== clean);
  const updated = await saveMedicine({
    ...med,
    secondaryBarcodes: sec
  });
  return updated;
}

/**
 * Update the primary barcode of a medicine
 */
export async function updateMedicineBarcode(medicineId: string, newBarcode: string): Promise<Medicine> {
  const clean = newBarcode.trim();
  if (!clean) throw new Error('الباركود غير صالح');

  const uniqueCheck = await checkBarcodeUnique(clean, medicineId);
  if (!uniqueCheck.isUnique) {
    throw new Error(`الباركود مستخدم مسبقاً مع الدواء: ${uniqueCheck.existingMedicine?.name}`);
  }

  const med = await getMedicineById(medicineId);
  if (!med) throw new Error('الدواء غير موجود');

  // If new barcode was in secondary list, remove it from secondary
  const sec = (med.secondaryBarcodes || []).filter((b) => b !== clean);
  const updated = await saveMedicine({
    ...med,
    barcode: clean,
    secondaryBarcodes: sec
  });
  return updated;
}

// ==========================================
// Phase 5 + 2D-3B-2b.3: Stocktaking System («نظام الجرد»)
// ==========================================

function getEffectiveStocktakingBranchId(knownBranchId?: string): string {
  if (knownBranchId && isValidOutboxBranchId(knownBranchId)) {
    return knownBranchId.trim();
  }
  if (authAuthorityEnforced) {
    throw new Error('BRANCH_AUTH_REQUIRED: Active branch context is required for stocktaking operations');
  }
  return 'khalid-1';
}

function assertStocktakingWriteAuthorized(): void {
  if (!authAuthorityEnforced) return;
  if (!trustedAuthSession || !isValidFirebaseActorUid(trustedAuthSession.uid) || trustedAuthSession.emailVerified !== true) {
    throw new Error('STOCKTAKING_AUTH_REQUIRED: Verified authenticated session required for stocktaking');
  }
  if (trustedAuthSession.offlineFallback || trustedAuthSession.role === 'cashier') {
    throw new Error('STOCKTAKING_ROLE_DENIED: Online admin or super_admin role is required for stocktaking');
  }
}

function assertSessionBranchMatches(session: any, effectiveBranchId: string): void {
  if (
    session &&
    typeof session.branchId === 'string' &&
    session.branchId.trim().length > 0 &&
    session.branchId.trim() !== effectiveBranchId
  ) {
    throw new Error(
      `BRANCH_ISOLATION_VIOLATION: Stocktaking session belongs to branch "${session.branchId}" (active "${effectiveBranchId}")`
    );
  }
}

function isStocktakingSessionLockedOrTerminalLocal(session: any): boolean {
  if (!session || typeof session !== 'object') return true;
  const st = session.status;
  if (
    st !== 'active' &&
    st !== 'in_progress' &&
    st !== 'reviewing'
  ) {
    return true;
  }
  if (session.accountingStatus && session.accountingStatus !== 'open') {
    return true;
  }
  if (session.committedAt || session.cancelledAt) {
    return true;
  }
  return false;
}

function hasSessionOutboxLockOrCommit(
  entries: OutboxEntry[],
  sessionId: string,
  branchId?: string
): boolean {
  for (const e of entries) {
    if (!e || e.entityType !== 'stocktaking_session' || e.entityId !== sessionId) continue;
    if (e.status === 'dead-letter') continue;
    if (branchId && e.branchId && e.branchId.trim() !== branchId) continue;
    const p = e.payload;
    if (!p || typeof p !== 'object') continue;
    const st = p.status;
    const acct = p.accountingStatus;
    if (
      st === 'syncing_adjustments' ||
      st === 'sync_completed_unverified' ||
      st === 'committed' ||
      st === 'COMMITTED' ||
      st === 'cancelled' ||
      st === 'CANCELLED' ||
      acct === 'unverified_client_sync' ||
      acct === 'cancelled'
    ) {
      return true;
    }
  }
  return false;
}

function computeStocktakingSummaryMetrics(items: StocktakingItem[]): {
  itemsCount: number;
  totalItemsCount: number;
  matchedItemsCount: number;
  surplusItemsCount: number;
  deficitItemsCount: number;
  totalScanned: number;
  itemsWithVariance: number;
  netVarianceSDG: number;
  totalVarianceCost: number;
} {
  let matchedItemsCount = 0;
  let surplusItemsCount = 0;
  let deficitItemsCount = 0;
  let totalScanned = 0;
  let netVarianceRaw = 0;

  for (const it of items) {
    totalScanned += Number(it.actualCount) || 0;
    const v = Number(it.variance) || 0;
    netVarianceRaw += Number(it.varianceSDG) || 0;
    if (v > 0.001) {
      surplusItemsCount += 1;
    } else if (v < -0.001) {
      deficitItemsCount += 1;
    } else {
      matchedItemsCount += 1;
    }
  }

  const netVarianceSDG = Number(netVarianceRaw.toFixed(2));
  return {
    itemsCount: items.length,
    totalItemsCount: items.length,
    matchedItemsCount,
    surplusItemsCount,
    deficitItemsCount,
    totalScanned,
    itemsWithVariance: surplusItemsCount + deficitItemsCount,
    netVarianceSDG,
    totalVarianceCost: netVarianceSDG
  };
}

function buildSanitizedCloudSessionPayload(
  session: any,
  overrides: {
    status: string;
    accountingStatus: 'open' | 'unverified_client_sync' | 'cancelled';
    knownBranchId?: string;
    knownActorUid?: string;
    includeCompletionSummaries?: boolean;
    committedByUid?: string;
    committedBy?: string;
    committedAt?: string;
    auditReason?: string;
    adjustmentLedgerIds?: string[];
  }
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: session.id,
    ...(overrides.knownBranchId ? { branchId: overrides.knownBranchId } : {}),
    ...(session.sessionNumber ? { sessionNumber: session.sessionNumber } : {}),
    status: overrides.status,
    accountingStatus: overrides.accountingStatus,
    syncStatus: session.syncStatus || 'pending_sync',
    ...(session.startedAt ? { startedAt: session.startedAt } : {}),
    ...(session.startedBy !== undefined ? { startedBy: session.startedBy } : {}),
    ...(session.startedByUid || overrides.knownActorUid
      ? { startedByUid: session.startedByUid || overrides.knownActorUid }
      : {}),
    ...(session.deviceId ? { deviceId: session.deviceId } : {}),
    ...(session.notes !== undefined ? { notes: session.notes } : {}),
    ...(overrides.auditReason !== undefined
      ? { auditReason: overrides.auditReason }
      : session.auditReason !== undefined
        ? { auditReason: session.auditReason }
        : {}),
  };

  if (overrides.includeCompletionSummaries) {
    payload.itemsCount = session.itemsCount;
    payload.totalItemsCount = session.totalItemsCount;
    payload.matchedItemsCount = session.matchedItemsCount;
    payload.surplusItemsCount = session.surplusItemsCount;
    payload.deficitItemsCount = session.deficitItemsCount;
    payload.totalScanned = session.totalScanned;
    payload.itemsWithVariance = session.itemsWithVariance;
    payload.netVarianceSDG = session.netVarianceSDG;
    payload.totalVarianceCost = session.totalVarianceCost;
    if (overrides.committedAt) payload.committedAt = overrides.committedAt;
    if (overrides.committedBy !== undefined) payload.committedBy = overrides.committedBy;
    if (overrides.committedByUid) payload.committedByUid = overrides.committedByUid;
    if (overrides.adjustmentLedgerIds && overrides.adjustmentLedgerIds.length > 0) {
      payload.adjustmentLedgerIds = [...overrides.adjustmentLedgerIds];
    }
  }

  return payload;
}

function buildSanitizedCloudItemPayload(item: StocktakingItemRecord, knownBranchId?: string): Record<string, unknown> {
  return {
    id: item.id,
    ...(knownBranchId ? { branchId: knownBranchId } : { branchId: item.branchId }),
    sessionId: item.sessionId,
    medicineId: item.medicineId,
    medicineName: item.medicineName,
    barcode: item.barcode ?? '',
    ...(Array.isArray(item.secondaryBarcodes) ? { secondaryBarcodes: item.secondaryBarcodes } : {}),
    ...(item.batchNumber !== undefined ? { batchNumber: item.batchNumber } : {}),
    ...(item.expiry !== undefined ? { expiry: item.expiry } : {}),
    systemStock: item.systemStock,
    actualCount: item.actualCount,
    variance: item.variance,
    variancePacks: item.variancePacks ?? item.variance,
    unit: item.unit || 'pack',
    buyPrice: item.buyPrice,
    ...(item.sellPrice !== undefined ? { sellPrice: item.sellPrice } : {}),
    varianceSDG: item.varianceSDG,
    varianceCost: item.varianceCost ?? item.varianceSDG,
    lastScannedAt: item.lastScannedAt,
    ...(item.updatedByUid ? { updatedByUid: item.updatedByUid } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function hydrateSessionWithSubcollectionItems(
  session: StocktakingSession,
  subItems: StocktakingItemRecord[]
): StocktakingSession {
  if (!subItems || subItems.length === 0) {
    return {
      ...session,
      items: Array.isArray(session.items) ? session.items : []
    };
  }
  const byMed = new Map<string, StocktakingItemRecord>();
  for (const it of subItems) {
    if (it && it.medicineId) byMed.set(it.medicineId, it);
  }
  const ordered: StocktakingItem[] = Array.from(byMed.values()).sort(
    (a, b) => Date.parse(b.lastScannedAt || b.updatedAt || '') - Date.parse(a.lastScannedAt || a.updatedAt || '')
  );
  return {
    ...session,
    items: ordered
  };
}

export async function getStocktakingItems(
  sessionId: string,
  dbOverride?: IDBDatabase
): Promise<StocktakingItemRecord[]> {
  if (!isValidStocktakingDocId(sessionId)) return [];
  const db = dbOverride || (await openPharmacyDB());
  if (!db.objectStoreNames.contains('stocktaking_items')) {
    return [];
  }
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(['stocktaking_items'], 'readonly');
      const store = tx.objectStore('stocktaking_items');
      const req = store.indexNames.contains('sessionId')
        ? store.index('sessionId').getAll(sessionId.trim())
        : store.getAll();
      req.onsuccess = () => {
        const all = (req.result as StocktakingItemRecord[]) || [];
        resolve(all.filter((it) => it && it.sessionId === sessionId.trim()));
      };
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

export async function getAllStocktakingSessions(): Promise<StocktakingSession[]> {
  const db = await openPharmacyDB();
  const hasItemsStore = db.objectStoreNames.contains('stocktaking_items');
  return new Promise((resolve, reject) => {
    try {
      const stores = hasItemsStore ? ['stocktaking_sessions', 'stocktaking_items'] : ['stocktaking_sessions'];
      const tx = db.transaction(stores, 'readonly');
      const store = tx.objectStore('stocktaking_sessions');
      const itemsStore = hasItemsStore ? tx.objectStore('stocktaking_items') : null;
      let rawSessions: StocktakingSession[] = [];
      let rawItems: StocktakingItemRecord[] = [];
      let sessDone = false;
      let itemsDone = !itemsStore;

      const tryResolve = () => {
        if (!sessDone || !itemsDone) return;
        const bySession = new Map<string, StocktakingItemRecord[]>();
        for (const it of rawItems) {
          if (!it || !it.sessionId) continue;
          const arr = bySession.get(it.sessionId) || [];
          arr.push(it);
          bySession.set(it.sessionId, arr);
        }
        const results = rawSessions.map((s) =>
          hydrateSessionWithSubcollectionItems(s, bySession.get(s.id) || [])
        );
        results.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
        resolve(results);
      };

      const req = store.getAll();
      req.onsuccess = () => {
        rawSessions = (req.result as StocktakingSession[]) || [];
        sessDone = true;
        tryResolve();
      };
      req.onerror = () => reject(req.error);

      if (itemsStore) {
        const iReq = itemsStore.getAll();
        iReq.onsuccess = () => {
          rawItems = (iReq.result as StocktakingItemRecord[]) || [];
          itemsDone = true;
          tryResolve();
        };
        iReq.onerror = () => reject(iReq.error);
      }
    } catch (err) {
      reject(err);
    }
  });
}

export async function getStocktakingSession(id: string): Promise<StocktakingSession | null> {
  const db = await openPharmacyDB();
  const hasItemsStore = db.objectStoreNames.contains('stocktaking_items');
  return new Promise((resolve, reject) => {
    try {
      const stores = hasItemsStore ? ['stocktaking_sessions', 'stocktaking_items'] : ['stocktaking_sessions'];
      const tx = db.transaction(stores, 'readonly');
      const store = tx.objectStore('stocktaking_sessions');
      const itemsStore = hasItemsStore ? tx.objectStore('stocktaking_items') : null;
      let rawSession: StocktakingSession | null = null;
      let rawItems: StocktakingItemRecord[] = [];
      let sessDone = false;
      let itemsDone = !itemsStore;

      const tryResolve = () => {
        if (!sessDone || !itemsDone) return;
        if (!rawSession) {
          resolve(null);
          return;
        }
        resolve(hydrateSessionWithSubcollectionItems(rawSession, rawItems));
      };

      const req = store.get(id);
      req.onsuccess = () => {
        rawSession = (req.result as StocktakingSession) || null;
        sessDone = true;
        tryResolve();
      };
      req.onerror = () => reject(req.error);

      if (itemsStore) {
        const iReq = itemsStore.indexNames.contains('sessionId')
          ? itemsStore.index('sessionId').getAll(id)
          : itemsStore.getAll();
        iReq.onsuccess = () => {
          const res = (iReq.result as StocktakingItemRecord[]) || [];
          rawItems = res.filter((it) => it && it.sessionId === id);
          itemsDone = true;
          tryResolve();
        };
        iReq.onerror = () => reject(iReq.error);
      }
    } catch (err) {
      reject(err);
    }
  });
}

export async function getActiveStocktakingSession(): Promise<StocktakingSession | null> {
  const sessions = await getAllStocktakingSessions();
  const active = sessions.find(
    (s) => s.status === 'in_progress' || s.status === 'reviewing' || (s.status as string) === 'active'
  );
  return active || null;
}

function collectUnsyncedStocktakingOps(
  entries: OutboxEntry[],
  sessionId: string
): {
  unsyncedCreateOpIds: string[];
  unsyncedAllSessionItemOpIds: string[];
  unsyncedItemOpsByItemId: Map<string, string[]>;
  hasPendingItemOps: boolean;
} {
  const depIndex = buildOutboxDependencyIndex(entries);
  const unsyncedCreateOpIds: string[] = [];
  const unsyncedAllSessionItemOpIds: string[] = [];
  const unsyncedItemOpsByItemId = new Map<string, string[]>();

  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.status === 'synced') continue;

    if (e.entityType === 'stocktaking_session' && e.entityId === sessionId && e.action === 'CREATE') {
      validateOutboxRecordDependencies(e, depIndex);
      const opId = getCanonicalOutboxOperationId(e);
      if (opId && !unsyncedCreateOpIds.includes(opId)) {
        unsyncedCreateOpIds.push(opId);
      }
    } else if (e.entityType === 'stocktaking_session_item' && e.payload?.sessionId === sessionId) {
      validateOutboxRecordDependencies(e, depIndex);
      const opId = getCanonicalOutboxOperationId(e);
      if (opId) {
        if (!unsyncedAllSessionItemOpIds.includes(opId)) {
          unsyncedAllSessionItemOpIds.push(opId);
        }
        const byItem = unsyncedItemOpsByItemId.get(e.entityId) || [];
        if (!byItem.includes(opId)) byItem.push(opId);
        unsyncedItemOpsByItemId.set(e.entityId, byItem);
      }
    }
  }

  return {
    unsyncedCreateOpIds,
    unsyncedAllSessionItemOpIds,
    unsyncedItemOpsByItemId,
    hasPendingItemOps: unsyncedAllSessionItemOpIds.length > 0
  };
}

export async function saveStocktakingSession(session: StocktakingSession): Promise<void> {
  assertStocktakingWriteAuthorized();
  if (!session || !isValidStocktakingDocId(session.id)) {
    throw new Error('INVALID_FIRESTORE_ID: Valid stocktaking session ID is required');
  }

  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['stocktaking_sessions', 'outbox']);
  const nowIso = new Date().toISOString();
  const knownBranchId = getKnownActiveBranchId();
  const effectiveBranchId = getEffectiveStocktakingBranchId(knownBranchId);
  const knownActorUid = getKnownActiveActorId();
  assertSessionBranchMatches(session, effectiveBranchId);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['stocktaking_sessions', 'outbox'], 'readwrite');
    const store = tx.objectStore('stocktaking_sessions');
    const outboxStore = tx.objectStore('outbox');

    let sessLoaded = false;
    let outboxLoaded = false;
    let existingSession: StocktakingSession | undefined;
    let existingOutboxEntries: OutboxEntry[] = [];
    let finalized = false;
    let abortReason: Error | null = null;

    const abortWith = (err: unknown, fallback: string) => {
      if (!abortReason) abortReason = err instanceof Error ? err : new Error(fallback);
      try {
        tx.abort();
      } catch {
        // ignore
      }
    };

    const tryWrite = () => {
      if (finalized || !sessLoaded || !outboxLoaded) return;
      finalized = true;
      try {
        if (existingSession) {
          assertSessionBranchMatches(existingSession, effectiveBranchId);
          if (
            isStocktakingSessionLockedOrTerminalLocal(existingSession) ||
            hasSessionOutboxLockOrCommit(existingOutboxEntries, session.id, knownBranchId)
          ) {
            abortWith(
              new Error('STOCKTAKING_SESSION_LOCKED: لا يمكن تعديل أو إعادة فتح جلسة جرد مقفلة أو معتمدة'),
              'جلسة مقفلة'
            );
            return;
          }
        }

        const actuallyNew = !existingSession;
        const rawStatus = session.status as string;
        const safeOutboxStatus =
          rawStatus === 'active' || rawStatus === 'in_progress' || rawStatus === 'reviewing'
            ? rawStatus
            : 'in_progress';
        const sessionToStore = {
          ...session,
          branchId: (session as any).branchId || effectiveBranchId,
          accountingStatus: 'open',
          syncStatus: 'pending_sync',
          updatedAt: nowIso
        };
        store.put(sessionToStore);

        const { unsyncedCreateOpIds } = collectUnsyncedStocktakingOps(existingOutboxEntries, session.id);
        const outboxId = generateUUID();
        const cloudPayload = buildSanitizedCloudSessionPayload(sessionToStore, {
          status: safeOutboxStatus,
          accountingStatus: 'open',
          knownBranchId,
          knownActorUid
        });
        outboxStore.put({
          id: outboxId,
          operationId: outboxId,
          idempotencyKey: actuallyNew
            ? `stocktaking_session:CREATE:${session.id}`
            : `stocktaking_session:UPDATE:${session.id}:${outboxId}`,
          ...(knownBranchId ? { branchId: knownBranchId } : {}),
          ...(knownActorUid ? { actorUid: knownActorUid } : {}),
          schemaVersion: 2,
          ...(actuallyNew === false && unsyncedCreateOpIds.length > 0 ? { dependsOn: unsyncedCreateOpIds } : {}),
          entityType: 'stocktaking_session',
          entityId: session.id,
          action: actuallyNew ? 'CREATE' : 'UPDATE',
          payload: cloudPayload,
          timestamp: nowIso,
          retryCount: 0,
          attempts: 0,
          status: 'pending'
        });
      } catch (err) {
        abortWith(err, 'فشل حفظ جلسة الجرد');
      }
    };

    const sReq = store.get(session.id);
    sReq.onerror = () => abortWith(sReq.error, 'تعذر قراءة جلسة الجرد');
    sReq.onsuccess = () => {
      existingSession = sReq.result as StocktakingSession | undefined;
      sessLoaded = true;
      tryWrite();
    };

    const oReq = outboxStore.getAll();
    oReq.onerror = () => abortWith(oReq.error, 'تعذر قراءة طابور Outbox للجلسة');
    oReq.onsuccess = () => {
      existingOutboxEntries = (oReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryWrite();
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل حفظ جلسة الجرد'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة حفظ جلسة الجرد'));
  });
}

export async function createStocktakingSession(employeeName: string, notes?: string): Promise<StocktakingSession> {
  assertStocktakingWriteAuthorized();
  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['stocktaking_sessions', 'stocktaking_items', 'outbox']);
  const nowIso = new Date().toISOString();
  const knownBranchId = getKnownActiveBranchId();
  const effectiveBranchId = getEffectiveStocktakingBranchId(knownBranchId);
  const knownActorUid = getKnownActiveActorId();
  const deviceId = getDeviceId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['stocktaking_sessions', 'stocktaking_items', 'outbox'], 'readwrite');
    const store = tx.objectStore('stocktaking_sessions');
    const itemsStore = tx.objectStore('stocktaking_items');
    const outboxStore = tx.objectStore('outbox');
    let resultSession: StocktakingSession | null = null;
    let abortReason: Error | null = null;

    let sessionsLoaded = false;
    let itemsLoaded = false;
    let sessions: StocktakingSession[] = [];
    let allItems: StocktakingItemRecord[] = [];
    let finalized = false;

    const tryCreate = () => {
      if (finalized || !sessionsLoaded || !itemsLoaded) return;
      finalized = true;
      try {
        sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
        const active = sessions.find(
          (s) =>
            (s.status === 'in_progress' || s.status === 'reviewing' || (s.status as string) === 'active') &&
            (!(s as any).branchId || (s as any).branchId === effectiveBranchId)
        );
        if (active) {
          const matchingItems = allItems.filter((it) => it && it.sessionId === active.id);
          resultSession = hydrateSessionWithSubcollectionItems(active, matchingItems);
          return;
        }

        const dateTag = nowIso.slice(0, 10).replace(/-/g, '');
        let sessionNumber = `STK-${dateTag}-${Date.now().toString().slice(-4)}`;
        if (sessions.some((s) => s.id === sessionNumber)) {
          sessionNumber = `${sessionNumber}-${generateUUID().slice(0, 4).toUpperCase()}`;
        }

        const newSession: StocktakingSession & {
          branchId: string;
          accountingStatus: 'open';
          syncStatus: 'pending_sync';
          startedByUid?: string;
          itemsCount: number;
          totalItemsCount: number;
          matchedItemsCount: number;
          surplusItemsCount: number;
          deficitItemsCount: number;
          totalVarianceCost: number;
          deviceId: string;
          createdAt: string;
          updatedAt: string;
        } = {
          id: sessionNumber,
          sessionNumber,
          branchId: effectiveBranchId,
          startedAt: nowIso,
          startedBy: (employeeName || 'صيدلي مسؤول').slice(0, 128),
          ...(knownActorUid ? { startedByUid: knownActorUid } : {}),
          status: 'in_progress',
          accountingStatus: 'open',
          syncStatus: 'pending_sync',
          notes: (notes || '').slice(0, 500),
          items: [],
          itemsCount: 0,
          totalItemsCount: 0,
          matchedItemsCount: 0,
          surplusItemsCount: 0,
          deficitItemsCount: 0,
          totalScanned: 0,
          itemsWithVariance: 0,
          netVarianceSDG: 0,
          totalVarianceCost: 0,
          deviceId,
          createdAt: nowIso,
          updatedAt: nowIso
        };

        store.put(newSession);
        const outboxId = generateUUID();
        const cloudPayload = buildSanitizedCloudSessionPayload(newSession, {
          status: 'in_progress',
          accountingStatus: 'open',
          knownBranchId,
          knownActorUid
        });
        outboxStore.put({
          id: outboxId,
          operationId: outboxId,
          idempotencyKey: `stocktaking_session:CREATE:${newSession.id}`,
          ...(knownBranchId ? { branchId: knownBranchId } : {}),
          ...(knownActorUid ? { actorUid: knownActorUid } : {}),
          schemaVersion: 2,
          entityType: 'stocktaking_session',
          entityId: newSession.id,
          action: 'CREATE',
          payload: cloudPayload,
          timestamp: nowIso,
          retryCount: 0,
          attempts: 0,
          status: 'pending'
        });
        resultSession = newSession;
      } catch (err) {
        abortReason = err instanceof Error ? err : new Error('فشل إنشاء جلسة الجرد');
        try {
          tx.abort();
        } catch {
          // ignore
        }
      }
    };

    const allReq = store.getAll();
    allReq.onerror = () => {
      abortReason = allReq.error || new Error('تعذر فحص جلسات الجرد');
      try {
        tx.abort();
      } catch {
        // ignore
      }
    };
    allReq.onsuccess = () => {
      sessions = (allReq.result as StocktakingSession[]) || [];
      sessionsLoaded = true;
      tryCreate();
    };

    const iReq = itemsStore.getAll();
    iReq.onerror = () => {
      abortReason = iReq.error || new Error('تعذر فحص أصناف الجرد');
      try {
        tx.abort();
      } catch {
        // ignore
      }
    };
    iReq.onsuccess = () => {
      allItems = (iReq.result as StocktakingItemRecord[]) || [];
      itemsLoaded = true;
      tryCreate();
    };

    tx.oncomplete = () => {
      if (resultSession) {
        resolve(resultSession);
      } else {
        reject(abortReason || new Error('فشل إنشاء جلسة الجرد'));
      }
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل إنشاء جلسة الجرد'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة إنشاء جلسة الجرد'));
  });
}

function findMedicineInMemoryByBarcodeOrId(allMeds: Medicine[], barcodeOrId: string): Medicine | null {
  const rawTarget = (barcodeOrId || '').trim();
  if (!rawTarget) return null;
  const target = rawTarget.toLowerCase();
  const targetWithoutLeadingZeros = target.replace(/^0+/, '');

  const matchBarcode = (candidate?: string): boolean => {
    if (!candidate) return false;
    const sb = candidate.trim().toLowerCase();
    if (sb === target) return true;
    if (targetWithoutLeadingZeros.length >= 3 && sb.replace(/^0+/, '') === targetWithoutLeadingZeros) return true;
    if (target.length === 12 && sb === '0' + target) return true;
    if (target.length === 13 && target.startsWith('0') && sb === target.slice(1)) return true;
    return false;
  };

  const byBarcode = allMeds.find((m) => {
    if (matchBarcode(m.barcode)) return true;
    if (Array.isArray(m.secondaryBarcodes)) {
      return m.secondaryBarcodes.some((b) => matchBarcode(b));
    }
    return false;
  });
  if (byBarcode) return byBarcode;

  return allMeds.find((m) => m.id === rawTarget) || null;
}

/**
 * Record a scanned or manually counted item in the active stocktaking session (atomic read-modify-write).
 * Persists normalized child record in `stocktaking_items`, keeps local `session.items` synced,
 * and enqueues `stocktaking_session_item` CREATE/UPDATE without mutating inventory_ledger.
 */
export async function recordStocktakingItem(
  sessionId: string,
  barcodeOrId: string,
  deltaCount?: number,
  manualCount?: number
): Promise<{ session: StocktakingSession; item: StocktakingItem }> {
  assertStocktakingWriteAuthorized();
  if (!isValidStocktakingDocId(sessionId)) {
    throw new Error('INVALID_FIRESTORE_ID: معرف جلسة الجرد غير صالح');
  }
  if (manualCount !== undefined && (typeof manualCount !== 'number' || !Number.isFinite(manualCount) || manualCount < 0)) {
    throw new Error(`INVALID_STOCKTAKING_QUANTITY: العدد اليدوي غير صالح (${String(manualCount)})`);
  }
  if (deltaCount !== undefined && (typeof deltaCount !== 'number' || !Number.isFinite(deltaCount))) {
    throw new Error(`INVALID_STOCKTAKING_QUANTITY: مقدار التعديل غير صالح (${String(deltaCount)})`);
  }

  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['stocktaking_sessions', 'stocktaking_items', 'medicines', 'inventory_ledger', 'outbox']);
  const nowIso = new Date().toISOString();
  const knownBranchId = getKnownActiveBranchId();
  const effectiveBranchId = getEffectiveStocktakingBranchId(knownBranchId);
  const knownActorUid = getKnownActiveActorId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ['stocktaking_sessions', 'stocktaking_items', 'medicines', 'inventory_ledger', 'outbox'],
      'readwrite'
    );
    const sessionStore = tx.objectStore('stocktaking_sessions');
    const itemsStore = tx.objectStore('stocktaking_items');
    const medStore = tx.objectStore('medicines');
    const ledgerStore = tx.objectStore('inventory_ledger');
    const outboxStore = tx.objectStore('outbox');

    let sessLoaded = false;
    let subItemsLoaded = false;
    let medsLoaded = false;
    let ledgerLoaded = false;
    let outboxLoaded = false;
    let session: (StocktakingSession & { branchId?: string; accountingStatus?: string; syncStatus?: string }) | undefined;
    let sessionSubItems: StocktakingItemRecord[] = [];
    let allMeds: Medicine[] = [];
    let allMovements: LedgerMovement[] = [];
    let existingOutboxEntries: OutboxEntry[] = [];
    let finalized = false;
    let abortReason: Error | null = null;
    let resultData: { session: StocktakingSession; item: StocktakingItem } | null = null;

    const abortWith = (err: unknown, fallback: string) => {
      if (!abortReason) abortReason = err instanceof Error ? err : new Error(fallback);
      try {
        tx.abort();
      } catch {
        // ignore
      }
    };

    const tryProceed = () => {
      if (finalized || !sessLoaded || !subItemsLoaded || !medsLoaded || !ledgerLoaded || !outboxLoaded) return;
      finalized = true;

      try {
        if (!session) {
          abortWith(new Error('جلسة الجرد غير موجودة'), 'جلسة الجرد غير موجودة');
          return;
        }
        assertSessionBranchMatches(session, effectiveBranchId);

        if (
          isStocktakingSessionLockedOrTerminalLocal(session) ||
          hasSessionOutboxLockOrCommit(existingOutboxEntries, session.id, knownBranchId)
        ) {
          abortWith(new Error('STOCKTAKING_SESSION_LOCKED: لا يمكن تعديل جلسة جرد مغلقة أو معتمدة'), 'جلسة مغلقة');
          return;
        }

        const med = findMedicineInMemoryByBarcodeOrId(allMeds, barcodeOrId);
        if (!med) {
          abortWith(new Error(`الدواء ذو الباركود/المعرف "${barcodeOrId}" غير مسجل بالنظام`), 'الدواء غير موجود');
          return;
        }
        if (!isValidStocktakingDocId(med.id)) {
          abortWith(new Error(`INVALID_FIRESTORE_ID: معرف الدواء "${med.id}" غير صالح لـ Firestore`), 'معرف دواء غير صالح');
          return;
        }
        if ((med as any).branchId && (med as any).branchId !== effectiveBranchId) {
          abortWith(
            new Error(`BRANCH_ISOLATION_VIOLATION: الدواء "${med.name}" ينتمي لفرع آخر`),
            'مخالفة عزل الفروع'
          );
          return;
        }
        if (med.archived === true) {
          abortWith(new Error(`COMMERCIAL_TARGET_ARCHIVED: الدواء "${med.name}" مؤرشف ولا يمكن جرده`), 'الدواء مؤرشف');
          return;
        }
        try {
          assertMedicineOperationallyAllowed(med);
        } catch (error) {
          abortWith(error, 'الدواء لم يحصل على الاعتماد التشغيلي المستقل؛ لا يمكن إدخاله في الجرد');
          return;
        }
        if (typeof med.buyPrice !== 'number' || !Number.isFinite(med.buyPrice) || med.buyPrice < 0) {
          abortWith(new Error(`INVALID_STOCKTAKING_PRICE: سعر الشراء للدواء "${med.name}" غير صالح`), 'سعر غير صالح');
          return;
        }

        const totalPills = allMovements
          .filter((m) => m.medicineId === med.id)
          .reduce((sum, m) => sum + (Number(m.baseUnitsDelta) || 0), 0);
        const stripsPerPack = Number(med.stripsPerPack);
        const pillsPerStrip = Number(med.pillsPerStrip);
        if (!Number.isSafeInteger(stripsPerPack) || stripsPerPack <= 0 ||
            !Number.isSafeInteger(pillsPerStrip) || pillsPerStrip <= 0) {
          abortWith(new Error(`MEDICINE_OPERATION_BLOCKED:INVALID_PACKING_FACTORS:${med.id}`), 'عوامل تعبئة الدواء غير موثقة؛ تعذر إجراء الجرد');
          return;
        }
        const pillsPerPack = stripsPerPack * pillsPerStrip;
        const systemStockPacks = Math.floor(Math.max(0, totalPills) / pillsPerPack);

        // Merge any pre-existing legacy inline items with subcollection store items cleanly (deduped by medicineId)
        const itemMapByMed = new Map<string, StocktakingItemRecord>();
        for (const legacyIt of Array.isArray(session.items) ? session.items : []) {
          if (!legacyIt || !legacyIt.medicineId) continue;
          const legId = isValidStocktakingDocId(legacyIt.id)
            ? legacyIt.id.trim()
            : deriveStocktakingItemId(effectiveBranchId, session.id, legacyIt.medicineId);
          itemMapByMed.set(legacyIt.medicineId, {
            ...legacyIt,
            id: legId,
            sessionId: session.id,
            branchId: effectiveBranchId,
            createdAt: (legacyIt as any).createdAt || session.startedAt || nowIso,
            updatedAt: (legacyIt as any).updatedAt || legacyIt.lastScannedAt || nowIso
          });
        }
        for (const subIt of sessionSubItems) {
          if (!subIt || !subIt.medicineId) continue;
          itemMapByMed.set(subIt.medicineId, subIt);
        }

        const existingRec = itemMapByMed.get(med.id);
        const resolvedItemId =
          existingRec && isValidStocktakingDocId(existingRec.id)
            ? existingRec.id
            : deriveStocktakingItemId(effectiveBranchId, session.id, med.id);

        let itemRecord: StocktakingItemRecord;
        if (existingRec) {
          let newActualCount = existingRec.actualCount;
          if (manualCount !== undefined) {
            newActualCount = manualCount;
          } else {
            const step = deltaCount !== undefined ? deltaCount : 1;
            newActualCount = existingRec.actualCount + step;
          }
          if (!Number.isFinite(newActualCount) || newActualCount < 0) {
            abortWith(
              new Error('INVALID_STOCKTAKING_QUANTITY: لا يمكن أن يكون العد الفعلي أقل من صفر'),
              'عد فعلي سالب'
            );
            return;
          }

          // Preserve reference buyPrice established on the item during this stocktaking session
          const referenceBuyPrice =
            typeof existingRec.buyPrice === 'number' && Number.isFinite(existingRec.buyPrice) && existingRec.buyPrice >= 0
              ? existingRec.buyPrice
              : med.buyPrice;
          const variance = Number((newActualCount - systemStockPacks).toFixed(2));
          const varianceSDG = Number((variance * referenceBuyPrice).toFixed(2));

          itemRecord = {
            ...existingRec,
            id: resolvedItemId,
            sessionId: session.id,
            branchId: existingRec.branchId || effectiveBranchId,
            systemStock: systemStockPacks,
            actualCount: newActualCount,
            buyPrice: referenceBuyPrice,
            variance,
            variancePacks: variance,
            varianceSDG,
            varianceCost: varianceSDG,
            lastScannedAt: nowIso,
            updatedAt: nowIso,
            ...(knownActorUid ? { updatedByUid: knownActorUid } : {}),
            syncStatus: 'pending_sync'
          };
        } else {
          let initialActual = 1;
          if (manualCount !== undefined) {
            initialActual = manualCount;
          } else if (deltaCount !== undefined) {
            initialActual = deltaCount;
          }
          if (!Number.isFinite(initialActual) || initialActual < 0) {
            abortWith(
              new Error('INVALID_STOCKTAKING_QUANTITY: لا يمكن تسجيل صنف بكمية عد سالبة'),
              'عد أولي سالب'
            );
            return;
          }

          const variance = Number((initialActual - systemStockPacks).toFixed(2));
          const varianceSDG = Number((variance * med.buyPrice).toFixed(2));

          itemRecord = {
            id: resolvedItemId,
            sessionId: session.id,
            branchId: effectiveBranchId,
            medicineId: med.id,
            medicineName: (med.name || med.id).slice(0, 200),
            barcode: (med.barcode || '').slice(0, 64),
            secondaryBarcodes: med.secondaryBarcodes || [],
            ...(med.batchNumber ? { batchNumber: med.batchNumber.slice(0, 64) } : {}),
            expiry: (med.expiry || '').slice(0, 32),
            systemStock: systemStockPacks,
            actualCount: initialActual,
            variance,
            variancePacks: variance,
            unit: 'pack',
            buyPrice: med.buyPrice,
            sellPrice: med.sellPrice,
            varianceSDG,
            varianceCost: varianceSDG,
            lastScannedAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
            ...(knownActorUid ? { updatedByUid: knownActorUid } : {}),
            syncStatus: 'pending_sync'
          };
        }

        itemsStore.put(itemRecord);
        itemMapByMed.set(med.id, itemRecord);

        const mergedItems: StocktakingItemRecord[] = [];
        // Keep newest scanned/updated item first for UI ergonomics
        mergedItems.push(itemRecord);
        for (const [mId, rec] of itemMapByMed.entries()) {
          if (mId !== med.id) mergedItems.push(rec);
        }

        const metrics = computeStocktakingSummaryMetrics(mergedItems);
        const updatedSession: StocktakingSession & {
          branchId: string;
          accountingStatus: 'open';
          syncStatus: 'pending_sync';
        } = {
          ...session,
          branchId: session.branchId || effectiveBranchId,
          accountingStatus: 'open',
          syncStatus: 'pending_sync',
          items: mergedItems,
          ...metrics,
          updatedAt: nowIso
        };
        sessionStore.put(updatedSession);

        // Determine CREATE vs UPDATE for stocktaking_session_item based on Outbox history
        const { unsyncedCreateOpIds } = collectUnsyncedStocktakingOps(existingOutboxEntries, session.id);
        const depIndex = buildOutboxDependencyIndex(existingOutboxEntries);

        const itemHistoryOps = existingOutboxEntries.filter(
          (e) => e && e.entityType === 'stocktaking_session_item' && e.entityId === resolvedItemId
        );
        const lastItemOp = itemHistoryOps.length > 0 ? itemHistoryOps[itemHistoryOps.length - 1] : undefined;
        const itemAction: 'CREATE' | 'UPDATE' = !lastItemOp || lastItemOp.action === 'DELETE' ? 'CREATE' : 'UPDATE';

        const unsyncedMedCreates: string[] = [];
        for (const e of existingOutboxEntries) {
          if (e && e.entityType === 'medicine' && e.entityId === med.id && e.action === 'CREATE' && e.status !== 'synced') {
            validateOutboxRecordDependencies(e, depIndex);
            const opId = getCanonicalOutboxOperationId(e);
            if (opId && !unsyncedMedCreates.includes(opId)) unsyncedMedCreates.push(opId);
          }
        }
        const priorUnsyncedItemOps: string[] = [];
        for (const e of itemHistoryOps) {
          if (e.status !== 'synced') {
            validateOutboxRecordDependencies(e, depIndex);
            const opId = getCanonicalOutboxOperationId(e);
            if (opId && !priorUnsyncedItemOps.includes(opId)) priorUnsyncedItemOps.push(opId);
          }
        }

        const itemDeps = Array.from(new Set([...unsyncedCreateOpIds, ...unsyncedMedCreates, ...priorUnsyncedItemOps]));
        const outboxId = generateUUID();
        outboxStore.put({
          id: outboxId,
          operationId: outboxId,
          idempotencyKey:
            itemAction === 'CREATE'
              ? `stocktaking_session_item:CREATE:${session.id}:${resolvedItemId}`
              : `stocktaking_session_item:UPDATE:${session.id}:${resolvedItemId}:${outboxId}`,
          ...(knownBranchId ? { branchId: knownBranchId } : {}),
          ...(knownActorUid ? { actorUid: knownActorUid } : {}),
          schemaVersion: 2,
          ...(itemDeps.length > 0 ? { dependsOn: itemDeps } : {}),
          entityType: 'stocktaking_session_item',
          entityId: resolvedItemId,
          action: itemAction,
          payload: buildSanitizedCloudItemPayload(itemRecord, knownBranchId),
          timestamp: nowIso,
          retryCount: 0,
          attempts: 0,
          status: 'pending'
        });

        resultData = { session: updatedSession, item: itemRecord };
      } catch (err) {
        abortWith(err, 'فشل تسجيل عنصر الجرد');
      }
    };

    const sReq = sessionStore.get(sessionId);
    sReq.onerror = () => abortWith(sReq.error, 'تعذر قراءة جلسة الجرد');
    sReq.onsuccess = () => {
      session = sReq.result as any;
      sessLoaded = true;
      tryProceed();
    };

    const iReq = itemsStore.indexNames.contains('sessionId')
      ? itemsStore.index('sessionId').getAll(sessionId)
      : itemsStore.getAll();
    iReq.onerror = () => abortWith(iReq.error, 'تعذر قراءة أصناف جلسة الجرد');
    iReq.onsuccess = () => {
      const res = (iReq.result as StocktakingItemRecord[]) || [];
      sessionSubItems = res.filter((it) => it && it.sessionId === sessionId);
      subItemsLoaded = true;
      tryProceed();
    };

    const mReq = medStore.getAll();
    mReq.onerror = () => abortWith(mReq.error, 'تعذر قراءة الأدوية');
    mReq.onsuccess = () => {
      allMeds = (mReq.result as Medicine[]) || [];
      medsLoaded = true;
      tryProceed();
    };

    const lReq = ledgerStore.index('medicineId').getAll();
    lReq.onerror = () => abortWith(lReq.error, 'تعذر قراءة سجل المخزون');
    lReq.onsuccess = () => {
      allMovements = (lReq.result as LedgerMovement[]) || [];
      ledgerLoaded = true;
      tryProceed();
    };

    const oReq = outboxStore.getAll();
    oReq.onerror = () => abortWith(oReq.error, 'تعذر قراءة طابور Outbox');
    oReq.onsuccess = () => {
      existingOutboxEntries = (oReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryProceed();
    };

    tx.oncomplete = () => {
      if (resultData) {
        resolve(resultData);
      } else {
        reject(abortReason || new Error('فشل تسجيل عنصر الجرد'));
      }
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل تسجيل عنصر الجرد'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة تسجيل عنصر الجرد'));
  });
}

/**
 * Remove an item entry from an open stocktaking session (atomic read-modify-write).
 * Deletes child record from `stocktaking_items` and enqueues `stocktaking_session_item:DELETE`.
 */
export async function removeStocktakingItem(
  sessionId: string,
  medicineId: string
): Promise<StocktakingSession> {
  assertStocktakingWriteAuthorized();
  if (!isValidStocktakingDocId(sessionId) || !isValidStocktakingDocId(medicineId)) {
    throw new Error('INVALID_FIRESTORE_ID: معرف جلسة الجرد أو الدواء غير صالح');
  }

  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['stocktaking_sessions', 'stocktaking_items', 'outbox']);
  const nowIso = new Date().toISOString();
  const knownBranchId = getKnownActiveBranchId();
  const effectiveBranchId = getEffectiveStocktakingBranchId(knownBranchId);
  const knownActorUid = getKnownActiveActorId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['stocktaking_sessions', 'stocktaking_items', 'outbox'], 'readwrite');
    const sessionStore = tx.objectStore('stocktaking_sessions');
    const itemsStore = tx.objectStore('stocktaking_items');
    const outboxStore = tx.objectStore('outbox');

    let sessLoaded = false;
    let subItemsLoaded = false;
    let outboxLoaded = false;
    let session: (StocktakingSession & { branchId?: string; accountingStatus?: string; syncStatus?: string }) | undefined;
    let sessionSubItems: StocktakingItemRecord[] = [];
    let existingOutboxEntries: OutboxEntry[] = [];
    let finalized = false;
    let abortReason: Error | null = null;
    let updatedSession: StocktakingSession | null = null;

    const abortWith = (err: unknown, fallback: string) => {
      if (!abortReason) abortReason = err instanceof Error ? err : new Error(fallback);
      try {
        tx.abort();
      } catch {
        // ignore
      }
    };

    const tryProceed = () => {
      if (finalized || !sessLoaded || !subItemsLoaded || !outboxLoaded) return;
      finalized = true;
      try {
        if (!session) {
          abortWith(new Error('جلسة الجرد غير موجودة'), 'جلسة الجرد غير موجودة');
          return;
        }
        assertSessionBranchMatches(session, effectiveBranchId);

        if (
          isStocktakingSessionLockedOrTerminalLocal(session) ||
          hasSessionOutboxLockOrCommit(existingOutboxEntries, session.id, knownBranchId)
        ) {
          abortWith(new Error('STOCKTAKING_SESSION_LOCKED: لا يمكن تعديل جلسة جرد مغلقة أو معتمدة'), 'جلسة مغلقة');
          return;
        }

        const itemMapByMed = new Map<string, StocktakingItemRecord>();
        for (const legIt of Array.isArray(session.items) ? session.items : []) {
          if (!legIt || !legIt.medicineId) continue;
          const legId = isValidStocktakingDocId(legIt.id)
            ? legIt.id.trim()
            : deriveStocktakingItemId(effectiveBranchId, session.id, legIt.medicineId);
          itemMapByMed.set(legIt.medicineId, {
            ...legIt,
            id: legId,
            sessionId: session.id,
            branchId: effectiveBranchId,
            createdAt: (legIt as any).createdAt || session.startedAt || nowIso,
            updatedAt: (legIt as any).updatedAt || legIt.lastScannedAt || nowIso
          });
        }
        for (const subIt of sessionSubItems) {
          if (subIt && subIt.medicineId) itemMapByMed.set(subIt.medicineId, subIt);
        }

        const removedRecord = itemMapByMed.get(medicineId);
        const resolvedItemId =
          removedRecord && isValidStocktakingDocId(removedRecord.id)
            ? removedRecord.id
            : deriveStocktakingItemId(effectiveBranchId, session.id, medicineId);

        itemMapByMed.delete(medicineId);
        itemsStore.delete(resolvedItemId);
        for (const subIt of sessionSubItems) {
          if (subIt && subIt.medicineId === medicineId && subIt.id !== resolvedItemId) {
            itemsStore.delete(subIt.id);
          }
        }

        const remainingItems = Array.from(itemMapByMed.values());
        const metrics = computeStocktakingSummaryMetrics(remainingItems);

        const nextSession: StocktakingSession & {
          branchId: string;
          accountingStatus: 'open';
          syncStatus: 'pending_sync';
        } = {
          ...session,
          branchId: session.branchId || effectiveBranchId,
          accountingStatus: 'open',
          syncStatus: 'pending_sync',
          items: remainingItems,
          ...metrics,
          updatedAt: nowIso
        };
        sessionStore.put(nextSession);

        if (removedRecord) {
          const { unsyncedCreateOpIds } = collectUnsyncedStocktakingOps(existingOutboxEntries, session.id);
          const depIndex = buildOutboxDependencyIndex(existingOutboxEntries);
          const priorItemOps = existingOutboxEntries.filter(
            (e) => e && e.entityType === 'stocktaking_session_item' && e.entityId === resolvedItemId && e.status !== 'synced'
          );
          const priorUnsyncedIds: string[] = [];
          for (const e of priorItemOps) {
            validateOutboxRecordDependencies(e, depIndex);
            const opId = getCanonicalOutboxOperationId(e);
            if (opId && !priorUnsyncedIds.includes(opId)) priorUnsyncedIds.push(opId);
          }
          const deleteDeps = Array.from(new Set([...unsyncedCreateOpIds, ...priorUnsyncedIds]));
          const outboxId = generateUUID();
          outboxStore.put({
            id: outboxId,
            operationId: outboxId,
            idempotencyKey: `stocktaking_session_item:DELETE:${session.id}:${resolvedItemId}:${outboxId}`,
            ...(knownBranchId ? { branchId: knownBranchId } : {}),
            ...(knownActorUid ? { actorUid: knownActorUid } : {}),
            schemaVersion: 2,
            ...(deleteDeps.length > 0 ? { dependsOn: deleteDeps } : {}),
            entityType: 'stocktaking_session_item',
            entityId: resolvedItemId,
            action: 'DELETE',
            payload: {
              id: resolvedItemId,
              ...(knownBranchId ? { branchId: knownBranchId } : { branchId: effectiveBranchId }),
              sessionId: session.id,
              medicineId
            },
            timestamp: nowIso,
            retryCount: 0,
            attempts: 0,
            status: 'pending'
          });
        }

        updatedSession = nextSession;
      } catch (err) {
        abortWith(err, 'فشل إزالة عنصر الجرد');
      }
    };

    const sReq = sessionStore.get(sessionId);
    sReq.onerror = () => abortWith(sReq.error, 'تعذر قراءة جلسة الجرد');
    sReq.onsuccess = () => {
      session = sReq.result as any;
      sessLoaded = true;
      tryProceed();
    };

    const iReq = itemsStore.indexNames.contains('sessionId')
      ? itemsStore.index('sessionId').getAll(sessionId)
      : itemsStore.getAll();
    iReq.onerror = () => abortWith(iReq.error, 'تعذر قراءة أصناف جلسة الجرد');
    iReq.onsuccess = () => {
      const res = (iReq.result as StocktakingItemRecord[]) || [];
      sessionSubItems = res.filter((it) => it && it.sessionId === sessionId);
      subItemsLoaded = true;
      tryProceed();
    };

    const oReq = outboxStore.getAll();
    oReq.onerror = () => abortWith(oReq.error, 'تعذر قراءة طابور Outbox');
    oReq.onsuccess = () => {
      existingOutboxEntries = (oReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryProceed();
    };

    tx.oncomplete = () => {
      if (updatedSession) resolve(updatedSession);
      else reject(abortReason || new Error('فشل إزالة عنصر الجرد'));
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل إزالة عنصر الجرد'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة إزالة عنصر الجرد'));
  });
}

/**
 * Commit Stocktaking Session:
 * Atomically reads session + stocktaking_items + medicines + existing ledger/outbox in-tx,
 * enforces double-commit/lock/integrity guards, generates deterministic ADJUSTMENT ledger IDs,
 * updates local session status = 'committed' + accountingStatus = 'unverified_client_sync',
 * and emits the 3-Stage Rules-Compliant Outbox V2 DAG:
 *   Stage 2A: stocktaking_session UPDATE (status: 'syncing_adjustments', accountingStatus: 'open')
 *   Stage 2B: inventory_ledger CREATE (ADJUSTMENT) depending on Stage 2A + medicine + items
 *   Stage 3:  stocktaking_session UPDATE (status: 'sync_completed_unverified', accountingStatus: 'unverified_client_sync')
 */
export async function commitStocktakingSession(
  sessionId: string,
  employeeName: string,
  reason?: string
): Promise<{ session: StocktakingSession; movements: LedgerMovement[] }> {
  assertStocktakingWriteAuthorized();
  if (!isValidStocktakingDocId(sessionId)) {
    throw new Error('INVALID_FIRESTORE_ID: معرف جلسة الجرد غير صالح');
  }

  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, [
    'stocktaking_sessions',
    'stocktaking_items',
    'medicines',
    'inventory_ledger',
    'outbox'
  ]);
  const nowIso = new Date().toISOString();
  const deviceId = getDeviceId();
  const knownBranchId = getKnownActiveBranchId();
  const effectiveBranchId = getEffectiveStocktakingBranchId(knownBranchId);
  const knownActorUid = getKnownActiveActorId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ['stocktaking_sessions', 'stocktaking_items', 'medicines', 'inventory_ledger', 'outbox'],
      'readwrite'
    );
    const sessionStore = tx.objectStore('stocktaking_sessions');
    const itemsStore = tx.objectStore('stocktaking_items');
    const medStore = tx.objectStore('medicines');
    const ledgerStore = tx.objectStore('inventory_ledger');
    const outboxStore = tx.objectStore('outbox');

    let sessLoaded = false;
    let subItemsLoaded = false;
    let medsLoaded = false;
    let ledgerLoaded = false;
    let outboxLoaded = false;
    let session: (StocktakingSession & { branchId?: string; accountingStatus?: string; syncStatus?: string }) | undefined;
    let sessionSubItems: StocktakingItemRecord[] = [];
    let allMeds: Medicine[] = [];
    let existingLedger: LedgerMovement[] = [];
    let existingOutboxEntries: OutboxEntry[] = [];
    let finalized = false;
    let abortReason: Error | null = null;
    let committedResult: { session: StocktakingSession; movements: LedgerMovement[] } | null = null;

    const abortWith = (err: unknown, fallback: string) => {
      if (!abortReason) abortReason = err instanceof Error ? err : new Error(fallback);
      try {
        tx.abort();
      } catch {
        // ignore
      }
    };

    const tryCommit = () => {
      if (finalized || !sessLoaded || !subItemsLoaded || !medsLoaded || !ledgerLoaded || !outboxLoaded) return;
      finalized = true;

      try {
        if (!session) {
          abortWith(new Error('جلسة الجرد غير موجودة'), 'جلسة الجرد غير موجودة');
          return;
        }
        assertSessionBranchMatches(session, effectiveBranchId);

        if (
          session.status === 'committed' ||
          (session.status as string) === 'COMMITTED' ||
          (session.status as string) === 'sync_completed_unverified' ||
          (session.status as string) === 'syncing_adjustments'
        ) {
          abortWith(new Error('جلسة الجرد معتمدة ومرحلة مسبقاً'), 'جلسة معتمدة مسبقاً');
          return;
        }
        if (session.status === 'cancelled' || (session.status as string) === 'CANCELLED') {
          abortWith(new Error('جلسة الجرد ملغاة ولا يمكن اعتمادها'), 'جلسة ملغاة');
          return;
        }
        if ((session as any).unitMigrationReviewRequired === true) {
          abortWith(
            new Error('STOCKTAKING_UNIT_REVIEW_REQUIRED: جلسة الجرد موقوفة للمراجعة الصيدلانية بسبب تعارض أو تكرار بيانات الوحدات'),
            'جلسة جرد تتطلب مراجعة الوحدات'
          );
          return;
        }
        if (hasSessionOutboxLockOrCommit(existingOutboxEntries, session.id, knownBranchId)) {
          abortWith(
            new Error('STOCKTAKING_SESSION_LOCKED: توجد عملية قفل أو اعتماد سابقة في طابور المزامنة لهذه الجلسة'),
            'جلسة مقفلة في Outbox'
          );
          return;
        }

        const medMap = new Map<string, Medicine>();
        for (const m of allMeds) {
          if (m) medMap.set(m.id, m);
        }

        // Authoritative items: merge subcollection store + legacy inline items, detecting duplicates
        const itemByMed = new Map<string, StocktakingItemRecord>();
        const seenLegacyMeds = new Set<string>();
        for (const legacyIt of Array.isArray(session.items) ? session.items : []) {
          if (!legacyIt || typeof legacyIt !== 'object') {
            abortWith(new Error('INVALID_STOCKTAKING_ITEM: يوجد سطر غير صالح داخل الجلسة'), 'سطر غير صالح');
            return;
          }
          if (!isValidStocktakingDocId(legacyIt.medicineId)) {
            abortWith(new Error('INVALID_FIRESTORE_ID: معرف دواء غير صالح داخل الجلسة'), 'معرف غير صالح');
            return;
          }
          if (seenLegacyMeds.has(legacyIt.medicineId)) {
            abortWith(
              new Error(`DUPLICATE_STOCKTAKING_MEDICINE: الدواء "${legacyIt.medicineId}" مكرر داخل الجلسة`),
              'تكرار دواء'
            );
            return;
          }
          seenLegacyMeds.add(legacyIt.medicineId);
          const legId = isValidStocktakingDocId(legacyIt.id)
            ? legacyIt.id.trim()
            : deriveStocktakingItemId(effectiveBranchId, session.id, legacyIt.medicineId);
          itemByMed.set(legacyIt.medicineId, {
            ...legacyIt,
            id: legId,
            sessionId: session.id,
            branchId: effectiveBranchId,
            createdAt: (legacyIt as any).createdAt || session.startedAt || nowIso,
            updatedAt: (legacyIt as any).updatedAt || legacyIt.lastScannedAt || nowIso
          });
        }
        const seenSubMeds = new Set<string>();
        for (const subIt of sessionSubItems) {
          if (!subIt || !isValidStocktakingDocId(subIt.medicineId)) {
            abortWith(new Error('INVALID_STOCKTAKING_ITEM: سجل صنف تالف في مخزن stocktaking_items'), 'سجل صنف تالف');
            return;
          }
          if (seenSubMeds.has(subIt.medicineId)) {
            abortWith(
              new Error(`DUPLICATE_STOCKTAKING_MEDICINE: الدواء "${subIt.medicineId}" مكرر في stocktaking_items`),
              'تكرار دواء'
            );
            return;
          }
          seenSubMeds.add(subIt.medicineId);
          itemByMed.set(subIt.medicineId, subIt);
        }

        const authoritativeItems = Array.from(itemByMed.values());
        for (const item of authoritativeItems) {
          if (
            typeof item.systemStock !== 'number' ||
            !Number.isFinite(item.systemStock) ||
            item.systemStock < 0 ||
            typeof item.actualCount !== 'number' ||
            !Number.isFinite(item.actualCount) ||
            item.actualCount < 0 ||
            typeof item.buyPrice !== 'number' ||
            !Number.isFinite(item.buyPrice) ||
            item.buyPrice < 0 ||
            typeof item.variance !== 'number' ||
            !Number.isFinite(item.variance) ||
            typeof item.varianceSDG !== 'number' ||
            !Number.isFinite(item.varianceSDG)
          ) {
            abortWith(
              new Error(`INVALID_STOCKTAKING_ITEM: قيم غير صالحة أو سالبة للصنف "${item.medicineName}"`),
              'قيم جرد غير صالحة'
            );
            return;
          }
          if (Math.abs(item.variance - (item.actualCount - item.systemStock)) > 0.01) {
            abortWith(
              new Error(`STOCKTAKING_VARIANCE_MISMATCH: عدم تطابق الفارق الحسابي للصنف "${item.medicineName}"`),
              'تعارض حسابي للفارق'
            );
            return;
          }
          if (Math.abs(item.varianceSDG - item.variance * item.buyPrice) > 0.02) {
            abortWith(
              new Error(`STOCKTAKING_VARIANCE_SDG_MISMATCH: عدم تطابق التكلفة الحسابية للصنف "${item.medicineName}"`),
              'تعارض حسابي للتكلفة'
            );
            return;
          }
          // Ensure stocktaking_items store has persisted child record (even for legacy v5 sessions)
          itemsStore.put({ ...item, syncStatus: item.syncStatus || 'pending_sync' });
        }

        const outboxDepIndex = buildOutboxDependencyIndex(existingOutboxEntries);
        const sessionItemVarianceMedIds = new Set(
          authoritativeItems.filter((i) => Math.abs(i.variance) > 0.001).map((i) => i.medicineId)
        );
        const unsyncedMedCreateByMed = new Map<string, string[]>();
        for (const e of existingOutboxEntries) {
          if (
            e &&
            e.entityType === 'medicine' &&
            sessionItemVarianceMedIds.has(e.entityId) &&
            e.action === 'CREATE' &&
            e.status !== 'synced'
          ) {
            validateOutboxRecordDependencies(e, outboxDepIndex);
            const opId = getCanonicalOutboxOperationId(e);
            if (opId) {
              const list = unsyncedMedCreateByMed.get(e.entityId) || [];
              if (!list.includes(opId)) list.push(opId);
              unsyncedMedCreateByMed.set(e.entityId, list);
            }
          }
        }

        const existingLedgerIds = new Set(existingLedger.map((m) => m?.id).filter(Boolean));
        const existingOutboxEntityIds = new Set(
          existingOutboxEntries
            .filter((e) => e && e.entityType === 'inventory_ledger')
            .map((e) => e.entityId)
        );

        const movements: LedgerMovement[] = [];
        const adjustmentItemIdByMovId = new Map<string, string>();
        for (const item of authoritativeItems) {
          if (Math.abs(item.variance) > 0.001) {
            const med = medMap.get(item.medicineId);
            if (!med) {
              abortWith(new Error(`STOCKTAKING_MEDICINE_MISSING:${item.medicineId}`), 'دواء الجرد غير موجود');
              return;
            }
            if (med.archived === true) {
              abortWith(
                new Error(`COMMERCIAL_TARGET_ARCHIVED: الدواء "${med.name}" مؤرشف ولا يمكن تسوية مخزونه`),
                'الدواء مؤرشف'
              );
              return;
            }
            try {
              assertMedicineOperationallyAllowed(med);
            } catch (error) {
              abortWith(error, 'لا يمكن اعتماد جرد دواء لم يجتز التحقق التشغيلي');
              return;
            }
            if ((med as any).branchId && (med as any).branchId !== effectiveBranchId) {
              abortWith(
                new Error(`BRANCH_ISOLATION_VIOLATION: الدواء "${med.name}" يتبع فرعاً آخر`),
                'مخالفة عزل الفروع'
              );
              return;
            }

            const resolvedBatchNumber = String(item.batchNumber || med.batchNumber || '').trim();
            if (!resolvedBatchNumber) {
              abortWith(
                new Error(`LEGACY_BATCH_IDENTITY_UNKNOWN:${med.id}:stocktaking-adjustment`),
                'لا يمكن تسوية فرق الجرد قبل تحديد التشغيلة؛ لن يتم إنشاء دفعة افتراضية'
              );
              return;
            }
            const stripsPerPack = Number(med.stripsPerPack);
            const pillsPerStrip = Number(med.pillsPerStrip);
            const baseUnitsDelta = convertMedicineQuantityToBaseUnits(item.variance, 'pack', med);
            if (!Number.isFinite(baseUnitsDelta) || baseUnitsDelta === 0) {
              abortWith(
                new Error(`INVALID_STOCKTAKING_LEDGER_DELTA: حركة تسوية صفرية أو غير صالحة للدواء "${item.medicineName}"`),
                'حركة تسوية صفرية'
              );
              return;
            }

            const detLedgerId = deriveStocktakingAdjustmentLedgerId(
              effectiveBranchId,
              session.id,
              item.id,
              'ADJUSTMENT'
            );
            if (existingLedgerIds.has(detLedgerId) || existingOutboxEntityIds.has(detLedgerId)) {
              abortWith(
                new Error(`DUPLICATE_STOCKTAKING_ADJUSTMENT: حركة التسوية "${detLedgerId}" مسجلة مسبقاً`),
                'تكرار حركة تسوية'
              );
              return;
            }

            const auditNote = [
              `تسوية جرد دوري #${session.sessionNumber}`,
              `الدواء: ${item.medicineName}`,
              `رصيد النظام: ${item.systemStock} عبوة`,
              `العد الفعلي: ${item.actualCount} عبوة`,
              `الفارق: ${item.variance > 0 ? '+' : ''}${item.variance} عبوة (${item.varianceSDG > 0 ? '+' : ''}${item.varianceSDG} ج.س)`,
              reason ? `السبب: ${reason}` : ''
            ]
              .filter(Boolean)
              .join(' | ');

            const movement: LedgerMovement = {
              id: detLedgerId,
              medicineId: item.medicineId,
              batchNumber: resolvedBatchNumber,
              expiry: item.expiry || med?.expiry,
              type: 'ADJUSTMENT',
              unit: 'pack',
              quantityDelta: item.variance,
              baseUnitsDelta,
              costPerUnit: item.buyPrice,
              costPerBaseUnit: normalizeMedicineCostToBaseUnit(item.buyPrice, 'pack', med),
              referenceId: session.sessionNumber,
              deviceId,
              userId: knownActorUid || employeeName,
              employeeName: (employeeName || 'صيدلي مسؤول').slice(0, 120),
              notes: auditNote.slice(0, 500),
              timestamp: nowIso,
              synced: 0
            };
            movements.push(movement);
            adjustmentItemIdByMovId.set(movement.id, item.id);
          }
        }

        const metrics = computeStocktakingSummaryMetrics(authoritativeItems);
        const adjustmentLedgerIds = movements.map((m) => m.id);
        const finalReason = (reason || 'اعتماد تسوية الجرد الدوري للمخزون').slice(0, 500);
        const committedByName = (employeeName || 'صيدلي مسؤول').slice(0, 128);

        // Local representation retains status = 'committed' and items[] for full Phase 5 & UI compatibility
        const updatedSession: StocktakingSession & {
          branchId: string;
          accountingStatus: 'unverified_client_sync';
          syncStatus: 'pending_sync';
          committedByUid?: string;
        } = {
          ...session,
          branchId: session.branchId || effectiveBranchId,
          status: 'committed',
          accountingStatus: 'unverified_client_sync',
          syncStatus: 'pending_sync',
          committedAt: nowIso,
          committedBy: committedByName,
          ...(knownActorUid ? { committedByUid: knownActorUid } : {}),
          auditReason: finalReason,
          items: authoritativeItems,
          ...metrics,
          adjustmentLedgerIds,
          updatedAt: nowIso
        };
        sessionStore.put(updatedSession);

        // Build 3-Stage Rules-Compliant Outbox V2 DAG
        const { unsyncedCreateOpIds, unsyncedAllSessionItemOpIds, unsyncedItemOpsByItemId } =
          collectUnsyncedStocktakingOps(existingOutboxEntries, session.id);

        // Stage 2A: Lock session in Firestore (status: 'syncing_adjustments', accountingStatus: 'open', NO committedAt)
        const lockOutboxId = generateUUID();
        const lockDeps = Array.from(new Set([...unsyncedCreateOpIds, ...unsyncedAllSessionItemOpIds]));
        outboxStore.put({
          id: lockOutboxId,
          operationId: lockOutboxId,
          idempotencyKey: `stocktaking_session:UPDATE:lock:${session.id}`,
          ...(knownBranchId ? { branchId: knownBranchId } : {}),
          ...(knownActorUid ? { actorUid: knownActorUid } : {}),
          schemaVersion: 2,
          ...(lockDeps.length > 0 ? { dependsOn: lockDeps } : {}),
          entityType: 'stocktaking_session',
          entityId: session.id,
          action: 'UPDATE',
          payload: buildSanitizedCloudSessionPayload(updatedSession, {
            status: 'syncing_adjustments',
            accountingStatus: 'open',
            knownBranchId,
            knownActorUid,
            includeCompletionSummaries: false,
            auditReason: finalReason
          }),
          timestamp: nowIso,
          retryCount: 0,
          attempts: 0,
          status: 'pending'
        });

        // Stage 2B: Ledger ADJUSTMENT entries depending on Stage 2A Lock + medicine CREATE + child item ops
        const ledgerOutboxOpIds: string[] = [];
        for (const mov of movements) {
          ledgerStore.put(mov);
          const medDeps = unsyncedMedCreateByMed.get(mov.medicineId) || [];
          const targetItemId = adjustmentItemIdByMovId.get(mov.id) || '';
          const itemDeps = targetItemId ? unsyncedItemOpsByItemId.get(targetItemId) || [] : [];
          const movDeps = Array.from(new Set([lockOutboxId, ...medDeps, ...itemDeps]));
          const movOutboxId = generateUUID();
          ledgerOutboxOpIds.push(movOutboxId);
          outboxStore.put({
            id: movOutboxId,
            operationId: movOutboxId,
            idempotencyKey: `inventory_ledger:CREATE:${mov.id}`,
            ...(knownBranchId ? { branchId: knownBranchId } : {}),
            ...(knownActorUid ? { actorUid: knownActorUid } : {}),
            schemaVersion: 2,
            dependsOn: movDeps,
            entityType: 'inventory_ledger',
            entityId: mov.id,
            action: 'CREATE',
            payload: { ...mov, ...(knownBranchId ? { branchId: knownBranchId } : {}) },
            timestamp: nowIso,
            retryCount: 0,
            attempts: 0,
            status: 'pending'
          });
        }

        // Stage 3: Final completion UPDATE (status: 'sync_completed_unverified', accountingStatus: 'unverified_client_sync')
        const completeOutboxId = generateUUID();
        const completeDeps = Array.from(new Set([lockOutboxId, ...ledgerOutboxOpIds]));
        outboxStore.put({
          id: completeOutboxId,
          operationId: completeOutboxId,
          idempotencyKey: `stocktaking_session:UPDATE:complete:${session.id}`,
          ...(knownBranchId ? { branchId: knownBranchId } : {}),
          ...(knownActorUid ? { actorUid: knownActorUid } : {}),
          schemaVersion: 2,
          dependsOn: completeDeps,
          entityType: 'stocktaking_session',
          entityId: session.id,
          action: 'UPDATE',
          payload: buildSanitizedCloudSessionPayload(updatedSession, {
            status: 'sync_completed_unverified',
            accountingStatus: 'unverified_client_sync',
            knownBranchId,
            knownActorUid,
            includeCompletionSummaries: true,
            committedAt: nowIso,
            committedBy: committedByName,
            committedByUid: knownActorUid,
            auditReason: finalReason,
            adjustmentLedgerIds
          }),
          timestamp: nowIso,
          retryCount: 0,
          attempts: 0,
          status: 'pending'
        });

        committedResult = { session: updatedSession, movements };
      } catch (err) {
        abortWith(err, 'فشل اعتماد جلسة الجرد');
      }
    };

    const sReq = sessionStore.get(sessionId);
    sReq.onerror = () => abortWith(sReq.error, 'تعذر قراءة جلسة الجرد');
    sReq.onsuccess = () => {
      session = sReq.result as any;
      sessLoaded = true;
      tryCommit();
    };

    const iReq = itemsStore.indexNames.contains('sessionId')
      ? itemsStore.index('sessionId').getAll(sessionId)
      : itemsStore.getAll();
    iReq.onerror = () => abortWith(iReq.error, 'تعذر قراءة أصناف الجرد للاعتماد');
    iReq.onsuccess = () => {
      const res = (iReq.result as StocktakingItemRecord[]) || [];
      sessionSubItems = res.filter((it) => it && it.sessionId === sessionId);
      subItemsLoaded = true;
      tryCommit();
    };

    const mReq = medStore.getAll();
    mReq.onerror = () => abortWith(mReq.error, 'تعذر قراءة الأدوية للاعتماد');
    mReq.onsuccess = () => {
      allMeds = (mReq.result as Medicine[]) || [];
      medsLoaded = true;
      tryCommit();
    };

    const lReq = ledgerStore.getAll();
    lReq.onerror = () => abortWith(lReq.error, 'تعذر قراءة سجل المخزون للاعتماد');
    lReq.onsuccess = () => {
      existingLedger = (lReq.result as LedgerMovement[]) || [];
      ledgerLoaded = true;
      tryCommit();
    };

    const oReq = outboxStore.getAll();
    oReq.onerror = () => abortWith(oReq.error, 'تعذر قراءة طابور Outbox للاعتماد');
    oReq.onsuccess = () => {
      existingOutboxEntries = (oReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryCommit();
    };

    tx.oncomplete = () => {
      if (committedResult) resolve(committedResult);
      else reject(abortReason || new Error('فشل اعتماد جلسة الجرد'));
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل اعتماد جلسة الجرد'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة اعتماد جلسة الجرد'));
  });
}

/**
 * Cancel a stocktaking session without affecting inventory (atomic read-modify-write).
 * Strictly forbids cancelling a locked, syncing_adjustments, committed, or already cancelled session.
 */
export async function cancelStocktakingSession(
  sessionId: string,
  employeeName: string
): Promise<StocktakingSession> {
  assertStocktakingWriteAuthorized();
  if (!isValidStocktakingDocId(sessionId)) {
    throw new Error('INVALID_FIRESTORE_ID: معرف جلسة الجرد غير صالح');
  }

  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['stocktaking_sessions', 'stocktaking_items', 'outbox']);
  const nowIso = new Date().toISOString();
  const knownBranchId = getKnownActiveBranchId();
  const effectiveBranchId = getEffectiveStocktakingBranchId(knownBranchId);
  const knownActorUid = getKnownActiveActorId();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['stocktaking_sessions', 'stocktaking_items', 'outbox'], 'readwrite');
    const sessionStore = tx.objectStore('stocktaking_sessions');
    const outboxStore = tx.objectStore('outbox');

    let sessLoaded = false;
    let outboxLoaded = false;
    let session: (StocktakingSession & { branchId?: string; accountingStatus?: string; syncStatus?: string }) | undefined;
    let existingOutboxEntries: OutboxEntry[] = [];
    let finalized = false;
    let abortReason: Error | null = null;
    let cancelledSession: StocktakingSession | null = null;

    const abortWith = (err: unknown, fallback: string) => {
      if (!abortReason) abortReason = err instanceof Error ? err : new Error(fallback);
      try {
        tx.abort();
      } catch {
        // ignore
      }
    };

    const tryCancel = () => {
      if (finalized || !sessLoaded || !outboxLoaded) return;
      finalized = true;
      try {
        if (!session) {
          abortWith(new Error('جلسة الجرد غير موجودة'), 'جلسة الجرد غير موجودة');
          return;
        }
        assertSessionBranchMatches(session, effectiveBranchId);

        if (
          isStocktakingSessionLockedOrTerminalLocal(session) ||
          hasSessionOutboxLockOrCommit(existingOutboxEntries, session.id, knownBranchId)
        ) {
          abortWith(
            new Error('STOCKTAKING_SESSION_LOCKED: لا يمكن إلغاء جلسة جرد مقفلة أو معتمدة أو ملغاة مسبقاً'),
            'جلسة مقفلة أو معتمدة'
          );
          return;
        }

        const cancelReason = `ألغيت بواسطة ${employeeName || 'صيدلي مسؤول'}`.slice(0, 500);
        const updatedSession: StocktakingSession & {
          branchId: string;
          accountingStatus: 'cancelled';
          syncStatus: 'pending_sync';
        } = {
          ...session,
          branchId: session.branchId || effectiveBranchId,
          status: 'cancelled',
          accountingStatus: 'cancelled',
          syncStatus: 'pending_sync',
          cancelledAt: nowIso,
          cancelledBy: (employeeName || 'صيدلي مسؤول').slice(0, 128),
          auditReason: cancelReason,
          updatedAt: nowIso
        };
        sessionStore.put(updatedSession);

        const { unsyncedCreateOpIds, unsyncedAllSessionItemOpIds } = collectUnsyncedStocktakingOps(
          existingOutboxEntries,
          session.id
        );
        const cancelDeps = Array.from(new Set([...unsyncedCreateOpIds, ...unsyncedAllSessionItemOpIds]));
        const outboxId = generateUUID();
        outboxStore.put({
          id: outboxId,
          operationId: outboxId,
          idempotencyKey: `stocktaking_session:UPDATE:cancel:${session.id}`,
          ...(knownBranchId ? { branchId: knownBranchId } : {}),
          ...(knownActorUid ? { actorUid: knownActorUid } : {}),
          schemaVersion: 2,
          ...(cancelDeps.length > 0 ? { dependsOn: cancelDeps } : {}),
          entityType: 'stocktaking_session',
          entityId: session.id,
          action: 'UPDATE',
          payload: buildSanitizedCloudSessionPayload(updatedSession, {
            status: 'cancelled',
            accountingStatus: 'cancelled',
            knownBranchId,
            knownActorUid,
            includeCompletionSummaries: false,
            auditReason: cancelReason
          }),
          timestamp: nowIso,
          retryCount: 0,
          attempts: 0,
          status: 'pending'
        });
        cancelledSession = updatedSession;
      } catch (err) {
        abortWith(err, 'فشل إلغاء جلسة الجرد');
      }
    };

    const sReq = sessionStore.get(sessionId);
    sReq.onerror = () => abortWith(sReq.error, 'تعذر قراءة جلسة الجرد');
    sReq.onsuccess = () => {
      session = sReq.result as any;
      sessLoaded = true;
      tryCancel();
    };

    const oReq = outboxStore.getAll();
    oReq.onerror = () => abortWith(oReq.error, 'تعذر قراءة طابور Outbox');
    oReq.onsuccess = () => {
      existingOutboxEntries = (oReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryCancel();
    };

    tx.oncomplete = () => {
      if (cancelledSession) resolve(cancelledSession);
      else reject(abortReason || new Error('فشل إلغاء جلسة الجرد'));
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل إلغاء جلسة الجرد'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة إلغاء جلسة الجرد'));
  });
}

/**
 * FIX-A01 & FIX-A02: Delete a Bankak receipt with an atomic persistent tombstone.
 * Ensures the tombstone is written and receipt is deleted within a single readwrite transaction.
 * If either step fails, the entire transaction is rolled back.
 */
export async function deleteBankakReceiptWithTombstone(
  id: string,
  metadata?: { transactionId?: string; reason?: string; deletedBy?: string }
): Promise<{ success: boolean; tombstone: BankakTombstone }> {
  const db = await openPharmacyDB();
  return new Promise((resolve, reject) => {
    try {
      const stores = ['receipts', 'bankak_tombstones'];
      for (const s of stores) {
        if (!db.objectStoreNames.contains(s)) {
          throw new Error(`Object store '${s}' not found in database schema`);
        }
      }

      const tx = db.transaction(stores, 'readwrite');
      const receiptsStore = tx.objectStore('receipts');
      const tombstoneStore = tx.objectStore('bankak_tombstones');

      const tombstone: BankakTombstone = {
        id,
        transactionId: metadata?.transactionId || undefined,
        deletedAt: new Date().toISOString(),
        syncStatus: 'pending_server_delete',
        deletedBy: metadata?.deletedBy || undefined,
        reason: metadata?.reason || undefined,
      };

      // 1. Write persistent tombstone
      tombstoneStore.put(tombstone);

      // 2. Delete receipt record
      receiptsStore.delete(id);

      tx.oncomplete = () => {
        resolve({ success: true, tombstone });
      };
      tx.onerror = () => {
        reject(tx.error || new Error('Transaction failed while deleting receipt with tombstone'));
      };
      tx.onabort = () => {
        reject(new Error('Transaction aborted: receipt deletion and tombstone write rolled back'));
      };
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Retrieves all persistent Bankak deletion tombstones.
 */
export async function getBankakTombstones(): Promise<BankakTombstone[]> {
  const db = await openPharmacyDB();
  if (!db.objectStoreNames.contains('bankak_tombstones')) return [];
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('bankak_tombstones', 'readonly');
      const req = tx.objectStore('bankak_tombstones').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || tx.error);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Checks whether a given receipt ID has been marked with a persistent deletion tombstone.
 */
export async function isReceiptDeleted(id: string): Promise<boolean> {
  const db = await openPharmacyDB();
  if (!db.objectStoreNames.contains('bankak_tombstones')) return false;
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('bankak_tombstones', 'readonly');
      const store = tx.objectStore('bankak_tombstones');
      const req = store.get(id);
      req.onsuccess = () => resolve(!!req.result);
      req.onerror = () => reject(req.error || tx.error);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Confirms that a tombstone deletion has been synchronized and confirmed by the backend server.
 */
export async function confirmServerTombstoneSync(id: string): Promise<boolean> {
  const db = await openPharmacyDB();
  if (!db.objectStoreNames.contains('bankak_tombstones')) return false;
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('bankak_tombstones', 'readwrite');
      const store = tx.objectStore('bankak_tombstones');
      const req = store.get(id);
      req.onsuccess = () => {
        const tombstone = req.result as BankakTombstone | undefined;
        if (tombstone) {
          tombstone.syncStatus = 'synced';
          store.put(tombstone);
        }
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    } catch (err) {
      reject(err);
    }
  });
}

let isSyncingTombstones = false;

/**
 * Retries syncing any persistent tombstones with status 'pending_server_delete' to the server.
 * Ensures single-concurrency guard (isSyncingTombstones), idempotent operations, and updates
 * tombstone syncStatus to 'synced' ONLY after server confirmation and local IndexedDB save completion.
 */
export async function syncPendingBankakTombstones(apiClient?: { delete: (url: string) => Promise<any> }): Promise<{
  attempted: number;
  synced: number;
  failed: number;
}> {
  if (isSyncingTombstones) {
    return { attempted: 0, synced: 0, failed: 0 };
  }
  isSyncingTombstones = true;

  try {
    const tombstones = await getBankakTombstones();
    const pending = tombstones.filter((t) => t.syncStatus === 'pending_server_delete');
    if (pending.length === 0) {
      return { attempted: 0, synced: 0, failed: 0 };
    }

    let syncedCount = 0;
    let failedCount = 0;

    const fetchClient = apiClient || {
      delete: async (url: string) => {
        const res = await fetch(url, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json().catch(() => ({ success: true }));
      },
    };

    for (const tombstone of pending) {
      try {
        const srvRes = await fetchClient.delete(`/api/bankak/receipts/${tombstone.id}`);
        if (srvRes && (srvRes.success || srvRes.alreadyDeleted)) {
          const ok = await confirmServerTombstoneSync(tombstone.id);
          if (ok) {
            syncedCount++;
          } else {
            failedCount++;
          }
        } else {
          failedCount++;
        }
      } catch (err) {
        console.warn(`[TombstoneSync] Pending tombstone retry failed for receipt ${tombstone.id}:`, err);
        failedCount++;
      }
    }

    return { attempted: pending.length, synced: syncedCount, failed: failedCount };
  } finally {
    isSyncingTombstones = false;
  }
}

/**
 * Delete a Bankak receipt from the primary IndexedDB with durable tombstone guarantee.
 * Retains backward-compatible signature.
 */
export async function deleteBankakReceipt(id: string): Promise<boolean> {
  const res = await deleteBankakReceiptWithTombstone(id);
  return res.success;
}

/**
 * Check if a Bankak receipt is linked to a sales or supplier financial transaction
 */
export async function checkReceiptFinancialLink(transactionId?: string): Promise<{
  isLinked: boolean;
  linkedType?: 'SALE' | 'SUPPLIER_PAYMENT';
  referenceDetails?: string;
}> {
  if (!transactionId || !transactionId.trim()) {
    return { isLinked: false };
  }
  const cleanId = transactionId.trim();

  // 1. Check sales
  const sales = await getAllSales();
  const linkedSale = sales.find(s => s.bankakTransactionId && s.bankakTransactionId.trim() === cleanId);
  if (linkedSale) {
    return {
      isLinked: true,
      linkedType: 'SALE',
      referenceDetails: `فاتورة مبيعات #${linkedSale.invoiceNumber} بقيمة ${linkedSale.total} ج.س`
    };
  }

  // 2. Check supplier payments
  const payments = await getAllSupplierPayments();
  const linkedPayment = payments.find(p => 
    (p.bankakTransactionId && p.bankakTransactionId.trim() === cleanId) ||
    (p.referenceId && p.referenceId.trim() === cleanId)
  );
  if (linkedPayment) {
    return {
      isLinked: true,
      linkedType: 'SUPPLIER_PAYMENT',
      referenceDetails: `سند صرف مورد #${linkedPayment.voucherNumber} بقيمة ${linkedPayment.amount} ج.س`
    };
  }

  return { isLinked: false };
}

/**
 * Category Management Subsystem (Phase 1M.8)
 */
export async function getAllCategories(): Promise<string[]> {
  const db = await openPharmacyDB();
  const defaultCategories = ['Antibiotics', 'Analgesics', 'Chronic', 'Vitamins'];

  // 1. Fetch custom categories from metadata store
  const customCatList = await new Promise<string[]>((resolve) => {
    try {
      const tx = db.transaction('metadata', 'readonly');
      const store = tx.objectStore('metadata');
      const req = store.get('custom_categories');
      req.onsuccess = () => {
        if (req.result && Array.isArray(req.result.value)) {
          resolve(req.result.value);
        } else {
          resolve([]);
        }
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });

  // 2. Fetch categories from all existing medicines to ensure any historic categories are included
  const medicines = await getAllMedicines();
  const medicineCategories = medicines
    .map((m) => m.category)
    .filter((cat): cat is string => Boolean(cat && typeof cat === 'string' && cat.trim().length > 0));

  // 3. Deduplicate (case-insensitive & whitespace normalized) preserving original title-case string
  const categoryMap = new Map<string, string>();

  // Add default categories first
  defaultCategories.forEach((cat) => {
    const key = cat.trim().toLowerCase();
    if (!categoryMap.has(key)) categoryMap.set(key, cat.trim());
  });

  // Add stored custom categories
  customCatList.forEach((cat) => {
    if (typeof cat === 'string' && cat.trim().length > 0) {
      const key = cat.trim().toLowerCase();
      if (!categoryMap.has(key)) categoryMap.set(key, cat.trim());
    }
  });

  // Add categories found in medicines
  medicineCategories.forEach((cat) => {
    const key = cat.trim().toLowerCase();
    if (!categoryMap.has(key)) categoryMap.set(key, cat.trim());
  });

  return Array.from(categoryMap.values());
}

function resolveCategoryOutboxWrite(params: {
  existingEntries: OutboxEntry[];
  updatedCustom: string[];
  knownBranchId?: string;
  knownActorUid?: string;
  nowIso: string;
  incomingFreshnessMs: number;
}): {
  targetEntry: OutboxEntry;
  coalesced: boolean;
} {
  const { existingEntries, updatedCustom, knownBranchId, knownActorUid, nowIso, incomingFreshnessMs } = params;
  const catOutboxEntries = existingEntries.filter(
    (e) =>
      e &&
      e.entityType === 'category_metadata' &&
      e.entityId === 'custom_categories'
  );

  const isInFlightOrLeased = (e: OutboxEntry): boolean =>
    e.status === 'processing' ||
    e.status === 'syncing' ||
    (typeof e.leaseOwner === 'string' && e.leaseOwner.trim().length > 0);

  const getEntryFreshnessMs = (e: OutboxEntry): number => {
    const payloadMs = Date.parse(e.payload?.updatedAt || '');
    const tsMs = Date.parse(e.timestamp || '');
    return Math.max(Number.isFinite(payloadMs) ? payloadMs : 0, Number.isFinite(tsMs) ? tsMs : 0);
  };

  let latestProtectedMs = 0;
  let hasStrictlyNewerEntry = false;
  for (const entry of catOutboxEntries) {
    const entryMs = getEntryFreshnessMs(entry);
    if (entryMs > incomingFreshnessMs) {
      hasStrictlyNewerEntry = true;
    }
    if (
      isInFlightOrLeased(entry) ||
      entry.status === 'synced' ||
      entry.status === 'dead-letter' ||
      entry.status === 'blocked'
    ) {
      if (entryMs > latestProtectedMs) {
        latestProtectedMs = entryMs;
      }
    }
  }

  let coalesceCandidate: OutboxEntry | null = null;
  if (!hasStrictlyNewerEntry) {
    let bestCandidateMs = -1;
    for (const entry of catOutboxEntries) {
      if (isInFlightOrLeased(entry)) continue;
      if (entry.status !== 'pending' && entry.status !== 'retry' && entry.status !== 'failed') continue;
      if (entry.action !== 'UPDATE') continue;

      const entryMs = getEntryFreshnessMs(entry);
      if (entryMs < latestProtectedMs) continue;
      if (entryMs > incomingFreshnessMs) continue;

      if (entryMs >= bestCandidateMs) {
        bestCandidateMs = entryMs;
        coalesceCandidate = entry;
      }
    }
  }

  if (coalesceCandidate) {
    const normalizedCandidate = normalizeOutboxEntry(coalesceCandidate);
    const updatedEntry: OutboxEntry = {
      ...normalizedCandidate,
      action: 'UPDATE',
      idempotencyKey: 'category_metadata:UPDATE:custom_categories',
      ...(knownBranchId && !normalizedCandidate.branchId ? { branchId: knownBranchId } : {}),
      ...(knownActorUid && !normalizedCandidate.actorUid ? { actorUid: knownActorUid } : {}),
      payload: { custom_categories: updatedCustom },
      timestamp: nowIso,
      status: 'pending'
    };
    delete updatedEntry.leaseOwner;
    delete updatedEntry.leaseExpiresAt;
    delete updatedEntry.nextRetryAt;
    delete updatedEntry.lastErrorCode;
    delete updatedEntry.lastErrorMessage;
    return { targetEntry: updatedEntry, coalesced: true };
  }

  const categoryOutboxId = generateUUID();
  const freshEntry: OutboxEntry = {
    id: categoryOutboxId,
    operationId: categoryOutboxId,
    idempotencyKey: 'category_metadata:UPDATE:custom_categories',
    ...(knownBranchId ? { branchId: knownBranchId } : {}),
    ...(knownActorUid ? { actorUid: knownActorUid } : {}),
    schemaVersion: 1,
    entityType: 'category_metadata',
    entityId: 'custom_categories',
    action: 'UPDATE',
    payload: { custom_categories: updatedCustom },
    timestamp: nowIso,
    retryCount: 0,
    attempts: 0,
    status: 'pending'
  };
  return { targetEntry: freshEntry, coalesced: false };
}

export async function saveCategory(categoryName: string): Promise<string[]> {
  const trimmed = (categoryName || '').trim();
  if (!trimmed) {
    throw new Error('اسم التصنيف لا يمكن أن يكون فارغاً');
  }

  const db = await openPharmacyDB();
  assertRequiredObjectStores(db, ['metadata', 'medicines', 'outbox']);
  const knownBranchId = getKnownActiveBranchId();
  const knownActorUid = getKnownActiveActorId();
  const defaultCategories = ['Antibiotics', 'Analgesics', 'Chronic', 'Vitamins'];

  return new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(['metadata', 'medicines', 'outbox'], 'readwrite');
    const metaStore = tx.objectStore('metadata');
    const medStore = tx.objectStore('medicines');
    const outboxStore = tx.objectStore('outbox');

    let metaLoaded = false;
    let inTxMetaRecord: { key: string; value?: unknown; updatedAt?: string } | undefined;
    let medsLoaded = false;
    let inTxMeds: Medicine[] = [];
    let outboxLoaded = false;
    let existingOutboxEntries: OutboxEntry[] = [];
    let finalized = false;
    let abortReason: Error | null = null;
    let resolvedCategoryList: string[] | null = null;

    const failTx = (err: unknown, fallbackMsg: string) => {
      const normalizedErr = err instanceof Error ? err : new Error(fallbackMsg);
      abortReason = normalizedErr;
      try {
        tx.abort();
      } catch {
        // ignore abort error
      }
      reject(normalizedErr);
    };

    const tryFinalize = () => {
      if (finalized || !metaLoaded || !medsLoaded || !outboxLoaded) {
        return;
      }
      finalized = true;

      try {
        const currentCustom = Array.isArray(inTxMetaRecord?.value)
          ? inTxMetaRecord!.value.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
          : [];

        const categoryMap = new Map<string, string>();
        defaultCategories.forEach((cat) => {
          const key = cat.trim().toLowerCase();
          if (!categoryMap.has(key)) categoryMap.set(key, cat.trim());
        });
        currentCustom.forEach((cat) => {
          const key = cat.trim().toLowerCase();
          if (!categoryMap.has(key)) categoryMap.set(key, cat.trim());
        });
        inTxMeds.forEach((med) => {
          if (med && typeof med.category === 'string' && med.category.trim().length > 0) {
            const key = med.category.trim().toLowerCase();
            if (!categoryMap.has(key)) categoryMap.set(key, med.category.trim());
          }
        });

        const lowerTarget = trimmed.toLowerCase();
        if (categoryMap.has(lowerTarget)) {
          failTx(new Error(`التصنيف "${trimmed}" موجود بالفعل`), 'التصنيف موجود بالفعل');
          return;
        }

        const updatedCustom = [...currentCustom, trimmed];
        categoryMap.set(lowerTarget, trimmed);
        resolvedCategoryList = Array.from(categoryMap.values());

        const txWallMs = Date.now();
        const txWallIso = new Date(txWallMs).toISOString();
        const existingMetaUpdatedAtMs = inTxMetaRecord?.updatedAt
          ? Date.parse(inTxMetaRecord.updatedAt)
          : NaN;
        let maxCatOutboxMs = 0;
        for (const entry of existingOutboxEntries) {
          if (!entry || entry.entityType !== 'category_metadata' || entry.entityId !== 'custom_categories') {
            continue;
          }
          const tsMs = Date.parse(entry.timestamp || '');
          maxCatOutboxMs = Math.max(maxCatOutboxMs, Number.isFinite(tsMs) ? tsMs : 0);
        }

        const persistedUpdatedAtIso = new Date(
          Math.max(
            txWallMs,
            Number.isFinite(existingMetaUpdatedAtMs) ? existingMetaUpdatedAtMs : 0,
            maxCatOutboxMs
          )
        ).toISOString();

        metaStore.put({
          key: 'custom_categories',
          value: updatedCustom,
          updatedAt: persistedUpdatedAtIso
        });

        const { targetEntry: categoryOutboxEntry } = resolveCategoryOutboxWrite({
          existingEntries: existingOutboxEntries,
          updatedCustom,
          knownBranchId,
          knownActorUid,
          nowIso: txWallIso,
          incomingFreshnessMs: txWallMs
        });
        outboxStore.put(categoryOutboxEntry);
      } catch (err) {
        failTx(err, 'فشل حفظ التصنيف داخل المعاملة');
      }
    };

    const metaReq = metaStore.get('custom_categories');
    metaReq.onsuccess = () => {
      inTxMetaRecord = metaReq.result as { key: string; value?: unknown; updatedAt?: string } | undefined;
      metaLoaded = true;
      tryFinalize();
    };
    metaReq.onerror = () => failTx(metaReq.error, 'تعذر قراءة التصنيفات داخل المعاملة');

    const medAllReq = medStore.getAll();
    medAllReq.onsuccess = () => {
      inTxMeds = (medAllReq.result as Medicine[]) || [];
      medsLoaded = true;
      tryFinalize();
    };
    medAllReq.onerror = () => failTx(medAllReq.error, 'تعذر قراءة تصنيفات الأدوية داخل المعاملة');

    const outboxAllReq = outboxStore.getAll();
    outboxAllReq.onsuccess = () => {
      existingOutboxEntries = (outboxAllReq.result as OutboxEntry[]) || [];
      outboxLoaded = true;
      tryFinalize();
    };
    outboxAllReq.onerror = () => failTx(outboxAllReq.error, 'تعذر قراءة طابور Outbox داخل المعاملة');

    tx.oncomplete = () => {
      if (resolvedCategoryList) {
        resolve(resolvedCategoryList);
      } else {
        reject(abortReason || new Error('فشل حفظ التصنيف'));
      }
    };
    tx.onerror = () => reject(abortReason || tx.error || new Error('فشل حفظ التصنيف'));
    tx.onabort = () => reject(abortReason || tx.error || new Error('أُلغيت معاملة حفظ التصنيف'));
  });
}

/**
 * Batch Capture 2.0 Session Persistence (Zero DB_VERSION Upgrade)
 * Stored strictly in the active branch's existing 'metadata' object store
 * under 'batch_capture_session_v2' for full reload & offline recovery.
 */
export const BATCH_CAPTURE_SESSION_METADATA_KEY = 'batch_capture_session_v2';

export interface PersistedBatchCaptureSessionRecord {
  version: 2;
  sessionId: string;
  mode: 'SEQUENTIAL' | 'UNIFIED_IMAGE';
  branchId: string;
  sequenceCounter: number;
  createdAt: string;
  updatedAt: string;
  originalImages?: Array<{
    id: string;
    dataUrl: string;
    width: number;
    height: number;
    capturedAt: string;
  }>;
  items: any[];
}

export async function saveBatchCaptureSessionState(
  session: PersistedBatchCaptureSessionRecord
): Promise<boolean> {
  if (!session || !session.sessionId) return false;
  try {
    const db = await openPharmacyDB();
    const activeBranch = getActiveBranchId() || 'default';
    const sanitized: PersistedBatchCaptureSessionRecord = {
      ...session,
      branchId: session.branchId || activeBranch,
      updatedAt: new Date().toISOString()
    };
    const serialized = JSON.parse(JSON.stringify(sanitized));
    return await new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction('metadata', 'readwrite');
        tx.objectStore('metadata').put({
          key: BATCH_CAPTURE_SESSION_METADATA_KEY,
          value: serialized,
          updatedAt: sanitized.updatedAt
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  } catch {
    return false;
  }
}

export async function loadBatchCaptureSessionState(): Promise<PersistedBatchCaptureSessionRecord | null> {
  try {
    const db = await openPharmacyDB();
    const activeBranch = getActiveBranchId() || 'default';
    return await new Promise<PersistedBatchCaptureSessionRecord | null>((resolve) => {
      try {
        const tx = db.transaction('metadata', 'readonly');
        const req = tx.objectStore('metadata').get(BATCH_CAPTURE_SESSION_METADATA_KEY);
        req.onsuccess = () => {
          const val = req.result?.value as PersistedBatchCaptureSessionRecord | undefined;
          if (!val || typeof val !== 'object' || !val.sessionId || !Array.isArray(val.items)) {
            resolve(null);
            return;
          }
          // Enforce strict branch isolation on recovery
          if (val.branchId && val.branchId !== activeBranch) {
            resolve(null);
            return;
          }
          resolve(val);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

export async function clearBatchCaptureSessionState(): Promise<boolean> {
  try {
    const db = await openPharmacyDB();
    return await new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction('metadata', 'readwrite');
        tx.objectStore('metadata').delete(BATCH_CAPTURE_SESSION_METADATA_KEY);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  } catch {
    return false;
  }
}

