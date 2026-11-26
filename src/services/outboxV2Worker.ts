import {
  deleteDoc as firestoreDeleteDoc,
  doc,
  getDocFromServer as firestoreGetDocFromServer,
  serverTimestamp as firestoreServerTimestamp,
  setDoc as firestoreSetDoc,
  Timestamp,
  updateDoc as firestoreUpdateDoc,
} from 'firebase/firestore';
import {
  acquireOutboxLease,
  buildCanonicalFirestoreDocumentPath,
  buildOutboxDependencyIndex,
  DEFAULT_FIREBASE_PROJECT_ID,
  DEFAULT_FIRESTORE_DATABASE_ID,
  generateUUID,
  getCanonicalOutboxOperationId,
  getOutboxQueue,
  getTrustedActorSessionState,
  isValidFirebaseActorUid,
  markOutboxOperationBlocked,
  markOutboxOperationDeadLetter,
  markOutboxOperationRetry,
  markOutboxOperationSynced,
  normalizeFirestoreDatabaseId,
  sealInternalRemoteWriteCompletionEvidence,
  type OutboxEntityType,
  type OutboxEntry,
  type RemoteWriteEvidenceKind,
  type ServerDocVerificationResult,
  type TrustedActorSessionState,
  type VerificationTargetSpec,
} from './pharmacyDb';
import {
  getFirebaseServices,
  isBrowserOffline,
  normalizeFirebaseErrorCode,
  resolveFirebaseConfig,
} from './firebaseClient';
import {
  isOutboxV2WorkerEnabled,
  registerOutboxV2CoordinatorHooks,
} from './outboxFeatureFlags';
import {
  isValidFirestoreDocumentId,
  normalizeOutboxEntryForFirestore,
  resolveOutboxDependencyRefs,
  type FirestoreTimestampFactory,
} from './outboxFirestoreNormalizer';
import {
  clearMatchingV1SyncRetry,
  isV1EntitySyncInFlight,
} from './branchSyncService';

export const DEFAULT_OUTBOX_V2_SUPPORTED_ENTITY_TYPES: ReadonlySet<OutboxEntityType> = new Set([
  'medicine',
  'sale',
  'inventory_ledger',
  'stocktaking_session',
  'stocktaking_session_item',
]);

export const DEFERRED_OUTBOX_V2_ENTITY_TYPES: ReadonlySet<OutboxEntityType> = new Set([
  'receipt',
  'category_metadata',
  'supplier',
  'purchase_invoice',
  'supplier_transaction',
]);

export const DEFAULT_MAX_OUTBOX_V2_ATTEMPTS = 5;

export interface OutboxFirestoreTransport {
  projectId: string;
  firestoreDatabaseId: string;
  timestampFactory?: FirestoreTimestampFactory;
  getDocFromServer: (documentPath: string) => Promise<{
    exists: boolean;
    data: Record<string, unknown> | null;
    offline?: boolean;
    errorCode?: string;
  }>;
  setDoc: (documentPath: string, data: Record<string, unknown>) => Promise<void>;
  updateDoc: (documentPath: string, data: Record<string, unknown>) => Promise<void>;
  deleteDoc?: (documentPath: string) => Promise<void>;
}

export interface RunOutboxV2SyncOptions {
  reason?: string;
  db?: IDBDatabase;
  transport?: OutboxFirestoreTransport;
  sessionOverride?: TrustedActorSessionState | null;
  getCurrentSessionFn?: () => TrustedActorSessionState | null;
  isOfflineFn?: () => boolean;
  nowMs?: number;
  leaseOwner?: string;
  leaseDurationMs?: number;
  maxAttempts?: number;
  supportedEntityTypes?: ReadonlySet<OutboxEntityType>;
  clearV1RetryFn?: (
    kind: 'medicine' | 'sale' | 'archive_medicine',
    originUid: string,
    branchId: string,
    entityId: string
  ) => void;
  isV1InFlightFn?: (
    originUid: string,
    branchId: string,
    entityType: 'medicine' | 'sale',
    entityId: string
  ) => boolean;
}

export interface OutboxV2ItemOutcome {
  outboxId: string;
  operationId: string;
  entityType: OutboxEntityType;
  entityId: string;
  branchId?: string;
  outcome:
    | 'synced'
    | 'synced_idempotent_server'
    | 'retried'
    | 'blocked'
    | 'dead_lettered'
    | 'skipped'
    | 'deferred';
  reason?: string;
  evidenceKind?: RemoteWriteEvidenceKind;
  v1CleanupWarning?: string;
}

export interface OutboxV2CycleResult {
  status:
    | 'disabled'
    | 'skipped_unauthenticated'
    | 'skipped_offline'
    | 'idle'
    | 'completed'
    | 'aborted_session_changed';
  reason?: string;
  processed: number;
  synced: number;
  retried: number;
  blocked: number;
  deadLettered: number;
  skipped: number;
  deferred: number;
  results: OutboxV2ItemOutcome[];
}

const inFlightWorkerCycles = new Map<string, Promise<OutboxV2CycleResult>>();
const customTransportIds = new WeakMap<OutboxFirestoreTransport, number>();
let nextCustomTransportId = 1;

function getTransportFlightTag(transport: OutboxFirestoreTransport, isCustom: boolean): string {
  if (!isCustom) return 'default';
  let id = customTransportIds.get(transport);
  if (!id) {
    id = nextCustomTransportId++;
    customTransportIds.set(transport, id);
  }
  return `custom-${id}`;
}

const TRANSIENT_FIRESTORE_ERROR_CODES = new Set([
  'unavailable',
  'deadline-exceeded',
  'aborted',
  'resource-exhausted',
  'internal',
  'cancelled',
  'unknown',
]);

function isNetworkOrTransientError(error: unknown): {
  transient: boolean;
  retryAuth?: boolean;
  code: string;
  message: string;
} {
  const code = normalizeFirebaseErrorCode(error) || 'unknown';
  const message = error instanceof Error ? error.message : String(error || 'Unknown Firestore sync error');
  const lowerMsg = message.toLowerCase();

  if (code === 'unauthenticated') {
    return { transient: true, retryAuth: true, code, message };
  }
  if (
    TRANSIENT_FIRESTORE_ERROR_CODES.has(code) ||
    lowerMsg.includes('offline') ||
    lowerMsg.includes('network') ||
    lowerMsg.includes('timed out') ||
    lowerMsg.includes('failed to fetch')
  ) {
    return { transient: true, code, message };
  }
  return { transient: false, code, message };
}

function splitDocSegments(documentPath: string): string[] {
  const parts = documentPath.split('/').filter((s) => s.length > 0);
  if (parts.length < 2 || parts.length % 2 !== 0) {
    throw new Error(`INVALID_DOCUMENT_PATH: "${documentPath}" must contain even collection/doc segments`);
  }
  return parts;
}

