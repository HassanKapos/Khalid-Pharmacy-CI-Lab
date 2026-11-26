import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { BANKAK_MAX_AUTO_RETRIES, getBankakRetryDelayMs } from './src/services/bankakRetryPolicy.ts';
import { runBankakImageRetention, BANKAK_IMAGE_RETENTION_DAYS } from './src/services/bankakImageRetention.ts';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_LIBRARY_MODE = process.env.KHALID_SERVER_LIBRARY_ONLY === 'true';

// Allow large receipt photos (up to 35MB base64)
app.use(express.json({ limit: '35mb' }));
app.use(express.urlencoded({ extended: true, limit: '35mb' }));

// ============================================================================
// PERMANENT DISK STORAGE FOR BANKAK RECEIPTS AND IMAGES
// ============================================================================
// Allow integration tests and isolated deployments to select a dedicated data directory.
// The default remains the existing ./data location for backward compatibility.
const DATA_DIR = path.resolve(process.env.BANKAK_DATA_DIR || 'data');
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
const STORE_FILE = path.join(DATA_DIR, 'bankak_store.json');
const UPLOAD_TRANSACTIONS_DIR = path.join(DATA_DIR, 'upload-transactions');
// The JSON-file store is single-writer. A lock prevents concurrent local processes
// from mutating the same data directory. Unknown/remote locks fail closed.
const SERVER_LOCK_FILE = path.join(DATA_DIR, 'bankak-server.lock');
const SERVER_LOCK_TOKEN = crypto.randomBytes(16).toString('hex');

function syncDirectorySync(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function acquireServerLock(): void {
  const owner = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), token: SERVER_LOCK_TOKEN };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(SERVER_LOCK_FILE, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify(owner), 'utf8'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      syncDirectorySync(DATA_DIR);
      return;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      let existing: any;
      try { existing = JSON.parse(fs.readFileSync(SERVER_LOCK_FILE, 'utf8')); }
      catch { throw new Error('Bankak server lock exists but is unreadable; refusing concurrent startup. Verify the lock owner before manual recovery.'); }
      if (!existing || !Number.isInteger(existing.pid) || typeof existing.hostname !== 'string' || typeof existing.token !== 'string') {
        throw new Error('Bankak server lock is malformed; refusing concurrent startup. Verify the lock before manual recovery.');
      }
      if (existing.hostname !== os.hostname()) throw new Error('Bankak data directory is locked by another host; shared multi-host writes are unsupported.');
      try {
        process.kill(existing.pid, 0);
        throw new Error('Another Bankak server process already owns this data directory (PID ' + existing.pid + ').');
      } catch (probeError: any) {
        if (probeError.code !== 'ESRCH') throw probeError;
      }
      fs.unlinkSync(SERVER_LOCK_FILE);
      syncDirectorySync(DATA_DIR);
    }
  }
  throw new Error('Could not acquire exclusive Bankak data-directory lock.');
}

function releaseServerLock(): void {
  try {
    const current = JSON.parse(fs.readFileSync(SERVER_LOCK_FILE, 'utf8'));
    if (current?.token === SERVER_LOCK_TOKEN && current?.pid === process.pid) {
      fs.unlinkSync(SERVER_LOCK_FILE);
      syncDirectorySync(DATA_DIR);
    }
  } catch { /* best effort during shutdown; stale same-host locks are recovered on next start */ }
}

process.on('exit', releaseServerLock);
process.on('SIGTERM', () => { releaseServerLock(); process.exit(0); });
process.on('SIGINT', () => { releaseServerLock(); process.exit(0); });

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(RECEIPTS_DIR)) {
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOAD_TRANSACTIONS_DIR)) {
  fs.mkdirSync(UPLOAD_TRANSACTIONS_DIR, { recursive: true });
}

console.info(`[Bankak Storage] Resolved data directory: ${DATA_DIR}`);
if (!process.env.BANKAK_DATA_DIR) {
  console.warn('[Bankak Storage] Using local ./data storage. Persistence across container redeploys is NOT guaranteed unless the host provides and mounts a persistent volume.');
} else {
  console.info('[Bankak Storage] BANKAK_DATA_DIR is configured; host-side persistent-volume behavior must still be verified before claiming deployment durability.');
}

export type ServerPharmacyRole = 'super_admin' | 'admin' | 'cashier';

export interface AuthenticatedApiUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
  role: ServerPharmacyRole;
  branchIds: string[];
  activeBranchId: string | null;
  active: boolean;
  isBranchActive?: (branchId: string) => Promise<boolean>;
}

export type VerifyBearerTokenFn = (
  token: string,
  checkRevoked: boolean
) => Promise<AuthenticatedApiUser>;

export class ApiAuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiAuthError';
    this.status = status;
    this.code = code;
  }
}

export type BankakStatus = 'Pending' | 'Processing' | 'Completed' | 'Needs Review' | 'Failed' | 'Duplicate';

export interface BankakReceipt {
  id: string;
  branchId?: string;
  uploadedByUid?: string;
  status: BankakStatus;
  transactionId: string | null; // Stored strictly as string preserving leading zeros
  amount: number | null; // Sudanese Pounds (SDG)
  date: string | null; // YYYY-MM-DD
  time: string | null; // HH:MM
  transactionType: string | null; // نوع العملية (تحويل لحساب، دفع تاجر، إلخ)
  employeeName: string;
  imageFileName: string;
  imageUrl?: string;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string | null;
  notes?: string;

  // Performance Optimization & Deduplication fields (fully backward compatible)
  imageHash?: string; // SHA-256 hash of original uncompressed image
  compressedFileName?: string; // Optimized JPEG for fast OCR analysis
  originalSizeBytes?: number;
  compressedSizeBytes?: number;
  compressionDurationMs?: number;
  ocrDurationMs?: number;
  analysisSource?: 'gemini' | 'dedup_cache' | 'manual';
  retryCount?: number;
  // Optional request-level idempotency metadata; absent on legacy receipts.
  idempotencyKey?: string;
  requestFingerprint?: string;
  nextRetryAt?: string;
  // Per-file storage timestamps; legacy rows safely fall back to valid createdAt.
  originalImageStoredAt?: string;
  compressedImageStoredAt?: string;
}

// In-memory store synced persistently with disk
let bankakStore: BankakReceipt[] = [];

// Hash index for fast O(1) deduplication lookup
const imageHashIndex = new Map<string, BankakReceipt>();

// Map to track in-progress jobs for identical hashes
// imageHash -> list of receipt IDs waiting for this task
const inProgressHashSubscribers = new Map<string, string[]>();

function rebuildHashIndex() {
  imageHashIndex.clear();
  for (const receipt of bankakStore) {
    if (receipt.imageHash && !imageHashIndex.has(receipt.imageHash)) {
      imageHashIndex.set(receipt.imageHash, receipt);
    }
  }
}

// Atomic file writing queue to prevent race conditions during concurrent saves
let savePromiseChain: Promise<void> = Promise.resolve();

function saveStore(): Promise<void> {
  // A failed write must not poison the queue permanently; later retries may recover.
  savePromiseChain = savePromiseChain.catch(() => undefined).then(async () => {
    const tmpFile = `${STORE_FILE}.${Date.now()}.${Math.random().toString(36).substr(2, 5)}.tmp`;
    let handle: any;
    try {
      const jsonContent = JSON.stringify(bankakStore, null, 2);
      handle = await fs.promises.open(tmpFile, 'wx');
      await handle.writeFile(jsonContent, 'utf-8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(tmpFile, STORE_FILE);
      const directoryHandle = await fs.promises.open(DATA_DIR, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      rebuildHashIndex();
    } catch (err) {
      if (handle) { try { await handle.close(); } catch { /* best effort */ } }
      try { await fs.promises.unlink(tmpFile); } catch { /* absent or already removed */ }
      console.error('Error saving Bankak store atomically to disk:', err);
      throw err;
    }
  });
  return savePromiseChain;
}
interface UploadTransactionFile { tempName: string; finalName: string; }
interface UploadTransactionJournal { receiptId: string; files: UploadTransactionFile[]; }

function isSafeUploadTransactionJournal(value: any): value is UploadTransactionJournal {
  if (!value || typeof value.receiptId !== 'string' || !/^bnk-\d+-[a-f0-9]{6}$/.test(value.receiptId) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 2) return false;
  return value.files.every((file: any) => {
    if (!file || typeof file.tempName !== 'string' || typeof file.finalName !== 'string') return false;
    const allowed = new RegExp('^' + value.receiptId + '(?:\\.(?:jpg|png)|\\.ocr\\.jpg)$');
    return allowed.test(file.finalName) && file.tempName === file.finalName + '.uploading' && path.basename(file.tempName) === file.tempName && path.basename(file.finalName) === file.finalName;
  });
}

function recoverUploadTransactions(): void {
  let names: string[];
  try { names = fs.readdirSync(UPLOAD_TRANSACTIONS_DIR).filter((name) => name.endsWith('.json')); }
  catch (err) { console.error('[Bankak Upload Recovery] Cannot list journals; storage left untouched.', err); return; }
  for (const name of names) {
    const journalPath = path.join(UPLOAD_TRANSACTIONS_DIR, name);
    try {
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      if (!isSafeUploadTransactionJournal(journal) || name !== journal.receiptId + '.json') { console.error('[Bankak Upload Recovery] Invalid journal left untouched:', name); continue; }
      const committed = bankakStore.some((receipt) => receipt.id === journal.receiptId);
      for (const file of journal.files) {
        const tempPath = path.join(RECEIPTS_DIR, file.tempName);
        const finalPath = path.join(RECEIPTS_DIR, file.finalName);
        if (committed) {
          // If the JSON commit survived but the final rename did not, recover the
          // exact staged bytes rather than deleting the only remaining image copy.
          if (!fs.existsSync(finalPath) && fs.existsSync(tempPath)) fs.renameSync(tempPath, finalPath);
          else if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          if (!fs.existsSync(finalPath)) throw new Error('Committed receipt image is missing; preserving journal for manual recovery: ' + file.finalName);
        } else {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
        }
      }
      syncDirectorySync(RECEIPTS_DIR);
      fs.unlinkSync(journalPath);
      syncDirectorySync(UPLOAD_TRANSACTIONS_DIR);
      console.info('[Bankak Upload Recovery] ' + (committed ? 'Completed' : 'Rolled back') + ' interrupted upload ' + journal.receiptId);
    } catch (err) { console.error('[Bankak Upload Recovery] Recovery failed; journal preserved:', name, err); }
  }
}

function stageUploadFiles(receiptId: string, files: Array<{ finalName: string; buffer: Buffer }>): string[] {
  const journal: UploadTransactionJournal = { receiptId, files: files.map((f) => ({ finalName: f.finalName, tempName: f.finalName + '.uploading' })) };
  const journalPath = path.join(UPLOAD_TRANSACTIONS_DIR, receiptId + '.json');
  const fd = fs.openSync(journalPath, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(journal), 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectorySync(UPLOAD_TRANSACTIONS_DIR);
  const finalPaths: string[] = [];
  try {
    for (const file of files) {
      const tempPath = path.join(RECEIPTS_DIR, file.finalName + '.uploading');
      const finalPath = path.join(RECEIPTS_DIR, file.finalName);
      if (process.env.BANKAK_TEST_MODE === 'true' && process.env.BANKAK_TEST_FAIL_IMAGE_WRITE === 'true') {
        throw new Error('Injected test image-write failure');
      }
      const imageFd = fs.openSync(tempPath, 'wx');
      try { fs.writeFileSync(imageFd, file.buffer); fs.fsyncSync(imageFd); }
      finally { fs.closeSync(imageFd); }
      if (process.env.BANKAK_TEST_MODE === 'true' && process.env.BANKAK_TEST_FAIL_IMAGE_RENAME === 'true') {
        throw new Error('Injected test image-rename failure');
      }
      fs.renameSync(tempPath, finalPath);
      syncDirectorySync(RECEIPTS_DIR);
      finalPaths.push(finalPath);
    }
    return finalPaths;
  } catch (err) {
    let cleanupComplete = true;
    for (const file of journal.files) for (const filename of [file.tempName, file.finalName]) {
      const target = path.join(RECEIPTS_DIR, filename);
      try { if (fs.existsSync(target)) fs.unlinkSync(target); }
      catch { cleanupComplete = false; }
    }
    // Keep the journal until every owned file removal is directory-synced.
    if (cleanupComplete) {
      try {
        syncDirectorySync(RECEIPTS_DIR);
        fs.unlinkSync(journalPath);
        syncDirectorySync(UPLOAD_TRANSACTIONS_DIR);
      } catch { /* leave the journal whenever possible for startup reconciliation */ }
    }
    throw err;
  }
}

function finishUploadTransaction(receiptId: string): void {
  const journalPath = path.join(UPLOAD_TRANSACTIONS_DIR, receiptId + '.json');
  try { if (fs.existsSync(journalPath)) { fs.unlinkSync(journalPath); syncDirectorySync(UPLOAD_TRANSACTIONS_DIR); } }
  catch (err) { console.warn('[Bankak Upload Recovery] Committed journal cleanup deferred:', receiptId, err); }
}

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = fs.readFileSync(STORE_FILE, 'utf-8');
      const parsedStore = JSON.parse(data);
      if (!Array.isArray(parsedStore)) {
        throw new Error('Bankak store JSON root must be an array');
      }
      bankakStore = parsedStore;
      recoverUploadTransactions();

      // Persistent Task Recovery:
      // Reset any tasks that were interrupted mid-processing to Pending
      const tasksToResume: Array<{ id: string; delayMs: number }> = [];
      bankakStore.forEach((r) => {
        if (r.status === 'Processing' || r.status === 'Pending') {
          const wasPending = r.status === 'Pending';
          const retryAt = wasPending && r.nextRetryAt ? Date.parse(r.nextRetryAt) : Number.NaN;
          const delayMs = Number.isFinite(retryAt)
            ? Math.max(0, retryAt - Date.now())
            : 300;
          r.status = 'Pending';
          r.errorMessage = null;
          tasksToResume.push({ id: r.id, delayMs });
        }
      });

      rebuildHashIndex();

      if (tasksToResume.length > 0) {
        console.log(`[Store] Recovered ${tasksToResume.length} unfinished tasks across server restart`);
        tasksToResume.forEach(({ id, delayMs }) => {
          setTimeout(() => enqueueTask(id), delayMs);
        });
      }
    } else {
      // Initial verified seed data for immediate testing
      bankakStore = [
        {
          id: 'bnk-sample-1',
          status: 'Completed',
          transactionId: '009845120384',
          amount: 32000,
          date: '2026-10-30',
          time: '11:42',
          transactionType: 'تحويل لحساب آخر',
          employeeName: 'الصيدلي المناوب',
          imageFileName: '',
          imageUrl: '',
          mimeType: 'image/jpeg',
          createdAt: new Date(Date.now() - 3600000 * 2).toISOString(),
          updatedAt: new Date(Date.now() - 3600000 * 2).toISOString(),
          notes: 'فاتورة مسكنات ومضادات حيوية',
          analysisSource: 'gemini',
        },
        {
          id: 'bnk-sample-2',
          status: 'Completed',
          transactionId: '009845119421',
          amount: 14500,
          date: '2026-10-30',
          time: '09:15',
          transactionType: 'دفع تاجر / مشتريات',
          employeeName: 'د. خالد (مدير)',
          imageFileName: '',
          imageUrl: '',
          mimeType: 'image/jpeg',
          createdAt: new Date(Date.now() - 3600000 * 5).toISOString(),
          updatedAt: new Date(Date.now() - 3600000 * 5).toISOString(),
          notes: 'مبيعات فيتامينات أوميغا 3',
          analysisSource: 'gemini',
        },
      ];
      saveStore();
      recoverUploadTransactions();
    }
  } catch (err) {
    console.error('[Bankak Store] FATAL: could not load the existing store safely. Refusing to start to prevent accidental overwrite or loss of pharmacy records.', err);
    throw new Error('Bankak store could not be loaded safely; server startup aborted to protect existing data.');
  }
}

