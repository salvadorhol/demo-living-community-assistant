import {VoiceSession} from './voice';
import type {SocketConnection} from '../api/socket';
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
    endCall: vi.fn(async () => undefined),
    retrySave: vi.fn(async () => undefined),
    stopAudio: vi.fn(async () => undefined),
    reportPlayback: vi.fn(),
    onTranscript: vi.fn(() => vi.fn()),
    onAudio: vi.fn<SocketConnection['onAudio']>(() => vi.fn()),
  });
  const status = vi.fn();
  const voice = new VoiceSession(
    connection as SocketConnection,
    status,
    vi.fn()
  );
  return {voice, connection, status};
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockResolvedValue(true);
  mocks.stop.mockResolvedValue(undefined);
});
it('sends chunks in order and immediately discards capture on Stop', async () => {
  const {voice, connection, status} = setup();
  await voice.start();
  mocks.chunk(new Uint8Array(1920));
  mocks.stop.mockImplementationOnce(async () => {
    mocks.chunk(new Uint8Array(128));
  });
  await voice.stop();
  expect(
    connection.sendAudio.mock.calls.map(([chunk]) => chunk.sequence)
  ).toEqual([0]);
  expect(connection.stopAudio).toHaveBeenCalledTimes(1);
  expect(status).toHaveBeenLastCalledWith({state: 'idle', chunksSent: 0});
  voice.dispose();
});
it('stops when input exceeds the queue budget and never replays discarded chunks', async () => {
  const {voice, connection, status} = setup();
  await voice.start();
  const finishes: (() => void)[] = [];
  connection.sendAudio.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finishes.push(resolve);
      })
  );
  for (let i = 0; i < 13; i++) mocks.chunk(new Uint8Array(1920));
  expect(status).toHaveBeenLastCalledWith({
    state: 'error',
    error: expect.stringContaining('fell behind'),
  });
  expect(mocks.dispose).toHaveBeenCalled();
  expect(connection.sendAudio).toHaveBeenCalledTimes(8);
  finishes.forEach(finish => finish());
  await Promise.resolve();
  expect(connection.sendAudio).toHaveBeenCalledTimes(8);
  voice.dispose();
});

it.each([100, 150, 250])(
  'sustains real-time capture with %i ms acknowledgement latency and jitter',
  async latency => {
    vi.useFakeTimers();
    const {voice, connection, status} = setup();
    try {
      let inFlight = 0;
      let peak = 0;
      connection.sendAudio.mockImplementation(
        ({sequence}) =>
          new Promise(resolve => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            setTimeout(
              () => {
                inFlight--;
                resolve();
              },
              latency + (sequence % 3) * 20
            );
          })
      );
      await voice.start();
      for (let i = 0; i < 125; i++) {
        mocks.chunk(new Uint8Array(1920).fill(i));
        await vi.advanceTimersByTimeAsync(40);
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(
        connection.sendAudio.mock.calls.map(([chunk]) => chunk.sequence)
      ).toEqual(Array.from({length: 125}, (_, i) => i));
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(8);
      expect(status.mock.calls.some(([value]) => value.state === 'error')).toBe(
        false
      );
      expect(status).toHaveBeenLastCalledWith(
        expect.objectContaining({state: 'streaming', chunksSent: 125})
      );
      expect(mocks.dispose).not.toHaveBeenCalled();
    } finally {
      voice.dispose();
      vi.useRealTimers();
    }
  }
);

