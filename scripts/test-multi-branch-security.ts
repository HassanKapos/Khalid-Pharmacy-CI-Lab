import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import * as PharmacyDB from '../src/services/pharmacyDb.ts';
import { googleDriveBackupService } from '../src/services/googleDriveBackupService.ts';
import {
  __setAuthRuntimeForTests,
  resolvePharmacySession,
} from './helpers/authTestHarness.ts';

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
  writable: true,
});

async function establishSuperAdminSession(activeBranchId = 'khalid-1'): Promise<void> {
  const mockUser: any = {
    uid: 'mb-super-admin-1',
    email: 'super@khalid.test',
    displayName: 'Multi-Branch Super Admin',
    emailVerified: true,
    getIdToken: async () => 'tok-mb',
    getIdTokenResult: async () => ({ token: 'tok-mb', claims: {} }),
  };
  __setAuthRuntimeForTests({
    isOfflineFn: () => false,
    getServices: () => ({ auth: { currentUser: mockUser } as any, db: {} as any }),
    getDocFn: async () =>
      ({
        exists: () => true,
        data: () => ({
          uid: 'mb-super-admin-1',
          email: 'super@khalid.test',
          displayName: 'Multi-Branch Super Admin',
          role: 'super_admin',
          branchIds: ['khalid-1', 'khalid-2', 'khalid-3'],
          activeBranchId,
          active: true,
        }),
        metadata: { fromCache: false },
      }) as any,
  });
  await resolvePharmacySession(mockUser);
}