export function createFirebaseOutboxTransport(): OutboxFirestoreTransport {
  const config = resolveFirebaseConfig();
  const projectId = config.projectId || DEFAULT_FIREBASE_PROJECT_ID;
  const firestoreDatabaseId = normalizeFirestoreDatabaseId(
    config.firestoreDatabaseId || DEFAULT_FIRESTORE_DATABASE_ID
  );

  return {
    projectId,
    firestoreDatabaseId,
    timestampFactory: {
      serverTimestamp: () => firestoreServerTimestamp(),
      fromIsoDate: (iso: string) => Timestamp.fromDate(new Date(iso)),
    },
    async getDocFromServer(documentPath: string) {
      const { db } = getFirebaseServices();
      const [first, ...rest] = splitDocSegments(documentPath);
      const ref = doc(db, first, ...rest);
      try {
        const snap = await firestoreGetDocFromServer(ref);
        return {
          exists: snap.exists(),
          data: snap.exists() ? (snap.data() as Record<string, unknown>) : null,
        };
      } catch (err) {
        const info = isNetworkOrTransientError(err);
        if (info.transient) {
          return {
            exists: false,
            data: null,
            offline: true,
            errorCode: info.code,
          };
        }
        throw err;
      }
    },
    async setDoc(documentPath: string, data: Record<string, unknown>) {
      const { db } = getFirebaseServices();
      const [first, ...rest] = splitDocSegments(documentPath);
      const ref = doc(db, first, ...rest);
      await firestoreSetDoc(ref, data);
    },
    async updateDoc(documentPath: string, data: Record<string, unknown>) {
      const { db } = getFirebaseServices();
      const [first, ...rest] = splitDocSegments(documentPath);
      const ref = doc(db, first, ...rest);
      await firestoreUpdateDoc(ref, data);
    },
    async deleteDoc(documentPath: string) {
      const { db } = getFirebaseServices();
      const [first, ...rest] = splitDocSegments(documentPath);
      const ref = doc(db, first, ...rest);
      await firestoreDeleteDoc(ref);
    },
  };
}

function isBranchAuthorizedForSession(session: TrustedActorSessionState, branchId: string): boolean {
  if (!isValidFirestoreDocumentId(branchId)) return false;
  if (session.role === 'super_admin') return true;
  return Array.isArray(session.branchIds) && session.branchIds.includes(branchId);
}

function isRoleAuthorizedForOutboxEntry(
  session: TrustedActorSessionState,
  entry: OutboxEntry
): boolean {
  if (session.role === 'super_admin' || session.role === 'admin') {
    if (entry.action === 'DELETE') {
      return entry.entityType === 'stocktaking_session_item';
    }
    return true;
  }
  if (session.role === 'cashier') {
    if (entry.entityType === 'sale' && entry.action === 'CREATE') {
      return true;
    }
    if (
      entry.entityType === 'inventory_ledger' &&
      entry.action === 'CREATE' &&
      entry.payload?.type === 'SALE'
    ) {
      return true;
    }
    return false;
  }
  return false;
}

function hasValidV2OutboxMetadata(entry: OutboxEntry): boolean {
  const hasBranch = typeof entry.branchId === 'string' && isValidFirestoreDocumentId(entry.branchId.trim());
  const hasOpId = typeof entry.operationId === 'string' && entry.operationId.trim().length > 0;
  const hasIdemp = typeof entry.idempotencyKey === 'string' && entry.idempotencyKey.trim().length > 0;
  const hasSchema = typeof entry.schemaVersion === 'number' && Number.isFinite(entry.schemaVersion);
  return hasBranch && hasOpId && hasIdemp && hasSchema;
}

function topologicallySortCandidates(
  candidates: OutboxEntry[],
  allEntries: OutboxEntry[]
): OutboxEntry[] {
  const depIndex = buildOutboxDependencyIndex(allEntries);
  const candidateByOpId = new Map<string, OutboxEntry>();
  for (const e of candidates) {
    const opId = getCanonicalOutboxOperationId(e);
    if (opId) candidateByOpId.set(opId, e);
  }

  const baseSorted = [...candidates].sort((a, b) => {
    const seqA = typeof a.sequence === 'number' ? a.sequence : Number.MAX_SAFE_INTEGER;
    const seqB = typeof b.sequence === 'number' ? b.sequence : Number.MAX_SAFE_INTEGER;
    if (seqA !== seqB) return seqA - seqB;
    return Date.parse(a.timestamp || '') - Date.parse(b.timestamp || '');
  });

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: OutboxEntry[] = [];

  const visit = (entry: OutboxEntry) => {
    const opId = getCanonicalOutboxOperationId(entry) || entry.id;
    if (visited.has(opId) || visiting.has(opId)) return;
    visiting.add(opId);

    if (Array.isArray(entry.dependsOn)) {
      const depOpIds = resolveOutboxDependencyRefs(entry.dependsOn, depIndex);
      for (const depOpId of depOpIds) {
        const parentCandidate = candidateByOpId.get(depOpId);
        if (parentCandidate) {
          visit(parentCandidate);
        }
      }
    }

    visiting.delete(opId);
    visited.add(opId);
    ordered.push(entry);
  };

  for (const entry of baseSorted) {
    visit(entry);
  }
  return ordered;
}

function medicineMutableFieldsMatchServer(
  normalizedData: Record<string, unknown>,
  serverData: Record<string, unknown> | null
): boolean {
  if (!serverData) return false;
  const compareKeys = [
    'name',
    'barcode',
    'category',
    'minStock',
    'buyPrice',
    'sellPrice',
    'sellPriceStrip',
    'sellPricePill',
    'sellPack',
    'sellStrip',
    'sellPill',
    'expiry',
    'unitType',
    'stripsPerPack',
    'pillsPerStrip',
    'batchNumber',
    'archived',
  ];
  for (const k of compareKeys) {
    if (!(k in normalizedData)) continue;
    const localVal = normalizedData[k];
    const remoteVal = serverData[k];
    if (Array.isArray(localVal)) {
      if (!Array.isArray(remoteVal) || JSON.stringify(localVal) !== JSON.stringify(remoteVal)) {
        return false;
      }
    } else if (localVal !== remoteVal) {
      return false;
    }
  }
  if ('secondaryBarcodes' in normalizedData) {
    if (
      !Array.isArray(serverData.secondaryBarcodes) ||
      JSON.stringify(normalizedData.secondaryBarcodes) !== JSON.stringify(serverData.secondaryBarcodes)
    ) {
      return false;
    }
  }
  return true;
}

function buildMedicineMutablePatchFromCreate(
  createData: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...createData };
  delete patch.id;
  delete patch.branchId;
  delete patch.createdAt;
  return patch;
}