it('bounds the flight window and preserves sequence when acknowledgements arrive out of order', async () => {
  const {voice, connection, status} = setup();
  const releases: (() => void)[] = [];
  connection.sendAudio.mockImplementation(
    () => new Promise(resolve => releases.push(resolve))
  );
  await voice.start();
  for (let i = 0; i < 10; i++) mocks.chunk(new Uint8Array(1920));
  expect(connection.sendAudio).toHaveBeenCalledTimes(8);
  releases[3]();
  await Promise.resolve();
  releases[0]();
  await Promise.resolve();
  expect(
    connection.sendAudio.mock.calls.map(([chunk]) => chunk.sequence)
  ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  releases.forEach(release => release());
  await Promise.resolve();
  expect(status).toHaveBeenLastCalledWith(
    expect.objectContaining({chunksSent: 10})
  );
  voice.dispose();
});

it.each(['stop', 'disconnect', 'dispose'] as const)(
  'discards queued audio and ignores late acknowledgements after %s',
  async action => {
    const {voice, connection, status} = setup();
    const pending: {resolve(): void; reject(error: Error): void}[] = [];
    connection.sendAudio.mockImplementation(
      () => new Promise((resolve, reject) => pending.push({resolve, reject}))
    );
    await voice.start();
    for (let i = 0; i < 10; i++) mocks.chunk(new Uint8Array(1920));
    const oldStream = connection.sendAudio.mock.calls[0][0].streamId;
    if (action === 'stop') await voice.stop();
    else if (action === 'disconnect') voice.disconnect();
    else voice.dispose();
    const previousStatus = status.mock.calls.length;
    if (action !== 'dispose') {
      connection.sendAudio.mockResolvedValue(undefined);
      await voice.start();
      mocks.chunk(new Uint8Array(1920));
      await Promise.resolve();
      expect(connection.sendAudio.mock.calls.at(-1)?.[0]).toMatchObject({
        sequence: 0,
      });
      expect(connection.sendAudio.mock.calls.at(-1)?.[0].streamId).not.toBe(
        oldStream
      );
    }
    const beforeLate = status.mock.calls.length;
    pending[0].reject(new Error('old timeout'));
    pending.slice(1).forEach(value => value.resolve());
    await Promise.resolve();
    await Promise.resolve();
    expect(
      connection.sendAudio.mock.calls.filter(
        ([chunk]) => chunk.streamId === oldStream
      )
    ).toHaveLength(8);
    expect(status.mock.calls.length).toBe(beforeLate);
    if (action === 'dispose')
      expect(status.mock.calls.length).toBe(previousStatus);
    voice.dispose();
  }
);
it('allows permission failure retry and cancels pending capture on disconnect', async () => {
  const {voice, status} = setup();
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
  const {voice, connection} = setup();
  let acknowledge!: () => void;
  connection.startAudio.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        acknowledge = resolve;
      })
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
  const {voice, connection, status} = setup();
  await voice.start();
  connection.sendAudio.mockRejectedValueOnce(new Error('timeout'));
  mocks.chunk(new Uint8Array(2));
  await vi.waitFor(() =>
    expect(status).toHaveBeenLastCalledWith({
      state: 'error',
      error: 'timeout',
    })
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
  const {voice, connection, status} = setup();
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
  const {voice, connection, status} = setup();
  let ready: () => void = () => undefined;
  connection.startAudio.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        ready = resolve;
      })
  );
  const starting = voice.start();
  await Promise.resolve();
  for (let i = 0; i < 50; i++) mocks.chunk(new Uint8Array(1920));
  expect(connection.sendAudio).not.toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith({state: 'connecting voice'});
  ready();
  await starting;
  mocks.chunk(new Uint8Array(2));
  await vi.waitFor(() => expect(connection.sendAudio).toHaveBeenCalledOnce());
  expect(connection.sendAudio.mock.calls[0][0].sequence).toBe(0);
  voice.dispose();
});

it('releases capture on asynchronous provider failure and ignores late speech after Stop', async () => {
  const {voice, connection, status} = setup();
  await voice.start();
  const listener = connection.onAudio.mock.calls[0][0];
  listener({
    type: 'error',
    error: {code: 'VOICE_UNAVAILABLE', message: 'Try Start again.'},
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
      format: {encoding: 'pcm16le', sampleRate: 24000, channels: 1},
    },
  });
  expect(mocks.playbackHandle).not.toHaveBeenCalled();
  expect(connection.stopAudio).toHaveBeenLastCalledWith(
    expect.any(String),
    true
  );
  voice.dispose();
});

