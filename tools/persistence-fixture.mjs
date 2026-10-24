import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import {
  initializeApp as clientApp,
  deleteApp as deleteClient,
} from 'firebase/app';
import {
  getAuth as clientAuth,
  connectAuthEmulator,
  signInAnonymously,
} from 'firebase/auth';
const projectId = 'demo-living-community-assistant';
const app = initializeApp({
  projectId,
  storageBucket: `${projectId}.firebasestorage.app`,
});
const [mode, marker] = process.argv.slice(2);
try {
  if (mode === 'seed') {
    const client = clientApp({ projectId, apiKey: 'demo-api-key' });
    const auth = clientAuth(client);
    connectAuthEmulator(
      auth,
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`,
      { disableWarnings: true },
    );
    const { user } = await signInAnonymously(auth);
    const path = `sessions/${user.uid}/calls/persisted`;
    await getFirestore(app)
      .doc(path)
      .set({
        uid: user.uid,
        recording: {
          bucket: `${projectId}.firebasestorage.app`,
          objectPath: `${path}/recording.wav`,
        },
      });
    await getFirestore(app)
      .doc(`${path}/transcripts/one`)
      .set({ text: 'Persisted conversation' });
    await getStorage(app)
      .bucket()
      .file(`${path}/recording.wav`)
      .save(Buffer.from('RIFF-persisted-recording'));
    writeFileSync(marker, JSON.stringify({ uid: user.uid, path }));
    await deleteClient(client);
  } else {
    const { uid, path } = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal((await getAuth(app).getUser(uid)).uid, uid);
    assert.equal((await getFirestore(app).doc(path).get()).get('uid'), uid);
    assert.equal(
      (await getFirestore(app).doc(`${path}/transcripts/one`).get()).get(
        'text',
      ),
      'Persisted conversation',
    );
    assert.equal(
      (
        await getStorage(app).bucket().file(`${path}/recording.wav`).download()
      )[0].toString(),
      'RIFF-persisted-recording',
    );
    console.log(
      'Restart persistence passed: anonymous identity, call, transcript, and recording survived export/import.',
    );
  }
} finally {
  await deleteApp(app);
}
