import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ErrorLogService } from '../src/services/errorLogService.ts';

async function run() {
  const service = new ErrorLogService('KhalidPharmacyDiagnosticsDB-Test', 3);

  const sensitiveError = new Error(
    'Authorization: Bearer headerSecret access_token=querySecret password=passSecret ' +
    'https://example.test/callback?refresh_token=urlSecret&api_key=urlKeySecret'
  );
  sensitiveError.stack = [
    'Error: Bearer stackBearerSecret',
    '    at https://example.test/path?access_token=stackUrlSecret',
    '    at handler (authorization: Bearer stackHeaderSecret)',
  ].join('\\n');

  await service.recordError({
    source: 'google-drive',
    operation: 'authorization',
    error: sensitiveError,
    correlationId: 'trace-token=correlationSecret',
  });

  const first = await service.list();
  assert.equal(first.length, 1, 'a diagnostic entry is persisted');
  assert.equal(first[0].source, 'google-drive');
  assert.equal(first[0].occurrenceCount, 1);
  assert.ok(['android', 'web', 'unknown'].includes(first[0].platform));
  assert.ok(first[0].timestamp && first[0].id, 'entry includes timestamp and identifier');

  const persistedText = JSON.stringify(first[0]);
  for (const secret of [
    'headerSecret', 'querySecret', 'passSecret', 'urlSecret', 'urlKeySecret',
    'stackBearerSecret', 'stackUrlSecret', 'stackHeaderSecret', 'correlationSecret',
  ]) {
    assert.ok(!persistedText.includes(secret), `sensitive value ${secret} is redacted`);
  }
  assert.ok(first[0].message.includes('[REDACTED]'), 'message includes redaction markers');
  assert.ok(first[0].stack?.includes('[REDACTED]'), 'stack is sanitized before persistence');
  assert.ok(first[0].correlationId.includes('[REDACTED]'), 'correlation IDs are sanitized');

  await service.recordError({
    source: 'structured-error',
    operation: 'json-payload',
    error: { token: 'objectTokenSecret', client_secret: 'objectClientSecret' },
  });
  const structured = (await service.list()).find((entry) => entry.source === 'structured-error');
  assert.ok(structured);
  assert.ok(!structured.message.includes('objectTokenSecret'));
  assert.ok(!structured.message.includes('objectClientSecret'));

  for (let index = 0; index < 5; index += 1) {
    await service.recordError({
      level: index % 2 === 0 ? 'warning' : 'error',
      source: 'retention-test',
      operation: `record-${index}`,
      error: `test failure ${index}`,
    });
  }

  const retained = await service.list({ limit: 20 });
  assert.equal(retained.length, 3, 'retention limit is enforced');
  assert.equal(retained[0].operation, 'record-4', 'newest diagnostic entries are retained');

  const warnings = await service.list({ level: 'warning', limit: 20 });
  assert.ok(warnings.every((entry) => entry.level === 'warning'), 'level filtering is applied');

  const exported = JSON.parse(await service.exportJSON());
  assert.equal(exported.count, 3, 'export contains the retained entries');
  assert.equal(exported.entries.length, 3);

  assert.equal(await service.clear(), true, 'diagnostics can be cleared');
  assert.equal((await service.list()).length, 0, 'clear removes diagnostic entries');

  // Verify Basic auth, quoted multi-word secrets, OAuth query codes, Google ya29 tokens, and JWTs
  const extraSecretError = new Error(
    'Authorization: Basic dXNlcjpwYXNz redirect=https://app.test/cb?code=oauthCodeSecret99&state=ok ' +
    'failed using ya29.a0AfH6SMGoogleSecretToken123 and jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sigSecretKey123'
  );
  await service.recordError({
    source: 'oauth-extra',
    operation: 'token-exchange',
    error: extraSecretError,
  });
  await service.recordError({
    source: 'passphrase-json',
    operation: 'backup',
    error: { passphrase: 'my multi word secret phrase', private_key: 'pemSecretBlock' },
  });
  const extraEntries = await service.list();
  const extraText = JSON.stringify(extraEntries);
  for (const leak of [
    'dXNlcjpwYXNz',
    'oauthCodeSecret99',
    'ya29.a0AfH6SMGoogleSecretToken123',
    'sigSecretKey123',
    'my multi word secret phrase',
    'multi word',
    'pemSecretBlock',
  ]) {
    assert.ok(!extraText.includes(leak), `sensitive value "${leak}" must be redacted`);
  }
  assert.ok(extraText.includes('[REDACTED_GOOGLE_TOKEN]'), 'Google access token marker is applied');
  assert.ok(extraText.includes('[REDACTED_JWT]'), 'JWT marker is applied');

  // Verify non-blocking behavior when IndexedDB is unavailable
  const originalIndexedDb = globalThis.indexedDB;
  try {
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true });
    const unavailableService = new ErrorLogService('UnavailableDiagnosticsDB', 5);
    await unavailableService.recordError({ source: 'fallback', operation: 'noop', error: new Error('db missing') });
    assert.deepEqual(await unavailableService.list(), []);
    assert.equal(await unavailableService.clear(), false);
  } finally {
    Object.defineProperty(globalThis, 'indexedDB', { value: originalIndexedDb, configurable: true });
  }
  await service.clear();


  // Admin-only RBAC verification on ErrorLogService directly
  let currentRole: string | null = 'cashier';
  service.setAccessChecker(() => currentRole === 'admin');
  await service.recordError({ source: 'pos', operation: 'checkout', error: new Error('cashier runtime error') });
  assert.deepEqual(await service.list(), [], 'cashier cannot read diagnostic logs directly via ErrorLogService.list()');
  assert.equal(await service.clear(), false, 'cashier cannot clear diagnostic logs directly via ErrorLogService.clear()');
  await assert.rejects(() => service.exportJSON(), /Admin access required/, 'cashier cannot export diagnostic logs via ErrorLogService.exportJSON()');

  currentRole = 'admin';
  const adminEntries = await service.list();
  assert.equal(adminEntries.length, 1, 'admin can read diagnostic entries recorded during cashier session');
  const adminExport = JSON.parse(await service.exportJSON());
  assert.equal(adminExport.count, 1, 'admin can export diagnostic logs');
  assert.equal(await service.clear(), true, 'admin can clear diagnostic logs');
  service.setAccessChecker(null);

  // Admin-only RBAC verification on actual extracted index.html UI handlers & template guards
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  assert.ok(
    /<section\s+[^>]*v-if="[^"]*currentTab\s*===\s*'errorLogs'[^"]*&&[^"]*canAccess\('errorLogs'\)[^"]*"/.test(indexHtml),
    "errorLogs section in index.html is guarded by canAccess('errorLogs')"
  );

  const canAccessMatch = indexHtml.match(/const\s+canAccess\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\};/);
  assert.ok(canAccessMatch, 'canAccess function exists in index.html');
  const blockMatch = indexHtml.match(
    /const\s+errorLogs\s*=\s*ref\(\[\]\);[\s\S]*?const\s+reportAppError\s*=\s*\([\s\S]*?\n\s*\};/
  );
  assert.ok(blockMatch, 'diagnostics handler block exists in index.html');

  let serviceListCalls = 0;
  let serviceExportCalls = 0;
  let serviceClearCalls = 0;
  let confirmCalls = 0;
  let clipboardCalls = 0;
  let anchorClicks = 0;

  const currentUser = { value: { role: 'cashier' } as { role: string } | null };
  const lang = { value: 'ar' };
  const ref = <T>(v: T) => ({ value: v });
  const computed = <T>(getter: () => T) => ({ get value() { return getter(); } });
  const fakeWindow: any = {
    ErrorLogService: {
      setAccessChecker: () => {},
      list: async () => { serviceListCalls++; return [{ id: '1', level: 'error', source: 'pos', operation: 'op', message: 'msg', timestamp: new Date().toISOString(), appVersion: '0.0.0', platform: 'web', correlationId: 'c1', occurrenceCount: 1 }]; },
      exportJSON: async () => { serviceExportCalls++; return '{"count":1,"entries":[]}'; },
      clear: async () => { serviceClearCalls++; return true; },
      recordError: async () => { throw new Error('Diagnostics DB crashed!'); },
    },
    setTimeout: () => 0,
  };
  const fakeDocument = {
    createElement: () => ({ href: '', download: '', click: () => { anchorClicks++; }, remove: () => {} }),
    body: { appendChild: () => {} },
  };
  const fakeNavigator = { clipboard: { writeText: async () => { clipboardCalls++; } } };
  const fakeConfirm = () => { confirmCalls++; return true; };

  const harness = new Function(
    'ref', 'computed', 'currentUser', 'lang', 'window', 'document', 'navigator', 'confirm',
    `${canAccessMatch![0]}
${blockMatch![0]}
return { canAccess, errorLogs, loadErrorLogs, filteredErrorLogs, exportErrorLogs, clearErrorLogs, copyErrorLog, reportAppError };`
  )(ref, computed, currentUser, lang, fakeWindow, fakeDocument, fakeNavigator, fakeConfirm);

  // Inject cached log entry and test direct invocation as cashier
  harness.errorLogs.value = [{ id: 'cached-1', level: 'error', source: 'pos', operation: 'op', message: 'secret' }];
  currentUser.value = { role: 'cashier' };
  assert.equal(harness.canAccess('errorLogs'), false, 'cashier cannot access errorLogs tab');
  assert.deepEqual(harness.filteredErrorLogs.value, [], 'cashier sees empty filteredErrorLogs even if state was cached');
  assert.equal(await harness.loadErrorLogs(), false, 'cashier direct loadErrorLogs() is blocked');
  assert.deepEqual(harness.errorLogs.value, [], 'cashier loadErrorLogs clears cached errorLogs');
  assert.equal(await harness.exportErrorLogs(), false, 'cashier direct exportErrorLogs() is blocked');
  assert.equal(await harness.clearErrorLogs(), false, 'cashier direct clearErrorLogs() is blocked');
  assert.equal(await harness.copyErrorLog({ id: 'cached-1' }), false, 'cashier direct copyErrorLog() is blocked');
  assert.equal(serviceListCalls, 0);
  assert.equal(serviceExportCalls, 0);
  assert.equal(serviceClearCalls, 0);
  assert.equal(confirmCalls, 0);
  assert.equal(clipboardCalls, 0);
  assert.equal(anchorClicks, 0);

  // Unauthenticated (null user)
  currentUser.value = null;
  assert.equal(harness.canAccess('errorLogs'), false, 'null user cannot access errorLogs tab');
  assert.equal(await harness.loadErrorLogs(), false);
  assert.equal(await harness.exportErrorLogs(), false);
  assert.equal(await harness.clearErrorLogs(), false);
  assert.equal(await harness.copyErrorLog({ id: 'cached-1' }), false);

  // Admin can invoke all functions normally
  currentUser.value = { role: 'admin' };
  assert.equal(harness.canAccess('errorLogs'), true, 'admin can access errorLogs tab');
  assert.equal(await harness.loadErrorLogs(), true, 'admin can load logs');
  assert.equal(harness.filteredErrorLogs.value.length, 1, 'admin sees loaded logs');
  assert.equal(await harness.copyErrorLog(harness.filteredErrorLogs.value[0]), true, 'admin can copy log entry');
  assert.equal(await harness.clearErrorLogs(), true, 'admin can clear logs');
  assert.equal(serviceListCalls, 1);
  assert.equal(serviceClearCalls, 1);
  assert.equal(confirmCalls, 1);
  assert.equal(clipboardCalls, 1);

  // Resilience verification: failing ErrorLogService or IndexedDB never disrupts POS/Inventory/Bankak/Google Drive
  const pharmacyDbSrc = fs.readFileSync(path.join(process.cwd(), 'src/services/pharmacyDb.ts'), 'utf8');
  const errorSvcSrc = fs.readFileSync(path.join(process.cwd(), 'src/services/errorLogService.ts'), 'utf8');
  assert.ok(pharmacyDbSrc.includes('KhalidPharmacyDB') && !pharmacyDbSrc.includes('KhalidPharmacyDiagnosticsDB'));
  assert.ok(errorSvcSrc.includes("DEFAULT_DB_NAME = 'KhalidPharmacyDiagnosticsDB'") && !errorSvcSrc.includes("'KhalidPharmacyDB'"));

  // Synchronous throw inside recordError does not crash reportAppError during POS/Bankak/Drive flows
  fakeWindow.ErrorLogService.recordError = () => { throw new Error('Synchronous IndexedDB failure'); };
  let workflowCompleted = false;
  try {
    harness.reportAppError('pos', 'sale-checkout', new Error('simulated issue'));
    harness.reportAppError('bankak', 'receipt-sync', new Error('simulated issue'));
    harness.reportAppError('google-drive-backup', 'daily-backup', new Error('simulated issue'));
    workflowCompleted = true;
  } catch {
    workflowCompleted = false;
  }
  assert.equal(workflowCompleted, true, 'sync failure in diagnostics never interrupts POS, Bankak, or Google Drive workflows');

  // Asynchronous IndexedDB open failure on real ErrorLogService never throws
  const brokenOpen = indexedDB.open;
  (indexedDB as any).open = () => { throw new Error('Simulated IndexedDB quota/corruption'); };
  try {
    const brokenService = new ErrorLogService('BrokenDiagnosticsDB', 10);
    await brokenService.recordError({ source: 'inventory', operation: 'adjust-stock', error: new Error('stock error') });
    assert.deepEqual(await brokenService.list(), []);
    assert.equal(await brokenService.clear(), false);
  } finally {
    (indexedDB as any).open = brokenOpen;
  }

  console.log('PASS: error log persistence, secret redaction, retention, filtering, export, and clear');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