it('surfaces reply limits while keeping microphone capture and input streaming active', async () => {
  const {voice, connection, status} = setup();
  await voice.start();
  const listener = connection.onAudio.mock.calls[0][0];
  listener({
    type: 'warning',
    warning: {
      code: 'VOICE_OUTPUT_LIMIT',
      message: 'Reply stopped; keep speaking.',
    },
  });
  expect(status).toHaveBeenLastCalledWith(
    expect.objectContaining({
      state: 'streaming',
      warning: 'Reply stopped; keep speaking.',
    })
  );
  expect(mocks.dispose).not.toHaveBeenCalled();
  expect(connection.stopAudio).not.toHaveBeenCalled();
  mocks.chunk(new Uint8Array(1920));
  await vi.waitFor(() => expect(connection.sendAudio).toHaveBeenCalledOnce());
  expect(status).toHaveBeenLastCalledWith(
    expect.objectContaining({warning: 'Reply stopped; keep speaking.'})
  );
  voice.dispose();
});
it('shows configuration errors and releases the microphone', async () => {
  const {voice, connection, status} = setup();
  await voice.start();
  connection.onAudio.mock.calls[0][0]({
    type: 'error',
    error: {
      code: 'VOICE_CONFIGURATION_ERROR',
      message: 'Ask the administrator to check server settings.',
    },
  });
  expect(status).toHaveBeenLastCalledWith({
    state: 'error',
    error: 'Ask the administrator to check server settings.',
  });
  expect(mocks.dispose).toHaveBeenCalled();
  voice.dispose();
});

it('releases capture for demo handoff without cutting off closing playback', async () => {
  const {voice, connection, status} = setup();
  await voice.start();
  const receive = connection.onAudio.mock.calls[0][0];
  receive({type: 'closing', callId: 'call', reason: 'demo_sales_handoff'});
  expect(mocks.dispose).toHaveBeenCalled();
  expect(mocks.playbackClear).not.toHaveBeenCalled();
  expect(connection.stopAudio).not.toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith({state: 'closing'});
  receive({
    type: 'start',
    stream: {
      streamId: 'closing-audio',
      format: {encoding: 'pcm16le', sampleRate: 24000, channels: 1},
    },
  });
  expect(mocks.playbackHandle).toHaveBeenCalledWith(
    expect.objectContaining({type: 'start'})
  );
  voice.finishClosing();
  expect(status).toHaveBeenLastCalledWith({state: 'idle'});
  voice.dispose();
});

it('clears playback and releases the microphone immediately for a visitor stop', async () => {
  const {voice, connection, status} = setup();
  await voice.start();
  connection.onAudio.mock.calls[0][0]({
    type: 'closing',
    callId: 'call',
    reason: 'visitor_requested',
  });
  expect(mocks.playbackClear).toHaveBeenCalledOnce();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(connection.stopAudio).not.toHaveBeenCalled();
  voice.finishClosing();
  expect(status).toHaveBeenLastCalledWith({state: 'idle'});
  voice.dispose();
});

it.each(['prompt_injection', 'guardrail_unavailable'] as const)(
  'retains the safety warning and stops capture/playback for %s',
  async reason => {
    const {voice, connection, status} = setup();
    await voice.start();
    const receive = connection.onAudio.mock.calls[0][0];
    receive({
      type: 'warning',
      warning: {
        code:
          reason === 'prompt_injection'
            ? 'PROMPT_INJECTION_DETECTED'
            : 'GUARDRAIL_UNAVAILABLE',
        callId: 'call',
        message: 'Safety stop',
      },
    });
    receive({type: 'closing', callId: 'call', reason});
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.playbackClear).toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith({
      state: 'closing',
      warning: 'Safety stop',
    });
    voice.finishClosing();
    expect(status).toHaveBeenLastCalledWith({
      state: 'idle',
      warning: 'Safety stop',
    });
    await voice.start();
    expect(status.mock.calls.at(-1)?.[0]).not.toHaveProperty('warning');
    voice.dispose();
  }
);

it('clears the previous reply for manager handoff, releases capture, then plays the transfer message', async () => {
  const {voice, connection, status} = setup();
  await voice.start();
  const receive = connection.onAudio.mock.calls[0][0];
  receive({type: 'closing', callId: 'call', reason: 'demo_manager_handoff'});
  expect(mocks.playbackClear).toHaveBeenCalledOnce();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(connection.stopAudio).not.toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith({state: 'closing'});
  receive({
    type: 'start',
    stream: {
      streamId: 'manager',
      format: {encoding: 'pcm16le', sampleRate: 24000, channels: 1},
    },
  });
  expect(mocks.playbackHandle).toHaveBeenCalledWith(
    expect.objectContaining({type: 'start'})
  );
  voice.finishClosing();
  expect(status).toHaveBeenLastCalledWith({state: 'idle'});
  voice.dispose();
});