function saleMatchesServer(
  localData: Record<string, unknown>,
  remoteData: Record<string, unknown> | null
): boolean {
  if (!remoteData) return false;
  if (remoteData.id !== localData.id) return false;
  if (remoteData.branchId !== localData.branchId) return false;
  if (remoteData.cashierUid !== localData.cashierUid) return false;
  if (remoteData.invoiceNumber !== localData.invoiceNumber) return false;

  const localTotal = typeof localData.total === 'number' ? localData.total : Number.NaN;
  const remoteTotal = typeof remoteData.total === 'number' ? remoteData.total : Number.NaN;
  if (!Number.isFinite(localTotal) || !Number.isFinite(remoteTotal) || Math.abs(localTotal - remoteTotal) > 0.01) {
    return false;
  }

  const localItems = Array.isArray(localData.items) ? (localData.items as Array<Record<string, unknown>>) : null;
  const remoteItems = Array.isArray(remoteData.items) ? (remoteData.items as Array<Record<string, unknown>>) : null;
  if (!localItems || !remoteItems || localItems.length !== remoteItems.length) {
    return false;
  }
  if (typeof remoteData.itemsCount === 'number' && remoteData.itemsCount !== localItems.length) {
    return false;
  }

  for (let i = 0; i < localItems.length; i++) {
    const li = localItems[i];
    const ri = remoteItems[i];
    if (!li || !ri || typeof ri !== 'object') return false;
    if (ri.medicineId !== li.medicineId) return false;
    const lQty = typeof li.qty === 'number' ? li.qty : Number.NaN;
    const rQty = typeof ri.qty === 'number' ? ri.qty : Number.NaN;
    if (!Number.isFinite(lQty) || !Number.isFinite(rQty) || Math.abs(lQty - rQty) > 0.001) {
      return false;
    }
    const lSub = typeof li.subtotal === 'number' ? li.subtotal : Number.NaN;
    const rSub = typeof ri.subtotal === 'number' ? ri.subtotal : Number.NaN;
    if (!Number.isFinite(lSub) || !Number.isFinite(rSub) || Math.abs(lSub - rSub) > 0.02) {
      return false;
    }
    if ('unit' in ri && ri.unit !== undefined && ri.unit !== li.unit) {
      return false;
    }
  }

  return true;
}

function inventoryLedgerMatchesServer(
  localData: Record<string, unknown>,
  remoteData: Record<string, unknown> | null
): boolean {
  if (!remoteData) return false;
  if (remoteData.id !== localData.id) return false;
  if (remoteData.branchId !== localData.branchId) return false;
  if (remoteData.medicineId !== localData.medicineId) return false;
  if (remoteData.type !== localData.type) return false;
  if (remoteData.userId !== localData.userId) return false;
  if (remoteData.unit !== localData.unit) return false;

  const lDelta = typeof localData.quantityDelta === 'number' ? localData.quantityDelta : Number.NaN;
  const rDelta = typeof remoteData.quantityDelta === 'number' ? remoteData.quantityDelta : Number.NaN;
  if (!Number.isFinite(lDelta) || !Number.isFinite(rDelta) || Math.abs(lDelta - rDelta) > 0.001) {
    return false;
  }

  const lBase = typeof localData.baseUnitsDelta === 'number' ? localData.baseUnitsDelta : Number.NaN;
  const rBase = typeof remoteData.baseUnitsDelta === 'number' ? remoteData.baseUnitsDelta : Number.NaN;
  if (!Number.isFinite(lBase) || !Number.isFinite(rBase) || Math.abs(lBase - rBase) > 0.001) {
    return false;
  }

  if (typeof localData.costPerUnit === 'number' && remoteData.costPerUnit !== undefined) {
    const rCost = typeof remoteData.costPerUnit === 'number' ? remoteData.costPerUnit : Number.NaN;
    if (!Number.isFinite(rCost) || Math.abs(localData.costPerUnit - rCost) > 0.02) {
      return false;
    }
  }

  if ('referenceId' in localData) {
    if (remoteData.referenceId !== localData.referenceId) {
      return false;
    }
  } else if (remoteData.referenceId !== undefined && remoteData.referenceId !== null) {
    return false;
  }

  return true;
}

function stocktakingSessionMatchesServer(
  localData: Record<string, unknown>,
  remoteData: Record<string, unknown> | null,
  expectedSessionId: string,
  expectedBranchId: string
): boolean {
  if (!remoteData) return false;
  if (remoteData.id !== expectedSessionId || remoteData.branchId !== expectedBranchId) {
    return false;
  }
  if (remoteData.status !== localData.status || remoteData.accountingStatus !== localData.accountingStatus) {
    return false;
  }
  if (localData.sessionNumber !== undefined && remoteData.sessionNumber !== localData.sessionNumber) {
    return false;
  }
  if (localData.status === 'sync_completed_unverified') {
    if (remoteData.committedByUid !== localData.committedByUid) return false;
    const summaryNumKeys = [
      'totalItemsCount',
      'matchedItemsCount',
      'surplusItemsCount',
      'deficitItemsCount',
      'itemsWithVariance',
      'totalScanned',
      'netVarianceSDG',
    ] as const;
    for (const key of summaryNumKeys) {
      const lv = typeof localData[key] === 'number' ? (localData[key] as number) : Number.NaN;
      const rv = typeof remoteData[key] === 'number' ? (remoteData[key] as number) : Number.NaN;
      if (!Number.isFinite(lv) || !Number.isFinite(rv) || Math.abs(lv - rv) > 0.02) {
        return false;
      }
    }
    const localIds = Array.isArray(localData.adjustmentLedgerIds) ? localData.adjustmentLedgerIds : [];
    const remoteIds = Array.isArray(remoteData.adjustmentLedgerIds) ? remoteData.adjustmentLedgerIds : [];
    if (JSON.stringify(localIds) !== JSON.stringify(remoteIds)) {
      return false;
    }
  }
  return true;
}

function stocktakingItemMatchesServer(
  localData: Record<string, unknown>,
  remoteData: Record<string, unknown> | null
): boolean {
  if (!remoteData) return false;
  const compareExact = [
    'medicineName',
    'barcode',
    'batchNumber',
    'expiry',
    'unit',
    'updatedByUid',
  ] as const;
  for (const key of compareExact) {
    if (key in localData && remoteData[key] !== localData[key]) {
      return false;
    }
  }
  const compareApprox: ReadonlyArray<readonly [string, number]> = [
    ['systemStock', 0.001],
    ['actualCount', 0.001],
    ['variance', 0.01],
    ['variancePacks', 0.01],
    ['buyPrice', 0.01],
    ['sellPrice', 0.01],
    ['varianceSDG', 0.02],
    ['varianceCost', 0.02],
  ];
  for (const [key, tol] of compareApprox) {
    if (!(key in localData)) continue;
    const lv = typeof localData[key] === 'number' ? (localData[key] as number) : Number.NaN;
    const rv = typeof remoteData[key] === 'number' ? (remoteData[key] as number) : Number.NaN;
    if (!Number.isFinite(lv) || !Number.isFinite(rv) || Math.abs(lv - rv) > tol) {
      return false;
    }
  }
  if ('secondaryBarcodes' in localData) {
    if (
      !Array.isArray(remoteData.secondaryBarcodes) ||
      JSON.stringify(localData.secondaryBarcodes) !== JSON.stringify(remoteData.secondaryBarcodes)
    ) {
      return false;
    }
  }
  return true;
}

function buildStocktakingItemMutablePatchFromCreate(
  createData: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...createData };
  delete patch.id;
  delete patch.branchId;
  delete patch.sessionId;
  delete patch.medicineId;
  delete patch.createdAt;
  return patch;
}

