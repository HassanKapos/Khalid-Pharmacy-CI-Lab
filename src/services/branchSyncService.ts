import {
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  Firestore,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  getFirebaseServices,
  handleFirestoreError,
  isBrowserOffline,
  OperationType,
} from './firebaseClient';
import { errorLogService } from './errorLogService';
import {
  areCanonicalTimestampsEqual,
  detectLockedPackingViolations,
  detectMedicineSyncConflict,
  extractCanonicalTimestampMillis,
  isCloudSaleReconciled,
  LOCKED_MEDICINE_IMMUTABLE_FIELDS,
  prepareMedicineFirestoreV2Payload,
  reconcileRemoteSaleExpectedLedgerIds,
  serializePackingLockedAt,
  SPARK_DIRECT_COMPLETE_MAX_DOC_ACCESS_BUDGET,
  SPARK_DIRECT_COMPLETE_MAX_LEDGERS,
  SPARK_LEDGER_VERIFICATION_SLICE_SIZE,
  validateExistingSaleLedgerMovement,
  type ExistingLedgerValidationResult,
  type MedicineSyncConflictReport,
  type MedicineV2PayloadResolution,
  type SaleRecoveryExpectedLedgerCheck,
} from './sparkDirectSyncContract';
export {
  areCanonicalTimestampsEqual,
  detectLockedPackingViolations,
  detectMedicineSyncConflict,
  extractCanonicalTimestampMillis,
  isCloudSaleReconciled,
  LOCKED_MEDICINE_IMMUTABLE_FIELDS,
  prepareMedicineFirestoreV2Payload,
  reconcileRemoteSaleExpectedLedgerIds,
  serializePackingLockedAt,
  SPARK_DIRECT_COMPLETE_MAX_DOC_ACCESS_BUDGET,
  SPARK_DIRECT_COMPLETE_MAX_LEDGERS,
  SPARK_LEDGER_VERIFICATION_SLICE_SIZE,
  validateExistingSaleLedgerMovement,
  type ExistingLedgerValidationResult,
  type MedicineSyncConflictReport,
  type MedicineV2PayloadResolution,
  type SaleRecoveryExpectedLedgerCheck,
};
import {
  canSessionPerformAdminOperation,
  computeInviteId,
  DEFAULT_BRANCH_DEFINITIONS,
  type PharmacyRole,
  type PharmacySession,
} from './firebaseAuthService';
import {
  isEntityManagedByOutboxV2WhenEnabled,
  isOutboxV2WorkerEnabled,
  triggerOutboxV2SyncIfEnabled,
} from './outboxFeatureFlags';
import { openPharmacyDB, withLocalFirstMutationMutex, assertLocalFirstMutationMutexLeaseCurrent } from './pharmacyDb';

export interface PharmacyBranchRecord {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  city?: string;
  phone?: string;
  active: boolean;
  adminUids: string[];
  memberUids: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface StaffProfileRecord {
  uid: string;
  email: string;
  displayName: string;
  role: PharmacyRole;
  branchIds: string[];
  activeBranchId?: string | null;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface StaffInviteRecord {
  id: string;
  email: string;
  displayName: string;
  role: PharmacyRole;
  branchIds: string[];
  active: boolean;
  invitedByUid: string;
  claimedUid?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface BranchAuditLogRecord {
  id: string;
  branchId: string;
  actorUid: string;
  actorEmail?: string;
  actorRole: PharmacyRole;
  action: string;
  targetId?: string;
  details?: string;
  createdAt?: string;
}

const activeUnsubs: Unsubscribe[] = [];

function normalizeTimestamp(val: unknown): string {
  if (val instanceof Timestamp) return val.toDate().toISOString();
  if (val && typeof (val as any).toDate === 'function') {
    try {
      return (val as any).toDate().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
  if (typeof val === 'string') return val;
  return new Date().toISOString();
}

function isPermissionDenied(error: unknown): boolean {
  const code = (error as any)?.code;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  return code === 'permission-denied' || msg.includes('missing or insufficient permissions');
}

function isOffline(error: unknown): boolean {
  const code = (error as any)?.code;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  return code === 'unavailable' || msg.includes('client is offline') || msg.includes('network');
}

export function sanitizeFirestoreId(raw: string, prefix = 'rec'): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  return cleaned || `${prefix}-${Date.now()}`;
}

export function unsubscribeAllBranchListeners(): void {
  while (activeUnsubs.length > 0) {
    const unsub = activeUnsubs.pop();
    try {
      unsub?.();
    } catch {
      // ignore cleanup errors
    }
  }
}

function assertLiveAdminSession(session: PharmacySession, requireSuperAdmin = false): void {
  if (!session || session.emailVerified !== true) {
    throw new Error('يلزم التحقق من الهوية وتأكيد البريد الإلكتروني أولاً.');
  }
  if (session.offlineFallback === true || isBrowserOffline()) {
    throw new Error('العمليات الإدارية متاحة عند الاتصال المباشر بالإنترنت فقط (ممنوعة في وضع Offline).');
  }
  if (!canSessionPerformAdminOperation(session, !isBrowserOffline())) {
    throw new Error('غير مصرح بتنفيذ هذه العملية الإدارية.');
  }
  if (requireSuperAdmin && session.role !== 'super_admin') {
    throw new Error('هذه العملية متاحة لمدير النظام (Super Admin) فقط.');
  }
}

export async function listAccessibleBranches(session: PharmacySession): Promise<PharmacyBranchRecord[]> {
  const { db } = getFirebaseServices();
  const branches: PharmacyBranchRecord[] = [];
  const seen = new Set<string>();
  let permissionDeniedBranches = 0;

  try {
    if (session.role === 'super_admin') {
      const snap = await getDocs(collection(db, 'branches'));
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        const item: PharmacyBranchRecord = {
          id: docSnap.id,
          code: d.code || docSnap.id,
          nameAr: d.nameAr || docSnap.id,
          nameEn: d.nameEn || docSnap.id,
          city: d.city || '',
          phone: d.phone || '',
          active: d.active !== false,
          adminUids: Array.isArray(d.adminUids) ? d.adminUids : [],
          memberUids: Array.isArray(d.memberUids) ? d.memberUids : [],
          createdAt: normalizeTimestamp(d.createdAt),
          updatedAt: normalizeTimestamp(d.updatedAt),
        };
        seen.add(item.id);
        branches.push(item);
      });
    } else {
      const q = query(
        collection(db, 'branches'),
        where('memberUids', 'array-contains', session.uid),
        where('active', '==', true)
      );
      try {
        const snap = await getDocs(q);
        snap.forEach((docSnap) => {
          const d = docSnap.data();
          if (d.active !== true) return;
          seen.add(docSnap.id);
          branches.push({
            id: docSnap.id,
            code: d.code || docSnap.id,
            nameAr: d.nameAr || docSnap.id,
            nameEn: d.nameEn || docSnap.id,
            city: d.city || '',
            phone: d.phone || '',
            active: true,
            adminUids: Array.isArray(d.adminUids) ? d.adminUids : [],
            memberUids: Array.isArray(d.memberUids) ? d.memberUids : [],
            createdAt: normalizeTimestamp(d.createdAt),
            updatedAt: normalizeTimestamp(d.updatedAt),
          });
        });
      } catch (queryErr) {
        // Fallback to direct getDoc on each assigned branch ID (e.g. if composite index is still building)
        void errorLogService.recordError({
          level: 'warning',
          source: 'branchSyncService',
          operation: 'listAccessibleBranches(query)',
          correlationId: session.uid,
          error: queryErr,
        });
      }

      for (const bid of session.branchIds) {
        if (seen.has(bid)) continue;
        try {
          const docSnap = await getDoc(doc(db, 'branches', bid));
          if (docSnap.exists()) {
            const d = docSnap.data();
            if (d.active !== true) continue;
            seen.add(docSnap.id);
            branches.push({
              id: docSnap.id,
              code: d.code || docSnap.id,
              nameAr: d.nameAr || docSnap.id,
              nameEn: d.nameEn || docSnap.id,
              city: d.city || '',
              phone: d.phone || '',
              active: true,
              adminUids: Array.isArray(d.adminUids) ? d.adminUids : [],
              memberUids: Array.isArray(d.memberUids) ? d.memberUids : [],
              createdAt: normalizeTimestamp(d.createdAt),
              updatedAt: normalizeTimestamp(d.updatedAt),
            });
          }
        } catch (err) {
          if (isPermissionDenied(err)) {
            // A disabled branch (active == false) intentionally denies non-super-admin reads.
            // Log diagnostically and skip so other active assigned branches still load cleanly.
            permissionDeniedBranches += 1;
            void errorLogService.recordError({
              level: 'warning',
              source: 'branchSyncService',
              operation: `listAccessibleBranches(skipDisabled:${bid})`,
              correlationId: bid,
              error: err,
            });
            continue;
          }
          if (!isOffline(err)) {
            void errorLogService.recordError({
              level: 'warning',
              source: 'branchSyncService',
              operation: `listAccessibleBranches(get:${bid})`,
              correlationId: bid,
              error: err,
            });
          }
        }
      }
    }
  } catch (error) {
    if (isPermissionDenied(error)) {
      handleFirestoreError(error, OperationType.LIST, 'branches');
    }
    if (!isOffline(error)) throw error;
  }

  if (branches.length === 0 && !(permissionDeniedBranches > 0 && permissionDeniedBranches >= session.branchIds.length)) {
    const allowedDefaults =
      session.role === 'super_admin'
        ? DEFAULT_BRANCH_DEFINITIONS
        : DEFAULT_BRANCH_DEFINITIONS.filter((b) => session.branchIds.includes(b.id));
    return allowedDefaults.map((b) => ({
      ...b,
      adminUids: [],
      memberUids: [session.uid],
    }));
  }

  return branches.sort((a, b) => a.code.localeCompare(b.code));
}

export async function createBranch(
  session: PharmacySession,
  input: { id?: string; code: string; nameAr: string; nameEn: string; city?: string; phone?: string }
): Promise<PharmacyBranchRecord> {
  if (session.role !== 'super_admin') {
    throw new Error('إنشاء الفروع الجديدة متاح لمدير النظام (Super Admin) فقط.');
  }
  assertLiveAdminSession(session, true);

  const { db } = getFirebaseServices();
  const branchId = sanitizeFirestoreId(input.id || input.code || `branch-${Date.now()}`, 'branch');
  const branchRef = doc(db, 'branches', branchId);
  const path = `branches/${branchId}`;

  const payload = {
    id: branchId,
    code: String(input.code || branchId).trim().slice(0, 32),
    nameAr: String(input.nameAr || '').trim().slice(0, 120),
    nameEn: String(input.nameEn || input.nameAr || '').trim().slice(0, 120),
    city: String(input.city || '').trim().slice(0, 120),
    phone: String(input.phone || '').trim().slice(0, 40),
    active: true,
    adminUids: [session.uid],
    memberUids: [session.uid],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(branchRef, payload);
  } catch (error) {
    if (isPermissionDenied(error)) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
    throw error;
  }

  await writeBranchAuditLog(session, branchId, 'BRANCH_CREATED', branchId, payload.nameAr);

  return {
    ...payload,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function updateBranch(
  session: PharmacySession,
  branchId: string,
  patch: Partial<Pick<PharmacyBranchRecord, 'code' | 'nameAr' | 'nameEn' | 'city' | 'phone' | 'active'>>
): Promise<void> {
  if (session.role !== 'super_admin') {
    throw new Error('تعديل بيانات الفروع أو تعطيلها متاح لمدير النظام (Super Admin) فقط.');
  }
  assertLiveAdminSession(session, true);

  const { db } = getFirebaseServices();
  const path = `branches/${branchId}`;
  const updateData: Record<string, any> = {
    updatedAt: serverTimestamp(),
  };
  if (patch.code !== undefined) updateData.code = String(patch.code).trim().slice(0, 32);
  if (patch.nameAr !== undefined) updateData.nameAr = String(patch.nameAr).trim().slice(0, 120);
  if (patch.nameEn !== undefined) updateData.nameEn = String(patch.nameEn).trim().slice(0, 120);
  if (patch.city !== undefined) updateData.city = String(patch.city).trim().slice(0, 120);
  if (patch.phone !== undefined) updateData.phone = String(patch.phone).trim().slice(0, 40);
  if (patch.active !== undefined) updateData.active = Boolean(patch.active);

  try {
    await updateDoc(doc(db, 'branches', branchId), updateData);
  } catch (error) {
    if (isPermissionDenied(error)) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
    throw error;
  }

  await writeBranchAuditLog(
    session,
    branchId,
    patch.active === false ? 'BRANCH_DISABLED' : 'BRANCH_UPDATED',
    branchId,
    JSON.stringify(patch).slice(0, 300)
  );
}

export async function listStaffProfiles(session: PharmacySession, branchId?: string): Promise<StaffProfileRecord[]> {
  if (!canSessionPerformAdminOperation(session, !isBrowserOffline())) return [];
  const { db } = getFirebaseServices();
  const targetBranch = branchId || session.activeBranchId;

  try {
    const q =
      session.role === 'super_admin'
        ? collection(db, 'users')
        : targetBranch && session.branchIds.includes(targetBranch)
          ? query(collection(db, 'users'), where('branchIds', 'array-contains', targetBranch))
          : null;
    if (!q) return [];
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        uid: data.uid || d.id,
        email: data.email || '',
        displayName: data.displayName || data.email || d.id,
        role: data.role,
        branchIds: Array.isArray(data.branchIds) ? data.branchIds : [],
        activeBranchId: data.activeBranchId || null,
        active: data.active === true,
        createdAt: normalizeTimestamp(data.createdAt),
        updatedAt: normalizeTimestamp(data.updatedAt),
      } as StaffProfileRecord;
    });
  } catch (error) {
    if (isPermissionDenied(error)) {
      handleFirestoreError(error, OperationType.LIST, 'users');
    }
    throw error;
  }
}

export async function listStaffInvites(session: PharmacySession, branchId?: string): Promise<StaffInviteRecord[]> {
  if (!canSessionPerformAdminOperation(session, !isBrowserOffline())) return [];
  const { db } = getFirebaseServices();
  const targetBranch = branchId || session.activeBranchId;

  try {
    const q =
      session.role === 'super_admin'
        ? collection(db, 'staff_invites')
        : targetBranch && session.branchIds.includes(targetBranch)
          ? query(collection(db, 'staff_invites'), where('branchIds', 'array-contains', targetBranch))
          : null;
    if (!q) return [];
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: data.id || d.id,
        email: data.email || '',
        displayName: data.displayName || '',
        role: data.role,
        branchIds: Array.isArray(data.branchIds) ? data.branchIds : [],
        active: data.active === true,
        invitedByUid: data.invitedByUid || '',
        claimedUid: data.claimedUid || null,
        createdAt: normalizeTimestamp(data.createdAt),
        updatedAt: normalizeTimestamp(data.updatedAt),
      } as StaffInviteRecord;
    });
  } catch (error) {
    if (isPermissionDenied(error)) {
      handleFirestoreError(error, OperationType.LIST, 'staff_invites');
    }
    throw error;
  }
}

