/**
 * Firestore Security Rules v2 Emulator Test Suite (Hardened RBAC + Multi-Branch + Financial Integrity)
 *
 * Requires Firebase Firestore Emulator + Java runtime when executed directly:
 *   firebase emulators:exec --only firestore "npx tsx firestore.rules.test.ts"
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
  writeBatch,
} from 'firebase/firestore';

const PROJECT_ID = 'khalid-pharmacy-rules-test';

async function run() {
  const rules = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
  const testEnv: RulesTestEnvironment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: '127.0.0.1',
      port: 8080,
    },
  });

  const superUid = 'super-uid-1';
  const bootstrapSuperUid = 'bootstrap-super-uid';
  const disabledSuperUid = 'super-disabled-uid';
  const disabledAdminUid = 'admin-disabled-uid';
  const disabledCashierUid = 'cashier-disabled-uid';
  const admin1Uid = 'admin-k1-uid';
  const admin2Uid = 'admin-k2-uid';
  const cashier1Uid = 'cashier-k1-uid';
  const outsiderUid = 'outsider-uid';
  const inviteeUid = 'invitee-uid-1';
  const secondClaimUid = 'invitee-uid-2';

  try {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const ts = Timestamp.now();

      await setDoc(doc(db, 'branches/khalid-1'), {
        id: 'khalid-1',
        code: 'KP-01',
        nameAr: 'صيدلية خالد 1',
        nameEn: 'Khalid Pharmacy 1',
        active: true,
        adminUids: [superUid, admin1Uid],
        memberUids: [superUid, admin1Uid, cashier1Uid],
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-2'), {
        id: 'khalid-2',
        code: 'KP-02',
        nameAr: 'صيدلية خالد 2',
        nameEn: 'Khalid Pharmacy 2',
        active: true,
        adminUids: [superUid, admin2Uid],
        memberUids: [superUid, admin2Uid],
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-disabled'), {
        id: 'khalid-disabled',
        code: 'KP-OFF',
        nameAr: 'فرع معطل',
        nameEn: 'Disabled Branch',
        active: false,
        adminUids: [superUid, admin1Uid],
        memberUids: [superUid, admin1Uid, cashier1Uid],
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, `users/${superUid}`), {
        uid: superUid,
        email: 'hassan300009@gmail.com',
        displayName: 'Super Admin',
        role: 'super_admin',
        branchIds: ['khalid-1', 'khalid-2'],
        activeBranchId: 'khalid-1',
        active: true,
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, `users/${disabledSuperUid}`), {
        uid: disabledSuperUid,
        email: 'disabled-super@khalid.test',
        displayName: 'Disabled Super Admin',
        role: 'super_admin',
        branchIds: ['khalid-1'],
        activeBranchId: 'khalid-1',
        active: false,
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, `users/${disabledAdminUid}`), {
        uid: disabledAdminUid,
        email: 'disabled-admin@khalid.test',
        displayName: 'Disabled Admin',
        role: 'admin',
        branchIds: ['khalid-1'],
        activeBranchId: 'khalid-1',
        active: false,
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, `users/${disabledCashierUid}`), {
        uid: disabledCashierUid,
        email: 'disabled-cashier@khalid.test',
        displayName: 'Disabled Cashier',
        role: 'cashier',
        branchIds: ['khalid-1'],
        activeBranchId: 'khalid-1',
        active: false,
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, `users/${admin1Uid}`), {
        uid: admin1Uid,
        email: 'admin1@khalid.test',
        displayName: 'Branch 1 Admin',
        role: 'admin',
        branchIds: ['khalid-1', 'khalid-disabled'],
        activeBranchId: 'khalid-1',
        active: true,
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, `users/${admin2Uid}`), {
        uid: admin2Uid,
        email: 'admin2@khalid.test',
        displayName: 'Branch 2 Admin',
        role: 'admin',
        branchIds: ['khalid-2'],
        activeBranchId: 'khalid-2',
        active: true,
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, `users/${cashier1Uid}`), {
        uid: cashier1Uid,
        email: 'cashier1@khalid.test',
        displayName: 'Cashier 1',
        role: 'cashier',
        branchIds: ['khalid-1'],
        activeBranchId: 'khalid-1',
        active: true,
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-1/medicines/med-1'), {
        id: 'med-1',
        branchId: 'khalid-1',
        name: 'Panadol Extra',
        buyPrice: 2500,
        sellPrice: 3500,
        secondaryBarcodes: ['62810000001'],
        archived: false,
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-2/medicines/med-2'), {
        id: 'med-2',
        branchId: 'khalid-2',
        name: 'Augmentin 1g',
        buyPrice: 14000,
        sellPrice: 19500,
        archived: false,
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-disabled/medicines/med-off'), {
        id: 'med-off',
        branchId: 'khalid-disabled',
        name: 'Frozen Drug',
        buyPrice: 1000,
        sellPrice: 1500,
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-1/suppliers/sup-1'), {
        id: 'sup-1',
        branchId: 'khalid-1',
        nameAr: 'مورد الخرطوم',
        balance: 50000,
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-2/suppliers/sup-2'), {
        id: 'sup-2',
        branchId: 'khalid-2',
        nameAr: 'مورد بحري',
        balance: 30000,
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-1/receipts/rcpt-1'), {
        id: 'rcpt-1',
        branchId: 'khalid-1',
        status: 'pending',
        amount: 3500,
        createdByUid: cashier1Uid,
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-1/sales/sale-seed'), {
        id: 'sale-seed',
        branchId: 'khalid-1',
        invoiceNumber: 'INV-SEED-1',
        items: [{ medicineId: 'med-1', qty: 1, subtotal: 3500 }],
        itemsCount: 1,
        subtotal: 3500,
        discount: 0,
        total: 3500,
        paymentMethod: 'Cash',
        cashierUid: cashier1Uid,
        createdAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-1/sales/sale-admin-owned'), {
        id: 'sale-admin-owned',
        branchId: 'khalid-1',
        invoiceNumber: 'INV-SEED-ADMIN',
        items: [{ medicineId: 'med-1', qty: 1, subtotal: 3500 }],
        itemsCount: 1,
        subtotal: 3500,
        discount: 0,
        total: 3500,
        paymentMethod: 'Cash',
        cashierUid: admin1Uid,
        createdAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-1/inventory_ledger/mov-1'), {
        id: 'mov-1',
        branchId: 'khalid-1',
        medicineId: 'med-1',
        type: 'INITIAL',
        unit: 'pack',
        quantityDelta: 10,
        baseUnitsDelta: 200,
        userId: admin1Uid,
        createdAt: ts,
      });

      await setDoc(doc(db, 'branches/khalid-1/stocktaking_sessions/stk-committed'), {
        id: 'stk-committed',
        branchId: 'khalid-1',
        status: 'committed',
        createdAt: ts,
        updatedAt: ts,
      });

      await setDoc(doc(db, 'staff_invites/inv-single-use'), {
        id: 'inv-single-use',
        email: 'newcashier@khalid.test',
        displayName: 'New Cashier',
        role: 'cashier',
        branchIds: ['khalid-1'],
        active: true,
        invitedByUid: superUid,
        createdAt: ts,
        updatedAt: ts,
      });
    });

    const unauthDb = testEnv.unauthenticatedContext().firestore();
    const unverifiedDb = testEnv
      .authenticatedContext('unverified-uid', { email: 'cashier1@khalid.test', email_verified: false })
      .firestore();
    const cashierDb = testEnv
      .authenticatedContext(cashier1Uid, { email: 'cashier1@khalid.test', email_verified: true })
      .firestore();
    const admin1Db = testEnv
      .authenticatedContext(admin1Uid, { email: 'admin1@khalid.test', email_verified: true })
      .firestore();
    const admin2Db = testEnv
      .authenticatedContext(admin2Uid, { email: 'admin2@khalid.test', email_verified: true })
      .firestore();
    const superDb = testEnv
      .authenticatedContext(superUid, { email: 'hassan300009@gmail.com', email_verified: true })
      .firestore();
    const disabledSuperDb = testEnv
      .authenticatedContext(disabledSuperUid, { email: 'disabled-super@khalid.test', email_verified: true })
      .firestore();
    const disabledAdminDb = testEnv
      .authenticatedContext(disabledAdminUid, { email: 'disabled-admin@khalid.test', email_verified: true })
      .firestore();
    const disabledCashierDb = testEnv
      .authenticatedContext(disabledCashierUid, { email: 'disabled-cashier@khalid.test', email_verified: true })
      .firestore();
    const bootstrapSuperDb = testEnv
      .authenticatedContext(bootstrapSuperUid, { email: 'hassan300009@gmail.com', email_verified: true })
      .firestore();
    const unverifiedBootstrapDb = testEnv
      .authenticatedContext('unverified-bootstrap-uid', { email: 'hassan300009@gmail.com', email_verified: false })
      .firestore();
    const outsiderDb = testEnv
      .authenticatedContext(outsiderUid, { email: 'outsider@khalid.test', email_verified: true })
      .firestore();
    const inviteeDb = testEnv
      .authenticatedContext(inviteeUid, { email: 'newcashier@khalid.test', email_verified: true })
      .firestore();
    const secondClaimDb = testEnv
      .authenticatedContext(secondClaimUid, { email: 'newcashier@khalid.test', email_verified: true })
      .firestore();

    // 1. Unauthenticated & Unverified Default Deny (including unverified bootstrapped email)
    await assertFails(getDoc(doc(unauthDb, 'branches/khalid-1/medicines/med-1')));
    await assertFails(getDoc(doc(unauthDb, 'users/admin-k1-uid')));
    await assertFails(getDoc(doc(unverifiedDb, 'branches/khalid-1/medicines/med-1')));
    await assertFails(getDoc(doc(unverifiedBootstrapDb, 'branches/khalid-1/medicines/med-1')));

    // 1b. Bootstrapped Super Admin BEFORE user profile creation can read & bootstrap own super_admin profile
    await assertSucceeds(getDoc(doc(bootstrapSuperDb, 'branches/khalid-1/medicines/med-1')));
    await assertSucceeds(
      setDoc(doc(bootstrapSuperDb, `users/${bootstrapSuperUid}`), {
        uid: bootstrapSuperUid,
        email: 'hassan300009@gmail.com',
        displayName: 'Bootstrapped Founder',
        role: 'super_admin',
        branchIds: ['khalid-1', 'khalid-2'],
        activeBranchId: 'khalid-1',
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // 2. Self-Privilege Escalation & Disabled Accounts (Super Admin, Admin, Cashier)
    await assertFails(
      updateDoc(doc(cashierDb, `users/${cashier1Uid}`), {
        role: 'super_admin',
        branchIds: ['khalid-1', 'khalid-2'],
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(admin1Db, `users/${admin1Uid}`), {
        role: 'super_admin',
        branchIds: ['khalid-1', 'khalid-2'],
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(outsiderDb, `users/${outsiderUid}`), {
        uid: outsiderUid,
        email: 'outsider@khalid.test',
        displayName: 'Rogue',
        role: 'super_admin',
        branchIds: ['khalid-1'],
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(getDoc(doc(disabledSuperDb, 'branches/khalid-1/medicines/med-1')));
    await assertFails(getDoc(doc(disabledAdminDb, 'branches/khalid-1/medicines/med-1')));
    await assertFails(getDoc(doc(disabledCashierDb, 'branches/khalid-1/medicines/med-1')));
    await assertFails(
      setDoc(doc(disabledCashierDb, 'branches/khalid-1/sales/sale-disabled-cashier'), {
        id: 'sale-disabled-cashier',
        branchId: 'khalid-1',
        invoiceNumber: 'INV-DIS-1',
        items: [{ medicineId: 'med-1', qty: 1, subtotal: 3500 }],
        itemsCount: 1,
        subtotal: 3500,
        discount: 0,
        total: 3500,
        paymentMethod: 'Cash',
        cashierUid: disabledCashierUid,
        createdAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(superDb, `users/${superUid}`), {
        active: false,
        updatedAt: serverTimestamp(),
      })
    );

    // 3. Multi-Branch Isolation (khalid-1 vs khalid-2 across collections + unassigned cashierUid bypass attempts)
    await assertFails(getDoc(doc(admin1Db, 'branches/khalid-2/medicines/med-2')));
    await assertFails(getDoc(doc(admin1Db, 'branches/khalid-2/suppliers/sup-2')));
    await assertFails(getDoc(doc(admin2Db, 'branches/khalid-1/sales/sale-seed')));
    await assertFails(getDoc(doc(cashierDb, 'branches/khalid-2/medicines/med-2')));
    await assertFails(
      setDoc(doc(outsiderDb, 'branches/khalid-1/sales/sale-outsider-selfuid'), {
        id: 'sale-outsider-selfuid',
        branchId: 'khalid-1',
        invoiceNumber: 'INV-OUT-1',
        items: [{ medicineId: 'med-1', qty: 1, subtotal: 3500 }],
        itemsCount: 1,
        subtotal: 3500,
        discount: 0,
        total: 3500,
        paymentMethod: 'Cash',
        cashierUid: outsiderUid,
        createdAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(admin2Db, 'branches/khalid-1/sales/sale-admin2-cross'), {
        id: 'sale-admin2-cross',
        branchId: 'khalid-1',
        invoiceNumber: 'INV-A2-1',
        items: [{ medicineId: 'med-1', qty: 1, subtotal: 3500 }],
        itemsCount: 1,
        subtotal: 3500,
        discount: 0,
        total: 3500,
        paymentMethod: 'Cash',
        cashierUid: admin2Uid,
        createdAt: serverTimestamp(),
      })
    );

    // 4. Disabled Branch Blocking (reads & writes denied operationally; Super Admin can inspect/re-enable branch doc)
    await assertFails(getDoc(doc(admin1Db, 'branches/khalid-disabled/medicines/med-off')));
    await assertFails(getDoc(doc(cashierDb, 'branches/khalid-disabled/medicines/med-off')));
    await assertFails(
      setDoc(doc(admin1Db, 'branches/khalid-disabled/medicines/med-off-new'), {
        id: 'med-off-new',
        branchId: 'khalid-disabled',
        name: 'Blocked Admin Write In Disabled Branch',
        buyPrice: 100,
        sellPrice: 200,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(superDb, 'branches/khalid-disabled/medicines/med-new'), {
        id: 'med-new',
        branchId: 'khalid-disabled',
        name: 'Blocked In Disabled Branch',
        buyPrice: 100,
        sellPrice: 200,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    await assertSucceeds(getDoc(doc(superDb, 'branches/khalid-disabled')));

    // 5. All-Element Validation (branchIds[1], secondaryBarcodes[1])
    await assertFails(
      setDoc(doc(superDb, 'staff_invites/inv-bad-branch'), {
        id: 'inv-bad-branch',
        email: 'badbranch@khalid.test',
        displayName: 'Bad Branch',
        role: 'admin',
        branchIds: ['khalid-1', 'bad/branch/id'],
        active: true,
        invitedByUid: superUid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(admin1Db, 'branches/khalid-1/medicines/med-1'), {
        secondaryBarcodes: ['62810000001', ''],
        updatedAt: serverTimestamp(),
      })
    );

    // 6. Sales Forged Totals, Illogical Discounts & Re-sync Retry Protection
    await assertFails(
      setDoc(doc(cashierDb, 'branches/khalid-1/sales/sale-forged-total'), {
        id: 'sale-forged-total',
        branchId: 'khalid-1',
        invoiceNumber: 'INV-BAD-1',
        items: [{ medicineId: 'med-1', qty: 1, subtotal: 3500 }],
        itemsCount: 1,
        subtotal: 3500,
        discount: 0,
        total: 10,
        paymentMethod: 'Cash',
        cashierUid: cashier1Uid,
        createdAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(cashierDb, 'branches/khalid-1/sales/sale-bad-discount'), {
        id: 'sale-bad-discount',
        branchId: 'khalid-1',
        invoiceNumber: 'INV-BAD-2',
        items: [{ medicineId: 'med-1', qty: 1, subtotal: 3500 }],
        itemsCount: 1,
        subtotal: 3500,
        discount: 5000,
        total: 0,
        paymentMethod: 'Cash',
        cashierUid: cashier1Uid,
        createdAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(cashierDb, 'branches/khalid-1/sales/sale-count-mismatch'), {
        id: 'sale-count-mismatch',
        branchId: 'khalid-1',
        invoiceNumber: 'INV-BAD-3',
        items: [{ medicineId: 'med-1', qty: 1, subtotal: 3500 }],
        itemsCount: 3,
        subtotal: 3500,
        discount: 0,
        total: 3500,
        paymentMethod: 'Cash',
        cashierUid: cashier1Uid,
        createdAt: serverTimestamp(),
      })
    );
    // Re-syncing existing sale with setDoc(createdAt: serverTimestamp()) fails as invalid update
    await assertFails(
      setDoc(doc(admin1Db, 'branches/khalid-1/sales/sale-seed'), {
        id: 'sale-seed',
        branchId: 'khalid-1',
        invoiceNumber: 'INV-SEED-1',
        items: [{ medicineId: 'med-1', qty: 1, subtotal: 3500 }],
        itemsCount: 1,
        subtotal: 3500,
        discount: 0,
        total: 3500,
        paymentMethod: 'Cash',
        cashierUid: cashier1Uid,
        createdAt: serverTimestamp(),
      })
    );
    // Cashier cannot update committed sale; Admin can update only customer/bankakTransactionId, never financial totals
    await assertFails(
      updateDoc(doc(cashierDb, 'branches/khalid-1/sales/sale-seed'), {
        customer: 'Tampered',
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(admin1Db, 'branches/khalid-1/sales/sale-seed'), {
        total: 100,
        updatedAt: serverTimestamp(),
      })
    );
    await assertSucceeds(
      updateDoc(doc(admin1Db, 'branches/khalid-1/sales/sale-seed'), {
        customer: 'VIP Patient',
        updatedAt: serverTimestamp(),
      })
    );

    // 7. inventory_ledger: Reject Positive SALE, Non-Existent Sale, Cross-Branch Sale, Non-UID userId, Name in userId
    await assertFails(
      setDoc(doc(cashierDb, 'branches/khalid-1/inventory_ledger/mov-positive-sale'), {
        id: 'mov-positive-sale',
        branchId: 'khalid-1',
        medicineId: 'med-1',
        type: 'SALE',
        unit: 'pack',
        quantityDelta: 5,
        baseUnitsDelta: 100,
        referenceId: 'sale-seed',
        userId: cashier1Uid,
        createdAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(cashierDb, 'branches/khalid-1/inventory_ledger/mov-orphan-sale'), {
        id: 'mov-orphan-sale',
        branchId: 'khalid-1',
        medicineId: 'med-1',
        type: 'SALE',
        unit: 'pack',
        quantityDelta: -1,
        baseUnitsDelta: -20,
        referenceId: 'non-existent-sale',
        userId: cashier1Uid,
        createdAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(cashierDb, 'branches/khalid-1/inventory_ledger/mov-missing-med'), {
        id: 'mov-missing-med',
        branchId: 'khalid-1',
        medicineId: 'med-does-not-exist',
        type: 'SALE',
        unit: 'pack',
        quantityDelta: -1,
        baseUnitsDelta: -20,
        referenceId: 'sale-seed',
        userId: cashier1Uid,
        createdAt: serverTimestamp(),
      })
    );
    // Reject employee display name or mismatched UID in userId
    await assertFails(
      setDoc(doc(cashierDb, 'branches/khalid-1/inventory_ledger/mov-name-userid'), {
        id: 'mov-name-userid',
        branchId: 'khalid-1',
        medicineId: 'med-1',
        type: 'SALE',
        unit: 'pack',
        quantityDelta: -1,
        baseUnitsDelta: -20,
        referenceId: 'sale-seed',
        userId: 'Ahmed Cashier',
        createdAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(cashierDb, 'branches/khalid-1/inventory_ledger/mov-other-userid'), {
        id: 'mov-other-userid',
        branchId: 'khalid-1',
        medicineId: 'med-1',
        type: 'SALE',
        unit: 'pack',
        quantityDelta: -1,
        baseUnitsDelta: -20,
        referenceId: 'sale-seed',
        userId: admin1Uid,
        createdAt: serverTimestamp(),
      })
    );
    // Reject linking ledger movement in branch khalid-2 to a sale in branch khalid-1
    await assertFails(
      setDoc(doc(admin2Db, 'branches/khalid-2/inventory_ledger/mov-cross-branch'), {
        id: 'mov-cross-branch',
        branchId: 'khalid-2',
        medicineId: 'med-2',
        type: 'SALE',
        unit: 'pack',
        quantityDelta: -1,
        baseUnitsDelta: -10,
        referenceId: 'sale-seed',
        userId: admin2Uid,
        createdAt: serverTimestamp(),
      })
    );

    // Reject cashier linking SALE ledger to another cashier/admin's sale, or creating ADJUSTMENT/PURCHASE/RETURN
    await assertFails(
      setDoc(doc(cashierDb, 'branches/khalid-1/inventory_ledger/mov-other-sale-owner'), {
        id: 'mov-other-sale-owner',
        branchId: 'khalid-1',
        medicineId: 'med-1',
        type: 'SALE',
        unit: 'pack',
        quantityDelta: -1,
        baseUnitsDelta: -20,
        referenceId: 'sale-admin-owned',
        userId: cashier1Uid,
        createdAt: serverTimestamp(),
      })
    );
    for (const nonSaleType of ['ADJUSTMENT', 'PURCHASE', 'RETURN'] as const) {
      await assertFails(
        setDoc(doc(cashierDb, `branches/khalid-1/inventory_ledger/mov-cashier-${nonSaleType.toLowerCase()}`), {
          id: `mov-cashier-${nonSaleType.toLowerCase()}`,
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: nonSaleType,
          unit: 'pack',
          quantityDelta: 2,
          baseUnitsDelta: 40,
          userId: cashier1Uid,
          createdAt: serverTimestamp(),
        })
      );
    }
    // Branch Admin CAN create ADJUSTMENT, PURCHASE, RETURN ledger movements
    for (const nonSaleType of ['ADJUSTMENT', 'PURCHASE', 'RETURN'] as const) {
      await assertSucceeds(
        setDoc(doc(admin1Db, `branches/khalid-1/inventory_ledger/mov-admin-${nonSaleType.toLowerCase()}`), {
          id: `mov-admin-${nonSaleType.toLowerCase()}`,
          branchId: 'khalid-1',
          medicineId: 'med-1',
          type: nonSaleType,
          unit: 'pack',
          quantityDelta: 2,
          baseUnitsDelta: 40,
          userId: admin1Uid,
          createdAt: serverTimestamp(),
        })
      );
    }

    // Reject unassigned user (outsider) atomic batch even if cashierUid == outsiderUid and userId == outsiderUid
    {
      const outsiderBatch = writeBatch(outsiderDb);
      outsiderBatch.set(doc(outsiderDb, 'branches/khalid-1/sales/sale-outsider-batch'), {
        id: 'sale-outsider-batch',
        branchId: 'khalid-1',
        invoiceNumber: 'INV-OUT-B1',
        items: [{ medicineId: 'med-1', qty: 1, subtotal: 3500 }],
        itemsCount: 1,
        subtotal: 3500,
        discount: 0,
        total: 3500,
        paymentMethod: 'Cash',
        cashierUid: outsiderUid,
        createdAt: serverTimestamp(),
      });
      outsiderBatch.set(doc(outsiderDb, 'branches/khalid-1/inventory_ledger/mov-outsider-batch'), {
        id: 'mov-outsider-batch',
        branchId: 'khalid-1',
        medicineId: 'med-1',
        type: 'SALE',
        unit: 'pack',
        quantityDelta: -1,
        baseUnitsDelta: -20,
        referenceId: 'sale-outsider-batch',
        userId: outsiderUid,
        createdAt: serverTimestamp(),
      });
      await assertFails(outsiderBatch.commit());
    }

    // Atomic Valid Sale + Linked Negative SALE Ledger Batches across ALL permitted roles:
    // 1 sale + 1 ledger, 1 sale + 2 ledger, and 1 sale + 8 ledger
    const roleContexts = [
      { label: 'cashier', db: cashierDb, uid: cashier1Uid },
      { label: 'admin', db: admin1Db, uid: admin1Uid },
      { label: 'super', db: superDb, uid: superUid },
    ] as const;

    for (const actor of roleContexts) {
      for (const ledgerCount of [1, 2, 8] as const) {
        const batch = writeBatch(actor.db);
        const saleId = `sale-batch-${actor.label}-${ledgerCount}`;
        batch.set(doc(actor.db, `branches/khalid-1/sales/${saleId}`), {
          id: saleId,
          branchId: 'khalid-1',
          invoiceNumber: `INV-${actor.label.toUpperCase()}-${ledgerCount}`,
          items: [{ medicineId: 'med-1', qty: ledgerCount, subtotal: 3500 * ledgerCount }],
          itemsCount: 1,
          subtotal: 3500 * ledgerCount,
          discount: 0,
          total: 3500 * ledgerCount,
          paymentMethod: 'Cash',
          cashierUid: actor.uid,
          createdAt: serverTimestamp(),
        });
        for (let i = 1; i <= ledgerCount; i++) {
          const movId = `mov-batch-${actor.label}-${ledgerCount}-${i}`;
          batch.set(doc(actor.db, `branches/khalid-1/inventory_ledger/${movId}`), {
            id: movId,
            branchId: 'khalid-1',
            medicineId: 'med-1',
            batchNumber: `B-${i}`,
            type: 'SALE',
            unit: 'pack',
            quantityDelta: -1,
            baseUnitsDelta: -20,
            referenceId: saleId,
            invoiceNumber: `INV-${actor.label.toUpperCase()}-${ledgerCount}`,
            userId: actor.uid,
            employeeName: actor.label,
            createdAt: serverTimestamp(),
          });
        }
        await assertSucceeds(batch.commit());
      }
    }

    // Completing missing ledger movement for an already-committed sale succeeds; duplicate movement ID & update/delete fail
    await assertSucceeds(
      setDoc(doc(cashierDb, 'branches/khalid-1/inventory_ledger/mov-seed-complete'), {
        id: 'mov-seed-complete',
        branchId: 'khalid-1',
        medicineId: 'med-1',
        type: 'SALE',
        unit: 'pack',
        quantityDelta: -1,
        baseUnitsDelta: -20,
        referenceId: 'sale-seed',
        invoiceNumber: 'INV-SEED-1',
        userId: cashier1Uid,
        createdAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(cashierDb, 'branches/khalid-1/inventory_ledger/mov-1'), {
        id: 'mov-1',
        branchId: 'khalid-1',
        medicineId: 'med-1',
        type: 'SALE',
        unit: 'pack',
        quantityDelta: -1,
        baseUnitsDelta: -20,
        referenceId: 'sale-seed',
        userId: cashier1Uid,
        createdAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(admin1Db, 'branches/khalid-1/inventory_ledger/mov-1'), {
        quantityDelta: -5,
      })
    );

    // 8. Financial Validation on Purchase Invoices, Supplier Transactions & Receipts
    await assertFails(
      setDoc(doc(admin1Db, 'branches/khalid-1/purchase_invoices/pinv-bad'), {
        id: 'pinv-bad',
        branchId: 'khalid-1',
        supplierId: 'sup-1',
        invoiceNumber: 'PINV-1',
        totalAmount: 10000,
        discount: 0,
        netAmount: 10000,
        paidAmount: -500,
        remainingAmount: 10500,
        paymentType: 'Credit',
        paymentStatus: 'Unpaid',
        createdAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(admin1Db, 'branches/khalid-1/supplier_transactions/stx-bad'), {
        id: 'stx-bad',
        branchId: 'khalid-1',
        supplierId: 'sup-1',
        type: 'PAYMENT',
        amount: -100,
        createdAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(cashierDb, 'branches/khalid-1/receipts/rcpt-bad'), {
        id: 'rcpt-bad',
        branchId: 'khalid-1',
        status: 'pending',
        amount: -250,
        createdByUid: cashier1Uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    // 8b. Phase 2D-3B-2a Financial Invariants: Purchase Invoices & Supplier Transactions
    {
      // Purchase Invoice: Paid with paidAmount = 0 and netAmount > 0 MUST FAIL
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/purchase_invoices/pinv-paid-zero-fail'), {
          id: 'pinv-paid-zero-fail',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          invoiceNumber: 'PINV-P0',
          invoiceDate: '2026-11-17',
          totalAmount: 1000,
          subtotal: 1000,
          discount: 0,
          netAmount: 1000,
          paidAmount: 0,
          remainingAmount: 0,
          paymentType: 'Cash',
          paymentStatus: 'Paid',
          createdAt: serverTimestamp(),
        })
      );

      // Purchase Invoice: Paid with paidAmount == netAmount MUST SUCCEED
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/purchase_invoices/pinv-paid-ok'), {
          id: 'pinv-paid-ok',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          invoiceNumber: 'PINV-P1',
          invoiceDate: '2026-11-17',
          totalAmount: 1200,
          subtotal: 1200,
          discount: 200,
          netAmount: 1000,
          paidAmount: 1000,
          remainingAmount: 0,
          paymentType: 'Cash',
          paymentStatus: 'Paid',
          createdAt: serverTimestamp(),
        })
      );

      // Purchase Invoice: Paid with netAmount == 0 MUST SUCCEED
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/purchase_invoices/pinv-paid-free-ok'), {
          id: 'pinv-paid-free-ok',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          invoiceNumber: 'PINV-FREE',
          totalAmount: 0,
          subtotal: 0,
          discount: 0,
          netAmount: 0,
          paidAmount: 0,
          remainingAmount: 0,
          paymentType: 'Cash',
          paymentStatus: 'Paid',
          createdAt: serverTimestamp(),
        })
      );

      // Purchase Invoice: Partial & Unpaid compatibility + immutable totalAmount/discount/netAmount on update
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/purchase_invoices/pinv-partial-ok'), {
          id: 'pinv-partial-ok',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          invoiceNumber: 'PINV-PART',
          totalAmount: 1000,
          subtotal: 1000,
          discount: 0,
          netAmount: 1000,
          paidAmount: 300,
          remainingAmount: 700,
          paymentType: 'Partial',
          paymentStatus: 'Partial',
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/purchase_invoices/pinv-partial-ok'), {
          totalAmount: 500,
          netAmount: 500,
          paidAmount: 500,
          remainingAmount: 0,
          paymentStatus: 'Paid',
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, 'branches/khalid-1/purchase_invoices/pinv-partial-ok'), {
          paidAmount: 1000,
          remainingAmount: 0,
          paymentStatus: 'Paid',
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/purchase_invoices/pinv-unpaid-ok'), {
          id: 'pinv-unpaid-ok',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          invoiceNumber: 'PINV-UNP',
          totalAmount: 800,
          discount: 0,
          netAmount: 800,
          paidAmount: 0,
          remainingAmount: 800,
          paymentType: 'Credit',
          paymentStatus: 'Unpaid',
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/purchase_invoices/pinv-unpaid-bad'), {
          id: 'pinv-unpaid-bad',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          invoiceNumber: 'PINV-UNP-BAD',
          totalAmount: 800,
          discount: 0,
          netAmount: 800,
          paidAmount: 200,
          remainingAmount: 600,
          paymentType: 'Credit',
          paymentStatus: 'Unpaid',
          createdAt: serverTimestamp(),
        })
      );

      // Supplier Transactions: debit/credit/effect, invoiceAllocations <= 12 unique, deterministic Reversal
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/supplier_transactions/stx-inv-ok'), {
          id: 'stx-inv-ok',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          type: 'PURCHASE_INVOICE',
          referenceId: 'pinv-partial-ok',
          amount: 1000,
          effect: 'CREDIT',
          debit: 0,
          credit: 1000,
          balanceAfter: 51000,
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/supplier_transactions/stx-inv-wrong-effect'), {
          id: 'stx-inv-wrong-effect',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          type: 'PURCHASE_INVOICE',
          amount: 1000,
          effect: 'DEBIT',
          debit: 1000,
          credit: 0,
          balanceAfter: 49000,
          createdAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/supplier_transactions/stx-pay-ok'), {
          id: 'stx-pay-ok',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          type: 'PAYMENT',
          amount: 700,
          effect: 'DEBIT',
          debit: 700,
          credit: 0,
          balanceAfter: 50300,
          paymentMethod: 'Bankak',
          invoiceAllocations: [{ invoiceId: 'pinv-partial-ok', invoiceNumber: 'PINV-PART', amount: 700 }],
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/supplier_transactions/stx-pay-dup-alloc'), {
          id: 'stx-pay-dup-alloc',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          type: 'PAYMENT',
          amount: 700,
          effect: 'DEBIT',
          debit: 700,
          credit: 0,
          balanceAfter: 50300,
          invoiceAllocations: [
            { invoiceId: 'pinv-partial-ok', amount: 350 },
            { invoiceId: 'pinv-partial-ok', amount: 350 },
          ],
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/supplier_transactions/stx-pay-over-alloc'), {
          id: 'stx-pay-over-alloc',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          type: 'PAYMENT',
          amount: 500,
          effect: 'DEBIT',
          debit: 500,
          credit: 0,
          balanceAfter: 50500,
          invoiceAllocations: [{ invoiceId: 'pinv-partial-ok', amount: 600 }],
          createdAt: serverTimestamp(),
        })
      );

      const revDigest = crypto
        .createHash('sha256')
        .update('khalid-pharmacy:supplier_payment_reversal:v1:stx-pay-ok')
        .digest('hex')
        .slice(0, 32);
      const deterministicRevId = `rev-${revDigest}`;

      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/supplier_transactions/stx-rev-wrong-amount'), {
          id: 'stx-rev-wrong-amount',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          type: 'ADJUSTMENT',
          referenceId: 'stx-pay-ok',
          amount: 500,
          effect: 'CREDIT',
          debit: 0,
          credit: 500,
          balanceAfter: 50800,
          isReversal: true,
          reversedTxId: 'stx-pay-ok',
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/supplier_transactions/stx-rev-noncanonical-id'), {
          id: 'stx-rev-noncanonical-id',
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          type: 'ADJUSTMENT',
          referenceId: 'stx-pay-ok',
          amount: 700,
          effect: 'CREDIT',
          debit: 0,
          credit: 700,
          balanceAfter: 51000,
          isReversal: true,
          reversedTxId: 'stx-pay-ok',
          createdAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, `branches/khalid-1/supplier_transactions/${deterministicRevId}`), {
          id: deterministicRevId,
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          type: 'ADJUSTMENT',
          referenceId: 'stx-pay-ok',
          amount: 700,
          effect: 'CREDIT',
          debit: 0,
          credit: 700,
          balanceAfter: 51000,
          isReversal: true,
          reversedTxId: 'stx-pay-ok',
          createdAt: serverTimestamp(),
        })
      );
      // Duplicate reversal on same deterministic ID fails (update denied)
      await assertFails(
        setDoc(doc(admin1Db, `branches/khalid-1/supplier_transactions/${deterministicRevId}`), {
          id: deterministicRevId,
          branchId: 'khalid-1',
          supplierId: 'sup-1',
          type: 'ADJUSTMENT',
          referenceId: 'stx-pay-ok',
          amount: 700,
          effect: 'CREDIT',
          debit: 0,
          credit: 700,
          balanceAfter: 51700,
          isReversal: true,
          reversedTxId: 'stx-pay-ok',
          createdAt: serverTimestamp(),
        })
      );
    }

    // 9. Staff Invite Atomic Claim & Reuse Prevention (getAfter requires claimedUid update in same batch)
    // Creating user profile WITHOUT updating staff_invites.claimedUid MUST FAIL
    await assertFails(
      setDoc(doc(inviteeDb, `users/${inviteeUid}`), {
        uid: inviteeUid,
        email: 'newcashier@khalid.test',
        displayName: 'New Cashier',
        role: 'cashier',
        branchIds: ['khalid-1'],
        activeBranchId: 'khalid-1',
        active: true,
        inviteId: 'inv-single-use',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );

    const claimBatch = writeBatch(inviteeDb);
    claimBatch.set(doc(inviteeDb, `users/${inviteeUid}`), {
      uid: inviteeUid,
      email: 'newcashier@khalid.test',
      displayName: 'New Cashier',
      role: 'cashier',
      branchIds: ['khalid-1'],
      activeBranchId: 'khalid-1',
      active: true,
      inviteId: 'inv-single-use',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    claimBatch.update(doc(inviteeDb, 'staff_invites/inv-single-use'), {
      claimedUid: inviteeUid,
      updatedAt: serverTimestamp(),
    });
    await assertSucceeds(claimBatch.commit());

    // Second UID with same email MUST FAIL to reuse or re-claim already-claimed invite
    await assertFails(
      setDoc(doc(secondClaimDb, `users/${secondClaimUid}`), {
        uid: secondClaimUid,
        email: 'newcashier@khalid.test',
        displayName: 'Clone Account',
        role: 'cashier',
        branchIds: ['khalid-1'],
        activeBranchId: 'khalid-1',
        active: true,
        inviteId: 'inv-single-use',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      updateDoc(doc(secondClaimDb, 'staff_invites/inv-single-use'), {
        claimedUid: secondClaimUid,
        updatedAt: serverTimestamp(),
      })
    );

    // 10. Physical Deletion Blocked -> Archive Allowed for Branch Admin
    await assertFails(deleteDoc(doc(admin1Db, 'branches/khalid-1/medicines/med-1')));
    await assertFails(deleteDoc(doc(admin1Db, 'branches/khalid-1/suppliers/sup-1')));
    await assertFails(deleteDoc(doc(admin1Db, 'branches/khalid-1/receipts/rcpt-1')));
    await assertFails(deleteDoc(doc(admin1Db, 'branches/khalid-1/sales/sale-seed')));
    await assertFails(deleteDoc(doc(admin1Db, 'branches/khalid-1/inventory_ledger/mov-1')));
    await assertSucceeds(
      updateDoc(doc(admin1Db, 'branches/khalid-1/medicines/med-1'), {
        archived: true,
        archivedAt: serverTimestamp(),
        archivedByUid: admin1Uid,
        updatedAt: serverTimestamp(),
      })
    );

    // 11. Stocktaking Terminal Lock
    await assertFails(
      updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-committed'), {
        status: 'active',
        accountingStatus: 'open',
        updatedAt: serverTimestamp(),
      })
    );

    // 11b. Category Lowercase Duplicate & Metadata Bounds (Phase 2D-3B-2a)
    {
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/categories/vitamin c'), {
          branchId: 'khalid-1',
          name: 'Vitamin C',
          normalizedName: 'vitamin c',
          createdByUid: admin1Uid,
          createdAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/categories/مضادات خاصة'), {
          branchId: 'khalid-1',
          name: 'مضادات خاصة',
          normalizedName: 'مضادات خاصة',
          createdByUid: admin1Uid,
          createdAt: serverTimestamp(),
        })
      );
      await assertSucceeds(getDoc(doc(cashierDb, 'branches/khalid-1/categories/vitamin c')));
      // Reject case-duplicate overwrite or mixed-case document key or default category
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/categories/vitamin c'), {
          branchId: 'khalid-1',
          name: 'VITAMIN C',
          normalizedName: 'vitamin c',
          createdByUid: admin1Uid,
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/categories/VITAMIN C'), {
          branchId: 'khalid-1',
          name: 'VITAMIN C',
          normalizedName: 'vitamin c',
          createdByUid: admin1Uid,
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/categories/antibiotics'), {
          branchId: 'khalid-1',
          name: 'Antibiotics',
          normalizedName: 'antibiotics',
          createdByUid: admin1Uid,
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(cashierDb, 'branches/khalid-1/categories/pediatric'), {
          branchId: 'khalid-1',
          name: 'Pediatric',
          normalizedName: 'pediatric',
          createdByUid: cashier1Uid,
          createdAt: serverTimestamp(),
        })
      );
      await assertFails(deleteDoc(doc(admin1Db, 'branches/khalid-1/categories/vitamin c')));

      // Bounded metadata/custom_categories cache (<= 12 unique lowercase)
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/metadata/custom_categories'), {
          id: 'custom_categories',
          branchId: 'khalid-1',
          custom_categories: ['Cardio', 'Pediatrics'],
          updatedByUid: admin1Uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/metadata/custom_categories'), {
          custom_categories: ['Cardio', 'cardio'],
          updatedByUid: admin1Uid,
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/metadata/custom_categories'), {
          custom_categories: ['Cardio', 'Antibiotics'],
          updatedByUid: admin1Uid,
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, 'branches/khalid-1/metadata/custom_categories'), {
          custom_categories: ['Cardio', 'Pediatrics', 'Dermatology'],
          updatedByUid: admin1Uid,
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(deleteDoc(doc(admin1Db, 'branches/khalid-1/metadata/custom_categories')));
    }

    // 11c. Stocktaking Subcollection, Partial Adjustment Verification & State Machine (Phase 2D-3B-2a)
    {
      // Cannot create directly as sync_completed_unverified, syncing_adjustments, committed, cancelled, or server_verified
      for (const badStatus of ['syncing_adjustments', 'sync_completed_unverified', 'committed', 'cancelled'] as const) {
        await assertFails(
          setDoc(doc(admin1Db, `branches/khalid-1/stocktaking_sessions/stk-bad-init-${badStatus}`), {
            id: `stk-bad-init-${badStatus}`,
            branchId: 'khalid-1',
            status: badStatus,
            accountingStatus: 'open',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
        );
      }
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-bad-acct'), {
          id: 'stk-bad-acct',
          branchId: 'khalid-1',
          status: 'in_progress',
          accountingStatus: 'server_verified',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );

      // Valid open session creation
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1'), {
          id: 'stk-flow-1',
          branchId: 'khalid-1',
          sessionNumber: 'STK-20261117-0001',
          status: 'in_progress',
          accountingStatus: 'open',
          startedBy: 'Branch 1 Admin',
          startedByUid: admin1Uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );

      // Subcollection item create/update/delete works while session is in_progress
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1/items/med-1'), {
          id: 'med-1',
          branchId: 'khalid-1',
          sessionId: 'stk-flow-1',
          medicineId: 'med-1',
          medicineName: 'Panadol Extra',
          systemStock: 10,
          actualCount: 8,
          variance: -2,
          buyPrice: 2500,
          varianceSDG: -5000,
          updatedByUid: admin1Uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1/items/item-tamper'), {
          id: 'item-tamper',
          branchId: 'khalid-1',
          sessionId: 'stk-flow-1',
          medicineId: 'med-1',
          medicineName: 'Panadol Extra',
          systemStock: 10,
          actualCount: 8,
          variance: 0,
          buyPrice: 2500,
          varianceSDG: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(cashierDb, 'branches/khalid-1/stocktaking_sessions/stk-flow-1/items/item-cashier'), {
          id: 'item-cashier',
          branchId: 'khalid-1',
          sessionId: 'stk-flow-1',
          medicineId: 'med-1',
          medicineName: 'Panadol Extra',
          systemStock: 10,
          actualCount: 9,
          variance: -1,
          buyPrice: 2500,
          varianceSDG: -2500,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );

      // Cannot jump directly from in_progress to sync_completed_unverified
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1'), {
          status: 'sync_completed_unverified',
          accountingStatus: 'unverified_client_sync',
          committedAt: serverTimestamp(),
          committedByUid: admin1Uid,
          totalItemsCount: 1,
          matchedItemsCount: 0,
          surplusItemsCount: 0,
          deficitItemsCount: 1,
          itemsWithVariance: 1,
          totalScanned: 8,
          netVarianceSDG: -5000,
          adjustmentLedgerIds: ['mov-1'],
          updatedAt: serverTimestamp(),
        })
      );

      // Valid transition: in_progress -> reviewing -> syncing_adjustments
      await assertSucceeds(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1'), {
          status: 'reviewing',
          accountingStatus: 'open',
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1'), {
          status: 'syncing_adjustments',
          accountingStatus: 'open',
          updatedAt: serverTimestamp(),
        })
      );

      // Items are LOCKED during syncing_adjustments, and cancelling or reverting to reviewing MUST FAIL
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1/items/med-1'), {
          actualCount: 10,
          variance: 0,
          varianceSDG: 0,
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        deleteDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1/items/med-1'))
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1'), {
          status: 'cancelled',
          accountingStatus: 'cancelled',
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1'), {
          status: 'reviewing',
          accountingStatus: 'open',
          updatedAt: serverTimestamp(),
        })
      );

      // Completion MUST FAIL with wrong ledger type ('mov-1' is INITIAL) or empty adjustmentLedgerIds
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1'), {
          status: 'sync_completed_unverified',
          accountingStatus: 'unverified_client_sync',
          committedAt: serverTimestamp(),
          committedByUid: admin1Uid,
          totalItemsCount: 1,
          matchedItemsCount: 0,
          surplusItemsCount: 0,
          deficitItemsCount: 1,
          itemsWithVariance: 1,
          totalScanned: 8,
          netVarianceSDG: -5000,
          adjustmentLedgerIds: ['mov-1'],
          updatedAt: serverTimestamp(),
        })
      );

      // Create genuine ADJUSTMENT movements, then fail if claiming server_verified or committed
      for (const idx of [1, 2, 3]) {
        await assertSucceeds(
          setDoc(doc(admin1Db, `branches/khalid-1/inventory_ledger/stk-adj-${idx}`), {
            id: `stk-adj-${idx}`,
            branchId: 'khalid-1',
            medicineId: 'med-1',
            type: 'ADJUSTMENT',
            unit: 'pack',
            quantityDelta: -1,
            baseUnitsDelta: -20,
            referenceId: 'STK-20261117-0001',
            userId: admin1Uid,
            createdAt: serverTimestamp(),
          })
        );
      }
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1'), {
          status: 'committed',
          accountingStatus: 'server_verified',
          committedAt: serverTimestamp(),
          committedByUid: admin1Uid,
          totalItemsCount: 3,
          matchedItemsCount: 0,
          surplusItemsCount: 0,
          deficitItemsCount: 3,
          itemsWithVariance: 3,
          totalScanned: 24,
          netVarianceSDG: -15000,
          adjustmentLedgerIds: ['stk-adj-1', 'stk-adj-2', 'stk-adj-3'],
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1'), {
          status: 'sync_completed_unverified',
          accountingStatus: 'unverified_client_sync',
          committedAt: serverTimestamp(),
          committedByUid: admin1Uid,
          totalItemsCount: 3,
          matchedItemsCount: 0,
          surplusItemsCount: 0,
          deficitItemsCount: 3,
          itemsWithVariance: 3,
          totalScanned: 24,
          netVarianceSDG: -15000,
          adjustmentLedgerIds: ['stk-adj-1', 'stk-adj-2', 'stk-adj-missing-last'],
          updatedAt: serverTimestamp(),
        })
      );

      // Valid completion to sync_completed_unverified + unverified_client_sync
      await assertSucceeds(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1'), {
          status: 'sync_completed_unverified',
          accountingStatus: 'unverified_client_sync',
          committedAt: serverTimestamp(),
          committedByUid: admin1Uid,
          totalItemsCount: 3,
          matchedItemsCount: 0,
          surplusItemsCount: 0,
          deficitItemsCount: 3,
          itemsWithVariance: 3,
          totalScanned: 24,
          netVarianceSDG: -15000,
          adjustmentLedgerIds: ['stk-adj-1', 'stk-adj-2', 'stk-adj-3'],
          updatedAt: serverTimestamp(),
        })
      );

      // Terminal Lock after sync_completed_unverified: items create/update/delete & session reopen ALL FAIL
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1/items/med-new-lock'), {
          id: 'med-new-lock',
          branchId: 'khalid-1',
          sessionId: 'stk-flow-1',
          medicineId: 'med-1',
          medicineName: 'Panadol Extra',
          systemStock: 5,
          actualCount: 5,
          variance: 0,
          buyPrice: 2500,
          varianceSDG: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1/items/med-1'), {
          actualCount: 10,
          variance: 0,
          varianceSDG: 0,
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        deleteDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1/items/med-1'))
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-flow-1'), {
          status: 'in_progress',
          accountingStatus: 'open',
          updatedAt: serverTimestamp(),
        })
      );

      // Cancelled session pre-sync locks items & prevents reopen
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-cancel-1'), {
          id: 'stk-cancel-1',
          branchId: 'khalid-1',
          status: 'in_progress',
          accountingStatus: 'open',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-cancel-1'), {
          status: 'cancelled',
          accountingStatus: 'cancelled',
          auditReason: 'Admin cancelled before commit',
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-cancel-1/items/med-1'), {
          id: 'med-1',
          branchId: 'khalid-1',
          sessionId: 'stk-cancel-1',
          medicineId: 'med-1',
          medicineName: 'Panadol Extra',
          systemStock: 10,
          actualCount: 10,
          variance: 0,
          buyPrice: 2500,
          varianceSDG: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertFails(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-cancel-1'), {
          status: 'in_progress',
          accountingStatus: 'open',
          updatedAt: serverTimestamp(),
        })
      );

      // Zero-variance completion allowed with empty adjustmentLedgerIds; bulk root items array rejected
      await assertFails(
        setDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-legacy-items'), {
          id: 'stk-legacy-items',
          branchId: 'khalid-1',
          status: 'in_progress',
          accountingStatus: 'open',
          items: [],
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        setDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-zero-var'), {
          id: 'stk-zero-var',
          branchId: 'khalid-1',
          sessionNumber: 'STK-ZERO-1',
          status: 'in_progress',
          accountingStatus: 'open',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-zero-var'), {
          status: 'syncing_adjustments',
          accountingStatus: 'open',
          updatedAt: serverTimestamp(),
        })
      );
      await assertSucceeds(
        updateDoc(doc(admin1Db, 'branches/khalid-1/stocktaking_sessions/stk-zero-var'), {
          status: 'sync_completed_unverified',
          accountingStatus: 'unverified_client_sync',
          committedAt: serverTimestamp(),
          committedByUid: admin1Uid,
          totalItemsCount: 1,
          matchedItemsCount: 1,
          surplusItemsCount: 0,
          deficitItemsCount: 0,
          itemsWithVariance: 0,
          totalScanned: 5,
          netVarianceSDG: 0,
          adjustmentLedgerIds: [],
          updatedAt: serverTimestamp(),
        })
      );
    }

    assert.ok(true);
    console.log('PASS: All Hardened Firestore Security Rules v2 emulator assertions succeeded');
  } finally {
    await testEnv.cleanup();
  }
}

run().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
