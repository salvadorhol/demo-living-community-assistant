import type { Socket } from 'socket.io';
import type {
  AudioOutputEvent,
  TranscriptUpdate,
  AudioPlaybackProgress,
  AudioAck,
  ClientToServerEvents,
  ServerToClientEvents,
} from '@living-community-assistant/types';
import { SavedCall } from './call.ts';
import type { CallStore } from './call-store.ts';
import { validFormat } from './audio.ts';

export interface VoiceAgent {
  initialize(): Promise<void>;
  beginInput(): void;
  write(data: Uint8Array): void;
  pause(): void;
  progress(value: AudioPlaybackProgress): void;
  dispose(): void;
  finish?(): Promise<void>;
}
export interface VoiceAgentFactory {
  kind: 'conversation';
  create(context: {
    uid: string;
    transcript?(event: TranscriptUpdate): void;
    turnEnded?(): void;
    degraded?(): void;
    metadata?(info: Record<string, string>): void;
    output(event: AudioOutputEvent): void;
  }): VoiceAgent;
}
type VoiceSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  { uid: string }
>;

/** Own one conversation per socket; room membership never routes private audio. */
export function attachConversation(
  socket: VoiceSocket,
  factory: VoiceAgentFactory,
  store?: CallStore,
  maxCallMs = 60 * 60 * 1000,
  roomId = socket.data.uid,
  authentication: Record<string, unknown> = {},
) {
  let agent: VoiceAgent | undefined;
  let generation = 0;
  let call: SavedCall | undefined;
  let ending: Promise<void> | undefined;
  let limit: ReturnType<typeof setTimeout> | undefined;
  let initializing = false;
  let closed = false;
  let lastCallId: string | undefined;
  const retained = new Map<string, SavedCall>();
  async function end(reason: string) {
    if (ending) return ending;
    const current = call;
    if (!current) return;
    clearTimeout(limit);
    current.ending();
    lastCallId = current.id;
    input = undefined;
    const old = agent;
    ending = (async () => {
      try {
        old?.pause();
      } catch {
        /* A failed provider can still have a recording. */
      }
      try {
        await old?.finish?.();
      } catch {
        current.degraded();
      }
      dispose();
      call = undefined;
      await current.finish(reason);
      if (current.state === 'failed') retained.set(current.id, current);
    })().finally(() => {
      ending = undefined;
    });
    return ending;
  }
  function command(id: unknown) {
    return typeof id === 'string' && id.length <= 128;
  }
  socket.on('call:end', (value, ack) => {
    if (typeof ack !== 'function') return;
    if (
      !command(value?.callId) ||
      (call?.id !== value.callId &&
        lastCallId !== value.callId &&
        !retained.has(value.callId))
    ) {
      ack({ ok: false, code: 'INVALID_STREAM', message: 'No matching call.' });
      return;
    }
    ack({ ok: true });
    if (call?.id === value.callId) void end('ended');
  });
  socket.on('call:retry', async (value, ack) => {
    if (typeof ack !== 'function') return;
    const current = command(value?.callId)
      ? retained.get(value.callId)
      : undefined;
    if (!current || current.uid !== socket.data.uid) {
      ack({
        ok: false,
        code: 'INVALID_STREAM',
        message: 'No matching failed call.',
      });
      return;
    }
    ack({ ok: true });
    await current.finish('ended');
    if (current.state === 'saved') retained.delete(current.id);
  });
  let input: { id: string; sequence: number; ready: boolean } | undefined;
  const failed = (): AudioAck => ({
    ok: false,
    code: 'AUDIO_FAILED',
    message:
      'Voice unavailable. Check server configuration and try Start again.',
  });
  function dispose() {
    generation++;
    input = undefined;
    const old = agent;
    agent = undefined;
    old?.dispose();
  }
  function output(event: AudioOutputEvent, owner: number) {
    if (owner !== generation) return;
    if (event.type === 'clear') call?.recording.clear(event.streamId);
    if (!socket.connected) return;
    switch (event.type) {
      case 'start':
        socket.emit('audio:output:start', event.stream);
        break;
      case 'chunk':
        call?.recording.append(event.chunk.streamId, event.chunk.data);
        socket.emit('audio:output:chunk', event.chunk);
        break;
      case 'end':
        socket.emit('audio:output:end', { streamId: event.streamId });
        break;
      case 'clear':
        call?.recording.clear(event.streamId);
        socket.emit('audio:output:clear', { streamId: event.streamId });
        break;
      case 'error':
        socket.emit('voice:session:error', event.error);
        void end('provider_error');
        break;
    }
  }
  socket.on('audio:input:start', async (value, ack) => {
    if (typeof ack !== 'function') return;
    if (
      !value ||
      typeof value.streamId !== 'string' ||
      !value.streamId.length ||
      value.streamId.length > 128 ||
      !validFormat(value.format)
    ) {
      ack({
        ok: false,
        code: 'INVALID_AUDIO',
        message: 'Expected mono PCM16 at 24 kHz.',
      });
      return;
    }
    if (
      closed ||
      !socket.connected ||
      input ||
      ending ||
      initializing ||
      retained.size >= 3
    ) {
      ack({
        ok: false,
        code: 'BUSY',
        message: 'An input stream is already active.',
      });
      return;
    }
    const run = { id: value.streamId, sequence: 0, ready: false };
    input = run;
    initializing = true;
    try {
      if (!agent) {
        const owner = ++generation;
        const current = new SavedCall(
          socket.data.uid,
          store,
          (status) => {
            if (socket.connected) socket.emit('call:status', status);
          },
          (update) => {
            if (socket.connected) socket.emit('transcript:update', update);
          },
        );
        call = current;
        await current.start(roomId, authentication);
        if (input !== run || !socket.connected || ending) {
          await end('cancelled');
          ack(failed());
          return;
        }
        limit = setTimeout(() => {
          socket.emit('voice:session:error', {
            code: 'VOICE_UNAVAILABLE',
            message: 'Call duration limit reached.',
          });
          void end('duration_limit');
        }, maxCallMs);
        limit.unref();
        agent = factory.create({
          uid: socket.data.uid,
          transcript: (value) => {
            if (owner === generation) current.update(value);
          },
          degraded: () => current.degraded(),
          metadata: (info) => current.metadata(info),
          output: (event) => output(event, owner),
        });
      }
      const session = agent;
      await session.initialize();
      if (input !== run || agent !== session || !socket.connected) {
        ack({
          ok: false,
          code: 'INVALID_STREAM',
          message: 'Voice start cancelled.',
        });
        return;
      }
      session.beginInput();
      run.ready = true;
      call?.pause(false);
      ack({ ok: true });
    } catch {
      if (input === run) await end('start_failed');
      ack(failed());
    } finally {
      initializing = false;
    }
  });
  socket.on('audio:input:chunk', (value, ack) => {
    if (typeof ack !== 'function') return;
    if (!input?.ready || !value || value.streamId !== input.id) {
      ack({
        ok: false,
        code: 'INVALID_STREAM',
        message: 'No matching input stream.',
      });
      return;
    }
    if (
      !Number.isSafeInteger(value.sequence) ||
      value.sequence !== input.sequence ||
      !(value.data instanceof Uint8Array) ||
      !value.data.byteLength ||
      value.data.byteLength % 2 ||
      value.data.byteLength > 4800
    ) {
      ack({
        ok: false,
        code: 'INVALID_AUDIO',
        message: 'Invalid PCM chunk or sequence.',
      });
      return;
    }
    try {
      agent?.write(value.data);
      call?.recording.append(`input-${input.id}`, value.data, true);
      input.sequence++;
      ack({ ok: true });
    } catch {
      void end('provider_error');
      socket.emit('voice:session:error', {
        code: 'VOICE_UNAVAILABLE',
        message: 'Voice connection fell behind or failed. Try Start again.',
      });
      ack(failed());
    }
  });
  socket.on('audio:input:stop', (value, ack) => {
    if (typeof ack !== 'function') return;
    if (!input || value?.streamId !== input.id) {
      ack({
        ok: false,
        code: 'INVALID_STREAM',
        message: 'No matching input stream.',
      });
      return;
    }
    const ready = input.ready;
    input = undefined;
    try {
      if (ready) {
        agent?.pause();
        call?.pause(true);
      } else void end('cancelled'); // Cancel initialization rather than leaving a late connection alive.
      ack({ ok: true });
    } catch {
      void end('provider_error');
      ack(failed());
    }
  });
  socket.on('audio:playback:progress', (value) => {
    if (
      !value ||
      typeof value.streamId !== 'string' ||
      !Number.isFinite(value.playedMs) ||
      value.playedMs < 0
    )
      return;
    try {
      agent?.progress(value);
      call?.recording.progress(value.streamId, value.playedMs);
    } catch {
      void end('provider_error');
      socket.emit('voice:session:error', {
        code: 'VOICE_UNAVAILABLE',
        message: 'Voice connection failed. Try Start again.',
      });
    }
  });
  socket.once('disconnect', () => {
    void end('disconnect');
  });
  return () => {
    closed = true;
    return end('shutdown');
  };
}