export async function createOrUpdateStaffInvite(
  session: PharmacySession,
  input: { email: string; displayName: string; role: PharmacyRole; branchIds: string[] }
): Promise<StaffInviteRecord> {
  if (session.role === 'cashier') {
    throw new Error('ليس لديك صلاحية لإضافة الموظفين.');
  }
  assertLiveAdminSession(session, false);
  if (session.role === 'admin') {
    if (input.role !== 'cashier') {
      throw new Error('مدير الفرع يمكنه إضافة حسابات كاشير فقط لفرعه المصرح به.');
    }
    if (input.branchIds.length !== 1 || !session.branchIds.includes(input.branchIds[0])) {
      throw new Error('يمكن لمدير الفرع تعيين الكاشير لفرع واحد مصرح به فقط.');
    }
  }
  if (input.role === 'cashier' && input.branchIds.length !== 1) {
    throw new Error('يجب تعيين فرع واحد فقط لحساب الكاشير.');
  }
  if (input.role === 'admin' && input.branchIds.length === 0) {
    throw new Error('يجب تعيين فرع واحد على الأقل لحساب المدير.');
  }

  const normalizedEmail = input.email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('أدخل بريداً إلكترونياً صالحاً.');
  }

  const inviteId = await computeInviteId(normalizedEmail);
  const { db } = getFirebaseServices();
  const inviteRef = doc(db, 'staff_invites', inviteId);
  const path = `staff_invites/${inviteId}`;

  const payload = {
    id: inviteId,
    email: normalizedEmail.slice(0, 254),
    displayName: (input.displayName || normalizedEmail).trim().slice(0, 120),
    role: input.role,
    branchIds: input.branchIds.slice(0, 20),
    active: true,
    invitedByUid: session.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    const existing = await getDoc(inviteRef);
    if (existing.exists()) {
      await updateDoc(inviteRef, {
        displayName: payload.displayName,
        role: payload.role,
        branchIds: payload.branchIds,
        active: true,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(inviteRef, payload);
    }
  } catch (error) {
    if (isPermissionDenied(error)) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
    throw error;
  }

  const auditBranchId = input.branchIds[0] || session.activeBranchId || 'khalid-1';
  await writeBranchAuditLog(session, auditBranchId, 'STAFF_INVITED', inviteId, `${normalizedEmail} (${input.role})`);

  return {
    ...payload,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function toggleStaffInviteActive(
  session: PharmacySession,
  inviteId: string,
  active: boolean
): Promise<void> {
  if (session.role === 'cashier') {
    throw new Error('ليس لديك صلاحية لتعديل دعوات الموظفين.');
  }
  assertLiveAdminSession(session, false);
  const { db } = getFirebaseServices();
  const path = `staff_invites/${inviteId}`;
  try {
    await updateDoc(doc(db, 'staff_invites', inviteId), {
      active: Boolean(active),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isPermissionDenied(error)) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
    throw error;
  }
  if (session.activeBranchId) {
    await writeBranchAuditLog(session, session.activeBranchId, active ? 'INVITE_ENABLED' : 'INVITE_DISABLED', inviteId);
  }
}

export async function updateStaffUserProfile(
  session: PharmacySession,
  target: StaffProfileRecord,
  patch: { role?: PharmacyRole; branchIds?: string[]; active?: boolean; displayName?: string }
): Promise<void> {
  if (session.role === 'cashier') {
    throw new Error('غير مصرح للكاشير بتعديل حسابات الموظفين.');
  }
  assertLiveAdminSession(session, false);
  if (session.role === 'admin') {
    if (target.role !== 'cashier' || patch.role || patch.branchIds) {
      throw new Error('مدير الفرع يملك صلاحية تفعيل/تعطيل الكاشير التابع لفرعه فقط.');
    }
    const sharesBranch = target.branchIds.some((bid) => session.branchIds.includes(bid));
    if (!sharesBranch) {
      throw new Error('غير مصرح لمدير الفرع بتعديل موظف خارج فروعه.');
    }
  }
  if (target.uid === session.uid && patch.active === false) {
    throw new Error('لا يمكنك تعطيل حسابك النشط.');
  }

  const { db } = getFirebaseServices();
  const path = `users/${target.uid}`;
  const updateBody: Record<string, any> = {
    updatedAt: serverTimestamp(),
  };
  if (patch.displayName !== undefined) updateBody.displayName = patch.displayName.trim().slice(0, 120);
  if (patch.active !== undefined) updateBody.active = Boolean(patch.active);
  if (session.role === 'super_admin') {
    if (patch.role !== undefined) updateBody.role = patch.role;
    if (patch.branchIds !== undefined) {
      const boundedBranchIds = patch.branchIds.slice(0, 20);
      updateBody.branchIds = boundedBranchIds;
      updateBody.activeBranchId = boundedBranchIds[0] || null;
    }
  }

  try {
    await updateDoc(doc(db, 'users', target.uid), updateBody);

    // Sync membership arrays on affected branches when Super Admin updates branchIds/role
    if (session.role === 'super_admin' && (patch.branchIds !== undefined || patch.role !== undefined)) {
      const nextRole = patch.role || target.role;
      const nextBranches = (patch.branchIds || target.branchIds).slice(0, 20);
      const allAffected = new Set([...target.branchIds, ...nextBranches]);
      for (const bid of allAffected) {
        const branchRef = doc(db, 'branches', bid);
        const included = nextBranches.includes(bid);
        const isBranchAdm = included && (nextRole === 'admin' || nextRole === 'super_admin');
        try {
          await updateDoc(branchRef, {
            memberUids: included ? arrayUnion(target.uid) : arrayRemove(target.uid),
            adminUids: isBranchAdm ? arrayUnion(target.uid) : arrayRemove(target.uid),
            updatedAt: serverTimestamp(),
          });
        } catch {
          // ignore if branch doesn't exist yet
        }
      }
    }
  } catch (error) {
    if (isPermissionDenied(error)) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
    throw error;
  }

  const auditBranchId = (patch.branchIds?.[0] || target.branchIds[0] || session.activeBranchId || 'khalid-1');
  await writeBranchAuditLog(session, auditBranchId, 'STAFF_PROFILE_UPDATED', target.uid, target.email);
}

export async function writeBranchAuditLog(
  session: PharmacySession,
  branchId: string,
  action: string,
  targetId?: string,
  details?: string
): Promise<void> {
  if (!branchId) return;
  const { db } = getFirebaseServices();
  const eventId = sanitizeFirestoreId(`audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 'audit');
  const path = `branches/${branchId}/audit_logs/${eventId}`;

  try {
    await setDoc(doc(db, 'branches', branchId, 'audit_logs', eventId), {
      id: eventId,
      branchId,
      actorUid: session.uid,
      actorEmail: session.email || '',
      actorRole: session.role,
      action: action.slice(0, 120),
      targetId: (targetId || '').slice(0, 128),
      details: (details || '').slice(0, 500),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    if (isPermissionDenied(error)) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
    // Never break operational workflow on audit connectivity failure while offline
  }
}

export async function listBranchAuditLogs(branchId: string, maxCount = 50): Promise<BranchAuditLogRecord[]> {
  if (!branchId) return [];
  const { db } = getFirebaseServices();
  const path = `branches/${branchId}/audit_logs`;
  try {
    const q = query(
      collection(db, 'branches', branchId, 'audit_logs'),
      where('branchId', '==', branchId),
      orderBy('createdAt', 'desc'),
      limit(maxCount)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: data.id || d.id,
        branchId: data.branchId,
        actorUid: data.actorUid,
        actorEmail: data.actorEmail || '',
        actorRole: data.actorRole,
        action: data.action,
        targetId: data.targetId || '',
        details: data.details || '',
        createdAt: normalizeTimestamp(data.createdAt),
      };
    });
  } catch (error) {
    if (isPermissionDenied(error)) {
      handleFirestoreError(error, OperationType.LIST, path);
    }
    return [];
  }
}

export type BranchMedicineSyncDeferReason =
  | 'MEDICINE_SYNC_DEFERRED_UNKNOWN_PACKING'
  | 'MEDICINE_SYNC_REJECTED_INVALID_PACKING'
  | 'MEDICINE_SYNC_DEFERRED_UNVERIFIED_PACKING'
  | 'MEDICINE_SYNC_DEFERRED_QUARANTINED_PACKING'
  | 'MEDICINE_SYNC_DEFERRED_DIRECT_PACK_REQUIRES_V2_SCHEMA';

export interface CloudSyncActionResult {
  status: 'synced' | 'already_synced' | 'archived' | 'queued' | 'skipped' | 'deferred' | 'conflict';
  id?: string;
  ledgerCount?: number;
  syncState?: 'complete' | 'pending_ledger';
  conflict?: MedicineSyncConflictReport;
  reasonCode?: BranchMedicineSyncDeferReason;
  error?: string;
}

export interface PendingBranchSyncItem {
  key: string;
  kind: 'medicine' | 'sale' | 'archive_medicine';
  originUid: string;
  branchId: string;
  entityId: string;
  payload: Record<string, any>;
  attempts: number;
  lastError: string;
  queuedAt: number;
  updatedAt: number;
}

const SYNC_RETRY_QUEUE_KEY_PREFIX = 'khalid_cloud_sync_retry_queue_v1';
const MAX_RETRY_QUEUE_ITEMS = 200;
// Keeps distinct cross-document Security Rules reads per writeBatch well under Firestore's 20-read batch limit.
export const MAX_LEDGER_WRITES_PER_BATCH = 8;

export const V1_IN_FLIGHT_LEASE_STORAGE_PREFIX = 'khalid_v1_inflight_lease_v1:';
export const V1_IN_FLIGHT_LEASE_IDB_PREFIX = 'v1_inflight_lease_v1:';
export const DEFAULT_V1_IN_FLIGHT_LEASE_TTL_MS = 120_000;

export interface V1InFlightLeaseRecord {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly operationId: string;
  readonly tabInstanceId: string;
  readonly kind: 'medicine' | 'sale' | 'archive_medicine';
  readonly entityType: 'sale' | 'medicine';
  readonly entityId: string;
  readonly originUid: string;
  readonly branchId: string;
  readonly medicineIds: ReadonlyArray<string>;
  readonly createdAtMs: number;
  readonly heartbeatAtMs: number;
  readonly expiresAtMs: number;
}

export interface V1InFlightEnumerationResult {
  readonly available: boolean;
  readonly activeLeases: ReadonlyArray<V1InFlightLeaseRecord>;
  readonly expiredLeases: ReadonlyArray<V1InFlightLeaseRecord>;
  readonly activeMedicineIds: ReadonlyArray<string>;
  readonly discoveredContexts: ReadonlyArray<{ readonly uid: string; readonly branchId: string }>;
  readonly errors: ReadonlyArray<string>;
}

const inFlightSaleSyncs = new Map<string, Promise<CloudSyncActionResult>>();
const inFlightMedicineSyncs = new Map<string, Promise<CloudSyncActionResult>>();
const inFlightMedicineArchiveSyncs = new Map<string, Promise<CloudSyncActionResult>>();
const inFlightRetryRuns = new Map<string, Promise<{ processed: number; succeeded: number; remaining: number }>>();
const inFlightOperationRecords = new Map<string, V1InFlightLeaseRecord>();

function generateV1TabInstanceId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let currentV1TabInstanceId = generateV1TabInstanceId();

export function getV1SyncTabInstanceId(): string {
  return currentV1TabInstanceId;
}

export function setV1SyncTabInstanceIdForTests(tabId: string | null): void {
  currentV1TabInstanceId =
    typeof tabId === 'string' && tabId.trim() ? tabId.trim() : generateV1TabInstanceId();
}

export function validateV1InFlightLeaseRecord(
  raw: unknown
): { valid: true; record: V1InFlightLeaseRecord } | { valid: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: 'NON_OBJECT' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) return { valid: false, reason: 'INVALID_SCHEMA_VERSION' };
  const strFields = ['leaseId', 'operationId', 'tabInstanceId', 'entityId', 'originUid', 'branchId'] as const;
  for (const field of strFields) {
    if (typeof obj[field] !== 'string' || !String(obj[field]).trim()) {
      return { valid: false, reason: `MISSING_${field.toUpperCase()}` };
    }
  }
  const kind = obj.kind;
  const entityType = obj.entityType;
  if (kind !== 'medicine' && kind !== 'sale' && kind !== 'archive_medicine') {
    return { valid: false, reason: 'INVALID_KIND' };
  }
  const expectedEntityType = kind === 'sale' ? 'sale' : 'medicine';
  if (entityType !== expectedEntityType) {
    return { valid: false, reason: 'ENTITY_TYPE_MISMATCH' };
  }
  if (!Array.isArray(obj.medicineIds) || obj.medicineIds.length === 0) {
    return { valid: false, reason: 'EMPTY_MEDICINE_IDS' };
  }
  const cleanMedIds: string[] = [];
  for (const mid of obj.medicineIds) {
    if (typeof mid !== 'string' || !mid.trim()) {
      return { valid: false, reason: 'INVALID_MEDICINE_ID_ENTRY' };
    }
    cleanMedIds.push(mid.trim());
  }
  if (
    typeof obj.createdAtMs !== 'number' ||
    !Number.isFinite(obj.createdAtMs) ||
    typeof obj.heartbeatAtMs !== 'number' ||
    !Number.isFinite(obj.heartbeatAtMs) ||
    typeof obj.expiresAtMs !== 'number' ||
    !Number.isFinite(obj.expiresAtMs) ||
    obj.expiresAtMs < obj.createdAtMs
  ) {
    return { valid: false, reason: 'INVALID_TIMESTAMPS' };
  }
  return {
    valid: true,
    record: {
      schemaVersion: 1,
      leaseId: String(obj.leaseId).trim(),
      operationId: String(obj.operationId).trim(),
      tabInstanceId: String(obj.tabInstanceId).trim(),
      kind,
      entityType: expectedEntityType,
      entityId: String(obj.entityId).trim(),
      originUid: String(obj.originUid).trim(),
      branchId: String(obj.branchId).trim(),
      medicineIds: Array.from(new Set(cleanMedIds)),
      createdAtMs: obj.createdAtMs,
      heartbeatAtMs: obj.heartbeatAtMs,
      expiresAtMs: obj.expiresAtMs,
    },
  };
}

function writeV1LeaseToStorage(record: V1InFlightLeaseRecord): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      `${V1_IN_FLIGHT_LEASE_STORAGE_PREFIX}${record.leaseId}`,
      JSON.stringify(record)
    );
  } catch {
    // ignore storage quota errors; in-memory & IDB lease still preserve coordination
  }
}

function removeV1LeaseFromStorageIfOwned(lease: V1InFlightLeaseRecord): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const key = `${V1_IN_FLIGHT_LEASE_STORAGE_PREFIX}${lease.leaseId}`;
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.leaseId === lease.leaseId &&
      parsed.tabInstanceId === lease.tabInstanceId
    ) {
      localStorage.removeItem(key);
    }
  } catch {
    // ignore cleanup storage error
  }
}

async function persistV1LeaseToIdb(record: V1InFlightLeaseRecord): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined') return;
    const db = await openPharmacyDB();
    if (!db.objectStoreNames.contains('metadata')) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['metadata'], 'readwrite');
      tx.objectStore('metadata').put({
        ...record,
        key: `${V1_IN_FLIGHT_LEASE_IDB_PREFIX}${record.leaseId}`,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('V1_IDB_LEASE_WRITE_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('V1_IDB_LEASE_WRITE_ABORTED'));
    });
  } catch {
    // Fallback gracefully in pure unit tests without IDB; in-memory & localStorage remain active
  }
}

async function removeV1LeaseFromIdbIfOwned(lease: V1InFlightLeaseRecord): Promise<void> {
  try {
    if (typeof indexedDB === 'undefined') return;
    const db = await openPharmacyDB();
    if (!db.objectStoreNames.contains('metadata')) return;
    const key = `${V1_IN_FLIGHT_LEASE_IDB_PREFIX}${lease.leaseId}`;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['metadata'], 'readwrite');
      const metaStore = tx.objectStore('metadata');
      const getReq = metaStore.get(key);
      getReq.onsuccess = () => {
        const cur = getReq.result as Record<string, unknown> | undefined;
        if (
          cur &&
          cur.leaseId === lease.leaseId &&
          cur.tabInstanceId === lease.tabInstanceId
        ) {
          metaStore.delete(key);
        }
      };
      getReq.onerror = () => reject(getReq.error || new Error('V1_IDB_LEASE_READ_FAILED'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('V1_IDB_LEASE_DELETE_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('V1_IDB_LEASE_DELETE_ABORTED'));
    });
  } catch {
    // ignore cleanup IDB error when IDB is unavailable
  }
}

export function extractSaleMedicineIds(
  sale: Record<string, any>,
  ledgerDocs?: ReadonlyArray<{ medicineId: string }>
): string[] {
  const medIds = new Set<string>();
  if (Array.isArray(ledgerDocs)) {
    for (const d of ledgerDocs) {
      if (d && typeof d.medicineId === 'string' && d.medicineId.trim()) {
        medIds.add(d.medicineId.trim());
      }
    }
  }
  if (sale && typeof sale === 'object') {
    if (typeof sale.medicineId === 'string' && sale.medicineId.trim()) {
      medIds.add(sale.medicineId.trim());
    }
    if (Array.isArray(sale.items)) {
      for (const item of sale.items) {
        if (item && typeof item === 'object') {
          const id = item.medicineId ?? item.medicine_id ?? item.medId;
          if (typeof id === 'string' && id.trim()) {
            medIds.add(id.trim());
          }
        }
      }
    }
  }
  return Array.from(medIds);
}

export function acquireV1InFlightLeaseSync(params: {
  kind: 'medicine' | 'sale' | 'archive_medicine';
  originUid: string;
  branchId: string;
  entityId: string;
  medicineIds: ReadonlyArray<string>;
  ttlMs?: number;
  nowMs?: number;
  tabInstanceId?: string;
  operationId?: string;
}): V1InFlightLeaseRecord {
  const nowMs = typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const ttlMs =
    typeof params.ttlMs === 'number' && Number.isFinite(params.ttlMs) && params.ttlMs > 0
      ? Math.floor(params.ttlMs)
      : DEFAULT_V1_IN_FLIGHT_LEASE_TTL_MS;
  const tabInstanceId =
    typeof params.tabInstanceId === 'string' && params.tabInstanceId.trim()
      ? params.tabInstanceId.trim()
      : currentV1TabInstanceId;
  const uniqueSuffix = `${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const leaseId = `${sanitizeFirestoreId(tabInstanceId, 'tab')}-${sanitizeFirestoreId(params.kind, 'op')}-${sanitizeFirestoreId(params.entityId, 'ent')}-${uniqueSuffix}`;
  const operationId =
    typeof params.operationId === 'string' && params.operationId.trim()
      ? params.operationId.trim()
      : leaseId;
  const cleanMeds = Array.from(
    new Set(params.medicineIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))
  );
  if (cleanMeds.length === 0 && (params.kind === 'medicine' || params.kind === 'archive_medicine')) {
    cleanMeds.push(params.entityId);
  }
  const record: V1InFlightLeaseRecord = {
    schemaVersion: 1,
    leaseId,
    operationId,
    tabInstanceId,
    kind: params.kind,
    entityType: params.kind === 'sale' ? 'sale' : 'medicine',
    entityId: params.entityId,
    originUid: params.originUid,
    branchId: params.branchId,
    medicineIds: cleanMeds,
    createdAtMs: nowMs,
    heartbeatAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  };
  inFlightOperationRecords.set(leaseId, record);
  writeV1LeaseToStorage(record);
  return record;
}

export async function refreshV1InFlightLeaseHeartbeat(
  lease: V1InFlightLeaseRecord,
  ttlMs: number = DEFAULT_V1_IN_FLIGHT_LEASE_TTL_MS,
  nowMs: number = Date.now()
): Promise<V1InFlightLeaseRecord | null> {
  const existing = inFlightOperationRecords.get(lease.leaseId);
  if (!existing || existing.tabInstanceId !== lease.tabInstanceId) {
    return null;
  }
  const updated: V1InFlightLeaseRecord = {
    ...existing,
    heartbeatAtMs: nowMs,
    expiresAtMs: nowMs + Math.max(1, Math.floor(ttlMs)),
  };
  inFlightOperationRecords.set(lease.leaseId, updated);
  writeV1LeaseToStorage(updated);
  await persistV1LeaseToIdb(updated);
  return updated;
}

export async function releaseV1InFlightLease(lease: V1InFlightLeaseRecord): Promise<void> {
  const existing = inFlightOperationRecords.get(lease.leaseId);
  if (existing && existing.tabInstanceId === lease.tabInstanceId) {
    inFlightOperationRecords.delete(lease.leaseId);
  }
  removeV1LeaseFromStorageIfOwned(lease);
  await removeV1LeaseFromIdbIfOwned(lease);
}

export async function pruneExpiredV1InFlightLeases(nowMs: number = Date.now()): Promise<number> {
  let pruned = 0;
  for (const [leaseId, rec] of Array.from(inFlightOperationRecords.entries())) {
    if (rec.expiresAtMs <= nowMs) {
      inFlightOperationRecords.delete(leaseId);
      pruned += 1;
    }
  }
  try {
    if (typeof localStorage !== 'undefined') {
      const toDelete: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(V1_IN_FLIGHT_LEASE_STORAGE_PREFIX)) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        try {
          const v = validateV1InFlightLeaseRecord(JSON.parse(raw));
          if (v.valid && v.record.expiresAtMs <= nowMs) {
            toDelete.push(key);
          }
        } catch {
          // Do not silently destroy corrupt leases — leave them for fail-closed auditing
        }
      }
      for (const k of toDelete) {
        localStorage.removeItem(k);
        pruned += 1;
      }
    }
  } catch {
    // ignore storage errors
  }
  try {
    if (typeof indexedDB !== 'undefined') {
      const db = await openPharmacyDB();
      if (db.objectStoreNames.contains('metadata')) {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['metadata'], 'readwrite');
          const store = tx.objectStore('metadata');
          const req = store.getAll(
            IDBKeyRange.bound(V1_IN_FLIGHT_LEASE_IDB_PREFIX, `${V1_IN_FLIGHT_LEASE_IDB_PREFIX}\uffff`)
          );
          req.onsuccess = () => {
            const rows = Array.isArray(req.result) ? req.result : [];
            for (const row of rows) {
              const v = validateV1InFlightLeaseRecord(row);
              if (v.valid && v.record.expiresAtMs <= nowMs && typeof row?.key === 'string') {
                store.delete(row.key);
                pruned += 1;
              }
            }
          };
          req.onerror = () => reject(req.error || new Error('V1_PRUNE_IDB_READ_FAILED'));
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('V1_PRUNE_IDB_TX_FAILED'));
        });
      }
    }
  } catch {
    // ignore IDB errors during best-effort expired cleanup
  }
  return pruned;
}

