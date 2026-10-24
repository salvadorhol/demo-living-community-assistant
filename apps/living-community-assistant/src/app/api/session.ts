import { signInAnonymously, type User } from 'firebase/auth';
import { auth } from './firebase';

let pending: Promise<User> | undefined;
export async function ensureAnonymousSession(): Promise<User> {
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;
  pending ??= signInAnonymously(auth)
    .then(({ user }) => user)
    .finally(() => {
      pending = undefined;
    });
  return pending;
}
