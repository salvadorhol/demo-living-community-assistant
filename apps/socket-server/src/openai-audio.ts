import { ConfigurationError, voiceError } from './configuration-error.ts';
import { silentLogger } from './logger.ts';
import WebSocket from 'ws';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AudioPlaybackProgress,
  TranscriptUpdate,
} from '@living-community-assistant/types';
import {
  AGENT_CONFIG,
  readOpenAIKey,
  readOutputQueueMs,
} from './agent-config.ts';
import type { VoiceAgentFactory } from './conversation.ts';

const FORMAT = { encoding: 'pcm16le', sampleRate: 24000, channels: 1 } as const;
export type ConnectOpenAI = (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

/** Realtime voice transport with assistant captions and input turn boundaries. */
export function createOpenAIAudio(
  key = readOpenAIKey(),
  connect: ConnectOpenAI = (url, options) => new WebSocket(url, options),
  options: { maxOutputQueueMs?: number } = {},
): VoiceAgentFactory {
  const maxOutputQueueMs = readOutputQueueMs(options.maxOutputQueueMs);
  const maxOutputQueueBytes = maxOutputQueueMs * 48;
  return {
    kind: 'conversation',
    create({
      uid,
      output,
      transcript,
      turnEnded,
      metadata,
      logger = silentLogger,
    }) {
      let log = logger.child({ component: 'openai-voice' });
      const texts = new Map<string, TranscriptUpdate>();
      let socket: WebSocket | undefined;
      let initialization: Promise<void> | undefined;
      let rejectSetup: ((error: Error) => void) | undefined;
      let setupTimer: ReturnType<typeof setTimeout> | undefined;
      let disposed = false;
      let ready = false;
      let listening = false;
      let responseId: string | undefined;
      const cancelled = new Set<string>();
      const configurationEvents = new Set<string>();
      type Output = {
        id: string;
        itemId: string;
        contentIndex: number;
        responseId: string;
        sequence: number;
        bytes: number;
        playedMs: number;
        queue: Buffer[];
        queuedBytes: number;
        done: boolean;
        startedAt: number;
        lastQueueLog: number;
        peakQueuedBytes: number;
        highWaterLogged: boolean;
      };
      let current: Output | undefined;
      let interrupted: Output | undefined;
      let truncateTimer: ReturnType<typeof setTimeout> | undefined;
      let pumpTimer: ReturnType<typeof setInterval> | undefined;

      function send(event: object) {
        if (disposed || !socket || socket.readyState !== WebSocket.OPEN)
          throw new Error('Voice connection unavailable.');
        if (socket.bufferedAmount > AGENT_CONFIG.maxQueuedBytes)
          throw new Error('Voice input backlog exceeded.');
        let command = event;
        if ((event as { type?: string }).type === 'session.update') {
          const eventId = randomUUID();
          configurationEvents.add(eventId);
          if (configurationEvents.size > 32)
            configurationEvents.delete(
              configurationEvents.values().next().value as string,
            );
          command = { ...event, event_id: eventId };
        }
        socket.send(JSON.stringify(command), (error) => {
          if (error) fail(error);
        });
      }
      function dispose() {
        if (disposed) return;
        // Clear playback before invalidating the transport.
        if (current) output({ type: 'clear', streamId: current.id });
        disposed = true;
        listening = false;
        clearTimeout(setupTimer);
        clearTimeout(truncateTimer);
        clearInterval(pumpTimer);
        rejectSetup?.(new Error('Voice connection closed.'));
        rejectSetup = undefined;
        current = undefined;
        interrupted = undefined;
        socket?.terminate();
      }
      function fail(err: unknown = new Error('Voice provider failed')) {
        if (disposed) return;
        log.error(
          {
            event:
              err instanceof ConfigurationError
                ? 'voice.configuration_failed'
                : 'voice.provider_failed',
            err,
          },
          'Voice provider failed',
        );
        rejectSetup?.(
          err instanceof Error ? err : new Error('Voice provider failed'),
        );
        rejectSetup = undefined;
        dispose();
        output({
          type: 'error',
          error: voiceError(err),
        });
      }
      function truncate() {
        clearTimeout(truncateTimer);
        const item = interrupted;
        interrupted = undefined;
        if (!item || disposed) return;
        send({
          type: 'conversation.item.truncate',
          item_id: item.itemId,
          content_index: item.contentIndex,
          audio_end_ms: Math.floor(item.playedMs),
        });
      }
      function interrupt(cancelResponse = true) {
        log.debug(
          { event: 'voice.interrupted', responseId },
          'Assistant playback interrupted',
        );
        if (cancelResponse && responseId) {
          cancelled.add(responseId);
          send({ type: 'response.cancel', response_id: responseId });
          responseId = undefined;
        }
        if (!current) return;
        if (interrupted) truncate();
        interrupted = current;
        const id = `assistant-${current.itemId}-${current.contentIndex}`;
        const entry = texts.get(id);
        if (entry) {
          const update = { ...entry, interrupted: true, isFinal: true };
          texts.set(id, update);
          transcript?.(update);
        }
        if (cancelResponse) cancelled.add(interrupted.responseId);
        current = undefined;
        clearInterval(pumpTimer);
        pumpTimer = undefined;
        // Clear causes the browser to report its final playback position.
        output({ type: 'clear', streamId: interrupted.id });
        truncateTimer = setTimeout(() => {
          try {
            truncate();
          } catch (err) {
            fail(err);
          }
        }, 250);
      }
      function queueStats(item: Output) {
        const elapsedMs = Math.max(1, Date.now() - item.startedAt);
        return {
          responseId: item.responseId,
          queuedBytes: item.queuedBytes,
          queuedMs: Math.round(item.queuedBytes / 48),
          peakQueuedMs: Math.round(item.peakQueuedBytes / 48),
          generatedMs: Math.round(item.bytes / 48),
          deliveredMs: Math.round((item.bytes - item.queuedBytes) / 48),
          elapsedMs,
          generationRate: Math.round((item.bytes / 48 / elapsedMs) * 100) / 100,
          deliveryRate:
            Math.round(
              ((item.bytes - item.queuedBytes) / 48 / elapsedMs) * 100,
            ) / 100,
          limitMs: maxOutputQueueMs,
        };
      }
      function cancelOversizedReply(incomingBytes: number) {
        if (!current) return;
        log.warn(
          {
            event: 'voice.output_limit',
            ...queueStats(current),
            incomingBytes,
          },
          'Assistant reply exceeded output buffer; cancelling reply, keeping call active',
        );
        interrupt();
        output({
          type: 'warning',
          warning: {
            code: 'VOICE_OUTPUT_LIMIT',
            message:
              'The assistant reply was too long and was stopped. You can keep speaking or ask for a shorter answer.',
          },
        });
      }
      function pump() {
        const item = current;
        if (!item || disposed) return;
        const parts: Buffer[] = [];
        let size = 0;
        while (item.queue.length && size < 1920) {
          const head = item.queue[0];
          const take = Math.min(head.length, 1920 - size);
          parts.push(head.subarray(0, take));
          size += take;
          if (take === head.length) item.queue.shift();
          else item.queue[0] = head.subarray(take);
        }
        if (size) {
          const data = Buffer.concat(parts);
          item.queuedBytes -= data.byteLength;
          output({
            type: 'chunk',
            chunk: { streamId: item.id, sequence: item.sequence++, data },
          });
        }
        if (Date.now() - item.lastQueueLog >= 1000) {
          log.debug(
            { event: 'voice.output_queue', ...queueStats(item) },
            'Voice output queue',
          );
          item.lastQueueLog = Date.now();
        }
        if (item.done && !item.queue.length) {
          clearInterval(pumpTimer);
          pumpTimer = undefined;
          output({ type: 'end', streamId: item.id });
        }
      }
      function message(event: Record<string, unknown>) {
        if (disposed) return;
        switch (event.type) {
          case 'response.created': {
            const response = event.response as { id: string };
            if (!listening) {
              send({ type: 'response.cancel', response_id: response.id });
              cancelled.add(response.id);
            } else responseId = response.id;
            break;
          }
          case 'input_audio_buffer.speech_stopped':
            turnEnded?.();
            break;
          case 'response.output_audio_transcript.delta':
          case 'response.output_audio_transcript.done': {
            if (
              typeof event.item_id !== 'string' ||
              !Number.isSafeInteger(event.content_index)
            )
              break;
            const id = `assistant-${event.item_id}-${event.content_index}`;
            const previous = texts.get(id);
            if (
              previous?.interrupted ||
              cancelled.has(String(event.response_id))
            )
              break;
            const isFinal = event.type.endsWith('.done');
            const text = isFinal
              ? event.transcript
              : (previous?.text ?? '') + event.delta;
            if (typeof text !== 'string' || text.length > 100_000)
              throw new Error('Invalid transcript');
            const update: TranscriptUpdate = {
              id,
              role: 'assistant',
              text,
              isFinal,
            };
            texts.set(id, update);
            transcript?.(update);
            break;
          }
          case 'input_audio_buffer.speech_started':
            interrupt();
            break;
          case 'response.output_audio.delta': {
            if (!listening || cancelled.has(String(event.response_id))) return;
            if (
              typeof event.delta !== 'string' ||
              typeof event.item_id !== 'string' ||
              !Number.isSafeInteger(event.content_index)
            )
              throw new Error('Invalid voice output');
            if (
              !current ||
              current.itemId !== event.item_id ||
              current.contentIndex !== event.content_index
            ) {
              if (current) interrupt(false);
              current = {
                id: randomUUID(),
                itemId: event.item_id,
                contentIndex: event.content_index as number,
                responseId: String(event.response_id),
                sequence: 0,
                bytes: 0,
                playedMs: 0,
                queue: [],
                queuedBytes: 0,
                done: false,
                startedAt: Date.now(),
                lastQueueLog: Date.now(),
                peakQueuedBytes: 0,
                highWaterLogged: false,
              };
              output({
                type: 'start',
                stream: { streamId: current.id, format: FORMAT },
              });
            }
            // Bound decoded allocation before accepting an unusually large provider event.
            const estimatedBytes =
              Math.floor((event.delta.length * 3) / 4) -
              (event.delta.endsWith('==')
                ? 2
                : event.delta.endsWith('=')
                  ? 1
                  : 0);
            if (current.queuedBytes + estimatedBytes > maxOutputQueueBytes) {
              cancelOversizedReply(estimatedBytes);
              break;
            }
            const data = Buffer.from(event.delta, 'base64');
            if (!data.length || data.length % 2)
              throw new Error('Invalid PCM output');
            current.bytes += data.length;
            current.queuedBytes += data.length;
            current.peakQueuedBytes = Math.max(
              current.peakQueuedBytes,
              current.queuedBytes,
            );
            if (
              !current.highWaterLogged &&
              current.queuedBytes >= maxOutputQueueBytes * 0.75
            ) {
              current.highWaterLogged = true;
              log.warn(
                { event: 'voice.output_queue_high', ...queueStats(current) },
                'Voice output buffer nearing limit',
              );
            }
            // Pace delivery at the recorded sample rate, avoiding normal generation bursts
            // overflowing the browser's two-second playback budget.
            for (let offset = 0; offset < data.length; offset += 1920)
              current.queue.push(data.subarray(offset, offset + 1920));
            if (!pumpTimer)
              pumpTimer = setInterval(() => {
                try {
                  pump();
                } catch (err) {
                  fail(err);
                }
              }, 40);
            break;
          }
          case 'response.output_audio.done':
            if (current && current.itemId === event.item_id)
              current.done = true;
            break;
          case 'response.done': {
            const response = event.response as { id: string; status: string };
            if (current?.responseId === response.id)
              log.debug(
                {
                  event: 'voice.response_done',
                  ...queueStats(current),
                  status: response.status,
                },
                'Voice response generation finished',
              );
            if (responseId === response.id) responseId = undefined;
            if (response.status === 'failed')
              throw Object.assign(new Error('Voice response failed'), {
                code: (
                  event.response as {
                    status_details?: { error?: { code?: string } };
                  }
                ).status_details?.error?.code,
              });
            if (cancelled.size > 128)
              cancelled.delete(cancelled.values().next().value as string);
            break;
          }
          case 'error': {
            const error = event.error as
              | {
                  code?: string;
                  type?: string;
                  param?: string;
                  event_id?: string;
                }
              | undefined;
            // Server VAD can cancel before our explicit interruption command arrives.
            if (error?.code === 'response_cancel_not_active') return;
            if (
              (error?.event_id && configurationEvents.has(error.event_id)) ||
              (!ready && error?.type === 'invalid_request_error')
            ) {
              log.error(
                {
                  event: 'voice.configuration_rejected',
                  providerCode: error?.code,
                  parameter: error?.param,
                },
                'OpenAI rejected voice session settings',
              );
              throw new ConfigurationError(
                'OpenAI rejected voice session settings. Check the model, voice, and audio configuration.',
              );
            }
            throw Object.assign(
              new Error('Voice provider rejected a command'),
              { code: error?.code },
            );
          }
        }
      }
      return {
        initialize() {
          if (disposed)
            return Promise.reject(new Error('Voice connection closed.'));
          initialization ??= new Promise<void>((resolve, reject) => {
            rejectSetup = reject;
            if (!key) {
              reject(
                new ConfigurationError('OPENAI_API_KEY is required for voice.'),
              );
              return;
            }
            socket = connect(
              `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(AGENT_CONFIG.model)}`,
              {
                headers: {
                  Authorization: `Bearer ${key}`,
                  'OpenAI-Safety-Identifier': createHash('sha256')
                    .update(uid)
                    .digest('hex'),
                },
              },
            );
            setupTimer = setTimeout(
              () => fail(new Error('Voice initialization timed out')),
              AGENT_CONFIG.setupTimeoutMs,
            );
            socket.on('error', fail);
            socket.on('close', (code) =>
              fail(
                Object.assign(new Error('Voice upstream closed'), {
                  code: String(code),
                }),
              ),
            );
            socket.on('open', () => {
              try {
                send({
                  type: 'session.update',
                  session: {
                    type: 'realtime',
                    instructions: AGENT_CONFIG.instructions,
                    output_modalities: ['audio'],
                    audio: {
                      input: {
                        format: { type: 'audio/pcm', rate: 24000 },
                        turn_detection: null,
                      },
                      output: {
                        format: { type: 'audio/pcm', rate: 24000 },
                        voice: AGENT_CONFIG.voice,
                      },
                    },
                  },
                });
              } catch (err) {
                fail(err);
              }
            });
            socket.on('message', (data) => {
              if (disposed) return;
              try {
                const event = JSON.parse(data.toString());
                if (
                  event.type === 'session.created' &&
                  typeof event.session?.id === 'string'
                ) {
                  log = log.child({ providerSessionId: event.session.id });
                  metadata?.({ providerSessionId: event.session.id });
                }
                if (event.type === 'session.updated' && !ready) {
                  log.info(
                    { event: 'voice.configured' },
                    'Voice provider configured',
                  );
                  ready = true;
                  clearTimeout(setupTimer);
                  rejectSetup = undefined;
                  resolve();
                } else message(event);
              } catch (err) {
                fail(err);
              }
            });
          });
          return initialization;
        },
        beginInput() {
          if (!ready || disposed) throw new Error('Voice not ready');
          if (interrupted) truncate();
          listening = true;
          send({
            type: 'session.update',
            session: {
              type: 'realtime',
              audio: { input: { turn_detection: AGENT_CONFIG.turnDetection } },
            },
          });
        },
        write(data) {
          if (!listening) throw new Error('Microphone paused');
          send({
            type: 'input_audio_buffer.append',
            audio: Buffer.from(data).toString('base64'),
          });
        },
        pause() {
          listening = false;
          send({
            type: 'session.update',
            session: {
              type: 'realtime',
              audio: { input: { turn_detection: null } },
            },
          });
          interrupt();
          send({ type: 'input_audio_buffer.clear' });
        },
        progress(value: AudioPlaybackProgress) {
          const item =
            interrupted?.id === value.streamId
              ? interrupted
              : current?.id === value.streamId
                ? current
                : undefined;
          if (
            !item ||
            value.playedMs < item.playedMs ||
            value.playedMs > item.bytes / 48
          )
            return;
          item.playedMs = value.playedMs;
          if (item === interrupted && value.cleared === true) truncate();
        },
        dispose,
      };
    },
  };
}
