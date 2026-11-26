/**
 * Khalid Pharmacy Management System - Isolated Restore Sandbox Engine (P0.2.3-R1)
 * Specification: Isolated In-Memory Backup Inspection, Decryption & Schema Audit.
 *
 * Security Mandates & Hardening:
 * 1. ZERO Production DB Touch: Completely isolated in-memory sandbox sessions. Never connects to, reads from, writes to, or modifies IndexedDB production stores.
 * 2. Lossless Deep Clone Isolation: getStoreRecords uses P0.2.1 Lossless Serializer/Deserializer to preserve Date, BigInt, Map, Set, TypedArray, DataView, ArrayBuffer, RegExp, undefined, sparse arrays, and circular references.
 * 3. Race Condition & Cancellation Guard: Monotonic sessionToken prevents async decryption completions from re-opening or populating closed sessions.
 * 4. Safe Memory Cleanup & Zeroing: Closing a sandbox instance zero-fills ArrayBuffers/TypedArrays and purges all restored records from virtual memory.
 * 5. Strict Manifest & Checksum Validation: Validates store manifest schema, rejects duplicate stores, checks record counts, and verifies individual store payload checksums.
 * 6. Zero Secret Disclosure: Passwords, raw encryption keys, and sensitive medical data are never logged or stored in instance properties.
 */

import {
  KhalidPharmacyBackupV1,
  BackupHeader,
  SchemaManifest,
  StoreManifest,
  verifyBackupChecksum,
  canonicalJsonStringify,
  computeSha256,
} from './backupFormat.js';

import {
  deserializeLossless,
  serializeLossless,
  DeserializerLimits,
  EnvelopeNode,
} from './backupSerializer.js';

import {
  decryptBackup,
  EncryptedBackupPackageV1,
  EncryptionLimits,
} from './backupEncryption.js';

export type SandboxStatus = 'initialized' | 'loaded' | 'closed';

export interface RestoreSandboxOptions {
  limits?: EncryptionLimits & DeserializerLimits;
  verifyChecksumFn?: (backup: KhalidPharmacyBackupV1) => Promise<boolean>;
}

export interface StoreSummary {
  storeName: string;
  recordCount: number;
  payloadChecksum: string;
}

export interface RestoreSandboxSummary {
  sandboxId: string;
  status: SandboxStatus;
  createdAt: string;
  loadedAt?: string;
  header?: BackupHeader;
  schema?: SchemaManifest;
  totalStores: number;
  totalRecords: number;
  stores: StoreSummary[];
}

export class RestoreSandboxSession {
  public readonly sandboxId: string;
  public readonly createdAt: string;
  private status: SandboxStatus = 'initialized';
  private loadedAt?: string;
  private header?: BackupHeader;
  private schema?: SchemaManifest;
  private storesMap: Map<string, any[]> = new Map();

  /** Monotonic generation counter to prevent race conditions when close() is called during async operations */
  private sessionToken: number = 0;

  constructor(sandboxId: string) {
    this.sandboxId = sandboxId;
    this.createdAt = new Date().toISOString();
  }

  public getStatus(): SandboxStatus {
    return this.status;
  }

  private ensureActive(): void {
    if (this.status === 'closed') {
      throw new Error(`Restore Sandbox Error: Sandbox session '${this.sandboxId}' is closed or invalid`);
    }
  }

  /**
   * Verifies and loads a passwordless KP_BACKUP_V1 package into this isolated sandbox session.
   * Atomic operation: If any step fails or session is closed mid-operation, no partial data is retained.
   */
  public async loadBackupPackage(
    backupInput: KhalidPharmacyBackupV1 | string,
    options: RestoreSandboxOptions = {}
  ): Promise<RestoreSandboxSummary> {
    this.ensureActive();
    const currentToken = this.sessionToken;

    let backupObj: any;
    if (typeof backupInput === 'string') {
      try {
        backupObj = JSON.parse(backupInput);
      } catch {
        throw new Error('Restore Sandbox Error: Backup payload is not valid JSON string');
      }
    } else {
      backupObj = backupInput;
    }

    return this._loadVerifiedBackupObject(backupObj, currentToken, options);
  }

