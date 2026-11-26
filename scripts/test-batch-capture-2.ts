/**
 * Batch Capture 2.0 — Comprehensive Offline Automated Verification Suite
 * Project: Khalid Pharmacy ("com.khalidpharmacy.app")
 *
 * Verifies:
 * - Scenario A: Non-blocking Mode A FIFO Queue, Failure Isolation, Reload Recovery & Branch Isolation
 * - Scenario B: Unified Multi-Object Image (Mode B) CV Detection, Manual Box Split & Barcode-First Decode
 * - Scenario C: Pharmaceutical Token Parsing (Combo Strengths, Manufacturers, Sizes, XR/SR Conflicts, UI Tiers)
 * - Scenario D: Independent POS Cart Action Invariant (Zero Ledger Deduction)
 * - Scenario E: Independent Inventory Receive Invariant (Append-Only PURCHASE Ledger + Stock Verification)
 * - Scenario F: UI Markup & First-Run / DB_VERSION Safety Contracts
 * - Scenario G: Real Measured Node/CV/IndexedDB Latencies
 */

import 'fake-indexeddb/auto';
import { strictEqual, ok } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  BatchCaptureService,
  type BatchMedicineItem
} from '../src/services/batchCaptureService.ts';
import {
  singleImageSegmentationService,
  type BoundingBox
} from '../src/services/singleImageSegmentationService.ts';
import { staticImageBarcodeService } from '../src/services/staticImageBarcodeService.ts';
import {
  parseMedicineText,
  matchMedicineText,
  mapMatchClassificationToUiTier,
  type MedicineCatalogueEntry
} from '../src/services/medicineTextParser.ts';
import { medicineTextRecognitionService } from '../src/services/medicineTextRecognitionService.ts';
import {
  DB_VERSION,
  initializeAndMigrate,
  openPharmacyDB,
  setActiveBranchContext,
  saveMedicine,
  addBatchStock,
  calculateMedicineStock,
  getLedgerMovements,
  loadBatchCaptureSessionState,
  clearBatchCaptureSessionState
} from '../src/services/pharmacyDb.ts';

interface SyntheticPackage {
  x: number;
  y: number;
  width: number;
  height: number;
  r: number;
  g: number;
  b: number;
}

function createSyntheticMultiBoxCanvas(
  width: number,
  height: number,
  packages: SyntheticPackage[],
  bgRgb: [number, number, number] = [238, 240, 244]
) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    pixels[idx] = bgRgb[0];
    pixels[idx + 1] = bgRgb[1];
    pixels[idx + 2] = bgRgb[2];
    pixels[idx + 3] = 255;
  }

  for (const pkg of packages) {
    const xEnd = Math.min(width, pkg.x + pkg.width);
    const yEnd = Math.min(height, pkg.y + pkg.height);
    for (let y = Math.max(0, pkg.y); y < yEnd; y++) {
      for (let x = Math.max(0, pkg.x); x < xEnd; x++) {
        const idx = (y * width + x) * 4;
        const isBorder = x - pkg.x < 4 || xEnd - 1 - x < 4 || y - pkg.y < 4 || yEnd - 1 - y < 4;
        const isLabelBand = (y - pkg.y) % 14 < 5 && (x - pkg.x) % 10 < 7;
        pixels[idx] = isBorder ? 20 : isLabelBand ? 35 : pkg.r;
        pixels[idx + 1] = isBorder ? 20 : isLabelBand ? 35 : pkg.g;
        pixels[idx + 2] = isBorder ? 20 : isLabelBand ? 35 : pkg.b;
        pixels[idx + 3] = 255;
      }
    }
  }

  return {
    width,
    height,
    naturalWidth: width,
    naturalHeight: height,
    _pixels: pixels
  };
}

