import {
  onIdTokenChanged,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type Auth,
  type IdTokenResult,
  type Unsubscribe as AuthUnsubscribe,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getDocFromServer,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Unsubscribe as FirestoreUnsubscribe,
} from 'firebase/firestore';
import {
  getFirebaseServices,
  googleProvider,
  handleFirestoreError,
  isBrowserOffline,
  isFirebaseConfigured,
  OperationType,
  subscribeConnectivityChanges,
  testFirestoreConnection,
} from './firebaseClient';
import {
  activateTrustedAuthAuthority,
  applyTrustedActorSessionFromAuth,
} from './pharmacyDb';

export type PharmacyRole = 'super_admin' | 'admin' | 'cashier';

export interface PharmacySession {
  uid: string;
  email: string | null;
  displayName: string;
  role: PharmacyRole;
  branchIds: string[];
  activeBranchId: string | null;
  emailVerified: boolean;
  offlineFallback?: boolean;
  offlineCachedAt?: number;
  offlineExpiresAt?: number;
  offlineVerifiedMonotonicMs?: number;
  offlineExpiresMonotonicMs?: number;
  verifiedAt?: number;
}

export type OfflineSnapshotFailureReason =
  | 'OK'
  | 'STORAGE_UNAVAILABLE'
  | 'MISSING'
  | 'INVALID_FORMAT'
  | 'UID_MISMATCH'
  | 'EMAIL_MISMATCH'
  | 'EMAIL_NOT_VERIFIED'
  | 'OFFLINE_ROLE_FORBIDDEN'
  | 'INVALID_BRANCH_CONFIG'
  | 'MISSING_CACHED_AT'
  | 'INVALID_CACHED_AT'
  | 'FUTURE_CACHED_AT'
  | 'TTL_EXPIRED'
  | 'COLD_RELOAD_REAUTH_REQUIRED'
  | 'SNAPSHOT_TAMPERED';

export interface OfflineSnapshotValidationResult {
  valid: boolean;
  reason: OfflineSnapshotFailureReason;
  session?: PharmacySession;
  message?: string;
}

export const BOOTSTRAPPED_SUPER_ADMIN_EMAIL = 'hassan300009@gmail.com';
export const OFFLINE_CASHIER_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours max

const VALID_BRANCH_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export const DEFAULT_BRANCH_DEFINITIONS = [
  {
    id: 'khalid-1',
    code: 'KP-01',
    nameAr: 'صيدلية خالد 1',
    nameEn: 'Khalid Pharmacy 1',
    city: 'الخرطوم',
    phone: '',
    active: true,
  },
  {
    id: 'khalid-2',
    code: 'KP-02',
    nameAr: 'صيدلية خالد 2',
    nameEn: 'Khalid Pharmacy 2',
    city: 'الخرطوم',
    phone: '',
    active: true,
  },
] as const;

const SESSION_CACHE_PREFIX = 'khalid_verified_session_';
const inFlightSessionResolutions = new Map<string, Promise<PharmacySession>>();

// Enforce FirebaseAuthService as the sole runtime authority over pharmacyDb actor & branch context.
activateTrustedAuthAuthority();
applyTrustedActorSessionFromAuth(null);

function syncTrustedActorToPharmacyDb(session: PharmacySession | null): void {
  if (!session) {
    applyTrustedActorSessionFromAuth(null);
    return;
  }
  applyTrustedActorSessionFromAuth({
    uid: session.uid,
    role: session.role,
    branchIds: [...session.branchIds],
    activeBranchId: session.activeBranchId,
    emailVerified: session.emailVerified === true,
    offlineFallback: Boolean(session.offlineFallback),
  });
}

function defaultMonotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

// Ephemeral in-memory proof bound strictly to the current JS runtime context.
// Clears automatically on any cold page reload and is never reconstructed from localStorage/IndexedDB.
const lastOnlineVerifiedBindings = new Map<
  string,
  {
    role: PharmacyRole;
    branchIds: string[];
    activeBranchId: string | null;
    verifiedAt: number;
    verifiedMonotonicMs: number;
  }
>();

export { isFirebaseConfigured };

export async function computeInviteId(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const encoded = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `inv-${hex.slice(0, 32)}`;
}

function normalizeRole(value: unknown): PharmacyRole {
  if (value === 'super_admin' || value === 'admin' || value === 'cashier') {
    return value;
  }
  throw new Error('هذا الحساب لا يملك صلاحية صيدلية صالحة. راجع مدير النظام.');
}

function isValidBranchId(value: unknown): value is string {
  return typeof value === 'string' && VALID_BRANCH_ID_PATTERN.test(value.trim());
}

function sanitizeBranchIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const entry of raw) {
    if (!isValidBranchId(entry)) continue;
    const trimmed = entry.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      clean.push(trimmed);
    }
    if (clean.length >= 20) break;
  }
  return clean;
}

function isExplicitServerSnapshot(snap: unknown): snap is DocumentSnapshot<DocumentData> {
  try {
    if (!snap || typeof snap !== 'object') {
      return false;
    }
    const candidate = snap as {
      exists?: unknown;
      data?: unknown;
      metadata?: unknown;
    };
    if (typeof candidate.exists !== 'function' || typeof candidate.data !== 'function') {
      return false;
    }
    const metadata = candidate.metadata;
    if (!metadata || typeof metadata !== 'object') {
      return false;
    }
    return (metadata as { fromCache?: unknown }).fromCache === false;
  } catch {
    return false;
  }
}

function isFromCacheSnapshot(snap: unknown): boolean {
  try {
    if (!snap || typeof snap !== 'object') {
      return false;
    }
    const metadata = (snap as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== 'object') {
      return false;
    }
    return (metadata as { fromCache?: unknown }).fromCache === true;
  } catch {
    return false;
  }
}

function isOfflineError(error: unknown): boolean {
  const code = (error as any)?.code;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  return (
    code === 'unavailable' ||
    code === 'firestore/unavailable' ||
    code === 'deadline-exceeded' ||
    code === 'firestore/deadline-exceeded' ||
    msg.includes('client is offline') ||
    msg.includes('network') ||
    msg.includes('the operation could not be completed') ||
    msg.includes('timed out') ||
    msg.includes('failed to get document because the client is offline')
  );
}

function isPermissionDeniedError(error: unknown): boolean {
  const code = (error as any)?.code;
  const msg = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
  return (
    code === 'permission-denied' ||
    code === 'firestore/permission-denied' ||
    code === 'unauthenticated' ||
    code === 'firestore/unauthenticated' ||
    msg.includes('missing or insufficient permissions')
  );
}

