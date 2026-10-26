import {
  persistLocalAppointments,
  readAppointmentsBackup,
} from './local-appointments.mjs';
import { APPOINTMENTS_PATH } from '@living-community-assistant/types/appointments';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
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
const projectId = 'demo-appointments-persistence';
const app = initializeApp({
  projectId,
  storageBucket: `${projectId}.firebasestorage.app`,
});
const [mode, marker] = process.argv.slice(2);
const backupPath = join(dirname(marker), 'appointments.json');
const latestSlots = [{ date: '2099-11-02', time: '14:30' }];
const stopAppointments = await persistLocalAppointments({
  projectId,
  path: backupPath,
});
async function waitForBackup(revision) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (readAppointmentsBackup(backupPath, projectId)?.revision === revision)
      return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Appointment changes were not backed up');
}
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
    await getFirestore(app)
      .doc(APPOINTMENTS_PATH)
      .set({
        slots: [{ date: '2099-11-02', time: '10:00' }],
        revision: 1,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: 'admin-test',
      });
    await waitForBackup(1);
    writeFileSync(marker, JSON.stringify({ uid: user.uid, path }));
    await deleteClient(client);
  } else if (mode === 'update-config') {
    // This process deliberately exits without exporting. The next emulator run
    // imports the old revision-one export, as after a missed shutdown export.
    await getFirestore(app).doc(APPOINTMENTS_PATH).set({
      slots: latestSlots,
      revision: 2,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'admin-test',
    });
    await waitForBackup(2);
    console.log(
      'Latest appointments backed up without updating the emulator export.',
    );
  } else {
    const appointments = (
      await getFirestore(app).doc(APPOINTMENTS_PATH).get()
    ).data();
    assert.equal(appointments.revision, 2);
    assert.deepEqual(appointments.slots, latestSlots);
    assert.equal(appointments.updatedBy, 'admin-test');
    const backup = readAppointmentsBackup(backupPath, projectId);
    assert.equal(
      appointments.updatedAt.toMillis(),
      backup.updatedAt.toMillis(),
    );
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
      'Restart persistence passed: latest appointments survived an outdated export; anonymous identity, call, transcript, and recording survived export/import.',
    );
  }
} finally {
  await stopAppointments();
  await deleteApp(app);
}
