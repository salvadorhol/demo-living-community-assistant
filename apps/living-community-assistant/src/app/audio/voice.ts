import { AUDIO_FORMAT } from './format';
import type { SocketConnection } from '../api/socket';
import { MicrophoneCapture } from './capture';
import { AudioPlayback } from './playback';

export interface VoiceStatus {
  state:
    | 'idle'
    | 'requesting permission'
    | 'connecting voice'
    | 'streaming'
    | 'stopping'
    | 'error';
  error?: string;
  chunksSent?: number;
  microphoneName?: string;
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
    this.playback = new AudioPlayback(
      (message) => {
        playbackIssue(message);
        if (message && this.active) this.fail(this.active, new Error(message));
      },
      (progress) => connection.reportPlayback(progress),
    );
    this.unsubscribe = connection.onAudio((event) => {
      if (event.type === 'error') {
        if (this.active) this.fail(this.active, new Error(event.error.message));
        else {
          this.playback.clear();
          this.status({ state: 'error', error: event.error.message });
        }
      } else if (this.active || event.type === 'clear' || event.type === 'end')
        this.playback.handle(event);
    });
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
    const capture = input.capture.start().then((started) => {
      if (started && this.active === input && !input.ready)
        this.status({
          state: 'connecting voice',
          microphoneName: input.capture.microphoneName,
        });
      return started;
    });
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
      this.status({
        state: 'streaming',
        chunksSent: input.sequence,
        microphoneName: input.capture.microphoneName,
      });
    } catch (error) {
      this.fail(input, error);
    }
  }
  private enqueue(input: ActiveInput, data: Uint8Array) {
    if (this.active !== input || !input.ready) return;
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
        microphoneName: input.capture.microphoneName,
      });
    }
  }
  private stopping = false;
  async stop() {
    const input = this.active;
    if (!input || this.stopping) return;
    this.stopping = true;
    this.status({ state: 'stopping', chunksSent: input.sequence });
    this.playback.clear();
    this.active = undefined;
    input.capture.dispose();
    input.queue = [];
    try {
      await this.connection.stopAudio(input.id, true);
      if (!this.active && !this.disposed)
        this.status({ state: 'idle', chunksSent: input.sequence });
    } catch (error) {
      if (!this.active && !this.disposed)
        this.status({
          state: 'error',
          error:
            error instanceof Error ? error.message : 'Voice could not stop.',
        });
    } finally {
      this.stopping = false;
    }
  }
  async end() {
    // Stop capture/playback before asking the backend to finalize.
    await this.stop();
    await this.connection.endCall();
  }
  async retrySave() {
    await this.connection.retrySave();
  }
  private fail(input: ActiveInput, error: unknown) {
    if (this.active !== input) return;
    this.abort();
    this.playback.clear();
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
