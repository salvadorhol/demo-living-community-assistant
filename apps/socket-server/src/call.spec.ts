import { existsSync } from 'node:fs';
import { SavedCall } from './call.ts';
import type { CallStore } from './call-store.ts';
function setup() {
  const store = {
    start: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    transcript: vi.fn(async () => undefined),
    upload: vi.fn(async () => ({ objectPath: 'private-recording' })),
  } satisfies CallStore;
  const status = vi.fn();
  const transcript = vi.fn();
  const call = new SavedCall('owner', store, status, transcript);
  return { call, store, status, transcript };
}
it('serializes checkpoints, preserves ordering and saves one recording on duplicate End', async () => {
  const { call, store, transcript, status } = setup();
  await call.start('room');
  call.update({ id: 'user-item', role: 'user', text: 'Hel', isFinal: false });
  call.update({
    id: 'assistant-item',
    role: 'assistant',
    text: 'Hi',
    isFinal: true,
  });
  call.update({ id: 'user-item', role: 'user', text: 'Hello', isFinal: true });
  expect(transcript.mock.calls.at(-1)?.[0]).toMatchObject({
    callId: call.id,
    order: 0,
    revision: 2,
  });
  await Promise.all([call.finish('ended'), call.finish('disconnect')]);
  expect(store.upload).toHaveBeenCalledOnce();
  expect(status).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'saved' }),
  );
  expect(store.update).toHaveBeenLastCalledWith(
    'owner',
    call.id,
    expect.objectContaining({ recordingStatus: 'saved' }),
  );
  expect(existsSync(call.recording.directory)).toBe(false);
  call.update({ id: 'late', role: 'user', text: 'late', isFinal: true });
  expect(transcript).toHaveBeenCalledTimes(3);
});
it('retains failed audio, retries upload, and reuses an uploaded reference after metadata failure', async () => {
  const { call, store, status } = setup();
  await call.start('room');
  store.upload.mockRejectedValue(new Error('offline'));
  await call.finish('ended');
  expect(store.upload).toHaveBeenCalledTimes(3);
  expect(status).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: 'failed' }),
  );
  expect(existsSync(call.recording.path)).toBe(true);
  store.upload.mockResolvedValue({ objectPath: 'private-recording' });
  await call.finish('ended');
  expect(call.state).toBe('saved');
  expect(existsSync(call.recording.directory)).toBe(false);
});