class SessionChangedAbortError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'SessionChangedAbortError';
    this.reason = reason;
  }
}

function assertActiveSessionUnchangedForEntry(
  getCurrentSession: () => TrustedActorSessionState | null,
  isOffline: () => boolean,
  activeSession: TrustedActorSessionState,
  entry: OutboxEntry,
  entryBranchId: string
): void {
  const check = validateTrustedSessionForWorker(getCurrentSession(), isOffline);
  if (!check.ok) {
    throw new SessionChangedAbortError(check.reason);
  }
  if (check.session.uid !== activeSession.uid) {
    throw new SessionChangedAbortError('SESSION_ACTOR_CHANGED_MID_CYCLE');
  }
  if (!isBranchAuthorizedForSession(check.session, entryBranchId)) {
    throw new SessionChangedAbortError('BRANCH_AUTHORIZATION_REVOKED_MID_CYCLE');
  }
  if (!isRoleAuthorizedForOutboxEntry(check.session, entry)) {
    throw new SessionChangedAbortError('ROLE_AUTHORIZATION_REVOKED_MID_CYCLE');
  }
}

async function fetchServerVerificationsForTargets(
  targets: VerificationTargetSpec[],
  transport: OutboxFirestoreTransport,
  verifiedAtIso: string
): Promise<ServerDocVerificationResult[]> {
  const results: ServerDocVerificationResult[] = [];
  for (const target of targets) {
    const snap = await transport.getDocFromServer(target.documentPath);
    if (!snap.offline && snap.errorCode) {
      const codeInfo = isNetworkOrTransientError({ code: snap.errorCode });
      if (!codeInfo.transient) {
        throw Object.assign(
          new Error(`Parent verification permanent error (${snap.errorCode}) for ${target.documentPath}`),
          { code: snap.errorCode }
        );
      }
    }
    results.push({
      projectId: transport.projectId,
      firestoreDatabaseId: transport.firestoreDatabaseId,
      branchId: target.branchId,
      entityType: target.entityType,
      entityId: target.entityId,
      documentPath: target.documentPath,
      verifiedAt: verifiedAtIso,
      source: 'firestore_getDocFromServer',
      exists: snap.exists,
      ...(snap.offline ? { offline: true } : {}),
      ...(snap.errorCode ? { errorCode: snap.errorCode } : {}),
      docData: snap.data,
    });
  }
  return results;
}

function validateTrustedSessionForWorker(
  session: TrustedActorSessionState | null,
  isOfflineFn: () => boolean
): { ok: true; session: TrustedActorSessionState } | { ok: false; status: 'skipped_unauthenticated' | 'skipped_offline'; reason: string } {
  if (!session) {
    return {
      ok: false,
      status: 'skipped_unauthenticated',
      reason: 'NO_TRUSTED_FIREBASE_SESSION',
    };
  }
  if (!isValidFirebaseActorUid(session.uid) || !isValidFirestoreDocumentId(session.uid)) {
    return {
      ok: false,
      status: 'skipped_unauthenticated',
      reason: 'INVALID_RUNTIME_ACTOR_UID',
    };
  }
  if (session.emailVerified !== true) {
    return {
      ok: false,
      status: 'skipped_unauthenticated',
      reason: 'EMAIL_NOT_VERIFIED',
    };
  }
  if (session.offlineFallback === true) {
    return {
      ok: false,
      status: 'skipped_offline',
      reason: 'OFFLINE_FALLBACK_SESSION_READ_ONLY',
    };
  }
  if (isOfflineFn()) {
    return {
      ok: false,
      status: 'skipped_offline',
      reason: 'BROWSER_OFFLINE',
    };
  }
  return { ok: true, session };
}

/**
 * Executes a single bounded Outbox V2 sync cycle when enabled via feature flag.
 * Strictly returns `{ status: 'disabled' }` with zero IndexedDB/network side effects when flag is OFF.
 */
