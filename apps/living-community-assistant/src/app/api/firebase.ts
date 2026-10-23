import { getApp, getApps, initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import environment from '#firebase-environment';

const existingApp = getApps().length ? getApp() : undefined;
export const firebaseApp = existingApp ?? initializeApp(environment.firebase);

export const auth = getAuth(firebaseApp);
export const firestore = getFirestore(firebaseApp);
// Initialize Auth first so Functions can attach its ID token to callable requests.
export const functions = getFunctions(firebaseApp, 'us-central1');

if (__FIREBASE_USE_EMULATOR__ && !existingApp) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(firestore, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
