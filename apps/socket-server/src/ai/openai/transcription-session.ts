import { VOICE_LIMITS, readOpenAIKey } from '../../config.ts';
import { ConfigurationError } from '../../configuration-error.ts';
import { silentLogger } from '../../logger.ts';
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { ASSISTANT_PROFILE } from '../assistant-profile.ts';
import type { VoiceAgentFactory, TranscriptionSession } from '../contracts.ts';
import { parseEvent, type ConnectOpenAI } from './protocol.ts';

/** Separate live ASR connection: it cannot generate assistant responses. */
export function createTranscriptionSession(
  context: Parameters<VoiceAgentFactory['create']>[0],
  key = readOpenAIKey(),
  connect: ConnectOpenAI = (url, options) => new WebSocket(url, options),
): TranscriptionSession {
  let log = (context.logger ?? silentLogger).child({
    component: 'transcription',
  });
  let failed = false;
  let socket: WebSocket | undefined;
  let disposed = false;
  let available = false;
  let pendingAudio = false;
  let bytes = 0;
  let outstanding = 0;
  let settle: (() => void) | undefined;
  let rejectSetup: ((error: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const text = new Map<string, string>();
  const fail = (err: unknown = new Error('Transcription unavailable')) => {
    if (disposed || failed) return;
    failed = true;
    log.warn(
      {
        event:
          err instanceof ConfigurationError
            ? 'transcription.configuration_failed'
            : 'transcription.degraded',
        err,
      },
      'Live transcription unavailable; voice continues',
    );
    available = false;
    context.degraded?.();
    rejectSetup?.(new Error('Transcription unavailable.'));
    rejectSetup = undefined;
    clearTimeout(timer);
    socket?.terminate();
    settle?.();
  };
  function send(event: object) {
    if (!available || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > VOICE_LIMITS.maxQueuedBytes) {
      fail(new Error('Transcription input backlog exceeded'));
      return;
    }
    socket.send(JSON.stringify(event), (error) => {
      if (error) fail(error);
    });
  }
  function commit() {
    if (!pendingAudio || !available) return;
    // Very short buffers cannot be committed by the provider.
    if (bytes < 4800)
      send({
        type: 'input_audio_buffer.append',
        audio: Buffer.alloc(4800 - bytes).toString('base64'),
      });
    outstanding++;
    send({ type: 'input_audio_buffer.commit' });
    pendingAudio = false;
    bytes = 0;
  }
  return {
    async initialize() {
      if (socket || disposed) return;
      await new Promise<void>((resolve, reject) => {
        rejectSetup = reject;
        socket = connect(
          'wss://api.openai.com/v1/realtime?intent=transcription',
          {
            headers: {
              Authorization: `Bearer ${key}`,
              'OpenAI-Safety-Identifier': createHash('sha256')
                .update(context.uid)
                .digest('hex'),
            },
          },
        );
        timer = setTimeout(
          () => fail(new Error('Transcription initialization timed out')),
          VOICE_LIMITS.setupTimeoutMs,
        );
        socket.on('error', fail);
        socket.on('close', (code) => {
          if (!failed)
            fail(
              Object.assign(new Error('Transcription upstream closed'), {
                code: String(code),
              }),
            );
        });
        socket.on('open', () => {
          if (disposed) return;
          available = true;
          send({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: 24000 },
                  transcription: {
                    model: ASSISTANT_PROFILE.transcriptionModel,
                    delay: 'low',
                  },
                  turn_detection: null,
                },
              },
            },
          });
        });
        socket.on('message', (data) => {
          if (disposed || !available) return;
          try {
            const event = parseEvent(data);
            if (
              event.type === 'session.created' &&
              typeof event.session?.id === 'string'
            ) {
              log = log.child({ transcriptionSessionId: event.session.id });
              context.metadata?.({
                transcriptionSessionId: event.session.id,
              });
            }
            if (event.type === 'session.updated') {
              clearTimeout(timer);
              rejectSetup = undefined;
              resolve();
            } else if (
              event.type === 'error' ||
              event.type ===
                'conversation.item.input_audio_transcription.failed'
            ) {
              if (event.error?.type === 'invalid_request_error') {
                log.warn(
                  {
                    event: 'transcription.configuration_rejected',
                    providerCode: event.error?.code,
                    parameter: event.error?.param,
                  },
                  'OpenAI rejected transcription settings',
                );
                fail(
                  new ConfigurationError(
                    'OpenAI rejected transcription settings. Check the transcription model and audio configuration.',
                  ),
                );
              } else
                fail(
                  Object.assign(
                    new Error('Transcription provider rejected a command'),
                    {
                      code:
                        typeof event.error?.code === 'string'
                          ? event.error.code
                          : undefined,
                    },
                  ),
                );
            } else if (
              event.type ===
                'conversation.item.input_audio_transcription.delta' ||
              event.type ===
                'conversation.item.input_audio_transcription.completed'
            ) {
              if (
                typeof event.item_id !== 'string' ||
                !Number.isSafeInteger(event.content_index)
              )
                return;
              const id = `user-${event.item_id}-${event.content_index}`;
              const final = event.type.endsWith('.completed');
              const value = final
                ? event.transcript
                : (text.get(id) ?? '') + event.delta;
              if (typeof value !== 'string' || value.length > 100_000) {
                fail();
                return;
              }
              text.set(id, value);
              context.transcript?.({
                id,
                providerItemId: event.item_id,
                source: 'transcription',
                role: 'user',
                text: value,
                isFinal: final,
              });
              if (final) {
                text.delete(id);
                outstanding = Math.max(0, outstanding - 1);
                if (!outstanding) settle?.();
              }
            }
          } catch (err) {
            fail(err);
          }
        });
      }).catch((err) => fail(err));
    },
    write(data) {
      pendingAudio = true;
      bytes += data.length;
      send({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(data).toString('base64'),
      });
    },
    commit,
    async finish() {
      commit();
      if (available && outstanding)
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            log.warn(
              { event: 'transcription.finish_timeout', outstanding },
              'Transcription finalization timed out',
            );
            context.degraded?.();
            resolve();
          }, 1500);
          settle = () => {
            clearTimeout(timeout);
            resolve();
          };
        });
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      rejectSetup?.(new Error('Transcription closed.'));
      rejectSetup = undefined;
      settle?.();
      available = false;
      socket?.terminate();
    },
  };
}