  /**
   * Decrypts, verifies, and deserializes an encrypted backup package into this isolated sandbox session.
   * Atomic operation: If any step fails or session is closed mid-operation, no partial data is retained.
   */
  public async loadEncryptedBackup(
    encryptedInput: EncryptedBackupPackageV1 | string,
    password: string,
    options: RestoreSandboxOptions = {}
  ): Promise<RestoreSandboxSummary> {
    this.ensureActive();
    const currentToken = this.sessionToken;

    const checkCancellation = () => {
      if (this.status === 'closed' || this.sessionToken !== currentToken) {
        throw new Error(
          `Restore Sandbox Error: Sandbox session '${this.sandboxId}' was closed or invalidated during operation`
        );
      }
    };

    try {
      // 1. Decrypt using P0.2.2 Web Crypto engine
      let decryptedJsonString: string;
      try {
        decryptedJsonString = await decryptBackup(encryptedInput, password, { limits: options.limits });
      } catch (err: any) {
        checkCancellation();
        throw new Error(`Restore Sandbox Error: Decryption failed. ${err?.message || 'Invalid password or tampered backup.'}`);
      }

      checkCancellation();

      // 2. Parse JSON
      let backupObj: any;
      try {
        backupObj = JSON.parse(decryptedJsonString);
      } catch {
        checkCancellation();
        throw new Error('Restore Sandbox Error: Decrypted payload is not valid JSON string');
      }

      checkCancellation();

      return await this._loadVerifiedBackupObject(backupObj, currentToken, options);
    } catch (err) {
      if (this.sessionToken !== currentToken || this.status === 'closed') {
        this.status = 'closed';
        activeSandboxSessions.delete(this.sandboxId);
      }
      throw err;
    }
  }

