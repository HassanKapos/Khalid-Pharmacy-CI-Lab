import './index.css';
import * as Vue from 'vue';
import { lucideProxy } from './services/icons';
import { registerPlugin } from '@capacitor/core';
import {
  addBatchStock,
  addSecondaryBarcode,
  calculateInventoryValuation,
  cancelStocktakingSession,
  canDeleteSupplier,
  checkBarcodeUnique,
  checkOverAllocationWarnings,
  checkReceiptFinancialLink,
  checkSupplierInvoiceDuplicate,
  commitStocktakingSession,
  confirmServerTombstoneSync,
  createStocktakingSession,
  createVerifiedMedicine,
  deleteBankakReceiptWithTombstone,
  deleteSupplier,
  deleteSupplierInvoiceDraft,
  downloadSupplierStatementPdf,
  executeSale,
  findDraftByImageHash,
  findMedicineByBarcode,
  generateUUID,
  getActiveBranchId,
  getActiveStocktakingSession,
  getAllCategories,
  getAllMedicinesWithLiveStock,
  getAllPurchaseInvoices,
  getAllSales,
  getAllStocktakingSessions,
  getAllSupplierInvoiceDrafts,
  getAllSupplierPayments,
  getAllSuppliers,
  getBankakTombstones,
  getDeviceId,
  getLedgerMovements,
  getMedicineUnitSellingPrice,
  getOutboxPendingCount,
  getSupplierById,
  getSupplierPaymentById,
  getSupplierStatement,
  initializeAndMigrate,
  onBranchContextChange,
  postPurchaseInvoice,
  recordStocktakingItem,
  recordSupplierPayment,
  removeStocktakingItem,
  reverseSupplierPayment,
  reviewAndPostOpeningBalance,
  saveCategory,
  saveMedicine,
  saveSupplier,
  setActiveBranchContext,
  syncPendingBankakTombstones,
  toggleSupplierStatus,
  updateSupplier,
  verifyMedicineUnitConfiguration,
} from './services/pharmacyDb';
import * as SupplierInvoiceOcrService from './services/supplierInvoiceOcrService';
import { BarcodeScannerService, barcodeScannerService } from './services/barcodeScannerService';
import { validateBarcode } from './services/barcodeValidator';

import { mlKitPocService } from './services/mlKitPocService';
import { UnifiedScannerService, unifiedScannerService } from './services/unifiedScannerService';
import * as SmartPricingService from './services/smartPricingService';
import { medicineTextRecognitionService } from './services/medicineTextRecognitionService';
import * as MedicineTextParser from './services/medicineTextParser';
import { apiClient, ApiClient, ApiClientError } from './services/apiClient';
import { batchCaptureService, BatchCaptureService } from './services/batchCaptureService';
import { singleImageSegmentationService, SingleImageSegmentationService } from './services/singleImageSegmentationService';
import { staticImageBarcodeService } from './services/staticImageBarcodeService';
import * as GoogleDriveOAuthService from './services/googleDriveOAuthService';
import { googleDriveBackupService, GoogleDriveBackupService } from './services/googleDriveBackupService';
import { errorLogService } from './services/errorLogService';
import {
  canSessionPerformAdminOperation,
  canSessionPerformPosOperation,
  getCurrentIdToken,
  isOfflineSessionExpired,
  observePharmacyAuth,
  reverifyCurrentPharmacySession,
  signInPharmacyUser,
  signInWithGoogle,
  signOutPharmacyUser,
  updateActiveBranchPreference,
} from './services/firebaseAuthService';
import * as BranchSyncService from './services/branchSyncService';
import {
  getUnitMigrationStatus,
  pauseUnitMigration,
  resumeUnitMigration,
  startUnitMigration,
} from './services/unitMigrationService';

export interface UnitMigrationPublicFacade {
  readonly getStatus: typeof getUnitMigrationStatus;
  readonly startMigration: typeof startUnitMigration;
  readonly resumeMigration: typeof resumeUnitMigration;
  readonly pauseMigration: typeof pauseUnitMigration;
}

