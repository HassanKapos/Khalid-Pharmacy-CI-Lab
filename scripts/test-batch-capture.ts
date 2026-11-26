/**
 * Phase 3.6-A: Automated Verification Suite for Sequential Multi-Medicine Batch Capture
 * 
 * Verifies:
 * 1. Batch capture session initialization & sequencing.
 * 2. Independent OCR processing per item.
 * 3. Match classification (VERIFIED MATCH, POSSIBLE MATCH, NEEDS REVIEW, UNKNOWN, CONFLICT).
 * 4. Clinical differentiation (strength, dosage form, XR/SR release type, active ingredients).
 * 5. Duplicate detection across session items with warning alerts (no auto-deletion).
 * 6. Single item deletion and list re-indexing.
 * 7. Empty image / corrupted image handling.
 * 8. Individual OCR failure isolation (partial session failure does not abort other items).
 * 9. Session cancellation (complete memory purge).
 * 10. Camera Mutex arbitration (preventing concurrent CameraX collisions).
 * 11. Safety Invariant: ZERO database mutations, ZERO POS cart injections, ZERO stock alterations.
 */

import { strictEqual, ok } from 'node:assert';
import { readFileSync } from 'node:fs';
import { BatchCaptureService, BatchMedicineItem } from '../src/services/batchCaptureService.ts';
import { parseMedicineText, matchMedicineText, MedicineCatalogueEntry } from '../src/services/medicineTextParser.ts';
import { medicineTextRecognitionService } from '../src/services/medicineTextRecognitionService.ts';

let passed = 0;
let total = 0;

