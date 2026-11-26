/**
 * Khalid Pharmacy Management System - Standalone Backup Format V1
 * Specification, Canonical JSON, and Integrity Checksum Engine.
 */

export interface BackupHeader {
  version: '1.0';
  appId: 'com.khalidpharmacy.app';
  format: 'KP_BACKUP_V1';
  createdAt: string; // ISO 8601 UTC timestamp
  generator: string;
  branchId?: string;
  branchName?: string;
}

export interface StoreManifest {
  storeName: string;
  recordCount: number;
  payloadChecksum: string; // SHA-256 hash of serialized store payload
}

export interface SchemaManifest {
  dbVersion: number;
  stores: StoreManifest[];
}

export interface BackupPayloadEnvelope {
  type: string;
  data: any;
}

export interface KhalidPharmacyBackupV1 {
  header: BackupHeader;
  schema: SchemaManifest;
  payload: Record<string, any>; // Store payload map containing lossless graph representation
  checksum: string; // SHA-256 digest of header + schema + payload (canonical JSON)
}

/**
 * Deterministically serializes a JavaScript object into a canonical JSON string.
 * Keys at all object nesting levels are sorted lexicographically by UTF-16 code unit values (RFC 8785).
 */
export function canonicalJsonStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    const arrayElements = obj.map(item => {
      const stringified = canonicalJsonStringify(item);
      return stringified === undefined ? 'null' : stringified;
    });
    return `[${arrayElements.join(',')}]`;
  }

  // Lexicographical sorting by UTF-16 code unit order (RFC 8785 Section 3.2.3)
  const sortedKeys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pairs: string[] = [];

  for (const key of sortedKeys) {
    const val = obj[key];
    if (val !== undefined) {
      const stringified = canonicalJsonStringify(val);
      if (stringified !== undefined) {
        pairs.push(`${JSON.stringify(key)}:${stringified}`);
      }
    }
  }

  return `{${pairs.join(',')}}`;
}

/**
 * Computes a hex-encoded SHA-256 checksum of string data using the Web Crypto API.
 */
export async function computeSha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Computes SHA-256 checksum for a KhalidPharmacyBackupV1 structure (strictly excluding checksum field).
 * Safe against circular inclusion of the checksum field itself.
 */
export async function computeBackupChecksum(
  backup: Omit<KhalidPharmacyBackupV1, 'checksum'> | KhalidPharmacyBackupV1
): Promise<string> {
  const canonicalData = canonicalJsonStringify({
    header: backup.header,
    schema: backup.schema,
    payload: backup.payload,
  });
  return computeSha256(canonicalData);
}

/**
 * Verifies the integrity of a full backup object by recomputing its SHA-256 checksum.
 */
export async function verifyBackupChecksum(backup: KhalidPharmacyBackupV1): Promise<boolean> {
  if (!backup || !backup.checksum || typeof backup.checksum !== 'string') {
    return false;
  }
  const expectedChecksum = await computeBackupChecksum(backup);
  return backup.checksum.toLowerCase() === expectedChecksum.toLowerCase();
}