function isTokenRevokedOrDisabledError(error: unknown): boolean {
  const code = String((error as any)?.code || '').toLowerCase();
  return (
    code === 'auth/user-disabled' ||
    code === 'auth/user-token-expired' ||
    code === 'auth/invalid-user-token' ||
    code === 'auth/user-not-found' ||
    code === 'auth/token-revoked'
  );
}

export function isOfflineSessionExpired(
  session: PharmacySession | null | undefined,
  now: number = Date.now(),
  monotonicNow: number = defaultMonotonicNow()
): boolean {
  if (!session) return true;
  if (!session.offlineFallback) return false;
  if (session.role !== 'cashier') return true;
  const cachedAt = session.offlineCachedAt;
  if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt) || cachedAt <= 0) {
    return true;
  }
  if (cachedAt > now) {
    return true;
  }
  if (now - cachedAt > OFFLINE_CASHIER_TTL_MS) {
    return true;
  }
  if (
    typeof session.offlineExpiresAt === 'number' &&
    Number.isFinite(session.offlineExpiresAt) &&
    now > session.offlineExpiresAt
  ) {
    return true;
  }

  // Require an active in-memory runtime binding and monotonic clock verification
  // so neither localStorage edits nor device-clock rollback can extend the session.
  const runtimeMem = session.uid ? lastOnlineVerifiedBindings.get(session.uid) : undefined;
  if (!runtimeMem || runtimeMem.role !== 'cashier') {
    return true;
  }
  if (
    typeof session.offlineVerifiedMonotonicMs !== 'number' ||
    !Number.isFinite(session.offlineVerifiedMonotonicMs) ||
    session.offlineVerifiedMonotonicMs !== runtimeMem.verifiedMonotonicMs
  ) {
    return true;
  }
  if (
    !Number.isFinite(monotonicNow) ||
    monotonicNow < runtimeMem.verifiedMonotonicMs ||
    monotonicNow - runtimeMem.verifiedMonotonicMs > OFFLINE_CASHIER_TTL_MS
  ) {
    return true;
  }
  if (
    typeof session.offlineExpiresMonotonicMs === 'number' &&
    Number.isFinite(session.offlineExpiresMonotonicMs) &&
    monotonicNow > session.offlineExpiresMonotonicMs
  ) {
    return true;
  }
  return false;
}

export function canSessionPerformAdminOperation(
  session: PharmacySession | null | undefined,
  isOnline: boolean = !isBrowserOffline()
): boolean {
  if (!session || session.emailVerified !== true) return false;
  if (session.role !== 'super_admin' && session.role !== 'admin') return false;
  if (session.offlineFallback === true) return false;
  if (!isOnline || isBrowserOffline()) return false;
  return true;
}

