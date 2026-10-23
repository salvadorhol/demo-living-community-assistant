import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from 'firebase/functions';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  terminate,
} from 'firebase/firestore';

const projectId = 'demo-living-community-assistant';
const app = initializeApp({
  projectId,
  apiKey: 'demo-api-key',
  appId: 'demo-smoke',
});
const functions = getFunctions(app, 'us-central1');
const db = getFirestore(app);
connectFunctionsEmulator(functions, '127.0.0.1', 5101);
connectFirestoreEmulator(db, '127.0.0.1', 8180);
try {
  const response = await fetch(
    `http://127.0.0.1:5101/${projectId}/us-central1/health`,
  );
  assert.equal(response.status, 200);
  for (const body of [
    await response.json(),
    (await httpsCallable(functions, 'healthCallable')()).data,
  ]) {
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.time, 'number');
  }
  const ref = doc(db, 'smoke', 'denied');
  await assert.rejects(
    getDoc(ref),
    (error) => error.code === 'permission-denied',
  );
  await assert.rejects(
    setDoc(ref, { test: true }),
    (error) => error.code === 'permission-denied',
  );
  console.log(
    'Smoke passed: HTTP/callable health and Firestore default-deny rules.',
  );
} finally {
  await terminate(db);
  await deleteApp(app);
}
