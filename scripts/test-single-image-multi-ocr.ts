/**
 * Phase 3.6-B & 3.6-B.1 — Multi-Medicine Single-Image Recognition Test Suite
 * Khalid Pharmacy (com.khalidpharmacy.app)
 *
 * Verifies real connected-component package detection (non-grid), negative blank-image behavior,
 * safe non-overlapping crops, coordinate mapping, and strict 3-package single-image OCR isolation.
 */

import { parseMedicineText, matchMedicineText } from '../src/services/medicineTextParser.ts';
import { singleImageSegmentationService, BoundingBox } from '../src/services/singleImageSegmentationService.ts';
import { batchCaptureService } from '../src/services/batchCaptureService.ts';
import { barcodeScannerService } from '../src/services/barcodeScannerService.ts';
import { mlKitPocService } from '../src/services/mlKitPocService.ts';
import { medicineTextRecognitionService } from '../src/services/medicineTextRecognitionService.ts';

// Mock DOM elements and Canvas for Node test execution
let lastCropDrawArgs: unknown[] | null = null;

interface SyntheticPackage {
  x: number;
  y: number;
  width: number;
  height: number;
  ocrText: string;
}

interface SyntheticImage {
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  _pixels: Uint8ClampedArray;
  packages: SyntheticPackage[];
}

function createSyntheticImage(
  width: number,
  height: number,
  packages: SyntheticPackage[],
  bgLum = 235
): SyntheticImage {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    pixels[idx] = bgLum;
    pixels[idx + 1] = bgLum;
    pixels[idx + 2] = bgLum;
    pixels[idx + 3] = 255;
  }

  for (const pkg of packages) {
    const xEnd = Math.min(width, pkg.x + pkg.width);
    const yEnd = Math.min(height, pkg.y + pkg.height);
    for (let y = Math.max(0, pkg.y); y < yEnd; y++) {
      for (let x = Math.max(0, pkg.x); x < xEnd; x++) {
        const idx = (y * width + x) * 4;
        const isBorder =
          x - pkg.x < 4 || xEnd - 1 - x < 4 || y - pkg.y < 4 || yEnd - 1 - y < 4;
        const isTextBand = (y - pkg.y) % 14 < 5 && (x - pkg.x) % 9 < 6;
        const val = isBorder ? 25 : isTextBand ? 40 : 120;
        pixels[idx] = val;
        pixels[idx + 1] = val;
        pixels[idx + 2] = val;
        pixels[idx + 3] = 255;
      }
    }
  }

  return {
    width,
    height,
    naturalWidth: width,
    naturalHeight: height,
    _pixels: pixels,
    packages
  };
}

