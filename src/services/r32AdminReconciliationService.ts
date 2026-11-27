/**
 * Phase 2E-B.3 (R3.2 Gap 3) — Admin Financial Reconciliation Concurrency Service
 *
 * Implements Spark-only Firestore `runTransaction` concurrency leases for `sales_financials/{saleId}`,
 * immutable `inventory_financials/{movementId}` writes, and append-only `reconciliation_operations/{opId}`.
 *
 * Enforces:
 * - Single active Admin reconciler via server-time `leaseExpiresAt` + monotonic `leaseVersion` CAS.
 * - Expired-lease crash recovery takeover after `leaseExpiresAt`.
 * - Terminal immutability once `reconciliationStatus == 'EXACT_RECONCILED'`.
 * - Fail-closed `NEEDS_REVIEW` when any ledger movement lacks exact historical cost provenance.
 */

import {
  doc,
  runTransaction,
  serverTimestamp,
  Timestamp,
  type Firestore,
} from 'firebase/firestore';
import {
  addRational,
  rationalFromNumber,
  subRational,
  type ExactRational,
  type MovementCostResult,
} from './r32FinancialSplitContract';

export interface ClaimReconciliationLeaseResult {
  claimed: boolean;
  leaseVersion: number;
  status: 'RECONCILING' | 'ALREADY_RECONCILED' | 'LEASE_HELD_BY_OTHER';
  leaseOwnerUid?: string;
}

export async function claimOrTakeoverSaleReconciliationLease(
  db: Firestore,
  branchId: string,
  saleId: string,
  adminUid: string,
  expectedFinancialLedgerCount: number,
  leaseDurationMs = 120_000
): Promise<ClaimReconciliationLeaseResult> {
  if (leaseDurationMs <= 0 || leaseDurationMs > 290_000) {
    throw new Error('LEASE_DURATION_OUT_OF_RULES_BOUNDS');
  }
  const ref = doc(db, 'branches', branchId, 'sales_financials', saleId);

  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const nowMs = Date.now();
    const leaseExpiresAt = Timestamp.fromMillis(nowMs + leaseDurationMs);

    if (!snap.exists()) {
      tx.set(ref, {
        id: saleId,
        branchId,
        saleId,
        reconciliationStatus: 'RECONCILING',
        leaseOwnerUid: adminUid,
        leaseExpiresAt,
        leaseVersion: 1,
        expectedFinancialLedgerCount,
        verifiedFinancialLedgerCount: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return {
        claimed: true,
        leaseVersion: 1,
        status: 'RECONCILING',
        leaseOwnerUid: adminUid,
      };
    }

    const data = snap.data() as Record<string, unknown>;
    const currentStatus = String(data.reconciliationStatus ?? '');
    if (currentStatus === 'EXACT_RECONCILED') {
      return {
        claimed: false,
        leaseVersion: Number(data.leaseVersion ?? 0),
        status: 'ALREADY_RECONCILED',
      };
    }

    const prevVersion = Number(data.leaseVersion ?? 0);
    const prevExpires = data.leaseExpiresAt as Timestamp | null | undefined;
    const isExpired = !prevExpires || nowMs > prevExpires.toMillis();

    if (
      currentStatus === 'RECONCILING' &&
      !isExpired &&
      data.leaseOwnerUid !== adminUid
    ) {
      return {
        claimed: false,
        leaseVersion: prevVersion,
        status: 'LEASE_HELD_BY_OTHER',
        leaseOwnerUid: String(data.leaseOwnerUid ?? ''),
      };
    }

    if (currentStatus === 'RECONCILING' && !isExpired && data.leaseOwnerUid === adminUid) {
      return {
        claimed: true,
        leaseVersion: prevVersion,
        status: 'RECONCILING',
        leaseOwnerUid: adminUid,
      };
    }

    const nextVersion = prevVersion + 1;
    tx.update(ref, {
      reconciliationStatus: 'RECONCILING',
      leaseOwnerUid: adminUid,
      leaseExpiresAt,
      leaseVersion: nextVersion,
      updatedAt: serverTimestamp(),
    });

    return {
      claimed: true,
      leaseVersion: nextVersion,
      status: 'RECONCILING',
      leaseOwnerUid: adminUid,
    };
  });
}

export interface FinalizeSaleReconciliationInput {
  branchId: string;
  saleId: string;
  adminUid: string;
  expectedLeaseVersion: number;
  saleSubtotal: number;
  saleTotal: number;
  movementResults: MovementCostResult[];
  operationId: string;
}

