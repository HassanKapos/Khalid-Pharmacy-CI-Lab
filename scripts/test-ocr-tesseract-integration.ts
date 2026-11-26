/**
 * Comprehensive Integration & Regression Suite:
 * 1. Actual public/tesseract/tesseract.esm.min.js export shape & createWorker resolution
 * 2. WebMedicineTextRecognitionService worker lifecycle, serialization, offline cache & retry recovery
 * 3. Medicine recognition scenarios (single box, 3 boxes in 1 image, similar strengths, blurry, unknown, model failure + retry, offline post-cache)
 * 4. Simplified Arabic scanner toolbar & modal UX invariants in index.html
 */

import { strictEqual, ok } from 'node:assert';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  extractCleanMedicineNameSuggestion,
  resolveTesseractApi,
  scoreOcrTextReadability,
  WebMedicineTextRecognitionService
} from '../src/services/webMedicineTextRecognitionService.ts';
import { medicineTextRecognitionService } from '../src/services/medicineTextRecognitionService.ts';
import { BatchCaptureService } from '../src/services/batchCaptureService.ts';
import { MedicineCatalogueEntry } from '../src/services/medicineTextParser.ts';

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

async function run() {
  console.log('=== KHALID PHARMACY — TESSERACT OCR & SCANNER INTEGRATION SUITE ===\n');

  const catalogue: MedicineCatalogueEntry[] = [
    { id: 'med-amox-500', name: 'Amoxicillin 500mg capsules', barcode: '6281001001' },
    { id: 'med-amox-250', name: 'Amoxicillin 250mg suspension', barcode: '6281001002' },
    { id: 'med-met-500-std', name: 'Metformin 500mg tablets', barcode: '6281002001' },
    { id: 'med-met-500-xr', name: 'Metformin 500mg XR extended release tablets', barcode: '6281002002' },
    { id: 'med-para-500', name: 'Paracetamol 500mg tablets', barcode: '6281003001' },
    { id: 'med-cipro-500', name: 'Ciprofloxacin 500mg tablets', barcode: '6281004001' }
  ];

  // 1. Inspect ACTUAL tesseract.esm.min.js export shape & resolveTesseractApi()
  await test('1. Actual public/tesseract/tesseract.esm.min.js default export resolves createWorker cleanly', async () => {
    const prevSelf = (globalThis as any).self;
    (globalThis as any).self = globalThis;
    try {
      const esmUrl = pathToFileURL(join(process.cwd(), 'public/tesseract/tesseract.esm.min.js')).href;
      const actualModule: any = await import(esmUrl);
      strictEqual(typeof actualModule.createWorker, 'undefined', 'Raw ESM wrapper has no named createWorker export');
      strictEqual(typeof actualModule.default?.createWorker, 'function', 'Raw ESM wrapper exposes createWorker on .default');

      const resolved = resolveTesseractApi(actualModule);
      strictEqual(typeof resolved.createWorker, 'function', 'resolveTesseractApi extracts createWorker function');
    } finally {
      (globalThis as any).self = prevSelf;
    }
  });

  // 2. Worker configuration, single-worker reuse, concurrency serialization, and dispose lifecycle
  await test('2. Single worker lifecycle: passes workerBlobURL:false, serializes concurrent jobs, and disposes cleanly', async () => {
    let createCalls = 0;
    let terminateCalls = 0;
    let activeRecognize = 0;
    let maxConcurrent = 0;
    let capturedOptions: Record<string, unknown> | null = null;

    const svc = new WebMedicineTextRecognitionService({
      assetEnsurer: async () => undefined,
      moduleLoader: async () => ({
        default: {
          createWorker: async (_lang: string, _oem: number, opts: Record<string, unknown>) => {
            createCalls++;
            capturedOptions = opts;
            return {
              recognize: async (blob: Blob) => {
                activeRecognize++;
                maxConcurrent = Math.max(maxConcurrent, activeRecognize);
                await new Promise((r) => setTimeout(r, 15));
                activeRecognize--;
                const txt = await blob.text();
                return { data: { text: txt, confidence: 91 } };
              },
              terminate: async () => {
                terminateCalls++;
              }
            };
          }
        }
      })
    });

    const b1 = new Blob(['Amoxicillin 500mg capsules'], { type: 'text/plain' });
    const b2 = new Blob(['Paracetamol 500mg tablets'], { type: 'text/plain' });
    const b3 = new Blob(['Ciprofloxacin 500mg tablets'], { type: 'text/plain' });

    const [r1, r2, r3] = await Promise.all([svc.recognize(b1), svc.recognize(b2), svc.recognize(b3)]);
    strictEqual(createCalls, 1, 'Only ONE worker created across 3 concurrent jobs');
    strictEqual(maxConcurrent, 1, 'Recognize jobs are serialized through queue');
    strictEqual(r1.text, 'Amoxicillin 500mg capsules');
    strictEqual(r2.text, 'Paracetamol 500mg tablets');
    strictEqual(r3.text, 'Ciprofloxacin 500mg tablets');
    strictEqual(capturedOptions?.['workerBlobURL'], false, 'Same-origin workerBlobURL: false configured');
    strictEqual(capturedOptions?.['workerPath'], '/tesseract/worker.min.js');
    strictEqual(capturedOptions?.['corePath'], '/tesseract/core/');
    strictEqual(capturedOptions?.['langPath'], '/tesseract/lang');

    await svc.dispose();
    strictEqual(terminateCalls, 1, 'dispose() terminates live worker once');

    // Next recognize after dispose cleanly creates a fresh worker
    await svc.recognize(b1);
    strictEqual(createCalls, 2, 'New worker created cleanly after dispose()');
    await svc.dispose();
  });

  // 3. Model load failure -> clean reset -> retry succeeds without losing image or batch session
  await test('3. Model load failure in BatchCapture preserves captured image & session and recovers on retry', async () => {
    const batch = new BatchCaptureService();
    const sessionId = batch.startNewSession();

    const originalRecognizeWeb = medicineTextRecognitionService.recognizeWebImage.bind(medicineTextRecognitionService);
    const originalRecognizeStill = medicineTextRecognitionService.recognizeStillImage.bind(medicineTextRecognitionService);

    let attempts = 0;
    (medicineTextRecognitionService as any).recognizeWebImage = async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('تعذر تحميل نموذج التعرف الضوئي المحلي');
      }
      return { text: 'Amoxicillin 500mg capsules', lines: ['Amoxicillin 500mg capsules'], blocks: [] };
    };

    try {
      const sampleBlob = new Blob(['fake-image-bytes'], { type: 'image/jpeg' });
      const failedItem = await batch.addWebCapture(sampleBlob, catalogue);

      strictEqual(failedItem.status, 'failed', 'Failed model load marks item failed instead of dropping it');
      ok(failedItem.sourceImageBlob === sampleBlob, 'Original captured image blob preserved for retry');
      ok(failedItem.thumbnailUrl && failedItem.thumbnailUrl.length > 0, 'Thumbnail preserved during failure');
      strictEqual(batch.getSessionId(), sessionId, 'Batch session remains active');
      strictEqual(batch.getItems().length, 1, 'Failed item stays in session');

      // Retry without re-capturing photo
      const retriedItem = await batch.reprocessItem(failedItem.id, catalogue);
      strictEqual(retriedItem.status, 'ready', 'Retry succeeds cleanly');
      strictEqual(retriedItem.classification, 'VERIFIED MATCH', 'Retry produces accurate match classification');
      strictEqual(retriedItem.selectedMedicine, null, 'Clinical safety: never pre-selects unconfirmed OCR match');
      ok(retriedItem.candidates.some((c) => c.medicine.id === 'med-amox-500'), 'Correct candidate ranked for pharmacist');
    } finally {
      (medicineTextRecognitionService as any).recognizeWebImage = originalRecognizeWeb;
      (medicineTextRecognitionService as any).recognizeStillImage = originalRecognizeStill;
    }
  });

  // 4. Offline readiness after caching vs offline uncached error (zero external URLs)
  await test('4. Offline behavior: cached CacheStorage runs offline; uncached offline throws clear Arabic error', async () => {
    const requiredAssets = [
      '/tesseract/tesseract.esm.min.js',
      '/tesseract/worker.min.js',
      '/tesseract/core/tesseract-core.wasm.js',
      '/tesseract/core/tesseract-core-simd.wasm.js',
      '/tesseract/core/tesseract-core-lstm.wasm.js',
      '/tesseract/core/tesseract-core-simd-lstm.wasm.js',
      '/tesseract/core/tesseract-core.wasm',
      '/tesseract/core/tesseract-core-simd.wasm',
      '/tesseract/core/tesseract-core-lstm.wasm',
      '/tesseract/core/tesseract-core-simd-lstm.wasm',
      '/tesseract/lang/eng.traineddata.gz'
    ];

    const prevWindow = (globalThis as any).window;
    const prevWorker = (globalThis as any).Worker;
    const prevCaches = (globalThis as any).caches;
    const prevNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

    const cacheStore = new Map<string, { ok: boolean; url: string }>();

    (globalThis as any).window = { location: { origin: 'https://pharmacy.local' }, addEventListener: () => undefined };
    (globalThis as any).Worker = function FakeWorker() {};
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
    (globalThis as any).caches = {
      open: async () => ({
        match: async (u: string) => cacheStore.get(u),
        put: async (u: string, res: any) => { cacheStore.set(u, res); }
      }),
      match: async (u: string) => cacheStore.get(u)
    };

    try {
      const svc = new WebMedicineTextRecognitionService({
        moduleLoader: async () => ({
          default: {
            createWorker: async () => ({
              recognize: async () => ({ data: { text: 'Paracetamol 500mg tablets', confidence: 88 } }),
              terminate: async () => undefined
            })
          }
        })
      });

      // Case A: Offline and uncached -> clear Arabic error
      strictEqual(await svc.isReady(), false, 'Uncached state reports not ready');
      let offlineErr = '';
      try {
        await svc.recognize(new Blob(['img'], { type: 'image/jpeg' }));
      } catch (e: any) {
        offlineErr = e.message;
      }
      ok(offlineErr.includes('غير متصل بالإنترنت'), 'Offline uncached failure explains offline state in Arabic');

      // Case B: Populated CacheStorage while offline (airplane mode) -> runs with zero network
      for (const asset of requiredAssets) {
        cacheStore.set(asset, { ok: true, url: `https://pharmacy.local${asset}` });
      }
      strictEqual(await svc.isReady(), true, 'Cached state reports ready offline');
      const offlineRes = await svc.recognize(new Blob(['img'], { type: 'image/jpeg' }));
      strictEqual(offlineRes.text, 'Paracetamol 500mg tablets', 'OCR succeeds while navigator.onLine is false');
      await svc.dispose();
    } finally {
      (globalThis as any).window = prevWindow;
      (globalThis as any).Worker = prevWorker;
      (globalThis as any).caches = prevCaches;
      if (prevNavigatorDesc) Object.defineProperty(globalThis, 'navigator', prevNavigatorDesc);
    }
  });

  // 5. Clinical scenarios: similar strengths, blurry image, unknown medicine, 3-box isolation
  await test('5. Clinical safety scenarios: similar strengths, blurry image, unregistered drug, 3-package isolation', async () => {
    const batch = new BatchCaptureService();
    batch.startNewSession();
    const originalRecognizeWeb = medicineTextRecognitionService.recognizeWebImage.bind(medicineTextRecognitionService);

    (medicineTextRecognitionService as any).recognizeWebImage = async (blob: Blob) => {
      const txt = await blob.text();
      return { text: txt, lines: txt.split('\n'), blocks: [] };
    };

    try {
      // Single box + similar strengths (250mg must NOT verify 500mg; XR must NOT verify standard)
      const amox250 = await batch.addWebCapture(new Blob(['Amoxicillin 250mg suspension'], { type: 'text/plain' }), catalogue);
      strictEqual(amox250.candidates[0]?.medicine.id, 'med-amox-250');

      const metStd = await batch.addWebCapture(new Blob(['Metformin 500mg tablets'], { type: 'text/plain' }), catalogue);
      strictEqual(metStd.candidates[0]?.medicine.id, 'med-met-500-std');
      ok(metStd.candidates.every((c) => !(c.medicine.id === 'med-met-500-xr' && c.status === 'verified')), 'Standard release never verifies XR');

      // Blurry / unreadable text
      const blurry = await batch.addWebCapture(new Blob(['   '], { type: 'text/plain' }), catalogue);
      strictEqual(blurry.classification, 'UNKNOWN MEDICINE', 'Blurry/empty text never falsely matches a medicine');
      strictEqual(blurry.selectedMedicine, null);

      // Unregistered medicine
      const unknown = await batch.addWebCapture(new Blob(['ZyrtecDrops 10mg/ml oral'], { type: 'text/plain' }), catalogue);
      strictEqual(unknown.classification, 'UNKNOWN MEDICINE', 'Unregistered medicine stays UNKNOWN MEDICINE');
      strictEqual(unknown.selectedMedicine, null, 'Unregistered medicine never auto-added or selected');

      // 3 distinct items in session remain strictly bound and non-mixed
      const s = new BatchCaptureService();
      const sid = s.startNewSession();
      const i1 = s.addItemToSession(sid, { imageDataUrl: 'data:image/jpeg;base64,QQ==', ocrResult: { success: true, text: 'Amoxicillin 500mg capsules' }, parsedResult: null });
      const i2 = s.addItemToSession(sid, { imageDataUrl: 'data:image/jpeg;base64,Qg==', ocrResult: { success: true, text: 'Paracetamol 500mg tablets' }, parsedResult: null });
      const i3 = s.addItemToSession(sid, { imageDataUrl: 'data:image/jpeg;base64,Qw==', ocrResult: { success: true, text: 'Ciprofloxacin 500mg tablets' }, parsedResult: null });
      strictEqual(i1.ocrText, 'Amoxicillin 500mg capsules');
      strictEqual(i1.imageBase64, 'data:image/jpeg;base64,QQ==');
      strictEqual(i2.ocrText, 'Paracetamol 500mg tablets');
      strictEqual(i2.imageBase64, 'data:image/jpeg;base64,Qg==');
      strictEqual(i3.ocrText, 'Ciprofloxacin 500mg tablets');
      strictEqual(i3.imageBase64, 'data:image/jpeg;base64,Qw==');
    } finally {
      (medicineTextRecognitionService as any).recognizeWebImage = originalRecognizeWeb;
    }
  });

  // 6. Toolbar & UI verification in index.html
  await test('6. Simplified Arabic scan toolbar & contextual crop/retry UI in index.html', () => {
    const html = readFileSync('index.html', 'utf8');
    ok(html.includes('<span>مسح الأدوية بالكاميرا</span>'), 'Primary camera scan CTA is cleanly labeled in Arabic');
    ok(html.includes('<span>التقاط عدة عبوات</span>'), 'Secondary Batch Capture button has visible Arabic label');
    ok(html.includes('<span>إدخال الباركود</span>'), 'Secondary manual barcode button has visible Arabic label');
    ok(html.includes('<span>قص الصورة</span>'), 'Contextual crop button is available in review tools');
    ok(html.includes('@click="captureCameraFrameForMedicineOcr"'), 'Unified camera modal includes barcode-first + image OCR fallback');
    ok(html.includes('@click="retryCameraCapturedOcr"'), 'Camera modal provides retry on OCR error without losing image');
    ok(html.includes('@click="reprocessBatchItem(item.id)"'), 'Batch Capture failed card provides retry button');

    // Ensure developer PoC / mock buttons are removed from the POS toolbar section
    const posToolbarStart = html.indexOf('v-model="posQuery"');
    const posToolbarEnd = html.indexOf('Fast Drug Selection Grid', posToolbarStart);
    const posToolbarSlice = html.slice(posToolbarStart, posToolbarEnd);
    ok(!posToolbarSlice.includes('openMlKitPocModal'), 'ML Kit PoC developer button removed from POS toolbar');
    ok(!posToolbarSlice.includes('simulateBarcodeScan'), 'Mock barcode test button removed from POS toolbar');
    ok(!posToolbarSlice.includes('openSingleImageMultiModal'), 'Multi-image crop clutter removed from POS top bar (moved to image tools)');
  });

  // 7. OCR readability scorer rejects gibberish like "Er a ge pe Lo pe..." and prefers crisp labels
  await test('7. OCR readability scorer distinguishes readable medicine labels from noisy gibberish', () => {
    const gibberish = scoreOcrTextReadability('Er a ge pe Lo pe Fae 4 . en % A .... | ) ; Ei | "i EB 3 eg . . " ( D |', 58);
    const clean = scoreOcrTextReadability('Bralix 5 mg/2.5 mg\nsugar-coated tablets', 79);

    strictEqual(gibberish.isGarbled, true, 'Noisy character fragment output is flagged as garbled');
    strictEqual(clean.isGarbled, false, 'Clean brand + dosage + form output is accepted as readable');
    ok(clean.score > gibberish.score + 80, `Clean OCR score (${clean.score}) clearly outranks garbled output (${gibberish.score})`);
  });

  // 8. In-place per-item cropping updates OCR & thumbnail without dropping other session items
  await test('8. BatchCaptureService.updateItemCroppedImage updates item in-place and preserves session & original image', async () => {
    const batch = new BatchCaptureService();
    const sid = batch.startNewSession();
    const originalRecognize = medicineTextRecognitionService.recognizeWebImage.bind(medicineTextRecognitionService);

    let pass = 0;
    (medicineTextRecognitionService as any).recognizeWebImage = async () => {
      pass++;
      if (pass === 1) {
        return { text: 'Er a ge pe Lo pe | ) ;', lines: ['Er a ge pe Lo pe | ) ;'], blocks: [] };
      }
      if (pass === 2) {
        return { text: 'Paracetamol 500mg tablets', lines: ['Paracetamol 500mg tablets'], blocks: [] };
      }
      return { text: 'Amoxicillin 500mg capsules', lines: ['Amoxicillin 500mg capsules'], blocks: [] };
    };

    try {
      const origBlob1 = new Blob(['full-frame-1'], { type: 'image/jpeg' });
      const origBlob2 = new Blob(['full-frame-2'], { type: 'image/jpeg' });
      const item1 = await batch.addWebCapture(origBlob1, catalogue);
      const item2 = await batch.addWebCapture(origBlob2, catalogue);

      strictEqual(item1.classification, 'UNKNOWN MEDICINE', 'Initial unclear OCR yields UNKNOWN MEDICINE');
      strictEqual(batch.getItems().length, 2, 'Two items exist in batch session before crop');

      const croppedDataUrl = 'data:image/jpeg;base64,' + Buffer.from('tight-crop-amox').toString('base64');
      const updated = await batch.updateItemCroppedImage(item1.id, croppedDataUrl, catalogue);

      strictEqual(batch.getSessionId(), sid, 'Batch session ID stays unchanged after per-item crop');
      strictEqual(batch.getItems().length, 2, 'Cropping item #1 does NOT delete item #2');
      strictEqual(updated.id, item1.id, 'Updated item keeps its ID and sequence slot');
      strictEqual(updated.thumbnailUrl, croppedDataUrl, 'Updated thumbnail reflects cropped region');
      ok(updated.originalSourceBlob === origBlob1, 'Original full photo Blob is preserved for future re-crop');
      strictEqual(updated.ocrText, 'Amoxicillin 500mg capsules', 'OCR re-runs on the cropped region');
      strictEqual(updated.classification, 'VERIFIED MATCH', 'Cropped region clarifies medicine recognition');
      strictEqual(updated.selectedMedicine, null, 'Clinical safety: never auto-selects without pharmacist confirmation');
      strictEqual(item2.ocrText, 'Paracetamol 500mg tablets', 'Sibling batch item remains untouched');
    } finally {
      (medicineTextRecognitionService as any).recognizeWebImage = originalRecognize;
    }
  });

  // 9. Preview iframe safety: crop handlers must NOT use browser confirm(), interactive stage & Arabic labels present
  await test('9. Crop buttons avoid blocked confirm() in Preview iframe and expose interactive crop stage', () => {
    const html = readFileSync('index.html', 'utf8');
    const batchCropFnStart = html.indexOf('const openSingleImageFromBatchModal = () => {');
    const batchCropFnEnd = html.indexOf('const closeSingleImageMultiModal =', batchCropFnStart);
    ok(batchCropFnStart > 0 && batchCropFnEnd > batchCropFnStart, 'openSingleImageFromBatchModal exists');
    ok(!html.slice(batchCropFnStart, batchCropFnEnd).includes('confirm('), 'openSingleImageFromBatchModal must not use blocked browser confirm()');

    const camCropFnStart = html.indexOf('const openCropFromCapturedScannerFrame = () => {');
    const camCropFnEnd = html.indexOf('const reviewScannerOcrCandidate =', camCropFnStart);
    ok(camCropFnStart > 0 && camCropFnEnd > camCropFnStart, 'openCropFromCapturedScannerFrame exists');
    ok(!html.slice(camCropFnStart, camCropFnEnd).includes('confirm('), 'openCropFromCapturedScannerFrame must not use blocked browser confirm()');

    ok(html.includes('@click="openCropForBatchItem(item.id)"'), 'Per-item crop button is wired in Batch Capture cards');
    ok(html.includes('id="single-crop-stage"'), 'Interactive pointer crop stage exists');
    ok(html.includes('@pointerdown="startCropStagePointerDown"'), 'Touch/mouse drag-to-draw crop handler is wired');
    ok(html.includes('getClassificationLabel(item.classification)'), 'Arabic classification label helper is rendered on cards');
    ok(html.includes("window.confirm(t('applyDriveRestoreConfirm'))"), 'Google Drive restore explicit confirm guard remains intact');
  });

  // 10. Sideways / garbled OCR strings like ">nge1 © sie|del OE Buy apuidsul JAwelld" must NOT suggest garbage names
  await test('10. Sideways garbled OCR is rejected instead of proposing garbage name "nge1 ©"', () => {
    const sideways = scoreOcrTextReadability('>nge1 © sie|del OE Buy apuidsul JAwelld', 52);
    strictEqual(sideways.isGarbled, true, 'Sideways OCR noise is flagged as garbled');
    strictEqual(
      extractCleanMedicineNameSuggestion('>nge1 © sie|del OE Buy apuidsul JAwelld'),
      '',
      'extractCleanMedicineNameSuggestion never proposes garbled text like nge1 ©'
    );
    const garbledParsed = medicineTextRecognitionService.parseOcrText('>nge1 © sie|del OE Buy apuidsul JAwelld');
    strictEqual(garbledParsed.brandName, undefined, 'parseOcrText suppresses brandName on garbled OCR');

    const uprightText = 'Piramyl® 4mg\nGlimepiride 4 mg\n30 Tablets\nTabuk';
    const upright = scoreOcrTextReadability(uprightText, 84);
    strictEqual(upright.isGarbled, false, 'Upright vertical-rotated Piramyl label is readable');
    const cleanSuggestion = extractCleanMedicineNameSuggestion(uprightText);
    ok(cleanSuggestion.includes('Piramyl'), `Clean suggestion includes brand name ("${cleanSuggestion}")`);
    const uprightParsed = medicineTextRecognitionService.parseOcrText(uprightText);
    ok(String(uprightParsed.brandName || '').includes('Piramyl'), 'parseOcrText extracts clean brandName on upright label');
    strictEqual(uprightParsed.strength, '4mg', 'parseOcrText extracts dosage strength');
  });

  // 11. Pending capture review card & cropper expose 90-degree rotation and crop controls
  await test('11. Add-product Capture suggestion banner and cropper expose rotate-90 and crop actions', () => {
    const html = readFileSync('index.html', 'utf8');
    ok(html.includes('@click="rotateAndRetryPendingCapture"'), 'Capture suggestion box provides 90-degree rotate+retry button');
    ok(html.includes('@click="openCropForPendingCapture"'), 'Capture suggestion box provides interactive crop+rotate button');
    ok(html.includes('@click="rotateCropStageImage90"'), 'Crop modal toolbar provides 90-degree rotate button');
    ok(html.includes('isPendingCaptureOcrUnclear'), 'Capture suggestion hides gibberish pill when OCR is garbled');
  });

  console.log(`\nSUMMARY: ${passed}/${total} integration checks passed.`);
}

run().catch((err) => {
  console.error('Integration suite failed:', err);
  process.exit(1);
});
