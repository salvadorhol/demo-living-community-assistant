import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {initializeApp, deleteApp} from 'firebase-admin/app';
import {getFirestore, Timestamp} from 'firebase-admin/firestore';
import {
  APPOINTMENTS_PATH,
  validateAppointmentSlots,
} from '@living-community-assistant/types/appointments';

const root = resolve(import.meta.dirname, '..');
export const appointmentsBackupPath = resolve(
  root,
  'firebase-local-config',
  'appointments.json'
);
function validate(data) {
  validateAppointmentSlots(data?.slots);
  if (
    !Number.isSafeInteger(data.revision) ||
    data.revision < 1 ||
    typeof data.updatedBy !== 'string' ||
    !data.updatedBy ||
    !Number.isSafeInteger(data.updatedAt?.seconds) ||
    !Number.isInteger(data.updatedAt?.nanoseconds)
  )
    throw new Error('Invalid local appointments backup.');
  // Timestamp validates its range as well as the nanoseconds component.
  return {
    ...data,
    updatedAt: new Timestamp(
      data.updatedAt.seconds,
      data.updatedAt.nanoseconds
    ),
  };
}
export function readAppointmentsBackup(path, projectId) {
  if (!existsSync(path)) return undefined;
  const backup = JSON.parse(readFileSync(path, 'utf8'));
  if (backup.version !== 1 || backup.projectId !== projectId)
    throw new Error(
      'Local appointments backup belongs to a different project or format.'
    );
  return validate(backup.data);
}
export function writeAppointmentsBackup(path, projectId, value) {
  const data = validate(value);
  const backup = {
    version: 1,
    projectId,
    data: {
      slots: data.slots,
      revision: data.revision,
      updatedBy: data.updatedBy,
      updatedAt: {
        seconds: data.updatedAt.seconds,
        nanoseconds: data.updatedAt.nanoseconds,
      },
    },
  };
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(backup, null, 2)}\n`, {
    mode: 0o600,
    flush: true,
  });
  renameSync(temporary, path);
}
export function newerAppointments(left, right) {
  if (!right) return true;
  const a = left.updatedAt;
  const b = right.updatedAt;
  return (
    a.seconds > b.seconds ||
    (a.seconds === b.seconds &&
      (a.nanoseconds > b.nanoseconds ||
        (a.nanoseconds === b.nanoseconds && left.revision > right.revision)))
  );
}

async function requireEmulator(host) {
  try {
    const response = await fetch(`http://${host}/`, {
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
  } catch {
    throw new Error(
      'The local Firestore emulator is not running. Start development before backing up appointments.'
    );
  }
}

/** Development launcher only: keep admin settings outside Firebase's exit-only export. */
export async function persistLocalAppointments({
  projectId = 'demo-living-community-assistant',
  path = appointmentsBackupPath,
  onError = error =>
    console.error('Local appointments backup failed:', error.message),
} = {}) {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (
    !projectId.startsWith('demo-') ||
    !host ||
    !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)
  )
    throw new Error(
      'Local appointments persistence requires a demo project and a loopback Firestore emulator.'
    );
  const backup = readAppointmentsBackup(path, projectId);
  await requireEmulator(host);
  const app = initializeApp({projectId}, `appointments-backup-${randomUUID()}`);
  const db = getFirestore(app);
  let unsubscribe;
  try {
    // The transaction prevents overwriting an admin save racing with startup.
    await db.runTransaction(async tx => {
      const ref = db.doc(APPOINTMENTS_PATH);
      const snapshot = await tx.get(ref);
      const current = snapshot.exists ? snapshot.data() : undefined;
      if (backup && newerAppointments(backup, current)) tx.set(ref, backup);
    });
    // Wait for the initial snapshot to be durable before starting the frontend.
    await new Promise((resolve, reject) => {
      unsubscribe = db.doc(APPOINTMENTS_PATH).onSnapshot(
        snapshot => {
          try {
            if (snapshot.exists)
              writeAppointmentsBackup(path, projectId, snapshot.data());
            resolve();
          } catch (error) {
            onError(error);
            reject(error);
          }
        },
        error => {
          onError(error);
          reject(error);
        }
      );
    });
  } catch (error) {
    unsubscribe?.();
    await deleteApp(app);
    throw error;
  }
  let stopping;
  return () =>
    (stopping ??= (async () => {
      unsubscribe?.();
      // Capture one last committed change before emulator shutdown/export.
      try {
        await requireEmulator(host);
        const snapshot = await db.doc(APPOINTMENTS_PATH).get();
        if (snapshot.exists)
          writeAppointmentsBackup(path, projectId, snapshot.data());
      } finally {
        await deleteApp(app);
      }
    })());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const stop = await persistLocalAppointments();
  await stop();
  console.log(
    'Current local appointment configuration backed up (if configured).'
  );
}
