import { register } from 'node:module';
import type { Auth, IdTokenResult, Unsubscribe as AuthUnsubscribe, User } from 'firebase/auth';
import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Unsubscribe as FirestoreUnsubscribe,
} from 'firebase/firestore';
import * as RealFirebaseClient from '../../src/services/firebaseClient.ts';
import type { PharmacySession } from '../../src/services/firebaseAuthService.ts';

// Register test-only module loader once so src/services/firebaseAuthService.ts
// never needs testRuntimeOverrides or any test hooks in production code.
const LOADER_REGISTERED_SYMBOL = Symbol.for('khalid.authTestLoaderRegistered');
if (!(globalThis as any)[LOADER_REGISTERED_SYMBOL]) {
  register('./firebase-auth-mock-loader.mjs', import.meta.url);
  (globalThis as any)[LOADER_REGISTERED_SYMBOL] = true;
}

export interface AuthRuntimeDependencies {
  getServices?: () => { auth: Auth; db: Firestore };
  docFn?: (db: Firestore, path: string, ...pathSegments: string[]) => DocumentReference<DocumentData>;
  onIdTokenChangedFn?: (auth: Auth, nextOrObserver: (user: User | null) => void) => AuthUnsubscribe;
  getDocFn?: (ref: DocumentReference<DocumentData>) => Promise<DocumentSnapshot<DocumentData>>;
  getDocFromServerFn?: (ref: DocumentReference<DocumentData>) => Promise<DocumentSnapshot<DocumentData>>;
  onSnapshotFn?: (
    ref: DocumentReference<DocumentData>,
    options: { includeMetadataChanges: boolean },
    onNext: (snap: DocumentSnapshot<DocumentData>) => void,
    onError: (err: unknown) => void
  ) => FirestoreUnsubscribe;
  signOutFn?: (auth: Auth) => Promise<void>;
  reloadUserFn?: (user: User) => Promise<void>;
  getIdTokenFn?: (user: User, forceRefresh?: boolean) => Promise<string>;
  getIdTokenResultFn?: (user: User, forceRefresh?: boolean) => Promise<IdTokenResult>;
  isOfflineFn?: () => boolean;
  subscribeConnectivityFn?: (listener: (status: string) => void) => () => void;
  testFirestoreConnectionFn?: () => Promise<boolean>;
  setDocFn?: (ref: DocumentReference<DocumentData>, data: unknown) => Promise<void>;
  writeBatchFn?: () => {
    set: (ref: DocumentReference<DocumentData>, data: unknown) => void;
    update: (ref: DocumentReference<DocumentData>, data: unknown) => void;
    commit: () => Promise<void>;
  };
  nowFn?: () => number;
  monotonicNowFn?: () => number;
}

type AuthModuleType = typeof import('../../src/services/firebaseAuthService.ts');

const originalDateNow = Date.now.bind(Date);
const originalPerfNow =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now.bind(performance)
    : () => originalDateNow();

let activeOverrides: AuthRuntimeDependencies = {};
let moduleEpoch = 0;
let currentAuthMod: AuthModuleType | null = null;
const trackedUsers = new Map<string, { uid: string; email: string }>();

function trackUserIdentity(userLike: { uid?: unknown; email?: unknown } | null | undefined): void {
  if (!userLike || typeof userLike.uid !== 'string' || !userLike.uid) return;
  const email =
    typeof userLike.email === 'string' && userLike.email.trim()
      ? userLike.email.trim()
      : `${userLike.uid}@khalid.test`;
  trackedUsers.set(userLike.uid, { uid: userLike.uid, email });
}

