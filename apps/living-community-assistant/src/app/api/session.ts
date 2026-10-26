import {
  browserLocalPersistence,
  onIdTokenChanged,
  setPersistence,
  signInWithCustomToken,
  signOut,
  type User,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, functions } from './firebase';

let persistence: Promise<void> | undefined;
function ready() {
  persistence ??= setPersistence(auth, browserLocalPersistence).catch(
    (error) => {
      persistence = undefined;
      throw error;
    },
  );
  return persistence;
}

export async function ensureAuthorizedSession(): Promise<User> {
  await ready();
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user || (await user.getIdTokenResult()).claims.appAccess !== true)
    throw new Error('Password required.');
  return user;
}

export async function unlockApp(password: string): Promise<void> {
  await ready();
  // Discard legacy or expired identities before the public callable attaches auth.
  if (auth.currentUser) await signOut(auth);
  const unlock = httpsCallable<{ password: string }, { customToken: string }>(
    functions,
    'unlockApp',
  );
  const { data } = await unlock({ password });
  await signInWithCustomToken(auth, data.customToken);
}

export function lockApp(): Promise<void> {
  return signOut(auth);
}

export function observeAccess(
  listener: (user: User | null, error?: string) => void,
): () => void {
  let disposed = false;
  let revision = 0;
  const unsubscribe = onIdTokenChanged(
    auth,
    (user) => {
      const current = ++revision;
      void ready()
        .then(async () => {
          const allowed =
            user && (await user.getIdTokenResult()).claims.appAccess === true;
          if (!disposed && current === revision)
            listener(allowed ? user : null);
        })
        .catch(() => {
          if (!disposed && current === revision)
            listener(null, 'Could not restore access. Please retry.');
        });
    },
    () => {
      revision++;
      if (!disposed) listener(null, 'Could not restore access. Please retry.');
    },
  );
  return () => {
    disposed = true;
    revision++;
    unsubscribe();
  };
}
