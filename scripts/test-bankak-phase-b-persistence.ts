/**
 * Phase B1 — real-server persistence integration test.
 * Uses a unique temporary directory and never reads/writes the pharmacy's ./data.
 * The seeded completed receipt makes upload use the existing OCR dedup cache,
 * so the test does not invoke Gemini or start background OCR work.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getBankakRetryDelayMs } from '../src/services/bankakRetryPolicy.ts';

const repoRoot = process.cwd();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'khalid-bankak-phase-b1-'));
const dataDir = path.join(tempRoot, 'isolated-bankak-data');
await fs.mkdir(path.join(dataDir, 'receipts'), { recursive: true });

assert.equal(getBankakRetryDelayMs(1, 0), 2000, 'first retry uses the 2-second exponential base');
assert.equal(getBankakRetryDelayMs(1, 0.5), 2500, 'first retry adds bounded jitter');
assert.equal(getBankakRetryDelayMs(2, 0.999), 4999, 'second retry doubles the base and caps jitter');
assert.equal(getBankakRetryDelayMs(6, 0.999), 15999, 'retry delay is capped before bounded jitter');
assert.throws(() => getBankakRetryDelayMs(0, 0), RangeError, 'invalid retry count is rejected');
console.log('PASS: retry policy uses bounded exponential backoff with deterministic jitter bounds.');

const imageBytes = Buffer.from('Khalid Pharmacy Phase B1 persistence fixture');
const idempotencyKey = 'phase-b1-upload-request-0001';
const imageHash = crypto.createHash('sha256').update(imageBytes).digest('hex');
const seedReceipt = {
  id: 'phase-b1-seed',
  status: 'Completed',
  transactionId: 'PHASE-B1-SEED-TXN',
  amount: 12345,
  date: '2026-11-12',
  time: '10:00',
  transactionType: 'test fixture',
  employeeName: 'Phase B1 Test',
  imageFileName: '',
  mimeType: 'image/jpeg',
  imageHash,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
await fs.writeFile(path.join(dataDir, 'bankak_store.json'), JSON.stringify([seedReceipt], null, 2));

const portServer = createServer();
await new Promise<void>((resolve, reject) => {
  portServer.once('error', reject);
  portServer.listen(0, '127.0.0.1', resolve);
});
const address = portServer.address();
if (!address || typeof address === 'string') throw new Error('Could not allocate test port');
const port = address.port;
await new Promise<void>((resolve, reject) => portServer.close((err) => err ? reject(err) : resolve()));

let child: ChildProcess | undefined;
let childLogs = '';
const baseUrl = `http://127.0.0.1:${port}`;

function startServer(targetDataDir = dataDir, extraEnv: Record<string, string> = {}) {
  childLogs = '';
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      BANKAK_DATA_DIR: targetDataDir,
      GEMINI_API_KEY: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout?.on('data', (chunk) => { childLogs += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { childLogs += chunk.toString(); });
  return child;
}

async function waitForHealth(proc: ChildProcess) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Server exited early. Logs:\\n${childLogs}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server did not become healthy. Logs:\\n${childLogs}`);
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const proc = child;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
  child = undefined;
}

try {
  console.log('Phase B1: starting isolated real server...');
  await waitForHealth(startServer()!);
  assert.ok(childLogs.includes(`[Bankak Storage] Resolved data directory: ${dataDir}`), 'startup reports the resolved isolated storage path');
  assert.ok(childLogs.includes('BANKAK_DATA_DIR is configured'), 'startup warns that host-side persistence still requires verification');
  console.log('PASS: startup reports the configured storage path and durability limitation.');

  // The JSON store is single-writer: a second process targeting the same directory must fail closed.
  const competingServer = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port + 1), BANKAK_DATA_DIR: dataDir, GEMINI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let competingLogs = '';
  competingServer.stdout?.on('data', (chunk) => { competingLogs += chunk.toString(); });
  competingServer.stderr?.on('data', (chunk) => { competingLogs += chunk.toString(); });
  const competingExit = await Promise.race([
    new Promise<number | null>((resolve) => competingServer.once('exit', (code) => resolve(code))),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000))
  ]);
  if (competingExit === 'timeout') { competingServer.kill('SIGKILL'); throw new Error('Second server unexpectedly acquired the same Bankak data directory'); }
  assert.notEqual(competingExit, 0, 'second process cannot acquire the active data-directory lock');
  assert.match(competingLogs, /already owns this data directory/, 'competing server reports the existing lock owner');
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200, 'original server remains healthy after competing startup is rejected');
  console.log('PASS: exclusive data-directory lock rejects a second local server process without affecting the owner.');

  const remoteLockDataDir = path.join(tempRoot, 'remote-host-lock-data');
  await fs.mkdir(path.join(remoteLockDataDir, 'receipts'), { recursive: true });
  await fs.mkdir(path.join(remoteLockDataDir, 'upload-transactions'), { recursive: true });
  const remoteLockPath = path.join(remoteLockDataDir, 'bankak-server.lock');
  const remoteLockBytes = Buffer.from(JSON.stringify({ pid: process.pid, hostname: 'phase-b-remote-host-fixture', startedAt: new Date().toISOString(), token: 'remote-host-lock-fixture' }));
  await fs.writeFile(remoteLockPath, remoteLockBytes, { flag: 'wx' });
  const remoteLockServer = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port + 2), BANKAK_DATA_DIR: remoteLockDataDir, GEMINI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let remoteLockLogs = '';
  remoteLockServer.stdout?.on('data', (chunk) => { remoteLockLogs += chunk.toString(); });
  remoteLockServer.stderr?.on('data', (chunk) => { remoteLockLogs += chunk.toString(); });
  const remoteLockExit = await Promise.race([
    new Promise<number | null>((resolve) => remoteLockServer.once('exit', (code) => resolve(code))),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000))
  ]);
  if (remoteLockExit === 'timeout') { remoteLockServer.kill('SIGKILL'); throw new Error('Server unexpectedly ignored a remote-host data-directory lock'); }
  assert.notEqual(remoteLockExit, 0, 'server refuses a data-directory lock owned by another host');
  assert.match(remoteLockLogs, /shared multi-host writes are unsupported/, 'remote lock failure clearly states the unsupported multi-host mode');
  assert.deepEqual(await fs.readFile(remoteLockPath), remoteLockBytes, 'unknown remote-host lock is preserved for operator review');
  console.log('PASS: remote-host lock fails closed and is preserved without unsafe stale-lock deletion.');

  const uploadResponse = await fetch(`${baseUrl}/api/bankak/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      image: imageBytes.toString('base64'),
      mimeType: 'image/jpeg',
      employeeName: 'Phase B1 Integration Test',
      notes: 'Synthetic persistence test only'
    })
  });
  assert.equal(uploadResponse.status, 201, 'upload returns HTTP 201');
  const uploadBody = await uploadResponse.json() as any;
  assert.equal(uploadBody.success, true, 'upload reports success');
  assert.equal(uploadBody.cachedResult, true, 'fixture takes deterministic dedup-cache path');
  const uploadedId = uploadBody.receipt?.id;
  const imageFileName = uploadBody.receipt?.imageFileName;
  assert.ok(uploadedId && imageFileName, 'upload returns receipt ID and image filename');

  const persistedStore = JSON.parse(await fs.readFile(path.join(dataDir, 'bankak_store.json'), 'utf8'));
  assert.ok(persistedStore.some((receipt: any) => receipt.id === uploadedId), 'receipt is committed to isolated JSON store');
  const persistedImage = await fs.readFile(path.join(dataDir, 'receipts', imageFileName));
  assert.deepEqual(persistedImage, imageBytes, 'original image bytes are persisted unchanged');
  console.log('PASS: upload response, JSON record, and original image persisted.');

  const replayResponse = await fetch(`${baseUrl}/api/bankak/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      image: imageBytes.toString('base64'),
      mimeType: 'image/jpeg',
      employeeName: 'Phase B1 Integration Test',
      notes: 'Synthetic persistence test only'
    })
  });
  assert.equal(replayResponse.status, 200, 'same idempotency key and payload returns HTTP 200 replay');
  const replayBody = await replayResponse.json() as any;
  assert.equal(replayBody.idempotentReplay, true, 'same request is identified as an idempotent replay');
  assert.equal(replayBody.receipt?.id, uploadedId, 'replay returns the original receipt ID');

  const mismatchResponse = await fetch(`${baseUrl}/api/bankak/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      image: Buffer.from('different payload for same idempotency key').toString('base64'),
      // Deliberately spoof the original client hash: the server must still detect
      // that the actual uploaded bytes differ.
      imageHash,
      mimeType: 'image/jpeg',
      employeeName: 'Phase B1 Integration Test',
      notes: 'Synthetic persistence test only'
    })
  });
  assert.equal(mismatchResponse.status, 409, 'same key with different payload is rejected');
  const afterIdempotencyStore = JSON.parse(await fs.readFile(path.join(dataDir, 'bankak_store.json'), 'utf8'));
  assert.equal(afterIdempotencyStore.filter((receipt: any) => receipt.idempotencyKey === idempotencyKey).length, 1, 'only one record exists for the idempotency key');
  assert.equal((await fs.readdir(path.join(dataDir, 'receipts'))).length, 1, 'replay and conflict create no extra image files');
  console.log('PASS: request idempotency, payload mismatch conflict, and no duplicate files.');

  const concurrentKey = 'phase-b2-concurrent-upload-0001';
  const concurrentPayload = {
    image: imageBytes.toString('base64'),
    mimeType: 'image/jpeg',
    employeeName: 'Phase B2 Concurrent Test',
    notes: 'Synthetic concurrent request fixture'
  };
  const concurrentResponses = await Promise.all([1, 2].map(() => fetch(`${baseUrl}/api/bankak/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': concurrentKey },
    body: JSON.stringify(concurrentPayload)
  })));
  const concurrentBodies = await Promise.all(concurrentResponses.map((response) => response.json() as Promise<any>));
  assert.deepEqual(concurrentResponses.map((response) => response.status).sort(), [200, 201], 'concurrent same-key requests produce one create and one replay');
  assert.equal(concurrentBodies[0].receipt?.id, concurrentBodies[1].receipt?.id, 'concurrent requests return the same receipt ID');
  const afterConcurrentStore = JSON.parse(await fs.readFile(path.join(dataDir, 'bankak_store.json'), 'utf8'));
  assert.equal(afterConcurrentStore.filter((receipt: any) => receipt.idempotencyKey === concurrentKey).length, 1, 'concurrent requests commit exactly one record');
  assert.equal((await fs.readdir(path.join(dataDir, 'receipts'))).length, 2, 'concurrent replay creates no second image');
  console.log('PASS: concurrent same-key uploads commit exactly one receipt and image.');

  await stopServer();

  // Seed interrupted Pending and Processing tasks while the server is stopped.
  // On startup the real loader must recover both; with no Gemini key configured,
  // each safely terminates in Needs Review without making an external API call.
  const recoveryImageBytes = Buffer.from('Synthetic Phase B4 interrupted OCR task');
  const recoveryImageHash = crypto.createHash('sha256').update(recoveryImageBytes).digest('hex');
  const recoveryStore = JSON.parse(await fs.readFile(path.join(dataDir, 'bankak_store.json'), 'utf8'));
  const recoveryFixtures: any[] = [
    { id: 'phase-b4-interrupted-processing', status: 'Processing' },
    { id: 'phase-b4-pending-task', status: 'Pending' }
  ].map((fixture) => ({
    ...fixture,
    transactionId: null,
    amount: null,
    date: '2026-11-12',
    time: '10:00',
    transactionType: null,
    employeeName: 'Phase B4 Recovery Test',
    imageFileName: `${fixture.id}.jpg`,
    mimeType: 'image/jpeg',
    imageHash: recoveryImageHash + fixture.id,
    retryCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));
  const delayedRetryAt = new Date(Date.now() + 5000).toISOString();
  recoveryFixtures.push({
    ...recoveryFixtures[1],
    id: 'phase-b4-delayed-retry',
    status: 'Pending',
    imageFileName: 'phase-b4-delayed-retry.jpg',
    imageHash: recoveryImageHash + 'delayed',
    nextRetryAt: delayedRetryAt
  });
  for (const fixture of recoveryFixtures) {
    await fs.writeFile(path.join(dataDir, 'receipts', fixture.imageFileName), recoveryImageBytes);
  }
  recoveryStore.unshift(...recoveryFixtures);
  await fs.writeFile(path.join(dataDir, 'bankak_store.json'), JSON.stringify(recoveryStore, null, 2));

  console.log('Phase B4: restarting server with interrupted Pending/Processing tasks...');
  await waitForHealth(startServer()!);
  assert.match(childLogs, /Recovered 3 unfinished tasks across server restart/, 'startup logs both recovered tasks');

  const recoveryDeadline = Date.now() + 15000;
  let recoveredTasks: any[] = [];
  while (Date.now() < recoveryDeadline) {
    const recoveryResponse = await fetch(`${baseUrl}/api/bankak/receipts`);
    const recoveryBody = await recoveryResponse.json() as any;
    recoveredTasks = recoveryBody.receipts.filter((receipt: any) => receipt.id.startsWith('phase-b4-'));
    const immediateTasks = recoveredTasks.filter((receipt: any) => receipt.id !== 'phase-b4-delayed-retry');
    if (immediateTasks.length === 2 && immediateTasks.every((receipt: any) => receipt.status === 'Needs Review')) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const immediateTasks = recoveredTasks.filter((receipt: any) => receipt.id !== 'phase-b4-delayed-retry');
  assert.equal(immediateTasks.length, 2, 'both interrupted tasks remain present after restart');
  assert.ok(immediateTasks.every((receipt: any) => receipt.status === 'Needs Review'), 'recovered tasks reach safe manual-review state without Gemini credentials');
  assert.ok(immediateTasks.every((receipt: any) => receipt.retryCount === 1), 'recovery preserves retry counters');

  const delayedTask = recoveredTasks.find((receipt: any) => receipt.id === 'phase-b4-delayed-retry');
  assert.ok(delayedTask, 'scheduled retry remains present after restart');
  assert.equal(delayedTask.status, 'Pending', 'scheduled retry is not executed before nextRetryAt');
  assert.equal(delayedTask.nextRetryAt, delayedRetryAt, 'scheduled retry timestamp survives restart');

  const delayedDeadline = Date.now() + 10000;
  let delayedFinalStatus = 'Pending';
  while (Date.now() < delayedDeadline) {
    const delayedResponse = await fetch(`${baseUrl}/api/bankak/receipts`);
    const delayedBody = await delayedResponse.json() as any;
    const delayed = delayedBody.receipts.find((receipt: any) => receipt.id === 'phase-b4-delayed-retry');
    delayedFinalStatus = delayed?.status || 'Missing';
    if (delayedFinalStatus === 'Needs Review') break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.equal(delayedFinalStatus, 'Needs Review', 'scheduled retry runs after persisted retry time');
  console.log('PASS: Pending/Processing recovery works and persisted retry times are honored after restart.');

  const listResponse = await fetch(`${baseUrl}/api/bankak/receipts`);
  assert.equal(listResponse.status, 200, 'receipt list works after restart');
  const listBody = await listResponse.json() as any;
  const recovered = listBody.receipts?.find((receipt: any) => receipt.id === uploadedId);
  assert.ok(recovered, 'uploaded receipt survives server restart');
  assert.equal(recovered.imageFileName, imageFileName, 'image reference survives server restart');
  assert.equal(recovered.idempotencyKey, idempotencyKey, 'idempotency key survives server restart');
  const replayAfterRestart = await fetch(`${baseUrl}/api/bankak/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      image: imageBytes.toString('base64'),
      mimeType: 'image/jpeg',
      employeeName: 'Phase B1 Integration Test',
      notes: 'Synthetic persistence test only'
    })
  });
  assert.equal(replayAfterRestart.status, 200, 'idempotency replay works after server restart');
  const restartReplayBody = await replayAfterRestart.json() as any;
  assert.equal(restartReplayBody.receipt?.id, uploadedId, 'post-restart replay returns the original receipt');
  const imageResponse = await fetch(`${baseUrl}/api/bankak/images/${encodeURIComponent(imageFileName)}`);
  assert.equal(imageResponse.status, 200, 'persisted image is served after restart');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), imageBytes, 'served image bytes match original upload');
  console.log('PASS: receipt and image remain readable after server restart.');

  // Simulate a disk failure after the image directory accepts the upload but
  // the parent data directory cannot accept the atomic JSON temp file.
  const receiptsDir = path.join(dataDir, 'receipts');
  const committedImageCountBeforeFailure = (await fs.readdir(receiptsDir)).length;
  await fs.chmod(dataDir, 0o555);
  await fs.chmod(receiptsDir, 0o777);
  const failureKey = 'phase-b3-store-write-failure';
  const failurePayload = {
    image: imageBytes.toString('base64'),
    mimeType: 'image/jpeg',
    employeeName: 'Phase B3 Failure Test',
    notes: 'Synthetic disk-write failure fixture'
  };
  const failedUpload = await fetch(`${baseUrl}/api/bankak/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': failureKey },
    body: JSON.stringify(failurePayload)
  });
  assert.equal(failedUpload.status, 500, 'store write failure returns HTTP 500, never false success');
  const storeAfterFailure = JSON.parse(await fs.readFile(path.join(dataDir, 'bankak_store.json'), 'utf8'));
  assert.equal(storeAfterFailure.some((receipt: any) => receipt.idempotencyKey === failureKey), false, 'failed receipt is not committed');
  assert.equal((await fs.readdir(receiptsDir)).length, committedImageCountBeforeFailure, 'failed image is rolled back while earlier committed images remain');

  const failedManualEdit = await fetch(`${baseUrl}/api/bankak/receipts/${uploadedId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notes: 'This edit must not be acknowledged or retained while storage is read-only' })
  });
  assert.equal(failedManualEdit.status, 500, 'manual receipt edit returns HTTP 500 when durable save fails');
  const afterFailedEdit = await (await fetch(`${baseUrl}/api/bankak/receipts`)).json() as any;
  const restoredAfterEdit = afterFailedEdit.receipts.find((receipt: any) => receipt.id === uploadedId);
  assert.equal(restoredAfterEdit?.notes, 'Synthetic persistence test only', 'manual edit is rolled back in memory when disk commit fails');
  const originalStatusBeforeFailedRetry = restoredAfterEdit?.status;
  const failedManualRetry = await fetch(`${baseUrl}/api/bankak/retry/${uploadedId}`, { method: 'POST' });
  assert.equal(failedManualRetry.status, 500, 'manual retry returns HTTP 500 when durable save fails');
  const afterFailedRetry = await (await fetch(`${baseUrl}/api/bankak/receipts`)).json() as any;
  const restoredAfterRetry = afterFailedRetry.receipts.find((receipt: any) => receipt.id === uploadedId);
  assert.equal(restoredAfterRetry?.status, originalStatusBeforeFailedRetry, 'manual retry request is rolled back to its original status when disk commit fails');
  console.log('PASS: manual edit and retry endpoints roll back memory state and return 500 when durable persistence fails.');

  // Restore write permission and retry the exact same request. This also proves
  // a failed save does not poison the serialized save queue permanently.
  await fs.chmod(dataDir, 0o755);
  await fs.chmod(receiptsDir, 0o755);
  const recoveredUpload = await fetch(`${baseUrl}/api/bankak/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': failureKey },
    body: JSON.stringify(failurePayload)
  });
  assert.equal(recoveredUpload.status, 201, 'same request succeeds after storage permission is restored');
  const recoveredUploadBody = await recoveredUpload.json() as any;
  assert.equal(recoveredUploadBody.success, true, 'retry reports successful durable commit');
  const storeAfterRetry = JSON.parse(await fs.readFile(path.join(dataDir, 'bankak_store.json'), 'utf8'));
  assert.equal(storeAfterRetry.filter((receipt: any) => receipt.idempotencyKey === failureKey).length, 1, 'retry creates exactly one committed receipt');
  assert.equal((await fs.readdir(receiptsDir)).length, committedImageCountBeforeFailure + 1, 'only the newly committed retry image is added');
  console.log('PASS: failed store write returns 500, rolls back image/record, and retry recovers.');

  // Verify the real background worker retries injected transient OCR failures exactly twice.
  await stopServer(); // Free the shared test port before starting the isolated retry-cap server.
  const retryCapDataDir = path.join(tempRoot, 'transient-retry-cap-data');
  await fs.mkdir(path.join(retryCapDataDir, 'receipts'), { recursive: true });
  await fs.writeFile(path.join(retryCapDataDir, 'bankak_store.json'), '[]');
  const retryCapChild = startServer(retryCapDataDir, {
    BANKAK_TEST_MODE: 'true', BANKAK_TEST_TRANSIENT_FAILURES: '3', GEMINI_API_KEY: 'test-only-placeholder-key'
  })!;
  await waitForHealth(retryCapChild);
  const retryCapBytes = Buffer.from('Khalid Pharmacy transient OCR retry-cap fixture');
  const retryCapUpload = await fetch(`${baseUrl}/api/bankak/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'phase-b4-transient-retry-cap' },
    body: JSON.stringify({ image: retryCapBytes.toString('base64'), mimeType: 'image/jpeg', employeeName: 'Retry Cap Test' })
  });
  assert.equal(retryCapUpload.status, 201, 'test receipt is durably accepted before background retries');
  let retryCapReceipt: any = null;
  const retryDeadline = Date.now() + 20000;
  while (Date.now() < retryDeadline) {
    const response = await fetch(`${baseUrl}/api/bankak/receipts`);
    const body = await response.json() as any;
    retryCapReceipt = body.receipts?.find((receipt: any) => receipt.idempotencyKey === 'phase-b4-transient-retry-cap');
    if (retryCapReceipt?.status === 'Failed') break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.equal(retryCapReceipt?.status, 'Failed', 'worker reaches terminal Failed status after exhausting transient retries; receipt=' + JSON.stringify(retryCapReceipt) + '; logs=' + childLogs);
  assert.equal(retryCapReceipt?.retryCount, 2, 'worker performs exactly two automatic retries after the initial attempt');
  assert.equal(retryCapReceipt?.nextRetryAt, undefined, 'terminal task has no pending retry timestamp');
  assert.equal((childLogs.match(/Injected transient OCR failure #/g) || []).length, 3, 'worker executed exactly three attempts: initial plus two retries');
  console.log('PASS: real worker performs exactly two automatic retries for transient 429 failures, then reaches terminal Failed.');
  await stopServer();

  // Verify the worker does not start OCR until Processing is persisted, and retries the claim after a transient persistence failure.
  const processingFailureDir = path.join(tempRoot, 'processing-state-failure-data');
  await fs.mkdir(path.join(processingFailureDir, 'receipts'), { recursive: true });
  await fs.writeFile(path.join(processingFailureDir, 'bankak_store.json'), '[]');
  const processingFailureChild = startServer(processingFailureDir, { BANKAK_TEST_MODE: 'true', BANKAK_TEST_FAIL_PROCESSING_SAVE_ONCE: 'true' })!;
  await waitForHealth(processingFailureChild);
  const processingFailureUpload = await fetch(`${baseUrl}/api/bankak/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'phase-b4-processing-save-failure' },
    body: JSON.stringify({ image: Buffer.from('processing persistence failure fixture').toString('base64'), mimeType: 'image/jpeg', employeeName: 'State Transition Test' })
  });
  assert.equal(processingFailureUpload.status, 201, 'receipt is durably accepted before worker processing');
  let processingFailureReceipt: any = null;
  const processingFailureDeadline = Date.now() + 15000;
  while (Date.now() < processingFailureDeadline) {
    const response = await fetch(`${baseUrl}/api/bankak/receipts`);
    const body = await response.json() as any;
    processingFailureReceipt = body.receipts?.find((receipt: any) => receipt.idempotencyKey === 'phase-b4-processing-save-failure');
    if (processingFailureReceipt?.status === 'Needs Review') break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.equal(processingFailureReceipt?.status, 'Needs Review', 'task proceeds only after the Processing state can be persisted');
  assert.match(childLogs, /Could not persist Processing state; OCR was not started/, 'first attempt explicitly refuses OCR before durable Processing claim');
  assert.equal((childLogs.match(/Injected Processing-state persistence failure/g) || []).length, 1, 'Processing persistence failpoint fires exactly once');
  console.log('PASS: failed Processing-state persistence prevents OCR; the task is requeued and then completes its safe review path.');
  await stopServer();

  // If the final OCR state cannot be saved, keep the durable Processing state and recover it after restart.
  const finalFailureDir = path.join(tempRoot, 'final-state-failure-data');
  await fs.mkdir(path.join(finalFailureDir, 'receipts'), { recursive: true });
  await fs.writeFile(path.join(finalFailureDir, 'bankak_store.json'), '[]');
  const finalFailureChild = startServer(finalFailureDir, { BANKAK_TEST_MODE: 'true', BANKAK_TEST_FAIL_FINAL_SAVE_ONCE: 'true' })!;
  await waitForHealth(finalFailureChild);
  const finalFailureUpload = await fetch(`${baseUrl}/api/bankak/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'phase-b4-final-save-failure' },
    body: JSON.stringify({ image: Buffer.from('final state persistence failure fixture').toString('base64'), mimeType: 'image/jpeg', employeeName: 'State Transition Test' })
  });
  assert.equal(finalFailureUpload.status, 201, 'receipt is accepted before OCR background processing');
  let finalFailureReceipt: any = null;
  const finalFailureDeadline = Date.now() + 12000;
  while (Date.now() < finalFailureDeadline) {
    const response = await fetch(`${baseUrl}/api/bankak/receipts`);
    const body = await response.json() as any;
    finalFailureReceipt = body.receipts?.find((receipt: any) => receipt.idempotencyKey === 'phase-b4-final-save-failure');
    if (childLogs.includes('Final OCR state could not be persisted') && finalFailureReceipt?.status === 'Processing') break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.equal(finalFailureReceipt?.status, 'Processing', 'unpersisted terminal state is not exposed as durable');
  assert.match(childLogs, /Final OCR state could not be persisted/, 'failed final commit is explicitly logged');
  await stopServer();
  await waitForHealth(startServer(finalFailureDir)!);
  let recoveredFinalReceipt: any = null;
  const finalRecoveryDeadline = Date.now() + 12000;
  while (Date.now() < finalRecoveryDeadline) {
    const response = await fetch(`${baseUrl}/api/bankak/receipts`);
    const body = await response.json() as any;
    recoveredFinalReceipt = body.receipts?.find((receipt: any) => receipt.idempotencyKey === 'phase-b4-final-save-failure');
    if (recoveredFinalReceipt?.status === 'Needs Review') break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.equal(recoveredFinalReceipt?.status, 'Needs Review', 'restart reprocesses the durable Processing state and commits a safe terminal review state');
  console.log('PASS: failed final OCR-state commit remains Processing and is safely recovered after a real server restart.');
  await stopServer();

  // Inject image-write and image-rename failures independently; neither may leave a receipt, file, or journal.
  await stopServer();
  for (const scenario of [
    { name: 'image-write', flag: 'BANKAK_TEST_FAIL_IMAGE_WRITE' },
    { name: 'image-rename', flag: 'BANKAK_TEST_FAIL_IMAGE_RENAME' }
  ]) {
    const failureDataDir = path.join(tempRoot, scenario.name + '-failure-data');
    const failureReceiptsDir = path.join(failureDataDir, 'receipts');
    const failureJournalDir = path.join(failureDataDir, 'upload-transactions');
    await fs.mkdir(failureReceiptsDir, { recursive: true });
    await fs.mkdir(failureJournalDir, { recursive: true });
    await fs.writeFile(path.join(failureDataDir, 'bankak_store.json'), '[]');
    const failureChild = startServer(failureDataDir, { BANKAK_TEST_MODE: 'true', [scenario.flag]: 'true' })!;
    await waitForHealth(failureChild);
    const failureResponse = await fetch(`${baseUrl}/api/bankak/upload`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'phase-b3-' + scenario.name + '-failure' },
      body: JSON.stringify({ image: Buffer.from('failure fixture ' + scenario.name).toString('base64'), mimeType: 'image/jpeg', employeeName: 'Failure Injection Test' })
    });
    assert.equal(failureResponse.status, 500, scenario.name + ' failure returns HTTP 500');
    const failureStore = JSON.parse(await fs.readFile(path.join(failureDataDir, 'bankak_store.json'), 'utf8'));
    assert.equal(failureStore.length, 0, scenario.name + ' failure does not create a receipt');
    assert.equal((await fs.readdir(failureReceiptsDir)).length, 0, scenario.name + ' failure leaves no temp or final image');
    assert.equal((await fs.readdir(failureJournalDir)).length, 0, scenario.name + ' failure removes its resolved journal');
    await stopServer();
  }
  console.log('PASS: injected image-write and image-rename failures return 500 with no receipt, image, or stale journal.');

  // Recreate the exact on-disk states left by a process killed during upload:
  // (1) journal + final image but no receipt, and (2) journal + committed receipt.
  await stopServer();
  const recoveryDataDir = path.join(tempRoot, 'upload-journal-recovery-data');
  const recoveryReceiptsDir = path.join(recoveryDataDir, 'receipts');
  const recoveryJournalDir = path.join(recoveryDataDir, 'upload-transactions');
  await fs.mkdir(recoveryReceiptsDir, { recursive: true });
  await fs.mkdir(recoveryJournalDir, { recursive: true });
  const orphanId = 'bnk-1790000000000-a1b2c3';
  const committedId = 'bnk-1790000000001-d4e5f6';
  const recoverStagedId = 'bnk-1790000000002-a7b8c9';
  const orphanFinal = orphanId + '.jpg';
  const committedFinal = committedId + '.jpg';
  const recoverStagedFinal = recoverStagedId + '.jpg';
  await fs.writeFile(path.join(recoveryReceiptsDir, orphanFinal), Buffer.from('uncommitted image'));
  await fs.writeFile(path.join(recoveryReceiptsDir, orphanFinal + '.uploading'), Buffer.from('partial temp'));
  await fs.writeFile(path.join(recoveryReceiptsDir, committedFinal), Buffer.from('committed image'));
  await fs.writeFile(path.join(recoveryReceiptsDir, committedFinal + '.uploading'), Buffer.from('stale temp'));
  await fs.writeFile(path.join(recoveryReceiptsDir, recoverStagedFinal + '.uploading'), Buffer.from('only remaining committed image bytes'));
  const journal = (receiptId: string, finalName: string) => JSON.stringify({
    receiptId, files: [{ finalName, tempName: finalName + '.uploading' }]
  });
  await fs.writeFile(path.join(recoveryJournalDir, orphanId + '.json'), journal(orphanId, orphanFinal));
  await fs.writeFile(path.join(recoveryJournalDir, committedId + '.json'), journal(committedId, committedFinal));
  await fs.writeFile(path.join(recoveryJournalDir, recoverStagedId + '.json'), journal(recoverStagedId, recoverStagedFinal));
  await fs.writeFile(path.join(recoveryDataDir, 'bankak_store.json'), JSON.stringify([
    { id: committedId, status: 'Completed', transactionId: 'RECOVERY-COMMITTED', amount: 100, date: '2026-11-12', time: '10:00', transactionType: 'test', employeeName: 'test', imageFileName: committedFinal, mimeType: 'image/jpeg', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: recoverStagedId, status: 'Completed', transactionId: 'RECOVERY-STAGED', amount: 200, date: '2026-11-12', time: '10:01', transactionType: 'test', employeeName: 'test', imageFileName: recoverStagedFinal, mimeType: 'image/jpeg', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  ]));
  await waitForHealth(startServer(recoveryDataDir)!);
  assert.equal(await fs.readdir(recoveryJournalDir).then((names) => names.length), 0, 'valid recovered journals are removed');
  await assert.rejects(fs.access(path.join(recoveryReceiptsDir, orphanFinal)), 'uncommitted final image is rolled back');
  await assert.rejects(fs.access(path.join(recoveryReceiptsDir, orphanFinal + '.uploading')), 'uncommitted temp image is rolled back');
  assert.deepEqual(await fs.readFile(path.join(recoveryReceiptsDir, committedFinal)), Buffer.from('committed image'), 'committed image is preserved');
  await assert.rejects(fs.access(path.join(recoveryReceiptsDir, committedFinal + '.uploading')), 'stale temp image is removed after commit');
  assert.deepEqual(await fs.readFile(path.join(recoveryReceiptsDir, recoverStagedFinal)), Buffer.from('only remaining committed image bytes'), 'committed receipt is restored from its staged image when final rename was not retained');
  await assert.rejects(fs.access(path.join(recoveryReceiptsDir, recoverStagedFinal + '.uploading')), 'recovered staged image is renamed to its final filename');
  console.log('PASS: startup journal recovery rolls back only uncommitted generated files and preserves committed receipt images.');
  await stopServer();

  // Exercise a real abrupt process kill after final image staging but before JSON commit.
  const crashDataDir = path.join(tempRoot, 'forced-process-crash-data');
  const crashReceiptsDir = path.join(crashDataDir, 'receipts');
  const crashJournalDir = path.join(crashDataDir, 'upload-transactions');
  await fs.mkdir(crashReceiptsDir, { recursive: true });
  await fs.mkdir(crashJournalDir, { recursive: true });
  await fs.writeFile(path.join(crashDataDir, 'bankak_store.json'), '[]');
  const crashChild = startServer(crashDataDir, { BANKAK_TEST_MODE: 'true', BANKAK_TEST_CRASH_AFTER_IMAGE_STAGE: 'true' })!;
  await waitForHealth(crashChild);
  const crashExitPromise = new Promise<string | null>((resolve) => crashChild.once('exit', (_code, signal) => resolve(signal)));
  const crashBytes = Buffer.from('Khalid Pharmacy abrupt process termination fixture');
  try {
    await fetch(`${baseUrl}/api/bankak/upload`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'phase-b3-forced-process-kill' },
      body: JSON.stringify({ image: crashBytes.toString('base64'), mimeType: 'image/jpeg', employeeName: 'Crash Test' })
    });
  } catch { /* SIGKILL closes the request before an HTTP response can be sent. */ }
  const crashExit = await Promise.race([
    crashExitPromise,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000))
  ]);
  assert.equal(crashExit, 'SIGKILL', 'test failpoint abruptly terminates the real server process');
  assert.ok(await fs.readFile(path.join(crashDataDir, 'bankak-server.lock'), 'utf8'), 'SIGKILL leaves the exclusive lock for stale-owner recovery');
  const stagedAfterCrash = await fs.readdir(crashReceiptsDir);
  assert.equal(stagedAfterCrash.length, 1, 'crash leaves exactly the staged final image for recovery');
  assert.equal((await fs.readdir(crashJournalDir)).length, 1, 'crash leaves its transaction journal');
  await waitForHealth(startServer(crashDataDir)!);
  const recoveredLock = JSON.parse(await fs.readFile(path.join(crashDataDir, 'bankak-server.lock'), 'utf8'));
  assert.equal(recoveredLock.pid, child?.pid, 'restart removes stale dead-process lock and acquires a fresh lock');
  assert.equal((await fs.readdir(crashReceiptsDir)).length, 0, 'restart rolls back image from killed uncommitted upload');
  assert.equal((await fs.readdir(crashJournalDir)).length, 0, 'restart removes the resolved crash journal');
  const crashStore = JSON.parse(await fs.readFile(path.join(crashDataDir, 'bankak_store.json'), 'utf8'));
  assert.equal(crashStore.length, 0, 'killed upload never appears as a committed receipt');
  console.log('PASS: forced SIGKILL between image staging and JSON commit is recovered without orphan image or false receipt.');
  await stopServer();

  // Corrupt JSON must fail closed. The server must refuse to initialize an empty
  // in-memory store and must preserve the original bytes for manual recovery.
  await stopServer();
  const corruptDataDir = path.join(tempRoot, 'corrupt-store-data');
  await fs.mkdir(path.join(corruptDataDir, 'receipts'), { recursive: true });
  const corruptStoreBytes = Buffer.from('{ this is intentionally invalid JSON');
  const corruptStorePath = path.join(corruptDataDir, 'bankak_store.json');
  await fs.writeFile(corruptStorePath, corruptStoreBytes);
  const corruptServer = startServer(corruptDataDir);
  const corruptExitCode = await Promise.race([
    new Promise<number | null>((resolve) => corruptServer.once('exit', (code) => resolve(code))),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000))
  ]);
  if (corruptExitCode === 'timeout') {
    corruptServer.kill('SIGKILL');
    throw new Error('Server did not fail closed for corrupt Bankak store JSON');
  }
  assert.notEqual(corruptExitCode, 0, 'server startup aborts when persisted JSON is corrupt');
  assert.ok(childLogs.includes('FATAL: could not load the existing store safely'), 'startup logs an explicit data-protection error');
  assert.deepEqual(await fs.readFile(corruptStorePath), corruptStoreBytes, 'corrupt source bytes remain unchanged for recovery');
  console.log('PASS: malformed store JSON fails closed and original bytes are preserved.');

  const nonArrayDataDir = path.join(tempRoot, 'non-array-store-data');
  await fs.mkdir(path.join(nonArrayDataDir, 'receipts'), { recursive: true });
  const nonArrayStoreBytes = Buffer.from(JSON.stringify({ receipts: [] }));
  const nonArrayStorePath = path.join(nonArrayDataDir, 'bankak_store.json');
  await fs.writeFile(nonArrayStorePath, nonArrayStoreBytes);
  const nonArrayServer = startServer(nonArrayDataDir);
  const nonArrayExitCode = await Promise.race([
    new Promise<number | null>((resolve) => nonArrayServer.once('exit', (code) => resolve(code))),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000))
  ]);
  if (nonArrayExitCode === 'timeout') {
    nonArrayServer.kill('SIGKILL');
    throw new Error('Server did not fail closed for a non-array Bankak store root');
  }
  assert.notEqual(nonArrayExitCode, 0, 'server startup aborts when store JSON root is not an array');
  assert.ok(childLogs.includes('FATAL: could not load the existing store safely'), 'non-array store root logs an explicit data-protection error');
  assert.deepEqual(await fs.readFile(nonArrayStorePath), nonArrayStoreBytes, 'non-array source bytes remain unchanged');
  console.log('PASS: non-array store root fails closed and original bytes are preserved.');

  console.log('PHASE B1/B2/B3/B4/B5 SAFETY RESULT: PASS');
} finally {
  await stopServer();
  // The failure-injection case intentionally makes the data directory read-only.
  // Restore permissions before deleting the isolated test fixture and its lock file.
  try { await fs.chmod(dataDir, 0o755); } catch { /* already removed or inaccessible */ }
  try { await fs.chmod(path.join(dataDir, 'receipts'), 0o755); } catch { /* best effort */ }
  await fs.rm(tempRoot, { recursive: true, force: true });
}
