// TEST-ONLY ISOLATION SHIM — not copied from the protected production file.
// PR-F3 asserts that Outbox V2 remains disabled during offline stocktake tests.
export const DEFAULT_OUTBOX_V2_WORKER_ENABLED = false as const;
export function isOutboxV2WorkerEnabled(): boolean { return false; }
export function setOutboxV2WorkerEnabledOverride(_enabled: boolean | null): void {
  if (_enabled !== null && typeof _enabled !== 'boolean') throw new Error('INVALID_FEATURE_FLAG');
}
export function registerOutboxV2CoordinatorHooks(_hooks: unknown): void {}
export async function triggerOutboxV2SyncIfEnabled(): Promise<{status:'disabled';reason:'OUTBOX_V2_WORKER_DISABLED'}> {
  return { status: 'disabled', reason: 'OUTBOX_V2_WORKER_DISABLED' };
}
export async function isEntityManagedByOutboxV2WhenEnabled(): Promise<boolean> { return false; }