function readText(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

async function verifyFirestoreRulesAndBlueprint() {
  console.log('[1/4] Verifying Firestore Rules v2 invariants & ESLint...');
  const rulesSrc = readText('firestore.rules');
  const blueprint = JSON.parse(readText('firebase-blueprint.json'));

  assert.match(rulesSrc, /rules_version\s*=\s*'2';/, 'Rules v2 declaration required');
  assert.match(
    rulesSrc,
    /match \/\{document=\*\*\} \{\s*allow read, write: if false;/,
    'Root wildcard default deny catch-all required'
  );
  assert.ok(rulesSrc.includes('isVerifiedUser()'), 'Verified email enforcement required');
  assert.ok(rulesSrc.includes('isSuperAdmin()'), 'Super Admin RBAC helper required');
  assert.ok(rulesSrc.includes('isBranchAdmin(branchId)'), 'Branch Admin RBAC helper required');
  assert.ok(rulesSrc.includes('isAssignedUser(branchId)'), 'Branch member check required');
  assert.ok(rulesSrc.includes('canCreateOwnProfileFromInvite'), 'Invite claim validation required');
  assert.ok(rulesSrc.includes('affectedKeys().hasOnly('), 'Update field allowlist required');
  // Semantic verification of Stocktaking terminal & accountingStatus locks
  const terminalFnMatch = rulesSrc.match(/function\s+isTerminalStocktakingStatus\s*\([^)]*\)\s*\{([\s\S]*?)\}/);
  assert.ok(terminalFnMatch, 'isTerminalStocktakingStatus helper must exist in firestore.rules');
  for (const terminalStatus of [
    'sync_completed_unverified',
    'committed',
    'cancelled',
    'COMMITTED',
    'CANCELLED',
  ]) {
    assert.ok(
      terminalFnMatch![1].includes(`'${terminalStatus}'`),
      `isTerminalStocktakingStatus must include '${terminalStatus}'`
    );
  }

  const sessionBlockMatch = rulesSrc.match(
    /match\s+\/stocktaking_sessions\/\{sessionId\}\s*\{([\s\S]*?)match\s+\/items\/\{itemId\}\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\}/
  );
  assert.ok(sessionBlockMatch, 'stocktaking_sessions and items blocks must exist in firestore.rules');
  const sessionRulesBody = sessionBlockMatch![1];
  const itemRulesBody = sessionBlockMatch![2];

  const sessionUpdateMatch = sessionRulesBody.match(/allow\s+update:\s*if\s*([\s\S]*?);/);
  assert.ok(sessionUpdateMatch, 'stocktaking_sessions allow update rule required');
  assert.ok(
    sessionUpdateMatch![1].includes('!isTerminalStocktakingStatus(existing().status)'),
    'stocktaking_sessions allow update must enforce !isTerminalStocktakingStatus(existing().status)'
  );
  assert.ok(
    sessionUpdateMatch![1].includes("existing().get('accountingStatus', 'open') == 'open'"),
    "stocktaking_sessions allow update must require existing accountingStatus == 'open'"
  );
  assert.match(sessionRulesBody, /allow\s+delete:\s*if\s+false;/, 'stocktaking_sessions must forbid delete');

  const itemsWritableMatch = rulesSrc.match(
    /function\s+parentStocktakingItemsAreWritable\s*\([^)]*\)\s*\{([\s\S]*?)\}/
  );
  assert.ok(itemsWritableMatch, 'parentStocktakingItemsAreWritable helper required');
  const itemsWritableBody = itemsWritableMatch![1];
  const statusListMatch = itemsWritableBody.match(/\.data\.status\s+in\s+\[([^\]]+)\]/);
  assert.ok(statusListMatch, 'parentStocktakingItemsAreWritable must whitelist writable session statuses');
  for (const allowedStatus of ['active', 'in_progress', 'reviewing']) {
    assert.ok(
      statusListMatch![1].includes(`'${allowedStatus}'`),
      `parentStocktakingItemsAreWritable must allow '${allowedStatus}'`
    );
  }
  for (const forbiddenStatus of [
    'syncing_adjustments',
    'sync_completed_unverified',
    'committed',
    'cancelled',
    'COMMITTED',
    'CANCELLED',
  ]) {
    assert.ok(
      !statusListMatch![1].includes(`'${forbiddenStatus}'`),
      `parentStocktakingItemsAreWritable must NOT allow '${forbiddenStatus}'`
    );
  }
  assert.ok(
    itemsWritableBody.includes("get('accountingStatus', 'open') == 'open'"),
    "parentStocktakingItemsAreWritable must require parent accountingStatus == 'open'"
  );

  for (const op of ['create', 'update', 'delete'] as const) {
    const opMatch = itemRulesBody.match(new RegExp(`allow\\s+${op}:\\s*if\\s*([\\s\\S]*?);`));
    assert.ok(opMatch, `stocktaking items allow ${op} rule required`);
    assert.ok(
      opMatch![1].includes('parentStocktakingItemsAreWritable(branchId, sessionId)'),
      `stocktaking items allow ${op} must enforce parentStocktakingItemsAreWritable(branchId, sessionId)`
    );
  }
  assert.ok(
    /match \/inventory_ledger\/\{movementId\}[\s\S]*allow update, delete: if false;/.test(rulesSrc),
    'Inventory ledger append-only lock required'
  );
  assert.ok(
    /match \/audit_logs\/\{eventId\}[\s\S]*allow update, delete: if false;/.test(rulesSrc),
    'Audit logs append-only lock required'
  );

  // Check blueprint covers all required entities
  const entities = Object.keys(blueprint.entities || {});
  for (const required of [
    'UserProfile',
    'StaffInvite',
    'PharmacyBranch',
    'BranchMedicine',
    'BranchInventoryLedger',
    'BranchSale',
    'BranchSupplier',
    'BranchPurchaseInvoice',
    'BranchSupplierTransaction',
    'BranchReceipt',
    'BranchOcrDraft',
    'BranchStocktakingSession',
    'BranchAuditLog',
  ]) {
    assert.ok(entities.includes(required), `Blueprint missing entity: ${required}`);
  }

  // Run ESLint official security-rules validator
  execSync('npx eslint firestore.rules', { stdio: 'pipe' });
  console.log('✓ PASS: firestore.rules passed ESLint & all Dirty Dozen structural invariants');
}