export interface FirebaseAuthPublicFacade {
  readonly observePharmacyAuth: typeof observePharmacyAuth;
  readonly signInPharmacyUser: typeof signInPharmacyUser;
  readonly signInWithGoogle: typeof signInWithGoogle;
  readonly signOutPharmacyUser: typeof signOutPharmacyUser;
  readonly reverifyCurrentPharmacySession: typeof reverifyCurrentPharmacySession;
  readonly getCurrentIdToken: typeof getCurrentIdToken;
  readonly updateActiveBranchPreference: typeof updateActiveBranchPreference;
  readonly isOfflineSessionExpired: typeof isOfflineSessionExpired;
  readonly canSessionPerformAdminOperation: typeof canSessionPerformAdminOperation;
  readonly canSessionPerformPosOperation: typeof canSessionPerformPosOperation;
}

export interface PharmacyDBPublicFacade {
  readonly addBatchStock: typeof addBatchStock;
  readonly addSecondaryBarcode: typeof addSecondaryBarcode;
  readonly calculateInventoryValuation: typeof calculateInventoryValuation;
  readonly cancelStocktakingSession: typeof cancelStocktakingSession;
  readonly canDeleteSupplier: typeof canDeleteSupplier;
  readonly checkBarcodeUnique: typeof checkBarcodeUnique;
  readonly checkOverAllocationWarnings: typeof checkOverAllocationWarnings;
  readonly checkReceiptFinancialLink: typeof checkReceiptFinancialLink;
  readonly checkSupplierInvoiceDuplicate: typeof checkSupplierInvoiceDuplicate;
  readonly commitStocktakingSession: typeof commitStocktakingSession;
  readonly confirmServerTombstoneSync: typeof confirmServerTombstoneSync;
  readonly createStocktakingSession: typeof createStocktakingSession;
  readonly createVerifiedMedicine: typeof createVerifiedMedicine;
  readonly deleteBankakReceiptWithTombstone: typeof deleteBankakReceiptWithTombstone;
  readonly deleteSupplier: typeof deleteSupplier;
  readonly deleteSupplierInvoiceDraft: typeof deleteSupplierInvoiceDraft;
  readonly downloadSupplierStatementPdf: typeof downloadSupplierStatementPdf;
  readonly executeSale: typeof executeSale;
  readonly findDraftByImageHash: typeof findDraftByImageHash;
  readonly findMedicineByBarcode: typeof findMedicineByBarcode;
  readonly generateUUID: typeof generateUUID;
  readonly getActiveBranchId: typeof getActiveBranchId;
  readonly getActiveStocktakingSession: typeof getActiveStocktakingSession;
  readonly getAllCategories: typeof getAllCategories;
  readonly getAllMedicinesWithLiveStock: typeof getAllMedicinesWithLiveStock;
  readonly getAllPurchaseInvoices: typeof getAllPurchaseInvoices;
  readonly getAllSales: typeof getAllSales;
  readonly getAllStocktakingSessions: typeof getAllStocktakingSessions;
  readonly getAllSupplierInvoiceDrafts: typeof getAllSupplierInvoiceDrafts;
  readonly getAllSupplierPayments: typeof getAllSupplierPayments;
  readonly getAllSuppliers: typeof getAllSuppliers;
  readonly getBankakTombstones: typeof getBankakTombstones;
  readonly getDeviceId: typeof getDeviceId;
  readonly getLedgerMovements: typeof getLedgerMovements;
  readonly getMedicineUnitSellingPrice: typeof getMedicineUnitSellingPrice;
  readonly getOutboxPendingCount: typeof getOutboxPendingCount;
  readonly getSupplierById: typeof getSupplierById;
  readonly getSupplierPaymentById: typeof getSupplierPaymentById;
  readonly getSupplierStatement: typeof getSupplierStatement;
  readonly initializeAndMigrate: typeof initializeAndMigrate;
  readonly onBranchContextChange: typeof onBranchContextChange;
  readonly postPurchaseInvoice: typeof postPurchaseInvoice;
  readonly recordStocktakingItem: typeof recordStocktakingItem;
  readonly recordSupplierPayment: typeof recordSupplierPayment;
  readonly removeStocktakingItem: typeof removeStocktakingItem;
  readonly reverseSupplierPayment: typeof reverseSupplierPayment;
  readonly reviewAndPostOpeningBalance: typeof reviewAndPostOpeningBalance;
  readonly saveCategory: typeof saveCategory;
  readonly saveMedicine: typeof saveMedicine;
  readonly saveSupplier: typeof saveSupplier;
  readonly setActiveBranchContext: typeof setActiveBranchContext;
  readonly syncPendingBankakTombstones: typeof syncPendingBankakTombstones;
  readonly toggleSupplierStatus: typeof toggleSupplierStatus;
  readonly updateSupplier: typeof updateSupplier;
  readonly verifyMedicineUnitConfiguration: typeof verifyMedicineUnitConfiguration;
}