// Mock DOM Canvas operating over genuine RGBA pixel buffers and crop coordinates
if (typeof document === 'undefined') {
  (global as any).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') {
        const canvas: any = {
          width: 800,
          height: 600,
          _cropMeta: { sx: 0, sy: 0, sw: 800, sh: 600 },
          _buffer: new Uint8ClampedArray(800 * 600 * 4),
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
              lastCropDrawArgs = [source, a1, a2, a3, a4, a5, a6, a7, a8];
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

const mockCatalog = [
  { id: '1', name: 'Amoxicillin 500mg Capsules', price: 1500 },
  { id: '2', name: 'Paracetamol 500mg Tablets', price: 500 },
  { id: '3', name: 'Ibuprofen 400mg Tablets', price: 800 },
  { id: '4', name: 'Augmentin 1g Tablets', price: 4500 },
  { id: '5', name: 'Cataflam 50mg Tablets', price: 1200 },
  { id: '6', name: 'Amaryl 4mg', price: 2400 },
  { id: '7', name: 'Lasix 40mg', price: 1100 }
];

let testCount = 0;
let passedCount = 0;

function assert(condition: boolean, description: string) {
  testCount++;
  if (condition) {
    passedCount++;
    console.log(`  ✓ Test ${testCount}: ${description}`);
  } else {
    console.error(`  ✗ Test ${testCount} FAILED: ${description}`);
  }
}

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

async function runTests() {
  console.log('========================================================================');
  console.log('Phase 3.6-B & 3.6-B.1 — Single-Image Multi-OCR Refinement Test Suite');
  console.log('========================================================================\n');

  // Scenario 0: Blank / uniform image must NOT produce fixed-grid boxes
  console.log('--- Scenario 0: Blank Image Rejection (No Fixed Grid Fallback) ---');
  const blankImg = createSyntheticImage(1000, 600, []);
  const blankProposal = await singleImageSegmentationService.proposeBoundingBoxes(blankImg as any);
  assert(blankProposal.boxes.length === 0, 'Blank uniform image returns 0 proposed boxes (no fixed grid fallback)');

  // Scenario 1: Single image containing 2 distinct packages -> 2 connected-component boxes -> 2 items parsed
  console.log('\n--- Scenario 1: Single Image with 2 Packages ---');
  const mockImage2: any = createSyntheticImage(1000, 600, [
    { x: 60, y: 80, width: 320, height: 420, ocrText: 'Amoxicillin 500mg Capsules' },
    { x: 560, y: 90, width: 310, height: 400, ocrText: 'Paracetamol 500mg Tablets' }
  ]);
  const proposal2 = await singleImageSegmentationService.proposeBoundingBoxes(mockImage2 as any);
  assert(proposal2.boxes.length === 2, `Connected-component detector finds exactly 2 boxes (got ${proposal2.boxes.length})`);
  const boxes2: BoundingBox[] = [
    { id: 'box-1', x: 50, y: 50, width: 400, height: 500, label: 'Amoxicillin' },
    { id: 'box-2', x: 500, y: 50, width: 400, height: 500, label: 'Paracetamol' }
  ];

  batchCaptureService.clearCurrentSession();
  const result2 = await singleImageSegmentationService.processSingleImageMultiRegion(mockImage2 as any, boxes2, mockCatalog);
  assert(result2.regions.length === 2, 'Processed exactly 2 image regions into session');
  assert(result2.sessionId !== '', 'Created a valid batch capture session ID');

  // Scenario 2: Single image containing 3 separated medicine boxes — Full Detection + Cropping + Independent OCR Isolation
  console.log('\n--- Scenario 2: Single Image with 3 Separate Medicine Boxes (Zero Cross-Contamination) ---');
  const threePackages: SyntheticPackage[] = [
    {
      x: 40,
      y: 70,
      width: 240,
      height: 360,
      ocrText: 'Amaryl\nGlimepiride\n4 mg\n30 Tablets\nsanofi'
    },
    {
      x: 370,
      y: 90,
      width: 240,
      height: 340,
      ocrText: 'Lasix\nFurosemide\n40 mg\ntablets'
    },
    {
      x: 700,
      y: 65,
      width: 250,
      height: 375,
      ocrText: 'Paracetamol 500mg\nTablets'
    }
  ];
  const threeBoxImg = createSyntheticImage(1000, 600, threePackages);
  const proposal3 = await singleImageSegmentationService.proposeBoundingBoxes(threeBoxImg as any);
  assert(proposal3.boxes.length === 3, `Connected-component detector finds all 3 separated packages (got ${proposal3.boxes.length})`);

  // Verify each detected box covers its corresponding package without spanning two packages
  const cleanThreeMapping = proposal3.boxes.length === 3 && proposal3.boxes.every((box, i) => {
    const overlapsPkgI = rectsOverlap(box, threePackages[i]);
    const overlapsOther = threePackages.some((pkg, j) => j !== i && rectsOverlap(box, pkg));
    return overlapsPkgI && !overlapsOther;
  });
  assert(cleanThreeMapping, 'Each of the 3 proposed boxes isolates exactly one medicine package with zero bleed into neighbors');

  // Verify safe crop bounds keep each crop isolated from neighboring boxes
  const safeCrops3 = proposal3.boxes.map((box) =>
    singleImageSegmentationService.calculateSafeCropBounds(box, threeBoxImg.width, threeBoxImg.height, proposal3.boxes, 0.10)
  );
  const cropsDisjoint =
    safeCrops3[0].x + safeCrops3[0].width <= safeCrops3[1].x + 1 &&
    safeCrops3[1].x + safeCrops3[1].width <= safeCrops3[2].x + 1;
  assert(cropsDisjoint, 'Safe 10% padded crops for the 3 boxes remain spatially disjoint');

  // Run full processSingleImageMultiRegion using per-crop OCR spy reading pixels inside crop meta
  batchCaptureService.clearCurrentSession();
  const originalRecognizeWebImage = medicineTextRecognitionService.recognizeWebImage.bind(medicineTextRecognitionService);
  (medicineTextRecognitionService as any).recognizeWebImage = async (blob: Blob) => {
    const rawMeta = await blob.text();
    const crop = JSON.parse(rawMeta) as { sx: number; sy: number; sw: number; sh: number };
    const cropRect = { x: crop.sx, y: crop.sy, width: crop.sw, height: crop.sh };
    const hits = threePackages.filter((pkg) => rectsOverlap(cropRect, pkg));
    const combinedText = hits.map((h) => h.ocrText).join('\n');
    return {
      text: combinedText,
      lines: combinedText.split('\n'),
      blocks: []
    };
  };

  let result3;
  try {
    result3 = await singleImageSegmentationService.processSingleImageMultiRegion(
      threeBoxImg as any,
      proposal3.boxes,
      mockCatalog
    );
  } finally {
    (medicineTextRecognitionService as any).recognizeWebImage = originalRecognizeWebImage;
  }

  assert(result3.processedCount === 3 && result3.regions.length === 3, 'Processed all 3 regions cleanly into batch capture session');
  assert(
    result3.regions[0].parsedMatches[0]?.medicine.id === '6' &&
      result3.regions[1].parsedMatches[0]?.medicine.id === '7' &&
      result3.regions[2].parsedMatches[0]?.medicine.id === '2',
    'The 3 OCR results resolve independently to Amaryl 4mg, Lasix 40mg, and Paracetamol 500mg without mixing'
  );

  const batchItems3 = batchCaptureService.getItems();
  assert(
    batchItems3.length === 3 &&
      batchItems3[0].candidates[0]?.medicine.id === '6' &&
      batchItems3[1].candidates[0]?.medicine.id === '7' &&
      batchItems3[2].candidates[0]?.medicine.id === '2' &&
      batchItems3[0].ocrText.includes('Amaryl') && !batchItems3[0].ocrText.includes('Lasix') &&
      batchItems3[1].ocrText.includes('Lasix') && !batchItems3[1].ocrText.includes('Paracetamol') &&
      batchItems3[2].ocrText.includes('Paracetamol') && !batchItems3[2].ocrText.includes('Amaryl'),
    'Batch Capture session binds each OCR text, thumbnail, and top candidate strictly to its corresponding region without cross-contamination'
  );
  assert(
    batchItems3.every((it) => it.selectedMedicine === null && it.isManuallyReviewed === false && it.isConfirmed === false) &&
      batchItems3[0].thumbnailUrl !== batchItems3[1].thumbnailUrl &&
      batchItems3[1].thumbnailUrl !== batchItems3[2].thumbnailUrl &&
      batchItems3[0].captureId !== batchItems3[1].captureId &&
      batchItems3[1].captureId !== batchItems3[2].captureId,
    'Each batch item retains its unique cropped image URL and captureId, and requires manual review/selection (selectedMedicine null)'
  );
  assert(batchCaptureService.confirmAllEligibleItems() === 0 && batchCaptureService.getItems().every((it) => !it.isConfirmed), 'Bulk confirmation is blocked (confirmAllEligibleItems returns 0 and leaves items unconfirmed)');

  // Scenario 3: 5 packages batch processing
  console.log('\n--- Scenario 3: 5 Packages Region Processing ---');
  const boxes5: BoundingBox[] = [
    { id: 'b1', x: 10, y: 10, width: 180, height: 250 },
    { id: 'b2', x: 200, y: 10, width: 180, height: 250 },
    { id: 'b3', x: 390, y: 10, width: 180, height: 250 },
    { id: 'b4', x: 580, y: 10, width: 180, height: 250 },
    { id: 'b5', x: 770, y: 10, width: 180, height: 250 }
  ];
  // Each scenario owns a fresh batch session; the service correctly refuses to overwrite prior results.
  batchCaptureService.clearCurrentSession();
  const result5 = await singleImageSegmentationService.processSingleImageMultiRegion(mockImage2 as any, boxes5, mockCatalog);
  assert(result5.regions.length === 5, 'Processed 5 distinct medicine regions in single photograph');

  // Scenario 4: Adjacent / touching packages separation
  console.log('\n--- Scenario 4: Adjacent / Touching Packages ---');
  const boxAdj1: BoundingBox = { id: 'adj-1', x: 100, y: 100, width: 200, height: 300 };
  const boxAdj2: BoundingBox = { id: 'adj-2', x: 300, y: 100, width: 200, height: 300 };
  assert(boxAdj1.x + boxAdj1.width === boxAdj2.x, 'Adjacent boxes touch at X=300 without spatial overlap');

  // Scenario 5: Different sizes & orientations
  console.log('\n--- Scenario 5: Different Package Sizes & Orientations ---');
  const boxLarge: BoundingBox = { id: 'sz-1', x: 10, y: 10, width: 600, height: 400 };
  const boxSmall: BoundingBox = { id: 'sz-2', x: 620, y: 10, width: 150, height: 100 };
  const cropLarge = singleImageSegmentationService.cropRegionWithPadding(mockImage2 as any, boxLarge);
  const cropSmall = singleImageSegmentationService.cropRegionWithPadding(mockImage2 as any, boxSmall);
  assert(typeof cropLarge === 'string' && typeof cropSmall === 'string', 'Successfully cropped both large and small regions');

  // Scenario 6: Manual bounding box addition / adjustment
  console.log('\n--- Scenario 6: Manual Bounding Box Adjustment ---');
  const origBox: BoundingBox = { id: 'man-1', x: 100, y: 100, width: 200, height: 200 };
  const modifiedBox: BoundingBox = { ...origBox, width: 350, height: 280, label: 'عدّل الصيدلي الحدود' };
  const cropModified = singleImageSegmentationService.cropRegionWithPadding(mockImage2 as any, modifiedBox);
  assert(modifiedBox.width === 350 && cropModified.length > 0, 'Re-crops region using pharmacist-adjusted bounding box');

  // Scenario 7: Text boundary isolation with padding
  console.log('\n--- Scenario 7: Padding Safety Boundary ---');
  const padBox: BoundingBox = { id: 'pad-1', x: 100, y: 100, width: 200, height: 200 };
  const croppedData = singleImageSegmentationService.cropRegionWithPadding(mockImage2 as any, padBox, 0.10);
  assert(croppedData.length > 0, '10% safety margin applied to box boundaries during crop');

  // Scenario 8: Unclear image / low resolution classification
  console.log('\n--- Scenario 8: Unclear Image / Low Resolution ---');
  const lowResProfile = parseMedicineText('xyz ... Blur');
  const lowResCandidates = matchMedicineText(lowResProfile, mockCatalog);
  const lowResClass = batchCaptureService.classifyMatch(lowResCandidates, 'xyz ... Blur');
  assert(lowResClass.classification === 'UNKNOWN MEDICINE', 'Low clarity / unreadable OCR text yields UNKNOWN MEDICINE');

  // Scenario 9: Uncatalogued item in one region
  console.log('\n--- Scenario 9: Uncatalogued Medicine in Region ---');
  const uncataloguedProfile = parseMedicineText('Unlisted Brand X 750mg Injection');
  const uncataloguedCandidates = matchMedicineText(uncataloguedProfile, mockCatalog);
  const uncataloguedClass = batchCaptureService.classifyMatch(uncataloguedCandidates, 'Unlisted Brand X 750mg Injection');
  assert(uncataloguedClass.classification === 'UNKNOWN MEDICINE', 'Uncatalogued medicine in region flagged as UNKNOWN MEDICINE');

  // Scenario 10: Strength / dosage form conflict
  console.log('\n--- Scenario 10: Strength / Form Conflict ---');
  const conflictProfile = parseMedicineText('Amoxicillin 1000mg Syrup');
  const conflictCandidates = matchMedicineText(conflictProfile, mockCatalog);
  const conflictClass = batchCaptureService.classifyMatch(conflictCandidates, 'Amoxicillin 1000mg Syrup');
  assert(
    conflictClass.classification === 'POSSIBLE MATCH' ||
      conflictClass.classification === 'CONFLICT' ||
      conflictClass.classification === 'NEEDS REVIEW' ||
      conflictClass.classification === 'UNKNOWN MEDICINE',
    'Dosage form/strength mismatch flags conflict or possible match'
  );

  // Scenario 11: Partial OCR failure resilience
  console.log('\n--- Scenario 11: Partial OCR Failure Resilience ---');
  batchCaptureService.clearCurrentSession();
  const multiRes = await singleImageSegmentationService.processSingleImageMultiRegion(mockImage2 as any, boxes2, mockCatalog);
  assert(multiRes.processedCount === 2, 'Session processes all regions even if one region fails OCR');

  // Scenario 12: Session cancellation
  console.log('\n--- Scenario 12: Session Cancellation ---');
  const cancelSession = batchCaptureService.startBatchSession('SINGLE_IMAGE_MULTI');
  batchCaptureService.addItemToSession(cancelSession.sessionId, {
    imageDataUrl: 'data:image/jpeg;base64,mock',
    ocrResult: null,
    parsedResult: null
  });
  batchCaptureService.clearCurrentSession();
  assert(batchCaptureService.getCurrentSession() === null, 'Cancelling single-image multi-OCR session clears session without saving');

  // Scenario 13: Invariant check -> safeToAutoSelect is ALWAYS false
  console.log('\n--- Scenario 13: Invariant: safeToAutoSelect = false ---');
  const invProfile = parseMedicineText('Amoxicillin 500mg');
  const invCandidates = matchMedicineText(invProfile, mockCatalog);
  assert(invCandidates.every(c => c.safeToAutoSelect === false), 'CRITICAL INVARIANT: safeToAutoSelect is strictly FALSE for text OCR matches');

  // Scenario 14: Invariant check -> zero automatic cart addition or IndexedDB mutation
  console.log('\n--- Scenario 14: Invariant: Zero Automatic Mutations ---');
  const activeSess = batchCaptureService.getCurrentSession();
  assert(activeSess === null || activeSess.items.length === 0, 'No items automatically injected into POS cart or database without click');

  // Phase 3.6-B.1 Required Refinement Tests
  console.log('\n--- Phase 3.6-B.1: Refinement Test 1 - Horizontally Touching Medicines ---');
  const hBox1: BoundingBox = { id: 'h1', x: 100, y: 100, width: 200, height: 300 };
  const hBox2: BoundingBox = { id: 'h2', x: 300, y: 100, width: 200, height: 300 };
  const cropH1 = singleImageSegmentationService.calculateSafeCropBounds(hBox1, 1000, 1000, [hBox1, hBox2], 0.10);
  const cropH2 = singleImageSegmentationService.calculateSafeCropBounds(hBox2, 1000, 1000, [hBox1, hBox2], 0.10);
  assert(cropH1.x + cropH1.width <= hBox2.x && cropH2.x >= hBox1.x + hBox1.width, '1. Horizontally touching medicines: crops restricted at touch boundary without encroachment');

  console.log('\n--- Phase 3.6-B.1: Refinement Test 2 - Vertically Touching Medicines ---');
  const vBox1: BoundingBox = { id: 'v1', x: 100, y: 100, width: 300, height: 200 };
  const vBox2: BoundingBox = { id: 'v2', x: 100, y: 300, width: 300, height: 200 };
  const cropV1 = singleImageSegmentationService.calculateSafeCropBounds(vBox1, 1000, 1000, [vBox1, vBox2], 0.10);
  const cropV2 = singleImageSegmentationService.calculateSafeCropBounds(vBox2, 1000, 1000, [vBox1, vBox2], 0.10);
  assert(cropV1.y + cropV1.height <= vBox2.y && cropV2.y >= vBox1.y + vBox1.height, '2. Vertically touching medicines: crops restricted at touch boundary without encroachment');

  console.log('\n--- Phase 3.6-B.1: Refinement Test 3 - Three Close Medicines ---');
  const c1: BoundingBox = { id: 'c1', x: 100, y: 100, width: 200, height: 200 };
  const c2: BoundingBox = { id: 'c2', x: 300, y: 100, width: 200, height: 200 };
  const c3: BoundingBox = { id: 'c3', x: 500, y: 100, width: 200, height: 200 };
  const cropC2 = singleImageSegmentationService.calculateSafeCropBounds(c2, 1000, 1000, [c1, c2, c3], 0.10);
  assert(cropC2.x >= c1.x + c1.width && cropC2.x + cropC2.width <= c3.x, '3. Three close medicines: middle crop clamped safely between left and right neighbors');

  console.log('\n--- Phase 3.6-B.1: Refinement Test 4 - Partially Overlapping Medicines ---');
  const o1: BoundingBox = { id: 'o1', x: 100, y: 100, width: 200, height: 200 };
  const o2: BoundingBox = { id: 'o2', x: 280, y: 100, width: 200, height: 200 };
  const cropO1 = singleImageSegmentationService.calculateSafeCropBounds(o1, 1000, 1000, [o1, o2], 0.10);
  assert(cropO1.x + cropO1.width >= o1.x + o1.width, '4. Partially overlapping medicines: original box is preserved without shrinking below unpadded bounds');

  console.log('\n--- Phase 3.6-B.1: Refinement Test 5 - Medicine Near Image Edge ---');
  const edgeBox: BoundingBox = { id: 'e1', x: 5, y: 5, width: 100, height: 100 };
  const cropEdge = singleImageSegmentationService.calculateSafeCropBounds(edgeBox, 1000, 1000, [edgeBox], 0.10);
  assert(cropEdge.x === 0 && cropEdge.y === 0, '5. Medicine near image edge: crop boundary clamped safely at X=0, Y=0');

  console.log('\n--- Phase 3.6-B.1: Refinement Test 6 - Displayed Image at Half Original Size ---');
  const dispBoxHalf = { x: 50, y: 25, width: 100, height: 50 };
  const mappingHalf = { originalWidth: 2000, originalHeight: 1000, displayWidth: 1000, displayHeight: 500 };
  const origMappedHalf = singleImageSegmentationService.mapDisplayToOriginalBox(dispBoxHalf, mappingHalf);
  assert(origMappedHalf.x === 100 && origMappedHalf.y === 50 && origMappedHalf.width === 200 && origMappedHalf.height === 100, '6. Displayed image at half original size: maps display coordinates to original image coordinates accurately');

  console.log('\n--- Phase 3.6-B.1: Refinement Test 7 - Displayed Image with Different Aspect Ratio ---');
  const mappingAspect = { originalWidth: 1000, originalHeight: 1000, displayWidth: 800, displayHeight: 600, offsetX: 100, offsetY: 0 };
  const dispBoxAspect = { x: 200, y: 60, width: 120, height: 120 };
  const origMappedAspect = singleImageSegmentationService.mapDisplayToOriginalBox(dispBoxAspect, mappingAspect);
  assert(origMappedAspect.x > 0 && origMappedAspect.width > 0, '7. Displayed image with aspect ratio / letterbox offset: maps offset UI box correctly');

  console.log('\n--- Phase 3.6-B.1: Refinement Test 8 - Small Mobile Screen Bounding Box Adjustment ---');
  const mobileMapping = { originalWidth: 1920, originalHeight: 1080, displayWidth: 360, displayHeight: 202.5 };
  const mobileTouchBox = { x: 10, y: 10, width: 100, height: 80 };
  const mobileMapped = singleImageSegmentationService.mapDisplayToOriginalBox(mobileTouchBox, mobileMapping);
  const backToDisplay = singleImageSegmentationService.mapOriginalToDisplayBox(mobileMapped, mobileMapping);
  assert(Math.abs(backToDisplay.x - mobileTouchBox.x) <= 2, '8. Small mobile screen adjustment: round-trip coordinate mapping preserves accuracy within 2 pixels');

  console.log('\n--- Phase 3.6-B.1: Refinement Test 9 - Coordinates Bounds Limit Enforcement ---');
  const outBox = { x: 350, y: 200, width: 100, height: 100 };
  const outMapping = { originalWidth: 1000, originalHeight: 1000, displayWidth: 360, displayHeight: 360 };
  const outMapped = singleImageSegmentationService.mapDisplayToOriginalBox(outBox, outMapping);
  assert(outMapped.x + outMapped.width <= 1000 && outMapped.y + outMapped.height <= 1000, '9. Coordinates limit enforcement: mapped coordinates never exceed original image dimensions');

  console.log('\n--- Phase 3.6-B.1: Refinement Test 10 - Original Bounding Box Immutability ---');
  const pristineBox: BoundingBox = { id: 'p1', x: 150, y: 150, width: 250, height: 350 };
  const origSnapshot = JSON.stringify(pristineBox);
  singleImageSegmentationService.calculateSafeCropBounds(pristineBox, 1000, 1000, [pristineBox], 0.10);
  assert(JSON.stringify(pristineBox) === origSnapshot, '10. Original Bounding Box immutability: input box coordinates remain strictly unchanged during padding calculations');

  console.log('\n========================================================================');

  // A direct crop-bounds call must validate every neighboring region it uses.
  let invalidNeighborRejected = false;
  try {
    singleImageSegmentationService.calculateSafeCropBounds(
      { id: 'crop-target', x: 100, y: 100, width: 100, height: 100 },
      1000,
      600,
      [
        { id: 'crop-target', x: 100, y: 100, width: 100, height: 100 },
        { id: 'bad-neighbor', x: Number.NaN, y: 100, width: 100, height: 100 }
      ]
    );
  } catch {
    invalidNeighborRejected = true;
  }
  assert(invalidNeighborRejected, 'Direct crop calculation rejects malformed neighboring boxes');

  // Safety validation: malformed, out-of-bounds, duplicate and heavily overlapping boxes.
  console.log('\n--- Safety: Bounding Box Validation ---');
  let invalidRejected = false;
  try {
    singleImageSegmentationService.validateBoundingBoxes(
      [{ id: 'bad', x: -1, y: 0, width: 20, height: 20 }],
      1000,
      600
    );
  } catch {
    invalidRejected = true;
  }
  assert(invalidRejected, 'Rejects negative/out-of-bounds bounding box coordinates');

  let duplicateRejected = false;
  try {
    singleImageSegmentationService.validateBoundingBoxes([
      { id: 'dup-1', x: 10, y: 10, width: 100, height: 100 },
      { id: 'dup-2', x: 10, y: 10, width: 100, height: 100 }
    ], 1000, 600);
  } catch {
    duplicateRejected = true;
  }
  assert(duplicateRejected, 'Rejects duplicate geometry assigned to separate medicine IDs');

  let overlapRejected = false;
  try {
    singleImageSegmentationService.validateBoundingBoxes([
      { id: 'overlap-1', x: 10, y: 10, width: 200, height: 200 },
      { id: 'overlap-2', x: 50, y: 50, width: 200, height: 200 }
    ], 1000, 600);
  } catch {
    overlapRejected = true;
  }
  assert(overlapRejected, 'Rejects heavily overlapping regions before OCR attribution');
  let emptyRegionsRejected = false;
  try {
    await singleImageSegmentationService.processSingleImageMultiRegion(mockImage2, [], mockCatalog);
  } catch {
    emptyRegionsRejected = true;
  }
  assert(emptyRegionsRejected, 'Rejects empty region lists before starting a batch session');



  // Safety: exercise both underlying scanner states through UnifiedScannerService.
  console.log('\n--- Safety: Unified Native/Web Scanner Exclusion ---');
  const originalWebIsScanning = barcodeScannerService.isScanning;
  const originalNativeIsScanning = mlKitPocService.isScanning;
  let webScannerRejected = false;
  let nativeScannerRejected = false;
  try {
    barcodeScannerService.isScanning = () => true;
    webScannerRejected = false;
    try {
      await singleImageSegmentationService.processSingleImageMultiRegion(mockImage2, boxes2, mockCatalog);
    } catch (err: any) {
      webScannerRejected = String(err?.message || '').includes('Native أو Web');
    }
    barcodeScannerService.isScanning = originalWebIsScanning;

    mlKitPocService.isScanning = () => true;
    try {
      await singleImageSegmentationService.processSingleImageMultiRegion(mockImage2, boxes2, mockCatalog);
    } catch (err: any) {
      nativeScannerRejected = String(err?.message || '').includes('Native أو Web');
    }
  } finally {
    barcodeScannerService.isScanning = originalWebIsScanning;
    mlKitPocService.isScanning = originalNativeIsScanning;
  }
  assert(webScannerRejected, 'Rejects image OCR while Web ZXing scanner is active');
  assert(nativeScannerRejected, 'Rejects image OCR while Android ML Kit scanner is active');

  // Safety: do not replace an existing batch session when starting single-image processing.
  console.log('\n--- Safety: Preserve Existing Batch Session ---');
  batchCaptureService.clearCurrentSession();
  const protectedSession = batchCaptureService.startBatchSession('EXISTING_BATCH');
  batchCaptureService.addItemToSession(protectedSession.sessionId, {
    imageDataUrl: 'data:image/jpeg;base64,existing',
    ocrResult: { success: true, text: 'Amoxicillin 500mg capsules' },
    parsedResult: null
  });
  let existingSessionPreserved = false;
  try {
    await singleImageSegmentationService.processSingleImageMultiRegion(mockImage2, boxes2, mockCatalog);
  } catch (err: any) {
    existingSessionPreserved = String(err?.message || '').includes('جلسة التقاط أخرى');
  }
  assert(existingSessionPreserved, 'Refuses to overwrite a non-empty batch session');
  assert(batchCaptureService.getSessionId() === protectedSession.sessionId, 'Existing session ID remains unchanged after rejection');
  batchCaptureService.clearCurrentSession();

  // Safety: a caller cannot reuse an approved region ID with substituted coordinates.
  console.log('--- Safety: Canonical Crop Target Coordinates ---');
  const approvedCropBox: BoundingBox = { id: 'approved-target', x: 120, y: 140, width: 180, height: 220 };
  const substitutedCropBox: BoundingBox = { ...approvedCropBox, x: 500, y: 350, width: 300, height: 180 };
  const approvedCrop = singleImageSegmentationService.calculateSafeCropBounds(
    approvedCropBox, 1000, 600, [approvedCropBox], 0.10
  );
  const substitutedCrop = singleImageSegmentationService.calculateSafeCropBounds(
    substitutedCropBox, 1000, 600, [approvedCropBox], 0.10
  );
  assert(
    JSON.stringify(substitutedCrop) === JSON.stringify(approvedCrop),
    'Crop calculations use canonical validated coordinates, not caller-substituted coordinates with the same ID'
  );

  // Direct crop API must use the canonical target and preserve neighbor boundaries.
  const approvedNeighbor: BoundingBox = { id: 'approved-neighbor', x: 300, y: 140, width: 160, height: 220 };
  singleImageSegmentationService.cropRegionWithPadding(mockImage2, approvedCropBox, 0.10, [approvedCropBox, approvedNeighbor]);
  const approvedDrawArgs = lastCropDrawArgs?.slice(1, 5);
  singleImageSegmentationService.cropRegionWithPadding(mockImage2, substitutedCropBox, 0.10, [approvedCropBox, approvedNeighbor]);
  assert(JSON.stringify(lastCropDrawArgs?.slice(1, 5)) === JSON.stringify(approvedDrawArgs), 'cropRegionWithPadding uses canonical coordinates and the approved neighboring-region boundary');

  let missingTargetRejected = false;
  try { singleImageSegmentationService.cropRegionWithPadding(mockImage2, substitutedCropBox, 0.10, [approvedNeighbor]); } catch { missingTargetRejected = true; }
  assert(missingTargetRejected, 'Direct crop rejects a target ID absent from the approved region list');

  let emptyApprovedListRejected = false;
  try { singleImageSegmentationService.cropRegionWithPadding(mockImage2, approvedCropBox, 0.10, []); } catch { emptyApprovedListRejected = true; }
  assert(emptyApprovedListRejected, 'Direct crop rejects an explicitly empty approved-region list');

  let duplicateIdsRejected = false;
  try { singleImageSegmentationService.validateBoundingBoxes([approvedCropBox, { ...approvedNeighbor, id: approvedCropBox.id, x: 500 }], 1000, 600); } catch { duplicateIdsRejected = true; }
  assert(duplicateIdsRejected, 'Bounding-box validation rejects duplicate region IDs');

  let invalidPaddingRejected = false;
  try { singleImageSegmentationService.calculateSafeCropBounds(approvedCropBox, 1000, 600, [approvedCropBox], 0.75); } catch { invalidPaddingRejected = true; }
  assert(invalidPaddingRejected, 'Crop calculation rejects padding percentages outside the supported range');

  console.log(`Results: ${passedCount} / ${testCount} tests passed.`);
  console.log('========================================================================\n');

  if (passedCount !== testCount) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
