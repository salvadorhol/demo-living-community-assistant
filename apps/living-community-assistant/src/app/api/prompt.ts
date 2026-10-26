import {
  doc,
  getDocFromServer,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import {
  SOPHIE_PROMPT_PATH,
  validPromptContent,
  validSophiePrompt,
  type SophiePrompt,
} from '@living-community-assistant/types/prompt';
import { auth, firestore } from './firebase';
const reference = () => doc(firestore, SOPHIE_PROMPT_PATH);
export async function loadPrompt(): Promise<SophiePrompt | null> {
  const snapshot = await getDocFromServer(reference());
  if (!snapshot.exists()) return null;
  const value = snapshot.data();
  if (!validSophiePrompt(value))
    throw new Error('The saved prompt is invalid. Contact the administrator.');
  return value;
}
export async function savePrompt(
  content: string,
  baseRevision: number,
): Promise<void> {
  if (!validPromptContent(content))
    throw new Error('Enter a nonblank prompt of at most 50,000 characters.');
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Admin sign-in required.');
  await runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(reference());
    const revision = snapshot.exists() ? snapshot.get('revision') : 0;
    if (revision !== baseRevision)
      throw new Error(
        'Another admin changed this prompt. Your draft is preserved. Discard changes to load the latest version before saving.',
      );
    transaction.set(reference(), {
      content,
      revision: revision + 1,
      updatedAt: serverTimestamp(),
      updatedBy: uid,
    });
  });
}