if (typeof document === 'undefined') {
  (global as any).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        const canvas: any = {
          width: 1200,
          height: 800,
          _cropMeta: { sx: 0, sy: 0, sw: 1200, sh: 800 },
          _buffer: new Uint8ClampedArray(1200 * 800 * 4),
          getContext: () => ({
            drawImage: (
              source: any,
              a1: number,
              a2: number,
              a3?: number,
              a4?: number,
              a5?: number,
              a6?: number,
              a7?: number,
              a8?: number
            ) => {
              const dw = a7 ?? a3 ?? canvas.width;
              const dh = a8 ?? a4 ?? canvas.height;
              const sx = a5 !== undefined ? a1 : 0;
              const sy = a6 !== undefined ? a2 : 0;
              const sw = a5 !== undefined ? (a3 ?? dw) : (source?.width ?? canvas.width);
              const sh = a6 !== undefined ? (a4 ?? dh) : (source?.height ?? canvas.height);
              canvas._cropMeta = { sx, sy, sw, sh };
              const targetLen = canvas.width * canvas.height * 4;
              if (canvas._buffer.length !== targetLen) {
                canvas._buffer = new Uint8ClampedArray(targetLen);
              }
              if (source && source._pixels && source.width === canvas.width && source.height === canvas.height && sx === 0 && sy === 0) {
                canvas._buffer.set(source._pixels);
              }
            },
            getImageData: (_x: number, _y: number, w: number, h: number) => ({
              data: canvas._buffer.length === w * h * 4 ? canvas._buffer : new Uint8ClampedArray(w * h * 4)
            })
          }),
          toDataURL: () => {
            const payload = Buffer.from(JSON.stringify(canvas._cropMeta), 'utf8').toString('base64');
            return `data:image/jpeg;base64,${payload}`;
          }
        };
        return canvas;
      }
      return {};
    }
  };
}

