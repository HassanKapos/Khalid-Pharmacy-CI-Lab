import assert from "node:assert/strict";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, writeBatch, runTransaction, Timestamp } from "firebase/firestore";

const projectId = "demo-khalid-stage1";
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");
const env = await initializeTestEnvironment({
  projectId, firestore: { host, port: Number(port) }
});
const operatorA = env.authenticatedContext("operator-a", { role: "operator", tenantId: "tenant-a" }).firestore();
const operatorB = env.authenticatedContext("operator-b", { role: "operator", tenantId: "tenant-a" }).firestore();
const foreignOperator = env.authenticatedContext("operator-x", { role: "operator", tenantId: "tenant-b" }).firestore();
const adminA = env.authenticatedContext("admin-a", { role: "admin", tenantId: "tenant-a" }).firestore();
let passed = 0;
async function test(name, fn) {
  await fn(); passed++; console.log(`PASS ${name}`);
}
try {
  await env.withSecurityRulesDisabled(async ({ firestore }) => {
    const db = firestore();
    await setDoc(doc(db, "tenants/tenant-a/leases/shared"), {
      version: 0, owner: "unclaimed", expiresAt: Timestamp.fromMillis(Date.now() + 600000)
    });
    await setDoc(doc(db, "tenants/tenant-a/operationalRecords/seed"), { label: "synthetic" });
    await setDoc(doc(db, "tenants/tenant-a/sensitiveRecords/costs"), { purchaseCost: 17 });
  });

  await test("tenant isolation denies cross-tenant reads", async () => {
    await assertFails(getDoc(doc(foreignOperator, "tenants/tenant-a/operationalRecords/seed")));
  });
  await test("sensitive split denies operator and allows same-tenant admin", async () => {
    await assertFails(getDoc(doc(operatorA, "tenants/tenant-a/sensitiveRecords/costs")));
    await assertSucceeds(getDoc(doc(adminA, "tenants/tenant-a/sensitiveRecords/costs")));
  });
  await test("forbidden financial-field smuggling is rejected", async () => {
    await assertFails(setDoc(doc(operatorA, "tenants/tenant-a/operationalRecords/leak"), {
      label: "synthetic", purchaseCost: 999
    }));
  });
  await test("CAS lease race admits exactly one contender", async () => {
    const refA = doc(operatorA, "tenants/tenant-a/leases/shared");
    const refB = doc(operatorB, "tenants/tenant-a/leases/shared");
    async function claim(db, ref, uid) {
      return runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        if (snap.data().version !== 0) throw new Error("CAS_VERSION_CONFLICT");
        tx.update(ref, { version: 1, owner: uid, expiresAt: Timestamp.fromMillis(Date.now() + 300000) });
      });
    }
    const results = await Promise.allSettled([
      claim(operatorA, refA, "operator-a"), claim(operatorB, refB, "operator-b")
    ]);
    assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
    assert.equal((await getDoc(refA)).data().version, 1);
  });
  await test("expired lease creation is denied by request.time", async () => {
    await assertFails(setDoc(doc(operatorA, "tenants/tenant-a/leases/expired"), {
      version: 0, owner: "operator-a", expiresAt: Timestamp.fromMillis(Date.now() - 60000)
    }));
  });
  await test("atomic batch rolls back valid sibling when forbidden write fails", async () => {
    const batch = writeBatch(operatorA);
    batch.set(doc(operatorA, "tenants/tenant-a/operationalRecords/atomic-probe"), { label: "must-rollback" });
    batch.set(doc(operatorA, "tenants/tenant-a/sensitiveRecords/forbidden"), { purchaseCost: 1 });
    await assertFails(batch.commit());
    await env.withSecurityRulesDisabled(async ({ firestore }) => {
      assert.equal((await getDoc(doc(firestore(), "tenants/tenant-a/operationalRecords/atomic-probe"))).exists(), false);
    });
  });
  await test("deterministic event replay remains idempotent", async () => {
    const ref = doc(operatorA, "tenants/tenant-a/events/event-fixed-001");
    async function recordOnce() {
      await runTransaction(operatorA, async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists()) tx.set(ref, { eventKey: "event-fixed-001", amount: 3 });
      });
    }
    await recordOnce(); await recordOnce();
    const snap = await getDoc(ref);
    assert.equal(snap.exists(), true);
    assert.equal(snap.data().eventKey, "event-fixed-001");
  });
  console.log(`STAGE1_RESULT=PASS (${passed}/7)`);
} finally { await env.cleanup(); }