export function enumerateV1InFlightOperations(options?: {
  nowMs?: number;
}): V1InFlightEnumerationResult {
  const nowMs =
    typeof options?.nowMs === 'number' && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const byLeaseId = new Map<string, V1InFlightLeaseRecord>();
  const errors: string[] = [];

  for (const [leaseId, rec] of inFlightOperationRecords.entries()) {
    const validated = validateV1InFlightLeaseRecord(rec);
    if (!validated.valid) {
      errors.push(`MALFORMED_IN_MEMORY_V1_LEASE:${leaseId}:${validated.reason}`);
      continue;
    }
    byLeaseId.set(validated.record.leaseId, validated.record);
  }

  // Ensure every entry in legacy per-tab inFlight Maps has matching tracked metadata
  const coveredInMemKeys = new Set<string>();
  for (const rec of inFlightOperationRecords.values()) {
    coveredInMemKeys.add(`${rec.kind}:${rec.originUid}:${rec.branchId}:${rec.entityId}`);
  }
  for (const mapKey of inFlightSaleSyncs.keys()) {
    if (!coveredInMemKeys.has(`sale:${mapKey}`)) {
      errors.push(`UNTRACKED_V1_IN_FLIGHT_SALE:${mapKey}`);
    }
  }
  for (const mapKey of inFlightMedicineSyncs.keys()) {
    if (!coveredInMemKeys.has(`medicine:${mapKey}`)) {
      errors.push(`UNTRACKED_V1_IN_FLIGHT_MEDICINE:${mapKey}`);
    }
  }
  for (const mapKey of inFlightMedicineArchiveSyncs.keys()) {
    if (!coveredInMemKeys.has(`archive_medicine:${mapKey}`)) {
      errors.push(`UNTRACKED_V1_IN_FLIGHT_ARCHIVE:${mapKey}`);
    }
  }

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
        const validated = validateV1InFlightLeaseRecord(parsed);
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

export function isV1EntitySyncInFlight(
  originUid: string,
  branchId: string,
  entityType: 'sale' | 'medicine',
  entityId: string
): boolean {
  const key = `${originUid}:${branchId}:${entityId}`;
  const inLocalMap =
    entityType === 'sale'
      ? inFlightSaleSyncs.has(key)
      : inFlightMedicineSyncs.has(key) || inFlightMedicineArchiveSyncs.has(key);
  if (inLocalMap) return true;
  const snapshot = enumerateV1InFlightOperations();
  return snapshot.activeLeases.some(
    (lease) =>
      lease.originUid === originUid &&
      lease.branchId === branchId &&
      lease.entityType === entityType &&
      lease.entityId === entityId
  );
}

export const V1_IN_FLIGHT_RUNTIME_BRIDGE_SYMBOL = Symbol.for(
  'khalid_pharmacy.v1_in_flight_runtime_bridge_v1'
);

(globalThis as Record<symbol, unknown>)[V1_IN_FLIGHT_RUNTIME_BRIDGE_SYMBOL] = {
  isV1EntitySyncInFlight,
  enumerateV1InFlightOperations,
  validateV1InFlightLeaseRecord,
};

function getSyncRetryQueueKey(uid: string): string {
  return `${SYNC_RETRY_QUEUE_KEY_PREFIX}:${sanitizeFirestoreId(uid, 'anon')}`;
}

function readSyncRetryQueueForKey(storageKey: string): PendingBranchSyncItem[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readSyncRetryQueue(uid: string): PendingBranchSyncItem[] {
  if (!uid) return [];
  const items = readSyncRetryQueueForKey(getSyncRetryQueueKey(uid));
  return items.filter((item) => item && item.originUid === uid);
}

function writeSyncRetryQueue(uid: string, items: PendingBranchSyncItem[]): void {
  try {
    if (typeof localStorage === 'undefined' || !uid) return;
    const trimmed = [...items]
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
      .slice(-MAX_RETRY_QUEUE_ITEMS);
    localStorage.setItem(getSyncRetryQueueKey(uid), JSON.stringify(trimmed));
  } catch {
    // ignore storage quota errors
  }
}

export function getPendingBranchSyncs(uid?: string): PendingBranchSyncItem[] {
  if (uid) {
    return readSyncRetryQueue(uid);
  }
  try {
    if (typeof localStorage === 'undefined') return [];
    const merged: PendingBranchSyncItem[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(`${SYNC_RETRY_QUEUE_KEY_PREFIX}:`)) {
        merged.push(...readSyncRetryQueueForKey(key));
      }
    }
    return merged.sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
  } catch {
    return [];
  }
}

export function clearBranchSyncRetryQueue(uid?: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (uid) {
      localStorage.removeItem(getSyncRetryQueueKey(uid));
      return;
    }
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && (k === SYNC_RETRY_QUEUE_KEY_PREFIX || k.startsWith(`${SYNC_RETRY_QUEUE_KEY_PREFIX}:`))) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) {
      localStorage.removeItem(k);
    }
  } catch {
    // ignore
  }
}

