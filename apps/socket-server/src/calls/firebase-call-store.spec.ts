import { firebaseCallStore } from './firebase-call-store.ts';
import type { App } from 'firebase-admin/app';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
}));
vi.mock('firebase-admin/firestore', () => {
  const ref = (path: string) => ({
    path,
    collection: (name: string) => ({
      doc: (id: string) => ref(`${path}/${name}/${id}`),
    }),
  });
  return {
    FieldValue: { serverTimestamp: () => 'server-time' },
    getFirestore: () => ({
      doc: ref,
      runTransaction: async (fn: (tx: unknown) => unknown) => fn(mocks),
    }),
  };
});
const store = firebaseCallStore({} as App, 'test-recordings');
const entry = {
  id: 'utterance',
  role: 'user' as const,
  text: 'Hello',
  isFinal: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ exists: true, get: () => 'ended' });
});
it('updates existing call metadata and writes transcripts beneath the call', async () => {
  await store.update('visitor', 'call', { status: 'saving' });
  expect(mocks.update).toHaveBeenCalledWith(
    expect.objectContaining({ path: 'sessions/visitor/calls/call' }),
    expect.objectContaining({ status: 'saving' }),
  );
  await store.transcript('visitor', 'call', entry);
  expect(mocks.set).toHaveBeenCalledWith(
    expect.objectContaining({
      path: 'sessions/visitor/calls/call/transcripts/utterance',
    }),
    expect.objectContaining(entry),
  );
});
it.each([
  { exists: false, get: () => undefined },
  { exists: true, get: () => 'deleting' },
])(
  'does not recreate deleted calls or their transcript descendants',
  async (current) => {
    mocks.get.mockResolvedValue(current);
    await expect(
      store.update('visitor', 'call', { status: 'saving' }),
    ).rejects.toThrow('no longer available');
    await expect(store.transcript('visitor', 'call', entry)).rejects.toThrow(
      'no longer available',
    );
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  },
);
