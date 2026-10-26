import {AUDIO_FORMAT} from './format';
import type {SocketConnection} from '../api/socket';
import {MicrophoneCapture} from './capture';
import {AudioPlayback} from './playback';

// PCM16 mono at 24 kHz is 48,000 bytes/second. Bound queued + unacknowledged
// audio to 500 ms, while pipelining enough 40 ms frames for hosted round trips.
const MAX_PENDING_INPUT_BYTES = 24_000;
const MAX_IN_FLIGHT_CHUNKS = 8;

export interface VoiceStatus {
  state:
    | 'idle'
    | 'requesting permission'
    | 'connecting voice'
    | 'streaming'
    | 'closing'
    | 'stopping'
    | 'error';
  error?: string;
  warning?: string;
  chunksSent?: number;
  microphoneName?: string;
}
interface ActiveInput {
  id: string;
  capture: MicrophoneCapture;
  queue: Uint8Array[];
  bytes: number;
  sequence: number;
  acknowledged: number;
  inFlight: number;
  ready: boolean;
}
export class VoiceSession {
  private closing = false;
  private warning?: string;
  private active?: ActiveInput;
  private disposed = false;
  private playback: AudioPlayback;
  private unsubscribe: () => void;
  constructor(
    private connection: SocketConnection,
    private status: (status: VoiceStatus) => void,
    private playbackIssue: (message?: string) => void
  ) {
    this.playback = new AudioPlayback(
      message => {
        playbackIssue(message);
        if (message && this.active) this.fail(this.active, new Error(message));
      },
      progress => connection.reportPlayback(progress)
    );
    this.unsubscribe = connection.onAudio(event => {
      if (event.type === 'closing') {
        this.closing = true;
        if (
          [
            'visitor_requested',
            'demo_manager_handoff',
            'prompt_injection',
            'guardrail_unavailable',
          ].includes(event.reason)
        )
          this.playback.clear();
        const input = this.active;
        this.active = undefined;
        if (input) {
          input.capture.dispose();
          input.queue = [];
        }
        this.status({
          state: 'closing',
          ...(this.warning ? {warning: this.warning} : {}),
        });
        return;
      }
      if (event.type === 'warning') {
        if (event.warning.code !== 'VOICE_OUTPUT_LIMIT') {
          this.warning = event.warning.message;
          this.playback.clear();
          this.abort();
          this.closing = true;
          this.status({state: 'closing', warning: this.warning});
          return;
        }
        if (!this.active) return;
        this.warning = event.warning.message;
        this.status({
          state: 'streaming',
          warning: this.warning,
          microphoneName: this.active.capture.microphoneName,
        });
        return;
      }
      if (event.type === 'start') this.warning = undefined;
      if (event.type === 'error') {
        if (this.active) this.fail(this.active, new Error(event.error.message));
        else {
          this.playback.clear();
          this.status({state: 'error', error: event.error.message});
        }
      } else if (
        this.active ||
        this.closing ||
        event.type === 'clear' ||
        event.type === 'end'
      )
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
        error instanceof Error ? error.message : 'Audio playback failed.'
      );
    }
  }
  async start() {
    if (this.active || this.closing || this.disposed) return;
    this.warning = undefined;
    this.status({state: 'requesting permission'});
    const input: ActiveInput = {
      id: crypto.randomUUID(),
      queue: [],
      bytes: 0,
      sequence: 0,
      acknowledged: 0,
      inFlight: 0,
      ready: false,
      capture: new MicrophoneCapture(
        data => this.enqueue(input, data),
        () =>
          this.fail(
            input,
            new Error('Microphone disconnected. Please start again.')
          )
      ),
    };
    this.active = input;
    // Both AudioContexts are resumed from the user's Start gesture.
    void this.enableAudio();
    const capture = input.capture.start().then(started => {
      if (started && this.active === input && !input.ready)
        this.status({
          state: 'connecting voice',
          microphoneName: input.capture.microphoneName,
        });
      return started;
    });
    const server = this.connection
      .startAudio({streamId: input.id, format: AUDIO_FORMAT})
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
        chunksSent: input.acknowledged,
        microphoneName: input.capture.microphoneName,
      });
    } catch (error) {
      this.fail(input, error);
    }
  }
  private enqueue(input: ActiveInput, data: Uint8Array) {
    if (this.active !== input || !input.ready) return;
    input.bytes += data.byteLength;
    if (input.bytes > MAX_PENDING_INPUT_BYTES) {
      this.fail(
        input,
        new Error('Audio connection fell behind. Please start again.')
      );
      return;
    }
    input.queue.push(data);
    this.pump(input);
  }
  private pump(input: ActiveInput) {
    while (
      this.active === input &&
      input.ready &&
      input.inFlight < MAX_IN_FLIGHT_CHUNKS &&
      input.queue.length
    ) {
      const data = input.queue.shift();
      if (!data) return;
      // Socket.IO preserves dispatch order. Reserve sequence numbers before
      // awaiting acknowledgements, which may arrive in a different order.
      const sequence = input.sequence++;
      input.inFlight++;
      void this.send(input, data, sequence);
    }
  }
  private async send(input: ActiveInput, data: Uint8Array, sequence: number) {
    try {
      await this.connection.sendAudio({
        streamId: input.id,
        sequence,
        data,
      });
      if (this.active !== input) return;
      input.bytes -= data.byteLength;
      input.acknowledged++;
      this.status({
        state: this.stopping ? 'stopping' : 'streaming',
        chunksSent: input.acknowledged,
        microphoneName: input.capture.microphoneName,
        ...(this.warning ? {warning: this.warning} : {}),
      });
    } catch (error) {
      this.fail(input, error);
    } finally {
      input.inFlight--;
      this.pump(input);
    }
  }
  private stopping = false;
  async stop() {
    const input = this.active;
    if (!input || this.stopping) return;
    this.stopping = true;
    this.status({state: 'stopping', chunksSent: input.acknowledged});
    this.playback.clear();
    this.active = undefined;
    input.capture.dispose();
    input.queue = [];
    try {
      await this.connection.stopAudio(input.id, true);
      if (!this.active && !this.disposed)
        this.status({state: 'idle', chunksSent: input.acknowledged});
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
  finishClosing() {
    if (!this.closing) return;
    this.closing = false;
    this.playback.clear();
    if (!this.disposed)
      this.status({
        state: 'idle',
        ...(this.warning ? {warning: this.warning} : {}),
      });
  }
  disconnect() {
    const wasActive = !!this.active || this.closing;
    this.closing = false;
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
