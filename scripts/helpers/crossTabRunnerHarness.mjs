import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const TEST_BRANCH_MAIN = 'r4e8-cross-tab-main';
export const TEST_BRANCH_PARKING = 'r4e8-cross-tab-parking';
export const TEST_ADMIN_UID = 'r4e8-admin-user-01';
export const TEST_ADMIN_EMAIL = 'r4e8.admin@khalidpharmacy.test';
export const TEST_CASHIER_UID = 'r4e8-cashier-user-01';
export const TEST_CASHIER_EMAIL = 'r4e8.cashier@khalidpharmacy.test';

export const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
export const DEFAULT_NAV_TIMEOUT_MS = 15_000;
export const DEFAULT_SCENARIO_TIMEOUT_MS = 30_000;
export const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

export function getIsolatedBranchDbName(branchId = TEST_BRANCH_MAIN) {
  const clean = typeof branchId === 'string' ? branchId.trim() : '';
  if (!clean || clean === 'khalid-1' || clean === 'khalid-2') {
    throw new Error(
      `UNSAFE_TEST_BRANCH_ID: Refusing to bind test harness to production/default branch "${clean || 'default'}"`
    );
  }
  return `KhalidPharmacyDB__branch__${clean.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export async function withTimeout(promiseOrFn, timeoutMs, label) {
  const promise = typeof promiseOrFn === 'function' ? Promise.resolve().then(promiseOrFn) : promiseOrFn;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`TIMEOUT: "${label}" exceeded bounded limit of ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') {
        probe.close(() => reject(new Error('Unable to allocate free TCP port for Vite')));
        return;
      }
      const { port } = addr;
      probe.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

export async function resolvePlaywrightAndChromium(options = {}) {
  const fsMod = options.fsMod || fs;
  const candidateModules = options.candidateModules || [
    'playwright',
    '/usr/local/share/bun-global/node_modules/playwright/index.mjs',
    '/usr/local/share/bun-global/node_modules/playwright-core/index.mjs',
  ];

  let playwrightMod = null;
  let resolvedModulePath = null;
  for (const candidate of candidateModules) {
    try {
      const target = candidate.startsWith('/') ? pathToFileURL(candidate).href : candidate;
      const imported = await import(target);
      if (imported?.chromium && typeof imported.chromium.launch === 'function') {
        playwrightMod = imported;
        resolvedModulePath = candidate;
        break;
      }
    } catch {
      // try next pre-installed candidate without triggering installs
    }
  }

  if (!playwrightMod) {
    throw new Error(
      'PLAYWRIGHT_UNAVAILABLE: Pre-installed playwright/playwright-core module not found; refusing to install packages.'
    );
  }

  const candidateExecutables = options.candidateExecutables || [
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    typeof playwrightMod.chromium.executablePath === 'function'
      ? playwrightMod.chromium.executablePath()
      : '',
  ].filter(Boolean);

  let executablePath = null;
  for (const exe of candidateExecutables) {
    try {
      if (fsMod.existsSync(exe)) {
        executablePath = exe;
        break;
      }
    } catch {
      // continue
    }
  }

  if (!executablePath) {
    throw new Error(
      'CHROMIUM_UNAVAILABLE: Pre-installed Chromium executable not found; refusing to download browser.'
    );
  }

  return {
    chromium: playwrightMod.chromium,
    resolvedModulePath,
    executablePath,
  };
}

export function isExpectedExternalFontUrl(urlOrParsed) {
  let parsed = urlOrParsed;
  if (typeof urlOrParsed === 'string') {
    try {
      parsed = new URL(urlOrParsed);
    } catch {
      return false;
    }
  }
  if (!parsed || parsed.protocol !== 'https:') {
    return false;
  }
  return (
    parsed.origin === 'https://fonts.googleapis.com' ||
    parsed.origin === 'https://fonts.gstatic.com'
  );
}

export const EXPECTED_BLOCKED_GOOGLE_GSI_URL = 'https://accounts.google.com/gsi/client';

