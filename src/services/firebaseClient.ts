import { initializeApp, getApps, getApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import {
  disableNetwork,
  doc,
  enableNetwork,
  getDocFromServer,
  getFirestore,
  initializeFirestore,
  setLogLevel,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export interface ResolvedFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket: string;
  messagingSenderId: string;
  firestoreDatabaseId: string;
}

export interface FirebaseConfigDiagnostics {
  configured: boolean;
  projectId: string;
  authDomain: string;
  firestoreDatabaseId: string;
  hasAppId: boolean;
  hasMessagingSenderId: boolean;
  missingRequired: string[];
  missingOptional: string[];
  mismatches: string[];
}

export type FirebaseConnectivityStatus = 'unknown' | 'online' | 'offline' | 'error';

interface ImportMetaWithEnv {
  readonly env?: Record<string, string | undefined>;
}

interface RawFirebaseConfigFile {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  appId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  firestoreDatabaseId?: string;
}

type ConnectivityProbeFn = (db: Firestore) => Promise<void>;

export interface FirestoreInstanceOverrides {
  initializeFirestoreFn?: typeof initializeFirestore;
  getFirestoreFn?: typeof getFirestore;
}

const FIRESTORE_PROBE_TIMEOUT_MS = 7000;
let activeProbeLogSuppressions = 0;

function beginConnectivityProbeLogSuppression(): () => void {
  activeProbeLogSuppressions += 1;
  try {
    setLogLevel('silent');
  } catch {
    // ignore logger errors in mocked environments
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeProbeLogSuppressions = Math.max(0, activeProbeLogSuppressions - 1);
    if (activeProbeLogSuppressions === 0) {
      try {
        setLogLevel('error');
      } catch {
        // ignore logger errors in mocked environments
      }
    }
  };
}

const defaultConnectivityProbe: ConnectivityProbeFn = async (db) => {
  const releaseLogs = beginConnectivityProbeLogSuppression();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let timedOut = false;

  try {
    const probePromise = getDocFromServer(doc(db, 'test', 'connection')).then(
      (snap) => {
        settled = true;
        return snap;
      },
      (err) => {
        settled = true;
        throw err;
      }
    );
    // Prevent unhandled rejection warnings if the timeout wins the race and the SDK settles later.
    probePromise.catch(() => {});

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          reject(new Error('unavailable: connection probe timed out'));
        }
      }, FIRESTORE_PROBE_TIMEOUT_MS);
    });

    await Promise.race([probePromise, timeoutPromise]);
  } catch (err) {
    if (timedOut) {
      // Cancel the pending Firestore WatchStream before SDK's 10s OnlineStateTracker timeout fires,
      // then re-enable network so subsequent online operations remain functional.
      await disableNetwork(db).catch(() => {});
      await enableNetwork(db).catch(() => {});
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    releaseLogs();
  }
};

let cachedApp: FirebaseApp | null = null;
let cachedAuth: Auth | null = null;
let cachedDb: Firestore | null = null;
let cachedConfigKey: string | null = null;
let connectivityEpoch = 0;
let inFlightCheck: { epoch: number; token: symbol; promise: Promise<boolean> } | null = null;
let lastConnectivityStatus: FirebaseConnectivityStatus = 'unknown';
let lastConnectivityError: string | null = null;
let customConnectivityProbe: ConnectivityProbeFn | null = null;
let listenersAttachedTarget: EventTarget | null = null;
const connectivityListeners = new Set<(status: FirebaseConnectivityStatus) => void>();

