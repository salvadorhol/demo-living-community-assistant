import {getReviewAudio} from './review';
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  blob: vi.fn(),
  ref: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock('firebase/functions', () => ({httpsCallable: () => mocks.call}));
vi.mock('firebase/storage', () => ({getBlob: mocks.blob, ref: mocks.ref}));
vi.mock('./firebase', () => ({
  functions: {},
  storage: {name: 'configured-emulator-storage'},
}));
const OriginalURL = URL;
const access = {
  kind: 'storage',
  bucket: 'demo-test-call-recordings',
  objectPath: 'sessions/visitor/calls/one/recording.wav',
  sizeBytes: 8 * 1024 * 1024,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.call.mockResolvedValue({data: access});
  mocks.ref.mockReturnValue({name: 'recording-reference'});
  mocks.blob.mockResolvedValue(new Blob([new Uint8Array(access.sizeBytes)]));
  mocks.create.mockReturnValue('blob:recording');
  vi.stubGlobal(
    'URL',
    class extends OriginalURL {
      static override createObjectURL = mocks.create;
      static override revokeObjectURL = mocks.revoke;
    }
  );
});
afterEach(() => vi.unstubAllGlobals());
it('downloads a recording above 6 MB through configured Storage and creates a WAV Blob URL', async () => {
  const result = await getReviewAudio({uid: 'visitor', callId: 'one'});
  expect(result.url).toBe('blob:recording');
  expect(mocks.ref).toHaveBeenCalledWith(
    {name: 'configured-emulator-storage'},
    'gs://demo-test-call-recordings/sessions/visitor/calls/one/recording.wav'
  );
  expect(mocks.blob).toHaveBeenCalledWith(
    {name: 'recording-reference'},
    200 * 1024 * 1024
  );
  expect(mocks.create.mock.calls[0][0].type).toBe('audio/wav');
  result.dispose();
  result.dispose();
  expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith('blob:recording');
});
it.each([
  {kind: 'signed-url', url: 'https://signed.test/audio', expiresAt: 123},
  {url: 'https://signed.test/audio', expiresAt: 123},
])('preserves production and older signed URL responses', async data => {
  mocks.call.mockResolvedValue({data});
  const result = await getReviewAudio({uid: 'visitor', callId: 'one'});
  expect(result).toMatchObject({url: data.url, expiresAt: 123});
  result.dispose();
  expect(mocks.blob).not.toHaveBeenCalled();
  expect(mocks.revoke).not.toHaveBeenCalled();
});
it('rejects oversized metadata before downloading', async () => {
  mocks.call.mockResolvedValue({
    data: {...access, sizeBytes: 200 * 1024 * 1024 + 1},
  });
  await expect(getReviewAudio({uid: 'visitor', callId: 'one'})).rejects.toThrow(
    '200 MiB'
  );
  expect(mocks.blob).not.toHaveBeenCalled();
});
it.each([
  ['storage/object-not-found', 'Recording not found'],
  ['storage/unauthorized', 'Recording access denied'],
  ['storage/retry-limit-exceeded', 'Audio could not be downloaded'],
])(
  'reports download failure %s without creating a Blob URL',
  async (code, message) => {
    mocks.blob.mockRejectedValue({code});
    await expect(
      getReviewAudio({uid: 'visitor', callId: 'one'})
    ).rejects.toThrow(message);
    expect(mocks.create).not.toHaveBeenCalled();
  }
);

it('does not create a playable URL for a truncated download', async () => {
  mocks.blob.mockResolvedValue(new Blob(['partial']));
  await expect(getReviewAudio({uid: 'visitor', callId: 'one'})).rejects.toThrow(
    'Audio could not be downloaded'
  );
  expect(mocks.create).not.toHaveBeenCalled();
});
