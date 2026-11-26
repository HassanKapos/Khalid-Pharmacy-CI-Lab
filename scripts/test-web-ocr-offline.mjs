import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const assets = [
  'public/tesseract/tesseract.esm.min.js',
  'public/tesseract/worker.min.js',
  'public/tesseract/core/tesseract-core.wasm.js',
  'public/tesseract/core/tesseract-core-simd.wasm.js',
  'public/tesseract/core/tesseract-core-lstm.wasm.js',
  'public/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  'public/tesseract/core/tesseract-core.wasm',
  'public/tesseract/core/tesseract-core-simd.wasm',
  'public/tesseract/core/tesseract-core-lstm.wasm',
  'public/tesseract/core/tesseract-core-simd-lstm.wasm',
  'public/tesseract/lang/eng.traineddata.gz'
];
for (const asset of assets) {
  const path = join(root, asset);
  assert.ok(existsSync(path), `Missing local OCR asset: ${asset}`);
  assert.ok(statSync(path).size > (asset.endsWith('.wasm') || asset.endsWith('.traineddata.gz') ? 1000000 : 1000), `OCR asset is unexpectedly small: ${asset}`);
}
const service = readFileSync(join(root, 'src/services/webMedicineTextRecognitionService.ts'), 'utf8');
assert.ok(service.includes("workerPath: `${OCR_ROOT}/worker.min.js`"));
assert.ok(service.includes("corePath: `${OCR_ROOT}/core/`"));
assert.ok(service.includes("langPath: `${OCR_ROOT}/lang`"));
assert.ok(!/https?:\/\//.test(service), 'Web OCR service must not use external network URLs');
const sw = readFileSync(join(root, 'public/sw.js'), 'utf8');
for (const asset of assets) assert.ok(sw.includes('/' + asset.replace(/^public\//, '')), `Service Worker does not cache ${asset}`);
console.log('Web OCR offline asset integrity checks: all passed.');