function notifyConnectivityListeners(status: FirebaseConnectivityStatus): void {
  for (const listener of Array.from(connectivityListeners)) {
    try {
      listener(status);
    } catch {
      // ignore listener errors
    }
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function sanitizeFirestoreDatabaseId(
  rawValue: unknown,
  disallowedHostnames: ReadonlyArray<string> = []
): string {
  const trimmed = readString(rawValue);
  if (!trimmed || trimmed === '(default)') return '';
  const lower = trimmed.toLowerCase();
  if (
    disallowedHostnames.some((host) => Boolean(host) && host.toLowerCase() === lower) ||
    lower.endsWith('.firebasestorage.app') ||
    lower.endsWith('.appspot.com') ||
    lower.endsWith('.firebaseapp.com') ||
    trimmed.includes('.') ||
    trimmed.includes('/') ||
    trimmed.includes(':')
  ) {
    return '';
  }
  return /^[a-zA-Z0-9_-]{1,63}$/.test(trimmed) ? trimmed : '';
}

export function resolveFirebaseConfig(
  envOverrides?: Record<string, string | undefined>
): ResolvedFirebaseConfig {
  const metaEnv = envOverrides ?? (import.meta as unknown as ImportMetaWithEnv).env ?? {};
  const fileConfig = firebaseConfig as RawFirebaseConfigFile;
  const fileProjectId = readString(fileConfig.projectId);
  const envProjectId = readString(metaEnv.VITE_FIREBASE_PROJECT_ID);
  const allowEnvFallback = !fileProjectId || (Boolean(envProjectId) && envProjectId === fileProjectId);
  const envValue = (key: string): string => (allowEnvFallback ? readString(metaEnv[key]) : '');
  const authDomain = readString(fileConfig.authDomain) || envValue('VITE_FIREBASE_AUTH_DOMAIN');
  const storageBucket = readString(fileConfig.storageBucket) || envValue('VITE_FIREBASE_STORAGE_BUCKET');
  const disallowedHosts = [storageBucket, authDomain];

  return {
    apiKey: readString(fileConfig.apiKey) || envValue('VITE_FIREBASE_API_KEY'),
    authDomain,
    projectId: fileProjectId || envProjectId,
    appId: readString(fileConfig.appId) || envValue('VITE_FIREBASE_APP_ID'),
    storageBucket,
    messagingSenderId: readString(fileConfig.messagingSenderId) || envValue('VITE_FIREBASE_MESSAGING_SENDER_ID'),
    firestoreDatabaseId:
      sanitizeFirestoreDatabaseId(fileConfig.firestoreDatabaseId, disallowedHosts) ||
      sanitizeFirestoreDatabaseId(envValue('VITE_FIREBASE_FIRESTORE_DATABASE_ID'), disallowedHosts) ||
      sanitizeFirestoreDatabaseId(envValue('VITE_FIREBASE_DATABASE_ID'), disallowedHosts),
  };
}

export function getFirebaseConfigDiagnostics(
  cfg: ResolvedFirebaseConfig = resolveFirebaseConfig()
): FirebaseConfigDiagnostics {
  const missingRequired: string[] = [];
  if (!cfg.apiKey) missingRequired.push('apiKey');
  if (!cfg.authDomain) missingRequired.push('authDomain');
  if (!cfg.projectId) missingRequired.push('projectId');

  const missingOptional: string[] = [];
  if (!cfg.appId) missingOptional.push('appId');
  if (!cfg.messagingSenderId) missingOptional.push('messagingSenderId');

  const mismatches: string[] = [];
  if (cfg.projectId && cfg.authDomain.endsWith('.firebaseapp.com')) {
    const expectedAuthDomain = `${cfg.projectId}.firebaseapp.com`;
    if (cfg.authDomain !== expectedAuthDomain) {
      mismatches.push(`authDomain (${cfg.authDomain}) does not match projectId (${cfg.projectId})`);
    }
  }
  if (
    cfg.projectId &&
    (cfg.storageBucket.endsWith('.firebasestorage.app') || cfg.storageBucket.endsWith('.appspot.com'))
  ) {
    if (!cfg.storageBucket.startsWith(`${cfg.projectId}.`)) {
      mismatches.push(`storageBucket (${cfg.storageBucket}) does not match projectId (${cfg.projectId})`);
    }
  }
  if (cfg.appId && cfg.messagingSenderId) {
    const appIdParts = cfg.appId.split(':');
    if (appIdParts.length >= 2 && appIdParts[1] !== cfg.messagingSenderId) {
      mismatches.push(`appId sender (${appIdParts[1]}) does not match messagingSenderId (${cfg.messagingSenderId})`);
    }
  }

  return {
    configured: missingRequired.length === 0 && mismatches.length === 0,
    projectId: cfg.projectId,
    authDomain: cfg.authDomain,
    firestoreDatabaseId: cfg.firestoreDatabaseId || '(default)',
    hasAppId: Boolean(cfg.appId),
    hasMessagingSenderId: Boolean(cfg.messagingSenderId),
    missingRequired,
    missingOptional,
    mismatches,
  };
}

export function isFirebaseConfigured(): boolean {
  return getFirebaseConfigDiagnostics().configured;
}

function buildFirebaseOptions(cfg: ResolvedFirebaseConfig): FirebaseOptions {
  const options: FirebaseOptions = {
    apiKey: cfg.apiKey,
    authDomain: cfg.authDomain,
    projectId: cfg.projectId,
  };
  if (cfg.storageBucket) options.storageBucket = cfg.storageBucket;
  if (cfg.appId) options.appId = cfg.appId;
  if (cfg.messagingSenderId) options.messagingSenderId = cfg.messagingSenderId;
  return options;
}

export function normalizeFirebaseErrorCode(error: unknown): string {
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof rawCode !== 'string') return '';
  return rawCode.trim().toLowerCase().replace(/^firestore\//, '');
}

export function isFirestoreAlreadyInitializedError(error: unknown): boolean {
  if (normalizeFirebaseErrorCode(error) !== 'failed-precondition') {
    return false;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
  return (
    message.includes('already been called') ||
    message.includes('already been started') ||
    message.includes('already initialized') ||
    message.includes('different options')
  );
}

export function resolveFirestoreInstance(
  app: FirebaseApp,
  firestoreDatabaseId: string,
  overrides?: FirestoreInstanceOverrides
): Firestore {
  const initFn = overrides?.initializeFirestoreFn ?? initializeFirestore;
  const getFn = overrides?.getFirestoreFn ?? getFirestore;
  const firestoreSettings = { experimentalAutoDetectLongPolling: true };
  const resolvedDbId = sanitizeFirestoreDatabaseId(firestoreDatabaseId);

  try {
    return resolvedDbId
      ? initFn(app, firestoreSettings, resolvedDbId)
      : initFn(app, firestoreSettings);
  } catch (error) {
    if (isFirestoreAlreadyInitializedError(error)) {
      return resolvedDbId ? getFn(app, resolvedDbId) : getFn(app);
    }
    throw error;
  }
}

export function getFirebaseServices(): { app: FirebaseApp; auth: Auth; db: Firestore } {
  const cfg = resolveFirebaseConfig();
  const diagnostics = getFirebaseConfigDiagnostics(cfg);
  if (!diagnostics.configured) {
    const reasons = [
      ...diagnostics.missingRequired.map((field) => `missing ${field}`),
      ...diagnostics.mismatches,
    ].join('; ');
    throw new Error(
      `Firebase is not configured (${reasons || 'invalid config'}). Check firebase-applet-config.json or VITE_FIREBASE_* settings.`
    );
  }

  const configKey = JSON.stringify([cfg.projectId, cfg.apiKey, cfg.authDomain, cfg.appId, cfg.firestoreDatabaseId]);
  if (cachedConfigKey && cachedConfigKey !== configKey) {
    cachedApp = null;
    cachedAuth = null;
    cachedDb = null;
    connectivityEpoch += 1;
    inFlightCheck = null;
    lastConnectivityStatus = 'unknown';
    lastConnectivityError = null;
  }
  cachedConfigKey = configKey;

  if (!cachedApp) {
    const existingDefaultApp = getApps().find((app) => app.name === '[DEFAULT]');
    if (existingDefaultApp && existingDefaultApp.options.projectId === cfg.projectId) {
      cachedApp = existingDefaultApp;
    } else if (!existingDefaultApp) {
      cachedApp = initializeApp(buildFirebaseOptions(cfg));
    } else {
      cachedApp = getApp();
    }
  }
  if (!cachedAuth) {
    cachedAuth = getAuth(cachedApp);
  }
  if (!cachedDb) {
    cachedDb = resolveFirestoreInstance(cachedApp, cfg.firestoreDatabaseId);
  }

  return { app: cachedApp, auth: cachedAuth, db: cachedDb };
}

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  let currentUser: Auth['currentUser'] = null;
  try {
    currentUser = getFirebaseServices().auth.currentUser;
  } catch {
    currentUser = null;
  }

  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid ?? null,
      email: currentUser?.email ?? null,
      emailVerified: currentUser?.emailVerified ?? null,
      isAnonymous: currentUser?.isAnonymous ?? null,
      tenantId: currentUser?.tenantId ?? null,
      providerInfo:
        currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) ?? [],
    },
    operationType,
    path,
  };

  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function handleOfflineTransition(): void {
  connectivityEpoch += 1;
  inFlightCheck = null;
  lastConnectivityStatus = 'offline';
  lastConnectivityError = 'Browser is currently offline.';
  notifyConnectivityListeners('offline');
}

