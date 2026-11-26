import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import {
  initializeAndMigrate,
  openPharmacyDB,
  saveSupplierInvoiceDraft,
  getSupplierInvoiceDraft
} from '../src/services/pharmacyDb';
import {
  createEmptySupplierInvoiceDraft,
  executeOcrExtraction
} from '../src/services/supplierInvoiceOcrService';

async function readReceipt(id: string): Promise<any> {
  const db = await openPharmacyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('receipts', 'readonly');
    const request = tx.objectStore('receipts').get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function writeReceipt(receipt: any): Promise<void> {
  const db = await openPharmacyDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('receipts', 'readwrite');
    tx.objectStore('receipts').put(receipt);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Receipt transaction aborted'));
  });
}

async function run(): Promise<void> {
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    assert.ok(condition, message);
    passed++;
    console.log(`✓ ${message}`);
  };

  await initializeAndMigrate();

  // Bankak: verify the primary IndexedDB receipts store preserves the original image payload.
  const receiptId = 'phase1a-local-receipt-test';
  const originalImage = 'data:image/jpeg;base64,ORIGINAL_IMAGE_BYTES';
  const receipt = {
    id: receiptId,
    status: 'Pending',
    transactionId: null,
    amount: null,
    imageData: originalImage,
    imageHash: 'sha256-phase1a-test',
    mimeType: 'image/jpeg',
    createdAt: new Date().toISOString()
  };
  await writeReceipt(receipt);
  const storedReceipt = await readReceipt(receiptId);
  check(storedReceipt?.id === receiptId, 'Bankak receipt is persisted in the primary IndexedDB receipts store');
  check(storedReceipt?.imageData === originalImage, 'Bankak original image payload survives IndexedDB round-trip');
  check(storedReceipt?.imageHash === receipt.imageHash, 'Bankak image hash survives IndexedDB round-trip');

  // Supplier invoice: verify a page-bearing draft is persisted before any OCR attempt.
  const draft = createEmptySupplierInvoiceDraft();
  draft.id = 'phase1a-local-invoice-test';
  draft.pages.push({
    id: 'phase1a-page-1',
    pageNumber: 1,
    originalFileName: 'invoice-page-1.jpg',
    dataUrl: originalImage,
    imageHash: 'sha256-invoice-page-test',
    rotation: 0,
    width: 1200,
    height: 1600,
    createdAt: new Date().toISOString()
  });
  await saveSupplierInvoiceDraft(draft);
  const storedDraft = await getSupplierInvoiceDraft(draft.id);
  check(storedDraft?.pages.length === 1, 'Supplier invoice draft is persisted with its page before OCR');
  check(storedDraft?.pages[0]?.dataUrl === originalImage, 'Supplier invoice page image survives IndexedDB round-trip');

  // Offline: OCR must fail closed before calling the remote API; the local draft must remain.
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: false }
  });
  let offlineRejected = false;
  try {
    await executeOcrExtraction(draft, [], []);
  } catch (error) {
    offlineRejected = error instanceof Error &&
      error.message.includes('تتطلب اتصالاً بالإنترنت');
  } finally {
    if (previousNavigator) {
      Object.defineProperty(globalThis, 'navigator', previousNavigator);
    } else {
      delete (globalThis as any).navigator;
    }
  }
  check(offlineRejected, 'Supplier invoice OCR rejects offline execution before remote processing');
  const draftAfterOfflineAttempt = await getSupplierInvoiceDraft(draft.id);
  check(draftAfterOfflineAttempt?.pages[0]?.dataUrl === originalImage, 'Supplier invoice draft and image remain available after offline OCR rejection');

  console.log(`\nPhase 1A local persistence checks: ${passed}/7 passed.`);
}

run().catch((error) => {
  console.error('Phase 1A local persistence checks failed:', error);
  process.exitCode = 1;
});
