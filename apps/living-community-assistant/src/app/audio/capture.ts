import workletUrl from './capture.worklet.ts?worker&url';

export function microphoneSupported() {
  return (
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export class MicrophoneCapture {
  private cancelled = false;
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private stopped?: () => void;
  constructor(
    private chunk: (data: Uint8Array) => void,
    private lost: () => void,
  ) {}
  async start() {
    if (!microphoneSupported())
      throw new Error(
        'Microphone streaming requires Web Audio and microphone access on HTTPS or localhost.',
      );
    try {
      this.context = new AudioContext({ sampleRate: 24000 });
    } catch {
      // Some devices only support their native rate; the worklet resamples it.
      this.context = new AudioContext();
    }
    const resumed = this.context.resume().then(
      () => true,
      () => false,
    );
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (this.cancelled) {
        this.dispose();
        return false;
      }
      if (!(await resumed))
        throw new Error('Microphone audio could not start. Please retry.');
      await this.context.audioWorklet.addModule(workletUrl);
      if (this.cancelled) return false;
      this.source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, 'pcm-capture');
      this.node.port.onmessage = ({ data }) => {
        if (data.type === 'stopped') this.stopped?.();
        else if (!this.cancelled && data.type === 'chunk')
          this.chunk(data.data);
      };
      this.node.onprocessorerror = () => this.lost();
      this.stream
        .getAudioTracks()
        .forEach((track) => track.addEventListener('ended', this.lost));
      // The processor emits silence; connecting it keeps the capture graph rendering.
      this.source.connect(this.node).connect(this.context.destination);
      return true;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  async stop() {
    if (!this.node) {
      this.dispose();
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Microphone could not stop.')),
          2000,
        );
        this.stopped = () => {
          clearTimeout(timeout);
          resolve();
        };
        this.node?.port.postMessage({ type: 'stop' });
      });
    } finally {
      this.dispose();
    }
  }
  dispose() {
    this.cancelled = true;
    this.stopped?.();
    this.stopped = undefined;
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => {
      track.removeEventListener('ended', this.lost);
      track.stop();
    });
    if (this.context && this.context.state !== 'closed')
      void this.context.close().catch(() => undefined);
  }
}
