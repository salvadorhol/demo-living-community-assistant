import { MicrophoneCapture } from './capture';
const contexts: Context[] = [];
const nodes: Node[] = [];
const track = {
  stop: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};
const media = { getTracks: () => [track], getAudioTracks: () => [track] };
const getUserMedia = vi.fn();
class Context {
  state = 'running';
  destination = {};
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  source = {
    connect: vi.fn(() => nodes[nodes.length - 1]),
    disconnect: vi.fn(),
  };
  createMediaStreamSource() {
    return this.source;
  }
  constructor() {
    contexts.push(this);
  }
}
class Node {
  port = {
    onmessage: undefined as
      | undefined
      | ((event: { data: { type: string; data?: Uint8Array } }) => void),
    close: vi.fn(),
    postMessage: vi.fn(() => {
      this.port.onmessage?.({
        data: { type: 'chunk', data: new Uint8Array(2) },
      });
      this.port.onmessage?.({ data: { type: 'stopped' } });
    }),
  };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    nodes.push(this);
  }
}
beforeEach(() => {
  contexts.length = 0;
  nodes.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', Node);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  getUserMedia.mockResolvedValue(media);
});
afterEach(() => vi.unstubAllGlobals());
it('flushes the final frame and releases tracks, graph, port, and context on Stop', async () => {
  const chunk = vi.fn();
  const capture = new MicrophoneCapture(chunk, vi.fn());
  expect(await capture.start()).toBe(true);
  await capture.stop();
  expect(chunk).toHaveBeenCalledWith(new Uint8Array(2));
  expect(track.stop).toHaveBeenCalled();
  expect(nodes[nodes.length - 1].disconnect).toHaveBeenCalled();
  expect(nodes[nodes.length - 1].port.close).toHaveBeenCalled();
  expect(contexts[contexts.length - 1].close).toHaveBeenCalled();
});
it('releases a microphone permission grant that resolves after cancellation', async () => {
  let allow!: (value: typeof media) => void;
  getUserMedia.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  const capture = new MicrophoneCapture(vi.fn(), vi.fn());
  const starting = capture.start();
  capture.dispose();
  allow(media);
  expect(await starting).toBe(false);
  expect(track.stop).toHaveBeenCalled();
  expect(
    contexts[contexts.length - 1].audioWorklet.addModule,
  ).not.toHaveBeenCalled();
});
it('reports permission failure and closes the audio context', async () => {
  getUserMedia.mockRejectedValueOnce(new Error('Permission denied'));
  const capture = new MicrophoneCapture(vi.fn(), vi.fn());
  await expect(capture.start()).rejects.toThrow('Permission denied');
  expect(contexts[contexts.length - 1].close).toHaveBeenCalled();
});
it('registers device loss handling and removes it during disposal', async () => {
  const lost = vi.fn();
  const capture = new MicrophoneCapture(vi.fn(), lost);
  await capture.start();
  expect(track.addEventListener).toHaveBeenCalledWith('ended', lost);
  capture.dispose();
  expect(track.removeEventListener).toHaveBeenCalledWith('ended', lost);
});

it('falls back to a native-rate context when a device rejects 24 kHz', async () => {
  class NativeContext extends Context {
    constructor(options?: AudioContextOptions) {
      if (options?.sampleRate) throw new Error('Unsupported sample rate');
      super();
    }
  }
  vi.stubGlobal('AudioContext', NativeContext);
  const capture = new MicrophoneCapture(vi.fn(), vi.fn());
  expect(await capture.start()).toBe(true);
  capture.dispose();
});