function enqueueSyncRetry(
  kind: PendingBranchSyncItem['kind'],
  originUid: string,
  branchId: string,
  entityId: string,
  payload: Record<string, any>,
  error: unknown
): void {
  const key = `${originUid}:${kind}:${branchId}:${entityId}`;
  const existing = readSyncRetryQueue(originUid);
  const prev = existing.find((item) => item.key === key);
  const message = error instanceof Error ? error.message : String(error || 'Sync failed');
  const nextItem: PendingBranchSyncItem = {
    key,
    kind,
    originUid,
    branchId,
    entityId,
    payload,
    attempts: (prev?.attempts || 0) + 1,
    lastError: message.slice(0, 400),
    queuedAt: prev?.queuedAt || Date.now(),
    updatedAt: Date.now(),
  };
  const filtered = existing.filter((item) => item.key !== key);
  filtered.push(nextItem);
  writeSyncRetryQueue(originUid, filtered);
}

function removeSyncRetry(
  kind: PendingBranchSyncItem['kind'],
  originUid: string,
  branchId: string,
  entityId: string
): void {
  const key = `${originUid}:${kind}:${branchId}:${entityId}`;
  const existing = readSyncRetryQueue(originUid);
  const next = existing.filter((item) => item.key !== key);
  if (next.length !== existing.length) {
    writeSyncRetryQueue(originUid, next);
  }
}

export function clearMatchingV1SyncRetry(
  kind: PendingBranchSyncItem['kind'],
  originUid: string,
  branchId: string,
  entityId: string
): void {
  removeSyncRetry(kind, originUid, branchId, entityId);
}

function logSyncFailure(operation: string, correlationId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Unknown cloud sync error');
  void errorLogService.recordError({
    level: 'warning',
    source: 'branchSyncService',
    operation,
    correlationId,
    error,
  });
  return message;
}

export function sanitizeSecondaryBarcodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const cleaned = entry.trim().slice(0, 64);
    if (cleaned) unique.add(cleaned);
    if (unique.size >= 20) break;
  }
  return Array.from(unique);
}

function resolveStrictNonNullAlias(
  candidates: ReadonlyArray<readonly [string, unknown]>,
  fieldGroupLabel: string
): unknown {
  for (const [aliasName, value] of candidates) {
    if (value === null) {
      throw new Error(
        `SDI-04_INVALID_SALE_INPUT: Explicit null is forbidden for ${fieldGroupLabel} (${aliasName} cannot fall back through ??).`
      );
    }
  }
  for (const [, value] of candidates) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function parseStrictPositiveSaleQuantity(raw: unknown, fieldLabel = "quantity"): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `SDI-04_INVALID_SALE_QUANTITY: ${fieldLabel} must be a finite positive number (> 0); received ${
        typeof raw === "number" ? String(raw) : typeof raw
      }.`
    );
  }
  return raw;
}

export function parseStrictPositiveSaleBaseUnits(raw: unknown, fieldLabel = "baseUnits"): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    throw new Error(
      `SDI-04_INVALID_SALE_BASE_UNITS: ${fieldLabel} must be a positive safe integer (>= 1); received ${
        typeof raw === "number" ? String(raw) : typeof raw
      }.`
    );
  }
  return raw;
}

function isStrictModularFirestoreInstance(candidate: unknown): candidate is Firestore {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate instanceof Date
  ) {
    return false;
  }
  if (!(candidate instanceof Firestore)) {
    return false;
  }
  const record = candidate as unknown as Record<string, unknown>;
  if (record.type !== "firestore" && record.type !== "firestore-lite") {
    return false;
  }
  if (typeof record.app !== "object" || record.app === null || Array.isArray(record.app)) {
    return false;
  }
  const dbId = record._databaseId;
  if (
    typeof dbId !== "object" ||
    dbId === null ||
    Array.isArray(dbId) ||
    typeof (dbId as Record<string, unknown>).projectId !== "string" ||
    ((dbId as Record<string, unknown>).projectId as string).trim().length === 0
  ) {
    return false;
  }
  if (typeof record.toJSON !== "function") {
    return false;
  }
  try {
    const serialized = (record.toJSON as () => unknown)();
    if (typeof serialized !== "object" || serialized === null || Array.isArray(serialized)) {
      return false;
    }
    const serRecord = serialized as Record<string, unknown>;
    const serDbId = serRecord.databaseId;
    if (
      typeof serDbId !== "object" ||
      serDbId === null ||
      Array.isArray(serDbId) ||
      typeof (serDbId as Record<string, unknown>).projectId !== "string" ||
      ((serDbId as Record<string, unknown>).projectId as string).trim().length === 0
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

export function isValidFirestoreDbInstance(candidate: unknown): boolean {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    candidate instanceof Date
  ) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "_delegate") || "_delegate" in record) {
    if (typeof record.app !== "object" || record.app === null || Array.isArray(record.app)) {
      return false;
    }
    const delegate = record._delegate;
    if (
      typeof delegate === "object" &&
      delegate !== null &&
      Object.prototype.hasOwnProperty.call(delegate, "_delegate")
    ) {
      return false;
    }
    return isStrictModularFirestoreInstance(delegate);
  }
  return isStrictModularFirestoreInstance(candidate);
}