export async function runOutboxV2SyncCycle(
  options: RunOutboxV2SyncOptions = {}
): Promise<OutboxV2CycleResult> {
  if (!isOutboxV2WorkerEnabled()) {
    return {
      status: 'disabled',
      reason: 'OUTBOX_V2_WORKER_DISABLED',
      processed: 0,
      synced: 0,
      retried: 0,
      blocked: 0,
      deadLettered: 0,
      skipped: 0,
      deferred: 0,
      results: [],
    };
  }

  const getCurrentSession =
    options.getCurrentSessionFn ??
    (() => (options.sessionOverride !== undefined ? options.sessionOverride : getTrustedActorSessionState()));
  const isOffline = options.isOfflineFn ?? isBrowserOffline;

  const initialSessionCheck = validateTrustedSessionForWorker(getCurrentSession(), isOffline);
  if (!initialSessionCheck.ok) {
    return {
      status: initialSessionCheck.status,
      reason: initialSessionCheck.reason,
      processed: 0,
      synced: 0,
      retried: 0,
      blocked: 0,
      deadLettered: 0,
      skipped: 0,
      deferred: 0,
      results: [],
    };
  }

  const activeSession = initialSessionCheck.session;
  const transport = options.transport ?? createFirebaseOutboxTransport();
  const transportTag = getTransportFlightTag(transport, Boolean(options.transport));
  const singleFlightKey = `${activeSession.uid}:${transport.projectId}:${transport.firestoreDatabaseId}:${transportTag}`;

  const existingFlight = inFlightWorkerCycles.get(singleFlightKey);
  if (existingFlight) {
    return existingFlight;
  }

  const executeCycle = async (): Promise<OutboxV2CycleResult> => {
    const supportedTypes = options.supportedEntityTypes ?? DEFAULT_OUTBOX_V2_SUPPORTED_ENTITY_TYPES;
    const clearV1Retry = options.clearV1RetryFn ?? clearMatchingV1SyncRetry;
    const checkV1InFlight = options.isV1InFlightFn ?? isV1EntitySyncInFlight;
    const maxAttemptsDefault =
      typeof options.maxAttempts === 'number' && options.maxAttempts >= 1
        ? options.maxAttempts
        : DEFAULT_MAX_OUTBOX_V2_ATTEMPTS;
    const now = () =>
      typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
        ? options.nowMs
        : Date.now();
    const leaseOwnerBase =
      typeof options.leaseOwner === 'string' && options.leaseOwner.trim().length > 0
        ? options.leaseOwner.trim()
        : `v2-worker-${activeSession.uid}-${generateUUID().slice(0, 8)}`;

    const allEntries = await getOutboxQueueForWorker(options.db);
    if (allEntries.length === 0) {
      return {
        status: 'idle',
        processed: 0,
        synced: 0,
        retried: 0,
        blocked: 0,
        deadLettered: 0,
        skipped: 0,
        deferred: 0,
        results: [],
      };
    }

    const candidates: OutboxEntry[] = [];
    const results: OutboxV2ItemOutcome[] = [];
    let skipped = 0;
    let deferred = 0;

    for (const rawEntry of allEntries) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const opId = getCanonicalOutboxOperationId(rawEntry) || rawEntry.id;

      // Preserve completed, blocked, and dead-letter entries untouched
      if (rawEntry.status === 'synced' || rawEntry.status === 'blocked' || rawEntry.status === 'dead-letter') {
        continue;
      }

      // Receipts (Bankak) are permanently deferred until schema harmonization, regardless of custom supportedEntityTypes
      if (rawEntry.entityType === 'receipt') {
        deferred += 1;
        results.push({
          outboxId: rawEntry.id,
          operationId: opId,
          entityType: rawEntry.entityType,
          entityId: rawEntry.entityId,
          branchId: rawEntry.branchId,
          outcome: 'deferred',
          reason: 'DEFERRED_TO_BANKAK_SCHEMA_HARMONIZATION',
        });
        continue;
      }

      // Preserve deferred scope (stocktaking, categories, supplier accounting) untouched until 3B-2b.3/3B-2b.4
      if (!supportedTypes.has(rawEntry.entityType)) {
        deferred += 1;
        results.push({
          outboxId: rawEntry.id,
          operationId: opId,
          entityType: rawEntry.entityType,
          entityId: rawEntry.entityId,
          branchId: rawEntry.branchId,
          outcome: 'deferred',
          reason: 'DEFERRED_TO_3B2B3_OR_3B2B4',
        });
        continue;
      }

      // Preserve legacy entries missing actorUid or V2 metadata untouched (Rule #7)
      if (!isValidFirebaseActorUid(rawEntry.actorUid)) {
        skipped += 1;
        results.push({
          outboxId: rawEntry.id,
          operationId: opId,
          entityType: rawEntry.entityType,
          entityId: rawEntry.entityId,
          branchId: rawEntry.branchId,
          outcome: 'skipped',
          reason: 'MISSING_ACTOR_UID_PRESERVED',
        });
        continue;
      }

      // Strict Actor Attribution Guard (Rule #6)
      if (rawEntry.actorUid !== activeSession.uid) {
        skipped += 1;
        results.push({
          outboxId: rawEntry.id,
          operationId: opId,
          entityType: rawEntry.entityType,
          entityId: rawEntry.entityId,
          branchId: rawEntry.branchId,
          outcome: 'skipped',
          reason: 'ACTOR_UID_MISMATCH_PRESERVED',
        });
        continue;
      }

      if (!hasValidV2OutboxMetadata(rawEntry)) {
        skipped += 1;
        results.push({
          outboxId: rawEntry.id,
          operationId: opId,
          entityType: rawEntry.entityType,
          entityId: rawEntry.entityId,
          branchId: rawEntry.branchId,
          outcome: 'skipped',
          reason: 'LEGACY_REVALIDATION_REQUIRED_PRESERVED',
        });
        continue;
      }

      const entryBranchId = rawEntry.branchId!.trim();
      if (!isBranchAuthorizedForSession(activeSession, entryBranchId)) {
        skipped += 1;
        results.push({
          outboxId: rawEntry.id,
          operationId: opId,
          entityType: rawEntry.entityType,
          entityId: rawEntry.entityId,
          branchId: entryBranchId,
          outcome: 'skipped',
          reason: 'BRANCH_UNAUTHORIZED_PRESERVED',
        });
        continue;
      }

      if (!isRoleAuthorizedForOutboxEntry(activeSession, rawEntry)) {
        skipped += 1;
        results.push({
          outboxId: rawEntry.id,
          operationId: opId,
          entityType: rawEntry.entityType,
          entityId: rawEntry.entityId,
          branchId: entryBranchId,
          outcome: 'skipped',
          reason: 'ROLE_UNAUTHORIZED_PRESERVED',
        });
        continue;
      }

      candidates.push(rawEntry);
    }

    const orderedCandidates = topologicallySortCandidates(candidates, allEntries);
    let processed = 0;
    let synced = 0;
    let retried = 0;
    let blocked = 0;
    let deadLettered = 0;

    for (const candidate of orderedCandidates) {
      const entryBranchId = candidate.branchId!.trim();
      // Re-verify active session, branch authorization, and role before every operation
      try {
        assertActiveSessionUnchangedForEntry(getCurrentSession, isOffline, activeSession, candidate, entryBranchId);
      } catch (sessionErr) {
        if (sessionErr instanceof SessionChangedAbortError) {
          return {
            status: 'aborted_session_changed',
            reason: sessionErr.reason,
            processed,
            synced,
            retried,
            blocked,
            deadLettered,
            skipped,
            deferred,
            results,
          };
        }
        throw sessionErr;
      }

      const opId = getCanonicalOutboxOperationId(candidate) || candidate.id;
      const leaseOwner = `${leaseOwnerBase}`;

      // Avoid competing simultaneously with an active V1 sync on the exact same sale/medicine
      if (
        (candidate.entityType === 'sale' || candidate.entityType === 'medicine') &&
        checkV1InFlight(activeSession.uid, entryBranchId, candidate.entityType, candidate.entityId)
      ) {
        skipped += 1;
        results.push({
          outboxId: candidate.id,
          operationId: opId,
          entityType: candidate.entityType,
          entityId: candidate.entityId,
          branchId: entryBranchId,
          outcome: 'skipped',
          reason: 'V1_SYNC_IN_FLIGHT',
        });
        continue;
      }

      // Step 1: Acquire lease (and perform fresh getDocFromServer parent proof if requested)
      let lease = await acquireOutboxLease({
        outboxId: candidate.id,
        leaseOwner,
        leaseDurationMs: options.leaseDurationMs,
        nowMs: now(),
        expectedBranchId: entryBranchId,
        expectedProjectId: transport.projectId,
        expectedFirestoreDatabaseId: transport.firestoreDatabaseId,
        db: options.db,
      });

      if (
        !lease.acquired &&
        (lease.reason === 'SERVER_VERIFICATION_REQUIRED' ||
          lease.reason === 'REMOTE_PARENT_EXISTENCE_UNPROVEN') &&
        lease.verificationTargets &&
        lease.verificationTargets.length > 0
      ) {
        try {
          const svResults = await fetchServerVerificationsForTargets(
            lease.verificationTargets,
            transport,
            new Date(now()).toISOString()
          );

          // Re-verify actor session after awaiting network check
          try {
            assertActiveSessionUnchangedForEntry(getCurrentSession, isOffline, activeSession, candidate, entryBranchId);
          } catch (sessionErr) {
            if (sessionErr instanceof SessionChangedAbortError) {
              return {
                status: 'aborted_session_changed',
                reason: sessionErr.reason,
                processed,
                synced,
                retried,
                blocked,
                deadLettered,
                skipped,
                deferred,
                results,
              };
            }
            throw sessionErr;
          }

          lease = await acquireOutboxLease({
            outboxId: candidate.id,
            leaseOwner,
            leaseDurationMs: options.leaseDurationMs,
            nowMs: now(),
            expectedBranchId: entryBranchId,
            expectedProjectId: transport.projectId,
            expectedFirestoreDatabaseId: transport.firestoreDatabaseId,
            serverVerificationResults: svResults,
            db: options.db,
          });
        } catch (err) {
          const errInfo = isNetworkOrTransientError(err);
          if (errInfo.transient) {
            skipped += 1;
            results.push({
              outboxId: candidate.id,
              operationId: opId,
              entityType: candidate.entityType,
              entityId: candidate.entityId,
              branchId: entryBranchId,
              outcome: 'skipped',
              reason: `PARENT_VERIFICATION_ERROR:${errInfo.code}`,
            });
            continue;
          }
          const blockReason = `PARENT_VERIFICATION_${errInfo.code.toUpperCase().replace(/-/g, '_')}`;
          await markOutboxOperationBlocked({
            outboxId: candidate.id,
            blockReason,
            errorCode: errInfo.code,
            errorMessage: errInfo.message.slice(0, 400),
            db: options.db,
          });
          blocked += 1;
          results.push({
            outboxId: candidate.id,
            operationId: opId,
            entityType: candidate.entityType,
            entityId: candidate.entityId,
            branchId: entryBranchId,
            outcome: 'blocked',
            reason: blockReason,
          });
          continue;
        }
      }

      if (!lease.acquired || !lease.entry) {
        if (lease.entry?.status === 'blocked') {
          blocked += 1;
          results.push({
            outboxId: candidate.id,
            operationId: opId,
            entityType: candidate.entityType,
            entityId: candidate.entityId,
            branchId: entryBranchId,
            outcome: 'blocked',
            reason: lease.reason || 'BLOCKED',
          });
        } else {
          skipped += 1;
          results.push({
            outboxId: candidate.id,
            operationId: opId,
            entityType: candidate.entityType,
            entityId: candidate.entityId,
            branchId: entryBranchId,
            outcome: 'skipped',
            reason: lease.reason || 'LEASE_NOT_ACQUIRED',
          });
        }
        continue;
      }

      const leasedEntry = lease.entry;
      processed += 1;

      // Double-check actorUid attribution invariant on leased entry before normalization or remote calls
      if (leasedEntry.actorUid !== activeSession.uid) {
        await markOutboxOperationRetry({
          outboxId: leasedEntry.id,
          errorCode: 'ACTOR_UID_MISMATCH',
          errorMessage: 'Aborted leased operation because actorUid does not match current session.',
          retryDelayMs: 0,
          expectedLeaseOwner: leaseOwner,
          nowMs: now(),
          db: options.db,
        });
        skipped += 1;
        results.push({
          outboxId: leasedEntry.id,
          operationId: opId,
          entityType: leasedEntry.entityType,
          entityId: leasedEntry.entityId,
          branchId: entryBranchId,
          outcome: 'skipped',
          reason: 'ACTOR_UID_MISMATCH_PRESERVED',
        });
        continue;
      }

      const latestEntries = await getOutboxQueueForWorker(options.db);
      try {
        assertActiveSessionUnchangedForEntry(getCurrentSession, isOffline, activeSession, leasedEntry, entryBranchId);
      } catch (sessionErr) {
        if (sessionErr instanceof SessionChangedAbortError) {
          await markOutboxOperationRetry({
            outboxId: leasedEntry.id,
            errorCode: 'SESSION_ACTOR_CHANGED',
            errorMessage: `Aborted before normalization: ${sessionErr.reason}`,
            retryDelayMs: 0,
            expectedLeaseOwner: leaseOwner,
            nowMs: now(),
            db: options.db,
          });
          return {
            status: 'aborted_session_changed',
            reason: sessionErr.reason,
            processed,
            synced,
            retried,
            blocked,
            deadLettered,
            skipped,
            deferred,
            results,
          };
        }
        throw sessionErr;
      }

      const norm = normalizeOutboxEntryForFirestore(leasedEntry, {
        actorUid: activeSession.uid,
        branchId: entryBranchId,
        allOutboxEntries: latestEntries,
        timestampFactory: transport.timestampFactory,
      });

      if (!norm.ok) {
        await markOutboxOperationBlocked({
          outboxId: leasedEntry.id,
          blockReason: norm.code,
          errorCode: norm.code,
          errorMessage: norm.message,
          expectedLeaseOwner: leaseOwner,
          db: options.db,
        });
        blocked += 1;
        results.push({
          outboxId: leasedEntry.id,
          operationId: opId,
          entityType: leasedEntry.entityType,
          entityId: leasedEntry.entityId,
          branchId: entryBranchId,
          outcome: 'blocked',
          reason: norm.code,
        });
        continue;
      }

      try {
        let evidenceKind: RemoteWriteEvidenceKind = 'firestore_doc_write';
        let skippedWriteBecauseServerHasDoc = false;

        // Authoritative Server Pre-Write Verification, Conflict Detection & Idempotent Recovery
        if (
          leasedEntry.entityType === 'sale' ||
          leasedEntry.entityType === 'medicine' ||
          leasedEntry.entityType === 'inventory_ledger' ||
          leasedEntry.entityType === 'stocktaking_session' ||
          leasedEntry.entityType === 'stocktaking_session_item'
        ) {
          const existingSnap = await transport.getDocFromServer(norm.documentPath);
          if (existingSnap.offline) {
            throw new Error(`unavailable: offline checking ${norm.documentPath}`);
          }

          if (leasedEntry.action === 'CREATE' && existingSnap.exists) {
            if (leasedEntry.entityType === 'sale') {
              if (saleMatchesServer(norm.data, existingSnap.data)) {
                evidenceKind = 'firestore_server_get';
                skippedWriteBecauseServerHasDoc = true;
              } else {
                throw Object.assign(
                  new Error(`REMOTE_CONFLICT_MISMATCH: Remote sale mismatch on existing ${norm.documentPath}`),
                  { code: 'failed-precondition' }
                );
              }
            } else if (leasedEntry.entityType === 'inventory_ledger') {
              if (inventoryLedgerMatchesServer(norm.data, existingSnap.data)) {
                evidenceKind = 'firestore_server_get';
                skippedWriteBecauseServerHasDoc = true;
              } else {
                throw Object.assign(
                  new Error(`REMOTE_CONFLICT_MISMATCH: Remote ledger mismatch on existing ${norm.documentPath}`),
                  { code: 'failed-precondition' }
                );
              }
            } else if (leasedEntry.entityType === 'medicine') {
              const sData = existingSnap.data;
              if (!sData || sData.id !== leasedEntry.entityId || sData.branchId !== entryBranchId) {
                throw Object.assign(
                  new Error(`REMOTE_CONFLICT_MISMATCH: Remote medicine identity mismatch on existing ${norm.documentPath}`),
                  { code: 'failed-precondition' }
                );
              }
              if (sData.archived === true) {
                throw Object.assign(
                  new Error(`COMMERCIAL_TARGET_ARCHIVED: Remote medicine ${norm.documentPath} is archived`),
                  { code: 'failed-precondition' }
                );
              }
              if (medicineMutableFieldsMatchServer(norm.data, sData)) {
                evidenceKind = 'firestore_server_get';
                skippedWriteBecauseServerHasDoc = true;
              } else {
                // Coalesced or newer update over V1-created medicine doc: use rule-safe updateDoc
                const patch = buildMedicineMutablePatchFromCreate(norm.data);
                assertActiveSessionUnchangedForEntry(
                  getCurrentSession,
                  isOffline,
                  activeSession,
                  leasedEntry,
                  entryBranchId
                );
                await transport.updateDoc(norm.documentPath, patch);
                evidenceKind = 'firestore_doc_write';
                skippedWriteBecauseServerHasDoc = true;
              }
            } else if (leasedEntry.entityType === 'stocktaking_session') {
              if (
                stocktakingSessionMatchesServer(
                  norm.data,
                  existingSnap.data,
                  leasedEntry.entityId,
                  entryBranchId
                )
              ) {
                evidenceKind = 'firestore_server_get';
                skippedWriteBecauseServerHasDoc = true;
              } else {
                throw Object.assign(
                  new Error(`REMOTE_CONFLICT_MISMATCH: Remote stocktaking_session mismatch on existing ${norm.documentPath}`),
                  { code: 'failed-precondition' }
                );
              }
            } else if (leasedEntry.entityType === 'stocktaking_session_item') {
              const sData = existingSnap.data;
              if (
                !sData ||
                sData.id !== leasedEntry.entityId ||
                sData.branchId !== entryBranchId ||
                sData.sessionId !== norm.data.sessionId ||
                sData.medicineId !== norm.data.medicineId
              ) {
                throw Object.assign(
                  new Error(`REMOTE_CONFLICT_MISMATCH: Remote stocktaking item identity mismatch on ${norm.documentPath}`),
                  { code: 'failed-precondition' }
                );
              }
              if (stocktakingItemMatchesServer(norm.data, sData)) {
                evidenceKind = 'firestore_server_get';
                skippedWriteBecauseServerHasDoc = true;
              } else {
                const patch = buildStocktakingItemMutablePatchFromCreate(norm.data);
                assertActiveSessionUnchangedForEntry(
                  getCurrentSession,
                  isOffline,
                  activeSession,
                  leasedEntry,
                  entryBranchId
                );
                await transport.updateDoc(norm.documentPath, patch);
                evidenceKind = 'firestore_doc_write';
                skippedWriteBecauseServerHasDoc = true;
              }
            }
          } else if (leasedEntry.action === 'UPDATE') {
            if (!existingSnap.exists) {
              throw Object.assign(
                new Error(`not-found: Target document ${norm.documentPath} missing on Firestore server`),
                { code: 'not-found' }
              );
            }
            if (leasedEntry.entityType === 'medicine' && existingSnap.data?.archived === true) {
              throw Object.assign(
                new Error(`COMMERCIAL_TARGET_ARCHIVED: Cannot update archived document ${norm.documentPath}`),
                { code: 'failed-precondition' }
              );
            }
            if (leasedEntry.entityType === 'stocktaking_session') {
              const sData = existingSnap.data;
              if (
                stocktakingSessionMatchesServer(
                  norm.data,
                  sData,
                  leasedEntry.entityId,
                  entryBranchId
                )
              ) {
                // Idempotent recovery: Stage 2A lock / Stage 3 completion / Cancel already committed on server
                evidenceKind = 'firestore_server_get';
                skippedWriteBecauseServerHasDoc = true;
              } else {
                const remoteStatus = typeof sData?.status === 'string' ? sData.status : '';
                const remoteAccounting = typeof sData?.accountingStatus === 'string' ? sData.accountingStatus : 'open';
                const isRemoteTerminal =
                  remoteStatus === 'sync_completed_unverified' ||
                  remoteStatus === 'committed' ||
                  remoteStatus === 'COMMITTED' ||
                  remoteStatus === 'cancelled' ||
                  remoteStatus === 'CANCELLED' ||
                  remoteAccounting !== 'open';
                if (isRemoteTerminal) {
                  throw Object.assign(
                    new Error(`REMOTE_CONFLICT_MISMATCH: Server stocktaking_session ${norm.documentPath} is in incompatible terminal state "${remoteStatus}/${remoteAccounting}"`),
                    { code: 'failed-precondition' }
                  );
                }
              }
            } else if (leasedEntry.entityType === 'stocktaking_session_item') {
              const sData = existingSnap.data;
              if (
                !sData ||
                sData.id !== leasedEntry.entityId ||
                sData.branchId !== entryBranchId
              ) {
                throw Object.assign(
                  new Error(`REMOTE_CONFLICT_MISMATCH: Remote stocktaking item identity mismatch on ${norm.documentPath}`),
                  { code: 'failed-precondition' }
                );
              }
              if (stocktakingItemMatchesServer(norm.data, sData)) {
                evidenceKind = 'firestore_server_get';
                skippedWriteBecauseServerHasDoc = true;
              }
            }
          } else if (leasedEntry.action === 'DELETE') {
            if (!existingSnap.exists) {
              // Idempotent server delete recovery: already deleted on server
              evidenceKind = 'firestore_server_get';
              skippedWriteBecauseServerHasDoc = true;
            } else if (leasedEntry.entityType === 'stocktaking_session_item') {
              const sData = existingSnap.data;
              if (!sData || sData.branchId !== entryBranchId || sData.sessionId !== norm.data.sessionId) {
                throw Object.assign(
                  new Error(`REMOTE_CONFLICT_MISMATCH: Remote stocktaking item delete target mismatch on ${norm.documentPath}`),
                  { code: 'failed-precondition' }
                );
              }
            }
          }
        }

        if (!skippedWriteBecauseServerHasDoc) {
          // Final actor session check immediately prior to Firestore write
          assertActiveSessionUnchangedForEntry(
            getCurrentSession,
            isOffline,
            activeSession,
            leasedEntry,
            entryBranchId
          );

          if (norm.op === 'set') {
            await transport.setDoc(norm.documentPath, norm.data);
          } else if (norm.op === 'delete') {
            if (!transport.deleteDoc) {
              throw Object.assign(
                new Error(`OUTBOX_TRANSPORT_DELETE_UNSUPPORTED: deleteDoc is required for ${norm.documentPath}`),
                { code: 'failed-precondition' }
              );
            }
            await transport.deleteDoc(norm.documentPath);
          } else {
            await transport.updateDoc(norm.documentPath, norm.data);
          }
          evidenceKind = 'firestore_doc_write';
        }

        const attemptId = generateUUID();
        const completedAtIso = new Date(now()).toISOString();
        const evidence = sealInternalRemoteWriteCompletionEvidence({
          evidenceKind,
          projectId: transport.projectId,
          firestoreDatabaseId: transport.firestoreDatabaseId,
          branchId: entryBranchId,
          entityType: leasedEntry.entityType,
          entityId: leasedEntry.entityId,
          documentPath: norm.documentPath,
          completedAt: completedAtIso,
          actorUid: activeSession.uid,
          clientAttemptId: attemptId,
        });

        const markSyncedRes = await markOutboxOperationSynced({
          outboxId: leasedEntry.id,
          ackedAt: completedAtIso,
          nowMs: now(),
          expectedLeaseOwner: leaseOwner,
          remoteWriteEvidence: evidence,
          expectedProjectId: transport.projectId,
          expectedFirestoreDatabaseId: transport.firestoreDatabaseId,
          db: options.db,
        });

        if (!markSyncedRes.updated) {
          await markOutboxOperationRetry({
            outboxId: leasedEntry.id,
            errorCode: markSyncedRes.reason || 'MARK_SYNCED_FAILED',
            errorMessage: `Unable to mark outbox synced (${markSyncedRes.reason || 'unknown'})`,
            expectedLeaseOwner: leaseOwner,
            nowMs: now(),
            db: options.db,
          });
          retried += 1;
          results.push({
            outboxId: leasedEntry.id,
            operationId: opId,
            entityType: leasedEntry.entityType,
            entityId: leasedEntry.entityId,
            branchId: entryBranchId,
            outcome: 'retried',
            reason: markSyncedRes.reason || 'MARK_SYNCED_FAILED',
          });
          continue;
        }

        // Remove only the exact matching V1 retry queue item in an isolated try/catch so cleanup errors never revert sync
        let v1CleanupWarning: string | undefined;
        try {
          if (leasedEntry.entityType === 'sale') {
            clearV1Retry('sale', activeSession.uid, entryBranchId, leasedEntry.entityId);
          } else if (leasedEntry.entityType === 'medicine') {
            clearV1Retry('medicine', activeSession.uid, entryBranchId, leasedEntry.entityId);
            clearV1Retry('archive_medicine', activeSession.uid, entryBranchId, leasedEntry.entityId);
          }
        } catch (cleanupErr) {
          v1CleanupWarning = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        }

        synced += 1;
        results.push({
          outboxId: leasedEntry.id,
          operationId: opId,
          entityType: leasedEntry.entityType,
          entityId: leasedEntry.entityId,
          branchId: entryBranchId,
          outcome: evidenceKind === 'firestore_server_get' ? 'synced_idempotent_server' : 'synced',
          evidenceKind,
          ...(v1CleanupWarning ? { v1CleanupWarning } : {}),
        });
      } catch (err) {
        if (err instanceof SessionChangedAbortError) {
          await markOutboxOperationRetry({
            outboxId: leasedEntry.id,
            errorCode: 'SESSION_ACTOR_CHANGED',
            errorMessage: `Aborted before remote write: ${err.reason}`,
            retryDelayMs: 0,
            expectedLeaseOwner: leaseOwner,
            nowMs: now(),
            db: options.db,
          });
          return {
            status: 'aborted_session_changed',
            reason: err.reason,
            processed,
            synced,
            retried,
            blocked,
            deadLettered,
            skipped,
            deferred,
            results,
          };
        }

        const errInfo = isNetworkOrTransientError(err);
        if (errInfo.transient) {
          const nextAttempt = (leasedEntry.attempts || 0) + 1;
          const limitAttempts =
            typeof leasedEntry.maxAttempts === 'number' && leasedEntry.maxAttempts >= 1
              ? leasedEntry.maxAttempts
              : maxAttemptsDefault;

          if (!errInfo.retryAuth && nextAttempt >= limitAttempts) {
            await markOutboxOperationDeadLetter({
              outboxId: leasedEntry.id,
              errorCode: errInfo.code,
              errorMessage: errInfo.message.slice(0, 400),
              blockReason: 'MAX_RETRY_ATTEMPTS_EXCEEDED',
              expectedLeaseOwner: leaseOwner,
              nowMs: now(),
              db: options.db,
            });
            deadLettered += 1;
            results.push({
              outboxId: leasedEntry.id,
              operationId: opId,
              entityType: leasedEntry.entityType,
              entityId: leasedEntry.entityId,
              branchId: entryBranchId,
              outcome: 'dead_lettered',
              reason: errInfo.code,
            });
          } else {
            await markOutboxOperationRetry({
              outboxId: leasedEntry.id,
              errorCode: errInfo.code,
              errorMessage: errInfo.message.slice(0, 400),
              expectedLeaseOwner: leaseOwner,
              nowMs: now(),
              db: options.db,
            });
            retried += 1;
            results.push({
              outboxId: leasedEntry.id,
              operationId: opId,
              entityType: leasedEntry.entityType,
              entityId: leasedEntry.entityId,
              branchId: entryBranchId,
              outcome: 'retried',
              reason: errInfo.code,
            });
          }
        } else {
          const blockCode = errInfo.message.includes('COMMERCIAL_TARGET_ARCHIVED')
            ? 'COMMERCIAL_TARGET_ARCHIVED'
            : errInfo.message.includes('REMOTE_CONFLICT_MISMATCH')
              ? 'REMOTE_CONFLICT_MISMATCH'
              : errInfo.code.toUpperCase().replace(/-/g, '_');
          await markOutboxOperationBlocked({
            outboxId: leasedEntry.id,
            blockReason: blockCode,
            errorCode: errInfo.code,
            errorMessage: errInfo.message.slice(0, 400),
            expectedLeaseOwner: leaseOwner,
            db: options.db,
          });
          blocked += 1;
          results.push({
            outboxId: leasedEntry.id,
            operationId: opId,
            entityType: leasedEntry.entityType,
            entityId: leasedEntry.entityId,
            branchId: entryBranchId,
            outcome: 'blocked',
            reason: blockCode,
          });
        }
      }
    }

    return {
      status: 'completed',
      processed,
      synced,
      retried,
      blocked,
      deadLettered,
      skipped,
      deferred,
      results,
    };
  };

  const flight = executeCycle().finally(() => {
    inFlightWorkerCycles.delete(singleFlightKey);
  });
  inFlightWorkerCycles.set(singleFlightKey, flight);
  return flight;
}

