import { VoiceSession } from './voice';
import type { SocketConnection } from '../api/socket';
const mocks = vi.hoisted(() => ({
  chunk: vi.fn<(data: Uint8Array) => void>(),
  lost: () => undefined as void,
  start: vi.fn(),
  stop: vi.fn(),
  dispose: vi.fn(),
  playbackClear: vi.fn(),
  playbackHandle: vi.fn(),
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
    handle = mocks.playbackHandle;
    clear = mocks.playbackClear;
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
    reportPlayback: vi.fn(),
    onTranscript: vi.fn(() => vi.fn()),
    onAudio: vi.fn<SocketConnection['onAudio']>(() => vi.fn()),
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
it('sends chunks serially and immediately discards capture on Stop', async () => {
  const { voice, connection, status } = setup();
  await voice.start();
  mocks.chunk(new Uint8Array(1920));
  mocks.stop.mockImplementationOnce(async () => {
    mocks.chunk(new Uint8Array(128));
  });
  await voice.stop();
  expect(
    connection.sendAudio.mock.calls.map(([chunk]) => chunk.sequence),
  ).toEqual([0]);
  expect(connection.stopAudio).toHaveBeenCalledTimes(1);
  expect(status).toHaveBeenLastCalledWith({ state: 'idle', chunksSent: 0 });
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

it('discards pre-ready microphone audio without overflowing the queue', async () => {
  const { voice, connection, status } = setup();
  let ready: () => void = () => undefined;
  connection.startAudio.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  const starting = voice.start();
  await Promise.resolve();
  for (let i = 0; i < 50; i++) mocks.chunk(new Uint8Array(1920));
  expect(connection.sendAudio).not.toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith({ state: 'connecting voice' });
  ready();
  await starting;
  mocks.chunk(new Uint8Array(2));
  await vi.waitFor(() => expect(connection.sendAudio).toHaveBeenCalledOnce());
  expect(connection.sendAudio.mock.calls[0][0].sequence).toBe(0);
  voice.dispose();
});

it('releases capture on asynchronous provider failure and ignores late speech after Stop', async () => {
  const { voice, connection, status } = setup();
  await voice.start();
  const listener = connection.onAudio.mock.calls[0][0];
  listener({
    type: 'error',
    error: { code: 'VOICE_UNAVAILABLE', message: 'Try Start again.' },
  });
  expect(mocks.dispose).toHaveBeenCalled();
  expect(mocks.playbackClear).toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith({
    state: 'error',
    error: 'Try Start again.',
  });
  await voice.start();
  await voice.stop();
  mocks.playbackHandle.mockClear();
  listener({
    type: 'start',
    stream: {
      streamId: 'late',
      format: { encoding: 'pcm16le', sampleRate: 24000, channels: 1 },
    },
  });
  expect(mocks.playbackHandle).not.toHaveBeenCalled();
  expect(connection.stopAudio).toHaveBeenLastCalledWith(
    expect.any(String),
    true,
  );
  voice.dispose();
});
