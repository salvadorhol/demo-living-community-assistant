const mocks = vi.hoisted(() => ({
  secret: vi.fn(() => 'correct password'),
  createUser: vi.fn(async ({uid}: {uid: string}) => ({uid})),
  claims: vi.fn(async () => undefined),
  token: vi.fn(async () => 'custom-token'),
  warn: vi.fn(),
}));
vi.mock('firebase-functions/params', () => ({
  defineSecret: () => ({value: mocks.secret}),
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
import {unlockApp} from './access';
const call = unlockApp as unknown as (request: {
  data?: unknown;
}) => Promise<unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.secret.mockReturnValue('correct password');
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
