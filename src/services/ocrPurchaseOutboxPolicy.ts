/**
 * Pure Outbox coalescing policies shared by manual and OCR purchase posting.
 *
 * This module intentionally has no IndexedDB, Firebase, Bankak, or runtime-context
 * dependencies. Callers inject the existing normalizer, actor validator and ID
 * generator so both posting paths retain the same canonical Outbox semantics.
 */

export interface PurchaseOutboxEntryLike {
  id: string;
  operationId?: string;
  idempotencyKey?: string;
  branchId?: string;
  actorUid?: string;
  schemaVersion?: number;
  entityType: string;
  entityId: string;
  action: string;
  payload?: { updatedAt?: string } | unknown;
  timestamp: string;
  retryCount?: number;
  attempts?: number;
  status: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  nextRetryAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  dependsOn?: string[];
}

export interface PurchaseOutboxEntityLike {
  id: string;
  updatedAt?: string;
}

export interface PurchaseOutboxPolicyDependencies<TEntry> {
  normalizeEntry(entry: TEntry): TEntry;
  isValidActorUid(value: unknown): value is string;
  generateId(): string;
}

export interface PurchaseOutboxWriteResult<TEntry> {
  targetEntry: TEntry;
  coalesced: boolean;
}

function isInFlightOrLeased(entry: PurchaseOutboxEntryLike): boolean {
  return entry.status === 'processing' ||
    entry.status === 'syncing' ||
    (typeof entry.leaseOwner === 'string' && entry.leaseOwner.trim().length > 0);
}

function entryFreshnessMs(entry: PurchaseOutboxEntryLike): number {
  const payload = entry.payload as { updatedAt?: string } | null | undefined;
  const payloadMs = Date.parse(payload?.updatedAt || '');
  const timestampMs = Date.parse(entry.timestamp || '');
  return Math.max(
    Number.isFinite(payloadMs) ? payloadMs : 0,
    Number.isFinite(timestampMs) ? timestampMs : 0
  );
}

function findCoalesceCandidate<TEntry extends PurchaseOutboxEntryLike>(
  entries: TEntry[],
  entityType: 'medicine' | 'supplier',
  entityId: string,
  incomingMs: number,
  latestProtectedMs: number,
  allowCoalesceCreate: boolean
): TEntry | null {
  const matching = entries.filter(entry =>
    entry && entry.entityType === entityType && entry.entityId === entityId
  );
  if (matching.some(entry => entryFreshnessMs(entry) > incomingMs)) return null;

  let candidate: TEntry | null = null;
  let bestCandidateMs = -1;
  for (const entry of matching) {
    if (isInFlightOrLeased(entry)) continue;
    if (entry.status !== 'pending' && entry.status !== 'retry' && entry.status !== 'failed') continue;
    if (entry.action !== 'CREATE' && entry.action !== 'UPDATE') continue;
    if (!allowCoalesceCreate && entry.action === 'CREATE') continue;
    const freshness = entryFreshnessMs(entry);
    if (freshness < latestProtectedMs || freshness > incomingMs) continue;
    if (freshness >= bestCandidateMs) {
      bestCandidateMs = freshness;
      candidate = entry;
    }
  }
  return candidate;
}

function latestProtectedFreshness<TEntry extends PurchaseOutboxEntryLike>(
  entries: TEntry[],
  entityType: 'medicine' | 'supplier',
  entityId: string
): number {
  let latest = 0;
  for (const entry of entries) {
    if (!entry || entry.entityType !== entityType || entry.entityId !== entityId) continue;
    if (
      isInFlightOrLeased(entry) ||
      entry.status === 'synced' ||
      entry.status === 'dead-letter' ||
      entry.status === 'blocked'
    ) {
      latest = Math.max(latest, entryFreshnessMs(entry));
    }
  }
  return latest;
}

export function resolveMedicineOutboxWriteShared<
  TEntry extends PurchaseOutboxEntryLike,
  TMedicine extends PurchaseOutboxEntityLike
