/** Pure FEFO allocation validator shared by inventory transactions and tests. */
export interface BatchMovementLike {
  batchNumber?: string;
  expiry?: string;
  baseUnitsDelta?: number;
}

export interface FefoAllocationResult {
  allocations: Map<string, number>;
  remaining: number;
}

export function calculateFefoBatchAllocation(
  movements: BatchMovementLike[],
  requestedBaseUnits: number,
  today: string
): FefoAllocationResult {
  if (!Number.isSafeInteger(requestedBaseUnits) || requestedBaseUnits < 0) {
    throw new Error('الكمية الأساسية المطلوبة يجب أن تكون عدداً صحيحاً غير سالب');
  }
  const batches = new Map<string, { quantity: number; expiry: string }>();
  for (const movement of movements) {
    const batchNumber = movement.batchNumber || 'DEFAULT';
    const current = batches.get(batchNumber) || { quantity: 0, expiry: movement.expiry || '2099-12-31' };
    current.quantity += Number(movement.baseUnitsDelta) || 0;
    if (movement.expiry) current.expiry = movement.expiry;
    batches.set(batchNumber, current);
  }

  const eligible = Array.from(batches.entries())
    .filter(([, batch]) => batch.quantity > 0 && batch.expiry >= today)
    .sort((a, b) => a[1].expiry.localeCompare(b[1].expiry) || a[0].localeCompare(b[0]));

  let remaining = requestedBaseUnits;
  const allocations = new Map<string, number>();
  for (const [batchNumber, batch] of eligible) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantity, remaining);
    if (take > 0) allocations.set(batchNumber, take);
    remaining -= take;
  }
  return { allocations, remaining };
}

export function allocationsMatch(
  planned: Map<string, number>,
  expected: Map<string, number>
): boolean {
  const batches = new Set([...planned.keys(), ...expected.keys()]);
  for (const batch of batches) {
    if ((planned.get(batch) || 0) !== (expected.get(batch) || 0)) return false;
  }
  return true;
}
