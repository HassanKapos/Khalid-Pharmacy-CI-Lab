import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FIREBASE_CLIENT_REAL_URL = `${pathToFileURL(path.resolve(process.cwd(), 'src/services/firebaseClient.ts')).href}?real=1`;

export async function resolve(specifier, context, nextResolve) {
  const parent = context?.parentURL || '';
  if (parent.includes('firebaseAuthService.ts')) {
    if (specifier === 'firebase/auth') {
      return { shortCircuit: true, url: 'khalid-test://firebase-auth-mock' };
    }
    if (specifier === 'firebase/firestore') {
      return { shortCircuit: true, url: 'khalid-test://firebase-firestore-mock' };
    }
    if (specifier === './firebaseClient' || specifier === './firebaseClient.ts') {
      return { shortCircuit: true, url: 'khalid-test://firebase-client-mock' };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === 'khalid-test://firebase-auth-mock') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        const m = () => globalThis.__khalidAuthTestMocks.auth;
        export const onIdTokenChanged = (...args) => m().onIdTokenChanged(...args);
        export const reload = (...args) => m().reload(...args);
        export const sendEmailVerification = (...args) => m().sendEmailVerification(...args);
        export const signInWithEmailAndPassword = (...args) => m().signInWithEmailAndPassword(...args);
        export const signInWithPopup = (...args) => m().signInWithPopup(...args);
        export const signOut = (...args) => m().signOut(...args);
      `,
    };
  }

  if (url === 'khalid-test://firebase-firestore-mock') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        const m = () => globalThis.__khalidAuthTestMocks.firestore;
        export const doc = (...args) => m().doc(...args);
        export const getDoc = (...args) => m().getDoc(...args);
        export const getDocFromServer = (...args) => m().getDocFromServer(...args);
        export const onSnapshot = (...args) => m().onSnapshot(...args);
        export const serverTimestamp = (...args) => m().serverTimestamp(...args);
        export const setDoc = (...args) => m().setDoc(...args);
        export const updateDoc = (...args) => m().updateDoc(...args);
        export const writeBatch = (...args) => m().writeBatch(...args);
      `,
    };
  }

  if (url === 'khalid-test://firebase-client-mock') {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        import {
          googleProvider,
          handleFirestoreError,
          isFirebaseConfigured,
          OperationType,
        } from ${JSON.stringify(FIREBASE_CLIENT_REAL_URL)};
        const m = () => globalThis.__khalidAuthTestMocks.client;
        export { googleProvider, handleFirestoreError, isFirebaseConfigured, OperationType };
        export const getFirebaseServices = (...args) => m().getFirebaseServices(...args);
        export const isBrowserOffline = (...args) => m().isBrowserOffline(...args);
        export const subscribeConnectivityChanges = (...args) => m().subscribeConnectivityChanges(...args);
        export const testFirestoreConnection = (...args) => m().testFirestoreConnection(...args);
      `,
    };
  }

  return nextLoad(url, context);
}
