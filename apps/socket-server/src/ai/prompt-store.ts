import type { App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  SOPHIE_PROMPT_PATH,
  validSophiePrompt,
  type SophiePrompt,
} from '@living-community-assistant/types/prompt';

export function firebasePromptLoader(app: App): () => Promise<SophiePrompt> {
  return async () => {
    const snapshot = await getFirestore(app).doc(SOPHIE_PROMPT_PATH).get();
    const value: unknown = snapshot.data();
    if (!validSophiePrompt(value))
      throw new Error('Assistant prompt is missing or invalid.');
    return value;
  };
}
