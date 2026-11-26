import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BANKAK_IMAGE_RETENTION_MS, runBankakImageRetention } from '../src/services/bankakImageRetention.ts';

async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khalid-bankak-retention-'));
  const supplierDir = path.join(root, 'supplier-invoices');
  const bankakDir = path.join(root, 'bankak-receipts');
  await fs.mkdir(supplierDir);
  await fs.mkdir(bankakDir);
  const now = new Date('2026-11-14T12:00:00.000Z');
  const old = new Date(now.getTime() - BANKAK_IMAGE_RETENTION_MS - 1000).toISOString();
  const exactBoundary = new Date(now.getTime() - BANKAK_IMAGE_RETENTION_MS).toISOString();
  const recent = new Date(now.getTime() - BANKAK_IMAGE_RETENTION_MS + 1000).toISOString();

  try {
    for (const name of ['old-original.jpg', 'old-compressed.jpg', 'exactly-sixty.jpg', 'recent.jpg', 'unknown.jpg', 'pending.jpg', 'shared.jpg']) {
      await fs.writeFile(path.join(bankakDir, name), 'bankak-image');
    }
    await fs.writeFile(path.join(supplierDir, 'supplier-payment-proof.jpg'), 'supplier-proof');

    const receipts = [
      { id: 'old', status: 'Completed', transactionId: '000123', amount: 25000, imageFileName: 'old-original.jpg', compressedFileName: 'old-compressed.jpg', originalImageStoredAt: old, compressedImageStoredAt: old, createdAt: old },
      { id: 'exact', status: 'Completed', transactionId: '000128', amount: 50000, imageFileName: 'exactly-sixty.jpg', originalImageStoredAt: exactBoundary, createdAt: exactBoundary },
      { id: 'recent', status: 'Completed', transactionId: '000124', amount: 30000, imageFileName: 'recent.jpg', originalImageStoredAt: recent, createdAt: recent },
      { id: 'unknown', status: 'Completed', transactionId: '000125', amount: 35000, imageFileName: 'unknown.jpg', createdAt: 'not-a-date' },
      { id: 'pending', status: 'Processing', transactionId: null, amount: null, imageFileName: 'pending.jpg', createdAt: old },
      { id: 'shared-old', status: 'Completed', transactionId: '000126', amount: 40000, imageFileName: 'shared.jpg', createdAt: old },
      { id: 'shared-recent', status: 'Completed', transactionId: '000127', amount: 45000, imageFileName: 'shared.jpg', createdAt: recent },
    ];
    const beforeFinancialRows = JSON.stringify(receipts.map(({ id, transactionId, amount, status }) => ({ id, transactionId, amount, status })));

    const result = await runBankakImageRetention(receipts, bankakDir, now);

    assert.deepEqual(new Set(result.deletedFiles), new Set(['old-original.jpg', 'old-compressed.jpg', 'exactly-sixty.jpg']), 'only expired Bankak original/compressed images are deleted');
    assert.equal(await exists(path.join(bankakDir, 'exactly-sixty.jpg')), false, 'image at the exact 60-day boundary is eligible for deletion');
    assert.equal(await exists(path.join(bankakDir, 'recent.jpg')), true, 'image younger than 60 days is retained');
    assert.equal(await exists(path.join(bankakDir, 'unknown.jpg')), true, 'legacy image with unknown timestamp is retained');
    assert.equal(await exists(path.join(bankakDir, 'pending.jpg')), true, 'image required by active OCR is retained');
    assert.equal(await exists(path.join(bankakDir, 'shared.jpg')), true, 'shared image is retained while any linked receipt is not expired');
    assert.equal(await exists(path.join(supplierDir, 'supplier-payment-proof.jpg')), true, 'supplier payment receipt is never touched');
    assert.equal(JSON.stringify(receipts.map(({ id, transactionId, amount, status }) => ({ id, transactionId, amount, status }))), beforeFinancialRows, 'all Bankak financial and transaction records remain unchanged');
    assert.ok(result.preservedFiles.some((item) => item.fileName === 'unknown.jpg' && item.reason === 'unknown_timestamp'));
    assert.ok(result.preservedFiles.some((item) => item.fileName === 'pending.jpg' && item.reason === 'active_ocr'));
    console.log('BANKAK 60-DAY IMAGE RETENTION: PASS');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
