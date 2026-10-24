import { VoiceSession } from './voice';
import type { SocketConnection } from '../api/socket';
const mocks = vi.hoisted(() => ({
  chunk: vi.fn<(data: Uint8Array) => void>(),
  lost: () => undefined as void,
  start: vi.fn(),
  stop: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('./capture', () => ({
  MicrophoneCapture: class {
    constructor(chunk: typeof mocks.chunk, lost: typeof mocks.lost) {
      mocks.chunk = chunk;
      mocks.lost = lost;
    }
    start = mocks.start;
    stop = mocks.stop;
    dispose = mocks.dispose;
  },
}));
vi.mock('./playback', () => ({
  AudioPlayback: class {
    enable = async () => undefined;
    handle() {
      return undefined;
    }
    clear() {
      return undefined;
    }
    dispose() {
      return undefined;
    }
  },
}));
function setup() {
  const connection = Object.assign(vi.fn(), {
    startAudio: vi.fn<SocketConnection['startAudio']>(async () => undefined),
    sendAudio: vi.fn<SocketConnection['sendAudio']>(async () => undefined),
    stopAudio: vi.fn(async () => undefined),
    onAudio: vi.fn(() => vi.fn()),
  });
  const status = vi.fn();
  const voice = new VoiceSession(
    connection as SocketConnection,
    status,
    vi.fn(),
  );
  return { voice, connection, status };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockResolvedValue(true);
  mocks.stop.mockResolvedValue(undefined);
});
it('sends chunks serially and drains a final partial chunk before stop', async () => {
  const { voice, connection, status } = setup();
  await voice.start();
  mocks.chunk(new Uint8Array(1920));
  mocks.stop.mockImplementationOnce(async () => {
    mocks.chunk(new Uint8Array(128));
  });
  await voice.stop();
  expect(
    connection.sendAudio.mock.calls.map(([chunk]) => chunk.sequence),
  ).toEqual([0, 1]);
  expect(connection.stopAudio).toHaveBeenCalledTimes(1);
  expect(status).toHaveBeenLastCalledWith({ state: 'idle', chunksSent: 2 });
  voice.dispose();
});
it('stops when input exceeds the queue budget and never replays discarded chunks', async () => {
  const { voice, connection, status } = setup();
  await voice.start();
  let finish!: () => void;
  connection.sendAudio.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  for (let i = 0; i < 7; i++) mocks.chunk(new Uint8Array(1920));
  expect(status).toHaveBeenLastCalledWith({
    state: 'error',
    error: expect.stringContaining('fell behind'),
  });
  expect(mocks.dispose).toHaveBeenCalled();
  finish();
  await Promise.resolve();
  expect(connection.sendAudio).toHaveBeenCalledTimes(1);
  voice.dispose();
});
it('allows permission failure retry and cancels pending capture on disconnect', async () => {
  const { voice, status } = setup();
  mocks.start.mockRejectedValueOnce(new Error('Permission denied'));
  await voice.start();
  expect(status).toHaveBeenLastCalledWith({
    state: 'error',
    error: 'Permission denied',
  });
  await voice.start();
  voice.disconnect();
  expect(mocks.dispose).toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith({
    state: 'error',
    error: expect.stringContaining('disconnected'),
  });
  voice.dispose();
});
it('cancels an unacknowledged start and releases a late server session', async () => {
  const { voice, connection } = setup();
  let acknowledge!: () => void;
  connection.startAudio.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  const start = voice.start();
  await voice.stop();
  acknowledge();
  await start;
  expect(connection.stopAudio).toHaveBeenCalledWith(expect.any(String), true);
  expect(mocks.dispose).toHaveBeenCalled();
  voice.dispose();
});
it('surfaces a chunk acknowledgement failure and device loss', async () => {
  const { voice, connection, status } = setup();
  await voice.start();
  connection.sendAudio.mockRejectedValueOnce(new Error('timeout'));
  mocks.chunk(new Uint8Array(2));
  await vi.waitFor(() =>
    expect(status).toHaveBeenLastCalledWith({
      state: 'error',
      error: 'timeout',
    }),
  );
  await voice.start();
  mocks.lost();
  expect(status).toHaveBeenLastCalledWith({
    state: 'error',
    error: expect.stringContaining('Microphone disconnected'),
  });
  voice.dispose();
});

it('cancels a potentially-created server stream after start times out', async () => {
  const { voice, connection, status } = setup();
  connection.startAudio.mockRejectedValueOnce(new Error('start timeout'));
  await voice.start();
  expect(status).toHaveBeenLastCalledWith({
    state: 'error',
    error: 'start timeout',
  });
  expect(connection.stopAudio).toHaveBeenCalledWith(expect.any(String), true);
  voice.dispose();
});
