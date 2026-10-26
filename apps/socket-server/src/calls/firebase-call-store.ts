import type { App } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { statSync } from 'node:fs';
import type { CallStore } from './call-store.ts';

export function firebaseCallStore(app: App, bucketName: string): CallStore {
  const db = getFirestore(app);
  const ref = (uid: string, id: string) =>
    db.doc(`sessions/${uid}/calls/${id}`);
  return {
    async start(uid, id, info) {
      const batch = db.batch();
      batch.set(
        db.doc(`sessions/${uid}`),
        {
          uid,
          provider: info.authProvider ?? 'unknown',
          lastSeenAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      batch.set(
        ref(uid, id),
        { ...info, uid, createdAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
      await batch.commit();
    },
    async update(uid, id, info) {
      const call = ref(uid, id);
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(call);
        if (!current.exists || current.get('status') === 'deleting')
          throw new Error('Call is no longer available.');
        transaction.update(call, {
          ...info,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
    },
    async transcript(uid, id, value) {
      const call = ref(uid, id);
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(call);
        if (!current.exists || current.get('status') === 'deleting')
          throw new Error('Call is no longer available.');
        transaction.set(call.collection('transcripts').doc(value.id), {
          ...value,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
    },
    async upload(uid, id, path, durationMs) {
      const objectPath = `sessions/${uid}/calls/${id}/recording.wav`;
      const [file] = await getStorage(app)
        .bucket(bucketName)
        .upload(path, {
          destination: objectPath,
          resumable: false,
          metadata: {
            contentType: 'audio/wav',
            cacheControl: 'private, no-store',
          },
        });
      const [metadata] = await file.getMetadata();
      return {
        bucket: bucketName,
        objectPath,
        generation: String(metadata.generation),
        contentType: 'audio/wav',
        bytes: statSync(path).size,
        durationMs,
      };
    },
  };
}
