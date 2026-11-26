/**
 * Khalid Pharmacy Management System - Standalone Secure Backup Encryption Engine
 * Specification: AES-256-GCM + PBKDF2-SHA256 (600,000 iterations)
 * Phase: P0.2.2-R1 — Targeted Encryption Hardening
 *
 * Security Mandates:
 * - Encryption: AES-256-GCM with 128-bit authentication tag.
 * - Key Derivation: PBKDF2 with HMAC-SHA-256 and exactly 600,000 iterations (OWASP recommendation).
 * - Salt: 16 cryptographically secure random bytes generated via crypto.getRandomValues.
 * - IV: 12 cryptographically secure random bytes generated via crypto.getRandomValues per encryption.
 * - Authenticated Additional Data (AAD): Cryptographic binding of header metadata to ciphertext.
 * - Zero Secrets Retention: Passwords and raw keys are NEVER persisted or serialized in output packages.
 * - Complete Failure on Tampering: Any modification to ciphertext, IV, Salt, or AAD causes complete rejection.
 * - Pre-allocation Sizing: UTF-8 length is calculated before allocating byte arrays; Uint8Array byteLength is checked before copy.
 * - Centralized Limits: Strict validation against safe integers, positive bounds, and immutable hard ceilings.
 *
 * Memory Management Disclosure:
 * In managed JavaScript runtime environments (V8 / Node / Browser), string primitives and garbage-collected
 * objects cannot be instantaneously wiped from virtual memory with hardware guarantees. For JavaScript objects,
 * canonicalJsonStringify produces an in-memory string representation before byte sizing. We then calculate the
 * exact UTF-8 byte length using computeUtf8ByteLength before allocating any Uint8Array or calling Web Crypto.
 * To minimize exposure, passwords are processed as transient ArrayBuffers, derived CryptoKeys are non-extractable,
 * and temporary typed arrays are explicitly zeroed out after use where feasible.
 */

import { canonicalJsonStringify } from './backupFormat.js';

// ---------------------------------------------------------------------------
// 1. Constants & Security Parameters
// ---------------------------------------------------------------------------

export const ENCRYPTION_FORMAT_TAG = 'KP_ENCRYPTED_BACKUP_V1' as const;
export const ENCRYPTION_VERSION_TAG = '1.0' as const;
export const APP_ID_TAG = 'com.khalidpharmacy.app' as const;
export const REQUIRED_KDF_ALGORITHM = 'PBKDF2' as const;
export const REQUIRED_KDF_HASH = 'SHA-256' as const;
export const REQUIRED_KDF_ITERATIONS = 600_000 as const;
export const REQUIRED_SALT_BYTE_LENGTH = 16 as const;
export const REQUIRED_CIPHER_ALGORITHM = 'AES-256-GCM' as const;
export const REQUIRED_IV_BYTE_LENGTH = 12 as const;
export const REQUIRED_TAG_BIT_LENGTH = 128 as const;
export const WEB_CRYPTO_AES_GCM = 'AES-GCM' as const;

// Static metadata and AAD limits
export const MAX_GENERATOR_LENGTH = 256 as const;
export const MAX_CREATED_AT_LENGTH = 64 as const;
export const MAX_AAD_BYTE_LENGTH = 4096 as const;

// Immutable hard ceilings for configurable limits (defense against DoS / memory exhaustion)
export const HARD_LIMIT_CEILINGS = {
  MAX_PLAINTEXT_BYTES_CEILING: 500 * 1024 * 1024,   // 500 MB hard ceiling
  MAX_CIPHERTEXT_BYTES_CEILING: 750 * 1024 * 1024,  // 750 MB hard ceiling
  MIN_PASSWORD_LENGTH_FLOOR: 8,                     // Minimum allowed minPasswordLength (OWASP)
  MIN_PASSWORD_LENGTH_CEILING: 128,                 // Maximum allowed minPasswordLength
  MAX_PASSWORD_LENGTH_FLOOR: 8,                     // Minimum allowed maxPasswordLength
  MAX_PASSWORD_LENGTH_CEILING: 4096,                // Maximum allowed maxPasswordLength
} as const;

// ---------------------------------------------------------------------------
// 2. Types & Interfaces
// ---------------------------------------------------------------------------

export interface EncryptionHeader {
  format: typeof ENCRYPTION_FORMAT_TAG;
  version: typeof ENCRYPTION_VERSION_TAG;
  appId: typeof APP_ID_TAG;
  createdAt: string; // ISO 8601 UTC timestamp
  generator: string;
}