function wrapMockUser(user: any): any {
  if (!user || typeof user !== 'object') return user;
  trackUserIdentity(user);
  return new Proxy(user, {
    get(target, prop, receiver) {
      if (prop === 'getIdToken') {
        return (forceRefresh = false) => {
          if (activeOverrides.getIdTokenFn) {
            return activeOverrides.getIdTokenFn(target, forceRefresh);
          }
          return typeof target.getIdToken === 'function'
            ? target.getIdToken(forceRefresh)
            : Promise.resolve('mock-id-token');
        };
      }
      if (prop === 'getIdTokenResult') {
        return (forceRefresh = false) => {
          if (activeOverrides.getIdTokenResultFn) {
            return activeOverrides.getIdTokenResultFn(target, forceRefresh);
          }
          return typeof target.getIdTokenResult === 'function'
            ? target.getIdTokenResult(forceRefresh)
            : Promise.resolve({ token: 'mock-id-token', claims: {} } as any);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function installGlobalClockHooks(overrides: AuthRuntimeDependencies): void {
  if (overrides.nowFn) {
    const fn = overrides.nowFn;
    Date.now = () => fn();
  } else {
    Date.now = originalDateNow;
  }

  if (typeof performance !== 'undefined') {
    const targetMono = overrides.monotonicNowFn ?? originalPerfNow;
    Object.defineProperty(performance, 'now', {
      value: () => targetMono(),
      configurable: true,
      writable: true,
    });
  }
}

function installGlobalFirebaseMocks(): void {
  (globalThis as any).__khalidAuthTestMocks = {
    auth: {
      onIdTokenChanged: (auth: Auth, handler: (u: User | null) => void) => {
        if (activeOverrides.onIdTokenChangedFn) {
          return activeOverrides.onIdTokenChangedFn(auth, (u) => handler(wrapMockUser(u)));
        }
        return () => {};
      },
      reload: async (user: User) => {
        if (activeOverrides.reloadUserFn) {
          return activeOverrides.reloadUserFn(user);
        }
      },
      sendEmailVerification: async () => {},
      signInWithEmailAndPassword: async () => {
        throw new Error('Mock signInWithEmailAndPassword not configured');
      },
      signInWithPopup: async () => {
        throw new Error('Mock signInWithPopup not configured');
      },
      signOut: async (auth: Auth) => {
        if (activeOverrides.signOutFn) {
          return activeOverrides.signOutFn(auth);
        }
      },
    },
    firestore: {
      doc: (db: Firestore, path: string, ...segs: string[]) => {
        if (activeOverrides.docFn) {
          return activeOverrides.docFn(db, path, ...segs);
        }
        return { path: [path, ...segs].join('/') } as any;
      },
      getDoc: async (ref: DocumentReference<DocumentData>) => {
        if (activeOverrides.getDocFn) {
          return activeOverrides.getDocFn(ref);
        }
        throw new Error(`Unexpected unmocked getDoc(${(ref as any)?.path || ''})`);
      },
      getDocFromServer: async (ref: DocumentReference<DocumentData>) => {
        if (activeOverrides.getDocFromServerFn) {
          return activeOverrides.getDocFromServerFn(ref);
        }
        if (activeOverrides.getDocFn) {
          return activeOverrides.getDocFn(ref);
        }
        throw new Error(`Unexpected unmocked getDocFromServer(${(ref as any)?.path || ''})`);
      },
      onSnapshot: (
        ref: DocumentReference<DocumentData>,
        options: { includeMetadataChanges: boolean },
        onNext: (snap: DocumentSnapshot<DocumentData>) => void,
        onError: (err: unknown) => void
      ) => {
        if (activeOverrides.onSnapshotFn) {
          return activeOverrides.onSnapshotFn(ref, options, onNext, onError);
        }
        return () => {};
      },
      serverTimestamp: () => new Date().toISOString(),
      setDoc: async (ref: DocumentReference<DocumentData>, data: unknown) => {
        if (activeOverrides.setDocFn) {
          return activeOverrides.setDocFn(ref, data);
        }
      },
      updateDoc: async () => {},
      writeBatch: () => {
        if (activeOverrides.writeBatchFn) {
          return activeOverrides.writeBatchFn();
        }
        return {
          set: () => {},
          update: () => {},
          commit: async () => {},
        };
      },
    },
    client: {
      getFirebaseServices: () => {
        if (activeOverrides.getServices) {
          const wrappedAuth = new Proxy({}, {
            get(_target, prop, _receiver) {
              const services = activeOverrides.getServices ? activeOverrides.getServices() : null;
              const realAuth = services?.auth;
              if (prop === 'currentUser') {
                return wrapMockUser(realAuth?.currentUser);
              }
              if (realAuth && typeof (realAuth as any)[prop] === 'function') {
                return (realAuth as any)[prop].bind(realAuth);
              }
              return realAuth ? (realAuth as any)[prop] : undefined;
            },
          });
          const services = activeOverrides.getServices();
          return { auth: wrappedAuth as Auth, db: services.db };
        }
        return RealFirebaseClient.getFirebaseServices();
      },
      isBrowserOffline: () => {
        if (activeOverrides.isOfflineFn) {
          return activeOverrides.isOfflineFn();
        }
        return RealFirebaseClient.isBrowserOffline();
      },
      subscribeConnectivityChanges: (listener: (status: string) => void) => {
        if (activeOverrides.subscribeConnectivityFn) {
          return activeOverrides.subscribeConnectivityFn(listener);
        }
        return RealFirebaseClient.subscribeConnectivityChanges(listener);
      },
      testFirestoreConnection: async () => {
        if (activeOverrides.testFirestoreConnectionFn) {
          return activeOverrides.testFirestoreConnectionFn();
        }
        return true;
      },
    },
  };
}

installGlobalFirebaseMocks();

async function ensureAuthModule(): Promise<AuthModuleType> {
  if (!currentAuthMod) {
    moduleEpoch += 1;
    const loaded: AuthModuleType = await import(`../../src/services/firebaseAuthService.ts?testEpoch=${moduleEpoch}`);
    currentAuthMod = loaded;
    return loaded;
  }
  return currentAuthMod;
}

function getLoadedMod(): AuthModuleType {
  if (!currentAuthMod) {
    throw new Error('Auth test module not initialized; await __resetAuthStateForTests() first.');
  }
  return currentAuthMod;
}

export function __setAuthRuntimeForTests(overrides: AuthRuntimeDependencies | null): void {
  activeOverrides = overrides ? { ...overrides } : {};
  installGlobalClockHooks(activeOverrides);
  installGlobalFirebaseMocks();
}

export async function __resetAuthStateForTests(): Promise<void> {
  activeOverrides = {};
  trackedUsers.clear();
  installGlobalClockHooks(activeOverrides);
  installGlobalFirebaseMocks();
  moduleEpoch += 1;
  currentAuthMod = await import(`../../src/services/firebaseAuthService.ts?testEpoch=${moduleEpoch}`);
}

/**
 * Behavioral, non-mutating check against validateOfflineSessionSnapshot to determine
 * whether the isolated auth module currently holds an active in-memory runtime binding
 * for a given UID (without requiring any test hook inside production code).
 */
export function __hasRuntimeBindingForTests(uid: string): boolean {
  const mod = getLoadedMod();
  const info = trackedUsers.get(uid) || { uid, email: `${uid}@khalid.test` };
  if (typeof localStorage === 'undefined') return false;

  const key = `khalid_verified_session_${uid}`;
  const prevRaw = localStorage.getItem(key);
  const now = Date.now();

  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 2,
        uid,
        email: info.email,
        displayName: 'Probe',
        role: 'cashier',
        branchIds: ['khalid-1'],
        activeBranchId: 'khalid-1',
        emailVerified: true,
        cachedAt: now,
      })
    );
    const res = mod.validateOfflineSessionSnapshot(
      {
        uid,
        email: info.email,
        displayName: 'Probe',
        emailVerified: true,
      },
      now + 1
    );
    return res.reason !== 'COLD_RELOAD_REAUTH_REQUIRED';
  } finally {
    if (prevRaw === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, prevRaw);
    }
  }
}

export function __getRuntimeBindingCountForTests(): number {
  let count = 0;
  for (const uid of trackedUsers.keys()) {
    if (__hasRuntimeBindingForTests(uid)) {
      count += 1;
    }
  }
  return count;
}

export const OFFLINE_CASHIER_TTL_MS = 12 * 60 * 60 * 1000;

export async function resolvePharmacySession(
  user: User,
  options?: { preferServer?: boolean }
): Promise<PharmacySession> {
  trackUserIdentity(user);
  const mod = await ensureAuthModule();
  return mod.resolvePharmacySession(wrapMockUser(user), options);
}

export function validateOfflineSessionSnapshot(
  user: Pick<User, 'uid' | 'email' | 'displayName' | 'emailVerified'>,
  now?: number
) {
  trackUserIdentity(user);
  return getLoadedMod().validateOfflineSessionSnapshot(user, now);
}

export function loadOfflineSessionSnapshot(
  user: Pick<User, 'uid' | 'email' | 'displayName' | 'emailVerified'>,
  now?: number
) {
  trackUserIdentity(user);
  return getLoadedMod().loadOfflineSessionSnapshot(user, now);
}

export function saveOfflineSessionSnapshot(session: PharmacySession, now?: number): boolean {
  if (session?.uid) {
    trackUserIdentity({ uid: session.uid, email: session.email });
  }
  return getLoadedMod().saveOfflineSessionSnapshot(session, now);
}

export function clearOfflineSessionSnapshot(uid?: string): void {
  return getLoadedMod().clearOfflineSessionSnapshot(uid);
}

export function isOfflineSessionExpired(
  session: PharmacySession | null | undefined,
  now?: number,
  monotonicNow?: number
): boolean {
  return getLoadedMod().isOfflineSessionExpired(session, now, monotonicNow);
}

export function canSessionPerformAdminOperation(
  session: PharmacySession | null | undefined,
  isOnline?: boolean
): boolean {
  return getLoadedMod().canSessionPerformAdminOperation(session, isOnline);
}

export function canSessionPerformPosOperation(
  session: PharmacySession | null | undefined,
  isOnline?: boolean,
  now?: number,
  monotonicNow?: number
): boolean {
  return getLoadedMod().canSessionPerformPosOperation(session, isOnline, now, monotonicNow);
}

export function observePharmacyAuth(
  callback: (session: PharmacySession | null, error?: Error) => void
): () => void {
  return getLoadedMod().observePharmacyAuth(callback);
}

export async function signOutPharmacyUser(): Promise<void> {
  return getLoadedMod().signOutPharmacyUser();
}

