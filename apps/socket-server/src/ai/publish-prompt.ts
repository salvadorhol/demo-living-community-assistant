import type { App } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  SOPHIE_PROMPT_PATH,
  validSophiePrompt,
  validPromptContent,
} from '@living-community-assistant/types/prompt';
import { sophieInstructions } from './sophie-prompt.ts';

/** Explicit publication only. Startup seeding must never overwrite an admin edit. */
export async function publishReviewedPrompt(
  app: App,
  expectedRevision: number,
): Promise<number> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new Error(
      'Supply a positive --expected-revision from the admin editor.',
    );
  if (!validPromptContent(sophieInstructions))
    throw new Error('The reviewed prompt is invalid.');
  const db = getFirestore(app);
  return db.runTransaction(async (tx) => {
    const ref = db.doc(SOPHIE_PROMPT_PATH);
    const current = (await tx.get(ref)).data();
    if (!validSophiePrompt(current))
      throw new Error(
        'The saved prompt is missing or invalid. Seed it first if needed.',
      );
    if (current.revision !== expectedRevision)
      throw new Error(
        'The prompt revision changed. Review the current admin prompt before publishing; nothing was overwritten.',
      );
    if (current.content === sophieInstructions) return current.revision;
    const revision = current.revision + 1;
    tx.set(ref, {
      content: sophieInstructions,
      revision,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'reviewed-prompt-publish',
    });
    return revision;
  });
}
