import {
  ensureAuthorizedSession,
  unlockApp,
  lockApp,
  observeAccess,
} from './session';
const mocks = vi.hoisted(() => ({
  auth: {
    authStateReady: vi.fn(async () => undefined),
    currentUser: null as null | {
      uid: string;
      getIdTokenResult: ReturnType<typeof vi.fn>;
    },
  },
  signIn: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
  persistence: vi.fn(async () => undefined),
  callable: vi.fn(async () => ({ data: { customToken: 'custom-token' } })),
  observe: vi.fn(),
}));
vi.mock('./firebase', () => ({ auth: mocks.auth, functions: {} }));
vi.mock('firebase/functions', () => ({ httpsCallable: () => mocks.callable }));
vi.mock('firebase/auth', () => ({
  signInWithCustomToken: mocks.signIn,
  signOut: mocks.signOut,
  setPersistence: mocks.persistence,
  browserLocalPersistence: 'local',
  onIdTokenChanged: mocks.observe,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.currentUser = null;
});
it('restores a claimed session without signing in', async () => {
  mocks.auth.currentUser = {
    uid: 'restored',
    getIdTokenResult: vi.fn(async () => ({ claims: { appAccess: true } })),
  };
  expect(await ensureAuthorizedSession()).toBe(mocks.auth.currentUser);
  expect(mocks.signIn).not.toHaveBeenCalled();
});
it('never creates a session without the password exchange', async () => {
  await expect(ensureAuthorizedSession()).rejects.toThrow('Password required');
  expect(mocks.signIn).not.toHaveBeenCalled();
});
it('rejects an existing unclaimed identity', async () => {
  mocks.auth.currentUser = {
    uid: 'legacy',
    getIdTokenResult: vi.fn(async () => ({ claims: {} })),
  };
  await expect(ensureAuthorizedSession()).rejects.toThrow('Password required');
});
it('exchanges a password and signs in using only the returned token', async () => {
  await unlockApp('password');
  expect(mocks.callable).toHaveBeenCalledWith({ password: 'password' });
  expect(mocks.signIn).toHaveBeenCalledWith(mocks.auth, 'custom-token');
});
it('does not sign in when the exchange fails and permits retry', async () => {
  mocks.callable.mockRejectedValueOnce(new Error('offline'));
  await expect(unlockApp('password')).rejects.toThrow('offline');
  expect(mocks.signIn).not.toHaveBeenCalled();
  await unlockApp('password');
  expect(mocks.signIn).toHaveBeenCalledOnce();
});
it('signs out explicitly', async () => {
  await lockApp();
  expect(mocks.signOut).toHaveBeenCalledWith(mocks.auth);
});
it('ignores stale access checks after sign-out across tabs', async () => {
  const unsubscribe = vi.fn();
  mocks.observe.mockReturnValue(unsubscribe);
  const listener = vi.fn();
  const stop = observeAccess(listener);
  const changed = mocks.observe.mock.calls[0][1];
  let resolve!: (value: unknown) => void;
  changed({
    getIdTokenResult: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  changed(null);
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(null));
  resolve({ claims: { appAccess: true } });
  await new Promise((done) => setTimeout(done, 0));
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
