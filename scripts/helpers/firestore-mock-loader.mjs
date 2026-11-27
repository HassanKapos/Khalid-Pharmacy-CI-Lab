export async function resolve(specifier, context, nextResolve) {
  const parent = context?.parentURL || '';
  if (
    parent.includes('stocktakeFirestoreService.ts') &&
    specifier === 'firebase/firestore'
  ) {
    return { shortCircuit: true, url: 'khalid-test://phase2f-firestore-mock' };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === 'khalid-test://phase2f-firestore-mock') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        const m = () => globalThis.__khalidPhase2fFirestoreMock;
        export const Timestamp = globalThis.__khalidPhase2fTimestampClass;
        export const collection = (...args) => m().collection(...args);
        export const doc = (...args) => m().doc(...args);
        export const getDoc = (...args) => m().getDoc(...args);
        export const getDocs = (...args) => m().getDocs(...args);
        export const query = (...args) => m().query(...args);
        export const runTransaction = (...args) => m().runTransaction(...args);
        export const serverTimestamp = (...args) => m().serverTimestamp(...args);
        export const setDoc = (...args) => m().setDoc(...args);
        export const updateDoc = (...args) => m().updateDoc(...args);
        export const where = (...args) => m().where(...args);
        export const writeBatch = (...args) => m().writeBatch(...args);
      `,
    };
  }
  return nextLoad(url, context);
}