async function getOutboxQueueForWorker(db?: IDBDatabase): Promise<OutboxEntry[]> {
  if (!db) {
    return getOutboxQueue();
  }
  if (!db.objectStoreNames.contains('outbox')) {
    return [];
  }
  return new Promise((resolve) => {
    const tx = db.transaction('outbox', 'readonly');
    const req = tx.objectStore('outbox').getAll();
    req.onsuccess = () => resolve((req.result as OutboxEntry[]) || []);
    req.onerror = () => resolve([]);
  });
}

async function isEntityManagedByOutboxV2Check(params: {
  branchId: string;
  entityType: 'sale' | 'medicine';
  entityId: string;
  actorUid: string;
}): Promise<boolean> {
  if (!isOutboxV2WorkerEnabled()) return false;
  if (!isValidFirebaseActorUid(params.actorUid) || !isValidFirestoreDocumentId(params.branchId)) {
    return false;
  }
  const entries = await getOutboxQueue();
  return entries.some(
    (e) =>
      e &&
      e.entityType === params.entityType &&
      e.entityId === params.entityId &&
      e.branchId === params.branchId &&
      e.actorUid === params.actorUid &&
      hasValidV2OutboxMetadata(e) &&
      e.status !== 'dead-letter'
  );
}

// Register coordinator hooks without altering feature flag (stays OFF by default)
registerOutboxV2CoordinatorHooks({
  runSyncIfEnabled: (context) => runOutboxV2SyncCycle({ reason: context?.reason }),
  isEntityManagedByOutboxV2: isEntityManagedByOutboxV2Check,
});

export { buildCanonicalFirestoreDocumentPath };