export async function finalizeSaleFinancialReconciliation(
  db: Firestore,
  input: FinalizeSaleReconciliationInput
): Promise<{
  status: 'EXACT_RECONCILED' | 'NEEDS_REVIEW';
  unresolvedBaseUnits: number;
}> {
  const sfRef = doc(
    db,
    'branches',
    input.branchId,
    'sales_financials',
    input.saleId
  );
  const opRef = doc(
    db,
    'branches',
    input.branchId,
    'reconciliation_operations',
    input.operationId
  );

  let totalCogs: ExactRational = { num: 0, den: 1 };
  let unresolvedBaseUnits = 0;
  let allProvenanceValid = input.movementResults.length > 0;
  const normalizedResults: MovementCostResult[] = input.movementResults.map((mr) => {
    const hasValidProvenance =
      mr.costStatus === 'EXACT_RECONCILED' &&
      mr.unresolvedBaseUnits === 0 &&
      mr.costPerBaseUnitExact != null &&
      mr.totalCostExact != null &&
      mr.costPerBaseUnitExact.den > 0 &&
      mr.costPerBaseUnitExact.num >= 0 &&
      mr.totalCostExact.den > 0;
    if (!hasValidProvenance) {
      allProvenanceValid = false;
      const fallbackUnresolved = mr.unresolvedBaseUnits > 0 ? mr.unresolvedBaseUnits : 1;
      unresolvedBaseUnits += fallbackUnresolved;
      return {
        ...mr,
        costStatus: 'NEEDS_REVIEW',
        costPerBaseUnitExact: null,
        costPerUnitExact: null,
        totalCostExact: null,
        unresolvedBaseUnits: fallbackUnresolved,
      };
    }
    totalCogs = addRational(totalCogs, mr.totalCostExact!);
    return mr;
  });

  const finalStatus: 'EXACT_RECONCILED' | 'NEEDS_REVIEW' =
    unresolvedBaseUnits === 0 && allProvenanceValid
      ? 'EXACT_RECONCILED'
      : 'NEEDS_REVIEW';

  const subtotalRat = rationalFromNumber(input.saleSubtotal);
  const totalRat = rationalFromNumber(input.saleTotal);
  const grossProfitExact =
    finalStatus === 'EXACT_RECONCILED'
      ? subRational(subtotalRat, totalCogs)
      : null;
  const netProfitExact =
    finalStatus === 'EXACT_RECONCILED'
      ? subRational(totalRat, totalCogs)
      : null;

  await runTransaction(db, async (tx) => {
    const sfSnap = await tx.get(sfRef);
    if (!sfSnap.exists()) {
      throw new Error('SALE_FINANCIAL_DOC_MISSING');
    }
    const existing = sfSnap.data() as Record<string, unknown>;
    if (existing.reconciliationStatus !== 'RECONCILING') {
      throw new Error(`INVALID_RECONCILIATION_STATE:${existing.reconciliationStatus}`);
    }
    if (existing.leaseOwnerUid !== input.adminUid) {
      throw new Error('LEASE_NOT_OWNED_BY_ACTOR');
    }
    if (Number(existing.leaseVersion) !== input.expectedLeaseVersion) {
      throw new Error('STALE_RECONCILIATION_LEASE_VERSION');
    }

    // Read existing inventory_financials first (Firestore requires all reads before writes)
    const invRefs = normalizedResults.map((mr) =>
      doc(db, 'branches', input.branchId, 'inventory_financials', mr.movementId)
    );
    const invSnaps = await Promise.all(invRefs.map((r) => tx.get(r)));

    for (let i = 0; i < normalizedResults.length; i++) {
      if (!invSnaps[i].exists()) {
        const mr = normalizedResults[i];
        tx.set(invRefs[i], {
          id: mr.movementId,
          branchId: input.branchId,
          movementId: mr.movementId,
          medicineId: mr.medicineId,
          movementType: mr.movementType,
          costPerUnitExact: mr.costPerUnitExact,
          costPerBaseUnitExact: mr.costPerBaseUnitExact,
          totalCostExact: mr.totalCostExact,
          ...(mr.purchaseReturnVarianceExact !== undefined
            ? { purchaseReturnVarianceExact: mr.purchaseReturnVarianceExact }
            : {}),
          costStatus: mr.costStatus,
          costProvenanceType: mr.costProvenanceType,
          ...(mr.sourceReferenceId ? { sourceReferenceId: mr.sourceReferenceId } : {}),
          unresolvedBaseUnits: mr.unresolvedBaseUnits,
          reconciledByUid: input.adminUid,
          ...(mr.notes ? { notes: mr.notes } : {}),
          createdAt: serverTimestamp(),
        });
      }
    }

    tx.update(sfRef, {
      reconciliationStatus: finalStatus,
      verifiedFinancialLedgerCount: normalizedResults.length,
      costOfGoodsExact: finalStatus === 'EXACT_RECONCILED' ? totalCogs : null,
      grossProfitExact,
      netProfitExact,
      unresolvedBaseUnits,
      reconciledByUid: input.adminUid,
      reconciledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    tx.set(opRef, {
      id: input.operationId,
      branchId: input.branchId,
      operationType: 'SALE_RECONCILIATION',
      targetId: input.saleId,
      actorUid: input.adminUid,
      status: finalStatus === 'EXACT_RECONCILED' ? 'COMPLETED' : 'NEEDS_REVIEW',
      details: `Reconciled ${normalizedResults.length} ledger rows (unresolved=${unresolvedBaseUnits})`,
      createdAt: serverTimestamp(),
    });
  });

  return { status: finalStatus, unresolvedBaseUnits };
}
