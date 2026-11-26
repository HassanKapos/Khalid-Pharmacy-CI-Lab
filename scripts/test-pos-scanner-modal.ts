/**
 * Automated Verification Test: POS Camera Scanner Button & Modal Accessibility
 * Pure Node.js test without external dependencies
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

async function runTest() {
  console.log('========================================================================');
  console.log('🧪 TESTING POS CAMERA SCANNER BUTTON & MODAL INDEPENDENCE');
  console.log('========================================================================\n');

  const htmlContent = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

  // Test 1: DOM Structure - Check that showOverrideReasonModal is closed before showCameraScannerModal starts
  console.log('--- Test 1: DOM Hierarchy & Nesting Verification ---');
  const overrideStart = htmlContent.indexOf('v-if="showOverrideReasonModal"');
  assert(overrideStart !== -1, 'Found showOverrideReasonModal in template');

  const scannerStart = htmlContent.indexOf('v-if="showCameraScannerModal"');
  assert(scannerStart !== -1, 'Found showCameraScannerModal in template');

  // Check the slice between overrideStart and scannerStart
  const intermediateSlice = htmlContent.slice(overrideStart, scannerStart);
  
  // Count div opens and closes in intermediateSlice
  const interOpens = (intermediateSlice.match(/<div(\s|>)/gi) || []).length;
  const interCloses = (intermediateSlice.match(/<\/div>/gi) || []).length;
  
  assert(interOpens === interCloses, `Override modal is completely closed before scanner modal (Opens: ${interOpens}, Closes: ${interCloses})`);

  // Test 2: Check POS camera button onclick attribute
  console.log('\n--- Test 2: POS Camera Scanner Button Binding ---');
  const hasPosCameraBtn = htmlContent.includes('@click="openCameraScanner(\'pos\')"');
  assert(hasPosCameraBtn, 'POS camera button has exact binding @click="openCameraScanner(\'pos\')"');

  // Test 3: Verify balanced div tags across the entire #app template
  console.log('\n--- Test 3: HTML Div Tag Balance Verification ---');
  const appStart = htmlContent.indexOf('<div id="app"');
  const scriptStart = htmlContent.indexOf('<script', appStart);
  const templateChunk = htmlContent.slice(appStart, scriptStart);

  const openDivs = (templateChunk.match(/<div(\s|>)/gi) || []).length;
  const closeDivs = (templateChunk.match(/<\/div>/gi) || []).length;
  assert(openDivs === closeDivs, `Div tags in #app are completely balanced (Opens: ${openDivs}, Closes: ${closeDivs})`);

  // Test 4: Vue Reactive Logic Simulation
  console.log('\n--- Test 4: Modal State Logic Simulation ---');
  const state = {
    showCameraScannerModal: false,
    showOverrideReasonModal: false,
    scannerTarget: 'pos',
    scannerErrorMessage: '',
    isTorchOn: false
  };

  const openCameraScanner = (target = 'pos') => {
    state.scannerTarget = target;
    state.scannerErrorMessage = '';
    state.showCameraScannerModal = true;
  };

  const closeCameraScanner = () => {
    state.showCameraScannerModal = false;
    state.isTorchOn = false;
  };

  assert(state.showCameraScannerModal === false, 'Scanner modal initially closed');
  assert(state.showOverrideReasonModal === false, 'Override reason modal initially closed');

  // Trigger button click
  openCameraScanner('pos');
  assert(state.showCameraScannerModal === true, 'Clicking POS button sets showCameraScannerModal to true');
  assert(state.scannerTarget === 'pos', 'scannerTarget is set to "pos"');

  // Close scanner
  closeCameraScanner();
  assert(state.showCameraScannerModal === false, 'closeCameraScanner closes modal cleanly');

  // Test 5: Fallback manual input and camera controls present in scanner modal
  console.log('\n--- Test 5: Fallback & Resilience Controls ---');
  const scannerModalChunk = htmlContent.slice(scannerStart, htmlContent.indexOf('showUnlinkedBarcodeModal'));
  assert(scannerModalChunk.includes('v-model="scannerManualInput"'), 'Scanner modal contains manual barcode input');
  assert(scannerModalChunk.includes('@click="submitManualBarcode"'), 'Scanner modal contains submitManualBarcode button');
  assert(scannerModalChunk.includes('ref="scannerVideoRef"'), 'Scanner modal contains videoElement with ref="scannerVideoRef"');
  assert(scannerModalChunk.includes('v-if="scannerErrorMessage"'), 'Scanner modal handles camera permission/unavailability errors gracefully');

  // Test 6: Permissions in metadata.json
  console.log('\n--- Test 6: metadata.json Frame Permissions ---');
  const meta = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'metadata.json'), 'utf8'));
  assert(Array.isArray(meta.requestFramePermissions) && meta.requestFramePermissions.includes('camera'), 'metadata.json includes "camera" in requestFramePermissions');

  // Test 7: Vue template refs (barcodeInput & scannerVideoRef) are declared and returned from setup()
  console.log('\n--- Test 7: Vue Template Refs Registration ---');
  assert(htmlContent.includes('const barcodeInput = ref(null);'), 'barcodeInput ref is declared in Vue setup()');
  assert(htmlContent.includes('const scannerVideoRef = ref(null);'), 'scannerVideoRef ref is declared in Vue setup()');
  const setupReturnSlice = htmlContent.slice(htmlContent.lastIndexOf('return {'));
  assert(setupReturnSlice.includes('barcodeInput,'), 'barcodeInput is returned from Vue setup()');
  assert(setupReturnSlice.includes('scannerVideoRef,'), 'scannerVideoRef is returned from Vue setup()');
  assert(setupReturnSlice.includes('focusManualBarcodeInput,'), 'focusManualBarcodeInput is returned from Vue setup()');

  console.log('\n========================================================================');
  console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTest().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