export interface KeyDerivationParams {
  algorithm: typeof REQUIRED_KDF_ALGORITHM;
  hash: typeof REQUIRED_KDF_HASH;
  iterations: typeof REQUIRED_KDF_ITERATIONS;
  saltLength: typeof REQUIRED_SALT_BYTE_LENGTH;
  salt: string; // Base64 encoded 16-byte salt
}

export interface CipherParams {
  algorithm: typeof REQUIRED_CIPHER_ALGORITHM;
  ivLength: typeof REQUIRED_IV_BYTE_LENGTH;
  iv: string; // Base64 encoded 12-byte IV
  tagLength: typeof REQUIRED_TAG_BIT_LENGTH;
}

export interface AuthenticatedAdditionalData {
  format: typeof ENCRYPTION_FORMAT_TAG;
  version: typeof ENCRYPTION_VERSION_TAG;
  appId: typeof APP_ID_TAG;
  createdAt: string;
  generator: string;
}

export interface EncryptedBackupPackageV1 {
  header: EncryptionHeader;
  kdf: KeyDerivationParams;
  encryption: CipherParams;
  aad: AuthenticatedAdditionalData;
  ciphertext: string; // Base64 encoded (ciphertext + 128-bit authentication tag)
}

export interface EncryptionLimits {
  /** Maximum plaintext byte length allowed to prevent memory exhaustion (default: 100MB) */
  maxPlaintextByteLength?: number;
  /** Maximum ciphertext Base64 string length allowed before decoding (default: 150MB) */
  maxCiphertextByteLength?: number;
  /** Minimum required password length (default: 8 characters) */
  minPasswordLength?: number;
  /** Maximum allowed password length (default: 1024 characters) */
  maxPasswordLength?: number;
}

export const DEFAULT_ENCRYPTION_LIMITS: Required<EncryptionLimits> = {
  maxPlaintextByteLength: 100 * 1024 * 1024,   // 100 MB
  maxCiphertextByteLength: 150 * 1024 * 1024,  // 150 MB (~112MB binary)
  minPasswordLength: 8,
  maxPasswordLength: 1024,
};

// ---------------------------------------------------------------------------
// 3. Centralized Limits Validation Engine
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes EncryptionLimits.
 * Strictly verifies each limit is a safe integer, strictly positive (> 0),
 * within immutable hard ceilings, and maintains minPasswordLength <= maxPasswordLength.
 * Rejects NaN, Infinity, negative values, zeroes, non-integers, and ceiling breaches.
 */
export function validateEncryptionLimits(
  customLimits?: Partial<EncryptionLimits>
): Required<EncryptionLimits> {
  if (customLimits === undefined) {
    return { ...DEFAULT_ENCRYPTION_LIMITS };
  }
  if (customLimits === null) {
    throw new Error('Encryption Configuration Error: limits cannot be null. Pass an object or undefined.');
  }
  if (typeof customLimits !== 'object' || Array.isArray(customLimits)) {
    throw new Error('Encryption Configuration Error: limits must be an object');
  }

  const checkLimit = (
    key: keyof EncryptionLimits,
    val: unknown,
    minVal: number,
    maxCeiling: number
  ): number => {
    if (val === undefined) return DEFAULT_ENCRYPTION_LIMITS[key];
    if (typeof val !== 'number' || !Number.isSafeInteger(val)) {
      throw new Error(
        `Encryption Configuration Error: Limit '${key}' must be a safe positive integer. Received: ${String(val)}`
      );
    }
    if (val <= 0) {
      throw new Error(
        `Encryption Configuration Error: Limit '${key}' must be strictly positive (> 0). Received: ${val}`
      );
    }
    if (val < minVal) {
      throw new Error(
        `Encryption Configuration Error: Limit '${key}' cannot be less than safe minimum (${minVal}). Received: ${val}`
      );
    }
    if (val > maxCeiling) {
      throw new Error(
        `Encryption Configuration Error: Limit '${key}' exceeds immutable hard ceiling (${maxCeiling}). Received: ${val}`
      );
    }
    return val;
  };

  const maxPlaintextByteLength = checkLimit(
    'maxPlaintextByteLength',
    customLimits.maxPlaintextByteLength,
    1,
    HARD_LIMIT_CEILINGS.MAX_PLAINTEXT_BYTES_CEILING
  );

  const maxCiphertextByteLength = checkLimit(
    'maxCiphertextByteLength',
    customLimits.maxCiphertextByteLength,
    1,
    HARD_LIMIT_CEILINGS.MAX_CIPHERTEXT_BYTES_CEILING
  );

  const minPasswordLength = checkLimit(
    'minPasswordLength',
    customLimits.minPasswordLength,
    HARD_LIMIT_CEILINGS.MIN_PASSWORD_LENGTH_FLOOR,
    HARD_LIMIT_CEILINGS.MIN_PASSWORD_LENGTH_CEILING
  );

  const maxPasswordLength = checkLimit(
    'maxPasswordLength',
    customLimits.maxPasswordLength,
    HARD_LIMIT_CEILINGS.MAX_PASSWORD_LENGTH_FLOOR,
    HARD_LIMIT_CEILINGS.MAX_PASSWORD_LENGTH_CEILING
  );

  if (minPasswordLength > maxPasswordLength) {
    throw new Error(
      `Encryption Configuration Error: minPasswordLength (${minPasswordLength}) cannot exceed maxPasswordLength (${maxPasswordLength})`
    );
  }

  return {
    maxPlaintextByteLength,
    maxCiphertextByteLength,
    minPasswordLength,
    maxPasswordLength,
  };
}