function resolveExplicitFirestoreDbOverride(
  options?: { dbOverride?: unknown }
): ReturnType<typeof getFirebaseServices>["db"] | null {
  if (
    options === undefined ||
    options === null ||
    typeof options !== "object" ||
    !Object.prototype.hasOwnProperty.call(options, "dbOverride")
  ) {
    return null;
  }
  if (!isValidFirestoreDbInstance(options.dbOverride)) {
    throw new Error(
      "SYNC_DB_OVERRIDE_REQUIRED: Explicit dbOverride must be a genuine Firestore instance (modular Firestore or compat _delegate); fail-closed without fallback."
    );
  }
  return options.dbOverride as ReturnType<typeof getFirebaseServices>["db"];
}

export function normalizeSalePayloadForFirestore(
  session: PharmacySession,
  branchId: string,
  sale: Record<string, any>
): {
  saleId: string;
  invoiceNumber: string;
  actorUid: string;
  saleDoc: Record<string, any>;
  ledgerDocs: Array<{ id: string; medicineId: string; data: Record<string, any> }>;
} {
  const saleId = sanitizeFirestoreId(sale.id, 'sale');
  const invoiceNumber = String(sale.invoiceNumber || saleId).trim().slice(0, 64) || saleId;
  const actorUid =
    typeof sale.cashierUid === 'string' && sale.cashierUid.trim()
      ? sanitizeFirestoreId(sale.cashierUid, 'uid')
      : session.uid;
  const rawItems = Array.isArray(sale.items) ? sale.items.slice(0, 100) : [];
  const cleanItems =
    rawItems.length > 0
      ? rawItems
      : [
          {
            medicineId: sanitizeFirestoreId(sale.medicineId || 'unknown-item', 'med'),
            name: String(sale.customer || 'POS Sale Item').slice(0, 120),
            qty: 1,
            unit: 'pack',
            subtotal: Math.max(0, Number(sale.subtotal ?? sale.total) || 0),
          },
        ];

  const itemsSubtotalSum = cleanItems.reduce(
    (sum: number, item: Record<string, any>) => sum + Math.max(0, Number(item?.subtotal) || 0),
    0
  );
  const rawSubtotal = Number(sale.subtotal);
  const subtotal =
    Number.isFinite(rawSubtotal) && rawSubtotal >= 0 ? Number(rawSubtotal.toFixed(2)) : Number(itemsSubtotalSum.toFixed(2));
  const rawDiscount = Number(sale.discount);
  const discount = Math.min(
    subtotal,
    Math.max(0, Number.isFinite(rawDiscount) ? Number(rawDiscount.toFixed(2)) : 0)
  );
  const total = Number(Math.max(0, subtotal - discount).toFixed(2));
  const cashierName = String(sale.cashierName || session.displayName || actorUid).slice(0, 120);

  const saleDoc: Record<string, any> = {
    id: saleId,
    branchId,
    invoiceNumber,
    customer: String(sale.customer || 'Walk-in Patient').slice(0, 160),
    time: String(sale.time || '').slice(0, 32),
    timestamp: String(sale.timestamp || new Date().toISOString()).slice(0, 64),
    items: cleanItems,
    itemsCount: cleanItems.length,
    subtotal,
    discount,
    total,
    costOfGoods: Math.max(0, Number(sale.costOfGoods) || 0),
    grossProfit: Number((subtotal - Math.max(0, Number(sale.costOfGoods) || 0)).toFixed(2)),
    netProfit: Number((total - Math.max(0, Number(sale.costOfGoods) || 0)).toFixed(2)),
    paymentMethod: ['Cash', 'Card', 'Bankak'].includes(sale.paymentMethod) ? sale.paymentMethod : 'Cash',
    bankakTransactionId: String(sale.bankakTransactionId || '').slice(0, 128),
    cashierUid: actorUid,
    cashierName,
    deviceId: String(sale.deviceId || '').slice(0, 128),
  };

  const ledgerDocs: Array<{ id: string; medicineId: string; data: Record<string, any> }> = [];
  const usedMovementIds = new Set<string>();
  const reserveUniqueMovementId = (candidateRaw: string): string => {
    const baseId = sanitizeFirestoreId(candidateRaw, 'mov');
    if (!usedMovementIds.has(baseId)) {
      usedMovementIds.add(baseId);
      return baseId;
    }
    let suffix = 1;
    let uniqueId = `${baseId.slice(0, 110)}-d${suffix}`;
    while (usedMovementIds.has(uniqueId)) {
      suffix += 1;
      uniqueId = `${baseId.slice(0, 110)}-d${suffix}`;
    }
    usedMovementIds.add(uniqueId);
    return uniqueId;
  };

  cleanItems.forEach((item: Record<string, any>, itemIdx: number) => {
    const medicineId = sanitizeFirestoreId(item?.medicineId || '', 'med');
    const rawUnit = item?.unit ?? item?.unitType;
    const unit = rawUnit === 'strip' || rawUnit === 'pill' ? rawUnit : 'pack';
    const allocations = Array.isArray(item?.batchAllocations) ? item.batchAllocations : [];

    const rawItemQty = resolveStrictNonNullAlias(
      [
        ['item.qty', item?.qty],
        ['item.quantity', item?.quantity],
      ],
      `items[${itemIdx}] quantity`
    );
    const validatedItemQty =
      rawItemQty !== undefined
        ? parseStrictPositiveSaleQuantity(rawItemQty, `items[${itemIdx}].qty/quantity`)
        : null;
    if (validatedItemQty === null && allocations.length === 0) {
      parseStrictPositiveSaleQuantity(undefined, `items[${itemIdx}].qty/quantity`);
    }

    const rawItemBaseUnits = resolveStrictNonNullAlias(
      [
        ['item.baseUnits', item?.baseUnits],
        ['item.totalBaseUnits', item?.totalBaseUnits],
      ],
      `items[${itemIdx}] baseUnits`
    );
    if (rawItemBaseUnits !== undefined) {
      parseStrictPositiveSaleBaseUnits(rawItemBaseUnits, `items[${itemIdx}].baseUnits/totalBaseUnits`);
    }

    const rawCostPerUnitCandidate = item?.costPerUnit ?? item?.buyPrice;
    const parsedDirectCost =
      rawCostPerUnitCandidate !== undefined && rawCostPerUnitCandidate !== null
        ? Number(rawCostPerUnitCandidate)
        : NaN;
    const parsedCog =
      item?.costOfGoods !== undefined && item?.costOfGoods !== null ? Number(item.costOfGoods) : NaN;
    const fallbackCostPerUnit =
      Number.isFinite(parsedDirectCost) && parsedDirectCost >= 0
        ? parsedDirectCost
        : Number.isFinite(parsedCog) && parsedCog > 0 && validatedItemQty !== null
          ? parsedCog / validatedItemQty
          : 0;

    if (allocations.length > 0) {
      allocations.forEach((alloc: Record<string, any>, allocIdx: number) => {
        const movementId = reserveUniqueMovementId(
          typeof alloc?.ledgerMovementId === 'string' && alloc.ledgerMovementId.trim()
            ? alloc.ledgerMovementId
            : `${saleId}-${medicineId}-i${itemIdx}-b${allocIdx}`
        );
        const allocUnit =
          alloc?.unit === 'strip' || alloc?.unit === 'pill' || alloc?.unit === 'pack'
            ? alloc.unit
            : unit;
        const rawAllocQty = resolveStrictNonNullAlias(
          [
            ['alloc.quantity', alloc?.quantity],
            ['alloc.qty', alloc?.qty],
          ],
          `items[${itemIdx}].batchAllocations[${allocIdx}] quantity`
        );
        const qtyVal = parseStrictPositiveSaleQuantity(
          rawAllocQty !== undefined ? rawAllocQty : validatedItemQty,
          `items[${itemIdx}].batchAllocations[${allocIdx}].quantity`
        );
        const rawAllocBase = resolveStrictNonNullAlias(
          [
            ['alloc.baseUnits', alloc?.baseUnits],
            ['alloc.quantityBaseUnits', alloc?.quantityBaseUnits],
          ],
          `items[${itemIdx}].batchAllocations[${allocIdx}] baseUnits`
        );
        const baseSource =
          rawAllocBase !== undefined
            ? rawAllocBase
            : allocations.length === 1
              ? rawItemBaseUnits
              : undefined;
        const baseVal = parseStrictPositiveSaleBaseUnits(
          baseSource,
          `items[${itemIdx}].batchAllocations[${allocIdx}].baseUnits`
        );
        ledgerDocs.push({
          id: movementId,
          medicineId,
          data: {
            id: movementId,
            branchId,
            medicineId,
            batchNumber: String(alloc?.batchNumber || item?.batchNumber || '').slice(0, 64),
            expiry: String(alloc?.expiry || item?.expiry || '').slice(0, 32),
            type: 'SALE',
            unit: allocUnit,
            quantityDelta: -qtyVal,
            baseUnitsDelta: -baseVal,
            costPerUnit: Math.max(0, Number(alloc?.costPerUnit ?? fallbackCostPerUnit) || 0),
            costPerBaseUnit: Math.max(0, Number(alloc?.costPerBaseUnit ?? item?.costPerBaseUnit) || 0),
            referenceId: saleId,
            invoiceNumber,
            deviceId: String(sale.deviceId || '').slice(0, 128),
            userId: actorUid,
            employeeName: cashierName,
            notes: `فاتورة بيع #${invoiceNumber}`,
            timestamp: saleDoc.timestamp,
          },
        });
      });
    } else {
      const movementId = reserveUniqueMovementId(
        typeof item?.ledgerMovementId === 'string' && item.ledgerMovementId.trim()
          ? item.ledgerMovementId
          : `${saleId}-${medicineId}-i${itemIdx}`
      );
      const qtyVal = parseStrictPositiveSaleQuantity(
        validatedItemQty,
        `items[${itemIdx}].qty/quantity`
      );
      const baseVal = parseStrictPositiveSaleBaseUnits(
        rawItemBaseUnits,
        `items[${itemIdx}].baseUnits/totalBaseUnits`
      );
      ledgerDocs.push({
        id: movementId,
        medicineId,
        data: {
          id: movementId,
          branchId,
          medicineId,
          batchNumber: String(item?.batchNumber || '').slice(0, 64),
          expiry: String(item?.expiry || '').slice(0, 32),
          type: 'SALE',
          unit,
          quantityDelta: -qtyVal,
          baseUnitsDelta: -baseVal,
          costPerUnit: fallbackCostPerUnit,
          costPerBaseUnit: Math.max(0, Number(item?.costPerBaseUnit) || 0),
          referenceId: saleId,
          invoiceNumber,
          deviceId: String(sale.deviceId || '').slice(0, 128),
          userId: actorUid,
          employeeName: cashierName,
          notes: `فاتورة بيع #${invoiceNumber}`,
          timestamp: saleDoc.timestamp,
        },
      });
    }
  });

  const expectedLedgerIds = ledgerDocs.map((m) => m.id);
  const uniqueMedCount = new Set(ledgerDocs.map((m) => m.medicineId)).size;
  const canDirectComplete =
    ledgerDocs.length > 0 &&
    ledgerDocs.length <= SPARK_DIRECT_COMPLETE_MAX_LEDGERS &&
    uniqueMedCount + ledgerDocs.length <= SPARK_DIRECT_COMPLETE_MAX_DOC_ACCESS_BUDGET;

  saleDoc.syncState = canDirectComplete ? 'complete' : 'pending_ledger';
  saleDoc.expectedLedgerCount = Math.max(1, ledgerDocs.length);
  saleDoc.expectedLedgerIds = expectedLedgerIds;
  saleDoc.verifiedLedgerCount = canDirectComplete ? ledgerDocs.length : 0;
  saleDoc.syncOperationId = sanitizeFirestoreId(sale.syncOperationId || `sync-${saleId}`, 'sync');

  return { saleId, invoiceNumber, actorUid, saleDoc, ledgerDocs };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function finalizePendingSaleWithCheckpoints(params: {
  saleRef: ReturnType<typeof doc>;
  expectedLedgerCount: number;
  initialVerifiedCount: number;
  assertLeaseCurrent: () => Promise<void>;
}): Promise<void> {
  const { saleRef, expectedLedgerCount, initialVerifiedCount, assertLeaseCurrent } = params;
  let cursor = Math.max(0, Math.min(expectedLedgerCount, initialVerifiedCount));
  while (cursor < expectedLedgerCount) {
    const nextCursor = Math.min(expectedLedgerCount, cursor + SPARK_LEDGER_VERIFICATION_SLICE_SIZE);
    const nextState = nextCursor === expectedLedgerCount ? 'complete' : 'pending_ledger';
    await assertLeaseCurrent();
    await updateDoc(saleRef, {
      syncState: nextState,
      verifiedLedgerCount: nextCursor,
      updatedAt: serverTimestamp(),
    });
    cursor = nextCursor;
  }
}

async function ensureMedicinesExistInFirestore(
  db: ReturnType<typeof getFirebaseServices>['db'],
  branchId: string,
  ledgerDocs: Array<{ medicineId: string }>
): Promise<string[]> {
  const uniqueMedIds = Array.from(new Set(ledgerDocs.map((m) => m.medicineId)));
  const medSnaps = await Promise.all(
    uniqueMedIds.map((medId) => getDoc(doc(db, 'branches', branchId, 'medicines', medId)))
  );
  return uniqueMedIds.filter((_, idx) => !medSnaps[idx].exists());
}

async function verifyCloudSaleAndAllMovementsComplete(
  db: ReturnType<typeof getFirebaseServices>['db'],
  branchId: string,
  saleId: string,
  ledgerDocs: Array<{ id: string; medicineId: string; data: Record<string, any> }>
): Promise<boolean> {
  try {
    const saleSnap = await getDoc(doc(db, 'branches', branchId, 'sales', saleId));
    if (!saleSnap.exists()) return false;
    const saleData = saleSnap.data() as Record<string, unknown>;
    if (!isCloudSaleReconciled(saleData)) return false;
    const expectedCheck = reconcileRemoteSaleExpectedLedgerIds({
      branchId,
      saleId,
      remoteSaleData: saleData,
      localExpectedLedgerIds: ledgerDocs.map((m) => m.id),
    });
    if (!expectedCheck.ok) return false;
    const movSnaps = await Promise.all(
      ledgerDocs.map((m) => getDoc(doc(db, 'branches', branchId, 'inventory_ledger', m.id)))
    );
    return movSnaps.every((snap, idx) => {
      if (!snap.exists()) return false;
      const expected = ledgerDocs[idx];
      return validateExistingSaleLedgerMovement({
        expectedId: expected.id,
        branchId,
        saleId,
        expectedData: expected.data,
        actualDoc: snap.data() as Record<string, unknown>,
      }).ok;
    });
  } catch {
    return false;
  }
}

export interface BranchMedicineFirestorePayloadSuccess {
  readonly ok: true;
  readonly mutableFields: Record<string, any>;
}

export interface BranchMedicineFirestorePayloadDeferred {
  readonly ok: false;
  readonly reasonCode: BranchMedicineSyncDeferReason;
  readonly error: string;
}

export type BranchMedicineFirestorePayloadResult =
  | BranchMedicineFirestorePayloadSuccess
  | BranchMedicineFirestorePayloadDeferred;

function isAbsentPackingValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function parseVerifiedPositivePackingFactor(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
  }
  return null;
}

