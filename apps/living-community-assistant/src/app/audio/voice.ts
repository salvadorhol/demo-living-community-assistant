import { AUDIO_FORMAT } from './format';
import type { SocketConnection } from '../api/socket';
import { MicrophoneCapture } from './capture';
import { AudioPlayback } from './playback';

export interface VoiceStatus {
  state: 'idle' | 'requesting permission' | 'streaming' | 'stopping' | 'error';
  error?: string;
  chunksSent?: number;
}
interface ActiveInput {
  id: string;
  capture: MicrophoneCapture;
  queue: Uint8Array[];
  bytes: number;
  sequence: number;
  ready: boolean;
  sending?: Promise<void>;
}
export class VoiceSession {
  private active?: ActiveInput;
  private disposed = false;
  private playback: AudioPlayback;
  private unsubscribe: () => void;
  constructor(
    private connection: SocketConnection,
    private status: (status: VoiceStatus) => void,
    private playbackIssue: (message?: string) => void,
  ) {
    this.playback = new AudioPlayback(playbackIssue);
    this.unsubscribe = connection.onAudio((event) =>
      this.playback.handle(event),
    );
  }
  async enableAudio() {
    if (this.disposed) return;
    try {
      await this.playback.enable();
    } catch (error) {
      if (this.disposed) return;
      this.playbackIssue(
        error instanceof Error ? error.message : 'Audio playback failed.',
      );
    }
  }
  async start() {
    if (this.active || this.disposed) return;
    this.status({ state: 'requesting permission' });
    const input: ActiveInput = {
      id: crypto.randomUUID(),
      queue: [],
      bytes: 0,
      sequence: 0,
      ready: false,
      capture: new MicrophoneCapture(
        (data) => this.enqueue(input, data),
        () =>
          this.fail(
            input,
            new Error('Microphone disconnected. Please start again.'),
          ),
      ),
    };
    this.active = input;
    // Both AudioContexts are resumed from the user's Start gesture.
    void this.enableAudio();
    const capture = input.capture.start();
    const server = this.connection
      .startAudio({ streamId: input.id, format: AUDIO_FORMAT })
      .then(() => {
        if (this.active !== input) {
          void this.connection.stopAudio(input.id, true).catch(() => undefined);
          return;
        }
        input.ready = true;
        this.pump(input);
      });
    try {
      const [started] = await Promise.all([capture, server]);
      if (this.active !== input || !started) return;
      this.status({ state: 'streaming', chunksSent: input.sequence });
    } catch (error) {
      this.fail(input, error);
    }
  }
  private enqueue(input: ActiveInput, data: Uint8Array) {
    if (this.active !== input) return;
    input.bytes += data.byteLength;
    if (input.bytes > 12000) {
      this.fail(
        input,
        new Error('Audio connection fell behind. Please start again.'),
      );
      return;
    }
    input.queue.push(data);
    this.pump(input);
  }
  private pump(input: ActiveInput) {
    if (
      this.active !== input ||
      !input.ready ||
      input.sending ||
      !input.queue.length
    )
      return;
    input.sending = this.drain(input)
      .catch((error) => this.fail(input, error))
      .finally(() => {
        input.sending = undefined;
        this.pump(input);
      });
  }
  private async drain(input: ActiveInput) {
    while (this.active === input && input.queue.length) {
      const data = input.queue.shift();
      if (!data) return;
      await this.connection.sendAudio({
        streamId: input.id,
        sequence: input.sequence,
        data,
      });
      if (this.active !== input) return;
      input.bytes -= data.byteLength;
      input.sequence++;
      this.status({
        state: this.stopping ? 'stopping' : 'streaming',
        chunksSent: input.sequence,
      });
    }
  }
  private stopping = false;
  async stop() {
    const input = this.active;
    if (!input || this.stopping) return;
    if (!input.ready) {
      this.abort();
      this.status({ state: 'idle' });
      return;
    }
    this.stopping = true;
    this.status({ state: 'stopping', chunksSent: input.sequence });
    try {
      await input.capture.stop();
      while (this.active === input && (input.sending || input.queue.length)) {
        this.pump(input);
        await input.sending;
      }
      if (this.active !== input) return;
      await this.connection.stopAudio(input.id);
      if (this.active !== input) return;
      this.active = undefined;
      this.status({ state: 'idle', chunksSent: input.sequence });
    } catch (error) {
      this.fail(input, error);
    } finally {
      this.stopping = false;
    }
  }
  private fail(input: ActiveInput, error: unknown) {
    if (this.active !== input) return;
    this.abort();
    this.status({
      state: 'error',
      error:
        error instanceof Error ? error.message : 'Audio failed. Please retry.',
    });
  }
  private abort() {
    const input = this.active;
    this.active = undefined;
    this.stopping = false;
    if (!input) return;
    input.capture.dispose();
    input.queue = [];
    // A timed-out start may still have created a server session. Cancel it too.
    void this.connection.stopAudio(input.id, true).catch(() => undefined);
  }
  disconnect() {
    const wasActive = !!this.active;
    this.abort();
    this.playback.clear();
    if (wasActive && !this.disposed)
      this.status({
        state: 'error',
        error: 'Socket disconnected. Start again after reconnecting.',
      });
  }
  dispose() {
    this.disposed = true;
    this.abort();
    this.unsubscribe();
    this.playback.dispose();
  }
}