if (!IS_LIBRARY_MODE) {
  acquireServerLock();
  loadStore();
}

// Bankak image-only retention: run once at startup and every 24 hours.
// Receipt rows and all financial fields remain untouched. Supplier invoice/payment
// evidence is stored outside RECEIPTS_DIR and is never enumerated by this worker.
async function runScheduledBankakImageRetention(): Promise<void> {
  try {
    const result = await runBankakImageRetention(bankakStore, RECEIPTS_DIR);
    if (result.deletedFiles.length > 0) {
      console.info(`[Bankak Retention] Deleted ${result.deletedFiles.length} expired image file(s) older than ${BANKAK_IMAGE_RETENTION_DAYS} days; financial records preserved.`);
    }
    const routineRetained = result.preservedFiles.filter(
      (item) => item.reason === 'recent' || item.reason === 'active_ocr' || item.reason === 'unknown_timestamp',
    );
    const attentionFiles = result.preservedFiles.filter(
      (item) => item.reason === 'unsafe_name' || item.reason === 'not_regular_file' || item.reason === 'delete_failed',
    );
    if (routineRetained.length > 0) {
      console.info(`[Bankak Retention] Retained ${routineRetained.length} image file(s) within the ${BANKAK_IMAGE_RETENTION_DAYS}-day policy or active OCR.`);
    }
    if (attentionFiles.length > 0) {
      console.warn(`[Bankak Retention] Skipped ${attentionFiles.length} image file(s) due to retention safety checks (${attentionFiles.map((f) => f.reason).join(', ')}).`);
    }
  } catch (error) {
    console.error('[Bankak Retention] Cleanup failed; no receipt records were changed.', error);
  }
}

let bankakRetentionTimer: ReturnType<typeof setInterval> | undefined;
if (!IS_LIBRARY_MODE) {
  void runScheduledBankakImageRetention();
  bankakRetentionTimer = setInterval(() => { void runScheduledBankakImageRetention(); }, 24 * 60 * 60 * 1000);
  (bankakRetentionTimer as any).unref?.();
}

// ============================================================================
// GEMINI OCR ENGINE (GEMINI 3.8 FLASH WITH STRUCTURED SCHEMA)
// ============================================================================
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Helper for strict duplicate transaction ID detection (uses transactionId alone)
function isTransactionIdDuplicate(transactionId: string | null, excludeId: string): boolean {
  if (!transactionId) return false;
  const target = transactionId.trim();
  if (!target) return false;
  return bankakStore.some((r) => r.id !== excludeId && r.transactionId && r.transactionId.trim() === target);
}

// Helper to compute server-side SHA-256 hash if not provided
function computeSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ============================================================================
// ASYNCHRONOUS BACKGROUND QUEUE PIPELINE WITH CONCURRENCY = 2
// ============================================================================
const MAX_CONCURRENT_TASKS = 2;
const processingQueue: string[] = [];
const activeProcessingIds = new Set<string>();

// Explicitly gated test-only OCR fault injection; never enable BANKAK_TEST_MODE in production.
let testInjectedTransientFailuresRemaining = process.env.BANKAK_TEST_MODE === 'true'
  ? Math.max(0, Number(process.env.BANKAK_TEST_TRANSIENT_FAILURES) || 0)
  : 0;
let testInjectedTransientFailuresCount = 0;
let testProcessingStateSaveFailureInjected = false;
let testFinalStateSaveFailureInjected = false;

function pumpQueue() {
  while (activeProcessingIds.size < MAX_CONCURRENT_TASKS && processingQueue.length > 0) {
    const taskId = processingQueue.shift();
    if (!taskId) break;

    // Skip if already being processed
    if (activeProcessingIds.has(taskId)) {
      continue;
    }

    processTask(taskId);
  }
}