/**
 * Pure, fail-closed V1 Firestore medicine payload validator/builder.
 * - Never fabricates 2x10 fallback packing.
 * - Never emits stripsPerPack: 0 or pillsPerStrip: 0 (which violates firestore.rules >= 1).
 * - Defers unknown, invalid, unverified, quarantined, or DIRECT_PACK records with a typed reasonCode.
 */
export function prepareBranchMedicineFirestoreMutableFields(
  medicine: Record<string, any>
): BranchMedicineFirestorePayloadResult {
  if (!medicine || typeof medicine !== 'object') {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
      error: 'Medicine payload is missing or invalid.',
    };
  }

  if (medicine.unitMigrationStatus === 'QUARANTINED' || medicine.unitMigrationStatus === 'CONFLICTED') {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_DEFERRED_QUARANTINED_PACKING',
      error: `Medicine sync deferred: unitMigrationStatus is ${String(medicine.unitMigrationStatus)}.`,
    };
  }

  if (medicine.unitDefinition?.hierarchy?.kind === 'DIRECT_PACK') {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_DEFERRED_DIRECT_PACK_REQUIRES_V2_SCHEMA',
      error: 'Medicine sync deferred: DIRECT_PACK medicines require V2 Firestore schema and cannot be synced via V1 strips/pills fields.',
    };
  }

  if (
    medicine.unitOperationalAllowed === false ||
    (typeof medicine.configStatus === 'string' && medicine.configStatus.trim() !== '' && medicine.configStatus !== 'VERIFIED') ||
    (typeof medicine.unitDefinition?.configStatus === 'string' &&
      medicine.unitDefinition.configStatus.trim() !== '' &&
      medicine.unitDefinition.configStatus !== 'VERIFIED')
  ) {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_DEFERRED_UNVERIFIED_PACKING',
      error: 'Medicine sync deferred: packing configuration is not verified for operational sync.',
    };
  }

  const stripsAbsent = isAbsentPackingValue(medicine.stripsPerPack);
  const pillsAbsent = isAbsentPackingValue(medicine.pillsPerStrip);

  if (stripsAbsent && pillsAbsent) {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_DEFERRED_UNKNOWN_PACKING',
      error: 'Medicine sync deferred: stripsPerPack and pillsPerStrip are unknown; sync requires verified positive integers (>= 1).',
    };
  }

  const stripsPerPack = parseVerifiedPositivePackingFactor(medicine.stripsPerPack);
  const pillsPerStrip = parseVerifiedPositivePackingFactor(medicine.pillsPerStrip);

  if (stripsPerPack === null || pillsPerStrip === null) {
    return {
      ok: false,
      reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
      error: 'Medicine sync rejected: stripsPerPack and pillsPerStrip must both be positive safe integers (>= 1); zero or partial packing is forbidden.',
    };
  }

  const nestedHierarchy = medicine.unitDefinition?.hierarchy;
  if (nestedHierarchy?.kind === 'SOLID_TWO_LEVEL') {
    const nestedStrips = parseVerifiedPositivePackingFactor(nestedHierarchy.stripsPerPack);
    const nestedPills = parseVerifiedPositivePackingFactor(nestedHierarchy.pillsPerStrip);
    if (nestedStrips !== stripsPerPack || nestedPills !== pillsPerStrip) {
      return {
        ok: false,
        reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
        error: 'Medicine sync rejected: stripsPerPack/pillsPerStrip disagree with unitDefinition.hierarchy.',
      };
    }
  }

  return {
    ok: true,
    mutableFields: {
      barcode: String(medicine.barcode || '').slice(0, 64),
      name: String(medicine.name || 'Unnamed').slice(0, 200),
      category: String(medicine.category || 'General').slice(0, 80),
      minStock: Math.max(0, Number(medicine.minStock) || 0),
      buyPrice: Math.max(0, Number(medicine.buyPrice) || 0),
      sellPrice: Math.max(0, Number(medicine.sellPrice) || 0),
      sellPriceStrip:
        medicine.sellPriceStrip !== undefined && medicine.sellPriceStrip !== null
          ? Math.max(0, Number(medicine.sellPriceStrip) || 0)
          : null,
      sellPricePill:
        medicine.sellPricePill !== undefined && medicine.sellPricePill !== null
          ? Math.max(0, Number(medicine.sellPricePill) || 0)
          : null,
      sellPack: medicine.sellPack !== false,
      sellStrip: Boolean(medicine.sellStrip),
      sellPill: Boolean(medicine.sellPill),
      expiry: String(medicine.expiry || '').slice(0, 32),
      unitType: 'pack',
      stripsPerPack,
      pillsPerStrip,
      ...(medicine.batchNumber ? { batchNumber: String(medicine.batchNumber).slice(0, 64) } : {}),
      secondaryBarcodes: sanitizeSecondaryBarcodes(medicine.secondaryBarcodes),
      archived: Boolean(medicine.archived),
    },
  };
}

/**
 * Legacy V1 medicine sync helper.
 * V1/V2 Boundary (Phase 2D / D4-01): This legacy path does NOT accept a `dbOverride`
 * option and unconditionally uses `getFirebaseServices().db`. Strict D4-01 `dbOverride`
 * enforcement (`resolveExplicitFirestoreDbOverride`) applies exclusively to V2 push paths
 * (`pushBranchMedicineV2ToFirestore` and `pushBranchSaleToFirestore`).
 */
export async function pushBranchMedicineToFirestore(
  session: PharmacySession,
  branchId: string,
  medicine: Record<string, any>
): Promise<CloudSyncActionResult> {
  if (!branchId || !canSessionPerformAdminOperation(session, !isBrowserOffline())) {
    return { status: 'skipped' };
  }
  const medicineId = sanitizeFirestoreId(medicine.id, 'med');
  const inFlightKey = `${session.uid}:${branchId}:${medicineId}`;
  const existingRun = inFlightMedicineSyncs.get(inFlightKey);
  if (existingRun) {
    return existingRun;
  }

  let lease = acquireV1InFlightLeaseSync({
    kind: 'medicine',
    originUid: session.uid,
    branchId,
    entityId: medicineId,
    medicineIds: [medicineId],
  });

  const heartbeatIntervalMs = Math.max(5_000, Math.floor(DEFAULT_V1_IN_FLIGHT_LEASE_TTL_MS / 3));
  const heartbeatTimer = setInterval(() => {
    void refreshV1InFlightLeaseHeartbeat(lease).then((next) => {
      if (next) lease = next;
    });
  }, heartbeatIntervalMs);
  (heartbeatTimer as { unref?: () => void }).unref?.();

  let task!: Promise<CloudSyncActionResult>;
  task = (async (): Promise<CloudSyncActionResult> => {
    try {
      return await withLocalFirstMutationMutex('V1_MEDICINE_SYNC', async (mutexLease) => {
      await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);
      await persistV1LeaseToIdb(lease);

      if (
        await isEntityManagedByOutboxV2WhenEnabled({
          branchId,
          entityType: 'medicine',
          entityId: medicineId,
          actorUid: session.uid,
        })
      ) {
        return { status: 'skipped', id: medicineId };
      }

      const prepared = prepareBranchMedicineFirestoreMutableFields(medicine);
      if (!prepared.ok) {
        removeSyncRetry('medicine', session.uid, branchId, medicineId);
        void errorLogService.recordError({
          level: 'warning',
          source: 'branchSyncService',
          operation: 'pushBranchMedicineToFirestore.deferred',
          correlationId: medicineId,
          error: new Error(`${prepared.reasonCode}: ${prepared.error}`),
        });
        return {
          status: 'deferred',
          id: medicineId,
          reasonCode: prepared.reasonCode,
          error: prepared.error,
        };
      }

      const { db } = getFirebaseServices();
      const path = `branches/${branchId}/medicines/${medicineId}`;
      const docRef = doc(db, 'branches', branchId, 'medicines', medicineId);

      const mutableFields = {
        ...prepared.mutableFields,
        updatedAt: serverTimestamp(),
      };

      try {
        const existing = await getDoc(docRef);
        if (existing.exists()) {
          await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);
          await updateDoc(docRef, mutableFields);
        } else {
          await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);
          await setDoc(docRef, {
            id: medicineId,
            branchId,
            ...mutableFields,
            createdAt: serverTimestamp(),
          });
        }
        removeSyncRetry('medicine', session.uid, branchId, medicineId);
        return { status: 'synced', id: medicineId };
      } catch (error) {
        const msg = logSyncFailure(`pushBranchMedicine(${path})`, medicineId, error);
        enqueueSyncRetry('medicine', session.uid, branchId, medicineId, medicine, error);
        return { status: 'queued', id: medicineId, error: msg };
      }
      });
    } finally {
      clearInterval(heartbeatTimer);
      await releaseV1InFlightLease(lease);
      if (inFlightMedicineSyncs.get(inFlightKey) === task) {
        inFlightMedicineSyncs.delete(inFlightKey);
      }
    }
  })();

  inFlightMedicineSyncs.set(inFlightKey, task);
  return task;
}

