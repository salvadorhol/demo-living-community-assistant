import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { migrateAppointmentPrompt } from '../apps/socket-server/src/ai/appointment-prompt-migration.ts';
import {
  SOPHIE_PROMPT_PATH,
  validSophiePrompt,
  validPromptContent,
} from '@living-community-assistant/types/prompt';
const [flag, projectId, extra] = process.argv.slice(2);
if (
  flag !== '--project' ||
  !projectId ||
  extra ||
  !/^[a-z][a-z0-9-]+$/.test(projectId)
)
  throw new Error(
    'Usage: node tools/migrate-appointment-prompt.mjs --project <project-id>',
  );
if (projectId.startsWith('demo-') && !process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error('Set FIRESTORE_EMULATOR_HOST for a demo project.');
const app = initializeApp({ projectId });
try {
  const db = getFirestore(app);
  const reference = db.doc(SOPHIE_PROMPT_PATH);
  const original = (await reference.get()).data();
  if (!validSophiePrompt(original))
    throw new Error('Saved prompt is missing or invalid.');
  const content = migrateAppointmentPrompt(original.content);
  if (!validPromptContent(content))
    throw new Error('Migrated prompt exceeds the content limit.');
  if (content === original.content)
    console.log('Appointment prompt instructions already current.');
  else {
    await db.runTransaction(async (tx) => {
      if ((await tx.get(reference)).get('revision') !== original.revision)
        throw new Error(
          'Prompt changed during migration. Retry after reviewing the latest version.',
        );
      tx.set(reference, {
        content,
        revision: original.revision + 1,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: 'appointment-migration',
      });
    });
    console.log(
      'Appointment prompt instructions updated; unrelated edits preserved.',
    );
  }
} finally {
  await deleteApp(app);
}
