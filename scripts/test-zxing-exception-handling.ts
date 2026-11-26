import * as ZXingLib from '@zxing/library';
import { writeBarcode, type WriteInputBarcodeFormat } from 'zxing-wasm/writer';
import { purgeZXingModule, setZXingModuleOverrides } from 'zxing-wasm/reader';
import { ZXingJSEngineAdapter } from '../src/services/barcodeEngines/ZXingJSEngine';
import { ZXingWasmEngineAdapter } from '../src/services/barcodeEngines/ZXingWasmEngine';
import { NativeEngineAdapter } from '../src/services/barcodeEngines/NativeEngine';
import { BarcodeEngineManager } from '../src/services/barcodeEngines/EngineManager';

const ZXing: any = (ZXingLib as any).default && (ZXingLib as any).default.MultiFormatReader
  ? (ZXingLib as any).default
  : ZXingLib;

const NotFoundException = ZXing.NotFoundException || (ZXingLib as any).NotFoundException;
const ChecksumException = ZXing.ChecksumException || (ZXingLib as any).ChecksumException;
const FormatException = ZXing.FormatException || (ZXingLib as any).FormatException;
const ReaderException = ZXing.ReaderException || (ZXingLib as any).ReaderException;
const IllegalStateException = ZXing.IllegalStateException || (ZXingLib as any).IllegalStateException;

let passed = 0;
let total = 0;

