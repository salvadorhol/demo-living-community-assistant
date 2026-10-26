import type {
  AudioOutputEvent,
  AudioPlaybackProgress,
} from '@living-community-assistant/types';
import { AUDIO_FORMAT } from './format';

export class AudioPlayback {
  private disposed = false;
  private context?: AudioContext;
  private streamId?: string;
  private sequence = 0;
  private nextTime = 0;
  private accepting = false;
  private sources = new Set<AudioBufferSourceNode>();
  private progressTimer?: ReturnType<typeof setInterval>;
  private segments: { start: number; duration: number }[] = [];
  constructor(
    private issue: (message?: string) => void,
    private progress: (value: AudioPlaybackProgress) => void = () => undefined,
  ) {}
  private report(cleared = false) {
    if (!this.streamId) return;
    const time = this.context?.currentTime ?? 0;
    const played = this.segments.reduce(
      (total, segment) =>
        total + Math.max(0, Math.min(segment.duration, time - segment.start)),
      0,
    );
    this.progress({
      streamId: this.streamId,
      playedMs: Math.floor(played * 1000),
      cleared,
    });
    if (!this.accepting && time >= this.nextTime) {
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }
  }
  async enable() {
    if (this.disposed) return;
    if (typeof AudioContext === 'undefined')
      throw new Error('Audio playback is unsupported in this browser.');
    this.context ??= new AudioContext();
    await this.context.resume();
    if (this.disposed) return;
    if (this.context.state !== 'running')
      throw new Error('Select Enable audio to allow playback.');
    this.issue(undefined);
  }
  handle(event: AudioOutputEvent) {
    if (
      this.disposed ||
      event.type === 'error' ||
      event.type === 'warning' ||
      event.type === 'closing'
    )
      return;
    try {
      if (event.type === 'start') {
        this.clear();
        if (
          !event.stream ||
          typeof event.stream.streamId !== 'string' ||
          !event.stream.streamId ||
          event.stream.format?.encoding !== AUDIO_FORMAT.encoding ||
          event.stream.format.sampleRate !== 24000 ||
          event.stream.format.channels !== 1
        ) {
          throw new Error('Unsupported output audio format.');
        }
        this.streamId = event.stream.streamId;
        this.sequence = 0;
        this.accepting = true;
        this.progressTimer = setInterval(() => this.report(), 100);
        return;
      }
      const id =
        event.type === 'chunk' ? event.chunk?.streamId : event.streamId;
      if (!this.streamId || id !== this.streamId) return;
      if (event.type === 'clear') {
        this.clear();
        return;
      }
      if (event.type === 'end') {
        this.accepting = false;
        return;
      }
      if (!this.accepting) return;
      const chunk = event.chunk;
      const raw: unknown = chunk.data;
      const data = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
      if (
        chunk.sequence !== this.sequence ||
        !(data instanceof Uint8Array) ||
        !data.byteLength ||
        data.byteLength % 2 ||
        data.byteLength > 4800
      ) {
        throw new Error('Invalid output audio chunk.');
      }
      this.sequence++;
      const context = this.context;
      if (!context || context.state !== 'running') {
        this.issue('Select Enable audio to allow playback.');
        return;
      }
      const duration = data.byteLength / 48000;
      const start = Math.max(context.currentTime, this.nextTime);
      if (start - context.currentTime + duration > 2)
        throw new Error('Audio playback fell behind. Please start again.');
      const buffer = context.createBuffer(1, data.byteLength / 2, 24000);
      const samples = buffer.getChannelData(0);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let i = 0; i < samples.length; i++)
        samples[i] = view.getInt16(i * 2, true) / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        source.disconnect();
        this.sources.delete(source);
      };
      this.sources.add(source);
      this.segments.push({ start, duration });
      source.start(start);
      this.nextTime = start + duration;
    } catch (error) {
      this.clear();
      this.issue(
        error instanceof Error ? error.message : 'Audio playback failed.',
      );
    }
  }
  clear() {
    this.report(true);
    clearInterval(this.progressTimer);
    this.progressTimer = undefined;
    this.segments = [];
    this.sources.forEach((source) => {
      source.stop();
      source.disconnect();
    });
    this.sources.clear();
    this.streamId = undefined;
    this.accepting = false;
    this.nextTime = 0;
  }
  dispose() {
    this.disposed = true;
    this.clear();
    if (this.context && this.context.state !== 'closed')
      void this.context.close().catch(() => undefined);
  }
}
