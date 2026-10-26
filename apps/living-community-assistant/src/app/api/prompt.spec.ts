import { loadPrompt, savePrompt } from './prompt';
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  set: vi.fn(),
  auth: { currentUser: { uid: 'admin' } as { uid: string } | null },
}));
vi.mock('./firebase', () => ({ auth: mocks.auth, firestore: {} }));
vi.mock('firebase/firestore', () => ({
  doc: () => 'prompt-ref',
  getDocFromServer: mocks.read,
  serverTimestamp: () => 'server-timestamp',
  runTransaction: async (
    _db: unknown,
    run: (transaction: unknown) => unknown,
  ) => run({ get: mocks.read, set: mocks.set }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.currentUser = { uid: 'admin' };
});
it('distinguishes a missing prompt from an invalid saved document', async () => {
  mocks.read.mockResolvedValueOnce({ exists: () => false });
  await expect(loadPrompt()).resolves.toBeNull();
  mocks.read.mockResolvedValueOnce({
    exists: () => true,
    data: () => ({ content: 'invalid' }),
  });
  await expect(loadPrompt()).rejects.toThrow('invalid');
});
it('creates a missing prompt with revision one and server metadata', async () => {
  mocks.read.mockResolvedValue({ exists: () => false });
  await savePrompt('Prompt', 0);
  expect(mocks.set).toHaveBeenCalledWith('prompt-ref', {
    content: 'Prompt',
    revision: 1,
    updatedAt: 'server-timestamp',
    updatedBy: 'admin',
  });
});
it('preserves a concurrent edit instead of overwriting it', async () => {
  mocks.read.mockResolvedValue({ exists: () => true, get: () => 3 });
  await expect(savePrompt('My draft', 2)).rejects.toThrow(
    'Your draft is preserved',
  );
  expect(mocks.set).not.toHaveBeenCalled();
});
it.each(['', ' \n ', 'a'.repeat(50001)])(
  'rejects invalid content before writing',
  async (content) => {
    await expect(savePrompt(content, 1)).rejects.toThrow('nonblank');
    expect(mocks.read).not.toHaveBeenCalled();
  },
);
