const mocks = vi.hoisted(() => ({
  secret: vi.fn(() => 'correct password'),
  adminSecret: vi.fn(() => 'admin password'),
  createUser: vi.fn(async ({uid}: {uid: string}) => ({uid})),
  claims: vi.fn(async () => undefined),
  token: vi.fn(async () => 'custom-token'),
  warn: vi.fn(),
}));
vi.mock('firebase-functions/params', () => ({
  defineSecret: (name: string) => ({
    value: name === 'ADMIN_ACCESS_PASSWORD' ? mocks.adminSecret : mocks.secret,
  }),
}));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (_options: unknown, handler: unknown) => handler,
  HttpsError: class extends Error {
    constructor(
      public code: string,
      message: string
    ) {
      super(message);
    }
  },
}));
vi.mock('firebase-functions/logger', () => ({warn: mocks.warn}));
vi.mock('firebase-admin/app', () => ({
  getApps: () => [{}],
  initializeApp: vi.fn(),
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    createUser: mocks.createUser,
    setCustomUserClaims: mocks.claims,
    createCustomToken: mocks.token,
  }),
}));
import {unlockApp, unlockAdmin} from './access';
const call = unlockApp as unknown as (request: {
  data?: unknown;
}) => Promise<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.secret.mockReturnValue('correct password');
  mocks.adminSecret.mockReturnValue('admin password');
});
it('creates a new visitor and persists access before signing a token', async () => {
  await expect(
    call({data: {password: 'correct password', uid: 'untrusted'}})
  ).resolves.toEqual({customToken: 'custom-token'});
  const uid = mocks.createUser.mock.calls[0][0].uid;
  expect(uid).not.toBe('untrusted');
  expect(mocks.claims).toHaveBeenCalledWith(uid, {appAccess: true});
  expect(mocks.token).toHaveBeenCalledWith(uid);
  expect(mocks.claims.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.token.mock.invocationCallOrder[0]
  );
});
it.each([
  undefined,
  null,
  {},
  {password: ''},
  {password: 42},
  {password: 'é'.repeat(513)},
])('rejects malformed input %j', async data => {
  await expect(call({data})).rejects.toMatchObject({code: 'invalid-argument'});
  expect(mocks.createUser).not.toHaveBeenCalled();
});
it.each(['incorrect', ' correct password', 'correct password '])(
  'rejects an incorrect password without creating an identity',
  async password => {
    await expect(call({data: {password}})).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(mocks.createUser).not.toHaveBeenCalled();
  }
);
it('fails closed when the secret is absent', async () => {
  mocks.secret.mockReturnValue('');
  await expect(
    call({data: {password: 'correct password'}})
  ).rejects.toMatchObject({code: 'unavailable'});
  expect(mocks.createUser).not.toHaveBeenCalled();
});
it('hides SDK failure details', async () => {
  mocks.token.mockRejectedValueOnce(new Error('sensitive SDK details'));
  await expect(
    call({data: {password: 'correct password'}})
  ).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Sign-in is unavailable. Please retry.',
  });
  expect(mocks.warn).toHaveBeenCalledWith('app.access_signing_failed');
});

const callAdmin = unlockAdmin as unknown as typeof call;
it('grants persisted admin and app access only for the admin password', async () => {
  await expect(
    callAdmin({data: {password: 'admin password'}})
  ).resolves.toEqual({customToken: 'custom-token'});
  expect(mocks.claims).toHaveBeenCalledWith(expect.any(String), {
    admin: true,
    appAccess: true,
  });
});
it('rejects the app password at the admin exchange', async () => {
  await expect(
    callAdmin({data: {password: 'correct password'}})
  ).rejects.toMatchObject({code: 'permission-denied'});
  expect(mocks.createUser).not.toHaveBeenCalled();
});
it('does not accept the admin password at the ordinary exchange', async () => {
  await expect(
    call({data: {password: 'admin password'}})
  ).rejects.toMatchObject({code: 'permission-denied'});
});
it.each([''])('fails closed for a missing admin secret %j', async secret => {
  mocks.adminSecret.mockReturnValue(secret);
  await expect(
    callAdmin({data: {password: secret || 'anything'}})
  ).rejects.toMatchObject({code: 'unavailable'});
  expect(mocks.createUser).not.toHaveBeenCalled();
});

it('allows matching app and admin passwords while granting claims by endpoint', async () => {
  mocks.adminSecret.mockReturnValue('correct password');
  await callAdmin({data: {password: 'correct password'}});
  expect(mocks.claims).toHaveBeenLastCalledWith(expect.any(String), {
    admin: true,
    appAccess: true,
  });
  await call({data: {password: 'correct password'}});
  expect(mocks.claims).toHaveBeenLastCalledWith(expect.any(String), {
    appAccess: true,
  });
});
