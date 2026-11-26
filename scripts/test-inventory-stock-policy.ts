/** Phase 2-B regression tests for FEFO stock allocation and stale-sale protection. */
import { allocationsMatch, calculateFefoBatchAllocation } from '../src/services/inventoryStockPolicy.ts';
let passed = 0;
let total = 0;
function assert(condition: boolean, message: string): void {
  total++;
  if (!condition) throw new Error(`FAIL: ${message}`);
  passed++;
  console.log(`✓ ${message}`);
}
const stock = [
  { batchNumber: 'B-LATE', expiry: '2027-12-31', baseUnitsDelta: 100 },
  { batchNumber: 'B-EARLY', expiry: '2027-01-31', baseUnitsDelta: 30 },
  { batchNumber: 'B-EXPIRED', expiry: '2025-01-01', baseUnitsDelta: 500 },
  { batchNumber: 'B-EARLY', expiry: '2027-01-31', baseUnitsDelta: -5 }
];
const plan = calculateFefoBatchAllocation(stock, 40, '2026-11-08');
assert(plan.remaining === 0, 'Available unexpired stock satisfies request');
assert(plan.allocations.get('B-EARLY') === 25, 'FEFO consumes earliest-expiry batch first');
assert(plan.allocations.get('B-LATE') === 15, 'FEFO spills remaining quantity into next batch');
assert(!plan.allocations.has('B-EXPIRED'), 'Expired stock is never allocated');
assert(allocationsMatch(plan.allocations, new Map([['B-EARLY', 25], ['B-LATE', 15]])), 'Identical allocation plan passes stale-plan check');
assert(!allocationsMatch(plan.allocations, new Map([['B-LATE', 40]])), 'Changed batch allocation is rejected to preserve FEFO');
const insufficient = calculateFefoBatchAllocation(stock, 200, '2026-11-08');
assert(insufficient.remaining === 75, 'Insufficient stock is reported without negative allocation');
const sameDay = calculateFefoBatchAllocation([{ batchNumber: 'TODAY', expiry: '2026-11-08', baseUnitsDelta: 3 }], 3, '2026-11-08');
assert(sameDay.remaining === 0, 'Batch expiring today remains eligible for current-day sale');
console.log(`\nSUMMARY: ${passed}/${total} assertions passed`);
