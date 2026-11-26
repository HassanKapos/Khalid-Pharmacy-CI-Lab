import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { initializeAndMigrate, openPharmacyDB } from '../src/services/pharmacyDb';

async function transactionDone(tx: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

async function seedLegacyBankakDatabase(): Promise<void> {
  const request = indexedDB.open('KhalidPharmacyBankakDB', 1);
  const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => {
      request.result.createObjectStore('receipts', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const tx = legacyDb.transaction('receipts', 'readwrite');
  const store = tx.objectStore('receipts');
  store.put({
    id: 'legacy-bankak-migration-001',
    transactionId: 'LEGACY-001',
    imageData: 'data:image/jpeg;base64,LEGACY_ORIGINAL_1',
    status: 'Completed'
  });
  store.put({
    id: 'legacy-bankak-migration-002',
    transactionId: 'LEGACY-002',
    imageData: 'data:image/jpeg;base64,LEGACY_ORIGINAL_2',
    status: 'Needs Review'
  });
  store.put({
    id: 'legacy-bankak-migration-003',
    transactionId: 'LEGACY-003',
    imageData: 'data:image/jpeg;base64,LEGACY_ORIGINAL_3',
    status: 'Completed'
  });
  await transactionDone(tx);
  legacyDb.close();
}

async function readPrimaryReceipts(): Promise<any[]> {
  const db = await openPharmacyDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('receipts', 'readonly');
    const request = tx.objectStore('receipts').getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function run(): Promise<void> {
  const db = await openPharmacyDB();
  const seedTx = db.transaction('metadata', 'readwrite');
  seedTx.objectStore('metadata').put({
    key: 'is_initialized',
    value: true,
    initializedAt: new Date().toISOString()
  });
  await transactionDone(seedTx);

  // A newer primary-store record must win over an older legacy copy with the same ID.
  const existingTx = db.transaction('receipts', 'readwrite');
  existingTx.objectStore('receipts').put({
    id: 'legacy-bankak-migration-001',
    transactionId: 'PRIMARY-001',
    imageData: 'data:image/jpeg;base64,PRIMARY_VERSION',
    status: 'Completed'
  });
  await transactionDone(existingTx);

  // A durable deletion tombstone must prevent a legacy copy from being resurrected.
  const tombstoneTx = db.transaction('bankak_tombstones', 'readwrite');
  tombstoneTx.objectStore('bankak_tombstones').put({
    id: 'legacy-bankak-migration-002',
    transactionId: 'LEGACY-002',
    deletedAt: new Date().toISOString(),
    syncStatus: 'pending_server_delete'
  });
  await transactionDone(tombstoneTx);

  await seedLegacyBankakDatabase();

  // The migration promise must not resolve until all legacy records are durable in the primary DB.
  await initializeAndMigrate();
  const migrated = await readPrimaryReceipts();
  const first = migrated.find(receipt => receipt.id === 'legacy-bankak-migration-001');
  const deleted = migrated.find(receipt => receipt.id === 'legacy-bankak-migration-002');
  const third = migrated.find(receipt => receipt.id === 'legacy-bankak-migration-003');

  assert.ok(first, 'Existing primary Bankak receipt remains present after migration');
  assert.equal(deleted, undefined, 'Legacy receipt with a durable deletion tombstone is not resurrected');
  assert.ok(third, 'Unseen legacy Bankak receipt is migrated before initializeAndMigrate resolves');
  assert.equal(first.imageData, 'data:image/jpeg;base64,PRIMARY_VERSION', 'Existing primary receipt must not be overwritten by legacy data');
  assert.equal(third.imageData, 'data:image/jpeg;base64,LEGACY_ORIGINAL_3', 'New legacy receipt and its original image must be imported');

  // Re-running migration must remain idempotent and preserve the same records.
  await initializeAndMigrate();
  const migratedAgain = await readPrimaryReceipts();
  assert.equal(
    migratedAgain.filter(receipt => receipt.id.startsWith('legacy-bankak-migration-')).length,
    2,
    'Repeated migration must not duplicate legacy receipts'
  );

  console.log('Phase 1A Bankak legacy migration checks: all passed.');
}

run().catch(error => {
  console.error('Phase 1A Bankak legacy migration checks failed:', error);
  process.exitCode = 1;
});