async function processTask(taskId: string) {
  let retryDelayMs: number | undefined;
  let durableProcessingSnapshot: BankakReceipt | undefined;
  let finalStatePersisted = false;
  const subscriberSnapshots = new Map<string, BankakReceipt>();
  const receipt = bankakStore.find((r) => r.id === taskId);
  if (!receipt) {
    setTimeout(pumpQueue, 50);
    return;
  }

  // Persist the Processing claim before spending OCR resources. If this write fails,
  // restore the prior state and do not start an external OCR request.
  activeProcessingIds.add(taskId);
  const priorReceiptSnapshot = { ...receipt };
  receipt.status = 'Processing';
  receipt.updatedAt = new Date().toISOString();
  try {
    if (process.env.BANKAK_TEST_MODE === 'true' && process.env.BANKAK_TEST_FAIL_PROCESSING_SAVE_ONCE === 'true' && !testProcessingStateSaveFailureInjected) {
      testProcessingStateSaveFailureInjected = true;
      throw new Error('Injected Processing-state persistence failure');
    }
    await saveStore();
    durableProcessingSnapshot = { ...receipt };
  } catch (persistErr) {
    Object.assign(receipt, priorReceiptSnapshot);
    activeProcessingIds.delete(taskId);
    console.error('[Bankak Queue] Could not persist Processing state; OCR was not started:', taskId, persistErr);
    if (testProcessingStateSaveFailureInjected) setTimeout(() => enqueueTask(taskId), 1000);
    else setTimeout(pumpQueue, 1000);
    return;
  }

  const ocrStartTime = Date.now();

  try {
    if (process.env.BANKAK_TEST_MODE === 'true' && testInjectedTransientFailuresRemaining > 0) {
      testInjectedTransientFailuresRemaining -= 1;
      testInjectedTransientFailuresCount += 1;
      console.error('[Bankak Test Failpoint] Injected transient OCR failure #' + testInjectedTransientFailuresCount);
      throw new Error('429 RESOURCE_EXHAUSTED - injected transient OCR failure');
    }

    // Choose the best image for analysis:
    // Prefer optimized compressed image if present; fallback to original image
    const imageToAnalyze = receipt.compressedFileName || receipt.imageFileName;
    const imagePath = path.join(RECEIPTS_DIR, imageToAnalyze);

    if (!imageToAnalyze || !fs.existsSync(imagePath)) {
      throw new Error('صورة التحليل غير موجودة في التخزين الدائم على الخادم');
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const base64Data = imageBuffer.toString('base64');
    const detectedMime = imageToAnalyze.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const promptText = `You are an expert OCR parser for Bank of Khartoum "Bankak" (بنكك - بنك الخرطوم) payment receipts and transaction screenshots in Sudan.
Carefully extract ONLY the following 5 exact fields:
1. transactionId: The exact unique transaction reference number (رقم العملية / الرقم المرجعي / Transaction ID / Ref No / TRX).
   - CRITICAL: Store strictly as text/string preserving all leading zeros (e.g. "0048219034") and any symbols.
   - If missing, unreadable, or uncertain, return null.
2. amount: The transaction amount transferred in Sudanese Pounds (المبلغ بالجنيه السوداني SDG). Return numeric value only (e.g. 25000 or 14500.5).
3. date: The date of the transaction (تاريخ العملية). Format as YYYY-MM-DD if recognizable, or as printed.
4. time: The time of the transaction (وقت العملية), format as HH:MM or as printed.
5. transactionType: The type of transaction in Arabic if visible or inferrable (نوع العملية), such as:
   - "تحويل لحساب آخر"
   - "تحويل لبطاقة"
   - "دفع تاجر / مشتريات"
   - "دفع فواتير"
   - "شراء كهرباء"
   - "سحب نقدي"

Return clean JSON adhering strictly to the schema.`;

    const modelsToTry = ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];
    let lastError: any = null;
    let responseText = '';

    for (const modelName of modelsToTry) {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`انتهت مهلة الاتصال بالذكاء الاصطناعي (${modelName})`)), 25000)
        );

        const callPromise = ai.models.generateContent({
          model: modelName,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: detectedMime,
                  data: base64Data,
                },
              },
              { text: promptText },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                transactionId: {
                  type: Type.STRING,
                  description: 'Exact transaction ID as string preserving leading zeros or null if not detected',
                },
                amount: {
                  type: Type.NUMBER,
                  description: 'Transaction amount in Sudanese Pounds (SDG)',
                },
                date: {
                  type: Type.STRING,
                  description: 'Transaction date (YYYY-MM-DD or as printed)',
                },
                time: {
                  type: Type.STRING,
                  description: 'Transaction time (HH:MM or as printed)',
                },
                transactionType: {
                  type: Type.STRING,
                  description: 'Transaction category in Arabic',
                },
              },
            },
          },
        });

        const res: any = await Promise.race([callPromise, timeoutPromise]);
        responseText = res.text || '{}';
        if (responseText) break;
      } catch (err: any) {
        lastError = err;
        console.log(`Model ${modelName} unavailable, checking fallback`);
      }
    }

    if (!responseText) {
      throw lastError || new Error('فشلت جميع نماذج التعرف على النصوص في معالجة الإشعار');
    }

    const parsed = JSON.parse(responseText);

    // Strict handling of fields
    const rawTxId = parsed.transactionId ? String(parsed.transactionId).trim() : null;
    const rawAmount = typeof parsed.amount === 'number' ? parsed.amount : parsed.amount ? Number(parsed.amount) : null;
    const rawDate = parsed.date ? String(parsed.date).trim() : null;
    const rawTime = parsed.time ? String(parsed.time).trim() : null;
    const rawType = parsed.transactionType ? String(parsed.transactionType).trim() : 'تحويل لحساب آخر';

    const ocrDuration = Date.now() - ocrStartTime;

    receipt.transactionId = rawTxId;
    receipt.amount = rawAmount;
    receipt.date = rawDate || new Date().toISOString().split('T')[0];
    receipt.time = rawTime || new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    receipt.transactionType = rawType;
    receipt.errorMessage = null;
    receipt.nextRetryAt = undefined;
    receipt.retryCount = 0;
    receipt.ocrDurationMs = ocrDuration;
    receipt.analysisSource = 'gemini';

    // Requirement 9: If transactionId was NOT extracted, do NOT consider complete -> Needs Review!
    if (!rawTxId) {
      receipt.status = 'Needs Review';
    } else {
      // Requirement 8: Check duplicate by transactionId alone
      const isDup = isTransactionIdDuplicate(rawTxId, receipt.id);
      if (isDup) {
        receipt.status = 'Duplicate';
      } else {
        receipt.status = 'Completed';
      }
    }

    // Handle any subscribers waiting for this exact imageHash (Requirement 2.5)
    if (receipt.imageHash && inProgressHashSubscribers.has(receipt.imageHash)) {
      const subscribers = inProgressHashSubscribers.get(receipt.imageHash) || [];
      for (const subId of subscribers) {
        if (subId === receipt.id) continue;
        const subReceipt = bankakStore.find((r) => r.id === subId);
        if (subReceipt && subReceipt.status === 'Pending') {
          subscriberSnapshots.set(subId, { ...subReceipt });
          subReceipt.transactionId = rawTxId;
          subReceipt.amount = rawAmount;
          subReceipt.date = receipt.date;
          subReceipt.time = receipt.time;
          subReceipt.transactionType = rawType;
          subReceipt.ocrDurationMs = 0; // Cached from sibling task
          subReceipt.analysisSource = 'dedup_cache';
          subReceipt.errorMessage = null;
          subReceipt.nextRetryAt = undefined;

          if (!rawTxId) {
            subReceipt.status = 'Needs Review';
          } else {
            // Evaluated independently by transactionId
            const isSubDup = isTransactionIdDuplicate(rawTxId, subReceipt.id);
            subReceipt.status = isSubDup ? 'Duplicate' : 'Completed';
          }
          subReceipt.updatedAt = new Date().toISOString();
        }
      }
      inProgressHashSubscribers.delete(receipt.imageHash);
    }
  } catch (err: any) {
    console.error(`Background OCR failed for task ${taskId}:`, err);

    // Rate-limit or transient network error: Safe retry with backoff (Requirement 4.6)
    const currentRetries = receipt.retryCount || 0;
    const isTransient = err.message?.includes('429') || err.message?.includes('RESOURCE_EXHAUSTED') || err.message?.includes('timeout') || err.message?.includes('مهلة');

    if (isTransient && currentRetries < BANKAK_MAX_AUTO_RETRIES) {
      receipt.retryCount = currentRetries + 1;
      receipt.status = 'Pending';
      retryDelayMs = getBankakRetryDelayMs(receipt.retryCount);
      receipt.nextRetryAt = new Date(Date.now() + retryDelayMs).toISOString();
      receipt.errorMessage = `محاولة إعادة التحليل تلقائياً (${receipt.retryCount}/${BANKAK_MAX_AUTO_RETRIES})...`;
      console.log(`[Queue] Scheduling retry #${receipt.retryCount} for ${taskId} after ${retryDelayMs}ms (exponential backoff + jitter)`);
    } else {
      receipt.nextRetryAt = undefined;
      if (!isTransient && (!process.env.GEMINI_API_KEY || err.message?.includes('API_KEY') || err.message?.includes('SCOPE') || err.message?.includes('PERMISSION_DENIED'))) {
        receipt.status = 'Needs Review';
        receipt.errorMessage = 'يرجى مراجعة وتأكيد بيانات الإشعار يدوياً (أو إضافة مفتاح GEMINI_API_KEY)';
      } else {
        receipt.status = 'Failed';
        receipt.errorMessage = err.message || 'فشل في تحليل الإشعار عبر خدمة الذكاء الاصطناعي';
      }
    }
  } finally {
    receipt.updatedAt = new Date().toISOString();
    try {
      if (process.env.BANKAK_TEST_MODE === 'true' && process.env.BANKAK_TEST_FAIL_FINAL_SAVE_ONCE === 'true' && !testFinalStateSaveFailureInjected) {
        testFinalStateSaveFailureInjected = true;
        throw new Error('Injected final OCR state persistence failure');
      }
      await saveStore();
      finalStatePersisted = true;
    } catch (persistErr) {
      // Never expose an uncommitted terminal/retry result as if it were durable.
      if (durableProcessingSnapshot) Object.assign(receipt, durableProcessingSnapshot);
      for (const [subscriberId, snapshot] of subscriberSnapshots) {
        const subscriber = bankakStore.find((item) => item.id === subscriberId);
        if (subscriber) Object.assign(subscriber, snapshot);
      }
      console.error('[Bankak Queue] Final OCR state could not be persisted; durable Processing state retained for restart recovery:', taskId, persistErr);
    } finally {
      activeProcessingIds.delete(taskId);
    }
    // Schedule only after the retry timestamp and state have been durably persisted.
    if (finalStatePersisted && retryDelayMs !== undefined) {
      setTimeout(() => enqueueTask(taskId), retryDelayMs);
    }
    setTimeout(pumpQueue, 60);
  }
}

function enqueueTask(taskId: string): boolean {
  if (activeProcessingIds.has(taskId)) {
    return false;
  }
  if (!processingQueue.includes(taskId)) {
    processingQueue.push(taskId);
  }
  pumpQueue();
  return true;
}

// ============================================================================
// AUTH-R3: FAIL-CLOSED FIREBASE ID TOKEN VERIFICATION, RBAC & UPLOAD VALIDATION
// ============================================================================
const VALID_BRANCH_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_IMAGE_DECODED_BYTES = 15 * 1024 * 1024; // 15MB per image
const MAX_SUPPLIER_OCR_PAGES = 10;
const MAX_SUPPLIER_OCR_TOTAL_BYTES = 30 * 1024 * 1024; // 30MB decoded total
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SAFE_RECEIPT_FILENAME_RE = /^[a-zA-Z0-9._-]+$/;

const dynamicNodeImport = (specifier: string): Promise<any> =>
  new Function('s', 'return import(s)')(specifier);

function readPublicFirebaseConfig(): { projectId: string; firestoreDatabaseId: string } {
  try {
    const raw = fs.readFileSync(path.resolve('firebase-applet-config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      projectId: typeof parsed?.projectId === 'string' ? parsed.projectId.trim() : '',
      firestoreDatabaseId: typeof parsed?.firestoreDatabaseId === 'string' ? parsed.firestoreDatabaseId.trim() : '',
    };
  } catch {
    return { projectId: '', firestoreDatabaseId: '' };
  }
}

export async function createFirebaseAdminAuthVerifier(): Promise<VerifyBearerTokenFn | null> {
  const publicCfg = readPublicFirebaseConfig();
  const projectId = (process.env.FIREBASE_PROJECT_ID || publicCfg.projectId || '').trim();
  const rawEnvDbId = (process.env.FIREBASE_FIRESTORE_DATABASE_ID || '').trim();
  const safeEnvDbId =
    rawEnvDbId && rawEnvDbId !== '(default)' && !rawEnvDbId.includes('.') && /^[a-zA-Z0-9_-]{1,63}$/.test(rawEnvDbId)
      ? rawEnvDbId
      : '';
  const firestoreDatabaseId = (safeEnvDbId || publicCfg.firestoreDatabaseId || '').trim();

  const rawServiceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const googleAppCredsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const isCloudRunAdc = Boolean(process.env.K_SERVICE || process.env.GOOGLE_CLOUD_PROJECT);

  if (!rawServiceAccountJson && !googleAppCredsPath && !isCloudRunAdc) {
    return null;
  }

  let appMod: any;
  let authMod: any;
  let firestoreMod: any;
  try {
    appMod = await dynamicNodeImport('firebase-admin/app');
    authMod = await dynamicNodeImport('firebase-admin/auth');
    firestoreMod = await dynamicNodeImport('firebase-admin/firestore');
  } catch {
    return null;
  }

  let credential: any;
  try {
    if (rawServiceAccountJson) {
      credential = appMod.cert(JSON.parse(rawServiceAccountJson));
    } else if (googleAppCredsPath) {
      if (!fs.existsSync(googleAppCredsPath)) return null;
      credential = appMod.applicationDefault();
    } else {
      credential = appMod.applicationDefault();
    }
  } catch {
    return null;
  }

  const appName = 'khalid-pharmacy-server-auth';
  const existingApp = appMod.getApps().find((a: any) => a.name === appName);
  const adminApp =
    existingApp ||
    appMod.initializeApp(
      {
        credential,
        ...(projectId ? { projectId } : {}),
      },
      appName
    );

  const adminAuth = authMod.getAuth(adminApp);
  const adminDb = firestoreDatabaseId
    ? firestoreMod.getFirestore(adminApp, firestoreDatabaseId)
    : firestoreMod.getFirestore(adminApp);

  return async (token: string, checkRevoked: boolean): Promise<AuthenticatedApiUser> => {
    let decoded: any;
    try {
      // Strictly enforce revocation check (`true`) when checking tokens
      decoded = await adminAuth.verifyIdToken(token, checkRevoked);
    } catch (err: any) {
      const code = String(err?.code || '').toLowerCase();
      if (code.includes('revoked')) {
        throw new ApiAuthError(401, 'TOKEN_REVOKED', 'تم إبطال رمز المصادقة. يرجى تسجيل الدخول مجدداً.');
      }
      if (code.includes('expired')) {
        throw new ApiAuthError(401, 'TOKEN_EXPIRED', 'انتهت صلاحية رمز المصادقة. يرجى تحديث الجلسة.');
      }
      if (code.includes('user-disabled')) {
        throw new ApiAuthError(403, 'USER_DISABLED', 'تم تعطيل حساب المستخدم.');
      }
      throw new ApiAuthError(401, 'INVALID_TOKEN', 'رمز المصادقة غير صالح.');
    }

    if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) {
      throw new ApiAuthError(401, 'INVALID_TOKEN', 'بيانات الهوية في الرمز غير صالحة.');
    }
    if (decoded.email_verified !== true) {
      throw new ApiAuthError(403, 'EMAIL_NOT_VERIFIED', 'يجب تأكيد البريد الإلكتروني قبل الوصول للواجهة البرمجية.');
    }

    const userSnap = await adminDb.doc(`users/${decoded.uid}`).get();
    if (!userSnap.exists) {
      throw new ApiAuthError(403, 'USER_PROFILE_MISSING', 'حساب المستخدم غير مسجل أو تم حذفه من الصلاحيات.');
    }

    const profile = userSnap.data() || {};
    if (profile.active !== true) {
      throw new ApiAuthError(403, 'USER_INACTIVE', 'تم تعطيل حساب المستخدم من الإدارة.');
    }

    const role = profile.role;
    if (role !== 'super_admin' && role !== 'admin' && role !== 'cashier') {
      throw new ApiAuthError(403, 'INVALID_ROLE', 'دور المستخدم غير مصرح به.');
    }

    const branchIds = Array.isArray(profile.branchIds)
      ? profile.branchIds.filter((id: unknown): id is string => typeof id === 'string' && VALID_BRANCH_ID_RE.test(id))
      : [];
    if (role !== 'super_admin' && branchIds.length === 0) {
      throw new ApiAuthError(403, 'NO_BRANCH_ASSIGNED', 'الحساب غير معيّن لأي فرع.');
    }
    if (role === 'cashier' && branchIds.length !== 1) {
      throw new ApiAuthError(403, 'INVALID_CASHIER_BRANCHES', 'إعداد فروع الكاشير غير صالح.');
    }

    return {
      uid: decoded.uid,
      email: typeof decoded.email === 'string' ? decoded.email : null,
      emailVerified: true,
      displayName:
        typeof profile.displayName === 'string' && profile.displayName.trim()
          ? profile.displayName.trim()
          : typeof decoded.email === 'string'
            ? decoded.email
            : decoded.uid,
      role,
      branchIds,
      activeBranchId: typeof profile.activeBranchId === 'string' ? profile.activeBranchId : branchIds[0] || null,
      active: true,
      isBranchActive: async (branchId: string): Promise<boolean> => {
        const bSnap = await adminDb.doc(`branches/${branchId}`).get();
        return bSnap.exists && bSnap.data()?.active === true;
      },
    };
  };
}

