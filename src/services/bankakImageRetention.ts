import fs from 'node:fs';
import path from 'node:path';

export const BANKAK_IMAGE_RETENTION_DAYS = 60;
export const BANKAK_IMAGE_RETENTION_MS = BANKAK_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface BankakImageRetentionReceipt {
  id?: unknown;
  status?: unknown;
  imageFileName?: unknown;
  compressedFileName?: unknown;
  originalImageStoredAt?: unknown;
  compressedImageStoredAt?: unknown;
  createdAt?: unknown;
}

export interface BankakImageRetentionResult {
  scannedReferences: number;
  deletedFiles: string[];
  preservedFiles: Array<{ fileName: string; reason: 'recent' | 'unknown_timestamp' | 'active_ocr' | 'unsafe_name' | 'not_regular_file' | 'delete_failed' }>;
}

/**
 * Deletes only Bankak image files explicitly referenced by the Bankak receipt store.
 * It never mutates receipt rows, transaction IDs, amounts, or accounting records.
 * Legacy rows may use createdAt only when it is a valid timestamp; unknown dates fail closed.
 */
export async function runBankakImageRetention(
  receipts: readonly BankakImageRetentionReceipt[],
  receiptsDirectory: string,
  now: Date = new Date(),
): Promise<BankakImageRetentionResult> {
  if (!Array.isArray(receipts)) throw new Error('Bankak retention requires a receipt array.');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Bankak retention requires a valid reference date.');

  const root = path.resolve(receiptsDirectory);
  const references = new Map<string, Array<{ timestamp: number | null; active: boolean }>>();
  let scannedReferences = 0;

  const addReference = (candidate: unknown, explicitTimestamp: unknown, fallbackTimestamp: unknown, active: boolean) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    scannedReferences++;
    const fileName = candidate.trim();
    const current = references.get(fileName) || [];
    const rawTimestamp = typeof explicitTimestamp === 'string' ? explicitTimestamp : fallbackTimestamp;
    const parsedTimestamp = typeof rawTimestamp === 'string' ? Date.parse(rawTimestamp) : Number.NaN;
    current.push({ timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : null, active });
    references.set(fileName, current);
  };

  for (const receipt of receipts) {
    const active = receipt.status === 'Pending' || receipt.status === 'Processing';
    addReference(receipt.imageFileName, receipt.originalImageStoredAt, receipt.createdAt, active);
    addReference(receipt.compressedFileName, receipt.compressedImageStoredAt, receipt.createdAt, active);
  }

  const deletedFiles: string[] = [];
  const preservedFiles: BankakImageRetentionResult['preservedFiles'] = [];

  for (const [fileName, owners] of references) {
    if (path.basename(fileName) !== fileName || fileName === '.' || fileName === '..' || fileName.includes('\\0')) {
      preservedFiles.push({ fileName, reason: 'unsafe_name' });
      continue;
    }
    if (owners.some((owner) => owner.active)) {
      preservedFiles.push({ fileName, reason: 'active_ocr' });
      continue;
    }
    if (owners.some((owner) => owner.timestamp === null)) {
      preservedFiles.push({ fileName, reason: 'unknown_timestamp' });
      continue;
    }
    if (owners.some((owner) => now.getTime() - (owner.timestamp as number) < BANKAK_IMAGE_RETENTION_MS)) {
      preservedFiles.push({ fileName, reason: 'recent' });
      continue;
    }

    const target = path.resolve(root, fileName);
    if (path.dirname(target) !== root) {
      preservedFiles.push({ fileName, reason: 'unsafe_name' });
      continue;
    }

    try {
      const stat = await fs.promises.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        preservedFiles.push({ fileName, reason: 'not_regular_file' });
        continue;
      }
      await fs.promises.unlink(target);
      deletedFiles.push(fileName);
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
      preservedFiles.push({ fileName, reason: 'delete_failed' });
    }
  }

  return { scannedReferences, deletedFiles, preservedFiles };
}