>(
  params: {
    existingEntries: TEntry[];
    medicine: TMedicine;
    actuallyNew: boolean;
    knownBranchId?: string;
    knownActorUid?: string;
    nowIso: string;
    incomingFreshnessMs?: number;
  },
  deps: PurchaseOutboxPolicyDependencies<TEntry>
): PurchaseOutboxWriteResult<TEntry> {
  const { existingEntries, medicine, actuallyNew, knownBranchId, knownActorUid, nowIso, incomingFreshnessMs } = params;
  const incomingRaw = typeof incomingFreshnessMs === 'number' && Number.isFinite(incomingFreshnessMs)
    ? incomingFreshnessMs
    : Date.parse(medicine.updatedAt || nowIso);
  const incomingMs = Number.isFinite(incomingRaw) ? incomingRaw : Date.now();
  const latestProtectedMs = latestProtectedFreshness(existingEntries, 'medicine', medicine.id);
  const candidate = findCoalesceCandidate(existingEntries, 'medicine', medicine.id, incomingMs, latestProtectedMs, true);
  const validActorUid = deps.isValidActorUid(knownActorUid) ? knownActorUid : undefined;

  if (candidate) {
    const normalized = deps.normalizeEntry(candidate) as TEntry & PurchaseOutboxEntryLike;
    const action: 'CREATE' | 'UPDATE' =
      normalized.action === 'CREATE' ? 'CREATE' : actuallyNew ? 'CREATE' : 'UPDATE';
    const candidateActor = deps.isValidActorUid(normalized.actorUid) ? normalized.actorUid : undefined;
    const resolvedActor = validActorUid || candidateActor;
    const updated = {
      ...normalized,
      action,
      idempotencyKey: `medicine:${action}:${medicine.id}`,
      ...(knownBranchId && !normalized.branchId ? { branchId: knownBranchId } : {}),
      ...(resolvedActor ? { actorUid: resolvedActor } : {}),
      payload: medicine,
      timestamp: nowIso,
      status: 'pending'
    } as TEntry & PurchaseOutboxEntryLike;
    if (!resolvedActor) delete updated.actorUid;
    delete updated.leaseOwner;
    delete updated.leaseExpiresAt;
    delete updated.nextRetryAt;
    delete updated.lastErrorCode;
    delete updated.lastErrorMessage;
    return { targetEntry: updated as TEntry, coalesced: true };
  }

  const id = deps.generateId();
  const action: 'CREATE' | 'UPDATE' = actuallyNew ? 'CREATE' : 'UPDATE';
  const fresh = {
    id,
    operationId: id,
    idempotencyKey: `medicine:${action}:${medicine.id}`,
    ...(knownBranchId ? { branchId: knownBranchId } : {}),
    ...(validActorUid ? { actorUid: validActorUid } : {}),
    schemaVersion: 1,
    entityType: 'medicine',
    entityId: medicine.id,
    action,
    payload: medicine,
    timestamp: nowIso,
    retryCount: 0,
    attempts: 0,
    status: 'pending'
  } as TEntry;
  return { targetEntry: fresh, coalesced: false };
}

export function resolveSupplierOutboxWriteShared<
  TEntry extends PurchaseOutboxEntryLike,
  TSupplier extends PurchaseOutboxEntityLike
>(
  params: {
    existingEntries: TEntry[];
    supplier: TSupplier;
    actuallyNew: boolean;
    allowCoalesceCreate?: boolean;
    knownBranchId?: string;
    knownActorUid?: string;
    nowIso: string;
    incomingFreshnessMs?: number;
  },
  deps: PurchaseOutboxPolicyDependencies<TEntry>
): PurchaseOutboxWriteResult<TEntry> {
  const {
    existingEntries, supplier, actuallyNew, allowCoalesceCreate = true,
    knownBranchId, knownActorUid, nowIso, incomingFreshnessMs
  } = params;
  const incomingRaw = typeof incomingFreshnessMs === 'number' && Number.isFinite(incomingFreshnessMs)
    ? incomingFreshnessMs
    : Date.parse(supplier.updatedAt || nowIso);
  const incomingMs = Number.isFinite(incomingRaw) ? incomingRaw : Date.now();
  const latestProtectedMs = latestProtectedFreshness(existingEntries, 'supplier', supplier.id);
  const candidate = findCoalesceCandidate(
    existingEntries, 'supplier', supplier.id, incomingMs, latestProtectedMs, allowCoalesceCreate
  );
  const validActorUid = deps.isValidActorUid(knownActorUid) ? knownActorUid : undefined;

  if (candidate) {
    const normalized = deps.normalizeEntry(candidate) as TEntry & PurchaseOutboxEntryLike;
    const action: 'CREATE' | 'UPDATE' =
      normalized.action === 'CREATE' ? 'CREATE' : actuallyNew ? 'CREATE' : 'UPDATE';
    const candidateActor = deps.isValidActorUid(normalized.actorUid) ? normalized.actorUid : undefined;
    const resolvedActor = validActorUid || candidateActor;
    const updated = {
      ...normalized,
      action,
      idempotencyKey: `supplier:${action}:${supplier.id}`,
      ...(knownBranchId && !normalized.branchId ? { branchId: knownBranchId } : {}),
      ...(resolvedActor ? { actorUid: resolvedActor } : {}),
      payload: supplier,
      timestamp: nowIso,
      status: 'pending'
    } as TEntry & PurchaseOutboxEntryLike;
    if (!resolvedActor) delete updated.actorUid;
    delete updated.leaseOwner;
    delete updated.leaseExpiresAt;
    delete updated.nextRetryAt;
    delete updated.lastErrorCode;
    delete updated.lastErrorMessage;
    return { targetEntry: updated as TEntry, coalesced: true };
  }

  const id = deps.generateId();
  const action: 'CREATE' | 'UPDATE' = actuallyNew ? 'CREATE' : 'UPDATE';
  const fresh = {
    id,
    operationId: id,
    idempotencyKey: `supplier:${action}:${supplier.id}`,
    ...(knownBranchId ? { branchId: knownBranchId } : {}),
    ...(validActorUid ? { actorUid: validActorUid } : {}),
    schemaVersion: 1,
    entityType: 'supplier',
    entityId: supplier.id,
    action,
    payload: supplier,
    timestamp: nowIso,
    retryCount: 0,
    attempts: 0,
    status: 'pending'
  } as TEntry;
  return { targetEntry: fresh, coalesced: false };
}