function handleOnlineTransition(): void {
  connectivityEpoch += 1;
  inFlightCheck = null;
  lastConnectivityStatus = 'unknown';
  lastConnectivityError = null;
  notifyConnectivityListeners('unknown');
}

function resolveNetworkEventTarget(): EventTarget | null {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    return window;
  }
  if (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as unknown as Partial<EventTarget>).addEventListener === 'function'
  ) {
    return globalThis as unknown as EventTarget;
  }
  return null;
}

export function ensureConnectivityListenersAttached(): void {
  const target = resolveNetworkEventTarget();
  if (!target || listenersAttachedTarget === target) return;

  if (listenersAttachedTarget) {
    listenersAttachedTarget.removeEventListener('offline', handleOfflineTransition);
    listenersAttachedTarget.removeEventListener('online', handleOnlineTransition);
  }

  target.addEventListener('offline', handleOfflineTransition);
  target.addEventListener('online', handleOnlineTransition);
  listenersAttachedTarget = target;
}

ensureConnectivityListenersAttached();

export async function testFirestoreConnection(): Promise<boolean> {
  ensureConnectivityListenersAttached();

  if (isBrowserOffline()) {
    if (lastConnectivityStatus !== 'offline' || inFlightCheck !== null) {
      handleOfflineTransition();
    } else {
      lastConnectivityError = 'Browser is currently offline.';
    }
    return false;
  }

  if (inFlightCheck && inFlightCheck.epoch === connectivityEpoch) {
    return inFlightCheck.promise;
  }

  if (lastConnectivityStatus === 'online') {
    return true;
  }

  const probeEpoch = connectivityEpoch;
  const checkToken = Symbol('firestore-connectivity-probe');
  const runProbe = customConnectivityProbe ?? defaultConnectivityProbe;

  const checkPromise = (async (): Promise<boolean> => {
    try {
      const { db } = getFirebaseServices();
      await runProbe(db);

      if (probeEpoch !== connectivityEpoch || isBrowserOffline()) {
        if (isBrowserOffline() && lastConnectivityStatus !== 'offline') {
          handleOfflineTransition();
        }
        return false;
      }

      lastConnectivityStatus = 'online';
      lastConnectivityError = null;
      return true;
    } catch (error) {
      const code = normalizeFirebaseErrorCode(error);
      const message = error instanceof Error ? error.message : String(error);

      if (probeEpoch !== connectivityEpoch || isBrowserOffline()) {
        if (isBrowserOffline() && lastConnectivityStatus !== 'offline') {
          handleOfflineTransition();
        }
        return false;
      }

      lastConnectivityError = message;
      // Permission denied on default-deny test/connection confirms live server reachability.
      if (message.includes('Missing or insufficient permissions') || code === 'permission-denied') {
        lastConnectivityStatus = 'online';
        lastConnectivityError = null;
        return true;
      }
      if (
        message.toLowerCase().includes('the client is offline') ||
        code === 'unavailable' ||
        code === 'deadline-exceeded' ||
        message.toLowerCase().includes('unavailable') ||
        message.toLowerCase().includes('timed out')
      ) {
        lastConnectivityStatus = 'offline';
        console.warn('Firestore background probe is offline; continuing in offline-first mode.');
        return false;
      }
      lastConnectivityStatus = 'error';
      return false;
    } finally {
      if (inFlightCheck && inFlightCheck.epoch === probeEpoch && inFlightCheck.token === checkToken) {
        inFlightCheck = null;
      }
    }
  })();

  inFlightCheck = { epoch: probeEpoch, token: checkToken, promise: checkPromise };
  return checkPromise;
}

export function getFirebaseConnectivityStatus(): FirebaseConnectivityStatus {
  return lastConnectivityStatus;
}

export function getLastFirebaseConnectivityError(): string | null {
  return lastConnectivityError;
}

export function subscribeConnectivityChanges(
  listener: (status: FirebaseConnectivityStatus) => void
): () => void {
  ensureConnectivityListenersAttached();
  connectivityListeners.add(listener);
  return () => {
    connectivityListeners.delete(listener);
  };
}

export function __setFirestoreProbeForTests(probe: ConnectivityProbeFn | null): void {
  customConnectivityProbe = probe;
}

export function __resetFirebaseClientConnectivityForTests(): void {
  connectivityEpoch += 1;
  inFlightCheck = null;
  lastConnectivityStatus = 'unknown';
  lastConnectivityError = null;
}