function assert(condition: boolean, message: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ [PASS] ${message}`);
  } else {
    console.error(`  ✗ [FAIL] ${message}`);
    process.exitCode = 1;
  }
}

function createBlankImageData(width = 200, height = 200): ImageData {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  return { data, width, height } as unknown as ImageData;
}

async function renderBarcodeImageData(
  text: string,
  format: WriteInputBarcodeFormat,
  scale = 3
): Promise<ImageData> {
  const res = await writeBarcode(text, { format, scale, withQuietZones: true, withHRT: false });
  if (res.error || !res.symbol) {
    throw new Error(`Failed to generate ${format} test barcode: ${res.error || 'no symbol'}`);
  }
  const { data: gray, width: sw, height: sh } = res.symbol;
  const pad = 24;
  const outW = sw + pad * 2;
  const outH = sh + pad * 2;
  const rgba = new Uint8ClampedArray(outW * outH * 4).fill(255);

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = gray[y * sw + x];
      const idx = ((y + pad) * outW + (x + pad)) * 4;
      rgba[idx] = v;
      rgba[idx + 1] = v;
      rgba[idx + 2] = v;
      rgba[idx + 3] = 255;
    }
  }
  return { data: rgba, width: outW, height: outH } as unknown as ImageData;
}

async function runZxingExceptionSuite() {
  console.log('========================================================================');
  console.log('🧪 KHALID PHARMACY — ZXING & ADAPTER EXCEPTION REGRESSION SUITE');
  console.log('========================================================================\n');

  // -------------------------------------------------------------------------
  // 1. Blank frame misses return null cleanly
  // -------------------------------------------------------------------------
  console.log('--- Section 1: Blank Image Normal Miss Behavior ---');
  const jsAdapter = new ZXingJSEngineAdapter();
  const wasmAdapter = new ZXingWasmEngineAdapter();
  await jsAdapter.init();
  await wasmAdapter.init();

  const blankImg = createBlankImageData();
  const jsBlank = await jsAdapter.decode(blankImg);
  assert(jsBlank === null, 'ZXingJSEngineAdapter returns null on blank image without throwing');

  const wasmBlank = await wasmAdapter.decode(blankImg);
  assert(wasmBlank === null, 'ZXingWasmEngineAdapter returns null on blank image without throwing');

  // -------------------------------------------------------------------------
  // 2. Expected ZXing miss exceptions return null (no false fatal error)
  // -------------------------------------------------------------------------
  console.log('\n--- Section 2: Expected ZXing Reader Miss Exceptions ---');
  const expectedErrors = [
    { name: 'NotFoundException', err: new NotFoundException('No barcode in frame') },
    { name: 'ChecksumException', err: new ChecksumException('Bad checksum') },
    { name: 'FormatException', err: new FormatException('Invalid symbol format') },
    { name: 'ReaderException', err: new ReaderException('Reader failed to locate code') },
  ];

  for (const { name, err } of expectedErrors) {
    const mockAdapter = new ZXingJSEngineAdapter();
    await mockAdapter.init();
    (mockAdapter as any).reader = {
      decode: () => {
        throw err;
      }
    };
    let threw = false;
    let res = null;
    try {
      res = await mockAdapter.decode(blankImg);
    } catch {
      threw = true;
    }
    assert(!threw && res === null, `ZXingJSEngineAdapter treats ${name} as expected null miss`);
  }

  // -------------------------------------------------------------------------
  // 3. Unexpected adapter runtime errors must propagate (not swallowed to null)
  // -------------------------------------------------------------------------
  console.log('\n--- Section 3: Unexpected Runtime Error Propagation ---');
  const unexpectedErrors = [
    { name: 'TypeError', err: new TypeError('Unexpected internal reader failure') },
    { name: 'IllegalStateException', err: new IllegalStateException('Invalid decoder state') },
    { name: 'Runtime Error', err: new Error('Unexpected memory error') },
  ];

  for (const { name, err } of unexpectedErrors) {
    const mockAdapter = new ZXingJSEngineAdapter();
    await mockAdapter.init();
    (mockAdapter as any).reader = {
      decode: () => {
        throw err;
      }
    };
    let caught: unknown = null;
    try {
      await mockAdapter.decode(blankImg);
    } catch (e) {
      caught = e;
    }
    assert(caught === err, `ZXingJSEngineAdapter propagates unexpected ${name} to caller`);
  }

  // ZXingWasmEngineAdapter unexpected buffer access error propagation (without mutating global WASM loader yet)
  const wasmReadErr = new Error('Corrupt ImageData buffer');
  const corruptWasmImage = {
    data: new Proxy(new Uint8ClampedArray(16), {
      get(_target, prop) {
        if (prop === 'length' || prop === 'byteLength' || prop === 'buffer') {
          throw wasmReadErr;
        }
        return Reflect.get(_target, prop);
      }
    }),
    width: 2,
    height: 2
  } as unknown as ImageData;
  let wasmBufferCaught: unknown = null;
  try {
    await wasmAdapter.decode(corruptWasmImage);
  } catch (e) {
    wasmBufferCaught = e;
  }
  assert(wasmBufferCaught === wasmReadErr, 'ZXingWasmEngineAdapter propagates unexpected ImageData/buffer runtime errors');

  // NativeEngineAdapter expected miss vs valid decode vs unexpected runtime error
  const nativeBlankAdapter = new NativeEngineAdapter();
  (nativeBlankAdapter as any).detector = { detect: async () => [] };
  (nativeBlankAdapter as any).isInitialized = true;
  assert((await nativeBlankAdapter.decode(blankImg)) === null, 'NativeEngineAdapter returns null when no barcode is detected');

  const nativeValidAdapter = new NativeEngineAdapter();
  (nativeValidAdapter as any).detector = { detect: async () => [{ rawValue: '6211388017861', format: 'ean_13' }] };
  (nativeValidAdapter as any).isInitialized = true;
  const nativeRes = await nativeValidAdapter.decode(blankImg);
  assert(nativeRes?.barcode === '6211388017861' && nativeRes.type === 'EAN-13', 'NativeEngineAdapter returns decoded EAN-13 result');

  const nativeErrAdapter = new NativeEngineAdapter();
  const detectorFailure = new Error('BarcodeDetector hardware error');
  (nativeErrAdapter as any).detector = {
    detect: async () => {
      throw detectorFailure;
    }
  };
  (nativeErrAdapter as any).isInitialized = true;
  let nativeCaught: unknown = null;
  try {
    await nativeErrAdapter.decode(blankImg);
  } catch (e) {
    nativeCaught = e;
  }
  assert(nativeCaught === detectorFailure, 'NativeEngineAdapter propagates unexpected detector failure');

  // -------------------------------------------------------------------------
  // 4. EngineManager Failover & Benchmark Error Observability
  // -------------------------------------------------------------------------
  console.log('\n--- Section 4: EngineManager Failover Boundary Verification ---');
  const managerNativeFail = new BarcodeEngineManager();
  await managerNativeFail.initAll();
  (managerNativeFail as any).engines.set('native', nativeErrAdapter);
  managerNativeFail.setActiveEngine('native');
  const fail1Res = await managerNativeFail.decodeFrame(blankImg);
  assert(
    fail1Res === null &&
    managerNativeFail.getActiveEngineName() === 'zxing-wasm' &&
    (managerNativeFail.getFallbackReason() || '').includes('zxing-wasm'),
    'EngineManager fails over from broken native engine to zxing-wasm'
  );

  // Native misses ([]) while zxing-wasm throws -> must skip broken zxing-wasm and fail over to zxing-js
  const managerNativeMissWasmFail = new BarcodeEngineManager();
  await managerNativeMissWasmFail.initAll();
  (managerNativeMissWasmFail as any).engines.set('native', nativeBlankAdapter);
  (managerNativeMissWasmFail as any).engines.set('zxing-wasm', {
    name: 'zxing-wasm',
    init: async () => true,
    isAvailable: () => true,
    decode: async () => {
      throw new Error('WASM runtime aborted');
    },
    destroy: () => {}
  });
  managerNativeMissWasmFail.setActiveEngine('native');
  await managerNativeMissWasmFail.decodeFrame(blankImg);
  assert(
    managerNativeMissWasmFail.getActiveEngineName() === 'zxing-js' &&
    (managerNativeMissWasmFail.getFallbackReason() || '').includes('zxing-js'),
    'EngineManager fails over to zxing-js when native misses and zxing-wasm throws unexpectedly'
  );

  // Active zxing-wasm throws -> fails over to zxing-js
  const managerWasmFail = new BarcodeEngineManager();
  await managerWasmFail.initAll();
  (managerWasmFail as any).engines.set('zxing-wasm', {
    name: 'zxing-wasm',
    init: async () => true,
    isAvailable: () => true,
    decode: async () => {
      throw new Error('WASM decode exception');
    },
    destroy: () => {}
  });
  managerWasmFail.setActiveEngine('zxing-wasm');
  await managerWasmFail.decodeFrame(blankImg);
  assert(
    managerWasmFail.getActiveEngineName() === 'zxing-js' &&
    (managerWasmFail.getFallbackReason() || '').includes('zxing-js'),
    'EngineManager fails over from broken zxing-wasm to zxing-js'
  );

  // Benchmark reports null errorReason on blank misses and records actual errorReason on unexpected failures
  const blankBench = await managerWasmFail.runComparativeBenchmark(blankImg, 1);
  const wasmBenchEntry = blankBench.find((b) => b.engineName === 'zxing-wasm');
  const jsBenchEntry = blankBench.find((b) => b.engineName === 'zxing-js');
  assert(
    wasmBenchEntry?.errorReason === 'WASM decode exception' && jsBenchEntry?.errorReason === null,
    'Comparative benchmark isolates unexpected adapter errors from normal misses'
  );

  // -------------------------------------------------------------------------
  // 5. Real Format Decode Preservation (EAN-13, CODE-128, QR_CODE)
  // -------------------------------------------------------------------------
  console.log('\n--- Section 5: Existing Barcode Format Decode Verification ---');
  const ean13Img = await renderBarcodeImageData('6211388017861', 'EAN-13', 3);
  const code128Img = await renderBarcodeImageData('KHALID-PHARM-128', 'Code128', 3);
  const qrImg = await renderBarcodeImageData('PHARMACY-QR-2026', 'QRCode', 6);

  const jsEan13 = await jsAdapter.decode(ean13Img);
  const jsCode128 = await jsAdapter.decode(code128Img);
  const jsQr = await jsAdapter.decode(qrImg);
  assert(jsEan13?.barcode === '6211388017861' && jsEan13.type === 'EAN-13', 'ZXingJSEngineAdapter still decodes EAN-13');
  assert(jsCode128?.barcode === 'KHALID-PHARM-128' && jsCode128.type === 'CODE-128', 'ZXingJSEngineAdapter still decodes CODE-128');
  assert(jsQr?.barcode === 'PHARMACY-QR-2026', 'ZXingJSEngineAdapter still decodes QR_CODE');

  const wasmEan13 = await wasmAdapter.decode(ean13Img);
  const wasmCode128 = await wasmAdapter.decode(code128Img);
  const wasmQr = await wasmAdapter.decode(qrImg);
  assert(wasmEan13?.barcode === '6211388017861' && wasmEan13.type === 'EAN-13', 'ZXingWasmEngineAdapter still decodes EAN-13');
  assert(wasmCode128?.barcode === 'KHALID-PHARM-128' && wasmCode128.type === 'CODE-128', 'ZXingWasmEngineAdapter still decodes CODE-128');
  assert(wasmQr?.barcode === 'PHARMACY-QR-2026', 'ZXingWasmEngineAdapter still decodes QR_CODE');

  // Test authentic WASM instantiation RuntimeError after real WASM decodes
  purgeZXingModule();
  const wasmInitErr = new WebAssembly.RuntimeError('WASM instantiation failed');
  setZXingModuleOverrides({
    instantiateWasm: () => {
      throw wasmInitErr;
    }
  });
  let wasmInitCaught: unknown = null;
  try {
    await wasmAdapter.decode(blankImg);
  } catch (e) {
    wasmInitCaught = e;
  } finally {
    purgeZXingModule();
  }
  assert(wasmInitCaught === wasmInitErr, 'ZXingWasmEngineAdapter propagates WebAssembly.RuntimeError instantiation failure');

  console.log('\n========================================================================');
  console.log(`ZXING EXCEPTION REGRESSION SUMMARY: ${passed}/${total} PASSED`);
  console.log('========================================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runZxingExceptionSuite().catch((err) => {
  console.error('ZXing exception regression suite failed:', err);
  process.exit(1);
});
