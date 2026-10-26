import { publishReviewedPrompt } from './publish-prompt.ts';
import { sophieInstructions } from './sophie-prompt.ts';
const mocks = vi.hoisted(() => ({ data: {} as unknown, set: vi.fn() }));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'timestamp' },
  getFirestore: () => ({
    doc: () => 'prompt-ref',
    runTransaction: async (run: (tx: unknown) => unknown) =>
      run({ get: async () => ({ data: () => mocks.data }), set: mocks.set }),
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = {
    content: 'Custom current prompt',
    revision: 4,
    updatedAt: { toMillis: () => 0 },
    updatedBy: 'admin',
  };
});
it('publishes only the reviewed full prompt at the expected revision', async () => {
  expect(await publishReviewedPrompt({} as never, 4)).toBe(5);
  expect(mocks.set).toHaveBeenCalledWith('prompt-ref', {
    content: sophieInstructions,
    revision: 5,
    updatedAt: 'timestamp',
    updatedBy: 'reviewed-prompt-publish',
  });
});
it('refuses to overwrite a concurrent admin edit', async () => {
  await expect(publishReviewedPrompt({} as never, 3)).rejects.toThrow(
    'revision changed',
  );
  expect(mocks.set).not.toHaveBeenCalled();
});
it('is idempotent when the reviewed prompt is already current', async () => {
  mocks.data = { ...(mocks.data as object), content: sophieInstructions };
  expect(await publishReviewedPrompt({} as never, 4)).toBe(4);
  expect(mocks.set).not.toHaveBeenCalled();
});
