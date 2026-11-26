/**
 * Khalid Pharmacy — Google Drive appData Backup & Restore Integration (Phase C Complete)
 *
 * All pharmacy IndexedDB stores are snapshotted read-only with SHA-256 checksums and
 * lossless serialization, then uploaded directly to Google Drive's private `appDataFolder`
 * without requiring a backup password. OAuth tokens remain strictly in memory.
 */
import {
  canonicalJsonStringify,
  computeBackupChecksum,
  computeSha256,
  type KhalidPharmacyBackupV1,
} from './backupFormat.js';
import { bytesToBase64, type EncryptedBackupPackageV1 } from './backupEncryption.js';
import { serializeLossless } from './backupSerializer.js';
import {
  createRestoreSandbox,
  destroyRestoreSandbox,
  getRestoreSandboxSession,
  type RestoreSandboxSummary,
} from './restoreSandbox.js';
import { getActiveBranchId, getActiveBranchName, openPharmacyDB, LOCAL_FIRST_MUTATION_MUTEX_KEY, withLocalFirstMutationMutex, assertLocalFirstMutationMutexLeaseCurrent, type LocalFirstMutationMutexLease } from './pharmacyDb.js';
import { apiClient } from './apiClient.js';
import { googleDriveOAuthService } from './googleDriveOAuthService.js';

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const BACKUP_PREFIX = 'khalid-pharmacy-backup-';
const LAST_BACKUP_METADATA_KEY = 'google_drive_last_successful_backup';

export interface GoogleDriveBackupFile {
  id: string;
  name: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  mimeType?: string;
}

export interface GoogleDriveBackupResult {
  file: GoogleDriveBackupFile;
  createdAt: string;
  payloadBytes: number;
  storeCount: number;
  recordCount: number;
  skippedReceiptImagesCount?: number;
}

export interface DailyBackupResult {
  skipped: boolean;
  reason?: 'already_backed_up_today';
  result?: GoogleDriveBackupResult;
}

export interface RestorePreviewResult {
  sandboxId: string;
  summary: RestoreSandboxSummary;
  attachmentReceiptsCount: number;
  skippedReceiptImagesCount: number;
}

export interface ApplyRestoreResult {
  restoredStores: string[];
  totalRecords: number;
  backupCreatedAt?: string;
}

export interface LastBackupMetadata {
  key: string;
  date: string;
  fileId: string;
  fileName: string;
  createdAt: string;
  recordCount: number;
  storeCount: number;
  skippedReceiptImagesCount?: number;
}

type OAuthTokenProvider = Pick<typeof googleDriveOAuthService, 'getAccessToken'> & {
  handleUnauthorized?: () => void;
};

function parseDriveError(body: string, status: number, onUnauthorized?: () => void): Error {
  if (status === 401) {
    try {
      onUnauthorized?.();
    } catch {
      // ignore cleanup error
    }
    return new Error('انتهت صلاحية جلسة Google Drive (HTTP 401). أعد ربط الحساب وحاول مجدداً.');
  }
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.message;
    if (typeof message === 'string' && message.trim()) {
      return new Error(`Google Drive request failed (HTTP ${status}): ${message}`);
    }
  } catch {
    // Use the stable HTTP error below.
  }
  return new Error(`Google Drive request failed (HTTP ${status}).`);
}

function getConfiguredBackendUrl(): string {
  try {
    const raw = (import.meta as any)?.env?.VITE_BACKEND_API_URL;
    return typeof raw === 'string' ? raw.trim() : '';
  } catch {
    return '';
  }
}

export class GoogleDriveBackupService {
  constructor(
    private readonly tokenProvider: OAuthTokenProvider = googleDriveOAuthService,
    private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}

  private getAuthorizationHeaders(): Record<string, string> {
    const token = this.tokenProvider.getAccessToken();
    if (!token) {
      throw new Error('Google Drive is not connected or the access token has expired. Reconnect and retry.');
    }
    return { Authorization: `Bearer ${token}` };
  }

