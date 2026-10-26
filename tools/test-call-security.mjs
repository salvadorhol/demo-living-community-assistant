import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  signInAnonymously,
  signInWithCustomToken,
} from 'firebase/auth';
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  terminate,
} from 'firebase/firestore';
import {
  getStorage,
  connectStorageEmulator,
  ref,
  getBytes,
  uploadBytes,
  deleteObject,
  listAll,
} from 'firebase/storage';
import {
  initializeApp as initializeAdmin,
  deleteApp as deleteAdmin,
} from 'firebase-admin/app';
import { getAuth as adminAuth } from 'firebase-admin/auth';
import { getFirestore as adminFirestore } from 'firebase-admin/firestore';
import { getStorage as adminStorage } from 'firebase-admin/storage';
const projectId = 'demo-living-community-assistant';
const bucket = `${projectId}.firebasestorage.app`;
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8180';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9190';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9298';
const admin = initializeAdmin(
  { projectId, storageBucket: bucket },
  'rules-admin',
);
const clients = [];
function client(name) {
  const app = initializeApp(
    { projectId, apiKey: 'demo-api-key', storageBucket: bucket },
    name,
  );
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9190', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8180);
  const storage = getStorage(app);
  connectStorageEmulator(storage, '127.0.0.1', 9298);
  const value = { app, auth, db, storage };
  clients.push(value);
  return value;
}
try {
  const owner = client('owner');
  const other = client('other');
  const anonymous = client('unauthenticated');
  const unclaimed = client('unclaimed');
  const { user } = await signInAnonymously(owner.auth);
  // Retain a valid token for the very same UID without the authorization claim.
  await signInWithCustomToken(
    unclaimed.auth,
    await adminAuth(admin).createCustomToken(user.uid),
  );
  await adminAuth(admin).setCustomUserClaims(user.uid, { appAccess: true });
  await user.getIdToken(true);
  const { user: otherUser } = await signInAnonymously(other.auth);
  await adminAuth(admin).setCustomUserClaims(otherUser.uid, {
    appAccess: true,
  });
  await otherUser.getIdToken(true);
  const path = `sessions/${user.uid}/calls/call`;
  const recording = `${path}/recording.wav`;
  await adminFirestore(admin)
    .doc(`sessions/${user.uid}`)
    .set({ uid: user.uid });
  await adminFirestore(admin)
    .doc(path)
    .set({ uid: user.uid, recording: { bucket, objectPath: recording } });
  const followUp = `sessions/${user.uid}/followUpRequests/request`;
  await adminFirestore(admin)
    .doc(followUp)
    .set({ kind: 'callback', status: 'pending' });
  await adminFirestore(admin)
    .doc(`${path}/transcripts/utterance`)
    .set({ text: 'private transcript' });
  await adminStorage(admin)
    .bucket()
    .file(recording)
    .save(Buffer.from('RIFF-private-audio'), {
      metadata: { contentType: 'audio/wav' },
    });
  for (const c of [owner, other, anonymous, unclaimed]) {
    for (const document of [
      `sessions/${user.uid}`,
      followUp,
      path,
      `${path}/transcripts/utterance`,
    ]) {
      const reference = doc(c.db, document);
      if (c === owner) assert.equal((await getDoc(reference)).exists(), true);
      else
        await assert.rejects(
          getDoc(reference),
          (e) => e.code === 'permission-denied',
        );
      for (const operation of [
        () => setDoc(reference, { malicious: true }),
        () => updateDoc(reference, { malicious: true }),
        () => deleteDoc(reference),
      ])
        await assert.rejects(
          operation(),
          (e) => e.code === 'permission-denied',
        );
    }
    const object = ref(c.storage, recording);
    if (c === owner)
      assert.equal(
        Buffer.from(await getBytes(object)).toString(),
        'RIFF-private-audio',
      );
    else
      await assert.rejects(
        getBytes(object),
        (e) => e.code === 'storage/unauthorized',
      );
    for (const operation of [
      () => uploadBytes(object, new Uint8Array([1])),
      () => deleteObject(object),
      () => listAll(ref(c.storage, `sessions/${user.uid}`)),
    ])
      await assert.rejects(
        operation(),
        (e) => e.code === 'storage/unauthorized',
      );
  }
  assert.equal(
    (await getDocs(collection(owner.db, `${path}/transcripts`))).size,
    1,
  );
  await assert.rejects(
    getDocs(collection(other.db, `${path}/transcripts`)),
    (e) => e.code === 'permission-denied',
  );
  console.log(
    'Call security passed: owner reads, cross-identity denial, and all client writes denied in Firestore and Storage.',
  );
} finally {
  await Promise.all(
    clients.map(async (c) => {
      await terminate(c.db);
      await deleteApp(c.app);
    }),
  );
  await deleteAdmin(admin);
}