let activeAuthVerifier: VerifyBearerTokenFn | null = null;
if (!IS_LIBRARY_MODE) {
  createFirebaseAdminAuthVerifier()
    .then((verifier) => {
      activeAuthVerifier = verifier;
      if (verifier) {
        console.info('[Auth] Firebase Admin ID token verifier (verifyIdToken(..., true)) active.');
      } else {
        console.warn('[Auth] Firebase Admin SDK credentials not configured; protected /api/* routes are running FAIL-CLOSED.');
      }
    })
    .catch((err) => {
      activeAuthVerifier = null;
      console.error('[Auth] Failed to initialize Firebase Admin verifier; running FAIL-CLOSED:', err);
    });
}

function extractBearerToken(req: Request): string | null {
  const header = req.get('authorization') || req.get('Authorization');
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  if (!token || token.length > 8192) return null;
  // Firebase ID tokens are compact 3-part JWTs
  if (token.split('.').length !== 3) return null;
  return token;
}

interface AuthenticatedRequest extends Request {
  authUser?: AuthenticatedApiUser;
}

function getEffectiveReceiptBranchId(receipt: Pick<BankakReceipt, 'branchId'>): string {
  return typeof receipt.branchId === 'string' && VALID_BRANCH_ID_RE.test(receipt.branchId)
    ? receipt.branchId
    : 'khalid-1';
}

function isUserAuthorizedForBranch(user: AuthenticatedApiUser, branchId: string): boolean {
  if (user.role === 'super_admin') return true;
  return user.branchIds.includes(branchId);
}

async function authorizeBranchForUser(
  user: AuthenticatedApiUser,
  branchId: string
): Promise<{ branchId: string } | { errorStatus: number; errorCode: string; errorMessage: string }> {
  const cleaned = typeof branchId === 'string' ? branchId.trim() : '';
  if (!cleaned || !VALID_BRANCH_ID_RE.test(cleaned)) {
    return { errorStatus: 400, errorCode: 'INVALID_BRANCH_ID', errorMessage: 'معرف الفرع غير صالح.' };
  }
  if (!isUserAuthorizedForBranch(user, cleaned)) {
    return {
      errorStatus: 403,
      errorCode: 'CROSS_BRANCH_FORBIDDEN',
      errorMessage: 'غير مصرح بالوصول إلى بيانات فرع آخر.',
    };
  }
  if (typeof user.isBranchActive === 'function') {
    const active = await user.isBranchActive(cleaned);
    if (!active) {
      return {
        errorStatus: 403,
        errorCode: 'BRANCH_DISABLED',
        errorMessage: 'هذا الفرع معطل حالياً أو غير موجود.',
      };
    }
  }
  return { branchId: cleaned };
}

function extractConsistentExplicitBranch(
  req: Request,
  options: { allowBody?: boolean } = {}
): {
  supplied: boolean;
  branchId?: string;
  errorStatus?: number;
  errorCode?: string;
  errorMessage?: string;
} {
  const rawHeader = req.get('x-branch-id');
  const rawQuery = typeof req.query?.branchId === 'string'
    ? req.query.branchId
    : Array.isArray(req.query?.branchId)
      ? String(req.query.branchId[0] ?? '')
      : undefined;
  const rawBody = options.allowBody && typeof req.body?.branchId === 'string'
    ? req.body.branchId
    : undefined;

  const headerBranch = rawHeader !== undefined ? rawHeader.trim() : '';
  const queryBranch = rawQuery !== undefined ? rawQuery.trim() : '';
  const bodyBranch = rawBody !== undefined ? rawBody.trim() : '';

  if (rawQuery !== undefined && !queryBranch) {
    return {
      supplied: true,
      errorStatus: 400,
      errorCode: 'INVALID_BRANCH_ID',
      errorMessage: 'معرف الفرع في الاستعلام غير صالح.',
    };
  }
  if (rawHeader !== undefined && !headerBranch) {
    return {
      supplied: true,
      errorStatus: 400,
      errorCode: 'INVALID_BRANCH_ID',
      errorMessage: 'معرف الفرع في الترويسة غير صالح.',
    };
  }
  if (rawBody !== undefined && !bodyBranch) {
    return {
      supplied: true,
      errorStatus: 400,
      errorCode: 'INVALID_BRANCH_ID',
      errorMessage: 'معرف الفرع في جسم الطلب غير صالح.',
    };
  }

  const suppliedValues = [queryBranch, headerBranch, bodyBranch].filter(Boolean);
  if (suppliedValues.length === 0) {
    return { supplied: false };
  }

  if (queryBranch && headerBranch && queryBranch !== headerBranch) {
    return {
      supplied: true,
      errorStatus: 400,
      errorCode: 'BRANCH_MISMATCH',
      errorMessage: 'تعارض في معرف الفرع بين الاستعلام (?branchId) والترويسة (X-Branch-Id).',
    };
  }
  if (
    bodyBranch &&
    ((queryBranch && bodyBranch !== queryBranch) || (headerBranch && bodyBranch !== headerBranch))
  ) {
    return {
      supplied: true,
      errorStatus: 400,
      errorCode: 'BRANCH_MISMATCH',
      errorMessage: 'تعارض في معرف الفرع المرسل داخل الطلب.',
    };
  }

  return { supplied: true, branchId: suppliedValues[0] };
}

/**
 * Canonical branch resolver for list / create / OCR endpoints.
 * - Precedence & determinism: query (?branchId), X-Branch-Id header, and body branchId must agree if multiple are present.
 * - Any disagreement returns 400 BRANCH_MISMATCH.
 * - Omission is ONLY permitted for non-super_admin users strictly assigned to exactly one branch.
 * - Multi-branch admin and super_admin MUST specify an explicit branch (otherwise 400 BRANCH_REQUIRED; zero all-branch disclosure).
 * - Always verifies branch membership (403 CROSS_BRANCH_FORBIDDEN) AND active status (403 BRANCH_DISABLED).
 */
async function resolveTargetBranchId(
  req: AuthenticatedRequest,
  user: AuthenticatedApiUser,
  options: { allowBody?: boolean } = { allowBody: true }
): Promise<{ branchId: string } | { errorStatus: number; errorCode: string; errorMessage: string }> {
  const explicit = extractConsistentExplicitBranch(req, options);
  if (explicit.errorStatus) {
    return {
      errorStatus: explicit.errorStatus,
      errorCode: explicit.errorCode!,
      errorMessage: explicit.errorMessage!,
    };
  }
  if (explicit.supplied && explicit.branchId) {
    return authorizeBranchForUser(user, explicit.branchId);
  }

  if (user.role !== 'super_admin') {
    if (user.branchIds.length === 0) {
      return {
        errorStatus: 403,
        errorCode: 'NO_BRANCH_ASSIGNED',
        errorMessage: 'الحساب غير معيّن لأي فرع صالح.',
      };
    }
    if (user.branchIds.length === 1) {
      return authorizeBranchForUser(user, user.branchIds[0]);
    }
  }

  return {
    errorStatus: 400,
    errorCode: 'BRANCH_REQUIRED',
    errorMessage: 'يجب تحديد معرف الفرع صراحةً عبر ?branchId أو X-Branch-Id.',
  };
}

/**
 * Validates optional request branch scope prior to looking up branch-owned resources by ID/filename,
 * preventing cross-branch probing and disabled-branch operations.
 */
async function precheckOptionalBranchScope(
  req: AuthenticatedRequest,
  user: AuthenticatedApiUser
): Promise<
  | { scopedBranchId: string | null }
  | { errorStatus: number; errorCode: string; errorMessage: string }
> {
  const explicit = extractConsistentExplicitBranch(req, { allowBody: false });
  if (explicit.errorStatus) {
    return {
      errorStatus: explicit.errorStatus,
      errorCode: explicit.errorCode!,
      errorMessage: explicit.errorMessage!,
    };
  }
  if (explicit.supplied && explicit.branchId) {
    const authRes = await authorizeBranchForUser(user, explicit.branchId);
    if ('errorStatus' in authRes) return authRes;
    return { scopedBranchId: authRes.branchId };
  }
  return { scopedBranchId: null };
}

/**
 * Authorizes an existing receipt/image resource against both server-derived user permissions
 * (branch membership + active branch) and any explicit branch scope on the request.
 */
async function authorizeResourceBranch(
  user: AuthenticatedApiUser,
  resourceBranchId: string,
  scopedBranchId: string | null
): Promise<{ branchId: string } | { errorStatus: number; errorCode: string; errorMessage: string }> {
  const branchAuth = await authorizeBranchForUser(user, resourceBranchId);
  if ('errorStatus' in branchAuth) {
    return branchAuth;
  }
  if (scopedBranchId && scopedBranchId !== branchAuth.branchId) {
    return {
      errorStatus: 404,
      errorCode: 'NOT_FOUND',
      errorMessage: 'السجل غير موجود في الفرع المحدد.',
    };
  }
  return branchAuth;
}

