import type { App } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { APPOINTMENTS_PATH } from '@living-community-assistant/types/appointments';
/** Isolated test data only. Production availability must be saved through /admin. */
export async function seedTestAppointments(app: App) {
  if (
    !process.env.FIRESTORE_EMULATOR_HOST ||
    !app.options.projectId?.startsWith('demo-')
  )
    throw new Error('Test slots require an explicit demo emulator.');
  const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const db = getFirestore(app);
  await db.runTransaction(async (tx) => {
    const ref = db.doc(APPOINTMENTS_PATH);
    if ((await tx.get(ref)).exists) return;
    tx.create(ref, {
      slots: [
        { date, time: '10:00' },
        { date, time: '14:30' },
      ],
      revision: 1,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'test-fixture',
    });
  });
}