declare global {
  interface Window {
    Vue: typeof Vue;
    lucide: typeof lucideProxy;
    PharmacyDB: PharmacyDBPublicFacade;
    SmartPricingService: typeof SmartPricingService;
    SupplierInvoiceOcrService: typeof SupplierInvoiceOcrService;
    BarcodeScannerService: typeof BarcodeScannerService;
    barcodeScannerService: typeof barcodeScannerService;
    validateBarcode: typeof validateBarcode;
    medicineTextRecognitionService: typeof medicineTextRecognitionService;
    MedicineTextParser: typeof MedicineTextParser;
    batchCaptureService: typeof batchCaptureService;
    BatchCaptureService: typeof BatchCaptureService;
    singleImageSegmentationService: typeof singleImageSegmentationService;
    SingleImageSegmentationService: typeof SingleImageSegmentationService;
    staticImageBarcodeService: typeof staticImageBarcodeService;
    mlKitPocService: typeof mlKitPocService;
    UnifiedScannerService: typeof UnifiedScannerService;
    unifiedScannerService: typeof unifiedScannerService;
    apiClient: typeof apiClient;
    ApiClient: typeof ApiClient;
    ApiClientError: typeof ApiClientError;
    GoogleDriveOAuthService: typeof GoogleDriveOAuthService;
    googleDriveBackupService: typeof googleDriveBackupService;
    GoogleDriveBackupService: typeof GoogleDriveBackupService;
    ErrorLogService: typeof errorLogService;
    FirebaseAuthService: FirebaseAuthPublicFacade;
    BranchSyncService: typeof BranchSyncService;
    UnitMigrationService: UnitMigrationPublicFacade;
    AndroidNavigation: { exitApp: () => Promise<void> };
    BankakOptimizer?: unknown;
    loadBankakOptimizerModule?: () => Promise<unknown>;
    mountKhalidApp?: () => void;
    __khalid_mounted?: boolean;
    __bankak_optimizer_module?: unknown;
  }
}

