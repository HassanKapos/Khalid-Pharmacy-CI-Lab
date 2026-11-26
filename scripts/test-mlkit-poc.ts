import 'fake-indexeddb/auto';
import { mlKitPocService } from '../src/services/mlKitPocService';

async function testMlKitPocSuite() {
  console.log('========================================================================');
  console.log('🧪 KHALID PHARMACY — GOOGLE ML KIT POC & COMPATIBILITY VERIFICATION');
  console.log('========================================================================\n');

  let passed = 0;
  let total = 0;

  function assert(condition: boolean, msg: string) {
    total++;
    if (condition) {
      console.log(`  ✓ [PASS] ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ [FAIL] ${msg}`);
      process.exitCode = 1;
    }
  }

  // Test 1: Service Singleton Initialized
  assert(!!mlKitPocService, 'mlKitPocService singleton initialized successfully');

  // Test 2: Native Platform Detection
  const isNative = mlKitPocService.isNativePlatform();
  console.log(`  ℹ Running Environment Native Status: [${isNative ? 'Android Native APK' : 'Web Browser / PWA Preview'}]`);
  assert(typeof isNative === 'boolean', 'isNativePlatform returns valid boolean');

  // Test 3: Permission Check Fallback
  const perm = await mlKitPocService.checkPermissions();
  assert(typeof perm === 'boolean', 'checkPermissions evaluates cleanly');

  // Test 4: Web Fallback Safeguard
  if (!isNative) {
    let errorCaught = false;
    try {
      await mlKitPocService.scanNativeSingleShot();
    } catch (err: any) {
      errorCaught = true;
      assert(err.message.includes('أندرويد الأصلي'), 'Web mode correctly guards against direct native call');
    }
    assert(errorCaught, 'Native scanner call safely rejected in web mode');
  }

  console.log('\n========================================================================');
  console.log(`TEST SUMMARY: ${passed}/${total} PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('========================================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

testMlKitPocSuite().catch((err) => {
  console.error('MlKit PoC test failed:', err);
  process.exit(1);
});
