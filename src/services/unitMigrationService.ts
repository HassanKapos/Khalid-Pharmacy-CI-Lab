/**
 * PR-2B Universal Unit Migration & Legacy Data Quarantine Service
 *
 * Resumable, bounded-batch, idempotent, non-destructive local IndexedDB migration engine
 * built strictly atop PR-1 (`universalUnitPolicy.ts`) and PR-2A-R2 (`unitSerialization.ts`).
 *
 * Guarantees:
 * - Zero mutations to historical financial stores (`inventory_ledger`, `sales`, `purchase_invoices`,
 *   `supplier_transactions`, `suppliers`, `outbox`) or medicine prices/stock/barcodes.
 * - Zero cloud calls, zero Outbox V2 enqueueing/activation, zero `DB_VERSION` changes.
 * - Zero automatic `VERIFIED` operational promotion (even when DTOs claim `VERIFIED`).
 * - Zero silent dosageForm guessing from name, zero `1x1` -> Tablet conversion, zero `2x10` defaults.
 * - Preserves `QUARANTINED` strictly across all paths, including corrupted/poisoned records.
 * - Archives every duplicate/conflicting legacy stocktaking item into bounded chunks (<= 20/chunk)
 *   with read-back verification before cursor advancement; puts conflicted open sessions into
 *   `'reviewing'` (`unitMigrationReviewRequired: true`) while keeping historical sessions untouched.
 * - Executes strictly synchronous work inside IDB transactions; never blocks POS.
 */

import {
  assertLocalFirstMutationMutexLeaseCurrent,
  getActiveBranchId,
  getActiveDbName,
  getBranchDbName,
  getIDBFactory,
  getKnownActiveActorId,
  getTrustedActorSessionState,
  isTrustedAuthAuthorityEnforced,
  isTrustedSessionExpired,
  isValidFirebaseActorUid,
  openPharmacyDB,
  withLocalFirstMutationMutex,
  sha256HexSync,
  type Medicine,
  type TrustedActorSessionState,
} from './pharmacyDb.ts';
import {
  getMedicineUnitSellingPrice,
  isMedicineUnitSellable,
  validateMedicineUnitConfiguration,
  type MedicineUnitKind,
  type MedicineUnitPriceSource,
} from './medicineUnitPolicy.ts';
import { evaluatePackingLockSnapshot } from './packingLockCoordinator.ts';
import {
  createValidatedUnitDefinition,
  type BaseUnitKind,
  type SupportedUnitKind,
  type UnitConfigurationStatus,
  type UnitDefinition,
} from './universalUnitPolicy.ts';
import {
  rehydrateLegacyOrV2MedicineConfig,
  rehydrateUnitDefinitionFromDto,
  serializeUnitDefinitionToDto,
  type KnownDosageFormKind,
  type SerializedUnitDefinitionDTOV2,
} from './unitSerialization.ts';
import type {
  V1InFlightEnumerationResult,
  V1InFlightLeaseRecord,
} from './branchSyncService.ts';

export const UNIT_MIGRATION_SCHEMA_VERSION = 2 as const;
export const MAX_UNIT_MIGRATION_BATCH_SIZE = 25 as const;
export const STOCKTAKING_ARCHIVE_CHUNK_SIZE = 20 as const;
export const STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE = 20 as const;
export const STOCKTAKING_ARCHIVE_WRITE_BATCH_SIZE = 20 as const;

export const REQUIRED_EVIDENCE_STORES = Object.freeze([
  'medicines',
  'metadata',
  'inventory_ledger',
  'sales',
  'purchase_invoices',
  'outbox',
  'stocktaking_sessions',
  'stocktaking_items',
] as const);

export const OPTIONAL_EVIDENCE_STORES = Object.freeze([
  'supplier_invoice_drafts',
] as const);

export const AUTHORIZED_MIGRATION_WRITE_FIELDS = Object.freeze([
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
] as const);

const AUTHORIZED_MIGRATION_FIELD_SET = new Set<string>(AUTHORIZED_MIGRATION_WRITE_FIELDS);

export const UNIT_MIGRATION_CHECKPOINT_KEY = 'unit_migration_v2:checkpoint';
export const UNIT_MIGRATION_BASELINE_DIGEST_KEY = 'unit_migration_v2:baseline_digest';
export const UNIT_MIGRATION_QUARANTINE_PREFIX = 'unit_migration_v2:quarantine:';
export const UNIT_MIGRATION_RECOVERY_AUDIT_PREFIX = 'unit_migration_v2:recovery_audit:';
export const UNIT_MIGRATION_MEDICINE_FINGERPRINT_PREFIX = 'unit_migration_v2:medicine_fingerprint:';
export const UNIT_MIGRATION_STOCKTAKING_ARCHIVE_INDEX_PREFIX =
  'unit_migration_v2:stocktaking_archive_index:';
export const UNIT_MIGRATION_STOCKTAKING_ARCHIVE_PAGE_PREFIX =
  'unit_migration_v2:stocktaking_archive_page:';
export const UNIT_MIGRATION_STOCKTAKING_ARCHIVE_CHUNK_PREFIX =
  'unit_migration_v2:stocktaking_archive_chunk:';
export const UNIT_MIGRATION_STOCKTAKING_REVIEW_PREFIX = 'unit_migration_v2:stocktaking_review:';
export const UNIT_MIGRATION_LEGACY_ARCHIVE_QUARANTINE_PREFIX =
  'unit_migration_v2:legacy_archive_quarantine:';
export const V1_CLOUD_SYNC_RETRY_QUEUE_PREFIX = 'khalid_cloud_sync_retry_queue_v1';
export const V1_IN_FLIGHT_LEASE_STORAGE_PREFIX = 'khalid_v1_inflight_lease_v1:';
export const V1_IN_FLIGHT_LEASE_IDB_PREFIX = 'v1_inflight_lease_v1:';

export type MigrationRunStatus = 'IDLE' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'FAILED';
export type MigrationPhase =
  | 'NOT_STARTED'
  | 'BASELINE_AUDIT'
  | 'MEDICINES_BATCH'
  | 'STOCKTAKING_BATCH'
  | 'FINAL_VERIFY'
  | 'DONE';

export type MedicineMigrationClassification = 'MIGRATED_CONSERVATIVE' | 'QUARANTINED' | 'CONFLICTED';

export type PackingLockEvidenceStatus =
  | 'LOCKED_WITH_EVIDENCE'
  | 'SAFE_NO_EVIDENCE'
  | 'UNKNOWN_FAIL_CLOSED';

export type PackingLockEvidenceSource =
  | 'INVENTORY_LEDGER'
  | 'NONZERO_STOCK_BALANCE'
  | 'SALES'
  | 'PURCHASE_INVOICES'
  | 'EXISTING_PACKING_LOCK'
  | 'OUTBOX_V2_NON_SYNCED'
  | 'V1_LOCALSTORAGE_RETRY_QUEUE'
  | 'V1_IN_FLIGHT_OPERATION'
  | 'QUARANTINE_OR_RECONCILIATION_STATE'
  | 'OPEN_STOCKTAKING'
  | 'UNPOSTED_OCR_DRAFT'
  | 'UNRESOLVED_BACKUP_REVIEW';

export interface PackingLockEvidenceReport {
  readonly medicineId: string;
  readonly status: PackingLockEvidenceStatus;
  readonly effectivePackingLocked: boolean;
  readonly matchedSources: ReadonlyArray<PackingLockEvidenceSource>;
  readonly reasons: ReadonlyArray<string>;
  readonly unknownFailureReasons: ReadonlyArray<string>;
  readonly v1InFlightScope: 'KNOWN_CONTEXT_AND_EXPLICIT' | 'UNINSPECTABLE_FAIL_CLOSED';
}

export interface InspectPackingLockOptions {
  readonly db?: IDBDatabase;
  readonly medicineRecordOverride?: unknown;
  readonly v1InFlightMedicineIds?: ReadonlyArray<string>;
  readonly v1InFlightInspector?: () => ReadonlyArray<string>;
  readonly v1InFlightEnumerator?: (() => V1InFlightEnumerationResult) | null;
  readonly v1InFlightAvailable?: boolean;
  readonly v1InFlightNowMs?: number;
  readonly v1ContextHints?: ReadonlyArray<{ readonly uid: string; readonly branchId: string }>;
  readonly excludeQuarantineSelfLockForRecovery?: boolean;
}

export interface UnitMigrationCheckpoint {
  readonly key: typeof UNIT_MIGRATION_CHECKPOINT_KEY;
  readonly schemaVersion: typeof UNIT_MIGRATION_SCHEMA_VERSION;
  readonly migrationRunId: string;
  readonly status: MigrationRunStatus;
  readonly phase: MigrationPhase;
  readonly batchSize: number;
  readonly totalMedicines: number;
  readonly processedMedicines: number;
  readonly migratedCount: number;
  readonly quarantinedCount: number;
  readonly conflictedCount: number;
  readonly skippedAlreadyValidCount: number;
  readonly legacyStocktakingSessionsInspected: number;
  readonly legacyStocktakingArchivedConflicts: number;
  readonly legacyStocktakingSessionsFlaggedReview: number;
  readonly lastMedicineCursorId: string | null;
  readonly lastStocktakingSessionCursorId: string | null;
  readonly batchNumber: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly pausedAt?: string;
  readonly completedAt?: string;
  readonly pauseRequested: boolean;
  readonly baselineDigestKey: string;
  readonly finalVerified: boolean;
  readonly lastError?: string;
  readonly operationalTrustIndependentFromMigrationCompletion: true;
  readonly verifiedMedicinesCount: 0;
  readonly allMedicinesReadyForSale: false;
  readonly executionLeaseId?: string;
  readonly executionLeaseAcquiredAtMs?: number;
  readonly executionLeaseHeartbeatAtMs?: number;
  readonly executionLeaseReleased?: boolean;
}

export interface OutboxBaselineSnapshotEntry {
  readonly id: string;
  readonly operationId: string | null;
  readonly entityType: string;
  readonly entityId: string;
  readonly status: string;
  readonly leaseOwner: string | null;
  readonly timestamp: string;
  readonly digest: string;
}

export interface FinancialBaselineDigestRecord {
  readonly key: typeof UNIT_MIGRATION_BASELINE_DIGEST_KEY;
  readonly schemaVersion: typeof UNIT_MIGRATION_SCHEMA_VERSION;
  readonly migrationRunId: string;
  readonly capturedAt: string;
  readonly counts: {
    readonly inventoryLedger: number;
    readonly sales: number;
    readonly purchaseInvoices: number;
    readonly supplierTransactions: number;
    readonly suppliers: number;
    readonly outbox: number;
    readonly medicines: number;
    readonly historicalStocktakingSessions: number;
  };
  readonly digests: {
    readonly inventoryLedger: string;
    readonly sales: string;
    readonly purchaseInvoices: string;
    readonly supplierTransactions: string;
    readonly suppliers: string;
    readonly outbox: string;
    readonly nonMedicineOutbox?: string;
    readonly medicineFinancials: string;
    readonly medicineStock: string;
    readonly historicalStocktaking: string;
  };
  readonly medicineFinancialHashesById?: Record<string, string>;
  readonly medicineStockHashesById?: Record<string, string>;
  readonly outboxBaselineSnapshots?: Record<string, OutboxBaselineSnapshotEntry>;
}

export interface MedicineQuarantineRecord {
  readonly key: string;
  readonly schemaVersion: typeof UNIT_MIGRATION_SCHEMA_VERSION;
  readonly medicineId: string;
  readonly classification: 'QUARANTINED' | 'CONFLICTED';
  readonly preservedConfigStatus: UnitConfigurationStatus;
  readonly claimedConfigStatus?: UnitConfigurationStatus;
  readonly reasonCode: string;
  readonly message: string;
  readonly firstQuarantinedAt: string;
  readonly lastSeenAt: string;
  readonly migrationRunId: string;
  readonly lastSeenRunId: string;
  readonly operationalAllowed: false;
  readonly packingLocked: boolean;
  readonly preQuarantinePackingLocked?: boolean;
  readonly reviewStatus: 'PENDING_PHARMACIST_REVIEW' | 'RESOLVED';
  readonly resolvedAt?: string;
  readonly resolvedByUid?: string;
  readonly resolutionReason?: string;
  readonly rawSnapshot: unknown;
}

export interface StocktakingConflictArchiveEntry {
  readonly conflictId: string;
  readonly sessionId: string;
  readonly sourceStore: 'stocktaking_sessions.items' | 'stocktaking_items';
  readonly conflictType:
    | 'DUPLICATE_INLINE_MEDICINE'
    | 'DUPLICATE_SUBCOLLECTION_MEDICINE'
    | 'INLINE_SUBCOLLECTION_CONFLICT'
    | 'MALFORMED_ITEM'
    | 'QUARANTINED_MEDICINE_REFERENCE'
    | 'CONFLICTED_MEDICINE_REFERENCE';
  readonly medicineId: string;
  readonly sourceIndex?: number;
  readonly sourceRecordId?: string;
  readonly detectedAt: string;
  readonly migrationRunId: string;
  readonly rawVersion: unknown;
}

export interface StocktakingConflictArchiveChunk {
  readonly key: string;
  readonly schemaVersion: typeof UNIT_MIGRATION_SCHEMA_VERSION;
  readonly nodeKind?: 'ARCHIVE_CHUNK';
  readonly sessionId: string;
  readonly chunkIndex: number;
  readonly chunkDigest: string;
  readonly entries: ReadonlyArray<StocktakingConflictArchiveEntry>;
}

export interface StocktakingConflictArchiveLeafRef {
  readonly chunkKey: string;
  readonly chunkIndex: number;
  readonly entryCount: number;
  readonly firstConflictId: string;
  readonly lastConflictId: string;
  readonly chunkDigest: string;
}

export interface StocktakingConflictArchiveInternalRef {
  readonly pageKey: string;
  readonly level: number;
  readonly pageIndex: number;
  readonly pageDigest: string;
  readonly subtreeChunkCount: number;
  readonly subtreeEntryCount: number;
}

export interface StocktakingConflictArchiveIndexPage {
  readonly key: string;
  readonly schemaVersion: typeof UNIT_MIGRATION_SCHEMA_VERSION;
  readonly nodeKind?: 'ARCHIVE_INDEX_PAGE';
  readonly sessionId: string;
  readonly nodeType: 'LEAF' | 'INTERNAL';
  readonly level: number;
  readonly pageIndex: number;
  readonly maxRefs: typeof STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE;
  readonly refs: ReadonlyArray<
    StocktakingConflictArchiveLeafRef | StocktakingConflictArchiveInternalRef
  >;
  readonly pageDigest: string;
}

export interface StocktakingConflictArchiveIndex {
  readonly key: string;
  readonly schemaVersion: typeof UNIT_MIGRATION_SCHEMA_VERSION;
  readonly archiveFormat: 'BOUNDED_TREE_V2';
  readonly sessionId: string;
  readonly sessionKeyHash: string;
  readonly totalEntries: number;
  readonly chunkCount: number;
  readonly chunkSizeLimit: typeof STOCKTAKING_ARCHIVE_CHUNK_SIZE;
  readonly indexPageSizeLimit: typeof STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE;
  readonly indexPageCount: number;
  readonly treeHeight: number;
  readonly rootPageKey: string | null;
  readonly rootPageDigest: string | null;
  readonly archiveDigest: string;
  readonly archivedAt: string;
  readonly migrationRunId: string;
  readonly verifiedReadBack: boolean;
  readonly legacyArchiveQuarantineKey?: string | null;
}

export interface LegacyArchiveQuarantineRecord {
  readonly key: string;
  readonly schemaVersion: typeof UNIT_MIGRATION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly detectedFormat: string;
  readonly quarantinedAt: string;
  readonly migrationRunId: string;
  readonly legacyChunkCount: number;
  readonly legacySnapshot: unknown;
}

export interface StocktakingSessionReviewMetadata {
  readonly key: string;
  readonly schemaVersion: typeof UNIT_MIGRATION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly sessionStatusAtInspection: string;
  readonly isHistoricalImmutableSession: boolean;
  readonly reviewRequired: boolean;
  readonly reasonCodes: ReadonlyArray<string>;
  readonly conflictCount: number;
  readonly archiveIndexKey: string | null;
  readonly inspectedAt: string;
  readonly migrationRunId: string;
}

export interface UnitMigrationStatusReport {
  readonly schemaVersion: typeof UNIT_MIGRATION_SCHEMA_VERSION;
  readonly migrationRunId: string | null;
  readonly status: MigrationRunStatus;
  readonly phase: MigrationPhase;
  readonly batchSize: number;
  readonly counts: {
    readonly totalMedicines: number;
    readonly processedMedicines: number;
    readonly migratedCount: number;
    readonly quarantinedCount: number;
    readonly conflictedCount: number;
    readonly skippedAlreadyValidCount: number;
    readonly pendingMedicines: number;
    readonly legacyStocktakingSessionsInspected: number;
    readonly legacyStocktakingArchivedConflicts: number;
    readonly legacyStocktakingSessionsFlaggedReview: number;
  };
  readonly baselineVerified: boolean;
  readonly finalVerified: boolean;
  readonly quarantineSampleKeys: ReadonlyArray<string>;
  readonly trustSummary: {
    readonly operationalTrustIndependentFromMigrationCompletion: true;
    readonly verifiedMedicinesCount: 0;
    readonly allMedicinesReadyForSale: false;
    readonly migrationGrantsOperationalVerification: false;
  };
  readonly checkpoint: UnitMigrationCheckpoint | null;
}

export interface StartMigrationOptions {
  readonly db?: IDBDatabase;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly pauseAfterBatch?: number;
  readonly allowConcurrentPosWrites?: boolean;
  /** Allows Medicine financial fields modified concurrently by authorized ops during migration. Default false (fail-closed tampering guard). */
  readonly allowConcurrentMedicineEdits?: boolean;
  /** Strategy when a Medicine record or its lock evidence changed between pre-read and atomic tx commit. Default 'RECLASSIFY_IN_TX'. */
  readonly staleBatchPolicy?: 'RECLASSIFY_IN_TX' | 'ABORT';
  /** Optional active in-memory V1 in-flight medicine IDs supplied by caller alongside read-only localStorage inspection. */
  readonly v1InFlightMedicineIds?: ReadonlyArray<string>;
  /** Optional inspector for V1 in-flight medicine IDs (fail-closed if throws). */
  readonly v1InFlightInspector?: () => ReadonlyArray<string>;
  /** Optional enumerator for V1 in-flight operations. */
  readonly v1InFlightEnumerator?: (() => V1InFlightEnumerationResult) | null;
  /** Explicit flag marking V1 in-flight inspection unavailable (triggers UNKNOWN_FAIL_CLOSED). */
  readonly v1InFlightAvailable?: boolean;
  /** Optional deterministic timestamp (ms) for evaluating V1 in-flight lease expiry. */
  readonly v1InFlightNowMs?: number;
  /** Optional `(uid, branchId)` hints for querying `isV1EntitySyncInFlight`. */
  readonly v1ContextHints?: ReadonlyArray<{ readonly uid: string; readonly branchId: string }>;
  /** Optional hook invoked after pre-read and BEFORE opening the atomic readwrite batch tx (simulates TOCTOU concurrent writes cleanly). */
  readonly onBeforeBatchTxOpen?: (context: {
    phase: 'MEDICINES_BATCH' | 'STOCKTAKING_BATCH';
    batchNumber: number;
    itemIds: ReadonlyArray<string>;
  }) => Promise<void> | void;
  /** Optional hook invoked right AFTER bounded stocktaking chunks commit and BEFORE index pages/manifest commit. */
  readonly onAfterStocktakingChunksCommitted?: (context: {
    sessionId: string;
    committedChunks: number;
    totalChunks: number;
  }) => Promise<void> | void;
  /** Test hook invoked after independent archive readback and immediately before the atomic final publication transaction. */
  readonly onAfterStocktakingArchiveReadBack?: (context: {
    sessionId: string;
    archiveIndexKey: string;
    archiveChunkRefs: ReadonlyArray<string>;
    pageKeys: ReadonlyArray<string>;
  }) => Promise<void> | void;
  /** Internal test hook invoked INSIDE a readwrite batch transaction before commit. */
  readonly onInsideBatchTxBeforeCommit?: (context: {
    tx: IDBTransaction;
    phase: 'MEDICINES_BATCH' | 'STOCKTAKING_BATCH';
    batchNumber: number;
    itemIds: ReadonlyArray<string>;
  }) => void;
  /** Optional test hook invoked BEFORE BASELINE_AUDIT -> MEDICINES_BATCH transition. */
  readonly onBeforeBaselinePhaseTransition?: (context: {
    migrationRunId: string;
    executionLeaseId: string;
  }) => Promise<void> | void;
  /** Optional test hook invoked INSIDE phase transition tx before commit. */
  readonly onInsidePhaseTransitionTxBeforeCommit?: (context: {
    tx: IDBTransaction;
    fromPhase: MigrationPhase;
    targetPhase: MigrationPhase;
  }) => void;
  /** Optional hook invoked BETWEEN committed batches (never inside IDB tx). */
  readonly onAfterBatchCommitted?: (checkpoint: UnitMigrationCheckpoint) => Promise<void> | void;
}

export interface MedicineClassificationOutcome {
  readonly classification: MedicineMigrationClassification;
  readonly medicineId: string;
  readonly configStatus: UnitConfigurationStatus;
  readonly claimedConfigStatus?: UnitConfigurationStatus;
  readonly unitDefinitionDto?: SerializedUnitDefinitionDTOV2;
  readonly unitDefinitionKey?: string;
  readonly baseDimensionKey?: string;
  readonly dosageForm?: KnownDosageFormKind;
  readonly baseUnitsPerPack?: number;
  readonly packingLocked?: boolean;
  readonly packingLockStatus?: PackingLockEvidenceStatus;
  readonly quarantinePreserved: boolean;
  readonly reasonCode: string;
  readonly message: string;
  readonly alreadyMigratedUnchanged: boolean;
  readonly updatedMedicineRecord: Medicine | null;
  readonly quarantineRecord: MedicineQuarantineRecord | null;
}

const KNOWN_BASE_UNIT_BY_FORM: Record<KnownDosageFormKind, BaseUnitKind> = {
  Tablet: 'pill',
  Capsule: 'capsule',
  Syrup: 'bottle',
  Suspension: 'bottle',
  Drops: 'bottle',
  InjectionVial: 'vial',
  Ampoule: 'ampoule',
  Cream: 'tube',
  Ointment: 'tube',
  Gel: 'tube',
  Inhaler: 'inhaler',
  Suppository: 'suppository',
  Sachet: 'sachet',
};

const HISTORICAL_STOCKTAKING_STATUSES = new Set<string>([
  'committed',
  'COMMITTED',
  'cancelled',
  'CANCELLED',
  'syncing_adjustments',
  'sync_completed_unverified',
]);

const OPEN_STOCKTAKING_STATUSES = new Set<string>([
  'in_progress',
  'IN_PROGRESS',
  'active',
  'reviewing',
]);

const UNIT_MIGRATION_EXECUTION_WEB_LOCK = 'khalid-pharmacy-unit-migration-execution-v2';
const EXECUTION_LEASE_TTL_MS = 30_000;
const EXECUTION_LEASE_HEARTBEAT_INTERVAL_MS = 10_000;

const MIGRATION_PHASE_ORDER: Readonly<Record<MigrationPhase, number>> = {
  NOT_STARTED: 0,
  BASELINE_AUDIT: 1,
  MEDICINES_BATCH: 2,
  STOCKTAKING_BATCH: 3,
  FINAL_VERIFY: 4,
  DONE: 5,
};

let pauseRequestedFlag = false;
let activeMigrationPromise: Promise<UnitMigrationCheckpoint> | null = null;
let fallbackLeaseSequence = 0;

function clampBatchSize(requested?: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return MAX_UNIT_MIGRATION_BATCH_SIZE;
  }
  const intVal = Math.floor(requested);
  if (intVal < 1) return 1;
  if (intVal > MAX_UNIT_MIGRATION_BATCH_SIZE) return MAX_UNIT_MIGRATION_BATCH_SIZE;
  return intVal;
}

function generateMigrationRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `umig-${ts}-${rand}`;
}

export function generateExecutionLeaseId(): string {
  const cryptoApi =
    typeof globalThis !== 'undefined' && globalThis.crypto ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `umlease-${cryptoApi.randomUUID()}`;
  }
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `umlease-${Date.now().toString(36)}-${hex}`;
  }
  fallbackLeaseSequence = (fallbackLeaseSequence + 1) % 1_000_000;
  const ts = Date.now().toString(36);
  const perf =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? Math.floor(performance.now() * 1000).toString(36)
      : '0';
  const seq = fallbackLeaseSequence.toString(36);
  const randA = Math.random().toString(36).slice(2, 10);
  const randB = Math.random().toString(36).slice(2, 10);
  return `umlease-fb-${ts}-${perf}-${seq}-${randA}${randB}`;
}

function isExecutionLeaseActivelyHeld(
  cp: UnitMigrationCheckpoint | null | undefined,
  nowMs = Date.now()
): boolean {
  if (!cp || cp.status !== 'IN_PROGRESS' || cp.phase === 'DONE') {
    return false;
  }
  if (cp.executionLeaseReleased === true) {
    return false;
  }
  if (typeof cp.executionLeaseId === 'string' && cp.executionLeaseId.trim().length > 0) {
    const refMs = cp.executionLeaseHeartbeatAtMs ?? cp.executionLeaseAcquiredAtMs;
    if (typeof refMs === 'number' && Number.isFinite(refMs)) {
      return nowMs - refMs < EXECUTION_LEASE_TTL_MS;
    }
    return true;
  }
  const updatedMs = typeof cp.updatedAt === 'string' ? Date.parse(cp.updatedAt) : NaN;
  if (Number.isFinite(updatedMs)) {
    return nowMs - updatedMs < EXECUTION_LEASE_TTL_MS;
  }
  return false;
}

/**
 * Safely reads own DATA properties using Object.getOwnPropertyDescriptor without
 * invoking getters/setters or walking custom prototypes.
 */
function sanitizeForPlainJson(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') {
    if (!Number.isFinite(value)) return `[NON_FINITE_NUMBER:${String(value)}]`;
    return value;
  }
  if (t === 'bigint') return `[BIGINT:${value.toString()}]`;
  if (t === 'symbol') return `[SYMBOL:${String(value)}]`;
  if (t === 'function') return '[FUNCTION_OMITTED]';

  if (depth >= 8) {
    return '[MAX_DEPTH_TRUNCATED]';
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const maxLen = Math.min(value.length, 100000);
    for (let i = 0; i < maxLen; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(value, i);
      if (!desc) {
        out.push(null);
      } else if (!('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
        out.push({ __accessorRejected: true });
      } else {
        out.push(sanitizeForPlainJson(desc.value, depth + 1));
      }
    }
    if (value.length > maxLen) {
      out.push(`[TRUNCATED_${value.length - maxLen}_ITEMS]`);
    }
    return out;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : '[INVALID_DATE]';
  }

  const obj = value as object;
  const proto = Object.getPrototypeOf(obj);
  const out: Record<string, unknown> = {};
  if (proto !== Object.prototype && proto !== null) {
    out.__customPrototypeRejected = true;
  }
  const ownSymbols = Object.getOwnPropertySymbols(obj);
  if (ownSymbols.length > 0) {
    out.__symbolKeysRejectedCount = ownSymbols.length;
  }

  for (const key of Object.getOwnPropertyNames(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc) continue;
    if (!('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
      out[key] = { __accessorRejected: true };
    } else {
      out[key] = sanitizeForPlainJson(desc.value, depth + 1);
    }
  }
  return out;
}

function getSafeOwnDataProp(candidate: unknown, key: string): { found: boolean; value: unknown } {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { found: false, value: undefined };
  }
  try {
    const desc = Object.getOwnPropertyDescriptor(candidate, key);
    if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
      return { found: false, value: undefined };
    }
    return { found: true, value: desc.value };
  } catch {
    return { found: false, value: undefined };
  }
}

function canonicalStableJson(value: unknown): string {
  const normalized = sanitizeForPlainJson(value);
  const sortRecursive = (node: unknown): unknown => {
    if (node === null || node === undefined || typeof node !== 'object') {
      return node;
    }
    if (Array.isArray(node)) {
      return node.map(sortRecursive);
    }
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(node as Record<string, unknown>).sort()) {
      const v = (node as Record<string, unknown>)[k];
      if (v !== undefined) {
        sorted[k] = sortRecursive(v);
      }
    }
    return sorted;
  };
  return JSON.stringify(sortRecursive(normalized));
}

function computeCanonicalRecordsDigest(
  records: ReadonlyArray<unknown>,
  idSelector: (rec: unknown, index: number) => string
): string {
  const entries = records.map((rec, idx) => ({
    sortKey: idSelector(rec, idx),
    payload: canonicalStableJson(rec),
  }));
  entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.payload < b.payload ? -1 : a.payload > b.payload ? 1 : 0));
  return sha256HexSync(JSON.stringify(entries));
}

function projectSingleMedicineFinancials(raw: unknown, idx = 0): Record<string, unknown> {
  const safe = sanitizeForPlainJson(raw) as Record<string, unknown>;
  const id = typeof safe?.id === 'string' ? safe.id : `idx-${idx}`;
  return {
    id,
    barcode: safe?.barcode ?? null,
    name: safe?.name ?? null,
    category: safe?.category ?? null,
    minStock: safe?.minStock ?? null,
    buyPrice: safe?.buyPrice ?? null,
    sellPrice: safe?.sellPrice ?? null,
    sellPriceStrip: safe?.sellPriceStrip ?? null,
    sellPricePill: safe?.sellPricePill ?? null,
    sellPack: safe?.sellPack ?? null,
    sellStrip: safe?.sellStrip ?? null,
    sellPill: safe?.sellPill ?? null,
    expiry: safe?.expiry ?? null,
    unitType: safe?.unitType ?? null,
    stripsPerPack: safe?.stripsPerPack ?? null,
    pillsPerStrip: safe?.pillsPerStrip ?? null,
    batchNumber: safe?.batchNumber ?? null,
    createdAt: safe?.createdAt ?? null,
    secondaryBarcodes: safe?.secondaryBarcodes ?? null,
    archived: safe?.archived ?? null,
    archivedAt: safe?.archivedAt ?? null,
    archivedByUid: safe?.archivedByUid ?? null,
  };
}

function computeSingleMedicineFinancialHash(raw: unknown, idx = 0): string {
  return sha256HexSync(canonicalStableJson(projectSingleMedicineFinancials(raw, idx)));
}

function computeMedicineUnitStockFingerprint(raw: unknown): string {
  const fields = [
    'dosageForm',
    'stripsPerPack',
    'pillsPerStrip',
    'baseUnitsPerPack',
    'unitType',
    'sellPack',
    'sellStrip',
    'sellPill',
    'configStatus',
    'unitDefinition',
    'unitDefinitionKey',
    'baseDimensionKey',
    'packingLocked',
    'unitMigrationStatus',
    'unitMigrationRunId',
    'unitMigratedAt',
    'unitOperationalAllowed',
    'stock',
    'currentStock',
    'initialStock',
    'quantity',
    'totalBasePills',
    'baseStock',
    'batches',
    'openingStockEvidence',
  ];
  const projection: Record<string, unknown> = {};
  const id = getSafeOwnDataProp(raw, 'id');
  projection.id = id.found ? id.value : { __type: 'missing' };
  for (const field of fields) {
    const prop = getSafeOwnDataProp(raw, field);
    projection[field] = {
      found: prop.found,
      value: prop.value === undefined ? { __type: 'undefined' } : sanitizeForPlainJson(prop.value),
    };
  }
  return sha256HexSync(canonicalStableJson(projection));
}

function computeMedicineUnitIdentityFingerprint(raw: unknown): string {
  const fields = [
    'dosageForm',
    'stripsPerPack',
    'pillsPerStrip',
    'baseUnitsPerPack',
    'unitType',
    'sellPack',
    'sellStrip',
    'sellPill',
    'configStatus',
    'unitDefinition',
    'unitDefinitionKey',
    'baseDimensionKey',
    'packingLocked',
    'unitMigrationStatus',
    'unitMigrationRunId',
    'unitMigratedAt',
    'unitOperationalAllowed',
  ];
  const projection: Record<string, unknown> = {};
  const id = getSafeOwnDataProp(raw, 'id');
  projection.id = id.found ? id.value : { __type: 'missing' };
  for (const field of fields) {
    const prop = getSafeOwnDataProp(raw, field);
    projection[field] = {
      found: prop.found,
      value: prop.value === undefined ? { __type: 'undefined' } : sanitizeForPlainJson(prop.value),
    };
  }
  return sha256HexSync(canonicalStableJson(projection));
}

function extractLedgerIdsForMedicine(ledger: ReadonlyArray<unknown>, medicineId: string): string[] {
  const ids: string[] = [];
  for (let i = 0; i < ledger.length; i += 1) {
    const row = ledger[i];
    const medProp = getSafeOwnDataProp(row, 'medicineId');
    if (!medProp.found || typeof medProp.value !== 'string' || medProp.value.trim() !== medicineId) {
      continue;
    }
    const idProp = getSafeOwnDataProp(row, 'id');
    if (idProp.found && typeof idProp.value === 'string' && idProp.value.trim()) {
      ids.push(idProp.value.trim());
    }
  }
  return Array.from(new Set(ids)).sort();
}

function computeBatchesTotalBaseUnits(
  batches: unknown,
  baseUnitsPerPack: number
): { valid: boolean; present: boolean; totalBaseUnits: number } {
  if (batches === undefined || batches === null) {
    return { valid: true, present: false, totalBaseUnits: 0 };
  }
  if (!Array.isArray(batches)) {
    return { valid: false, present: true, totalBaseUnits: 0 };
  }
  let total = 0;
  for (const rawBatch of batches) {
    if (!rawBatch || typeof rawBatch !== 'object' || Array.isArray(rawBatch)) {
      return { valid: false, present: true, totalBaseUnits: 0 };
    }
    const totalPillsProp = getSafeOwnDataProp(rawBatch, 'totalPills');
    const baseUnitsProp = getSafeOwnDataProp(rawBatch, 'baseUnits');
    const qtyProp = getSafeOwnDataProp(rawBatch, 'quantity');
    const stockProp = getSafeOwnDataProp(rawBatch, 'stock');
    for (const numProp of [totalPillsProp, baseUnitsProp, qtyProp, stockProp]) {
      if (numProp.found && numProp.value !== undefined && numProp.value !== null) {
        if (typeof numProp.value !== 'number' || !Number.isFinite(numProp.value) || numProp.value < 0) {
          return { valid: false, present: true, totalBaseUnits: 0 };
        }
      }
    }
    const totalPillsVal =
      totalPillsProp.found && typeof totalPillsProp.value === 'number' ? totalPillsProp.value : null;
    const baseUnitsVal =
      baseUnitsProp.found && typeof baseUnitsProp.value === 'number' ? baseUnitsProp.value : null;
    const qtyVal =
      qtyProp.found && typeof qtyProp.value === 'number' ? qtyProp.value : null;
    const stockVal =
      stockProp.found && typeof stockProp.value === 'number' ? stockProp.value : null;

    if (totalPillsVal !== null && baseUnitsVal !== null && Math.abs(totalPillsVal - baseUnitsVal) > 1e-4) {
      return { valid: false, present: true, totalBaseUnits: 0 };
    }
    const explicitBase = totalPillsVal ?? baseUnitsVal;
    if (qtyVal !== null && stockVal !== null && Math.abs(qtyVal - stockVal) > 1e-4) {
      return { valid: false, present: true, totalBaseUnits: 0 };
    }
    const packQtyVal = qtyVal ?? stockVal;
    if (
      explicitBase !== null &&
      packQtyVal !== null &&
      Math.abs(packQtyVal * baseUnitsPerPack - explicitBase) > 1e-4
    ) {
      return { valid: false, present: true, totalBaseUnits: 0 };
    }

    const batchBase =
      explicitBase !== null
        ? explicitBase
        : packQtyVal !== null
          ? packQtyVal * baseUnitsPerPack
          : null;
    if (batchBase === null || !Number.isFinite(batchBase) || batchBase < 0) {
      return { valid: false, present: true, totalBaseUnits: 0 };
    }
    total += batchBase;
  }
  return { valid: true, present: true, totalBaseUnits: total };
}

function reconcileMedicineStockChangeWithValidatedDelta(
  prevMedSnapshot: Record<string, unknown>,
  liveMed: unknown,
  deltaBaseUnits: number
): boolean {
  if (!Number.isFinite(deltaBaseUnits) || deltaBaseUnits === 0) {
    return false;
  }
  if (!liveMed || typeof liveMed !== 'object' || Array.isArray(liveMed)) {
    return false;
  }
  const baseUnitsPerPack = resolveMedicinePackBaseUnitsFactor(liveMed);
  if (baseUnitsPerPack === null) {
    return false;
  }

  // initialStock and openingStockEvidence are creation-time constants and must NEVER mutate post-migration
  const prevInitial = prevMedSnapshot.initialStock as { found: boolean; value: unknown } | undefined;
  const liveInitialProp = getSafeOwnDataProp(liveMed, 'initialStock');
  if (
    canonicalStableJson(prevInitial ?? { found: false, value: { __type: 'undefined' } }) !==
    canonicalStableJson({
      found: liveInitialProp.found,
      value:
        liveInitialProp.value === undefined
          ? { __type: 'undefined' }
          : sanitizeForPlainJson(liveInitialProp.value),
    })
  ) {
    return false;
  }
  const prevOpeningEvidence = prevMedSnapshot.openingStockEvidence as { found: boolean; value: unknown } | undefined;
  const liveOpeningEvidenceProp = getSafeOwnDataProp(liveMed, 'openingStockEvidence');
  if (
    canonicalStableJson(prevOpeningEvidence ?? { found: false, value: { __type: 'undefined' } }) !==
    canonicalStableJson({
      found: liveOpeningEvidenceProp.found,
      value:
        liveOpeningEvidenceProp.value === undefined
          ? { __type: 'undefined' }
          : sanitizeForPlainJson(liveOpeningEvidenceProp.value),
    })
  ) {
    return false;
  }

  let matchedAnyDelta = false;
  const liveConsistentBaseTotals: number[] = [];

  for (const baseField of ['totalBasePills', 'baseStock'] as const) {
    const prevEntry = prevMedSnapshot[baseField] as { found: boolean; value: unknown } | undefined;
    const liveProp = getSafeOwnDataProp(liveMed, baseField);
    const prevVal =
      prevEntry?.found && typeof prevEntry.value === 'number' && Number.isFinite(prevEntry.value)
        ? prevEntry.value
        : prevEntry?.found && (prevEntry.value === null || (prevEntry.value as { __type?: string })?.__type === 'undefined')
          ? null
          : undefined;
    const liveVal =
      liveProp.found && typeof liveProp.value === 'number' && Number.isFinite(liveProp.value)
        ? liveProp.value
        : liveProp.found && (liveProp.value === null || liveProp.value === undefined)
          ? null
          : undefined;
    if (typeof liveVal === 'number') {
      if (liveVal < 0) return false;
      liveConsistentBaseTotals.push(liveVal);
    }
    const changed =
      canonicalStableJson(prevEntry ?? { found: false, value: { __type: 'undefined' } }) !==
      canonicalStableJson({
        found: liveProp.found,
        value: liveProp.value === undefined ? { __type: 'undefined' } : sanitizeForPlainJson(liveProp.value),
      });
    if (changed) {
      if (typeof liveVal !== 'number' || liveVal < 0) return false;
      const baseBefore = typeof prevVal === 'number' ? prevVal : 0;
      if (Math.abs((liveVal - baseBefore) - deltaBaseUnits) > 1e-6) {
        return false;
      }
      matchedAnyDelta = true;
    }
  }

  for (const packField of ['stock', 'currentStock', 'quantity'] as const) {
    const prevEntry = prevMedSnapshot[packField] as { found: boolean; value: unknown } | undefined;
    const liveProp = getSafeOwnDataProp(liveMed, packField);
    const prevVal =
      prevEntry?.found && typeof prevEntry.value === 'number' && Number.isFinite(prevEntry.value)
        ? prevEntry.value
        : prevEntry?.found && (prevEntry.value === null || (prevEntry.value as { __type?: string })?.__type === 'undefined')
          ? null
          : undefined;
    const liveVal =
      liveProp.found && typeof liveProp.value === 'number' && Number.isFinite(liveProp.value)
        ? liveProp.value
        : liveProp.found && (liveProp.value === null || liveProp.value === undefined)
          ? null
          : undefined;
    if (typeof liveVal === 'number') {
      if (liveVal < 0) return false;
      liveConsistentBaseTotals.push(liveVal * baseUnitsPerPack);
    }
    const changed =
      canonicalStableJson(prevEntry ?? { found: false, value: { __type: 'undefined' } }) !==
      canonicalStableJson({
        found: liveProp.found,
        value: liveProp.value === undefined ? { __type: 'undefined' } : sanitizeForPlainJson(liveProp.value),
      });
    if (changed) {
      if (typeof liveVal !== 'number' || liveVal < 0) return false;
      const packsBefore = typeof prevVal === 'number' ? prevVal : 0;
      if (Math.abs((liveVal - packsBefore) * baseUnitsPerPack - deltaBaseUnits) > 1e-4) {
        return false;
      }
      matchedAnyDelta = true;
    }
  }

  const prevBatchesEntry = prevMedSnapshot.batches as { found: boolean; value: unknown } | undefined;
  const liveBatchesProp = getSafeOwnDataProp(liveMed, 'batches');
  const prevBatchesRaw =
    prevBatchesEntry?.found && (prevBatchesEntry.value as { __type?: string })?.__type !== 'undefined'
      ? prevBatchesEntry.value
      : undefined;
  const liveBatchesStats = computeBatchesTotalBaseUnits(liveBatchesProp.value, baseUnitsPerPack);
  const changedBatches =
    canonicalStableJson(prevBatchesEntry ?? { found: false, value: { __type: 'undefined' } }) !==
    canonicalStableJson({
      found: liveBatchesProp.found,
      value:
        liveBatchesProp.value === undefined
          ? { __type: 'undefined' }
          : sanitizeForPlainJson(liveBatchesProp.value),
    });
  if (changedBatches) {
    const prevBatchesStats = computeBatchesTotalBaseUnits(prevBatchesRaw, baseUnitsPerPack);
    if (!prevBatchesStats.valid || !liveBatchesStats.valid || !liveBatchesStats.present) {
      return false;
    }
    if (Math.abs((liveBatchesStats.totalBaseUnits - prevBatchesStats.totalBaseUnits) - deltaBaseUnits) > 1e-4) {
      return false;
    }
    matchedAnyDelta = true;
  }

  if (
    liveBatchesStats.present &&
    liveBatchesStats.valid &&
    ((Array.isArray(liveBatchesProp.value) && liveBatchesProp.value.length > 0) ||
      (Array.isArray(prevBatchesRaw) && prevBatchesRaw.length > 0))
  ) {
    liveConsistentBaseTotals.push(liveBatchesStats.totalBaseUnits);
  } else if (liveBatchesStats.present && !liveBatchesStats.valid) {
    return false;
  }

  if (liveConsistentBaseTotals.length > 1) {
    const anchor = liveConsistentBaseTotals[0];
    for (let i = 1; i < liveConsistentBaseTotals.length; i += 1) {
      if (Math.abs(liveConsistentBaseTotals[i] - anchor) > 1e-4) {
        return false;
      }
    }
  }

  return matchedAnyDelta;
}

function projectSingleMedicineStockState(raw: unknown, idx = 0): Record<string, unknown> {
  const safe = sanitizeForPlainJson(raw) as Record<string, unknown>;
  const projection: Record<string, unknown> = {
    id: typeof safe?.id === 'string' ? safe.id : `idx-${idx}`,
  };
  for (const field of [
    'stock',
    'currentStock',
    'initialStock',
    'quantity',
    'totalBasePills',
    'baseStock',
    'batches',
    'openingStockEvidence',
  ]) {
    const prop = getSafeOwnDataProp(raw, field);
    projection[field] = {
      found: prop.found,
      value: prop.value === undefined ? { __type: 'undefined' } : sanitizeForPlainJson(prop.value),
    };
  }
  return projection;
}

function computeMedicineStockDigest(medicines: ReadonlyArray<unknown>): string {
  const projections = medicines.map((raw, idx) => projectSingleMedicineStockState(raw, idx));
  projections.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  return sha256HexSync(canonicalStableJson(projections));
}

function isZeroStockEvidenceValue(evRaw: unknown): boolean {
  if (!evRaw || typeof evRaw !== 'object' || Array.isArray(evRaw)) {
    return false;
  }
  const ev = sanitizeForPlainJson(evRaw) as Record<string, unknown> | null;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    return false;
  }
  if (ev.schemaVersion !== 1) return false;
  if (ev.intent !== 'OMITTED' && ev.intent !== 'EXPLICIT_ZERO') return false;
  if (ev.intendedInitialStock !== 0 || ev.intendedBaseUnits !== 0) return false;
  if (ev.initialLedgerMovementId !== undefined) return false;
  return true;
}

function isZeroStockMedicineState(raw: unknown): boolean {
  const stockFields = [
    'stock',
    'currentStock',
    'initialStock',
    'quantity',
    'totalBasePills',
    'baseStock',
  ];
  for (const field of stockFields) {
    const prop = getSafeOwnDataProp(raw, field);
    if (!prop.found || prop.value === undefined || prop.value === null) continue;
    if (typeof prop.value !== 'number' || !Number.isFinite(prop.value) || prop.value !== 0) {
      return false;
    }
  }
  const batchesProp = getSafeOwnDataProp(raw, 'batches');
  if (batchesProp.found && batchesProp.value !== undefined && batchesProp.value !== null) {
    if (!Array.isArray(batchesProp.value) || batchesProp.value.length > 0) {
      return false;
    }
  }
  const evProp = getSafeOwnDataProp(raw, 'openingStockEvidence');
  if (evProp.found && evProp.value !== undefined && evProp.value !== null) {
    if (!isZeroStockEvidenceValue(evProp.value)) {
      return false;
    }
  }
  return true;
}

function isZeroStockSnapshot(stockSnap: unknown): boolean {
  if (!stockSnap || typeof stockSnap !== 'object' || Array.isArray(stockSnap)) {
    return false;
  }
  const snapRec = stockSnap as Record<string, unknown>;
  const extract = (field: string): { present: boolean; value: unknown } => {
    const entry = snapRec[field] as { found?: boolean; value?: unknown } | undefined;
    if (!entry || !entry.found) return { present: false, value: undefined };
    const v = entry.value;
    if (
      v === undefined ||
      v === null ||
      (typeof v === 'object' && (v as { __type?: string })?.__type === 'undefined')
    ) {
      return { present: false, value: undefined };
    }
    return { present: true, value: v };
  };
  for (const field of [
    'stock',
    'currentStock',
    'initialStock',
    'quantity',
    'totalBasePills',
    'baseStock',
  ] as const) {
    const e = extract(field);
    if (!e.present) continue;
    if (typeof e.value !== 'number' || !Number.isFinite(e.value) || e.value !== 0) {
      return false;
    }
  }
  const batchesEntry = extract('batches');
  if (batchesEntry.present) {
    if (!Array.isArray(batchesEntry.value) || batchesEntry.value.length > 0) {
      return false;
    }
  }
  const evEntry = extract('openingStockEvidence');
  if (evEntry.present) {
    if (!isZeroStockEvidenceValue(evEntry.value)) {
      return false;
    }
  }
  return true;
}

function normalizePropForCreationEquality(found: boolean, value: unknown): string {
  return canonicalStableJson({
    found: Boolean(found),
    value: value === undefined ? { __type: 'undefined' } : sanitizeForPlainJson(value),
  });
}

function isPropEffectivelyDefined(prop: { found: boolean; value: unknown }): boolean {
  return Boolean(
    prop.found &&
      prop.value !== undefined &&
      prop.value !== null &&
      (typeof prop.value !== 'object' ||
        (prop.value as { __type?: string })?.__type !== 'undefined')
  );
}

function validateOpeningStockCreationEvidence(
  evidenceRaw: unknown,
  medRaw: unknown,
  medId: string,
  expectedCreateOpId: string | null,
  packUnits: number | null
):
  | {
      ok: true;
      evidence: {
        intent: 'OMITTED' | 'EXPLICIT_ZERO' | 'POSITIVE';
        intendedInitialStock: number;
        intendedBaseUnits: number;
        initialLedgerMovementId?: string;
        batchNumber?: string;
      };
    }
  | { ok: false; reason: string } {
  if (!evidenceRaw || typeof evidenceRaw !== 'object' || Array.isArray(evidenceRaw)) {
    return { ok: false, reason: 'openingStockEvidence is not a plain object' };
  }
  const ev = sanitizeForPlainJson(evidenceRaw) as Record<string, unknown> | null;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    return { ok: false, reason: 'openingStockEvidence failed plain JSON check' };
  }
  if (ev.schemaVersion !== 1) {
    return { ok: false, reason: `unsupported openingStockEvidence schemaVersion '${String(ev.schemaVersion)}'` };
  }
  if (ev.medicineId !== medId) {
    return { ok: false, reason: `openingStockEvidence.medicineId '${String(ev.medicineId)}' mismatches '${medId}'` };
  }
  const opId = typeof ev.createOperationId === 'string' ? ev.createOperationId.trim() : '';
  if (!opId || (expectedCreateOpId !== null && opId !== expectedCreateOpId)) {
    return {
      ok: false,
      reason: `openingStockEvidence.createOperationId '${opId}' mismatches CREATE outbox operationId '${String(expectedCreateOpId)}'`,
    };
  }
  const intent = ev.intent;
  if (intent !== 'OMITTED' && intent !== 'EXPLICIT_ZERO' && intent !== 'POSITIVE') {
    return { ok: false, reason: `invalid openingStockEvidence.intent '${String(intent)}'` };
  }
  if (
    typeof ev.intendedInitialStock !== 'number' ||
    !Number.isFinite(ev.intendedInitialStock) ||
    ev.intendedInitialStock < 0
  ) {
    return { ok: false, reason: 'invalid openingStockEvidence.intendedInitialStock' };
  }
  if (
    typeof ev.intendedBaseUnits !== 'number' ||
    !Number.isFinite(ev.intendedBaseUnits) ||
    ev.intendedBaseUnits < 0
  ) {
    return { ok: false, reason: 'invalid openingStockEvidence.intendedBaseUnits' };
  }

  const medInitialProp = getSafeOwnDataProp(medRaw, 'initialStock');
  if (
    !medInitialProp.found ||
    typeof medInitialProp.value !== 'number' ||
    !Number.isFinite(medInitialProp.value) ||
    medInitialProp.value !== ev.intendedInitialStock
  ) {
    return {
      ok: false,
      reason: `openingStockEvidence.intendedInitialStock (${ev.intendedInitialStock}) contradicts medicine initialStock (${String(medInitialProp.value)})`,
    };
  }

  if (intent === 'POSITIVE') {
    if (ev.intendedInitialStock <= 0 || ev.intendedBaseUnits <= 0) {
      return { ok: false, reason: 'POSITIVE openingStockEvidence requires positive quantities' };
    }
    if (packUnits !== null && Math.abs(ev.intendedInitialStock * packUnits - ev.intendedBaseUnits) > 1e-4) {
      return {
        ok: false,
        reason: `POSITIVE openingStockEvidence baseUnits (${ev.intendedBaseUnits}) disagrees with pack conversion (${ev.intendedInitialStock} * ${packUnits})`,
      };
    }
    const movId = typeof ev.initialLedgerMovementId === 'string' ? ev.initialLedgerMovementId.trim() : '';
    const batch = typeof ev.batchNumber === 'string' ? ev.batchNumber.trim() : '';
    if (!movId || !batch) {
      return { ok: false, reason: 'POSITIVE openingStockEvidence requires initialLedgerMovementId and batchNumber' };
    }
    const medBatchVal = getSafeOwnDataProp(medRaw, 'batchNumber').value;
    const medBatch = typeof medBatchVal === 'string' ? medBatchVal.trim() : '';
    if (medBatch && batch !== medBatch) {
      return { ok: false, reason: `openingStockEvidence.batchNumber '${batch}' mismatches '${medBatch}'` };
    }
    return {
      ok: true,
      evidence: {
        intent,
        intendedInitialStock: ev.intendedInitialStock,
        intendedBaseUnits: ev.intendedBaseUnits,
        initialLedgerMovementId: movId,
        batchNumber: batch,
      },
    };
  }

  if (ev.intendedInitialStock !== 0 || ev.intendedBaseUnits !== 0 || ev.initialLedgerMovementId !== undefined) {
    return {
      ok: false,
      reason: `${intent} openingStockEvidence cannot carry positive stock or initialLedgerMovementId`,
    };
  }
  return {
    ok: true,
    evidence: {
      intent,
      intendedInitialStock: 0,
      intendedBaseUnits: 0,
    },
  };
}

function positiveSafeIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function resolveVerifiedUnitDefinitionForRecord(medRaw: unknown): UnitDefinition | null {
  if (!medRaw || typeof medRaw !== 'object' || Array.isArray(medRaw)) {
    return null;
  }
  const unitDefProp = getSafeOwnDataProp(medRaw, 'unitDefinition');
  if (!unitDefProp.found || unitDefProp.value === undefined || unitDefProp.value === null) {
    return null;
  }
  const rehydrated = rehydrateUnitDefinitionFromDto(unitDefProp.value);
  if (!rehydrated.ok) {
    return null;
  }
  const def = rehydrated.definition;
  const topFormProp = getSafeOwnDataProp(medRaw, 'dosageForm');
  if (topFormProp.found && topFormProp.value !== undefined && topFormProp.value !== null && topFormProp.value !== def.dosageForm) {
    return null;
  }
  const topBaseProp = getSafeOwnDataProp(medRaw, 'baseUnitsPerPack');
  if (topBaseProp.found && topBaseProp.value !== undefined && topBaseProp.value !== null && topBaseProp.value !== def.baseUnitsPerPack) {
    return null;
  }
  const topStripsProp = getSafeOwnDataProp(medRaw, 'stripsPerPack');
  const topPillsProp = getSafeOwnDataProp(medRaw, 'pillsPerStrip');
  if (def.hierarchy.kind === 'DIRECT_PACK') {
    if (
      (topStripsProp.found && topStripsProp.value !== undefined && topStripsProp.value !== null) ||
      (topPillsProp.found && topPillsProp.value !== undefined && topPillsProp.value !== null)
    ) {
      return null;
    }
  } else {
    if (
      topStripsProp.found &&
      topStripsProp.value !== undefined &&
      topStripsProp.value !== def.hierarchy.stripsPerPack
    ) {
      return null;
    }
    if (
      topPillsProp.found &&
      topPillsProp.value !== undefined &&
      topPillsProp.value !== def.hierarchy.pillsPerStrip
    ) {
      return null;
    }
  }
  return def;
}

function resolveMedicinePackBaseUnitsFactor(medRaw: unknown): number | null {
  if (!medRaw || typeof medRaw !== 'object' || Array.isArray(medRaw)) {
    return null;
  }
  const unitDefProp = getSafeOwnDataProp(medRaw, 'unitDefinition');
  if (unitDefProp.found && unitDefProp.value !== undefined && unitDefProp.value !== null) {
    const def = resolveVerifiedUnitDefinitionForRecord(medRaw);
    return def ? def.hierarchy.baseUnitsPerPack : null;
  }

  const dosageFormVal = getSafeOwnDataProp(medRaw, 'dosageForm').value;
  if (
    typeof dosageFormVal !== 'string' ||
    !Object.prototype.hasOwnProperty.call(KNOWN_BASE_UNIT_BY_FORM, dosageFormVal)
  ) {
    return null;
  }
  const knownForm = dosageFormVal as KnownDosageFormKind;
  const isSolid = knownForm === 'Tablet' || knownForm === 'Capsule';
  const stripsProp = getSafeOwnDataProp(medRaw, 'stripsPerPack');
  const pillsProp = getSafeOwnDataProp(medRaw, 'pillsPerStrip');
  const baseUnitsProp = getSafeOwnDataProp(medRaw, 'baseUnitsPerPack');

  if (!isSolid) {
    if (
      (stripsProp.found && stripsProp.value !== undefined && stripsProp.value !== null) ||
      (pillsProp.found && pillsProp.value !== undefined && pillsProp.value !== null)
    ) {
      return null;
    }
    return positiveSafeIntOrNull(baseUnitsProp.value);
  }

  const strips = positiveSafeIntOrNull(stripsProp.value);
  const pills = positiveSafeIntOrNull(pillsProp.value);
  if (strips === null || pills === null) {
    return null;
  }
  const computedPackUnits = strips * pills;
  if (!Number.isSafeInteger(computedPackUnits) || computedPackUnits <= 0) {
    return null;
  }
  if (baseUnitsProp.found && baseUnitsProp.value !== undefined && baseUnitsProp.value !== null) {
    const explicitBase = positiveSafeIntOrNull(baseUnitsProp.value);
    if (explicitBase === null || explicitBase !== computedPackUnits) {
      return null;
    }
  }
  return computedPackUnits;
}

function resolveMedicineUnitConversionFactor(medRaw: unknown, unitRaw: unknown): number | null {
  if (typeof unitRaw !== 'string') return null;
  const unit = unitRaw.trim();
  if (!unit || unit !== unitRaw) return null;

  const packUnits = resolveMedicinePackBaseUnitsFactor(medRaw);
  if (packUnits === null) {
    return null;
  }

  const unitDefProp = getSafeOwnDataProp(medRaw, 'unitDefinition');
  if (unitDefProp.found && unitDefProp.value !== undefined && unitDefProp.value !== null) {
    const def = resolveVerifiedUnitDefinitionForRecord(medRaw);
    if (!def) return null;
    if (def.hierarchy.kind === 'DIRECT_PACK') {
      if (unit === 'strip' || unit === 'pill') {
        return null;
      }
      if (unit === def.baseUnit) {
        return 1;
      }
      if (unit === def.packUnit || unit === 'pack') {
        return def.hierarchy.baseUnitsPerPack;
      }
      return null;
    }
    if (unit === def.baseUnit || unit === 'pill') {
      return 1;
    }
    if (unit === 'strip') {
      return def.hierarchy.pillsPerStrip;
    }
    if (unit === def.packUnit || unit === 'pack') {
      return def.hierarchy.baseUnitsPerPack;
    }
    return null;
  }

  const dosageForm = getSafeOwnDataProp(medRaw, 'dosageForm').value as KnownDosageFormKind;
  const expectedBaseUnit = KNOWN_BASE_UNIT_BY_FORM[dosageForm];
  const isSolid = dosageForm === 'Tablet' || dosageForm === 'Capsule';
  if (!isSolid) {
    if (unit === 'strip' || unit === 'pill') {
      return null;
    }
    if (unit === expectedBaseUnit) {
      return 1;
    }
    if (unit === 'pack') {
      return packUnits;
    }
    return null;
  }

  const pills = positiveSafeIntOrNull(getSafeOwnDataProp(medRaw, 'pillsPerStrip').value);
  if (pills === null) return null;
  if (unit === 'pill' || unit === expectedBaseUnit) return 1;
  if (unit === 'strip') return pills;
  if (unit === 'pack') return packUnits;
  return null;
}

function buildSafeMedicinePriceSource(medRaw: unknown): {
  valid: boolean;
  source: MedicineUnitPriceSource;
} {
  const numOrUndef = (prop: { found: boolean; value: unknown }): { ok: boolean; value: number | undefined } => {
    if (!prop.found || prop.value === undefined || prop.value === null) {
      return { ok: true, value: undefined };
    }
    if (typeof prop.value !== 'number' || !Number.isSafeInteger(prop.value) || prop.value < 0) {
      return { ok: false, value: undefined };
    }
    return { ok: true, value: prop.value };
  };
  const sellPrice = numOrUndef(getSafeOwnDataProp(medRaw, 'sellPrice'));
  const sellPriceStrip = numOrUndef(getSafeOwnDataProp(medRaw, 'sellPriceStrip'));
  const sellPricePill = numOrUndef(getSafeOwnDataProp(medRaw, 'sellPricePill'));
  const stripsProp = getSafeOwnDataProp(medRaw, 'stripsPerPack');
  const pillsProp = getSafeOwnDataProp(medRaw, 'pillsPerStrip');
  const sellPackProp = getSafeOwnDataProp(medRaw, 'sellPack');
  const sellStripProp = getSafeOwnDataProp(medRaw, 'sellStrip');
  const sellPillProp = getSafeOwnDataProp(medRaw, 'sellPill');

  if (!sellPrice.ok || !sellPriceStrip.ok || !sellPricePill.ok) {
    return { valid: false, source: {} };
  }
  return {
    valid: true,
    source: {
      sellPrice: sellPrice.value,
      sellPriceStrip: sellPriceStrip.value,
      sellPricePill: sellPricePill.value,
      sellPack: typeof sellPackProp.value === 'boolean' ? sellPackProp.value : sellPackProp.value === undefined ? undefined : false,
      sellStrip: sellStripProp.value === true,
      sellPill: sellPillProp.value === true,
      stripsPerPack: positiveSafeIntOrNull(stripsProp.value) ?? undefined,
      pillsPerStrip: positiveSafeIntOrNull(pillsProp.value) ?? undefined,
    },
  };
}

function inspectExplicitStockFieldsOnLiveMed(
  medRaw: unknown,
  packUnits: number
): { valid: boolean; hasAnyExplicit: boolean; isExplicitlyZero: boolean; agreedBaseUnits: number | null } {
  const numericTotals: number[] = [];
  let hasAnyExplicit = false;
  let allNumericZero = true;

  for (const baseField of ['totalBasePills', 'baseStock'] as const) {
    const p = getSafeOwnDataProp(medRaw, baseField);
    if (!p.found || p.value === undefined || p.value === null) continue;
    hasAnyExplicit = true;
    if (typeof p.value !== 'number' || !Number.isFinite(p.value) || p.value < 0) {
      return { valid: false, hasAnyExplicit: true, isExplicitlyZero: false, agreedBaseUnits: null };
    }
    if (p.value !== 0) allNumericZero = false;
    numericTotals.push(p.value);
  }
  for (const packField of ['stock', 'currentStock', 'quantity'] as const) {
    const p = getSafeOwnDataProp(medRaw, packField);
    if (!p.found || p.value === undefined || p.value === null) continue;
    hasAnyExplicit = true;
    if (typeof p.value !== 'number' || !Number.isFinite(p.value) || p.value < 0) {
      return { valid: false, hasAnyExplicit: true, isExplicitlyZero: false, agreedBaseUnits: null };
    }
    if (p.value !== 0) allNumericZero = false;
    numericTotals.push(p.value * packUnits);
  }

  const batchesProp = getSafeOwnDataProp(medRaw, 'batches');
  let batchesHasPositiveStock = false;
  if (batchesProp.found && batchesProp.value !== undefined && batchesProp.value !== null) {
    hasAnyExplicit = true;
    const stats = computeBatchesTotalBaseUnits(batchesProp.value, packUnits);
    if (!stats.valid) {
      return { valid: false, hasAnyExplicit: true, isExplicitlyZero: false, agreedBaseUnits: null };
    }
    if (Array.isArray(batchesProp.value) && batchesProp.value.length > 0) {
      numericTotals.push(stats.totalBaseUnits);
      if (stats.totalBaseUnits > 0) {
        batchesHasPositiveStock = true;
        allNumericZero = false;
      }
    }
  }

  if (numericTotals.length > 1) {
    const anchor = numericTotals[0];
    for (let i = 1; i < numericTotals.length; i += 1) {
      if (Math.abs(numericTotals[i] - anchor) > 1e-4) {
        return { valid: false, hasAnyExplicit: true, isExplicitlyZero: false, agreedBaseUnits: null };
      }
    }
  }

  const isExplicitlyZero = hasAnyExplicit && allNumericZero && !batchesHasPositiveStock;
  return {
    valid: true,
    hasAnyExplicit,
    isExplicitlyZero,
    agreedBaseUnits: numericTotals.length > 0 ? numericTotals[0] : isExplicitlyZero ? 0 : null,
  };
}

function inspectExplicitStockFieldsOnSnapshot(
  stockSnap: Record<string, unknown> | undefined,
  packUnits: number
): { valid: boolean; hasAnyExplicit: boolean; isExplicitlyZero: boolean; agreedBaseUnits: number | null } {
  if (!stockSnap || typeof stockSnap !== 'object') {
    return { valid: true, hasAnyExplicit: false, isExplicitlyZero: false, agreedBaseUnits: null };
  }
  const extractEntry = (field: string): { present: boolean; value: unknown } => {
    const entry = stockSnap[field] as { found?: boolean; value?: unknown } | undefined;
    if (!entry || !entry.found) return { present: false, value: undefined };
    const v = entry.value;
    if (v === undefined || v === null || (typeof v === 'object' && (v as { __type?: string })?.__type === 'undefined')) {
      return { present: false, value: undefined };
    }
    return { present: true, value: v };
  };

  const numericTotals: number[] = [];
  let hasAnyExplicit = false;
  let allNumericZero = true;

  for (const baseField of ['totalBasePills', 'baseStock'] as const) {
    const e = extractEntry(baseField);
    if (!e.present) continue;
    hasAnyExplicit = true;
    if (typeof e.value !== 'number' || !Number.isFinite(e.value) || e.value < 0) {
      return { valid: false, hasAnyExplicit: true, isExplicitlyZero: false, agreedBaseUnits: null };
    }
    if (e.value !== 0) allNumericZero = false;
    numericTotals.push(e.value);
  }
  for (const packField of ['stock', 'currentStock', 'quantity'] as const) {
    const e = extractEntry(packField);
    if (!e.present) continue;
    hasAnyExplicit = true;
    if (typeof e.value !== 'number' || !Number.isFinite(e.value) || e.value < 0) {
      return { valid: false, hasAnyExplicit: true, isExplicitlyZero: false, agreedBaseUnits: null };
    }
    if (e.value !== 0) allNumericZero = false;
    numericTotals.push(e.value * packUnits);
  }

  const batchesEntry = extractEntry('batches');
  let batchesHasPositiveStock = false;
  if (batchesEntry.present) {
    hasAnyExplicit = true;
    const stats = computeBatchesTotalBaseUnits(batchesEntry.value, packUnits);
    if (!stats.valid) {
      return { valid: false, hasAnyExplicit: true, isExplicitlyZero: false, agreedBaseUnits: null };
    }
    if (Array.isArray(batchesEntry.value) && batchesEntry.value.length > 0) {
      numericTotals.push(stats.totalBaseUnits);
      if (stats.totalBaseUnits > 0) {
        batchesHasPositiveStock = true;
        allNumericZero = false;
      }
    }
  }

  if (numericTotals.length > 1) {
    const anchor = numericTotals[0];
    for (let i = 1; i < numericTotals.length; i += 1) {
      if (Math.abs(numericTotals[i] - anchor) > 1e-4) {
        return { valid: false, hasAnyExplicit: true, isExplicitlyZero: false, agreedBaseUnits: null };
      }
    }
  }

  const isExplicitlyZero = hasAnyExplicit && allNumericZero && !batchesHasPositiveStock;
  return {
    valid: true,
    hasAnyExplicit,
    isExplicitlyZero,
    agreedBaseUnits: numericTotals.length > 0 ? numericTotals[0] : isExplicitlyZero ? 0 : null,
  };
}

function isValidMedicineOutboxIdentity(
  raw: unknown,
  expectedMedicineId: string,
  baselineCutoffMs: number,
  options?: { readonly requireCreateAction?: boolean; readonly requireUpdateAction?: boolean }
): boolean {
  const entityType = getSafeOwnDataProp(raw, 'entityType').value;
  const entityId = getSafeOwnDataProp(raw, 'entityId').value;
  const action = getSafeOwnDataProp(raw, 'action').value;
  const id = getSafeOwnDataProp(raw, 'id').value;
  const operationId = getSafeOwnDataProp(raw, 'operationId').value;
  const idempotencyKey = getSafeOwnDataProp(raw, 'idempotencyKey');
  const timestamp = getSafeOwnDataProp(raw, 'timestamp').value;
  const payload = getSafeOwnDataProp(raw, 'payload').value;
  const payloadId = getSafeOwnDataProp(payload, 'id').value;
  const payloadUpdatedAt = getSafeOwnDataProp(payload, 'updatedAt').value;
  const operationIdentity =
    typeof operationId === 'string' && operationId.trim()
      ? operationId.trim()
      : typeof id === 'string'
        ? id.trim()
        : '';
  const timestampMs = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  const payloadUpdatedAtMs = typeof payloadUpdatedAt === 'string' ? Date.parse(payloadUpdatedAt) : NaN;
  const requireCreate = options?.requireCreateAction === true;
  const requireUpdate = options?.requireUpdateAction === true;
  const actionValid = requireCreate
    ? action === 'CREATE'
    : requireUpdate
      ? action === 'UPDATE'
      : action === 'CREATE' || action === 'UPDATE';
  const expectedIdempotencyKey =
    action === 'CREATE'
      ? `medicine:CREATE:${expectedMedicineId}`
      : action === 'UPDATE'
        ? `medicine:UPDATE:${expectedMedicineId}`
        : '';
  const idempotencyKeyValid =
    idempotencyKey.found &&
    typeof idempotencyKey.value === 'string' &&
    expectedIdempotencyKey.length > 0 &&
    idempotencyKey.value.trim() === expectedIdempotencyKey;
  return (
    entityType === 'medicine' &&
    entityId === expectedMedicineId &&
    payloadId === expectedMedicineId &&
    actionValid &&
    typeof id === 'string' &&
    id.trim().length > 0 &&
    operationIdentity.length > 0 &&
    // The persisted row id and operationId are one stable operation identity.
    // Accept legacy rows with no operationId, but reject a contradictory one.
    (operationId === undefined || operationId === null || operationId === id) &&
    idempotencyKeyValid &&
    Number.isFinite(timestampMs) &&
    timestampMs > baselineCutoffMs &&
    Number.isFinite(payloadUpdatedAtMs) &&
    payloadUpdatedAtMs > baselineCutoffMs
  );
}

function computeMedicineFinancialsDigest(medicines: ReadonlyArray<unknown>): string {
  const projections = medicines.map((raw, idx) => projectSingleMedicineFinancials(raw, idx));
  projections.sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  return sha256HexSync(canonicalStableJson(projections));
}

function computeHistoricalStocktakingDigest(
  sessions: ReadonlyArray<unknown>,
  subItems: ReadonlyArray<unknown>
): { count: number; digest: string } {
  const historicalSessions: Array<{ id: string; raw: unknown }> = [];
  const historicalSessionIds = new Set<string>();

  for (const s of sessions) {
    const safe = sanitizeForPlainJson(s) as Record<string, unknown>;
    const status = typeof safe?.status === 'string' ? safe.status : '';
    const id = typeof safe?.id === 'string' ? safe.id : '';
    if (HISTORICAL_STOCKTAKING_STATUSES.has(status)) {
      historicalSessions.push({ id, raw: safe });
      if (id) historicalSessionIds.add(id);
    }
  }
  historicalSessions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const historicalSubItems: Array<{ id: string; raw: unknown }> = [];
  for (const it of subItems) {
    const safe = sanitizeForPlainJson(it) as Record<string, unknown>;
    const sid = typeof safe?.sessionId === 'string' ? safe.sessionId : '';
    if (historicalSessionIds.has(sid)) {
      historicalSubItems.push({
        id: typeof safe?.id === 'string' ? safe.id : canonicalStableJson(safe),
        raw: safe,
      });
    }
  }
  historicalSubItems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    count: historicalSessions.length,
    digest: sha256HexSync(
      JSON.stringify({
        sessions: historicalSessions.map((s) => canonicalStableJson(s.raw)),
        subItems: historicalSubItems.map((i) => canonicalStableJson(i.raw)),
      })
    ),
  };
}

function recordSortId(rec: unknown, index: number): string {
  const safeId = getSafeOwnDataProp(rec, 'id');
  if (safeId.found && typeof safeId.value === 'string' && safeId.value.trim()) {
    return safeId.value.trim();
  }
  return `__idx_${String(index).padStart(8, '0')}`;
}

function filterPreBaselineRecords(records: ReadonlyArray<unknown>, cutoffIso: string): unknown[] {
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) return [...records];
  return records.filter((rec) => {
    const tsProp = getSafeOwnDataProp(rec, 'timestamp');
    const createdProp = getSafeOwnDataProp(rec, 'createdAt');
    const rawTs =
      typeof tsProp.value === 'string'
        ? tsProp.value
        : typeof createdProp.value === 'string'
          ? createdProp.value
          : '';
    if (!rawTs) return true;
    const ms = Date.parse(rawTs);
    if (!Number.isFinite(ms)) return true;
    return ms <= cutoffMs;
  });
}

function readAllStoreAsync(tx: IDBTransaction, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error || new Error(`Failed reading store ${storeName}`));
  });
}

function readMetaAsync<T>(tx: IDBTransaction, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('metadata').get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error || new Error(`Failed reading metadata key ${key}`));
  });
}

async function resolveTargetDb(
  explicitDb?: IDBDatabase,
  expectedDbName?: string
): Promise<IDBDatabase> {
  if (explicitDb !== undefined) {
    if (
      !explicitDb ||
      typeof explicitDb !== 'object' ||
      typeof explicitDb.name !== 'string' ||
      explicitDb.name.trim().length === 0 ||
      typeof explicitDb.transaction !== 'function' ||
      !explicitDb.objectStoreNames ||
      typeof explicitDb.objectStoreNames.contains !== 'function'
    ) {
      throw new Error(
        'UNAUTHORIZED_DATABASE_HANDLE: Invalid or incomplete IndexedDB database handle rejected.'
      );
    }
    if (expectedDbName && explicitDb.name !== expectedDbName) {
      throw new Error(
        `UNAUTHORIZED_DATABASE_HANDLE: Foreign database handle "${explicitDb.name}" rejected; expected active branch database "${expectedDbName}".`
      );
    }
    return explicitDb;
  }
  const idb = getIDBFactory();
  if (!idb) {
    throw new Error('INDEXEDDB_UNAVAILABLE: IndexedDB is required for unit migration.');
  }
  const opened = await openPharmacyDB();
  if (expectedDbName && opened.name !== expectedDbName) {
    throw new Error(
      `UNAUTHORIZED_DATABASE_HANDLE: Opened database handle "${opened.name}" mismatched expected active branch database "${expectedDbName}".`
    );
  }
  return opened;
}

function buildBaselineDigestFromStores(
  db: IDBDatabase,
  migrationRunId: string,
  capturedAt: string
): Promise<FinancialBaselineDigestRecord> {
  const candidateStores = [
    'inventory_ledger',
    'sales',
    'purchase_invoices',
    'supplier_transactions',
    'suppliers',
    'outbox',
    'medicines',
    'stocktaking_sessions',
    'stocktaking_items',
  ].filter((name) => db.objectStoreNames.contains(name));

  return new Promise((resolve, reject) => {
    const tx = db.transaction(candidateStores, 'readonly');
    const dataMap = new Map<string, unknown[]>();
    let pending = candidateStores.length;

    const finalizeIfReady = () => {
      pending -= 1;
      if (pending > 0) return;
      try {
        const ledger = dataMap.get('inventory_ledger') ?? [];
        const sales = dataMap.get('sales') ?? [];
        const purchaseInvoices = dataMap.get('purchase_invoices') ?? [];
        const supplierTxs = dataMap.get('supplier_transactions') ?? [];
        const suppliers = dataMap.get('suppliers') ?? [];
        const outbox = dataMap.get('outbox') ?? [];
        const medicines = dataMap.get('medicines') ?? [];
        const sessions = dataMap.get('stocktaking_sessions') ?? [];
        const subItems = dataMap.get('stocktaking_items') ?? [];
        const histSt = computeHistoricalStocktakingDigest(sessions, subItems);

        const medicineFinancialHashesById: Record<string, string> = {};
        const medicineStockHashesById: Record<string, string> = {};
        for (let i = 0; i < medicines.length; i += 1) {
          const med = medicines[i];
          const mid = recordSortId(med, i);
          medicineFinancialHashesById[mid] = computeSingleMedicineFinancialHash(med, i);
          medicineStockHashesById[mid] = sha256HexSync(
            canonicalStableJson(projectSingleMedicineStockState(med, i))
          );
        }

        const outboxBaselineSnapshots: Record<string, OutboxBaselineSnapshotEntry> = {};
        for (let i = 0; i < outbox.length; i += 1) {
          const entry = outbox[i];
          const safe = sanitizeForPlainJson(entry) as Record<string, unknown>;
          const id = recordSortId(entry, i);
          const opId = typeof safe?.operationId === 'string' ? safe.operationId : null;
          const entityType = typeof safe?.entityType === 'string' ? safe.entityType : '';
          const entityId = typeof safe?.entityId === 'string' ? safe.entityId : '';
          const status = typeof safe?.status === 'string' ? safe.status : '';
          const leaseOwner =
            typeof safe?.leaseOwner === 'string' && safe.leaseOwner.trim() ? safe.leaseOwner.trim() : null;
          const ts =
            typeof safe?.timestamp === 'string'
              ? safe.timestamp
              : typeof safe?.createdAt === 'string'
                ? safe.createdAt
                : '';
          outboxBaselineSnapshots[id] = {
            id,
            operationId: opId,
            entityType,
            entityId,
            status,
            leaseOwner,
            timestamp: ts,
            digest: sha256HexSync(canonicalStableJson(entry)),
          };
        }

        resolve({
          key: UNIT_MIGRATION_BASELINE_DIGEST_KEY,
          schemaVersion: UNIT_MIGRATION_SCHEMA_VERSION,
          migrationRunId,
          capturedAt,
          counts: {
            inventoryLedger: ledger.length,
            sales: sales.length,
            purchaseInvoices: purchaseInvoices.length,
            supplierTransactions: supplierTxs.length,
            suppliers: suppliers.length,
            outbox: outbox.length,
            medicines: medicines.length,
            historicalStocktakingSessions: histSt.count,
          },
          digests: {
            inventoryLedger: computeCanonicalRecordsDigest(ledger, recordSortId),
            sales: computeCanonicalRecordsDigest(sales, recordSortId),
            purchaseInvoices: computeCanonicalRecordsDigest(purchaseInvoices, recordSortId),
            supplierTransactions: computeCanonicalRecordsDigest(supplierTxs, recordSortId),
            suppliers: computeCanonicalRecordsDigest(suppliers, recordSortId),
            outbox: computeCanonicalRecordsDigest(outbox, recordSortId),
            nonMedicineOutbox: computeCanonicalRecordsDigest(
              outbox.filter((o) => getSafeOwnDataProp(o, 'entityType').value !== 'medicine'),
              recordSortId
            ),
            medicineFinancials: computeMedicineFinancialsDigest(medicines),
            medicineStock: computeMedicineStockDigest(medicines),
            historicalStocktaking: histSt.digest,
          },
          medicineFinancialHashesById,
          medicineStockHashesById,
          outboxBaselineSnapshots,
        });
      } catch (err) {
        reject(err);
      }
    };

    for (const storeName of candidateStores) {
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => {
        dataMap.set(storeName, Array.isArray(req.result) ? req.result : []);
        finalizeIfReady();
      };
      req.onerror = () => {
        reject(req.error || new Error(`BASELINE_READ_FAILED: ${storeName}`));
      };
    }

    tx.onerror = () => reject(tx.error || new Error('BASELINE_TX_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('BASELINE_TX_ABORTED'));
  });
}

function buildQuarantineRecord(params: {
  medicineId: string;
  classification: 'QUARANTINED' | 'CONFLICTED';
  preservedConfigStatus: UnitConfigurationStatus;
  claimedConfigStatus?: UnitConfigurationStatus;
  reasonCode: string;
  message: string;
  nowIso: string;
  migrationRunId: string;
  rawSnapshot: unknown;
  existingQuarantine?: MedicineQuarantineRecord | null;
  preQuarantinePackingLocked?: boolean;
}): MedicineQuarantineRecord {
  const existing = params.existingQuarantine;
  const computedPreLocked =
    existing?.preQuarantinePackingLocked !== undefined
      ? existing.preQuarantinePackingLocked
      : Boolean(params.preQuarantinePackingLocked);
  return {
    key: `${UNIT_MIGRATION_QUARANTINE_PREFIX}${params.medicineId}`,
    schemaVersion: UNIT_MIGRATION_SCHEMA_VERSION,
    medicineId: params.medicineId,
    classification: params.classification,
    preservedConfigStatus: params.preservedConfigStatus,
    ...(params.claimedConfigStatus !== undefined
      ? { claimedConfigStatus: params.claimedConfigStatus }
      : existing?.claimedConfigStatus !== undefined
        ? { claimedConfigStatus: existing.claimedConfigStatus }
        : {}),
    reasonCode: params.reasonCode,
    message: params.message,
    firstQuarantinedAt: existing?.firstQuarantinedAt ?? params.nowIso,
    lastSeenAt: params.nowIso,
    migrationRunId: existing?.migrationRunId ?? params.migrationRunId,
    lastSeenRunId: params.migrationRunId,
    operationalAllowed: false,
    packingLocked: true,
    preQuarantinePackingLocked: computedPreLocked,
    reviewStatus: 'PENDING_PHARMACIST_REVIEW',
    rawSnapshot: existing?.rawSnapshot !== undefined ? existing.rawSnapshot : params.rawSnapshot,
  };
}

function computeMedicineCanonicalFingerprint(rawMed: unknown): string {
  return canonicalStableJson(rawMed);
}

function assertOnlyAuthorizedMedicinePatch(
  beforeRaw: unknown,
  afterMed: Medicine | null
): void {
  if (!afterMed || !beforeRaw || typeof beforeRaw !== 'object') return;
  const beforeSafe = sanitizeForPlainJson(beforeRaw);
  const afterSafe = sanitizeForPlainJson(afterMed);
  if (
    !beforeSafe ||
    typeof beforeSafe !== 'object' ||
    Array.isArray(beforeSafe) ||
    !afterSafe ||
    typeof afterSafe !== 'object' ||
    Array.isArray(afterSafe)
  ) {
    return;
  }
  const bObj = beforeSafe as Record<string, unknown>;
  const aObj = afterSafe as Record<string, unknown>;
  const keys = new Set<string>([...Object.keys(bObj), ...Object.keys(aObj)]);
  for (const k of keys) {
    if (k === '__customPrototypeRejected' || k === '__symbolKeysRejectedCount') continue;
    if (!AUTHORIZED_MIGRATION_FIELD_SET.has(k)) {
      if (canonicalStableJson(bObj[k]) !== canonicalStableJson(aObj[k])) {
        throw new Error(`UNAUTHORIZED_MEDICINE_MUTATION: Field '${k}' mutated unexpectedly`);
      }
    }
  }
}

function inspectMedicineStockAndLockFlags(rawMed: unknown): {
  hasNonZeroStock: boolean;
  hasExistingLockFlag: boolean;
  hasCloudOrPermanentLockFlag: boolean;
  hasQuarantineStatus: boolean;
  corruptReasons: string[];
} {
  const corruptReasons: string[] = [];
  let hasNonZeroStock = false;
  let hasExistingLockFlag = false;
  let hasQuarantineStatus = false;

  const numericStockFields = ['stock', 'currentStock', 'initialStock', 'quantity', 'totalBasePills', 'baseStock'];
  for (const field of numericStockFields) {
    const prop = getSafeOwnDataProp(rawMed, field);
    if (!prop.found || prop.value === undefined || prop.value === null) continue;
    if (typeof prop.value !== 'number' || !Number.isFinite(prop.value)) {
      corruptReasons.push(`CORRUPT_STOCK_FIELD:${field}`);
      hasNonZeroStock = true;
    } else if (prop.value !== 0) {
      hasNonZeroStock = true;
    }
  }

  const batchesProp = getSafeOwnDataProp(rawMed, 'batches');
  if (batchesProp.found && batchesProp.value !== undefined && batchesProp.value !== null) {
    if (!Array.isArray(batchesProp.value)) {
      corruptReasons.push('CORRUPT_BATCHES_NON_ARRAY');
      hasNonZeroStock = true;
    } else {
      for (let i = 0; i < batchesProp.value.length; i += 1) {
        const batch = batchesProp.value[i];
        if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
          corruptReasons.push(`CORRUPT_BATCH_ENTRY:${i}`);
          hasNonZeroStock = true;
          continue;
        }
        for (const bField of ['quantity', 'totalPills', 'baseUnits', 'stock']) {
          const bp = getSafeOwnDataProp(batch, bField);
          if (!bp.found || bp.value === undefined || bp.value === null) continue;
          if (typeof bp.value !== 'number' || !Number.isFinite(bp.value)) {
            corruptReasons.push(`CORRUPT_BATCH_FIELD:${i}.${bField}`);
            hasNonZeroStock = true;
          } else if (bp.value !== 0) {
            hasNonZeroStock = true;
          }
        }
      }
    }
  }

  let hasCloudOrPermanentLockFlag = false;
  for (const lockField of ['packingLocked', 'cloudPackingLocked', 'permanentPackingLocked']) {
    const lp = getSafeOwnDataProp(rawMed, lockField);
    if (!lp.found || lp.value === undefined || lp.value === null) continue;
    if (typeof lp.value !== 'boolean') {
      corruptReasons.push(`CORRUPT_LOCK_FLAG:${lockField}`);
    } else if (lp.value === true) {
      hasExistingLockFlag = true;
      if (lockField === 'cloudPackingLocked' || lockField === 'permanentPackingLocked') {
        hasCloudOrPermanentLockFlag = true;
      }
    }
  }

  const unitDefProp = getSafeOwnDataProp(rawMed, 'unitDefinition');
  if (unitDefProp.found && unitDefProp.value && typeof unitDefProp.value === 'object' && !Array.isArray(unitDefProp.value)) {
    const defLock = getSafeOwnDataProp(unitDefProp.value, 'packingLocked');
    if (defLock.found && defLock.value === true) {
      hasExistingLockFlag = true;
    } else if (defLock.found && defLock.value !== undefined && defLock.value !== null && typeof defLock.value !== 'boolean') {
      corruptReasons.push('CORRUPT_UNIT_DEF_PACKING_LOCK');
    }
    const defCfg = getSafeOwnDataProp(unitDefProp.value, 'configStatus');
    if (defCfg.found && (defCfg.value === 'QUARANTINED' || defCfg.value === 'RECONCILIATION_REQUIRED')) {
      hasQuarantineStatus = true;
    }
  }

  const cfgProp = getSafeOwnDataProp(rawMed, 'configStatus');
  if (cfgProp.found && (cfgProp.value === 'QUARANTINED' || cfgProp.value === 'RECONCILIATION_REQUIRED')) {
    hasQuarantineStatus = true;
  }
  const migProp = getSafeOwnDataProp(rawMed, 'unitMigrationStatus');
  if (migProp.found && (migProp.value === 'QUARANTINED' || migProp.value === 'CONFLICTED')) {
    hasQuarantineStatus = true;
  }
  for (const reconBoolField of ['needsReconciliation', 'reconciliationRequired']) {
    const rp = getSafeOwnDataProp(rawMed, reconBoolField);
    if (!rp.found || rp.value === undefined || rp.value === null) continue;
    if (typeof rp.value !== 'boolean') {
      corruptReasons.push(`CORRUPT_RECONCILIATION_FLAG:${reconBoolField}`);
    } else if (rp.value === true) {
      hasQuarantineStatus = true;
    }
  }
  const reconStatusProp = getSafeOwnDataProp(rawMed, 'reconciliationStatus');
  if (reconStatusProp.found && typeof reconStatusProp.value === 'string') {
    const norm = reconStatusProp.value.trim().toUpperCase();
    if (norm && norm !== 'RESOLVED' && norm !== 'NONE' && norm !== 'CLEARED') {
      hasQuarantineStatus = true;
    }
  }

  return {
    hasNonZeroStock,
    hasExistingLockFlag,
    hasCloudOrPermanentLockFlag,
    hasQuarantineStatus,
    corruptReasons,
  };
}

function buildUpdatedPlainMedicine(
  safeRawOwnData: Record<string, unknown>,
  patch: Record<string, unknown>
): Medicine {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(safeRawOwnData)) {
    if (
      key === '__customPrototypeRejected' ||
      key === '__symbolKeysRejectedCount'
    ) {
      continue;
    }
    clean[key] = safeRawOwnData[key];
  }
  for (const patchKey of Object.keys(patch)) {
    if (!AUTHORIZED_MIGRATION_FIELD_SET.has(patchKey)) {
      throw new Error(`UNAUTHORIZED_MIGRATION_WRITE_FIELD: '${patchKey}'`);
    }
    clean[patchKey] = patch[patchKey];
  }
  return clean as unknown as Medicine;
}

function deriveConservativeSellableUnits(
  safeRawOwnData: Record<string, unknown>,
  dosageForm: KnownDosageFormKind,
  baseUnit: BaseUnitKind,
  supportsStrip: boolean
): SupportedUnitKind[] {
  const sellable: SupportedUnitKind[] = [];
  if (safeRawOwnData.sellPack !== false) {
    sellable.push('pack');
  }
  if (supportsStrip && safeRawOwnData.sellStrip === true) {
    sellable.push('strip');
  }
  if (safeRawOwnData.sellPill === true) {
    sellable.push(baseUnit);
  }
  if (sellable.length === 0) {
    // Structural fallback only inside UnitDefinition.sellableUnits; original legacy flags stay untouched.
    sellable.push('pack');
  }
  return sellable;
}

export function enforceFailClosedQuarantineLockPolicy(params: {
  readonly classification: MedicineMigrationClassification;
  readonly configStatus: UnitConfigurationStatus;
  readonly resolvedEffectiveLocked: boolean;
  readonly packingLockReport?: PackingLockEvidenceReport;
}): {
  readonly packingLocked: boolean;
  readonly unitOperationalAllowed: false;
  readonly mustLockForQuarantineOrConflict: boolean;
} {
  const mustLockForQuarantineOrConflict =
    params.classification === 'QUARANTINED' ||
    params.classification === 'CONFLICTED' ||
    params.configStatus === 'QUARANTINED' ||
    params.configStatus === 'RECONCILIATION_REQUIRED' ||
    params.packingLockReport?.status === 'UNKNOWN_FAIL_CLOSED';

  return {
    packingLocked: Boolean(mustLockForQuarantineOrConflict || params.resolvedEffectiveLocked),
    unitOperationalAllowed: false,
    mustLockForQuarantineOrConflict,
  };
}

function resolveOutcomeLockMeta(
  rawMed: unknown,
  options: {
    readonly hasHistoricalMovementOrPendingSync: boolean;
    readonly packingLockReport?: PackingLockEvidenceReport;
    readonly existingQuarantine?: MedicineQuarantineRecord | null;
  }
): { effectiveLocked: boolean; lockStatus: PackingLockEvidenceStatus } {
  const flags = inspectMedicineStockAndLockFlags(rawMed);
  const activeQuarantineExists =
    Boolean(options.existingQuarantine && options.existingQuarantine.reviewStatus !== 'RESOLVED');
  if (options.packingLockReport) {
    if (flags.corruptReasons.length > 0 || options.packingLockReport.status === 'UNKNOWN_FAIL_CLOSED') {
      return { effectiveLocked: true, lockStatus: 'UNKNOWN_FAIL_CLOSED' };
    }
    const effectiveLocked = Boolean(
      options.packingLockReport.effectivePackingLocked ||
        flags.hasExistingLockFlag ||
        flags.hasNonZeroStock ||
        flags.hasQuarantineStatus ||
        activeQuarantineExists ||
        options.hasHistoricalMovementOrPendingSync
    );
    const lockStatus: PackingLockEvidenceStatus =
      effectiveLocked ? 'LOCKED_WITH_EVIDENCE' : 'SAFE_NO_EVIDENCE';
    return { effectiveLocked, lockStatus };
  }
  if (flags.corruptReasons.length > 0) {
    return { effectiveLocked: true, lockStatus: 'UNKNOWN_FAIL_CLOSED' };
  }
  const effectiveLocked = Boolean(
    flags.hasExistingLockFlag ||
      flags.hasNonZeroStock ||
      options.hasHistoricalMovementOrPendingSync ||
      flags.hasQuarantineStatus ||
      activeQuarantineExists
  );
  return {
    effectiveLocked,
    lockStatus: effectiveLocked ? 'LOCKED_WITH_EVIDENCE' : 'SAFE_NO_EVIDENCE',
  };
}

/**
 * Classifies and builds conservative PR-1/PR-2A-R2 migration output for a single raw medicine record.
 * - Never invokes getters or copies Symbol/prototype properties.
 * - Never guesses dosageForm from name, never converts 1x1 automatically, never promotes to VERIFIED.
 * - Preserves `QUARANTINED` unconditionally and enforces fail-closed `packingLocked` semantics across all quarantine/conflict/unresolved paths.
 */
export function classifyMedicineRecordForMigration(
  rawMed: unknown,
  options: {
    readonly hasHistoricalMovementOrPendingSync: boolean;
    readonly packingLockReport?: PackingLockEvidenceReport;
    readonly migrationRunId: string;
    readonly nowIso: string;
    readonly fallbackRecordId?: string;
    readonly existingQuarantine?: MedicineQuarantineRecord | null;
  }
): MedicineClassificationOutcome {
  const lockMeta = resolveOutcomeLockMeta(rawMed, options);
  const preLockedFlags = inspectMedicineStockAndLockFlags(rawMed);
  const preQuarantineLocked = Boolean(
    preLockedFlags.hasExistingLockFlag ||
      preLockedFlags.hasNonZeroStock ||
      options.hasHistoricalMovementOrPendingSync ||
      (options.packingLockReport &&
        options.packingLockReport.matchedSources.some(
          (src) => src !== 'QUARANTINE_OR_RECONCILIATION_STATE'
        ))
  );
  const outcome = classifyMedicineRecordForMigrationCore(
    rawMed,
    { ...options, preQuarantinePackingLocked: preQuarantineLocked },
    lockMeta.effectiveLocked
  );
  const quarantinePolicy = enforceFailClosedQuarantineLockPolicy({
    classification: outcome.classification,
    configStatus: outcome.configStatus,
    resolvedEffectiveLocked: Boolean(outcome.packingLocked ?? lockMeta.effectiveLocked),
    packingLockReport: options.packingLockReport,
  });

  let finalUpdatedMed = outcome.updatedMedicineRecord;
  if (finalUpdatedMed && quarantinePolicy.mustLockForQuarantineOrConflict) {
    const rawUpdated = sanitizeForPlainJson(finalUpdatedMed) as Record<string, unknown>;
    if (rawUpdated.packingLocked !== true || rawUpdated.unitOperationalAllowed !== false) {
      finalUpdatedMed = {
        ...finalUpdatedMed,
        packingLocked: true,
        unitOperationalAllowed: false,
      };
    }
  }
  if (finalUpdatedMed) {
    assertOnlyAuthorizedMedicinePatch(rawMed, finalUpdatedMed);
  }
  return {
    ...outcome,
    packingLocked: quarantinePolicy.packingLocked,
    packingLockStatus: lockMeta.lockStatus,
    updatedMedicineRecord: finalUpdatedMed,
  };
}

function classifyMedicineRecordForMigrationCore(
  rawMed: unknown,
  options: {
    readonly hasHistoricalMovementOrPendingSync: boolean;
    readonly packingLockReport?: PackingLockEvidenceReport;
    readonly migrationRunId: string;
    readonly nowIso: string;
    readonly fallbackRecordId?: string;
    readonly existingQuarantine?: MedicineQuarantineRecord | null;
    readonly preQuarantinePackingLocked?: boolean;
  },
  resolvedEffectiveLocked: boolean
): MedicineClassificationOutcome {
  const safeIdProp = getSafeOwnDataProp(rawMed, 'id');
  const medicineId =
    safeIdProp.found && typeof safeIdProp.value === 'string' && safeIdProp.value.trim()
      ? safeIdProp.value.trim()
      : options.fallbackRecordId || 'unknown-medicine';

  const safeSnapshot = sanitizeForPlainJson(rawMed);
  const safeOwnObj =
    safeSnapshot !== null && typeof safeSnapshot === 'object' && !Array.isArray(safeSnapshot)
      ? (safeSnapshot as Record<string, unknown>)
      : null;

  const rehydration = rehydrateLegacyOrV2MedicineConfig(rawMed);

  // 1. INVALID / POISONED / CONTRADICTORY RECORDS
  if (rehydration.kind === 'INVALID') {
    const isConflict =
      rehydration.errorCode === 'LEGACY_V2_CONTRADICTION' ||
      rehydration.policyCode === 'INCONSISTENT_PACK_HIERARCHY' ||
      rehydration.policyCode === 'SOLID_HIERARCHY_FORBIDDEN_FOR_NON_SOLID';

    const classification: 'QUARANTINED' | 'CONFLICTED' = isConflict ? 'CONFLICTED' : 'QUARANTINED';
    const preservedStatus: UnitConfigurationStatus = 'QUARANTINED';

    const quarantineRecord = buildQuarantineRecord({
      medicineId,
      classification,
      preservedConfigStatus: preservedStatus,
      claimedConfigStatus: rehydration.claimedConfigStatus,
      reasonCode: rehydration.policyCode || rehydration.errorCode,
      message: rehydration.message,
      nowIso: options.nowIso,
      migrationRunId: options.migrationRunId,
      rawSnapshot: safeSnapshot,
      existingQuarantine: options.existingQuarantine,
      preQuarantinePackingLocked: options.preQuarantinePackingLocked,
    });

    const alreadySameState =
      safeOwnObj !== null &&
      safeOwnObj.configStatus === preservedStatus &&
      safeOwnObj.unitMigrationStatus === classification &&
      safeOwnObj.unitOperationalAllowed === false &&
      safeOwnObj.packingLocked === true;

    const updatedMedicineRecord =
      safeOwnObj !== null && safeIdProp.found && typeof safeIdProp.value === 'string' && !alreadySameState
        ? buildUpdatedPlainMedicine(safeOwnObj, {
            configStatus: preservedStatus,
            unitMigrationStatus: classification,
            unitMigrationRunId: options.migrationRunId,
            unitMigratedAt:
              typeof safeOwnObj.unitMigratedAt === 'string'
                ? safeOwnObj.unitMigratedAt
                : options.nowIso,
            packingLocked: true,
            unitOperationalAllowed: false,
          })
        : null;

    return {
      classification,
      medicineId,
      configStatus: preservedStatus,
      ...(rehydration.claimedConfigStatus !== undefined
        ? { claimedConfigStatus: rehydration.claimedConfigStatus }
        : {}),
      packingLocked: true,
      quarantinePreserved: true,
      reasonCode: rehydration.policyCode || rehydration.errorCode,
      message: rehydration.message,
      alreadyMigratedUnchanged: alreadySameState && Boolean(options.existingQuarantine),
      updatedMedicineRecord,
      quarantineRecord,
    };
  }

  // 2. VALID V2 REHYDRATED RECORD
  if (rehydration.kind === 'V2_REHYDRATED') {
    const def = rehydration.definition;
    const effectiveLocked = Boolean(def.packingLocked || resolvedEffectiveLocked);

    // Preserve QUARANTINED strictly without ever downgrading it, and ALWAYS enforce packingLocked=true
    if (rehydration.trustStatus === 'QUARANTINED') {
      const quarantinedEffectiveLocked = true;
      const rebuiltDef: UnitDefinition =
        def.packingLocked === quarantinedEffectiveLocked
          ? def
          : createValidatedUnitDefinition({
              dosageForm: def.dosageForm,
              baseUnit: def.baseUnit,
              packUnit: def.packUnit,
              intermediateUnit: def.hierarchy.intermediateUnit,
              ...(def.hierarchy.kind === 'SOLID_TWO_LEVEL'
                ? {
                    stripsPerPack: def.hierarchy.stripsPerPack,
                    pillsPerStrip: def.hierarchy.pillsPerStrip,
                  }
                : {}),
              baseUnitsPerPack: def.baseUnitsPerPack,
              requestedSellableUnits: [...def.sellableUnits.toArray()],
              definitionVersion: def.definitionVersion,
              configStatus: 'QUARANTINED',
              packingLocked: quarantinedEffectiveLocked,
            });
      const dto = serializeUnitDefinitionToDto(rebuiltDef);

      const quarantineRecord = buildQuarantineRecord({
        medicineId,
        classification: 'QUARANTINED',
        preservedConfigStatus: 'QUARANTINED',
        claimedConfigStatus: rehydration.claimedConfigStatus,
        reasonCode: 'EXISTING_V2_QUARANTINED',
        message: 'Existing QUARANTINED V2 record preserved in pharmacist review queue.',
        nowIso: options.nowIso,
        migrationRunId: options.migrationRunId,
        rawSnapshot: safeSnapshot,
        existingQuarantine: options.existingQuarantine,
        preQuarantinePackingLocked: options.preQuarantinePackingLocked,
      });

      const alreadySame =
        safeOwnObj !== null &&
        safeOwnObj.configStatus === 'QUARANTINED' &&
        safeOwnObj.unitMigrationStatus === 'QUARANTINED' &&
        safeOwnObj.unitOperationalAllowed === false &&
        safeOwnObj.packingLocked === true &&
        canonicalStableJson(safeOwnObj.unitDefinition) === canonicalStableJson(dto);

      const updatedMedicineRecord =
        safeOwnObj !== null && !alreadySame
          ? buildUpdatedPlainMedicine(safeOwnObj, {
              dosageForm: dto.dosageForm,
              baseUnitsPerPack: dto.baseUnitsPerPack,
              configStatus: 'QUARANTINED',
              unitDefinition: dto,
              unitDefinitionKey: dto.unitDefinitionKey,
              baseDimensionKey: dto.baseDimensionKey,
              packingLocked: true,
              unitMigrationStatus: 'QUARANTINED',
              unitMigrationRunId: options.migrationRunId,
              unitMigratedAt:
                typeof safeOwnObj.unitMigratedAt === 'string'
                  ? safeOwnObj.unitMigratedAt
                  : options.nowIso,
              unitOperationalAllowed: false,
            })
          : null;

      return {
        classification: 'QUARANTINED',
        medicineId,
        configStatus: 'QUARANTINED',
        claimedConfigStatus: rehydration.claimedConfigStatus,
        unitDefinitionDto: dto,
        unitDefinitionKey: dto.unitDefinitionKey,
        baseDimensionKey: dto.baseDimensionKey,
        dosageForm: dto.dosageForm,
        baseUnitsPerPack: dto.baseUnitsPerPack,
        packingLocked: true,
        quarantinePreserved: true,
        reasonCode: 'EXISTING_V2_QUARANTINED',
        message: 'QUARANTINED status strictly preserved.',
        alreadyMigratedUnchanged: alreadySame && Boolean(options.existingQuarantine),
        updatedMedicineRecord,
        quarantineRecord,
      };
    }

    if (rehydration.trustStatus === 'RECONCILIATION_REQUIRED') {
      const conflictEffectiveLocked = true;
      const rebuiltDef =
        def.packingLocked === conflictEffectiveLocked
          ? def
          : createValidatedUnitDefinition({
              dosageForm: def.dosageForm,
              baseUnit: def.baseUnit,
              packUnit: def.packUnit,
              intermediateUnit: def.hierarchy.intermediateUnit,
              ...(def.hierarchy.kind === 'SOLID_TWO_LEVEL'
                ? {
                    stripsPerPack: def.hierarchy.stripsPerPack,
                    pillsPerStrip: def.hierarchy.pillsPerStrip,
                  }
                : {}),
              baseUnitsPerPack: def.baseUnitsPerPack,
              requestedSellableUnits: [...def.sellableUnits.toArray()],
              definitionVersion: def.definitionVersion,
              configStatus: 'RECONCILIATION_REQUIRED',
              packingLocked: conflictEffectiveLocked,
            });
      const dto = serializeUnitDefinitionToDto(rebuiltDef);

      const quarantineRecord = buildQuarantineRecord({
        medicineId,
        classification: 'CONFLICTED',
        preservedConfigStatus: 'RECONCILIATION_REQUIRED',
        claimedConfigStatus: rehydration.claimedConfigStatus,
        reasonCode: 'V2_RECONCILIATION_REQUIRED',
        message: 'Record marked RECONCILIATION_REQUIRED and queued for review.',
        nowIso: options.nowIso,
        migrationRunId: options.migrationRunId,
        rawSnapshot: safeSnapshot,
        existingQuarantine: options.existingQuarantine,
        preQuarantinePackingLocked: options.preQuarantinePackingLocked,
      });

      const alreadySame =
        safeOwnObj !== null &&
        safeOwnObj.configStatus === 'RECONCILIATION_REQUIRED' &&
        safeOwnObj.unitMigrationStatus === 'CONFLICTED' &&
        safeOwnObj.unitOperationalAllowed === false &&
        safeOwnObj.packingLocked === true &&
        canonicalStableJson(safeOwnObj.unitDefinition) === canonicalStableJson(dto);

      const updatedMedicineRecord =
        safeOwnObj !== null && !alreadySame
          ? buildUpdatedPlainMedicine(safeOwnObj, {
              dosageForm: dto.dosageForm,
              baseUnitsPerPack: dto.baseUnitsPerPack,
              configStatus: 'RECONCILIATION_REQUIRED',
              unitDefinition: dto,
              unitDefinitionKey: dto.unitDefinitionKey,
              baseDimensionKey: dto.baseDimensionKey,
              packingLocked: true,
              unitMigrationStatus: 'CONFLICTED',
              unitMigrationRunId: options.migrationRunId,
              unitMigratedAt:
                typeof safeOwnObj.unitMigratedAt === 'string'
                  ? safeOwnObj.unitMigratedAt
                  : options.nowIso,
              unitOperationalAllowed: false,
            })
          : null;

      return {
        classification: 'CONFLICTED',
        medicineId,
        configStatus: 'RECONCILIATION_REQUIRED',
        claimedConfigStatus: rehydration.claimedConfigStatus,
        unitDefinitionDto: dto,
        unitDefinitionKey: dto.unitDefinitionKey,
        baseDimensionKey: dto.baseDimensionKey,
        dosageForm: dto.dosageForm,
        baseUnitsPerPack: dto.baseUnitsPerPack,
        packingLocked: true,
        quarantinePreserved: false,
        reasonCode: 'V2_RECONCILIATION_REQUIRED',
        message: 'Record requires reconciliation before operational verification.',
        alreadyMigratedUnchanged: alreadySame && Boolean(options.existingQuarantine),
        updatedMedicineRecord,
        quarantineRecord,
      };
    }

    // Valid V2 with conservative trustStatus ('LEGACY_ASSUMED' or 'UNVERIFIED_UNKNOWN' — NEVER 'VERIFIED')
    const conservativeStatus = rehydration.trustStatus;
    const canonicalDef = createValidatedUnitDefinition({
      dosageForm: def.dosageForm,
      baseUnit: def.baseUnit,
      packUnit: def.packUnit,
      intermediateUnit: def.hierarchy.intermediateUnit,
      ...(def.hierarchy.kind === 'SOLID_TWO_LEVEL'
        ? {
            stripsPerPack: def.hierarchy.stripsPerPack,
            pillsPerStrip: def.hierarchy.pillsPerStrip,
          }
        : {}),
      baseUnitsPerPack: def.baseUnitsPerPack,
      requestedSellableUnits: [...def.sellableUnits.toArray()],
      definitionVersion: def.definitionVersion,
      configStatus: conservativeStatus,
      packingLocked: effectiveLocked,
    });
    const dto = serializeUnitDefinitionToDto(canonicalDef);
    const roundTrip = rehydrateUnitDefinitionFromDto(dto);
    if (!roundTrip.ok || roundTrip.isVerifiedForOperations || roundTrip.trustStatus !== conservativeStatus) {
      throw new Error(`PR2B_ROUNDTRIP_GUARD_FAILED: Unexpected rehydration result for ${medicineId}`);
    }

    const alreadySame =
      safeOwnObj !== null &&
      safeOwnObj.dosageForm === dto.dosageForm &&
      safeOwnObj.baseUnitsPerPack === dto.baseUnitsPerPack &&
      safeOwnObj.configStatus === conservativeStatus &&
      safeOwnObj.unitDefinitionKey === dto.unitDefinitionKey &&
      safeOwnObj.baseDimensionKey === dto.baseDimensionKey &&
      safeOwnObj.packingLocked === dto.packingLocked &&
      safeOwnObj.unitMigrationStatus === 'MIGRATED_CONSERVATIVE' &&
      safeOwnObj.unitOperationalAllowed === false &&
      canonicalStableJson(safeOwnObj.unitDefinition) === canonicalStableJson(dto);

    const updatedMedicineRecord =
      safeOwnObj !== null && !alreadySame
        ? buildUpdatedPlainMedicine(safeOwnObj, {
            dosageForm: dto.dosageForm,
            baseUnitsPerPack: dto.baseUnitsPerPack,
            configStatus: conservativeStatus,
            unitDefinition: dto,
            unitDefinitionKey: dto.unitDefinitionKey,
            baseDimensionKey: dto.baseDimensionKey,
            packingLocked: dto.packingLocked,
            unitMigrationStatus: 'MIGRATED_CONSERVATIVE',
            unitMigrationRunId: options.migrationRunId,
            unitMigratedAt:
              typeof safeOwnObj.unitMigratedAt === 'string'
                ? safeOwnObj.unitMigratedAt
                : options.nowIso,
            unitOperationalAllowed: false,
          })
        : null;

    return {
      classification: 'MIGRATED_CONSERVATIVE',
      medicineId,
      configStatus: conservativeStatus,
      claimedConfigStatus: rehydration.claimedConfigStatus,
      unitDefinitionDto: dto,
      unitDefinitionKey: dto.unitDefinitionKey,
      baseDimensionKey: dto.baseDimensionKey,
      dosageForm: dto.dosageForm,
      baseUnitsPerPack: dto.baseUnitsPerPack,
      packingLocked: dto.packingLocked,
      quarantinePreserved: false,
      reasonCode:
        rehydration.claimedConfigStatus === 'VERIFIED'
          ? 'V2_CLAIMED_VERIFIED_CLAMPED_TO_UNVERIFIED'
          : 'V2_CONSERVATIVE_MIGRATED',
      message:
        rehydration.claimedConfigStatus === 'VERIFIED'
          ? 'Untrusted DTO VERIFIED claim clamped to UNVERIFIED_UNKNOWN until independent approval.'
          : 'Validated V2 unit definition preserved conservatively.',
      alreadyMigratedUnchanged: alreadySame,
      updatedMedicineRecord,
      quarantineRecord: null,
    };
  }

  // 3. LEGACY INSPECTED RECORD (PR-1 inspectLegacyMedicineUnitConfig result)
  const insp = rehydration.inspection;

  // 3a. Preserve QUARANTINED strictly if raw legacy record carried QUARANTINED
  if (rehydration.trustStatus === 'QUARANTINED' || rehydration.quarantinePreserved) {
    const quarantineRecord = buildQuarantineRecord({
      medicineId,
      classification: 'QUARANTINED',
      preservedConfigStatus: 'QUARANTINED',
      claimedConfigStatus: rehydration.claimedConfigStatus,
      reasonCode: 'LEGACY_QUARANTINED_PRESERVED',
      message: 'Existing legacy QUARANTINED record strictly preserved without downgrade.',
      nowIso: options.nowIso,
      migrationRunId: options.migrationRunId,
      rawSnapshot: safeSnapshot,
      existingQuarantine: options.existingQuarantine,
      preQuarantinePackingLocked: options.preQuarantinePackingLocked,
    });

    const alreadySame =
      safeOwnObj !== null &&
      safeOwnObj.configStatus === 'QUARANTINED' &&
      safeOwnObj.unitMigrationStatus === 'QUARANTINED' &&
      safeOwnObj.unitOperationalAllowed === false &&
      safeOwnObj.packingLocked === true;

    const updatedMedicineRecord =
      safeOwnObj !== null && !alreadySame
        ? buildUpdatedPlainMedicine(safeOwnObj, {
            configStatus: 'QUARANTINED',
            unitMigrationStatus: 'QUARANTINED',
            unitMigrationRunId: options.migrationRunId,
            unitMigratedAt:
              typeof safeOwnObj.unitMigratedAt === 'string'
                ? safeOwnObj.unitMigratedAt
                : options.nowIso,
            packingLocked: true,
            unitOperationalAllowed: false,
          })
        : null;

    return {
      classification: 'QUARANTINED',
      medicineId,
      configStatus: 'QUARANTINED',
      ...(rehydration.claimedConfigStatus !== undefined
        ? { claimedConfigStatus: rehydration.claimedConfigStatus }
        : {}),
      packingLocked: true,
      quarantinePreserved: true,
      reasonCode: 'LEGACY_QUARANTINED_PRESERVED',
      message: 'Legacy QUARANTINED record strictly preserved.',
      alreadyMigratedUnchanged: alreadySame && Boolean(options.existingQuarantine),
      updatedMedicineRecord,
      quarantineRecord,
    };
  }

  // 3b. Conflicted legacy record (e.g. non-solid with solid stripsPerPack / pillsPerStrip spoof)
  if (insp.configStatus === 'RECONCILIATION_REQUIRED') {
    const quarantineRecord = buildQuarantineRecord({
      medicineId,
      classification: 'CONFLICTED',
      preservedConfigStatus: 'RECONCILIATION_REQUIRED',
      claimedConfigStatus: rehydration.claimedConfigStatus,
      reasonCode: insp.reasonCode,
      message: `Legacy contradiction (${insp.reasonCode}); queued for pharmacist reconciliation.`,
      nowIso: options.nowIso,
      migrationRunId: options.migrationRunId,
      rawSnapshot: safeSnapshot,
      existingQuarantine: options.existingQuarantine,
      preQuarantinePackingLocked: options.preQuarantinePackingLocked,
    });

    const alreadySame =
      safeOwnObj !== null &&
      safeOwnObj.configStatus === 'RECONCILIATION_REQUIRED' &&
      safeOwnObj.unitMigrationStatus === 'CONFLICTED' &&
      safeOwnObj.unitOperationalAllowed === false &&
      safeOwnObj.packingLocked === true;

    const updatedMedicineRecord =
      safeOwnObj !== null && !alreadySame
        ? buildUpdatedPlainMedicine(safeOwnObj, {
            configStatus: 'RECONCILIATION_REQUIRED',
            unitMigrationStatus: 'CONFLICTED',
            unitMigrationRunId: options.migrationRunId,
            unitMigratedAt:
              typeof safeOwnObj.unitMigratedAt === 'string'
                ? safeOwnObj.unitMigratedAt
                : options.nowIso,
            packingLocked: true,
            unitOperationalAllowed: false,
          })
        : null;

    return {
      classification: 'CONFLICTED',
      medicineId,
      configStatus: 'RECONCILIATION_REQUIRED',
      packingLocked: true,
      quarantinePreserved: false,
      reasonCode: insp.reasonCode,
      message: `Conflicted legacy unit configuration: ${insp.reasonCode}.`,
      alreadyMigratedUnchanged: alreadySame && Boolean(options.existingQuarantine),
      updatedMedicineRecord,
      quarantineRecord,
    };
  }

  // 3c. Unknown dosageForm -> MUST quarantine (never guess from name!)
  if (insp.dosageForm === 'Unknown') {
    const quarantineRecord = buildQuarantineRecord({
      medicineId,
      classification: 'QUARANTINED',
      preservedConfigStatus: 'QUARANTINED',
      claimedConfigStatus: rehydration.claimedConfigStatus,
      reasonCode: 'LEGACY_UNKNOWN_DOSAGE_FORM',
      message:
        'Dosage form is missing or Unknown; quarantined without guessing from medicine name.',
      nowIso: options.nowIso,
      migrationRunId: options.migrationRunId,
      rawSnapshot: safeSnapshot,
      existingQuarantine: options.existingQuarantine,
      preQuarantinePackingLocked: options.preQuarantinePackingLocked,
    });

    const alreadySame =
      safeOwnObj !== null &&
      safeOwnObj.configStatus === 'QUARANTINED' &&
      safeOwnObj.unitMigrationStatus === 'QUARANTINED' &&
      safeOwnObj.unitOperationalAllowed === false &&
      safeOwnObj.packingLocked === true;

    const updatedMedicineRecord =
      safeOwnObj !== null && !alreadySame
        ? buildUpdatedPlainMedicine(safeOwnObj, {
            configStatus: 'QUARANTINED',
            unitMigrationStatus: 'QUARANTINED',
            unitMigrationRunId: options.migrationRunId,
            unitMigratedAt:
              typeof safeOwnObj.unitMigratedAt === 'string'
                ? safeOwnObj.unitMigratedAt
                : options.nowIso,
            packingLocked: true,
            unitOperationalAllowed: false,
          })
        : null;

    return {
      classification: 'QUARANTINED',
      medicineId,
      configStatus: 'QUARANTINED',
      packingLocked: true,
      quarantinePreserved: true,
      reasonCode: 'LEGACY_UNKNOWN_DOSAGE_FORM',
      message: 'Unknown dosageForm quarantined without inferring from name.',
      alreadyMigratedUnchanged: alreadySame && Boolean(options.existingQuarantine),
      updatedMedicineRecord,
      quarantineRecord,
    };
  }

  const knownForm = insp.dosageForm;
  const baseUnit = KNOWN_BASE_UNIT_BY_FORM[knownForm];
  const isSolidForm = knownForm === 'Tablet' || knownForm === 'Capsule';

  // 3d. Known non-solid without confirmed V2 unitDefinition:
  // If explicit baseUnitsPerPack >= 1 is present, build conservative DIRECT_PACK UNVERIFIED_UNKNOWN;
  // otherwise quarantine without fabricating baseUnitsPerPack = 1!
  if (!isSolidForm) {
    const rawBasePackProp = getSafeOwnDataProp(rawMed, 'baseUnitsPerPack');
    const hasExplicitBaseUnits =
      rawBasePackProp.found &&
      typeof rawBasePackProp.value === 'number' &&
      Number.isSafeInteger(rawBasePackProp.value) &&
      rawBasePackProp.value >= 1;

    if (!hasExplicitBaseUnits) {
      const quarantineRecord = buildQuarantineRecord({
        medicineId,
        classification: 'QUARANTINED',
        preservedConfigStatus: 'QUARANTINED',
        claimedConfigStatus: rehydration.claimedConfigStatus,
        reasonCode: 'LEGACY_NON_SOLID_MISSING_BASE_UNITS_PER_PACK',
        message: `Non-solid dosage form '${knownForm}' lacks confirmed baseUnitsPerPack; quarantined without assuming 1.`,
        nowIso: options.nowIso,
        migrationRunId: options.migrationRunId,
        rawSnapshot: safeSnapshot,
        existingQuarantine: options.existingQuarantine,
        preQuarantinePackingLocked: options.preQuarantinePackingLocked,
      });

      const alreadySame =
        safeOwnObj !== null &&
        safeOwnObj.configStatus === 'QUARANTINED' &&
        safeOwnObj.unitMigrationStatus === 'QUARANTINED' &&
        safeOwnObj.unitOperationalAllowed === false &&
        safeOwnObj.packingLocked === true;

      const updatedMedicineRecord =
        safeOwnObj !== null && !alreadySame
          ? buildUpdatedPlainMedicine(safeOwnObj, {
              dosageForm: knownForm,
              configStatus: 'QUARANTINED',
              unitMigrationStatus: 'QUARANTINED',
              unitMigrationRunId: options.migrationRunId,
              unitMigratedAt:
                typeof safeOwnObj.unitMigratedAt === 'string'
                  ? safeOwnObj.unitMigratedAt
                  : options.nowIso,
              packingLocked: true,
              unitOperationalAllowed: false,
            })
          : null;

      return {
        classification: 'QUARANTINED',
        medicineId,
        configStatus: 'QUARANTINED',
        dosageForm: knownForm,
        packingLocked: true,
        quarantinePreserved: true,
        reasonCode: 'LEGACY_NON_SOLID_MISSING_BASE_UNITS_PER_PACK',
        message: 'Non-solid legacy record without baseUnitsPerPack quarantined.',
        alreadyMigratedUnchanged: alreadySame && Boolean(options.existingQuarantine),
        updatedMedicineRecord,
        quarantineRecord,
      };
    }

    const explicitBaseUnits = rawBasePackProp.value as number;
    const effectiveLocked = resolvedEffectiveLocked;
    const sellable = deriveConservativeSellableUnits(
      safeOwnObj || {},
      knownForm,
      baseUnit,
      false
    );
    const canonicalDef = createValidatedUnitDefinition({
      dosageForm: knownForm,
      baseUnit,
      packUnit: 'pack',
      intermediateUnit: null,
      baseUnitsPerPack: explicitBaseUnits,
      requestedSellableUnits: sellable,
      definitionVersion: 1,
      configStatus: 'UNVERIFIED_UNKNOWN',
      packingLocked: effectiveLocked,
    });
    const dto = serializeUnitDefinitionToDto(canonicalDef);
    const roundTrip = rehydrateUnitDefinitionFromDto(dto);
    if (!roundTrip.ok || roundTrip.isVerifiedForOperations) {
      throw new Error(`PR2B_ROUNDTRIP_GUARD_FAILED: Non-solid round-trip failed for ${medicineId}`);
    }

    const updatedMedicineRecord =
      safeOwnObj !== null
        ? buildUpdatedPlainMedicine(safeOwnObj, {
            dosageForm: knownForm,
            baseUnitsPerPack: dto.baseUnitsPerPack,
            configStatus: 'UNVERIFIED_UNKNOWN',
            unitDefinition: dto,
            unitDefinitionKey: dto.unitDefinitionKey,
            baseDimensionKey: dto.baseDimensionKey,
            packingLocked: dto.packingLocked,
            unitMigrationStatus: 'MIGRATED_CONSERVATIVE',
            unitMigrationRunId: options.migrationRunId,
            unitMigratedAt:
              typeof safeOwnObj.unitMigratedAt === 'string'
                ? safeOwnObj.unitMigratedAt
                : options.nowIso,
            unitOperationalAllowed: false,
          })
        : null;

    return {
      classification: 'MIGRATED_CONSERVATIVE',
      medicineId,
      configStatus: 'UNVERIFIED_UNKNOWN',
      unitDefinitionDto: dto,
      unitDefinitionKey: dto.unitDefinitionKey,
      baseDimensionKey: dto.baseDimensionKey,
      dosageForm: dto.dosageForm,
      baseUnitsPerPack: dto.baseUnitsPerPack,
      packingLocked: dto.packingLocked,
      quarantinePreserved: false,
      reasonCode: 'LEGACY_NON_SOLID_EXPLICIT_BASE_UNITS_MIGRATED',
      message: 'Non-solid legacy record with explicit baseUnitsPerPack migrated as UNVERIFIED_UNKNOWN.',
      alreadyMigratedUnchanged: false,
      updatedMedicineRecord,
      quarantineRecord: null,
    };
  }

  // 3e. Known solid (`Tablet` or `Capsule`)
  if (
    insp.legacyStripsPerPack === undefined ||
    insp.legacyPillsPerStrip === undefined ||
    insp.configStatus !== 'LEGACY_ASSUMED'
  ) {
    const quarantineRecord = buildQuarantineRecord({
      medicineId,
      classification: 'QUARANTINED',
      preservedConfigStatus: 'QUARANTINED',
      claimedConfigStatus: rehydration.claimedConfigStatus,
      reasonCode: 'LEGACY_SOLID_MISSING_FACTORS',
      message: `Solid dosage form '${knownForm}' is missing clear stripsPerPack/pillsPerStrip factors.`,
      nowIso: options.nowIso,
      migrationRunId: options.migrationRunId,
      rawSnapshot: safeSnapshot,
      existingQuarantine: options.existingQuarantine,
      preQuarantinePackingLocked: options.preQuarantinePackingLocked,
    });

    const alreadySame =
      safeOwnObj !== null &&
      safeOwnObj.configStatus === 'QUARANTINED' &&
      safeOwnObj.unitMigrationStatus === 'QUARANTINED' &&
      safeOwnObj.unitOperationalAllowed === false &&
      safeOwnObj.packingLocked === true;

    const updatedMedicineRecord =
      safeOwnObj !== null && !alreadySame
        ? buildUpdatedPlainMedicine(safeOwnObj, {
            dosageForm: knownForm,
            configStatus: 'QUARANTINED',
            unitMigrationStatus: 'QUARANTINED',
            unitMigrationRunId: options.migrationRunId,
            unitMigratedAt:
              typeof safeOwnObj.unitMigratedAt === 'string'
                ? safeOwnObj.unitMigratedAt
                : options.nowIso,
            packingLocked: true,
            unitOperationalAllowed: false,
          })
        : null;

    return {
      classification: 'QUARANTINED',
      medicineId,
      configStatus: 'QUARANTINED',
      dosageForm: knownForm,
      packingLocked: true,
      quarantinePreserved: true,
      reasonCode: 'LEGACY_SOLID_MISSING_FACTORS',
      message: 'Solid legacy record missing conversion factors quarantined.',
      alreadyMigratedUnchanged: alreadySame && Boolean(options.existingQuarantine),
      updatedMedicineRecord,
      quarantineRecord,
    };
  }

  // Never convert 1x1 automatically! Require confirmation via quarantine.
  if (insp.legacyStripsPerPack === 1 && insp.legacyPillsPerStrip === 1) {
    const quarantineRecord = buildQuarantineRecord({
      medicineId,
      classification: 'QUARANTINED',
      preservedConfigStatus: 'QUARANTINED',
      claimedConfigStatus: rehydration.claimedConfigStatus,
      reasonCode: 'LEGACY_UNCONFIRMED_1X1_FACTORS',
      message:
        'Legacy record with stripsPerPack=1 and pillsPerStrip=1 is unconfirmed and quarantined without automatic conversion.',
      nowIso: options.nowIso,
      migrationRunId: options.migrationRunId,
      rawSnapshot: safeSnapshot,
      existingQuarantine: options.existingQuarantine,
      preQuarantinePackingLocked: options.preQuarantinePackingLocked,
    });

    const alreadySame =
      safeOwnObj !== null &&
      safeOwnObj.configStatus === 'QUARANTINED' &&
      safeOwnObj.unitMigrationStatus === 'QUARANTINED' &&
      safeOwnObj.unitOperationalAllowed === false &&
      safeOwnObj.packingLocked === true;

    const updatedMedicineRecord =
      safeOwnObj !== null && !alreadySame
        ? buildUpdatedPlainMedicine(safeOwnObj, {
            dosageForm: knownForm,
            configStatus: 'QUARANTINED',
            unitMigrationStatus: 'QUARANTINED',
            unitMigrationRunId: options.migrationRunId,
            unitMigratedAt:
              typeof safeOwnObj.unitMigratedAt === 'string'
                ? safeOwnObj.unitMigratedAt
                : options.nowIso,
            packingLocked: true,
            unitOperationalAllowed: false,
          })
        : null;

    return {
      classification: 'QUARANTINED',
      medicineId,
      configStatus: 'QUARANTINED',
      dosageForm: knownForm,
      packingLocked: true,
      quarantinePreserved: true,
      reasonCode: 'LEGACY_UNCONFIRMED_1X1_FACTORS',
      message: 'Unconfirmed 1x1 legacy configuration quarantined.',
      alreadyMigratedUnchanged: alreadySame && Boolean(options.existingQuarantine),
      updatedMedicineRecord,
      quarantineRecord,
    };
  }

  // Valid known Tablet/Capsule with clear non-1x1 factors -> Conservative LEGACY_ASSUMED UnitDefinition
  const stripsPerPack = insp.legacyStripsPerPack;
  const pillsPerStrip = insp.legacyPillsPerStrip;
  const baseUnitsPerPackBig = BigInt(stripsPerPack) * BigInt(pillsPerStrip);
  if (baseUnitsPerPackBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    const quarantineRecord = buildQuarantineRecord({
      medicineId,
      classification: 'QUARANTINED',
      preservedConfigStatus: 'QUARANTINED',
      reasonCode: 'FACTOR_OVERFLOW',
      message: 'stripsPerPack * pillsPerStrip exceeds Number.MAX_SAFE_INTEGER.',
      nowIso: options.nowIso,
      migrationRunId: options.migrationRunId,
      rawSnapshot: safeSnapshot,
      existingQuarantine: options.existingQuarantine,
      preQuarantinePackingLocked: options.preQuarantinePackingLocked,
    });
    return {
      classification: 'QUARANTINED',
      medicineId,
      configStatus: 'QUARANTINED',
      packingLocked: true,
      quarantinePreserved: true,
      reasonCode: 'FACTOR_OVERFLOW',
      message: 'Conversion factor overflow quarantined.',
      alreadyMigratedUnchanged: false,
      updatedMedicineRecord: safeOwnObj
        ? buildUpdatedPlainMedicine(safeOwnObj, {
            configStatus: 'QUARANTINED',
            unitMigrationStatus: 'QUARANTINED',
            unitMigrationRunId: options.migrationRunId,
            unitMigratedAt: options.nowIso,
            packingLocked: true,
            unitOperationalAllowed: false,
          })
        : null,
      quarantineRecord,
    };
  }

  const baseUnitsPerPack = Number(baseUnitsPerPackBig);
  const effectiveLocked = resolvedEffectiveLocked;
  const sellable = deriveConservativeSellableUnits(
    safeOwnObj || {},
    knownForm,
    baseUnit,
    true
  );

  const canonicalDef = createValidatedUnitDefinition({
    dosageForm: knownForm,
    baseUnit,
    packUnit: 'pack',
    intermediateUnit: 'strip',
    stripsPerPack,
    pillsPerStrip,
    baseUnitsPerPack,
    requestedSellableUnits: sellable,
    definitionVersion: 1,
    configStatus: 'LEGACY_ASSUMED',
    packingLocked: effectiveLocked,
  });
  const dto = serializeUnitDefinitionToDto(canonicalDef);
  const roundTrip = rehydrateUnitDefinitionFromDto(dto);
  if (!roundTrip.ok || roundTrip.isVerifiedForOperations || roundTrip.trustStatus !== 'LEGACY_ASSUMED') {
    throw new Error(`PR2B_ROUNDTRIP_GUARD_FAILED: Solid round-trip failed for ${medicineId}`);
  }

  const alreadySame =
    safeOwnObj !== null &&
    safeOwnObj.dosageForm === dto.dosageForm &&
    safeOwnObj.baseUnitsPerPack === dto.baseUnitsPerPack &&
    safeOwnObj.configStatus === 'LEGACY_ASSUMED' &&
    safeOwnObj.unitDefinitionKey === dto.unitDefinitionKey &&
    safeOwnObj.baseDimensionKey === dto.baseDimensionKey &&
    safeOwnObj.packingLocked === dto.packingLocked &&
    safeOwnObj.unitMigrationStatus === 'MIGRATED_CONSERVATIVE' &&
    safeOwnObj.unitOperationalAllowed === false &&
    canonicalStableJson(safeOwnObj.unitDefinition) === canonicalStableJson(dto);

  const updatedMedicineRecord =
    safeOwnObj !== null && !alreadySame
      ? buildUpdatedPlainMedicine(safeOwnObj, {
          dosageForm: knownForm,
          baseUnitsPerPack: dto.baseUnitsPerPack,
          configStatus: 'LEGACY_ASSUMED',
          unitDefinition: dto,
          unitDefinitionKey: dto.unitDefinitionKey,
          baseDimensionKey: dto.baseDimensionKey,
          packingLocked: dto.packingLocked,
          unitMigrationStatus: 'MIGRATED_CONSERVATIVE',
          unitMigrationRunId: options.migrationRunId,
          unitMigratedAt:
            typeof safeOwnObj.unitMigratedAt === 'string'
              ? safeOwnObj.unitMigratedAt
              : options.nowIso,
          unitOperationalAllowed: false,
        })
      : null;

  return {
    classification: 'MIGRATED_CONSERVATIVE',
    medicineId,
    configStatus: 'LEGACY_ASSUMED',
    unitDefinitionDto: dto,
    unitDefinitionKey: dto.unitDefinitionKey,
    baseDimensionKey: dto.baseDimensionKey,
    dosageForm: dto.dosageForm,
    baseUnitsPerPack: dto.baseUnitsPerPack,
    packingLocked: dto.packingLocked,
    quarantinePreserved: false,
    reasonCode: 'LEGACY_KNOWN_SOLID_MIGRATED_CONSERVATIVELY',
    message: 'Known solid legacy record migrated conservatively as LEGACY_ASSUMED.',
    alreadyMigratedUnchanged: alreadySame,
    updatedMedicineRecord,
    quarantineRecord: null,
  };
}

interface V1LocalRetrySnapshot {
  readonly available: boolean;
  readonly medicineIds: ReadonlySet<string>;
  readonly discoveredContexts: ReadonlyArray<{ readonly uid: string; readonly branchId: string }>;
  readonly errors: ReadonlyArray<string>;
}

const CONTAINER_KEYS_WITH_MEDICINE_REFS = new Set<string>([
  'items',
  'medicines',
  'adjustments',
  'entries',
  'lines',
  'allocations',
  'deductions',
  'payload',
  'data',
  'after',
  'before',
  'snapshot',
]);

function extractMedicineRefsRecursive(
  value: unknown,
  depth: number,
  outIds: Set<string>,
  errors: string[],
  label: string
): void {
  if (value === null || value === undefined || depth > 6) return;
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(value, i);
      if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
        errors.push(`MALFORMED_ARRAY_ELEMENT:${label}[${i}]`);
        continue;
      }
      if (desc.value === null || typeof desc.value !== 'object') {
        errors.push(`MALFORMED_ARRAY_NON_OBJECT:${label}[${i}]`);
        continue;
      }
      extractMedicineRefsRecursive(desc.value, depth + 1, outIds, errors, `${label}[${i}]`);
    }
    return;
  }

  const obj = value as object;
  for (const field of ['medicineId', 'medicine_id', 'medId']) {
    const p = getSafeOwnDataProp(obj, field);
    if (p.found && p.value !== undefined && p.value !== null) {
      if (typeof p.value === 'string' && p.value.trim()) {
        outIds.add(p.value.trim());
      } else {
        errors.push(`INVALID_MEDICINE_REF:${label}.${field}`);
      }
    }
  }

  for (const key of CONTAINER_KEYS_WITH_MEDICINE_REFS) {
    const child = getSafeOwnDataProp(obj, key);
    if (!child.found || child.value === undefined || child.value === null) continue;
    if (typeof child.value !== 'object') {
      errors.push(`MALFORMED_CONTAINER:${label}.${key}`);
      continue;
    }
    extractMedicineRefsRecursive(child.value, depth + 1, outIds, errors, `${label}.${key}`);
  }
}

function readV1LocalStorageRetrySnapshot(): V1LocalRetrySnapshot {
  const medicineIds = new Set<string>();
  const discoveredContexts: Array<{ uid: string; branchId: string }> = [];
  const errors: string[] = [];

  let storage: Storage | undefined;
  try {
    storage = typeof globalThis !== 'undefined' ? globalThis.localStorage : undefined;
    if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function' || typeof storage.getItem !== 'function') {
      return {
        available: false,
        medicineIds,
        discoveredContexts,
        errors: ['LOCALSTORAGE_UNAVAILABLE'],
      };
    }
    const len = storage.length;
    for (let i = 0; i < len; i += 1) {
      const k = storage.key(i);
      if (typeof k !== 'string') {
        errors.push(`LOCALSTORAGE_INVALID_KEY_AT:${i}`);
        continue;
      }
      if (!k.startsWith(V1_CLOUD_SYNC_RETRY_QUEUE_PREFIX)) continue;

      const raw = storage.getItem(k);
      if (raw === null || raw === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        errors.push(`CORRUPT_V1_RETRY_JSON:${k}`);
        continue;
      }

      if (!Array.isArray(parsed)) {
        errors.push(`CORRUPT_V1_RETRY_NON_ARRAY:${k}`);
        continue;
      }

      for (let idx = 0; idx < parsed.length; idx += 1) {
        const entry = parsed[idx];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`MALFORMED_V1_RETRY_ITEM:${k}[${idx}]`);
          continue;
        }
        const originUidProp = getSafeOwnDataProp(entry, 'originUid');
        const branchIdProp = getSafeOwnDataProp(entry, 'branchId');
        const uid = originUidProp.found && typeof originUidProp.value === 'string' ? originUidProp.value.trim() : '';
        const branchId = branchIdProp.found && typeof branchIdProp.value === 'string' && branchIdProp.value.trim() ? branchIdProp.value.trim() : 'default';
        if (uid) {
          discoveredContexts.push({ uid, branchId });
        }

        const kindProp = getSafeOwnDataProp(entry, 'kind');
        const entityIdProp = getSafeOwnDataProp(entry, 'entityId');
        const kind = kindProp.found && typeof kindProp.value === 'string' ? kindProp.value : '';
        if (kind === 'medicine' || kind === 'archive_medicine') {
          if (entityIdProp.found && typeof entityIdProp.value === 'string' && entityIdProp.value.trim()) {
            medicineIds.add(entityIdProp.value.trim());
          } else {
            errors.push(`MALFORMED_V1_RETRY_MEDICINE_ENTITY_ID:${k}[${idx}]`);
          }
        }
        const beforeCount = errors.length;
        extractMedicineRefsRecursive(entry, 0, medicineIds, errors, `v1Retry(${k})[${idx}]`);
        const payloadProp = getSafeOwnDataProp(entry, 'payload');
        if (kind === 'sale') {
          if (!payloadProp.found || !payloadProp.value || typeof payloadProp.value !== 'object') {
            errors.push(`MALFORMED_V1_RETRY_SALE_PAYLOAD:${k}[${idx}]`);
          } else {
            const itemsProp = getSafeOwnDataProp(payloadProp.value, 'items');
            if (!itemsProp.found || !Array.isArray(itemsProp.value)) {
              errors.push(`MALFORMED_V1_RETRY_SALE_ITEMS:${k}[${idx}]`);
            } else {
              for (let j = 0; j < itemsProp.value.length; j += 1) {
                const it = itemsProp.value[j];
                const mp = getSafeOwnDataProp(it, 'medicineId');
                if (!mp.found || typeof mp.value !== 'string' || !mp.value.trim()) {
                  errors.push(`MALFORMED_V1_RETRY_SALE_LINE_ITEM:${k}[${idx}].items[${j}]`);
                } else {
                  medicineIds.add(mp.value.trim());
                }
              }
            }
          }
        } else if (!kind && errors.length === beforeCount && medicineIds.size === 0) {
          // Unknown item shape with neither kind nor medicine reference -> fail closed
          errors.push(`UNKNOWN_V1_RETRY_ENTRY_SHAPE:${k}[${idx}]`);
        }
      }
    }
  } catch (err) {
    errors.push(`LOCALSTORAGE_READ_THROWN:${err instanceof Error ? err.message : String(err)}`);
    return {
      available: false,
      medicineIds,
      discoveredContexts,
      errors,
    };
  }

  return {
    available: true,
    medicineIds,
    discoveredContexts,
    errors,
  };
}

function readExplicitV1InFlightSnapshot(
  options: Pick<
    InspectPackingLockOptions,
    'v1InFlightMedicineIds' | 'v1InFlightInspector' | 'v1InFlightAvailable' | 'v1ContextHints'
  >
): {
  explicitMedicineIds: ReadonlySet<string>;
  extraContexts: ReadonlyArray<{ readonly uid: string; readonly branchId: string }>;
  errors: ReadonlyArray<string>;
  scope: 'KNOWN_CONTEXT_AND_EXPLICIT' | 'UNINSPECTABLE_FAIL_CLOSED';
} {
  const explicitMedicineIds = new Set<string>();
  const errors: string[] = [];

  if (options.v1InFlightAvailable === false) {
    errors.push('V1_IN_FLIGHT_UNAVAILABLE');
  }

  if (options.v1InFlightMedicineIds !== undefined) {
    if (!Array.isArray(options.v1InFlightMedicineIds)) {
      errors.push('INVALID_V1_IN_FLIGHT_LIST');
    } else {
      for (const id of options.v1InFlightMedicineIds) {
        if (typeof id === 'string' && id.trim()) {
          explicitMedicineIds.add(id.trim());
        } else {
          errors.push('MALFORMED_V1_IN_FLIGHT_ID');
        }
      }
    }
  }

  if (options.v1InFlightInspector !== undefined) {
    try {
      const inspected = options.v1InFlightInspector();
      if (!Array.isArray(inspected)) {
        errors.push('V1_IN_FLIGHT_INSPECTOR_NON_ARRAY');
      } else {
        for (const id of inspected) {
          if (typeof id === 'string' && id.trim()) {
            explicitMedicineIds.add(id.trim());
          } else {
            errors.push('V1_IN_FLIGHT_INSPECTOR_INVALID_ID');
          }
        }
      }
    } catch (err) {
      errors.push(`V1_IN_FLIGHT_INSPECTOR_THROWN:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const extraContexts = Array.isArray(options.v1ContextHints) ? [...options.v1ContextHints] : [];
  return {
    explicitMedicineIds,
    extraContexts,
    errors,
    scope: errors.length > 0 ? 'UNINSPECTABLE_FAIL_CLOSED' : 'KNOWN_CONTEXT_AND_EXPLICIT',
  };
}

export type V1EntitySyncInFlightChecker = (
  originUid: string,
  branchId: string,
  entityType: 'sale' | 'medicine',
  entityId: string
) => boolean;

export type V1InFlightOperationsEnumerator = (options?: {
  nowMs?: number;
}) => V1InFlightEnumerationResult;

let customV1InFlightChecker: V1EntitySyncInFlightChecker | null = null;
let defaultV1InFlightChecker: V1EntitySyncInFlightChecker | null = null;
let customV1InFlightEnumerator: V1InFlightOperationsEnumerator | null = null;
let defaultV1InFlightEnumerator: V1InFlightOperationsEnumerator | null = null;
let defaultV1LeaseValidator:
  | ((raw: unknown) => { valid: true; record: V1InFlightLeaseRecord } | { valid: false; reason: string })
  | null = null;
let v1InFlightRegistryAvailableOverride: boolean | null = null;

export function setV1EntitySyncInFlightChecker(
  checker: V1EntitySyncInFlightChecker | null
): void {
  customV1InFlightChecker = checker;
}

export function setV1InFlightOperationsEnumerator(
  enumerator: V1InFlightOperationsEnumerator | null
): void {
  customV1InFlightEnumerator = enumerator;
}

export function setV1InFlightRegistryAvailableForTests(
  available: boolean | null
): void {
  v1InFlightRegistryAvailableOverride = available;
}

const V1_IN_FLIGHT_RUNTIME_BRIDGE_SYMBOL = Symbol.for(
  'khalid_pharmacy.v1_in_flight_runtime_bridge_v1'
);

async function ensureV1InFlightCheckerResolved(): Promise<void> {
  if (v1InFlightRegistryAvailableOverride === false) {
    throw new Error('V1_IN_FLIGHT_REGISTRY_UNAVAILABLE');
  }
  const bridge = (globalThis as Record<symbol, unknown>)[V1_IN_FLIGHT_RUNTIME_BRIDGE_SYMBOL] as
    | {
        isV1EntitySyncInFlight?: V1EntitySyncInFlightChecker;
        enumerateV1InFlightOperations?: V1InFlightOperationsEnumerator;
        validateV1InFlightLeaseRecord?: (
          raw: unknown
        ) => { valid: true; record: V1InFlightLeaseRecord } | { valid: false; reason: string };
      }
    | undefined;
  if (
    bridge &&
    typeof bridge.isV1EntitySyncInFlight === 'function' &&
    typeof bridge.enumerateV1InFlightOperations === 'function'
  ) {
    defaultV1InFlightChecker = bridge.isV1EntitySyncInFlight;
    defaultV1InFlightEnumerator = bridge.enumerateV1InFlightOperations;
    if (typeof bridge.validateV1InFlightLeaseRecord === 'function') {
      defaultV1LeaseValidator = bridge.validateV1InFlightLeaseRecord;
    }
    return;
  }
  // When branchSyncService has not been imported yet in this JS realm, no in-memory V1 Map syncs can exist;
  // inspect shared cross-tab localStorage + IDB leases directly without triggering firebaseAuthService side effects.
  defaultV1InFlightEnumerator = fallbackEnumerateV1InFlightStorageLeases;
}

function validateIdbV1LeaseRecord(
  raw: unknown
): { valid: true; record: V1InFlightLeaseRecord } | { valid: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: 'NON_OBJECT' };
  }
  if (defaultV1LeaseValidator) {
    return defaultV1LeaseValidator(raw);
  }
  const sv = getSafeOwnDataProp(raw, 'schemaVersion');
  const leaseId = getSafeOwnDataProp(raw, 'leaseId');
  const operationId = getSafeOwnDataProp(raw, 'operationId');
  const tabId = getSafeOwnDataProp(raw, 'tabInstanceId');
  const kind = getSafeOwnDataProp(raw, 'kind');
  const entityType = getSafeOwnDataProp(raw, 'entityType');
  const entityId = getSafeOwnDataProp(raw, 'entityId');
  const originUid = getSafeOwnDataProp(raw, 'originUid');
  const branchId = getSafeOwnDataProp(raw, 'branchId');
  const medicineIds = getSafeOwnDataProp(raw, 'medicineIds');
  const createdAtMs = getSafeOwnDataProp(raw, 'createdAtMs');
  const heartbeatAtMs = getSafeOwnDataProp(raw, 'heartbeatAtMs');
  const expiresAtMs = getSafeOwnDataProp(raw, 'expiresAtMs');

  if (sv.value !== 1) return { valid: false, reason: 'INVALID_SCHEMA_VERSION' };
  if (typeof leaseId.value !== 'string' || !leaseId.value.trim()) return { valid: false, reason: 'INVALID_LEASE_ID' };
  if (typeof tabId.value !== 'string' || !tabId.value.trim()) return { valid: false, reason: 'INVALID_TAB_ID' };
  if (kind.value !== 'medicine' && kind.value !== 'sale' && kind.value !== 'archive_medicine') {
    return { valid: false, reason: 'INVALID_KIND' };
  }
  const expectedEntityType = kind.value === 'sale' ? 'sale' : 'medicine';
  if (entityType.value !== expectedEntityType) {
    return { valid: false, reason: 'INVALID_ENTITY_TYPE' };
  }
  if (typeof entityId.value !== 'string' || !entityId.value.trim()) return { valid: false, reason: 'INVALID_ENTITY_ID' };
  if (typeof originUid.value !== 'string' || !originUid.value.trim()) return { valid: false, reason: 'INVALID_ORIGIN_UID' };
  if (typeof branchId.value !== 'string' || !branchId.value.trim()) return { valid: false, reason: 'INVALID_BRANCH_ID' };
  if (!Array.isArray(medicineIds.value) || medicineIds.value.length === 0) {
    return { valid: false, reason: 'INVALID_MEDICINE_IDS' };
  }
  const cleanMedIds: string[] = [];
  for (const m of medicineIds.value) {
    if (typeof m !== 'string' || !m.trim()) return { valid: false, reason: 'MALFORMED_MEDICINE_ID' };
    cleanMedIds.push(m.trim());
  }
  if (
    typeof createdAtMs.value !== 'number' ||
    !Number.isFinite(createdAtMs.value) ||
    typeof heartbeatAtMs.value !== 'number' ||
    !Number.isFinite(heartbeatAtMs.value) ||
    typeof expiresAtMs.value !== 'number' ||
    !Number.isFinite(expiresAtMs.value) ||
    expiresAtMs.value < createdAtMs.value
  ) {
    return { valid: false, reason: 'INVALID_TIMESTAMPS' };
  }
  return {
    valid: true,
    record: {
      schemaVersion: 1,
      leaseId: leaseId.value.trim(),
      operationId:
        typeof operationId.value === 'string' && operationId.value.trim()
          ? operationId.value.trim()
          : leaseId.value.trim(),
      tabInstanceId: tabId.value.trim(),
      kind: kind.value,
      entityType: expectedEntityType,
      entityId: entityId.value.trim(),
      originUid: originUid.value.trim(),
      branchId: branchId.value.trim(),
      medicineIds: Array.from(new Set(cleanMedIds)),
      createdAtMs: createdAtMs.value,
      heartbeatAtMs: heartbeatAtMs.value,
      expiresAtMs: expiresAtMs.value,
    },
  };
}

function fallbackEnumerateV1InFlightStorageLeases(options?: {
  nowMs?: number;
}): V1InFlightEnumerationResult {
  const nowMs =
    typeof options?.nowMs === 'number' && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const byLeaseId = new Map<string, V1InFlightLeaseRecord>();
  const errors: string[] = [];
  let storageAvailable = true;

  try {
    const storage = typeof globalThis !== 'undefined' ? globalThis.localStorage : undefined;
    if (
      !storage ||
      typeof storage.length !== 'number' ||
      typeof storage.key !== 'function' ||
      typeof storage.getItem !== 'function'
    ) {
      storageAvailable = false;
      errors.push('V1_LEASE_LOCALSTORAGE_UNAVAILABLE');
    } else {
      const len = storage.length;
      for (let i = 0; i < len; i += 1) {
        const k = storage.key(i);
        if (typeof k !== 'string') {
          errors.push(`V1_LEASE_INVALID_STORAGE_KEY:${i}`);
          continue;
        }
        if (!k.startsWith(V1_IN_FLIGHT_LEASE_STORAGE_PREFIX)) continue;
        const raw = storage.getItem(k);
        if (raw === null || raw === '') {
          errors.push(`EMPTY_V1_IN_FLIGHT_LEASE:${k}`);
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          errors.push(`CORRUPT_V1_IN_FLIGHT_LEASE_JSON:${k}`);
          continue;
        }
        const validated = validateIdbV1LeaseRecord(parsed);
        if (!validated.valid) {
          errors.push(`MALFORMED_V1_IN_FLIGHT_LEASE:${k}:${validated.reason}`);
          continue;
        }
        const existing = byLeaseId.get(validated.record.leaseId);
        if (!existing || validated.record.heartbeatAtMs >= existing.heartbeatAtMs) {
          byLeaseId.set(validated.record.leaseId, validated.record);
        }
      }
    }
  } catch (err) {
    storageAvailable = false;
    errors.push(`V1_LEASE_LOCALSTORAGE_THROWN:${err instanceof Error ? err.message : String(err)}`);
  }

  const activeLeases: V1InFlightLeaseRecord[] = [];
  const expiredLeases: V1InFlightLeaseRecord[] = [];
  const activeMedicineIdSet = new Set<string>();
  const contextMap = new Map<string, { uid: string; branchId: string }>();

  for (const rec of byLeaseId.values()) {
    contextMap.set(`${rec.originUid}::${rec.branchId}`, {
      uid: rec.originUid,
      branchId: rec.branchId,
    });
    if (rec.expiresAtMs <= nowMs) {
      expiredLeases.push(rec);
    } else {
      activeLeases.push(rec);
      for (const mid of rec.medicineIds) {
        activeMedicineIdSet.add(mid);
      }
    }
  }

  return {
    available: storageAvailable,
    activeLeases,
    expiredLeases,
    activeMedicineIds: Array.from(activeMedicineIdSet).sort(),
    discoveredContexts: Array.from(contextMap.values()),
    errors,
  };
}

interface EvidenceEvaluationResult {
  readonly sourcesByMedicine: ReadonlyMap<string, Set<PackingLockEvidenceSource>>;
  readonly perMedicineUnknownReasons: ReadonlyMap<string, string[]>;
  readonly globalUnknownReasons: ReadonlyArray<string>;
  readonly v1InFlightScope: 'KNOWN_CONTEXT_AND_EXPLICIT' | 'UNINSPECTABLE_FAIL_CLOSED';
  readonly buildReportForMedicine: (medicineId: string, rawMed: unknown, existingQuarantine?: MedicineQuarantineRecord | null) => PackingLockEvidenceReport;
}

function evaluateAllPackingLockEvidenceSnapshot(params: {
  readonly presentStores: ReadonlySet<string>;
  readonly medicines: ReadonlyArray<unknown>;
  readonly ledger: ReadonlyArray<unknown>;
  readonly sales: ReadonlyArray<unknown>;
  readonly purchaseInvoices: ReadonlyArray<unknown>;
  readonly outbox: ReadonlyArray<unknown>;
  readonly stocktakingSessions: ReadonlyArray<unknown>;
  readonly stocktakingItems: ReadonlyArray<unknown>;
  readonly supplierInvoiceDrafts: ReadonlyArray<unknown>;
  readonly backupReviewMetadata: ReadonlyArray<unknown>;
  readonly existingQuarantines: ReadonlyMap<string, MedicineQuarantineRecord>;
  readonly idbV1LeaseRows?: ReadonlyArray<unknown>;
  readonly localRetrySnapshot: V1LocalRetrySnapshot;
  readonly v1InFlightMedicineIds?: ReadonlyArray<string>;
  readonly v1InFlightInspector?: () => ReadonlyArray<string>;
  readonly v1InFlightEnumerator?: (() => V1InFlightEnumerationResult) | null;
  readonly v1InFlightAvailable?: boolean;
  readonly v1InFlightNowMs?: number;
  readonly v1ContextHints?: ReadonlyArray<{ readonly uid: string; readonly branchId: string }>;
  readonly excludeQuarantineSelfLockForRecovery?: boolean;
}): EvidenceEvaluationResult {
  const sourcesByMedicine = new Map<string, Set<PackingLockEvidenceSource>>();
  const perMedicineUnknownReasons = new Map<string, string[]>();
  const globalUnknownReasons: string[] = [];
  const excludeSelfQuarantine = params.excludeQuarantineSelfLockForRecovery === true;
  const nowMs =
    typeof params.v1InFlightNowMs === 'number' && Number.isFinite(params.v1InFlightNowMs)
      ? params.v1InFlightNowMs
      : Date.now();

  const addSource = (medId: string, src: PackingLockEvidenceSource) => {
    const s = sourcesByMedicine.get(medId) ?? new Set<PackingLockEvidenceSource>();
    s.add(src);
    sourcesByMedicine.set(medId, s);
  };

  const addMedUnknown = (medId: string, reason: string) => {
    const list = perMedicineUnknownReasons.get(medId) ?? [];
    list.push(reason);
    perMedicineUnknownReasons.set(medId, list);
  };

  // Verify every required store exists in IndexedDB
  for (const requiredStore of REQUIRED_EVIDENCE_STORES) {
    if (!params.presentStores.has(requiredStore)) {
      globalUnknownReasons.push(`MISSING_REQUIRED_STORE:${requiredStore}`);
    }
  }

  // Known candidate medicine IDs + V1 contexts collected dynamically
  const candidateMedIds = new Set<string>();
  const discoveredV1Contexts: Array<{ uid: string; branchId: string }> = [
    ...params.localRetrySnapshot.discoveredContexts,
  ];
  try {
    const trusted = getTrustedActorSessionState();
    const knownUid = getKnownActiveActorId();
    const activeBranch = getActiveBranchId() || 'default';
    if (trusted?.uid) {
      discoveredV1Contexts.push({ uid: trusted.uid, branchId: trusted.activeBranchId || activeBranch });
      discoveredV1Contexts.push({ uid: trusted.uid, branchId: activeBranch });
      discoveredV1Contexts.push({ uid: trusted.uid, branchId: 'default' });
    }
    if (knownUid) {
      discoveredV1Contexts.push({ uid: knownUid, branchId: activeBranch });
      discoveredV1Contexts.push({ uid: knownUid, branchId: 'default' });
    }
  } catch {
    globalUnknownReasons.push('ACTOR_CONTEXT_UNINSPECTABLE');
  }

  // 1. INVENTORY_LEDGER + Net ledger movement balance check
  const netLedgerBaseUnits = new Map<string, number>();
  for (let i = 0; i < params.ledger.length; i += 1) {
    const mov = params.ledger[i];
    if (!mov || typeof mov !== 'object' || Array.isArray(mov)) {
      globalUnknownReasons.push(`MALFORMED_LEDGER_ROW:${i}`);
      continue;
    }
    const medProp = getSafeOwnDataProp(mov, 'medicineId');
    if (!medProp.found || typeof medProp.value !== 'string' || !medProp.value.trim()) {
      globalUnknownReasons.push(`MALFORMED_LEDGER_MISSING_MEDICINE_ID:${i}`);
      continue;
    }
    const medId = medProp.value.trim();
    addSource(medId, 'INVENTORY_LEDGER');
    candidateMedIds.add(medId);

    const baseDeltaProp = getSafeOwnDataProp(mov, 'baseUnitsDelta');
    const qtyDeltaProp = getSafeOwnDataProp(mov, 'quantityDelta');
    const deltaVal = baseDeltaProp.found ? baseDeltaProp.value : qtyDeltaProp.found ? qtyDeltaProp.value : undefined;
    if (deltaVal !== undefined && deltaVal !== null) {
      if (typeof deltaVal !== 'number' || !Number.isFinite(deltaVal)) {
        addMedUnknown(medId, `CORRUPT_LEDGER_DELTA:${i}`);
      } else {
        netLedgerBaseUnits.set(medId, (netLedgerBaseUnits.get(medId) ?? 0) + deltaVal);
      }
    }
  }
  for (const [medId, net] of netLedgerBaseUnits.entries()) {
    if (net !== 0) {
      addSource(medId, 'NONZERO_STOCK_BALANCE');
    }
  }

  // 2. MEDICINES store (stock balance, existing lock flags, quarantine/reconciliation status)
  for (let i = 0; i < params.medicines.length; i += 1) {
    const rawMed = params.medicines[i];
    if (!rawMed || typeof rawMed !== 'object' || Array.isArray(rawMed)) {
      globalUnknownReasons.push(`MALFORMED_MEDICINE_RECORD:${i}`);
      continue;
    }
    const idProp = getSafeOwnDataProp(rawMed, 'id');
    if (!idProp.found || typeof idProp.value !== 'string' || !idProp.value.trim()) {
      globalUnknownReasons.push(`MALFORMED_MEDICINE_MISSING_ID:${i}`);
      continue;
    }
    const medId = idProp.value.trim();
    candidateMedIds.add(medId);

    const flags = inspectMedicineStockAndLockFlags(rawMed);
    for (const err of flags.corruptReasons) {
      addMedUnknown(medId, err);
    }
    if (flags.hasNonZeroStock) {
      addSource(medId, 'NONZERO_STOCK_BALANCE');
    }
    const existingQ = params.existingQuarantines.get(medId);
    if (
      flags.hasCloudOrPermanentLockFlag ||
      (flags.hasExistingLockFlag &&
        (!excludeSelfQuarantine || !existingQ || existingQ.preQuarantinePackingLocked !== false))
    ) {
      addSource(medId, 'EXISTING_PACKING_LOCK');
    }
    if (flags.hasQuarantineStatus && !excludeSelfQuarantine) {
      addSource(medId, 'QUARANTINE_OR_RECONCILIATION_STATE');
    }
  }

  // 3. EXISTING QUARANTINE / RECONCILIATION METADATA
  for (const [medId, qRec] of params.existingQuarantines.entries()) {
    candidateMedIds.add(medId);
    if (!qRec || typeof qRec !== 'object' || qRec.medicineId !== medId) {
      addMedUnknown(medId, 'CORRUPT_QUARANTINE_METADATA');
      continue;
    }
    if (!excludeSelfQuarantine) {
      if (qRec.reviewStatus !== 'RESOLVED') {
        addSource(medId, 'QUARANTINE_OR_RECONCILIATION_STATE');
      }
    } else if (qRec.preQuarantinePackingLocked !== false) {
      addSource(medId, 'EXISTING_PACKING_LOCK');
    }
  }

  // 4. SALES
  const parsedSales: Array<{ saleId: string; medicineIds: string[] }> = [];
  for (let i = 0; i < params.sales.length; i += 1) {
    const sale = params.sales[i];
    if (!sale || typeof sale !== 'object' || Array.isArray(sale)) {
      globalUnknownReasons.push(`MALFORMED_SALE_ROW:${i}`);
      continue;
    }
    const saleIdProp = getSafeOwnDataProp(sale, 'id');
    const saleId = saleIdProp.found && typeof saleIdProp.value === 'string' ? saleIdProp.value.trim() : '';
    const itemsProp = getSafeOwnDataProp(sale, 'items');
    if (!itemsProp.found || !Array.isArray(itemsProp.value)) {
      globalUnknownReasons.push(`MALFORMED_SALE_ITEMS:${i}`);
      continue;
    }
    const saleMeds: string[] = [];
    for (let j = 0; j < itemsProp.value.length; j += 1) {
      const it = itemsProp.value[j];
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        globalUnknownReasons.push(`MALFORMED_SALE_LINE_ITEM:${i}[${j}]`);
        continue;
      }
      const mp = getSafeOwnDataProp(it, 'medicineId');
      if (!mp.found || typeof mp.value !== 'string' || !mp.value.trim()) {
        globalUnknownReasons.push(`MALFORMED_SALE_MISSING_MEDICINE_ID:${i}[${j}]`);
        continue;
      }
      const medId = mp.value.trim();
      addSource(medId, 'SALES');
      candidateMedIds.add(medId);
      saleMeds.push(medId);
    }
    if (saleId && saleMeds.length > 0) {
      parsedSales.push({ saleId, medicineIds: saleMeds });
    }
  }

  // 5. PURCHASE_INVOICES
  for (let i = 0; i < params.purchaseInvoices.length; i += 1) {
    const inv = params.purchaseInvoices[i];
    if (!inv || typeof inv !== 'object' || Array.isArray(inv)) {
      globalUnknownReasons.push(`MALFORMED_PURCHASE_INVOICE_ROW:${i}`);
      continue;
    }
    const itemsProp = getSafeOwnDataProp(inv, 'items');
    if (!itemsProp.found || !Array.isArray(itemsProp.value)) {
      globalUnknownReasons.push(`MALFORMED_PURCHASE_INVOICE_ITEMS:${i}`);
      continue;
    }
    for (let j = 0; j < itemsProp.value.length; j += 1) {
      const it = itemsProp.value[j];
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        globalUnknownReasons.push(`MALFORMED_PURCHASE_INVOICE_LINE_ITEM:${i}[${j}]`);
        continue;
      }
      const mp = getSafeOwnDataProp(it, 'medicineId');
      if (!mp.found || typeof mp.value !== 'string' || !mp.value.trim()) {
        globalUnknownReasons.push(`MALFORMED_PURCHASE_INVOICE_MISSING_MEDICINE_ID:${i}[${j}]`);
        continue;
      }
      const medId = mp.value.trim();
      addSource(medId, 'PURCHASE_INVOICES');
      candidateMedIds.add(medId);
    }
  }

  // 5a. Unposted supplier invoice OCR drafts hold the medicine packing definition
  // stable while a pharmacist is reviewing a draft against the catalog.
  for (let i = 0; i < params.supplierInvoiceDrafts.length; i += 1) {
    const draft = params.supplierInvoiceDrafts[i];
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      globalUnknownReasons.push(`MALFORMED_SUPPLIER_INVOICE_DRAFT:${i}`);
      continue;
    }
    const statusProp = getSafeOwnDataProp(draft, 'status');
    const status = statusProp.found && typeof statusProp.value === 'string' ? statusProp.value : '';
    if (status === 'POSTED' || status === 'FAILED' || status === 'DUPLICATE') continue;
    if (!['DRAFT', 'PROCESSING', 'NEEDS_REVIEW', 'VERIFIED'].includes(status)) {
      globalUnknownReasons.push(`UNKNOWN_SUPPLIER_INVOICE_DRAFT_STATUS:${i}`);
      continue;
    }
    const itemsProp = getSafeOwnDataProp(draft, 'items');
    if (!itemsProp.found || !Array.isArray(itemsProp.value)) {
      globalUnknownReasons.push(`MALFORMED_SUPPLIER_INVOICE_DRAFT_ITEMS:${i}`);
      continue;
    }
    for (let j = 0; j < itemsProp.value.length; j += 1) {
      const item = itemsProp.value[j];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        globalUnknownReasons.push(`MALFORMED_SUPPLIER_INVOICE_DRAFT_ITEM:${i}[${j}]`);
        continue;
      }
      const matchProp = getSafeOwnDataProp(item, 'matchedMedicineId');
      if (matchProp.found && matchProp.value !== undefined && matchProp.value !== null) {
        if (typeof matchProp.value !== 'string' || !matchProp.value.trim()) {
          globalUnknownReasons.push(`MALFORMED_SUPPLIER_INVOICE_DRAFT_MEDICINE_ID:${i}[${j}]`);
          continue;
        }
        addSource(matchProp.value.trim(), 'UNPOSTED_OCR_DRAFT');
        candidateMedIds.add(matchProp.value.trim());
      }
    }
  }

  // 5b. Unresolved archive/backup review metadata is fail-closed for any malformed,
  // cross-session, unidentifiable, or active unresolved backup review row.
  for (let i = 0; i < params.backupReviewMetadata.length; i += 1) {
    const row = params.backupReviewMetadata[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      globalUnknownReasons.push(`MALFORMED_METADATA_ROW:${i}`);
      continue;
    }
    const keyProp = getSafeOwnDataProp(row, 'key');
    if (!keyProp.found || typeof keyProp.value !== 'string') {
      globalUnknownReasons.push(`MALFORMED_METADATA_KEY:${i}`);
      continue;
    }
    if (!keyProp.value.startsWith(UNIT_MIGRATION_STOCKTAKING_REVIEW_PREFIX)) continue;

    const keySessionId = keyProp.value.slice(UNIT_MIGRATION_STOCKTAKING_REVIEW_PREFIX.length).trim();
    const reviewProp = getSafeOwnDataProp(row, 'reviewRequired');
    if (!reviewProp.found || typeof reviewProp.value !== 'boolean') {
      globalUnknownReasons.push(`MALFORMED_BACKUP_REVIEW_FLAG:${keySessionId || i}`);
      continue;
    }

    const sessionProp = getSafeOwnDataProp(row, 'sessionId');
    const sessionId =
      sessionProp.found && typeof sessionProp.value === 'string' ? sessionProp.value.trim() : '';

    if (reviewProp.value === false) {
      if (!keySessionId || !sessionId || sessionId !== keySessionId) {
        globalUnknownReasons.push(
          `CORRUPT_BACKUP_REVIEW_SESSION_MISMATCH:${keySessionId || i}:${sessionId || 'missing'}`
        );
      }
      const archPropFalse = getSafeOwnDataProp(row, 'archiveIndexKey');
      if (archPropFalse.found && archPropFalse.value !== null && archPropFalse.value !== undefined) {
        const expectedIdxKey = `${UNIT_MIGRATION_STOCKTAKING_ARCHIVE_INDEX_PREFIX}${sessionId || keySessionId}`;
        if (typeof archPropFalse.value !== 'string' || archPropFalse.value.trim() !== expectedIdxKey) {
          globalUnknownReasons.push(`CORRUPT_BACKUP_REVIEW_ARCHIVE_KEY:${sessionId || keySessionId || i}`);
        }
      }
      continue;
    }

    // reviewRequired === true
    if (!keySessionId) {
      globalUnknownReasons.push(`CORRUPT_BACKUP_REVIEW_EMPTY_KEY_SESSION:${i}`);
      continue;
    }
    if (!sessionId) {
      globalUnknownReasons.push(`UNRESOLVED_BACKUP_REVIEW_MISSING_SESSION_ID:${keySessionId || i}`);
      continue;
    }
    if (keySessionId !== sessionId) {
      globalUnknownReasons.push(`CORRUPT_BACKUP_REVIEW_CROSS_SESSION_MISMATCH:${keySessionId}:${sessionId}`);
      continue;
    }
    const archPropTrue = getSafeOwnDataProp(row, 'archiveIndexKey');
    if (archPropTrue.found && archPropTrue.value !== null && archPropTrue.value !== undefined) {
      const expectedIdxKey = `${UNIT_MIGRATION_STOCKTAKING_ARCHIVE_INDEX_PREFIX}${sessionId}`;
      if (typeof archPropTrue.value !== 'string' || archPropTrue.value.trim() !== expectedIdxKey) {
        globalUnknownReasons.push(`CORRUPT_BACKUP_REVIEW_ARCHIVE_KEY:${sessionId}`);
        continue;
      }
    }

    const matchingSession = params.stocktakingSessions.find((session) => {
      const id = getSafeOwnDataProp(session, 'id');
      return id.found && typeof id.value === 'string' && id.value.trim() === sessionId;
    });
    const statusProp = matchingSession ? getSafeOwnDataProp(matchingSession, 'status') : { found: false, value: undefined };
    const status = statusProp.found && typeof statusProp.value === 'string' ? statusProp.value : '';
    if (matchingSession && HISTORICAL_STOCKTAKING_STATUSES.has(status)) {
      continue;
    }

    let attributedMedicinesCount = 0;

    if (matchingSession) {
      const session = matchingSession as Record<string, unknown>;
      const itemsProp = getSafeOwnDataProp(session, 'items');
      if (itemsProp.found && itemsProp.value !== undefined && itemsProp.value !== null) {
        if (!Array.isArray(itemsProp.value)) {
          globalUnknownReasons.push(`MALFORMED_BACKUP_REVIEW_SESSION_ITEMS:${sessionId}`);
        } else {
          for (let j = 0; j < itemsProp.value.length; j += 1) {
            const item = itemsProp.value[j];
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              globalUnknownReasons.push(`MALFORMED_BACKUP_REVIEW_INLINE_ITEM:${sessionId}[${j}]`);
              continue;
            }
            const itemSessProp = getSafeOwnDataProp(item, 'sessionId');
            if (
              itemSessProp.found &&
              typeof itemSessProp.value === 'string' &&
              itemSessProp.value.trim() &&
              itemSessProp.value.trim() !== sessionId
            ) {
              globalUnknownReasons.push(`CORRUPT_BACKUP_REVIEW_CROSS_SESSION_ITEM:${sessionId}`);
              continue;
            }
            const medicineProp = getSafeOwnDataProp(item, 'medicineId');
            if (!medicineProp.found || typeof medicineProp.value !== 'string' || !medicineProp.value.trim()) {
              globalUnknownReasons.push(`MALFORMED_BACKUP_REVIEW_MISSING_MEDICINE_ID:${sessionId}[${j}]`);
              continue;
            }
            addSource(medicineProp.value.trim(), 'UNRESOLVED_BACKUP_REVIEW');
            candidateMedIds.add(medicineProp.value.trim());
            attributedMedicinesCount += 1;
          }
        }
      }
    }

    for (let j = 0; j < params.stocktakingItems.length; j += 1) {
      const subItem = params.stocktakingItems[j];
      if (!subItem || typeof subItem !== 'object' || Array.isArray(subItem)) continue;
      const subSessProp = getSafeOwnDataProp(subItem, 'sessionId');
      if (!subSessProp.found || typeof subSessProp.value !== 'string' || subSessProp.value.trim() !== sessionId) {
        continue;
      }
      const subMedProp = getSafeOwnDataProp(subItem, 'medicineId');
      if (!subMedProp.found || typeof subMedProp.value !== 'string' || !subMedProp.value.trim()) {
        globalUnknownReasons.push(`MALFORMED_BACKUP_REVIEW_SUBITEM_MISSING_MEDICINE_ID:${sessionId}:${j}`);
        continue;
      }
      addSource(subMedProp.value.trim(), 'UNRESOLVED_BACKUP_REVIEW');
      candidateMedIds.add(subMedProp.value.trim());
      attributedMedicinesCount += 1;
    }

    // Also inspect any archive chunks for this sessionId inside metadata
    for (const metaRow of params.backupReviewMetadata) {
      if (!metaRow || typeof metaRow !== 'object' || Array.isArray(metaRow)) continue;
      const mk = getSafeOwnDataProp(metaRow, 'key');
      if (!mk.found || typeof mk.value !== 'string') continue;
      if (!mk.value.startsWith(UNIT_MIGRATION_STOCKTAKING_ARCHIVE_CHUNK_PREFIX)) continue;
      const chSess = getSafeOwnDataProp(metaRow, 'sessionId');
      if (!chSess.found || chSess.value !== sessionId) continue;
      const entriesProp = getSafeOwnDataProp(metaRow, 'entries');
      if (!entriesProp.found || !Array.isArray(entriesProp.value)) {
        globalUnknownReasons.push(`MALFORMED_BACKUP_REVIEW_ARCHIVE_CHUNK:${sessionId}`);
        continue;
      }
      for (const chEntry of entriesProp.value) {
        if (!chEntry || typeof chEntry !== 'object' || Array.isArray(chEntry)) {
          globalUnknownReasons.push(`MALFORMED_BACKUP_REVIEW_ARCHIVE_ENTRY:${sessionId}`);
          continue;
        }
        const entrySess = getSafeOwnDataProp(chEntry, 'sessionId');
        if (entrySess.found && typeof entrySess.value === 'string' && entrySess.value !== sessionId) {
          globalUnknownReasons.push(`CORRUPT_BACKUP_REVIEW_CROSS_SESSION_ARCHIVE:${sessionId}`);
          continue;
        }
        const entryMed = getSafeOwnDataProp(chEntry, 'medicineId');
        if (!entryMed.found || typeof entryMed.value !== 'string' || !entryMed.value.trim()) {
          globalUnknownReasons.push(`MALFORMED_BACKUP_REVIEW_ARCHIVE_MISSING_MEDICINE_ID:${sessionId}`);
          continue;
        }
        addSource(entryMed.value.trim(), 'UNRESOLVED_BACKUP_REVIEW');
        candidateMedIds.add(entryMed.value.trim());
        attributedMedicinesCount += 1;
      }
    }

    if (attributedMedicinesCount === 0) {
      globalUnknownReasons.push(`UNRESOLVED_BACKUP_REVIEW_NO_IDENTIFIABLE_ITEMS:${sessionId}`);
    }
  }

  // 6. OUTBOX V2 (ALL non-'synced' statuses, both direct medicine and indirect nested payloads)
  for (let i = 0; i < params.outbox.length; i += 1) {
    const entry = params.outbox[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      globalUnknownReasons.push(`MALFORMED_OUTBOX_ROW:${i}`);
      continue;
    }
    const actorProp = getSafeOwnDataProp(entry, 'actorUid');
    const branchProp = getSafeOwnDataProp(entry, 'branchId');
    if (actorProp.found && typeof actorProp.value === 'string' && actorProp.value.trim()) {
      discoveredV1Contexts.push({
        uid: actorProp.value.trim(),
        branchId:
          branchProp.found && typeof branchProp.value === 'string' && branchProp.value.trim()
            ? branchProp.value.trim()
            : 'default',
      });
    }

    const statusProp = getSafeOwnDataProp(entry, 'status');
    if (!statusProp.found || typeof statusProp.value !== 'string' || !statusProp.value.trim()) {
      globalUnknownReasons.push(`MALFORMED_OUTBOX_STATUS:${i}`);
      continue;
    }
    if (statusProp.value === 'synced') continue;

    // Non-synced entry (pending, processing, syncing, blocked, retry, failed, dead-letter, etc.)
    const typeProp = getSafeOwnDataProp(entry, 'entityType');
    const entityType = typeProp.found && typeof typeProp.value === 'string' ? typeProp.value.trim() : '';
    const idProp = getSafeOwnDataProp(entry, 'entityId');
    const entityId = idProp.found && typeof idProp.value === 'string' ? idProp.value.trim() : '';

    const extractedIds = new Set<string>();
    const extractErrors: string[] = [];

    if (entityType === 'medicine') {
      if (entityId) {
        extractedIds.add(entityId);
      } else {
        extractErrors.push(`MALFORMED_OUTBOX_MEDICINE_ENTITY_ID:${i}`);
      }
    }

    extractMedicineRefsRecursive(entry, 0, extractedIds, extractErrors, `outbox[${i}]`);

    if (extractErrors.length > 0) {
      globalUnknownReasons.push(...extractErrors);
    }

    if (
      extractedIds.size === 0 &&
      extractErrors.length === 0 &&
      (entityType === 'sale' ||
        entityType === 'purchase_invoice' ||
        entityType === 'inventory_ledger' ||
        entityType === 'medicine')
    ) {
      const payloadProp = getSafeOwnDataProp(entry, 'payload');
      const itemsProp =
        payloadProp.found && payloadProp.value && typeof payloadProp.value === 'object'
          ? getSafeOwnDataProp(payloadProp.value, 'items')
          : { found: false, value: undefined };
      const isLegitimateEmptyArray = itemsProp.found && Array.isArray(itemsProp.value) && itemsProp.value.length === 0;
      if (!isLegitimateEmptyArray) {
        globalUnknownReasons.push(`UNATTRIBUTABLE_NON_SYNCED_OUTBOX:${i}:${entityType}`);
      }
    }

    for (const medId of extractedIds) {
      addSource(medId, 'OUTBOX_V2_NON_SYNCED');
      candidateMedIds.add(medId);
    }
  }

  // 7. V1 localStorage retry queue
  if (!params.localRetrySnapshot.available || params.localRetrySnapshot.errors.length > 0) {
    globalUnknownReasons.push(...params.localRetrySnapshot.errors);
  }
  for (const medId of params.localRetrySnapshot.medicineIds) {
    addSource(medId, 'V1_LOCALSTORAGE_RETRY_QUEUE');
    candidateMedIds.add(medId);
  }

  // 8. V1 In-flight operations (explicit IDs/inspector + cross-tab shared lease enumerator + IDB metadata leases + checker)
  const v1Snap = readExplicitV1InFlightSnapshot({
    v1InFlightMedicineIds: params.v1InFlightMedicineIds,
    v1InFlightInspector: params.v1InFlightInspector,
    v1InFlightAvailable:
      v1InFlightRegistryAvailableOverride === false ? false : params.v1InFlightAvailable,
    v1ContextHints: params.v1ContextHints,
  });
  let v1Scope: 'KNOWN_CONTEXT_AND_EXPLICIT' | 'UNINSPECTABLE_FAIL_CLOSED' = v1Snap.scope;
  if (v1Snap.errors.length > 0) {
    globalUnknownReasons.push(...v1Snap.errors);
    v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
  }
  for (const medId of v1Snap.explicitMedicineIds) {
    addSource(medId, 'V1_IN_FLIGHT_OPERATION');
    candidateMedIds.add(medId);
  }

  // 8a. Shared V1 cross-tab enumerator (`enumerateV1InFlightOperations`)
  const activeEnumerator =
    params.v1InFlightEnumerator !== undefined
      ? params.v1InFlightEnumerator
      : customV1InFlightEnumerator ?? defaultV1InFlightEnumerator;

  if (
    v1InFlightRegistryAvailableOverride === false ||
    params.v1InFlightAvailable === false ||
    !activeEnumerator
  ) {
    globalUnknownReasons.push('V1_IN_FLIGHT_ENUMERATOR_UNAVAILABLE');
    v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
  } else {
    try {
      const enumRes = activeEnumerator({ nowMs });
      if (!enumRes || typeof enumRes !== 'object') {
        globalUnknownReasons.push('INVALID_V1_IN_FLIGHT_ENUMERATION');
        v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
      } else {
        if (!enumRes.available) {
          globalUnknownReasons.push('V1_IN_FLIGHT_REGISTRY_UNAVAILABLE');
          v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
        }
        if (Array.isArray(enumRes.errors) && enumRes.errors.length > 0) {
          globalUnknownReasons.push(...enumRes.errors);
          v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
        }
        if (Array.isArray(enumRes.expiredLeases) && enumRes.expiredLeases.length > 0) {
          for (const expLease of enumRes.expiredLeases) {
            globalUnknownReasons.push(
              `EXPIRED_UNRELEASED_V1_LEASE:${String(expLease?.leaseId || 'unknown')}`
            );
            if (Array.isArray(expLease?.medicineIds)) {
              for (const mid of expLease.medicineIds) {
                if (typeof mid === 'string' && mid.trim()) {
                  addSource(mid.trim(), 'V1_IN_FLIGHT_OPERATION');
                  candidateMedIds.add(mid.trim());
                }
              }
            }
          }
          v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
        }
        if (Array.isArray(enumRes.activeLeases)) {
          for (const lease of enumRes.activeLeases) {
            const v = validateIdbV1LeaseRecord(lease);
            if (!v.valid) {
              globalUnknownReasons.push(`MALFORMED_ENUMERATED_V1_LEASE:${v.reason}`);
              v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
              continue;
            }
            discoveredV1Contexts.push({
              uid: v.record.originUid,
              branchId: v.record.branchId,
            });
            for (const mid of v.record.medicineIds) {
              addSource(mid, 'V1_IN_FLIGHT_OPERATION');
              candidateMedIds.add(mid);
            }
          }
        }
        if (Array.isArray(enumRes.activeMedicineIds)) {
          for (const mid of enumRes.activeMedicineIds) {
            if (typeof mid === 'string' && mid.trim()) {
              addSource(mid.trim(), 'V1_IN_FLIGHT_OPERATION');
              candidateMedIds.add(mid.trim());
            }
          }
        }
        if (Array.isArray(enumRes.discoveredContexts)) {
          for (const ctx of enumRes.discoveredContexts) {
            if (
              ctx &&
              typeof ctx.uid === 'string' &&
              ctx.uid.trim() &&
              typeof ctx.branchId === 'string' &&
              ctx.branchId.trim()
            ) {
              discoveredV1Contexts.push({ uid: ctx.uid.trim(), branchId: ctx.branchId.trim() });
            }
          }
        }
      }
    } catch (err) {
      globalUnknownReasons.push(
        `V1_IN_FLIGHT_ENUMERATOR_THROWN:${err instanceof Error ? err.message : String(err)}`
      );
      v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
    }
  }

  // 8b. IndexedDB persisted V1 in-flight lease rows (`metadata` store prefix `v1_inflight_lease_v1:`)
  if (Array.isArray(params.idbV1LeaseRows)) {
    for (let i = 0; i < params.idbV1LeaseRows.length; i += 1) {
      const row = params.idbV1LeaseRows[i];
      const keyProp = getSafeOwnDataProp(row, 'key');
      const rowKey = keyProp.found && typeof keyProp.value === 'string' ? keyProp.value : `idb[${i}]`;
      const v = validateIdbV1LeaseRecord(row);
      if (!v.valid) {
        globalUnknownReasons.push(`MALFORMED_IDB_V1_LEASE:${rowKey}:${v.reason}`);
        v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
        continue;
      }
      discoveredV1Contexts.push({
        uid: v.record.originUid,
        branchId: v.record.branchId,
      });
      if (v.record.expiresAtMs <= nowMs) {
        globalUnknownReasons.push(`EXPIRED_UNRELEASED_V1_LEASE:idb:${v.record.leaseId}`);
        v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
      }
      for (const mid of v.record.medicineIds) {
        addSource(mid, 'V1_IN_FLIGHT_OPERATION');
        candidateMedIds.add(mid);
      }
    }
  }

  // 8c. Legacy per-context V1 checker (`isV1EntitySyncInFlight`) for medicines and sales
  const uniqueCtxMap = new Map<string, { uid: string; branchId: string }>();
  for (const ctx of [...discoveredV1Contexts, ...v1Snap.extraContexts]) {
    if (ctx.uid && ctx.branchId) {
      uniqueCtxMap.set(`${ctx.uid}::${ctx.branchId}`, ctx);
    }
  }
  const activeChecker = customV1InFlightChecker ?? defaultV1InFlightChecker;
  if (!activeChecker && v1InFlightRegistryAvailableOverride === false) {
    globalUnknownReasons.push('V1_IN_FLIGHT_CHECKER_UNAVAILABLE');
    v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
  } else if (activeChecker) {
    for (const ctx of uniqueCtxMap.values()) {
      for (const medId of candidateMedIds) {
        try {
          if (activeChecker(ctx.uid, ctx.branchId, 'medicine', medId)) {
            addSource(medId, 'V1_IN_FLIGHT_OPERATION');
          }
        } catch {
          globalUnknownReasons.push(`V1_IN_FLIGHT_QUERY_FAILED:${medId}`);
          v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
        }
      }
      for (const s of parsedSales) {
        try {
          if (activeChecker(ctx.uid, ctx.branchId, 'sale', s.saleId)) {
            for (const medId of s.medicineIds) {
              addSource(medId, 'V1_IN_FLIGHT_OPERATION');
            }
          }
        } catch {
          globalUnknownReasons.push(`V1_IN_FLIGHT_SALE_QUERY_FAILED:${s.saleId}`);
          v1Scope = 'UNINSPECTABLE_FAIL_CLOSED';
        }
      }
    }
  }

  // 9. OPEN STOCKTAKING SESSIONS & SUBCOLLECTION ITEMS
  const openSessionIds = new Set<string>();
  for (let i = 0; i < params.stocktakingSessions.length; i += 1) {
    const sess = params.stocktakingSessions[i];
    if (!sess || typeof sess !== 'object' || Array.isArray(sess)) {
      globalUnknownReasons.push(`MALFORMED_STOCKTAKING_SESSION:${i}`);
      continue;
    }
    const idProp = getSafeOwnDataProp(sess, 'id');
    const sessId = idProp.found && typeof idProp.value === 'string' ? idProp.value.trim() : '';
    const statusProp = getSafeOwnDataProp(sess, 'status');
    const statusStr = statusProp.found && typeof statusProp.value === 'string' ? statusProp.value : '';
    const isHistorical = HISTORICAL_STOCKTAKING_STATUSES.has(statusStr);
    if (isHistorical) continue;

    if (sessId) openSessionIds.add(sessId);
    const itemsProp = getSafeOwnDataProp(sess, 'items');
    if (itemsProp.found && itemsProp.value !== undefined && itemsProp.value !== null) {
      if (!Array.isArray(itemsProp.value)) {
        globalUnknownReasons.push(`MALFORMED_OPEN_STOCKTAKING_ITEMS:${sessId || i}`);
      } else {
        for (let j = 0; j < itemsProp.value.length; j += 1) {
          const it = itemsProp.value[j];
          if (!it || typeof it !== 'object' || Array.isArray(it)) {
            globalUnknownReasons.push(`MALFORMED_OPEN_STOCKTAKING_INLINE_ITEM:${sessId || i}[${j}]`);
            continue;
          }
          const mp = getSafeOwnDataProp(it, 'medicineId');
          if (!mp.found || typeof mp.value !== 'string' || !mp.value.trim()) {
            globalUnknownReasons.push(`MALFORMED_OPEN_STOCKTAKING_MISSING_MEDICINE_ID:${sessId || i}[${j}]`);
            continue;
          }
          addSource(mp.value.trim(), 'OPEN_STOCKTAKING');
        }
      }
    }
  }
  for (let i = 0; i < params.stocktakingItems.length; i += 1) {
    const sub = params.stocktakingItems[i];
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
      globalUnknownReasons.push(`MALFORMED_STOCKTAKING_SUBITEM:${i}`);
      continue;
    }
    const sp = getSafeOwnDataProp(sub, 'sessionId');
    const sid = sp.found && typeof sp.value === 'string' ? sp.value.trim() : '';
    if (!sid) {
      globalUnknownReasons.push(`MALFORMED_STOCKTAKING_SUBITEM_MISSING_SESSION:${i}`);
      continue;
    }
    if (!openSessionIds.has(sid)) continue;
    const mp = getSafeOwnDataProp(sub, 'medicineId');
    if (!mp.found || typeof mp.value !== 'string' || !mp.value.trim()) {
      globalUnknownReasons.push(`MALFORMED_OPEN_STOCKTAKING_SUBITEM_MISSING_MED:${sid}:${i}`);
      continue;
    }
    addSource(mp.value.trim(), 'OPEN_STOCKTAKING');
  }

  const dedupedGlobalUnknown = Array.from(new Set(globalUnknownReasons)).sort();

  const buildReportForMedicine = (
    medicineId: string,
    rawMed: unknown,
    existingQuarantine?: MedicineQuarantineRecord | null
  ): PackingLockEvidenceReport => {
    const matched = new Set<PackingLockEvidenceSource>(sourcesByMedicine.get(medicineId) ?? []);
    const medUnknowns = [...(perMedicineUnknownReasons.get(medicineId) ?? [])];
    let localScope = v1Scope;

    if (rawMed !== undefined) {
      if (!rawMed || typeof rawMed !== 'object' || Array.isArray(rawMed)) {
        medUnknowns.push('MALFORMED_TARGET_MEDICINE_RECORD');
      } else {
        const flags = inspectMedicineStockAndLockFlags(rawMed);
        medUnknowns.push(...flags.corruptReasons);
        if (flags.hasNonZeroStock) matched.add('NONZERO_STOCK_BALANCE');
        const resolvedQ = existingQuarantine ?? params.existingQuarantines.get(medicineId) ?? null;
        if (
          flags.hasCloudOrPermanentLockFlag ||
          (flags.hasExistingLockFlag &&
            (!excludeSelfQuarantine || !resolvedQ || resolvedQ.preQuarantinePackingLocked !== false))
        ) {
          matched.add('EXISTING_PACKING_LOCK');
        }
        if (flags.hasQuarantineStatus && !excludeSelfQuarantine) {
          matched.add('QUARANTINE_OR_RECONCILIATION_STATE');
        }
      }
    }
    if (existingQuarantine) {
      if (!excludeSelfQuarantine) {
        if (existingQuarantine.reviewStatus !== 'RESOLVED') {
          matched.add('QUARANTINE_OR_RECONCILIATION_STATE');
        }
      } else if (existingQuarantine.preQuarantinePackingLocked !== false) {
        matched.add('EXISTING_PACKING_LOCK');
      }
    }

    if (activeChecker) {
      for (const ctx of uniqueCtxMap.values()) {
        try {
          if (activeChecker(ctx.uid, ctx.branchId, 'medicine', medicineId)) {
            matched.add('V1_IN_FLIGHT_OPERATION');
          }
        } catch {
          medUnknowns.push(`V1_IN_FLIGHT_QUERY_FAILED:${medicineId}`);
          localScope = 'UNINSPECTABLE_FAIL_CLOSED';
        }
      }
    }

    const allUnknown = Array.from(new Set([...dedupedGlobalUnknown, ...medUnknowns])).sort();
    const sortedSources = Array.from(matched).sort();
    const coordinatorDecision = evaluatePackingLockSnapshot({
      firstInventoryMovement: matched.has('INVENTORY_LEDGER') || matched.has('SALES') || matched.has('PURCHASE_INVOICES') || matched.has('NONZERO_STOCK_BALANCE'),
      historicalLedgerCount: matched.has('INVENTORY_LEDGER') ? 1 : 0,
      pendingV1SyncCount: matched.has('V1_LOCALSTORAGE_RETRY_QUEUE') || matched.has('V1_IN_FLIGHT_OPERATION') ? 1 : 0,
      pendingV2SyncCount: matched.has('OUTBOX_V2_NON_SYNCED') ? 1 : 0,
      unresolvedBackupReview: matched.has('UNRESOLVED_BACKUP_REVIEW'),
      openReconciliation: matched.has('QUARANTINE_OR_RECONCILIATION_STATE'),
      openStocktaking: matched.has('OPEN_STOCKTAKING'),
      unpostedOcrDraft: matched.has('UNPOSTED_OCR_DRAFT'),
      quarantineOrUnverified: matched.has('QUARANTINE_OR_RECONCILIATION_STATE'),
      permanentLock: matched.has('EXISTING_PACKING_LOCK'),
      evidenceAvailable: allUnknown.length === 0,
      unknownReasons: allUnknown,
    });
    if (coordinatorDecision.failClosed) {
      return {
        medicineId,
        status: 'UNKNOWN_FAIL_CLOSED',
        effectivePackingLocked: coordinatorDecision.locked,
        matchedSources: sortedSources,
        reasons: [...sortedSources.map((s) => `EVIDENCE:${s}`), ...coordinatorDecision.reasons.map((r) => `COORDINATOR:${r}`)],
        unknownFailureReasons: allUnknown,
        v1InFlightScope: 'UNINSPECTABLE_FAIL_CLOSED',
      };
    }
    if (coordinatorDecision.locked) {
      return {
        medicineId,
        status: 'LOCKED_WITH_EVIDENCE',
        effectivePackingLocked: true,
        matchedSources: sortedSources,
        reasons: sortedSources.map((s) => `EVIDENCE:${s}`),
        unknownFailureReasons: [],
        v1InFlightScope: localScope,
      };
    }
    return {
      medicineId,
      status: 'SAFE_NO_EVIDENCE',
      effectivePackingLocked: false,
      matchedSources: [],
      reasons: [],
      unknownFailureReasons: [],
      v1InFlightScope: localScope,
    };
  };

  return {
    sourcesByMedicine,
    perMedicineUnknownReasons,
    globalUnknownReasons: dedupedGlobalUnknown,
    v1InFlightScope: dedupedGlobalUnknown.length > 0 ? 'UNINSPECTABLE_FAIL_CLOSED' : v1Scope,
    buildReportForMedicine,
  };
}

export async function inspectMedicinePackingLockEvidence(
  medicineId: string,
  options: InspectPackingLockOptions = {}
): Promise<PackingLockEvidenceReport> {
  if (!medicineId || typeof medicineId !== 'string' || !medicineId.trim()) {
    return {
      medicineId: String(medicineId ?? ''),
      status: 'UNKNOWN_FAIL_CLOSED',
      effectivePackingLocked: true,
      matchedSources: [],
      reasons: [],
      unknownFailureReasons: ['INVALID_MEDICINE_ID'],
      v1InFlightScope: 'UNINSPECTABLE_FAIL_CLOSED',
    };
  }
  const normalizedId = medicineId.trim();
  let v1InitFailed = false;
  try {
    await ensureV1InFlightCheckerResolved();
  } catch {
    v1InitFailed = true;
  }
  const db = await resolveTargetDb(options.db);
  const presentStores = new Set<string>();
  const storesToRead: string[] = [];
  for (const s of [...REQUIRED_EVIDENCE_STORES, ...OPTIONAL_EVIDENCE_STORES]) {
    if (db.objectStoreNames.contains(s)) {
      presentStores.add(s);
      storesToRead.push(s);
    }
  }
  const localRetrySnapshot = readV1LocalStorageRetrySnapshot();
  const effectiveAvailable = v1InitFailed ? false : options.v1InFlightAvailable;

  if (storesToRead.length === 0) {
    const emptyEval = evaluateAllPackingLockEvidenceSnapshot({
      presentStores,
      medicines: [],
      ledger: [],
      sales: [],
      purchaseInvoices: [],
      outbox: [],
      stocktakingSessions: [],
      stocktakingItems: [],
      supplierInvoiceDrafts: [],
      backupReviewMetadata: [],
      existingQuarantines: new Map(),
      idbV1LeaseRows: [],
      localRetrySnapshot,
      ...options,
      v1InFlightAvailable: effectiveAvailable,
    });
    return emptyEval.buildReportForMedicine(normalizedId, options.medicineRecordOverride, null);
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storesToRead, 'readonly');
    const dataMap = new Map<string, unknown[]>();
    let loaded = 0;

    const done = () => {
      loaded += 1;
      if (loaded < storesToRead.length) return;
      const medicines = dataMap.get('medicines') ?? [];
      const metadataRows = dataMap.get('metadata') ?? [];
      const existingQuarantines = new Map<string, MedicineQuarantineRecord>();
      const idbV1LeaseRows: unknown[] = [];
      for (const m of metadataRows) {
        const kProp = getSafeOwnDataProp(m, 'key');
        if (!kProp.found || typeof kProp.value !== 'string') continue;
        if (kProp.value.startsWith(UNIT_MIGRATION_QUARANTINE_PREFIX)) {
          const mId = kProp.value.slice(UNIT_MIGRATION_QUARANTINE_PREFIX.length);
          existingQuarantines.set(mId, m as MedicineQuarantineRecord);
        } else if (kProp.value.startsWith(V1_IN_FLIGHT_LEASE_IDB_PREFIX)) {
          idbV1LeaseRows.push(m);
        }
      }

      let rawTargetMed: unknown = options.medicineRecordOverride;
      if (rawTargetMed === undefined) {
        rawTargetMed = medicines.find((m) => {
          const idProp = getSafeOwnDataProp(m, 'id');
          return idProp.found && typeof idProp.value === 'string' && idProp.value.trim() === normalizedId;
        });
      }

      const evaluation = evaluateAllPackingLockEvidenceSnapshot({
        presentStores,
        medicines,
        ledger: dataMap.get('inventory_ledger') ?? [],
        sales: dataMap.get('sales') ?? [],
        purchaseInvoices: dataMap.get('purchase_invoices') ?? [],
        outbox: dataMap.get('outbox') ?? [],
        stocktakingSessions: dataMap.get('stocktaking_sessions') ?? [],
        stocktakingItems: dataMap.get('stocktaking_items') ?? [],
        supplierInvoiceDrafts: dataMap.get('supplier_invoice_drafts') ?? [],
        backupReviewMetadata: metadataRows,
        existingQuarantines,
        idbV1LeaseRows,
        localRetrySnapshot,
        v1InFlightMedicineIds: options.v1InFlightMedicineIds,
        v1InFlightInspector: options.v1InFlightInspector,
        v1InFlightEnumerator: options.v1InFlightEnumerator,
        v1InFlightAvailable: effectiveAvailable,
        v1InFlightNowMs: options.v1InFlightNowMs,
        v1ContextHints: options.v1ContextHints,
        excludeQuarantineSelfLockForRecovery: options.excludeQuarantineSelfLockForRecovery,
      });

      resolve(
        evaluation.buildReportForMedicine(
          normalizedId,
          rawTargetMed,
          existingQuarantines.get(normalizedId) ?? null
        )
      );
    };

    for (const storeName of storesToRead) {
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => {
        dataMap.set(storeName, Array.isArray(req.result) ? req.result : []);
        done();
      };
      req.onerror = () => reject(req.error || new Error(`EVIDENCE_READ_FAILED:${storeName}`));
    }
    tx.onerror = () => reject(tx.error || new Error('EVIDENCE_TX_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('EVIDENCE_TX_ABORTED'));
  });
}

function readPendingMedicinesSnapshot(
  db: IDBDatabase,
  options: Pick<
    StartMigrationOptions,
    | 'v1InFlightMedicineIds'
    | 'v1InFlightInspector'
    | 'v1InFlightEnumerator'
    | 'v1InFlightAvailable'
    | 'v1InFlightNowMs'
    | 'v1ContextHints'
  >,
  ownership?: ExpectedExecutionOwnership
): Promise<{
  pausedByPeer: boolean;
  checkpoint: UnitMigrationCheckpoint | null;
  medicines: unknown[];
  existingQuarantines: Map<string, MedicineQuarantineRecord>;
  evaluation: EvidenceEvaluationResult;
}> {
  const presentStores = new Set<string>();
  const stores: string[] = [];
  for (const s of [...REQUIRED_EVIDENCE_STORES, ...OPTIONAL_EVIDENCE_STORES]) {
    if (db.objectStoreNames.contains(s)) {
      presentStores.add(s);
      stores.push(s);
    }
  }
  const localRetrySnapshot = readV1LocalStorageRetrySnapshot();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readonly');
    const dataMap = new Map<string, unknown[]>();
    let loaded = 0;

    const done = () => {
      loaded += 1;
      if (loaded < stores.length) return;
      const medicines = dataMap.get('medicines') ?? [];
      const metadataRows = dataMap.get('metadata') ?? [];
      let liveCp: UnitMigrationCheckpoint | null = null;
      let liveBl: FinancialBaselineDigestRecord | null = null;
      const existingQuarantines = new Map<string, MedicineQuarantineRecord>();
      const idbV1LeaseRows: unknown[] = [];
      for (const m of metadataRows) {
        const kProp = getSafeOwnDataProp(m, 'key');
        if (!kProp.found || typeof kProp.value !== 'string') continue;
        if (kProp.value === UNIT_MIGRATION_CHECKPOINT_KEY) {
          liveCp = m as UnitMigrationCheckpoint;
        } else if (kProp.value === UNIT_MIGRATION_BASELINE_DIGEST_KEY) {
          liveBl = m as FinancialBaselineDigestRecord;
        } else if (kProp.value.startsWith(UNIT_MIGRATION_QUARANTINE_PREFIX)) {
          const medId = kProp.value.slice(UNIT_MIGRATION_QUARANTINE_PREFIX.length);
          existingQuarantines.set(medId, m as MedicineQuarantineRecord);
        } else if (kProp.value.startsWith(V1_IN_FLIGHT_LEASE_IDB_PREFIX)) {
          idbV1LeaseRows.push(m);
        }
      }

      if (ownership) {
        const check = validateLiveOwnershipInTx(liveCp, liveBl, ownership);
        if (!check.ok) {
          reject(check.error);
          return;
        }
        if (check.paused) {
          const emptyEval = evaluateAllPackingLockEvidenceSnapshot({
            presentStores,
            medicines: [],
            ledger: [],
            sales: [],
            purchaseInvoices: [],
            outbox: [],
            stocktakingSessions: [],
            stocktakingItems: [],
            supplierInvoiceDrafts: [],
            backupReviewMetadata: [],
            existingQuarantines: new Map(),
            idbV1LeaseRows: [],
            localRetrySnapshot,
            v1InFlightAvailable: options.v1InFlightAvailable,
          });
          resolve({
            pausedByPeer: true,
            checkpoint: check.checkpoint,
            medicines: [],
            existingQuarantines: new Map(),
            evaluation: emptyEval,
          });
          return;
        }
      }

      const evaluation = evaluateAllPackingLockEvidenceSnapshot({
        presentStores,
        medicines,
        ledger: dataMap.get('inventory_ledger') ?? [],
        sales: dataMap.get('sales') ?? [],
        purchaseInvoices: dataMap.get('purchase_invoices') ?? [],
        outbox: dataMap.get('outbox') ?? [],
        stocktakingSessions: dataMap.get('stocktaking_sessions') ?? [],
        stocktakingItems: dataMap.get('stocktaking_items') ?? [],
        supplierInvoiceDrafts: dataMap.get('supplier_invoice_drafts') ?? [],
        backupReviewMetadata: metadataRows,
        existingQuarantines,
        idbV1LeaseRows,
        localRetrySnapshot,
        v1InFlightMedicineIds: options.v1InFlightMedicineIds,
        v1InFlightInspector: options.v1InFlightInspector,
        v1InFlightEnumerator: options.v1InFlightEnumerator,
        v1InFlightAvailable: options.v1InFlightAvailable,
        v1InFlightNowMs: options.v1InFlightNowMs,
        v1ContextHints: options.v1ContextHints,
      });
      resolve({ pausedByPeer: false, checkpoint: liveCp, medicines, existingQuarantines, evaluation });
    };

    for (const storeName of stores) {
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => {
        dataMap.set(storeName, Array.isArray(req.result) ? req.result : []);
        done();
      };
      req.onerror = () => reject(req.error || new Error(`Failed reading ${storeName}`));
    }

    tx.onerror = () => reject(tx.error || new Error('PREBATCH_READ_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('PREBATCH_READ_ABORTED'));
  });
}

function buildStocktakingConflictEntriesForSession(params: {
  session: unknown;
  subItems: ReadonlyArray<unknown>;
  medicinesById: ReadonlyMap<string, unknown>;
  nowIso: string;
  migrationRunId: string;
}): {
  sessionId: string;
  sessionStatus: string;
  isHistorical: boolean;
  isOpen: boolean;
  entries: StocktakingConflictArchiveEntry[];
  reasonCodes: string[];
} {
  const safeSess = sanitizeForPlainJson(params.session) as Record<string, unknown>;
  const sessionId =
    typeof safeSess?.id === 'string' && safeSess.id.trim()
      ? safeSess.id.trim()
      : 'unknown-session';
  const sessionStatus = typeof safeSess?.status === 'string' ? safeSess.status : '';
  const isHistorical = HISTORICAL_STOCKTAKING_STATUSES.has(sessionStatus);
  const isOpen = OPEN_STOCKTAKING_STATUSES.has(sessionStatus);

  const rawInlineItems = Array.isArray(safeSess?.items) ? safeSess.items : [];
  const entries: StocktakingConflictArchiveEntry[] = [];
  const reasonSet = new Set<string>();

  const makeEntry = (p: Omit<StocktakingConflictArchiveEntry, 'conflictId'>): StocktakingConflictArchiveEntry => {
    const idSeed = JSON.stringify({
      sessionId: p.sessionId,
      sourceStore: p.sourceStore,
      conflictType: p.conflictType,
      medicineId: p.medicineId,
      sourceIndex: p.sourceIndex ?? null,
      sourceRecordId: p.sourceRecordId ?? null,
      rawVersion: canonicalStableJson(p.rawVersion),
    });
    return {
      conflictId: `stc-${sha256HexSync(idSeed).slice(0, 24)}`,
      ...p,
    };
  };

  // Group inline items by medicineId (ZERO silent skipping)
  const inlineByMed = new Map<string, Array<{ index: number; item: Record<string, unknown> }>>();
  for (let i = 0; i < rawInlineItems.length; i += 1) {
    const item = rawInlineItems[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      reasonSet.add('MALFORMED_INLINE_STOCKTAKING_ITEM');
      entries.push(
        makeEntry({
          sessionId,
          sourceStore: 'stocktaking_sessions.items',
          conflictType: 'MALFORMED_ITEM',
          medicineId: `__malformed_inline_${i}`,
          sourceIndex: i,
          detectedAt: params.nowIso,
          migrationRunId: params.migrationRunId,
          rawVersion: item,
        })
      );
      continue;
    }
    const obj = item as Record<string, unknown>;
    const medId = typeof obj.medicineId === 'string' ? obj.medicineId.trim() : '';
    if (!medId) {
      reasonSet.add('MISSING_MEDICINE_ID_IN_STOCKTAKING');
      entries.push(
        makeEntry({
          sessionId,
          sourceStore: 'stocktaking_sessions.items',
          conflictType: 'MALFORMED_ITEM',
          medicineId: `__missing_med_inline_${i}`,
          sourceIndex: i,
          sourceRecordId: typeof obj.id === 'string' ? obj.id : undefined,
          detectedAt: params.nowIso,
          migrationRunId: params.migrationRunId,
          rawVersion: obj,
        })
      );
      continue;
    }
    const bucket = inlineByMed.get(medId) ?? [];
    bucket.push({ index: i, item: obj });
    inlineByMed.set(medId, bucket);
  }

  for (const [medId, group] of inlineByMed.entries()) {
    if (group.length > 1) {
      reasonSet.add('DUPLICATE_INLINE_MEDICINE');
      for (const rec of group) {
        entries.push(
          makeEntry({
            sessionId,
            sourceStore: 'stocktaking_sessions.items',
            conflictType: 'DUPLICATE_INLINE_MEDICINE',
            medicineId: medId,
            sourceIndex: rec.index,
            sourceRecordId: typeof rec.item.id === 'string' ? rec.item.id : undefined,
            detectedAt: params.nowIso,
            migrationRunId: params.migrationRunId,
            rawVersion: rec.item,
          })
        );
      }
    }
  }

  // Group subcollection items by medicineId
  const subByMed = new Map<string, Array<{ recordId: string; item: Record<string, unknown> }>>();
  for (let i = 0; i < params.subItems.length; i += 1) {
    const safeSub = sanitizeForPlainJson(params.subItems[i]) as Record<string, unknown>;
    const medId = typeof safeSub?.medicineId === 'string' ? safeSub.medicineId.trim() : '';
    const recordId = typeof safeSub?.id === 'string' ? safeSub.id : `sub-${i}`;
    if (!medId) {
      reasonSet.add('MALFORMED_SUBCOLLECTION_ITEM');
      entries.push(
        makeEntry({
          sessionId,
          sourceStore: 'stocktaking_items',
          conflictType: 'MALFORMED_ITEM',
          medicineId: `__malformed_sub_${i}`,
          sourceRecordId: recordId,
          detectedAt: params.nowIso,
          migrationRunId: params.migrationRunId,
          rawVersion: safeSub,
        })
      );
      continue;
    }
    const bucket = subByMed.get(medId) ?? [];
    bucket.push({ recordId, item: safeSub });
    subByMed.set(medId, bucket);
  }

  for (const [medId, group] of subByMed.entries()) {
    if (group.length > 1) {
      reasonSet.add('DUPLICATE_SUBCOLLECTION_MEDICINE');
      for (const rec of group) {
        entries.push(
          makeEntry({
            sessionId,
            sourceStore: 'stocktaking_items',
            conflictType: 'DUPLICATE_SUBCOLLECTION_MEDICINE',
            medicineId: medId,
            sourceRecordId: rec.recordId,
            detectedAt: params.nowIso,
            migrationRunId: params.migrationRunId,
            rawVersion: rec.item,
          })
        );
      }
    }
  }

  // Detect inline vs subcollection disagreement on same medicineId
  const allReferencedMedIds = new Set<string>([...inlineByMed.keys(), ...subByMed.keys()]);
  for (const medId of allReferencedMedIds) {
    const inGroup = inlineByMed.get(medId) ?? [];
    const subGroup = subByMed.get(medId) ?? [];
    if (inGroup.length > 0 && subGroup.length > 0) {
      const firstIn = inGroup[0].item;
      const firstSub = subGroup[0].item;
      const differs =
        firstIn.actualCount !== firstSub.actualCount ||
        firstIn.systemStock !== firstSub.systemStock ||
        firstIn.unit !== firstSub.unit ||
        firstIn.buyPrice !== firstSub.buyPrice ||
        firstIn.variance !== firstSub.variance;
      if (differs) {
        reasonSet.add('INLINE_SUBCOLLECTION_CONFLICT');
        for (const rec of inGroup) {
          entries.push(
            makeEntry({
              sessionId,
              sourceStore: 'stocktaking_sessions.items',
              conflictType: 'INLINE_SUBCOLLECTION_CONFLICT',
              medicineId: medId,
              sourceIndex: rec.index,
              sourceRecordId: typeof rec.item.id === 'string' ? rec.item.id : undefined,
              detectedAt: params.nowIso,
              migrationRunId: params.migrationRunId,
              rawVersion: rec.item,
            })
          );
        }
        for (const rec of subGroup) {
          entries.push(
            makeEntry({
              sessionId,
              sourceStore: 'stocktaking_items',
              conflictType: 'INLINE_SUBCOLLECTION_CONFLICT',
              medicineId: medId,
              sourceRecordId: rec.recordId,
              detectedAt: params.nowIso,
              migrationRunId: params.migrationRunId,
              rawVersion: rec.item,
            })
          );
        }
      }
    }

    // Check referenced medicine quarantine/conflict state on open sessions
    const med = params.medicinesById.get(medId);
    if (med) {
      const safeMed = sanitizeForPlainJson(med) as Record<string, unknown>;
      const status = safeMed?.configStatus;
      const migStatus = safeMed?.unitMigrationStatus;
      if (status === 'QUARANTINED' || migStatus === 'QUARANTINED') {
        reasonSet.add('QUARANTINED_MEDICINE_REFERENCE');
        for (const rec of inGroup) {
          entries.push(
            makeEntry({
              sessionId,
              sourceStore: 'stocktaking_sessions.items',
              conflictType: 'QUARANTINED_MEDICINE_REFERENCE',
              medicineId: medId,
              sourceIndex: rec.index,
              detectedAt: params.nowIso,
              migrationRunId: params.migrationRunId,
              rawVersion: rec.item,
            })
          );
        }
        for (const rec of subGroup) {
          entries.push(
            makeEntry({
              sessionId,
              sourceStore: 'stocktaking_items',
              conflictType: 'QUARANTINED_MEDICINE_REFERENCE',
              medicineId: medId,
              sourceRecordId: rec.recordId,
              detectedAt: params.nowIso,
              migrationRunId: params.migrationRunId,
              rawVersion: rec.item,
            })
          );
        }
      } else if (status === 'RECONCILIATION_REQUIRED' || migStatus === 'CONFLICTED') {
        reasonSet.add('CONFLICTED_MEDICINE_REFERENCE');
        for (const rec of inGroup) {
          entries.push(
            makeEntry({
              sessionId,
              sourceStore: 'stocktaking_sessions.items',
              conflictType: 'CONFLICTED_MEDICINE_REFERENCE',
              medicineId: medId,
              sourceIndex: rec.index,
              detectedAt: params.nowIso,
              migrationRunId: params.migrationRunId,
              rawVersion: rec.item,
            })
          );
        }
        for (const rec of subGroup) {
          entries.push(
            makeEntry({
              sessionId,
              sourceStore: 'stocktaking_items',
              conflictType: 'CONFLICTED_MEDICINE_REFERENCE',
              medicineId: medId,
              sourceRecordId: rec.recordId,
              detectedAt: params.nowIso,
              migrationRunId: params.migrationRunId,
              rawVersion: rec.item,
            })
          );
        }
      }
    }
  }

  // Deduplicate strictly by deterministic conflictId (so repeated runs never duplicate identical archive rows)
  const dedupedByConflictId = new Map<string, StocktakingConflictArchiveEntry>();
  for (const e of entries) {
    if (!dedupedByConflictId.has(e.conflictId)) {
      dedupedByConflictId.set(e.conflictId, e);
    }
  }

  return {
    sessionId,
    sessionStatus,
    isHistorical,
    isOpen,
    entries: Array.from(dedupedByConflictId.values()),
    reasonCodes: Array.from(reasonSet).sort(),
  };
}

interface BoundedArchiveWritePlan {
  readonly sessionKeyHash: string;
  readonly chunks: ReadonlyArray<StocktakingConflictArchiveChunk>;
  readonly pages: ReadonlyArray<StocktakingConflictArchiveIndexPage>;
  readonly leafPagesCount: number;
  readonly internalPagesCount: number;
  readonly treeHeight: number;
  readonly rootPageKey: string | null;
  readonly rootPageDigest: string | null;
  readonly archiveDigest: string;
}

function computeStreamingArchiveDigestInit(sessionId: string): string {
  return sha256HexSync(`ARCHIVE_V2_INIT:${sessionId}`);
}

function stepStreamingArchiveDigest(
  runningDigest: string,
  chunkIndex: number,
  entryCount: number,
  chunkDigest: string
): string {
  return sha256HexSync(`${runningDigest}|c:${chunkIndex}|n:${entryCount}|d:${chunkDigest}`);
}

function buildBoundedStocktakingArchiveTree(
  sessionId: string,
  allEntriesSorted: ReadonlyArray<StocktakingConflictArchiveEntry>
): BoundedArchiveWritePlan {
  const sessionKeyHash = sha256HexSync(sessionId).slice(0, 16);
  let runningDigest = computeStreamingArchiveDigestInit(sessionId);

  if (allEntriesSorted.length === 0) {
    return {
      sessionKeyHash,
      chunks: [],
      pages: [],
      leafPagesCount: 0,
      internalPagesCount: 0,
      treeHeight: 0,
      rootPageKey: null,
      rootPageDigest: null,
      archiveDigest: runningDigest,
    };
  }

  const chunks: StocktakingConflictArchiveChunk[] = [];
  const leafRefs: StocktakingConflictArchiveLeafRef[] = [];

  for (let i = 0; i < allEntriesSorted.length; i += STOCKTAKING_ARCHIVE_CHUNK_SIZE) {
    const chunkIndex = chunks.length;
    const chunkKey = `${UNIT_MIGRATION_STOCKTAKING_ARCHIVE_CHUNK_PREFIX}${sessionKeyHash}:c:${String(chunkIndex).padStart(6, '0')}`;
    const sliceEntries = allEntriesSorted.slice(i, i + STOCKTAKING_ARCHIVE_CHUNK_SIZE);
    const chunkDigest = computeCanonicalRecordsDigest(sliceEntries, (e) =>
      String((e as StocktakingConflictArchiveEntry).conflictId)
    );
    runningDigest = stepStreamingArchiveDigest(
      runningDigest,
      chunkIndex,
      sliceEntries.length,
      chunkDigest
    );
    chunks.push({
      key: chunkKey,
      schemaVersion: UNIT_MIGRATION_SCHEMA_VERSION,
      nodeKind: 'ARCHIVE_CHUNK',
      sessionId,
      chunkIndex,
      chunkDigest,
      entries: sliceEntries,
    });
    leafRefs.push({
      chunkKey,
      chunkIndex,
      entryCount: sliceEntries.length,
      firstConflictId: sliceEntries[0].conflictId,
      lastConflictId: sliceEntries[sliceEntries.length - 1].conflictId,
      chunkDigest,
    });
  }

  const allPages: StocktakingConflictArchiveIndexPage[] = [];
  interface LevelBuildNode {
    readonly pageKey: string;
    readonly level: number;
    readonly pageIndex: number;
    readonly pageDigest: string;
    readonly subtreeChunkCount: number;
    readonly subtreeEntryCount: number;
  }

  let currentLevelNodes: LevelBuildNode[] = [];
  let leafPagesCount = 0;
  for (let i = 0; i < leafRefs.length; i += STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE) {
    const pageIndex = currentLevelNodes.length;
    const sliceRefs = leafRefs.slice(i, i + STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE);
    const pageKey = `${UNIT_MIGRATION_STOCKTAKING_ARCHIVE_PAGE_PREFIX}${sessionKeyHash}:l:0:p:${String(pageIndex).padStart(6, '0')}`;
    const pageDigest = sha256HexSync(
      canonicalStableJson({
        sessionId,
        nodeType: 'LEAF',
        level: 0,
        pageIndex,
        refs: sliceRefs,
      })
    );
    const subtreeChunkCount = sliceRefs.length;
    const subtreeEntryCount = sliceRefs.reduce((acc, r) => acc + r.entryCount, 0);
    allPages.push({
      key: pageKey,
      schemaVersion: UNIT_MIGRATION_SCHEMA_VERSION,
      nodeKind: 'ARCHIVE_INDEX_PAGE',
      sessionId,
      nodeType: 'LEAF',
      level: 0,
      pageIndex,
      maxRefs: STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE,
      refs: sliceRefs,
      pageDigest,
    });
    currentLevelNodes.push({
      pageKey,
      level: 0,
      pageIndex,
      pageDigest,
      subtreeChunkCount,
      subtreeEntryCount,
    });
    leafPagesCount += 1;
  }

  let internalPagesCount = 0;
  let currentLevel = 1;
  while (currentLevelNodes.length > 1) {
    const nextLevelNodes: LevelBuildNode[] = [];
    for (let i = 0; i < currentLevelNodes.length; i += STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE) {
      const pageIndex = nextLevelNodes.length;
      const sliceChildren = currentLevelNodes.slice(i, i + STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE);
      const internalRefs: StocktakingConflictArchiveInternalRef[] = sliceChildren.map((child) => ({
        pageKey: child.pageKey,
        level: child.level,
        pageIndex: child.pageIndex,
        pageDigest: child.pageDigest,
        subtreeChunkCount: child.subtreeChunkCount,
        subtreeEntryCount: child.subtreeEntryCount,
      }));
      const pageKey = `${UNIT_MIGRATION_STOCKTAKING_ARCHIVE_PAGE_PREFIX}${sessionKeyHash}:l:${currentLevel}:p:${String(pageIndex).padStart(6, '0')}`;
      const pageDigest = sha256HexSync(
        canonicalStableJson({
          sessionId,
          nodeType: 'INTERNAL',
          level: currentLevel,
          pageIndex,
          refs: internalRefs,
        })
      );
      allPages.push({
        key: pageKey,
        schemaVersion: UNIT_MIGRATION_SCHEMA_VERSION,
        nodeKind: 'ARCHIVE_INDEX_PAGE',
        sessionId,
        nodeType: 'INTERNAL',
        level: currentLevel,
        pageIndex,
        maxRefs: STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE,
        refs: internalRefs,
        pageDigest,
      });
      nextLevelNodes.push({
        pageKey,
        level: currentLevel,
        pageIndex,
        pageDigest,
        subtreeChunkCount: internalRefs.reduce((acc, r) => acc + r.subtreeChunkCount, 0),
        subtreeEntryCount: internalRefs.reduce((acc, r) => acc + r.subtreeEntryCount, 0),
      });
      internalPagesCount += 1;
    }
    currentLevelNodes = nextLevelNodes;
    currentLevel += 1;
  }

  const rootNode = currentLevelNodes[0];
  return {
    sessionKeyHash,
    chunks,
    pages: allPages,
    leafPagesCount,
    internalPagesCount,
    treeHeight: rootNode.level + 1,
    rootPageKey: rootNode.pageKey,
    rootPageDigest: rootNode.pageDigest,
    archiveDigest: runningDigest,
  };
}

function isSafeArchiveOverwriteForSession(
  existing: unknown,
  candidateKey: string,
  expectedSessionId: string,
  expectedKind: 'CHUNK' | 'PAGE' | 'INDEX' | 'LEGACY_QUARANTINE'
): boolean {
  if (existing === undefined) return true;
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false;
  const sessProp = getSafeOwnDataProp(existing, 'sessionId');
  if (!sessProp.found || sessProp.value !== expectedSessionId) return false;
  const schemaProp = getSafeOwnDataProp(existing, 'schemaVersion');
  if (!schemaProp.found || schemaProp.value !== UNIT_MIGRATION_SCHEMA_VERSION) return false;

  if (expectedKind === 'CHUNK') {
    const nk = getSafeOwnDataProp(existing, 'nodeKind');
    const ent = getSafeOwnDataProp(existing, 'entries');
    return (nk.value === 'ARCHIVE_CHUNK' || Array.isArray(ent.value)) && candidateKey.startsWith(UNIT_MIGRATION_STOCKTAKING_ARCHIVE_CHUNK_PREFIX);
  }
  if (expectedKind === 'PAGE') {
    const nk = getSafeOwnDataProp(existing, 'nodeKind');
    const refs = getSafeOwnDataProp(existing, 'refs');
    return (nk.value === 'ARCHIVE_INDEX_PAGE' || Array.isArray(refs.value)) && candidateKey.startsWith(UNIT_MIGRATION_STOCKTAKING_ARCHIVE_PAGE_PREFIX);
  }
  if (expectedKind === 'INDEX') {
    return candidateKey.startsWith(UNIT_MIGRATION_STOCKTAKING_ARCHIVE_INDEX_PREFIX);
  }
  if (expectedKind === 'LEGACY_QUARANTINE') {
    const df = getSafeOwnDataProp(existing, 'detectedFormat');
    return typeof df.value === 'string' && candidateKey.startsWith(UNIT_MIGRATION_LEGACY_ARCHIVE_QUARANTINE_PREFIX);
  }
  return false;
}

interface ExpectedExecutionOwnership {
  readonly migrationRunId: string;
  readonly executionLeaseId: string;
  readonly expectedPhase?: MigrationPhase;
  readonly minPhaseOrder?: number;
  readonly expectedBatchNumber?: number;
  readonly expectedMedicineCursorId?: string | null;
  readonly expectedStocktakingCursorId?: string | null;
  readonly allowPaused?: boolean;
}

type LiveOwnershipValidationResult =
  | { readonly ok: true; readonly paused: false; readonly checkpoint: UnitMigrationCheckpoint; readonly baseline: FinancialBaselineDigestRecord }
  | { readonly ok: true; readonly paused: true; readonly checkpoint: UnitMigrationCheckpoint; readonly baseline: FinancialBaselineDigestRecord }
  | { readonly ok: false; readonly error: Error };

function validateLiveOwnershipInTx(
  liveCp: UnitMigrationCheckpoint | null | undefined,
  liveBl: FinancialBaselineDigestRecord | null | undefined,
  expected: ExpectedExecutionOwnership
): LiveOwnershipValidationResult {
  if (
    !liveCp ||
    !liveBl ||
    liveCp.migrationRunId !== expected.migrationRunId ||
    liveBl.migrationRunId !== expected.migrationRunId
  ) {
    return {
      ok: false,
      error: new Error(
        `MIGRATION_CONCURRENTLY_SUPERSEDED: Migration run '${expected.migrationRunId}' was superseded or restored concurrently.`
      ),
    };
  }
  if (liveCp.executionLeaseId !== expected.executionLeaseId) {
    return {
      ok: false,
      error: new Error(
        `MIGRATION_EXECUTION_LEASE_LOST: Execution lease '${expected.executionLeaseId}' lost to '${String(liveCp.executionLeaseId ?? 'none')}'.`
      ),
    };
  }
  if (liveCp.status === 'COMPLETED' || liveCp.phase === 'DONE') {
    return {
      ok: false,
      error: new Error(
        `MIGRATION_ALREADY_COMPLETED_CONFLICT: Migration run '${expected.migrationRunId}' already reached COMPLETED/DONE.`
      ),
    };
  }
  if (liveCp.status === 'FAILED') {
    return {
      ok: false,
      error: new Error(
        `MIGRATION_ALREADY_FAILED_CONFLICT: Migration run '${expected.migrationRunId}' already transitioned to FAILED.`
      ),
    };
  }
  if (
    expected.expectedPhase !== undefined &&
    liveCp.phase !== expected.expectedPhase
  ) {
    return {
      ok: false,
      error: new Error(
        `MIGRATION_CHECKPOINT_REGRESSION_CONFLICT: Expected phase '${expected.expectedPhase}' but live checkpoint has '${liveCp.phase}'.`
      ),
    };
  }
  if (
    expected.minPhaseOrder !== undefined &&
    MIGRATION_PHASE_ORDER[liveCp.phase] < expected.minPhaseOrder
  ) {
    return {
      ok: false,
      error: new Error(
        `MIGRATION_CHECKPOINT_REGRESSION_CONFLICT: Live phase '${liveCp.phase}' is behind minimum expected phase order ${expected.minPhaseOrder}.`
      ),
    };
  }
  if (
    expected.expectedBatchNumber !== undefined &&
    liveCp.batchNumber !== expected.expectedBatchNumber
  ) {
    return {
      ok: false,
      error: new Error(
        `MIGRATION_CHECKPOINT_REGRESSION_CONFLICT: Expected batchNumber=${expected.expectedBatchNumber} but live checkpoint has ${liveCp.batchNumber}.`
      ),
    };
  }
  if (
    expected.expectedMedicineCursorId !== undefined &&
    liveCp.lastMedicineCursorId !== expected.expectedMedicineCursorId
  ) {
    return {
      ok: false,
      error: new Error(
        `MIGRATION_CHECKPOINT_REGRESSION_CONFLICT: Expected lastMedicineCursorId='${String(expected.expectedMedicineCursorId)}' but live checkpoint has '${String(liveCp.lastMedicineCursorId)}'.`
      ),
    };
  }
  if (
    expected.expectedStocktakingCursorId !== undefined &&
    liveCp.lastStocktakingSessionCursorId !== expected.expectedStocktakingCursorId
  ) {
    return {
      ok: false,
      error: new Error(
        `MIGRATION_CHECKPOINT_REGRESSION_CONFLICT: Expected lastStocktakingSessionCursorId='${String(expected.expectedStocktakingCursorId)}' but live checkpoint has '${String(liveCp.lastStocktakingSessionCursorId)}'.`
      ),
    };
  }
  if (liveCp.status === 'PAUSED' || liveCp.pauseRequested === true) {
    return { ok: true, paused: true, checkpoint: liveCp, baseline: liveBl };
  }
  return { ok: true, paused: false, checkpoint: liveCp, baseline: liveBl };
}

function writeMetadataBatchWithCollisionCheck(
  db: IDBDatabase,
  records: ReadonlyArray<{
    readonly key: string;
    readonly record: Record<string, unknown>;
    readonly kind: 'CHUNK' | 'PAGE' | 'INDEX' | 'LEGACY_QUARANTINE';
    readonly sessionId: string;
  }>,
  ownership?: ExpectedExecutionOwnership,
  refreshLeaseHeartbeat = false
): Promise<{ pausedByPeer: boolean; checkpoint: UnitMigrationCheckpoint | null }> {
  if (records.length === 0) return Promise.resolve({ pausedByPeer: false, checkpoint: null });
  if (records.length > STOCKTAKING_ARCHIVE_WRITE_BATCH_SIZE) {
    return Promise.reject(
      new Error(
        `BOUNDED_ARCHIVE_TX_EXCEEDED: Attempted ${records.length} writes in one tx (limit=${STOCKTAKING_ARCHIVE_WRITE_BATCH_SIZE})`
      )
    );
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['metadata'], 'readwrite');
    const metaStore = tx.objectStore('metadata');
    const existingMap = new Map<string, unknown>();
    let liveCheckpointInTx: UnitMigrationCheckpoint | null = null;
    let liveBaselineInTx: FinancialBaselineDigestRecord | null = null;
    const expectedChecks = records.length + (ownership ? 2 : 0);
    let checked = 0;
    let aborted = false;
    let pausedResult: UnitMigrationCheckpoint | null = null;

    const failCollision = (err: Error) => {
      if (aborted) return;
      aborted = true;
      try {
        tx.abort();
      } catch {
        // ignore
      }
      reject(err);
    };

    const onAllChecked = () => {
      if (aborted) return;
      let verifiedLiveCp: UnitMigrationCheckpoint | null = null;
      if (ownership) {
        const check = validateLiveOwnershipInTx(liveCheckpointInTx, liveBaselineInTx, ownership);
        if (!check.ok) {
          failCollision(check.error);
          return;
        }
        if (check.paused) {
          pausedResult = check.checkpoint;
          aborted = true;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          resolve({ pausedByPeer: true, checkpoint: check.checkpoint });
          return;
        }
        verifiedLiveCp = check.checkpoint;
      }
      for (const item of records) {
        const existing = existingMap.get(item.key);
        if (!isSafeArchiveOverwriteForSession(existing, item.key, item.sessionId, item.kind)) {
          failCollision(
            new Error(
              `ARCHIVE_KEY_COLLISION: Conflicting or unrelated metadata exists at key '${item.key}'`
            )
          );
          return;
        }
      }
      for (const item of records) {
        metaStore.put(item.record);
      }
      if (refreshLeaseHeartbeat && verifiedLiveCp) {
        metaStore.put({
          ...verifiedLiveCp,
          executionLeaseHeartbeatAtMs: Date.now(),
          updatedAt: new Date().toISOString(),
        });
      }
    };

    if (ownership) {
      const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
      cpReq.onsuccess = () => {
        liveCheckpointInTx = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
        checked += 1;
        if (checked === expectedChecks) onAllChecked();
      };
      cpReq.onerror = () =>
        failCollision(cpReq.error || new Error('ARCHIVE_WRITE_CHECKPOINT_READ_FAILED'));

      const blReq = metaStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
      blReq.onsuccess = () => {
        liveBaselineInTx = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
        checked += 1;
        if (checked === expectedChecks) onAllChecked();
      };
      blReq.onerror = () =>
        failCollision(blReq.error || new Error('ARCHIVE_WRITE_BASELINE_READ_FAILED'));
    }

    for (const item of records) {
      const req = metaStore.get(item.key);
      req.onsuccess = () => {
        existingMap.set(item.key, req.result);
        checked += 1;
        if (checked === expectedChecks) {
          onAllChecked();
        }
      };
      req.onerror = () => {
        failCollision(
          req.error || new Error(`ARCHIVE_COLLISION_CHECK_READ_FAILED:${item.key}`)
        );
      };
    }

    tx.oncomplete = () => {
      if (!aborted) resolve({ pausedByPeer: false, checkpoint: null });
    };
    tx.onerror = () => {
      if (!aborted && !pausedResult) reject(tx.error || new Error('ARCHIVE_WRITE_BATCH_TX_FAILED'));
    };
    tx.onabort = () => {
      if (!aborted && !pausedResult) reject(tx.error || new Error('ARCHIVE_WRITE_BATCH_TX_ABORTED'));
    };
  });
}

function readStocktakingInspectionContext(
  db: IDBDatabase,
  ownership?: ExpectedExecutionOwnership
): Promise<{
  pausedByPeer: boolean;
  checkpoint: UnitMigrationCheckpoint | null;
  sessions: unknown[];
  subItemsBySession: Map<string, unknown[]>;
  medicinesById: Map<string, unknown>;
  existingArchivesBySession: Map<string, StocktakingConflictArchiveEntry[]>;
  existingLegacyIndicesBySession: Map<string, { index: unknown; chunkCount: number }>;
}> {
  const stores = ['medicines', 'metadata'];
  if (db.objectStoreNames.contains('stocktaking_sessions')) stores.push('stocktaking_sessions');
  if (db.objectStoreNames.contains('stocktaking_items')) stores.push('stocktaking_items');

  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readonly');
    let medicines: unknown[] = [];
    let sessions: unknown[] = [];
    let subItems: unknown[] = [];
    let metadataRows: unknown[] = [];
    let loaded = 0;

    const done = () => {
      loaded += 1;
      if (loaded < stores.length) return;

      let liveCp: UnitMigrationCheckpoint | null = null;
      let liveBl: FinancialBaselineDigestRecord | null = null;
      for (const m of metadataRows) {
        const kProp = getSafeOwnDataProp(m, 'key');
        if (!kProp.found || typeof kProp.value !== 'string') continue;
        if (kProp.value === UNIT_MIGRATION_CHECKPOINT_KEY) {
          liveCp = m as UnitMigrationCheckpoint;
        } else if (kProp.value === UNIT_MIGRATION_BASELINE_DIGEST_KEY) {
          liveBl = m as FinancialBaselineDigestRecord;
        }
      }

      if (ownership) {
        const check = validateLiveOwnershipInTx(liveCp, liveBl, ownership);
        if (!check.ok) {
          reject(check.error);
          return;
        }
        if (check.paused) {
          resolve({
            pausedByPeer: true,
            checkpoint: check.checkpoint,
            sessions: [],
            subItemsBySession: new Map(),
            medicinesById: new Map(),
            existingArchivesBySession: new Map(),
            existingLegacyIndicesBySession: new Map(),
          });
          return;
        }
      }

      const medicinesById = new Map<string, unknown>();
      for (const m of medicines) {
        const idProp = getSafeOwnDataProp(m, 'id');
        if (idProp.found && typeof idProp.value === 'string' && idProp.value.trim()) {
          medicinesById.set(idProp.value.trim(), m);
        }
      }

      const subItemsBySession = new Map<string, unknown[]>();
      for (const it of subItems) {
        const sProp = getSafeOwnDataProp(it, 'sessionId');
        const sid = sProp.found && typeof sProp.value === 'string' ? sProp.value.trim() : '';
        if (!sid) continue;
        const arr = subItemsBySession.get(sid) ?? [];
        arr.push(it);
        subItemsBySession.set(sid, arr);
      }

      const rawArchivesBySession = new Map<string, StocktakingConflictArchiveEntry[]>();
      const verifiedArchiveSessionIds = new Set<string>();
      const legacyIndicesRaw = new Map<string, unknown>();
      const chunkCountsBySession = new Map<string, number>();

      for (const m of metadataRows) {
        const kProp = getSafeOwnDataProp(m, 'key');
        if (!kProp.found || typeof kProp.value !== 'string') continue;

        if (kProp.value.startsWith(UNIT_MIGRATION_STOCKTAKING_ARCHIVE_CHUNK_PREFIX)) {
          const chunk = m as StocktakingConflictArchiveChunk;
          if (typeof chunk.sessionId === 'string' && Array.isArray(chunk.entries)) {
            const arr = rawArchivesBySession.get(chunk.sessionId) ?? [];
            arr.push(...chunk.entries);
            rawArchivesBySession.set(chunk.sessionId, arr);
            chunkCountsBySession.set(
              chunk.sessionId,
              (chunkCountsBySession.get(chunk.sessionId) ?? 0) + 1
            );
          }
        } else if (kProp.value.startsWith(UNIT_MIGRATION_STOCKTAKING_ARCHIVE_INDEX_PREFIX)) {
          const fmtProp = getSafeOwnDataProp(m, 'archiveFormat');
          const sessProp = getSafeOwnDataProp(m, 'sessionId');
          const totalProp = getSafeOwnDataProp(m, 'totalEntries');
          const verifiedProp = getSafeOwnDataProp(m, 'verifiedReadBack');
          if (sessProp.found && typeof sessProp.value === 'string') {
            if (verifiedProp.found && verifiedProp.value === true) {
              verifiedArchiveSessionIds.add(sessProp.value);
            }
            if (
              fmtProp.value !== 'BOUNDED_TREE_V2' &&
              typeof totalProp.value === 'number' &&
              totalProp.value > 0
            ) {
              legacyIndicesRaw.set(sessProp.value, sanitizeForPlainJson(m));
            }
          }
        }
      }

      const existingArchivesBySession = new Map<string, StocktakingConflictArchiveEntry[]>();
      for (const sid of verifiedArchiveSessionIds) {
        const entries = rawArchivesBySession.get(sid);
        if (entries) {
          existingArchivesBySession.set(sid, entries);
        }
      }

      const existingLegacyIndicesBySession = new Map<string, { index: unknown; chunkCount: number }>();
      for (const [sid, rawIdx] of legacyIndicesRaw.entries()) {
        existingLegacyIndicesBySession.set(sid, {
          index: rawIdx,
          chunkCount: chunkCountsBySession.get(sid) ?? 0,
        });
      }

      resolve({
        pausedByPeer: false,
        checkpoint: liveCp,
        sessions,
        subItemsBySession,
        medicinesById,
        existingArchivesBySession,
        existingLegacyIndicesBySession,
      });
    };

    const read = (name: string, assign: (rows: unknown[]) => void) => {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => {
        assign(Array.isArray(req.result) ? req.result : []);
        done();
      };
      req.onerror = () => reject(req.error || new Error(`Failed reading ${name}`));
    };

    read('medicines', (r) => (medicines = r));
    read('metadata', (r) => (metadataRows = r));
    if (stores.includes('stocktaking_sessions')) read('stocktaking_sessions', (r) => (sessions = r));
    if (stores.includes('stocktaking_items')) read('stocktaking_items', (r) => (subItems = r));

    tx.onerror = () => reject(tx.error || new Error('STOCKTAKING_PRE_READ_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('STOCKTAKING_PRE_READ_ABORTED'));
  });
}

function verifyStocktakingArchiveReadBack(
  db: IDBDatabase,
  indexKey: string,
  expectedDigest: string,
  expectedCount: number,
  ownership?: ExpectedExecutionOwnership
): Promise<{ ok: boolean; pausedByPeer: boolean; checkpoint: UnitMigrationCheckpoint | null }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['metadata'], 'readonly');
    const metaStore = tx.objectStore('metadata');
    let liveCheckpointInTx: UnitMigrationCheckpoint | null = null;
    let liveBaselineInTx: FinancialBaselineDigestRecord | null = null;
    let indexResult: StocktakingConflictArchiveIndex | undefined = undefined;
    let settled = false;

    const finish = (ok: boolean, pausedByPeer = false, checkpoint: UnitMigrationCheckpoint | null = null) => {
      if (settled) return;
      settled = true;
      resolve({ ok, pausedByPeer, checkpoint });
    };

    const startVerification = () => {
      if (settled) return;
      if (ownership) {
        const check = validateLiveOwnershipInTx(liveCheckpointInTx, liveBaselineInTx, ownership);
        if (!check.ok) {
          settled = true;
          reject(check.error);
          return;
        }
        if (check.paused) {
          finish(false, true, check.checkpoint);
          return;
        }
      }

      const idx = indexResult;
      if (
        !idx ||
        idx.archiveFormat !== 'BOUNDED_TREE_V2' ||
        idx.schemaVersion !== UNIT_MIGRATION_SCHEMA_VERSION ||
        idx.totalEntries !== expectedCount ||
        idx.archiveDigest !== expectedDigest ||
        idx.chunkSizeLimit !== STOCKTAKING_ARCHIVE_CHUNK_SIZE ||
        idx.indexPageSizeLimit !== STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE
      ) {
        finish(false);
        return;
      }

      if (expectedCount === 0) {
        finish(
          idx.chunkCount === 0 &&
            idx.indexPageCount === 0 &&
            idx.treeHeight === 0 &&
            idx.rootPageKey === null &&
            idx.rootPageDigest === null
        );
        return;
      }

      if (
        typeof idx.rootPageKey !== 'string' ||
        !idx.rootPageKey ||
        typeof idx.rootPageDigest !== 'string' ||
        !idx.rootPageDigest ||
        idx.treeHeight < 1 ||
        idx.indexPageCount < 1 ||
        idx.chunkCount < 1
      ) {
        finish(false);
        return;
      }

      const visitedPages = new Set<string>();
      const visitedChunks = new Set<string>();
      let runningDigest = computeStreamingArchiveDigestInit(idx.sessionId);
      let expectedNextChunkIndex = 0;
      let totalEntriesRead = 0;

      interface TraversalStep {
        readonly kind: 'PAGE' | 'CHUNK';
        readonly key: string;
        readonly expectedLevel?: number;
        readonly expectedPageIndex?: number;
        readonly expectedPageDigest?: string;
        readonly leafRef?: StocktakingConflictArchiveLeafRef;
        readonly onSubtreeResult?: (chunkCount: number, entryCount: number) => void;
      }

      const verifySubtree = (
        step: TraversalStep,
        onDone: (ok: boolean, chunks: number, entries: number) => void
      ) => {
        if (settled) return;
        if (step.kind === 'CHUNK') {
          const leafRef = step.leafRef!;
          if (visitedChunks.has(step.key)) {
            onDone(false, 0, 0);
            return;
          }
          visitedChunks.add(step.key);
          const cReq = metaStore.get(step.key);
          cReq.onsuccess = () => {
            const chunk = cReq.result as StocktakingConflictArchiveChunk | undefined;
            if (
              !chunk ||
              chunk.sessionId !== idx.sessionId ||
              chunk.chunkIndex !== leafRef.chunkIndex ||
              chunk.chunkIndex !== expectedNextChunkIndex ||
              !Array.isArray(chunk.entries) ||
              chunk.entries.length < 1 ||
              chunk.entries.length > STOCKTAKING_ARCHIVE_CHUNK_SIZE ||
              chunk.entries.length !== leafRef.entryCount
            ) {
              onDone(false, 0, 0);
              return;
            }
            const firstId = chunk.entries[0]?.conflictId;
            const lastId = chunk.entries[chunk.entries.length - 1]?.conflictId;
            if (firstId !== leafRef.firstConflictId || lastId !== leafRef.lastConflictId) {
              onDone(false, 0, 0);
              return;
            }
            const actualChunkDigest = computeCanonicalRecordsDigest(chunk.entries, (e) =>
              String((e as StocktakingConflictArchiveEntry).conflictId)
            );
            if (actualChunkDigest !== chunk.chunkDigest || actualChunkDigest !== leafRef.chunkDigest) {
              onDone(false, 0, 0);
              return;
            }
            runningDigest = stepStreamingArchiveDigest(
              runningDigest,
              chunk.chunkIndex,
              chunk.entries.length,
              actualChunkDigest
            );
            expectedNextChunkIndex += 1;
            totalEntriesRead += chunk.entries.length;
            onDone(true, 1, chunk.entries.length);
          };
          cReq.onerror = () => reject(cReq.error || new Error('ARCHIVE_CHUNK_READBACK_FAILED'));
          return;
        }

        // PAGE step
        if (visitedPages.has(step.key)) {
          onDone(false, 0, 0);
          return;
        }
        visitedPages.add(step.key);
        const pReq = metaStore.get(step.key);
        pReq.onsuccess = () => {
          const page = pReq.result as StocktakingConflictArchiveIndexPage | undefined;
          if (
            !page ||
            page.sessionId !== idx.sessionId ||
            page.schemaVersion !== UNIT_MIGRATION_SCHEMA_VERSION ||
            page.level !== step.expectedLevel ||
            (step.expectedPageIndex !== undefined && page.pageIndex !== step.expectedPageIndex) ||
            !Array.isArray(page.refs) ||
            page.refs.length < 1 ||
            page.refs.length > STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE
          ) {
            onDone(false, 0, 0);
            return;
          }

          const recomputedPageDigest = sha256HexSync(
            canonicalStableJson({
              sessionId: idx.sessionId,
              nodeType: page.nodeType,
              level: page.level,
              pageIndex: page.pageIndex,
              refs: page.refs,
            })
          );
          if (recomputedPageDigest !== page.pageDigest || recomputedPageDigest !== step.expectedPageDigest) {
            onDone(false, 0, 0);
            return;
          }

          if (page.nodeType === 'LEAF') {
            if (page.level !== 0) {
              onDone(false, 0, 0);
              return;
            }
            const refs = page.refs as ReadonlyArray<StocktakingConflictArchiveLeafRef>;
            let idxRef = 0;
            let pageChunks = 0;
            let pageEntries = 0;
            const nextLeafRef = () => {
              if (idxRef >= refs.length) {
                onDone(true, pageChunks, pageEntries);
                return;
              }
              const ref = refs[idxRef];
              idxRef += 1;
              if (!ref || typeof ref.chunkKey !== 'string') {
                onDone(false, 0, 0);
                return;
              }
              verifySubtree(
                { kind: 'CHUNK', key: ref.chunkKey, leafRef: ref },
                (ok, c, e) => {
                  if (!ok) {
                    onDone(false, 0, 0);
                    return;
                  }
                  pageChunks += c;
                  pageEntries += e;
                  nextLeafRef();
                }
              );
            };
            nextLeafRef();
            return;
          }

          if (page.nodeType === 'INTERNAL') {
            if (page.level < 1) {
              onDone(false, 0, 0);
              return;
            }
            const refs = page.refs as ReadonlyArray<StocktakingConflictArchiveInternalRef>;
            let idxRef = 0;
            let subChunks = 0;
            let subEntries = 0;
            const nextInternalRef = () => {
              if (idxRef >= refs.length) {
                onDone(true, subChunks, subEntries);
                return;
              }
              const ref = refs[idxRef];
              idxRef += 1;
              if (!ref || typeof ref.pageKey !== 'string' || ref.level !== page.level - 1) {
                onDone(false, 0, 0);
                return;
              }
              verifySubtree(
                {
                  kind: 'PAGE',
                  key: ref.pageKey,
                  expectedLevel: ref.level,
                  expectedPageIndex: ref.pageIndex,
                  expectedPageDigest: ref.pageDigest,
                },
                (ok, c, e) => {
                  if (!ok || c !== ref.subtreeChunkCount || e !== ref.subtreeEntryCount) {
                    onDone(false, 0, 0);
                    return;
                  }
                  subChunks += c;
                  subEntries += e;
                  nextInternalRef();
                }
              );
            };
            nextInternalRef();
            return;
          }

          onDone(false, 0, 0);
        };
        pReq.onerror = () => reject(pReq.error || new Error('ARCHIVE_PAGE_READBACK_FAILED'));
      };

      verifySubtree(
        {
          kind: 'PAGE',
          key: idx.rootPageKey,
          expectedLevel: idx.treeHeight - 1,
          expectedPageIndex: 0,
          expectedPageDigest: idx.rootPageDigest,
        },
        (ok, rootChunks, rootEntries) => {
          if (!ok) {
            finish(false);
            return;
          }
          finish(
            visitedPages.size === idx.indexPageCount &&
              visitedChunks.size === idx.chunkCount &&
              rootChunks === idx.chunkCount &&
              rootEntries === expectedCount &&
              totalEntriesRead === expectedCount &&
              expectedNextChunkIndex === idx.chunkCount &&
              runningDigest === expectedDigest
          );
        }
      );
    };

    const baseExpected = ownership ? 3 : 1;
    let baseLoaded = 0;
    const onBase = () => {
      baseLoaded += 1;
      if (baseLoaded === baseExpected) {
        startVerification();
      }
    };

    const indexReq = metaStore.get(indexKey);
    indexReq.onsuccess = () => {
      indexResult = indexReq.result as StocktakingConflictArchiveIndex | undefined;
      onBase();
    };
    indexReq.onerror = () => reject(indexReq.error || new Error('ARCHIVE_INDEX_READBACK_FAILED'));

    if (ownership) {
      const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
      cpReq.onsuccess = () => {
        liveCheckpointInTx = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
        onBase();
      };
      cpReq.onerror = () => reject(cpReq.error || new Error('ARCHIVE_READBACK_CP_FAILED'));

      const blReq = metaStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
      blReq.onsuccess = () => {
        liveBaselineInTx = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
        onBase();
      };
      blReq.onerror = () => reject(blReq.error || new Error('ARCHIVE_READBACK_BL_FAILED'));
    }

    tx.onerror = () => reject(tx.error || new Error('ARCHIVE_READBACK_TX_FAILED'));
    tx.onabort = () => reject(tx.error || new Error('ARCHIVE_READBACK_TX_ABORTED'));
  });
}

function readCheckpointAndBaseline(db: IDBDatabase): Promise<{
  checkpoint: UnitMigrationCheckpoint | null;
  baseline: FinancialBaselineDigestRecord | null;
  quarantineKeys: string[];
}> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['metadata'], 'readonly');
    const metaStore = tx.objectStore('metadata');
    const req = metaStore.getAll();
    req.onsuccess = () => {
      const rows = Array.isArray(req.result) ? req.result : [];
      let checkpoint: UnitMigrationCheckpoint | null = null;
      let baseline: FinancialBaselineDigestRecord | null = null;
      const quarantineKeys: string[] = [];
      for (const row of rows) {
        const kProp = getSafeOwnDataProp(row, 'key');
        if (!kProp.found || typeof kProp.value !== 'string') continue;
        if (kProp.value === UNIT_MIGRATION_CHECKPOINT_KEY) {
          checkpoint = row as UnitMigrationCheckpoint;
        } else if (kProp.value === UNIT_MIGRATION_BASELINE_DIGEST_KEY) {
          baseline = row as FinancialBaselineDigestRecord;
        } else if (kProp.value.startsWith(UNIT_MIGRATION_QUARANTINE_PREFIX)) {
          quarantineKeys.push(kProp.value);
        }
      }
      quarantineKeys.sort();
      resolve({ checkpoint, baseline, quarantineKeys });
    };
    req.onerror = () => reject(req.error || new Error('METADATA_READ_FAILED'));
  });
}

function verifyBoundedArchiveTreeInMetadataMap(
  metaByKey: ReadonlyMap<string, unknown>,
  sessionId: string,
  expectedMinEntries: number,
  expectedRequiredConflictIds: ReadonlySet<string>
): { ok: true } | { ok: false; reason: string } {
  const indexKey = `${UNIT_MIGRATION_STOCKTAKING_ARCHIVE_INDEX_PREFIX}${sessionId}`;
  const rawIdx = metaByKey.get(indexKey) as StocktakingConflictArchiveIndex | undefined;
  if (!rawIdx || typeof rawIdx !== 'object' || Array.isArray(rawIdx)) {
    return {
      ok: false,
      reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_MISSING: Missing archive index '${indexKey}' for session '${sessionId}'.`,
    };
  }
  const expectedKeyHash = sha256HexSync(sessionId).slice(0, 16);
  if (
    rawIdx.archiveFormat !== 'BOUNDED_TREE_V2' ||
    rawIdx.schemaVersion !== UNIT_MIGRATION_SCHEMA_VERSION ||
    rawIdx.sessionId !== sessionId ||
    rawIdx.sessionKeyHash !== expectedKeyHash ||
    rawIdx.verifiedReadBack !== true ||
    rawIdx.chunkSizeLimit !== STOCKTAKING_ARCHIVE_CHUNK_SIZE ||
    rawIdx.indexPageSizeLimit !== STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE ||
    !Number.isSafeInteger(rawIdx.totalEntries) ||
    rawIdx.totalEntries < expectedMinEntries
  ) {
    return {
      ok: false,
      reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_UNVERIFIED: Archive index '${indexKey}' is invalid or verifiedReadBack !== true.`,
    };
  }

  if (rawIdx.totalEntries === 0) {
    const emptyDigest = computeStreamingArchiveDigestInit(sessionId);
    if (
      rawIdx.chunkCount !== 0 ||
      rawIdx.indexPageCount !== 0 ||
      rawIdx.treeHeight !== 0 ||
      rawIdx.rootPageKey !== null ||
      rawIdx.rootPageDigest !== null ||
      rawIdx.archiveDigest !== emptyDigest
    ) {
      return {
        ok: false,
        reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_CORRUPT: Empty archive index '${indexKey}' has inconsistent root or digest.`,
      };
    }
    return { ok: true };
  }

  if (
    typeof rawIdx.rootPageKey !== 'string' ||
    !rawIdx.rootPageKey ||
    typeof rawIdx.rootPageDigest !== 'string' ||
    !rawIdx.rootPageDigest ||
    rawIdx.treeHeight < 1 ||
    rawIdx.indexPageCount < 1 ||
    rawIdx.chunkCount < 1
  ) {
    return {
      ok: false,
      reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_CORRUPT: Archive index '${indexKey}' has invalid tree dimensions.`,
    };
  }

  const visitedPages = new Set<string>();
  const visitedChunks = new Set<string>();
  const foundConflictIds = new Set<string>();
  let runningDigest = computeStreamingArchiveDigestInit(sessionId);
  let expectedNextChunkIndex = 0;
  let totalEntriesRead = 0;

  const verifyPage = (
    pageKey: string,
    expectedLevel: number,
    expectedPageIndex: number,
    expectedDigest: string
  ): { ok: true; chunks: number; entries: number } | { ok: false; reason: string } => {
    if (visitedPages.has(pageKey)) {
      return { ok: false, reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_CYCLE: Duplicate page '${pageKey}'.` };
    }
    visitedPages.add(pageKey);
    const page = metaByKey.get(pageKey) as StocktakingConflictArchiveIndexPage | undefined;
    if (
      !page ||
      page.sessionId !== sessionId ||
      page.schemaVersion !== UNIT_MIGRATION_SCHEMA_VERSION ||
      page.nodeKind !== 'ARCHIVE_INDEX_PAGE' ||
      page.level !== expectedLevel ||
      page.pageIndex !== expectedPageIndex ||
      !Array.isArray(page.refs) ||
      page.refs.length < 1 ||
      page.refs.length > STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE
    ) {
      return { ok: false, reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_PAGE_CORRUPT: Invalid page '${pageKey}'.` };
    }
    const recomputedPageDigest = sha256HexSync(
      canonicalStableJson({
        sessionId: page.sessionId,
        nodeType: page.nodeType,
        level: page.level,
        pageIndex: page.pageIndex,
        refs: page.refs,
      })
    );
    if (recomputedPageDigest !== page.pageDigest || page.pageDigest !== expectedDigest) {
      return { ok: false, reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_PAGE_DIGEST_MISMATCH: Page '${pageKey}' digest mismatch.` };
    }

    if (expectedLevel === 0) {
      if (page.nodeType !== 'LEAF') {
        return { ok: false, reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_PAGE_CORRUPT: Expected LEAF at level 0 for '${pageKey}'.` };
      }
      const leafRefs = page.refs as ReadonlyArray<StocktakingConflictArchiveLeafRef>;
      let pageEntries = 0;
      for (const leafRef of leafRefs) {
        if (!leafRef || typeof leafRef.chunkKey !== 'string' || visitedChunks.has(leafRef.chunkKey)) {
          return { ok: false, reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_CHUNK_INVALID: Duplicate or invalid chunk ref in '${pageKey}'.` };
        }
        visitedChunks.add(leafRef.chunkKey);
        const chunk = metaByKey.get(leafRef.chunkKey) as StocktakingConflictArchiveChunk | undefined;
        if (
          !chunk ||
          chunk.sessionId !== sessionId ||
          chunk.schemaVersion !== UNIT_MIGRATION_SCHEMA_VERSION ||
          chunk.nodeKind !== 'ARCHIVE_CHUNK' ||
          chunk.chunkIndex !== leafRef.chunkIndex ||
          chunk.chunkIndex !== expectedNextChunkIndex ||
          !Array.isArray(chunk.entries) ||
          chunk.entries.length < 1 ||
          chunk.entries.length > STOCKTAKING_ARCHIVE_CHUNK_SIZE ||
          chunk.entries.length !== leafRef.entryCount ||
          chunk.entries[0]?.conflictId !== leafRef.firstConflictId ||
          chunk.entries[chunk.entries.length - 1]?.conflictId !== leafRef.lastConflictId
        ) {
          return { ok: false, reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_CHUNK_MISSING_OR_CORRUPT: Chunk '${leafRef.chunkKey}' failed integrity check.` };
        }
        const recomputedChunkDigest = computeCanonicalRecordsDigest(chunk.entries, (e) =>
          String((e as StocktakingConflictArchiveEntry).conflictId)
        );
        if (recomputedChunkDigest !== chunk.chunkDigest || chunk.chunkDigest !== leafRef.chunkDigest) {
          return { ok: false, reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_CHUNK_DIGEST_MISMATCH: Chunk '${leafRef.chunkKey}' digest mismatch.` };
        }
        for (const entry of chunk.entries) {
          foundConflictIds.add(entry.conflictId);
        }
        runningDigest = stepStreamingArchiveDigest(
          runningDigest,
          chunk.chunkIndex,
          chunk.entries.length,
          chunk.chunkDigest
        );
        expectedNextChunkIndex += 1;
        totalEntriesRead += chunk.entries.length;
        pageEntries += chunk.entries.length;
      }
      return { ok: true, chunks: leafRefs.length, entries: pageEntries };
    }

    if (page.nodeType !== 'INTERNAL') {
      return { ok: false, reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_PAGE_CORRUPT: Expected INTERNAL at level ${expectedLevel} for '${pageKey}'.` };
    }
    const childRefs = page.refs as ReadonlyArray<StocktakingConflictArchiveInternalRef>;
    let sumChunks = 0;
    let sumEntries = 0;
    for (const childRef of childRefs) {
      if (!childRef || childRef.level !== expectedLevel - 1) {
        return { ok: false, reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_PAGE_CORRUPT: Invalid child level ref in '${pageKey}'.` };
      }
      const childRes = verifyPage(
        childRef.pageKey,
        childRef.level,
        childRef.pageIndex,
        childRef.pageDigest
      );
      if (!childRes.ok) return childRes;
      if (childRes.chunks !== childRef.subtreeChunkCount || childRes.entries !== childRef.subtreeEntryCount) {
        return { ok: false, reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_SUBTREE_MISMATCH: Subtree counts mismatch in '${pageKey}'.` };
      }
      sumChunks += childRes.chunks;
      sumEntries += childRes.entries;
    }
    return { ok: true, chunks: sumChunks, entries: sumEntries };
  };

  const rootRes = verifyPage(
    rawIdx.rootPageKey,
    rawIdx.treeHeight - 1,
    0,
    rawIdx.rootPageDigest
  );
  if (!rootRes.ok) return rootRes;
  if (
    visitedPages.size !== rawIdx.indexPageCount ||
    visitedChunks.size !== rawIdx.chunkCount ||
    rootRes.chunks !== rawIdx.chunkCount ||
    rootRes.entries !== rawIdx.totalEntries ||
    totalEntriesRead !== rawIdx.totalEntries ||
    expectedNextChunkIndex !== rawIdx.chunkCount ||
    runningDigest !== rawIdx.archiveDigest
  ) {
    return {
      ok: false,
      reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_ROOT_MISMATCH: Archive tree summary mismatch for '${indexKey}'.`,
    };
  }
  for (const requiredCid of expectedRequiredConflictIds) {
    if (!foundConflictIds.has(requiredCid)) {
      return {
        ok: false,
        reason: `FINAL_VERIFY_STOCKTAKING_ARCHIVE_CONFLICT_MISSING: Required conflict '${requiredCid}' missing from verified archive for session '${sessionId}'.`,
      };
    }
  }
  return { ok: true };
}

const ALLOWED_OUTBOX_DEPENDENCY_TARGET_STATUSES = new Set([
  'pending',
  'retry',
  'processing',
  'syncing',
  'synced',
]);

/**
 * Validates the complete Outbox dependency DAG across all entity types (medicine, sale,
 * inventory_ledger, etc.) aligned with PharmacyDB's outbox dependency policy:
 * - Global canonical operationId uniqueness
 * - Well-formed dependsOn arrays without duplicate or empty items
 * - Unambiguous target existence (no missing or ambiguous references)
 * - No self-dependencies or multi-node cycles (iterative 3-color DFS)
 * - Rejects dependencies on failed ('failed'), terminal-blocked ('blocked', 'dead-letter'),
 *   deleted ('DELETE'), or unrecognized non-executable parent operations.
 */
function validateOutboxDependencyGraph(
  outbox: ReadonlyArray<unknown>
): { ok: true } | { ok: false; reason: string } {
  interface OutboxDagNode {
    index: number;
    oid: string;
    rowId: string;
    opId: string;
    status: string;
    action: string;
    hasDependsOnProp: boolean;
    rawDependsOn: unknown;
    neighborIndices: number[];
  }

  const nodes: OutboxDagNode[] = [];
  const byOpId = new Map<string, number[]>();
  const byRowId = new Map<string, number[]>();

  for (let i = 0; i < outbox.length; i += 1) {
    const entry = outbox[i];
    const oid = recordSortId(entry, i);
    const idProp = getSafeOwnDataProp(entry, 'id');
    const opProp = getSafeOwnDataProp(entry, 'operationId');
    const statusProp = getSafeOwnDataProp(entry, 'status');
    const actionProp = getSafeOwnDataProp(entry, 'action');
    const dependsOnProp = getSafeOwnDataProp(entry, 'dependsOn');

    const rowId = idProp.found && typeof idProp.value === 'string' ? idProp.value.trim() : '';
    const opId =
      opProp.found && typeof opProp.value === 'string' && opProp.value.trim()
        ? opProp.value.trim()
        : rowId || oid;
    const status =
      statusProp.found && typeof statusProp.value === 'string' ? statusProp.value.trim() : '';
    const action =
      actionProp.found && typeof actionProp.value === 'string' ? actionProp.value.trim() : '';

    nodes.push({
      index: i,
      oid,
      rowId,
      opId,
      status,
      action,
      hasDependsOnProp: dependsOnProp.found && dependsOnProp.value !== undefined,
      rawDependsOn: dependsOnProp.value,
      neighborIndices: [],
    });

    const opList = byOpId.get(opId) ?? [];
    opList.push(i);
    byOpId.set(opId, opList);

    if (rowId) {
      const rowList = byRowId.get(rowId) ?? [];
      rowList.push(i);
      byRowId.set(rowId, rowList);
    }
  }

  for (const [opId, indices] of byOpId.entries()) {
    if (indices.length > 1) {
      return {
        ok: false,
        reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate outbox operationId '${opId}'.`,
      };
    }
  }

  for (const node of nodes) {
    if (!node.hasDependsOnProp) continue;
    if (!Array.isArray(node.rawDependsOn)) {
      return {
        ok: false,
        reason: `BASELINE_INTEGRITY_MISMATCH: Outbox entry '${node.oid}' has malformed dependsOn.`,
      };
    }
    const seenDeps = new Set<string>();
    for (const rawDep of node.rawDependsOn) {
      if (typeof rawDep !== 'string' || !rawDep.trim()) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Outbox entry '${node.oid}' has malformed dependsOn.`,
        };
      }
      const dep = rawDep.trim();
      if (seenDeps.has(dep)) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Outbox entry '${node.oid}' has duplicate dependency '${dep}'.`,
        };
      }
      seenDeps.add(dep);

      const opMatches = byOpId.get(dep) ?? [];
      const legacyRowMatches = (byRowId.get(dep) ?? []).filter((idx) => nodes[idx].opId !== dep);
      if (
        opMatches.length > 1 ||
        (opMatches.length === 1 && legacyRowMatches.length > 0) ||
        (opMatches.length === 0 && legacyRowMatches.length > 1)
      ) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Outbox entry '${node.oid}' has ambiguous dependency '${dep}'.`,
        };
      }

      const parentIdx =
        opMatches.length === 1
          ? opMatches[0]
          : legacyRowMatches.length === 1
            ? legacyRowMatches[0]
            : undefined;
      if (parentIdx === undefined) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Outbox entry '${node.oid}' depends on missing operation '${dep}'.`,
        };
      }
      if (parentIdx === node.index || dep === node.opId || (node.rowId && dep === node.rowId)) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Self-dependent outbox entry '${node.oid}' references own operation '${dep}'.`,
        };
      }

      const parent = nodes[parentIdx];
      if (parent.status === 'failed') {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Outbox entry '${node.oid}' depends on failed operation '${dep}'.`,
        };
      }
      if (!ALLOWED_OUTBOX_DEPENDENCY_TARGET_STATUSES.has(parent.status)) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Outbox entry '${node.oid}' depends on disallowed terminal operation '${dep}' (status='${parent.status || 'MISSING'}').`,
        };
      }
      if (parent.action === 'DELETE') {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Outbox entry '${node.oid}' depends on disallowed terminal DELETE operation '${dep}'.`,
        };
      }

      node.neighborIndices.push(parentIdx);
    }
  }

  // Iterative 3-color DFS cycle detection (0=unvisited, 1=visiting, 2=visited)
  const color = new Uint8Array(nodes.length);
  for (let startIdx = 0; startIdx < nodes.length; startIdx += 1) {
    if (color[startIdx] !== 0 || nodes[startIdx].neighborIndices.length === 0) continue;
    const stack: Array<{ nodeIdx: number; edgePos: number }> = [{ nodeIdx: startIdx, edgePos: 0 }];
    color[startIdx] = 1;

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const currNode = nodes[top.nodeIdx];
      if (top.edgePos >= currNode.neighborIndices.length) {
        color[top.nodeIdx] = 2;
        stack.pop();
        continue;
      }
      const nextIdx = currNode.neighborIndices[top.edgePos];
      top.edgePos += 1;
      if (color[nextIdx] === 1) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Outbox dependency cycle detected between '${currNode.opId}' and '${nodes[nextIdx].opId}'.`,
        };
      }
      if (color[nextIdx] === 0) {
        color[nextIdx] = 1;
        stack.push({ nodeIdx: nextIdx, edgePos: 0 });
      }
    }
  }

  return { ok: true };
}

function evaluateFinalIntegrityOnSnapshots(params: {
  baseline: FinancialBaselineDigestRecord;
  checkpoint: UnitMigrationCheckpoint;
  dataMap: ReadonlyMap<string, unknown[]>;
  medicineStockFingerprints: ReadonlyMap<string, unknown>;
  allowConcurrentPosWrites: boolean;
  allowConcurrentMedicineEdits: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const {
    baseline,
    checkpoint,
    dataMap,
    medicineStockFingerprints,
    allowConcurrentPosWrites,
    allowConcurrentMedicineEdits,
  } = params;

  const medicines = dataMap.get('medicines') ?? [];
  const medicinesById = new Map<string, unknown>();
  const stockChangedCandidateMedIds = new Set<string>();
  const fpRecordByMedId = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < medicines.length; i += 1) {
    const medicineId = recordSortId(medicines[i], i);
    medicinesById.set(medicineId, medicines[i]);
    const rawFingerprint = medicineStockFingerprints.get(medicineId);
    const fingerprint = sanitizeForPlainJson(rawFingerprint) as Record<string, unknown> | null;
    if (
      !fingerprint ||
      fingerprint.schemaVersion !== 1 ||
      fingerprint.medicineId !== medicineId ||
      fingerprint.migrationRunId !== baseline.migrationRunId ||
      typeof fingerprint.fingerprint !== 'string' ||
      typeof fingerprint.unitIdentityFingerprint !== 'string' ||
      fingerprint.unitIdentityFingerprint !== computeMedicineUnitIdentityFingerprint(medicines[i])
    ) {
      return {
        ok: false,
        reason: `BASELINE_INTEGRITY_MISMATCH: Medicine '${medicineId}' unit/packing/stock state changed after its migration batch or has no final fingerprint.`,
      };
    }
    fpRecordByMedId.set(medicineId, fingerprint);
    if (fingerprint.fingerprint !== computeMedicineUnitStockFingerprint(medicines[i])) {
      if (!allowConcurrentPosWrites) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Medicine '${medicineId}' unit/packing/stock state changed after its migration batch or has no final fingerprint.`,
        };
      }
      stockChangedCandidateMedIds.add(medicineId);
    }
  }

  if (!allowConcurrentPosWrites) {
    if (allowConcurrentMedicineEdits && baseline.medicineStockHashesById) {
      const baseStockHashes = baseline.medicineStockHashesById;
      for (let i = 0; i < medicines.length; i += 1) {
        const med = medicines[i];
        const mid = recordSortId(med, i);
        const expectedStockHash = baseStockHashes[mid];
        if (expectedStockHash !== undefined) {
          const liveStockHash = sha256HexSync(
            canonicalStableJson(projectSingleMedicineStockState(med, i))
          );
          if (liveStockHash !== expectedStockHash) {
            return {
              ok: false,
              reason: 'BASELINE_INTEGRITY_MISMATCH: Medicine stock fields or batch quantities changed during migration.',
            };
          }
        } else if (!isZeroStockMedicineState(med)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: New medicine '${mid}' added without allowConcurrentPosWrites cannot carry non-zero stock.`,
          };
        }
      }
    } else if (
      typeof baseline.digests.medicineStock !== 'string' ||
      computeMedicineStockDigest(medicines) !== baseline.digests.medicineStock
    ) {
      return {
        ok: false,
        reason: 'BASELINE_INTEGRITY_MISMATCH: Medicine stock fields or batch quantities changed during migration.',
      };
    }
  }

  const sessions = dataMap.get('stocktaking_sessions') ?? [];
  const subItems = dataMap.get('stocktaking_items') ?? [];
  const histSt = computeHistoricalStocktakingDigest(sessions, subItems);
  if (
    histSt.count !== baseline.counts.historicalStocktakingSessions ||
    histSt.digest !== baseline.digests.historicalStocktaking
  ) {
    return {
      ok: false,
      reason: 'BASELINE_INTEGRITY_MISMATCH: Historical stocktaking sessions/items were modified.',
    };
  }

  // M-1: Atomic verification of stocktaking cursor completeness & archive/review integrity inside FINAL_VERIFY tx
  const metadataRows = dataMap.get('metadata') ?? [];
  const metaByKey = new Map<string, unknown>();
  for (const m of metadataRows) {
    const kProp = getSafeOwnDataProp(m, 'key');
    if (kProp.found && typeof kProp.value === 'string') {
      metaByKey.set(kProp.value, m);
    }
  }
  const subItemsBySession = new Map<string, unknown[]>();
  for (const it of subItems) {
    const sProp = getSafeOwnDataProp(it, 'sessionId');
    const sid = sProp.found && typeof sProp.value === 'string' ? sProp.value.trim() : '';
    if (!sid) continue;
    const arr = subItemsBySession.get(sid) ?? [];
    arr.push(it);
    subItemsBySession.set(sid, arr);
  }
  const sortedSessions = [...sessions]
    .map((raw, idx) => ({ id: recordSortId(raw, idx), raw }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (sortedSessions.length > 0) {
    const expectedLastSessionId = sortedSessions[sortedSessions.length - 1].id;
    if (
      checkpoint.lastStocktakingSessionCursorId === null ||
      checkpoint.lastStocktakingSessionCursorId !== expectedLastSessionId
    ) {
      return {
        ok: false,
        reason: `FINAL_VERIFY_STOCKTAKING_INCOMPLETE: lastStocktakingSessionCursorId '${String(checkpoint.lastStocktakingSessionCursorId)}' does not cover required session '${expectedLastSessionId}'.`,
      };
    }
  }

  for (const sessEntry of sortedSessions) {
    const sessSubItems = subItemsBySession.get(sessEntry.id) ?? [];
    const analysis = buildStocktakingConflictEntriesForSession({
      session: sessEntry.raw,
      subItems: sessSubItems,
      medicinesById,
      nowIso: checkpoint.updatedAt,
      migrationRunId: baseline.migrationRunId,
    });
    const indexKey = `${UNIT_MIGRATION_STOCKTAKING_ARCHIVE_INDEX_PREFIX}${sessEntry.id}`;
    const reviewKey = `${UNIT_MIGRATION_STOCKTAKING_REVIEW_PREFIX}${sessEntry.id}`;
    const liveIdx = metaByKey.get(indexKey);
    const liveReview = sanitizeForPlainJson(metaByKey.get(reviewKey)) as Record<string, unknown> | null;
    const hasConflicts = analysis.entries.length > 0 || analysis.reasonCodes.length > 0;

    if (analysis.entries.length > 0 || liveIdx !== undefined) {
      const requiredConflictIds = new Set(analysis.entries.map((e) => e.conflictId));
      const archiveCheck = verifyBoundedArchiveTreeInMetadataMap(
        metaByKey,
        sessEntry.id,
        analysis.entries.length,
        requiredConflictIds
      );
      if (!archiveCheck.ok) {
        return archiveCheck;
      }
    }

    if (hasConflicts) {
      if (
        !liveReview ||
        liveReview.reviewRequired !== true ||
        liveReview.sessionId !== sessEntry.id ||
        (analysis.entries.length > 0 && liveReview.archiveIndexKey !== indexKey)
      ) {
        return {
          ok: false,
          reason: `FINAL_VERIFY_STOCKTAKING_REVIEW_MISSING: Missing or invalid stocktaking review metadata '${reviewKey}' for session '${sessEntry.id}'.`,
        };
      }
    }
  }

  const purchaseInvoices = dataMap.get('purchase_invoices') ?? [];
  if (
    purchaseInvoices.length !== baseline.counts.purchaseInvoices ||
    computeCanonicalRecordsDigest(purchaseInvoices, recordSortId) !== baseline.digests.purchaseInvoices
  ) {
    return { ok: false, reason: 'BASELINE_INTEGRITY_MISMATCH: purchase_invoices changed.' };
  }

  const supplierTxs = dataMap.get('supplier_transactions') ?? [];
  if (
    supplierTxs.length !== baseline.counts.supplierTransactions ||
    computeCanonicalRecordsDigest(supplierTxs, recordSortId) !== baseline.digests.supplierTransactions
  ) {
    return { ok: false, reason: 'BASELINE_INTEGRITY_MISMATCH: supplier_transactions changed.' };
  }

  const suppliers = dataMap.get('suppliers') ?? [];
  if (
    suppliers.length !== baseline.counts.suppliers ||
    computeCanonicalRecordsDigest(suppliers, recordSortId) !== baseline.digests.suppliers
  ) {
    return { ok: false, reason: 'BASELINE_INTEGRITY_MISMATCH: suppliers changed.' };
  }

  const ledger = dataMap.get('inventory_ledger') ?? [];
  const sales = dataMap.get('sales') ?? [];
  const outbox = dataMap.get('outbox') ?? [];

  const ledgerDigest = computeCanonicalRecordsDigest(ledger, recordSortId);
  const salesDigest = computeCanonicalRecordsDigest(sales, recordSortId);
  const outboxDigest = computeCanonicalRecordsDigest(outbox, recordSortId);

  const validatedPostLedgerRows: Array<{
    id: string;
    medicineId: string;
    type: string;
    baseUnitsDelta: number;
    referenceId: string;
    saleId: string;
    raw: unknown;
    digest: string;
  }> = [];
  const postSaleRecordsById = new Map<
    string,
    { id: string; invoiceNumber: string; raw: unknown; digest: string }
  >();
  const postLedgerRowsByMed = new Map<
    string,
    Array<{ id: string; type: string; baseUnitsDelta: number }>
  >();
  const preBaselineLedgerMedIds = new Set<string>();
  const preBaselineSaleMedIds = new Set<string>();
  let validatePostBaselineUnitArithmetic:
    | (() => { ok: true } | { ok: false; reason: string })
    | null = null;

  if (!allowConcurrentPosWrites) {
    if (ledger.length !== baseline.counts.inventoryLedger || ledgerDigest !== baseline.digests.inventoryLedger) {
      return { ok: false, reason: 'BASELINE_INTEGRITY_MISMATCH: inventory_ledger changed.' };
    }
    if (sales.length !== baseline.counts.sales || salesDigest !== baseline.digests.sales) {
      return { ok: false, reason: 'BASELINE_INTEGRITY_MISMATCH: sales changed.' };
    }
    for (const row of ledger) {
      const medIdProp = getSafeOwnDataProp(row, 'medicineId');
      if (medIdProp.found && typeof medIdProp.value === 'string' && medIdProp.value.trim()) {
        preBaselineLedgerMedIds.add(medIdProp.value.trim());
      }
    }
    for (const s of sales) {
      const itemsProp = getSafeOwnDataProp(s, 'items');
      if (itemsProp.found && Array.isArray(itemsProp.value)) {
        for (const it of itemsProp.value) {
          const itemMedProp = getSafeOwnDataProp(it, 'medicineId');
          if (itemMedProp.found && typeof itemMedProp.value === 'string' && itemMedProp.value.trim()) {
            preBaselineSaleMedIds.add(itemMedProp.value.trim());
          }
        }
      }
    }
  } else {
    const preLedger = filterPreBaselineRecords(ledger, baseline.capturedAt);
    const preSales = filterPreBaselineRecords(sales, baseline.capturedAt);
    if (
      preLedger.length !== baseline.counts.inventoryLedger ||
      computeCanonicalRecordsDigest(preLedger, recordSortId) !== baseline.digests.inventoryLedger
    ) {
      return { ok: false, reason: 'BASELINE_INTEGRITY_MISMATCH: Pre-baseline inventory_ledger records modified.' };
    }
    if (
      preSales.length !== baseline.counts.sales ||
      computeCanonicalRecordsDigest(preSales, recordSortId) !== baseline.digests.sales
    ) {
      return { ok: false, reason: 'BASELINE_INTEGRITY_MISMATCH: Pre-baseline sales records modified.' };
    }

    // D-5: Strict post-baseline inventory_ledger & sales validation (allowlisted types, exact SALE cardinality/magnitude, backed non-SALE sources)
    const baselineCutoffMs = Date.parse(baseline.capturedAt);
    if (!Number.isFinite(baselineCutoffMs)) {
      return {
        ok: false,
        reason: 'BASELINE_INTEGRITY_MISMATCH: Invalid baseline capturedAt timestamp.',
      };
    }

    const ALLOWED_POST_LEDGER_TYPES = new Set([
      'SALE',
      'PURCHASE',
      'RETURN',
      'ADJUSTMENT',
      'DAMAGE',
      'INITIAL',
    ]);

    const allSalesSoldByIdAndMed = new Map<string, number>();
    const saleInvoiceBySaleId = new Map<string, string>();
    const saleIdByInvoiceNumber = new Map<string, string>();
    const invoiceNumbersSeen = new Set<string>();
    const seenPostSaleIds = new Set<string>();
    const saleRequirementByLedgerMovementId = new Map<
      string,
      { saleId: string; invoiceNumber: string; medicineId: string; itemIndex: number }
    >();
    const postSaleItemSpecs: Array<{
      saleId: string;
      invoiceNumber: string;
      itemIndex: number;
      medicineId: string;
      qty: unknown;
      unit: unknown;
      unitPrice: unknown;
      hasSellPriceProp: boolean;
      sellPrice: unknown;
      subtotal: unknown;
      baseUnits: number;
      ledgerMovementIds: string[];
      batchAllocations: Array<{ ledgerMovementId: string; baseUnits: number }> | null;
    }> = [];
    const postSaleFinancialSpecs: Array<{
      saleId: string;
      subtotal: unknown;
      discount: unknown;
      total: unknown;
      itemSubtotals: unknown[];
    }> = [];

    for (let i = 0; i < sales.length; i += 1) {
      const s = sales[i];
      const safeSale = sanitizeForPlainJson(s) as Record<string, unknown>;
      const sid = typeof safeSale?.id === 'string' ? safeSale.id.trim() : '';
      const invNo =
        typeof safeSale?.invoiceNumber === 'string' ? safeSale.invoiceNumber.trim() : '';
      const tsStr =
        typeof safeSale?.timestamp === 'string'
          ? safeSale.timestamp
          : typeof safeSale?.createdAt === 'string'
            ? safeSale.createdAt
            : '';
      const tsMs = Date.parse(tsStr);
      const isPost = Number.isFinite(tsMs) && tsMs > baselineCutoffMs;

      if (sid && invNo) {
        saleInvoiceBySaleId.set(sid, invNo);
        saleIdByInvoiceNumber.set(invNo, sid);
      }

      if (isPost) {
        if (!sid) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale row '${recordSortId(s, i)}' has missing id.`,
          };
        }
        if (seenPostSaleIds.has(sid)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate post-baseline sale id '${sid}'.`,
          };
        }
        seenPostSaleIds.add(sid);
        if (invNo) {
          if (invoiceNumbersSeen.has(invNo)) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate invoiceNumber '${invNo}' across sales records.`,
            };
          }
          invoiceNumbersSeen.add(invNo);
        }
        if (!Array.isArray(safeSale.items) || safeSale.items.length === 0) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sid}' has missing or empty items array.`,
          };
        }
        postSaleRecordsById.set(sid, {
          id: sid,
          invoiceNumber: invNo,
          raw: s,
          digest: sha256HexSync(canonicalStableJson(s)),
        });
        postSaleFinancialSpecs.push({
          saleId: sid,
          subtotal: safeSale.subtotal,
          discount: safeSale.discount,
          total: safeSale.total,
          itemSubtotals: safeSale.items.map((rawIt) =>
            rawIt && typeof rawIt === 'object' ? (rawIt as Record<string, unknown>).subtotal : undefined
          ),
        });
      } else if (invNo) {
        if (invoiceNumbersSeen.has(invNo)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate invoiceNumber '${invNo}' across sales records.`,
          };
        }
        invoiceNumbersSeen.add(invNo);
      }

      if (Array.isArray(safeSale?.items)) {
        for (let itemIdx = 0; itemIdx < safeSale.items.length; itemIdx += 1) {
          const it = safeSale.items[itemIdx];
          if (!it || typeof it !== 'object') {
            if (isPost) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sid}' has malformed line item[${itemIdx}].`,
              };
            }
            continue;
          }
          const itemRec = it as Record<string, unknown>;
          const itemMedId = typeof itemRec.medicineId === 'string' ? itemRec.medicineId.trim() : '';
          const itemBaseUnits = typeof itemRec.baseUnits === 'number' ? itemRec.baseUnits : NaN;
          const itemQty = typeof itemRec.qty === 'number' ? itemRec.qty : NaN;
          const soldBase = Number.isFinite(itemBaseUnits) ? itemBaseUnits : Number.isFinite(itemQty) ? itemQty : 0;
          if (sid && itemMedId && soldBase > 0) {
            const kId = `${sid}::${itemMedId}`;
            allSalesSoldByIdAndMed.set(kId, (allSalesSoldByIdAndMed.get(kId) ?? 0) + soldBase);
          }

          if (!isPost) {
            if (itemMedId) {
              preBaselineSaleMedIds.add(itemMedId);
            }
            continue;
          }

          if (!itemMedId || !medicinesById.has(itemMedId)) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sid}' references unknown medicine '${itemMedId}'.`,
            };
          }
          if (!Number.isSafeInteger(itemBaseUnits) || itemBaseUnits <= 0) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sid}' item[${itemIdx}] has invalid baseUnits.`,
            };
          }
          const lmIds: string[] = [];
          if (typeof itemRec.ledgerMovementId === 'string' && itemRec.ledgerMovementId.trim()) {
            lmIds.push(itemRec.ledgerMovementId.trim());
          }
          if (Array.isArray(itemRec.ledgerMovementIds)) {
            for (const rawLmId of itemRec.ledgerMovementIds) {
              if (typeof rawLmId === 'string' && rawLmId.trim() && !lmIds.includes(rawLmId.trim())) {
                lmIds.push(rawLmId.trim());
              }
            }
          }
          if (lmIds.length === 0) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sid}' item[${itemIdx}] lacks ledgerMovementId linkage.`,
            };
          }
          for (const lmId of lmIds) {
            if (saleRequirementByLedgerMovementId.has(lmId)) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Ledger movement '${lmId}' is referenced by multiple post-baseline sale items.`,
              };
            }
            saleRequirementByLedgerMovementId.set(lmId, {
              saleId: sid,
              invoiceNumber: invNo,
              medicineId: itemMedId,
              itemIndex: itemIdx,
            });
          }

          let parsedAllocs: Array<{ ledgerMovementId: string; baseUnits: number }> | null = null;
          if (itemRec.batchAllocations !== undefined) {
            if (!Array.isArray(itemRec.batchAllocations) || itemRec.batchAllocations.length === 0) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sid}' item[${itemIdx}] has invalid batchAllocations.`,
              };
            }
            parsedAllocs = [];
            let allocSum = 0;
            for (const rawAlloc of itemRec.batchAllocations) {
              if (!rawAlloc || typeof rawAlloc !== 'object') {
                return {
                  ok: false,
                  reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sid}' item[${itemIdx}] has malformed batchAllocation.`,
                };
              }
              const aRec = rawAlloc as Record<string, unknown>;
              const aLmId = typeof aRec.ledgerMovementId === 'string' ? aRec.ledgerMovementId.trim() : '';
              const aBase = typeof aRec.baseUnits === 'number' ? aRec.baseUnits : NaN;
              if (!aLmId || !Number.isFinite(aBase) || aBase <= 0 || !lmIds.includes(aLmId)) {
                return {
                  ok: false,
                  reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sid}' item[${itemIdx}] has inconsistent batchAllocation '${aLmId}'.`,
                };
              }
              allocSum += aBase;
              parsedAllocs.push({ ledgerMovementId: aLmId, baseUnits: aBase });
            }
            if (allocSum !== itemBaseUnits) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sid}' item[${itemIdx}] batchAllocations sum (${allocSum}) != baseUnits (${itemBaseUnits}).`,
              };
            }
          }

          postSaleItemSpecs.push({
            saleId: sid,
            invoiceNumber: invNo,
            itemIndex: itemIdx,
            medicineId: itemMedId,
            qty: itemRec.qty,
            unit: itemRec.unit,
            unitPrice: itemRec.unitPrice,
            hasSellPriceProp: Object.prototype.hasOwnProperty.call(itemRec, 'sellPrice') && itemRec.sellPrice !== undefined,
            sellPrice: itemRec.sellPrice,
            subtotal: itemRec.subtotal,
            baseUnits: itemBaseUnits,
            ledgerMovementIds: lmIds,
            batchAllocations: parsedAllocs,
          });
        }
      }
    }

    const cumulativeLedgerByMed = new Map<string, number>();
    const postTouchedMedIds = new Set<string>();
    const seenPostLedgerIds = new Set<string>();
    const postSaleLedgerById = new Map<
      string,
      { medicineId: string; baseUnitsDelta: number; referenceId: string; saleId: string }
    >();
    const canonicalReturnTotalByKey = new Map<string, number>();
    const postInitialMedIds = new Set<string>();
    const deferredUnlinkedAdjustmentOrDamage: Array<{ rowId: string; type: string }> = [];
    const postLedgerArithmeticSpecs: Array<{
      rowId: string;
      medicineId: string;
      type: string;
      unit: unknown;
      hasNumericQtyDelta: boolean;
      quantityDelta: number;
      baseUnitsDelta: number;
      batchNumber: string;
      timestampMs: number;
    }> = [];

    for (let i = 0; i < ledger.length; i += 1) {
      const row = ledger[i];
      const safeRow = sanitizeForPlainJson(row) as Record<string, unknown>;
      const medId = typeof safeRow?.medicineId === 'string' ? safeRow.medicineId.trim() : '';
      const delta = typeof safeRow?.baseUnitsDelta === 'number' ? safeRow.baseUnitsDelta : NaN;
      if (medId && Number.isFinite(delta)) {
        cumulativeLedgerByMed.set(medId, (cumulativeLedgerByMed.get(medId) ?? 0) + delta);
      }
      const tsStr =
        typeof safeRow?.timestamp === 'string'
          ? safeRow.timestamp
          : typeof safeRow?.createdAt === 'string'
            ? safeRow.createdAt
            : '';
      const tsMs = Date.parse(tsStr);
      const isPostBaseline = Number.isFinite(tsMs) && tsMs > baselineCutoffMs;
      if (!isPostBaseline) {
        if (medId) {
          preBaselineLedgerMedIds.add(medId);
        }
        const preType = typeof safeRow?.type === 'string' ? safeRow.type.trim().toUpperCase() : '';
        if (preType === 'RETURN' && medId && Number.isFinite(delta) && delta > 0) {
          const preRefId =
            typeof safeRow?.referenceId === 'string' && safeRow.referenceId.trim()
              ? safeRow.referenceId.trim()
              : '';
          const preExplicitSaleId =
            typeof safeRow?.saleId === 'string' && safeRow.saleId.trim() ? safeRow.saleId.trim() : '';
          const canonicalPreSaleId = preExplicitSaleId
            ? preExplicitSaleId
            : preRefId
              ? allSalesSoldByIdAndMed.has(`${preRefId}::${medId}`)
                ? preRefId
                : (saleIdByInvoiceNumber.get(preRefId) ?? '')
              : '';
          if (canonicalPreSaleId && allSalesSoldByIdAndMed.has(`${canonicalPreSaleId}::${medId}`)) {
            const cKey = `${canonicalPreSaleId}::${medId}`;
            canonicalReturnTotalByKey.set(cKey, (canonicalReturnTotalByKey.get(cKey) ?? 0) + delta);
          }
        }
        continue;
      }

      const rowId = typeof safeRow?.id === 'string' ? safeRow.id.trim() : '';
      if (!rowId) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline inventory_ledger row '${recordSortId(row, i)}' has missing id.`,
        };
      }
      if (seenPostLedgerIds.has(rowId)) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate post-baseline inventory_ledger id '${rowId}'.`,
        };
      }
      seenPostLedgerIds.add(rowId);

      if (!medId || !medicinesById.has(medId)) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline inventory_ledger row '${rowId}' references unknown medicine '${medId}'.`,
        };
      }
      if (!Number.isSafeInteger(delta) || delta === 0) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline inventory_ledger row '${rowId}' has invalid baseUnitsDelta.`,
        };
      }

      const typeStr = typeof safeRow?.type === 'string' ? safeRow.type.trim().toUpperCase() : '';
      const reasonStr = typeof safeRow?.reason === 'string' ? safeRow.reason.trim().toUpperCase() : '';
      if (!typeStr || !ALLOWED_POST_LEDGER_TYPES.has(typeStr)) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline inventory_ledger row '${rowId}' has unsupported type '${typeStr || 'MISSING'}'.`,
        };
      }
      if (reasonStr === 'SALE' && typeStr !== 'SALE') {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline inventory_ledger row '${rowId}' has mismatched reason 'SALE' with type '${typeStr}'.`,
        };
      }

      postTouchedMedIds.add(medId);
      const refId =
        typeof safeRow?.referenceId === 'string' && safeRow.referenceId.trim()
          ? safeRow.referenceId.trim()
          : '';
      const explicitSaleId =
        typeof safeRow?.saleId === 'string' && safeRow.saleId.trim() ? safeRow.saleId.trim() : '';
      const qtyDeltaProp = getSafeOwnDataProp(row, 'quantityDelta');
      const hasNumericQtyDelta =
        qtyDeltaProp.found && typeof qtyDeltaProp.value === 'number' && Number.isFinite(qtyDeltaProp.value);

      if (typeStr === 'SALE') {
        if (delta >= 0 || (hasNumericQtyDelta && (qtyDeltaProp.value as number) >= 0)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline SALE ledger row '${rowId}' must have negative baseUnitsDelta.`,
          };
        }
        const linkedSpec = saleRequirementByLedgerMovementId.get(rowId);
        if (!linkedSpec) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline SALE ledger row '${rowId}' lacks matching post-baseline sale '${explicitSaleId || refId || rowId}'.`,
          };
        }
        if (linkedSpec.medicineId !== medId) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline SALE ledger row '${rowId}' medicine '${medId}' mismatches sale item medicine '${linkedSpec.medicineId}'.`,
          };
        }
        if (explicitSaleId && explicitSaleId !== linkedSpec.saleId) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline SALE ledger row '${rowId}' saleId '${explicitSaleId}' mismatches linked sale '${linkedSpec.saleId}'.`,
          };
        }
        if (
          refId &&
          refId !== linkedSpec.saleId &&
          (!linkedSpec.invoiceNumber || refId !== linkedSpec.invoiceNumber)
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline SALE ledger row '${rowId}' referenceId '${refId}' mismatches linked sale '${linkedSpec.saleId}'.`,
          };
        }
        postSaleLedgerById.set(rowId, {
          medicineId: medId,
          baseUnitsDelta: delta,
          referenceId: refId,
          saleId: explicitSaleId,
        });
      } else if (typeStr === 'PURCHASE') {
        const batchNo = typeof safeRow?.batchNumber === 'string' ? safeRow.batchNumber.trim() : '';
        const expiryStr = typeof safeRow?.expiry === 'string' ? safeRow.expiry.trim() : '';
        const validQty = !hasNumericQtyDelta || (qtyDeltaProp.value as number) > 0;
        const validBatchReceipt =
          delta > 0 &&
          validQty &&
          batchNo.length > 0 &&
          expiryStr.length > 0 &&
          refId.startsWith('BATCH-IN-');
        if (!validBatchReceipt) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline PURCHASE ledger row '${rowId}' lacks valid backing batch/invoice receipt.`,
          };
        }
      } else if (typeStr === 'RETURN') {
        if (delta <= 0 || (hasNumericQtyDelta && (qtyDeltaProp.value as number) <= 0)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline RETURN ledger row '${rowId}' must have positive delta.`,
          };
        }
        if (explicitSaleId && refId) {
          const expectedInvForExplicit = saleInvoiceBySaleId.get(explicitSaleId);
          if (refId !== explicitSaleId && (!expectedInvForExplicit || refId !== expectedInvForExplicit)) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline RETURN ledger row '${rowId}' referenceId '${refId}' contradicts saleId '${explicitSaleId}'.`,
            };
          }
        }
        const canonicalSaleId = explicitSaleId
          ? explicitSaleId
          : refId
            ? allSalesSoldByIdAndMed.has(`${refId}::${medId}`)
              ? refId
              : (saleIdByInvoiceNumber.get(refId) ?? '')
            : '';
        const canonicalReturnKey = canonicalSaleId ? `${canonicalSaleId}::${medId}` : '';
        const maxSold = canonicalReturnKey ? allSalesSoldByIdAndMed.get(canonicalReturnKey) : undefined;
        if (!canonicalReturnKey || maxSold === undefined) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline RETURN ledger row '${rowId}' lacks matching sale '${explicitSaleId || refId}'.`,
          };
        }
        const nextRet = (canonicalReturnTotalByKey.get(canonicalReturnKey) ?? 0) + delta;
        if (nextRet > maxSold) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline RETURN total (${nextRet}) exceeds sold quantity (${maxSold}) for '${canonicalReturnKey}'.`,
          };
        }
        canonicalReturnTotalByKey.set(canonicalReturnKey, nextRet);
      } else if (typeStr === 'INITIAL') {
        const baseHashes = baseline.medicineFinancialHashesById;
        const isExistingBaselineMed =
          !baseHashes || Object.prototype.hasOwnProperty.call(baseHashes, medId);
        if (
          !allowConcurrentMedicineEdits ||
          isExistingBaselineMed ||
          delta <= 0 ||
          refId !== 'MANUAL-ADD' ||
          postInitialMedIds.has(medId)
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${rowId}' is unauthorized for medicine '${medId}'.`,
          };
        }
        postInitialMedIds.add(medId);
      } else {
        // ADJUSTMENT or DAMAGE — defer unlinked rejection until after cumulative negative balance check
        deferredUnlinkedAdjustmentOrDamage.push({ rowId, type: typeStr });
      }

      validatedPostLedgerRows.push({
        id: rowId,
        medicineId: medId,
        type: typeStr,
        baseUnitsDelta: delta,
        referenceId: refId,
        saleId: explicitSaleId,
        raw: row,
        digest: sha256HexSync(canonicalStableJson(row)),
      });
      postLedgerArithmeticSpecs.push({
        rowId,
        medicineId: medId,
        type: typeStr,
        unit: safeRow?.unit,
        hasNumericQtyDelta,
        quantityDelta: hasNumericQtyDelta ? (qtyDeltaProp.value as number) : NaN,
        baseUnitsDelta: delta,
        batchNumber: typeof safeRow?.batchNumber === 'string' ? safeRow.batchNumber.trim() : '',
        timestampMs: tsMs,
      });
      const medMovs = postLedgerRowsByMed.get(medId) ?? [];
      medMovs.push({ id: rowId, type: typeStr, baseUnitsDelta: delta });
      postLedgerRowsByMed.set(medId, medMovs);
    }

    // Reconcile every post-baseline sale item's ledgerMovementIds & baseUnits/batchAllocations 1-to-1
    for (const itemSpec of postSaleItemSpecs) {
      let itemLedgerSum = 0;
      for (const lmId of itemSpec.ledgerMovementIds) {
        const matchedRow = postSaleLedgerById.get(lmId);
        if (!matchedRow || matchedRow.medicineId !== itemSpec.medicineId) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' references missing SALE ledger movement '${lmId}'.`,
          };
        }
        itemLedgerSum += Math.abs(matchedRow.baseUnitsDelta);
      }
      if (itemLedgerSum !== itemSpec.baseUnits) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item baseUnits (${itemSpec.baseUnits}) mismatches linked ledger movements (${itemLedgerSum}).`,
        };
      }
      if (itemSpec.batchAllocations) {
        const allocByLm = new Map<string, number>();
        for (const a of itemSpec.batchAllocations) {
          allocByLm.set(a.ledgerMovementId, (allocByLm.get(a.ledgerMovementId) ?? 0) + a.baseUnits);
        }
        if (allocByLm.size !== itemSpec.ledgerMovementIds.length) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' ledgerMovementIds mismatch batchAllocations.`,
          };
        }
        for (const [lmId, aUnits] of allocByLm.entries()) {
          const matchedRow = postSaleLedgerById.get(lmId);
          if (!matchedRow || Math.abs(matchedRow.baseUnitsDelta) !== aUnits) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' allocation for '${lmId}' (${aUnits}) mismatches ledger delta.`,
            };
          }
        }
      }
    }

    for (const medId of postTouchedMedIds) {
      const bal = cumulativeLedgerByMed.get(medId) ?? 0;
      if (bal < 0) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Cumulative inventory_ledger balance for '${medId}' is negative (${bal}).`,
        };
      }
    }

    if (deferredUnlinkedAdjustmentOrDamage.length > 0) {
      const first = deferredUnlinkedAdjustmentOrDamage[0];
      return {
        ok: false,
        reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline ${first.type} ledger row '${first.rowId}' lacks verifiable stocktaking/source authorization.`,
      };
    }

    validatePostBaselineUnitArithmetic = (): { ok: true } | { ok: false; reason: string } => {
      for (const itemSpec of postSaleItemSpecs) {
        const medRaw = medicinesById.get(itemSpec.medicineId);
        const factor = resolveMedicineUnitConversionFactor(medRaw, itemSpec.unit);
        if (factor === null) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] has missing or unsupported unit '${String(itemSpec.unit ?? 'MISSING')}'.`,
          };
        }
        if (typeof itemSpec.qty !== 'number' || !Number.isSafeInteger(itemSpec.qty) || itemSpec.qty <= 0) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] has invalid qty.`,
          };
        }
        if (
          factor === 1
            ? Math.abs(itemSpec.qty - itemSpec.baseUnits) > 1e-6
            : Math.abs(itemSpec.qty * factor - itemSpec.baseUnits) > 1e-4
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] unit conversion (${itemSpec.qty} * ${factor}) != baseUnits (${itemSpec.baseUnits}).`,
          };
        }

        const unitStr = typeof itemSpec.unit === 'string' ? itemSpec.unit.trim() : '';
        const verifiedDef = resolveVerifiedUnitDefinitionForRecord(medRaw);
        let policyUnit: MedicineUnitKind | null = null;
        if (unitStr === 'pack' || (verifiedDef && unitStr === verifiedDef.packUnit)) {
          policyUnit = 'pack';
        } else if (unitStr === 'strip') {
          policyUnit = 'strip';
        } else if (unitStr === 'pill') {
          policyUnit = 'pill';
        }
        if (policyUnit === null) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] unit '${unitStr}' is unsupported for POS pricing.`,
          };
        }

        const priceSrcCheck = buildSafeMedicinePriceSource(medRaw);
        if (!priceSrcCheck.valid || priceSrcCheck.source.sellPrice === undefined) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] medicine '${itemSpec.medicineId}' has invalid selling price catalog configuration.`,
          };
        }
        if (
          (policyUnit === 'strip' &&
            (priceSrcCheck.source.sellPriceStrip === undefined ||
              priceSrcCheck.source.stripsPerPack === undefined ||
              priceSrcCheck.source.pillsPerStrip === undefined)) ||
          (policyUnit === 'pill' &&
            (priceSrcCheck.source.sellPricePill === undefined ||
              priceSrcCheck.source.stripsPerPack === undefined ||
              priceSrcCheck.source.pillsPerStrip === undefined))
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] lacks authoritative '${policyUnit}' pricing or solid factors on '${itemSpec.medicineId}'.`,
          };
        }
        if (!isMedicineUnitSellable(priceSrcCheck.source, policyUnit)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] unit '${policyUnit}' is not sellable for medicine '${itemSpec.medicineId}'.`,
          };
        }
        let authoritativeUnitPrice: number;
        try {
          authoritativeUnitPrice = getMedicineUnitSellingPrice(priceSrcCheck.source, policyUnit);
        } catch {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] failed authoritative unit price evaluation.`,
          };
        }

        if (
          typeof itemSpec.unitPrice !== 'number' ||
          !Number.isFinite(itemSpec.unitPrice) ||
          itemSpec.unitPrice < 0
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] has missing or invalid unitPrice.`,
          };
        }
        if (Math.abs(itemSpec.unitPrice - authoritativeUnitPrice) > 1e-6) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] unitPrice (${itemSpec.unitPrice}) mismatches authoritative price (${authoritativeUnitPrice}).`,
          };
        }
        if (
          itemSpec.hasSellPriceProp &&
          (typeof itemSpec.sellPrice !== 'number' ||
            !Number.isFinite(itemSpec.sellPrice) ||
            Math.abs(itemSpec.sellPrice - authoritativeUnitPrice) > 1e-6)
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] sellPrice disagrees with authoritative unit price (${authoritativeUnitPrice}).`,
          };
        }
        if (
          typeof itemSpec.subtotal !== 'number' ||
          !Number.isFinite(itemSpec.subtotal) ||
          itemSpec.subtotal < 0
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] has missing or invalid subtotal.`,
          };
        }
        if (Math.abs(itemSpec.subtotal - itemSpec.qty * authoritativeUnitPrice) > 1e-6) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${itemSpec.saleId}' item[${itemSpec.itemIndex}] subtotal disagrees with qty * unitPrice.`,
          };
        }
      }

      for (const sFin of postSaleFinancialSpecs) {
        if (typeof sFin.subtotal !== 'number' || !Number.isFinite(sFin.subtotal) || sFin.subtotal < 0) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sFin.saleId}' has missing or invalid subtotal.`,
          };
        }
        if (!sFin.itemSubtotals.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sFin.saleId}' has invalid item subtotal.`,
          };
        }
        const sumItems = (sFin.itemSubtotals as number[]).reduce((acc, v) => acc + v, 0);
        if (Math.abs(sumItems - sFin.subtotal) > 1e-6) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sFin.saleId}' subtotal disagrees with line items.`,
          };
        }
        if (
          typeof sFin.discount !== 'number' ||
          !Number.isFinite(sFin.discount) ||
          sFin.discount < 0 ||
          sFin.discount > sFin.subtotal + 1e-6
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sFin.saleId}' has missing or invalid discount.`,
          };
        }
        if (
          typeof sFin.total !== 'number' ||
          !Number.isFinite(sFin.total) ||
          sFin.total < 0 ||
          Math.abs(sFin.total - Math.max(0, sFin.subtotal - sFin.discount)) > 1e-6
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${sFin.saleId}' total disagrees with subtotal - discount.`,
          };
        }
      }

      for (const lSpec of postLedgerArithmeticSpecs) {
        const medRaw = medicinesById.get(lSpec.medicineId);
        const factor = resolveMedicineUnitConversionFactor(medRaw, lSpec.unit);
        if (factor === null) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline ${lSpec.type} ledger row '${lSpec.rowId}' has missing or unsupported unit '${String(lSpec.unit ?? 'MISSING')}'.`,
          };
        }
        if (!lSpec.hasNumericQtyDelta) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline ${lSpec.type} ledger row '${lSpec.rowId}' is missing numeric quantityDelta.`,
          };
        }
        if (lSpec.type === 'SALE') {
          const absQty = Math.abs(lSpec.quantityDelta);
          const absBase = Math.abs(lSpec.baseUnitsDelta);
          const matchesConversion =
            factor === 1
              ? Math.abs(absQty - absBase) <= 1e-6
              : Math.abs(absQty - Number((absBase / factor).toFixed(2))) <= 1e-6 ||
                Math.abs(absQty * factor - absBase) <= 1e-4;
          if (lSpec.quantityDelta >= 0 || !matchesConversion) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline SALE ledger row '${lSpec.rowId}' quantityDelta (${lSpec.quantityDelta} * ${factor}) contradicts baseUnitsDelta (${lSpec.baseUnitsDelta}).`,
            };
          }
        } else if (lSpec.type === 'PURCHASE' || lSpec.type === 'RETURN') {
          const matchesConversion =
            factor === 1
              ? Math.abs(lSpec.quantityDelta - lSpec.baseUnitsDelta) <= 1e-6
              : Math.abs(lSpec.quantityDelta * factor - lSpec.baseUnitsDelta) <= 1e-4;
          if (lSpec.quantityDelta <= 0 || !matchesConversion) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline ${lSpec.type} ledger row '${lSpec.rowId}' quantityDelta (${lSpec.quantityDelta} * ${factor}) contradicts baseUnitsDelta (${lSpec.baseUnitsDelta}).`,
            };
          }
        } else if (lSpec.type === 'INITIAL') {
          const packUnits = resolveMedicinePackBaseUnitsFactor(medRaw);
          const verifiedDef = resolveVerifiedUnitDefinitionForRecord(medRaw);
          const expectedPackUnit = verifiedDef ? verifiedDef.packUnit : 'pack';
          const unitStr = typeof lSpec.unit === 'string' ? lSpec.unit : '';
          if (
            packUnits === null ||
            (unitStr !== 'pack' && unitStr !== expectedPackUnit) ||
            factor !== packUnits ||
            lSpec.quantityDelta <= 0 ||
            Math.abs(lSpec.quantityDelta * factor - lSpec.baseUnitsDelta) > 1e-4
          ) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' unit conversion (${lSpec.quantityDelta} * ${String(factor)}) contradicts baseUnitsDelta (${lSpec.baseUnitsDelta}).`,
            };
          }

          const medCreatedAtVal = getSafeOwnDataProp(medRaw, 'createdAt').value;
          if (medCreatedAtVal !== undefined && medCreatedAtVal !== null) {
            const medCreatedAtMs = typeof medCreatedAtVal === 'string' ? Date.parse(medCreatedAtVal) : NaN;
            if (!Number.isFinite(medCreatedAtMs) || lSpec.timestampMs < medCreatedAtMs) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' predates new medicine createdAt.`,
              };
            }
          }

          const medBatchProp = getSafeOwnDataProp(medRaw, 'batchNumber');
          const medBatch = typeof medBatchProp.value === 'string' ? medBatchProp.value.trim() : '';
          if (!medBatch || !lSpec.batchNumber || lSpec.batchNumber !== medBatch) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' batchNumber '${lSpec.batchNumber}' contradicts new medicine batchNumber '${medBatch}'.`,
            };
          }

          const fpRec = fpRecordByMedId.get(lSpec.medicineId);
          if (fpRec) {
            const capturedIds = Array.isArray(fpRec.knownLedgerIdsAtCapture)
              ? fpRec.knownLedgerIdsAtCapture.filter((x): x is string => typeof x === 'string')
              : [];
            if (!capturedIds.includes(lSpec.rowId)) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' was injected after medicine capture.`,
              };
            }
          }

          const medInitialProp = getSafeOwnDataProp(medRaw, 'initialStock');
          const liveStockCheck = inspectExplicitStockFieldsOnLiveMed(medRaw, packUnits);
          const snapStockCheck = inspectExplicitStockFieldsOnSnapshot(
            fpRec?.stockSnapshot as Record<string, unknown> | undefined,
            packUnits
          );
          if (!liveStockCheck.valid || !snapStockCheck.valid) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' medicine '${lSpec.medicineId}' has contradictory stock state.`,
            };
          }

          const capturedIdSet = new Set(
            Array.isArray(fpRec?.knownLedgerIdsAtCapture)
              ? fpRec.knownLedgerIdsAtCapture.filter((x): x is string => typeof x === 'string')
              : []
          );
          const medMovements = postLedgerRowsByMed.get(lSpec.medicineId) ?? [];
          let capturedSum = 0;
          let totalLedgerSum = 0;
          for (const mv of medMovements) {
            totalLedgerSum += mv.baseUnitsDelta;
            if (capturedIdSet.has(mv.id)) {
              capturedSum += mv.baseUnitsDelta;
            }
          }

          if (
            (snapStockCheck.hasAnyExplicit && snapStockCheck.isExplicitlyZero && capturedSum > 0) ||
            (liveStockCheck.hasAnyExplicit && liveStockCheck.isExplicitlyZero && totalLedgerSum > 0)
          ) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' conflicts with zero-stock new medicine '${lSpec.medicineId}'.`,
            };
          }

          if (medInitialProp.found && medInitialProp.value !== undefined) {
            const initVal = typeof medInitialProp.value === 'number' ? medInitialProp.value : NaN;
            if (
              !Number.isFinite(initVal) ||
              initVal <= 0 ||
              Math.abs(initVal - lSpec.quantityDelta) > 1e-6 ||
              Math.abs(initVal * packUnits - lSpec.baseUnitsDelta) > 1e-4
            ) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' baseUnitsDelta (${lSpec.baseUnitsDelta}) contradicts medicine initialStock (${String(medInitialProp.value)}).`,
              };
            }
          }

          if (snapStockCheck.hasAnyExplicit) {
            if (
              snapStockCheck.agreedBaseUnits === null ||
              Math.abs(snapStockCheck.agreedBaseUnits - capturedSum) > 1e-4
            ) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' medicine snapshot stock (${String(snapStockCheck.agreedBaseUnits)}) disagrees with captured ledger (${capturedSum}).`,
              };
            }
          }

          if (liveStockCheck.hasAnyExplicit) {
            if (
              liveStockCheck.agreedBaseUnits === null ||
              Math.abs(liveStockCheck.agreedBaseUnits - totalLedgerSum) > 1e-4
            ) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' medicine live stock (${String(liveStockCheck.agreedBaseUnits)}) disagrees with ledger total (${totalLedgerSum}).`,
              };
            }
          }

          const medCreateOutbox = medicineCreateOutboxByMedId.get(lSpec.medicineId);
          if (!medCreateOutbox) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' lacks medicine CREATE outbox opening-stock proof for '${lSpec.medicineId}'.`,
            };
          }

          const medEvidenceProp = getSafeOwnDataProp(medRaw, 'openingStockEvidence');
          const snapEvidenceEntry = (fpRec?.stockSnapshot as Record<string, unknown> | undefined)
            ?.openingStockEvidence as { found?: boolean; value?: unknown } | undefined;
          const snapInitialEntry = (fpRec?.stockSnapshot as Record<string, unknown> | undefined)
            ?.initialStock as { found?: boolean; value?: unknown } | undefined;

          if (
            normalizePropForCreationEquality(medCreateOutbox.initialStockProp.found, medCreateOutbox.initialStockProp.value) !==
              normalizePropForCreationEquality(medInitialProp.found, medInitialProp.value) ||
            (fpRec?.stockSnapshot &&
              normalizePropForCreationEquality(Boolean(snapInitialEntry?.found), snapInitialEntry?.value) !==
                normalizePropForCreationEquality(medInitialProp.found, medInitialProp.value))
          ) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' opening initialStock diverges between medicine CREATE outbox, capture snapshot, and live record '${lSpec.medicineId}'.`,
            };
          }

          const hasLiveEvidence = isPropEffectivelyDefined(medEvidenceProp);
          const hasOutboxEvidence = isPropEffectivelyDefined(medCreateOutbox.openingStockEvidenceProp);
          const hasSnapEvidence = Boolean(
            snapEvidenceEntry &&
              isPropEffectivelyDefined({
                found: Boolean(snapEvidenceEntry.found),
                value: snapEvidenceEntry.value,
              })
          );
          if (
            hasLiveEvidence !== hasOutboxEvidence ||
            (fpRec?.stockSnapshot && hasLiveEvidence !== hasSnapEvidence) ||
            normalizePropForCreationEquality(
              medCreateOutbox.openingStockEvidenceProp.found,
              medCreateOutbox.openingStockEvidenceProp.value
            ) !== normalizePropForCreationEquality(medEvidenceProp.found, medEvidenceProp.value) ||
            (fpRec?.stockSnapshot &&
              normalizePropForCreationEquality(Boolean(snapEvidenceEntry?.found), snapEvidenceEntry?.value) !==
                normalizePropForCreationEquality(medEvidenceProp.found, medEvidenceProp.value))
          ) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' openingStockEvidence diverges between medicine CREATE outbox, capture snapshot, and live record '${lSpec.medicineId}'.`,
            };
          }

          if (
            !medInitialProp.found ||
            typeof medInitialProp.value !== 'number' ||
            !Number.isFinite(medInitialProp.value) ||
            medInitialProp.value <= 0
          ) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' lacks positive opening-stock creation evidence on medicine '${lSpec.medicineId}'.`,
            };
          }

          if (hasLiveEvidence) {
            const evCheck = validateOpeningStockCreationEvidence(
              medEvidenceProp.value,
              medRaw,
              lSpec.medicineId,
              medCreateOutbox.opId,
              packUnits
            );
            if (!evCheck.ok) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' for '${lSpec.medicineId}' failed openingStockEvidence check (${evCheck.reason}).`,
              };
            }
            if (
              evCheck.evidence.intent !== 'POSITIVE' ||
              Math.abs(evCheck.evidence.intendedInitialStock - lSpec.quantityDelta) > 1e-6 ||
              Math.abs(evCheck.evidence.intendedBaseUnits - lSpec.baseUnitsDelta) > 1e-4 ||
              evCheck.evidence.initialLedgerMovementId !== lSpec.rowId ||
              evCheck.evidence.batchNumber !== lSpec.batchNumber
            ) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger row '${lSpec.rowId}' contradicts openingStockEvidence on medicine '${lSpec.medicineId}'.`,
              };
            }
          }
        }
      }
      return { ok: true };
    };
  }

  // Validate medicine financial fields & ALL outbox integrity (including post-baseline POS outbox in BOTH edit modes!)
  const baselineCutoffMs = Date.parse(baseline.capturedAt);
  if (!Number.isFinite(baselineCutoffMs)) {
    return {
      ok: false,
      reason: 'BASELINE_INTEGRITY_MISMATCH: Invalid baseline capturedAt timestamp.',
    };
  }

  const seenIdempotencyKeys = new Set<string>();
  const medicineCreateOutboxByMedId = new Map<
    string,
    {
      opId: string;
      outboxId: string;
      initialStockProp: { found: boolean; value: unknown };
      openingStockEvidenceProp: { found: boolean; value: unknown };
    }
  >();
  const saleOutboxOpIdBySaleId = new Map<string, string>();
  const ledgerOutboxOpByLedgerId = new Map<string, { dependsOn: string[]; opId: string }>();

  if (!allowConcurrentMedicineEdits) {
    const medFinDigest = computeMedicineFinancialsDigest(medicines);
    if (medFinDigest !== baseline.digests.medicineFinancials) {
      return {
        ok: false,
        reason: 'BASELINE_INTEGRITY_MISMATCH: Medicine prices, barcodes, or batch fields changed during migration.',
      };
    }

    if (!allowConcurrentPosWrites) {
      if (outbox.length !== baseline.counts.outbox || outboxDigest !== baseline.digests.outbox) {
        return { ok: false, reason: 'BASELINE_INTEGRITY_MISMATCH: outbox changed.' };
      }
    } else {
      const preOutbox = filterPreBaselineRecords(outbox, baseline.capturedAt);
      if (
        preOutbox.length !== baseline.counts.outbox ||
        computeCanonicalRecordsDigest(preOutbox, recordSortId) !== baseline.digests.outbox
      ) {
        return { ok: false, reason: 'BASELINE_INTEGRITY_MISMATCH: Pre-baseline outbox records modified.' };
      }

      // Pass 1: Register all pre-baseline outbox identities BEFORE post-baseline checks so sort order cannot shadow collisions
      const baselineOutboxRowIds = new Set<string>();
      const baselineOutboxOpIds = new Set<string>();
      const baselineOutboxIdemKeys = new Set<string>();
      for (let i = 0; i < preOutbox.length; i += 1) {
        const entry = preOutbox[i];
        const safe = sanitizeForPlainJson(entry) as Record<string, unknown>;
        const rowId = typeof safe?.id === 'string' ? safe.id.trim() : '';
        const opId =
          typeof safe?.operationId === 'string' && safe.operationId.trim()
            ? safe.operationId.trim()
            : rowId;
        const idemKey = typeof safe?.idempotencyKey === 'string' ? safe.idempotencyKey.trim() : '';
        if (rowId) baselineOutboxRowIds.add(rowId);
        if (opId) baselineOutboxOpIds.add(opId);
        if (idemKey) baselineOutboxIdemKeys.add(idemKey);
      }

      const seenPosOpIds = new Set<string>();
      const seenPostRowIds = new Set<string>();
      for (let i = 0; i < outbox.length; i += 1) {
        const entry = outbox[i];
        const oid = recordSortId(entry, i);
        const safe = sanitizeForPlainJson(entry) as Record<string, unknown>;
        const liveTsStr =
          typeof safe?.timestamp === 'string'
            ? safe.timestamp
            : typeof safe?.createdAt === 'string'
              ? safe.createdAt
              : '';
        const liveTsMs = Date.parse(liveTsStr);
        const isPost = Number.isFinite(liveTsMs) && liveTsMs > baselineCutoffMs;
        if (!isPost) continue;

        const entityType = typeof safe?.entityType === 'string' ? safe.entityType : '';
        const entityId = typeof safe?.entityId === 'string' ? safe.entityId.trim() : '';
        const status = typeof safe?.status === 'string' ? safe.status : '';
        const action = typeof safe?.action === 'string' ? safe.action : '';
        const leaseOwner =
          typeof safe?.leaseOwner === 'string' && safe.leaseOwner.trim() ? safe.leaseOwner.trim() : null;
        const idemKey =
          typeof safe?.idempotencyKey === 'string' ? safe.idempotencyKey.trim() : '';
        const opProp = getSafeOwnDataProp(entry, 'operationId');
        const idProp = getSafeOwnDataProp(entry, 'id');
        const rowId = idProp.found && typeof idProp.value === 'string' ? idProp.value.trim() : '';
        const opId =
          opProp.found && typeof opProp.value === 'string' && opProp.value.trim()
            ? opProp.value.trim()
            : rowId;

        if (!idemKey) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline outbox entry '${oid}' is missing idempotencyKey.`,
          };
        }
        if (baselineOutboxIdemKeys.has(idemKey) || seenIdempotencyKeys.has(idemKey)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate outbox idempotencyKey '${idemKey}'.`,
          };
        }
        seenIdempotencyKeys.add(idemKey);

        if (entityType === 'medicine') {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Unauthorized post-baseline medicine outbox entry '${oid}'.`,
          };
        }

        if (entityType !== 'sale' && entityType !== 'inventory_ledger') {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Unsupported post-baseline outbox entityType '${entityType}' on '${oid}'.`,
          };
        }

        if (opId && (baselineOutboxOpIds.has(opId) || seenPosOpIds.has(opId))) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate outbox operationId '${opId}'.`,
          };
        }
        if (
          !rowId ||
          !opId ||
          (opProp.found && opProp.value !== undefined && opProp.value !== null && opProp.value !== rowId) ||
          baselineOutboxRowIds.has(rowId) ||
          seenPostRowIds.has(rowId) ||
          action !== 'CREATE' ||
          status !== 'pending' ||
          leaseOwner !== null ||
          !entityId ||
          idemKey !== `${entityType}:CREATE:${entityId}`
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Unauthorized post-baseline POS outbox entry '${oid}'.`,
          };
        }
        seenPostRowIds.add(rowId);
        seenPosOpIds.add(opId);

        if (entityType === 'sale') {
          const matchedSale = postSaleRecordsById.get(entityId);
          if (
            !matchedSale ||
            sha256HexSync(canonicalStableJson(safe?.payload)) !== matchedSale.digest
          ) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale outbox '${oid}' mismatches sales store.`,
            };
          }
          saleOutboxOpIdBySaleId.set(entityId, opId);
        } else {
          const matchedLedger = validatedPostLedgerRows.find((r) => r.id === entityId);
          if (
            !matchedLedger ||
            sha256HexSync(canonicalStableJson(safe?.payload)) !== matchedLedger.digest
          ) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline inventory_ledger outbox '${oid}' mismatches ledger store.`,
            };
          }
          const deps = Array.isArray(safe?.dependsOn)
            ? safe.dependsOn.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
            : [];
          if (safe?.dependsOn !== undefined && (!Array.isArray(safe.dependsOn) || deps.length !== safe.dependsOn.length)) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline inventory_ledger outbox '${oid}' has malformed dependsOn.`,
            };
          }
          ledgerOutboxOpByLedgerId.set(entityId, { dependsOn: deps, opId });
        }
      }
    }
  } else {
    const baseMedHashes = baseline.medicineFinancialHashesById;
    const baseOutboxSnaps = baseline.outboxBaselineSnapshots;
    if (!baseMedHashes || !baseOutboxSnaps) {
      return {
        ok: false,
        reason: 'BASELINE_INTEGRITY_MISMATCH: Missing per-medicine or outbox baseline snapshots for concurrent edit verification.',
      };
    }

    const liveMedById = new Map<string, { raw: unknown; hash: string }>();
    const changedMedicineIds = new Set<string>();
    for (let i = 0; i < medicines.length; i += 1) {
      const m = medicines[i];
      const mid = recordSortId(m, i);
      const liveHash = computeSingleMedicineFinancialHash(m, i);
      liveMedById.set(mid, { raw: m, hash: liveHash });
      const baseHash = baseMedHashes[mid];
      if (baseHash === undefined || baseHash !== liveHash) {
        changedMedicineIds.add(mid);
      }
    }
    for (const baseMid of Object.keys(baseMedHashes)) {
      if (!liveMedById.has(baseMid)) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Medicine '${baseMid}' was deleted during migration.`,
        };
      }
    }

    const nonMedOutbox = outbox.filter((o) => getSafeOwnDataProp(o, 'entityType').value !== 'medicine');
    const nonMedToCompare = allowConcurrentPosWrites
      ? filterPreBaselineRecords(nonMedOutbox, baseline.capturedAt)
      : nonMedOutbox;
    if (
      baseline.digests.nonMedicineOutbox === undefined ||
      computeCanonicalRecordsDigest(nonMedToCompare, recordSortId) !== baseline.digests.nonMedicineOutbox
    ) {
      return {
        ok: false,
        reason: 'BASELINE_INTEGRITY_MISMATCH: Non-medicine outbox records modified.',
      };
    }

    const liveOutboxIds = new Set<string>();
    const unchangedBaselineRowIds = new Set<string>();
    const unchangedBaselineOpIds = new Set<string>();
    const unchangedBaselineIdemKeys = new Set<string>();

    // Pass 1: Register all unchanged baseline entries first so post-baseline entries sorted before them cannot shadow collisions
    for (let i = 0; i < outbox.length; i += 1) {
      const entry = outbox[i];
      const oid = recordSortId(entry, i);
      const baseSnap = baseOutboxSnaps[oid];
      if (!baseSnap) continue;
      const liveDigest = sha256HexSync(canonicalStableJson(entry));
      if (liveDigest !== baseSnap.digest) continue;

      const safe = sanitizeForPlainJson(entry) as Record<string, unknown>;
      const rowId = typeof safe?.id === 'string' ? safe.id.trim() : '';
      const opId =
        typeof safe?.operationId === 'string' && safe.operationId.trim()
          ? safe.operationId.trim()
          : oid;
      const idemKey = typeof safe?.idempotencyKey === 'string' ? safe.idempotencyKey.trim() : '';

      if (rowId) unchangedBaselineRowIds.add(rowId);
      if (opId) unchangedBaselineOpIds.add(opId);
      if (idemKey) {
        if (seenIdempotencyKeys.has(idemKey)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate outbox idempotencyKey '${idemKey}'.`,
          };
        }
        seenIdempotencyKeys.add(idemKey);
        unchangedBaselineIdemKeys.add(idemKey);
      }
    }

    const seenMedicineOperationIds = new Set<string>();
    const seenPosOperationIds = new Set<string>();
    const seenNewMedCreates = new Set<string>();
    const provenUpdatedMedicineIds = new Set<string>();
    for (let i = 0; i < outbox.length; i += 1) {
      const entry = outbox[i];
      const oid = recordSortId(entry, i);
      liveOutboxIds.add(oid);
      const safe = sanitizeForPlainJson(entry) as Record<string, unknown>;
      const entityType = typeof safe?.entityType === 'string' ? safe.entityType : '';
      const entityId = typeof safe?.entityId === 'string' ? safe.entityId.trim() : '';
      const status = typeof safe?.status === 'string' ? safe.status : '';
      const action = typeof safe?.action === 'string' ? safe.action : '';
      const leaseOwner =
        typeof safe?.leaseOwner === 'string' && safe.leaseOwner.trim() ? safe.leaseOwner.trim() : null;
      const liveTsStr =
        typeof safe?.timestamp === 'string'
          ? safe.timestamp
          : typeof safe?.createdAt === 'string'
            ? safe.createdAt
            : '';
      const liveTsMs = Date.parse(liveTsStr);
      const baseSnap = baseOutboxSnaps[oid];

      const idemKey = typeof safe?.idempotencyKey === 'string' ? safe.idempotencyKey.trim() : '';

      if (entityType === 'medicine') {
        const operationIdProp = getSafeOwnDataProp(entry, 'operationId');
        const operationIdentity =
          typeof operationIdProp.value === 'string' && operationIdProp.value.trim()
            ? operationIdProp.value.trim()
            : oid;
        if (seenMedicineOperationIds.has(operationIdentity)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate medicine Outbox operation identity '${operationIdentity}'.`,
          };
        }
        seenMedicineOperationIds.add(operationIdentity);
      }

      if (baseSnap) {
        const liveDigest = sha256HexSync(canonicalStableJson(entry));
        if (liveDigest === baseSnap.digest) {
          continue;
        }
        if (idemKey) {
          if (seenIdempotencyKeys.has(idemKey)) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate outbox idempotencyKey '${idemKey}'.`,
            };
          }
          seenIdempotencyKeys.add(idemKey);
        }
        const liveMedForCoalesce = liveMedById.get(entityId);
        const coalescePayload = safe?.payload;
        const coalesceDosageProp = getSafeOwnDataProp(coalescePayload, 'dosageForm');
        const coalesceDosageValid =
          !liveMedForCoalesce ||
          coalesceDosageProp.value === undefined ||
          coalesceDosageProp.value === null ||
          coalesceDosageProp.value === getSafeOwnDataProp(liveMedForCoalesce.raw, 'dosageForm').value;
        const isValidCoalesce =
          baseSnap.entityType === 'medicine' &&
          baseSnap.status === 'pending' &&
          baseSnap.leaseOwner === null &&
          entityType === 'medicine' &&
          status === 'pending' &&
          leaseOwner === null &&
          entityId.length > 0 &&
          entityId === baseSnap.entityId &&
          Object.prototype.hasOwnProperty.call(baseMedHashes, entityId) &&
          Number.isFinite(liveTsMs) &&
          liveTsMs > baselineCutoffMs &&
          coalesceDosageValid &&
          isValidMedicineOutboxIdentity(entry, entityId, baselineCutoffMs) &&
          Boolean(liveMedForCoalesce) &&
          computeSingleMedicineFinancialHash(coalescePayload) === liveMedForCoalesce!.hash;

        if (!isValidCoalesce) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Unauthorized outbox mutation on entry '${oid}' (status='${baseSnap.status}->${status}', type='${baseSnap.entityType}->${entityType}').`,
          };
        }
        provenUpdatedMedicineIds.add(entityId);
      } else {
        if (!Number.isFinite(liveTsMs) || liveTsMs <= baselineCutoffMs) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: New outbox entry '${oid}' has missing or non-post-baseline timestamp.`,
          };
        }
        if (idemKey) {
          if (unchangedBaselineIdemKeys.has(idemKey) || seenIdempotencyKeys.has(idemKey)) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate outbox idempotencyKey '${idemKey}'.`,
            };
          }
          seenIdempotencyKeys.add(idemKey);
        }

        if (entityType !== 'medicine') {
          if (!allowConcurrentPosWrites) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Unexpected post-baseline non-medicine outbox entry '${oid}'.`,
            };
          }
          if (entityType !== 'sale' && entityType !== 'inventory_ledger') {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Unsupported post-baseline outbox entityType '${entityType}' on '${oid}'.`,
            };
          }
          const idProp = getSafeOwnDataProp(entry, 'id');
          const opProp = getSafeOwnDataProp(entry, 'operationId');
          const rowId = idProp.found && typeof idProp.value === 'string' ? idProp.value.trim() : '';
          const opId =
            opProp.found && typeof opProp.value === 'string' && opProp.value.trim()
              ? opProp.value.trim()
              : rowId;
          if (
            opId &&
            (unchangedBaselineOpIds.has(opId) ||
              seenPosOperationIds.has(opId) ||
              seenMedicineOperationIds.has(opId))
          ) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate outbox operationId '${opId}'.`,
            };
          }
          if (
            !rowId ||
            !opId ||
            (opProp.found && opProp.value !== undefined && opProp.value !== null && opProp.value !== rowId) ||
            unchangedBaselineRowIds.has(rowId) ||
            action !== 'CREATE' ||
            status !== 'pending' ||
            leaseOwner !== null ||
            !entityId ||
            idemKey !== `${entityType}:CREATE:${entityId}`
          ) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Unauthorized post-baseline POS outbox entry '${oid}'.`,
            };
          }
          seenPosOperationIds.add(opId);

          if (entityType === 'sale') {
            const matchedSale = postSaleRecordsById.get(entityId);
            if (
              !matchedSale ||
              sha256HexSync(canonicalStableJson(safe?.payload)) !== matchedSale.digest
            ) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale outbox '${oid}' mismatches sales store.`,
              };
            }
            saleOutboxOpIdBySaleId.set(entityId, opId);
          } else {
            const matchedLedger = validatedPostLedgerRows.find((r) => r.id === entityId);
            if (
              !matchedLedger ||
              sha256HexSync(canonicalStableJson(safe?.payload)) !== matchedLedger.digest
            ) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline inventory_ledger outbox '${oid}' mismatches ledger store.`,
              };
            }
            const deps = Array.isArray(safe?.dependsOn)
              ? safe.dependsOn.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
              : [];
            if (safe?.dependsOn !== undefined && (!Array.isArray(safe.dependsOn) || deps.length !== safe.dependsOn.length)) {
              return {
                ok: false,
                reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline inventory_ledger outbox '${oid}' has malformed dependsOn.`,
              };
            }
            ledgerOutboxOpByLedgerId.set(entityId, { dependsOn: deps, opId });
          }
          continue;
        }

        const opProp = getSafeOwnDataProp(entry, 'operationId');
        const opId =
          opProp.found && typeof opProp.value === 'string' && opProp.value.trim()
            ? opProp.value.trim()
            : oid;
        if (unchangedBaselineOpIds.has(opId) || seenPosOperationIds.has(opId)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline medicine outbox '${oid}' collides with non-medicine/baseline operationId '${opId}'.`,
          };
        }

        const isNewMedicineEntry = !Object.prototype.hasOwnProperty.call(baseMedHashes, entityId);
        const liveMedEntry = liveMedById.get(entityId);
        const liveMedRaw = liveMedEntry?.raw;
        const payloadObj = safe?.payload;
        const liveCreatedAt = getSafeOwnDataProp(liveMedRaw, 'createdAt').value;
        const createdAtValid =
          liveCreatedAt === undefined ||
          liveCreatedAt === null ||
          (typeof liveCreatedAt === 'string' &&
            Number.isFinite(Date.parse(liveCreatedAt)) &&
            (!isNewMedicineEntry || Date.parse(liveCreatedAt) > baselineCutoffMs));
        const unitAttrsMatch = !liveMedRaw
          ? false
          : isNewMedicineEntry
            ? (getSafeOwnDataProp(payloadObj, 'dosageForm').value ?? null) ===
                (getSafeOwnDataProp(liveMedRaw, 'dosageForm').value ?? null) &&
              (getSafeOwnDataProp(payloadObj, 'stripsPerPack').value ?? null) ===
                (getSafeOwnDataProp(liveMedRaw, 'stripsPerPack').value ?? null) &&
              (getSafeOwnDataProp(payloadObj, 'pillsPerStrip').value ?? null) ===
                (getSafeOwnDataProp(liveMedRaw, 'pillsPerStrip').value ?? null) &&
              (getSafeOwnDataProp(payloadObj, 'unitType').value ?? null) ===
                (getSafeOwnDataProp(liveMedRaw, 'unitType').value ?? null) &&
              (getSafeOwnDataProp(payloadObj, 'baseUnitsPerPack').value === undefined ||
                getSafeOwnDataProp(payloadObj, 'baseUnitsPerPack').value ===
                  getSafeOwnDataProp(liveMedRaw, 'baseUnitsPerPack').value)
            : getSafeOwnDataProp(payloadObj, 'dosageForm').value === undefined ||
              getSafeOwnDataProp(payloadObj, 'dosageForm').value === null ||
              getSafeOwnDataProp(payloadObj, 'dosageForm').value ===
                getSafeOwnDataProp(liveMedRaw, 'dosageForm').value;

        const isValidNewMedOutbox =
          status === 'pending' &&
          leaseOwner === null &&
          entityId.length > 0 &&
          createdAtValid &&
          unitAttrsMatch &&
          isValidMedicineOutboxIdentity(entry, entityId, baselineCutoffMs, {
            requireCreateAction: isNewMedicineEntry,
            requireUpdateAction: !isNewMedicineEntry,
          }) &&
          Boolean(liveMedEntry) &&
          computeSingleMedicineFinancialHash(safe?.payload) === liveMedEntry!.hash;

        if (!isValidNewMedOutbox) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Unauthorized post-baseline medicine outbox entry '${oid}' (status='${status}', leased=${leaseOwner !== null}).`,
          };
        }

        // Mutate state ONLY after full validation passes
        if (isNewMedicineEntry && action === 'CREATE') {
          if (seenNewMedCreates.has(entityId)) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Duplicate CREATE outbox proof for new medicine '${entityId}'.`,
            };
          }
          seenNewMedCreates.add(entityId);
          const rawCreatePayload = getSafeOwnDataProp(entry, 'payload').value;
          medicineCreateOutboxByMedId.set(entityId, {
            opId,
            outboxId: oid,
            initialStockProp: getSafeOwnDataProp(rawCreatePayload, 'initialStock'),
            openingStockEvidenceProp: getSafeOwnDataProp(rawCreatePayload, 'openingStockEvidence'),
          });
        }
        provenUpdatedMedicineIds.add(entityId);
      }
    }

    for (const baseOid of Object.keys(baseOutboxSnaps)) {
      if (!liveOutboxIds.has(baseOid)) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Baseline outbox entry '${baseOid}' was deleted during migration.`,
        };
      }
    }

    for (const changedMedId of changedMedicineIds) {
      if (!provenUpdatedMedicineIds.has(changedMedId)) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Medicine '${changedMedId}' financial fields changed without matching post-baseline pending outbox proof.`,
        };
      }
    }
  }

  if (allowConcurrentPosWrites || allowConcurrentMedicineEdits) {
    const dagCheck = validateOutboxDependencyGraph(outbox);
    if (!dagCheck.ok) {
      return dagCheck;
    }
  }

  // Enforce every post-baseline sale & ledger movement has its corresponding pending Outbox entry when allowConcurrentPosWrites=true
  if (allowConcurrentPosWrites) {
    for (const saleId of postSaleRecordsById.keys()) {
      if (!saleOutboxOpIdBySaleId.has(saleId)) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline sale '${saleId}' lacks matching pending sale outbox entry.`,
        };
      }
    }
    for (const row of validatedPostLedgerRows) {
      const obx = ledgerOutboxOpByLedgerId.get(row.id);
      if (!obx) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline inventory_ledger row '${row.id}' lacks matching pending outbox entry.`,
        };
      }
      if (row.type === 'INITIAL') {
        const medCreate = medicineCreateOutboxByMedId.get(row.medicineId);
        if (!medCreate || !obx.dependsOn.includes(medCreate.opId)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Post-baseline INITIAL ledger outbox for '${row.id}' lacks dependsOn link to medicine CREATE outbox.`,
          };
        }
      }
    }

    // Reconcile any post-batch medicine stock/batch quantity delta against validated post-capture ledger movements
    for (const medId of stockChangedCandidateMedIds) {
      const fpRec = fpRecordByMedId.get(medId);
      const liveMed = medicinesById.get(medId);
      const capturedIds = Array.isArray(fpRec?.knownLedgerIdsAtCapture)
        ? new Set(fpRec.knownLedgerIdsAtCapture.filter((x): x is string => typeof x === 'string'))
        : new Set<string>();
      const medMovements = postLedgerRowsByMed.get(medId) ?? [];
      let postCaptureDelta = 0;
      let hasPostCaptureMovement = false;
      for (const m of medMovements) {
        if (!capturedIds.has(m.id)) {
          postCaptureDelta += m.baseUnitsDelta;
          hasPostCaptureMovement = true;
        }
      }
      const stockSnap = fpRec?.stockSnapshot as Record<string, unknown> | undefined;
      if (
        !hasPostCaptureMovement ||
        !stockSnap ||
        !reconcileMedicineStockChangeWithValidatedDelta(stockSnap, liveMed, postCaptureDelta)
      ) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Medicine '${medId}' unit/packing/stock state changed after its migration batch or has no final fingerprint.`,
        };
      }
    }

    if (validatePostBaselineUnitArithmetic) {
      const arithResult = validatePostBaselineUnitArithmetic();
      if (!arithResult.ok) {
        return arithResult;
      }
    }
  }

  // Enforce complete opening-stock, capture-snapshot, and ledger-reconciliation integrity for ALL concurrent new medicines
  const baseMedHashesForNewCheck = baseline.medicineFinancialHashesById;
  if (baseMedHashesForNewCheck) {
    for (const [medId, medRaw] of medicinesById.entries()) {
      if (Object.prototype.hasOwnProperty.call(baseMedHashesForNewCheck, medId)) {
        continue;
      }
      if (preBaselineLedgerMedIds.has(medId) || preBaselineSaleMedIds.has(medId)) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' cannot reference pre-baseline ledger or sales records.`,
        };
      }

      const fpRec = fpRecordByMedId.get(medId);
      if (
        !fpRec ||
        !fpRec.stockSnapshot ||
        typeof fpRec.stockSnapshot !== 'object' ||
        Array.isArray(fpRec.stockSnapshot) ||
        !Array.isArray(fpRec.knownLedgerIdsAtCapture)
      ) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' lacks valid stock or ledger capture snapshot.`,
        };
      }

      const medMovements = postLedgerRowsByMed.get(medId) ?? [];
      const medMovementIds = new Set(medMovements.map((m) => m.id));
      const capturedIdSet = new Set<string>();
      for (const rawCapId of fpRec.knownLedgerIdsAtCapture) {
        if (typeof rawCapId !== 'string' || !rawCapId.trim()) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' has malformed knownLedgerIdsAtCapture entry.`,
          };
        }
        if (capturedIdSet.has(rawCapId) || !medMovementIds.has(rawCapId)) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' knownLedgerIdsAtCapture entry '${rawCapId}' is duplicated or missing from inventory_ledger.`,
          };
        }
        capturedIdSet.add(rawCapId);
      }

      const medCreateOutbox = medicineCreateOutboxByMedId.get(medId);
      if (!medCreateOutbox) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' lacks medicine CREATE outbox proof.`,
        };
      }

      const liveInitialProp = getSafeOwnDataProp(medRaw, 'initialStock');
      const snapInitialEntry = (fpRec.stockSnapshot as Record<string, unknown>).initialStock as
        | { found?: boolean; value?: unknown }
        | undefined;
      const liveEvidenceProp = getSafeOwnDataProp(medRaw, 'openingStockEvidence');
      const snapEvidenceEntry = (fpRec.stockSnapshot as Record<string, unknown>).openingStockEvidence as
        | { found?: boolean; value?: unknown }
        | undefined;

      if (
        normalizePropForCreationEquality(Boolean(snapEvidenceEntry?.found), snapEvidenceEntry?.value) !==
          normalizePropForCreationEquality(liveEvidenceProp.found, liveEvidenceProp.value) ||
        normalizePropForCreationEquality(
          medCreateOutbox.openingStockEvidenceProp.found,
          medCreateOutbox.openingStockEvidenceProp.value
        ) !== normalizePropForCreationEquality(liveEvidenceProp.found, liveEvidenceProp.value)
      ) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' openingStockEvidence mutated or diverges from CREATE outbox.`,
        };
      }

      if (
        normalizePropForCreationEquality(medCreateOutbox.initialStockProp.found, medCreateOutbox.initialStockProp.value) !==
        normalizePropForCreationEquality(liveInitialProp.found, liveInitialProp.value)
      ) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' initialStock diverges between CREATE outbox and live medicine.`,
        };
      }

      if (!allowConcurrentPosWrites) {
        if (
          !isZeroStockMedicineState(medRaw) ||
          !isZeroStockSnapshot(fpRec.stockSnapshot) ||
          medMovements.length > 0
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' added without allowConcurrentPosWrites cannot carry stock or ledger movements.`,
          };
        }
        if (isPropEffectivelyDefined(liveEvidenceProp)) {
          const evCheck = validateOpeningStockCreationEvidence(
            liveEvidenceProp.value,
            medRaw,
            medId,
            medCreateOutbox.opId,
            resolveMedicinePackBaseUnitsFactor(medRaw)
          );
          if (!evCheck.ok || evCheck.evidence.intent === 'POSITIVE') {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' has invalid or positive openingStockEvidence without allowConcurrentPosWrites.`,
            };
          }
        }
        continue;
      }

      let capturedSum = 0;
      let totalLedgerSum = 0;
      let postInitialRow: { id: string; baseUnitsDelta: number } | null = null;
      for (const mv of medMovements) {
        totalLedgerSum += mv.baseUnitsDelta;
        if (capturedIdSet.has(mv.id)) {
          capturedSum += mv.baseUnitsDelta;
        }
        if (mv.type === 'INITIAL') {
          postInitialRow = mv;
        }
      }

      const snapHasInitial = Boolean(
        snapInitialEntry?.found &&
          snapInitialEntry.value !== undefined &&
          snapInitialEntry.value !== null &&
          (typeof snapInitialEntry.value !== 'object' ||
            (snapInitialEntry.value as { __type?: string })?.__type !== 'undefined')
      );
      const liveHasInitial = Boolean(
        liveInitialProp.found && liveInitialProp.value !== undefined && liveInitialProp.value !== null
      );
      if (snapHasInitial) {
        if (
          typeof snapInitialEntry?.value !== 'number' ||
          !Number.isFinite(snapInitialEntry.value) ||
          snapInitialEntry.value < 0
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' has invalid captured initialStock (${String(snapInitialEntry?.value)}).`,
          };
        }
      }
      if (liveHasInitial) {
        if (
          typeof liveInitialProp.value !== 'number' ||
          !Number.isFinite(liveInitialProp.value) ||
          liveInitialProp.value < 0
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' has invalid initialStock (${String(liveInitialProp.value)}).`,
          };
        }
      }
      if (
        snapHasInitial !== liveHasInitial ||
        (liveHasInitial && snapInitialEntry?.value !== liveInitialProp.value)
      ) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' initialStock mutated after capture.`,
        };
      }
      const packUnits = resolveMedicinePackBaseUnitsFactor(medRaw);
      if (packUnits === null) {
        if (
          !isZeroStockMedicineState(medRaw) ||
          !isZeroStockSnapshot(fpRec.stockSnapshot) ||
          medMovements.length > 0
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' carries non-zero or unverifiable stock without valid packing configuration.`,
          };
        }
        continue;
      }

      if (isPropEffectivelyDefined(liveEvidenceProp)) {
        const evCheck = validateOpeningStockCreationEvidence(
          liveEvidenceProp.value,
          medRaw,
          medId,
          medCreateOutbox.opId,
          packUnits
        );
        if (!evCheck.ok) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' failed openingStockEvidence validation (${evCheck.reason}).`,
          };
        }
        if (evCheck.evidence.intent === 'POSITIVE') {
          if (
            !postInitialRow ||
            evCheck.evidence.initialLedgerMovementId !== postInitialRow.id ||
            Math.abs(evCheck.evidence.intendedBaseUnits - postInitialRow.baseUnitsDelta) > 1e-4
          ) {
            return {
              ok: false,
              reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' positive openingStockEvidence mismatches INITIAL ledger row.`,
            };
          }
        } else if (postInitialRow !== null) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' openingStockEvidence (${evCheck.evidence.intent}) forbids INITIAL ledger row '${postInitialRow.id}'.`,
          };
        }
      }

      if (liveHasInitial) {
        const initVal = liveInitialProp.value as number;
        if (initVal === 0 && postInitialRow !== null) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' has initialStock=0 conflicting with INITIAL ledger row '${postInitialRow.id}'.`,
          };
        }
        if (initVal > 0 && postInitialRow === null) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' has positive initialStock (${initVal}) without matching post-baseline INITIAL ledger row.`,
          };
        }
      } else if (postInitialRow !== null) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' lacks positive opening-stock creation evidence for INITIAL ledger row '${postInitialRow.id}'.`,
        };
      }

      const snapStockCheck = inspectExplicitStockFieldsOnSnapshot(
        fpRec.stockSnapshot as Record<string, unknown>,
        packUnits
      );
      const liveStockCheck = inspectExplicitStockFieldsOnLiveMed(medRaw, packUnits);
      if (!snapStockCheck.valid || !liveStockCheck.valid) {
        return {
          ok: false,
          reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' has invalid or contradictory explicit stock fields.`,
        };
      }

      if (snapStockCheck.hasAnyExplicit) {
        if (
          snapStockCheck.agreedBaseUnits === null ||
          Math.abs(snapStockCheck.agreedBaseUnits - capturedSum) > 1e-4
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' captured stock (${String(snapStockCheck.agreedBaseUnits)}) disagrees with captured ledger (${capturedSum}).`,
          };
        }
      }

      if (liveStockCheck.hasAnyExplicit) {
        if (
          liveStockCheck.agreedBaseUnits === null ||
          Math.abs(liveStockCheck.agreedBaseUnits - totalLedgerSum) > 1e-4
        ) {
          return {
            ok: false,
            reason: `BASELINE_INTEGRITY_MISMATCH: Concurrent new medicine '${medId}' live stock (${String(liveStockCheck.agreedBaseUnits)}) disagrees with ledger total (${totalLedgerSum}).`,
          };
        }
      }
    }
  }

  return { ok: true };
}

function hasValidNewMedicineOutboxProof(params: {
  medicineId: string;
  liveMed: unknown;
  outbox: ReadonlyArray<unknown>;
  baselineCutoffMs: number;
}): boolean {
  const { medicineId, liveMed, outbox, baselineCutoffMs } = params;
  const medFinHash = computeSingleMedicineFinancialHash(liveMed);
  const liveDosageForm = getSafeOwnDataProp(liveMed, 'dosageForm').value ?? null;
  const liveBaseUnits = getSafeOwnDataProp(liveMed, 'baseUnitsPerPack').value ?? null;
  const liveStrips = getSafeOwnDataProp(liveMed, 'stripsPerPack').value ?? null;
  const livePills = getSafeOwnDataProp(liveMed, 'pillsPerStrip').value ?? null;
  const liveUnitType = getSafeOwnDataProp(liveMed, 'unitType').value ?? null;
  const liveSellPack = getSafeOwnDataProp(liveMed, 'sellPack').value ?? null;
  const liveSellStrip = getSafeOwnDataProp(liveMed, 'sellStrip').value ?? null;
  const liveSellPill = getSafeOwnDataProp(liveMed, 'sellPill').value ?? null;
  const liveStockHash = sha256HexSync(canonicalStableJson(projectSingleMedicineStockState(liveMed)));
  const liveCreatedAt = getSafeOwnDataProp(liveMed, 'createdAt').value;
  if (
    liveCreatedAt !== undefined &&
    liveCreatedAt !== null &&
    (typeof liveCreatedAt !== 'string' ||
      !Number.isFinite(Date.parse(liveCreatedAt)) ||
      Date.parse(liveCreatedAt) <= baselineCutoffMs)
  ) {
    return false;
  }

  // Reject global outbox operationId / idempotencyKey collisions or multiple CREATE entries for this medicineId
  const seenOpIds = new Set<string>();
  const seenIdemKeys = new Set<string>();
  let matchingProofCount = 0;

  for (let i = 0; i < outbox.length; i += 1) {
    const entry = outbox[i];
    const safe = sanitizeForPlainJson(entry) as Record<string, unknown>;
    const rowId = typeof safe?.id === 'string' ? safe.id.trim() : '';
    const opId =
      typeof safe?.operationId === 'string' && safe.operationId.trim()
        ? safe.operationId.trim()
        : rowId;
    if (opId) {
      if (seenOpIds.has(opId)) return false;
      seenOpIds.add(opId);
    }
    const idem = typeof safe?.idempotencyKey === 'string' ? safe.idempotencyKey.trim() : '';
    if (idem) {
      if (seenIdemKeys.has(idem)) return false;
      seenIdemKeys.add(idem);
    }

    if (safe?.entityType !== 'medicine') continue;
    const entityId = typeof safe?.entityId === 'string' ? safe.entityId.trim() : '';
    if (entityId !== medicineId) continue;

    // Strict F-AUD-03: Never bypass non-pending, leased, or non-CREATE entries for the target new medicine
    const status = typeof safe?.status === 'string' ? safe.status : '';
    const leaseOwner =
      typeof safe?.leaseOwner === 'string' && safe.leaseOwner.trim() ? safe.leaseOwner.trim() : null;
    if (status !== 'pending' || leaseOwner !== null || safe?.action !== 'CREATE') {
      return false;
    }
    if (
      !isValidMedicineOutboxIdentity(entry, medicineId, baselineCutoffMs, {
        requireCreateAction: true,
      })
    ) {
      return false;
    }
    const payload = getSafeOwnDataProp(entry, 'payload').value;
    const payloadDosageForm = getSafeOwnDataProp(payload, 'dosageForm').value ?? null;
    const payloadBaseUnits = getSafeOwnDataProp(payload, 'baseUnitsPerPack').value ?? null;
    const payloadStrips = getSafeOwnDataProp(payload, 'stripsPerPack').value ?? null;
    const payloadPills = getSafeOwnDataProp(payload, 'pillsPerStrip').value ?? null;
    const payloadUnitType = getSafeOwnDataProp(payload, 'unitType').value ?? null;
    const payloadSellPack = getSafeOwnDataProp(payload, 'sellPack').value ?? null;
    const payloadSellStrip = getSafeOwnDataProp(payload, 'sellStrip').value ?? null;
    const payloadSellPill = getSafeOwnDataProp(payload, 'sellPill').value ?? null;
    const payloadStockHash = sha256HexSync(canonicalStableJson(projectSingleMedicineStockState(payload)));
    if (
      computeSingleMedicineFinancialHash(safe?.payload) !== medFinHash ||
      payloadDosageForm !== liveDosageForm ||
      payloadBaseUnits !== liveBaseUnits ||
      payloadStrips !== liveStrips ||
      payloadPills !== livePills ||
      payloadUnitType !== liveUnitType ||
      payloadSellPack !== liveSellPack ||
      payloadSellStrip !== liveSellStrip ||
      payloadSellPill !== liveSellPill ||
      payloadStockHash !== liveStockHash
    ) {
      return false;
    }

    matchingProofCount += 1;
    if (matchingProofCount > 1) return false;
  }
  return matchingProofCount === 1;
}

type CounterBucketKey =
  | 'MIGRATED_CONSERVATIVE'
  | 'QUARANTINED'
  | 'CONFLICTED'
  | 'SKIPPED';

function outcomeToCounterBucket(outcome: MedicineClassificationOutcome): CounterBucketKey {
  if (outcome.alreadyMigratedUnchanged) return 'SKIPPED';
  if (outcome.classification === 'MIGRATED_CONSERVATIVE') return 'MIGRATED_CONSERVATIVE';
  if (outcome.classification === 'CONFLICTED') return 'CONFLICTED';
  return 'QUARANTINED';
}

async function catchUpNewConcurrentMedicinesIfEnabled(
  db: IDBDatabase,
  activeRunId: string,
  activeExecutionLeaseId: string,
  expectedPhase: MigrationPhase,
  options: StartMigrationOptions
): Promise<{ pausedByPeer: boolean; checkpoint: UnitMigrationCheckpoint | null }> {
  if (!options.allowConcurrentMedicineEdits) {
    return { pausedByPeer: false, checkpoint: null };
  }

  const presentEvidenceStores = [...REQUIRED_EVIDENCE_STORES, ...OPTIONAL_EVIDENCE_STORES].filter((s) =>
    db.objectStoreNames.contains(s)
  );
  const catchupTxStores = Array.from(new Set<string>(['medicines', 'metadata', 'outbox', ...presentEvidenceStores]));

  // Bounded batches so even if many new medicines were created concurrently, no unbounded tx occurs
  let morePending = true;
  let latestCheckpoint: UnitMigrationCheckpoint | null = null;
  while (morePending) {
    morePending = false;
    const stepOutcome = await withLocalFirstMutationMutex(
      'UNIT_MIGRATION_CATCHUP_MEDICINES',
      async (lease): Promise<{
        pausedByPeer: boolean;
        checkpoint: UnitMigrationCheckpoint | null;
        moreRemaining: boolean;
      }> => {
        await assertLocalFirstMutationMutexLeaseCurrent(lease);
        return new Promise((resolve, reject) => {
          const localRetrySnapshot = readV1LocalStorageRetrySnapshot();
          const tx = db.transaction(catchupTxStores, 'readwrite');
          const medStore = tx.objectStore('medicines');
          const metaStore = tx.objectStore('metadata');

          const storeDataMap = new Map<string, unknown[]>();
          let liveCp: UnitMigrationCheckpoint | null = null;
          let liveBl: FinancialBaselineDigestRecord | null = null;
          let idbV1LeaseRows: unknown[] = [];
          const presentStoreSet = new Set<string>(presentEvidenceStores);
          let abortedByApp = false;
          let pausedByPeerResult: UnitMigrationCheckpoint | null = null;
          let committedCheckpoint: UnitMigrationCheckpoint | null = null;
          let hasMoreBatch = false;

          const otherStores = catchupTxStores.filter((s) => s !== 'metadata');
          const totalReadsExpected = 4 + otherStores.length;
          let readsCompleted = 0;

          const abortCatchup = (err: Error) => {
            if (abortedByApp) return;
            abortedByApp = true;
            try {
              tx.abort();
            } catch {
              // ignore
            }
            reject(err);
          };

          const onAllReads = () => {
            if (abortedByApp) return;
            try {
              const check = validateLiveOwnershipInTx(liveCp, liveBl, {
                migrationRunId: activeRunId,
                executionLeaseId: activeExecutionLeaseId,
                expectedPhase,
              });
              if (!check.ok) {
                abortCatchup(check.error);
                return;
              }
              if (check.paused) {
                pausedByPeerResult = check.checkpoint;
                abortedByApp = true;
                try {
                  tx.abort();
                } catch {
                  // ignore
                }
                resolve({ pausedByPeer: true, checkpoint: check.checkpoint, moreRemaining: false });
                return;
              }
              const verifiedCp = check.checkpoint;
              if (pauseRequestedFlag) {
                const nowIso = new Date().toISOString();
                const pausedCp: UnitMigrationCheckpoint = {
                  ...verifiedCp,
                  status: 'PAUSED',
                  pauseRequested: true,
                  pausedAt: verifiedCp.pausedAt ?? nowIso,
                  updatedAt: nowIso,
                  executionLeaseReleased: true,
                };
                metaStore.put(pausedCp);
                committedCheckpoint = pausedCp;
                pausedByPeerResult = pausedCp;
                hasMoreBatch = false;
                return;
              }
              const verifiedBl = check.baseline;

              const metadataRows = storeDataMap.get('metadata') ?? [];
              const existingQuarantines = new Map<string, MedicineQuarantineRecord>();
              const existingFingerprintsByMedId = new Map<string, Record<string, unknown>>();
              for (const row of metadataRows) {
                const kProp = getSafeOwnDataProp(row, 'key');
                if (!kProp.found || typeof kProp.value !== 'string') continue;
                if (kProp.value.startsWith(UNIT_MIGRATION_QUARANTINE_PREFIX)) {
                  existingQuarantines.set(
                    kProp.value.slice(UNIT_MIGRATION_QUARANTINE_PREFIX.length),
                    row as MedicineQuarantineRecord
                  );
                } else if (kProp.value.startsWith(UNIT_MIGRATION_MEDICINE_FINGERPRINT_PREFIX)) {
                  existingFingerprintsByMedId.set(
                    kProp.value.slice(UNIT_MIGRATION_MEDICINE_FINGERPRINT_PREFIX.length),
                    row as Record<string, unknown>
                  );
                }
              }

              const allMedicines = storeDataMap.get('medicines') ?? [];
              const allOutbox = storeDataMap.get('outbox') ?? [];
              const baseMedHashes = verifiedBl.medicineFinancialHashesById ?? {};
              const baselineCutoffMs = Date.parse(verifiedBl.capturedAt);
              const candidateNewMeds: Array<{ id: string; raw: unknown }> = [];

              for (let i = 0; i < allMedicines.length; i += 1) {
                const rawMed = allMedicines[i];
                const mid = recordSortId(rawMed, i);
                // Strictly only catch up BRAND-NEW post-baseline medicines with valid CREATE outbox proof
                if (Object.prototype.hasOwnProperty.call(baseMedHashes, mid)) {
                  continue;
                }
                const existingFp = existingFingerprintsByMedId.get(mid);
                if (
                  existingFp &&
                  existingFp.schemaVersion === 1 &&
                  existingFp.medicineId === mid &&
                  existingFp.migrationRunId === activeRunId
                ) {
                  continue;
                }
                if (
                  !Number.isFinite(baselineCutoffMs) ||
                  !hasValidNewMedicineOutboxProof({
                    medicineId: mid,
                    liveMed: rawMed,
                    outbox: allOutbox,
                    baselineCutoffMs,
                  })
                ) {
                  continue;
                }
                if (!options.allowConcurrentPosWrites && !isZeroStockMedicineState(rawMed)) {
                  continue;
                }
                const catchupEvProp = getSafeOwnDataProp(rawMed, 'openingStockEvidence');
                if (isPropEffectivelyDefined(catchupEvProp)) {
                  const catchupEvCheck = validateOpeningStockCreationEvidence(
                    catchupEvProp.value,
                    rawMed,
                    mid,
                    null,
                    resolveMedicinePackBaseUnitsFactor(rawMed)
                  );
                  if (!catchupEvCheck.ok) {
                    continue;
                  }
                }
                candidateNewMeds.push({ id: mid, raw: rawMed });
              }

              candidateNewMeds.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
              if (candidateNewMeds.length === 0) {
                committedCheckpoint = verifiedCp;
                hasMoreBatch = false;
                return;
              }

              const sliceLimit = clampBatchSize(verifiedCp.batchSize);
              const slice = candidateNewMeds.slice(0, sliceLimit);
              hasMoreBatch = candidateNewMeds.length > slice.length;

              const inTxEval = evaluateAllPackingLockEvidenceSnapshot({
                presentStores: presentStoreSet,
                medicines: allMedicines,
                ledger: storeDataMap.get('inventory_ledger') ?? [],
                sales: storeDataMap.get('sales') ?? [],
                purchaseInvoices: storeDataMap.get('purchase_invoices') ?? [],
                outbox: allOutbox,
                stocktakingSessions: storeDataMap.get('stocktaking_sessions') ?? [],
                stocktakingItems: storeDataMap.get('stocktaking_items') ?? [],
                supplierInvoiceDrafts: storeDataMap.get('supplier_invoice_drafts') ?? [],
                backupReviewMetadata: metadataRows,
                existingQuarantines,
                idbV1LeaseRows,
                localRetrySnapshot,
                v1InFlightMedicineIds: options.v1InFlightMedicineIds,
                v1InFlightInspector: options.v1InFlightInspector,
                v1InFlightEnumerator: options.v1InFlightEnumerator,
                v1InFlightAvailable: options.v1InFlightAvailable,
                v1InFlightNowMs: options.v1InFlightNowMs,
                v1ContextHints: options.v1ContextHints,
              });

              const batchIso = new Date().toISOString();
              let deltaProcessedUnique = 0;
              let deltaMigrated = 0;
              let deltaQuarantined = 0;
              let deltaConflicted = 0;
              let deltaSkipped = 0;

              const adjustBucket = (bucket: CounterBucketKey, sign: 1 | -1) => {
                if (bucket === 'SKIPPED') deltaSkipped += sign;
                else if (bucket === 'MIGRATED_CONSERVATIVE') deltaMigrated += sign;
                else if (bucket === 'CONFLICTED') deltaConflicted += sign;
                else deltaQuarantined += sign;
              };

              for (const entry of slice) {
                const latestQuarantine = existingQuarantines.get(entry.id) ?? null;
                const freshReport = inTxEval.buildReportForMedicine(
                  entry.id,
                  entry.raw,
                  latestQuarantine
                );
                const outcome = classifyMedicineRecordForMigration(entry.raw, {
                  hasHistoricalMovementOrPendingSync: freshReport.effectivePackingLocked,
                  packingLockReport: freshReport,
                  migrationRunId: activeRunId,
                  nowIso: batchIso,
                  fallbackRecordId: entry.id,
                  existingQuarantine: latestQuarantine,
                });

                const priorFp = existingFingerprintsByMedId.get(entry.id);
                const alreadyCountedInRun =
                  Boolean(priorFp && priorFp.schemaVersion === 1 && priorFp.migrationRunId === activeRunId);
                const newBucket = outcomeToCounterBucket(outcome);

                if (alreadyCountedInRun) {
                  const prevBucket = priorFp?.counterBucket as CounterBucketKey | undefined;
                  if (prevBucket && prevBucket !== newBucket) {
                    adjustBucket(prevBucket, -1);
                    adjustBucket(newBucket, 1);
                  }
                } else {
                  deltaProcessedUnique += 1;
                  adjustBucket(newBucket, 1);
                }

                if (outcome.updatedMedicineRecord) {
                  medStore.put(outcome.updatedMedicineRecord);
                }
                if (outcome.quarantineRecord) {
                  metaStore.put(outcome.quarantineRecord);
                }
                const finalMed = outcome.updatedMedicineRecord || entry.raw;
                const liveLedgerForFp = storeDataMap.get('inventory_ledger') ?? [];
                metaStore.put({
                  key: `${UNIT_MIGRATION_MEDICINE_FINGERPRINT_PREFIX}${entry.id}`,
                  schemaVersion: 1,
                  medicineId: entry.id,
                  migrationRunId: activeRunId,
                  counterBucket: newBucket,
                  fingerprint: computeMedicineUnitStockFingerprint(finalMed),
                  unitIdentityFingerprint: computeMedicineUnitIdentityFingerprint(finalMed),
                  stockSnapshot: projectSingleMedicineStockState(finalMed),
                  knownLedgerIdsAtCapture: extractLedgerIdsForMedicine(liveLedgerForFp, entry.id),
                  capturedAt: batchIso,
                });
              }

              const nextCheckpoint: UnitMigrationCheckpoint = {
                ...verifiedCp,
                totalMedicines: Math.max(verifiedCp.totalMedicines, allMedicines.length),
                processedMedicines: verifiedCp.processedMedicines + deltaProcessedUnique,
                migratedCount: Math.max(0, verifiedCp.migratedCount + deltaMigrated),
                quarantinedCount: Math.max(0, verifiedCp.quarantinedCount + deltaQuarantined),
                conflictedCount: Math.max(0, verifiedCp.conflictedCount + deltaConflicted),
                skippedAlreadyValidCount: Math.max(0, verifiedCp.skippedAlreadyValidCount + deltaSkipped),
                batchNumber: verifiedCp.batchNumber + 1,
                executionLeaseHeartbeatAtMs: Date.now(),
                updatedAt: batchIso,
              };
              metaStore.put(nextCheckpoint);
              committedCheckpoint = nextCheckpoint;
            } catch (err) {
              abortCatchup(err instanceof Error ? err : new Error(String(err)));
            }
          };

          const markRead = () => {
            readsCompleted += 1;
            if (readsCompleted === totalReadsExpected) {
              onAllReads();
            }
          };

          const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
          cpReq.onsuccess = () => {
            liveCp = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
            markRead();
          };
          cpReq.onerror = () => abortCatchup(cpReq.error || new Error('CATCHUP_CP_READ_FAILED'));

          const blReq = metaStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
          blReq.onsuccess = () => {
            liveBl = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
            markRead();
          };
          blReq.onerror = () => abortCatchup(blReq.error || new Error('CATCHUP_BL_READ_FAILED'));

          const v1Req = metaStore.getAll(
            IDBKeyRange.bound(V1_IN_FLIGHT_LEASE_IDB_PREFIX, `${V1_IN_FLIGHT_LEASE_IDB_PREFIX}\uffff`)
          );
          v1Req.onsuccess = () => {
            idbV1LeaseRows = Array.isArray(v1Req.result) ? v1Req.result : [];
            markRead();
          };
          v1Req.onerror = () => abortCatchup(v1Req.error || new Error('CATCHUP_V1_READ_FAILED'));

          const allMetaReq = metaStore.getAll();
          allMetaReq.onsuccess = () => {
            storeDataMap.set('metadata', Array.isArray(allMetaReq.result) ? allMetaReq.result : []);
            markRead();
          };
          allMetaReq.onerror = () => abortCatchup(allMetaReq.error || new Error('CATCHUP_META_READ_FAILED'));

          for (const storeName of otherStores) {
            const sReq = tx.objectStore(storeName).getAll();
            sReq.onsuccess = () => {
              storeDataMap.set(storeName, Array.isArray(sReq.result) ? sReq.result : []);
              markRead();
            };
            sReq.onerror = () => abortCatchup(sReq.error || new Error(`CATCHUP_READ_FAILED:${storeName}`));
          }

          tx.oncomplete = () => {
            if (!abortedByApp) {
              resolve({
                pausedByPeer: Boolean(committedCheckpoint?.status === 'PAUSED'),
                checkpoint: committedCheckpoint,
                moreRemaining: hasMoreBatch,
              });
            }
          };
          tx.onerror = () => {
            if (!abortedByApp && !pausedByPeerResult) {
              reject(tx.error || new Error('CATCHUP_TX_FAILED'));
            }
          };
          tx.onabort = () => {
            if (!abortedByApp && !pausedByPeerResult) {
              reject(tx.error || new Error('CATCHUP_TX_ABORTED'));
            }
          };
        });
      }
    );

    if (stepOutcome.pausedByPeer) {
      return { pausedByPeer: true, checkpoint: stepOutcome.checkpoint };
    }
    if (stepOutcome.checkpoint) {
      latestCheckpoint = stepOutcome.checkpoint;
    }
    morePending = stepOutcome.moreRemaining;
  }

  return { pausedByPeer: false, checkpoint: latestCheckpoint };
}

async function verifyAndCommitFinalMigrationInTx(
  db: IDBDatabase,
  activeRunId: string,
  activeExecutionLeaseId: string,
  options: StartMigrationOptions
): Promise<UnitMigrationCheckpoint> {
  const candidateStores = [
    'inventory_ledger',
    'sales',
    'purchase_invoices',
    'supplier_transactions',
    'suppliers',
    'outbox',
    'medicines',
    'stocktaking_sessions',
    'stocktaking_items',
  ].filter((name) => db.objectStoreNames.contains(name));

  const transactionStores = Array.from(new Set([...candidateStores, 'metadata'])).filter((name) =>
    db.objectStoreNames.contains(name)
  );

  return withLocalFirstMutationMutex('UNIT_MIGRATION_FINAL_VERIFY', async (lease) => {
    await assertLocalFirstMutationMutexLeaseCurrent(lease);
    return new Promise<UnitMigrationCheckpoint>((resolve, reject) => {
      const tx = db.transaction(transactionStores, 'readwrite');
      const metadataStore = tx.objectStore('metadata');
      const medicineStockFingerprints = new Map<string, unknown>();
      const dataMap = new Map<string, unknown[]>();
      let liveCheckpointInTx: UnitMigrationCheckpoint | null = null;
      let liveBaselineInTx: FinancialBaselineDigestRecord | null = null;
      let pending = candidateStores.length + 3;
      let abortedByApp = false;
      let pausedResult: UnitMigrationCheckpoint | null = null;
      let committedCheckpoint: UnitMigrationCheckpoint | null = null;

      const abortFinal = (err: Error) => {
        if (abortedByApp) return;
        abortedByApp = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      };

      const finalize = () => {
        pending -= 1;
        if (pending > 0 || abortedByApp) return;
        try {
          const check = validateLiveOwnershipInTx(liveCheckpointInTx, liveBaselineInTx, {
            migrationRunId: activeRunId,
            executionLeaseId: activeExecutionLeaseId,
            expectedPhase: 'FINAL_VERIFY',
          });
          if (!check.ok) {
            abortFinal(check.error);
            return;
          }
          if (check.paused) {
            pausedResult = check.checkpoint;
            abortedByApp = true;
            try {
              tx.abort();
            } catch {
              // ignore
            }
            resolve(check.checkpoint);
            return;
          }
          if (pauseRequestedFlag) {
            const nowIso = new Date().toISOString();
            const pausedCheckpoint: UnitMigrationCheckpoint = {
              ...check.checkpoint,
              status: 'PAUSED',
              pauseRequested: true,
              pausedAt: check.checkpoint.pausedAt ?? nowIso,
              updatedAt: nowIso,
              executionLeaseReleased: true,
            };
            metadataStore.put(pausedCheckpoint);
            committedCheckpoint = pausedCheckpoint;
            return;
          }

          const integrity = evaluateFinalIntegrityOnSnapshots({
            baseline: check.baseline,
            checkpoint: check.checkpoint,
            dataMap,
            medicineStockFingerprints,
            allowConcurrentPosWrites: Boolean(options.allowConcurrentPosWrites),
            allowConcurrentMedicineEdits: Boolean(options.allowConcurrentMedicineEdits),
          });
          if (!integrity.ok) {
            abortFinal(new Error(integrity.reason));
            return;
          }

          const doneIso = new Date().toISOString();
          const doneCheckpoint: UnitMigrationCheckpoint = {
            ...check.checkpoint,
            status: 'COMPLETED',
            phase: 'DONE',
            finalVerified: true,
            completedAt: doneIso,
            updatedAt: doneIso,
            pauseRequested: false,
            executionLeaseReleased: true,
            executionLeaseHeartbeatAtMs: Date.now(),
            verifiedMedicinesCount: 0,
            allMedicinesReadyForSale: false,
            operationalTrustIndependentFromMigrationCompletion: true,
          };
          metadataStore.put(doneCheckpoint);
          committedCheckpoint = doneCheckpoint;
        } catch (err) {
          abortFinal(err instanceof Error ? err : new Error(String(err)));
        }
      };

      const cpReq = metadataStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
      cpReq.onsuccess = () => {
        liveCheckpointInTx = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
        finalize();
      };
      cpReq.onerror = () =>
        abortFinal(cpReq.error || new Error('FINAL_VERIFY_CHECKPOINT_READ_FAILED'));

      const blReq = metadataStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
      blReq.onsuccess = () => {
        liveBaselineInTx = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
        finalize();
      };
      blReq.onerror = () =>
        abortFinal(blReq.error || new Error('FINAL_VERIFY_BASELINE_READ_FAILED'));

      const allMetaReq = metadataStore.getAll();
      allMetaReq.onsuccess = () => {
        dataMap.set('metadata', Array.isArray(allMetaReq.result) ? allMetaReq.result : []);
        finalize();
      };
      allMetaReq.onerror = () =>
        abortFinal(allMetaReq.error || new Error('FINAL_VERIFY_METADATA_READ_FAILED'));

      for (const storeName of candidateStores) {
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => {
          const rows = Array.isArray(req.result) ? req.result : [];
          dataMap.set(storeName, rows);
          if (storeName === 'medicines') {
            for (let i = 0; i < rows.length; i += 1) {
              const medicineId = getSafeOwnDataProp(rows[i], 'id').value;
              if (typeof medicineId !== 'string' || !medicineId.trim()) {
                const invalidKey = `__invalid_medicine_id_${i}`;
                medicineStockFingerprints.set(invalidKey, null);
                pending += 1;
                finalize();
                continue;
              }
              pending += 1;
              const fingerprintReq = metadataStore.get(
                `${UNIT_MIGRATION_MEDICINE_FINGERPRINT_PREFIX}${medicineId}`
              );
              fingerprintReq.onsuccess = () => {
                medicineStockFingerprints.set(medicineId, fingerprintReq.result ?? null);
                finalize();
              };
              fingerprintReq.onerror = () =>
                abortFinal(
                  fingerprintReq.error || new Error(`MEDICINE_FINAL_FINGERPRINT_READ_FAILED:${medicineId}`)
                );
            }
          }
          finalize();
        };
        req.onerror = () => abortFinal(req.error || new Error(`VERIFY_READ_FAILED: ${storeName}`));
      }

      tx.oncomplete = () => {
        if (!abortedByApp && committedCheckpoint) {
          resolve(committedCheckpoint);
        }
      };
      tx.onerror = () => {
        if (!abortedByApp && !pausedResult) reject(tx.error || new Error('VERIFY_TX_FAILED'));
      };
      tx.onabort = () => {
        if (!abortedByApp && !pausedResult) reject(tx.error || new Error('VERIFY_TX_ABORTED'));
      };
    });
  });
}

async function withCrossTabMigrationWebLock<T>(
  fn: (lockCtx: { readonly lockSupported: boolean; readonly heldExclusiveWebLock: boolean }) => Promise<T>,
  conflictErrorMessage = 'MIGRATION_ALREADY_IN_PROGRESS: Another browser tab holds the unit migration execution lock.'
): Promise<T> {
  const navLocks =
    typeof navigator !== 'undefined' &&
    navigator &&
    typeof navigator.locks?.request === 'function'
      ? navigator.locks
      : null;
  if (!navLocks) {
    return fn({ lockSupported: false, heldExclusiveWebLock: false });
  }
  return navLocks.request(
    UNIT_MIGRATION_EXECUTION_WEB_LOCK,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) {
        throw new Error(conflictErrorMessage);
      }
      return fn({ lockSupported: true, heldExclusiveWebLock: true });
    }
  );
}

async function renewExecutionLeaseHeartbeatInTx(
  db: IDBDatabase,
  activeRunId: string,
  activeExecutionLeaseId: string
): Promise<void> {
  await withLocalFirstMutationMutex('UNIT_MIGRATION_LEASE_HEARTBEAT', async (lease) => {
    await assertLocalFirstMutationMutexLeaseCurrent(lease);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['metadata'], 'readwrite');
      const metaStore = tx.objectStore('metadata');
      let liveCp: UnitMigrationCheckpoint | null = null;
      let liveBl: FinancialBaselineDigestRecord | null = null;
      let reads = 0;
      let aborted = false;

      const proceed = () => {
        const check = validateLiveOwnershipInTx(liveCp, liveBl, {
          migrationRunId: activeRunId,
          executionLeaseId: activeExecutionLeaseId,
        });
        if (!check.ok || check.paused) {
          aborted = true;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          resolve();
          return;
        }
        metaStore.put({
          ...check.checkpoint,
          executionLeaseHeartbeatAtMs: Date.now(),
          updatedAt: new Date().toISOString(),
        });
      };

      const onRead = () => {
        reads += 1;
        if (reads === 2) proceed();
      };

      const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
      cpReq.onsuccess = () => {
        liveCp = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
        onRead();
      };
      cpReq.onerror = () => reject(cpReq.error || new Error('HEARTBEAT_CP_READ_FAILED'));

      const blReq = metaStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
      blReq.onsuccess = () => {
        liveBl = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
        onRead();
      };
      blReq.onerror = () => reject(blReq.error || new Error('HEARTBEAT_BL_READ_FAILED'));

      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        if (!aborted) reject(tx.error || new Error('HEARTBEAT_TX_FAILED'));
      };
      tx.onabort = () => {
        if (!aborted) resolve();
      };
    });
  });
}

async function commitPauseIfStillOwnerInTx(
  db: IDBDatabase,
  activeRunId: string,
  activeExecutionLeaseId: string,
  expectedPhase?: MigrationPhase
): Promise<UnitMigrationCheckpoint> {
  return withLocalFirstMutationMutex('UNIT_MIGRATION_PAUSE_COMMIT', async (lease) => {
    await assertLocalFirstMutationMutexLeaseCurrent(lease);
    return new Promise<UnitMigrationCheckpoint>((resolve, reject) => {
      const tx = db.transaction(['metadata'], 'readwrite');
      const metaStore = tx.objectStore('metadata');
      let liveCp: UnitMigrationCheckpoint | null = null;
      let liveBl: FinancialBaselineDigestRecord | null = null;
      let reads = 0;
      let aborted = false;
      let alreadyPausedResult: UnitMigrationCheckpoint | null = null;
      let writtenCheckpoint: UnitMigrationCheckpoint | null = null;

      const failPause = (err: Error) => {
        if (aborted) return;
        aborted = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      };

      const proceed = () => {
        const check = validateLiveOwnershipInTx(liveCp, liveBl, {
          migrationRunId: activeRunId,
          executionLeaseId: activeExecutionLeaseId,
          expectedPhase,
          allowPaused: true,
        });
        if (!check.ok) {
          failPause(check.error);
          return;
        }
        if (check.checkpoint.status === 'PAUSED') {
          alreadyPausedResult = check.checkpoint;
          aborted = true;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          resolve(check.checkpoint);
          return;
        }
        const nowIso = new Date().toISOString();
        const nextPaused: UnitMigrationCheckpoint = {
          ...check.checkpoint,
          status: 'PAUSED',
          pauseRequested: true,
          pausedAt: check.checkpoint.pausedAt ?? nowIso,
          updatedAt: nowIso,
          executionLeaseReleased: true,
        };
        metaStore.put(nextPaused);
        writtenCheckpoint = nextPaused;
      };

      const onRead = () => {
        reads += 1;
        if (reads === 2) proceed();
      };

      const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
      cpReq.onsuccess = () => {
        liveCp = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
        onRead();
      };
      cpReq.onerror = () => failPause(cpReq.error || new Error('PAUSE_CP_READ_FAILED'));

      const blReq = metaStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
      blReq.onsuccess = () => {
        liveBl = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
        onRead();
      };
      blReq.onerror = () => failPause(blReq.error || new Error('PAUSE_BL_READ_FAILED'));

      tx.oncomplete = () => {
        if (!aborted && writtenCheckpoint) resolve(writtenCheckpoint);
      };
      tx.onerror = () => {
        if (!aborted && !alreadyPausedResult) reject(tx.error || new Error('PAUSE_TX_FAILED'));
      };
      tx.onabort = () => {
        if (!aborted && !alreadyPausedResult) reject(tx.error || new Error('PAUSE_TX_ABORTED'));
      };
    });
  });
}

async function commitPhaseTransitionInTx(
  db: IDBDatabase,
  activeRunId: string,
  activeExecutionLeaseId: string,
  expectedFromPhase: MigrationPhase,
  targetPhase: MigrationPhase,
  options?: Pick<StartMigrationOptions, 'onInsidePhaseTransitionTxBeforeCommit'>
): Promise<{ pausedByPeer: boolean; checkpoint: UnitMigrationCheckpoint }> {
  return withLocalFirstMutationMutex('UNIT_MIGRATION_PHASE_TRANSITION', async (lease) => {
    await assertLocalFirstMutationMutexLeaseCurrent(lease);
    return new Promise<{ pausedByPeer: boolean; checkpoint: UnitMigrationCheckpoint }>((resolve, reject) => {
      const tx = db.transaction(['metadata'], 'readwrite');
      const metaStore = tx.objectStore('metadata');
      let liveCp: UnitMigrationCheckpoint | null = null;
      let liveBl: FinancialBaselineDigestRecord | null = null;
      let reads = 0;
      let aborted = false;
      let pausedResult: UnitMigrationCheckpoint | null = null;
      let committedCheckpoint: UnitMigrationCheckpoint | null = null;

      const failTransition = (err: Error) => {
        if (aborted) return;
        aborted = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      };

      const proceed = () => {
        const check = validateLiveOwnershipInTx(liveCp, liveBl, {
          migrationRunId: activeRunId,
          executionLeaseId: activeExecutionLeaseId,
          expectedPhase: expectedFromPhase,
        });
        if (!check.ok) {
          failTransition(check.error);
          return;
        }
        if (check.paused) {
          pausedResult = check.checkpoint;
          aborted = true;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          resolve({ pausedByPeer: true, checkpoint: check.checkpoint });
          return;
        }
        if (MIGRATION_PHASE_ORDER[targetPhase] <= MIGRATION_PHASE_ORDER[check.checkpoint.phase]) {
          failTransition(
            new Error(
              `MIGRATION_CHECKPOINT_REGRESSION_CONFLICT: Refusing non-monotonic phase transition '${check.checkpoint.phase}' -> '${targetPhase}'.`
            )
          );
          return;
        }

        const nowIso = new Date().toISOString();
        if (pauseRequestedFlag) {
          const pausedCp: UnitMigrationCheckpoint = {
            ...check.checkpoint,
            status: 'PAUSED',
            pauseRequested: true,
            pausedAt: check.checkpoint.pausedAt ?? nowIso,
            updatedAt: nowIso,
            executionLeaseReleased: true,
          };
          metaStore.put(pausedCp);
          committedCheckpoint = pausedCp;
          pausedResult = pausedCp;
          return;
        }

        const transitioned: UnitMigrationCheckpoint = {
          ...check.checkpoint,
          phase: targetPhase,
          executionLeaseHeartbeatAtMs: Date.now(),
          updatedAt: nowIso,
        };
        metaStore.put(transitioned);
        committedCheckpoint = transitioned;

        if (options?.onInsidePhaseTransitionTxBeforeCommit) {
          try {
            options.onInsidePhaseTransitionTxBeforeCommit({
              tx,
              fromPhase: expectedFromPhase,
              targetPhase,
            });
          } catch (hookErr) {
            failTransition(hookErr instanceof Error ? hookErr : new Error(String(hookErr)));
            return;
          }
        }
      };

      const onRead = () => {
        reads += 1;
        if (reads === 2) proceed();
      };

      const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
      cpReq.onsuccess = () => {
        liveCp = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
        onRead();
      };
      cpReq.onerror = () => failTransition(cpReq.error || new Error('PHASE_TRANSITION_CP_READ_FAILED'));

      const blReq = metaStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
      blReq.onsuccess = () => {
        liveBl = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
        onRead();
      };
      blReq.onerror = () => failTransition(blReq.error || new Error('PHASE_TRANSITION_BL_READ_FAILED'));

      tx.oncomplete = () => {
        if (!aborted && committedCheckpoint) {
          resolve({
            pausedByPeer: committedCheckpoint.status === 'PAUSED',
            checkpoint: committedCheckpoint,
          });
        }
      };
      tx.onerror = () => {
        if (!aborted && !pausedResult) reject(tx.error || new Error('PHASE_TRANSITION_TX_FAILED'));
      };
      tx.onabort = () => {
        if (!aborted && !pausedResult) reject(tx.error || new Error('PHASE_TRANSITION_TX_ABORTED'));
      };
    });
  });
}

async function commitFailureIfStillOwnerInTx(
  db: IDBDatabase,
  activeRunId: string,
  activeExecutionLeaseId: string,
  errorMessage: string
): Promise<void> {
  await withLocalFirstMutationMutex('UNIT_MIGRATION_FAIL_COMMIT', async (lease) => {
    await assertLocalFirstMutationMutexLeaseCurrent(lease);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['metadata'], 'readwrite');
      const metaStore = tx.objectStore('metadata');
      let liveCp: UnitMigrationCheckpoint | null = null;
      let liveBl: FinancialBaselineDigestRecord | null = null;
      let reads = 0;
      let aborted = false;

      const proceed = () => {
        if (
          !liveCp ||
          !liveBl ||
          liveCp.migrationRunId !== activeRunId ||
          liveBl.migrationRunId !== activeRunId ||
          liveCp.executionLeaseId !== activeExecutionLeaseId ||
          liveCp.status === 'COMPLETED' ||
          liveCp.phase === 'DONE' ||
          liveCp.status === 'PAUSED'
        ) {
          aborted = true;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          resolve();
          return;
        }

        const failedCp: UnitMigrationCheckpoint = {
          ...liveCp,
          status: 'FAILED',
          lastError: errorMessage,
          updatedAt: new Date().toISOString(),
          executionLeaseReleased: true,
        };
        metaStore.put(failedCp);
      };

      const onRead = () => {
        reads += 1;
        if (reads === 2) proceed();
      };

      const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
      cpReq.onsuccess = () => {
        liveCp = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
        onRead();
      };
      cpReq.onerror = () => reject(cpReq.error || new Error('FAIL_COMMIT_CP_READ_FAILED'));

      const blReq = metaStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
      blReq.onsuccess = () => {
        liveBl = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
        onRead();
      };
      blReq.onerror = () => reject(blReq.error || new Error('FAIL_COMMIT_BL_READ_FAILED'));

      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        if (!aborted) reject(tx.error || new Error('FAIL_COMMIT_TX_FAILED'));
      };
      tx.onabort = () => {
        if (!aborted) reject(tx.error || new Error('FAIL_COMMIT_TX_ABORTED'));
      };
    });
  });
}

async function executeMigrationLoop(
  mode: 'START' | 'RESUME',
  options: StartMigrationOptions = {}
): Promise<UnitMigrationCheckpoint> {
  if (activeMigrationPromise) {
    return activeMigrationPromise;
  }

  // Clear pause flag synchronously before any async suspension so early pauseUnitMigration() calls are preserved
  pauseRequestedFlag = false;

  const runPromise = withCrossTabMigrationWebLock(async ({ heldExclusiveWebLock }): Promise<UnitMigrationCheckpoint> => {
    const db = await resolveTargetDb(options.db);
    if (!db.objectStoreNames.contains('medicines') || !db.objectStoreNames.contains('metadata')) {
      throw new Error('REQUIRED_STORES_MISSING: medicines and metadata stores are required.');
    }
    try {
      await ensureV1InFlightCheckerResolved();
    } catch {
      if (options.v1InFlightAvailable === undefined) {
        options = { ...options, v1InFlightAvailable: false };
      }
    }

    const effectiveBatchSize = clampBatchSize(options.batchSize);
    const stalePolicy = options.staleBatchPolicy ?? 'RECLASSIFY_IN_TX';
    const activeExecutionLeaseId = generateExecutionLeaseId();

    const initResult = await withLocalFirstMutationMutex('UNIT_MIGRATION_INIT', async (lease) => {
      await assertLocalFirstMutationMutexLeaseCurrent(lease);

      const attemptAcquireInTx = async (freshPayload?: {
        baseline: FinancialBaselineDigestRecord;
        checkpoint: UnitMigrationCheckpoint;
      }): Promise<{
        needsFreshBuild: boolean;
        checkpoint: UnitMigrationCheckpoint | null;
        baseline: FinancialBaselineDigestRecord | null;
        alreadyCompleted: boolean;
        pausedByEarlyRequest: boolean;
      }> => {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(['metadata'], 'readwrite');
          const metaStore = tx.objectStore('metadata');
          let liveCp: UnitMigrationCheckpoint | null = null;
          let liveBl: FinancialBaselineDigestRecord | null = null;
          let reads = 0;
          let aborted = false;
          let outcome: {
            needsFreshBuild: boolean;
            checkpoint: UnitMigrationCheckpoint | null;
            baseline: FinancialBaselineDigestRecord | null;
            alreadyCompleted: boolean;
            pausedByEarlyRequest: boolean;
          } | null = null;

          const abortInit = (err: Error) => {
            if (aborted) return;
            aborted = true;
            try {
              tx.abort();
            } catch {
              // ignore
            }
            reject(err);
          };

          const proceed = () => {
            // If this tab genuinely holds the exclusive browser Web Lock, any un-released
            // IN_PROGRESS IDB lease from a crashed/closed tab is guaranteed dead and can be
            // reclaimed immediately without waiting 30s TTL. Without Web Locks, fall back to IDB lease TTL.
            if (!heldExclusiveWebLock && isExecutionLeaseActivelyHeld(liveCp)) {
              abortInit(
                new Error(
                  `MIGRATION_ALREADY_IN_PROGRESS: Active execution lease '${String(liveCp?.executionLeaseId ?? 'unknown')}' is already held by another execution context.`
                )
              );
              return;
            }

            const nowMs = Date.now();
            const nowIso = new Date(nowMs).toISOString();

            if (mode === 'RESUME') {
              if (!liveCp || !liveBl) {
                abortInit(new Error('NO_RESUMABLE_MIGRATION: No existing migration checkpoint found to resume.'));
                return;
              }
              if (liveCp.status === 'COMPLETED' && liveCp.phase === 'DONE') {
                outcome = {
                  needsFreshBuild: false,
                  checkpoint: liveCp,
                  baseline: liveBl,
                  alreadyCompleted: true,
                  pausedByEarlyRequest: false,
                };
                return;
              }
              if (pauseRequestedFlag) {
                const pausedCp: UnitMigrationCheckpoint = {
                  ...liveCp,
                  status: 'PAUSED',
                  pauseRequested: true,
                  pausedAt: liveCp.pausedAt ?? nowIso,
                  updatedAt: nowIso,
                  executionLeaseReleased: true,
                };
                metaStore.put(pausedCp);
                outcome = {
                  needsFreshBuild: false,
                  checkpoint: pausedCp,
                  baseline: liveBl,
                  alreadyCompleted: false,
                  pausedByEarlyRequest: true,
                };
                return;
              }
              const nextPhase: MigrationPhase =
                liveCp.phase === 'BASELINE_AUDIT' || liveCp.phase === 'NOT_STARTED'
                  ? 'MEDICINES_BATCH'
                  : liveCp.phase;
              const resumedCp: UnitMigrationCheckpoint = {
                ...liveCp,
                status: 'IN_PROGRESS',
                phase: nextPhase,
                batchSize: clampBatchSize(options.batchSize ?? liveCp.batchSize),
                pauseRequested: false,
                pausedAt: undefined,
                updatedAt: nowIso,
                lastError: undefined,
                executionLeaseId: activeExecutionLeaseId,
                executionLeaseAcquiredAtMs: nowMs,
                executionLeaseHeartbeatAtMs: nowMs,
                executionLeaseReleased: false,
              };
              metaStore.put(resumedCp);
              outcome = {
                needsFreshBuild: false,
                checkpoint: resumedCp,
                baseline: liveBl,
                alreadyCompleted: false,
                pausedByEarlyRequest: false,
              };
              return;
            }

            // mode === 'START'
            const canResumeIncomplete =
              liveCp !== null &&
              liveBl !== null &&
              liveCp.migrationRunId === liveBl.migrationRunId &&
              (liveCp.status === 'PAUSED' ||
                liveCp.status === 'IN_PROGRESS' ||
                liveCp.status === 'FAILED') &&
              liveCp.phase !== 'DONE';

            if (canResumeIncomplete && liveCp && liveBl) {
              if (pauseRequestedFlag) {
                const pausedCp: UnitMigrationCheckpoint = {
                  ...liveCp,
                  status: 'PAUSED',
                  pauseRequested: true,
                  pausedAt: liveCp.pausedAt ?? nowIso,
                  updatedAt: nowIso,
                  executionLeaseReleased: true,
                };
                metaStore.put(pausedCp);
                outcome = {
                  needsFreshBuild: false,
                  checkpoint: pausedCp,
                  baseline: liveBl,
                  alreadyCompleted: false,
                  pausedByEarlyRequest: true,
                };
                return;
              }
              const nextPhase: MigrationPhase =
                liveCp.phase === 'BASELINE_AUDIT' || liveCp.phase === 'NOT_STARTED'
                  ? 'MEDICINES_BATCH'
                  : liveCp.phase;
              const resumedCp: UnitMigrationCheckpoint = {
                ...liveCp,
                status: 'IN_PROGRESS',
                phase: nextPhase,
                batchSize: effectiveBatchSize,
                pauseRequested: false,
                pausedAt: undefined,
                updatedAt: nowIso,
                lastError: undefined,
                executionLeaseId: activeExecutionLeaseId,
                executionLeaseAcquiredAtMs: nowMs,
                executionLeaseHeartbeatAtMs: nowMs,
                executionLeaseReleased: false,
              };
              metaStore.put(resumedCp);
              outcome = {
                needsFreshBuild: false,
                checkpoint: resumedCp,
                baseline: liveBl,
                alreadyCompleted: false,
                pausedByEarlyRequest: false,
              };
              return;
            }

            if (!freshPayload) {
              outcome = {
                needsFreshBuild: true,
                checkpoint: null,
                baseline: null,
                alreadyCompleted: false,
                pausedByEarlyRequest: false,
              };
              return;
            }

            const freshCp: UnitMigrationCheckpoint = pauseRequestedFlag
              ? {
                  ...freshPayload.checkpoint,
                  status: 'PAUSED',
                  pauseRequested: true,
                  pausedAt: nowIso,
                  executionLeaseReleased: true,
                }
              : freshPayload.checkpoint;

            metaStore.put(freshPayload.baseline);
            metaStore.put(freshCp);
            outcome = {
              needsFreshBuild: false,
              checkpoint: freshCp,
              baseline: freshPayload.baseline,
              alreadyCompleted: false,
              pausedByEarlyRequest: Boolean(pauseRequestedFlag),
            };
          };

          const onRead = () => {
            reads += 1;
            if (reads === 2) proceed();
          };

          const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
          cpReq.onsuccess = () => {
            liveCp = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
            onRead();
          };
          cpReq.onerror = () => abortInit(cpReq.error || new Error('INIT_CP_READ_FAILED'));

          const blReq = metaStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
          blReq.onsuccess = () => {
            liveBl = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
            onRead();
          };
          blReq.onerror = () => abortInit(blReq.error || new Error('INIT_BL_READ_FAILED'));

          tx.oncomplete = () => {
            if (!aborted && outcome) resolve(outcome);
          };
          tx.onerror = () => {
            if (!aborted) reject(tx.error || new Error('INIT_TX_FAILED'));
          };
          tx.onabort = () => {
            if (!aborted) reject(tx.error || new Error('INIT_TX_ABORTED'));
          };
        });
      };

      const firstPass = await attemptAcquireInTx();
      if (!firstPass.needsFreshBuild) {
        return {
          checkpoint: firstPass.checkpoint!,
          baseline: firstPass.baseline!,
          alreadyCompleted: firstPass.alreadyCompleted,
          pausedByEarlyRequest: firstPass.pausedByEarlyRequest,
        };
      }

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const migrationRunId = generateMigrationRunId();
      const builtBaseline = await buildBaselineDigestFromStores(db, migrationRunId, nowIso);
      const builtCheckpoint: UnitMigrationCheckpoint = {
        key: UNIT_MIGRATION_CHECKPOINT_KEY,
        schemaVersion: UNIT_MIGRATION_SCHEMA_VERSION,
        migrationRunId,
        status: 'IN_PROGRESS',
        phase: 'BASELINE_AUDIT',
        batchSize: effectiveBatchSize,
        totalMedicines: builtBaseline.counts.medicines,
        processedMedicines: 0,
        migratedCount: 0,
        quarantinedCount: 0,
        conflictedCount: 0,
        skippedAlreadyValidCount: 0,
        legacyStocktakingSessionsInspected: 0,
        legacyStocktakingArchivedConflicts: 0,
        legacyStocktakingSessionsFlaggedReview: 0,
        lastMedicineCursorId: null,
        lastStocktakingSessionCursorId: null,
        batchNumber: 0,
        startedAt: nowIso,
        updatedAt: nowIso,
        pauseRequested: false,
        baselineDigestKey: UNIT_MIGRATION_BASELINE_DIGEST_KEY,
        finalVerified: false,
        operationalTrustIndependentFromMigrationCompletion: true,
        verifiedMedicinesCount: 0,
        allMedicinesReadyForSale: false,
        executionLeaseId: activeExecutionLeaseId,
        executionLeaseAcquiredAtMs: nowMs,
        executionLeaseHeartbeatAtMs: nowMs,
        executionLeaseReleased: false,
      };

      const secondPass = await attemptAcquireInTx({
        baseline: builtBaseline,
        checkpoint: builtCheckpoint,
      });

      if (secondPass.alreadyCompleted || secondPass.pausedByEarlyRequest || !secondPass.checkpoint) {
        return {
          checkpoint: secondPass.checkpoint!,
          baseline: secondPass.baseline!,
          alreadyCompleted: secondPass.alreadyCompleted,
          pausedByEarlyRequest: secondPass.pausedByEarlyRequest,
        };
      }

      return {
        checkpoint: secondPass.checkpoint,
        baseline: secondPass.baseline!,
        alreadyCompleted: false,
        pausedByEarlyRequest: false,
      };
    });

    if (initResult.alreadyCompleted || initResult.pausedByEarlyRequest) {
      return initResult.checkpoint;
    }

    let checkpoint = initResult.checkpoint;
    const activeRunId = checkpoint.migrationRunId;
    let batchesExecutedThisInvocation = 0;
    let heartbeatStopped = false;
    let heartbeatInFlight = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const stopHeartbeat = () => {
      heartbeatStopped = true;
      if (heartbeatTimer !== null) {
        try {
          clearInterval(heartbeatTimer);
        } catch {
          // Never allow timer cleanup to mask execution errors
        }
        heartbeatTimer = null;
      }
    };

    try {
      heartbeatTimer = setInterval(() => {
        if (heartbeatStopped || heartbeatInFlight) return;
        heartbeatInFlight = true;
        void renewExecutionLeaseHeartbeatInTx(db, activeRunId, activeExecutionLeaseId)
          .catch(() => undefined)
          .finally(() => {
            heartbeatInFlight = false;
          });
      }, EXECUTION_LEASE_HEARTBEAT_INTERVAL_MS);
      if (typeof (heartbeatTimer as { unref?: () => void }).unref === 'function') {
        (heartbeatTimer as { unref: () => void }).unref();
      }

      if (checkpoint.phase === 'BASELINE_AUDIT') {
        // Strict wall-clock millisecond separation outside IDB tx so post-baseline records are strictly > baseline.capturedAt
        const baselineMs = Date.parse(initResult.baseline.capturedAt);
        while (Date.now() <= baselineMs) {
          await new Promise((r) => setTimeout(r, 2));
        }
        if (options.onBeforeBaselinePhaseTransition) {
          await options.onBeforeBaselinePhaseTransition({
            migrationRunId: activeRunId,
            executionLeaseId: activeExecutionLeaseId,
          });
        }
        const transition = await commitPhaseTransitionInTx(
          db,
          activeRunId,
          activeExecutionLeaseId,
          'BASELINE_AUDIT',
          'MEDICINES_BATCH',
          { onInsidePhaseTransitionTxBeforeCommit: options.onInsidePhaseTransitionTxBeforeCommit }
        );
        if (transition.pausedByPeer) {
          return transition.checkpoint;
        }
        checkpoint = transition.checkpoint;
      }

      // PHASE 1: Bounded Resumable Atomic Medicines Migration
      if (checkpoint.phase === 'MEDICINES_BATCH') {
        const preContext = await withLocalFirstMutationMutex(
          'UNIT_MIGRATION_MEDICINES_PRE_READ',
          async (lease) => {
            await assertLocalFirstMutationMutexLeaseCurrent(lease);
            return readPendingMedicinesSnapshot(db, options, {
              migrationRunId: activeRunId,
              executionLeaseId: activeExecutionLeaseId,
              expectedPhase: 'MEDICINES_BATCH',
              expectedBatchNumber: checkpoint.batchNumber,
              expectedMedicineCursorId: checkpoint.lastMedicineCursorId,
            });
          }
        );
        if (preContext.pausedByPeer && preContext.checkpoint) {
          return preContext.checkpoint;
        }

        const sortedMedicines = [...preContext.medicines]
          .map((rec, idx) => ({
            id: recordSortId(rec, idx),
            raw: rec,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

        const pendingMedicines = sortedMedicines.filter(
          (item) =>
            checkpoint.lastMedicineCursorId === null || item.id > checkpoint.lastMedicineCursorId
        );

        let offset = 0;
        while (offset < pendingMedicines.length) {
          if (
            pauseRequestedFlag ||
            checkpoint.pauseRequested ||
            (options.maxBatches !== undefined &&
              batchesExecutedThisInvocation >= options.maxBatches)
          ) {
            return commitPauseIfStillOwnerInTx(
              db,
              activeRunId,
              activeExecutionLeaseId,
              'MEDICINES_BATCH'
            );
          }

          const batchItems = pendingMedicines.slice(offset, offset + checkpoint.batchSize);
          offset += batchItems.length;
          const nextBatchNumber = checkpoint.batchNumber + 1;
          const batchIds = batchItems.map((b) => b.id);

          const preBatchFingerprint = new Map<string, string>();
          const preBatchLocked = new Map<string, boolean>();
          for (const entry of batchItems) {
            preBatchFingerprint.set(entry.id, computeMedicineCanonicalFingerprint(entry.raw));
            const rep = preContext.evaluation.buildReportForMedicine(
              entry.id,
              entry.raw,
              preContext.existingQuarantines.get(entry.id) ?? null
            );
            preBatchLocked.set(entry.id, rep.effectivePackingLocked);
          }

          if (options.onBeforeBatchTxOpen) {
            await options.onBeforeBatchTxOpen({
              phase: 'MEDICINES_BATCH',
              batchNumber: nextBatchNumber,
              itemIds: batchIds,
            });
          }

          const batchIso = new Date().toISOString();
          const lastCursorInBatch = batchItems[batchItems.length - 1].id;
          const currentCheckpointSnapshot = checkpoint;

          const presentEvidenceStores = [...REQUIRED_EVIDENCE_STORES, ...OPTIONAL_EVIDENCE_STORES].filter((s) =>
            db.objectStoreNames.contains(s)
          );
          const batchTxStores = Array.from(new Set<string>(['medicines', 'metadata', ...presentEvidenceStores]));

          const batchOutcome = await withLocalFirstMutationMutex(
            'UNIT_MIGRATION_MEDICINES_BATCH',
            async (lease): Promise<{ pausedByPeer: boolean; checkpoint: UnitMigrationCheckpoint }> => {
              await assertLocalFirstMutationMutexLeaseCurrent(lease);
              return new Promise<{ pausedByPeer: boolean; checkpoint: UnitMigrationCheckpoint }>(
                (resolve, reject) => {
                  const localRetrySnapshot = readV1LocalStorageRetrySnapshot();
                  const tx = db.transaction(batchTxStores, 'readwrite');
                  const medStore = tx.objectStore('medicines');
                  const metaStore = tx.objectStore('metadata');

                  const latestMedMap = new Map<string, unknown>();
                  const latestQuarantineMap = new Map<string, MedicineQuarantineRecord | null>();
                  const storeDataMap = new Map<string, unknown[]>();
                  let idbV1LeaseRows: unknown[] = [];
                  let liveCheckpointInTx: UnitMigrationCheckpoint | null = null;
                  let liveBaselineInTx: FinancialBaselineDigestRecord | null = null;
                  const presentStoreSet = new Set<string>(presentEvidenceStores);
                  let abortedByApp = false;
                  let pausedByPeerResult: UnitMigrationCheckpoint | null = null;
                  let resultCheckpoint: UnitMigrationCheckpoint | null = null;

                  const evidenceReadStores = presentEvidenceStores.filter(
                    (s) => s !== 'medicines' && s !== 'metadata'
                  );
                  const totalReadsExpected = batchItems.length * 2 + 5 + evidenceReadStores.length;
                  let readsCompleted = 0;

                  const abortWith = (err: Error) => {
                    if (abortedByApp) return;
                    abortedByApp = true;
                    try {
                      tx.abort();
                    } catch {
                      // ignore
                    }
                    reject(err);
                  };

                  const onAllInTxReadsComplete = () => {
                    if (abortedByApp) return;
                    try {
                      const check = validateLiveOwnershipInTx(liveCheckpointInTx, liveBaselineInTx, {
                        migrationRunId: activeRunId,
                        executionLeaseId: activeExecutionLeaseId,
                        expectedPhase: 'MEDICINES_BATCH',
                        expectedBatchNumber: currentCheckpointSnapshot.batchNumber,
                        expectedMedicineCursorId: currentCheckpointSnapshot.lastMedicineCursorId,
                      });
                      if (!check.ok) {
                        abortWith(check.error);
                        return;
                      }
                      if (check.paused) {
                        pausedByPeerResult = check.checkpoint;
                        abortedByApp = true;
                        try {
                          tx.abort();
                        } catch {
                          // ignore
                        }
                        resolve({ pausedByPeer: true, checkpoint: check.checkpoint });
                        return;
                      }

                      const verifiedCp = check.checkpoint;
                      if (
                        verifiedCp.lastMedicineCursorId !== null &&
                        lastCursorInBatch <= verifiedCp.lastMedicineCursorId
                      ) {
                        abortWith(
                          new Error(
                            `MIGRATION_CHECKPOINT_REGRESSION_CONFLICT: Refusing non-monotonic medicine cursor '${lastCursorInBatch}' <= '${verifiedCp.lastMedicineCursorId}'.`
                          )
                        );
                        return;
                      }

                      const allMedicinesInDb = storeDataMap.get('medicines') ?? [];
                      const inTxQuarantines = new Map<string, MedicineQuarantineRecord>(
                        preContext.existingQuarantines
                      );
                      for (const [mId, qRec] of latestQuarantineMap.entries()) {
                        if (qRec) {
                          inTxQuarantines.set(mId, qRec);
                        } else {
                          inTxQuarantines.delete(mId);
                        }
                      }
                      const inTxEval = evaluateAllPackingLockEvidenceSnapshot({
                        presentStores: presentStoreSet,
                        medicines: allMedicinesInDb,
                        ledger: storeDataMap.get('inventory_ledger') ?? [],
                        sales: storeDataMap.get('sales') ?? [],
                        purchaseInvoices: storeDataMap.get('purchase_invoices') ?? [],
                        outbox: storeDataMap.get('outbox') ?? [],
                        stocktakingSessions: storeDataMap.get('stocktaking_sessions') ?? [],
                        stocktakingItems: storeDataMap.get('stocktaking_items') ?? [],
                        supplierInvoiceDrafts: storeDataMap.get('supplier_invoice_drafts') ?? [],
                        backupReviewMetadata: storeDataMap.get('metadata') ?? [],
                        existingQuarantines: inTxQuarantines,
                        idbV1LeaseRows,
                        localRetrySnapshot,
                        v1InFlightMedicineIds: options.v1InFlightMedicineIds,
                        v1InFlightInspector: options.v1InFlightInspector,
                        v1InFlightEnumerator: options.v1InFlightEnumerator,
                        v1InFlightAvailable: options.v1InFlightAvailable,
                        v1InFlightNowMs: options.v1InFlightNowMs,
                        v1ContextHints: options.v1ContextHints,
                      });

                      const outcomes: MedicineClassificationOutcome[] = [];
                      for (const entry of batchItems) {
                        const latestMed = latestMedMap.get(entry.id);
                        const latestQuarantine = latestQuarantineMap.get(entry.id) ?? null;

                        if (latestMed === undefined) {
                          if (stalePolicy === 'ABORT') {
                            abortWith(
                              new Error(`STALE_MIGRATION_BATCH_CONFLICT: Medicine '${entry.id}' removed concurrently`)
                            );
                            return;
                          }
                          continue;
                        }

                        const freshReport = inTxEval.buildReportForMedicine(
                          entry.id,
                          latestMed,
                          latestQuarantine
                        );

                        if (stalePolicy === 'ABORT') {
                          const freshFp = computeMedicineCanonicalFingerprint(latestMed);
                          if (
                            freshFp !== preBatchFingerprint.get(entry.id) ||
                            freshReport.effectivePackingLocked !== preBatchLocked.get(entry.id)
                          ) {
                            abortWith(
                              new Error(
                                `STALE_MIGRATION_BATCH_CONFLICT: Medicine '${entry.id}' or its lock evidence changed before commit`
                              )
                            );
                            return;
                          }
                        }

                        const outcome = classifyMedicineRecordForMigration(latestMed, {
                          hasHistoricalMovementOrPendingSync: freshReport.effectivePackingLocked,
                          packingLockReport: freshReport,
                          migrationRunId: verifiedCp.migrationRunId,
                          nowIso: batchIso,
                          fallbackRecordId: entry.id,
                          existingQuarantine: latestQuarantine,
                        });
                        outcomes.push(outcome);
                      }

                      let deltaMigrated = 0;
                      let deltaQuarantined = 0;
                      let deltaConflicted = 0;
                      let deltaSkipped = 0;

                      for (const out of outcomes) {
                        if (out.alreadyMigratedUnchanged) {
                          deltaSkipped += 1;
                        } else if (out.classification === 'MIGRATED_CONSERVATIVE') {
                          deltaMigrated += 1;
                        } else if (out.classification === 'CONFLICTED') {
                          deltaConflicted += 1;
                        } else {
                          deltaQuarantined += 1;
                        }
                        if (out.quarantineRecord) {
                          preContext.existingQuarantines.set(out.medicineId, out.quarantineRecord);
                        }
                      }

                      const nextCheckpoint: UnitMigrationCheckpoint = {
                        ...verifiedCp,
                        phase: 'MEDICINES_BATCH',
                        totalMedicines: Math.max(verifiedCp.totalMedicines, sortedMedicines.length),
                        batchNumber: verifiedCp.batchNumber + 1,
                        processedMedicines: verifiedCp.processedMedicines + batchItems.length,
                        migratedCount: verifiedCp.migratedCount + deltaMigrated,
                        quarantinedCount: verifiedCp.quarantinedCount + deltaQuarantined,
                        conflictedCount: verifiedCp.conflictedCount + deltaConflicted,
                        skippedAlreadyValidCount: verifiedCp.skippedAlreadyValidCount + deltaSkipped,
                        lastMedicineCursorId: lastCursorInBatch,
                        executionLeaseHeartbeatAtMs: Date.now(),
                        updatedAt: batchIso,
                      };
                      resultCheckpoint = nextCheckpoint;

                      for (const out of outcomes) {
                        if (out.updatedMedicineRecord) {
                          medStore.put(out.updatedMedicineRecord);
                        }
                        if (out.quarantineRecord) {
                          metaStore.put(out.quarantineRecord);
                        }
                        const finalMedicineRecord = out.updatedMedicineRecord || latestMedMap.get(out.medicineId);
                        if (!finalMedicineRecord) {
                          throw new Error(`MEDICINE_FINAL_FINGERPRINT_SOURCE_MISSING:${out.medicineId}`);
                        }
                        const bucket = outcomeToCounterBucket(out);
                        const liveLedgerForFp = storeDataMap.get('inventory_ledger') ?? [];
                        metaStore.put({
                          key: `${UNIT_MIGRATION_MEDICINE_FINGERPRINT_PREFIX}${out.medicineId}`,
                          schemaVersion: 1,
                          medicineId: out.medicineId,
                          migrationRunId: verifiedCp.migrationRunId,
                          counterBucket: bucket,
                          fingerprint: computeMedicineUnitStockFingerprint(finalMedicineRecord),
                          unitIdentityFingerprint: computeMedicineUnitIdentityFingerprint(finalMedicineRecord),
                          stockSnapshot: projectSingleMedicineStockState(finalMedicineRecord),
                          knownLedgerIdsAtCapture: extractLedgerIdsForMedicine(
                            liveLedgerForFp,
                            out.medicineId
                          ),
                          capturedAt: batchIso,
                        });
                      }
                      metaStore.put(nextCheckpoint);

                      if (options.onInsideBatchTxBeforeCommit) {
                        options.onInsideBatchTxBeforeCommit({
                          tx,
                          phase: 'MEDICINES_BATCH',
                          batchNumber: nextCheckpoint.batchNumber,
                          itemIds: batchIds,
                        });
                      }
                    } catch (err) {
                      abortWith(err instanceof Error ? err : new Error(String(err)));
                    }
                  };

                  const markReadDone = () => {
                    readsCompleted += 1;
                    if (readsCompleted === totalReadsExpected) {
                      onAllInTxReadsComplete();
                    }
                  };

                  for (const entry of batchItems) {
                    const mReq = medStore.get(entry.id);
                    mReq.onsuccess = () => {
                      latestMedMap.set(entry.id, mReq.result);
                      markReadDone();
                    };
                    mReq.onerror = () => abortWith(mReq.error || new Error(`MED_GET_IN_TX_FAILED:${entry.id}`));

                    const qReq = metaStore.get(`${UNIT_MIGRATION_QUARANTINE_PREFIX}${entry.id}`);
                    qReq.onsuccess = () => {
                      latestQuarantineMap.set(entry.id, (qReq.result as MedicineQuarantineRecord | undefined) ?? null);
                      markReadDone();
                    };
                    qReq.onerror = () => abortWith(qReq.error || new Error(`META_QUARANTINE_IN_TX_FAILED:${entry.id}`));
                  }

                  const v1LeaseReq = metaStore.getAll(
                    IDBKeyRange.bound(V1_IN_FLIGHT_LEASE_IDB_PREFIX, `${V1_IN_FLIGHT_LEASE_IDB_PREFIX}\uffff`)
                  );
                  v1LeaseReq.onsuccess = () => {
                    idbV1LeaseRows = Array.isArray(v1LeaseReq.result) ? v1LeaseReq.result : [];
                    markReadDone();
                  };
                  v1LeaseReq.onerror = () =>
                    abortWith(v1LeaseReq.error || new Error('V1_IDB_LEASE_IN_TX_FAILED'));

                  const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
                  cpReq.onsuccess = () => {
                    liveCheckpointInTx = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
                    markReadDone();
                  };
                  cpReq.onerror = () => abortWith(cpReq.error || new Error('CHECKPOINT_IN_TX_READ_FAILED'));

                  const blReq = metaStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
                  blReq.onsuccess = () => {
                    liveBaselineInTx = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
                    markReadDone();
                  };
                  blReq.onerror = () => abortWith(blReq.error || new Error('BASELINE_IN_TX_READ_FAILED'));

                  const allMedReq = medStore.getAll();
                  allMedReq.onsuccess = () => {
                    storeDataMap.set('medicines', Array.isArray(allMedReq.result) ? allMedReq.result : []);
                    markReadDone();
                  };
                  allMedReq.onerror = () => abortWith(allMedReq.error || new Error('MED_GETALL_IN_TX_FAILED'));

                  const allMetaReq = metaStore.getAll();
                  allMetaReq.onsuccess = () => {
                    storeDataMap.set('metadata', Array.isArray(allMetaReq.result) ? allMetaReq.result : []);
                    markReadDone();
                  };
                  allMetaReq.onerror = () => abortWith(allMetaReq.error || new Error('META_GETALL_IN_TX_FAILED'));

                  for (const storeName of evidenceReadStores) {
                    const sReq = tx.objectStore(storeName).getAll();
                    sReq.onsuccess = () => {
                      storeDataMap.set(storeName, Array.isArray(sReq.result) ? sReq.result : []);
                      markReadDone();
                    };
                    sReq.onerror = () => abortWith(sReq.error || new Error(`EVIDENCE_IN_TX_FAILED:${storeName}`));
                  }

                  tx.oncomplete = () => {
                    if (!abortedByApp && resultCheckpoint) {
                      resolve({ pausedByPeer: false, checkpoint: resultCheckpoint });
                    }
                  };
                  tx.onerror = () => {
                    if (!abortedByApp && !pausedByPeerResult) {
                      reject(tx.error || new Error('MEDICINE_BATCH_TX_FAILED'));
                    }
                  };
                  tx.onabort = () => {
                    if (!abortedByApp && !pausedByPeerResult) {
                      reject(tx.error || new Error('MEDICINE_BATCH_TX_ABORTED'));
                    }
                  };
                }
              );
            }
          );

          if (batchOutcome.pausedByPeer) {
            return batchOutcome.checkpoint;
          }

          checkpoint = batchOutcome.checkpoint;
          batchesExecutedThisInvocation += 1;
          await options.onAfterBatchCommitted?.(checkpoint);

          if (
            options.pauseAfterBatch !== undefined &&
            nextBatchNumber >= options.pauseAfterBatch &&
            offset < pendingMedicines.length
          ) {
            return commitPauseIfStillOwnerInTx(
              db,
              activeRunId,
              activeExecutionLeaseId,
              'MEDICINES_BATCH'
            );
          }
        }

        if (options.allowConcurrentMedicineEdits) {
          const catchup = await catchUpNewConcurrentMedicinesIfEnabled(
            db,
            activeRunId,
            activeExecutionLeaseId,
            'MEDICINES_BATCH',
            options
          );
          if (catchup.pausedByPeer && catchup.checkpoint) {
            return catchup.checkpoint;
          }
          if (catchup.checkpoint) {
            checkpoint = catchup.checkpoint;
          }
        }

        const toStocktaking = await commitPhaseTransitionInTx(
          db,
          activeRunId,
          activeExecutionLeaseId,
          'MEDICINES_BATCH',
          'STOCKTAKING_BATCH'
        );
        if (toStocktaking.pausedByPeer) {
          return toStocktaking.checkpoint;
        }
        checkpoint = toStocktaking.checkpoint;
      }

      // PHASE 2: Legacy Stocktaking Duplicate/Conflict Inspection & Bounded Archive Tree
      if (checkpoint.phase === 'STOCKTAKING_BATCH') {
        const stContext = await withLocalFirstMutationMutex(
          'UNIT_MIGRATION_STOCKTAKING_READ',
          async (lease) => {
            await assertLocalFirstMutationMutexLeaseCurrent(lease);
            return readStocktakingInspectionContext(db, {
              migrationRunId: activeRunId,
              executionLeaseId: activeExecutionLeaseId,
              expectedPhase: 'STOCKTAKING_BATCH',
              expectedBatchNumber: checkpoint.batchNumber,
              expectedStocktakingCursorId: checkpoint.lastStocktakingSessionCursorId,
            });
          }
        );
        if (stContext.pausedByPeer && stContext.checkpoint) {
          return stContext.checkpoint;
        }

        const sortedSessions = [...stContext.sessions]
          .map((raw, idx) => ({
            id: recordSortId(raw, idx),
            raw,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

        const pendingSessions = sortedSessions.filter(
          (item) =>
            checkpoint.lastStocktakingSessionCursorId === null ||
            item.id > checkpoint.lastStocktakingSessionCursorId
        );

        for (const sessEntry of pendingSessions) {
          if (
            pauseRequestedFlag ||
            checkpoint.pauseRequested ||
            (options.maxBatches !== undefined &&
              batchesExecutedThisInvocation >= options.maxBatches)
          ) {
            return commitPauseIfStillOwnerInTx(
              db,
              activeRunId,
              activeExecutionLeaseId,
              'STOCKTAKING_BATCH'
            );
          }

          const sessionSubItems = stContext.subItemsBySession.get(sessEntry.id) ?? [];
          const expectedSessionDigest = sha256HexSync(canonicalStableJson(sessEntry.raw));
          const expectedSubItemsDigest = computeCanonicalRecordsDigest(sessionSubItems, recordSortId);

          const batchIso = new Date().toISOString();
          const analysis = buildStocktakingConflictEntriesForSession({
            session: sessEntry.raw,
            subItems: sessionSubItems,
            medicinesById: stContext.medicinesById,
            nowIso: batchIso,
            migrationRunId: checkpoint.migrationRunId,
          });

          const existingEntries = stContext.existingArchivesBySession.get(sessEntry.id) ?? [];
          const mergedByConflictId = new Map<string, StocktakingConflictArchiveEntry>();
          for (const e of existingEntries) {
            mergedByConflictId.set(e.conflictId, e);
          }
          let newlyArchivedCount = 0;
          for (const e of analysis.entries) {
            if (!mergedByConflictId.has(e.conflictId)) {
              mergedByConflictId.set(e.conflictId, e);
              newlyArchivedCount += 1;
            }
          }
          const allArchiveEntries = Array.from(mergedByConflictId.values()).sort((a, b) =>
            a.conflictId < b.conflictId ? -1 : a.conflictId > b.conflictId ? 1 : 0
          );

          const archivePlan = buildBoundedStocktakingArchiveTree(sessEntry.id, allArchiveEntries);
          const archiveIndexKey = `${UNIT_MIGRATION_STOCKTAKING_ARCHIVE_INDEX_PREFIX}${sessEntry.id}`;
          const existingLegacy = stContext.existingLegacyIndicesBySession.get(sessEntry.id);
          const legacyQuarantineKey = existingLegacy
            ? `${UNIT_MIGRATION_LEGACY_ARCHIVE_QUARANTINE_PREFIX}${archivePlan.sessionKeyHash}`
            : null;

          const legacyQuarantineRecord: LegacyArchiveQuarantineRecord | null = existingLegacy
            ? {
                key: legacyQuarantineKey!,
                schemaVersion: UNIT_MIGRATION_SCHEMA_VERSION,
                sessionId: sessEntry.id,
                detectedFormat: 'LEGACY_PRE_TREE_ARCHIVE',
                quarantinedAt: batchIso,
                migrationRunId: checkpoint.migrationRunId,
                legacyChunkCount: existingLegacy.chunkCount,
                legacySnapshot: existingLegacy.index,
              }
            : null;

          const archiveIndex: StocktakingConflictArchiveIndex = {
            key: archiveIndexKey,
            schemaVersion: UNIT_MIGRATION_SCHEMA_VERSION,
            archiveFormat: 'BOUNDED_TREE_V2',
            sessionId: sessEntry.id,
            sessionKeyHash: archivePlan.sessionKeyHash,
            totalEntries: allArchiveEntries.length,
            chunkCount: archivePlan.chunks.length,
            chunkSizeLimit: STOCKTAKING_ARCHIVE_CHUNK_SIZE,
            indexPageSizeLimit: STOCKTAKING_ARCHIVE_INDEX_PAGE_SIZE,
            indexPageCount: archivePlan.pages.length,
            treeHeight: archivePlan.treeHeight,
            rootPageKey: archivePlan.rootPageKey,
            rootPageDigest: archivePlan.rootPageDigest,
            archiveDigest: archivePlan.archiveDigest,
            archivedAt: batchIso,
            migrationRunId: checkpoint.migrationRunId,
            verifiedReadBack: false,
            ...(legacyQuarantineKey ? { legacyArchiveQuarantineKey: legacyQuarantineKey } : {}),
          };

          const hasConflicts = allArchiveEntries.length > 0 || analysis.reasonCodes.length > 0;
          const shouldFlagOpenReview = analysis.isOpen && hasConflicts;

          const reviewRecord: StocktakingSessionReviewMetadata = {
            key: `${UNIT_MIGRATION_STOCKTAKING_REVIEW_PREFIX}${sessEntry.id}`,
            schemaVersion: UNIT_MIGRATION_SCHEMA_VERSION,
            sessionId: sessEntry.id,
            sessionStatusAtInspection: analysis.sessionStatus,
            isHistoricalImmutableSession: analysis.isHistorical,
            reviewRequired: hasConflicts,
            reasonCodes: analysis.reasonCodes,
            conflictCount: allArchiveEntries.length,
            archiveIndexKey: allArchiveEntries.length > 0 ? archiveIndexKey : null,
            inspectedAt: batchIso,
            migrationRunId: checkpoint.migrationRunId,
          };

          const currentBatchNumberAtEntry = checkpoint.batchNumber;
          const nextBatchNumber = currentBatchNumberAtEntry + 1;

          const step4UpdatedSessionRecord =
            shouldFlagOpenReview && db.objectStoreNames.contains('stocktaking_sessions')
              ? {
                  ...(sanitizeForPlainJson(sessEntry.raw) as Record<string, unknown>),
                  status: 'reviewing',
                  unitMigrationReviewRequired: true,
                  unitMigrationReviewReasons: analysis.reasonCodes,
                  unitMigrationArchiveIndexKey: allArchiveEntries.length > 0 ? archiveIndexKey : null,
                  unitMigrationReviewedAt: batchIso,
                }
              : null;

          const sessionOwnership: ExpectedExecutionOwnership = {
            migrationRunId: activeRunId,
            executionLeaseId: activeExecutionLeaseId,
            expectedPhase: 'STOCKTAKING_BATCH',
            expectedBatchNumber: currentBatchNumberAtEntry,
            expectedStocktakingCursorId: checkpoint.lastStocktakingSessionCursorId,
          };

          // Step 1: Write chunks in bounded transactions (<= 20 puts/tx) with in-tx ownership & collision checks
          if (allArchiveEntries.length > 0) {
            for (let i = 0; i < archivePlan.chunks.length; i += STOCKTAKING_ARCHIVE_WRITE_BATCH_SIZE) {
              if (pauseRequestedFlag) {
                return commitPauseIfStillOwnerInTx(
                  db,
                  activeRunId,
                  activeExecutionLeaseId,
                  'STOCKTAKING_BATCH'
                );
              }
              const chunkBatch = archivePlan.chunks.slice(
                i,
                i + STOCKTAKING_ARCHIVE_WRITE_BATCH_SIZE
              );
              const chunkWriteRes = await withLocalFirstMutationMutex(
                'UNIT_MIGRATION_STOCKTAKING_CHUNKS',
                async (lease) => {
                  await assertLocalFirstMutationMutexLeaseCurrent(lease);
                  return writeMetadataBatchWithCollisionCheck(
                    db,
                    chunkBatch.map((c) => ({
                      key: c.key,
                      record: c as unknown as Record<string, unknown>,
                      kind: 'CHUNK' as const,
                      sessionId: sessEntry.id,
                    })),
                    sessionOwnership,
                    true
                  );
                }
              );
              if (chunkWriteRes.pausedByPeer && chunkWriteRes.checkpoint) {
                return chunkWriteRes.checkpoint;
              }
            }

            if (options.onAfterStocktakingChunksCommitted) {
              await options.onAfterStocktakingChunksCommitted({
                sessionId: sessEntry.id,
                committedChunks: archivePlan.chunks.length,
                totalChunks: archivePlan.chunks.length,
              });
            }

            // Step 2 & 3: Write index pages bottom-up and unverified root manifest in bounded transactions (<= 20 puts/tx)
            for (let i = 0; i < archivePlan.pages.length; i += STOCKTAKING_ARCHIVE_WRITE_BATCH_SIZE) {
              if (pauseRequestedFlag) {
                return commitPauseIfStillOwnerInTx(
                  db,
                  activeRunId,
                  activeExecutionLeaseId,
                  'STOCKTAKING_BATCH'
                );
              }
              const pageBatch = archivePlan.pages.slice(
                i,
                i + STOCKTAKING_ARCHIVE_WRITE_BATCH_SIZE
              );
              const pageWriteRes = await withLocalFirstMutationMutex(
                'UNIT_MIGRATION_STOCKTAKING_PAGES',
                async (lease) => {
                  await assertLocalFirstMutationMutexLeaseCurrent(lease);
                  return writeMetadataBatchWithCollisionCheck(
                    db,
                    pageBatch.map((p) => ({
                      key: p.key,
                      record: p as unknown as Record<string, unknown>,
                      kind: 'PAGE' as const,
                      sessionId: sessEntry.id,
                    })),
                    sessionOwnership,
                    true
                  );
                }
              );
              if (pageWriteRes.pausedByPeer && pageWriteRes.checkpoint) {
                return pageWriteRes.checkpoint;
              }
            }

            if (pauseRequestedFlag) {
              return commitPauseIfStillOwnerInTx(
                db,
                activeRunId,
                activeExecutionLeaseId,
                'STOCKTAKING_BATCH'
              );
            }

            const manifestRes = await withLocalFirstMutationMutex(
              'UNIT_MIGRATION_STOCKTAKING_PAGES',
              async (lease) => {
                await assertLocalFirstMutationMutexLeaseCurrent(lease);
                return writeMetadataBatchWithCollisionCheck(
                  db,
                  [
                    {
                      key: archiveIndexKey,
                      record: archiveIndex as unknown as Record<string, unknown>,
                      kind: 'INDEX',
                      sessionId: sessEntry.id,
                    },
                  ],
                  sessionOwnership,
                  true
                );
              }
            );
            if (manifestRes.pausedByPeer && manifestRes.checkpoint) {
              return manifestRes.checkpoint;
            }
          }

          if (options.onBeforeBatchTxOpen) {
            await options.onBeforeBatchTxOpen({
              phase: 'STOCKTAKING_BATCH',
              batchNumber: nextBatchNumber,
              itemIds: [sessEntry.id],
            });
          }

          // Step 4: Verify live session + subcollection items + ownership inside atomic readwrite tx
          const hasSessionsStore = db.objectStoreNames.contains('stocktaking_sessions');
          const hasSubItemsStore = db.objectStoreNames.contains('stocktaking_items');
          const step4TxStores: string[] = ['metadata'];
          if (hasSessionsStore) step4TxStores.push('stocktaking_sessions');
          if (hasSubItemsStore) step4TxStores.push('stocktaking_items');

          const step4Outcome = await withLocalFirstMutationMutex(
            'UNIT_MIGRATION_STOCKTAKING_STEP4',
            async (lease): Promise<{ pausedByPeer: boolean; checkpoint: UnitMigrationCheckpoint | null }> => {
              await assertLocalFirstMutationMutexLeaseCurrent(lease);
              return new Promise((resolve, reject) => {
                const tx = db.transaction(step4TxStores, 'readwrite');
                const metaStore = tx.objectStore('metadata');
                let liveSession: unknown = undefined;
                let liveAllSubItems: unknown[] = [];
                let liveCheckpointInTx: UnitMigrationCheckpoint | null = null;
                let liveBaselineInTx: FinancialBaselineDigestRecord | null = null;
                const expectedReads = 2 + (hasSessionsStore ? 1 : 0) + (hasSubItemsStore ? 1 : 0);
                let readsDone = 0;
                let abortedByToctou = false;
                let pausedByPeerResult: UnitMigrationCheckpoint | null = null;
                let step4CommittedCp: UnitMigrationCheckpoint | null = null;

                const abortStep4 = (reason: string) => {
                  if (abortedByToctou) return;
                  abortedByToctou = true;
                  try {
                    tx.abort();
                  } catch {
                    // ignore
                  }
                  reject(new Error(reason));
                };

                const proceedStep4Writes = () => {
                  if (abortedByToctou) return;
                  const check = validateLiveOwnershipInTx(
                    liveCheckpointInTx,
                    liveBaselineInTx,
                    sessionOwnership
                  );
                  if (!check.ok) {
                    abortStep4(check.error.message);
                    return;
                  }
                  if (check.paused) {
                    pausedByPeerResult = check.checkpoint;
                    abortedByToctou = true;
                    try {
                      tx.abort();
                    } catch {
                      // ignore
                    }
                    resolve({ pausedByPeer: true, checkpoint: check.checkpoint });
                    return;
                  }

                  const verifiedCp = check.checkpoint;
                  if (
                    verifiedCp.lastStocktakingSessionCursorId !== null &&
                    sessEntry.id <= verifiedCp.lastStocktakingSessionCursorId
                  ) {
                    abortStep4(
                      `MIGRATION_CHECKPOINT_REGRESSION_CONFLICT: Refusing non-monotonic stocktaking cursor '${sessEntry.id}' <= '${verifiedCp.lastStocktakingSessionCursorId}'.`
                    );
                    return;
                  }

                  if (hasSessionsStore) {
                    if (
                      liveSession === undefined ||
                      sha256HexSync(canonicalStableJson(liveSession)) !== expectedSessionDigest
                    ) {
                      abortStep4(
                        `STALE_STOCKTAKING_SESSION_CONFLICT: Session '${sessEntry.id}' modified, committed, or removed concurrently before Step 4 commit.`
                      );
                      return;
                    }
                  }
                  if (hasSubItemsStore) {
                    const liveSubItemsForSession = liveAllSubItems.filter(
                      (it) => getSafeOwnDataProp(it, 'sessionId').value === sessEntry.id
                    );
                    if (
                      computeCanonicalRecordsDigest(liveSubItemsForSession, recordSortId) !==
                      expectedSubItemsDigest
                    ) {
                      abortStep4(
                        `STALE_STOCKTAKING_SESSION_CONFLICT: Stocktaking subcollection items for '${sessEntry.id}' changed concurrently before Step 4 commit.`
                      );
                      return;
                    }
                  }

                  if (allArchiveEntries.length === 0) {
                    if (pauseRequestedFlag) {
                      const pausedCp: UnitMigrationCheckpoint = {
                        ...verifiedCp,
                        status: 'PAUSED',
                        pauseRequested: true,
                        pausedAt: verifiedCp.pausedAt ?? batchIso,
                        updatedAt: batchIso,
                        executionLeaseReleased: true,
                      };
                      metaStore.put(pausedCp);
                      step4CommittedCp = pausedCp;
                      pausedByPeerResult = pausedCp;
                      return;
                    }

                    const nextCpEmpty: UnitMigrationCheckpoint = {
                      ...verifiedCp,
                      phase: 'STOCKTAKING_BATCH',
                      batchNumber: verifiedCp.batchNumber + 1,
                      legacyStocktakingSessionsInspected: verifiedCp.legacyStocktakingSessionsInspected + 1,
                      legacyStocktakingArchivedConflicts:
                        verifiedCp.legacyStocktakingArchivedConflicts + newlyArchivedCount,
                      legacyStocktakingSessionsFlaggedReview:
                        verifiedCp.legacyStocktakingSessionsFlaggedReview + (shouldFlagOpenReview ? 1 : 0),
                      lastStocktakingSessionCursorId: sessEntry.id,
                      executionLeaseHeartbeatAtMs: Date.now(),
                      updatedAt: batchIso,
                    };
                    if (hasConflicts) metaStore.put(reviewRecord);
                    if (step4UpdatedSessionRecord && hasSessionsStore) {
                      tx.objectStore('stocktaking_sessions').put(step4UpdatedSessionRecord);
                    }
                    metaStore.put(nextCpEmpty);
                    step4CommittedCp = nextCpEmpty;
                  }

                  if (options.onInsideBatchTxBeforeCommit) {
                    try {
                      options.onInsideBatchTxBeforeCommit({
                        tx,
                        phase: 'STOCKTAKING_BATCH',
                        batchNumber: nextBatchNumber,
                        itemIds: [sessEntry.id],
                      });
                    } catch (hookErr) {
                      abortStep4(hookErr instanceof Error ? hookErr.message : String(hookErr));
                      return;
                    }
                  }
                };

                const onStep4Read = () => {
                  readsDone += 1;
                  if (readsDone === expectedReads) {
                    proceedStep4Writes();
                  }
                };

                const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
                cpReq.onsuccess = () => {
                  liveCheckpointInTx = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
                  onStep4Read();
                };
                cpReq.onerror = () => abortStep4(cpReq.error?.message || 'STEP4_CP_READ_FAILED');

                const blReq = metaStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
                blReq.onsuccess = () => {
                  liveBaselineInTx = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
                  onStep4Read();
                };
                blReq.onerror = () => abortStep4(blReq.error?.message || 'STEP4_BL_READ_FAILED');

                if (hasSessionsStore) {
                  const sReq = tx.objectStore('stocktaking_sessions').get(sessEntry.id);
                  sReq.onsuccess = () => {
                    liveSession = sReq.result;
                    onStep4Read();
                  };
                  sReq.onerror = () =>
                    abortStep4(sReq.error?.message || `STOCKTAKING_SESSION_READ_FAILED:${sessEntry.id}`);
                }
                if (hasSubItemsStore) {
                  const subReq = tx.objectStore('stocktaking_items').getAll();
                  subReq.onsuccess = () => {
                    liveAllSubItems = Array.isArray(subReq.result) ? subReq.result : [];
                    onStep4Read();
                  };
                  subReq.onerror = () =>
                    abortStep4(subReq.error?.message || `STOCKTAKING_ITEMS_READ_FAILED:${sessEntry.id}`);
                }

                tx.oncomplete = () => {
                  if (!abortedByToctou) {
                    resolve({
                      pausedByPeer: Boolean(step4CommittedCp?.status === 'PAUSED'),
                      checkpoint: step4CommittedCp,
                    });
                  }
                };
                tx.onerror = () => {
                  if (!abortedByToctou && !pausedByPeerResult) {
                    reject(tx.error || new Error('STOCKTAKING_BATCH_TX_FAILED'));
                  }
                };
                tx.onabort = () => {
                  if (!abortedByToctou && !pausedByPeerResult) {
                    reject(tx.error || new Error('STOCKTAKING_BATCH_TX_ABORTED'));
                  }
                };
              });
            }
          );

          if (step4Outcome.pausedByPeer && step4Outcome.checkpoint) {
            return step4Outcome.checkpoint;
          }

          if (step4Outcome.checkpoint) {
            checkpoint = step4Outcome.checkpoint;
          }

          // Step 5: Independent root -> internal -> leaf -> chunk read-back verification + live TOCTOU & ownership re-check inside commit tx!
          if (allArchiveEntries.length > 0) {
            const readBackRes = await withLocalFirstMutationMutex(
              'UNIT_MIGRATION_STOCKTAKING_READBACK',
              async (lease) => {
                await assertLocalFirstMutationMutexLeaseCurrent(lease);
                return verifyStocktakingArchiveReadBack(
                  db,
                  archiveIndexKey,
                  archivePlan.archiveDigest,
                  allArchiveEntries.length,
                  sessionOwnership
                );
              }
            );
            if (readBackRes.pausedByPeer && readBackRes.checkpoint) {
              return readBackRes.checkpoint;
            }
            if (!readBackRes.ok) {
              throw new Error(
                `STOCKTAKING_ARCHIVE_READBACK_FAILED: Bounded tree verification failed for session ${sessEntry.id}`
              );
            }
            await options.onAfterStocktakingArchiveReadBack?.({
              sessionId: sessEntry.id,
              archiveIndexKey,
              archiveChunkRefs: archivePlan.chunks.map((chunk) => chunk.key),
              pageKeys: archivePlan.pages.map((page) => page.key),
            });

            const step5Outcome = await withLocalFirstMutationMutex(
              'UNIT_MIGRATION_STOCKTAKING_PUBLISH',
              async (lease): Promise<{ pausedByPeer: boolean; checkpoint: UnitMigrationCheckpoint | null }> => {
                await assertLocalFirstMutationMutexLeaseCurrent(lease);
                return new Promise((resolve, reject) => {
                  const tx = db.transaction(step4TxStores, 'readwrite');
                  const metaStore = tx.objectStore('metadata');
                  let liveSession: unknown = undefined;
                  let liveAllSubItems: unknown[] = [];
                  let liveIndex: unknown = undefined;
                  let liveCheckpointInTx: UnitMigrationCheckpoint | null = null;
                  let liveBaselineInTx: FinancialBaselineDigestRecord | null = null;
                  const expectedReads =
                    3 +
                    archivePlan.chunks.length +
                    archivePlan.pages.length +
                    (legacyQuarantineRecord ? 1 : 0) +
                    (hasConflicts ? 1 : 0) +
                    (hasSessionsStore ? 1 : 0) +
                    (hasSubItemsStore ? 1 : 0);
                  let readsDone = 0;
                  let abortedByStep5 = false;
                  let archiveReadbacksValid = true;
                  const archiveReadbackMismatchKeys: string[] = [];
                  let pausedByPeerResult: UnitMigrationCheckpoint | null = null;
                  let step5CommittedCp: UnitMigrationCheckpoint | null = null;

                  const abortStep5 = (reason: string) => {
                    if (abortedByStep5) return;
                    abortedByStep5 = true;
                    try {
                      tx.abort();
                    } catch {
                      // ignore
                    }
                    reject(new Error(reason));
                  };

                  const proceedStep5Writes = () => {
                    if (abortedByStep5) return;
                    const check = validateLiveOwnershipInTx(
                      liveCheckpointInTx,
                      liveBaselineInTx,
                      sessionOwnership
                    );
                    if (!check.ok) {
                      abortStep5(check.error.message);
                      return;
                    }
                    if (check.paused) {
                      pausedByPeerResult = check.checkpoint;
                      abortedByStep5 = true;
                      try {
                        tx.abort();
                      } catch {
                        // ignore
                      }
                      resolve({ pausedByPeer: true, checkpoint: check.checkpoint });
                      return;
                    }

                    const verifiedCp = check.checkpoint;
                    if (pauseRequestedFlag) {
                      const pausedCp: UnitMigrationCheckpoint = {
                        ...verifiedCp,
                        status: 'PAUSED',
                        pauseRequested: true,
                        pausedAt: verifiedCp.pausedAt ?? batchIso,
                        updatedAt: batchIso,
                        executionLeaseReleased: true,
                      };
                      metaStore.put(pausedCp);
                      step5CommittedCp = pausedCp;
                      pausedByPeerResult = pausedCp;
                      return;
                    }

                    if (
                      verifiedCp.lastStocktakingSessionCursorId !== null &&
                      sessEntry.id <= verifiedCp.lastStocktakingSessionCursorId
                    ) {
                      abortStep5(
                        `MIGRATION_CHECKPOINT_REGRESSION_CONFLICT: Refusing non-monotonic stocktaking cursor '${sessEntry.id}' <= '${verifiedCp.lastStocktakingSessionCursorId}'.`
                      );
                      return;
                    }

                    if (hasSessionsStore) {
                      if (
                        liveSession === undefined ||
                        sha256HexSync(canonicalStableJson(liveSession)) !== expectedSessionDigest
                      ) {
                        abortStep5(
                          `STALE_STOCKTAKING_SESSION_CONFLICT: Session '${sessEntry.id}' modified concurrently before Step 5 verification commit.`
                        );
                        return;
                      }
                    }
                    if (hasSubItemsStore) {
                      const liveSubItemsForSession = liveAllSubItems.filter(
                        (it) => getSafeOwnDataProp(it, 'sessionId').value === sessEntry.id
                      );
                      if (
                        computeCanonicalRecordsDigest(liveSubItemsForSession, recordSortId) !==
                        expectedSubItemsDigest
                      ) {
                        abortStep5(
                          `STALE_STOCKTAKING_SESSION_CONFLICT: Stocktaking subcollection items for '${sessEntry.id}' modified concurrently before Step 5 verification commit.`
                        );
                        return;
                      }
                    }
                    if (!archiveReadbacksValid) {
                      abortStep5(
                        `STOCKTAKING_ARCHIVE_FINAL_READBACK_MISMATCH: Staged archive tree for '${sessEntry.id}' changed after external readback and before publication. Mismatches: ${archiveReadbackMismatchKeys.join(',') || 'unknown'}`
                      );
                      return;
                    }
                    const idxObj = liveIndex as StocktakingConflictArchiveIndex | undefined;
                    if (
                      !idxObj ||
                      canonicalStableJson(idxObj) !== canonicalStableJson(archiveIndex)
                    ) {
                      abortStep5(
                        `STALE_STOCKTAKING_SESSION_CONFLICT: Archive manifest for '${sessEntry.id}' modified concurrently before Step 5 verification commit.`
                      );
                      return;
                    }

                    const nextCpPublished: UnitMigrationCheckpoint = {
                      ...verifiedCp,
                      phase: 'STOCKTAKING_BATCH',
                      batchNumber: verifiedCp.batchNumber + 1,
                      legacyStocktakingSessionsInspected: verifiedCp.legacyStocktakingSessionsInspected + 1,
                      legacyStocktakingArchivedConflicts:
                        verifiedCp.legacyStocktakingArchivedConflicts + newlyArchivedCount,
                      legacyStocktakingSessionsFlaggedReview:
                        verifiedCp.legacyStocktakingSessionsFlaggedReview + (shouldFlagOpenReview ? 1 : 0),
                      lastStocktakingSessionCursorId: sessEntry.id,
                      executionLeaseHeartbeatAtMs: Date.now(),
                      updatedAt: batchIso,
                    };

                    metaStore.put({
                      ...archiveIndex,
                      verifiedReadBack: true,
                    });
                    if (legacyQuarantineRecord) metaStore.put(legacyQuarantineRecord);
                    if (hasConflicts) metaStore.put(reviewRecord);
                    if (step4UpdatedSessionRecord && hasSessionsStore) {
                      tx.objectStore('stocktaking_sessions').put(step4UpdatedSessionRecord);
                    }
                    metaStore.put(nextCpPublished);
                    step5CommittedCp = nextCpPublished;
                  };

                  const onStep5Read = () => {
                    readsDone += 1;
                    if (readsDone === expectedReads) {
                      proceedStep5Writes();
                    }
                  };

                  const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
                  cpReq.onsuccess = () => {
                    liveCheckpointInTx = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
                    onStep5Read();
                  };
                  cpReq.onerror = () => abortStep5(cpReq.error?.message || 'STEP5_CP_READ_FAILED');

                  const blReq = metaStore.get(UNIT_MIGRATION_BASELINE_DIGEST_KEY);
                  blReq.onsuccess = () => {
                    liveBaselineInTx = (blReq.result as FinancialBaselineDigestRecord | undefined) ?? null;
                    onStep5Read();
                  };
                  blReq.onerror = () => abortStep5(blReq.error?.message || 'STEP5_BL_READ_FAILED');

                  const idxReq = metaStore.get(archiveIndexKey);
                  idxReq.onsuccess = () => {
                    liveIndex = idxReq.result;
                    if (!liveIndex || canonicalStableJson(liveIndex) !== canonicalStableJson(archiveIndex)) {
                      archiveReadbacksValid = false;
                      archiveReadbackMismatchKeys.push(`INDEX:${archiveIndexKey}`);
                    }
                    onStep5Read();
                  };
                  idxReq.onerror = () =>
                    abortStep5(idxReq.error?.message || `ARCHIVE_INDEX_RECHECK_FAILED:${sessEntry.id}`);

                  for (const expectedPage of archivePlan.pages) {
                    const pageReq = metaStore.get(expectedPage.key);
                    pageReq.onsuccess = () => {
                      if (
                        !pageReq.result ||
                        canonicalStableJson(pageReq.result) !== canonicalStableJson(expectedPage)
                      ) {
                        archiveReadbacksValid = false;
                        archiveReadbackMismatchKeys.push(`PAGE:${expectedPage.key}`);
                      }
                      onStep5Read();
                    };
                    pageReq.onerror = () =>
                      abortStep5(pageReq.error?.message || `ARCHIVE_PAGE_FINAL_READ_FAILED:${expectedPage.key}`);
                  }
                  if (hasConflicts) {
                    const reviewReq = metaStore.get(reviewRecord.key);
                    reviewReq.onsuccess = () => {
                      if (reviewReq.result) {
                        const liveReview = sanitizeForPlainJson(reviewReq.result) as Record<string, unknown>;
                        const expectedReview = sanitizeForPlainJson(reviewRecord) as Record<string, unknown>;
                        delete liveReview.inspectedAt;
                        delete expectedReview.inspectedAt;
                        delete liveReview.sessionStatusAtInspection;
                        delete expectedReview.sessionStatusAtInspection;
                        delete liveReview.migrationRunId;
                        delete expectedReview.migrationRunId;
                        if (canonicalStableJson(liveReview) !== canonicalStableJson(expectedReview)) {
                          archiveReadbacksValid = false;
                          archiveReadbackMismatchKeys.push(`REVIEW:${reviewRecord.key}`);
                        }
                      }
                      onStep5Read();
                    };
                    reviewReq.onerror = () =>
                      abortStep5(reviewReq.error?.message || `STOCKTAKING_REVIEW_FINAL_READ_FAILED:${sessEntry.id}`);
                  }
                  if (legacyQuarantineRecord) {
                    const legacyReq = metaStore.get(legacyQuarantineRecord.key);
                    legacyReq.onsuccess = () => {
                      if (legacyReq.result) {
                        const liveLegacy = sanitizeForPlainJson(legacyReq.result) as Record<string, unknown>;
                        const expectedLegacy = sanitizeForPlainJson(legacyQuarantineRecord) as Record<string, unknown>;
                        delete liveLegacy.quarantinedAt;
                        delete expectedLegacy.quarantinedAt;
                        if (canonicalStableJson(liveLegacy) !== canonicalStableJson(expectedLegacy)) {
                          archiveReadbacksValid = false;
                          archiveReadbackMismatchKeys.push(`LEGACY:${legacyQuarantineRecord.key}`);
                        }
                      }
                      onStep5Read();
                    };
                    legacyReq.onerror = () =>
                      abortStep5(legacyReq.error?.message || `LEGACY_ARCHIVE_QUARANTINE_READ_FAILED:${sessEntry.id}`);
                  }
                  for (const expectedChunk of archivePlan.chunks) {
                    const chunkReq = metaStore.get(expectedChunk.key);
                    chunkReq.onsuccess = () => {
                      if (
                        !chunkReq.result ||
                        canonicalStableJson(chunkReq.result) !== canonicalStableJson(expectedChunk)
                      ) {
                        archiveReadbacksValid = false;
                        archiveReadbackMismatchKeys.push(`CHUNK:${expectedChunk.key}`);
                      }
                      onStep5Read();
                    };
                    chunkReq.onerror = () =>
                      abortStep5(chunkReq.error?.message || `ARCHIVE_CHUNK_FINAL_READ_FAILED:${expectedChunk.key}`);
                  }

                  if (hasSessionsStore) {
                    const sReq = tx.objectStore('stocktaking_sessions').get(sessEntry.id);
                    sReq.onsuccess = () => {
                      liveSession = sReq.result;
                      onStep5Read();
                    };
                    sReq.onerror = () =>
                      abortStep5(sReq.error?.message || `STOCKTAKING_SESSION_STEP5_READ_FAILED:${sessEntry.id}`);
                  }
                  if (hasSubItemsStore) {
                    const subReq = tx.objectStore('stocktaking_items').getAll();
                    subReq.onsuccess = () => {
                      liveAllSubItems = Array.isArray(subReq.result) ? subReq.result : [];
                      onStep5Read();
                    };
                    subReq.onerror = () =>
                      abortStep5(subReq.error?.message || `STOCKTAKING_ITEMS_STEP5_READ_FAILED:${sessEntry.id}`);
                  }

                  tx.oncomplete = () => {
                    if (!abortedByStep5 && step5CommittedCp) {
                      resolve({
                        pausedByPeer: step5CommittedCp.status === 'PAUSED',
                        checkpoint: step5CommittedCp,
                      });
                    }
                  };
                  tx.onerror = () => {
                    if (!abortedByStep5 && !pausedByPeerResult) {
                      reject(tx.error || new Error('ARCHIVE_VERIFY_UPDATE_FAILED'));
                    }
                  };
                  tx.onabort = () => {
                    if (!abortedByStep5 && !pausedByPeerResult) {
                      reject(tx.error || new Error('ARCHIVE_VERIFY_UPDATE_ABORTED'));
                    }
                  };
                });
              }
            );

            if (step5Outcome.pausedByPeer && step5Outcome.checkpoint) {
              return step5Outcome.checkpoint;
            }
            if (step5Outcome.checkpoint) {
              checkpoint = step5Outcome.checkpoint;
            }
          }

          batchesExecutedThisInvocation += 1;
          await options.onAfterBatchCommitted?.(checkpoint);
        }

        const toFinalVerify = await commitPhaseTransitionInTx(
          db,
          activeRunId,
          activeExecutionLeaseId,
          'STOCKTAKING_BATCH',
          'FINAL_VERIFY'
        );
        if (toFinalVerify.pausedByPeer) {
          return toFinalVerify.checkpoint;
        }
        checkpoint = toFinalVerify.checkpoint;
      }

      // PHASE 3: FINAL_VERIFY
      if (checkpoint.phase === 'FINAL_VERIFY') {
        if (options.allowConcurrentMedicineEdits) {
          const catchup = await catchUpNewConcurrentMedicinesIfEnabled(
            db,
            activeRunId,
            activeExecutionLeaseId,
            'FINAL_VERIFY',
            options
          );
          if (catchup.pausedByPeer && catchup.checkpoint) {
            return catchup.checkpoint;
          }
          if (catchup.checkpoint) {
            checkpoint = catchup.checkpoint;
          }
        }
        return await verifyAndCommitFinalMigrationInTx(
          db,
          activeRunId,
          activeExecutionLeaseId,
          options
        );
      }

      return checkpoint;
    } catch (err) {
      stopHeartbeat();
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await commitFailureIfStillOwnerInTx(db, activeRunId, activeExecutionLeaseId, msg);
      } catch {
        // Best-effort status persistence without hiding root error
      }
      throw err;
    } finally {
      stopHeartbeat();
    }
  });

  activeMigrationPromise = runPromise;
  try {
    return await runPromise;
  } finally {
    if (activeMigrationPromise === runPromise) {
      activeMigrationPromise = null;
    }
  }
}

export async function startUnitMigration(
  options?: StartMigrationOptions
): Promise<UnitMigrationCheckpoint> {
  if (activeMigrationPromise) return activeMigrationPromise;
  return executeMigrationLoop('START', options);
}

export async function resumeUnitMigration(
  options?: StartMigrationOptions
): Promise<UnitMigrationCheckpoint> {
  if (activeMigrationPromise) return activeMigrationPromise;
  return executeMigrationLoop('RESUME', options);
}

export async function pauseUnitMigration(explicitDb?: IDBDatabase): Promise<UnitMigrationCheckpoint | null> {
  pauseRequestedFlag = true;
  if (activeMigrationPromise) {
    return await activeMigrationPromise;
  }
  // Cross-tab pause request runs between per-critical-section mutex steps and checks live status inside IDB readwrite tx
  return withLocalFirstMutationMutex('UNIT_MIGRATION_PAUSE', async (lease) => {
    await assertLocalFirstMutationMutexLeaseCurrent(lease);
    const db = await resolveTargetDb(explicitDb);
    return new Promise<UnitMigrationCheckpoint | null>((resolve, reject) => {
      const tx = db.transaction(['metadata'], 'readwrite');
      const metaStore = tx.objectStore('metadata');
      let result: UnitMigrationCheckpoint | null = null;
      let aborted = false;

      const req = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
      req.onsuccess = () => {
        const liveCp = (req.result as UnitMigrationCheckpoint | undefined) ?? null;
        if (!liveCp) {
          result = null;
          return;
        }
        if (liveCp.status === 'COMPLETED' || liveCp.phase === 'DONE') {
          result = liveCp;
          return;
        }
        if (liveCp.status === 'PAUSED' && liveCp.executionLeaseReleased === true) {
          result = liveCp;
          return;
        }
        const nowIso = new Date().toISOString();
        const paused: UnitMigrationCheckpoint = {
          ...liveCp,
          status: 'PAUSED',
          pauseRequested: true,
          pausedAt: liveCp.pausedAt ?? nowIso,
          updatedAt: nowIso,
          executionLeaseReleased: true,
        };
        metaStore.put(paused);
        result = paused;
      };
      req.onerror = () => {
        aborted = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(req.error || new Error('PAUSE_CP_READ_FAILED'));
      };
      tx.oncomplete = () => {
        if (!aborted) resolve(result);
      };
      tx.onerror = () => {
        if (!aborted) reject(tx.error || new Error('PAUSE_TX_FAILED'));
      };
      tx.onabort = () => {
        if (!aborted) reject(tx.error || new Error('PAUSE_TX_ABORTED'));
      };
    });
  });
}

export async function getUnitMigrationStatus(
  explicitDb?: IDBDatabase
): Promise<UnitMigrationStatusReport> {
  const db = await resolveTargetDb(explicitDb);
  const { checkpoint, baseline, quarantineKeys } = await readCheckpointAndBaseline(db);

  let totalMedicines = checkpoint?.totalMedicines ?? 0;
  if (!checkpoint && db.objectStoreNames.contains('medicines')) {
    totalMedicines = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(['medicines'], 'readonly');
      const req = tx.objectStore('medicines').count();
      req.onsuccess = () => resolve(Number(req.result ?? 0));
      req.onerror = () => reject(req.error || new Error('MED_COUNT_FAILED'));
    });
  }

  const processed = checkpoint?.processedMedicines ?? 0;
  return Object.freeze({
    schemaVersion: UNIT_MIGRATION_SCHEMA_VERSION,
    migrationRunId: checkpoint?.migrationRunId ?? null,
    status: checkpoint?.status ?? 'IDLE',
    phase: checkpoint?.phase ?? 'NOT_STARTED',
    batchSize: checkpoint?.batchSize ?? MAX_UNIT_MIGRATION_BATCH_SIZE,
    counts: Object.freeze({
      totalMedicines,
      processedMedicines: processed,
      migratedCount: checkpoint?.migratedCount ?? 0,
      quarantinedCount: checkpoint?.quarantinedCount ?? 0,
      conflictedCount: checkpoint?.conflictedCount ?? 0,
      skippedAlreadyValidCount: checkpoint?.skippedAlreadyValidCount ?? 0,
      pendingMedicines: Math.max(0, totalMedicines - processed),
      legacyStocktakingSessionsInspected:
        checkpoint?.legacyStocktakingSessionsInspected ?? 0,
      legacyStocktakingArchivedConflicts:
        checkpoint?.legacyStocktakingArchivedConflicts ?? 0,
      legacyStocktakingSessionsFlaggedReview:
        checkpoint?.legacyStocktakingSessionsFlaggedReview ?? 0,
    }),
    baselineVerified: Boolean(baseline),
    finalVerified: Boolean(checkpoint?.finalVerified),
    quarantineSampleKeys: Object.freeze(quarantineKeys.slice(0, 25)),
    trustSummary: Object.freeze({
      operationalTrustIndependentFromMigrationCompletion: true,
      verifiedMedicinesCount: 0,
      allMedicinesReadyForSale: false,
      migrationGrantsOperationalVerification: false,
    }),
    checkpoint,
  });
}

export async function getQuarantinedMedicineRecord(
  medicineId: string,
  explicitDb?: IDBDatabase
): Promise<MedicineQuarantineRecord | null> {
  const db = await resolveTargetDb(explicitDb);
  const key = `${UNIT_MIGRATION_QUARANTINE_PREFIX}${medicineId}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['metadata'], 'readonly');
    const req = tx.objectStore('metadata').get(key);
    req.onsuccess = () => resolve((req.result as MedicineQuarantineRecord | undefined) ?? null);
    req.onerror = () => reject(req.error || new Error('QUARANTINE_READ_FAILED'));
  });
}

export async function getStocktakingArchiveForSession(
  sessionId: string,
  explicitDb?: IDBDatabase
): Promise<{
  index: StocktakingConflictArchiveIndex | null;
  indexPages: StocktakingConflictArchiveIndexPage[];
  chunks: StocktakingConflictArchiveChunk[];
  entries: StocktakingConflictArchiveEntry[];
  review: StocktakingSessionReviewMetadata | null;
  legacyQuarantine: LegacyArchiveQuarantineRecord | null;
}> {
  const db = await resolveTargetDb(explicitDb);
  const indexKey = `${UNIT_MIGRATION_STOCKTAKING_ARCHIVE_INDEX_PREFIX}${sessionId}`;
  const reviewKey = `${UNIT_MIGRATION_STOCKTAKING_REVIEW_PREFIX}${sessionId}`;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(['metadata'], 'readonly');
    const metaStore = tx.objectStore('metadata');
    let index: StocktakingConflictArchiveIndex | null = null;
    let review: StocktakingSessionReviewMetadata | null = null;

    const indexReq = metaStore.get(indexKey);
    const reviewReq = metaStore.get(reviewKey);
    let baseDone = 0;

    const finishWithTreeTraversal = (treeIndex: StocktakingConflictArchiveIndex) => {
      const legacyKey = treeIndex.legacyArchiveQuarantineKey ?? null;
      let legacyQuarantine: LegacyArchiveQuarantineRecord | null = null;

      const proceedTraversal = () => {
        if (!treeIndex.rootPageKey || treeIndex.totalEntries === 0) {
          resolve({
            index: treeIndex,
            indexPages: [],
            chunks: [],
            entries: [],
            review,
            legacyQuarantine,
          });
          return;
        }

        const indexPages: StocktakingConflictArchiveIndexPage[] = [];
        const chunks: StocktakingConflictArchiveChunk[] = [];
        const visitedPages = new Set<string>();

        const visitPage = (pageKey: string, onPageDone: () => void) => {
          if (visitedPages.has(pageKey)) {
            onPageDone();
            return;
          }
          visitedPages.add(pageKey);
          const pReq = metaStore.get(pageKey);
          pReq.onsuccess = () => {
            const page = pReq.result as StocktakingConflictArchiveIndexPage | undefined;
            if (!page || !Array.isArray(page.refs)) {
              onPageDone();
              return;
            }
            indexPages.push(page);
            if (page.nodeType === 'LEAF') {
              const refs = page.refs as ReadonlyArray<StocktakingConflictArchiveLeafRef>;
              let i = 0;
              const nextChunk = () => {
                if (i >= refs.length) {
                  onPageDone();
                  return;
                }
                const cKey = refs[i]?.chunkKey;
                i += 1;
                if (!cKey) {
                  nextChunk();
                  return;
                }
                const cReq = metaStore.get(cKey);
                cReq.onsuccess = () => {
                  const ch = cReq.result as StocktakingConflictArchiveChunk | undefined;
                  if (ch) chunks.push(ch);
                  nextChunk();
                };
                cReq.onerror = () => reject(cReq.error || new Error('ARCHIVE_CHUNK_GET_FAILED'));
              };
              nextChunk();
              return;
            }
            const refs = page.refs as ReadonlyArray<StocktakingConflictArchiveInternalRef>;
            let i = 0;
            const nextChild = () => {
              if (i >= refs.length) {
                onPageDone();
                return;
              }
              const childKey = refs[i]?.pageKey;
              i += 1;
              if (!childKey) {
                nextChild();
                return;
              }
              visitPage(childKey, nextChild);
            };
            nextChild();
          };
          pReq.onerror = () => reject(pReq.error || new Error('ARCHIVE_PAGE_GET_FAILED'));
        };

        visitPage(treeIndex.rootPageKey, () => {
          chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
          const entries = chunks.flatMap((c) => c.entries);
          resolve({
            index: treeIndex,
            indexPages,
            chunks,
            entries,
            review,
            legacyQuarantine,
          });
        });
      };

      if (legacyKey) {
        const lReq = metaStore.get(legacyKey);
        lReq.onsuccess = () => {
          legacyQuarantine = (lReq.result as LegacyArchiveQuarantineRecord | undefined) ?? null;
          proceedTraversal();
        };
        lReq.onerror = () => reject(lReq.error || new Error('LEGACY_QUARANTINE_READ_FAILED'));
      } else {
        proceedTraversal();
      }
    };

    const finishWithLegacyFallbackScan = () => {
      const allReq = metaStore.getAll();
      allReq.onsuccess = () => {
        const rows = Array.isArray(allReq.result) ? allReq.result : [];
        const legacyChunks: StocktakingConflictArchiveChunk[] = [];
        for (const row of rows) {
          const kProp = getSafeOwnDataProp(row, 'key');
          if (
            kProp.found &&
            typeof kProp.value === 'string' &&
            kProp.value.startsWith(UNIT_MIGRATION_STOCKTAKING_ARCHIVE_CHUNK_PREFIX)
          ) {
            const c = row as StocktakingConflictArchiveChunk;
            if (c.sessionId === sessionId && Array.isArray(c.entries)) {
              legacyChunks.push(c);
            }
          }
        }
        legacyChunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
        const entries = legacyChunks.flatMap((c) => c.entries);
        resolve({
          index,
          indexPages: [],
          chunks: legacyChunks,
          entries,
          review,
          legacyQuarantine: null,
        });
      };
      allReq.onerror = () => reject(allReq.error || new Error('ARCHIVE_LEGACY_SCAN_FAILED'));
    };

    const afterBase = () => {
      baseDone += 1;
      if (baseDone < 2) return;
      if (!index) {
        resolve({
          index: null,
          indexPages: [],
          chunks: [],
          entries: [],
          review,
          legacyQuarantine: null,
        });
        return;
      }
      if (index.archiveFormat === 'BOUNDED_TREE_V2') {
        finishWithTreeTraversal(index);
      } else {
        finishWithLegacyFallbackScan();
      }
    };

    indexReq.onsuccess = () => {
      index = (indexReq.result as StocktakingConflictArchiveIndex | undefined) ?? null;
      afterBase();
    };
    indexReq.onerror = () => reject(indexReq.error || new Error('ARCHIVE_INDEX_GET_FAILED'));

    reviewReq.onsuccess = () => {
      review = (reviewReq.result as StocktakingSessionReviewMetadata | undefined) ?? null;
      afterBase();
    };
    reviewReq.onerror = () => reject(reviewReq.error || new Error('ARCHIVE_REVIEW_GET_FAILED'));
  });
}

export interface AuthorizeUnitQuarantineRecoveryOptions {
  readonly db?: IDBDatabase;
  readonly session?: TrustedActorSessionState | null | undefined;
  readonly medicineId: string;
  readonly reason: string;
  readonly updatedUnitConfig: {
    readonly dosageForm: KnownDosageFormKind;
    readonly baseUnitsPerPack?: number;
    readonly stripsPerPack?: number;
    readonly pillsPerStrip?: number;
    readonly unitDefinition: SerializedUnitDefinitionDTOV2;
  };
  readonly v1InFlightMedicineIds?: ReadonlyArray<string>;
  readonly v1InFlightInspector?: () => ReadonlyArray<string>;
  readonly v1InFlightEnumerator?: (() => V1InFlightEnumerationResult) | null;
  readonly v1InFlightAvailable?: boolean;
  readonly v1InFlightNowMs?: number;
  readonly v1ContextHints?: ReadonlyArray<{ readonly uid: string; readonly branchId: string }>;
}

export interface AuthorizeUnitQuarantineRecoveryResult {
  readonly recovered: true;
  readonly medicineId: string;
  readonly configStatus: 'LEGACY_ASSUMED' | 'UNVERIFIED_UNKNOWN';
  readonly packingLocked: boolean;
  readonly unitOperationalAllowed: false;
  readonly resolvedByUid: string;
  readonly resolvedAt: string;
  readonly reason: string;
  readonly unitDefinitionKey: string;
  readonly baseDimensionKey: string;
}

async function authorizeUnitQuarantineRecoveryUnlocked(
  options: AuthorizeUnitQuarantineRecoveryOptions
): Promise<AuthorizeUnitQuarantineRecoveryResult> {
  if (activeMigrationPromise !== null) {
    throw new Error(
      'MIGRATION_IN_PROGRESS: Cannot authorize quarantine recovery while unit migration is active.'
    );
  }

  const medId = typeof options?.medicineId === 'string' ? options.medicineId.trim() : '';
  if (!medId) {
    throw new Error('INVALID_MEDICINE_ID: Medicine ID is required for quarantine recovery.');
  }

  const cleanReason = typeof options?.reason === 'string' ? options.reason.trim() : '';
  if (cleanReason.length < 3) {
    throw new Error('INVALID_RECOVERY_REASON: Audit reason of at least 3 characters is required.');
  }

  const callerSession = options?.session;
  const authAuthorityEnforced = isTrustedAuthAuthorityEnforced();
  const trustedSession = authAuthorityEnforced ? getTrustedActorSessionState() : null;
  const knownActorUid = getKnownActiveActorId();

  if (
    !authAuthorityEnforced ||
    !trustedSession ||
    !isValidFirebaseActorUid(trustedSession.uid) ||
    trustedSession.emailVerified !== true ||
    trustedSession.offlineFallback === true ||
    (trustedSession.role !== 'admin' && trustedSession.role !== 'super_admin') ||
    isTrustedSessionExpired(trustedSession) ||
    knownActorUid !== trustedSession.uid
  ) {
    throw new Error(
      'UNAUTHORIZED_QUARANTINE_RECOVERY: Verified online admin or super_admin runtime session is required.'
    );
  }

  const currentActiveBranch = getActiveBranchId();
  if (
    typeof currentActiveBranch !== 'string' ||
    currentActiveBranch.trim().length === 0 ||
    (trustedSession.role === 'admin' && !trustedSession.branchIds.includes(currentActiveBranch))
  ) {
    throw new Error(
      'UNAUTHORIZED_QUARANTINE_RECOVERY: Active branch is missing or unauthorized for trusted runtime session.'
    );
  }

  const expectedDbName = getBranchDbName(currentActiveBranch);
  if (getActiveDbName() !== expectedDbName) {
    throw new Error(
      `UNAUTHORIZED_DATABASE_HANDLE: Active database "${getActiveDbName()}" does not match expected branch database "${expectedDbName}".`
    );
  }

  // Any caller-supplied session may only match the authoritative runtime session; it can never override, extend, or escalate.
  if (callerSession !== undefined) {
    if (
      !callerSession ||
      typeof callerSession !== 'object' ||
      Array.isArray(callerSession) ||
      callerSession.uid !== trustedSession.uid ||
      callerSession.role !== trustedSession.role ||
      callerSession.emailVerified !== true ||
      callerSession.offlineFallback === true ||
      isTrustedSessionExpired(callerSession) ||
      (callerSession.activeBranchId !== undefined &&
        callerSession.activeBranchId !== null &&
        callerSession.activeBranchId !== currentActiveBranch) ||
      !Array.isArray(callerSession.branchIds) ||
      (trustedSession.role === 'admin' &&
        (callerSession.branchIds.length === 0 ||
          callerSession.branchIds.some((branchId) => !trustedSession.branchIds.includes(branchId))))
    ) {
      throw new Error(
        'UNAUTHORIZED_QUARANTINE_RECOVERY: Caller session does not match trusted runtime actor or branch authorization.'
      );
    }
  }

  const session = trustedSession;

  const cfg = options?.updatedUnitConfig;
  if (!cfg || !cfg.unitDefinition || typeof cfg.unitDefinition !== 'object') {
    throw new Error('INVALID_RECOVERY_CONFIG: Validated V2 unitDefinition is required.');
  }

  // Rehydrate & revalidate the supplied V2 DTO strictly BEFORE touching IndexedDB
  const rehydrated = rehydrateUnitDefinitionFromDto(cfg.unitDefinition);
  if (!rehydrated.ok) {
    throw new Error(`INVALID_RECOVERY_DTO: ${rehydrated.message}`);
  }
  const parsedDef = rehydrated.definition;
  if (parsedDef.dosageForm !== cfg.dosageForm) {
    throw new Error(
      `INVALID_RECOVERY_CONFIG: dosageForm mismatch ('${cfg.dosageForm}' vs '${parsedDef.dosageForm}')`
    );
  }
  if (
    cfg.baseUnitsPerPack !== undefined &&
    cfg.baseUnitsPerPack !== parsedDef.baseUnitsPerPack
  ) {
    throw new Error('INVALID_RECOVERY_CONFIG: baseUnitsPerPack does not match unitDefinition.');
  }
  if (
    rehydrated.trustStatus === 'QUARANTINED' ||
    rehydrated.trustStatus === 'RECONCILIATION_REQUIRED'
  ) {
    throw new Error(
      `INVALID_RECOVERY_CONFIG: Recovery target status cannot remain '${rehydrated.trustStatus}'.`
    );
  }
  if (parsedDef.hierarchy.kind === 'SOLID_TWO_LEVEL') {
    if (
      cfg.stripsPerPack !== undefined &&
      cfg.stripsPerPack !== parsedDef.hierarchy.stripsPerPack
    ) {
      throw new Error('INVALID_RECOVERY_CONFIG: stripsPerPack mismatch.');
    }
    if (
      cfg.pillsPerStrip !== undefined &&
      cfg.pillsPerStrip !== parsedDef.hierarchy.pillsPerStrip
    ) {
      throw new Error('INVALID_RECOVERY_CONFIG: pillsPerStrip mismatch.');
    }
    if (parsedDef.hierarchy.stripsPerPack === 1 && parsedDef.hierarchy.pillsPerStrip === 1) {
      throw new Error('INVALID_RECOVERY_CONFIG: Unconfirmed 1x1 solid factors cannot recover quarantine.');
    }
  }

  // Recovery never promotes directly to VERIFIED; preserve LEGACY_ASSUMED or UNVERIFIED_UNKNOWN conservatively
  const conservativeRecoveredStatus: 'LEGACY_ASSUMED' | 'UNVERIFIED_UNKNOWN' =
    rehydrated.trustStatus === 'LEGACY_ASSUMED' ? 'LEGACY_ASSUMED' : 'UNVERIFIED_UNKNOWN';

  // Ensure V1 in-flight registry is resolved (fail closed if unavailable)
  let v1InitFailed = false;
  try {
    await ensureV1InFlightCheckerResolved();
  } catch {
    v1InitFailed = true;
  }
  if (v1InitFailed || options.v1InFlightAvailable === false) {
    throw new Error(
      'QUARANTINE_RECOVERY_DENIED_UNKNOWN_EVIDENCE: V1 in-flight registry is unavailable; refusing recovery while locked and quarantined.'
    );
  }

  const db = await resolveTargetDb(options.db, expectedDbName);
  let availableStoreNames: string[] = [];
  try {
    for (const requiredStore of REQUIRED_EVIDENCE_STORES) {
      if (!db.objectStoreNames.contains(requiredStore)) {
        throw new Error(
          `QUARANTINE_RECOVERY_DENIED_UNKNOWN_EVIDENCE: Missing required store '${requiredStore}'.`
        );
      }
    }
    availableStoreNames = OPTIONAL_EVIDENCE_STORES.filter((store) =>
      db.objectStoreNames.contains(store)
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('QUARANTINE_RECOVERY_DENIED_UNKNOWN_EVIDENCE:')) {
      throw err;
    }
    throw new Error(
      `UNAUTHORIZED_DATABASE_HANDLE: Database handle is closed or inaccessible (${err instanceof Error ? err.message : String(err)}).`
    );
  }

  const nowIso = new Date().toISOString();
  const recoveryAuditKey = `${UNIT_MIGRATION_RECOVERY_AUDIT_PREFIX}${medId}:${generateMigrationRunId()}`;
  const txStores = Array.from(new Set<string>([
    ...REQUIRED_EVIDENCE_STORES,
    ...availableStoreNames,
  ]));
  const localRetrySnapshot = readV1LocalStorageRetrySnapshot();

  return withCrossTabMigrationWebLock(
    async ({ heldExclusiveWebLock }) =>
      new Promise<AuthorizeUnitQuarantineRecoveryResult>((resolve, reject) => {
        if (db.name !== expectedDbName || getActiveDbName() !== expectedDbName || getActiveBranchId() !== currentActiveBranch) {
          reject(
            new Error(
              `UNAUTHORIZED_DATABASE_HANDLE: Active branch or database handle changed before quarantine recovery transaction.`
            )
          );
          return;
        }
        let tx: IDBTransaction;
        try {
          tx = db.transaction(txStores, 'readwrite');
        } catch (txOpenErr) {
          reject(
            new Error(
              `UNAUTHORIZED_DATABASE_HANDLE: Failed to open quarantine recovery transaction (${txOpenErr instanceof Error ? txOpenErr.message : String(txOpenErr)}).`
            )
          );
          return;
        }
        const medStore = tx.objectStore('medicines');
        const metaStore = tx.objectStore('metadata');
        const storeDataMap = new Map<string, unknown[]>();
        let liveMed: unknown = undefined;
        let liveQuarantine: MedicineQuarantineRecord | null = null;
        let idbV1LeaseRows: unknown[] = [];
        const expectedReads = txStores.length + 6;
        let readsDone = 0;
        let recoveryAuditKeyAlreadyExists = false;
        let liveMedicineFingerprintRecord: unknown = null;
        let liveCheckpointInTx: UnitMigrationCheckpoint | null = null;
        let abortedByApp = false;
        let outcomeResult: AuthorizeUnitQuarantineRecoveryResult | null = null;

        const abortRecovery = (reason: string) => {
          if (abortedByApp) return;
          abortedByApp = true;
          try {
            tx.abort();
          } catch {
            // ignore
          }
          reject(new Error(reason));
        };

        const onAllReads = () => {
          if (abortedByApp) return;
          try {
            const liveTrusted = isTrustedAuthAuthorityEnforced()
              ? getTrustedActorSessionState()
              : null;
            const liveActorUid = getKnownActiveActorId();
            const liveBranch = getActiveBranchId();
            const liveActiveDbName = getActiveDbName();
            if (
              !liveTrusted ||
              liveTrusted.uid !== trustedSession.uid ||
              liveTrusted.role !== trustedSession.role ||
              liveTrusted.emailVerified !== true ||
              liveTrusted.offlineFallback === true ||
              (liveTrusted.role !== 'admin' && liveTrusted.role !== 'super_admin') ||
              isTrustedSessionExpired(liveTrusted) ||
              liveActorUid !== trustedSession.uid ||
              liveBranch !== currentActiveBranch ||
              (liveTrusted.role === 'admin' && !liveTrusted.branchIds.includes(liveBranch))
            ) {
              abortRecovery(
                'UNAUTHORIZED_QUARANTINE_RECOVERY: Trusted runtime session or branch authorization revoked during quarantine recovery.'
              );
              return;
            }
            const txDb = (tx as unknown as { db?: { name?: unknown } })?.db;
            const txDbName = txDb?.name;
            if (
              !txDb ||
              typeof txDb !== 'object' ||
              typeof txDbName !== 'string' ||
              txDbName.trim().length === 0 ||
              txDbName !== expectedDbName ||
              db.name !== expectedDbName ||
              liveActiveDbName !== expectedDbName
            ) {
              abortRecovery(
                `UNAUTHORIZED_DATABASE_HANDLE: Database handle changed or mismatched during quarantine recovery ("${String(txDbName ?? 'MISSING_TX_DB_NAME')}" vs "${expectedDbName}").`
              );
              return;
            }
            const hasActiveMigrationCheckpoint = Boolean(
              liveCheckpointInTx &&
                liveCheckpointInTx.status === 'IN_PROGRESS' &&
                liveCheckpointInTx.phase !== 'DONE' &&
                liveCheckpointInTx.executionLeaseReleased !== true
            );
            if (
              isExecutionLeaseActivelyHeld(liveCheckpointInTx) ||
              (heldExclusiveWebLock && hasActiveMigrationCheckpoint) ||
              (!heldExclusiveWebLock && hasActiveMigrationCheckpoint)
            ) {
              abortRecovery(
                'MIGRATION_IN_PROGRESS: Cannot authorize quarantine recovery while unit migration is active or unpaused.'
              );
              return;
            }
        if (!liveMed || typeof liveMed !== 'object' || Array.isArray(liveMed)) {
          abortRecovery(`MEDICINE_NOT_FOUND: Medicine '${medId}' does not exist.`);
          return;
        }
        const safeOwnObj = sanitizeForPlainJson(liveMed) as Record<string, unknown>;
        if (liveQuarantine !== null) {
          const q = liveQuarantine as unknown as Record<string, unknown>;
          if (
            !q ||
            typeof q !== 'object' ||
            Array.isArray(q) ||
            q.key !== `${UNIT_MIGRATION_QUARANTINE_PREFIX}${medId}` ||
            q.schemaVersion !== UNIT_MIGRATION_SCHEMA_VERSION ||
            q.medicineId !== medId ||
            (q.classification !== 'QUARANTINED' && q.classification !== 'CONFLICTED') ||
            q.operationalAllowed !== false ||
            typeof q.packingLocked !== 'boolean' ||
            typeof q.reasonCode !== 'string' ||
            !q.reasonCode.trim() ||
            typeof q.message !== 'string' ||
            typeof q.firstQuarantinedAt !== 'string' ||
            typeof q.lastSeenAt !== 'string' ||
            typeof q.migrationRunId !== 'string' ||
            typeof q.lastSeenRunId !== 'string' ||
            !Object.prototype.hasOwnProperty.call(q, 'rawSnapshot') ||
            q.reviewStatus !== 'PENDING_PHARMACIST_REVIEW'
          ) {
            abortRecovery('MALFORMED_QUARANTINE_RECORD: Existing quarantine metadata is malformed or already resolved while medicine remains quarantined.');
            return;
          }
        }
        const isCurrentlyQuarantinedOrConflicted =
          Boolean(liveQuarantine && liveQuarantine.reviewStatus !== 'RESOLVED') ||
          safeOwnObj.configStatus === 'QUARANTINED' ||
          safeOwnObj.configStatus === 'RECONCILIATION_REQUIRED' ||
          safeOwnObj.unitMigrationStatus === 'QUARANTINED' ||
          safeOwnObj.unitMigrationStatus === 'CONFLICTED';

        if (!isCurrentlyQuarantinedOrConflicted) {
          abortRecovery(
            `NOT_QUARANTINED: Medicine '${medId}' is not currently quarantined or conflicted.`
          );
          return;
        }

        const presentSet = new Set<string>(txStores);
        const existingQuarantines = new Map<string, MedicineQuarantineRecord>();
        if (liveQuarantine) {
          existingQuarantines.set(medId, liveQuarantine);
        }

        const evalRes = evaluateAllPackingLockEvidenceSnapshot({
          presentStores: presentSet,
          medicines: storeDataMap.get('medicines') ?? [],
          ledger: storeDataMap.get('inventory_ledger') ?? [],
          sales: storeDataMap.get('sales') ?? [],
          purchaseInvoices: storeDataMap.get('purchase_invoices') ?? [],
          outbox: storeDataMap.get('outbox') ?? [],
          stocktakingSessions: storeDataMap.get('stocktaking_sessions') ?? [],
          stocktakingItems: storeDataMap.get('stocktaking_items') ?? [],
          supplierInvoiceDrafts: storeDataMap.get('supplier_invoice_drafts') ?? [],
          backupReviewMetadata: storeDataMap.get('metadata') ?? [],
          existingQuarantines,
          idbV1LeaseRows,
          localRetrySnapshot,
          v1InFlightMedicineIds: options.v1InFlightMedicineIds,
          v1InFlightInspector: options.v1InFlightInspector,
          v1InFlightEnumerator: options.v1InFlightEnumerator,
          v1InFlightAvailable: options.v1InFlightAvailable,
          v1InFlightNowMs: options.v1InFlightNowMs,
          v1ContextHints: options.v1ContextHints,
          excludeQuarantineSelfLockForRecovery: true,
        });

        const freshReport = evalRes.buildReportForMedicine(medId, liveMed, liveQuarantine);
        if (freshReport.status === 'UNKNOWN_FAIL_CLOSED') {
          abortRecovery(
            `QUARANTINE_RECOVERY_DENIED_UNKNOWN_EVIDENCE: ${freshReport.unknownFailureReasons.join(', ')}`
          );
          return;
        }

        const hasNonQuarantineEvidence = freshReport.matchedSources.length > 0;
        const wasPreQuarantineLocked = liveQuarantine
          ? liveQuarantine.preQuarantinePackingLocked !== false
          : true;
        const wantsUnlock = cfg.unitDefinition.packingLocked === false;

        if (wantsUnlock && (hasNonQuarantineEvidence || wasPreQuarantineLocked)) {
          abortRecovery(
            `QUARANTINE_RECOVERY_UNLOCK_DENIED: Cannot unlock packingLocked for '${medId}' (evidence=[${freshReport.matchedSources.join(',')}], preQuarantineLocked=${String(wasPreQuarantineLocked)}).`
          );
          return;
        }

        const finalPackingLocked = Boolean(
          hasNonQuarantineEvidence || wasPreQuarantineLocked || cfg.unitDefinition.packingLocked === true
        );

        const canonicalDef = createValidatedUnitDefinition({
          dosageForm: parsedDef.dosageForm,
          baseUnit: parsedDef.baseUnit,
          packUnit: parsedDef.packUnit,
          intermediateUnit: parsedDef.hierarchy.intermediateUnit,
          ...(parsedDef.hierarchy.kind === 'SOLID_TWO_LEVEL'
            ? {
                stripsPerPack: parsedDef.hierarchy.stripsPerPack,
                pillsPerStrip: parsedDef.hierarchy.pillsPerStrip,
              }
            : {}),
          baseUnitsPerPack: parsedDef.baseUnitsPerPack,
          requestedSellableUnits: [...parsedDef.sellableUnits.toArray()],
          definitionVersion: parsedDef.definitionVersion,
          configStatus: conservativeRecoveredStatus,
          packingLocked: finalPackingLocked,
        });
        const finalDto = serializeUnitDefinitionToDto(canonicalDef);

        const patchedMed = buildUpdatedPlainMedicine(safeOwnObj, {
          dosageForm: finalDto.dosageForm,
          baseUnitsPerPack: finalDto.baseUnitsPerPack,
          configStatus: conservativeRecoveredStatus,
          unitDefinition: finalDto,
          unitDefinitionKey: finalDto.unitDefinitionKey,
          baseDimensionKey: finalDto.baseDimensionKey,
          packingLocked: finalDto.packingLocked,
          unitMigrationStatus: 'MIGRATED_CONSERVATIVE',
          unitMigratedAt: nowIso,
          unitOperationalAllowed: false,
        });

        // Validate patched medicine against pharmacyDb medicineUnitPolicy price ladder & sellable flags
        validateMedicineUnitConfiguration(patchedMed);
        assertOnlyAuthorizedMedicinePatch(liveMed, patchedMed);

        if (recoveryAuditKeyAlreadyExists) {
          abortRecovery('QUARANTINE_RECOVERY_AUDIT_KEY_COLLISION: Refusing to overwrite an existing recovery audit event.');
          return;
        }
        if (liveMedicineFingerprintRecord !== null) {
          const fingerprintRecord = sanitizeForPlainJson(liveMedicineFingerprintRecord) as Record<string, unknown> | null;
          if (
            !fingerprintRecord ||
            fingerprintRecord.schemaVersion !== 1 ||
            fingerprintRecord.medicineId !== medId ||
            typeof fingerprintRecord.migrationRunId !== 'string' ||
            typeof fingerprintRecord.fingerprint !== 'string' ||
            !fingerprintRecord.stockSnapshot ||
            typeof fingerprintRecord.stockSnapshot !== 'object' ||
            Array.isArray(fingerprintRecord.stockSnapshot) ||
            !Array.isArray(fingerprintRecord.knownLedgerIdsAtCapture) ||
            !fingerprintRecord.knownLedgerIdsAtCapture.every((id) => typeof id === 'string') ||
            typeof fingerprintRecord.capturedAt !== 'string'
          ) {
            abortRecovery('MALFORMED_MEDICINE_FINGERPRINT: Cannot update an invalid migration fingerprint during recovery.');
            return;
          }
          const capturedSnap = fingerprintRecord.stockSnapshot as Record<string, unknown>;
          const stockAnchorForFingerprint: Record<string, unknown> = {
            ...(patchedMed as unknown as Record<string, unknown>),
          };
          for (const stockField of [
            'stock',
            'currentStock',
            'initialStock',
            'quantity',
            'totalBasePills',
            'baseStock',
            'batches',
            'openingStockEvidence',
          ] as const) {
            const snapEntry = capturedSnap[stockField] as { found?: boolean; value?: unknown } | undefined;
            if (!snapEntry || !snapEntry.found) {
              delete stockAnchorForFingerprint[stockField];
            } else if (
              snapEntry.value &&
              typeof snapEntry.value === 'object' &&
              (snapEntry.value as { __type?: string }).__type === 'undefined'
            ) {
              stockAnchorForFingerprint[stockField] = undefined;
            } else {
              stockAnchorForFingerprint[stockField] = snapEntry.value;
            }
          }
          metaStore.put({
            ...fingerprintRecord,
            fingerprint: computeMedicineUnitStockFingerprint(stockAnchorForFingerprint),
            unitIdentityFingerprint: computeMedicineUnitIdentityFingerprint(patchedMed),
            stockSnapshot: fingerprintRecord.stockSnapshot,
            knownLedgerIdsAtCapture: fingerprintRecord.knownLedgerIdsAtCapture,
            capturedAt: fingerprintRecord.capturedAt,
          });
        }

        medStore.put(patchedMed);
        if (liveQuarantine) {
          const updatedQuarantine: MedicineQuarantineRecord = {
            ...liveQuarantine,
            reviewStatus: 'RESOLVED',
            resolvedAt: nowIso,
            resolvedByUid: session.uid,
            resolutionReason: cleanReason,
            packingLocked: finalPackingLocked,
            lastSeenAt: nowIso,
          };
          metaStore.put(updatedQuarantine);
        }

        // Append-only event: missing legacy metadata is explicitly recorded as unavailable.
        metaStore.add({
          key: recoveryAuditKey,
          schemaVersion: UNIT_MIGRATION_SCHEMA_VERSION,
          eventType: 'QUARANTINE_RECOVERY_AUTHORIZED',
          medicineId: medId,
          recordedAt: nowIso,
          actorUid: session.uid,
          actorRole: session.role,
          reason: cleanReason,
          historicalQuarantineEvidence: liveQuarantine ? 'PRESENT' : 'UNAVAILABLE_LEGACY_RECORD_MISSING',
          firstQuarantinedAt: liveQuarantine?.firstQuarantinedAt ?? null,
          beforeMedicineSnapshot: sanitizeForPlainJson(liveMed),
          afterMedicineSnapshot: sanitizeForPlainJson(patchedMed),
          quarantineRecordSnapshot: liveQuarantine ? sanitizeForPlainJson(liveQuarantine) : null,
          packingLockEvidence: {
            status: freshReport.status,
            effectivePackingLocked: freshReport.effectivePackingLocked,
            matchedSources: [...freshReport.matchedSources],
            reasons: [...freshReport.reasons],
            unknownFailureReasons: [...freshReport.unknownFailureReasons],
          },
        });

        outcomeResult = {
          recovered: true,
          medicineId: medId,
          configStatus: conservativeRecoveredStatus,
          packingLocked: finalPackingLocked,
          unitOperationalAllowed: false,
          resolvedByUid: session.uid,
          resolvedAt: nowIso,
          reason: cleanReason,
          unitDefinitionKey: finalDto.unitDefinitionKey,
          baseDimensionKey: finalDto.baseDimensionKey,
        };
      } catch (err) {
        abortRecovery(err instanceof Error ? err.message : String(err));
      }
    };

    const markRead = () => {
      readsDone += 1;
      if (readsDone === expectedReads) {
        onAllReads();
      }
    };

    const cpReq = metaStore.get(UNIT_MIGRATION_CHECKPOINT_KEY);
    cpReq.onsuccess = () => {
      liveCheckpointInTx = (cpReq.result as UnitMigrationCheckpoint | undefined) ?? null;
      markRead();
    };
    cpReq.onerror = () => abortRecovery(cpReq.error?.message || 'RECOVERY_CHECKPOINT_READ_FAILED');

    const targetMedReq = medStore.get(medId);
    targetMedReq.onsuccess = () => {
      liveMed = targetMedReq.result;
      markRead();
    };
    targetMedReq.onerror = () => abortRecovery(targetMedReq.error?.message || 'MED_READ_FAILED');

    const qReq = metaStore.get(`${UNIT_MIGRATION_QUARANTINE_PREFIX}${medId}`);
    qReq.onsuccess = () => {
      liveQuarantine = (qReq.result as MedicineQuarantineRecord | undefined) ?? null;
      markRead();
    };
    qReq.onerror = () => abortRecovery(qReq.error?.message || 'QUARANTINE_READ_FAILED');

    const medicineFingerprintReq = metaStore.get(
      `${UNIT_MIGRATION_MEDICINE_FINGERPRINT_PREFIX}${medId}`
    );
    medicineFingerprintReq.onsuccess = () => {
      liveMedicineFingerprintRecord = medicineFingerprintReq.result ?? null;
      markRead();
    };
    medicineFingerprintReq.onerror = () =>
      abortRecovery(medicineFingerprintReq.error?.message || 'MEDICINE_FINGERPRINT_READ_FAILED');

    const recoveryAuditReq = metaStore.get(recoveryAuditKey);
    recoveryAuditReq.onsuccess = () => {
      recoveryAuditKeyAlreadyExists = recoveryAuditReq.result !== undefined;
      markRead();
    };
    recoveryAuditReq.onerror = () =>
      abortRecovery(recoveryAuditReq.error?.message || 'RECOVERY_AUDIT_KEY_CHECK_FAILED');

    const leaseReq = metaStore.getAll(
      IDBKeyRange.bound(V1_IN_FLIGHT_LEASE_IDB_PREFIX, `${V1_IN_FLIGHT_LEASE_IDB_PREFIX}\uffff`)
    );
    leaseReq.onsuccess = () => {
      idbV1LeaseRows = Array.isArray(leaseReq.result) ? leaseReq.result : [];
      markRead();
    };
    leaseReq.onerror = () => abortRecovery(leaseReq.error?.message || 'V1_IDB_LEASE_READ_FAILED');

    for (const storeName of txStores) {
      const sReq = tx.objectStore(storeName).getAll();
      sReq.onsuccess = () => {
        storeDataMap.set(storeName, Array.isArray(sReq.result) ? sReq.result : []);
        markRead();
      };
      sReq.onerror = () => abortRecovery(sReq.error?.message || `STORE_READ_FAILED:${storeName}`);
    }

    tx.oncomplete = () => {
      if (!abortedByApp && outcomeResult) {
        resolve(outcomeResult);
      }
    };
    tx.onerror = () => {
      if (!abortedByApp) reject(tx.error || new Error('QUARANTINE_RECOVERY_TX_FAILED'));
    };
        tx.onabort = () => {
          if (!abortedByApp) reject(tx.error || new Error('QUARANTINE_RECOVERY_TX_ABORTED'));
        };
      }),
    'MIGRATION_IN_PROGRESS: Cannot authorize quarantine recovery while another tab holds the migration Web Lock.'
  );
}


export async function authorizeUnitQuarantineRecovery(
  options: AuthorizeUnitQuarantineRecoveryOptions
): Promise<AuthorizeUnitQuarantineRecoveryResult> {
  return withLocalFirstMutationMutex('UNIT_QUARANTINE_RECOVERY', () =>
    authorizeUnitQuarantineRecoveryUnlocked(options)
  );
}