async function verifyIndexedDbBranchIsolation() {
  console.log('[2/4] Verifying IndexedDB strict multi-branch data isolation...');

  // Verify DB naming policy preserves KhalidPharmacyDB for branch 1 and isolates branch 2 & dynamic branches
  assert.equal(PharmacyDB.getBranchDbName(null), 'KhalidPharmacyDB');
  assert.equal(PharmacyDB.getBranchDbName('khalid-1'), 'KhalidPharmacyDB');
  assert.equal(PharmacyDB.getBranchDbName('khalid-2'), 'KhalidPharmacyDB__branch__khalid-2');
  assert.equal(PharmacyDB.getBranchDbName('khalid-3'), 'KhalidPharmacyDB__branch__khalid-3');

  // Switch to Branch 1 -> initialize and seed/add item unique to Branch 1
  await establishSuperAdminSession();
  PharmacyDB.setActiveBranchContext('khalid-1', 'صيدلية خالد 1');
  await PharmacyDB.initializeAndMigrate();
  const branch1Med = await PharmacyDB.createVerifiedMedicine(
    {
      barcode: '628990001',
      name: 'Branch1 Exclusive Drug',
      category: 'Antibiotics',
      buyPrice: 5000,
      sellPrice: 7000,
      expiry: '2028-12-31',
      batchNumber: 'B-MB-1',
      initialStock: 10,
    },
    {
      dosageForm: 'Tablet',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      sellPack: true,
    }
  );
  const branch1Meds = await PharmacyDB.getAllMedicinesWithLiveStock();
  assert.ok(
    branch1Meds.some((m) => m.id === branch1Med.id),
    'Branch 1 must persist its own medicine'
  );

  // Switch to Branch 2 -> must NOT seed Branch 1 demo items and must have 0 access to Branch 1 items
  await establishSuperAdminSession('khalid-2');
  PharmacyDB.setActiveBranchContext('khalid-2', 'صيدلية خالد 2');
  await PharmacyDB.initializeAndMigrate();
  const branch2MedsInitial = await PharmacyDB.getAllMedicinesWithLiveStock();
  assert.equal(branch2MedsInitial.length, 0, 'Fresh Branch 2 DB must start empty with zero leak from Branch 1');

  const branch2Med = await PharmacyDB.createVerifiedMedicine(
    {
      barcode: '628990002',
      name: 'Branch2 Exclusive Drug',
      category: 'Chronic',
      buyPrice: 8000,
      sellPrice: 11000,
      expiry: '2029-06-30',
      batchNumber: 'B-MB-2',
      initialStock: 5,
    },
    {
      dosageForm: 'Tablet',
      stripsPerPack: 2,
      pillsPerStrip: 10,
      sellPack: true,
    }
  );
  const branch2MedsAfter = await PharmacyDB.getAllMedicinesWithLiveStock();
  assert.equal(branch2MedsAfter.length, 1);
  assert.equal(branch2MedsAfter[0].name, 'Branch2 Exclusive Drug');

  // Switch to newly created Branch 3 -> must also be strictly isolated
  PharmacyDB.setActiveBranchContext('khalid-3', 'صيدلية خالد 3');
  await PharmacyDB.initializeAndMigrate();
  assert.equal((await PharmacyDB.getAllMedicinesWithLiveStock()).length, 0, 'Dynamic Branch 3 must start completely isolated');

  // Switch back to Branch 1 -> must still retain Branch 1 Exclusive Drug and NOT see Branch 2 Drug
  PharmacyDB.setActiveBranchContext('khalid-1', 'صيدلية خالد 1');
  await PharmacyDB.initializeAndMigrate();
  const branch1Reloaded = await PharmacyDB.getAllMedicinesWithLiveStock();
  assert.ok(branch1Reloaded.some((m) => m.id === branch1Med.id), 'Branch 1 retained its medicine after branch switching');
  assert.ok(!branch1Reloaded.some((m) => m.id === branch2Med.id), 'Branch 1 must NOT see Branch 2 medicine');

  // Reset active context cleanly
  PharmacyDB.setActiveBranchContext('khalid-1', 'صيدلية خالد 1');
  console.log('✓ PASS: IndexedDB multi-branch isolation verified across khalid-1, khalid-2, and khalid-3');
}