export function isExpectedBlockedGoogleOAuthUrl(urlOrParsed) {
  if (typeof urlOrParsed === 'string') {
    if (urlOrParsed !== EXPECTED_BLOCKED_GOOGLE_GSI_URL) {
      return false;
    }
    try {
      const parsed = new URL(urlOrParsed);
      return parsed.href === EXPECTED_BLOCKED_GOOGLE_GSI_URL;
    } catch {
      return false;
    }
  }
  return Boolean(
    urlOrParsed &&
      urlOrParsed.protocol === 'https:' &&
      urlOrParsed.href === EXPECTED_BLOCKED_GOOGLE_GSI_URL
  );
}

export function createExternalNetworkTracker() {
  return {
    blockedExternalUrls: [],
    abortedFontUrls: [],
    blockedGoogleOAuthUrls: [],
    unmockedFirebaseUrls: [],
  };
}

export async function createIsolatedBrowserContext(browser, options = {}) {
  return browser.newContext({
    ...options,
    serviceWorkers: 'block',
  });
}

export function buildMockFirebaseSdkBundles(authConfig = {}) {
  const mode = authConfig.mode || 'authenticated';
  const uid = authConfig.uid || TEST_ADMIN_UID;
  const email = authConfig.email || TEST_ADMIN_EMAIL;
  const displayName = authConfig.displayName || 'R4E8 Test Admin';
  const role = authConfig.role || 'admin';
  const emailVerified = authConfig.emailVerified !== undefined ? Boolean(authConfig.emailVerified) : true;
  const branchIds = Array.isArray(authConfig.branchIds)
    ? [...authConfig.branchIds]
    : role === 'cashier'
      ? [TEST_BRANCH_MAIN]
      : [TEST_BRANCH_MAIN, TEST_BRANCH_PARKING];
  const activeBranchId =
    authConfig.activeBranchId !== undefined ? authConfig.activeBranchId : branchIds[0] || TEST_BRANCH_MAIN;
  const profileActive = authConfig.profileActive !== undefined ? Boolean(authConfig.profileActive) : true;
  // In 'revoked' mode, Firebase Auth initially presents an authenticated user whose Firestore profile was deleted/revoked,
  // allowing browser tests to verify fail-closed revocation and forced signOut against Firestore profile checks.
  const hasUser = mode === 'authenticated' || mode === 'revoked';
  const revokedOrMissingProfile = mode === 'revoked';

  const branchDocs = {};
  for (const bid of branchIds) {
    branchDocs[bid] = {
      code: bid.toUpperCase().slice(0, 8),
      nameAr: `فرع اختبار ${bid}`,
      nameEn: `Isolated Test Branch ${bid}`,
      city: 'Test',
      phone: '',
      active: true,
      adminUids: role === 'admin' || role === 'super_admin' ? [uid] : [],
      memberUids: [uid],
    };
  }

  const mockFirebaseAppSource = `
    const apps = [];
    export function initializeApp(options) {
      const app = { name: '[DEFAULT]', options: options || {} };
      apps.length = 0;
      apps.push(app);
      return app;
    }
    export function getApps() { return [...apps]; }
    export function getApp() { return apps[0] || initializeApp({}); }
  `;

  const mockFirebaseAuthSource = `
    const HAS_USER = ${JSON.stringify(hasUser)};
    const UID = ${JSON.stringify(uid)};
    const EMAIL = ${JSON.stringify(email)};
    const DISPLAY_NAME = ${JSON.stringify(displayName)};
    const EMAIL_VERIFIED = ${JSON.stringify(emailVerified)};
    const listeners = new Set();

    const makeUser = () => {
      if (!HAS_USER) return null;
      return {
        uid: UID,
        email: EMAIL,
        displayName: DISPLAY_NAME,
        emailVerified: EMAIL_VERIFIED,
        isAnonymous: false,
        tenantId: null,
        providerData: [{ providerId: 'password', email: EMAIL }],
        getIdToken: async () => 'r4e8-test-id-token-' + UID,
        getIdTokenResult: async () => ({ token: 'r4e8-test-id-token-' + UID, claims: {} }),
      };
    };

    const authInstance = { currentUser: makeUser() };

    export function getAuth() {
      return authInstance;
    }
    export class GoogleAuthProvider {
      setCustomParameters() {}
    }
    export function onIdTokenChanged(_auth, callback) {
      listeners.add(callback);
      Promise.resolve().then(() => {
        if (listeners.has(callback)) {
          callback(authInstance.currentUser);
        }
      });
      return () => {
        listeners.delete(callback);
      };
    }
    export async function reload() {}
    export async function sendEmailVerification() {}
    export async function signInWithEmailAndPassword() {
      throw new Error('TEST_MOCK_AUTH_INTERACTIVE_SIGNIN_DISABLED');
    }
    export async function signInWithPopup() {
      throw new Error('TEST_MOCK_AUTH_INTERACTIVE_POPUP_DISABLED');
    }
    export async function signOut(auth) {
      auth.currentUser = null;
      for (const cb of Array.from(listeners)) {
        await cb(null);
      }
    }
  `;

  const mockFirebaseFirestoreSource = `
    const REVOKED = ${JSON.stringify(revokedOrMissingProfile)};
    const UID = ${JSON.stringify(uid)};
    const EMAIL = ${JSON.stringify(email)};
    const DISPLAY_NAME = ${JSON.stringify(displayName)};
    const ROLE = ${JSON.stringify(role)};
    const BRANCH_IDS = ${JSON.stringify(branchIds)};
    const ACTIVE_BRANCH = ${JSON.stringify(activeBranchId)};
    const PROFILE_ACTIVE = ${JSON.stringify(profileActive)};
    const BRANCH_DOCS = ${JSON.stringify(branchDocs)};

    export class Timestamp {
      constructor(seconds = 0, nanoseconds = 0) {
        this.seconds = Math.trunc(Number(seconds) || 0);
        this.nanoseconds = Math.trunc(Number(nanoseconds) || 0);
      }
      toDate() {
        return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6));
      }
      toMillis() {
        return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
      }
      isEqual(other) {
        return Boolean(other && other.seconds === this.seconds && other.nanoseconds === this.nanoseconds);
      }
      static fromDate(d) {
        const date = d instanceof Date ? d : new Date(d);
        const ms = date.getTime();
        const seconds = Math.floor(ms / 1000);
        const nanoseconds = (ms - seconds * 1000) * 1e6;
        return new Timestamp(seconds, nanoseconds);
      }
      static fromMillis(ms) {
        const num = Number(ms);
        const seconds = Math.floor(num / 1000);
        const nanoseconds = (num - seconds * 1000) * 1e6;
        return new Timestamp(seconds, nanoseconds);
      }
      static now() {
        return Timestamp.fromMillis(Date.now());
      }
    }
    export function initializeFirestore(app) { return { app }; }
    export async function disableNetwork() {}
    export async function enableNetwork() {}
    export function setLogLevel() {}
    export function getFirestore(app) { return { app }; }
    export function doc(_db, ...segments) {
      const clean = segments.filter(Boolean);
      return { path: clean.join('/'), id: clean[clean.length - 1] || '' };
    }
    export function collection(_db, ...segments) {
      const clean = segments.filter(Boolean);
      return { path: clean.join('/'), isCollection: true };
    }
    export function query(target) { return target; }
    export function where() { return {}; }
    export function orderBy() { return {}; }
    export function limit() { return {}; }
    export function serverTimestamp() { return Timestamp.now(); }
    export function arrayRemove(...items) { return { __op: 'arrayRemove', items }; }
    export function arrayUnion(...items) { return { __op: 'arrayUnion', items }; }

    function makeServerSnap(id, data) {
      return {
        id,
        exists: () => Boolean(data),
        data: () => (data ? { ...data } : undefined),
        metadata: { fromCache: false },
      };
    }

    export async function getDoc(ref) {
      const p = String(ref?.path || '');
      if (REVOKED) {
        return makeServerSnap(ref?.id || '', null);
      }
      if (p === 'users/' + UID) {
        return makeServerSnap(UID, {
          uid: UID,
          email: EMAIL,
          displayName: DISPLAY_NAME,
          role: ROLE,
          branchIds: [...BRANCH_IDS],
          activeBranchId: ACTIVE_BRANCH,
          active: PROFILE_ACTIVE,
        });
      }
      if (p.startsWith('branches/')) {
        const bid = p.slice('branches/'.length);
        return makeServerSnap(bid, BRANCH_DOCS[bid] || null);
      }
      if (p === 'test/connection') {
        return makeServerSnap('connection', { ok: true });
      }
      return makeServerSnap(ref?.id || '', null);
    }

    export async function getDocFromServer(ref) {
      return getDoc(ref);
    }

    export async function getDocs(q) {
      const p = String(q?.path || '');
      if (p === 'branches') {
        const docs = REVOKED
          ? []
          : Object.entries(BRANCH_DOCS).map(([id, data]) => makeServerSnap(id, data));
        return {
          docs,
          forEach: (cb) => docs.forEach(cb),
        };
      }
      return { docs: [], forEach: () => {} };
    }

    export function onSnapshot(ref, optsOrNext, maybeNext, _maybeErr) {
      const onNext = typeof optsOrNext === 'function' ? optsOrNext : maybeNext;
      let active = true;
      if (typeof onNext === 'function' && ref?.path === 'users/' + UID) {
        Promise.resolve().then(() => {
          if (!active) return;
          if (REVOKED) {
            onNext(makeServerSnap(UID, null));
          } else {
            onNext(makeServerSnap(UID, {
              uid: UID,
              email: EMAIL,
              displayName: DISPLAY_NAME,
              role: ROLE,
              branchIds: [...BRANCH_IDS],
              activeBranchId: ACTIVE_BRANCH,
              active: PROFILE_ACTIVE,
            }));
          }
        });
      }
      return () => {
        active = false;
      };
    }
    export async function setDoc() {}
    export async function updateDoc() {}
    export async function deleteDoc() {}
    export function writeBatch() {
      return { set: () => {}, update: () => {}, delete: () => {}, commit: async () => {} };
    }
  `;

  return {
    mockFirebaseAppSource,
    mockFirebaseAuthSource,
    mockFirebaseFirestoreSource,
  };
}

