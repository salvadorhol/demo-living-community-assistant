import type { Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  AudioAck,
} from '@living-community-assistant/types';
import type { VoiceAgentFactory } from '../ai/contracts.ts';
import type { CallStore } from '../calls/call-store.ts';
import { silentLogger, type AppLogger } from '../logger.ts';
import { createConversationSession } from '../conversation/session.ts';
import type { TranscriptObserverFactory } from '../conversation/transcript-observer.ts';
import { validFormat } from './audio.ts';

type VoiceSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  { uid: string }
>;
const validId = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && id.length <= 128;
const invalid = (
  message: string,
  code: 'INVALID_AUDIO' | 'INVALID_STREAM' = 'INVALID_AUDIO',
): AudioAck => ({ ok: false, code, message });
/** Translate untrusted wire commands into a transport-independent conversation. */
export function attachConversation(
  socket: VoiceSocket,
  factory: VoiceAgentFactory,
  store?: CallStore,
  maxCallMs?: number,
  roomId = socket.data.uid,
  authentication: Record<string, unknown> = {},
  logger: AppLogger = silentLogger,
  observerFactory?: TranscriptObserverFactory,
) {
  const session = createConversationSession({
    uid: socket.data.uid,
    roomId,
    authentication,
    factory,
    store,
    maxCallMs,
    logger,
    observerFactory,
    events: {
      status: (value) => {
        if (socket.connected) socket.emit('call:status', value);
      },
      transcript: (value) => {
        if (socket.connected) socket.emit('transcript:update', value);
      },
      output(event) {
        if (!socket.connected) return;
        switch (event.type) {
          case 'start':
            socket.emit('audio:output:start', event.stream);
            break;
          case 'chunk':
            socket.emit('audio:output:chunk', event.chunk);
            break;
          case 'end':
            socket.emit('audio:output:end', { streamId: event.streamId });
            break;
          case 'clear':
            socket.emit('audio:output:clear', { streamId: event.streamId });
            break;
          case 'error':
            socket.emit('voice:session:error', event.error);
            break;
          case 'warning':
            socket.emit('voice:session:warning', event.warning);
            break;
        }
      },
    },
  });
  socket.on('audio:input:start', (value, ack) => {
    if (typeof ack !== 'function') return;
    if (!validId(value?.streamId) || !validFormat(value?.format))
      return ack(invalid('Expected mono PCM16 at 24 kHz.'));
    void session
      .start(value)
      .then(ack)
      .catch((err) => {
        logger.error(
          { event: 'conversation.command_failed', err },
          'Start command failed',
        );
        ack({
          ok: false,
          code: 'AUDIO_FAILED',
          message: 'Voice could not start. Please try again.',
        });
      });
  });
  socket.on('audio:input:chunk', (value, ack) => {
    if (typeof ack !== 'function') return;
    if (!validId(value?.streamId))
      return ack(invalid('No matching input stream.', 'INVALID_STREAM'));
    if (
      !Number.isSafeInteger(value.sequence) ||
      !(value.data instanceof Uint8Array) ||
      !value.data.byteLength ||
      value.data.byteLength % 2 ||
      value.data.byteLength > 4800
    )
      return ack(invalid('Invalid PCM chunk or sequence.'));
    ack(session.write(value));
  });
  socket.on('audio:input:stop', (value, ack) => {
    if (typeof ack !== 'function') return;
    ack(
      validId(value?.streamId)
        ? session.pause(value)
        : invalid('No matching input stream.', 'INVALID_STREAM'),
    );
  });
  socket.on('audio:playback:progress', (value) => {
    if (
      validId(value?.streamId) &&
      Number.isFinite(value.playedMs) &&
      value.playedMs >= 0
    )
      session.progress(value);
  });
  socket.on('call:end', (value, ack) => {
    if (typeof ack === 'function')
      ack(
        validId(value?.callId)
          ? session.end(value.callId)
          : invalid('No matching call.', 'INVALID_STREAM'),
      );
  });
  socket.on('call:retry', (value, ack) => {
    if (typeof ack === 'function')
      ack(
        validId(value?.callId)
          ? session.retrySave(value.callId)
          : invalid('No matching failed call.', 'INVALID_STREAM'),
      );
  });
  // One owner finalizes a disconnect; server shutdown owns session.close().
  socket.once('disconnect', () => {
    void session
      .disconnect()
      .catch((err) =>
        logger.error(
          { event: 'call.finalization_failed', err },
          'Disconnect finalization failed',
        ),
      );
  });
  return () => session.close();
}