  private async _loadVerifiedBackupObject(
    backupObj: any,
    currentToken: number,
    options: RestoreSandboxOptions = {}
  ): Promise<RestoreSandboxSummary> {
    const checkCancellation = () => {
      if (this.status === 'closed' || this.sessionToken !== currentToken) {
        throw new Error(
          `Restore Sandbox Error: Sandbox session '${this.sandboxId}' was closed or invalidated during operation`
        );
      }
    };

    const tempStoresMap = new Map<string, any[]>();

    try {
      checkCancellation();

      // 3. Structure & Envelope Validation
      if (!backupObj || typeof backupObj !== 'object') {
        throw new Error('Restore Sandbox Error: Invalid backup structure. Expected JSON object');
      }

      if (!backupObj.header || typeof backupObj.header !== 'object') {
        throw new Error('Restore Sandbox Error: Backup header is missing or malformed');
      }

      if (backupObj.header.format !== 'KP_BACKUP_V1') {
        throw new Error(`Restore Sandbox Error: Unsupported backup format '${backupObj.header.format}'. Expected 'KP_BACKUP_V1'`);
      }

      if (backupObj.header.version !== '1.0') {
        throw new Error(`Restore Sandbox Error: Unsupported backup version '${backupObj.header.version}'. Expected '1.0'`);
      }

      if (backupObj.header.appId !== 'com.khalidpharmacy.app') {
        throw new Error(`Restore Sandbox Error: Invalid application ID '${backupObj.header.appId}'. Expected 'com.khalidpharmacy.app'`);
      }

      if (!backupObj.schema || typeof backupObj.schema !== 'object' || !Array.isArray(backupObj.schema.stores)) {
        throw new Error('Restore Sandbox Error: Backup schema manifest is missing or invalid');
      }

      if (typeof backupObj.checksum !== 'string' || backupObj.checksum.length === 0) {
        throw new Error('Restore Sandbox Error: Backup checksum is missing');
      }

      // Validate Schema Stores Manifest for duplicate storeNames and invalid fields
      const seenStoreNames = new Set<string>();
      const storesList: StoreManifest[] = backupObj.schema.stores;

      for (const sm of storesList) {
        if (!sm || typeof sm !== 'object') {
          throw new Error('Restore Sandbox Error: Malformed store manifest item in schema');
        }
        if (typeof sm.storeName !== 'string' || sm.storeName.trim().length === 0) {
          throw new Error('Restore Sandbox Error: Store manifest missing valid storeName');
        }
        if (seenStoreNames.has(sm.storeName)) {
          throw new Error(`Restore Sandbox Error: Duplicate storeName '${sm.storeName}' in schema manifest`);
        }
        seenStoreNames.add(sm.storeName);

        if (typeof sm.recordCount !== 'number' || !Number.isInteger(sm.recordCount) || sm.recordCount < 0) {
          throw new Error(`Restore Sandbox Error: Invalid recordCount for store '${sm.storeName}' in schema manifest`);
        }

        if (sm.payloadChecksum !== undefined && typeof sm.payloadChecksum !== 'string') {
          throw new Error(`Restore Sandbox Error: Invalid payloadChecksum for store '${sm.storeName}' in schema manifest`);
        }
      }

      // 4. Verify Full Backup Checksum using P0.2.1 verifyBackupChecksum (or custom verifyChecksumFn hook)
      const verifyFn = options.verifyChecksumFn || verifyBackupChecksum;
      const isChecksumValid = await verifyFn(backupObj as KhalidPharmacyBackupV1);
      checkCancellation();

      if (!isChecksumValid) {
        throw new Error('Restore Sandbox Error: Backup checksum verification failed. Package has been tampered with or corrupted.');
      }

      // 5. Atomic Deserialization of Stores into temporary map
      for (const storeManifest of storesList) {
        checkCancellation();
        const storeName = storeManifest.storeName;
        const rawStorePayload = backupObj.payload ? backupObj.payload[storeName] : undefined;

        if (rawStorePayload === undefined) {
          throw new Error(`Restore Sandbox Error: Store '${storeName}' listed in schema is missing from payload`);
        }

        // Validate individual store payload checksum if provided in store manifest
        if (storeManifest.payloadChecksum && storeManifest.payloadChecksum.trim().length > 0) {
          const canonicalStoreStr = canonicalJsonStringify(rawStorePayload);
          const computedStoreHash = await computeSha256(canonicalStoreStr);
          checkCancellation();
          if (computedStoreHash.toLowerCase() !== storeManifest.payloadChecksum.trim().toLowerCase()) {
            throw new Error(`Restore Sandbox Error: Payload checksum mismatch for store '${storeName}'`);
          }
        }

        let restoredRecords: any[];
        if (
          typeof rawStorePayload === 'object' &&
          rawStorePayload !== null &&
          'rootRef' in rawStorePayload &&
          'nodes' in rawStorePayload
        ) {
          // Deserializes using P0.2.1 ThreePassDeserializer
          try {
            const deserializedGraph = deserializeLossless(
              rawStorePayload.rootRef,
              rawStorePayload.nodes as EnvelopeNode[],
              options.limits
            );
            restoredRecords = Array.isArray(deserializedGraph) ? deserializedGraph : [deserializedGraph];
          } catch (deserr: any) {
            throw new Error(`Restore Sandbox Error: Deserialization failed for store '${storeName}'. ${deserr?.message || ''}`);
          }
        } else if (Array.isArray(rawStorePayload)) {
          restoredRecords = rawStorePayload;
        } else {
          restoredRecords = [rawStorePayload];
        }

        // Check record count matching schema manifest
        if (restoredRecords.length !== storeManifest.recordCount) {
          throw new Error(
            `Restore Sandbox Error: Record count mismatch for store '${storeName}'. Manifest expects ${storeManifest.recordCount}, restored ${restoredRecords.length}`
          );
        }

        tempStoresMap.set(storeName, restoredRecords);
      }

      checkCancellation();

      // 6. Commit to Sandbox Instance State (Atomic)
      if (this.storesMap && this.storesMap.size > 0) {
        this.zeroOutMap(this.storesMap);
        this.storesMap.clear();
      }
      this.storesMap = tempStoresMap;
      this.header = backupObj.header;
      this.schema = backupObj.schema;
      this.status = 'loaded';
      this.loadedAt = new Date().toISOString();

      return this.inspectSummary();
    } catch (err) {
      // Best-effort zeroing and cleanup of uncommitted temporary data
      this.zeroOutMap(tempStoresMap);
      tempStoresMap.clear();

      // If the session was closed during execution, ensure status stays closed and registry is clean
      if (this.sessionToken !== currentToken || this.status === 'closed') {
        this.status = 'closed';
        activeSandboxSessions.delete(this.sandboxId);
      }
      throw err;
    }
  }

  public getStoreNames(): string[] {
    this.ensureActive();
    return Array.from(this.storesMap.keys());
  }

  /**
   * Returns a Lossless Deep Clone of records in the specified store.
   * Preserves Date, BigInt, Map, Set, TypedArray, DataView, ArrayBuffer, RegExp, undefined, sparse arrays, and circular references.
   */
  public getStoreRecords<T = any>(storeName: string): T[] {
    this.ensureActive();
    const records = this.storesMap.get(storeName);
    if (!records) {
      throw new Error(`Restore Sandbox Error: Store '${storeName}' does not exist in this sandbox session`);
    }

    // Lossless deep clone via P0.2.1 Serializer/Deserializer engine
    const serialized = serializeLossless(records);
    const cloned = deserializeLossless(serialized.rootRef, serialized.nodes);
    return cloned as T[];
  }

  public getRecordCount(storeName?: string): number {
    this.ensureActive();
    if (storeName) {
      const records = this.storesMap.get(storeName);
      return records ? records.length : 0;
    }
    let total = 0;
    for (const arr of this.storesMap.values()) {
      total += arr.length;
    }
    return total;
  }