async function verifyBackupBranchTagging() {
  console.log('[3/4] Verifying Google Drive backup branch tagging...');
  PharmacyDB.setActiveBranchContext('khalid-2', 'صيدلية خالد 2');
  await PharmacyDB.initializeAndMigrate();
  const pkg = await googleDriveBackupService.createBackupSnapshot();
  assert.equal(pkg.header.branchId, 'khalid-2', 'Backup header must record originating branchId');
  assert.equal(pkg.header.branchName, 'صيدلية خالد 2', 'Backup header must record originating branchName');
  PharmacyDB.setActiveBranchContext('khalid-1', 'صيدلية خالد 1');
  console.log('✓ PASS: Backup packages store branch origin metadata cleanly');
}

async function verifyUiAuthAndRbac() {
  console.log('[4/4] Verifying index.html authentication, zero demo backdoors & multi-branch UI...');
  const html = readText('index.html');

  // Must start unauthenticated (no default demo user object)
  assert.match(html, /const\s+currentUser\s*=\s*ref\(null\);/, 'currentUser must initialize as null');
  assert.ok(!html.includes("const currentUser = ref({ name: 'د. خالد (مدير)'"), 'Demo default user must be removed');
  assert.ok(!html.includes('selectRole'), 'Insecure login role selector must be removed');
  assert.ok(!html.includes('demoNotice'), 'Hardcoded demo credentials notice must be removed');
  assert.ok(!html.includes("password: '123'"), 'Hardcoded demo password 123 must be removed');

  // Must wire real Firebase auth & Google Sign-In & branch admin UI
  assert.ok(html.includes('handleGoogleLogin'), 'Google Sign-In handler must be present');
  assert.ok(html.includes('observePharmacyAuth'), 'Firebase Auth session observer must be wired');
  assert.ok(html.includes('switchActiveBranch'), 'Branch switcher handler must be present');
  assert.ok(html.includes("currentTab === 'branchAdmin' && canAccess('branchAdmin')"), 'Branch Admin panel must be RBAC-guarded');
  assert.ok(html.includes('KhalidPharmacyBankakDB__branch__'), 'Bankak receipts IDB must isolate non-default branches');

  // Verify extracted canAccess supports super_admin, admin, and restricts cashier & null
  const canAccessMatch = html.match(/const\s+canAccess\s*=\s*\(([^)]*)\)\s*=>\s*\{([\s\S]*?)\};/);
  assert.ok(canAccessMatch, 'canAccess helper must exist');
  const evalCanAccess = (role: string | null, tabId: string): boolean => {
    const fn = new Function('currentUser', `${canAccessMatch![0]}\nreturn canAccess('${tabId}');`);
    return fn({ value: role ? { role } : null });
  };

  assert.equal(evalCanAccess(null, 'pos'), false);
  assert.equal(evalCanAccess('cashier', 'pos'), true);
  assert.equal(evalCanAccess('cashier', 'branchAdmin'), false);
  assert.equal(evalCanAccess('cashier', 'suppliers'), false);
  assert.equal(evalCanAccess('cashier', 'reports'), false);
  assert.equal(evalCanAccess('admin', 'branchAdmin'), true);
  assert.equal(evalCanAccess('super_admin', 'branchAdmin'), true);
  assert.equal(evalCanAccess('super_admin', 'cloudSettings'), true);

  console.log('✓ PASS: index.html Firebase Auth, RBAC, and multi-branch UI checks passed');
}

async function run() {
  await verifyFirestoreRulesAndBlueprint();
  await verifyIndexedDbBranchIsolation();
  await verifyBackupBranchTagging();
  await verifyUiAuthAndRbac();
  console.log('\nALL MULTI-BRANCH & FIREBASE SECURITY TESTS PASSED (100%)');
}

run().catch((err) => {
  console.error('TEST FAILURE:', err);
  process.exit(1);
});
