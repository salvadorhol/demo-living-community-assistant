import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  signInWithCustomToken,
  signOut,
} from 'firebase/auth';
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from 'firebase/functions';
import { TEST_ACCESS_PASSWORD } from './emulator-secrets.mjs';
const app = initializeApp(
  { projectId: 'demo-living-community-assistant', apiKey: 'demo-api-key' },
  'access-smoke',
);
const auth = getAuth(app);
const functions = getFunctions(app, 'us-central1');
connectAuthEmulator(auth, 'http://127.0.0.1:9190', { disableWarnings: true });
connectFunctionsEmulator(functions, '127.0.0.1', 5101);
const unlock = httpsCallable(functions, 'unlockApp');
try {
  await assert.rejects(
    unlock({ password: 'wrong-password' }),
    (error) => error.code === 'functions/permission-denied',
  );
  assert.equal(auth.currentUser, null);
  await assert.rejects(
    unlock({ password: '' }),
    (error) => error.code === 'functions/invalid-argument',
  );
  const { data } = await unlock({ password: TEST_ACCESS_PASSWORD });
  const { user } = await signInWithCustomToken(auth, data.customToken);
  assert.equal(user.isAnonymous, false);
  assert.equal((await user.getIdTokenResult()).claims.appAccess, true);
  assert.equal((await user.getIdTokenResult(true)).claims.appAccess, true);
  await signOut(auth);
  assert.equal(auth.currentUser, null);
  console.log(
    'Access smoke passed: password exchange, custom sign-in, refreshed claim, and sign-out.',
  );
} finally {
  await deleteApp(app);
}
