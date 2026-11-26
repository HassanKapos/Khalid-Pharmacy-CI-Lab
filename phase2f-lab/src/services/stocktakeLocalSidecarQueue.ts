/**
 * Phase 2F — PR-F3: Isolated Local Offline Sidecar Queue (`LOCAL_PENDING`) & Reconnection Sync
 *
 * Strictly honors binding Owner Decisions:
 * - OD-2 / OD-2F-1: Zero modifications to `src/services/pharmacyDb.ts` or protected Outbox V2 files.
 *   Uses a dedicated browser IndexedDB database (`khalid_pharmacy_stocktake_v2_sidecar`) or
 *   serializable/in-memory adapter. Preserves `knownMovementIdsAtCount` & enforces ±30s fail-closed guard.
 * - OD-3 / OD-2F-2: Offline physical counts are strictly `LOCAL_PENDING` — NEVER a cloud lease,
 *   NEVER a shared confirmed count, and NEVER permission to post Inventory Ledger adjustments.
 *   On reconnection, reconciliation requires a POSITIVELY VERIFIED complete movement history snapshot
 *   (Fix B — fail closed to `NEEDS_REVIEW` on missing/incomplete/stale/wrong-scope/ambiguous history).
 * - OD-4 / OD-2F-3 / Fix A: Cashier combined view exposes ONLY their own confirmed physical quantity
 *   and unit plus their own pending/conflict status (zero systemStock, variance, cost, price, other-cashier data).
 * - Fix C: Deterministic collision-resistant offline record IDs using canonical UTF-8 length-prefixed
 *   5-field tuple `(branchId, sessionId, medicineId, actorUid, clientCountNonce)` + FIPS 180-4 SHA-256.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where,
  type Firestore,
  type Timestamp,
} from 'firebase/firestore';
import {
  FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS,
  computeMovementWatermarkDigest,
  scanForForbiddenKeys,
  type CashierOwnConfirmedCountView,
  type OperationalCountSubmissionEvent,
  type RemainingMedicinePublicView,
  type StocktakeCountUnit,
  type StocktakeRole,
} from './stocktakeContract.ts';
import {
  DEFAULT_CLOCK_SKEW_GUARD_MS,
  classifyMovementRelativeToCountReference,
  type ReconcilableLedgerMovement,
} from './stocktakeReconciliationEngine.ts';
import {
  acquireStocktakeLeaseTx,
  loadCashierStocktakeOperationalViews,
  submitStocktakeCountTx,
} from './stocktakeFirestoreService.ts';

export const STOCKTAKE_SIDECAR_DB_NAME = 'khalid_pharmacy_stocktake_v2_sidecar' as const;
export const STOCKTAKE_SIDECAR_STORE_NAME = 'local_pending_counts' as const;
export const DEFAULT_MAX_MOVEMENT_SNAPSHOT_AGE_MS = 5 * 60 * 1000; // 5 minutes

export type LocalPendingRecordStatus =
  | 'LOCAL_PENDING'
  | 'RECONCILIATION_PENDING'
  | 'CONFIRMED'
  | 'CONFLICT_ALREADY_COUNTED'
  | 'CONFLICT_ACTIVE_LEASE_HELD_BY_OTHER'
  | 'CONFLICT_SESSION_NOT_IN_PROGRESS'
  | 'CONFLICT_ITEM_MISSING'
  | 'NEEDS_REVIEW';

export interface LocalPendingStocktakeCountRecord {
  /** Deterministic collision-resistant SHA-256 ID (`off2_<64-hex>`) over full 5-field canonical tuple */
  localRecordId: string;
  branchId: string;
  sessionId: string;
  medicineId: string;
  medicineName: string;
  actorUid: string;
  actorDisplayName: string;
  actorRole: StocktakeRole;
  deviceId: string;
  clientCountNonce: string;

  /** Cashier's own physical count (NO system stock, NO variance, NO cost/price) */
  countedQuantity: number;
  countUnit: StocktakeCountUnit;
  baseUnitsPerCountUnit: number;

  /** Preserved OD-2F-1 movement watermark */
  knownMovementIdsAtCount: string[];
  watermarkDigest: string;
  countBusinessAtMs: number;
  localPersistedAtMs: number;
  notes?: string;

  /** Lifecycle status: LOCAL_PENDING -> RECONCILIATION_PENDING -> CONFIRMED / NEEDS_REVIEW / CONFLICT_* */
  status: LocalPendingRecordStatus;

  /** Explicit OD-2F-2 non-authority invariants */
  isCloudLease: false;
  isSharedConfirmedCount: boolean;
  canPostInventoryAdjustment: false;

  /** Populated ONLY once authoritatively confirmed in Firestore */
  confirmedEventId: string | null;
  confirmedCountRevision: number | null;
  confirmedAtMs: number | null;

  /** Populated when a conflict, history gap, or ±30s ambiguity blocks automatic sync/reconciliation */
  conflictCode: string | null;
  conflictDetail: string | null;
  lastReconcileAttemptAtMs: number | null;
}

/**
 * Fix B (CRITICAL): Explicit Authoritative Movement History Snapshot Contract.
 * Automatic offline reconciliation MUST NEVER proceed without a positively verified,
 * complete, in-scope, non-stale snapshot from Firestore `inventory_ledger`.
 */
export interface VerifiedMovementHistorySnapshot {
  snapshotId: string;
  branchId: string;
  coversAllBranchMedicines?: boolean;
  coveredMedicineIds?: ReadonlyArray<string>;
  /** Inclusive epoch ms interval covered by the authoritative query */
  intervalStartMs: number;
  intervalEndMs: number;
  authoritativeSource: 'FIRESTORE_INVENTORY_LEDGER';
  watermarkAtMs: number;
  completenessStatus: 'VERIFIED_COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';
  paginationComplete: boolean;
  movements: ReadonlyArray<ReconcilableLedgerMovement>;
}

export interface MovementHistoryVerificationResult {
  verified: boolean;
  code:
    | 'VERIFIED_OK'
    | 'MOVEMENT_HISTORY_MISSING'
    | 'MOVEMENT_HISTORY_UNVERIFIED_PROVENANCE'
    | 'MOVEMENT_HISTORY_INCOMPLETE'
    | 'MOVEMENT_HISTORY_PAGINATION_INCOMPLETE'
    | 'MOVEMENT_HISTORY_WRONG_BRANCH'
    | 'MOVEMENT_HISTORY_WRONG_MEDICINE'
    | 'MOVEMENT_HISTORY_STALE_OR_INTERVAL_GAP'
    | 'MOVEMENT_HISTORY_AMBIGUOUS_OR_MISSING_PROVENANCE'
    | 'AMBIGUOUS_MOVEMENT_WITHIN_30S_GUARD';
  detail: string;
  ambiguousMovementIds: string[];
}