export function matchMockFirebasePackageForPath(pathname) {
  const p = String(pathname || '');
  if (
    p.endsWith('/firebase_app.js') ||
    p.includes('/node_modules/.vite/deps/firebase_app.js') ||
    p.startsWith('/node_modules/firebase/app/') ||
    p === '/@id/firebase/app'
  ) {
    return 'app';
  }
  if (
    p.endsWith('/firebase_auth.js') ||
    p.includes('/node_modules/.vite/deps/firebase_auth.js') ||
    p.startsWith('/node_modules/firebase/auth/') ||
    p === '/@id/firebase/auth'
  ) {
    return 'auth';
  }
  if (
    p.endsWith('/firebase_firestore.js') ||
    p.includes('/node_modules/.vite/deps/firebase_firestore.js') ||
    p.startsWith('/node_modules/firebase/firestore/') ||
    p === '/@id/firebase/firestore'
  ) {
    return 'firestore';
  }
  if (
    p.startsWith('/node_modules/@firebase/') ||
    p.startsWith('/node_modules/firebase/') ||
    p.includes('/node_modules/.vite/deps/@firebase') ||
    p.includes('/node_modules/.vite/deps/firebase_') ||
    p.startsWith('/@id/@firebase/') ||
    p.startsWith('/@id/firebase/')
  ) {
    return 'UNMOCKED_FIREBASE';
  }
  return null;
}

