import fs from 'node:fs';
import path from 'node:path';
import { GoogleDriveOAuthService } from '../src/services/googleDriveOAuthService';

/**
 * P0.2.4.3 — R8: Restore Missing OAuth Stale-Callback Regression Tests
 * 
 * Verifies:
 * 1. Test A: Stale callback isolation (old callback A cannot affect session B or release its lock).
 * 2. Test B: Stale error_callback isolation (old error_callback A cannot affect session B or release its lock).
 * 3. Test C: R7 Async GIS loading race and session lock preservation.
 * 4. Strict Expiration Boundaries (0s, 30s, 60s, 61s, 3600s).
 * 5. Static rules (zero localStorage, sessionStorage, indexedDB, cookies, direct import.meta.env, drive.appdata scope).
 */

async function runOAuthServiceTestSuite() {
  console.log('===============================================================');
  console.log('P0.2.4.3-R8: Google Drive OAuth Stale-Callback & Regression Suite');
  console.log('===============================================================\n');

  let passedTests: number = 0;
  let totalTests: number = 0;

  function assert(condition: boolean, message: string) {
    totalTests++;
    if (condition) {
      console.log(`✓ PASS: ${message}`);
      passedTests++;
    } else {
      console.error(`✕ FAIL: ${message}`);
      process.exit(1);
    }
  }

  // 1. Static Storage Inspection of googleDriveOAuthService.ts
  const servicePath = path.resolve(process.cwd(), 'src/services/googleDriveOAuthService.ts');
  const serviceCode = fs.readFileSync(servicePath, 'utf-8');

  console.log('[SUITE 1] Static Storage & Security Rules Verification');
  assert(!serviceCode.includes('localStorage.'), 'Zero localStorage. method invocation in googleDriveOAuthService.ts');
  assert(!serviceCode.includes('sessionStorage.'), 'Zero sessionStorage. method invocation in googleDriveOAuthService.ts');
  assert(!serviceCode.includes('indexedDB.'), 'Zero IndexedDB. method invocation in googleDriveOAuthService.ts');
  assert(!serviceCode.includes('document.cookie'), 'Zero Cookie usage in googleDriveOAuthService.ts');
  assert(serviceCode.includes("import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID"), 'Direct import.meta.env usage without dynamic casts');
  assert(serviceCode.includes("https://www.googleapis.com/auth/drive.appdata"), 'Strict drive.appdata scope used');
  console.log();

  // Mock DOM / Browser environment globals for Node.js test execution
  let scriptAppendCount: number = 0;
  let manualGisResolver: (() => void) | null = null;
  let capturedCallback: any = null;

  const createMockGoogle = (cbRef?: (cb: any) => void, errCbRef?: (errCb: any) => void) => ({
    accounts: {
      oauth2: {
        initTokenClient: (config: any) => {
          capturedCallback = config.callback;
          if (cbRef) cbRef(config.callback);
          if (errCbRef) errCbRef(config.error_callback);
          return { requestAccessToken: (opts?: any) => {} };
        },
        revoke: (token: string, done?: () => void) => {
          if (done) done();
        }
      }
    }
  });

  (global as any).window = {
    location: { href: 'http://localhost' },
    google: undefined
  };
  (global as any).document = {
    querySelector: (selector: string) => null,
    createElement: (tag: string) => ({
      src: '',
      async: false,
      defer: false,
      onload: null,
      onerror: null
    }),
    head: {
      appendChild: (el: any) => {
        scriptAppendCount++;
        manualGisResolver = () => {
          (global as any).window.google = createMockGoogle();
          if (typeof el.onload === 'function') el.onload();
        };
      }
    }
  };

  // 2. Interface Verification
  console.log('[SUITE 2] Export Interface Verification');
  const service = new GoogleDriveOAuthService();
  service.getClientId = () => 'test_client_id_123.apps.googleusercontent.com';

  assert(typeof service.getClientId === 'function', 'getClientId export method exists');
  assert(typeof service.initialize === 'function', 'initialize export method exists');
  assert(typeof service.isConnected === 'function', 'isConnected export method exists');
  assert(typeof service.connect === 'function', 'connect export method exists');
  assert(typeof service.disconnect === 'function', 'disconnect export method exists');
  assert(typeof service.getAccessToken === 'function', 'getAccessToken export method exists');
  console.log();

  // 3. Strict Expiration Boundary Tests (0, 30, 60, 61, 3600 seconds)
  console.log('[SUITE 3] Strict Expiration Boundaries (0s, 30s, 60s, 61s, 3600s)');
  let registeredCallback: any = null;
  let registeredErrorCallback: any = null;
  let requestedScope: string | null = null;
  let requestAccessTokenCalls = 0;

  (global as any).window.google = {
    accounts: {
      oauth2: {
        initTokenClient: (config: any) => {
          registeredCallback = config.callback;
          registeredErrorCallback = config.error_callback;
          requestedScope = config.scope;
          return { requestAccessToken: () => { requestAccessTokenCalls++; } };
        },
        revoke: (t: string, cb?: () => void) => { if (cb) cb(); }
      }
    }
  };

  await service.initialize();
  assert(requestAccessTokenCalls === 0, 'initialize() preloads OAuth without opening a consent prompt automatically');

  const testExpirationCase = async (rawExpiresIn: any): Promise<boolean> => {
    const beforeRequestCount = requestAccessTokenCalls;
    const connP = service.connect();
    assert(requestAccessTokenCalls === beforeRequestCount + 1, 'connect() triggers requestAccessToken synchronously in the user-action call stack');
    assert(requestedScope === 'https://www.googleapis.com/auth/drive.appdata', 'every web OAuth token request asks only for the private appData scope');
    registeredCallback({ access_token: 'tok_exp_test', expires_in: rawExpiresIn });
    try {
      await connP;
      return true;
    } catch {
      return false;
    }
  };

  assert((await testExpirationCase(0)) === false, 'expires_in = 0 is REJECTED');
  assert((await testExpirationCase(30)) === false, 'expires_in = 30s is REJECTED (under 60s buffer)');
  assert((await testExpirationCase(60)) === false, 'expires_in = 60s is REJECTED (matches 60s buffer)');
  assert((await testExpirationCase(61)) === true, 'expires_in = 61s is ACCEPTED (usable duration 1s)');
  await service.disconnect();

  assert((await testExpirationCase(3600)) === true, 'expires_in = 3600s is ACCEPTED (usable duration 3540s)');
  assert(service.isConnected(), 'Token active for 3600s expiration');
  await service.disconnect();
  console.log();

  assert((await testExpirationCase(undefined)) === false, 'missing expires_in is REJECTED');
  assert((await testExpirationCase('3600')) === false, 'non-numeric expires_in is REJECTED');
  assert((await testExpirationCase(-1)) === false, 'negative expires_in is REJECTED');

  // Popup failures must reject the active connection without leaving its lock held.
  const popupPromise = service.connect();
  registeredErrorCallback({ message: 'popup_closed' });
  let popupRejected = false;
  try { await popupPromise; } catch (error: any) { popupRejected = String(error?.message).includes('popup_closed'); }
  assert(popupRejected && (service as any).isConnecting === false, 'popup_closed error_callback safely rejects and releases the active OAuth request');

  // Disconnect must invalidate a pending OAuth callback; a delayed response cannot restore the token.
  const pendingConnect = service.connect();
  const delayedCallback = registeredCallback;
  await service.disconnect();
  delayedCallback({ access_token: 'late_token_after_disconnect', expires_in: 3600 });
  let pendingRejected = false;
  try { await pendingConnect; } catch { pendingRejected = true; }
  assert(pendingRejected && !service.isConnected() && service.getAccessToken() === null, 'disconnect during pending connect prevents a late OAuth callback from restoring access');
  console.log();

  // 4. Test A — Stale callback isolation
  console.log('[SUITE 4] Test A — Stale callback isolation');
  let callbackA: any = null;
  let callbackB: any = null;
  let clientInitCount = 0;

  (global as any).window.google = {
    accounts: {
      oauth2: {
        initTokenClient: (config: any) => {
          clientInitCount++;
          if (clientInitCount === 1) {
            callbackA = config.callback;
          } else if (clientInitCount === 2) {
            callbackB = config.callback;
          }
          return { requestAccessToken: () => {} };
        },
        revoke: (t: string, cb?: () => void) => { if (cb) cb(); }
      }
    }
  };

  const pA = service.connect().catch(() => {});
  assert(callbackA !== null, 'Callback A captured successfully');

  await service.disconnect();
  assert(!service.isConnected(), 'Service disconnected after session A');

  const pB = service.connect();
  assert(callbackB !== null, 'Callback B captured successfully');
  assert((service as any).isConnecting === true, 'isConnecting is true during session B');

  // Invoke stale callback A
  try {
    callbackA({ access_token: 'stale_token_A', expires_in: 3600 });
  } catch {}

  assert((service as any).isConnecting === true, 'Stale callback A did not release session B lock');
  assert(!service.isConnected(), 'Stale callback A did not set connected status');
  assert(service.getAccessToken() === null, 'Stale callback A did not set token');

  // Verify Connect C is rejected while B is pending
  let connectCRejected = false;
  try {
    await service.connect();
  } catch (err: any) {
    if (err.message.includes('already in progress')) {
      connectCRejected = true;
    }
  }
  assert(connectCRejected, 'Connect C successfully rejected during pending session B');

  // Complete session B successfully
  callbackB({ access_token: 'valid_token_B', expires_in: 3600 });
  const resB = await pB;
  assert(resB.accessToken === 'valid_token_B', 'Session B completed successfully with token B');
  assert(service.isConnected(), 'Service is connected with session B token');
  await service.disconnect();
  console.log();

  // 5. Test B — Stale error_callback isolation
  console.log('[SUITE 5] Test B — Stale error_callback isolation');
  let errCbA: any = null;
  let errCbB: any = null;
  let errClientInitCount = 0;

  (global as any).window.google = {
    accounts: {
      oauth2: {
        initTokenClient: (config: any) => {
          errClientInitCount++;
          if (errClientInitCount === 1) {
            errCbA = config.error_callback;
            capturedCallback = config.callback;
          } else if (errClientInitCount === 2) {
            errCbB = config.error_callback;
            capturedCallback = config.callback;
          }
          return { requestAccessToken: () => {} };
        },
        revoke: (t: string, cb?: () => void) => { if (cb) cb(); }
      }
    }
  };

  const pA2 = service.connect().catch(() => {});
  assert(errCbA !== null, 'Error callback A captured');

  await service.disconnect();

  const pB2 = service.connect();
  assert(errCbB !== null, 'Error callback B captured');
  assert((service as any).isConnecting === true, 'isConnecting true for B2');

  // Invoke stale error callback A
  try {
    errCbA({ message: 'stale error from session A' });
  } catch {}

  assert((service as any).isConnecting === true, 'Stale error_callback A did not release session B2 lock');
  assert(!service.isConnected(), 'Not connected');

  // Complete session B2 successfully via capturedCallback
  capturedCallback({ access_token: 'valid_token_B2', expires_in: 3600 });
  const resB2 = await pB2;
  assert(resB2.accessToken === 'valid_token_B2', 'Session B2 completed successfully despite stale error_callback A');
  assert(service.isConnected(), 'Service connected with B2 token');
  await service.disconnect();
  console.log();

  // 6. Test C — R7 Async GIS Loading Stale-Session & Lock Test
  console.log('[SUITE 6] Test C — R7 Async GIS Loading Stale-Session & Lock Test');

  (service as any).tokenClient = null;
  (service as any).gisLoadPromise = null;
  (global as any).window.google = undefined;
  scriptAppendCount = 0;
  manualGisResolver = null;
  capturedCallback = null;

  let promiseARejected: boolean = false;
  const promiseA = service.connect().catch((err) => {
    promiseARejected = true;
    throw err;
  });
  promiseA.catch(() => {});

  assert((service as any).isConnecting === true, 'isConnecting is true after starting Connect A');

  await service.disconnect();
  assert((service as any).isConnecting === false, 'isConnecting reset to false after disconnect()');
  assert(!service.isConnected(), 'Not connected');

  const promiseB = service.connect();
  assert((service as any).isConnecting === true, 'isConnecting is true for Connect B pending GIS load');

  assert(manualGisResolver !== null, 'GIS resolver registered');
  const resolveA = manualGisResolver;

  (manualGisResolver as unknown as () => void)();

  await new Promise((r) => setTimeout(r, 20));
  assert((service as any).isConnecting === true, 'Stale GIS load completion from A did NOT release B lock');

  let connectCError: boolean = false;
  try {
    await service.connect();
  } catch (err: any) {
    if (err.message.includes('already in progress')) {
      connectCError = true;
    }
  }
  assert(connectCError, 'Connect C successfully rejected during pending B');

  assert(capturedCallback !== null, 'Callback B registered');
  capturedCallback({ access_token: 'valid_token_B_async', expires_in: 3600 });
  const resBAsync = await promiseB;
  assert(resBAsync.accessToken === 'valid_token_B_async', 'Connect B successfully resolved with token B async');
  assert(service.isConnected(), 'Service is connected with B token');

  assert(promiseARejected, 'Promise A successfully rejected due to stale session');

  await service.disconnect();
  assert(!service.isConnected(), 'Disconnected successfully');
  console.log();

  console.log('===============================================================');
  console.log(`ALL OAUTH R8 TESTS PASSED (${passedTests}/${totalTests})`);
  console.log('===============================================================');
}

runOAuthServiceTestSuite();