export interface StocktakeSidecarStorageAdapter {
  put(record: LocalPendingStocktakeCountRecord): Promise<void>;
  get(localRecordId: string): Promise<LocalPendingStocktakeCountRecord | null>;
  listBySessionAndActor(
    branchId: string,
    sessionId: string,
    actorUid: string
  ): Promise<LocalPendingStocktakeCountRecord[]>;
  listAllPending(branchId: string, sessionId: string): Promise<LocalPendingStocktakeCountRecord[]>;
}

/**
 * Pure, dependency-free FIPS 180-4 SHA-256 over UTF-8 strings.
 * Produces identical 64-character lowercase hex digests across Browser, Node.js, and Workers
 * with zero async WebCrypto or Node `crypto` runtime coupling.
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8Encode(str: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

export function sha256Utf8Hex(input: string): string {
  const msg = utf8Encode(input);
  const bitLen = msg.length * 8;
  const paddedLen = Math.ceil((msg.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(msg);
  buf[msg.length] = 0x80;

  const view = new DataView(buf.buffer);
  const hiBits = Math.floor(bitLen / 0x100000000);
  const loBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, hiBits, false);
  view.setUint32(paddedLen - 4, loBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * Deterministic in-memory sidecar adapter with JSON snapshot export/restore
 * (supports deterministic restart-persistence testing & non-DOM runtimes).
 */
export class InMemoryStocktakeSidecarStore implements StocktakeSidecarStorageAdapter {
  private readonly records = new Map<string, LocalPendingStocktakeCountRecord>();

  async put(record: LocalPendingStocktakeCountRecord): Promise<void> {
    assertSidecarRecordSafe(record);
    this.records.set(record.localRecordId, structuredClone(record));
  }

  async get(localRecordId: string): Promise<LocalPendingStocktakeCountRecord | null> {
    const found = this.records.get(localRecordId);
    return found ? structuredClone(found) : null;
  }

  async listBySessionAndActor(
    branchId: string,
    sessionId: string,
    actorUid: string
  ): Promise<LocalPendingStocktakeCountRecord[]> {
    const out: LocalPendingStocktakeCountRecord[] = [];
    for (const rec of this.records.values()) {
      if (rec.branchId === branchId && rec.sessionId === sessionId && rec.actorUid === actorUid) {
        out.push(structuredClone(rec));
      }
    }
    return out.sort((a, b) => a.localPersistedAtMs - b.localPersistedAtMs);
  }

  async listAllPending(branchId: string, sessionId: string): Promise<LocalPendingStocktakeCountRecord[]> {
    const out: LocalPendingStocktakeCountRecord[] = [];
    for (const rec of this.records.values()) {
      if (
        rec.branchId === branchId &&
        rec.sessionId === sessionId &&
        (rec.status === 'LOCAL_PENDING' || rec.status === 'RECONCILIATION_PENDING')
      ) {
        out.push(structuredClone(rec));
      }
    }
    return out.sort((a, b) => a.localPersistedAtMs - b.localPersistedAtMs);
  }

  exportSnapshot(): string {
    return JSON.stringify(Array.from(this.records.values()));
  }

  static fromSnapshot(snapshotJson: string): InMemoryStocktakeSidecarStore {
    const store = new InMemoryStocktakeSidecarStore();
    const parsed = JSON.parse(snapshotJson) as LocalPendingStocktakeCountRecord[];
    for (const rec of parsed) {
      assertSidecarRecordSafe(rec);
      store.records.set(rec.localRecordId, structuredClone(rec));
    }
    return store;
  }
}

/**
 * Dedicated browser IndexedDB sidecar store (`khalid_pharmacy_stocktake_v2_sidecar`).
 * Completely independent of `src/services/pharmacyDb.ts` (OD-2 / OD-2F-1).
 */
export class IndexedDbStocktakeSidecarStore implements StocktakeSidecarStorageAdapter {
  private readonly dbName: string;

  constructor(dbName: string = STOCKTAKE_SIDECAR_DB_NAME) {
    this.dbName = dbName;
  }

  private openDb(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
      throw new Error('INDEXEDDB_UNAVAILABLE_USE_IN_MEMORY_ADAPTER');
    }
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STOCKTAKE_SIDECAR_STORE_NAME)) {
          const store = db.createObjectStore(STOCKTAKE_SIDECAR_STORE_NAME, {
            keyPath: 'localRecordId',
          });
          store.createIndex('by_session_actor', ['branchId', 'sessionId', 'actorUid'], {
            unique: false,
          });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('SIDECAR_IDB_OPEN_FAILED'));
    });
  }

  async put(record: LocalPendingStocktakeCountRecord): Promise<void> {
    assertSidecarRecordSafe(record);
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STOCKTAKE_SIDECAR_STORE_NAME, 'readwrite');
        tx.objectStore(STOCKTAKE_SIDECAR_STORE_NAME).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('SIDECAR_IDB_PUT_FAILED'));
      });
    } finally {
      db.close();
    }
  }

  async get(localRecordId: string): Promise<LocalPendingStocktakeCountRecord | null> {
    const db = await this.openDb();
    try {
      return await new Promise<LocalPendingStocktakeCountRecord | null>((resolve, reject) => {
        const tx = db.transaction(STOCKTAKE_SIDECAR_STORE_NAME, 'readonly');
        const req = tx.objectStore(STOCKTAKE_SIDECAR_STORE_NAME).get(localRecordId);
        req.onsuccess = () => resolve((req.result as LocalPendingStocktakeCountRecord) ?? null);
        req.onerror = () => reject(req.error ?? new Error('SIDECAR_IDB_GET_FAILED'));
      });
    } finally {
      db.close();
    }
  }

  async listBySessionAndActor(
    branchId: string,
    sessionId: string,
    actorUid: string
  ): Promise<LocalPendingStocktakeCountRecord[]> {
    const db = await this.openDb();
    try {
      return await new Promise<LocalPendingStocktakeCountRecord[]>((resolve, reject) => {
        const tx = db.transaction(STOCKTAKE_SIDECAR_STORE_NAME, 'readonly');
        const idx = tx.objectStore(STOCKTAKE_SIDECAR_STORE_NAME).index('by_session_actor');
        const req = idx.getAll([branchId, sessionId, actorUid]);
        req.onsuccess = () => {
          const items = (req.result as LocalPendingStocktakeCountRecord[]) ?? [];
          resolve(items.sort((a, b) => a.localPersistedAtMs - b.localPersistedAtMs));
        };
        req.onerror = () => reject(req.error ?? new Error('SIDECAR_IDB_LIST_FAILED'));
      });
    } finally {
      db.close();
    }
  }

  async listAllPending(branchId: string, sessionId: string): Promise<LocalPendingStocktakeCountRecord[]> {
    const db = await this.openDb();
    try {
      return await new Promise<LocalPendingStocktakeCountRecord[]>((resolve, reject) => {
        const tx = db.transaction(STOCKTAKE_SIDECAR_STORE_NAME, 'readonly');
        const req = tx.objectStore(STOCKTAKE_SIDECAR_STORE_NAME).getAll();
        req.onsuccess = () => {
          const items = ((req.result as LocalPendingStocktakeCountRecord[]) ?? []).filter(
            (r) =>
              r.branchId === branchId &&
              r.sessionId === sessionId &&
              (r.status === 'LOCAL_PENDING' || r.status === 'RECONCILIATION_PENDING')
          );
          resolve(items.sort((a, b) => a.localPersistedAtMs - b.localPersistedAtMs));
        };
        req.onerror = () => reject(req.error ?? new Error('SIDECAR_IDB_LIST_PENDING_FAILED'));
      });
    } finally {
      db.close();
    }
  }
}