export async function installIsolatedFirebaseRoutes(
  context,
  port,
  authConfig = {},
  externalTrackerOrArray = createExternalNetworkTracker()
) {
  const tracker = Array.isArray(externalTrackerOrArray)
    ? {
        blockedExternalUrls: externalTrackerOrArray,
        abortedFontUrls: [],
        blockedGoogleOAuthUrls: [],
        unmockedFirebaseUrls: [],
      }
    : {
        blockedExternalUrls: externalTrackerOrArray?.blockedExternalUrls || [],
        abortedFontUrls: externalTrackerOrArray?.abortedFontUrls || [],
        blockedGoogleOAuthUrls: externalTrackerOrArray?.blockedGoogleOAuthUrls || [],
        unmockedFirebaseUrls: externalTrackerOrArray?.unmockedFirebaseUrls || [],
      };

  const {
    mockFirebaseAppSource,
    mockFirebaseAuthSource,
    mockFirebaseFirestoreSource,
  } = buildMockFirebaseSdkBundles(authConfig);

  const allowedPrefix1 = `http://127.0.0.1:${port}/`;
  const allowedPrefix2 = `http://localhost:${port}/`;

  await context.route('**/*', (route) => {
    const url = route.request().url();
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }

    const isLocalOrigin =
      url.startsWith(allowedPrefix1) ||
      url.startsWith(allowedPrefix2);

    if (isLocalOrigin && parsed) {
      const matched = matchMockFirebasePackageForPath(parsed.pathname || '');
      if (matched === 'app') {
        return route.fulfill({
          status: 200,
          contentType: 'application/javascript; charset=utf-8',
          body: mockFirebaseAppSource,
        });
      }
      if (matched === 'auth') {
        return route.fulfill({
          status: 200,
          contentType: 'application/javascript; charset=utf-8',
          body: mockFirebaseAuthSource,
        });
      }
      if (matched === 'firestore') {
        return route.fulfill({
          status: 200,
          contentType: 'application/javascript; charset=utf-8',
          body: mockFirebaseFirestoreSource,
        });
      }
      if (matched === 'UNMOCKED_FIREBASE') {
        tracker.unmockedFirebaseUrls.push(url);
        tracker.blockedExternalUrls.push(`UNMOCKED_FIREBASE:${url}`);
        return route.abort();
      }
      return route.continue();
    }

    if (url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }

    if (isExpectedExternalFontUrl(parsed)) {
      tracker.abortedFontUrls.push(url);
      return route.abort();
    }

    if (isExpectedBlockedGoogleOAuthUrl(url)) {
      const abortResult = route.abort();
      tracker.blockedGoogleOAuthUrls.push(url);
      return abortResult;
    }

    tracker.blockedExternalUrls.push(url);
    return route.abort();
  });

  return tracker;
}