export function canSessionPerformPosOperation(
  session: PharmacySession | null | undefined,
  isOnline: boolean = !isBrowserOffline(),
  now: number = Date.now(),
  monotonicNow: number = defaultMonotonicNow()
): boolean {
  if (!session || session.emailVerified !== true) return false;
  if (session.role === 'cashier') {
    if (session.branchIds.length !== 1 || session.activeBranchId !== session.branchIds[0]) {
      return false;
    }
    if (session.offlineFallback === true) {
      const runtimeMem = lastOnlineVerifiedBindings.get(session.uid);
      if (
        !runtimeMem ||
        runtimeMem.role !== 'cashier' ||
        runtimeMem.branchIds.length !== 1 ||
        runtimeMem.branchIds[0] !== session.activeBranchId ||
        runtimeMem.activeBranchId !== session.activeBranchId
      ) {
        return false;
      }
      return !isOfflineSessionExpired(session, now, monotonicNow);
    }
    return true;
  }
  if (session.role === 'admin' || session.role === 'super_admin') {
    if (session.offlineFallback === true || !isOnline || isBrowserOffline()) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Saves an offline fallback snapshot ONLY for an online cashier.
 * Strictly persists the localStorage snapshot and NEVER creates or renews runtime bindings.
 */
export function saveOfflineSessionSnapshot(
  session: PharmacySession,
  now: number = Date.now()
): boolean {
  try {
    if (!session || !session.uid) return false;
    // Never cache admin or super_admin for offline privileges; purge any stale snapshot.
    if (session.role !== 'cashier') {
      clearOfflineSessionSnapshot(session.uid);
      return false;
    }
    // Never refresh cachedAt from an already-offline fallback session.
    if (session.offlineFallback === true || session.emailVerified !== true) {
      return false;
    }
    if (!Number.isFinite(now) || now <= 0) {
      return false;
    }
    const cleanBranches = sanitizeBranchIds(session.branchIds);
    if (cleanBranches.length !== 1) {
      clearOfflineSessionSnapshot(session.uid);
      return false;
    }
    const branchId = cleanBranches[0];
    if (session.activeBranchId !== branchId) {
      clearOfflineSessionSnapshot(session.uid);
      return false;
    }

    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(
      `${SESSION_CACHE_PREFIX}${session.uid}`,
      JSON.stringify({
        version: 2,
        uid: session.uid,
        email: (session.email || '').trim().toLowerCase(),
        displayName: session.displayName,
        role: 'cashier',
        branchIds: [branchId],
        activeBranchId: branchId,
        emailVerified: true,
        cachedAt: now,
      })
    );
    return true;
  } catch {
    return false;
  }
}

export function validateOfflineSessionSnapshot(
  user: Pick<User, 'uid' | 'email' | 'displayName' | 'emailVerified'>,
  now: number = Date.now()
): OfflineSnapshotValidationResult {
  if (!user || !user.uid) {
    return {
      valid: false,
      reason: 'UID_MISMATCH',
      message: 'تعذر التحقق من هوية المستخدم.',
    };
  }

  if (user.emailVerified !== true) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'EMAIL_NOT_VERIFIED',
      message: 'يجب تأكيد البريد الإلكتروني أولاً قبل الدخول إلى النظام.',
    };
  }

  const runtimeMem = lastOnlineVerifiedBindings.get(user.uid);
  if (runtimeMem && runtimeMem.role !== 'cashier') {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'OFFLINE_ROLE_FORBIDDEN',
      message: 'صلاحيات المدير ومدير النظام غير متاحة بدون اتصال بالإنترنت. يرجى الاتصال بالإنترنت للتحقق السحابي.',
    };
  }

  if (typeof localStorage === 'undefined') {
    return {
      valid: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: 'تعذر التحقق من الجلسة المحلية بدون اتصال بالإنترنت.',
    };
  }

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(`${SESSION_CACHE_PREFIX}${user.uid}`);
  } catch {
    return {
      valid: false,
      reason: 'STORAGE_UNAVAILABLE',
      message: 'تعذر قراءة الجلسة المحلية.',
    };
  }

  if (!raw) {
    return {
      valid: false,
      reason: 'MISSING',
      message: 'لا توجد جلسة كاشير محلية صالحة. يرجى الاتصال بالإنترنت لتسجيل الدخول والتحقق.',
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'INVALID_FORMAT',
      message: 'بيانات الجلسة المحلية تالفة. يلزم الاتصال بالإنترنت لإعادة التحقق.',
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'INVALID_FORMAT',
      message: 'بيانات الجلسة المحلية غير صالحة. يلزم الاتصال بالإنترنت لإعادة التحقق.',
    };
  }

  if (parsed.uid !== user.uid) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'UID_MISMATCH',
      message: 'تعارض في معرف المستخدم للجلسة المحلية. يلزم إعادة التحقق عبر الإنترنت.',
    };
  }

  const expectedEmail = (user.email || '').trim().toLowerCase();
  const cachedEmail = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase() : '';
  if (!expectedEmail || cachedEmail !== expectedEmail) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'EMAIL_MISMATCH',
      message: 'تعارض في البريد الإلكتروني للجلسة المحلية. يلزم إعادة التحقق عبر الإنترنت.',
    };
  }

  // Strictly block admin & super_admin offline privileges even if cached or tampered in localStorage.
  if (parsed.role !== 'cashier') {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'OFFLINE_ROLE_FORBIDDEN',
      message:
        parsed.role === 'admin' || parsed.role === 'super_admin'
          ? 'صلاحيات المدير ومدير النظام غير متاحة بدون اتصال بالإنترنت. يرجى الاتصال بالإنترنت للتحقق السحابي.'
          : 'دور الجلسة المحلية غير مسموح به في وضع عدم الاتصال.',
    };
  }

  const branchIds = sanitizeBranchIds(parsed.branchIds);
  if (
    !Array.isArray(parsed.branchIds) ||
    parsed.branchIds.length !== 1 ||
    branchIds.length !== 1
  ) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'INVALID_BRANCH_CONFIG',
      message: 'تعيين الفرع في الجلسة المحلية غير صالح. يلزم إعادة التحقق عبر الإنترنت.',
    };
  }

  const assignedBranchId = branchIds[0];
  if (parsed.activeBranchId !== assignedBranchId) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'INVALID_BRANCH_CONFIG',
      message: 'عدم تطابق الفرع النشط في الجلسة المحلية. يلزم إعادة التحقق عبر الإنترنت.',
    };
  }

  if (runtimeMem) {
    if (runtimeMem.branchIds.length !== 1 || runtimeMem.branchIds[0] !== assignedBranchId) {
      clearOfflineSessionSnapshot(user.uid);
      return {
        valid: false,
        reason: 'INVALID_BRANCH_CONFIG',
        message: 'تم رصد اختلاف في الفرع المصرح به للجلسة المحلية. يلزم إعادة التحقق عبر الإنترنت.',
      };
    }
  }

  // Strictly validate cachedAt (missing, non-numeric, <= 0, future, or expired > 12h)
  if (parsed.cachedAt === undefined || parsed.cachedAt === null) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'MISSING_CACHED_AT',
      message: 'طابع وقت الجلسة المحلية مفقود. يلزم الاتصال بالإنترنت لإعادة التحقق.',
    };
  }

  if (typeof parsed.cachedAt !== 'number' || !Number.isFinite(parsed.cachedAt) || parsed.cachedAt <= 0) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'INVALID_CACHED_AT',
      message: 'طابع وقت الجلسة المحلية غير صالح. يلزم الاتصال بالإنترنت لإعادة التحقق.',
    };
  }

  if (!Number.isFinite(now) || now <= 0 || parsed.cachedAt > now) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'FUTURE_CACHED_AT',
      message: 'طابع وقت الجلسة المحلية مستقبلي أو ساعة الجهاز غير متطابقة. يلزم التحقق عبر الإنترنت.',
    };
  }

  if (now - parsed.cachedAt > OFFLINE_CASHIER_TTL_MS) {
    // Only clear the expired localStorage session snapshot; never touch IndexedDB or Outbox.
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'TTL_EXPIRED',
      message: 'انتهت صلاحية الجلسة المحلية للكاشير (12 ساعة). يلزم الاتصال بالإنترنت لإعادة التحقق؛ جميع المبيعات المحلية محفوظة بأمان.',
    };
  }

  // FAIL-CLOSED Cold Offline Reload policy:
  // Never trust localStorage/IndexedDB/cached Firebase user without an active runtime proof
  // from cloud verification inside this exact JS execution context.
  if (!runtimeMem) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'COLD_RELOAD_REAUTH_REQUIRED',
      message: 'يلزم الاتصال بالإنترنت لإعادة التحقق من الجلسة بعد إعادة تحميل الصفحة؛ جميع البيانات والمبيعات المحلية في النظام محفوظة بأمان.',
    };
  }

  if (
    runtimeMem.role !== 'cashier' ||
    runtimeMem.branchIds.length !== 1 ||
    runtimeMem.branchIds[0] !== assignedBranchId ||
    runtimeMem.activeBranchId !== assignedBranchId
  ) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'INVALID_BRANCH_CONFIG',
      message: 'تعارض في صلاحية الدور أو الفرع مع الجلسة الموثقة. يلزم إعادة التحقق عبر الإنترنت.',
    };
  }

  // Reject localStorage cachedAt manipulation within the same runtime session
  if (parsed.cachedAt !== runtimeMem.verifiedAt) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'SNAPSHOT_TAMPERED',
      message: 'تم رصد تعديل في بيانات الجلسة المحلية. يلزم الاتصال بالإنترنت لإعادة التحقق.',
    };
  }

  // Enforce monotonic clock TTL and detect wall-clock rollover/rollback inside the runtime
  const monotonicNow = defaultMonotonicNow();
  if (now < runtimeMem.verifiedAt) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'FUTURE_CACHED_AT',
      message: 'ساعة الجهاز غير متطابقة مع وقت التحقق السحابي. يلزم إعادة التحقق عبر الإنترنت.',
    };
  }
  if (
    !Number.isFinite(monotonicNow) ||
    monotonicNow < runtimeMem.verifiedMonotonicMs ||
    monotonicNow - runtimeMem.verifiedMonotonicMs > OFFLINE_CASHIER_TTL_MS
  ) {
    clearOfflineSessionSnapshot(user.uid);
    return {
      valid: false,
      reason: 'TTL_EXPIRED',
      message: 'انتهت صلاحية الجلسة المحلية للكاشير (12 ساعة). يلزم الاتصال بالإنترنت لإعادة التحقق؛ جميع المبيعات المحلية محفوظة بأمان.',
    };
  }

  const session: PharmacySession = {
    uid: user.uid,
    email: user.email || null,
    displayName:
      typeof parsed.displayName === 'string' && parsed.displayName.trim()
        ? parsed.displayName.trim()
        : user.displayName || user.email || user.uid,
    role: 'cashier',
    branchIds: [assignedBranchId],
    activeBranchId: assignedBranchId,
    emailVerified: true,
    offlineFallback: true,
    offlineCachedAt: parsed.cachedAt,
    offlineExpiresAt: parsed.cachedAt + OFFLINE_CASHIER_TTL_MS,
    offlineVerifiedMonotonicMs: runtimeMem.verifiedMonotonicMs,
    offlineExpiresMonotonicMs: runtimeMem.verifiedMonotonicMs + OFFLINE_CASHIER_TTL_MS,
  };

  return {
    valid: true,
    reason: 'OK',
    session,
  };
}