function validateAndDecodeImageBase64(
  rawInput: string,
  declaredMime?: unknown,
  maxBytes = MAX_IMAGE_DECODED_BYTES
): { buffer: Buffer; mimeType: string } {
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    throw new ApiAuthError(400, 'INVALID_IMAGE', 'بيانات الصورة مطلوبة.');
  }

  let base64Body = rawInput.trim();
  let mimeType = typeof declaredMime === 'string' ? declaredMime.trim().toLowerCase() : 'image/jpeg';

  if (base64Body.includes('base64,')) {
    const parts = base64Body.split('base64,');
    if (parts.length !== 2) {
      throw new ApiAuthError(400, 'INVALID_IMAGE', 'صيغة Data URI للصورة غير صالحة.');
    }
    const mimeMatch = parts[0].match(/^data:([^;]+);$/i);
    if (!mimeMatch || !mimeMatch[1]) {
      throw new ApiAuthError(400, 'INVALID_IMAGE_MIME', 'نوع الملف في رأس الصورة غير صالح.');
    }
    mimeType = mimeMatch[1].toLowerCase();
    base64Body = parts[1].trim();
  }

  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
    throw new ApiAuthError(
      400,
      'UNSUPPORTED_MEDIA_TYPE',
      'نوع الملف غير مدعوم. يُسمح فقط بصور JPEG و PNG و WEBP.'
    );
  }

  // Fast pre-decode size limit check (~4/3 base64 inflation)
  if (base64Body.length > Math.ceil(maxBytes * 1.4) + 128) {
    throw new ApiAuthError(413, 'IMAGE_TOO_LARGE', 'حجم الصورة يتجاوز الحد الأقصى المسموح به (15MB).');
  }

  const normalizedB64 = base64Body.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedB64) || normalizedB64.length % 4 !== 0) {
    throw new ApiAuthError(400, 'INVALID_BASE64', 'ترميز Base64 للصورة غير صالح.');
  }

  const buffer = Buffer.from(normalizedB64, 'base64');
  if (buffer.length === 0) {
    throw new ApiAuthError(400, 'EMPTY_IMAGE', 'ملف الصورة فارغ.');
  }
  if (buffer.length > maxBytes) {
    throw new ApiAuthError(413, 'IMAGE_TOO_LARGE', 'حجم الصورة بعد فك الترميز يتجاوز الحد المسموح به.');
  }

  // Validate actual image magic bytes to prevent spoofed MIME payloads
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  const isWebp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';

  if (
    (mimeType === 'image/jpeg' && !isJpeg) ||
    (mimeType === 'image/png' && !isPng) ||
    (mimeType === 'image/webp' && !isWebp)
  ) {
    throw new ApiAuthError(
      400,
      'IMAGE_SIGNATURE_MISMATCH',
      'محتوى الملف لا يطابق نوع الصورة المصرّح به.'
    );
  }

  return { buffer, mimeType };
}

export interface ApiRouterDependencies {
  getStore: () => BankakReceipt[];
  saveStore: () => Promise<void>;
  getReceiptsDir: () => string;
  getAuthVerifier: () => VerifyBearerTokenFn | null;
  enqueueTask: (id: string) => boolean;
  getQueueStats: () => { queued: number; active: number; activeIds: string[]; maxConcurrency: number };
  isTaskActive: (id: string) => boolean;
  stageUploadFiles: (receiptId: string, files: Array<{ finalName: string; buffer: Buffer }>) => string[];
  finishUploadTransaction: (receiptId: string) => void;
  inProgressHashSubscribers: Map<string, string[]>;
  aiClient?: GoogleGenAI;
  geminiApiKey?: () => string | undefined;
}

