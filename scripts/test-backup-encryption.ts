/**
 * Standalone Automated Test Suite for Secure Backup Encryption Engine (P0.2.2-R1)
 * Khalid Pharmacy Management System
 *
 * Validates:
 * - AES-256-GCM authenticated encryption and decryption.
 * - PBKDF2-HMAC-SHA256 key derivation with exactly 600,000 iterations.
 * - 16-byte random salt and 12-byte random IV generation.
 * - 128-bit authentication tag verification.
 * - Authenticated Additional Data (AAD) tamper detection.
 * - Complete failure and zero partial data leak upon any corruption.
 * - Rejection of invalid parameters, lengths, and algorithms.
 * - Boundary conditions (empty strings, large payloads, Arabic Unicode).
 * - Pre-allocation sizing and accurate UTF-8 calculation (Arabic, Non-BMP astral characters, lone surrogates).
 * - Header & AAD metadata protection (generator length, ISO 8601 date validation, 4096-byte AAD ceiling).
 * - Centralized limits validation (safe integer, positive bounds, immutable hard ceilings, NaN/Infinity rejection).
 */

import {
  encryptBackup,
  decryptBackup,
  isValidBase64Canonical,
  base64ToBytes,
  bytesToBase64,
  computeUtf8ByteLength,
  isValidIso8601Date,
  isLeapYear,
  getDaysInMonth,
  validateEncryptionLimits,
  buildAadBuffer,
  EncryptedBackupPackageV1,
  ENCRYPTION_FORMAT_TAG,
  ENCRYPTION_VERSION_TAG,
  REQUIRED_CIPHER_ALGORITHM,
  REQUIRED_KDF_ALGORITHM,
  REQUIRED_KDF_HASH,
  REQUIRED_KDF_ITERATIONS,
  REQUIRED_SALT_BYTE_LENGTH,
  REQUIRED_IV_BYTE_LENGTH,
  MAX_GENERATOR_LENGTH,
  MAX_CREATED_AT_LENGTH,
  MAX_AAD_BYTE_LENGTH,
  HARD_LIMIT_CEILINGS,
} from '../src/services/backupEncryption.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  [PASS] ${testName}`);
  } else {
    failedTests++;
    console.error(`  [FAIL] ${testName}${detail ? ` - ${detail}` : ''}`);
  }
}

async function assertThrowsAsync(
  fn: () => Promise<any>,
  testName: string,
  expectedSubstring?: string
) {
  totalTests++;
  try {
    const res = await fn();
    failedTests++;
    console.error(
      `  [FAIL] ${testName} - Expected error to be thrown, but succeeded with output:`,
      typeof res === 'string' ? res.substring(0, 50) : res
    );
  } catch (err: any) {
    if (
      !expectedSubstring ||
      (typeof err.message === 'string' && err.message.includes(expectedSubstring))
    ) {
      passedTests++;
      console.log(`  [PASS] ${testName} (Caught expected: "${expectedSubstring || err.message}")`);
    } else {
      failedTests++;
      console.error(
        `  [FAIL] ${testName} - Threw unexpected error: "${err.message}", expected substring: "${expectedSubstring}"`
      );
    }
  }
}

function assertThrowsSync(
  fn: () => any,
  testName: string,
  expectedSubstring?: string
) {
  totalTests++;
  try {
    const res = fn();
    failedTests++;
    console.error(
      `  [FAIL] ${testName} - Expected synchronous error to be thrown, but succeeded:`,
      res
    );
  } catch (err: any) {
    if (
      !expectedSubstring ||
      (typeof err.message === 'string' && err.message.includes(expectedSubstring))
    ) {
      passedTests++;
      console.log(`  [PASS] ${testName} (Caught expected: "${expectedSubstring || err.message}")`);
    } else {
      failedTests++;
      console.error(
        `  [FAIL] ${testName} - Threw unexpected error: "${err.message}", expected substring: "${expectedSubstring}"`
      );
    }
  }
}