  public inspectSummary(): RestoreSandboxSummary {
    this.ensureActive();
    const storesSummary: StoreSummary[] = [];
    let totalRecords = 0;

    if (this.schema && this.schema.stores) {
      for (const sm of this.schema.stores) {
        const records = this.storesMap.get(sm.storeName) || [];
        storesSummary.push({
          storeName: sm.storeName,
          recordCount: records.length,
          payloadChecksum: sm.payloadChecksum || '',
        });
        totalRecords += records.length;
      }
    } else {
      for (const [sName, records] of this.storesMap.entries()) {
        storesSummary.push({
          storeName: sName,
          recordCount: records.length,
          payloadChecksum: '',
        });
        totalRecords += records.length;
      }
    }

    return {
      sandboxId: this.sandboxId,
      status: this.status,
      createdAt: this.createdAt,
      loadedAt: this.loadedAt,
      header: this.header,
      schema: this.schema,
      totalStores: storesSummary.length,
      totalRecords,
      stores: storesSummary,
    };
  }

  /**
   * Safely closes the sandbox session, zeroes out binary typed buffers, and purges all restored records from memory.
   */
  public close(): void {
    if (this.status === 'closed') return;
    this.sessionToken++; // Invalidate any pending in-flight async operations
    this.zeroOutMap(this.storesMap);
    this.storesMap.clear();
    this.header = undefined;
    this.schema = undefined;
    this.status = 'closed';
    activeSandboxSessions.delete(this.sandboxId);
  }

  /**
   * Best-effort zeroing of ArrayBuffers and TypedArrays in store records prior to memory release.
   */
  private zeroOutMap(mapToZero: Map<string, any[]>): void {
    for (const storeRecords of mapToZero.values()) {
      if (Array.isArray(storeRecords)) {
        for (const record of storeRecords) {
          this.zeroOutValue(record, new Set());
        }
      }
    }
  }

  private zeroOutValue(val: any, visited: Set<any>): void {
    if (!val || typeof val !== 'object' || visited.has(val)) return;
    visited.add(val);

    if (val instanceof ArrayBuffer) {
      try {
        new Uint8Array(val).fill(0);
      } catch {}
      return;
    }

    if (ArrayBuffer.isView(val)) {
      try {
        const view = new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
        view.fill(0);
      } catch {}
      return;
    }

    if (Array.isArray(val)) {
      for (const item of val) {
        this.zeroOutValue(item, visited);
      }
    } else if (val instanceof Map) {
      for (const [k, v] of val.entries()) {
        this.zeroOutValue(k, visited);
        this.zeroOutValue(v, visited);
      }
    } else if (val instanceof Set) {
      for (const v of val.values()) {
        this.zeroOutValue(v, visited);
      }
    } else {
      for (const k of Object.keys(val)) {
        this.zeroOutValue(val[k], visited);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Global Sandbox Registry Engine
// ---------------------------------------------------------------------------

const activeSandboxSessions = new Map<string, RestoreSandboxSession>();

export function createRestoreSandbox(customId?: string): RestoreSandboxSession {
  let sandboxId: string;
  if (customId !== undefined && customId !== null) {
    if (typeof customId !== 'string' || customId.trim().length === 0) {
      throw new Error('Restore Sandbox Error: customId must be a non-empty string');
    }
    if (activeSandboxSessions.has(customId)) {
      throw new Error(`Restore Sandbox Error: Sandbox session with ID '${customId}' already exists`);
    }
    sandboxId = customId.trim();
  } else {
    const randomSuffix = Math.random().toString(36).substring(2, 10);
    sandboxId = `sandbox_${Date.now()}_${randomSuffix}`;
  }

  const session = new RestoreSandboxSession(sandboxId);
  activeSandboxSessions.set(sandboxId, session);
  return session;
}

export function getRestoreSandboxSession(sandboxId: string): RestoreSandboxSession | undefined {
  const session = activeSandboxSessions.get(sandboxId);
  if (!session || session.getStatus() === 'closed') {
    return undefined;
  }
  return session;
}

export function destroyRestoreSandbox(sandboxId: string): void {
  const session = activeSandboxSessions.get(sandboxId);
  if (session) {
    session.close();
  }
}

export function getActiveSandboxCount(): number {
  return activeSandboxSessions.size;
}

export function destroyAllRestoreSandboxes(): void {
  for (const session of Array.from(activeSandboxSessions.values())) {
    session.close();
  }
  activeSandboxSessions.clear();
}
