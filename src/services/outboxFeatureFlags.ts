export const DEFAULT_OUTBOX_V2_WORKER_ENABLED = false as const;

let runtimeOutboxV2EnabledOverride: boolean | null = null;

export interface OutboxV2DisabledTriggerResult {
  status: 'disabled';
  reason: 'OUTBOX_V2_WORKER_DISABLED';
}

export type OutboxV2SyncHook = (context?: {
  reason?: string;
  actorUid?: string;
  branchId?: string;
}) => Promise<unknown>;

export type OutboxV2EntityManagedChecker = (params: {
  branchId: string;
  entityType: 'sale' | 'medicine';
  entityId: string;
  actorUid: string;
}) => Promise<boolean>;

let registeredSyncHook: OutboxV2SyncHook | null = null;
let registeredEntityManagedChecker: OutboxV2EntityManagedChecker | null = null;

/**
 * Outbox V2 Cloud Sync Worker Feature Flag.
 * Remains strictly DISABLED (false) by default during Phase 2D-3B-2b.2 so
 * no automatic Firestore uploads are executed until explicit Phase 2D-3B-3 activation.
 */
export function isOutboxV2WorkerEnabled(): boolean {
  if (runtimeOutboxV2EnabledOverride !== null) {
    return runtimeOutboxV2EnabledOverride;
  }
  return DEFAULT_OUTBOX_V2_WORKER_ENABLED;
}

/**
 * Explicit runtime toggle intended exclusively for controlled tests or explicit gate activation.
 * Passing null restores DEFAULT_OUTBOX_V2_WORKER_ENABLED (false).
 */
export function setOutboxV2WorkerEnabledOverride(enabled: boolean | null): void {
  if (enabled === null) {
    runtimeOutboxV2EnabledOverride = null;
    return;
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('INVALID_FEATURE_FLAG: outbox V2 worker flag must be boolean or null');
  }
  runtimeOutboxV2EnabledOverride = enabled;
}

export function registerOutboxV2CoordinatorHooks(hooks: {
  runSyncIfEnabled?: OutboxV2SyncHook | null;
  isEntityManagedByOutboxV2?: OutboxV2EntityManagedChecker | null;
}): void {
  if ('runSyncIfEnabled' in hooks) {
    registeredSyncHook = hooks.runSyncIfEnabled ?? null;
  }
  if ('isEntityManagedByOutboxV2' in hooks) {
    registeredEntityManagedChecker = hooks.isEntityManagedByOutboxV2 ?? null;
  }
}

export async function triggerOutboxV2SyncIfEnabled(context?: {
  reason?: string;
  actorUid?: string;
  branchId?: string;
}): Promise<OutboxV2DisabledTriggerResult | unknown> {
  if (!isOutboxV2WorkerEnabled() || !registeredSyncHook) {
    return {
      status: 'disabled',
      reason: 'OUTBOX_V2_WORKER_DISABLED',
    };
  }
  return registeredSyncHook(context);
}

export async function isEntityManagedByOutboxV2WhenEnabled(params: {
  branchId: string;
  entityType: 'sale' | 'medicine';
  entityId: string;
  actorUid: string;
}): Promise<boolean> {
  if (!isOutboxV2WorkerEnabled()) {
    return false;
  }
  if (!registeredEntityManagedChecker) {
    // Fail closed while V2 is enabled if coordinator hook is not registered yet
    return true;
  }
  try {
    return await registeredEntityManagedChecker(params);
  } catch {
    // Fail closed when V2 is enabled and outbox inspection errors to prevent dual V1/V2 writes
    return true;
  }
}