export function createManagedViteSpawn(port, options = {}) {
  const viteBin = options.viteBin || path.resolve(process.cwd(), 'node_modules/vite/bin/vite.js');
  return spawn(
    process.execPath,
    [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DISABLE_HMR: 'true' },
    }
  );
}

export async function waitForViteReady({
  appUrl,
  server,
  serverLogs,
  getSpawnError,
  fetchFn = fetch,
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) {
      throw new Error(`Vite dev server failed to spawn: ${spawnError.message}`);
    }
    if (server.exitCode !== null) {
      throw new Error(
        `Vite dev server exited early (${server.exitCode}).\n${serverLogs.join('').slice(-2000)}`
      );
    }
    try {
      const response = await fetchFn(appUrl);
      if (response.ok) {
        return true;
      }
    } catch {
      // still booting
    }
    await delay(150);
  }
  throw new Error(`TIMEOUT: Vite dev server did not become reachable within ${timeoutMs}ms`);
}

export async function stopManagedServer(server, options = {}) {
  if (!server || server.pid === undefined || server.pid === null) {
    return;
  }
  const killFn = options.killFn || ((pid, sig) => process.kill(pid, sig));
  const waitMs = options.waitMs ?? 800;

  const isRunning = () => server.exitCode === null && server.signalCode === null;
  const destroyStreams = () => {
    try {
      server.stdout?.destroy?.();
    } catch {
      // ignore stream cleanup error
    }
    try {
      server.stderr?.destroy?.();
    } catch {
      // ignore stream cleanup error
    }
    try {
      server.unref?.();
    } catch {
      // ignore unref error
    }
  };

  if (!isRunning()) {
    destroyStreams();
    return;
  }

  const sendSignalToChildOnly = (sig) => {
    // Signal only the detached child process group created by this harness (fallback: direct child pid).
    try {
      killFn(-server.pid, sig);
    } catch {
      try {
        if (typeof server.kill === 'function') {
          server.kill(sig);
        } else {
          killFn(server.pid, sig);
        }
      } catch {
        // already exited
      }
    }
  };

  const exitPromise = new Promise((resolve) => {
    if (!isRunning()) {
      resolve();
      return;
    }
    const onDone = () => resolve();
    server.once?.('exit', onDone);
    server.once?.('close', onDone);
  });

  sendSignalToChildOnly('SIGTERM');
  await Promise.race([exitPromise, delay(waitMs)]);

  if (isRunning()) {
    sendSignalToChildOnly('SIGKILL');
    await Promise.race([exitPromise, delay(300)]);
  }

  destroyStreams();
}