// ---------------------------------------------------------------------------
// 4. Pre-allocation UTF-8 Size Calculation & ISO 8601 Validation
// ---------------------------------------------------------------------------

/**
 * Calculates the exact UTF-8 byte length of a string without allocating an intermediate byte array.
 * Strictly adheres to WHATWG UTF-8 Encoding rules:
 * - ASCII (U+0000..U+007F): 1 byte
 * - Arabic / Latin-extended (U+0080..U+07FF): 2 bytes
 * - BMP (U+0800..U+FFFF): 3 bytes
 * - Astral plane / Surrogate pairs (U+10000..U+10FFFF): 4 bytes
 * - Unpaired / lone surrogates: replaced by U+FFFD (3 bytes)
 *
 * If maxLimit is specified, exits immediately once running byte count exceeds maxLimit.
 */
export function computeUtf8ByteLength(str: string, maxLimit?: number): number {
  let byteLen = 0;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      byteLen += 1;
    } else if (code <= 0x7ff) {
      byteLen += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate
      if (i + 1 < len) {
        const nextCode = str.charCodeAt(i + 1);
        if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          // Valid surrogate pair -> Astral code point (U+10000 to U+10FFFF) -> 4 bytes UTF-8
          byteLen += 4;
          i++; // Consume low surrogate
        } else {
          // Unpaired high surrogate -> replaced by U+FFFD (3 bytes UTF-8)
          byteLen += 3;
        }
      } else {
        // Trailing lone high surrogate -> replaced by U+FFFD (3 bytes UTF-8)
        byteLen += 3;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate -> replaced by U+FFFD (3 bytes UTF-8)
      byteLen += 3;
    } else {
      // Regular BMP character (0x0800 - 0xD7FF, 0xE000 - 0xFFFF) -> 3 bytes UTF-8
      byteLen += 3;
    }

    if (maxLimit !== undefined && byteLen > maxLimit) {
      return byteLen;
    }
  }
  return byteLen;
}

const ISO_8601_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

/**
 * Determines whether a given Gregorian calendar year is a leap year.
 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Returns the maximum number of days in a given calendar month, accounting for leap years.
 */
export function getDaysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:  // January
    case 3:  // March
    case 5:  // May
    case 7:  // July
    case 8:  // August
    case 10: // October
    case 12: // December
      return 31;
    case 4:  // April
    case 6:  // June
    case 9:  // September
    case 11: // November
      return 30;
    case 2:  // February
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * Validates whether a string is a well-formed ISO 8601 UTC/offset timestamp
 * with strictly valid calendar date parts (including leap years and calendar days)
 * and within the maximum metadata length limit.
 */
export function isValidIso8601Date(val: string): boolean {
  if (typeof val !== 'string' || val.length === 0 || val.length > MAX_CREATED_AT_LENGTH) {
    return false;
  }
  const match = val.match(ISO_8601_REGEX);
  if (!match) {
    return false;
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);

  // Validate year range (1000..9999)
  if (year < 1000 || year > 9999) {
    return false;
  }

  // Validate month (1..12)
  if (month < 1 || month > 12) {
    return false;
  }

  // Validate day according to calendar month and leap year rules
  const maxDays = getDaysInMonth(year, month);
  if (day < 1 || day > maxDays) {
    return false;
  }

  // Validate time parts (hour: 0..23, minute: 0..59, second: 0..59)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return false;
  }

  // Validate timezone offset if present
  if (match[7] && match[8]) {
    const tzHour = parseInt(match[8], 10);
    const tzMinute = match[9] ? parseInt(match[9], 10) : 0;
    // Standard ISO 8601 timezone offsets range from -14:00 to +14:00
    if (tzHour < 0 || tzHour > 14 || tzMinute < 0 || tzMinute > 59) {
      return false;
    }
    if (tzHour === 14 && tzMinute > 0) {
      return false;
    }
  }

  const timestamp = Date.parse(val);
  return Number.isFinite(timestamp);
}

