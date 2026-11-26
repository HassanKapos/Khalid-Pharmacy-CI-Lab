import fs from 'node:fs';
import path from 'node:path';

/**
 * P0.2.4.3-R3 — Actual Source Verification (Final Test Fix)
 * 
 * Static Source Verification for Google Drive OAuth UI and Access Control in Khalid Pharmacy.
 * Reads index.html directly via Node.js fs, verifies source code definitions, rules,
 * translation keys, and evaluates the extracted canAccess function directly.
 * 
 * NO AppLogic or duplicate permission functions are used in this test.
 */

function runVerification() {
  console.log('===============================================================');
  console.log('P0.2.4.3-R3: Static Source Verification & Execution Test');
  console.log('===============================================================\n');

  const indexPath = path.resolve(process.cwd(), 'index.html');
  console.log(`[TEST 1] Checking index.html file existence at: ${indexPath}`);
  if (!fs.existsSync(indexPath)) {
    console.error('FAIL: index.html not found');
    process.exit(1);
  }
  const htmlContent = fs.readFileSync(indexPath, 'utf-8');
  console.log('✓ PASS: index.html loaded successfully\n');

  // Regression checks for visible Google Drive failures and mobile product-modal scrolling.
  const connectHandler = htmlContent.match(/const\s+handleConnectGoogleDrive\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\n\s*\};/);
  if (!connectHandler || !connectHandler[0].includes('oauthStatus.value = \'error\'') ||
      !connectHandler[0].includes('showToast') || !connectHandler[0].includes('GoogleDriveOAuthService')) {
    console.error('FAIL: Google Drive connect handler must report missing service and connection failures visibly');
    process.exit(1);
  }
  if (!htmlContent.includes('max-h-[calc(100dvh-1rem)]') ||
      !htmlContent.includes('overflow-y-auto overscroll-contain touch-pan-y')) {
    console.error('FAIL: Add/edit medicine modal must be height-constrained and vertically scrollable on mobile');
    process.exit(1);
  }
  console.log('✓ PASS: Google Drive failures are surfaced and the medicine modal is scrollable on mobile\n');

  // Test 2: Verify window.canAccess is NOT exposed in index.html (removed test-only exposure)
  console.log('[TEST 2] Verifying window.canAccess is NOT in index.html');
  if (htmlContent.includes('window.canAccess')) {
    console.error('FAIL: window.canAccess is still exposed in index.html');
    process.exit(1);
  }
  console.log('✓ PASS: window.canAccess test artifact successfully absent\n');

  // Test 3: Static check for canAccess definition in index.html
  console.log('[TEST 3] Verifying canAccess function definition in index.html');
  const canAccessMatch = htmlContent.match(/const\s+canAccess\s*=\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\};/);
  if (!canAccessMatch) {
    console.error('FAIL: canAccess function definition not found in index.html');
    process.exit(1);
  }
  const canAccessFullCode = canAccessMatch[0];
  console.log('Found canAccess source definition in index.html:');
  console.log('--- BEGIN SOURCE ---');
  console.log(canAccessFullCode.trim());
  console.log('--- END SOURCE ---');
  console.log('✓ PASS: canAccess definition present in index.html\n');

  // Test 4: Dynamic evaluation of extracted canAccess source code
  console.log('[TEST 4] Dynamic evaluation of extracted canAccess logic');
  const evalCanAccess = (currentUser: { value: { role: string } | null }, tabId: string): boolean => {
    const fn = new Function('currentUser', `${canAccessFullCode}\nreturn canAccess('${tabId}');`);
    return fn(currentUser);
  };

  // 4a. Denial when currentUser is null
  const nullUserResult = evalCanAccess({ value: null }, 'dashboard');
  if (nullUserResult !== false) {
    console.error(`FAIL: canAccess returned ${nullUserResult} for null currentUser, expected false`);
    process.exit(1);
  }
  console.log('✓ PASS: Denies access when currentUser is null');

  // 4b. Denial of cloudSettings for cashier
  const cashierCloudResult = evalCanAccess({ value: { role: 'cashier' } }, 'cloudSettings');
  if (cashierCloudResult !== false) {
    console.error(`FAIL: canAccess returned ${cashierCloudResult} for cashier accessing cloudSettings, expected false`);
    process.exit(1);
  }
  console.log('✓ PASS: Cashier role denied access to cloudSettings');

  // 4c. Allowance of cloudSettings for admin
  const adminCloudResult = evalCanAccess({ value: { role: 'admin' } }, 'cloudSettings');
  if (adminCloudResult !== true) {
    console.error(`FAIL: canAccess returned ${adminCloudResult} for admin accessing cloudSettings, expected true`);
    process.exit(1);
  }
  console.log('✓ PASS: Admin role allowed access to cloudSettings');

  // 4d. Allowed tabs for cashier
  const allowedCashierTabs = ['pos', 'dashboard', 'inventory', 'bankakArchive', 'supplierInvoiceOcr'];
  for (const tab of allowedCashierTabs) {
    const res = evalCanAccess({ value: { role: 'cashier' } }, tab);
    if (res !== true) {
      console.error(`FAIL: Cashier expected access to ${tab}, but got ${res}`);
      process.exit(1);
    }
  }
  console.log('✓ PASS: Cashier allowed access to permitted tabs (pos, dashboard, inventory, bankakArchive, supplierInvoiceOcr)');

  // 4e. Restricted tabs for cashier (e.g. reports, users)
  const restrictedCashierTabs = ['reports', 'cloudSettings', 'users'];
  for (const tab of restrictedCashierTabs) {
    const res = evalCanAccess({ value: { role: 'cashier' } }, tab);
    if (res !== false) {
      console.error(`FAIL: Cashier expected denial for ${tab}, but got ${res}`);
      process.exit(1);
    }
  }
  console.log('✓ PASS: Cashier denied access to admin-only tabs (reports, cloudSettings, users)');

  // 4f. Admin access to all tabs
  const allTestTabs = ['pos', 'dashboard', 'inventory', 'bankakArchive', 'supplierInvoiceOcr', 'reports', 'cloudSettings'];
  for (const tab of allTestTabs) {
    const res = evalCanAccess({ value: { role: 'admin' } }, tab);
    if (res !== true) {
      console.error(`FAIL: Admin expected access to ${tab}, but got ${res}`);
      process.exit(1);
    }
  }
  console.log('✓ PASS: Admin allowed access to all tabs\n');

  // Test 5: Static check for setTab calling canAccess(tabId)
  console.log('[TEST 5] Verifying setTab uses canAccess(tabId) guard');
  const setTabMatch = htmlContent.match(/const\s+setTab\s*=\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\n\s*\};/);
  if (!setTabMatch) {
    console.error('FAIL: setTab function definition not found in index.html');
    process.exit(1);
  }
  const setTabCode = setTabMatch[0];
  if (!setTabCode.includes('if (canAccess(') && !setTabCode.includes('canAccess(tabId)')) {
    console.error('FAIL: setTab does not call canAccess(tabId) guard before switching tabs');
    console.error('setTab code:\n', setTabCode);
    process.exit(1);
  }
  console.log('✓ PASS: setTab verifies canAccess(tabId) prior to tab change\n');

  // Test 6: Static check for v-if guard on Cloud Settings UI section
  console.log('[TEST 6] Verifying v-if guard on Cloud Settings section in template');
  const cloudSettingsSectionRegex = /<section\s+[^>]*v-if="[^"]*currentTab\s*===\s*'cloudSettings'[^"]*&&[^"]*canAccess\('cloudSettings'\)[^"]*"[^>]*>/;
  if (!cloudSettingsSectionRegex.test(htmlContent)) {
    console.error('FAIL: Cloud Settings section is not properly guarded with v-if containing canAccess(\'cloudSettings\')');
    process.exit(1);
  }
  console.log('✓ PASS: Cloud Settings template section is guarded by v-if="currentTab === \'cloudSettings\' && canAccess(\'cloudSettings\')"\n');

  // Test 7: Translation keys verification (Arabic & English)
  console.log('[TEST 7] Verifying translation dictionaries (Arabic and English)');
  const requiredKeys = [
    'cloudSettings',
    'cloudSettingsTitle',
    'cloudSettingsDesc',
    'oauthConnected',
    'connectGoogleDrive',
    'disconnectGoogleDrive',
    'runBackupNow',
    'applyDriveRestore',
    'applyDriveRestoreConfirm'
  ];

  // Extract translation objects from index.html
  const arBlockMatch = htmlContent.match(/ar:\s*\{([\s\S]*?)\n\s*\},/);
  const enBlockMatch = htmlContent.match(/en:\s*\{([\s\S]*?)\n\s*\}/);

  if (!arBlockMatch || !enBlockMatch) {
    console.error('FAIL: Could not locate Arabic (ar) or English (en) translation blocks in index.html');
    process.exit(1);
  }

  const arBlock = arBlockMatch[1];
  const enBlock = enBlockMatch[1];

  for (const key of requiredKeys) {
    if (!arBlock.includes(`${key}:`)) {
      console.error(`FAIL: Key '${key}' missing from Arabic translation dictionary`);
      process.exit(1);
    }
    if (!enBlock.includes(`${key}:`)) {
      console.error(`FAIL: Key '${key}' missing from English translation dictionary`);
      process.exit(1);
    }
  }
  console.log('✓ PASS: All required Cloud Settings translation keys present in both Arabic (ar) and English (en)\n');

  // Test 8: Verify setup() return object exports Cloud Settings & Google Drive Backup bindings
  console.log('[TEST 8] Verifying setup() return exports for Cloud Settings & Backup');
  const setupReturnMatch = htmlContent.match(/return\s*\{\s*lang,[\s\S]*?\};\s*\}\s*\}\);\s*app\.mount\('#app'\)/);
  if (!setupReturnMatch) {
    console.error('FAIL: Could not locate setup() return block in index.html');
    process.exit(1);
  }
  if (htmlContent.includes('backupPassphrase')) {
    console.error('FAIL: backupPassphrase password gate must be removed from index.html');
    process.exit(1);
  }
  if (!htmlContent.includes("confirm(t('applyDriveRestoreConfirm'))")) {
    console.error('FAIL: handleApplyDriveRestore must require explicit user confirmation before replacing local DB');
    process.exit(1);
  }
  const requiredSetupExports = [
    'oauthStatus',
    'oauthErrorMessage',
    'clientIdConfigured',
    'androidDriveDiagnostics',
    'lastBackupInfo',
    'copyAndroidSha1',
    'handleConnectGoogleDrive',
    'handleDisconnectGoogleDrive',
    'backupBusy',
    'backupStatusMessage',
    'backupStatusIsError',
    'driveBackupFiles',
    'selectedDriveBackupId',
    'restorePreview',
    'handleRunBackupNow',
    'handleRunDailyBackup',
    'handleListDriveBackups',
    'handlePreviewDriveRestore',
    'handleApplyDriveRestore',
    'handleCloseRestorePreview',
  ];
  for (const symbol of requiredSetupExports) {
    if (!new RegExp(`\\b${symbol}\\b`).test(setupReturnMatch[0])) {
      console.error(`FAIL: '${symbol}' is missing from setup() return object in index.html`);
      process.exit(1);
    }
  }
  console.log('✓ PASS: All Cloud Settings & passwordless Google Drive Backup/Restore bindings exported from setup()\n');

  console.log('===============================================================');
  console.log('ALL STATIC & EXECUTION SOURCE VERIFICATION TESTS PASSED (100%)');
  console.log('===============================================================');
}

runVerification();