export async function runManagedCrossTabHarness({
  run,
  findPortFn = findAvailablePort,
  spawnServerFn = createManagedViteSpawn,
  waitForServerFn = waitForViteReady,
  resolvePlaywrightFn = resolvePlaywrightAndChromium,
  fetchFn = fetch,
  killFn = (pid, sig) => process.kill(pid, sig),
  processObj = process,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  cleanupTimeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
  stopServerWaitMs = 800,
  onCleanupError = (err) => console.error('[Harness Cleanup Error]', err),
  onExitFailure = (err) => console.error(err),
}) {
  const serverLogs = [];
  let serverSpawnError = null;
  let server = null;
  let browser = null;
  const trackedContexts = new Set();
  const trackedPages = new Set();
  const cleanupErrors = [];
  let primaryError = null;
  let cleanupPromise = null;

  const trackContext = (ctx) => {
    if (ctx) trackedContexts.add(ctx);
    return ctx;
  };
  const trackPage = (page) => {
    if (page) trackedPages.add(page);
    return page;
  };

  const runBoundedCleanupStep = async (label, fn) => {
    try {
      await withTimeout(fn, cleanupTimeoutMs, `cleanup:${label}`);
    } catch (err) {
      cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
      onCleanupError(err);
    }
  };

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      for (const page of Array.from(trackedPages).reverse()) {
        await runBoundedCleanupStep('closePage', async () => {
          if (typeof page.isClosed !== 'function' || !page.isClosed()) {
            await page.close({ runBeforeUnload: false });
          }
        });
      }
      trackedPages.clear();

      for (const ctx of Array.from(trackedContexts).reverse()) {
        await runBoundedCleanupStep('closeContext', async () => {
          await ctx.close();
        });
      }
      trackedContexts.clear();

      if (browser) {
        const b = browser;
        browser = null;
        await runBoundedCleanupStep('closeBrowser', async () => {
          await b.close();
        });
      }

      if (server) {
        const s = server;
        server = null;
        await runBoundedCleanupStep('stopServer', async () => {
          await stopManagedServer(s, { killFn, waitMs: stopServerWaitMs });
        });
      }
    })();
    return cleanupPromise;
  };

  const abortController = new AbortController();
  let rejectSignalAbort = null;
  let signalRejectTimer = null;
  const signalAbortPromise = new Promise((_, reject) => {
    rejectSignalAbort = reject;
  });

  let signalHandlersInstalled = false;
  let signalTriggered = null;
  let signalExitCode = null;
  const handleSignal = (sigName, code) => {
    if (!signalTriggered) {
      signalTriggered = sigName;
      signalExitCode = code;
    }
    const signalError = new Error(`ABORTED_BY_SIGNAL: ${signalTriggered}`);
    if (!primaryError) {
      primaryError = signalError;
    }
    if (processObj) {
      processObj.exitCode = signalExitCode;
    }
    try {
      abortController.abort(signalError);
    } catch {
      // ignore abort controller listener errors
    }
    void cleanup();
    // Schedule rejection on the next macrotask turn so synchronous/microtask primary errors in run() still win the race
    // while genuinely hung async runs abort within milliseconds without hanging until scenario timeout.
    if (signalRejectTimer === null) {
      signalRejectTimer = setTimeout(() => {
        signalRejectTimer = null;
        rejectSignalAbort?.(signalError);
      }, 0);
      if (typeof signalRejectTimer.unref === 'function') {
        signalRejectTimer.unref();
      }
    }
  };
  const onSigInt = () => handleSignal('SIGINT', 130);
  const onSigTerm = () => handleSignal('SIGTERM', 143);

  if (typeof processObj?.on === 'function') {
    processObj.on('SIGINT', onSigInt);
    processObj.on('SIGTERM', onSigTerm);
    signalHandlersInstalled = true;
  }

  try {
    const execPromise = (async () => {
      const port = await findPortFn();
      const appUrl = `http://127.0.0.1:${port}/`;
      const localhostUrl = `http://localhost:${port}/`;

      server = spawnServerFn(port);
      server.stdout?.on?.('data', (chunk) => serverLogs.push(String(chunk)));
      server.stderr?.on?.('data', (chunk) => serverLogs.push(String(chunk)));
      server.on?.('error', (err) => {
        serverSpawnError = err instanceof Error ? err : new Error(String(err));
      });

      await waitForServerFn({
        appUrl,
        server,
        serverLogs,
        getSpawnError: () => serverSpawnError,
        fetchFn,
        timeoutMs: startupTimeoutMs,
      });

      const pw = await resolvePlaywrightFn();
      browser = await withTimeout(
        () =>
          pw.chromium.launch({
            executablePath: pw.executablePath,
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
          }),
        startupTimeoutMs,
        'chromium.launch'
      );

      const browserVersion = typeof browser.version === 'function' ? browser.version() : 'unknown';

      await run({
        port,
        appUrl,
        localhostUrl,
        browser,
        browserVersion,
        playwrightPath: pw.resolvedModulePath,
        chromiumExecutable: pw.executablePath,
        trackContext,
        trackPage,
        signal: abortController.signal,
      });
    })();

    // Prevent unhandled rejection if signalAbortPromise settles the race first
    execPromise.catch(() => {});

    await Promise.race([execPromise, signalAbortPromise]);

    if (signalTriggered) {
      throw primaryError || new Error(`ABORTED_BY_SIGNAL: ${signalTriggered}`);
    }

    return {
      ok: true,
      cleanupErrors,
      signal: signalTriggered,
    };
  } catch (err) {
    primaryError = err instanceof Error ? err : new Error(String(err));
    onExitFailure(primaryError);
    if (processObj) {
      processObj.exitCode =
        signalExitCode !== null
          ? signalExitCode
          : processObj.exitCode && processObj.exitCode !== 0
            ? processObj.exitCode
            : 1;
    }
    return {
      ok: false,
      error: primaryError,
      cleanupErrors,
      signal: signalTriggered,
    };
  } finally {
    if (signalRejectTimer !== null) {
      clearTimeout(signalRejectTimer);
      signalRejectTimer = null;
    }
    await cleanup();
    if (signalExitCode !== null && processObj) {
      processObj.exitCode = signalExitCode;
    }
    if (signalHandlersInstalled && typeof processObj?.off === 'function') {
      processObj.off('SIGINT', onSigInt);
      processObj.off('SIGTERM', onSigTerm);
    }
  }
}