export async function pushBranchMedicineV2ToFirestore(
  session: PharmacySession,
  branchId: string,
  medicine: Record<string, any>,
  options?: { expectedRemoteSyncVersion?: number; dbOverride?: any }
): Promise<CloudSyncActionResult> {
  const overrideDb = resolveExplicitFirestoreDbOverride(options);
  if (!branchId || !canSessionPerformAdminOperation(session, !isBrowserOffline())) {
    return { status: 'skipped' };
  }
  const medicineId = sanitizeFirestoreId(medicine.id, 'med');
  const prepared = prepareMedicineFirestoreV2Payload(medicine);
  if (!prepared.ok) {
    removeSyncRetry('medicine', session.uid, branchId, medicineId);
    return {
      status: 'deferred',
      id: medicineId,
      reasonCode: prepared.reasonCode,
      error: prepared.error,
    };
  }

  const db = overrideDb ?? getFirebaseServices().db;
  const path = `branches/${branchId}/medicines/${medicineId}`;
  const docRef = doc(db, 'branches', branchId, 'medicines', medicineId);

  try {
    const existing = await getDoc(docRef);
    if (existing.exists()) {
      const remoteData = existing.data() as Record<string, any>;
      const conflict = detectMedicineSyncConflict({
        localPayload: prepared.mutableFields,
        remoteDoc: remoteData,
        expectedRemoteSyncVersion: options?.expectedRemoteSyncVersion,
      });
      if (conflict.hasConflict) {
        return {
          status: 'conflict',
          id: medicineId,
          conflict,
          error: conflict.reason,
        };
      }
      if (conflict.isIdentical) {
        removeSyncRetry('medicine', session.uid, branchId, medicineId);
        return { status: 'already_synced', id: medicineId };
      }

      const nextSyncVersion = Math.max(
        Number(remoteData.syncVersion || 0) + 1,
        Number(prepared.mutableFields.syncVersion || 1)
      );
      const updatePayload: Record<string, any> = {
        ...prepared.mutableFields,
        syncVersion: nextSyncVersion,
        updatedAt: serverTimestamp(),
      };
      delete updatePayload.openingStockEvidence;
      // If remote is already locked, strip ALL immutable locked fields so PR #43 rules see zero locked-field mutation
      if (remoteData.packingLocked === true) {
        for (const immutableKey of LOCKED_MEDICINE_IMMUTABLE_FIELDS) {
          delete updatePayload[immutableKey];
        }
      }
      await updateDoc(docRef, updatePayload);
      removeSyncRetry('medicine', session.uid, branchId, medicineId);
      return { status: 'synced', id: medicineId };
    }

    // Create path: require genuine openingStockEvidence (never fabricate POSITIVE evidence)
    let openingStockEvidence = prepared.openingStockEvidence;
    if (!openingStockEvidence) {
      const claimedStock = Math.max(Number(medicine.stock || 0), Number(medicine.initialStock || 0));
      if (Number.isFinite(claimedStock) && claimedStock > 0) {
        removeSyncRetry('medicine', session.uid, branchId, medicineId);
        return {
          status: 'deferred',
          id: medicineId,
          reasonCode: 'MEDICINE_SYNC_REJECTED_INVALID_PACKING',
          error: 'Medicine V2 create rejected: positive opening stock requires genuine openingStockEvidence with initialLedgerMovementId.',
        };
      }
      openingStockEvidence = {
        mode: 'OMITTED',
        intendedInitialStock: 0,
        intendedBaseUnits: 0,
        initialLedgerMovementId: null,
        recordedAt: new Date().toISOString(),
      };
    }

    const createPayload: Record<string, any> = {
      id: medicineId,
      branchId,
      ...prepared.mutableFields,
      openingStockEvidence,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(docRef, createPayload);
    removeSyncRetry('medicine', session.uid, branchId, medicineId);
    return { status: 'synced', id: medicineId };
  } catch (error) {
    const msg = logSyncFailure(`pushBranchMedicineV2(${path})`, medicineId, error);
    enqueueSyncRetry('medicine', session.uid, branchId, medicineId, medicine, error);
    return { status: 'queued', id: medicineId, error: msg };
  }
}

export async function pushBranchSaleToFirestore(
  session: PharmacySession,
  branchId: string,
  sale: Record<string, any>,
  options?: { dbOverride?: any; maxLedgerWritesPerBatch?: number }
): Promise<CloudSyncActionResult> {
  const overrideDb = resolveExplicitFirestoreDbOverride(options);
  if (!branchId || !session.uid || session.emailVerified !== true) return { status: 'skipped' };

  const saleId = sanitizeFirestoreId(sale.id, 'sale');
  const actorUid =
    typeof sale.cashierUid === 'string' && sale.cashierUid.trim()
      ? sanitizeFirestoreId(sale.cashierUid, 'uid')
      : session.uid;

  if (actorUid !== session.uid) {
    // Under hardened rules (inventory_ledger.userId == request.auth.uid), only the originating user may submit their sale
    return { status: 'skipped', id: saleId };
  }

  const preNormalized = !isOutboxV2WorkerEnabled()
    ? normalizeSalePayloadForFirestore(session, branchId, sale)
    : null;

  const inFlightKey = `${actorUid}:${branchId}:${saleId}`;
  const existingRun = inFlightSaleSyncs.get(inFlightKey);
  if (existingRun) {
    return existingRun;
  }

  const saleMedicineIds = extractSaleMedicineIds(sale, preNormalized?.ledgerDocs ?? []);
  let lease = acquireV1InFlightLeaseSync({
    kind: 'sale',
    originUid: actorUid,
    branchId,
    entityId: saleId,
    medicineIds: saleMedicineIds.length > 0 ? saleMedicineIds : ['unknown-item'],
  });

  const heartbeatIntervalMs = Math.max(5_000, Math.floor(DEFAULT_V1_IN_FLIGHT_LEASE_TTL_MS / 3));
  const heartbeatTimer = setInterval(() => {
    void refreshV1InFlightLeaseHeartbeat(lease).then((next) => {
      if (next) lease = next;
    });
  }, heartbeatIntervalMs);
  (heartbeatTimer as { unref?: () => void }).unref?.();

  let task!: Promise<CloudSyncActionResult>;
  task = (async (): Promise<CloudSyncActionResult> => {
    try {
      return await withLocalFirstMutationMutex('V1_SALE_SYNC', async (mutexLease) => {
      await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);
      await persistV1LeaseToIdb(lease);

      if (
        await isEntityManagedByOutboxV2WhenEnabled({
          branchId,
          entityType: 'sale',
          entityId: saleId,
          actorUid: session.uid,
        })
      ) {
        return { status: 'skipped', id: saleId };
      }

      const normalized = preNormalized ?? normalizeSalePayloadForFirestore(session, branchId, sale);
      const { saleDoc, ledgerDocs } = normalized;

      const db = overrideDb ?? getFirebaseServices().db;
      const batchLimit = Math.max(
        1,
        Math.min(MAX_LEDGER_WRITES_PER_BATCH, options?.maxLedgerWritesPerBatch ?? MAX_LEDGER_WRITES_PER_BATCH)
      );
      const uniqueMedCount = new Set(ledgerDocs.map((m) => m.medicineId)).size;
      const canDirectComplete =
        ledgerDocs.length > 0 &&
        ledgerDocs.length <= batchLimit &&
        ledgerDocs.length <= SPARK_DIRECT_COMPLETE_MAX_LEDGERS &&
        uniqueMedCount + ledgerDocs.length <= SPARK_DIRECT_COMPLETE_MAX_DOC_ACCESS_BUDGET;
      const effectiveSaleDoc = {
        ...saleDoc,
        syncState: canDirectComplete ? ('complete' as const) : ('pending_ledger' as const),
        expectedLedgerCount: ledgerDocs.length,
        expectedLedgerIds: ledgerDocs.map((m) => m.id),
        verifiedLedgerCount: canDirectComplete ? ledgerDocs.length : 0,
      };
      const path = `branches/${branchId}/sales/${saleId}`;
      const saleRef = doc(db, 'branches', branchId, 'sales', saleId);
      const salePayloadToPersist = { ...sale, cashierUid: actorUid };

      try {
        if (ledgerDocs.length === 0) {
          throw new Error('Cannot sync cloud sale without SALE inventory_ledger movements.');
        }

        const existing = await getDoc(saleRef);
        if (existing.exists()) {
          const existingData = existing.data() as Record<string, any> | undefined;
          const localExpectedIds = ledgerDocs.map((m) => m.id);
          const expectedCheck = reconcileRemoteSaleExpectedLedgerIds({
            branchId,
            saleId,
            remoteSaleData: existingData,
            localExpectedLedgerIds: localExpectedIds,
          });
          if (!expectedCheck.ok) {
            throw new Error(`SALE_RECOVERY_EXPECTED_LEDGER_MISMATCH: ${expectedCheck.error}`);
          }

          const movSnaps = await Promise.all(
            ledgerDocs.map((m) => getDoc(doc(db, 'branches', branchId, 'inventory_ledger', m.id)))
          );

          const missingMovs: typeof ledgerDocs = [];
          const corruptMovErrors: string[] = [];
          for (let idx = 0; idx < ledgerDocs.length; idx += 1) {
            const expectedMov = ledgerDocs[idx];
            const snap = movSnaps[idx];
            if (!snap.exists()) {
              missingMovs.push(expectedMov);
              continue;
            }
            const validation = validateExistingSaleLedgerMovement({
              expectedId: expectedMov.id,
              branchId,
              saleId,
              expectedData: expectedMov.data,
              actualDoc: snap.data() as Record<string, unknown>,
            });
            if (!validation.ok) {
              corruptMovErrors.push(`${expectedMov.id}: ${validation.mismatches.join('; ')}`);
            }
          }

          if (corruptMovErrors.length > 0) {
            throw new Error(`SALE_RECOVERY_LEDGER_CORRUPTION: ${corruptMovErrors.join(' | ')}`);
          }

          if (missingMovs.length === 0) {
            if (existingData?.syncState === 'pending_ledger') {
              await finalizePendingSaleWithCheckpoints({
                saleRef,
                expectedLedgerCount: ledgerDocs.length,
                initialVerifiedCount: expectedCheck.verifiedLedgerCount,
                assertLeaseCurrent: () => assertLocalFirstMutationMutexLeaseCurrent(mutexLease),
              });
              removeSyncRetry('sale', actorUid, branchId, saleId);
              return { status: 'synced', id: saleId, ledgerCount: ledgerDocs.length, syncState: 'complete' };
            }
            if (!isCloudSaleReconciled(existingData)) {
              throw new Error('SALE_RECOVERY_UNRECONCILED_STATE: Remote sale is not reconciled despite existing movements.');
            }
            removeSyncRetry('sale', actorUid, branchId, saleId);
            return { status: 'already_synced', id: saleId, ledgerCount: ledgerDocs.length, syncState: 'complete' };
          }

          if (existingData?.syncState === 'complete') {
            throw new Error(
              `SALE_RECOVERY_COMPLETE_WITH_MISSING_LEDGERS: Remote sale is marked complete but ${missingMovs.length} expected ledger movement(s) are missing.`
            );
          }

          const missingMeds = await ensureMedicinesExistInFirestore(db, branchId, missingMovs);
          if (missingMeds.length > 0) {
            throw new Error(`Missing cloud medicine doc(s) for pending SALE ledger: ${missingMeds.join(', ')}`);
          }

          const missingChunks = chunkArray(missingMovs, batchLimit);
          for (const chunk of missingChunks) {
            const batch = writeBatch(db);
            for (const mov of chunk) {
              const movRef = doc(db, 'branches', branchId, 'inventory_ledger', mov.id);
              batch.set(movRef, {
                ...mov.data,
                createdAt: serverTimestamp(),
              });
            }
            await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);
            await batch.commit();
          }

          if (existingData?.syncState === 'pending_ledger') {
            await finalizePendingSaleWithCheckpoints({
              saleRef,
              expectedLedgerCount: ledgerDocs.length,
              initialVerifiedCount: expectedCheck.verifiedLedgerCount,
              assertLeaseCurrent: () => assertLocalFirstMutationMutexLeaseCurrent(mutexLease),
            });
          }

          removeSyncRetry('sale', actorUid, branchId, saleId);
          return { status: 'synced', id: saleId, ledgerCount: ledgerDocs.length, syncState: 'complete' };
        }

        // Pre-flight: ALL medicines referenced by ALL movements must exist in Firestore BEFORE writing the sale
        const missingMeds = await ensureMedicinesExistInFirestore(db, branchId, ledgerDocs);
        if (missingMeds.length > 0) {
          throw new Error(`Missing cloud medicine doc(s) before syncing sale: ${missingMeds.join(', ')}`);
        }

        const chunks = chunkArray(ledgerDocs, batchLimit);
        const firstBatch = writeBatch(db);
        firstBatch.set(saleRef, {
          ...effectiveSaleDoc,
          createdAt: serverTimestamp(),
        });
        for (const mov of chunks[0]) {
          const movRef = doc(db, 'branches', branchId, 'inventory_ledger', mov.id);
          firstBatch.set(movRef, {
            ...mov.data,
            createdAt: serverTimestamp(),
          });
        }
        await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);
        await firstBatch.commit();

        for (let chunkIdx = 1; chunkIdx < chunks.length; chunkIdx += 1) {
          const followBatch = writeBatch(db);
          for (const mov of chunks[chunkIdx]) {
            const movRef = doc(db, 'branches', branchId, 'inventory_ledger', mov.id);
            followBatch.set(movRef, {
              ...mov.data,
              createdAt: serverTimestamp(),
            });
          }
          await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);
          await followBatch.commit();
        }

        if (!canDirectComplete) {
          await finalizePendingSaleWithCheckpoints({
            saleRef,
            expectedLedgerCount: ledgerDocs.length,
            initialVerifiedCount: 0,
            assertLeaseCurrent: () => assertLocalFirstMutationMutexLeaseCurrent(mutexLease),
          });
        }

        removeSyncRetry('sale', actorUid, branchId, saleId);
        return { status: 'synced', id: saleId, ledgerCount: ledgerDocs.length, syncState: 'complete' };
      } catch (error) {
        if (isPermissionDenied(error)) {
          const alreadyCompletedConcurrently = await verifyCloudSaleAndAllMovementsComplete(
            db,
            branchId,
            saleId,
            ledgerDocs
          );
          if (alreadyCompletedConcurrently) {
            removeSyncRetry('sale', actorUid, branchId, saleId);
            return { status: 'already_synced', id: saleId, ledgerCount: ledgerDocs.length };
          }
        }
        const msg = logSyncFailure(`pushBranchSale(${path})`, saleId, error);
        enqueueSyncRetry('sale', actorUid, branchId, saleId, salePayloadToPersist, error);
        return { status: 'queued', id: saleId, error: msg };
      }
      });
    } finally {
      clearInterval(heartbeatTimer);
      await releaseV1InFlightLease(lease);
      if (inFlightSaleSyncs.get(inFlightKey) === task) {
        inFlightSaleSyncs.delete(inFlightKey);
      }
    }
  })();

  inFlightSaleSyncs.set(inFlightKey, task);
  return task;
}

