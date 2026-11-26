/**
 * Types for Barcode Scanning, Validation, and Stocktaking System (Phase 5)
 */

export type BarcodeType = 
  | 'EAN-13'
  | 'EAN-8'
  | 'UPC-A'
  | 'UPC-E'
  | 'CODE-128'
  | 'CODE-39'
  | 'ITF'
  | 'UNKNOWN';

export interface BarcodeValidationResult {
  isValid: boolean;
  type: BarcodeType;
  normalizedBarcode: string;
  errorMessage?: string;
}

export interface BarcodeScanEvent {
  barcode: string;
  type: BarcodeType;
  timestamp: number;
}

export interface StocktakingItem {
  id?: string;
  medicineId: string;
  medicineName: string;
  barcode: string;
  secondaryBarcodes?: string[];
  category?: string;
  unit: 'pack' | 'strip' | 'pill';
  batchNumber?: string;
  expiry?: string;
  systemStock: number;
  actualCount: number;
  variance: number;
  variancePacks?: number;
  buyPrice: number;
  sellPrice?: number;
  varianceSDG: number;
  varianceCost?: number;
  lastScannedAt: string;
  notes?: string;

  // Compatibility aliases
  systemQuantity?: number;
  countedQuantity?: number;
  varianceQuantity?: number;
}

export type StocktakingSessionStatus = 
  | 'in_progress' 
  | 'reviewing' 
  | 'committed' 
  | 'cancelled'
  | 'IN_PROGRESS'
  | 'COMMITTED'
  | 'CANCELLED';

export interface StocktakingSession {
  id: string;
  sessionNumber: string;
  status: StocktakingSessionStatus;
  startedAt: string;
  startedBy?: string;
  committedAt?: string;
  committedBy?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  auditReason?: string;
  employeeName?: string;
  deviceId: string;
  notes?: string;
  items: StocktakingItem[];
  totalScanned?: number;
  itemsWithVariance?: number;
  netVarianceSDG?: number;
  totalItemsCount?: number;
  matchedItemsCount?: number;
  surplusItemsCount?: number;
  deficitItemsCount?: number;
  totalVarianceCost?: number;
  adjustmentLedgerIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}
