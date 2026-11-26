/**
 * Barcode Validation & Format Detection Engine
 * Validates check digits for standard pharmaceutical and retail barcode symbologies:
 * EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, ITF
 */

import type { BarcodeType, BarcodeValidationResult } from '../types/barcode';

/**
 * Validates check digit of EAN-13 barcode
 */
export function validateEan13(barcode: string): boolean {
  if (!/^\d{13}$/.test(barcode)) return false;
  
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(barcode[i], 10);
    sum += (i % 2 === 0) ? digit : digit * 3;
  }
  
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(barcode[12], 10);
}

/**
 * Validates check digit of EAN-8 barcode
 */
export function validateEan8(barcode: string): boolean {
  if (!/^\d{8}$/.test(barcode)) return false;

  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const digit = parseInt(barcode[i], 10);
    sum += (i % 2 === 0) ? digit * 3 : digit;
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(barcode[7], 10);
}

/**
 * Validates check digit of UPC-A barcode
 */
export function validateUpcA(barcode: string): boolean {
  if (!/^\d{12}$/.test(barcode)) return false;

  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const digit = parseInt(barcode[i], 10);
    sum += (i % 2 === 0) ? digit * 3 : digit;
  }

  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(barcode[11], 10);
}

/**
 * Validates Code 39 barcode (allowed characters: A-Z, 0-9, -, ., $, /, +, %, space)
 */
export function validateCode39(barcode: string): boolean {
  const cleaned = barcode.startsWith('*') && barcode.endsWith('*') && barcode.length > 2
    ? barcode.slice(1, -1)
    : barcode;
  return /^[A-Z0-9\-. $/+%]+$/.test(cleaned) && cleaned.length >= 1;
}

/**
 * Validates Code 128 barcode (standard ASCII printable characters)
 */
export function validateCode128(barcode: string): boolean {
  // Code 128 supports ASCII 32 to 126
  return /^[\x20-\x7E]{1,80}$/.test(barcode);
}

/**
 * Validates ITF (Interleaved 2 of 5) barcode (numeric, even length >= 4)
 */
export function validateItf(barcode: string): boolean {
  return /^\d{4,30}$/.test(barcode) && barcode.length % 2 === 0;
}

/**
 * Detects symbology and validates checksum/format of any candidate barcode
 */
export function validateBarcode(rawInput: string): BarcodeValidationResult {
  if (!rawInput || typeof rawInput !== 'string') {
    return {
      isValid: false,
      type: 'UNKNOWN',
      normalizedBarcode: '',
      errorMessage: 'رمز الباركود فارغ'
    };
  }

  const normalized = rawInput.trim();
  if (normalized.length === 0) {
    return {
      isValid: false,
      type: 'UNKNOWN',
      normalizedBarcode: '',
      errorMessage: 'رمز الباركود فارغ'
    };
  }

  // Check EAN-13
  if (/^\d{13}$/.test(normalized)) {
    if (validateEan13(normalized)) {
      return { isValid: true, type: 'EAN-13', normalizedBarcode: normalized };
    }
    return {
      isValid: false,
      type: 'EAN-13',
      normalizedBarcode: normalized,
      errorMessage: 'رقم التحقق (Check Digit) لباركود EAN-13 غير صحيح'
    };
  }

  // Check UPC-A (12 digits)
  if (/^\d{12}$/.test(normalized)) {
    if (validateUpcA(normalized)) {
      return { isValid: true, type: 'UPC-A', normalizedBarcode: normalized };
    }
    // Also consider as raw Code 128 if checksum fails
    if (validateCode128(normalized)) {
      return { isValid: true, type: 'CODE-128', normalizedBarcode: normalized };
    }
  }

  // Check EAN-8 (8 digits)
  if (/^\d{8}$/.test(normalized)) {
    if (validateEan8(normalized)) {
      return { isValid: true, type: 'EAN-8', normalizedBarcode: normalized };
    }
    if (validateCode128(normalized)) {
      return { isValid: true, type: 'CODE-128', normalizedBarcode: normalized };
    }
  }

  // Check ITF (Interleaved 2 of 5 - 14 digits is typical ITF-14 for medicine cartons)
  if (/^\d{6,30}$/.test(normalized) && normalized.length % 2 === 0) {
    return { isValid: true, type: 'ITF', normalizedBarcode: normalized };
  }

  // Check Code 39 with explicit asterisks e.g. *CODE39*
  if (normalized.startsWith('*') && normalized.endsWith('*') && normalized.length > 2) {
    const clean = normalized.slice(1, -1);
    if (validateCode39(clean)) {
      return { isValid: true, type: 'CODE-39', normalizedBarcode: clean };
    }
  }

  // Check Code 128 (supports full ASCII including lowercase, numbers, symbols)
  if (validateCode128(normalized)) {
    return { isValid: true, type: 'CODE-128', normalizedBarcode: normalized };
  }

  // Check Code 39 without asterisks
  if (validateCode39(normalized)) {
    return { isValid: true, type: 'CODE-39', normalizedBarcode: normalized };
  }

  // General alphanumeric fallback for pharmacy internal codes (e.g. "6285001", "MED123456")
  if (/^[A-Za-z0-9\-_]{3,40}$/.test(normalized)) {
    return { isValid: true, type: 'CODE-128', normalizedBarcode: normalized };
  }

  return {
    isValid: false,
    type: 'UNKNOWN',
    normalizedBarcode: normalized,
    errorMessage: 'صيغة الباركود غير معتمدة أو تحتوي رموزاً غير مقروءة'
  };
}