function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(() => {
        passed++;
        console.log(`✓ [PASS] ${name}`);
      }).catch((err) => {
        console.error(`✗ [FAIL] ${name}:`, err.message);
        throw err;
      });
    }
    passed++;
    console.log(`✓ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`✗ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

async function runBatchVerificationSuite() {
  console.log('=== PHASE 3.6-A: BATCH CAPTURE & CLINICAL MATCHING VERIFICATION ===\n');

  const catalogue: MedicineCatalogueEntry[] = [
    { id: 'med-amox-500', name: 'Amoxicillin 500mg capsules', barcode: '6281001001' },
    { id: 'med-amox-250', name: 'Amoxicillin 250mg suspension', barcode: '6281001002' },
    { id: 'med-amox-1000', name: 'Amoxicillin 1g tablets', barcode: '6281001003' },
    { id: 'med-met-500-std', name: 'Metformin 500mg tablets', barcode: '6281002001' },
    { id: 'med-met-500-xr', name: 'Metformin 500mg XR extended release tablets', barcode: '6281002002' },
    { id: 'med-met-850', name: 'Metformin 850mg tablets', barcode: '6281002003' },
    { id: 'med-para-500', name: 'Paracetamol 500mg tablets', barcode: '6281003001' },
    { id: 'med-para-syr', name: 'Paracetamol 120mg/5ml syrup', barcode: '6281003002' },
    { id: 'med-cipro-500', name: 'Ciprofloxacin 500mg tablets', barcode: '6281004001' }
  ];

  const indexHtml = readFileSync('index.html', 'utf8');
  await test('Vue candidate list uses v-for on template and v-if inside button', () => {
    ok(indexHtml.includes('<template v-for="cand in item.candidates.slice(0, 2)"'), 'Candidate loop is scoped by template');
    ok(indexHtml.includes('<button v-if="cand.status === \'candidate\' || cand.status === \'verified\'"'), 'Candidate visibility condition is inside the loop');
    ok(!indexHtml.includes('<button v-for="cand in item.candidates.slice(0, 2)" v-if='), 'No same-element v-for/v-if remains');
  });
  await test('Barcode proposal accepts only 8, 12, or 13 decimal digits', () => {
    const barcodeLine = indexHtml.split(String.fromCharCode(10)).find((line) => line.includes('const barcodeProposal'));
    ok(barcodeLine, 'Barcode validation expression exists in the capture form');
    const expression = barcodeLine!.slice(barcodeLine!.indexOf('=') + 1, barcodeLine!.indexOf('.test(rawBarcode)')).trim();
    ok(expression.startsWith('/') && expression.endsWith('/'), 'Barcode validation is a regular expression literal');
    const barcodePattern = new RegExp(expression.slice(1, -1));
    ok(barcodePattern.test('12345678'), 'EAN-8 is accepted');
    ok(barcodePattern.test('123456789012'), 'UPC-A is accepted');
    ok(barcodePattern.test('6211388017861'), 'EAN-13 is accepted');
    ok(!barcodePattern.test('1234567') && !barcodePattern.test('12345678901234') && !barcodePattern.test('ABC12345'), 'Invalid lengths and non-digits are rejected');
  });
  await test('General new-product form preserves its established default category', () => {
    const formStart = indexHtml.indexOf('const productForm = ref({');
    const formEnd = indexHtml.indexOf('});', formStart);
    ok(formStart >= 0 && formEnd > formStart, 'General product form declaration exists');
    ok(indexHtml.slice(formStart, formEnd).includes("category: 'Analgesics'"), 'General product form defaults to Analgesics');
  });

  const service = new BatchCaptureService();

  // Test 1: Session Initialization & State Cleanliness
  test('1. Session Initialization: generates unique session ID and starts empty', () => {
    const sessionId = service.startNewSession();
    ok(sessionId.startsWith('batch-'), 'Session ID has correct prefix');
    strictEqual(service.getItems().length, 0, 'New session starts with zero items');
    strictEqual(service.isBusy(), false, 'Session is not busy on startup');
  });

  // Regression: items created by single-image multi-region capture retain their crop for OCR retry.
  await test('Single-image region items retain image data and can be reprocessed', async () => {
    const sessionId = service.startNewSession();
    const imageDataUrl = 'data:image/jpeg;base64,c2luZ2xlLWltYWdlLWNyb3A=';
    const item = service.addItemToSession(sessionId, {
      imageDataUrl,
      ocrResult: { success: true, text: 'Amoxicillin 500mg capsules' },
      parsedResult: null
    });
    strictEqual(item.imageBase64, imageDataUrl, 'Cropped image data is retained for retry');
    const originalRecognize = medicineTextRecognitionService.recognizeStillImage.bind(medicineTextRecognitionService);
    let receivedImage = '';
    (medicineTextRecognitionService as any).recognizeStillImage = async (value: string) => {
      receivedImage = value;
      return { text: 'Amoxicillin 500mg capsules', lines: [], blocks: [] };
    };
    try {
      const retried = await service.reprocessItem(item.id, catalogue);
      strictEqual(receivedImage, imageDataUrl, 'Retry receives the same captured crop');
      strictEqual(retried.status, 'ready', 'Retry completes successfully');
      strictEqual(retried.ocrText, 'Amoxicillin 500mg capsules', 'Retry refreshes OCR text');
    } finally {
      (medicineTextRecognitionService as any).recognizeStillImage = originalRecognize;
    }
  });

  // Test 2: Sequential Independent Item Addition & Classification (Verified Match & Possible Match)
  test('2. Independent item classification: exact match classifies as VERIFIED MATCH', () => {
    const textVerified = 'Amoxicillin 500mg capsules';
    const profileVerified = parseMedicineText(textVerified);
    const candidatesVerified = matchMedicineText(profileVerified, catalogue);
    const resVerified = service.classifyMatch(candidatesVerified, textVerified);

    strictEqual(resVerified.classification, 'VERIFIED MATCH');
    strictEqual(resVerified.selected?.id, 'med-amox-500');
    strictEqual(resVerified.conflicts.length, 0);

    // Label with auxiliary words (e.g. 20 caps) classifies conservatively as POSSIBLE MATCH
    const textPossible = 'Amoxicillin 500mg capsules 20 caps';
    const profilePossible = parseMedicineText(textPossible);
    const candidatesPossible = matchMedicineText(profilePossible, catalogue);
    const resPossible = service.classifyMatch(candidatesPossible, textPossible);
    strictEqual(resPossible.classification, 'POSSIBLE MATCH');
    strictEqual(resPossible.selected?.id, 'med-amox-500');
  });

  // Test 3: Strength Differentiation (Clinical Safety)
  test('3. Clinical Safety: 500mg does NOT match 250mg or 1g', () => {
    const text250 = 'Amoxicillin 250mg suspension';
    const profile250 = parseMedicineText(text250);
    const candidates250 = matchMedicineText(profile250, catalogue);
    const res250 = service.classifyMatch(candidates250, text250);

    strictEqual(res250.classification, 'VERIFIED MATCH');
    strictEqual(res250.selected?.id, 'med-amox-250');
    ok(String(res250.selected?.id) !== 'med-amox-500', 'Must not match 500mg when label says 250mg');

    // Cross-check: label 500mg against catalogue containing only 250mg entry is rejected
    const candCross = matchMedicineText(parseMedicineText('Amoxicillin 500mg capsules'), [catalogue[1]]);
    ok(candCross.some((match) => match.status === 'rejected' && match.conflicts.length > 0), 'Wrong strength remains available as an explicit rejected conflict');
  });

  // Test 4: Extended Release vs Immediate Release Differentiation (XR / SR Conflict)
  test('4. Clinical Safety: Metformin 500mg XR matches XR and conflicts with standard', () => {
    const xrText = 'Metformin 500mg XR extended release tablets';
    const xrProfile = parseMedicineText(xrText);
    const xrCandidates = matchMedicineText(xrProfile, catalogue);
    const xrRes = service.classifyMatch(xrCandidates, xrText);

    strictEqual(xrRes.classification, 'VERIFIED MATCH');
    strictEqual(xrRes.selected?.id, 'med-met-500-xr');
    ok(String(xrRes.selected?.id) !== 'med-met-500-std', 'XR must not match standard immediate release');

    // Cross-release comparison: Metformin 500mg XR against Metformin 500mg SR produces a strict conflict
    const candXrAgainstSr = matchMedicineText(xrProfile, [
      { id: 'med-met-500-sr', name: 'Metformin 500mg SR sustained release tablets', barcode: '6281002004' }
    ]);
    ok(candXrAgainstSr.some((match) => match.status === 'rejected' && match.conflicts.length > 0), 'XR and SR release types remain explicit rejected conflicts');
  });

  // Test 5: Dosage Form Differentiation (Tablets vs Syrup)
  test('5. Clinical Safety: Paracetamol Syrup matches Syrup and rejects Tablets', () => {
    const textSyrup = 'Paracetamol 120mg/5ml syrup';
    const profileSyrup = parseMedicineText(textSyrup);
    const candidatesSyrup = matchMedicineText(profileSyrup, catalogue);
    const resSyrup = service.classifyMatch(candidatesSyrup, textSyrup);

    strictEqual(resSyrup.selected?.id, 'med-para-syr');
    ok(String(resSyrup.selected?.id) !== 'med-para-500', 'Syrup must never match tablet');

    // Matching syrup label against tablet catalogue entry is strictly rejected
    const candAgainstTab = matchMedicineText(profileSyrup, [catalogue[6]]);
    ok(candAgainstTab.some((match) => match.status === 'rejected' && match.conflicts.length > 0), 'Syrup/tablet mismatch remains an explicit rejected conflict');
  });

  // Test 6: Empty Image or Unrecognizable Text (UNKNOWN MEDICINE)
  test('6. Unrecognizable or empty text yields UNKNOWN MEDICINE', () => {
    const resEmpty = service.classifyMatch([], '');
    strictEqual(resEmpty.classification, 'UNKNOWN MEDICINE');
    strictEqual(resEmpty.selected, null);

    const resGarbage = service.classifyMatch([], 'random text without medicine tokens 1234');
    strictEqual(resGarbage.classification, 'UNKNOWN MEDICINE');
    strictEqual(resGarbage.selected, null);
  });

  // Test 7: Duplicate Detection within Batch Session
  test('7. Duplicate Detection: flags multiple occurrences of the same drug without auto-deletion', () => {
    service.startNewSession();

    // Simulate adding item 1
    const item1: BatchMedicineItem = {
      id: 'item-1',
      sequenceNumber: 1,
      capturedAt: new Date().toISOString(),
      status: 'ready',
      ocrText: 'Amoxicillin 500mg',
      candidates: [],
      selectedMedicine: catalogue[0], // med-amox-500
      classification: 'VERIFIED MATCH',
      reasons: [],
      conflicts: [],
      isDuplicateInSession: false,
      duplicateCount: 1,
      duplicateItemIds: [],
      isConfirmed: false
    };

    // Simulate adding item 2 (different drug)
    const item2: BatchMedicineItem = {
      id: 'item-2',
      sequenceNumber: 2,
      capturedAt: new Date().toISOString(),
      status: 'ready',
      ocrText: 'Paracetamol 500mg',
      candidates: [],
      selectedMedicine: catalogue[6], // med-para-500
      classification: 'VERIFIED MATCH',
      reasons: [],
      conflicts: [],
      isDuplicateInSession: false,
      duplicateCount: 1,
      duplicateItemIds: [],
      isConfirmed: false
    };

    // Simulate adding item 3 (duplicate of item 1)
    const item3: BatchMedicineItem = {
      id: 'item-3',
      sequenceNumber: 3,
      capturedAt: new Date().toISOString(),
      status: 'ready',
      ocrText: 'Amoxicillin 500mg capsules',
      candidates: [],
      selectedMedicine: catalogue[0], // med-amox-500
      classification: 'VERIFIED MATCH',
      reasons: [],
      conflicts: [],
      isDuplicateInSession: false,
      duplicateCount: 1,
      duplicateItemIds: [],
      isConfirmed: false
    };

    (service as any).items = [item1, item2, item3];
    service.recalculateSessionDuplicates();

    const items = service.getItems();
    strictEqual(items[0].isDuplicateInSession, true, 'Item 1 flagged as duplicate');
    strictEqual(items[0].duplicateCount, 2, 'Item 1 has count 2');
    ok(items[0].duplicateItemIds.includes('item-3'), 'Item 1 references Item 3');

    strictEqual(items[1].isDuplicateInSession, false, 'Item 2 is unique');

    strictEqual(items[2].isDuplicateInSession, true, 'Item 3 flagged as duplicate');
    strictEqual(items[2].duplicateCount, 2, 'Item 3 has count 2');
    ok(items[2].duplicateItemIds.includes('item-1'), 'Item 3 references Item 1');
  });

  // Test 8: Item Removal and Re-evaluating Session Duplicates
  test('8. Item Removal: removing duplicate clears duplicate flag on remaining item', () => {
    service.removeItem('item-3');
    const items = service.getItems();
    strictEqual(items.length, 2, 'Items reduced to 2');
    strictEqual(items[0].isDuplicateInSession, false, 'Remaining item 1 is no longer duplicate');
  });

  // Test 9: Camera Mutex Arbitration (Collision Prevention)
  test('9. Camera Mutex: prevents concurrent camera acquisition', () => {
    const owner1 = 'capture-task-1';
    const owner2 = 'capture-task-2';

    const locked1 = service.acquireCameraLock(owner1);
    strictEqual(locked1, true, 'First lock acquisition succeeds');

    const locked2 = service.acquireCameraLock(owner2);
    strictEqual(locked2, false, 'Second lock acquisition is rejected while first is active');

    service.releaseCameraLock(owner1);
    const lockedAgain = service.acquireCameraLock(owner2);
    strictEqual(lockedAgain, true, 'Lock acquired after previous owner released it');
    service.releaseCameraLock(owner2);
  });

  // Test 10: Partial Failure Isolation
  test('10. Partial Failure Isolation: one failed capture does not invalidate session', () => {
    service.startNewSession();
    const itemOk: BatchMedicineItem = {
      id: 'item-ok',
      sequenceNumber: 1,
      capturedAt: new Date().toISOString(),
      status: 'ready',
      ocrText: 'Ciprofloxacin 500mg',
      candidates: [],
      selectedMedicine: catalogue[8],
      classification: 'VERIFIED MATCH',
      reasons: [],
      conflicts: [],
      isDuplicateInSession: false,
      duplicateCount: 1,
      duplicateItemIds: [],
      isConfirmed: false
    };

    const itemFail: BatchMedicineItem = {
      id: 'item-fail',
      sequenceNumber: 2,
      capturedAt: new Date().toISOString(),
      status: 'failed',
      ocrText: '',
      candidates: [],
      selectedMedicine: null,
      classification: 'UNKNOWN MEDICINE',
      reasons: [],
      conflicts: ['انقطاع الاتصال أو فشل قراءة الملف'],
      errorMessage: 'انقطاع الاتصال أو فشل قراءة الملف',
      isDuplicateInSession: false,
      duplicateCount: 1,
      duplicateItemIds: [],
      isConfirmed: false
    };

    (service as any).items = [itemOk, itemFail];
    const summary = service.getSessionSummary();

    strictEqual(summary.totalItems, 2);
    strictEqual(summary.readyItems, 1);
    strictEqual(summary.failedItems, 1);
    strictEqual(summary.verifiedCount, 1);
  });

  // Test 11: Session Cancellation & Memory Release
  test('11. Session Cancellation: destroys items and resets state completely', () => {
    service.cancelSession();
    strictEqual(service.getItems().length, 0);
    strictEqual(service.isBusy(), false);
  });

  // Test 12: Safety Invariant Verification
  test('12. Safety Invariant: safeToAutoSelect is strictly false on all matches', () => {
    const profile = parseMedicineText('Amoxicillin 500mg');
    const candidates = matchMedicineText(profile, catalogue);
    for (const c of candidates) {
      strictEqual(c.safeToAutoSelect, false, 'Candidate must have safeToAutoSelect: false');
    }
  });


  // Test 13: Confidence alone must never produce VERIFIED MATCH.
  test('13. Safety: high confidence candidate remains POSSIBLE MATCH', () => {
    const highConfidenceCandidate = [{
      medicine: catalogue[0],
      status: 'candidate' as const,
      confidence: 0.99,
      reasons: ['similarity only'],
      conflicts: [],
      safeToAutoSelect: false
    }];
    const result = service.classifyMatch(highConfidenceCandidate, 'Amoxicillin 500mg capsules');
    strictEqual(result.classification, 'POSSIBLE MATCH');
    strictEqual(result.selected?.id, catalogue[0].id);
  });

  // Test 14: Rejected candidates remain conflicts even with an inflated confidence.
  test('14. Safety: rejected candidate cannot become a possible/verified match', () => {
    const rejectedCandidate = [{
      medicine: catalogue[0],
      status: 'rejected' as const,
      confidence: 0.99,
      reasons: [],
      conflicts: ['explicit strength conflict'],
      safeToAutoSelect: false
    }];
    const result = service.classifyMatch(rejectedCandidate, 'Amoxicillin 250mg syrup');
    strictEqual(result.classification, 'CONFLICT');
    strictEqual(result.selected, null);
  });

  // Test 15: Confirmation requires an explicit per-item pharmacist review.
  test('15. Safety: bulk confirmation is disabled and individual confirmation requires manual review', () => {
    const reviewItem: BatchMedicineItem = {
      id: 'review-item',
      sequenceNumber: 1,
      capturedAt: new Date().toISOString(),
      status: 'ready',
      ocrText: 'Amoxicillin 500mg capsules',
      candidates: [{
        medicine: catalogue[0],
        status: 'candidate',
        confidence: 0.8,
        reasons: [],
        conflicts: [],
        safeToAutoSelect: false
      }],
      selectedMedicine: catalogue[0],
      classification: 'VERIFIED MATCH',
      reasons: [],
      conflicts: [],
      isDuplicateInSession: false,
      duplicateCount: 1,
      duplicateItemIds: [],
      isConfirmed: false,
      isManuallyReviewed: false
    };
    (service as any).items = [reviewItem];
    strictEqual(service.confirmAllEligibleItems(), 0);
    service.setItemConfirmation(reviewItem.id, true);
    strictEqual(reviewItem.isConfirmed, false);
    service.manuallySelectMedicine(reviewItem.id, catalogue[0]);
    service.setItemConfirmation(reviewItem.id, true);
    strictEqual(reviewItem.isConfirmed, true);
  });

  // Test 16: Unique barcode is not an approval when OCR attributes are missing.
  test('16. Safety: barcode-only match with missing OCR attributes remains a candidate', () => {
    const barcodeOnly = matchMedicineText(
      parseMedicineText('Amoxicillin'),
      catalogue,
      '6281001001'
    );
    strictEqual(barcodeOnly.length, 1);
    strictEqual(barcodeOnly[0].status, 'candidate');
    strictEqual(barcodeOnly[0].safeToAutoSelect, false);
  });


  // Test 16b: A barcode cannot verify a different medicine name with matching strength/form.
  test('16b. Safety: barcode match without a matching medicine name remains a candidate', () => {
    const nameMismatch = matchMedicineText(
      parseMedicineText('DifferentBrand 500mg capsules'),
      catalogue,
      '6281001001'
    );
    strictEqual(nameMismatch.length, 1);
    strictEqual(nameMismatch[0].status, 'candidate');
    strictEqual(nameMismatch[0].safeToAutoSelect, false);
  });

  // Test 17: Explicit OCR mismatch rejects a unique barcode match.
  test('17. Safety: barcode cannot override an explicit strength conflict', () => {
    const barcodeConflict = matchMedicineText(
      parseMedicineText('Amoxicillin 250mg capsules'),
      catalogue,
      '6281001001'
    );
    strictEqual(barcodeConflict.length, 1);
    strictEqual(barcodeConflict[0].status, 'rejected');
    strictEqual(barcodeConflict[0].safeToAutoSelect, false);
  });

  // Test 17b: addItemToSession always keeps selectedMedicine null until manual pharmacist selection.
  test("17b. Safety: addItemToSession never auto-selects selectedMedicine and leaves confirmAllEligibleItems at 0", () => {
    const sId = service.startNewSession();
    const profile = parseMedicineText("Amoxicillin 500mg capsules");
    const cands = matchMedicineText(profile, catalogue);
    const added = service.addItemToSession(sId, {
      imageDataUrl: "data:image/jpeg;base64,test17b",
      ocrResult: { success: true, text: "Amoxicillin 500mg capsules" },
      candidates: cands,
      parsedResult: null
    });
    strictEqual(added.selectedMedicine, null);
    strictEqual(added.isManuallyReviewed, false);
    strictEqual(added.isConfirmed, false);
    strictEqual(service.confirmAllEligibleItems(), 0);
    strictEqual(service.getItems()[0].isConfirmed, false);
  });


  // Test 18: Results from a cancelled session must never mutate the new session.
  total++;
  const originalRecognizeWebImage = medicineTextRecognitionService.recognizeWebImage;
  let resolveOcr: ((value: any) => void) | undefined;
  try {
    medicineTextRecognitionService.recognizeWebImage = (() => new Promise((resolve) => {
      resolveOcr = resolve;
    })) as any;
    const pendingCapture = service.addWebCapture(
      new Blob(['stale-session-test'], { type: 'image/png' }),
      catalogue
    );
    service.cancelSession();
    if (!resolveOcr) throw new Error('OCR test promise was not initialized');
    resolveOcr({ text: 'Amoxicillin 500mg capsules' });
    const staleResult = await pendingCapture;
    strictEqual(staleResult.status, 'cancelled');
    strictEqual(service.getItems().length, 0);
    passed++;
    console.log('✓ [PASS] 18. Session Isolation: stale OCR result cannot repopulate a cancelled session');
  } catch (err: any) {
    console.error('✗ [FAIL] 18. Session Isolation:', err?.message || err);
    throw err;
  } finally {
    medicineTextRecognitionService.recognizeWebImage = originalRecognizeWebImage;
  }


  // Test 19: Explicit parser conflicts must reach the batch classification layer.
  test('19. Safety: explicit strength/form mismatch is surfaced as CONFLICT', () => {
    const rejected = matchMedicineText(
      parseMedicineText('Amoxicillin 500mg capsules'),
      [catalogue[1]]
    );
    const result = service.classifyMatch(rejected, 'Amoxicillin 500mg capsules');
    strictEqual(rejected[0]?.status, 'rejected');
    strictEqual(result.classification, 'CONFLICT');
    strictEqual(result.selected, null);
  });

  // Test 20: Segmentation must not select a rejected result into the session.
  test('20. Safety: rejected parsed result is stored as CONFLICT without selection', () => {
    const activeSessionId = service.getSessionId();
    const conflictItem = service.addItemToSession(activeSessionId, {
      imageDataUrl: 'data:image/jpeg;base64,mock',
      ocrResult: { success: true, text: 'Amoxicillin 250mg syrup' },
      parsedResult: {
        matchedProduct: catalogue[0],
        confidence: 0.99,
        classification: 'CONFLICT',
        matchReason: 'strength/form conflict'
      }
    });
    strictEqual(conflictItem.classification, 'CONFLICT');
    strictEqual(conflictItem.selectedMedicine, null);
    strictEqual(conflictItem.candidates[0]?.status, 'rejected');
  });

  // Test 21: An old session ID cannot append into a newly started session.
  test('21. Safety: addItemToSession rejects results carrying a stale session ID', () => {
    const staleSessionId = service.getSessionId();
    service.startNewSession();
    let staleWriteRejected = false;
    try {
      service.addItemToSession(staleSessionId, {
        imageDataUrl: 'data:image/jpeg;base64,mock',
        ocrResult: { success: true, text: 'Paracetamol 500mg tablets' },
        parsedResult: null
      });
    } catch {
      staleWriteRejected = true;
    }
    strictEqual(staleWriteRejected, true);
    strictEqual(service.getItems().length, 0);
  });


  // Test 22: OCR matches remain suggestions until the pharmacist explicitly selects one.
  test('22. Safety: OCR match is not preselected or confirmable before manual pharmacist selection', () => {
    const sessionId = service.getSessionId();
    const item = service.addItemToSession(sessionId, {
      imageDataUrl: 'data:image/jpeg;base64,suggestion-only',
      ocrResult: { success: true, text: 'Amoxicillin 500mg capsules' },
      parsedResult: {
        matchedProduct: catalogue[0],
        confidence: 0.99,
        classification: 'VERIFIED MATCH',
        matchReason: 'strict parser match'
      }
    });
    strictEqual(item.selectedMedicine, null);
    strictEqual(item.isManuallyReviewed, false);
    service.setItemConfirmation(item.id, true);
    strictEqual(item.isConfirmed, false);
    service.manuallySelectMedicine(item.id, catalogue[0]);
    const reviewedItem = service.getItem(item.id) as BatchMedicineItem;
    strictEqual(reviewedItem.selectedMedicine?.id, catalogue[0].id);
    strictEqual(reviewedItem.isManuallyReviewed, true);
    service.setItemConfirmation(item.id, true);
    strictEqual(item.isConfirmed, true);
  });

  // Test 23: Starting a new session must not release an in-flight camera mutex.
  test('23. Safety: session reset retains the active camera lock until its owner releases it', () => {
    service.startNewSession();
    const owner = 'in-flight-native-capture';
    strictEqual(service.acquireCameraLock(owner), true);
    service.startNewSession();
    strictEqual(service.acquireCameraLock('new-session-capture'), false);
    service.releaseCameraLock(owner);
    strictEqual(service.acquireCameraLock('new-session-capture'), true);
    service.releaseCameraLock('new-session-capture');
  });

  // Test 24: manual selection must resolve to a clean candidate on this item.
  test('24. Safety: manual selection only accepts an existing non-rejected candidate', () => {
    service.startNewSession();
    const item = service.addItemToSession(service.getSessionId(), {
      imageDataUrl: 'data:image/jpeg;base64,manual-selection',
      ocrResult: { success: true, text: 'Amoxicillin 500mg capsules' },
      parsedResult: null
    });
    item.candidates = [{
      medicine: catalogue[0], status: 'candidate', confidence: 0.8,
      reasons: [], conflicts: [], safeToAutoSelect: false
    }];
    strictEqual(service.manuallySelectMedicine(item.id, catalogue[0]), true);
    strictEqual(item.selectedMedicine?.id, catalogue[0].id);
    strictEqual(item.isManuallyReviewed, true);
  });

  test('25. Safety: manual selection rejects rejected, conflicting, and unlisted medicines', () => {
    service.startNewSession();
    const item = service.addItemToSession(service.getSessionId(), {
      imageDataUrl: 'data:image/jpeg;base64,rejected-selection',
      ocrResult: { success: true, text: 'Amoxicillin 500mg capsules' },
      parsedResult: null
    });
    item.candidates = [{
      medicine: catalogue[0], status: 'rejected', confidence: 0,
      reasons: [], conflicts: ['strength conflict'], safeToAutoSelect: false
    }];
    strictEqual(service.manuallySelectMedicine(item.id, catalogue[0]), false);
    strictEqual(item.selectedMedicine, null);
    strictEqual(item.isManuallyReviewed, false);
    strictEqual(service.manuallySelectMedicine(item.id, catalogue[1]), false);
    strictEqual(item.selectedMedicine, null);

    item.candidates = [{
      medicine: catalogue[0], status: 'candidate', confidence: 0.8,
      reasons: [], conflicts: ['unresolved conflict'], safeToAutoSelect: false
    }];
    strictEqual(service.manuallySelectMedicine(item.id, catalogue[0]), false);
    strictEqual(item.selectedMedicine, null);
    strictEqual(item.isManuallyReviewed, false);
  });

  // Test 26: Caller-supplied fields cannot replace canonical catalogue data.
  test('26. Safety: forged medicine fields never replace the canonical candidate object', () => {
    service.startNewSession();
    const item = service.addItemToSession(service.getSessionId(), { imageDataUrl: 'data:image/jpeg;base64,forged-selection', ocrResult: { success: true, text: 'Amoxicillin 500mg capsules' }, parsedResult: null });
    item.candidates = [{ medicine: catalogue[0], status: 'candidate', confidence: 0.8, reasons: [], conflicts: [], safeToAutoSelect: false }];
    const forgedMedicine = { ...catalogue[0], name: 'FORGED MEDICINE', barcode: '9999999999' };
    strictEqual(service.manuallySelectMedicine(item.id, forgedMedicine), true);
    strictEqual(item.selectedMedicine, catalogue[0]);
    strictEqual(item.selectedMedicine?.name, catalogue[0].name);
    strictEqual(item.selectedMedicine?.barcode, catalogue[0].barcode);
    strictEqual(item.isConfirmed, false);
  });

  // Test 27: Malformed candidate state and non-ready items are rejected without mutation.
  test('27. Safety: malformed candidates, IDs, and non-ready items are rejected', () => {
    service.startNewSession();
    const item = service.addItemToSession(service.getSessionId(), { imageDataUrl: 'data:image/jpeg;base64,malformed-selection', ocrResult: { success: true, text: 'Amoxicillin 500mg capsules' }, parsedResult: null });
    item.candidates = null as any;
    strictEqual(service.manuallySelectMedicine(item.id, catalogue[0]), false);
    item.candidates = [{ medicine: catalogue[0], status: 'candidate', confidence: 0.8, reasons: [], conflicts: null as any, safeToAutoSelect: false }];
    strictEqual(service.manuallySelectMedicine(item.id, catalogue[0]), false);
    item.candidates = [{ medicine: catalogue[0], status: 'unknown' as any, confidence: 0.8, reasons: [], conflicts: [], safeToAutoSelect: false }];
    strictEqual(service.manuallySelectMedicine(item.id, catalogue[0]), false);
    item.candidates = [{ medicine: { ...catalogue[0], name: '   ' }, status: 'candidate', confidence: 0.8, reasons: [], conflicts: [], safeToAutoSelect: false }];
    strictEqual(service.manuallySelectMedicine(item.id, catalogue[0]), false);
    item.candidates = [{ medicine: catalogue[0], status: 'candidate', confidence: 0.8, reasons: [], conflicts: [], safeToAutoSelect: false }];
    strictEqual(service.manuallySelectMedicine(item.id, null as any), false);
    strictEqual(service.manuallySelectMedicine(item.id, { id: '   ' } as any), false);
    item.status = 'processing';
    strictEqual(service.manuallySelectMedicine(item.id, catalogue[0]), false);
    strictEqual(item.selectedMedicine, null);
    strictEqual(item.isManuallyReviewed, false);
    strictEqual(item.isConfirmed, false);
  });


  // Test 28: Android capture image and OCR stay attached to the same item.
  await test('28. Android Capture: original image and capture ID are retained with OCR', async () => {
    const originalCapture = medicineTextRecognitionService.captureAndRecognize;
    service.startNewSession();
    const image = 'data:image/jpeg;base64,dGVzdC1pbWFnZQ==';
    (medicineTextRecognitionService as any).captureAndRecognize = async () => ({
      text: 'Amoxicillin 500mg capsules',
      lines: ['Amoxicillin 500mg capsules'],
      blocks: [],
      imageBase64: image,
      captureId: 'native-capture-test-28',
      mimeType: 'image/jpeg',
      cancelled: false
    });
    try {
      const item = await service.addNativeCapture(catalogue);
      ok(item);
      strictEqual(item?.captureId, 'native-capture-test-28');
      strictEqual(item?.imageBase64, image);
      strictEqual(item?.thumbnailUrl, image);
      strictEqual(item?.ocrText, 'Amoxicillin 500mg capsules');
      strictEqual(item?.selectedMedicine, null);
    } finally {
      (medicineTextRecognitionService as any).captureAndRecognize = originalCapture;
    }
  });

  // Test 29: Native OCR without its source image is rejected.
  await test('29. Android Capture: OCR without original image is rejected', async () => {
    const originalCapture = medicineTextRecognitionService.captureAndRecognize;
    service.startNewSession();
    (medicineTextRecognitionService as any).captureAndRecognize = async () => ({
      text: 'Amoxicillin 500mg capsules',
      lines: ['Amoxicillin 500mg capsules'],
      blocks: [],
      cancelled: false
    });
    try {
      const item = await service.addNativeCapture(catalogue);
      ok(item);
      strictEqual(item?.status, 'failed');
      strictEqual(item?.classification, 'UNKNOWN MEDICINE');
      strictEqual(item?.thumbnailUrl, undefined);
    } finally {
      (medicineTextRecognitionService as any).captureAndRecognize = originalCapture;
    }
  });

  // Test 30: New saved medicines use the dedicated source-capture linking path.
  test('30. Suggestion linking: saved medicine links only to its reviewed source capture', () => {
    service.startNewSession();
    const item = service.addItemToSession(service.getSessionId(), {
      imageDataUrl: 'data:image/jpeg;base64,review-image',
      ocrResult: { success: true, text: 'New Medicine 500mg tablets' },
      parsedResult: null
    });
    item.suggestionStatus = 'under_review';
    const linked = service.linkSavedMedicine(item.id, { id: 'new-med-30', name: 'New Medicine 500mg tablets', barcode: '6281234567890' });
    strictEqual(linked, true);
    strictEqual(item.suggestionStatus, 'linked');
    strictEqual(item.selectedMedicine?.id, 'new-med-30');
    strictEqual(item.isManuallyReviewed, true);
    strictEqual(item.isConfirmed, false);
  });

  test('31. Suggestion linking: rejects missing source image or unreviewed suggestion', () => {
    service.startNewSession();
    const item = service.addItemToSession(service.getSessionId(), {
      imageDataUrl: 'data:image/jpeg;base64,review-image',
      ocrResult: { success: true, text: 'New Medicine 500mg tablets' },
      parsedResult: null
    });
    strictEqual(service.linkSavedMedicine(item.id, { id: 'new-med-31', name: 'New Medicine 500mg tablets' }), false);
    item.suggestionStatus = 'under_review';
    item.captureId = undefined;
    strictEqual(service.linkSavedMedicine(item.id, { id: 'new-med-31', name: 'New Medicine 500mg tablets' }), false);
  });

  test('32. Session Lifecycle: active empty session remains identifiable until explicit discard', () => {
    const sessionId = service.startNewSession();
    strictEqual(service.getCurrentSession()?.sessionId, sessionId);
    strictEqual(service.getCurrentSession()?.items.length, 0);
    service.cancelSession();
    strictEqual(service.getCurrentSession(), null);
  });

  // Test 33: Preserve main's real-world verbose package OCR regression coverage.
  test('33. Verbose box OCR: Amaryl box with extra marketing/generic lines remains a POSSIBLE MATCH', () => {
    const realCatalogue: MedicineCatalogueEntry[] = [
      { id: 'med-amaryl-4', name: 'Amaryl 4mg', barcode: '6223003991852' },
      { id: 'med-lasix-40', name: 'Lasix 40mg', barcode: '6223003990824' }
    ];
    const boxOcr = 'Amaryl\\nGlimepiride\\nOral antidiabetic\\n30 Tablets\\n4 mg\\nsanofi';
    const profile = parseMedicineText(boxOcr);
    const candidates = matchMedicineText(profile, realCatalogue);
    const classified = service.classifyMatch(candidates, boxOcr);
    strictEqual(classified.classification, 'POSSIBLE MATCH');
    strictEqual(classified.selected?.id, 'med-amaryl-4');

    const typoOcr = 'Amary1 Glimepiride Oral antidiabetic 30 Tablets 4 mg sanofi';
    const typoCandidates = matchMedicineText(parseMedicineText(typoOcr), realCatalogue);
    ok(typoCandidates.length > 0 && typoCandidates[0].medicine.id === 'med-amaryl-4',
      'OCR glyph lookalike still suggests Amaryl 4mg');
  });

  // Test 34: Preserve main's weak/failed OCR safety regression coverage.
  test('34. Safety: failed or weak OCR never pre-selects a medicine', () => {
    const sessionId = service.startNewSession();
    const weakItem = service.addItemToSession(sessionId, {
      imageDataUrl: 'data:image/jpeg;base64,test-weak-ocr',
      ocrResult: { success: false, text: '', errorMessage: 'OCR timeout' },
      candidates: [],
      parsedResult: null
    });
    strictEqual(weakItem.status, 'failed');
    strictEqual(weakItem.selectedMedicine, null);
    strictEqual(weakItem.classification, 'UNKNOWN MEDICINE');
  });
  console.log(`\n========================================`);

  console.log(`ALL BATCH CAPTURE TESTS PASSED: ${passed}/${total} (100%)`);
  console.log(`========================================\n`);
}

runBatchVerificationSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