// ---------------------------------------------------------------------------
// 5. RFC 4648 Canonical Base64 Utilities (Bit-Level Validation)
// ---------------------------------------------------------------------------

const BASE64_CANONICAL_REGEX =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{1}[AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

export function isValidBase64Canonical(b64: string): boolean {
  if (typeof b64 !== 'string') return false;
  if (b64.length === 0) return true;
  if (b64.length % 4 !== 0) return false;
  return BASE64_CANONICAL_REGEX.test(b64);
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (b64.length === 0) return new Uint8Array(0);
  if (!isValidBase64Canonical(b64)) {
    throw new Error('Encryption Service: Malformed or non-canonical Base64 payload');
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const binaryString = atob(b64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// 6. Secure Key Derivation Engine (PBKDF2-SHA256)
// ---------------------------------------------------------------------------

/**
 * Derives a non-extractable 256-bit AES-GCM CryptoKey using PBKDF2-HMAC-SHA256.
 * Enforces exactly 600,000 iterations.
 */
export async function deriveKeyFromPassword(
  passwordBytes: Uint8Array,
  saltBytes: Uint8Array,
  iterations = REQUIRED_KDF_ITERATIONS
): Promise<CryptoKey> {
  if (iterations !== REQUIRED_KDF_ITERATIONS) {
    throw new Error(
      `Encryption Security Violation: Non-compliant PBKDF2 iterations ${iterations}. Exactly ${REQUIRED_KDF_ITERATIONS} required.`
    );
  }
  if (saltBytes.length !== REQUIRED_SALT_BYTE_LENGTH) {
    throw new Error(
      `Encryption Security Violation: Salt byte length ${saltBytes.length} is invalid. Exactly ${REQUIRED_SALT_BYTE_LENGTH} bytes required.`
    );
  }

  // Import raw password as key material for key derivation (non-extractable)
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    passwordBytes as unknown as BufferSource,
    { name: REQUIRED_KDF_ALGORITHM },
    false, // extractable = false prevents key exfiltration
    ['deriveKey']
  );

  // Derive AES-GCM 256-bit key
  const derivedKey = await crypto.subtle.deriveKey(
    {
      name: REQUIRED_KDF_ALGORITHM,
      salt: saltBytes as unknown as BufferSource,
      iterations,
      hash: REQUIRED_KDF_HASH,
    },
    passwordKey,
    {
      name: WEB_CRYPTO_AES_GCM,
      length: 256,
    },
    false, // derived key is non-extractable
    ['encrypt', 'decrypt']
  );

  return derivedKey;
}

// ---------------------------------------------------------------------------
// 7. Authenticated Additional Data (AAD) Serializer
// ---------------------------------------------------------------------------

/**
 * Builds deterministic binary AAD from metadata fields.
 * Validates individual field limits and enforces total AAD size <= MAX_AAD_BYTE_LENGTH.
 */
export function buildAadBuffer(aad: AuthenticatedAdditionalData): Uint8Array {
  if (
    typeof aad.generator !== 'string' ||
    aad.generator.length === 0 ||
    aad.generator.length > MAX_GENERATOR_LENGTH
  ) {
    throw new Error(
      `Encryption Error: AAD generator must be a non-empty string not exceeding ${MAX_GENERATOR_LENGTH} characters`
    );
  }
  if (typeof aad.createdAt !== 'string' || !isValidIso8601Date(aad.createdAt)) {
    throw new Error(
      `Encryption Error: AAD createdAt must be a valid ISO 8601 date string not exceeding ${MAX_CREATED_AT_LENGTH} characters`
    );
  }

  const canonicalAadString = canonicalJsonStringify({
    appId: aad.appId,
    createdAt: aad.createdAt,
    format: aad.format,
    generator: aad.generator,
    version: aad.version,
  });

  const aadByteLen = computeUtf8ByteLength(canonicalAadString, MAX_AAD_BYTE_LENGTH + 1);
  if (aadByteLen > MAX_AAD_BYTE_LENGTH) {
    throw new Error(
      `Encryption Error: Authenticated Additional Data size (${aadByteLen} bytes) exceeds maximum limit of ${MAX_AAD_BYTE_LENGTH} bytes`
    );
  }

  return new TextEncoder().encode(canonicalAadString);
}

// ---------------------------------------------------------------------------
// 8. Main Encryption & Decryption Service
// ---------------------------------------------------------------------------

export interface EncryptBackupOptions {
  generator?: string;
  createdAt?: string;
  limits?: EncryptionLimits;
}

export interface DecryptBackupOptions {
  limits?: EncryptionLimits;
}

/**
 * Encrypts backup data using Web Crypto AES-256-GCM and PBKDF2-SHA256.
 *
 * @param plaintextData - Plaintext string, object (will be canonically serialized), or raw Uint8Array.
 * @param password - Strong user passphrase.
 * @param options - Optional generator name, timestamp override, and resource limits.
 * @returns Self-contained, versioned EncryptedBackupPackageV1.
 */
export async function encryptBackup(
  plaintextData: string | Uint8Array | Record<string, any>,
  password: string,
  options: EncryptBackupOptions = {}
): Promise<EncryptedBackupPackageV1> {
  // 1. Centralized limits validation and enforcement of immutable ceilings
  const limits = validateEncryptionLimits(options.limits);

  // 2. Password validation
  if (typeof password !== 'string') {
    throw new Error('Encryption Error: Password must be a string');
  }
  if (password.length < limits.minPasswordLength) {
    throw new Error(
      `Encryption Error: Password length (${password.length}) does not meet the minimum requirement of ${limits.minPasswordLength} characters`
    );
  }
  if (password.length > limits.maxPasswordLength) {
    throw new Error(
      `Encryption Error: Password length (${password.length}) exceeds maximum limit of ${limits.maxPasswordLength} characters`
    );
  }

  // 3. Pre-allocation sizing and validation
  let plaintextBytes: Uint8Array;
  if (plaintextData instanceof Uint8Array) {
    // Uint8Array: Validate byteLength directly on the input buffer before any copy or processing
    if (plaintextData.byteLength > limits.maxPlaintextByteLength) {
      throw new Error(
        `Encryption Error: Plaintext size (${plaintextData.byteLength} bytes) exceeds maximum limit (${limits.maxPlaintextByteLength} bytes)`
      );
    }
    // Isolate: Create an independent, defensive copy of the bytes
    // Ensures concurrent mutations to caller buffer during PBKDF2 cannot alter ciphertext
    plaintextBytes = new Uint8Array(plaintextData.byteLength);
    plaintextBytes.set(plaintextData);
  } else if (typeof plaintextData === 'string') {
    // Text: Pre-compute exact UTF-8 byte length without allocating any byte array first
    const calculatedByteLength = computeUtf8ByteLength(plaintextData, limits.maxPlaintextByteLength + 1);
    if (calculatedByteLength > limits.maxPlaintextByteLength) {
      throw new Error(
        `Encryption Error: Plaintext size (${calculatedByteLength} bytes) exceeds maximum limit (${limits.maxPlaintextByteLength} bytes)`
      );
    }
    plaintextBytes = new TextEncoder().encode(plaintextData);
  } else if (typeof plaintextData === 'object' && plaintextData !== null) {
    // Objects: Serialize canonically, then check UTF-8 byte length before allocating byte array.
    // Memory Management Disclosure: In JavaScript/V8, canonicalJsonStringify produces an in-memory
    // string representation. We calculate its exact UTF-8 byte size using computeUtf8ByteLength
    // and reject payloads exceeding maxPlaintextByteLength prior to allocating the byte buffer.
    const jsonStr = canonicalJsonStringify(plaintextData);
    const calculatedByteLength = computeUtf8ByteLength(jsonStr, limits.maxPlaintextByteLength + 1);
    if (calculatedByteLength > limits.maxPlaintextByteLength) {
      throw new Error(
        `Encryption Error: Plaintext size (${calculatedByteLength} bytes) exceeds maximum limit (${limits.maxPlaintextByteLength} bytes)`
      );
    }
    plaintextBytes = new TextEncoder().encode(jsonStr);
  } else {
    throw new Error('Encryption Error: Invalid plaintext data type. Expected string, Uint8Array, or object.');
  }

  try {
    // 4. Validate and construct Header & AAD Metadata before key derivation or crypto calls
    const createdAt = options.createdAt !== undefined ? options.createdAt : new Date().toISOString();
    const generator = options.generator !== undefined ? options.generator : 'Khalid Pharmacy Web Backup Engine';

    if (typeof generator !== 'string' || generator.length === 0 || generator.length > MAX_GENERATOR_LENGTH) {
      throw new Error(
        `Encryption Error: generator metadata must be a non-empty string not exceeding ${MAX_GENERATOR_LENGTH} characters`
      );
    }

    if (typeof createdAt !== 'string' || !isValidIso8601Date(createdAt)) {
      throw new Error(
        `Encryption Error: createdAt metadata must be a valid ISO 8601 date string not exceeding ${MAX_CREATED_AT_LENGTH} characters`
      );
    }

    const header: EncryptionHeader = {
      format: ENCRYPTION_FORMAT_TAG,
      version: ENCRYPTION_VERSION_TAG,
      appId: APP_ID_TAG,
      createdAt,
      generator,
    };

    const aad: AuthenticatedAdditionalData = {
      format: ENCRYPTION_FORMAT_TAG,
      version: ENCRYPTION_VERSION_TAG,
      appId: APP_ID_TAG,
      createdAt,
      generator,
    };

    // buildAadBuffer validates both individual fields and enforces MAX_AAD_BYTE_LENGTH
    const aadBytes = buildAadBuffer(aad);

    // 5. Cryptographically secure random generation of Salt and IV
    const salt = new Uint8Array(REQUIRED_SALT_BYTE_LENGTH);
    const iv = new Uint8Array(REQUIRED_IV_BYTE_LENGTH);
    crypto.getRandomValues(salt);
    crypto.getRandomValues(iv);

    // 6. Derive encryption key
    const passwordEncoder = new TextEncoder();
    const passwordBytes = passwordEncoder.encode(password);
    let derivedKey: CryptoKey;
    try {
      derivedKey = await deriveKeyFromPassword(passwordBytes, salt, REQUIRED_KDF_ITERATIONS);
    } finally {
      // Best-effort cleanup of temporary password bytes
      passwordBytes.fill(0);
    }

    // 7. Perform AES-256-GCM authenticated encryption
    const cipherBuffer = await crypto.subtle.encrypt(
      {
        name: WEB_CRYPTO_AES_GCM,
        iv: iv as unknown as BufferSource,
        additionalData: aadBytes as unknown as BufferSource,
        tagLength: REQUIRED_TAG_BIT_LENGTH,
      },
      derivedKey,
      plaintextBytes as unknown as BufferSource
    );

    const cipherBytes = new Uint8Array(cipherBuffer);

    // 8. Assemble versioned output envelope
    const outputPackage: EncryptedBackupPackageV1 = {
      header,
      kdf: {
        algorithm: REQUIRED_KDF_ALGORITHM,
        hash: REQUIRED_KDF_HASH,
        iterations: REQUIRED_KDF_ITERATIONS,
        saltLength: REQUIRED_SALT_BYTE_LENGTH,
        salt: bytesToBase64(salt),
      },
      encryption: {
        algorithm: REQUIRED_CIPHER_ALGORITHM,
        ivLength: REQUIRED_IV_BYTE_LENGTH,
        iv: bytesToBase64(iv),
        tagLength: REQUIRED_TAG_BIT_LENGTH,
      },
      aad,
      ciphertext: bytesToBase64(cipherBytes),
    };

    return outputPackage;
  } finally {
    // Explicitly zero out temporary plaintext bytes buffer in memory on success or failure
    plaintextBytes.fill(0);
  }
}

/**
 * Decrypts a backup package using Web Crypto AES-256-GCM and PBKDF2-SHA256.
 * Verifies version, algorithms, parameters, AAD, and authentication tag.
 *
 * @param encryptedInput - EncryptedBackupPackageV1 object or raw JSON string.
 * @param password - User passphrase.
 * @param options - Optional custom resource limits.
 * @returns Decrypted UTF-8 string. Rejects with an explicit safe error on any mismatch or tampering.
 */
export async function decryptBackup(
  encryptedInput: EncryptedBackupPackageV1 | string,
  password: string,
  options: DecryptBackupOptions = {}
): Promise<string> {
  // 1. Centralized limits validation and enforcement of immutable ceilings
  const limits = validateEncryptionLimits(options.limits);

  // 2. Password validation
  if (typeof password !== 'string') {
    throw new Error('Decryption Error: Password must be a string');
  }
  if (password.length > limits.maxPasswordLength) {
    throw new Error('Decryption Error: Password exceeds maximum allowed length');
  }

  // 3. Parse package if provided as JSON string
  let pkg: EncryptedBackupPackageV1;
  if (typeof encryptedInput === 'string') {
    if (encryptedInput.length > limits.maxCiphertextByteLength) {
      throw new Error('Decryption Error: Encrypted package JSON string exceeds maximum size limit');
    }
    try {
      pkg = JSON.parse(encryptedInput);
    } catch {
      throw new Error('Decryption Error: Malformed JSON in encrypted backup package');
    }
  } else if (typeof encryptedInput === 'object' && encryptedInput !== null) {
    pkg = encryptedInput;
  } else {
    throw new Error('Decryption Error: Invalid encrypted package input. Expected object or JSON string.');
  }

  // 4. Strict Pre-Decryption Validation of Header and Format Tags
  if (!pkg.header || typeof pkg.header !== 'object') {
    throw new Error('Decryption Error: Missing or invalid package header');
  }
  if (pkg.header.format !== ENCRYPTION_FORMAT_TAG) {
    throw new Error(`Decryption Error: Unsupported format tag '${pkg.header.format}'. Expected '${ENCRYPTION_FORMAT_TAG}'`);
  }
  if (pkg.header.version !== ENCRYPTION_VERSION_TAG) {
    throw new Error(`Decryption Error: Unsupported version '${pkg.header.version}'. Expected '${ENCRYPTION_VERSION_TAG}'`);
  }
  if (pkg.header.appId !== APP_ID_TAG) {
    throw new Error(`Decryption Error: Invalid application ID '${pkg.header.appId}'. Expected '${APP_ID_TAG}'`);
  }
  if (
    typeof pkg.header.generator !== 'string' ||
    pkg.header.generator.length === 0 ||
    pkg.header.generator.length > MAX_GENERATOR_LENGTH
  ) {
    throw new Error(`Decryption Error: Header generator exceeds maximum allowed limit of ${MAX_GENERATOR_LENGTH} characters`);
  }
  if (
    typeof pkg.header.createdAt !== 'string' ||
    !isValidIso8601Date(pkg.header.createdAt)
  ) {
    throw new Error(`Decryption Error: Header createdAt must be a valid ISO 8601 date string not exceeding ${MAX_CREATED_AT_LENGTH} characters`);
  }

  // 5. Strict Pre-Decryption Validation of KDF Parameters
  if (!pkg.kdf || typeof pkg.kdf !== 'object') {
    throw new Error('Decryption Error: Missing Key Derivation Parameters (kdf)');
  }
  if (pkg.kdf.algorithm !== REQUIRED_KDF_ALGORITHM) {
    throw new Error(`Decryption Error: Unsupported KDF algorithm '${pkg.kdf.algorithm}'. Expected '${REQUIRED_KDF_ALGORITHM}'`);
  }
  if (pkg.kdf.hash !== REQUIRED_KDF_HASH) {
    throw new Error(`Decryption Error: Unsupported KDF hash '${pkg.kdf.hash}'. Expected '${REQUIRED_KDF_HASH}'`);
  }
  if (pkg.kdf.iterations !== REQUIRED_KDF_ITERATIONS) {
    throw new Error(
      `Decryption Security Violation: Non-compliant PBKDF2 iterations ${pkg.kdf.iterations}. Expected strictly ${REQUIRED_KDF_ITERATIONS}.`
    );
  }
  if (pkg.kdf.saltLength !== REQUIRED_SALT_BYTE_LENGTH) {
    throw new Error(
      `Decryption Error: Invalid salt length parameter ${pkg.kdf.saltLength}. Expected ${REQUIRED_SALT_BYTE_LENGTH}.`
    );
  }
  if (typeof pkg.kdf.salt !== 'string' || !isValidBase64Canonical(pkg.kdf.salt)) {
    throw new Error('Decryption Error: Invalid or non-canonical Base64 salt');
  }

  const saltBytes = base64ToBytes(pkg.kdf.salt);
  if (saltBytes.length !== REQUIRED_SALT_BYTE_LENGTH) {
    throw new Error(
      `Decryption Security Violation: Decoded salt length (${saltBytes.length} bytes) does not match required ${REQUIRED_SALT_BYTE_LENGTH} bytes`
    );
  }

  // 6. Strict Pre-Decryption Validation of Cipher Parameters
  if (!pkg.encryption || typeof pkg.encryption !== 'object') {
    throw new Error('Decryption Error: Missing encryption parameters block');
  }
  if (pkg.encryption.algorithm !== REQUIRED_CIPHER_ALGORITHM) {
    throw new Error(
      `Decryption Error: Unsupported encryption algorithm '${pkg.encryption.algorithm}'. Expected '${REQUIRED_CIPHER_ALGORITHM}'`
    );
  }
  if (pkg.encryption.ivLength !== REQUIRED_IV_BYTE_LENGTH) {
    throw new Error(
      `Decryption Error: Invalid IV length parameter ${pkg.encryption.ivLength}. Expected ${REQUIRED_IV_BYTE_LENGTH}.`
    );
  }
  if (pkg.encryption.tagLength !== REQUIRED_TAG_BIT_LENGTH) {
    throw new Error(
      `Decryption Error: Invalid authentication tag length ${pkg.encryption.tagLength}. Expected ${REQUIRED_TAG_BIT_LENGTH}.`
    );
  }
  if (typeof pkg.encryption.iv !== 'string' || !isValidBase64Canonical(pkg.encryption.iv)) {
    throw new Error('Decryption Error: Invalid or non-canonical Base64 IV');
  }

  const ivBytes = base64ToBytes(pkg.encryption.iv);
  if (ivBytes.length !== REQUIRED_IV_BYTE_LENGTH) {
    throw new Error(
      `Decryption Security Violation: Decoded IV length (${ivBytes.length} bytes) does not match required ${REQUIRED_IV_BYTE_LENGTH} bytes`
    );
  }

  // 7. Strict Validation of AAD Block & Binding Check
  if (!pkg.aad || typeof pkg.aad !== 'object') {
    throw new Error('Decryption Error: Missing Authenticated Additional Data (aad) block');
  }
  if (
    typeof pkg.aad.generator !== 'string' ||
    pkg.aad.generator.length === 0 ||
    pkg.aad.generator.length > MAX_GENERATOR_LENGTH
  ) {
    throw new Error(`Decryption Error: AAD generator exceeds maximum allowed limit of ${MAX_GENERATOR_LENGTH} characters`);
  }
  if (
    typeof pkg.aad.createdAt !== 'string' ||
    !isValidIso8601Date(pkg.aad.createdAt)
  ) {
    throw new Error(`Decryption Error: AAD createdAt must be a valid ISO 8601 date string not exceeding ${MAX_CREATED_AT_LENGTH} characters`);
  }
  if (
    pkg.aad.appId !== pkg.header.appId ||
    pkg.aad.format !== pkg.header.format ||
    pkg.aad.version !== pkg.header.version ||
    pkg.aad.createdAt !== pkg.header.createdAt ||
    pkg.aad.generator !== pkg.header.generator
  ) {
    throw new Error('Decryption Security Violation: Mismatch between unencrypted header and AAD block');
  }

  // 8. Ciphertext length and canonical Base64 audit
  if (typeof pkg.ciphertext !== 'string') {
    throw new Error('Decryption Error: Missing ciphertext string');
  }
  if (pkg.ciphertext.length > limits.maxCiphertextByteLength) {
    throw new Error(
      `Decryption Error: Ciphertext length (${pkg.ciphertext.length}) exceeds maximum allowed limit (${limits.maxCiphertextByteLength})`
    );
  }
  if (!isValidBase64Canonical(pkg.ciphertext)) {
    throw new Error('Decryption Error: Malformed or non-canonical Base64 ciphertext');
  }

  const cipherBytes = base64ToBytes(pkg.ciphertext);
  // AES-GCM ciphertext must at least contain the 16-byte (128-bit) authentication tag
  if (cipherBytes.length < REQUIRED_TAG_BIT_LENGTH / 8) {
    throw new Error('Decryption Error: Ciphertext is shorter than the required 128-bit authentication tag');
  }

  // 9. Derive key from password and salt
  const passwordEncoder = new TextEncoder();
  const passwordBytes = passwordEncoder.encode(password);
  let derivedKey: CryptoKey;
  try {
    derivedKey = await deriveKeyFromPassword(passwordBytes, saltBytes, REQUIRED_KDF_ITERATIONS);
  } finally {
    passwordBytes.fill(0);
  }

  // 10. Reconstruct deterministic AAD buffer (validates AAD size <= MAX_AAD_BYTE_LENGTH)
  const aadBytes = buildAadBuffer(pkg.aad);

  // 11. Decrypt and verify authentication tag in Web Crypto AES-GCM
  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      {
        name: WEB_CRYPTO_AES_GCM,
        iv: ivBytes as unknown as BufferSource,
        additionalData: aadBytes as unknown as BufferSource,
        tagLength: REQUIRED_TAG_BIT_LENGTH,
      },
      derivedKey,
      cipherBytes as unknown as BufferSource
    );
  } catch {
    // Web Crypto throws DOMException / OperationError on authentication failure.
    // Return sanitized error message without leaking internal details.
    throw new Error(
      'Decryption Failed: Authentication tag verification failed. The passphrase may be incorrect, or the backup payload has been tampered with or corrupted.'
    );
  }

  // 12. Decode verified plaintext UTF-8 string
  return new TextDecoder('utf-8', { fatal: true }).decode(decryptedBuffer);
}