// Make core dependencies available immediately for fast POS boot
window.AndroidNavigation = registerPlugin<{ exitApp: () => Promise<void> }>('AndroidNavigation');
window.Vue = Vue;
window.lucide = lucideProxy;
window.PharmacyDB = Object.freeze({
  addBatchStock,
  addSecondaryBarcode,
  calculateInventoryValuation,
  cancelStocktakingSession,
  canDeleteSupplier,
  checkBarcodeUnique,
  checkOverAllocationWarnings,
  checkReceiptFinancialLink,
  checkSupplierInvoiceDuplicate,
  commitStocktakingSession,
  confirmServerTombstoneSync,
  createStocktakingSession,
  createVerifiedMedicine,
  deleteBankakReceiptWithTombstone,
  deleteSupplier,
  deleteSupplierInvoiceDraft,
  downloadSupplierStatementPdf,
  executeSale,
  findDraftByImageHash,
  findMedicineByBarcode,
  generateUUID,
  getActiveBranchId,
  getActiveStocktakingSession,
  getAllCategories,
  getAllMedicinesWithLiveStock,
  getAllPurchaseInvoices,
  getAllSales,
  getAllStocktakingSessions,
  getAllSupplierInvoiceDrafts,
  getAllSupplierPayments,
  getAllSuppliers,
  getBankakTombstones,
  getDeviceId,
  getLedgerMovements,
  getMedicineUnitSellingPrice,
  getOutboxPendingCount,
  getSupplierById,
  getSupplierPaymentById,
  getSupplierStatement,
  initializeAndMigrate,
  onBranchContextChange,
  postPurchaseInvoice,
  recordStocktakingItem,
  recordSupplierPayment,
  removeStocktakingItem,
  reverseSupplierPayment,
  reviewAndPostOpeningBalance,
  saveCategory,
  saveMedicine,
  saveSupplier,
  setActiveBranchContext,
  syncPendingBankakTombstones,
  toggleSupplierStatus,
  updateSupplier,
  verifyMedicineUnitConfiguration,
});
window.SmartPricingService = SmartPricingService;
window.SupplierInvoiceOcrService = SupplierInvoiceOcrService;
window.BarcodeScannerService = BarcodeScannerService;
window.barcodeScannerService = barcodeScannerService;
window.validateBarcode = validateBarcode;
window.medicineTextRecognitionService = medicineTextRecognitionService;
window.MedicineTextParser = MedicineTextParser;
window.batchCaptureService = batchCaptureService;
window.BatchCaptureService = BatchCaptureService;
window.singleImageSegmentationService = singleImageSegmentationService;
window.SingleImageSegmentationService = SingleImageSegmentationService;
window.staticImageBarcodeService = staticImageBarcodeService;
batchCaptureService.setAutoPersist(true);
window.mlKitPocService = mlKitPocService;
window.UnifiedScannerService = UnifiedScannerService;
window.unifiedScannerService = unifiedScannerService;
window.apiClient = apiClient;
window.ApiClient = ApiClient;
window.ApiClientError = ApiClientError;
window.GoogleDriveOAuthService = GoogleDriveOAuthService;
window.googleDriveBackupService = googleDriveBackupService;
window.GoogleDriveBackupService = GoogleDriveBackupService;
window.ErrorLogService = errorLogService;
window.FirebaseAuthService = Object.freeze({
  observePharmacyAuth,
  signInPharmacyUser,
  signInWithGoogle,
  signOutPharmacyUser,
  reverifyCurrentPharmacySession,
  getCurrentIdToken,
  updateActiveBranchPreference,
  isOfflineSessionExpired,
  canSessionPerformAdminOperation,
  canSessionPerformPosOperation,
});
window.BranchSyncService = BranchSyncService;
window.UnitMigrationService = Object.freeze({
  getStatus: getUnitMigrationStatus,
  startMigration: startUnitMigration,
  resumeMigration: resumeUnitMigration,
  pauseMigration: pauseUnitMigration,
});
errorLogService.installGlobalHandlers();

// Dynamic Lazy Loader for BankakOptimizer: Loads image compression & hashing only when Bankak Archive is opened
window.loadBankakOptimizerModule = async () => {
  if (window.__bankak_optimizer_module) {
    return window.__bankak_optimizer_module;
  }
  const mod = await import('./services/bankakOptimizer');
  window.BankakOptimizer = mod;
  window.__bankak_optimizer_module = mod;
  return mod;
};

// If the app definition in index.html is ready, mount it immediately
if (typeof window.mountKhalidApp === 'function' && !window.__khalid_mounted) {
  window.mountKhalidApp();
}

// Ensure icons render once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  if (typeof lucideProxy.createIcons === 'function') {
    try {
      lucideProxy.createIcons();
    } catch {
      // safe fallback
    }
  }
});
