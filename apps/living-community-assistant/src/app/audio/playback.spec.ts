import { AudioPlayback } from './playback';
import { AUDIO_FORMAT } from './format';
const sources: {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onended?: () => void;
}[] = [];
const contexts: Context[] = [];
class Context {
  constructor() {
    contexts.push(this);
  }
  state = 'suspended';
  currentTime = 1;
  destination = {};
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createBuffer = vi.fn((_channels, count: number) => ({
    getChannelData: () => new Float32Array(count),
  }));
  createBufferSource() {
    const source = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      buffer: undefined,
    };
    sources.push(source);
    return source;
  }
}
beforeEach(() => {
  sources.length = 0;
  vi.stubGlobal('AudioContext', Context);
});
afterEach(() => vi.unstubAllGlobals());
const start = {
  type: 'start',
  stream: { streamId: 'output', format: AUDIO_FORMAT },
} as const;
const chunk = (sequence = 0) =>
  ({
    type: 'chunk',
    chunk: { streamId: 'output', sequence, data: new Uint8Array(1920) },
  }) as const;
it('schedules contiguous output, ignores stale streams, and clears scheduled sound', async () => {
  const issue = vi.fn();
  const playback = new AudioPlayback(issue);
  await playback.enable();
  playback.handle(start);
  playback.handle(chunk());
  playback.handle(chunk(1));
  expect(sources[0].start).toHaveBeenCalledWith(1);
  expect(sources[1].start).toHaveBeenCalledWith(1.04);
  playback.handle({
    type: 'chunk',
    chunk: { ...chunk(2).chunk, streamId: 'stale' },
  });
  expect(sources).toHaveLength(2);
  playback.handle({ type: 'clear', streamId: 'output' });
  expect(sources[0].stop).toHaveBeenCalled();
  playback.handle(chunk(2));
  expect(sources).toHaveLength(2);
  playback.dispose();
});
it('requires user activation without retaining blocked audio', () => {
  const issue = vi.fn();
  const playback = new AudioPlayback(issue);
  playback.handle(start);
  playback.handle(chunk());
  expect(issue).toHaveBeenCalledWith('Select Enable audio to allow playback.');
  expect(sources).toHaveLength(0);
  playback.dispose();
});
it('bounds playback backlog and rejects out of order output', async () => {
  const issue = vi.fn();
  const playback = new AudioPlayback(issue);
  await playback.enable();
  playback.handle(start);
  for (let i = 0; i < 51; i++) playback.handle(chunk(i));
  expect(issue).toHaveBeenCalledWith(expect.stringContaining('fell behind'));
  playback.handle(start);
  playback.handle(chunk(2));
  expect(issue).toHaveBeenLastCalledWith('Invalid output audio chunk.');
  playback.dispose();
});
it('does not accept chunks after completion', async () => {
  const playback = new AudioPlayback(vi.fn());
  await playback.enable();
  playback.handle(start);
  playback.handle(chunk());
  playback.handle({ type: 'end', streamId: 'output' });
  playback.handle(chunk(1));
  expect(sources).toHaveLength(1);
  playback.dispose();
});

it('reports actual played time and final position when clearing queued audio', async () => {
  const progress = vi.fn();
  const playback = new AudioPlayback(vi.fn(), progress);
  await playback.enable();
  playback.handle(start);
  playback.handle(chunk());
  playback.handle(chunk(1));
  const context = contexts.at(-1);
  if (!context) throw new Error('Missing audio context');
  context.currentTime = 1.02;
  playback.clear();
  expect(progress).toHaveBeenLastCalledWith({
    streamId: 'output',
    playedMs: 20,
    cleared: true,
  });
  expect(sources.every((source) => source.stop.mock.calls.length === 1)).toBe(
    true,
  );
  playback.dispose();
});
