import {APPOINTMENTS_PATH} from '@living-community-assistant/types/appointments';
import assert from 'node:assert/strict';
import {initializeApp, deleteApp} from 'firebase/app';
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
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDocFromServer,
  getDocs,
  collection,
  setDoc,
  deleteDoc,
  serverTimestamp,
  terminate,
} from 'firebase/firestore';
import {
  initializeApp as initializeAdmin,
  deleteApp as deleteAdmin,
} from 'firebase-admin/app';
import {getFirestore as adminFirestore} from 'firebase-admin/firestore';
import {SOPHIE_PROMPT_PATH} from '@living-community-assistant/types/prompt';
import {
  TEST_ACCESS_PASSWORD,
  TEST_ADMIN_PASSWORD,
} from './emulator-secrets.mjs';
import {seedSophiePrompt} from './seed-sophie-prompt.mjs';
import {publishReviewedPrompt} from '../apps/socket-server/src/ai/publish-prompt.ts';
import {sophieInstructions} from '../apps/socket-server/src/ai/sophie-prompt.ts';
assert.equal(
  process.env.FIRESTORE_EMULATOR_HOST,
  '127.0.0.1:8180',
  'Run through the isolated smoke emulator suite.'
);
const projectId = 'demo-living-community-assistant';
const app = initializeApp({projectId, apiKey: 'demo-api-key'}, 'admin-smoke');
const admin = initializeAdmin({projectId}, 'admin-smoke-trusted');
const trusted = adminFirestore(admin).doc(SOPHIE_PROMPT_PATH);
const original = (await trusted.get()).data();
const trustedAppointments = adminFirestore(admin).doc(APPOINTMENTS_PATH);
const originalAppointments = (await trustedAppointments.get()).data();
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, 'us-central1');
connectAuthEmulator(auth, 'http://127.0.0.1:9190', {disableWarnings: true});
connectFirestoreEmulator(db, '127.0.0.1', 8180);
connectFunctionsEmulator(functions, '127.0.0.1', 5101);
const reference = doc(db, SOPHIE_PROMPT_PATH);
const denied = operation =>
  assert.rejects(operation, error => error.code === 'permission-denied');
try {
  await denied(getDocFromServer(reference));
  await denied(getDocFromServer(doc(db, APPOINTMENTS_PATH)));
  const unlockAdmin = httpsCallable(functions, 'unlockAdmin');
  await assert.rejects(
    unlockAdmin({password: TEST_ACCESS_PASSWORD}),
    error => error.code === 'functions/permission-denied'
  );
  const appToken = (
    await httpsCallable(
      functions,
      'unlockApp'
    )({password: TEST_ACCESS_PASSWORD})
  ).data.customToken;
  await signInWithCustomToken(auth, appToken);
  assert.notEqual(
    (await auth.currentUser.getIdTokenResult()).claims.admin,
    true
  );
  await denied(getDocFromServer(reference));
  await denied(getDocFromServer(doc(db, APPOINTMENTS_PATH)));
  await denied(setDoc(reference, {content: 'unauthorized'}));
  await signOut(auth);
  const token = (await unlockAdmin({password: TEST_ADMIN_PASSWORD})).data
    .customToken;
  const {user} = await signInWithCustomToken(auth, token);
  const claims = (await user.getIdTokenResult(true)).claims;
  assert.equal(claims.admin, true);
  assert.equal(claims.appAccess, true);
  const appointmentsRef = doc(db, APPOINTMENTS_PATH);
  const appointments = (await getDocFromServer(appointmentsRef)).data();
  const validAppointments = {
    slots: appointments.slots,
    revision: appointments.revision + 1,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  };
  await setDoc(appointmentsRef, validAppointments);
  for (const patch of [
    {slots: {}},
    {slots: Array(21).fill({date: '2099-01-01', time: '10:00'})},
    {revision: validAppointments.revision},
    {updatedBy: 'forged'},
    {updatedAt: new Date(0)},
    {extra: true},
  ]) {
    await denied(
      setDoc(appointmentsRef, {
        ...validAppointments,
        revision: validAppointments.revision + 1,
        ...patch,
      })
    );
  }
  await denied(deleteDoc(appointmentsRef));
  await trustedAppointments.delete();
  await denied(setDoc(appointmentsRef, {...validAppointments, revision: 2}));
  await setDoc(appointmentsRef, {
    ...validAppointments,
    revision: 1,
    slots: [],
  });
  const empty = await fetch(
    `http://127.0.0.1:5101/${projectId}/us-central1/getAvailableAppointments`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{}',
    }
  );
  assert.deepEqual((await empty.json()).appointments, []);
  await trustedAppointments.set({
    slots: [{date: 'not-a-date', time: '10:00'}],
    revision: 2,
    updatedAt: new Date(),
    updatedBy: 'test',
  });
  const invalid = await fetch(
    `http://127.0.0.1:5101/${projectId}/us-central1/getAvailableAppointments`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{}',
    }
  );
  assert.equal(
    invalid.status,
    503,
    'Invalid configuration must fail instead of returning invented availability'
  );
  const initial = (await getDocFromServer(reference)).data();
  const valid = {
    content: 'Private edited prompt\nSecond line',
    revision: initial.revision + 1,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
  };
  await setDoc(reference, valid);
  assert.equal(
    (await getDocFromServer(reference)).get('content'),
    valid.content
  );
  const next = {...valid, revision: valid.revision + 1};
  for (const patch of [
    {content: ''},
    {content: ' \n\t'},
    {content: 'x'.repeat(50001)},
    {content: 1},
    {revision: valid.revision},
    {revision: next.revision + 1},
    {revision: 1.5},
    {updatedBy: 'forged'},
    {updatedAt: new Date(0)},
    {extra: true},
  ])
    await denied(setDoc(reference, {...next, ...patch}));
  await denied(deleteDoc(reference));
  await denied(getDocs(collection(db, 'appConfig')));
  await denied(getDocFromServer(doc(db, 'appConfig/other')));
  await trusted.delete();
  await denied(setDoc(reference, {...next, revision: 2}));
  await setDoc(reference, {...valid, revision: 1});
  await seedSophiePrompt({projectId});
  assert.equal(
    (await trusted.get()).get('content'),
    valid.content,
    'Seeding must never overwrite an edit'
  );
  await assert.rejects(publishReviewedPrompt(admin, 2), /revision changed/);
  assert.equal((await trusted.get()).get('content'), valid.content);
  assert.equal(await publishReviewedPrompt(admin, 1), 2);
  assert.equal((await trusted.get()).get('content'), sophieInstructions);
  assert.equal(await publishReviewedPrompt(admin, 2), 2);
  console.log(
    'Admin smoke passed: separate password and refreshed claims, private reads, validated create/update, denied listing/deletion, non-destructive seeding, and revision-checked reviewed-prompt publication.'
  );
} finally {
  if (original) await trusted.set(original);
  if (originalAppointments) await trustedAppointments.set(originalAppointments);
  await terminate(db);
  await deleteApp(app);
  await deleteAdmin(admin);
}