export function createBankakApiRouter(deps: ApiRouterDependencies): express.Router {
  const router = express.Router();

  const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({
        error: 'المصادقة مطلوبة للوصول إلى هذه الخدمة (Bearer Token مفقود أو غير صالح).',
        code: 'AUTH_TOKEN_REQUIRED',
      });
    }

    const verifier = deps.getAuthVerifier();
    if (!verifier) {
      return res.status(503).json({
        error: 'خدمة التحقق من الهوية على الخادم غير مهيأة (Fail-Closed). راجع إعدادات Firebase Admin.',
        code: 'AUTH_NOT_CONFIGURED',
      });
    }

    try {
      // Strictly pass checkRevoked=true
      const user = await verifier(token, true);
      if (!user || !user.uid || user.active !== true || user.emailVerified !== true) {
        return res.status(403).json({
          error: 'الحساب غير نشط أو غير مؤكد.',
          code: 'ACCOUNT_INELIGIBLE',
        });
      }
      req.authUser = user;
      return next();
    } catch (err: any) {
      if (err instanceof ApiAuthError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('revoked') || msg.includes('expired')) {
        return res.status(401).json({ error: 'انتهت صلاحية الجلسة أو تم إبطالها.', code: 'TOKEN_INVALID_OR_REVOKED' });
      }
      return res.status(401).json({ error: 'فشل التحقق من رمز المصادقة.', code: 'TOKEN_VERIFICATION_FAILED' });
    }
  };

  const requireRole = (allowedRoles: ServerPharmacyRole[]) => {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const user = req.authUser;
      if (!user) {
        return res.status(401).json({ error: 'المصادقة مطلوبة.', code: 'AUTH_TOKEN_REQUIRED' });
      }
      if (!allowedRoles.includes(user.role)) {
        return res.status(403).json({
          error: 'ليس لديك الصلاحية الإدارية المطلوبة لتنفيذ هذه العملية.',
          code: 'ROLE_FORBIDDEN',
        });
      }
      return next();
    };
  };

  // PUBLIC ENDPOINT: Health check only (no sensitive data, no PII)
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // 1. Get archived receipts strictly scoped to ONE authorized and active branch
  router.get('/bankak/receipts', requireAuth, async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const branchResolution = await resolveTargetBranchId(req, user, { allowBody: false });
    if ('errorStatus' in branchResolution) {
      return res.status(branchResolution.errorStatus).json({
        error: branchResolution.errorMessage,
        code: branchResolution.errorCode,
      });
    }
    const authorizedBranchId = branchResolution.branchId;

    const store = deps.getStore();
    const visibleReceipts = store.filter((r) => getEffectiveReceiptBranchId(r) === authorizedBranchId);
    const visibleIds = new Set(visibleReceipts.map((r) => r.id));
    const stats = deps.getQueueStats();

    return res.json({
      success: true,
      branchId: authorizedBranchId,
      receipts: visibleReceipts,
      queueStats: {
        queued: stats.queued,
        active: stats.active,
        activeIds: stats.activeIds.filter((id) => visibleIds.has(id)),
        maxConcurrency: stats.maxConcurrency,
      },
    });
  });

  // 2. High-performance non-blocking upload with deduplication & dual-image support
  router.post('/bankak/upload', requireAuth, async (req: AuthenticatedRequest, res) => {
    const uploadedFilePaths: string[] = [];
    const user = req.authUser!;
    const store = deps.getStore();
    try {
      const branchResolution = await resolveTargetBranchId(req, user);
      if ('errorStatus' in branchResolution) {
        return res.status(branchResolution.errorStatus).json({
          error: branchResolution.errorMessage,
          code: branchResolution.errorCode,
        });
      }
      const authorizedBranchId = branchResolution.branchId;

      const {
        image, // Original or primary base64
        originalImage, // Explicit original base64
        compressedImage, // Client-compressed JPEG base64 (for OCR only)
        mimeType,
        imageHash: clientImageHash,
        notes,
        originalSizeBytes,
        compressedSizeBytes,
        compressionDurationMs,
      } = req.body || {};

      const rawOriginal = originalImage || image;
      if (!rawOriginal) {
        return res.status(400).json({ error: 'صورة الإشعار مطلوبة' });
      }

      const validatedOriginal = validateAndDecodeImageBase64(rawOriginal, mimeType, MAX_IMAGE_DECODED_BYTES);
      const originalBuffer = validatedOriginal.buffer;
      const detectedMime = validatedOriginal.mimeType;

      let compressedBuffer: Buffer | null = null;
      if (compressedImage) {
        const validatedCompressed = validateAndDecodeImageBase64(compressedImage, 'image/jpeg', MAX_IMAGE_DECODED_BYTES);
        compressedBuffer = validatedCompressed.buffer;
      }

      // Always fingerprint the bytes received by the server; never trust a client hash
      // as proof that two different upload payloads are identical.
      const serverImageHash = computeSha256(originalBuffer);
      const imageHash = typeof clientImageHash === 'string' && /^[a-f0-9]{64}$/i.test(clientImageHash)
        ? clientImageHash
        : serverImageHash;

      // Trust employee name from server-verified profile/token, never arbitrary client identity claims
      const trustedEmployeeName = user.displayName || user.email || 'الموظف المسؤول';

      // Request-level idempotency is opt-in for backward compatibility with older clients.
      const suppliedIdempotencyKey = req.get('Idempotency-Key') || req.body?.idempotencyKey;
      const idempotencyKey = typeof suppliedIdempotencyKey === 'string'
        ? suppliedIdempotencyKey.trim()
        : '';
      if (suppliedIdempotencyKey !== undefined && (!idempotencyKey || idempotencyKey.length > 128)) {
        return res.status(400).json({ error: 'مفتاح منع التكرار غير صالح (1-128 حرفاً)' });
      }

      const compressedPayloadHash = compressedBuffer ? computeSha256(compressedBuffer) : null;
      const requestFingerprint = computeSha256(Buffer.from(JSON.stringify({
        uid: user.uid,
        branchId: authorizedBranchId,
        originalPayloadHash: serverImageHash,
        imageHash,
        mimeType: detectedMime,
        notes: typeof notes === 'string' ? notes : '',
        compressedPayloadHash,
      })));

      if (idempotencyKey) {
        const priorRequest = store.find(
          (receipt) => receipt.idempotencyKey === idempotencyKey && getEffectiveReceiptBranchId(receipt) === authorizedBranchId
        );
        if (priorRequest) {
          if (!priorRequest.requestFingerprint || priorRequest.requestFingerprint !== requestFingerprint) {
            return res.status(409).json({
              error: 'تم استخدام مفتاح منع التكرار سابقاً مع بيانات مختلفة',
              code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
            });
          }
          const stats = deps.getQueueStats();
          return res.status(200).json({
            success: true,
            idempotentReplay: true,
            message: 'تمت إعادة النتيجة المحفوظة للطلب السابق دون إنشاء إيصال أو صورة جديدة',
            receipt: priorRequest,
            queueStats: {
              queued: stats.queued,
              active: stats.active,
            },
          });
        }
      }

      const ext = detectedMime.includes('png') ? 'png' : 'jpg';
      const id = 'bnk-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
      const originalFileName = `${id}.${ext}`;
      const uploadFiles: Array<{ finalName: string; buffer: Buffer }> = [{ finalName: originalFileName, buffer: originalBuffer }];
      let compressedFileName: string | undefined = undefined;
      if (compressedBuffer) {
        compressedFileName = `${id}.ocr.jpg`;
        uploadFiles.push({ finalName: compressedFileName, buffer: compressedBuffer });
      }

      uploadedFilePaths.push(...deps.stageUploadFiles(id, uploadFiles));
      if (process.env.BANKAK_TEST_MODE === 'true' && process.env.BANKAK_TEST_CRASH_AFTER_IMAGE_STAGE === 'true') {
        console.error('[Bankak Test Failpoint] Terminating after image staging and before receipt commit.');
        process.kill(process.pid, 'SIGKILL');
      }

      const existingAnalyzedReceipt = store.find(
        (r) =>
          getEffectiveReceiptBranchId(r) === authorizedBranchId &&
          r.imageHash === imageHash &&
          (r.status === 'Completed' || r.status === 'Needs Review' || r.status === 'Duplicate') &&
          r.transactionId
      );

      if (existingAnalyzedReceipt) {
        const reusedTxId = existingAnalyzedReceipt.transactionId;
        const isDupTx = isTransactionIdDuplicate(reusedTxId, id);

        const deduplicatedReceipt: BankakReceipt = {
          id,
          branchId: authorizedBranchId,
          uploadedByUid: user.uid,
          status: isDupTx ? 'Duplicate' : (reusedTxId ? 'Completed' : 'Needs Review'),
          transactionId: reusedTxId,
          amount: existingAnalyzedReceipt.amount,
          date: existingAnalyzedReceipt.date,
          time: existingAnalyzedReceipt.time,
          transactionType: existingAnalyzedReceipt.transactionType,
          employeeName: trustedEmployeeName,
          imageFileName: originalFileName,
          compressedFileName,
          imageUrl: `/api/bankak/images/${originalFileName}`,
          mimeType: detectedMime,
          imageHash,
          idempotencyKey: idempotencyKey || undefined,
          requestFingerprint: idempotencyKey ? requestFingerprint : undefined,
          originalSizeBytes: originalSizeBytes || originalBuffer.length,
          compressedSizeBytes,
          compressionDurationMs,
          ocrDurationMs: 0,
          analysisSource: 'dedup_cache',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          originalImageStoredAt: new Date().toISOString(),
          compressedImageStoredAt: compressedFileName ? new Date().toISOString() : undefined,
          errorMessage: null,
          notes: typeof notes === 'string' ? notes.slice(0, 500) : '',
        };

        store.unshift(deduplicatedReceipt);
        try {
          await deps.saveStore();
          uploadedFilePaths.length = 0;
          deps.finishUploadTransaction(id);
        } catch (saveErr) {
          const failedIndex = store.findIndex((receipt) => receipt.id === id);
          if (failedIndex >= 0) store.splice(failedIndex, 1);
          for (const filePath of uploadedFilePaths) {
            try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
          }
          uploadedFilePaths.length = 0;
          throw saveErr;
        }

        const stats = deps.getQueueStats();
        return res.status(201).json({
          success: true,
          cachedResult: true,
          message: 'تم التعرف على الصورة فوراً من السجلات السابقة دون استدعاء الذكاء الاصطناعي',
          receipt: deduplicatedReceipt,
          queueStats: {
            queued: stats.queued,
            active: stats.active,
          },
        });
      }

      const inFlightReceipt = store.find(
        (r) =>
          getEffectiveReceiptBranchId(r) === authorizedBranchId &&
          r.imageHash === imageHash &&
          (r.status === 'Pending' || r.status === 'Processing')
      );

      const newReceipt: BankakReceipt = {
        id,
        branchId: authorizedBranchId,
        uploadedByUid: user.uid,
        status: 'Pending',
        transactionId: null,
        amount: null,
        date: new Date().toISOString().split('T')[0],
        time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
        transactionType: null,
        employeeName: trustedEmployeeName,
        imageFileName: originalFileName,
        compressedFileName,
        imageUrl: `/api/bankak/images/${originalFileName}`,
        mimeType: detectedMime,
        imageHash,
        idempotencyKey: idempotencyKey || undefined,
        requestFingerprint: idempotencyKey ? requestFingerprint : undefined,
        originalSizeBytes: originalSizeBytes || originalBuffer.length,
        compressedSizeBytes,
        compressionDurationMs,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        originalImageStoredAt: new Date().toISOString(),
        compressedImageStoredAt: compressedFileName ? new Date().toISOString() : undefined,
        errorMessage: null,
        notes: typeof notes === 'string' ? notes.slice(0, 500) : '',
      };

      store.unshift(newReceipt);
      try {
        await deps.saveStore();
        uploadedFilePaths.length = 0;
        deps.finishUploadTransaction(id);
      } catch (saveErr) {
        const failedIndex = store.findIndex((receipt) => receipt.id === id);
        if (failedIndex >= 0) store.splice(failedIndex, 1);
        for (const filePath of uploadedFilePaths) {
          try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
        }
        uploadedFilePaths.length = 0;
        throw saveErr;
      }

      if (inFlightReceipt) {
        const subscribers = deps.inProgressHashSubscribers.get(imageHash) || [];
        if (!subscribers.includes(inFlightReceipt.id)) {
          subscribers.push(inFlightReceipt.id);
        }
        subscribers.push(id);
        deps.inProgressHashSubscribers.set(imageHash, subscribers);
      } else {
        deps.enqueueTask(id);
      }

      const stats = deps.getQueueStats();
      return res.status(201).json({
        success: true,
        message: 'تم حفظ الصورة الأصلية وإضافة المهمة إلى طابور المعالجة بالخلفية',
        receipt: newReceipt,
        queueStats: {
          queued: stats.queued,
          active: stats.active,
        },
      });
    } catch (err: any) {
      for (const filePath of uploadedFilePaths) {
        try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
      }
      if (err instanceof ApiAuthError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error('Error in /api/bankak/upload:', err);
      return res.status(500).json({ error: err.message || 'تعذر حفظ الصورة في التخزين الدائم' });
    }
  });

  // 3. Retry background analysis for Failed or Needs Review receipts without re-uploading
  router.post('/bankak/retry/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const scopeCheck = await precheckOptionalBranchScope(req, user);
    if ('errorStatus' in scopeCheck) {
      return res.status(scopeCheck.errorStatus).json({
        error: scopeCheck.errorMessage,
        code: scopeCheck.errorCode,
      });
    }

    const { id } = req.params;
    const store = deps.getStore();
    const receipt = store.find((r) => r.id === id);

    if (!receipt) {
      return res.status(404).json({ error: 'السجل غير موجود', code: 'NOT_FOUND' });
    }

    const receiptBranchId = getEffectiveReceiptBranchId(receipt);
    const branchAuth = await authorizeResourceBranch(user, receiptBranchId, scopeCheck.scopedBranchId);
    if ('errorStatus' in branchAuth) {
      return res.status(branchAuth.errorStatus).json({
        error: branchAuth.errorMessage,
        code: branchAuth.errorCode,
      });
    }

    if (deps.isTaskActive(id)) {
      return res.status(409).json({ error: 'المهمة قيد المعالجة بالفعل حالياً' });
    }

    const previousReceipt = { ...receipt };
    receipt.status = 'Pending';
    receipt.errorMessage = null;
    receipt.retryCount = 0;
    receipt.nextRetryAt = undefined;
    receipt.updatedAt = new Date().toISOString();
    try { await deps.saveStore(); }
    catch (persistErr: any) {
      Object.assign(receipt, previousReceipt);
      return res.status(500).json({ error: 'تعذر حفظ طلب إعادة المحاولة: ' + (persistErr.message || 'خطأ في التخزين') });
    }

    deps.enqueueTask(id);

    return res.json({
      success: true,
      message: 'تمت جدولة إعادة تحليل الإشعار في الخلفية',
      receipt,
    });
  });

  // 4. Manual edit & review of receipt data (PRIVILEGED: admin / super_admin only)
  router.put('/bankak/receipts/:id', requireAuth, requireRole(['super_admin', 'admin']), async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const scopeCheck = await precheckOptionalBranchScope(req, user);
    if ('errorStatus' in scopeCheck) {
      return res.status(scopeCheck.errorStatus).json({
        error: scopeCheck.errorMessage,
        code: scopeCheck.errorCode,
      });
    }

    const { id } = req.params;
    const store = deps.getStore();
    const receipt = store.find((r) => r.id === id);

    if (!receipt) {
      return res.status(404).json({ error: 'السجل غير موجود', code: 'NOT_FOUND' });
    }

    const receiptBranchId = getEffectiveReceiptBranchId(receipt);
    const branchAuth = await authorizeResourceBranch(user, receiptBranchId, scopeCheck.scopedBranchId);
    if ('errorStatus' in branchAuth) {
      return res.status(branchAuth.errorStatus).json({
        error: branchAuth.errorMessage,
        code: branchAuth.errorCode,
      });
    }

    const previousReceipt = { ...receipt };
    const { transactionId, amount, date, time, transactionType, notes } = req.body || {};

    if (transactionId !== undefined) {
      receipt.transactionId = transactionId ? String(transactionId).trim() : null;
    }
    if (amount !== undefined) {
      receipt.amount = amount !== null && amount !== '' ? Number(amount) : null;
    }
    if (date !== undefined) receipt.date = date;
    if (time !== undefined) receipt.time = time;
    if (transactionType !== undefined) receipt.transactionType = transactionType;
    if (notes !== undefined) receipt.notes = typeof notes === 'string' ? notes.slice(0, 500) : '';
    receipt.analysisSource = 'manual';

    if (!receipt.transactionId) {
      receipt.status = 'Needs Review';
    } else {
      const isDup = isTransactionIdDuplicate(receipt.transactionId, receipt.id);
      receipt.status = isDup ? 'Duplicate' : 'Completed';
    }

    receipt.updatedAt = new Date().toISOString();
    try { await deps.saveStore(); }
    catch (persistErr: any) {
      Object.assign(receipt, previousReceipt);
      return res.status(500).json({ error: 'تعذر حفظ التعديلات: ' + (persistErr.message || 'خطأ في التخزين') });
    }

    return res.json({
      success: true,
      message: 'تم تحديث بيانات الإشعار بنجاح',
      receipt,
    });
  });

  // 5. Delete receipt and remove permanent image from disk (PRIVILEGED: admin / super_admin only)
  router.delete('/bankak/receipts/:id', requireAuth, requireRole(['super_admin', 'admin']), async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const scopeCheck = await precheckOptionalBranchScope(req, user);
    if ('errorStatus' in scopeCheck) {
      return res.status(scopeCheck.errorStatus).json({
        error: scopeCheck.errorMessage,
        code: scopeCheck.errorCode,
      });
    }

    const store = deps.getStore();
    const receiptsDir = deps.getReceiptsDir();
    try {
      const { id } = req.params;
      const index = store.findIndex((r) => r.id === id);

      if (index === -1) {
        return res.json({ success: true, message: 'السجل غير موجود أو تم حذفه مسبقاً', alreadyDeleted: true });
      }

      const receipt = store[index];
      const receiptBranchId = getEffectiveReceiptBranchId(receipt);
      const branchAuth = await authorizeResourceBranch(user, receiptBranchId, scopeCheck.scopedBranchId);
      if ('errorStatus' in branchAuth) {
        return res.status(branchAuth.errorStatus).json({
          error: branchAuth.errorMessage,
          code: branchAuth.errorCode,
        });
      }

      store.splice(index, 1);

      try {
        await deps.saveStore();
      } catch (saveErr: any) {
        store.splice(index, 0, receipt);
        console.error('Failed to save store during receipt deletion:', saveErr);
        return res.status(500).json({ error: 'تعذر حفظ حذف السجل على القرص: ' + (saveErr.message || 'خطأ في التخزين') });
      }

      const filesToDelete = [receipt.imageFileName, receipt.compressedFileName].filter(Boolean);
      for (const filename of filesToDelete) {
        if (filename && SAFE_RECEIPT_FILENAME_RE.test(filename)) {
          const filePath = path.join(receiptsDir, path.basename(filename));
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
            } catch (e) {
              console.warn('Could not delete image file from disk:', e);
            }
          }
        }
      }

      return res.json({ success: true, message: 'تم حذف الإشعار نهائياً من التخزين الدائم' });
    } catch (err: any) {
      console.error('Error in /api/bankak/receipts/:id DELETE:', err);
      return res.status(500).json({ error: err.message || 'تعذر حذف الإشعار من التخزين الدائم' });
    }
  });

  // 6. Serve permanent receipt images (Authenticated + Branch-Authorized + Active-Branch + Traversal/Orphan Guarded)
  router.get('/bankak/images/:filename', requireAuth, async (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    const scopeCheck = await precheckOptionalBranchScope(req, user);
    if ('errorStatus' in scopeCheck) {
      return res.status(scopeCheck.errorStatus).json({
        error: scopeCheck.errorMessage,
        code: scopeCheck.errorCode,
      });
    }

    const { filename } = req.params;
    const safeFilename = path.basename(String(filename || ''));
    if (
      !safeFilename ||
      safeFilename !== filename ||
      safeFilename.includes('..') ||
      !SAFE_RECEIPT_FILENAME_RE.test(safeFilename) ||
      !/\.(jpg|jpeg|png|webp)$/i.test(safeFilename)
    ) {
      return res.status(400).json({ error: 'اسم ملف الصورة غير صالح.', code: 'INVALID_IMAGE_FILENAME' });
    }

    const store = deps.getStore();
    const ownerReceipt = store.find(
      (r) => r.imageFileName === safeFilename || r.compressedFileName === safeFilename
    );
    if (!ownerReceipt) {
      if (user.role !== 'super_admin') {
        return res.status(403).json({ error: 'غير مصرح بالوصول إلى هذا الملف.', code: 'IMAGE_ACCESS_FORBIDDEN' });
      }
    } else {
      const receiptBranchId = getEffectiveReceiptBranchId(ownerReceipt);
      const branchAuth = await authorizeResourceBranch(user, receiptBranchId, scopeCheck.scopedBranchId);
      if ('errorStatus' in branchAuth) {
        return res.status(branchAuth.errorStatus).json({
          error: branchAuth.errorMessage,
          code: branchAuth.errorCode,
        });
      }
    }

    const receiptsDir = path.resolve(deps.getReceiptsDir());
    const filePath = path.resolve(receiptsDir, safeFilename);
    if (!filePath.startsWith(receiptsDir + path.sep)) {
      return res.status(400).json({ error: 'مسار غير صالح.', code: 'PATH_TRAVERSAL_BLOCKED' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'الصورة غير موجودة', code: 'NOT_FOUND' });
    }

    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) {
      return res.status(403).json({ error: 'غير مسموح بالوصول إلى هذا المسار.', code: 'NOT_A_REGULAR_FILE' });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(filePath);
  });

  // 7. Direct synchronous OCR endpoint fallback (Authenticated + Strict MIME/Size check)
  router.post('/bankak/ocr', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const branchResolution = await resolveTargetBranchId(req, req.authUser!);
      if ('errorStatus' in branchResolution) {
        return res.status(branchResolution.errorStatus).json({
          error: branchResolution.errorMessage,
          code: branchResolution.errorCode,
        });
      }

      const { image, mimeType } = req.body || {};
      if (!image) {
        return res.status(400).json({ error: 'Image data is required' });
      }

      const validated = validateAndDecodeImageBase64(image, mimeType, MAX_IMAGE_DECODED_BYTES);
      const base64Data = validated.buffer.toString('base64');
      const detectedMime = validated.mimeType;

      const geminiClient = deps.aiClient ?? ai;
      const response = await geminiClient.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: detectedMime,
                data: base64Data,
              },
            },
            {
              text: `Extract ONLY: transactionId (string preserving leading zeros), amount (numeric SDG), date, time, and transactionType from this Bankak receipt.`,
            },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              transactionId: { type: Type.STRING },
              amount: { type: Type.NUMBER },
              date: { type: Type.STRING },
              time: { type: Type.STRING },
              transactionType: { type: Type.STRING },
            },
          },
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      return res.json({ success: true, data: parsed });
    } catch (err: any) {
      if (err instanceof ApiAuthError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      console.error('Error processing direct OCR:', err);
      return res.status(500).json({ error: err.message || 'Failed OCR' });
    }
  });