/**
 * Legacy V1 medicine archive helper.
 * V1/V2 Boundary (Phase 2D / D4-01): Does NOT accept `dbOverride`; unconditionally uses
 * `getFirebaseServices().db`. Not covered by V2 `dbOverride` validation.
 */
export async function archiveBranchMedicineInFirestore(
  session: PharmacySession,
  branchId: string,
  medicineId: string
): Promise<CloudSyncActionResult> {
  if (!branchId || !canSessionPerformAdminOperation(session, !isBrowserOffline())) {
    return { status: 'skipped' };
  }
  const cleanId = sanitizeFirestoreId(medicineId, 'med');
  const inFlightKey = `${session.uid}:${branchId}:${cleanId}`;
  const existingRun = inFlightMedicineArchiveSyncs.get(inFlightKey);
  if (existingRun) {
    return existingRun;
  }

  let lease = acquireV1InFlightLeaseSync({
    kind: 'archive_medicine',
    originUid: session.uid,
    branchId,
    entityId: cleanId,
    medicineIds: [cleanId],
  });

  const heartbeatIntervalMs = Math.max(5_000, Math.floor(DEFAULT_V1_IN_FLIGHT_LEASE_TTL_MS / 3));
  const heartbeatTimer = setInterval(() => {
    void refreshV1InFlightLeaseHeartbeat(lease).then((next) => {
      if (next) lease = next;
    });
  }, heartbeatIntervalMs);
  (heartbeatTimer as { unref?: () => void }).unref?.();

  let task!: Promise<CloudSyncActionResult>;
  task = (async (): Promise<CloudSyncActionResult> => {
    try {
      return await withLocalFirstMutationMutex('V1_MEDICINE_ARCHIVE_SYNC', async (mutexLease) => {
      await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);
      await persistV1LeaseToIdb(lease);

      if (
        await isEntityManagedByOutboxV2WhenEnabled({
          branchId,
          entityType: 'medicine',
          entityId: cleanId,
          actorUid: session.uid,
        })
      ) {
        return { status: 'skipped', id: cleanId };
      }

      const { db } = getFirebaseServices();
      const path = `branches/${branchId}/medicines/${cleanId}`;
      try {
        await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);
        await updateDoc(doc(db, 'branches', branchId, 'medicines', cleanId), {
          archived: true,
          archivedAt: serverTimestamp(),
          archivedByUid: session.uid,
          updatedAt: serverTimestamp(),
        });
        removeSyncRetry('archive_medicine', session.uid, branchId, cleanId);
        await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);
        await writeBranchAuditLog(session, branchId, 'MEDICINE_ARCHIVED', cleanId);
        return { status: 'archived', id: cleanId };
      } catch (error) {
        const msg = logSyncFailure(`archiveBranchMedicine(${path})`, cleanId, error);
        enqueueSyncRetry('archive_medicine', session.uid, branchId, cleanId, { id: cleanId }, error);
        return { status: 'queued', id: cleanId, error: msg };
      }
      });
    } finally {
      clearInterval(heartbeatTimer);
      await releaseV1InFlightLease(lease);
      if (inFlightMedicineArchiveSyncs.get(inFlightKey) === task) {
        inFlightMedicineArchiveSyncs.delete(inFlightKey);
      }
    }
  })();

  inFlightMedicineArchiveSyncs.set(inFlightKey, task);
  return task;
}

/**
 * Legacy V1 medicine delete alias (delegates to `archiveBranchMedicineInFirestore`).
 * V1/V2 Boundary (Phase 2D / D4-01): Does NOT accept `dbOverride`.
 */
export async function deleteBranchMedicineFromFirestore(
  session: PharmacySession,
  branchId: string,
  medicineId: string
): Promise<CloudSyncActionResult> {
  return archiveBranchMedicineInFirestore(session, branchId, medicineId);
}

/**
 * Processes pending retry queue items, routing V2 medicine payloads to
 * `pushBranchMedicineV2ToFirestore`, legacy V1 medicine payloads to
 * `pushBranchMedicineToFirestore`, sales to `pushBranchSaleToFirestore`, and archives
 * to `archiveBranchMedicineInFirestore`. Does not accept or forward `dbOverride`.
 */
export async function retryPendingBranchSyncs(session: PharmacySession): Promise<{
  processed: number;
  succeeded: number;
  remaining: number;
}> {
  if (!session?.uid || session.emailVerified !== true || session.offlineFallback === true || isBrowserOffline()) {
    const existingCount = session?.uid ? readSyncRetryQueue(session.uid).length : 0;
    return { processed: 0, succeeded: 0, remaining: existingCount };
  }

  const activeRun = inFlightRetryRuns.get(session.uid);
  if (activeRun) {
    return activeRun;
  }

  const runPromise = (async () => {
    const queue = readSyncRetryQueue(session.uid);
    let processed = 0;
    let succeeded = 0;

    for (const item of queue) {
      if (item.originUid !== session.uid) continue;
      if (session.role !== 'super_admin' && !session.branchIds.includes(item.branchId)) {
        continue;
      }
      if ((item.kind === 'medicine' || item.kind === 'archive_medicine') && !canSessionPerformAdminOperation(session, !isBrowserOffline())) {
        continue;
      }
      processed += 1;

      let res: CloudSyncActionResult;
      if (item.kind === 'medicine') {
        const isV2Payload =
          Boolean(item.payload?.unitDefinition) || Number(item.payload?.unitSchemaVersion || 0) >= 2;
        res = isV2Payload
          ? await pushBranchMedicineV2ToFirestore(session, item.branchId, item.payload)
          : await pushBranchMedicineToFirestore(session, item.branchId, item.payload);
      } else if (item.kind === 'sale') {
        res = await pushBranchSaleToFirestore(session, item.branchId, item.payload);
      } else {
        res = await archiveBranchMedicineInFirestore(session, item.branchId, item.entityId);
      }

      if (res.status === 'synced' || res.status === 'already_synced' || res.status === 'archived') {
        succeeded += 1;
      }
    }

    if (isOutboxV2WorkerEnabled()) {
      void triggerOutboxV2SyncIfEnabled({
        reason: 'retryPendingBranchSyncs',
        actorUid: session.uid,
      });
    }

    return {
      processed,
      succeeded,
      remaining: readSyncRetryQueue(session.uid).length,
    };
  })().finally(() => {
    inFlightRetryRuns.delete(session.uid);
  });

  inFlightRetryRuns.set(session.uid, runPromise);
  return runPromise;
}

export function registerBranchSyncOnlineListener(getSession: () => PharmacySession | null): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }

  const handleOnline = () => {
    const session = getSession();
    if (!session) return;
    void retryPendingBranchSyncs(session).catch((err) => {
      void errorLogService.recordError({
        level: 'warning',
        source: 'branchSyncService',
        operation: 'online.retryPendingBranchSyncs',
        correlationId: session.uid,
        error: err,
      });
    });
  };

  window.addEventListener('online', handleOnline);
  return () => {
    window.removeEventListener('online', handleOnline);
  };
}

export function subscribeToBranchAuditLogs(
  session: PharmacySession,
  branchId: string,
  onUpdate: (logs: BranchAuditLogRecord[]) => void
): Unsubscribe | null {
  if (!branchId || !canSessionPerformAdminOperation(session, !isBrowserOffline())) return null;
  const { db } = getFirebaseServices();
  const path = `branches/${branchId}/audit_logs`;
  const q = query(
    collection(db, 'branches', branchId, 'audit_logs'),
    where('branchId', '==', branchId),
    orderBy('createdAt', 'desc'),
    limit(50)
  );
  const unsub = onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: data.id || d.id,
          branchId: data.branchId,
          actorUid: data.actorUid,
          actorEmail: data.actorEmail || '',
          actorRole: data.actorRole,
          action: data.action,
          targetId: data.targetId || '',
          details: data.details || '',
          createdAt: normalizeTimestamp(data.createdAt),
        } as BranchAuditLogRecord;
      });
      onUpdate(items);
    },
    (error) => {
      if (isPermissionDenied(error)) {
        handleFirestoreError(error, OperationType.LIST, path);
      }
    }
  );
  activeUnsubs.push(unsub);
  return unsub;
}