export function loadOfflineSessionSnapshot(
  user: Pick<User, 'uid' | 'email' | 'displayName' | 'emailVerified'>,
  now: number = Date.now()
): PharmacySession | null {
  const result = validateOfflineSessionSnapshot(user, now);
  return result.valid && result.session ? result.session : null;
}

export function clearOfflineSessionSnapshot(uid?: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (uid) {
      localStorage.removeItem(`${SESSION_CACHE_PREFIX}${uid}`);
      return;
    }
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SESSION_CACHE_PREFIX)) keysToRemove.push(k);
    }
    for (const k of keysToRemove) localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

async function ensureDefaultBranchesForSuperAdmin(uid: string): Promise<void> {
  const { db } = getFirebaseServices();
  for (const branch of DEFAULT_BRANCH_DEFINITIONS) {
    const branchRef = doc(db, 'branches', branch.id);
    try {
      const snap = await getDoc(branchRef);
      if (!snap.exists()) {
        await setDoc(branchRef, {
          id: branch.id,
          code: branch.code,
          nameAr: branch.nameAr,
          nameEn: branch.nameEn,
          city: branch.city,
          phone: branch.phone,
          active: branch.active,
          adminUids: [uid],
          memberUids: [uid],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        handleFirestoreError(error, OperationType.WRITE, `branches/${branch.id}`);
      }
      throw error;
    }
  }
}

function mapFirebaseAuthError(error: unknown): Error {
  const code = (error as any)?.code || '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return new Error('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
    case 'auth/user-disabled':
      return new Error('تم تعطيل هذا الحساب من لوحة المصادقة.');
    case 'auth/user-token-expired':
    case 'auth/invalid-user-token':
    case 'auth/token-revoked':
      return new Error('انتهت صلاحية جلسة المصادقة أو تم إبطالها. يرجى إعادة تسجيل الدخول.');
    case 'auth/too-many-requests':
      return new Error('محاولات تسجيل دخول متكررة. انتظر قليلاً ثم أعد المحاولة.');
    case 'auth/network-request-failed':
      return new Error('تعذر الاتصال بخدمة المصادقة. تحقق من اتصال الإنترنت.');
    case 'auth/popup-closed-by-user':
      return new Error('تم إغلاق نافذة تسجيل الدخول قبل الإكمال.');
    case 'auth/popup-blocked':
      return new Error('حظر المتصفح نافذة تسجيل الدخول المنبثقة. اسمح بالنوافذ المنبثقة وحاول مجدداً.');
    case 'auth/unauthorized-domain':
      return new Error(
        'النطاق الحالي (Domain) غير مصرح له في Firebase Authentication. يرجى إضافة نطاق المعاينة الحالي إلى قائمة (Authorized domains) في وحدة تحكم Firebase (Firebase Console -> Authentication -> Settings -> Authorized domains).'
      );
    case 'auth/operation-not-allowed':
      return new Error(
        'تسجيل الدخول بالبريد وكلمة المرور غير مفعّل بعد في Firebase Console. استخدم الدخول عبر Google أو فعّل Email/Password في Firebase Console -> Authentication -> Sign-in method.'
      );
    default:
      return error instanceof Error ? error : new Error('تعذر تسجيل الدخول عبر Firebase.');
  }
}

function buildVerifiedSessionFromProfile(
  user: Pick<User, 'uid' | 'email' | 'displayName' | 'emailVerified'>,
  profile: Record<string, any>,
  now: number = Date.now()
): PharmacySession {
  if (!user.emailVerified) {
    throw new Error('يجب تأكيد البريد الإلكتروني أولاً قبل الدخول إلى النظام.');
  }

  if (!profile || profile.active !== true) {
    throw new Error('تم تعطيل هذا الحساب من الإدارة.');
  }

  const role = normalizeRole(profile.role);
  const claimBranchIds = sanitizeBranchIds(profile.branchIds);

  if (role !== 'super_admin' && claimBranchIds.length === 0) {
    throw new Error('هذا الحساب غير معيّن لأي فرع صيدلية.');
  }
  if (role === 'cashier' && claimBranchIds.length !== 1) {
    throw new Error('حساب الكاشير يجب أن يكون معيّناً لفرع واحد فقط.');
  }

  const activeBranchId =
    role === 'super_admin'
      ? typeof profile.activeBranchId === 'string' && isValidBranchId(profile.activeBranchId)
        ? profile.activeBranchId.trim()
        : claimBranchIds[0] || 'khalid-1'
      : typeof profile.activeBranchId === 'string' && claimBranchIds.includes(profile.activeBranchId)
        ? profile.activeBranchId
        : claimBranchIds[0];

  const session: PharmacySession = {
    uid: user.uid,
    email: user.email || null,
    displayName:
      typeof profile.displayName === 'string' && profile.displayName.trim()
        ? profile.displayName.trim()
        : user.displayName || user.email || user.uid,
    role,
    branchIds: claimBranchIds,
    activeBranchId,
    emailVerified: true,
    offlineFallback: false,
    verifiedAt: now,
  };

  lastOnlineVerifiedBindings.set(user.uid, {
    role,
    branchIds: [...claimBranchIds],
    activeBranchId,
    verifiedAt: now,
    verifiedMonotonicMs: defaultMonotonicNow(),
  });

  return session;
}

export async function resolvePharmacySession(
  user: User,
  options?: { preferServer?: boolean }
): Promise<PharmacySession> {
  const existingResolution = inFlightSessionResolutions.get(user.uid);
  if (existingResolution) {
    return existingResolution;
  }

  const task = resolvePharmacySessionInternal(user, options)
    .catch((err) => {
      syncTrustedActorToPharmacyDb(null);
      throw err;
    })
    .finally(() => {
      inFlightSessionResolutions.delete(user.uid);
    });
  inFlightSessionResolutions.set(user.uid, task);
  return task;
}

async function resolvePharmacySessionInternal(
  user: User,
  options?: { preferServer?: boolean }
): Promise<PharmacySession> {
  if (!user.emailVerified) {
    clearOfflineSessionSnapshot(user.uid);
    syncTrustedActorToPharmacyDb(null);
    throw new Error('يجب تأكيد البريد الإلكتروني أولاً قبل الدخول إلى النظام.');
  }

  const normalizedEmail = (user.email || '').trim().toLowerCase();
  const { db } = getFirebaseServices();
  const userPath = `users/${user.uid}`;
  const userRef = doc(db, 'users', user.uid);

  const tryOfflineCashierFallback = (fallbackErrMsg?: string): PharmacySession => {
    const validation = validateOfflineSessionSnapshot(user, Date.now());
    if (validation.valid && validation.session) {
      syncTrustedActorToPharmacyDb(validation.session);
      return validation.session;
    }
    syncTrustedActorToPharmacyDb(null);
    throw new Error(validation.message || fallbackErrMsg || 'تعذر التحقق من صلاحيات الحساب بدون اتصال بالإنترنت.');
  };

  if (isBrowserOffline()) {
    return tryOfflineCashierFallback();
  }

  let profileSnap: DocumentSnapshot<DocumentData>;
  try {
    if (options?.preferServer) {
      profileSnap = await getDocFromServer(userRef);
    } else {
      profileSnap = await getDoc(userRef);
    }
  } catch (error) {
    if (isOfflineError(error)) {
      return tryOfflineCashierFallback();
    }
    if (isPermissionDeniedError(error)) {
      handleFirestoreError(error, OperationType.GET, userPath);
    }
    throw error;
  }

  // Require explicit server-confirmed snapshot (metadata.fromCache === false).
  // Reject cache snapshots, undefined/missing metadata, incomplete snapshots, or throwing metadata getters.
  if (!isExplicitServerSnapshot(profileSnap)) {
    if (isFromCacheSnapshot(profileSnap)) {
      if (isBrowserOffline()) {
        return tryOfflineCashierFallback();
      }
      if (!options?.preferServer) {
        try {
          profileSnap = await getDocFromServer(userRef);
        } catch (error) {
          if (isOfflineError(error)) {
            return tryOfflineCashierFallback();
          }
          if (isPermissionDeniedError(error)) {
            handleFirestoreError(error, OperationType.GET, userPath);
          }
          throw error;
        }
      }
      if (isFromCacheSnapshot(profileSnap)) {
        return tryOfflineCashierFallback();
      }
    }
    if (!isExplicitServerSnapshot(profileSnap)) {
      throw new Error('تعذر التحقق من مصدر بيانات الحساب من خادم Firestore بشكل موثوق.');
    }
  }

  let profile: Record<string, any> | null = null;
  if (profileSnap.exists()) {
    const loadedProfile = profileSnap.data();
    if (!loadedProfile || typeof loadedProfile !== 'object') {
      throw new Error('بيانات ملف صلاحيات الحساب غير مكتملة أو غير صالحة.');
    }
    profile = loadedProfile;
  }

  if (!profile) {
    if (normalizedEmail === BOOTSTRAPPED_SUPER_ADMIN_EMAIL) {
      await ensureDefaultBranchesForSuperAdmin(user.uid);
      const newProfile = {
        uid: user.uid,
        email: normalizedEmail,
        displayName: user.displayName || 'مدير النظام (Super Admin)',
        role: 'super_admin' as const,
        branchIds: DEFAULT_BRANCH_DEFINITIONS.map((b) => b.id),
        activeBranchId: 'khalid-1',
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      try {
        await setDoc(userRef, newProfile);
      } catch (error) {
        if (isPermissionDeniedError(error)) {
          handleFirestoreError(error, OperationType.CREATE, userPath);
        }
        throw error;
      }
      const createdSnap = await getDocFromServer(userRef);
      if (!isExplicitServerSnapshot(createdSnap) || !createdSnap.exists()) {
        throw new Error('تعذر تأكيد إنشاء ملف مدير النظام من خادم Firestore بشكل موثوق.');
      }
      const createdProfile = createdSnap.data();
      if (!createdProfile || typeof createdProfile !== 'object') {
        throw new Error('بيانات ملف مدير النظام المنشأ غير مكتملة أو غير صالحة.');
      }
      profile = createdProfile;
    } else if (normalizedEmail) {
      const inviteId = await computeInviteId(normalizedEmail);
      const inviteRef = doc(db, 'staff_invites', inviteId);
      let inviteSnap: DocumentSnapshot<DocumentData>;
      try {
        inviteSnap = await getDoc(inviteRef);
        if (!isExplicitServerSnapshot(inviteSnap)) {
          if (isFromCacheSnapshot(inviteSnap)) {
            if (isBrowserOffline()) {
              return tryOfflineCashierFallback('تعذر التحقق من دعوة الحساب بدون اتصال بالإنترنت.');
            }
            inviteSnap = await getDocFromServer(inviteRef);
            if (isFromCacheSnapshot(inviteSnap)) {
              return tryOfflineCashierFallback('تعذر التحقق من دعوة الحساب من الخادم.');
            }
          }
          if (!isExplicitServerSnapshot(inviteSnap)) {
            throw new Error('تعذر التحقق من مصدر دعوة الحساب من خادم Firestore بشكل موثوق.');
          }
        }
      } catch (error) {
        if (isOfflineError(error)) {
          return tryOfflineCashierFallback('تعذر التحقق من دعوة الحساب بدون اتصال بالإنترنت.');
        }
        if (isPermissionDeniedError(error)) {
          throw new Error(
            'هذا الحساب غير مسجل أو لم تصدر له دعوة نشطة لدى صيدلية خالد. اطلب من مدير النظام إرسال دعوة لبريدك الإلكتروني أولاً.'
          );
        }
        throw error;
      }

      if (!inviteSnap.exists()) {
        throw new Error('هذا الحساب غير مسجل لدى صيدلية خالد. اطلب من مدير النظام إرسال دعوة لبريدك الإلكتروني.');
      }

      const invite = inviteSnap.data();
      if (!invite || typeof invite !== 'object') {
        throw new Error('بيانات دعوة الحساب غير مكتملة أو غير صالحة.');
      }
      if (invite.active !== true || String(invite.email || '').toLowerCase() !== normalizedEmail) {
        throw new Error('دعوة هذا الحساب غير نشطة أو غير مطابقة. تواصل مع مدير النظام.');
      }
      if (typeof invite.claimedUid === 'string' && invite.claimedUid.trim() !== '' && invite.claimedUid !== user.uid) {
        throw new Error('تمت المطالبة بهذه الدعوة مسبقاً من حساب آخر.');
      }

      const branchIds = sanitizeBranchIds(invite.branchIds);
      const newProfile = {
        uid: user.uid,
        email: normalizedEmail,
        displayName: user.displayName || invite.displayName || normalizedEmail,
        role: normalizeRole(invite.role),
        branchIds,
        activeBranchId: branchIds[0] || null,
        active: true,
        inviteId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      try {
        const batch = writeBatch(db);
        batch.set(userRef, newProfile);
        batch.update(inviteRef, {
          claimedUid: user.uid,
          updatedAt: serverTimestamp(),
        });
        await batch.commit();
      } catch (error) {
        if (isPermissionDeniedError(error)) {
          handleFirestoreError(error, OperationType.CREATE, userPath);
        }
        throw error;
      }
      const createdSnap = await getDocFromServer(userRef);
      if (!isExplicitServerSnapshot(createdSnap) || !createdSnap.exists()) {
        throw new Error('تعذر تأكيد إنشاء ملف الحساب من خادم Firestore بشكل موثوق.');
      }
      const createdProfile = createdSnap.data();
      if (!createdProfile || typeof createdProfile !== 'object') {
        throw new Error('بيانات ملف الحساب المنشأ غير مكتملة أو غير صالحة.');
      }
      profile = createdProfile;
    } else {
      throw new Error('حساب المستخدم غير مهيأ ولا يملك بريداً إلكترونياً.');
    }
  }

  const verifiedAt = Date.now();
  try {
    const session = buildVerifiedSessionFromProfile(user, profile, verifiedAt);
    saveOfflineSessionSnapshot(session, verifiedAt);
    syncTrustedActorToPharmacyDb(session);
    return session;
  } catch (err) {
    syncTrustedActorToPharmacyDb(null);
    throw err;
  }
}

export async function getCurrentIdToken(forceRefresh = false): Promise<string | null> {
  try {
    const { auth } = getFirebaseServices();
    const user = auth.currentUser;
    if (!user || user.emailVerified !== true) return null;
    if (isBrowserOffline()) return null;
    return await user.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

export async function reverifyCurrentPharmacySession(): Promise<PharmacySession | null> {
  const { auth } = getFirebaseServices();
  const user = auth.currentUser;
  if (!user) {
    syncTrustedActorToPharmacyDb(null);
    return null;
  }
  if (isBrowserOffline()) {
    const validation = validateOfflineSessionSnapshot(user, Date.now());
    const offlineSession = validation.valid ? validation.session ?? null : null;
    syncTrustedActorToPharmacyDb(offlineSession);
    return offlineSession;
  }
  await reload(user);
  await user.getIdToken(true);
  return await resolvePharmacySession(user, { preferServer: true });
}

export async function signInWithGoogle(): Promise<PharmacySession> {
  const { auth } = getFirebaseServices();
  let credential;
  try {
    credential = await signInWithPopup(auth, googleProvider);
  } catch (error) {
    throw mapFirebaseAuthError(error);
  }
  try {
    return await resolvePharmacySession(credential.user);
  } catch (error) {
    clearOfflineSessionSnapshot(credential.user?.uid);
    syncTrustedActorToPharmacyDb(null);
    await signOut(auth);
    throw error;
  }
}

export async function signInPharmacyUser(email: string, password: string): Promise<PharmacySession> {
  const { auth } = getFirebaseServices();
  let credential;
  try {
    credential = await signInWithEmailAndPassword(auth, email.trim(), password);
  } catch (error) {
    throw mapFirebaseAuthError(error);
  }

  if (!credential.user.emailVerified) {
    try {
      await sendEmailVerification(credential.user);
    } catch {
      // non-fatal if rate-limited
    }
    syncTrustedActorToPharmacyDb(null);
    await signOut(auth);
    throw new Error('تم إرسال رابط تأكيد للبريد الإلكتروني. فعّل بريدك ثم أعد تسجيل الدخول (أو سجّل الدخول عبر Google).');
  }

  try {
    return await resolvePharmacySession(credential.user);
  } catch (error) {
    clearOfflineSessionSnapshot(credential.user?.uid);
    syncTrustedActorToPharmacyDb(null);
    await signOut(auth);
    throw error;
  }
}

export async function signOutPharmacyUser(): Promise<void> {
  const { auth } = getFirebaseServices();
  const uid = auth.currentUser?.uid;
  clearOfflineSessionSnapshot(uid);
  if (uid) {
    lastOnlineVerifiedBindings.delete(uid);
  }
  syncTrustedActorToPharmacyDb(null);
  await signOut(auth);
}

export async function updateActiveBranchPreference(uid: string, branchId: string): Promise<void> {
  if (isBrowserOffline()) {
    throw new Error('تحديث الفرع النشط في السحابة يتطلب اتصالاً بالإنترنت.');
  }
  const { db } = getFirebaseServices();
  const path = `users/${uid}`;
  try {
    await updateDoc(doc(db, 'users', uid), {
      activeBranchId: branchId,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
    throw error;
  }
}

function computeSessionSignature(session: PharmacySession): string {
  return [
    session.uid,
    session.role,
    session.branchIds.join(','),
    session.activeBranchId || '',
    session.emailVerified ? '1' : '0',
    session.offlineFallback ? '1' : '0',
    session.displayName,
  ].join('|');
}

export function observePharmacyAuth(
  callback: (session: PharmacySession | null, error?: Error) => void
): () => void {
  const { auth, db } = getFirebaseServices();
  void testFirestoreConnection().catch(() => false);

  let disposed = false;
  let authEpoch = 0;
  let snapshotEpoch = 0;
  let activeUid: string | null = null;
  let trackedSnapshotUid: string | null = null;
  let userDocUnsub: FirestoreUnsubscribe | null = null;
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;
  let signOutInProgressUid: string | null = null;
  let lastEmittedSignature: string | null = null;
  let lastKnownSession: PharmacySession | null = null;
  let hasEmittedNull = false;
  let reconnectInFlight = false;

  const clearTtlTimer = (): void => {
    if (ttlTimer !== null) {
      clearTimeout(ttlTimer);
      ttlTimer = null;
    }
  };

  const cleanupUserDocListener = (): void => {
    clearTtlTimer();
    snapshotEpoch += 1;
    trackedSnapshotUid = null;
    if (userDocUnsub) {
      try {
        userDocUnsub();
      } catch {
        // ignore listener cleanup error
      }
      userDocUnsub = null;
    }
  };

  const emitNullOnce = (error?: Error): void => {
    if (disposed) return;
    lastEmittedSignature = null;
    lastKnownSession = null;
    syncTrustedActorToPharmacyDb(null);
    if (!error && hasEmittedNull) {
      return;
    }
    hasEmittedNull = true;
    callback(null, error);
  };

  const emitSessionIfChanged = (epoch: number, session: PharmacySession): void => {
    if (disposed || epoch !== authEpoch || activeUid !== session.uid) return;
    const sig = computeSessionSignature(session);
    lastKnownSession = session;
    hasEmittedNull = false;
    syncTrustedActorToPharmacyDb(session);

    clearTtlTimer();
    if (session.offlineFallback && session.role === 'cashier' && session.offlineExpiresAt) {
      const wallRemainingMs = session.offlineExpiresAt - Date.now();
      const monoRemainingMs =
        typeof session.offlineExpiresMonotonicMs === 'number'
          ? session.offlineExpiresMonotonicMs - defaultMonotonicNow()
          : wallRemainingMs;
      const remainingMs = Math.max(10, Math.min(wallRemainingMs, monoRemainingMs));
      // Cap timer delay to signed 32-bit int max to avoid immediate Node/browser wraparound
      const boundedMs = Math.min(remainingMs + 25, 2_147_483_000);
      ttlTimer = setTimeout(() => {
        if (disposed || epoch !== authEpoch) return;
        const current = auth.currentUser;
        if (
          current &&
          current.uid === session.uid &&
          isOfflineSessionExpired(session, Date.now(), defaultMonotonicNow())
        ) {
          clearOfflineSessionSnapshot(session.uid);
          lastOnlineVerifiedBindings.delete(session.uid);
          syncTrustedActorToPharmacyDb(null);
          emitNullOnce(
            new Error(
              'انتهت صلاحية الجلسة المحلية للكاشير (12 ساعة). يرجى الاتصال بالإنترنت لإعادة التحقق؛ جميع المبيعات المحلية محفوظة بأمان.'
            )
          );
        }
      }, boundedMs);
      (ttlTimer as any)?.unref?.();
    }

    if (sig === lastEmittedSignature) {
      return;
    }
    lastEmittedSignature = sig;
    callback(session);
  };

  const revokeSession = async (
    epoch: number,
    uid: string,
    reasonError: Error,
    performFirebaseSignOut: boolean
  ): Promise<void> => {
    if (disposed || epoch !== authEpoch) return;
    cleanupUserDocListener();
    clearOfflineSessionSnapshot(uid);
    lastOnlineVerifiedBindings.delete(uid);
    activeUid = null;
    syncTrustedActorToPharmacyDb(null);
    emitNullOnce(reasonError);

    if (performFirebaseSignOut && signOutInProgressUid !== uid) {
      signOutInProgressUid = uid;
      try {
        await signOut(auth);
      } catch {
        // ignore secondary signOut failure
      } finally {
        if (signOutInProgressUid === uid) {
          signOutInProgressUid = null;
        }
      }
    }
  };

  const handleOfflineTransitionForUser = (
    epoch: number,
    user: User,
    fallbackError?: Error
  ): void => {
    if (disposed || epoch !== authEpoch || activeUid !== user.uid) return;
    clearTtlTimer();

    // Non-cashier roles (admin / super_admin) NEVER retain privileges offline or when Firestore read fails.
    if (lastKnownSession && lastKnownSession.role !== 'cashier') {
      clearOfflineSessionSnapshot(user.uid);
      lastOnlineVerifiedBindings.delete(user.uid);
      syncTrustedActorToPharmacyDb(null);
      emitNullOnce(
        new Error('انقطع الاتصال بالإنترنت. صلاحيات المدير ومدير النظام غير متاحة بدون تحقق سحابي مباشر.')
      );
      return;
    }

    const validation = validateOfflineSessionSnapshot(user, Date.now());
    if (validation.valid && validation.session) {
      emitSessionIfChanged(epoch, validation.session);
      return;
    }

    syncTrustedActorToPharmacyDb(null);
    emitNullOnce(
      fallbackError ||
        new Error(
          validation.message ||
            'تعذر التحقق من الجلسة المحلية. يرجى الاتصال بالإنترنت لإعادة التحقق.'
        )
    );
  };

  const attachUserDocumentListener = (epoch: number, user: User): void => {
    if (disposed || epoch !== authEpoch || activeUid !== user.uid) return;
    if (trackedSnapshotUid === user.uid && userDocUnsub) return;

    cleanupUserDocListener();
    const snapEpoch = ++snapshotEpoch;
    trackedSnapshotUid = user.uid;
    const userRef = doc(db, 'users', user.uid);

    userDocUnsub = onSnapshot(
      userRef,
      { includeMetadataChanges: true },
      async (snap) => {
        if (disposed || snapEpoch !== snapshotEpoch || activeUid !== user.uid) return;
        const liveEpoch = authEpoch;

        // Require explicit server-confirmed snapshot (metadata.fromCache === false).
        // Reject cache snapshots, undefined/missing metadata, incomplete snapshots, or throwing metadata getters.
        if (!isExplicitServerSnapshot(snap)) {
          if (isFromCacheSnapshot(snap) && isBrowserOffline()) {
            handleOfflineTransitionForUser(liveEpoch, user);
          }
          return;
        }

        if (!snap.exists()) {
          await revokeSession(
            liveEpoch,
            user.uid,
            new Error('تم حذف ملف صلاحيات الحساب من النظام. تم إنهاء الجلسة فوراً.'),
            true
          );
          return;
        }

        const profile = snap.data();
        if (!profile || typeof profile !== 'object') {
          await revokeSession(
            liveEpoch,
            user.uid,
            new Error('تعذر قراءة ملف صلاحيات الحساب. تم إنهاء الجلسة.'),
            true
          );
          return;
        }

        if (!user.emailVerified) {
          await revokeSession(
            liveEpoch,
            user.uid,
            new Error('يجب تأكيد البريد الإلكتروني أولاً قبل الدخول إلى النظام.'),
            true
          );
          return;
        }

        try {
          const verifiedAt = Date.now();
          const updatedSession = buildVerifiedSessionFromProfile(user, profile, verifiedAt);
          saveOfflineSessionSnapshot(updatedSession, verifiedAt);
          syncTrustedActorToPharmacyDb(updatedSession);
          emitSessionIfChanged(liveEpoch, updatedSession);
        } catch (err) {
          await revokeSession(
            liveEpoch,
            user.uid,
            err instanceof Error ? err : new Error('تم تحديث أو تعطيل صلاحيات الحساب.'),
            true
          );
        }
      },
      async (error) => {
        if (disposed || snapEpoch !== snapshotEpoch || activeUid !== user.uid) return;
        const liveEpoch = authEpoch;

        if (isPermissionDeniedError(error)) {
          await revokeSession(
            liveEpoch,
            user.uid,
            new Error('تم سحب صلاحيات الوصول لهذا الحساب من الخادم.'),
            true
          );
          return;
        }

        if (isOfflineError(error) || isBrowserOffline()) {
          // Do NOT treat a Firestore read failure while offline as proof of old privileges,
          // and do NOT call signOut in a loop or wipe local IndexedDB/Outbox data.
          handleOfflineTransitionForUser(liveEpoch, user);
          return;
        }

        // Fail closed for unrecoverable listener errors without destroying local IndexedDB data.
        handleOfflineTransitionForUser(
          liveEpoch,
          user,
          error instanceof Error ? error : new Error('تعذر التحقق المباشر من صلاحيات الحساب.')
        );
      }
    );
  };

  const runLiveVerification = async (
    epoch: number,
    user: User,
    forceTokenRefresh: boolean
  ): Promise<void> => {
    if (disposed || epoch !== authEpoch || activeUid !== user.uid) return;

    if (!user.emailVerified) {
      if (!isBrowserOffline()) {
        try {
          await reload(user);
        } catch (reloadErr) {
          if (disposed || epoch !== authEpoch) return;
          if (isTokenRevokedOrDisabledError(reloadErr)) {
            await revokeSession(epoch, user.uid, mapFirebaseAuthError(reloadErr), true);
            return;
          }
        }
      }
      if (!user.emailVerified) {
        await revokeSession(
          epoch,
          user.uid,
          new Error('يجب تأكيد البريد الإلكتروني أولاً قبل الدخول إلى النظام.'),
          true
        );
        return;
      }
    }

    if (!isBrowserOffline()) {
      try {
        // Use getIdTokenResult(false) on id-token events to inspect current token without forcing another onIdTokenChanged loop;
        // forceRefresh=true is used strictly during explicit online reconnect verification.
        if (forceTokenRefresh) {
          await reload(user);
          await user.getIdToken(true);
        } else {
          await user.getIdTokenResult(false);
        }
      } catch (tokenErr) {
        if (disposed || epoch !== authEpoch) return;
        if (isTokenRevokedOrDisabledError(tokenErr)) {
          await revokeSession(epoch, user.uid, mapFirebaseAuthError(tokenErr), true);
          return;
        }
        if (isOfflineError(tokenErr)) {
          handleOfflineTransitionForUser(epoch, user);
          return;
        }
      }
    }

    if (disposed || epoch !== authEpoch || activeUid !== user.uid) return;

    try {
      const session = await resolvePharmacySession(user, {
        preferServer: forceTokenRefresh && !isBrowserOffline(),
      });
      if (disposed || epoch !== authEpoch || activeUid !== user.uid) return;
      emitSessionIfChanged(epoch, session);
      if (!isBrowserOffline()) {
        attachUserDocumentListener(epoch, user);
      }
    } catch (err) {
      if (disposed || epoch !== authEpoch) return;
      if (isOfflineError(err) || isBrowserOffline()) {
        handleOfflineTransitionForUser(
          epoch,
          user,
          err instanceof Error ? err : undefined
        );
        return;
      }
      await revokeSession(
        epoch,
        user.uid,
        err instanceof Error ? err : new Error('تعذر التحقق من حساب الصيدلية.'),
        true
      );
    }
  };

  const unsubscribeToken = onIdTokenChanged(auth, async (user) => {
    if (disposed) return;

    if (!user) {
      authEpoch += 1;
      cleanupUserDocListener();
      activeUid = null;
      syncTrustedActorToPharmacyDb(null);
      if (signOutInProgressUid) {
        // Expected onIdTokenChanged(null) triggered by revokeSession() — avoid clearing the revocation reason or looping.
        signOutInProgressUid = null;
        return;
      }
      emitNullOnce();
      return;
    }

    const isSameActiveUser = activeUid === user.uid;
    if (!isSameActiveUser) {
      cleanupUserDocListener();
      lastKnownSession = null;
      lastEmittedSignature = null;
      hasEmittedNull = false;
      syncTrustedActorToPharmacyDb(null);
    }

    const epoch = ++authEpoch;
    activeUid = user.uid;

    // On token refresh for the same user, inspect token + attach/keep live doc listener without forcing a loop.
    await runLiveVerification(epoch, user, false);
  });

  const unsubscribeConnectivity = subscribeConnectivityChanges(async (status) => {
    if (disposed) return;
    const currentUser = auth.currentUser;
    if (!currentUser) return;

    if (status === 'offline' || isBrowserOffline()) {
      const epoch = authEpoch;
      handleOfflineTransitionForUser(epoch, currentUser);
      return;
    }

    // Network returned ('unknown' / 'online'): re-verify identity, emailVerified, token revocation, role, and branch!
    if (reconnectInFlight) return;
    reconnectInFlight = true;
    try {
      const epoch = ++authEpoch;
      activeUid = currentUser.uid;
      await runLiveVerification(epoch, currentUser, true);
    } finally {
      reconnectInFlight = false;
    }
  });

  return () => {
    disposed = true;
    authEpoch += 1;
    cleanupUserDocListener();
    try {
      unsubscribeConnectivity();
    } catch {
      // ignore
    }
    try {
      unsubscribeToken();
    } catch {
      // ignore
    }
  };
}
