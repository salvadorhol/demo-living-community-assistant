import {
  doc,
  getDocFromServer,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import {
  APPOINTMENTS_PATH,
  validateAppointmentSlots,
  type AppointmentsConfig,
} from '@living-community-assistant/types/appointments';
import { auth, firestore } from './firebase';
export async function loadAppointments(): Promise<AppointmentsConfig | null> {
  const snapshot = await getDocFromServer(doc(firestore, APPOINTMENTS_PATH));
  if (!snapshot.exists()) return null;
  const value = snapshot.data();
  validateAppointmentSlots(value.slots);
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.updatedAt?.toMillis !== 'function'
  )
    throw new Error('Invalid appointments configuration.');
  return value as AppointmentsConfig;
}
export async function saveAppointments(
  json: string,
  baseRevision: number,
): Promise<void> {
  let slots: unknown;
  try {
    slots = JSON.parse(json);
  } catch {
    throw new Error('Enter a valid JSON array.');
  }
  validateAppointmentSlots(slots);
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Admin sign-in required.');
  await runTransaction(firestore, async (tx) => {
    const reference = doc(firestore, APPOINTMENTS_PATH);
    const current = await tx.get(reference);
    const revision = current.exists() ? current.get('revision') : 0;
    if (revision !== baseRevision)
      throw new Error(
        'Another admin changed the appointments. Your draft is preserved. Discard changes to reload before saving.',
      );
    tx.set(reference, {
      slots,
      revision: revision + 1,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    });
  });
}