  /** Read-only, transaction-consistent snapshot of every current pharmacy DB store. */
  async createBackupSnapshot(now = new Date()): Promise<KhalidPharmacyBackupV1> {
    const db = await openPharmacyDB();
    const storeNames = Array.from(db.objectStoreNames);
    if (storeNames.length === 0) {
      throw new Error('Pharmacy database contains no stores; backup was not created.');
    }

    const recordsByStore = await new Promise<Record<string, any[]>>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(storeNames, 'readonly');
      } catch (error) {
        reject(error);
        return;
      }
      const snapshot: Record<string, any[]> = {};
      for (const storeName of storeNames) {
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => { snapshot[storeName] = request.result || []; };
        request.onerror = () => reject(request.error || new Error(`Failed to read store ${storeName}`));
      }
      tx.oncomplete = () => resolve(snapshot);
      tx.onerror = () => reject(tx.error || new Error('Pharmacy backup snapshot transaction failed.'));
      tx.onabort = () => reject(tx.error || new Error('Pharmacy backup snapshot transaction was aborted.'));
    });

    const payload: Record<string, any> = {};
    const stores = [];
    for (const storeName of storeNames) {
      const records = recordsByStore[storeName] || [];
      const encodedStore = serializeLossless(records);
      payload[storeName] = encodedStore;
      stores.push({
        storeName,
        recordCount: records.length,
        payloadChecksum: await computeSha256(canonicalJsonStringify(encodedStore)),
      });
    }

    // Bankak image binaries may live on the backend server filesystem or inline as data URLs.
    // On standalone Android without VITE_BACKEND_API_URL configured, avoid failing the whole
    // backup because remote `/api/bankak/images/...` routes are unreachable without a backend host.
    const receiptImages: Array<{
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      dataBase64: string;
      receiptIds: string[];
    }> = [];
    const skippedReceiptImages: Array<{
      fileName: string;
      receiptIds: string[];
      skippedReason: 'no_android_backend_configured' | 'image_http_404' | 'image_fetch_failed' | 'image_empty';
    }> = [];
    const imagesByName = new Map<string, typeof receiptImages[number]>();
    const skippedByName = new Map<string, typeof skippedReceiptImages[number]>();
    const isNativeStandalone = apiClient.isNative() && !getConfiguredBackendUrl();

    for (const receipt of recordsByStore.receipts || []) {
      const fileName = typeof receipt?.imageFileName === 'string' ? receipt.imageFileName.trim() : '';
      if (!fileName) continue;

      const existing = imagesByName.get(fileName);
      if (existing) {
        if (typeof receipt.id === 'string') existing.receiptIds.push(receipt.id);
        continue;
      }

      const inlineDataUrl = [receipt?.imageDataUrl, receipt?.imageUrl, receipt?.imageBase64]
        .find((candidate) => typeof candidate === 'string' && candidate.startsWith('data:')) as string | undefined;

      if (inlineDataUrl) {
        const commaIndex = inlineDataUrl.indexOf(',');
        if (commaIndex > 0) {
          const metaPart = inlineDataUrl.slice(5, commaIndex);
          const mimeType = metaPart.split(';')[0] || receipt?.mimeType || 'image/jpeg';
          const base64Body = inlineDataUrl.slice(commaIndex + 1).trim();
          if (base64Body) {
            const estimatedBytes = Math.floor((base64Body.length * 3) / 4);
            const entry = {
              fileName,
              mimeType,
              sizeBytes: estimatedBytes,
              dataBase64: base64Body,
              receiptIds: typeof receipt.id === 'string' ? [receipt.id] : [],
            };
            imagesByName.set(fileName, entry);
            receiptImages.push(entry);
            continue;
          }
        }
      }

      if (isNativeStandalone) {
        const existingSkipped = skippedByName.get(fileName);
        if (existingSkipped) {
          if (typeof receipt.id === 'string') existingSkipped.receiptIds.push(receipt.id);
        } else {
          const skippedEntry = {
            fileName,
            receiptIds: typeof receipt.id === 'string' ? [receipt.id] : [],
            skippedReason: 'no_android_backend_configured' as const,
          };
          skippedByName.set(fileName, skippedEntry);
          skippedReceiptImages.push(skippedEntry);
        }
        continue;
      }

      // Resolve only the known same-backend image route; never fetch a receipt-provided
      // arbitrary URL from the local database during backup.
      const imagePath = `/api/bankak/images/${encodeURIComponent(fileName)}`;
      const imageUrl = apiClient.resolveImageUrl(imagePath);
      let response: Response;
      try {
        response = await this.fetcher(imageUrl);
      } catch {
        const existingSkipped = skippedByName.get(fileName);
        if (existingSkipped) {
          if (typeof receipt.id === 'string') existingSkipped.receiptIds.push(receipt.id);
        } else {
          const skippedEntry = {
            fileName,
            receiptIds: typeof receipt.id === 'string' ? [receipt.id] : [],
            skippedReason: 'image_fetch_failed' as const,
          };
          skippedByName.set(fileName, skippedEntry);
          skippedReceiptImages.push(skippedEntry);
        }
        continue;
      }

      if (!response.ok) {
        const existingSkipped = skippedByName.get(fileName);
        if (existingSkipped) {
          if (typeof receipt.id === 'string') existingSkipped.receiptIds.push(receipt.id);
        } else {
          const skippedEntry = {
            fileName,
            receiptIds: typeof receipt.id === 'string' ? [receipt.id] : [],
            skippedReason: response.status === 404 ? ('image_http_404' as const) : ('image_fetch_failed' as const),
          };
          skippedByName.set(fileName, skippedEntry);
          skippedReceiptImages.push(skippedEntry);
        }
        continue;
      }

      const mimeType = response.headers.get('content-type') || receipt.mimeType || 'application/octet-stream';
      const imageBytes = new Uint8Array(await response.arrayBuffer());
      if (imageBytes.byteLength === 0) {
        const existingSkipped = skippedByName.get(fileName);
        if (existingSkipped) {
          if (typeof receipt.id === 'string') existingSkipped.receiptIds.push(receipt.id);
        } else {
          const skippedEntry = {
            fileName,
            receiptIds: typeof receipt.id === 'string' ? [receipt.id] : [],
            skippedReason: 'image_empty' as const,
          };
          skippedByName.set(fileName, skippedEntry);
          skippedReceiptImages.push(skippedEntry);
        }
        continue;
      }

      const imageEntry = {
        fileName,
        mimeType,
        sizeBytes: imageBytes.byteLength,
        dataBase64: bytesToBase64(imageBytes),
        receiptIds: typeof receipt.id === 'string' ? [receipt.id] : [],
      };
      imagesByName.set(fileName, imageEntry);
      receiptImages.push(imageEntry);
    }

    payload.__attachments = {
      version: 1,
      bankakReceiptImages: receiptImages,
      ...(skippedReceiptImages.length > 0 ? { skippedBankakReceiptImages: skippedReceiptImages } : {}),
    };

    const activeBranchId = getActiveBranchId();
    const activeBranchName = getActiveBranchName();
    const header = {
      version: '1.0' as const,
      appId: 'com.khalidpharmacy.app' as const,
      format: 'KP_BACKUP_V1' as const,
      createdAt: now.toISOString(),
      generator: 'Khalid Pharmacy Google Drive Backup',
      ...(activeBranchId ? { branchId: activeBranchId } : {}),
      ...(activeBranchName ? { branchName: activeBranchName } : {}),
    };
    const backupWithoutChecksum = {
      header,
      schema: { dbVersion: db.version, stores },
      payload,
    };
    return {
      ...backupWithoutChecksum,
      checksum: await computeBackupChecksum(backupWithoutChecksum),
    };
  }

  async prepareBackupPackage(now = new Date()): Promise<{
    package: KhalidPharmacyBackupV1;
    createdAt: string;
    storeCount: number;
    recordCount: number;
    skippedReceiptImagesCount: number;
  }> {
    const backup = await this.createBackupSnapshot(now);
    const recordCount = backup.schema.stores.reduce((sum, store) => sum + store.recordCount, 0);
    const skipped = Array.isArray(backup.payload?.__attachments?.skippedBankakReceiptImages)
      ? backup.payload.__attachments.skippedBankakReceiptImages.length
      : 0;
    return {
      package: backup,
      createdAt: now.toISOString(),
      storeCount: backup.schema.stores.length,
      recordCount,
      skippedReceiptImagesCount: skipped,
    };
  }

  async listBackups(): Promise<GoogleDriveBackupFile[]> {
    const headers = this.getAuthorizationHeaders();
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `trashed = false and name contains '${BACKUP_PREFIX}'`,
      orderBy: 'createdTime desc',
      pageSize: '100',
      fields: 'files(id,name,createdTime,modifiedTime,size,mimeType)',
    });
    const response = await this.fetcher(`${DRIVE_FILES_URL}?${params.toString()}`, { headers });
    if (!response.ok) {
      throw parseDriveError(await response.text(), response.status, () => this.tokenProvider.handleUnauthorized?.());
    }
    const body = await response.json() as { files?: GoogleDriveBackupFile[] };
    return Array.isArray(body.files) ? body.files : [];
  }

  async uploadBackup(now = new Date()): Promise<GoogleDriveBackupResult> {
    const prepared = await this.prepareBackupPackage(now);
    const fileName = `${BACKUP_PREFIX}${now.toISOString().replace(/[:.]/g, '-')}.json`;
    const metadata = {
      name: fileName,
      mimeType: 'application/json',
      parents: ['appDataFolder'],
      description: 'Khalid Pharmacy verified full database backup (appDataFolder). Do not delete.',
    };
    const boundary = `khalid_pharmacy_${crypto.randomUUID().replace(/-/g, '')}`;
    const multipartBody = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(prepared.package),
      `\r\n--${boundary}--`,
    ]);
    const headers = {
      ...this.getAuthorizationHeaders(),
      'Content-Type': `multipart/related; boundary=${boundary}`,
    };
    const response = await this.fetcher(
      `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,name,createdTime,modifiedTime,size,mimeType`,
      { method: 'POST', headers, body: multipartBody },
    );
    if (!response.ok) {
      throw parseDriveError(await response.text(), response.status, () => this.tokenProvider.handleUnauthorized?.());
    }
    const file = await response.json() as GoogleDriveBackupFile;
    if (!file.id || !file.name) {
      throw new Error('Google Drive upload returned an incomplete file record; backup success was not recorded.');
    }
    return {
      file,
      createdAt: prepared.createdAt,
      payloadBytes: multipartBody.size,
      storeCount: prepared.storeCount,
      recordCount: prepared.recordCount,
      skippedReceiptImagesCount: prepared.skippedReceiptImagesCount,
    };
  }

  async downloadBackup(fileId: string): Promise<KhalidPharmacyBackupV1 | EncryptedBackupPackageV1> {
    if (typeof fileId !== 'string' || !fileId.trim() || fileId.length > 512) {
      throw new Error('Invalid Google Drive backup file ID.');
    }
    const headers = this.getAuthorizationHeaders();
    const response = await this.fetcher(
      `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`,
      { headers },
    );
    if (!response.ok) {
      throw parseDriveError(await response.text(), response.status, () => this.tokenProvider.handleUnauthorized?.());
    }
    const value = await response.json() as any;
    const isStandardPackage = value && typeof value === 'object' && value.header?.format === 'KP_BACKUP_V1' && value.payload;
    const isLegacyEncryptedPackage = value && typeof value === 'object' && value.header && value.ciphertext;
    if (!isStandardPackage && !isLegacyEncryptedPackage) {
      throw new Error('Downloaded Google Drive file is not a valid Khalid Pharmacy backup package.');
    }
    return value;
  }

  /**
   * Downloads and verifies a backup inside the isolated sandbox before any write to production IndexedDB.
   * Passwordless KP_BACKUP_V1 files open directly; legacy encrypted files require their original passphrase.
   */
  async previewRestoreFromDrive(fileId: string, legacyPassword?: string): Promise<RestorePreviewResult> {
    const downloaded = await this.downloadBackup(fileId);
    const sandbox = createRestoreSandbox();
    try {
      let summary: RestoreSandboxSummary;
      let attachmentReceiptsCount = 0;
      let skippedReceiptImagesCount = 0;

      if ('ciphertext' in downloaded && downloaded.ciphertext) {
        if (!legacyPassword || !legacyPassword.trim()) {
          throw new Error('هذه النسخة الاحتياطية قديمة ومحمية بكلمة مرور، بينما النسخ الحديثة لا تستخدم كلمة مرور.');
        }
        summary = await sandbox.loadEncryptedBackup(downloaded, legacyPassword);
      } else {
        const standardPkg = downloaded as KhalidPharmacyBackupV1;
        summary = await sandbox.loadBackupPackage(standardPkg);
        const attachments = standardPkg.payload?.__attachments;
        attachmentReceiptsCount = Array.isArray(attachments?.bankakReceiptImages) ? attachments.bankakReceiptImages.length : 0;
        skippedReceiptImagesCount = Array.isArray(attachments?.skippedBankakReceiptImages)
          ? attachments.skippedBankakReceiptImages.length
          : 0;
      }

      return {
        sandboxId: summary.sandboxId,
        summary,
        attachmentReceiptsCount,
        skippedReceiptImagesCount,
      };
    } catch (error) {
      destroyRestoreSandbox(sandbox.sandboxId);
      throw error;
    }
  }

  /**
   * Commits a verified, loaded restore sandbox atomically into production IndexedDB stores
   * and closes the sandbox once committed.
   */
  async applyRestoreSandbox(sandboxId: string): Promise<ApplyRestoreResult> {
    return withLocalFirstMutationMutex('BACKUP_RESTORE', async (mutexLease) => {
      await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);
      return this.applyRestoreSandboxUnderMutex(sandboxId, mutexLease);
    });
  }

  private async applyRestoreSandboxUnderMutex(
    sandboxId: string,
    mutexLease: LocalFirstMutationMutexLease
  ): Promise<ApplyRestoreResult> {
    const sandbox = getRestoreSandboxSession(sandboxId);
    if (!sandbox || sandbox.getStatus() !== 'loaded') {
      throw new Error('Restore session is closed or no verified backup is loaded. Re-preview the backup first.');
    }

    const summary = sandbox.inspectSummary();
    const currentBranchId = getActiveBranchId();
    const backupBranchId = summary.header?.branchId;
    if (backupBranchId && currentBranchId && backupBranchId !== currentBranchId) {
      throw new Error(
        `لا يمكن استعادة نسخة الفرع (${backupBranchId}) داخل الفرع الحالي (${currentBranchId}). بدّل إلى الفرع الصحيح أولاً.`
      );
    }

    const db = await openPharmacyDB();
    const existingStoreNames = new Set(Array.from(db.objectStoreNames));
    const restorableStores = sandbox.getStoreNames().filter((name) => existingStoreNames.has(name));

    if (restorableStores.length === 0) {
      throw new Error('The verified backup does not match any active pharmacy database stores.');
    }

    // Clone all verified records out of the sandbox before initiating any write transaction.
    const recordsByStore = new Map<string, any[]>();
    let totalRecords = 0;
    for (const storeName of restorableStores) {
      const records = sandbox.getStoreRecords<any>(storeName);
      recordsByStore.set(storeName, records);
      totalRecords += records.length;
    }

    await assertLocalFirstMutationMutexLeaseCurrent(mutexLease);

    await new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(restorableStores, 'readwrite');
      } catch (error) {
        reject(error);
        return;
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to write restored records to IndexedDB.'));
      tx.onabort = () => reject(tx.error || new Error('Database restore transaction was aborted; no changes saved.'));

      const abortRestore = (error: unknown) => {
        try {
          tx.abort();
        } catch {
          // The transaction may already be inactive.
        }
        reject(error instanceof Error ? error : new Error(String(error || 'Restore metadata protection failed.')));
      };

      const commitRecords = (protectedMetadataRecords: any[]) => {
        try {
          for (const storeName of restorableStores) {
            const store = tx.objectStore(storeName);
            store.clear();
            const records = recordsByStore.get(storeName) || [];
            if (storeName === 'metadata') {
              // Keep current quarantine and recovery audit evidence even when the
              // selected backup predates it. Current records win on key collision.
              const mergedByKey = new Map<string, any>();
              for (const record of records) {
                if (!record || typeof record.key !== 'string' || !record.key) {
                  throw new Error('RESTORE_METADATA_INVALID_KEY: Backup metadata contains a record without a valid key.');
                }
                mergedByKey.set(record.key, record);
              }
              for (const record of protectedMetadataRecords) {
                if (!record || typeof record.key !== 'string' || !record.key) {
                  throw new Error('RESTORE_PROTECTED_METADATA_INVALID: Current protected metadata has an invalid key.');
                }
                mergedByKey.set(record.key, record);
              }
              for (const record of mergedByKey.values()) store.put(record);
            } else {
              for (const record of records) store.put(record);
            }
          }
        } catch (writeErr) {
          abortRestore(writeErr);
        }
      };

      if (restorableStores.includes('metadata')) {
        const metadataStore = tx.objectStore('metadata');
        const metadataReq = metadataStore.getAll();
        metadataReq.onsuccess = () => {
          try {
            const protectedRecords = (Array.isArray(metadataReq.result) ? metadataReq.result : []).filter(
              (record: any) =>
                record &&
                typeof record.key === 'string' &&
                (record.key.startsWith('unit_migration_v2:quarantine:') ||
                  record.key.startsWith('unit_migration_v2:recovery_audit:') ||
                  record.key.startsWith('unit_migration_v2:medicine_fingerprint:') ||
                  record.key === 'unit_migration_v2:checkpoint' ||
                  record.key === 'unit_migration_v2:baseline_digest' ||
                  record.key === LOCAL_FIRST_MUTATION_MUTEX_KEY)
            );
            commitRecords(protectedRecords);
          } catch (readErr) {
            abortRestore(readErr);
          }
        };
        metadataReq.onerror = () =>
          abortRestore(metadataReq.error || new Error('RESTORE_PROTECTED_METADATA_READ_FAILED'));
      } else {
        commitRecords([]);
      }
    });

    destroyRestoreSandbox(sandboxId);
    return {
      restoredStores: restorableStores,
      totalRecords,
      backupCreatedAt: summary.header?.createdAt,
    };
  }

  closeRestorePreview(sandboxId: string): void {
    destroyRestoreSandbox(sandboxId);
  }

  async getLastBackupMetadata(): Promise<LastBackupMetadata | null> {
    const db = await openPharmacyDB();
    return new Promise<LastBackupMetadata | null>((resolve, reject) => {
      const tx = db.transaction('metadata', 'readonly');
      const request = tx.objectStore('metadata').get(LAST_BACKUP_METADATA_KEY);
      request.onsuccess = () => resolve((request.result as LastBackupMetadata) || null);
      request.onerror = () => reject(request.error || new Error('Could not read backup schedule metadata.'));
      tx.onabort = () => reject(tx.error || new Error('Backup schedule metadata read aborted.'));
    });
  }

  /**
   * Runs a backup to Google Drive. Unless `options.force` is true, limits uploads
   * to at most once per local calendar day.
   */
  async runDailyBackupIfDue(now = new Date(), options: { force?: boolean } = {}): Promise<DailyBackupResult> {
    const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    if (!options.force) {
      const previous = await this.getLastBackupMetadata();
      if (previous?.date === today && typeof previous?.fileId === 'string' && previous.fileId) {
        return { skipped: true, reason: 'already_backed_up_today' };
      }
    }

    const result = await this.uploadBackup(now);
    const db = await openPharmacyDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('metadata', 'readwrite');
      tx.objectStore('metadata').put({
        key: LAST_BACKUP_METADATA_KEY,
        date: today,
        fileId: result.file.id,
        fileName: result.file.name,
        createdAt: result.createdAt,
        recordCount: result.recordCount,
        storeCount: result.storeCount,
        skippedReceiptImagesCount: result.skippedReceiptImagesCount || 0,
      } satisfies LastBackupMetadata);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not save successful backup metadata.'));
      tx.onabort = () => reject(tx.error || new Error('Backup schedule metadata write aborted.'));
    });
    return { skipped: false, result };
  }
}

export const googleDriveBackupService = new GoogleDriveBackupService();
