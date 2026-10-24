import { ensureAnonymousSession } from './session';
const mocks = vi.hoisted(() => ({
  auth: {
    authStateReady: vi.fn(async () => undefined),
    currentUser: null as null | { uid: string },
  },
  signIn: vi.fn(),
}));
vi.mock('./firebase', () => ({ auth: mocks.auth }));
vi.mock('firebase/auth', () => ({ signInAnonymously: mocks.signIn }));
afterEach(() => {
  vi.clearAllMocks();
  mocks.auth.currentUser = null;
});
it('restores the existing session without signing in', async () => {
  mocks.auth.currentUser = { uid: 'restored' };
  expect(await ensureAnonymousSession()).toBe(mocks.auth.currentUser);
  expect(mocks.auth.authStateReady).toHaveBeenCalled();
  expect(mocks.signIn).not.toHaveBeenCalled();
});
it('deduplicates concurrent anonymous sign-ins', async () => {
  const user = { uid: 'new' };
  mocks.signIn.mockResolvedValue({ user });
  expect(
    await Promise.all([ensureAnonymousSession(), ensureAnonymousSession()]),
  ).toEqual([user, user]);
  expect(mocks.signIn).toHaveBeenCalledTimes(1);
});
it('allows retry after sign-in failure', async () => {
  mocks.signIn
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ user: { uid: 'retry' } });
  await expect(ensureAnonymousSession()).rejects.toThrow('offline');
  expect(await ensureAnonymousSession()).toEqual({ uid: 'retry' });
});