async function runTests() {
  console.log('======================================================================');
  console.log('KHALID PHARMACY — SECURE BACKUP ENCRYPTION TEST SUITE (P0.2.2-R1)');
  console.log('Testing AES-256-GCM + PBKDF2 (600,000 iterations) + Hardened Limits');
  console.log('======================================================================\n');

  const testPassword = 'CorrectPharmacistSecretPassphrase2026!';
  const samplePayload = JSON.stringify({
    pharmacy: 'Khalid Pharmacy',
    branch: 'Main Branch Khartoum',
    timestamp: '2026-11-11T12:00:00.000Z',
    medicines: [
      { id: 'MED-001', name: 'Amoxicillin 500mg', stock: 120, unitPrice: 450 },
      { id: 'MED-002', name: 'Paracetamol 500mg', stock: 500, unitPrice: 150 },
      { id: 'MED-003', name: 'Metformin 850mg', stock: 80, unitPrice: 320 },
    ],
  });

  // -------------------------------------------------------------------------
  // SUITE 1: End-to-End Encryption & Decryption Round-Trip
  // -------------------------------------------------------------------------
  console.log('--- Suite 1: End-to-End Encryption & Decryption Round-Trip ---');

  const encryptedPackage = await encryptBackup(samplePayload, testPassword, {
    generator: 'Khalid Pharmacy Automated Test Harness',
  });

  assert(
    encryptedPackage.header.format === ENCRYPTION_FORMAT_TAG,
    'Suite 1.1: Header format matches KP_ENCRYPTED_BACKUP_V1'
  );
  assert(
    encryptedPackage.header.version === ENCRYPTION_VERSION_TAG,
    'Suite 1.2: Header version matches 1.0'
  );
  assert(
    encryptedPackage.kdf.algorithm === REQUIRED_KDF_ALGORITHM &&
      encryptedPackage.kdf.iterations === REQUIRED_KDF_ITERATIONS &&
      encryptedPackage.kdf.hash === REQUIRED_KDF_HASH,
    'Suite 1.3: KDF parameters strictly specify PBKDF2-SHA256 with 600,000 iterations'
  );
  assert(
    encryptedPackage.encryption.algorithm === REQUIRED_CIPHER_ALGORITHM &&
      encryptedPackage.encryption.tagLength === 128,
    'Suite 1.4: Encryption parameters specify AES-256-GCM with 128-bit tag'
  );
  assert(
    isValidBase64Canonical(encryptedPackage.kdf.salt) &&
      base64ToBytes(encryptedPackage.kdf.salt).length === REQUIRED_SALT_BYTE_LENGTH,
    'Suite 1.5: Salt is valid canonical Base64 and exactly 16 bytes'
  );
  assert(
    isValidBase64Canonical(encryptedPackage.encryption.iv) &&
      base64ToBytes(encryptedPackage.encryption.iv).length === REQUIRED_IV_BYTE_LENGTH,
    'Suite 1.6: IV is valid canonical Base64 and exactly 12 bytes'
  );
  assert(
    isValidBase64Canonical(encryptedPackage.ciphertext) && encryptedPackage.ciphertext.length > 0,
    'Suite 1.7: Ciphertext is valid canonical Base64 string'
  );

  const decryptedPayload = await decryptBackup(encryptedPackage, testPassword);
  assert(
    decryptedPayload === samplePayload,
    'Suite 1.8: Decrypted plaintext exactly matches original backup payload'
  );

  // Also test decrypting when package is serialized as a JSON string
  const jsonPackageString = JSON.stringify(encryptedPackage);
  const decryptedFromJson = await decryptBackup(jsonPackageString, testPassword);
  assert(
    decryptedFromJson === samplePayload,
    'Suite 1.9: Decrypted package passed as serialized JSON string roundtrips identically'
  );

  // -------------------------------------------------------------------------
  // SUITE 2: Password Authentication & Zero Key Disclosure
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 2: Password Authentication & Zero Key Disclosure ---');

  // 2.1 Wrong password fails authentication completely
  await assertThrowsAsync(
    () => decryptBackup(encryptedPackage, 'WrongIncorrectPassword2026!'),
    'Suite 2.1: Rejection with wrong password',
    'Authentication tag verification failed'
  );

  // 2.2 Slightly altered password (case difference) fails authentication
  await assertThrowsAsync(
    () => decryptBackup(encryptedPackage, 'correctpharmacistsecretpassphrase2026!'),
    'Suite 2.2: Rejection with case-altered password',
    'Authentication tag verification failed'
  );

  // 2.3 Verify package object contains no key or password secrets
  const rawStringified = JSON.stringify(encryptedPackage);
  assert(
    !rawStringified.includes(testPassword),
    'Suite 2.3: Zero secrets leakage: Password does not appear anywhere in serialized package'
  );
  assert(
    !(encryptedPackage as any).key && !(encryptedPackage as any).secret,
    'Suite 2.4: Zero secrets leakage: Derived key is non-extractable and not attached to package'
  );

  // -------------------------------------------------------------------------
  // SUITE 3: Ciphertext, IV, and Salt Tampering Defenses
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 3: Ciphertext, IV, and Salt Tampering Defenses ---');

  // 3.1 Flipping one byte in the ciphertext
  const tamperedCipherBytes = base64ToBytes(encryptedPackage.ciphertext);
  tamperedCipherBytes[0] ^= 0x01; // flip single bit
  const tamperedCipherPackage: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    ciphertext: bytesToBase64(tamperedCipherBytes),
  };
  await assertThrowsAsync(
    () => decryptBackup(tamperedCipherPackage, testPassword),
    'Suite 3.1: Reject tampered ciphertext (flipped bit)',
    'Authentication tag verification failed'
  );

  // 3.2 Flipping one byte in the IV
  const tamperedIvBytes = base64ToBytes(encryptedPackage.encryption.iv);
  tamperedIvBytes[0] ^= 0x55;
  const tamperedIvPackage: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    encryption: {
      ...encryptedPackage.encryption,
      iv: bytesToBase64(tamperedIvBytes),
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(tamperedIvPackage, testPassword),
    'Suite 3.2: Reject tampered IV',
    'Authentication tag verification failed'
  );

  // 3.3 Flipping one byte in the Salt
  const tamperedSaltBytes = base64ToBytes(encryptedPackage.kdf.salt);
  tamperedSaltBytes[0] ^= 0xaa;
  const tamperedSaltPackage: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    kdf: {
      ...encryptedPackage.kdf,
      salt: bytesToBase64(tamperedSaltBytes),
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(tamperedSaltPackage, testPassword),
    'Suite 3.3: Reject tampered Salt',
    'Authentication tag verification failed'
  );

  // -------------------------------------------------------------------------
  // SUITE 4: Authenticated Additional Data (AAD) & Header Tampering Defenses
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 4: Authenticated Additional Data (AAD) & Header Tampering ---');

  // 4.1 Modifying header.createdAt without modifying aad
  const tamperedHeaderCreatedAt: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    header: {
      ...encryptedPackage.header,
      createdAt: '1999-01-01T00:00:00.000Z',
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(tamperedHeaderCreatedAt, testPassword),
    'Suite 4.1: Reject unencrypted header modification (mismatch with AAD block)',
    'Mismatch between unencrypted header and AAD block'
  );

  // 4.2 Modifying both header and AAD createdAt (simulating attacker trying to alter timestamp)
  const tamperedBothCreatedAt: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    header: {
      ...encryptedPackage.header,
      createdAt: '1999-01-01T00:00:00.000Z',
    },
    aad: {
      ...encryptedPackage.aad,
      createdAt: '1999-01-01T00:00:00.000Z',
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(tamperedBothCreatedAt, testPassword),
    'Suite 4.2: Reject AAD timestamp tampering via AES-GCM tag verification',
    'Authentication tag verification failed'
  );

  // 4.3 Modifying both header and AAD appId
  const tamperedAppId: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    header: {
      ...encryptedPackage.header,
      appId: 'com.malicious.app' as any,
    },
    aad: {
      ...encryptedPackage.aad,
      appId: 'com.malicious.app' as any,
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(tamperedAppId, testPassword),
    'Suite 4.3: Reject AAD appId tampering via pre-check or tag verification',
    'Invalid application ID'
  );

  // 4.4 Modifying both header and AAD generator
  const tamperedGenerator: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    header: {
      ...encryptedPackage.header,
      generator: 'Forged Generator Name',
    },
    aad: {
      ...encryptedPackage.aad,
      generator: 'Forged Generator Name',
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(tamperedGenerator, testPassword),
    'Suite 4.4: Reject AAD generator metadata tampering via AES-GCM tag verification',
    'Authentication tag verification failed'
  );

  // -------------------------------------------------------------------------
  // SUITE 5: Cryptographic Randomness (Unique Salt & IV per Operation)
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 5: Cryptographic Randomness (Unique Salt & IV per Run) ---');

  const pkg1 = await encryptBackup(samplePayload, testPassword);
  const pkg2 = await encryptBackup(samplePayload, testPassword);
  const pkg3 = await encryptBackup(samplePayload, testPassword);

  assert(
    pkg1.kdf.salt !== pkg2.kdf.salt && pkg2.kdf.salt !== pkg3.kdf.salt,
    'Suite 5.1: Salt is cryptographically unique across encryptions of identical plaintext'
  );
  assert(
    pkg1.encryption.iv !== pkg2.encryption.iv && pkg2.encryption.iv !== pkg3.encryption.iv,
    'Suite 5.2: IV is cryptographically unique across encryptions of identical plaintext'
  );
  assert(
    pkg1.ciphertext !== pkg2.ciphertext && pkg2.ciphertext !== pkg3.ciphertext,
    'Suite 5.3: Ciphertexts are completely distinct due to randomized Salt and IV'
  );

  // Verify all 3 decrypt to identical payload
  const dec1 = await decryptBackup(pkg1, testPassword);
  const dec2 = await decryptBackup(pkg2, testPassword);
  const dec3 = await decryptBackup(pkg3, testPassword);
  assert(
    dec1 === samplePayload && dec2 === samplePayload && dec3 === samplePayload,
    'Suite 5.4: All uniquely encrypted packages decrypt faithfully to the original plaintext'
  );

  // -------------------------------------------------------------------------
  // SUITE 6: Parameter Length & Algorithm Integrity Validation
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 6: Parameter Length & Algorithm Integrity Validation ---');

  // 6.1 Salt length must be strictly 16 bytes
  const badSaltPkg: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    kdf: {
      ...encryptedPackage.kdf,
      saltLength: 8 as any,
      salt: bytesToBase64(new Uint8Array(8)),
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(badSaltPkg, testPassword),
    'Suite 6.1: Reject Salt length other than 16 bytes',
    'Invalid salt length parameter'
  );

  // 6.2 IV length must be strictly 12 bytes
  const badIvPkg: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    encryption: {
      ...encryptedPackage.encryption,
      ivLength: 16 as any,
      iv: bytesToBase64(new Uint8Array(16)),
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(badIvPkg, testPassword),
    'Suite 6.2: Reject IV length other than 12 bytes',
    'Invalid IV length parameter'
  );

  // 6.3 PBKDF2 Iterations must be strictly 600,000
  const downgradedIterationsPkg: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    kdf: {
      ...encryptedPackage.kdf,
      iterations: 1000 as any, // downgrade attempt
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(downgradedIterationsPkg, testPassword),
    'Suite 6.3: Reject non-compliant PBKDF2 iterations downgrade',
    'Non-compliant PBKDF2 iterations'
  );

  // 6.4 Reject unknown or unsupported cipher algorithm
  const badCipherPkg: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    encryption: {
      ...encryptedPackage.encryption,
      algorithm: 'AES-128-CBC' as any,
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(badCipherPkg, testPassword),
    'Suite 6.4: Reject unapproved cipher algorithm (AES-128-CBC)',
    'Unsupported encryption algorithm'
  );

  // 6.5 Reject unknown format tag
  const badFormatPkg: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    header: {
      ...encryptedPackage.header,
      format: 'UNKNOWN_FORMAT_TAG' as any,
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(badFormatPkg, testPassword),
    'Suite 6.5: Reject unapproved format tag',
    'Unsupported format tag'
  );

  // 6.6 Reject unsupported version
  const badVersionPkg: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    header: {
      ...encryptedPackage.header,
      version: '2.0' as any,
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(badVersionPkg, testPassword),
    'Suite 6.6: Reject unapproved version tag (2.0)',
    'Unsupported version'
  );

  // -------------------------------------------------------------------------
  // SUITE 7: Resource Limits, Password Length, & DoS Defenses
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 7: Resource Limits, Password Length & DoS Defenses ---');

  // 7.1 Reject password below minimum length during encryption
  await assertThrowsAsync(
    () => encryptBackup(samplePayload, 'short'),
    'Suite 7.1: Reject password shorter than minimum (8 chars)',
    'does not meet the minimum requirement of 8 characters'
  );

  // 7.2 Reject password exceeding maximum length
  await assertThrowsAsync(
    () => encryptBackup(samplePayload, 'P'.repeat(1025)),
    'Suite 7.2: Reject password exceeding maximum (1024 chars)',
    'exceeds maximum limit'
  );

  // 7.3 Reject plaintext exceeding custom maximum limit
  await assertThrowsAsync(
    () =>
      encryptBackup('X'.repeat(500), testPassword, {
        limits: { maxPlaintextByteLength: 200 },
      }),
    'Suite 7.3: Reject plaintext exceeding maxPlaintextByteLength',
    'exceeds maximum limit'
  );

  // 7.4 Reject ciphertext exceeding custom maximum limit during decryption
  await assertThrowsAsync(
    () =>
      decryptBackup(encryptedPackage, testPassword, {
        limits: { maxCiphertextByteLength: 50 },
      }),
    'Suite 7.4: Reject ciphertext exceeding maxCiphertextByteLength',
    'exceeds maximum allowed limit'
  );

  // 7.5 Reject truncated ciphertext shorter than authentication tag (16 bytes)
  const truncatedCiphertextPkg: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    ciphertext: bytesToBase64(new Uint8Array(8)), // 8 bytes < 16 bytes tag
  };
  await assertThrowsAsync(
    () => decryptBackup(truncatedCiphertextPkg, testPassword),
    'Suite 7.5: Reject ciphertext shorter than 128-bit authentication tag',
    'shorter than the required 128-bit authentication tag'
  );

  // -------------------------------------------------------------------------
  // SUITE 8: Zero Partial Data Return Guarantee
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 8: Zero Partial Data Return Guarantee ---');

  let leakedData: any = 'SENTINEL_NEVER_SET';
  try {
    leakedData = await decryptBackup(tamperedCipherPackage, testPassword);
  } catch {
    leakedData = null; // expected rejection
  }
  assert(
    leakedData === null,
    'Suite 8.1: Complete failure guarantee: Zero partial data returned on authentication failure'
  );

  // -------------------------------------------------------------------------
  // SUITE 9: Boundary & Payload Diversity Verification
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 9: Boundary & Payload Diversity Verification ---');

  // 9.1 Empty string plaintext round-trip
  const emptyStringPkg = await encryptBackup('', testPassword);
  const decryptedEmpty = await decryptBackup(emptyStringPkg, testPassword);
  assert(decryptedEmpty === '', 'Suite 9.1: Empty string plaintext round-trips successfully');

  // 9.2 Arabic pharmaceutical text & Unicode preservation
  const arabicMedicalRecord = JSON.stringify({
    صيدلية: 'صيدلية خالد المركزية',
    الوصفة: 'أموكسيسيلين 500 ملغم كبسولات - يؤخذ بعد الأكل مرتين يومياً',
    المريض: 'أحمد إبراهيم حسن',
    الملاحظات: 'فحص الحساسية للبنسلين سليم — تم الصرف بتاريخ 2026-11-11',
    الباركود: '6211029384756',
  });
  const arabicPkg = await encryptBackup(arabicMedicalRecord, testPassword);
  const decryptedArabic = await decryptBackup(arabicPkg, testPassword);
  assert(
    decryptedArabic === arabicMedicalRecord,
    'Suite 9.2: Complex Arabic pharmaceutical Unicode strings preserved exactly bit-for-bit'
  );

  // 9.3 Large payload round-trip (~1MB synthetic pharmaceutical catalog)
  const largeCatalog: Array<any> = [];
  for (let i = 0; i < 2500; i++) {
    largeCatalog.push({
      sku: `KHP-${String(i).padStart(6, '0')}`,
      name: `Pharmaceutical Product Specimen #${i}`,
      category: 'PRESCRIPTION_MEDICATION',
      activeSubstance: 'Generic Active Agent Complex',
      dosageForm: 'Tablets / Blister Pack',
      batchHistory: ['BATCH-2026-A', 'BATCH-2026-B', 'BATCH-2026-C'],
      attributes: { verified: true, taxRate: 0.15, reorderLevel: 25 },
    });
  }
  const largePayloadString = JSON.stringify(largeCatalog);
  const largePayloadBytes = new TextEncoder().encode(largePayloadString).length;

  const t0 = Date.now();
  const largeEncryptedPkg = await encryptBackup(largePayloadString, testPassword);
  const encTime = Date.now() - t0;

  const t1 = Date.now();
  const decryptedLarge = await decryptBackup(largeEncryptedPkg, testPassword);
  const decTime = Date.now() - t1;

  assert(
    decryptedLarge === largePayloadString,
    `Suite 9.3: Large payload (${(largePayloadBytes / 1024 / 1024).toFixed(2)} MB) encrypts (${encTime}ms) & decrypts (${decTime}ms) accurately`
  );

  // -------------------------------------------------------------------------
  // SUITE 10: Pre-allocation Plaintext Sizing & UTF-8 Byte Calculations
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 10: Pre-allocation Plaintext Sizing & UTF-8 Calculations ---');

  // 10.1 Accurate UTF-8 calculation for Arabic text
  const arabicPhrase = 'صيدلية خالد المركزية - الخرطوم';
  const expectedArabicBytes = new TextEncoder().encode(arabicPhrase).length;
  const computedArabicBytes = computeUtf8ByteLength(arabicPhrase);
  assert(
    computedArabicBytes === expectedArabicBytes,
    `Suite 10.1: Accurate UTF-8 byte calculation for Arabic text (${computedArabicBytes} bytes calculated vs ${expectedArabicBytes} expected)`
  );

  // 10.2 Accurate UTF-8 calculation for Astral Plane non-BMP characters (surrogate pairs)
  const astralSymbols = '💊💉🧬🧪';
  const expectedAstralBytes = new TextEncoder().encode(astralSymbols).length; // 4 emojis * 4 bytes = 16 bytes
  const computedAstralBytes = computeUtf8ByteLength(astralSymbols);
  assert(
    computedAstralBytes === expectedAstralBytes && computedAstralBytes === 16,
    `Suite 10.2: Accurate UTF-8 byte calculation for Non-BMP astral characters (4 bytes per emoji, total ${computedAstralBytes} bytes)`
  );

  // 10.3 Accurate UTF-8 calculation for unpaired lone surrogates (WHATWG U+FFFD 3-byte replacement)
  const loneSurrogates = '\uD800\uDC00\uD800abc\uDC8A';
  const expectedSurrogateBytes = new TextEncoder().encode(loneSurrogates).length;
  const computedSurrogateBytes = computeUtf8ByteLength(loneSurrogates);
  assert(
    computedSurrogateBytes === expectedSurrogateBytes,
    `Suite 10.3: Accurate UTF-8 calculation for mixed valid and lone surrogates (${computedSurrogateBytes} bytes)`
  );

  // 10.4 Rejection of text exceeding maxPlaintextByteLength before byte array allocation
  await assertThrowsAsync(
    () =>
      encryptBackup('أدوية'.repeat(20), testPassword, {
        limits: { maxPlaintextByteLength: 50 },
      }),
    'Suite 10.4: Reject text exceeding maxPlaintextByteLength before allocation',
    'exceeds maximum limit'
  );

  // 10.5 Rejection of Uint8Array exceeding maxPlaintextByteLength directly on input byteLength
  const oversizedUint8 = new Uint8Array(150);
  await assertThrowsAsync(
    () =>
      encryptBackup(oversizedUint8, testPassword, {
        limits: { maxPlaintextByteLength: 100 },
      }),
    'Suite 10.5: Reject Uint8Array exceeding maxPlaintextByteLength directly on byteLength',
    'exceeds maximum limit'
  );

  // 10.6 Rejection of Object payload exceeding maxPlaintextByteLength before byte allocation
  const oversizedObject = { data: 'X'.repeat(300) };
  await assertThrowsAsync(
    () =>
      encryptBackup(oversizedObject, testPassword, {
        limits: { maxPlaintextByteLength: 100 },
      }),
    'Suite 10.6: Reject Object payload exceeding maxPlaintextByteLength before byte allocation',
    'exceeds maximum limit'
  );

  // -------------------------------------------------------------------------
  // SUITE 11: Header & Authenticated Additional Data (AAD) Hardening
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 11: Header & Authenticated Additional Data (AAD) Hardening ---');

  // 11.1 Reject generator exceeding MAX_GENERATOR_LENGTH (256 chars) during encryption
  await assertThrowsAsync(
    () =>
      encryptBackup(samplePayload, testPassword, {
        generator: 'G'.repeat(MAX_GENERATOR_LENGTH + 1),
      }),
    'Suite 11.1: Reject generator exceeding 256 characters during encryption',
    'generator metadata must be a non-empty string not exceeding 256 characters'
  );

  // 11.2 Reject empty generator string during encryption
  await assertThrowsAsync(
    () =>
      encryptBackup(samplePayload, testPassword, {
        generator: '',
      }),
    'Suite 11.2: Reject empty generator string during encryption',
    'generator metadata must be a non-empty string not exceeding 256 characters'
  );

  // 11.3 Reject invalid createdAt during encryption (non-ISO string)
  await assertThrowsAsync(
    () =>
      encryptBackup(samplePayload, testPassword, {
        createdAt: 'invalid-iso-date-string',
      }),
    'Suite 11.3: Reject malformed createdAt string during encryption',
    'createdAt metadata must be a valid ISO 8601 date string'
  );

  // 11.4 Reject invalid createdAt during encryption (date rollover e.g. Feb 31)
  await assertThrowsAsync(
    () =>
      encryptBackup(samplePayload, testPassword, {
        createdAt: '2026-02-31T12:00:00.000Z',
      }),
    'Suite 11.4: Reject invalid calendar date rollover (2026-02-31) during encryption',
    'createdAt metadata must be a valid ISO 8601 date string'
  );

  // 11.5 Reject createdAt exceeding MAX_CREATED_AT_LENGTH (64 chars) during encryption
  await assertThrowsAsync(
    () =>
      encryptBackup(samplePayload, testPassword, {
        createdAt: '2026-11-11T12:00:00.000Z' + '0'.repeat(50),
      }),
    'Suite 11.5: Reject createdAt exceeding 64 characters during encryption',
    'createdAt metadata must be a valid ISO 8601 date string'
  );

  // 11.6 Reject generator exceeding 256 characters in header during decryption
  const oversizedHeaderGeneratorPkg: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    header: {
      ...encryptedPackage.header,
      generator: 'G'.repeat(MAX_GENERATOR_LENGTH + 1),
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(oversizedHeaderGeneratorPkg, testPassword),
    'Suite 11.6: Reject oversized generator in header during decryption',
    'Header generator exceeds maximum allowed limit'
  );

  // 11.7 Reject invalid createdAt in header during decryption
  const badHeaderDatePkg: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    header: {
      ...encryptedPackage.header,
      createdAt: '2026-13-45T99:99:99.000Z',
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(badHeaderDatePkg, testPassword),
    'Suite 11.7: Reject invalid createdAt in header during decryption',
    'Header createdAt must be a valid ISO 8601 date string'
  );

  // 11.8 Reject invalid createdAt in AAD during decryption
  const badAadDatePkg: EncryptedBackupPackageV1 = {
    ...encryptedPackage,
    aad: {
      ...encryptedPackage.aad,
      createdAt: 'not-a-valid-date',
    },
  };
  await assertThrowsAsync(
    () => decryptBackup(badAadDatePkg, testPassword),
    'Suite 11.8: Reject invalid createdAt in AAD during decryption',
    'AAD createdAt must be a valid ISO 8601 date string'
  );

  // 11.9 Reject AAD exceeding MAX_AAD_BYTE_LENGTH (4096 bytes) in buildAadBuffer
  assertThrowsSync(
    () =>
      buildAadBuffer({
        appId: 'com.khalidpharmacy.app',
        format: 'KP_ENCRYPTED_BACKUP_V1',
        version: '1.0',
        createdAt: '2026-11-11T12:00:00.000Z',
        generator: 'G'.repeat(5000), // Exceeds generator limit & AAD limit
      }),
    'Suite 11.9: Reject AAD generator exceeding max generator length',
    'AAD generator must be a non-empty string not exceeding 256 characters'
  );

  // 11.10 Reject invalid Feb 31 with positive offset (2026-02-31T12:00:00+03:00)
  assert(
    !isValidIso8601Date('2026-02-31T12:00:00+03:00'),
    'Suite 11.10: isValidIso8601Date rejects 2026-02-31T12:00:00+03:00 (nonexistent February 31)'
  );
  await assertThrowsAsync(
    () =>
      encryptBackup(samplePayload, testPassword, {
        createdAt: '2026-02-31T12:00:00+03:00',
      }),
    'Suite 11.10b: encryptBackup rejects 2026-02-31T12:00:00+03:00',
    'createdAt metadata must be a valid ISO 8601 date string'
  );

  // 11.11 Reject invalid April 31 with negative offset (2026-04-31T12:00:00-05:00)
  assert(
    !isValidIso8601Date('2026-04-31T12:00:00-05:00'),
    'Suite 11.11: isValidIso8601Date rejects 2026-04-31T12:00:00-05:00 (nonexistent April 31)'
  );
  await assertThrowsAsync(
    () =>
      encryptBackup(samplePayload, testPassword, {
        createdAt: '2026-04-31T12:00:00-05:00',
      }),
    'Suite 11.11b: encryptBackup rejects 2026-04-31T12:00:00-05:00',
    'createdAt metadata must be a valid ISO 8601 date string'
  );

  // 11.12 Accept valid leap year Feb 29 (2028-02-29T12:00:00+03:00)
  assert(
    isLeapYear(2028) && getDaysInMonth(2028, 2) === 29,
    'Suite 11.12a: Leap year calculation correctly identifies 2028 as having 29 days in February'
  );
  assert(
    isValidIso8601Date('2028-02-29T12:00:00+03:00'),
    'Suite 11.12b: isValidIso8601Date accepts 2028-02-29T12:00:00+03:00 (valid leap year)'
  );
  const leapYearPkg = await encryptBackup(samplePayload, testPassword, {
    createdAt: '2028-02-29T12:00:00+03:00',
  });
  const decryptedLeapYear = await decryptBackup(leapYearPkg, testPassword);
  assert(
    decryptedLeapYear === samplePayload,
    'Suite 11.12c: encryptBackup and decryptBackup successfully process valid leap year 2028-02-29'
  );

  // 11.13 Reject non-leap year Feb 29 (2027-02-29T12:00:00+03:00)
  assert(
    !isLeapYear(2027) && getDaysInMonth(2027, 2) === 28,
    'Suite 11.13a: Leap year calculation correctly identifies 2027 as having only 28 days in February'
  );
  assert(
    !isValidIso8601Date('2027-02-29T12:00:00+03:00'),
    'Suite 11.13b: isValidIso8601Date rejects 2027-02-29T12:00:00+03:00 (non-leap year February 29)'
  );
  await assertThrowsAsync(
    () =>
      encryptBackup(samplePayload, testPassword, {
        createdAt: '2027-02-29T12:00:00+03:00',
      }),
    'Suite 11.13c: encryptBackup rejects non-leap year 2027-02-29',
    'createdAt metadata must be a valid ISO 8601 date string'
  );

  // 11.14 Accept valid date with positive offset (+03:00)
  const posOffsetPkg = await encryptBackup(samplePayload, testPassword, {
    createdAt: '2026-11-11T12:00:00+03:00',
  });
  const decryptedPos = await decryptBackup(posOffsetPkg, testPassword);
  assert(
    decryptedPos === samplePayload,
    'Suite 11.14: Round-trip encryption and decryption with positive timezone offset (+03:00)'
  );

  // 11.15 Accept valid date with negative offset (-05:00)
  const negOffsetPkg = await encryptBackup(samplePayload, testPassword, {
    createdAt: '2026-11-11T12:00:00-05:00',
  });
  const decryptedNeg = await decryptBackup(negOffsetPkg, testPassword);
  assert(
    decryptedNeg === samplePayload,
    'Suite 11.15: Round-trip encryption and decryption with negative timezone offset (-05:00)'
  );

  // -------------------------------------------------------------------------
  // SUITE 12: Centralized Limits Validation & Hard Ceiling Defenses
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 12: Centralized Limits Validation & Hard Ceiling Defenses ---');

  // 12.1 Reject NaN in numeric limits
  assertThrowsSync(
    () => validateEncryptionLimits({ maxPlaintextByteLength: NaN }),
    'Suite 12.1: Reject NaN in maxPlaintextByteLength',
    'must be a safe positive integer'
  );

  // 12.2 Reject NaN in password limits
  assertThrowsSync(
    () => validateEncryptionLimits({ minPasswordLength: NaN }),
    'Suite 12.2: Reject NaN in minPasswordLength',
    'must be a safe positive integer'
  );

  // 12.3 Reject Infinity in numeric limits
  assertThrowsSync(
    () => validateEncryptionLimits({ maxPlaintextByteLength: Infinity }),
    'Suite 12.3: Reject Infinity in maxPlaintextByteLength',
    'must be a safe positive integer'
  );

  // 12.4 Reject -Infinity in numeric limits
  assertThrowsSync(
    () => validateEncryptionLimits({ maxCiphertextByteLength: -Infinity }),
    'Suite 12.4: Reject -Infinity in maxCiphertextByteLength',
    'must be a safe positive integer'
  );

  // 12.5 Reject zero limits
  assertThrowsSync(
    () => validateEncryptionLimits({ maxPlaintextByteLength: 0 }),
    'Suite 12.5: Reject zero limit for maxPlaintextByteLength',
    'must be strictly positive (> 0)'
  );

  // 12.6 Reject negative limits
  assertThrowsSync(
    () => validateEncryptionLimits({ maxCiphertextByteLength: -100 }),
    'Suite 12.6: Reject negative limit for maxCiphertextByteLength',
    'must be strictly positive (> 0)'
  );

  // 12.7 Reject non-integer floating point limits
  assertThrowsSync(
    () => validateEncryptionLimits({ maxPlaintextByteLength: 1024.5 }),
    'Suite 12.7: Reject floating-point non-integer limit',
    'must be a safe positive integer'
  );

  // 12.8 Reject custom limits exceeding immutable hard ceiling for plaintext (500MB)
  assertThrowsSync(
    () =>
      validateEncryptionLimits({
        maxPlaintextByteLength: HARD_LIMIT_CEILINGS.MAX_PLAINTEXT_BYTES_CEILING + 1,
      }),
    'Suite 12.8: Reject custom maxPlaintextByteLength exceeding hard ceiling (500MB)',
    'exceeds immutable hard ceiling'
  );

  // 12.9 Reject custom limits exceeding immutable hard ceiling for ciphertext (750MB)
  assertThrowsSync(
    () =>
      validateEncryptionLimits({
        maxCiphertextByteLength: HARD_LIMIT_CEILINGS.MAX_CIPHERTEXT_BYTES_CEILING + 1,
      }),
    'Suite 12.9: Reject custom maxCiphertextByteLength exceeding hard ceiling (750MB)',
    'exceeds immutable hard ceiling'
  );

  // 12.10 Reject minPasswordLength below safe minimum floor of 8 characters
  assertThrowsSync(
    () => validateEncryptionLimits({ minPasswordLength: 4 }),
    'Suite 12.10: Reject minPasswordLength below minimum safe floor of 8 characters',
    'cannot be less than safe minimum (8)'
  );

  // 12.11 Reject inverted password length bounds (min > max)
  assertThrowsSync(
    () => validateEncryptionLimits({ minPasswordLength: 50, maxPasswordLength: 20 }),
    'Suite 12.11: Reject inverted password length bounds (minPasswordLength > maxPasswordLength)',
    'cannot exceed maxPasswordLength'
  );

  // 12.12 Reject non-object limits parameter (string, array, boolean, number)
  assertThrowsSync(
    () => validateEncryptionLimits('invalid-limits' as any),
    'Suite 12.12a: Reject string limits parameter',
    'limits must be an object'
  );
  assertThrowsSync(
    () => validateEncryptionLimits([1, 2, 3] as any),
    'Suite 12.12b: Reject array limits parameter',
    'limits must be an object'
  );
  assertThrowsSync(
    () => validateEncryptionLimits(12345 as any),
    'Suite 12.12c: Reject numeric primitive limits parameter',
    'limits must be an object'
  );

  // 12.13 Explicitly reject null in limits
  assertThrowsSync(
    () => validateEncryptionLimits(null as any),
    'Suite 12.13a: Reject null explicitly in validateEncryptionLimits',
    'limits cannot be null'
  );
  await assertThrowsAsync(
    () => encryptBackup(samplePayload, testPassword, { limits: null as any }),
    'Suite 12.13b: Reject null in options.limits during encryptBackup',
    'limits cannot be null'
  );
  await assertThrowsAsync(
    () => decryptBackup(encryptedPackage, testPassword, { limits: null as any }),
    'Suite 12.13c: Reject null in options.limits during decryptBackup',
    'limits cannot be null'
  );

  // 12.14 Accept undefined in validateEncryptionLimits and return default limits
  const defaultLimitsReturned = validateEncryptionLimits(undefined);
  assert(
    defaultLimitsReturned.maxPlaintextByteLength === 100 * 1024 * 1024 &&
      defaultLimitsReturned.minPasswordLength === 8 &&
      defaultLimitsReturned.maxPasswordLength === 1024,
    'Suite 12.14: validateEncryptionLimits(undefined) returns exact default limits'
  );

  // 12.15 Accept valid custom limits within safe boundaries
  const validCustomLimits = validateEncryptionLimits({
    maxPlaintextByteLength: 50 * 1024 * 1024,
    maxCiphertextByteLength: 80 * 1024 * 1024,
    minPasswordLength: 12,
    maxPasswordLength: 512,
  });
  assert(
    validCustomLimits.maxPlaintextByteLength === 50 * 1024 * 1024 &&
      validCustomLimits.minPasswordLength === 12 &&
      validCustomLimits.maxPasswordLength === 512,
    'Suite 12.15: Accept valid custom limits within safe bounds'
  );

  // 12.16 Continued success of end-to-end encryption/decryption with valid custom limits
  const customLimitsPackage = await encryptBackup(samplePayload, testPassword, {
    limits: {
      minPasswordLength: 10,
      maxPlaintextByteLength: 10 * 1024 * 1024,
    },
  });
  const decryptedWithCustomLimits = await decryptBackup(customLimitsPackage, testPassword, {
    limits: {
      maxCiphertextByteLength: 20 * 1024 * 1024,
    },
  });
  assert(
    decryptedWithCustomLimits === samplePayload,
    'Suite 12.16: Continued full end-to-end success of encryption and decryption with custom limits'
  );

  // -------------------------------------------------------------------------
  // SUITE 13: Uint8Array Input Isolation & Memory Zeroing Guarantees
  // -------------------------------------------------------------------------
  console.log('\n--- Suite 13: Uint8Array Input Isolation & Memory Zeroing Guarantees ---');

  // 13.1 Modifying caller's original Uint8Array after passing to encryptBackup does NOT alter encrypted data
  const rawOriginalData = new TextEncoder().encode('ConfidentialMedicalData2026-Original');
  const callerArray = new Uint8Array(rawOriginalData.byteLength);
  callerArray.set(rawOriginalData);

  // Launch encryption (PBKDF2 runs asynchronously in worker thread)
  const isolatedEncryptionPromise = encryptBackup(callerArray, testPassword);

  // Concurrently mutate caller's array immediately after launching
  callerArray[0] = 0x58; // 'X'
  callerArray[1] = 0x58; // 'X'
  callerArray[2] = 0x58; // 'X'

  const isolatedPackage = await isolatedEncryptionPromise;
  const decryptedIsolated = await decryptBackup(isolatedPackage, testPassword);
  assert(
    decryptedIsolated === 'ConfidentialMedicalData2026-Original',
    'Suite 13.1: Defensive copy ensures mutating caller array does NOT alter ciphertext content'
  );

  // 13.2 Verify caller array is retained by caller and not zeroed out by encryptBackup
  const callerDataCheck = new TextEncoder().encode('CallerPreservedBufferTest');
  await encryptBackup(callerDataCheck, testPassword);
  assert(
    new TextDecoder().decode(callerDataCheck) === 'CallerPreservedBufferTest',
    'Suite 13.2: Caller original Uint8Array remains intact and is not zeroed out by encryption'
  );

  // 13.3 Observe the exact plaintext Uint8Array passed to WebCrypto and verify
  // that encryptBackup zeroes that same internal buffer after successful encryption.
  const subtle = crypto.subtle;
  const originalEncrypt = subtle.encrypt.bind(subtle);
  const originalEncryptDescriptor = Object.getOwnPropertyDescriptor(subtle, 'encrypt');
  let capturedPlaintextBuffer: Uint8Array | null = null;
  // Read through a function so TypeScript does not incorrectly treat callback-mutated state as permanently null.
  const getCapturedPlaintextBuffer = (): Uint8Array | null => capturedPlaintextBuffer;
  let forceWebCryptoFailure = false;

  Object.defineProperty(subtle, 'encrypt', {
    configurable: true,
    writable: true,
    value: async (...args: any[]) => {
      // encryptBackup passes its private defensive Uint8Array as the third argument.
      capturedPlaintextBuffer = args[2] as Uint8Array;
      if (!(capturedPlaintextBuffer instanceof Uint8Array)) {
        throw new Error('Test harness expected a Uint8Array plaintext BufferSource');
      }
      if (forceWebCryptoFailure) {
        throw new Error('Intentional WebCrypto failure for memory-zeroing test');
      }
      return originalEncrypt(args[0], args[1], args[2]);
    },
  });

  try {
    const successPayload = new TextEncoder().encode('ZeroThisInternalPlaintextOnSuccess');
    const successPackage = await encryptBackup(successPayload, testPassword);
    const capturedAfterSuccess = getCapturedPlaintextBuffer();
    assert(
      capturedAfterSuccess instanceof Uint8Array &&
        capturedAfterSuccess.length === successPayload.length &&
        capturedAfterSuccess.every((byte: number) => byte === 0),
      'Suite 13.3: The exact internal plaintext buffer passed to WebCrypto is zeroed after successful encryption'
    );
    assert(
      (await decryptBackup(successPackage, testPassword)) === 'ZeroThisInternalPlaintextOnSuccess',
      'Suite 13.4: Instrumented successful encryption still produces a valid decryptable package'
    );

    // Force the WebCrypto call itself to fail after the internal buffer has been captured.
    capturedPlaintextBuffer = null;
    forceWebCryptoFailure = true;
    await assertThrowsAsync(
      () => encryptBackup('ZeroThisInternalPlaintextOnFailure', testPassword),
      'Suite 13.5: Forced WebCrypto failure is propagated',
      'Intentional WebCrypto failure for memory-zeroing test'
    );
    const capturedAfterFailure = getCapturedPlaintextBuffer();
    assert(
      capturedAfterFailure instanceof Uint8Array &&
        capturedAfterFailure.length > 0 &&
        capturedAfterFailure.every((byte: number) => byte === 0),
      'Suite 13.6: The exact internal plaintext buffer passed to failing WebCrypto is zeroed in finally'
    );
  } finally {
    // Restore the native WebCrypto method so the remaining process is unaffected.
    if (originalEncryptDescriptor) {
      Object.defineProperty(subtle, 'encrypt', originalEncryptDescriptor);
    } else {
      delete (subtle as any).encrypt;
    }
  }

  // -------------------------------------------------------------------------
  // TEST SUMMARY
  // -------------------------------------------------------------------------
  console.log('\n======================================================================');
  console.log(`TOTAL TESTS EXECUTED : ${totalTests}`);
  console.log(`PASSED               : ${passedTests}`);
  console.log(`FAILED               : ${failedTests}`);
  console.log('======================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled Test Execution Error in Backup Encryption Suite:', err);
  process.exit(1);
});
