import type { AudioOutputEvent } from '@living-community-assistant/types';
import { AUDIO_FORMAT } from './format';

export class AudioPlayback {
  private disposed = false;
  private context?: AudioContext;
  private streamId?: string;
  private sequence = 0;
  private nextTime = 0;
  private accepting = false;
  private sources = new Set<AudioBufferSourceNode>();
  constructor(private issue: (message?: string) => void) {}
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
    if (this.disposed) return;
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
