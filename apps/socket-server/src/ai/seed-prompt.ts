import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { SOPHIE_PROMPT_PATH } from '@living-community-assistant/types/prompt';
import { sophieInstructions } from './sophie-prompt.ts';

/** Explicit bootstrap only; production voice never imports this migration snapshot. */
export async function seedSophiePrompt({ projectId }: { projectId: string }) {
  const demo = /^demo-[a-z0-9-]+$/.test(projectId);
  if (
    !projectId ||
    (!demo && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId))
  )
    throw new Error('Provide an explicit valid --project <project-id>.');
  if (demo && !process.env.FIRESTORE_EMULATOR_HOST)
    throw new Error('A demo project requires FIRESTORE_EMULATOR_HOST.');
  const app = initializeApp({ projectId }, `prompt-seed-${Date.now()}`);
  try {
    const result = await getFirestore(app).runTransaction(
      async (transaction) => {
        const reference = getFirestore(app).doc(SOPHIE_PROMPT_PATH);
        if ((await transaction.get(reference)).exists)
          return 'already exists; unchanged';
        transaction.create(reference, {
          content: sophieInstructions,
          revision: 1,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: 'bootstrap',
        });
        return 'created';
      },
    );
    console.log(`Sophie prompt ${result} in ${projectId}.`);
  } finally {
    await deleteApp(app);
  }
}