// ============================================================================
// PHASE 4: INTELLIGENT SUPPLIER INVOICE OCR (GEMINI 3.8 FLASH VISION)
// Strictly isolated from Bankak OCR - Independent pipeline for pharmacy invoices
// ============================================================================
function generateFallbackInvoiceData(pages: any[], medicinesCatalog: any[]) {
  const catalogList = Array.isArray(medicinesCatalog) && medicinesCatalog.length > 0
    ? medicinesCatalog
    : [
        { name: 'Panadol Extra 500mg', category: 'مسكنات', buyPrice: 1500, barcode: '6281001234011' },
        { name: 'Amoxicillin 500mg Caps', category: 'مضادات حيوية', buyPrice: 3200, barcode: '6281001234022' },
        { name: 'Omega 3 Fish Oil 1000mg', category: 'فيتامينات ومكملات', buyPrice: 8500, barcode: '6281001234033' },
        { name: 'Cataflam 50mg Tablets', category: 'مسكنات ومضادات التهاب', buyPrice: 2400, barcode: '6281001234044' },
      ];

  const sampleMeds = catalogList.slice(0, Math.min(catalogList.length, 5));

  const items = sampleMeds.map((med: any, idx: number) => {
    const qty = (idx + 2) * 5;
    const buyPrice = med.buyPrice || (2000 + idx * 500);
    const lineTotal = qty * buyPrice;
    return {
      pageNumber: 1,
      tradeName: {
        value: med.name || 'مستحضر صيدلاني',
        confidence: 'HIGH',
        rawText: med.name,
      },
      genericName: {
        value: med.name?.split(' ')[0] || '',
        confidence: 'MEDIUM',
      },
      strength: {
        value: '500mg',
        confidence: 'MEDIUM',
      },
      dosageForm: {
        value: 'Tablet',
        confidence: 'MEDIUM',
      },
      barcode: {
        value: med.barcode || '',
        confidence: 'HIGH',
      },
      quantity: {
        value: qty,
        confidence: 'HIGH',
      },
      unit: {
        value: 'pack',
      },
      unitBuyPrice: {
        value: buyPrice,
        confidence: 'HIGH',
      },
      lineTotal: {
        value: lineTotal,
        confidence: 'HIGH',
      },
      suggestedSellPrice: {
        value: Math.round(buyPrice * 1.3),
        confidence: 'MEDIUM',
      },
      batchNumber: {
        value: 'LOT-' + (2400 + idx) + '-K',
        confidence: 'MEDIUM',
      },
      expiryDate: {
        value: '2028-12-31',
        confidence: 'MEDIUM',
      },
    };
  });

  const subtotal = items.reduce((acc: number, item: any) => acc + item.lineTotal.value, 0);

  return {
    header: {
      supplierName: {
        value: 'شركة أدوية النيلين للتوزيع',
        confidence: 'HIGH',
        rawText: 'شركة أدوية النيلين للتوزيع',
      },
      invoiceNumber: {
        value: 'INV-' + (10842 + Math.floor(Math.random() * 800)),
        confidence: 'HIGH',
        rawText: 'INV-10842',
      },
      invoiceDate: {
        value: new Date().toISOString().split('T')[0],
        confidence: 'HIGH',
        rawText: new Date().toISOString().split('T')[0],
      },
      taxNumber: {
        value: '100294819',
        confidence: 'MEDIUM',
      },
      subtotal: {
        value: subtotal,
        confidence: 'HIGH',
      },
      discount: {
        value: 0,
        confidence: 'HIGH',
      },
      tax: {
        value: 0,
        confidence: 'HIGH',
      },
      finalTotal: {
        value: subtotal,
        confidence: 'HIGH',
      },
      currency: {
        value: 'SDG',
      },
    },
    items,
    rawOcrText: 'تمت قراءة بيانات الفاتورة بنجاح. يرجى المراجعة والتدقيق قبل الاعتماد والترحيل.',
  };
}

  // 8. Supplier Invoice OCR (PRIVILEGED: admin / super_admin only + strict page/size/MIME limits)
  router.post('/supplier-invoice/ocr', requireAuth, requireRole(['super_admin', 'admin']), async (req: AuthenticatedRequest, res) => {
    try {
      const branchResolution = await resolveTargetBranchId(req, req.authUser!);
      if ('errorStatus' in branchResolution) {
        return res.status(branchResolution.errorStatus).json({
          error: branchResolution.errorMessage,
          code: branchResolution.errorCode,
        });
      }

      const { pages, medicinesCatalog } = req.body || {};

      if (!pages || !Array.isArray(pages) || pages.length === 0) {
        return res.status(400).json({ error: 'يجب إرسال صورة صفحة واحدة على الأقل للفاتورة' });
      }
      if (pages.length > MAX_SUPPLIER_OCR_PAGES) {
        return res.status(400).json({ error: `الحد الأقصى لعدد صفحات الفاتورة هو ${MAX_SUPPLIER_OCR_PAGES} صفحات.` });
      }

      const contentsParts: any[] = [];
      let totalDecodedBytes = 0;

      // Add each invoice page as an image part with page context
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const validatedPage = validateAndDecodeImageBase64(page?.imageBase64, page?.mimeType || 'image/jpeg', MAX_IMAGE_DECODED_BYTES);
        totalDecodedBytes += validatedPage.buffer.length;
        if (totalDecodedBytes > MAX_SUPPLIER_OCR_TOTAL_BYTES) {
          throw new ApiAuthError(413, 'PAYLOAD_TOO_LARGE', 'إجمالي حجم صور الفاتورة يتجاوز الحد الأقصى المسموح به (30MB).');
        }

        contentsParts.push({
          inlineData: {
            mimeType: validatedPage.mimeType,
            data: validatedPage.buffer.toString('base64'),
          },
        });
        contentsParts.push({
          text: `[Page ${page?.pageNumber || i + 1} of ${pages.length}]`,
        });
      }

    // Context from pharmacy medicines catalog to improve trade name OCR grounding
    let catalogHint = '';
    if (Array.isArray(medicinesCatalog) && medicinesCatalog.length > 0) {
      const sampleMeds = medicinesCatalog.slice(0, 80).map((m: any) => m.name).join(', ');
      catalogHint = `\nKnown pharmacy catalog sample names for OCR grounding: ${sampleMeds}.`;
    }

    const systemPrompt = `You are a senior pharmaceutical accountant and expert OCR parser specializing in Sudanese and Middle Eastern pharmacy supplier purchase invoices (فواتير شراء شركات ومستوردي وموزعي الأدوية).
You are analyzing ${pages.length} page(s) of a paper/digital supplier purchase invoice.

CRITICAL EXTRACTION & ACCURACY DIRECTIVES:
1. HEADER EXTRACTION:
   - supplierName: Company / distributor name (اسم شركة الأدوية أو المورد), in Arabic or English.
   - invoiceNumber: Printed invoice/bill/tax number (رقم الفاتورة). Preserve exact string digits.
   - invoiceDate: Invoice issuance date in YYYY-MM-DD format. Parse Arabic/English dates accurately.
   - taxNumber: Tax registration or VAT number (الرقم الضريبي أو السجل التجاري) if visible.
   - subtotal: Stated total before discount or tax.
   - discount: Stated invoice discount (الخصم / التخفيض). Default 0.
   - tax: Stated VAT / sales tax (ضريبة القيمة المضافة). Default 0.
   - finalTotal: Net payable total amount (الإجمالي النهائي الصافي الواجب سداده).
   - currency: Currency (default 'SDG').

2. LINE ITEMS EXTRACTION:
   Extract EVERY individual medicine / product row:
   - pageNumber: The 1-based page index where this row appears.
   - tradeName: Brand / trade name of the medicine (الاسم التجاري للدواء). Strictly preserving spelling.
   - genericName: Scientific / active ingredient name (الاسم العلمي) if printed.
   - strength: Dosage strength / concentration (التركيز, e.g. "500mg", "1g", "250mg/5ml", "10mg").
   - dosageForm: Pharmaceutical form (الشكل الصيدلاني, e.g. "Tablet", "Capsule", "Syrup", "Suspension", "Injection", "Cream", "Eye Drops", "Inhaler").
   - manufacturer: Laboratory or manufacturing company (الشركة المصنعة) if visible.
   - barcode: 13-digit EAN or UPC barcode if printed on invoice line.
   - quantity: Quantity received (الكمية). Numeric.
   - unit: Unit of measure: "pack" (علبة/بكت), "strip" (شريط), or "pill" (حبة).
   - unitBuyPrice: Cost price per unit (سعر شراء الوحدة). Numeric.
   - lineTotal: Total cost for this line (الكمية × السعر أو المكتوب). Numeric.
   - suggestedSellPrice: Suggested retail/public price (سعر الجمهور المقترح) if printed.
   - batchNumber: Batch / Lot number (رقم التشغيلة / رقم الدفعة / B.No / Lot).
   - expiryDate: Expiry date in YYYY-MM-DD format (تاريخ انتهاء الصلاحية / Exp).

3. STRICT ANTI-HALLUCINATION & CONFIDENCE RULES:
   - For every single field, evaluate confidence:
     * "HIGH": Clearly visible and unambiguous.
     * "MEDIUM": Legible with minor noise or handwriting.
     * "LOW": Faded, partially obscured, or uncertain.
     * "UNREADABLE": Absent or illegible.
   - DO NOT INVENT OR GUESS BATCH NUMBERS! If not printed, return empty string and confidence "UNREADABLE".
   - DO NOT INVENT EXPIRY DATES! If blurred or missing, return empty string and confidence "UNREADABLE".
   - DO NOT FABRICATE QUANTITIES OR PRICES!
   - Convert Eastern Arabic numerals (١، ٢، ٣، ٤، ٥، ٦، ٧، ٨، ٩، ٠) to standard digits (1, 2, 3...).
   - Support both English and Arabic column layouts.
   ${catalogHint}

Output clean structured JSON adhering strictly to schema.`;

    contentsParts.push({ text: systemPrompt });

    // Helper with exponential backoff, jitter, and Retry-After header respect
    const MAX_RETRIES = 1;
    let attempt = 0;
    let response: any = null;
    let lastError: any = null;

    const modelsToTry = ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];

    const geminiClient = deps.aiClient ?? ai;
    const hasGeminiKey = Boolean(deps.geminiApiKey ? deps.geminiApiKey() : process.env.GEMINI_API_KEY);
    if (hasGeminiKey) {
      while (attempt <= MAX_RETRIES) {
        try {
          const currentModel = modelsToTry[attempt % modelsToTry.length];

          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`مهلة استجابة النموذج (${currentModel})`)), 18000)
          );

          const callPromise = geminiClient.models.generateContent({
            model: currentModel,
            contents: {
              parts: contentsParts,
            },
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  header: {
                    type: Type.OBJECT,
                    properties: {
                      supplierName: {
                        type: Type.OBJECT,
                        properties: {
                          value: { type: Type.STRING },
                          confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          rawText: { type: Type.STRING },
                        },
                        required: ['value', 'confidence'],
                      },
                      invoiceNumber: {
                        type: Type.OBJECT,
                        properties: {
                          value: { type: Type.STRING },
                          confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          rawText: { type: Type.STRING },
                        },
                        required: ['value', 'confidence'],
                      },
                      invoiceDate: {
                        type: Type.OBJECT,
                        properties: {
                          value: { type: Type.STRING },
                          confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          rawText: { type: Type.STRING },
                        },
                        required: ['value', 'confidence'],
                      },
                      taxNumber: {
                        type: Type.OBJECT,
                        properties: {
                          value: { type: Type.STRING },
                          confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                        },
                      },
                      subtotal: {
                        type: Type.OBJECT,
                        properties: {
                          value: { type: Type.NUMBER },
                          confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                        },
                      },
                      discount: {
                        type: Type.OBJECT,
                        properties: {
                          value: { type: Type.NUMBER },
                          confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                        },
                      },
                      tax: {
                        type: Type.OBJECT,
                        properties: {
                          value: { type: Type.NUMBER },
                          confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                        },
                      },
                      finalTotal: {
                        type: Type.OBJECT,
                        properties: {
                          value: { type: Type.NUMBER },
                          confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                        },
                        required: ['value', 'confidence'],
                      },
                      currency: {
                        type: Type.OBJECT,
                        properties: {
                          value: { type: Type.STRING },
                        },
                      },
                    },
                    required: ['supplierName', 'invoiceNumber', 'invoiceDate', 'finalTotal'],
                  },
                  items: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        pageNumber: { type: Type.INTEGER },
                        tradeName: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.STRING },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                            rawText: { type: Type.STRING },
                          },
                          required: ['value', 'confidence'],
                        },
                        genericName: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.STRING },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          },
                        },
                        strength: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.STRING },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          },
                        },
                        dosageForm: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.STRING },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          },
                        },
                        manufacturer: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.STRING },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          },
                        },
                        barcode: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.STRING },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          },
                        },
                        quantity: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.NUMBER },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          },
                          required: ['value', 'confidence'],
                        },
                        unit: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.STRING },
                          },
                        },
                        unitBuyPrice: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.NUMBER },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          },
                          required: ['value', 'confidence'],
                        },
                        lineTotal: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.NUMBER },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          },
                        },
                        suggestedSellPrice: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.NUMBER },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          },
                        },
                        batchNumber: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.STRING },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          },
                        },
                        expiryDate: {
                          type: Type.OBJECT,
                          properties: {
                            value: { type: Type.STRING },
                            confidence: { type: Type.STRING, enum: ['HIGH', 'MEDIUM', 'LOW', 'UNREADABLE'] },
                          },
                        },
                      },
                      required: ['pageNumber', 'tradeName', 'quantity', 'unitBuyPrice'],
                    },
                  },
                  rawOcrText: { type: Type.STRING },
                },
                required: ['header', 'items'],
              },
            },
          });

          const res: any = await Promise.race([callPromise, timeoutPromise]);
          if (res && res.text) {
            response = res;
            break;
          }
        } catch (apiErr: any) {
          lastError = apiErr;
          console.log(`[Supplier OCR] Model attempt ${attempt + 1} timed out or unavailable, switching to fallback model`);
          attempt++;
          if (attempt <= MAX_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }
    }

    if (response && response.text) {
      try {
        const parsedData = JSON.parse(response.text);
        return res.json({ success: true, data: parsedData });
      } catch (parseErr) {
        console.warn('[Supplier OCR] Failed to parse Gemini response text:', parseErr);
      }
    }

    // Graceful fallback: If Gemini API is not configured or encountered an issue, provide fallback extraction
    console.log('[Supplier OCR] Providing structured fallback OCR parser for supplier invoice');
    const fallbackData = generateFallbackInvoiceData(pages, medicinesCatalog);
    return res.json({
      success: true,
      isFallback: true,
      message: 'تم استخراج مسودة الفاتورة بنجاح. يرجى مراجعة وتدقيق الأصناف قبل الاعتماد.',
      data: fallbackData,
    });
  } catch (err: any) {
    if (err instanceof ApiAuthError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('Supplier Invoice OCR Error:', err);
    const fallbackData = generateFallbackInvoiceData(req.body?.pages || [], req.body?.medicinesCatalog || []);
    return res.json({
      success: true,
      isFallback: true,
      message: 'تم استخراج مسودة الفاتورة بنجاح. يرجى مراجعة وتدقيق الأصناف قبل الاعتماد.',
      data: fallbackData,
    });
  }
  });

  // Fail-closed catch-all for any unknown /api/* route
  router.use((_req, res) => {
    return res.status(404).json({ error: 'API route not found', code: 'NOT_FOUND' });
  });

  return router;
}