function assertSidecarRecordSafe(payload: unknown): void {
  const leaks = scanForForbiddenKeys(payload, FORBIDDEN_CASHIER_CONFIRMED_VIEW_FIELDS);
  if (leaks.length > 0) {
    throw new Error(`OD_2F_3_SIDECAR_FORBIDDEN_FIELDS:${leaks.join(',')}`);
  }
}

function requireValidTupleComponent(name: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`INVALID_OFFLINE_RECORD_ID_INPUT:${name}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || value !== trimmed) {
    throw new Error(`INVALID_OFFLINE_RECORD_ID_INPUT:${name}`);
  }
  return trimmed;
}

/**
 * Fix C (HIGH): Deterministic, collision-resistant offline record ID.
 * Uses canonical UTF-8 byte-length-prefixed serialization of ALL 5 tuple components
 * `(branchId, sessionId, medicineId, actorUid, clientCountNonce)` hashed with SHA-256 ->
 * `off2_<64-hex>` (fixed 69 chars, always valid Firestore ID, zero lossy normalization,
 * zero delimiter ambiguity, zero truncation).
 */
export function buildDeterministicOfflineRecordId(params: {
  branchId: string;
  sessionId: string;
  medicineId: string;
  actorUid: string;
  clientCountNonce: string;
}): string {
  const parts = [
    requireValidTupleComponent('branchId', params.branchId),
    requireValidTupleComponent('sessionId', params.sessionId),
    requireValidTupleComponent('medicineId', params.medicineId),
    requireValidTupleComponent('actorUid', params.actorUid),
    requireValidTupleComponent('clientCountNonce', params.clientCountNonce),
  ];
  const canonical =
    'off2|' + parts.map((p) => `${utf8Encode(p).length}:${p}`).join('|');
  return `off2_${sha256Utf8Hex(canonical)}`;
}

export interface RecordOfflineCountInput {
  branchId: string;
  sessionId: string;
  medicineId: string;
  medicineName: string;
  actorUid: string;
  actorDisplayName: string;
  actorRole: StocktakeRole;
  deviceId: string;
  clientCountNonce: string;
  countedQuantity: number;
  countUnit: StocktakeCountUnit;
  baseUnitsPerCountUnit: number;
  knownMovementIdsAtCount: string[];
  countBusinessAtMs?: number;
  localPersistedAtMs?: number;
  notes?: string;
}

/**
 * OD-3 / OD-2F-2: Record a Cashier physical count offline into the isolated sidecar queue.
 * - Marked `LOCAL_PENDING`
 * - `isCloudLease: false`, `isSharedConfirmedCount: false`, `canPostInventoryAdjustment: false`
 * - Preserves `knownMovementIdsAtCount` & watermark digest (OD-2F-1)
 * - Idempotent if called repeatedly with the exact same 5-field tuple; fails closed on tuple mismatch!
 */
export async function recordOfflinePhysicalCountLocalPending(
  store: StocktakeSidecarStorageAdapter,
  input: RecordOfflineCountInput
): Promise<LocalPendingStocktakeCountRecord> {
  assertSidecarRecordSafe(input);

  if (!Number.isFinite(input.countedQuantity) || input.countedQuantity < 0) {
    throw new Error('INVALID_COUNTED_QUANTITY');
  }
  if (!Number.isFinite(input.baseUnitsPerCountUnit) || input.baseUnitsPerCountUnit <= 0) {
    throw new Error('INVALID_BASE_UNITS_PER_COUNT_UNIT');
  }
  if (!input.clientCountNonce || input.clientCountNonce.trim().length < 3) {
    throw new Error('CLIENT_COUNT_NONCE_REQUIRED');
  }

  const normalizedNonce = input.clientCountNonce.trim();
  const localRecordId = buildDeterministicOfflineRecordId({
    branchId: input.branchId,
    sessionId: input.sessionId,
    medicineId: input.medicineId,
    actorUid: input.actorUid,
    clientCountNonce: normalizedNonce,
  });

  const existing = await store.get(localRecordId);
  if (existing) {
    // Fix C defense-in-depth: verify full 5-field tuple equality before treating as idempotent replay
    if (
      existing.branchId !== input.branchId ||
      existing.sessionId !== input.sessionId ||
      existing.medicineId !== input.medicineId ||
      existing.actorUid !== input.actorUid ||
      existing.clientCountNonce !== normalizedNonce
    ) {
      throw new Error(`OFFLINE_RECORD_ID_TUPLE_MISMATCH:${localRecordId}`);
    }
    return existing;
  }

  const nowMs = Date.now();
  const dedupedKnownIds = [...new Set(input.knownMovementIdsAtCount)].sort();

  const record: LocalPendingStocktakeCountRecord = {
    localRecordId,
    branchId: input.branchId,
    sessionId: input.sessionId,
    medicineId: input.medicineId,
    medicineName: input.medicineName,
    actorUid: input.actorUid,
    actorDisplayName: input.actorDisplayName,
    actorRole: input.actorRole,
    deviceId: input.deviceId,
    clientCountNonce: normalizedNonce,
    countedQuantity: input.countedQuantity,
    countUnit: input.countUnit,
    baseUnitsPerCountUnit: input.baseUnitsPerCountUnit,
    knownMovementIdsAtCount: dedupedKnownIds,
    watermarkDigest: computeMovementWatermarkDigest(dedupedKnownIds),
    countBusinessAtMs: input.countBusinessAtMs ?? nowMs,
    localPersistedAtMs: input.localPersistedAtMs ?? nowMs,
    ...(input.notes ? { notes: input.notes } : {}),
    status: 'LOCAL_PENDING',
    isCloudLease: false,
    isSharedConfirmedCount: false,
    canPostInventoryAdjustment: false,
    confirmedEventId: null,
    confirmedCountRevision: null,
    confirmedAtMs: null,
    conflictCode: null,
    conflictDetail: null,
    lastReconcileAttemptAtMs: null,
  };

  await store.put(record);
  return record;
}

export interface OfflineWatermarkAmbiguityResult {
  requiresReview: boolean;
  status: 'SAFE_FOR_RECONCILIATION' | 'NEEDS_REVIEW';
  autoReconciliationBlocked: boolean;
  ambiguousMovementIds: string[];
  preCountMovementIds: string[];
  postCountMovementIds: string[];
}

/**
 * OD-2F-1 ±30-second fail-closed guard on an offline physical count record.
 * If ANY movement for the medicine has ambiguous ordering/provenance or falls within
 * ±30s of `countBusinessAtMs` without being listed in `knownMovementIdsAtCount`,
 * automatic reconciliation MUST stop and require explicit review (`NEEDS_REVIEW`).
 */
export function evaluateOfflineCountWatermarkAmbiguity(params: {
  record: LocalPendingStocktakeCountRecord;
  movements: ReadonlyArray<ReconcilableLedgerMovement>;
  clockSkewGuardMs?: number;
}): OfflineWatermarkAmbiguityResult {
  const guardMs = params.clockSkewGuardMs ?? DEFAULT_CLOCK_SKEW_GUARD_MS;
  const ambiguousMovementIds: string[] = [];
  const preCountMovementIds: string[] = [];
  const postCountMovementIds: string[] = [];

  const syntheticEvent: OperationalCountSubmissionEvent = {
    eventId: params.record.localRecordId,
    idempotencyKey: params.record.localRecordId,
    sessionId: params.record.sessionId,
    branchId: params.record.branchId,
    medicineId: params.record.medicineId,
    countRevision: 1,
    leaseId: 'local-pending-non-lease',
    leaseVersion: 0,
    countedQuantity: params.record.countedQuantity,
    countUnit: params.record.countUnit,
    baseUnitsPerCountUnit: params.record.baseUnitsPerCountUnit,
    countedBaseUnits: Math.round(params.record.countedQuantity * params.record.baseUnitsPerCountUnit),
    actorUid: params.record.actorUid,
    actorDisplayName: params.record.actorDisplayName,
    deviceId: params.record.deviceId,
    syncStatus: 'LOCAL_PENDING',
    watermark: {
      countBusinessAtMs: params.record.countBusinessAtMs,
      localPersistedAtMs: params.record.localPersistedAtMs,
      serverConfirmedAtMs: null,
      knownMovementIdsAtCount: [...params.record.knownMovementIdsAtCount],
      knownMovementCount: params.record.knownMovementIdsAtCount.length,
      watermarkDigest: params.record.watermarkDigest,
    },
    recountOfEventId: null,
    notes: params.record.notes ?? '',
  };

  for (const mv of params.movements) {
    if (mv.medicineId !== params.record.medicineId) continue;
    const res = classifyMovementRelativeToCountReference({
      movement: mv,
      countEvent: syntheticEvent,
      clockSkewGuardMs: guardMs,
    });
    if (res.classification === 'AMBIGUOUS_ORDERING_NEEDS_REVIEW') {
      ambiguousMovementIds.push(mv.id);
    } else if (res.classification === 'PRE_COUNT_ALREADY_IN_PHYSICAL_COUNT') {
      preCountMovementIds.push(mv.id);
    } else {
      postCountMovementIds.push(mv.id);
    }
  }

  const requiresReview = ambiguousMovementIds.length > 0;
  return {
    requiresReview,
    status: requiresReview ? 'NEEDS_REVIEW' : 'SAFE_FOR_RECONCILIATION',
    autoReconciliationBlocked: requiresReview,
    ambiguousMovementIds,
    preCountMovementIds,
    postCountMovementIds,
  };
}

/**
 * Fix B (CRITICAL): Positively verifies movement history completeness, scope, freshness,
 * pagination, provenance, and ±30s guard before allowing automatic offline reconciliation.
 * FAILS CLOSED to `NEEDS_REVIEW` on ANY missing, unverified, incomplete, stale, wrong-branch,
 * wrong-medicine, unpaginated, or ambiguous input.
 */
export function verifyMovementHistorySnapshotForRecord(params: {
  record: LocalPendingStocktakeCountRecord;
  snapshot: VerifiedMovementHistorySnapshot | null | undefined;
  clockSkewGuardMs?: number;
  maxSnapshotAgeMs?: number;
  nowMs?: number;
}): MovementHistoryVerificationResult {
  const { record, snapshot } = params;
  const guardMs = params.clockSkewGuardMs ?? DEFAULT_CLOCK_SKEW_GUARD_MS;
  const maxAgeMs = params.maxSnapshotAgeMs ?? DEFAULT_MAX_MOVEMENT_SNAPSHOT_AGE_MS;
  const nowMs = params.nowMs ?? Date.now();

  if (!snapshot) {
    return {
      verified: false,
      code: 'MOVEMENT_HISTORY_MISSING',
      detail: 'Movement history snapshot is missing/undefined; automatic offline reconciliation halted fail-closed.',
      ambiguousMovementIds: [],
    };
  }
  if (
    snapshot.authoritativeSource !== 'FIRESTORE_INVENTORY_LEDGER' ||
    typeof snapshot.snapshotId !== 'string' ||
    snapshot.snapshotId.trim().length < 3
  ) {
    return {
      verified: false,
      code: 'MOVEMENT_HISTORY_UNVERIFIED_PROVENANCE',
      detail: 'Movement history snapshot lacks authoritative FIRESTORE_INVENTORY_LEDGER provenance.',
      ambiguousMovementIds: [],
    };
  }
  if (snapshot.completenessStatus !== 'VERIFIED_COMPLETE') {
    return {
      verified: false,
      code: 'MOVEMENT_HISTORY_INCOMPLETE',
      detail: `Movement history completenessStatus is '${snapshot.completenessStatus}' (requires VERIFIED_COMPLETE).`,
      ambiguousMovementIds: [],
    };
  }
  if (snapshot.paginationComplete !== true) {
    return {
      verified: false,
      code: 'MOVEMENT_HISTORY_PAGINATION_INCOMPLETE',
      detail: 'Movement history pagination is incomplete; cannot guarantee all movements were inspected.',
      ambiguousMovementIds: [],
    };
  }
  if (snapshot.branchId !== record.branchId) {
    return {
      verified: false,
      code: 'MOVEMENT_HISTORY_WRONG_BRANCH',
      detail: `Movement history snapshot branchId '${snapshot.branchId}' does not match record branchId '${record.branchId}'.`,
      ambiguousMovementIds: [],
    };
  }
  const medicineCovered =
    snapshot.coversAllBranchMedicines === true ||
    (Array.isArray(snapshot.coveredMedicineIds) &&
      snapshot.coveredMedicineIds.includes(record.medicineId));
  if (!medicineCovered) {
    return {
      verified: false,
      code: 'MOVEMENT_HISTORY_WRONG_MEDICINE',
      detail: `Movement history snapshot does not cover medicine '${record.medicineId}'.`,
      ambiguousMovementIds: [],
    };
  }
  if (
    !Number.isFinite(snapshot.watermarkAtMs) ||
    !Number.isFinite(snapshot.intervalStartMs) ||
    !Number.isFinite(snapshot.intervalEndMs) ||
    snapshot.watermarkAtMs < record.countBusinessAtMs + guardMs ||
    snapshot.intervalStartMs > record.countBusinessAtMs - guardMs ||
    snapshot.intervalEndMs < record.countBusinessAtMs + guardMs ||
    nowMs - snapshot.watermarkAtMs > maxAgeMs
  ) {
    return {
      verified: false,
      code: 'MOVEMENT_HISTORY_STALE_OR_INTERVAL_GAP',
      detail:
        'Movement history snapshot is stale or does not cover [countBusinessAtMs - guard, countBusinessAtMs + guard].',
      ambiguousMovementIds: [],
    };
  }
  if (!Array.isArray(snapshot.movements)) {
    return {
      verified: false,
      code: 'MOVEMENT_HISTORY_INCOMPLETE',
      detail: 'Movement history snapshot movements array is missing.',
      ambiguousMovementIds: [],
    };
  }

  for (const mv of snapshot.movements) {
    if (mv.medicineId !== record.medicineId) continue;
    if (
      mv.branchId !== record.branchId ||
      !mv.id ||
      mv.id.trim().length === 0 ||
      !mv.referenceId ||
      mv.referenceId.trim().length === 0 ||
      mv.synced !== true ||
      !Number.isFinite(mv.businessOccurredAtMs) ||
      mv.businessOccurredAtMs <= 0
    ) {
      return {
        verified: false,
        code: 'MOVEMENT_HISTORY_AMBIGUOUS_OR_MISSING_PROVENANCE',
        detail: `Movement '${mv.id || 'unknown'}' has missing provenance, wrong branch, unsynced state, or ambiguous timestamp.`,
        ambiguousMovementIds: [mv.id || 'unknown'],
      };
    }
  }

  const ambiguity = evaluateOfflineCountWatermarkAmbiguity({
    record,
    movements: snapshot.movements,
    clockSkewGuardMs: guardMs,
  });
  if (ambiguity.requiresReview) {
    return {
      verified: false,
      code: 'AMBIGUOUS_MOVEMENT_WITHIN_30S_GUARD',
      detail: `Automatic reconciliation halted: ${ambiguity.ambiguousMovementIds.length} movement(s) [${ambiguity.ambiguousMovementIds.join(', ')}] fall within ±${Math.round(guardMs / 1000)}s or have ambiguous ordering/provenance.`,
      ambiguousMovementIds: ambiguity.ambiguousMovementIds,
    };
  }

  return {
    verified: true,
    code: 'VERIFIED_OK',
    detail: 'Authoritative movement history snapshot positively verified.',
    ambiguousMovementIds: [],
  };
}

/**
 * Fetches an authoritative `VerifiedMovementHistorySnapshot` directly from Firestore
 * `branches/{branchId}/inventory_ledger` with explicit pagination-completeness tracking.
 * If the result hits `maxDocs`, marks `paginationComplete: false` and `completenessStatus: 'INCOMPLETE'`
 * so downstream reconciliation FAILS CLOSED to `NEEDS_REVIEW` rather than silently truncating!
 */
export async function fetchVerifiedBranchMovementHistorySnapshot(
  db: Firestore,
  params: {
    branchId: string;
    intervalStartMs: number;
    intervalEndMs: number;
    maxDocs?: number;
  }
): Promise<VerifiedMovementHistorySnapshot> {
  const maxDocs = params.maxDocs ?? 500;
  const ledgerCol = collection(db, 'branches', params.branchId, 'inventory_ledger');
  const snap = await getDocs(
    query(ledgerCol, where('branchId', '==', params.branchId), limit(maxDocs + 1))
  );
  const truncated = snap.size > maxDocs;
  const docs = truncated ? snap.docs.slice(0, maxDocs) : snap.docs;
  const movements: ReconcilableLedgerMovement[] = docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const createdMs = (data.createdAt as Timestamp | undefined)?.toMillis?.() ?? 0;
    return {
      id: String(data.id ?? d.id),
      branchId: String(data.branchId ?? params.branchId),
      medicineId: String(data.medicineId ?? ''),
      batchNumber: typeof data.batchNumber === 'string' ? data.batchNumber : '',
      type: (data.type as ReconcilableLedgerMovement['type']) ?? 'ADJUSTMENT',
      unit: (data.unit as StocktakeCountUnit) ?? 'pill',
      quantityDelta: Number(data.quantityDelta ?? 0),
      baseUnitsDelta: Number(data.baseUnitsDelta ?? 0),
      referenceId: String(data.referenceId ?? ''),
      businessOccurredAtMs: Number(data.businessOccurredAtMs ?? createdMs),
      localPersistedAtMs: Number(data.localPersistedAtMs ?? createdMs),
      serverSyncedAtMs: createdMs || null,
      synced: true,
      branchLedgerSeq: typeof data.branchLedgerSeq === 'number' ? data.branchLedgerSeq : null,
      medicineLedgerSeq: typeof data.medicineLedgerSeq === 'number' ? data.medicineLedgerSeq : null,
    };
  });

  const nowMs = Date.now();
  return {
    snapshotId: `snap_${params.branchId}_${nowMs}`,
    branchId: params.branchId,
    coversAllBranchMedicines: true,
    intervalStartMs: params.intervalStartMs,
    intervalEndMs: Math.max(params.intervalEndMs, nowMs),
    authoritativeSource: 'FIRESTORE_INVENTORY_LEDGER',
    watermarkAtMs: nowMs,
    completenessStatus: truncated ? 'INCOMPLETE' : 'VERIFIED_COMPLETE',
    paginationComplete: !truncated,
    movements,
  };
}

export interface ReconcileOfflineSyncItemOutcome {
  localRecordId: string;
  medicineId: string;
  outcome:
    | 'SYNCED_CONFIRMED'
    | 'IDEMPOTENT_ALREADY_CONFIRMED'
    | 'CONFLICT_ALREADY_COUNTED'
    | 'CONFLICT_ACTIVE_LEASE_HELD_BY_OTHER'
    | 'CONFLICT_SESSION_NOT_IN_PROGRESS'
    | 'CONFLICT_ITEM_MISSING'
    | 'NEEDS_REVIEW';
  confirmedEventId: string | null;
  confirmedCountRevision: number | null;
  conflictCode: string | null;
  conflictDetail: string | null;
}

/**
 * OD-3 / Fix B / Fix F: Reconnect & reconcile offline `LOCAL_PENDING` (and interrupted
 * `RECONCILIATION_PENDING`) records against authoritative cloud state and verified movement history.
 *
 * Security & Safety Guarantees:
 * - Lifecycle: `LOCAL_PENDING -> RECONCILIATION_PENDING -> CONFIRMED / NEEDS_REVIEW / CONFLICT_*`.
 * - Positively requires a `VerifiedMovementHistorySnapshot`; missing/empty-unverified/incomplete/stale/
 *   wrong-scope/unpaginated/ambiguous history ALWAYS fails closed to `NEEDS_REVIEW`!
 * - Crash-after-commit deduplication queries ONLY the cashier's OWN actor-scoped `count_events`
 *   (100% Fix A / OD-4 compliant; zero reads of other cashiers' counts or removed shared item fields).
 * - Never overwrites cloud counts, never steals active leases, never leaks other-cashier UIDs,
 *   and NEVER auto-posts Inventory Ledger adjustments.
 */
export async function reconcileAndSyncOfflinePendingCounts(
  db: Firestore,
  store: StocktakeSidecarStorageAdapter,
  params: {
    branchId: string;
    sessionId: string;
    actorUid: string;
    /** Fix B: Positively verified authoritative movement history snapshot (missing/invalid fails closed -> NEEDS_REVIEW) */
    movementHistorySnapshot?: VerifiedMovementHistorySnapshot | null;
    clockSkewGuardMs?: number;
    maxSnapshotAgeMs?: number;
    nowMs?: number;
  }
): Promise<ReconcileOfflineSyncItemOutcome[]> {
  const outcomes: ReconcileOfflineSyncItemOutcome[] = [];
  const allActorRecords = await store.listBySessionAndActor(
    params.branchId,
    params.sessionId,
    params.actorUid
  );
  if (allActorRecords.length === 0) return outcomes;

  const sessRef = doc(db, 'branches', params.branchId, 'stocktake_sessions_v2', params.sessionId);
  const sessSnap = await getDoc(sessRef);
  const sessionStatus = sessSnap.exists() ? String(sessSnap.data().status ?? '') : 'MISSING';

  // Fix A compliant crash-after-commit deduplication: query ONLY this actor's OWN count_events!
  const ownEventsCol = collection(
    db,
    'branches',
    params.branchId,
    'stocktake_sessions_v2',
    params.sessionId,
    'count_events'
  );
  const ownEventsSnap = await getDocs(
    query(
      ownEventsCol,
      where('branchId', '==', params.branchId),
      where('sessionId', '==', params.sessionId),
      where('actorUid', '==', params.actorUid)
    )
  );
  const ownEventByLeaseId = new Map<string, { eventId: string; countRevision: number }>();
  ownEventsSnap.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    if (typeof data.leaseId === 'string') {
      ownEventByLeaseId.set(data.leaseId, {
        eventId: String(data.eventId ?? d.id),
        countRevision: Number(data.countRevision ?? 1),
      });
    }
  });

  for (const rec of allActorRecords) {
    if (rec.status === 'CONFIRMED') {
      outcomes.push({
        localRecordId: rec.localRecordId,
        medicineId: rec.medicineId,
        outcome: 'IDEMPOTENT_ALREADY_CONFIRMED',
        confirmedEventId: rec.confirmedEventId,
        confirmedCountRevision: rec.confirmedCountRevision,
        conflictCode: null,
        conflictDetail: null,
      });
      continue;
    }

    if (rec.status !== 'LOCAL_PENDING' && rec.status !== 'RECONCILIATION_PENDING') {
      outcomes.push({
        localRecordId: rec.localRecordId,
        medicineId: rec.medicineId,
        outcome: rec.status,
        confirmedEventId: rec.confirmedEventId,
        confirmedCountRevision: rec.confirmedCountRevision,
        conflictCode: rec.conflictCode,
        conflictDetail: rec.conflictDetail,
      });
      continue;
    }

    const attemptAtMs = params.nowMs ?? Date.now();

    // Persist explicit RECONCILIATION_PENDING transition before checking/mutating cloud
    const reconcilingRec: LocalPendingStocktakeCountRecord = {
      ...rec,
      status: 'RECONCILIATION_PENDING',
      isCloudLease: false,
      isSharedConfirmedCount: false,
      canPostInventoryAdjustment: false,
      lastReconcileAttemptAtMs: attemptAtMs,
    };
    await store.put(reconcilingRec);

    // 0. Crash-after-commit idempotency check via actor's OWN count_events (Fix A + Fix F)
    const expectedOfflineLeaseId = `lease-offsync-${rec.localRecordId}`;
    const alreadyInCloud = ownEventByLeaseId.get(expectedOfflineLeaseId);
    if (alreadyInCloud) {
      const updated: LocalPendingStocktakeCountRecord = {
        ...reconcilingRec,
        status: 'CONFIRMED',
        isCloudLease: false,
        isSharedConfirmedCount: true,
        canPostInventoryAdjustment: false,
        confirmedEventId: alreadyInCloud.eventId,
        confirmedCountRevision: alreadyInCloud.countRevision,
        confirmedAtMs: attemptAtMs,
        conflictCode: null,
        conflictDetail: null,
        lastReconcileAttemptAtMs: attemptAtMs,
      };
      await store.put(updated);
      outcomes.push({
        localRecordId: rec.localRecordId,
        medicineId: rec.medicineId,
        outcome: 'IDEMPOTENT_ALREADY_CONFIRMED',
        confirmedEventId: updated.confirmedEventId,
        confirmedCountRevision: updated.confirmedCountRevision,
        conflictCode: null,
        conflictDetail: null,
      });
      continue;
    }

    // 1. Authoritative session status check
    if (sessionStatus !== 'IN_PROGRESS') {
      const updated: LocalPendingStocktakeCountRecord = {
        ...reconcilingRec,
        status: 'CONFLICT_SESSION_NOT_IN_PROGRESS',
        isCloudLease: false,
        isSharedConfirmedCount: false,
        canPostInventoryAdjustment: false,
        conflictCode: `SESSION_STATUS_${sessionStatus}`,
        conflictDetail: `Cloud stocktake session is '${sessionStatus}' (not IN_PROGRESS); offline count kept unresolved.`,
        lastReconcileAttemptAtMs: attemptAtMs,
      };
      await store.put(updated);
      outcomes.push({
        localRecordId: rec.localRecordId,
        medicineId: rec.medicineId,
        outcome: 'CONFLICT_SESSION_NOT_IN_PROGRESS',
        confirmedEventId: null,
        confirmedCountRevision: null,
        conflictCode: updated.conflictCode,
        conflictDetail: updated.conflictDetail,
      });
      continue;
    }

    // 2. Fix B (CRITICAL): Positively verify authoritative movement history snapshot & ±30s guard
    const historyCheck = verifyMovementHistorySnapshotForRecord({
      record: reconcilingRec,
      snapshot: params.movementHistorySnapshot,
      clockSkewGuardMs: params.clockSkewGuardMs,
      maxSnapshotAgeMs: params.maxSnapshotAgeMs,
      nowMs: attemptAtMs,
    });
    if (!historyCheck.verified) {
      const updated: LocalPendingStocktakeCountRecord = {
        ...reconcilingRec,
        status: 'NEEDS_REVIEW',
        isCloudLease: false,
        isSharedConfirmedCount: false,
        canPostInventoryAdjustment: false,
        conflictCode: historyCheck.code,
        conflictDetail: historyCheck.detail,
        lastReconcileAttemptAtMs: attemptAtMs,
      };
      await store.put(updated);
      outcomes.push({
        localRecordId: rec.localRecordId,
        medicineId: rec.medicineId,
        outcome: 'NEEDS_REVIEW',
        confirmedEventId: null,
        confirmedCountRevision: null,
        conflictCode: updated.conflictCode,
        conflictDetail: updated.conflictDetail,
      });
      continue;
    }

    // 3. Check authoritative cloud item existence
    const itemRef = doc(
      db,
      'branches',
      params.branchId,
      'stocktake_sessions_v2',
      params.sessionId,
      'items',
      rec.medicineId
    );
    const itemSnap = await getDoc(itemRef);
    if (!itemSnap.exists()) {
      const updated: LocalPendingStocktakeCountRecord = {
        ...reconcilingRec,
        status: 'CONFLICT_ITEM_MISSING',
        isCloudLease: false,
        isSharedConfirmedCount: false,
        canPostInventoryAdjustment: false,
        conflictCode: 'CLOUD_ITEM_NOT_FOUND',
        conflictDetail: `Medicine '${rec.medicineId}' does not exist in cloud session '${params.sessionId}'.`,
        lastReconcileAttemptAtMs: attemptAtMs,
      };
      await store.put(updated);
      outcomes.push({
        localRecordId: rec.localRecordId,
        medicineId: rec.medicineId,
        outcome: 'CONFLICT_ITEM_MISSING',
        confirmedEventId: null,
        confirmedCountRevision: null,
        conflictCode: updated.conflictCode,
        conflictDetail: updated.conflictDetail,
      });
      continue;
    }

    // 4. Acquire real server-time CAS lease via PR-F2 service (Fix A generic conflict errors!)
    const leaseRes = await acquireStocktakeLeaseTx(db, {
      branchId: params.branchId,
      sessionId: params.sessionId,
      medicineId: rec.medicineId,
      actorUid: rec.actorUid,
      actorDisplayName: rec.actorDisplayName,
      deviceId: rec.deviceId,
      leaseId: expectedOfflineLeaseId,
      ttlMs: 120_000,
    });

    if (!leaseRes.ok) {
      if (leaseRes.code === 'ALREADY_COUNTED') {
        const updated: LocalPendingStocktakeCountRecord = {
          ...reconcilingRec,
          status: 'CONFLICT_ALREADY_COUNTED',
          isCloudLease: false,
          isSharedConfirmedCount: false,
          canPostInventoryAdjustment: false,
          conflictCode: 'CLOUD_ITEM_ALREADY_COUNTED',
          conflictDetail:
            'Item was already counted in the cloud before reconnection; offline count preserved as unresolved conflict without overwriting cloud count.',
          lastReconcileAttemptAtMs: attemptAtMs,
        };
        await store.put(updated);
        outcomes.push({
          localRecordId: rec.localRecordId,
          medicineId: rec.medicineId,
          outcome: 'CONFLICT_ALREADY_COUNTED',
          confirmedEventId: null,
          confirmedCountRevision: null,
          conflictCode: updated.conflictCode,
          conflictDetail: updated.conflictDetail,
        });
        continue;
      }

      if (leaseRes.code === 'LEASE_CONFLICT_ACTIVE') {
        const updated: LocalPendingStocktakeCountRecord = {
          ...reconcilingRec,
          status: 'CONFLICT_ACTIVE_LEASE_HELD_BY_OTHER',
          isCloudLease: false,
          isSharedConfirmedCount: false,
          canPostInventoryAdjustment: false,
          conflictCode: 'ACTIVE_LEASE_HELD_BY_OTHER',
          // Fix A: Strictly generic conflict detail — ZERO holderUid or actor identity leaked!
          conflictDetail: 'Another counter holds an active cloud lease; offline count kept unresolved.',
          lastReconcileAttemptAtMs: attemptAtMs,
        };
        await store.put(updated);
        outcomes.push({
          localRecordId: rec.localRecordId,
          medicineId: rec.medicineId,
          outcome: 'CONFLICT_ACTIVE_LEASE_HELD_BY_OTHER',
          confirmedEventId: null,
          confirmedCountRevision: null,
          conflictCode: updated.conflictCode,
          conflictDetail: updated.conflictDetail,
        });
        continue;
      }

      const updated: LocalPendingStocktakeCountRecord = {
        ...reconcilingRec,
        status: 'CONFLICT_ITEM_MISSING',
        isCloudLease: false,
        isSharedConfirmedCount: false,
        canPostInventoryAdjustment: false,
        conflictCode: 'CLOUD_ITEM_NOT_FOUND',
        conflictDetail: 'Item no longer exists in cloud session.',
        lastReconcileAttemptAtMs: attemptAtMs,
      };
      await store.put(updated);
      outcomes.push({
        localRecordId: rec.localRecordId,
        medicineId: rec.medicineId,
        outcome: 'CONFLICT_ITEM_MISSING',
        confirmedEventId: null,
        confirmedCountRevision: null,
        conflictCode: updated.conflictCode,
        conflictDetail: updated.conflictDetail,
      });
      continue;
    }

    // 5. Submit atomic count preserving original offline watermark & deterministic leaseId
    const submitted = await submitStocktakeCountTx(db, {
      branchId: params.branchId,
      sessionId: params.sessionId,
      medicineId: rec.medicineId,
      actorUid: rec.actorUid,
      actorDisplayName: rec.actorDisplayName,
      actorRole: rec.actorRole,
      deviceId: rec.deviceId,
      countedQuantity: rec.countedQuantity,
      countUnit: rec.countUnit,
      baseUnitsPerCountUnit: rec.baseUnitsPerCountUnit,
      knownMovementIdsAtCount: rec.knownMovementIdsAtCount,
      countBusinessAtMs: rec.countBusinessAtMs,
      localPersistedAtMs: rec.localPersistedAtMs,
      notes: rec.notes,
    });

    const confirmedRec: LocalPendingStocktakeCountRecord = {
      ...reconcilingRec,
      status: 'CONFIRMED',
      isCloudLease: false,
      isSharedConfirmedCount: true,
      canPostInventoryAdjustment: false,
      confirmedEventId: submitted.eventId,
      confirmedCountRevision: submitted.countRevision,
      confirmedAtMs: Date.now(),
      conflictCode: null,
      conflictDetail: null,
      lastReconcileAttemptAtMs: attemptAtMs,
    };
    await store.put(confirmedRec);
    ownEventByLeaseId.set(expectedOfflineLeaseId, {
      eventId: submitted.eventId,
      countRevision: submitted.countRevision,
    });
    outcomes.push({
      localRecordId: rec.localRecordId,
      medicineId: rec.medicineId,
      outcome: 'SYNCED_CONFIRMED',
      confirmedEventId: submitted.eventId,
      confirmedCountRevision: submitted.countRevision,
      conflictCode: null,
      conflictDetail: null,
    });
  }

  return outcomes;
}

export interface CashierLocalPendingItemView {
  localRecordId: string;
  medicineId: string;
  medicineName: string;
  countedQuantity: number;
  countUnit: StocktakeCountUnit;
  status: 'LOCAL_PENDING' | 'RECONCILIATION_PENDING';
  isCloudLease: false;
  isSharedConfirmedCount: false;
  canPostInventoryAdjustment: false;
  localPersistedAtMs: number;
}

export interface CashierUnresolvedConflictView {
  localRecordId: string;
  medicineId: string;
  medicineName: string;
  countedQuantity: number;
  countUnit: StocktakeCountUnit;
  status: Exclude<LocalPendingRecordStatus, 'LOCAL_PENDING' | 'RECONCILIATION_PENDING' | 'CONFIRMED'>;
  conflictCode: string | null;
  conflictDetail: string | null;
}

export interface CashierCombinedStocktakeView {
  remainingItems: RemainingMedicinePublicView[];
  myConfirmedCounts: CashierOwnConfirmedCountView[];
  myLocalPendingCounts: CashierLocalPendingItemView[];
  myUnresolvedConflicts: CashierUnresolvedConflictView[];
}

/**
 * OD-4 / OD-2F-3 + OD-3 / OD-2F-2 Combined Cashier Operational View:
 * Merges cloud blind remaining list + cashier's own confirmed counts + cashier's own
 * LOCAL_PENDING/RECONCILIATION_PENDING captures + visible unresolved conflicts.
 * Strictly strips and fail-closed verifies ZERO systemStock, variance, buyPrice, cost,
 * valuation, profit, margin, or other-cashier count data!
 */
export async function buildCashierCombinedOfflineAndConfirmedView(
  db: Firestore,
  store: StocktakeSidecarStorageAdapter,
  params: {
    branchId: string;
    sessionId: string;
    cashierUid: string;
  }
): Promise<CashierCombinedStocktakeView> {
  const cloudViews = await loadCashierStocktakeOperationalViews(
    db,
    params.branchId,
    params.sessionId,
    params.cashierUid
  );
  const localRecords = await store.listBySessionAndActor(
    params.branchId,
    params.sessionId,
    params.cashierUid
  );

  const myLocalPendingCounts: CashierLocalPendingItemView[] = [];
  const myUnresolvedConflicts: CashierUnresolvedConflictView[] = [];

  for (const r of localRecords) {
    if (r.status === 'LOCAL_PENDING' || r.status === 'RECONCILIATION_PENDING') {
      myLocalPendingCounts.push({
        localRecordId: r.localRecordId,
        medicineId: r.medicineId,
        medicineName: r.medicineName,
        countedQuantity: r.countedQuantity,
        countUnit: r.countUnit,
        status: r.status,
        isCloudLease: false,
        isSharedConfirmedCount: false,
        canPostInventoryAdjustment: false,
        localPersistedAtMs: r.localPersistedAtMs,
      });
    } else if (r.status !== 'CONFIRMED') {
      myUnresolvedConflicts.push({
        localRecordId: r.localRecordId,
        medicineId: r.medicineId,
        medicineName: r.medicineName,
        countedQuantity: r.countedQuantity,
        countUnit: r.countUnit,
        status: r.status,
        conflictCode: r.conflictCode,
        conflictDetail: r.conflictDetail,
      });
    }
  }

  const combined: CashierCombinedStocktakeView = {
    remainingItems: cloudViews.remainingItems,
    myConfirmedCounts: cloudViews.myConfirmedCounts,
    myLocalPendingCounts,
    myUnresolvedConflicts,
  };

  assertSidecarRecordSafe(combined);
  return combined;
}