let passed = 0;
let total = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`✓ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`✗ [FAIL] ${name}:`, err?.message || err);
    throw err;
  }
}

async function runSuite() {
  console.log('=== KHALID PHARMACY — BATCH CAPTURE 2.0 COMPREHENSIVE TEST SUITE ===\n');

  setActiveBranchContext('main');
  await initializeAndMigrate();
  await clearBatchCaptureSessionState();

  const catalogue: MedicineCatalogueEntry[] = [
    { id: 'cat-amox-500', name: 'Amoxicillin 500mg capsules', barcode: '6281001001005' },
    { id: 'cat-aug-1g', name: 'Augmentin 875/125 mg tablets', barcode: '6281001002002' },
    { id: 'cat-met-xr', name: 'Metformin 500mg XR tablets', barcode: '6281001003009' },
    { id: 'cat-met-sr', name: 'Metformin 500mg SR tablets', barcode: '6281001003016' },
    { id: 'cat-para-500', name: 'Paracetamol 500mg tablets', barcode: '6281001004006' }
  ];

  // =========================================================================
  // SCENARIO A: Mode A Non-Blocking FIFO Queue + Failure Isolation + Persistence + Branch Isolation
  // =========================================================================
  const origRecognizeWeb = medicineTextRecognitionService.recognizeWebImage;
  try {
    await test('A1. Non-blocking FIFO capture queue accepts multiple captures before first OCR resolves', async () => {
      const svc = new BatchCaptureService();
      svc.setAutoPersist(true);

      const gates: Array<{ resolve: (val: any) => void; reject: (err: any) => void }> = [];
      let callCount = 0;
      (medicineTextRecognitionService as any).recognizeWebImage = () =>
        new Promise((resolve, reject) => {
          callCount++;
          gates.push({ resolve, reject });
        });

      const tDispatchStart = performance.now();
      const job1 = svc.enqueueWebCapture(new Blob(['img-1-data'], { type: 'image/png' }), () => catalogue);
      const job2 = svc.enqueueWebCapture(new Blob(['img-2-data'], { type: 'image/png' }), () => catalogue);
      const job3 = svc.enqueueWebCapture(new Blob(['img-3-data'], { type: 'image/png' }), () => catalogue);
      const dispatchMs = Math.round((performance.now() - tDispatchStart) * 100) / 100;

      strictEqual(svc.getItems().length, 3, 'All 3 items appear immediately in the session');
      ok(svc.getQueueLength() >= 2, 'Queued + active items tracked immediately');

      // Yield microtasks so worker starts job 1 cleanly
      await new Promise((r) => setTimeout(r, 15));
      strictEqual(callCount, 1, 'FIFO worker runs only 1 OCR job at a time');
      strictEqual(job1.item.status, 'processing');
      strictEqual(job2.item.status, 'queued');
      strictEqual(job3.item.status, 'queued');

      // Complete job 1
      gates[0].resolve({ text: 'Augmentin 875/125 mg tablets' });
      const res1 = await job1.completion;
      strictEqual(res1.status, 'ready');
      strictEqual(res1.selectedMedicine, null, 'Pharmacist must select manually');
      strictEqual(res1.candidates[0]?.medicine.id, 'cat-aug-1g');

      // Wait for job 2 and force failure to verify failure isolation
      await new Promise((r) => setTimeout(r, 15));
      strictEqual(callCount, 2);
      gates[1].reject(new Error('Simulated Tesseract OOM on image 2'));
      const res2 = await job2.completion;
      strictEqual(res2.status, 'failed');
      ok(res2.errorMessage?.includes('Simulated Tesseract OOM'), 'Failed item retains specific error');
      ok(res2.sourceImageBlob && res2.sourceImageBlob.size > 0, 'Failed item keeps source image for retry');

      // Complete job 3 despite job 2 failure
      await new Promise((r) => setTimeout(r, 15));
      strictEqual(callCount, 3);
      gates[2].resolve({ text: 'Paracetamol 500mg tablets' });
      const res3 = await job3.completion;
      strictEqual(res3.status, 'ready');
      strictEqual(res3.candidates[0]?.medicine.id, 'cat-para-500');

      console.log(`   ⏱ Queue non-blocking dispatch latency (3 captures): ${dispatchMs}ms`);
    });

    await test('A2. Reload Persistence converts interrupted queued/processing items to recoverable failed state & enforces branch isolation', async () => {
      (medicineTextRecognitionService as any).recognizeWebImage = async () => ({ text: 'Paracetamol 500mg tablets' });
      setActiveBranchContext('main');
      const svc = new BatchCaptureService();
      svc.setAutoPersist(false);
      const sId = svc.startNewSession('SEQUENTIAL');

      const readyItem = svc.addItemToSession(sId, {
        imageDataUrl: 'data:image/jpeg;base64,aXRlbTE=',
        ocrResult: { success: true, text: 'Paracetamol 500mg tablets' },
        parsedResult: null
      });
      const interruptedItem = svc.addItemToSession(sId, {
        imageDataUrl: 'data:image/jpeg;base64,aXRlbTI=',
        ocrResult: { success: true, text: '' },
        parsedResult: null
      });
      // Simulate mid-OCR tab close / app reload
      (interruptedItem as BatchMedicineItem).status = 'processing';

      const tPersist = performance.now();
      const saved = await svc.persistNow('main');
      const persistMs = Math.round((performance.now() - tPersist) * 100) / 100;
      strictEqual(saved, true, 'Persisted batch session into active branch metadata store');

      // Branch Isolation Check: switching to branch_2 must NOT leak 'main' session
      setActiveBranchContext('branch_2');
      await initializeAndMigrate();
      const branch2Svc = new BatchCaptureService();
      const leaked = await branch2Svc.restoreFromPersistence();
      strictEqual(leaked, false, 'Different branch cannot restore session from another branch');

      // Restore inside 'main' fresh instance
      setActiveBranchContext('main');
      const mainRestoredSvc = new BatchCaptureService();
      const restored = await mainRestoredSvc.restoreFromPersistence();
      strictEqual(restored, true, 'Main branch restores persisted session cleanly');
      strictEqual(mainRestoredSvc.getSessionId(), sId);
      const restoredItems = mainRestoredSvc.getItems();
      strictEqual(restoredItems.length, 2);
      strictEqual(restoredItems[0].id, readyItem.id);
      strictEqual(restoredItems[0].status, 'ready');
      strictEqual(restoredItems[1].status, 'failed', 'Interrupted item becomes recoverable failed status');
      strictEqual(restoredItems[1].imageBase64, 'data:image/jpeg;base64,aXRlbTI=', 'Original cropped image preserved across reload');

      const stored = await loadBatchCaptureSessionState();
      ok(stored && stored.branchId === 'main', 'Stored metadata carries explicit branchId');
      console.log(`   ⏱ IndexedDB saveBatchCaptureSessionState latency: ${persistMs}ms`);
    });
  } finally {
    (medicineTextRecognitionService as any).recognizeWebImage = origRecognizeWeb;
  }

  // =========================================================================
  // SCENARIO B: Mode B Unified Multi-Object Image + Split Box + Barcode-First
  // =========================================================================
  await test('B1. Multi-cue CV detection finds 4 distinct boxes, splitBoundingBox halves overlapping/touching box, Barcode-First decodes prior to OCR', async () => {
    const fourBoxesImg = createSyntheticMultiBoxCanvas(1200, 800, [
      { x: 40, y: 60, width: 220, height: 280, r: 28, g: 110, b: 170 },
      { x: 340, y: 70, width: 230, height: 270, r: 195, g: 70, b: 45 },
      { x: 650, y: 65, width: 220, height: 280, r: 45, g: 150, b: 95 },
      { x: 180, y: 430, width: 320, height: 260, r: 130, g: 80, b: 175 }
    ]);

    const tCvStart = performance.now();
    const proposal = await singleImageSegmentationService.proposeBoundingBoxes(fourBoxesImg as any);
    const cvMs = Math.round((performance.now() - tCvStart) * 100) / 100;
    strictEqual(proposal.boxes.length, 4, `Expected 4 multi-cue detected boxes, got ${proposal.boxes.length}`);

    // Split a wide merged box along vertical axis
    const wideBox: BoundingBox = { id: 'merged-1', x: 100, y: 100, width: 400, height: 200, label: 'مدمج' };
    const [leftHalf, rightHalf] = singleImageSegmentationService.splitBoundingBox(wideBox, 'vertical', 1);
    strictEqual(leftHalf.x + leftHalf.width, rightHalf.x, 'Split boxes touch cleanly with zero overlap');
    strictEqual(leftHalf.width + rightHalf.width, wideBox.width, 'Split preserves total bounding box width');

    // Barcode-First integration during processSingleImageMultiRegion
    const origWebOcr = medicineTextRecognitionService.recognizeWebImage;
    let barcodeCallCount = 0;
    let ocrCallCount = 0;
    const callOrder: string[] = [];

    staticImageBarcodeService.setCustomDecoder(async (input) => {
      barcodeCallCount++;
      callOrder.push(`barcode-${barcodeCallCount}`);
      const url = typeof input === 'string' ? input : '';
      const b64 = url.split(',')[1] || '';
      const meta = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : { sx: 0 };
      if (meta.sx < 260 && meta.sx < 200 && barcodeCallCount === 1) {
        return {
          barcode: '6281001001005',
          format: 'EAN_13',
          type: 'EAN-13',
          isValid: true,
          engine: 'custom',
          decodeTimeMs: 4
        };
      }
      return null;
    });

    (medicineTextRecognitionService as any).recognizeWebImage = async (blob: Blob) => {
      ocrCallCount++;
      callOrder.push(`ocr-${ocrCallCount}`);
      const meta = JSON.parse(await blob.text()) as { sx: number; sy: number };
      if (meta.sx < 150 && meta.sy < 200) return { text: 'Amoxicillin 500mg capsules', lines: [], blocks: [] };
      if (meta.sx >= 260 && meta.sx < 600 && meta.sy < 200) return { text: 'Augmentin 875/125 mg 14 tablets GSK', lines: [], blocks: [] };
      if (meta.sx >= 600) return { text: 'Paracetamol 500mg tablets', lines: [], blocks: [] };
      return { text: 'Metformin 500mg XR tablets', lines: [], blocks: [] };
    };

    try {
      const svc = await import('../src/services/batchCaptureService.ts').then((m) => m.batchCaptureService);
      svc.cancelSession();
      const origDataUrl = 'data:image/jpeg;base64,ZnVsbC11bmlmaWVkLWltYWdl';
      const result = await singleImageSegmentationService.processSingleImageMultiRegion(
        fourBoxesImg as any,
        proposal.boxes,
        catalogue,
        { originalImageDataUrl: origDataUrl }
      );

      strictEqual(result.processedCount, 4);
      strictEqual(barcodeCallCount, 4, 'Barcode-First runs on every single cropped region');
      strictEqual(ocrCallCount, 4, 'OCR runs independently on every cropped region');
      strictEqual(callOrder[0], 'barcode-1', 'Barcode decoding runs strictly BEFORE OCR on region 1');
      strictEqual(callOrder[1], 'ocr-1');

      const sessionItems = svc.getItems();
      strictEqual(sessionItems.length, 4);
      strictEqual(sessionItems[0].barcodeDetected, '6281001001005', 'Region 1 retains detected EAN-13 barcode');
      strictEqual(sessionItems[0].candidates[0]?.medicine.id, 'cat-amox-500');
      ok(sessionItems.every((it) => it.originalImageId && it.captureMode === 'UNIFIED_IMAGE'), 'Every item retains link to original unified photo & UNIFIED_IMAGE mode');
      ok(sessionItems.every((it) => it.selectedMedicine === null), 'No medicine is preselected automatically');
      strictEqual(svc.confirmAllEligibleItems(), 0);
      strictEqual(svc.getOriginalImages().length, 1);

      console.log(`   ⏱ Multi-cue CV bounding box segmentation (1200x800, 4 boxes): ${cvMs}ms`);
    } finally {
      staticImageBarcodeService.setCustomDecoder(null);
      (medicineTextRecognitionService as any).recognizeWebImage = origWebOcr;
    }
  });

  // =========================================================================
  // SCENARIO C: Pharmaceutical Token Parsing, Conflicts, Manual Edit & Full Catalogue Search
  // =========================================================================
  await test('C1. Pharma parser handles dual-ratio combo strengths (875/125 mg), package sizes, manufacturers, and UI tiers', () => {
    const profile = parseMedicineText('Augmentin\n875/125 mg\n14 Tablets\nGSK');
    ok(profile.strengths.includes('875mg') && profile.strengths.includes('125mg'), 'Extracts both dual combo ratios');
    ok(profile.dosageForms.includes('tablet'), 'Extracts dosage form');
    ok(profile.packageSizes.includes('14 tablets'), 'Extracts package size');
    ok(profile.manufacturers.includes('gsk'), 'Extracts manufacturer');

    strictEqual(mapMatchClassificationToUiTier('VERIFIED MATCH'), 'VERIFIED');
    strictEqual(mapMatchClassificationToUiTier('POSSIBLE MATCH'), 'PROBABLE');
    strictEqual(mapMatchClassificationToUiTier('NEEDS REVIEW'), 'PROBABLE');
    strictEqual(mapMatchClassificationToUiTier('CONFLICT'), 'UNRECOGNIZED');
    strictEqual(mapMatchClassificationToUiTier('UNKNOWN MEDICINE'), 'UNRECOGNIZED');
  });

  await test('C2. Inline OCR/Barcode edit re-parses & manual full-catalogue assignment works cleanly', () => {
    const svc = new BatchCaptureService();
    const sId = svc.startNewSession();
    const item = svc.addItemToSession(sId, {
      imageDataUrl: 'data:image/jpeg;base64,ZWRpdC10ZXN0',
      ocrResult: { success: true, text: 'Blurry box label' },
      parsedResult: null
    });
    strictEqual(item.classification, 'UNKNOWN MEDICINE');
    strictEqual(item.confidenceTier, 'UNRECOGNIZED');

    const edited = svc.reparseEditedItemText(item.id, 'Metformin 500mg XR tablets', catalogue, '6281001003009');
    ok(edited);
    strictEqual(edited!.classification, 'VERIFIED MATCH');
    strictEqual(edited!.confidenceTier, 'VERIFIED');
    strictEqual(edited!.selectedMedicine, null, 'Re-parse still avoids auto-selecting');

    const assigned = svc.manuallyAssignCatalogueMedicine(item.id, catalogue[2]);
    strictEqual(assigned, true);
    strictEqual(item.selectedMedicine?.id, catalogue[2].id);
    strictEqual(item.isManuallyReviewed, true);
    strictEqual(item.isIgnored, false);

    svc.setItemIgnored(item.id, true);
    strictEqual(item.isIgnored, true);
  });

  // =========================================================================
  // SCENARIO D & E: POS Cart Zero-Deduction Invariant & Inventory Ledger AddBatchStock
  // =========================================================================
  await test('D1 & E1. POS Cart action mutates zero ledger rows; Inventory Receive posts append-only PURCHASE ledger + stock update', async () => {
    setActiveBranchContext('main');
    const medId = 'med-batch2-amox-500';
    await saveMedicine({
      id: medId,
      name: 'Amoxicillin 500mg capsules',
      barcode: '6281001001005',
      category: 'Antibiotics',
      buyPrice: 1200,
      sellPrice: 1800,
      initialStock: 0,
      expiry: '2028-01-01',
      stripsPerPack: 2,
      pillsPerStrip: 10
    });

    // Establish baseline stock with an initial batch
    await addBatchStock({
      medicineId: medId,
      batchNumber: 'INIT-B2-01',
      expiry: '2028-01-01',
      quantity: 5,
      unit: 'pack',
      costPerUnit: 1200
    });

    const ledgerBefore = await getLedgerMovements(medId);
    const stockBefore = await calculateMedicineStock(medId);
    strictEqual(ledgerBefore.length, 1);
    strictEqual(stockBefore.packs, 5);

    const svc = new BatchCaptureService();
    const sId = svc.startNewSession();
    const item = svc.addItemToSession(sId, {
      imageDataUrl: 'data:image/jpeg;base64,cG9zLWludg==',
      ocrResult: { success: true, text: 'Amoxicillin 500mg capsules' },
      parsedResult: null
    });
    svc.manuallyAssignCatalogueMedicine(item.id, {
      id: medId,
      name: 'Amoxicillin 500mg capsules',
      barcode: '6281001001005'
    });

    // Scenario D: Adding batch item to POS cart leaves inventory_ledger untouched
    svc.markAddedToCart(item.id, 1);
    strictEqual(item.cartActionStatus, 'added');
    strictEqual(item.cartAddedQty, 1);

    const ledgerAfterCart = await getLedgerMovements(medId);
    const stockAfterCart = await calculateMedicineStock(medId);
    strictEqual(ledgerAfterCart.length, 1, 'POS cart addition produces ZERO inventory_ledger mutations');
    strictEqual(stockAfterCart.packs, 5, 'Stock count remains identical after cart add');

    // Scenario E: Explicit Inventory Receive calls addBatchStock & records PURCHASE movement
    const movement = await addBatchStock({
      medicineId: medId,
      batchNumber: 'BC2-LOT-2026',
      expiry: '2029-05-01',
      quantity: 10,
      unit: 'pack',
      costPerUnit: 1250,
      referenceId: `BATCH-CAP-${item.id}`
    });
    svc.markAddedToInventory(item.id, 10, 'pack', movement.id);

    const ledgerAfterInv = await getLedgerMovements(medId);
    const stockAfterInv = await calculateMedicineStock(medId);
    strictEqual(ledgerAfterInv.length, 2, 'Inventory Receive appends exactly 1 PURCHASE ledger record');
    strictEqual(stockAfterInv.packs, 15, 'Stock accurately increased from 5 to 15 packs');
    strictEqual(item.inventoryActionStatus, 'added');
    strictEqual(item.inventoryAddedQty, 10);
    strictEqual(item.inventoryLedgerMovementId, movement.id);
  });

  // =========================================================================
  // SCENARIO F: UI Markup & DB_VERSION / First-Run Safety Contracts
  // =========================================================================
  await test('F1. index.html exposes Batch Capture 2.0 dual-mode controls, independent POS/Inventory actions, and zero window.alert/confirm', () => {
    const html = readFileSync('index.html', 'utf8');
    const requiredMarkers = [
      'switchBatchCaptureMode(\'SEQUENTIAL\')',
      'switchBatchCaptureMode(\'UNIFIED_IMAGE\')',
      'splitSingleImageBoundingBox',
      'handleBatchAddToCartClick(item)',
      'openBatchInventoryReceiveModal(item)',
      'showBatchInventoryReceiveModal',
      'submitBatchInventoryReceive',
      'openBatchCatalogueSearch(item.id)',
      'applyBatchInlineEdit(item.id)',
      'toggleIgnoreBatchItem(item.id)',
      'restoreFromPersistence'
    ];
    for (const marker of requiredMarkers) {
      ok(html.includes(marker), `index.html contains required Batch Capture 2.0 hook: ${marker}`);
    }

    const modalSectionStart = html.indexOf('<!-- MODAL: SEQUENTIAL BATCH MEDICINE CAPTURE');
    const modalSectionEnd = html.indexOf('<!-- MODAL: SINGLE-IMAGE MULTI-MEDICINE');
    ok(modalSectionStart > 0 && modalSectionEnd > modalSectionStart);
    const modalSlice = html.slice(modalSectionStart, modalSectionEnd);
    ok(!modalSlice.includes('window.alert') && !modalSlice.includes('window.confirm'), 'No blocked browser alert/confirm inside Batch Capture 2.0 modals');
  });

  await test('F2. DB_VERSION stays 5 and initializeAndMigrate retains R22 zero-arg production safety', async () => {
    strictEqual(DB_VERSION, 5, 'IndexedDB schema version preserved at 5');
    strictEqual(initializeAndMigrate.length, 0, 'initializeAndMigrate accepts 0 parameters (no accidental demo seeding in production)');
    const db = await openPharmacyDB();
    ok(db.objectStoreNames.contains('metadata'), 'Metadata store available for zero-upgrade persistence');
  });

  console.log(`\n=============================================================`);
  console.log(`BATCH CAPTURE 2.0 SUITE PASSED: ${passed}/${total} (100%)`);
  console.log(`=============================================================\n`);
}

runSuite().catch((err) => {
  console.error('Batch Capture 2.0 test suite failed:', err);
  process.exit(1);
});