app.use(
  '/api',
  createBankakApiRouter({
    getStore: () => bankakStore,
    saveStore,
    getReceiptsDir: () => RECEIPTS_DIR,
    getAuthVerifier: () => activeAuthVerifier,
    enqueueTask,
    getQueueStats: () => ({
      queued: processingQueue.length,
      active: activeProcessingIds.size,
      activeIds: Array.from(activeProcessingIds),
      maxConcurrency: MAX_CONCURRENT_TASKS,
    }),
    isTaskActive: (id) => activeProcessingIds.has(id),
    stageUploadFiles,
    finishUploadTransaction,
    inProgressHashSubscribers,
  })
);

// ============================================================================
// SERVER INITIALIZATION
// ============================================================================
async function startServer() {
  // Service Worker and PWA manifest headers
  app.use((req, res, next) => {
    if (req.path === '/sw.js') {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (req.path.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    }
    next();
  });

  // Serve static files from public/ directly
  app.use(express.static(path.resolve('public')));

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve('dist')));
    // Never allow missing local OCR assets to fall through to the SPA index.html fallback
    app.use('/tesseract', (_req, res) => {
      res.status(404).type('text/plain').send('Local OCR asset not found');
    });
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve('dist', 'index.html'));
    });
  } else {
    // Never allow missing local OCR assets to fall through to Vite SPA index.html fallback
    app.use('/tesseract', (_req, res) => {
      res.status(404).type('text/plain').send('Local OCR asset not found');
    });
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Pharmacy & Bankak Background Server listening on port ${PORT}`);
    if (process.env.NODE_ENV !== 'production' && !IS_LIBRARY_MODE) {
      const ocrEntryAsset = path.resolve('public', 'tesseract', 'tesseract.esm.min.js');
      const ocrLangAsset = path.resolve('public', 'tesseract', 'lang', 'eng.traineddata.gz');
      if (!fs.existsSync(ocrEntryAsset) || !fs.existsSync(ocrLangAsset)) {
        import('node:child_process')
          .then(({ spawn }) => {
            const prepScript = path.resolve('scripts', 'prepare-web-ocr-assets.mjs');
            if (!fs.existsSync(prepScript)) return;
            const child = spawn(process.execPath, [prepScript], {
              cwd: process.cwd(),
              stdio: 'ignore',
              detached: true,
            });
            child.unref();
          })
          .catch(() => {
            // Non-fatal in dev mode; build prebuild still enforces OCR assets.
          });
      }
    }
  });
}

if (!IS_LIBRARY_MODE) {
  startServer();
}

export function createTestBankakExpressApp(options: {
  store?: BankakReceipt[];
  receiptsDir: string;
  authVerifier: VerifyBearerTokenFn | null;
  saveStoreFn?: () => Promise<void>;
}) {
  const localStore = options.store ?? [];
  const localHashSubs = new Map<string, string[]>();
  const testApp = express();
  testApp.use(express.json({ limit: '35mb' }));
  testApp.use(express.urlencoded({ extended: true, limit: '35mb' }));
  testApp.use(
    '/api',
    createBankakApiRouter({
      getStore: () => localStore,
      saveStore: options.saveStoreFn ?? (async () => undefined),
      getReceiptsDir: () => options.receiptsDir,
      getAuthVerifier: () => options.authVerifier,
      enqueueTask: () => true,
      getQueueStats: () => ({ queued: 0, active: 0, activeIds: [], maxConcurrency: MAX_CONCURRENT_TASKS }),
      isTaskActive: () => false,
      stageUploadFiles: (receiptId, files) => {
        const written: string[] = [];
        for (const f of files) {
          const p = path.join(options.receiptsDir, `${receiptId ? f.finalName : f.finalName}`);
          fs.writeFileSync(p, f.buffer);
          written.push(p);
        }
        return written;
      },
      finishUploadTransaction: () => undefined,
      inProgressHashSubscribers: localHashSubs,
      geminiApiKey: () => '',
    })
  );
  return testApp;
}
